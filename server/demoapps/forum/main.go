// Command forum 是随服务端镜像分发的**内置演示应用**：内部小论坛（版块 / 主题 / 回帖）。
//
// 它演示的是"一个真的能用的内部小工具"该长什么样 —— 不是能力清单，而是**多表关系 +
// 事务写入 + 检索 + 分页**这四件在真实应用里天天要写的事：
//
//	forum_boards  版块（含 topic_count 计数列，用来演示事务里的一致性维护）
//	forum_topics  主题（含 reply_count / last_reply_at / pinned，列表排序靠它们）
//	forum_posts   回帖
//
// 三条硬约束下的设计取舍（平台契约，见 skills/app-builder/references/abi.md）：
//
//  1. **没有自增主键可用**：平台保留列 `_row_id` 应用看不到也不能提，所以业务主键由
//     `newID()` 自己生成（毫秒时间戳 + 随机后缀），排序一律靠 `created_at` / `last_reply_at`。
//     全部 SQL 里不出现 rowid / _rowid_ / oid（提到即 DB_DENIED）。
//  2. **平台不替你参数化**：值一律用 `?` 占位放进 args，SQL 里不拼任何用户输入。
//  3. **事务内只允许 db.query / db.exec 与两个出口**：所以 `log` 与 `db.define` 全部
//     放在事务外（`a.Tx` 的注释里也写了这一条）。
//
// 准入（R24：平台不比对名单，由应用自己判）走 `demoapp.AccessAllowed()`；入口 `/` 里
// **先判名单再给页面**，不通过时返回自制的 403 页（**页面上显示本人账号** —— 那是作者
// 发现名单拼错的唯一途径）。
//
// 前端在 `web/`（index.html / app.css / app.js），由 pack-assets.mjs 打成
// `index.html` 与 `static/app.css`、`static/app.js`：**静态资源由宿主按路径直出、
// 根本不经过 wasm**，只有 `/` 与 `/api/*` 会走到这里。
package main

import (
	"crypto/rand"
	"fmt"
	"html"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/picoaide/picoaide/demoapps/internal/demoapp"
)

func main() {
	// stdio 的阻塞模式由 `demoapp.Main` 统一拨正（wasip1 上可能是非阻塞的，
	// 漏掉它第一个宿主调用就会 EAGAIN）—— 见 `demoapps/internal/demoapp` 的注释，
	// 不要在应用里再抄一遍。
	demoapp.Main(handle)
}

// ===== 常量：三张表、校验上限、分页 =====

const (
	// PageSize 是主题列表每页条数（一次查询最多回 5000 行，20 行足够小、翻页也够快）。
	PageSize = 20
	// MaxTitleRunes / MaxBodyRunes 按**字符**（不是字节）计上限。
	MaxTitleRunes = 120
	MaxBodyRunes  = 4000
	// MaxSearchRunes 限制搜索词长度：超长词没有信息量，只会把 LIKE 拖慢。
	MaxSearchRunes = 60

	tblBoards = "forum_boards"
	tblTopics = "forum_topics"
	tblPosts  = "forum_posts"
)

// ===== 入口：一份路由，两条准入分支 =====

// handle 是唯一入口：一次请求一帧，返回一帧。
func handle(a *demoapp.App) demoapp.Response {
	path := a.Path()
	isAPI := strings.HasPrefix(path, "/api/")

	// ① 先判名单。读不到配置时 AccessAllowed 一律返回 false（绝不静默放行）。
	allowed, reason, cfg := a.AccessAllowed()
	if !allowed {
		a.Log("warn", fmt.Sprintf("拒绝访问 path=%s user=%q reason=%s", path, a.Username(), reason))
		if isAPI {
			return demoapp.Fail(403, "FORBIDDEN", reason+"（账号："+accountOf(a)+"）")
		}
		return demoapp.HTML(403, deniedPage(a, reason, cfg))
	}

	// ② 幂等建表 + 首次播种。db.define 每请求都要跑一遍：实例每请求新建，
	//    但库是持久的 —— created=false 表示表已存在，此时**绝不能重复播种**。
	if herr := ensureSchema(a); herr != nil {
		return hostFail(a, "建表", herr)
	}

	// ③ 路由。`/static/*` 到不了这里（宿主直出），所以只剩入口与 API 两条。
	if path == "/" || path == "/index.html" {
		markup, herr := a.EntryHTML()
		if herr != nil {
			return hostFail(a, "读入口页", herr)
		}
		return demoapp.HTML(200, markup)
	}
	if isAPI {
		return routeAPI(a)
	}
	return demoapp.Fail(404, "NOT_FOUND", "这个路径不存在："+path)
}

// routeAPI 分发 `/api/*`。路径按段解析（不引 regexp：这里的形状是封闭的）。
func routeAPI(a *demoapp.App) demoapp.Response {
	method, path := a.Req.Method, a.Path()

	switch {
	case path == "/api/bootstrap" && method == "GET":
		return getBootstrap(a)
	case path == "/api/topics" && method == "GET":
		return getTopics(a)
	case path == "/api/topics" && method == "POST":
		return postTopic(a)
	}

	rest, ok := strings.CutPrefix(path, "/api/topics/")
	if ok {
		segs := strings.Split(strings.Trim(rest, "/"), "/")
		if len(segs) >= 1 && segs[0] != "" {
			id := segs[0]
			switch {
			case len(segs) == 1 && method == "GET":
				return getTopic(a, id)
			case len(segs) == 1 && method == "DELETE":
				return deleteTopic(a, id)
			case len(segs) == 2 && segs[1] == "posts" && method == "POST":
				return postReply(a, id)
			case len(segs) == 2 && segs[1] == "pin" && method == "POST":
				return togglePin(a, id)
			}
		}
	}
	return demoapp.Fail(404, "NOT_FOUND", "没有这个接口："+method+" "+path)
}

// ===== 建表与播种 =====

func boardColumns() []demoapp.Column {
	return []demoapp.Column{
		{Name: "id", Type: "text"},
		{Name: "name", Type: "text"},
		{Name: "description", Type: "text"},
		{Name: "sort", Type: "int"},
		{Name: "topic_count", Type: "int"},
		{Name: "created_at", Type: "datetime"},
	}
}

func topicColumns() []demoapp.Column {
	return []demoapp.Column{
		{Name: "id", Type: "text"},
		{Name: "board_id", Type: "text"},
		{Name: "title", Type: "text"},
		{Name: "body", Type: "text"},
		{Name: "author", Type: "text"},
		{Name: "author_display", Type: "text"},
		{Name: "pinned", Type: "int"},
		{Name: "reply_count", Type: "int"},
		{Name: "last_reply_at", Type: "datetime"},
		{Name: "created_at", Type: "datetime"},
	}
}

func postColumns() []demoapp.Column {
	return []demoapp.Column{
		{Name: "id", Type: "text"},
		{Name: "topic_id", Type: "text"},
		{Name: "body", Type: "text"},
		{Name: "author", Type: "text"},
		{Name: "author_display", Type: "text"},
		{Name: "created_at", Type: "datetime"},
	}
}

// ensureSchema 幂等建三张表；**只有 boards 是本次新建的**才播种（否则每次请求都会插一遍）。
func ensureSchema(a *demoapp.App) *demoapp.HostError {
	createdBoards, herr := a.Define(tblBoards, boardColumns())
	if herr != nil {
		return herr
	}
	if _, herr = a.Define(tblTopics, topicColumns()); herr != nil {
		return herr
	}
	if _, herr = a.Define(tblPosts, postColumns()); herr != nil {
		return herr
	}
	if !createdBoards {
		return nil
	}
	return seedContent(a)
}

// ===== 首次播种：3 个版块 + 3 条带回复的演示主题 =====

// seedBoard / seedReply / seedTopic 是内置演示内容的**声明**（数据与写库分开，
// 版块要按主题条数预先算出 topic_count，两边必须看同一份数据）。
type seedBoard struct {
	id, name, desc string
	sort           int
}

type seedReply struct{ author, display, body string }

type seedTopic struct {
	id, board, title, body string
	pinned                 int
	replies                []seedReply
}

func seedBoards() []seedBoard {
	return []seedBoard{
		{"b-general", "综合讨论", "通知、提问、跨部门的事都放这里", 10},
		{"b-tech", "技术交流", "踩坑记录、方案评审、工具推荐", 20},
		{"b-life", "生活杂谈", "吃饭、运动、拼车、周末去哪儿", 30},
	}
}

// seedDemoTopics 是几条**有内容的**演示主题。
//
// 为什么演示要自带内容：空论坛的第一印象是"这东西还没做完"。版块列表有零有整、
// 主题列表里有几条真人写的帖子、回帖数不是 0，客户点进来才知道"能用"。
func seedDemoTopics() []seedTopic {
	return []seedTopic{
		{
			id: "t-welcome", board: "b-general", pinned: 1,
			title: "欢迎来到内部小论坛（先看这条）",
			body: "这是平台自带的演示应用：版块、主题、回帖都存在这个应用自己的库里，不经过任何外部服务。\n\n" +
				"随手试试：发一条主题、回一句、把它置顶，再刷新页面 —— 数据不会丢。需要删掉演示数据时，让管理员在应用中心删除本应用即可。",
			replies: []seedReply{
				{"zhangwei", "张伟", "试了一下，回帖之后主题列表的「最后回复」时间会跟着变。"},
				{"liuyang", "刘洋", "置顶的顺序在刷新之后还在，说明是真落库了。"},
			},
		},
		{
			id: "t-search", board: "b-tech",
			title: "搜索是怎么做的？",
			body:  "顶部搜索框对标题和正文做包含匹配，命中之后仍然按置顶与最后回复排序。",
			replies: []seedReply{
				{"liuyang", "刘洋", "正文也能搜到，刚试了。"},
			},
		},
		{
			id: "t-coffee", board: "b-life",
			title:   "楼下咖啡机修好了",
			body:    "今天早上试过，出水量正常了。",
			replies: nil,
		},
	}
}

// seedContent 播种内置演示内容。只在建表那一刻执行一次（`created == true` 是唯一判据），
// 后续请求里实例虽是新的、库却是持久的，所以**绝不会重复插入**。
//
// ⚠️ 播种路径上刻意**不用** `SET topic_count = topic_count + 1` 这种相对更新：
// 每个版块播几条主题在播种时就是已知常量，直接连同版块一起写进去即可。少三条 UPDATE，
// 也让"只认字面量 UPDATE 的本地预览宿主"能完整跑通播种（否则 `/` 会 500）。
func seedContent(a *demoapp.App) *demoapp.HostError {
	now := nowUTC()
	boards := seedBoards()
	topics := seedDemoTopics()

	counts := make(map[string]int, len(boards))
	for _, t := range topics {
		counts[t.board]++
	}

	for _, b := range boards {
		if _, herr := a.Exec(
			"INSERT INTO "+tblBoards+" (id, name, description, sort, topic_count, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			b.id, b.name, b.desc, b.sort, counts[b.id], now,
		); herr != nil {
			return herr
		}
	}

	for _, t := range topics {
		if _, herr := a.Exec(
			"INSERT INTO "+tblTopics+
				" (id, board_id, title, body, author, author_display, pinned, reply_count, last_reply_at, created_at)"+
				" VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			t.id, t.board, t.title, t.body, "admin", "平台管理员", t.pinned, len(t.replies), now, now,
		); herr != nil {
			return herr
		}
		for replyIndex, r := range t.replies {
			if _, herr := a.Exec(
				"INSERT INTO "+tblPosts+" (id, topic_id, body, author, author_display, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				fmt.Sprintf("%s-r%d", t.id, replyIndex+1), t.id, r.body, r.author, r.display, now,
			); herr != nil {
				return herr
			}
		}
	}

	a.Log("info", fmt.Sprintf("首次访问：建表并播种 %d 个版块、%d 条演示主题", len(boards), len(topics)))
	return nil
}

// ===== GET /api/bootstrap =====

// getBootstrap 返回版块列表 + 当前身份 + 统计（主题数 / 回帖数 / 我的发帖数）。
func getBootstrap(a *demoapp.App) demoapp.Response {
	rows, herr := a.Query(
		"SELECT id, name, description, sort, topic_count FROM " + tblBoards + " ORDER BY sort ASC, id ASC")
	if herr != nil {
		return hostFail(a, "读版块", herr)
	}
	boards := make([]boardDTO, 0, len(rows.Rows))
	for _, row := range rows.Rows {
		boards = append(boards, boardDTO{
			ID:          cellText(rows, row, "id"),
			Name:        cellText(rows, row, "name"),
			Description: cellText(rows, row, "description"),
			Sort:        cellInt(rows, row, "sort"),
			TopicCount:  cellInt(rows, row, "topic_count"),
		})
	}

	// 统计是**展示性信息**：宿主拒绝（本地预览宿主的 SQL 子集很窄）时如实标成不可用，
	// 页面显示「—」，而不是让整个首页 500。失败会记一条 warn 日志，不会被吞掉。
	// 用切片而不是 map 驱动：日志与错误顺序必须确定（map 迭代顺序是随机的）。
	stats := map[string]any{}
	available := true
	counts := []struct {
		key  string
		sql  string
		args []any
	}{
		{"topics", "SELECT count(*) FROM " + tblTopics, nil},
		{"posts", "SELECT count(*) FROM " + tblPosts, nil},
		{"mine", "SELECT count(*) FROM " + tblPosts + " WHERE author = ?", []any{a.Username()}},
	}
	for _, c := range counts {
		n, ok := countScalar(a, c.sql, c.args...)
		if !ok {
			available = false
			continue
		}
		stats[c.key] = n
	}

	body := map[string]any{
		"me":              meDTOOf(a),
		"boards":          boards,
		"page_size":       PageSize,
		"stats_available": available,
	}
	if available {
		body["stats"] = stats
	} else {
		body["stats"] = nil
	}
	return demoapp.JSON(200, body)
}

// ===== GET /api/topics =====

// getTopics 列表：置顶优先 → 再按 last_reply_at 倒序；支持版块过滤、关键词搜索、分页。
func getTopics(a *demoapp.App) demoapp.Response {
	boardID := strings.TrimSpace(a.QueryParam("board"))
	q := trimTo(strings.TrimSpace(a.QueryParam("q")), MaxSearchRunes)
	page := parsePage(a.QueryParam("page"))

	var where []string
	var filterArgs []any
	if boardID != "" {
		where = append(where, "board_id = ?")
		filterArgs = append(filterArgs, boardID)
	}
	if q != "" {
		like := "%" + escapeLike(q) + "%"
		where = append(where, `(title LIKE ? ESCAPE '\' OR body LIKE ? ESCAPE '\')`)
		filterArgs = append(filterArgs, like, like)
	}
	whereSQL := ""
	if len(where) > 0 {
		whereSQL = " WHERE " + strings.Join(where, " AND ")
	}

	// 多取一行判「还有下一页」：比再跑一次 count 便宜，也让"取不到总数"时翻页照常可用。
	args := append(append([]any{}, filterArgs...), PageSize+1, (page-1)*PageSize)
	rows, herr := a.Query(
		"SELECT id, board_id, title, author, author_display, pinned, reply_count, last_reply_at, created_at FROM "+
			tblTopics+whereSQL+" ORDER BY pinned DESC, last_reply_at DESC, created_at DESC LIMIT ? OFFSET ?", args...)
	if herr != nil {
		return hostFail(a, "读主题列表", herr)
	}

	topics := make([]topicDTO, 0, len(rows.Rows))
	for _, row := range rows.Rows {
		topics = append(topics, topicDTOOf(rows, row))
	}
	hasMore := len(topics) > PageSize
	if hasMore {
		topics = topics[:PageSize]
	}

	body := map[string]any{
		"board":     boardID,
		"q":         q,
		"page":      page,
		"page_size": PageSize,
		"topics":    topics,
		"has_more":  hasMore,
	}
	if total, ok := countScalar(a, "SELECT count(*) FROM "+tblTopics+whereSQL, filterArgs...); ok {
		body["total"] = total
		body["total_available"] = true
	} else {
		body["total"] = nil
		body["total_available"] = false
	}
	return demoapp.JSON(200, body)
}

// ===== POST /api/topics =====

type createTopicReq struct {
	BoardID string `json:"board_id"`
	Title   string `json:"title"`
	Body    string `json:"body"`
}

// postTopic 发主题：**事务**里插主题 + 递增版块的主题计数（计数与事实同事务，不会漂）。
func postTopic(a *demoapp.App) demoapp.Response {
	var req createTopicReq
	if !a.BodyJSON(&req) {
		return demoapp.Fail(400, "VALIDATION", "请求体必须是 JSON：{\"board_id\":\"…\",\"title\":\"…\",\"body\":\"…\"}")
	}
	boardID := strings.TrimSpace(req.BoardID)
	title := strings.TrimSpace(req.Title)
	body := strings.TrimSpace(req.Body)

	if msg := validateText("标题", title, 1, MaxTitleRunes); msg != "" {
		return demoapp.Fail(400, "VALIDATION", msg)
	}
	if msg := validateText("正文", body, 1, MaxBodyRunes); msg != "" {
		return demoapp.Fail(400, "VALIDATION", msg)
	}
	if boardID == "" {
		return demoapp.Fail(400, "VALIDATION", "必须指定 board_id（版块）")
	}
	// 版块必须存在：先查一次（事务外读，读失败不影响事务语义）。
	boardRows, herr := a.Query("SELECT id, name FROM "+tblBoards+" WHERE id = ?", boardID)
	if herr != nil {
		return hostFail(a, "校验版块", herr)
	}
	if len(boardRows.Rows) == 0 {
		return demoapp.Fail(400, "VALIDATION", "版块不存在："+boardID)
	}
	boardName := cellText(boardRows, boardRows.Rows[0], "name")

	now := nowUTC()
	topic := topicDTO{
		ID:          newID(),
		BoardID:     boardID,
		Title:       title,
		Body:        body,
		Author:      a.Username(),
		AuthorName:  a.DisplayName(),
		Pinned:      false,
		ReplyCount:  0,
		LastReplyAt: now,
		CreatedAt:   now,
	}

	if resp, ok := runTx(a, "发主题", func() *demoapp.HostError {
		if _, err := a.Exec(
			"INSERT INTO "+tblTopics+
				" (id, board_id, title, body, author, author_display, pinned, reply_count, last_reply_at, created_at)"+
				" VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			topic.ID, topic.BoardID, topic.Title, topic.Body, topic.Author, topic.AuthorName,
			0, 0, topic.LastReplyAt, topic.CreatedAt,
		); err != nil {
			return err
		}
		_, err := a.Exec("UPDATE "+tblBoards+" SET topic_count = topic_count + 1 WHERE id = ?", boardID)
		return err
	}); !ok {
		return resp
	}

	a.Log("info", fmt.Sprintf("新主题 %s 发到版块「%s」（%s）", topic.ID, boardName, topic.Author))
	return demoapp.JSON(201, map[string]any{"topic": topic})
}

// ===== GET /api/topics/<id> =====

// getTopic 主题详情 + 全部回帖（回帖按时间正序）。
func getTopic(a *demoapp.App, id string) demoapp.Response {
	topic, resp, ok := mustTopic(a, id)
	if !ok {
		return resp
	}

	rows, herr := a.Query(
		"SELECT id, topic_id, body, author, author_display, created_at FROM "+tblPosts+
			" WHERE topic_id = ? ORDER BY created_at ASC, id ASC", id)
	if herr != nil {
		return hostFail(a, "读回帖", herr)
	}
	posts := make([]postDTO, 0, len(rows.Rows))
	for _, row := range rows.Rows {
		posts = append(posts, postDTO{
			ID:         cellText(rows, row, "id"),
			TopicID:    cellText(rows, row, "topic_id"),
			Body:       cellText(rows, row, "body"),
			Author:     cellText(rows, row, "author"),
			AuthorName: cellText(rows, row, "author_display"),
			CreatedAt:  cellText(rows, row, "created_at"),
		})
	}
	return demoapp.JSON(200, map[string]any{"topic": topic, "posts": posts})
}

// ===== POST /api/topics/<id>/posts =====

type createPostReq struct {
	Body string `json:"body"`
}

// postReply 回帖：**事务**里插回帖 + 更新主题的 reply_count / last_reply_at（列表排序靠它）。
func postReply(a *demoapp.App, id string) demoapp.Response {
	topic, resp, ok := mustTopic(a, id)
	if !ok {
		return resp
	}
	var req createPostReq
	if !a.BodyJSON(&req) {
		return demoapp.Fail(400, "VALIDATION", "请求体必须是 JSON：{\"body\":\"…\"}")
	}
	body := strings.TrimSpace(req.Body)
	if msg := validateText("回帖内容", body, 1, MaxBodyRunes); msg != "" {
		return demoapp.Fail(400, "VALIDATION", msg)
	}

	now := nowUTC()
	post := postDTO{
		ID:         newID(),
		TopicID:    id,
		Body:       body,
		Author:     a.Username(),
		AuthorName: a.DisplayName(),
		CreatedAt:  now,
	}

	if resp, ok := runTx(a, "回帖", func() *demoapp.HostError {
		if _, err := a.Exec(
			"INSERT INTO "+tblPosts+" (id, topic_id, body, author, author_display, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			post.ID, post.TopicID, post.Body, post.Author, post.AuthorName, post.CreatedAt,
		); err != nil {
			return err
		}
		_, err := a.Exec(
			"UPDATE "+tblTopics+" SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?", now, id)
		return err
	}); !ok {
		return resp
	}

	topic.ReplyCount++
	topic.LastReplyAt = now
	a.Log("info", fmt.Sprintf("主题 %s 新增回帖 %s（%s）", id, post.ID, post.Author))
	return demoapp.JSON(201, map[string]any{"post": post, "topic": topic})
}

// ===== POST /api/topics/<id>/pin =====

// togglePin 切换置顶。置顶是"内部论坛"的公共操作，这里不限制身份（删除才限制）。
func togglePin(a *demoapp.App, id string) demoapp.Response {
	topic, resp, ok := mustTopic(a, id)
	if !ok {
		return resp
	}
	next := 0
	if !topic.Pinned {
		next = 1
	}
	if _, herr := a.Exec("UPDATE "+tblTopics+" SET pinned = ? WHERE id = ?", next, id); herr != nil {
		return hostFail(a, "切换置顶", herr)
	}
	a.Log("info", fmt.Sprintf("主题 %s 置顶改为 %d（%s）", id, next, a.Username()))
	return demoapp.JSON(200, map[string]any{"id": id, "pinned": next == 1})
}

// ===== DELETE /api/topics/<id> =====

// deleteTopic 删主题：**只允许作者本人或发布者**（user.is_publisher）；
// 删除时在事务里连带删掉该主题的全部回帖，并把版块计数减回去。
func deleteTopic(a *demoapp.App, id string) demoapp.Response {
	topic, resp, ok := mustTopic(a, id)
	if !ok {
		return resp
	}
	me := a.Username()
	publisher := a.Req.User != nil && a.Req.User.IsPublisher
	if topic.Author != me && !publisher {
		a.Log("warn", fmt.Sprintf("拒绝删除：主题作者=%s 请求者=%s（非发布者）", topic.Author, me))
		return demoapp.Fail(403, "FORBIDDEN",
			"只有主题作者本人或应用发布者可以删除（作者："+topic.Author+"，你："+accountOf(a)+"）")
	}

	var postsDeleted int64
	if resp, ok := runTx(a, "删除主题", func() *demoapp.HostError {
		n, err := a.Exec("DELETE FROM "+tblPosts+" WHERE topic_id = ?", id)
		if err != nil {
			return err
		}
		postsDeleted = n
		if _, err = a.Exec("DELETE FROM "+tblTopics+" WHERE id = ?", id); err != nil {
			return err
		}
		_, err = a.Exec(
			"UPDATE "+tblBoards+" SET topic_count = topic_count - 1 WHERE id = ? AND topic_count > 0", topic.BoardID)
		return err
	}); !ok {
		return resp
	}

	a.Log("info", fmt.Sprintf("删除主题 %s（连带 %d 条回帖，操作者 %s）", id, postsDeleted, me))
	return demoapp.JSON(200, map[string]any{"deleted": id, "posts_deleted": postsDeleted})
}

// ===== 公共小工具 =====

// mustTopic 读一个主题；不存在给 404，宿主失败给 500。
func mustTopic(a *demoapp.App, id string) (topicDTO, demoapp.Response, bool) {
	rows, herr := a.Query(
		"SELECT id, board_id, title, body, author, author_display, pinned, reply_count, last_reply_at, created_at FROM "+
			tblTopics+" WHERE id = ?", id)
	if herr != nil {
		return topicDTO{}, hostFail(a, "读主题", herr), false
	}
	if len(rows.Rows) == 0 {
		return topicDTO{}, demoapp.Fail(404, "NOT_FOUND", "主题不存在："+id), false
	}
	return topicDTOOf(rows, rows.Rows[0]), demoapp.Response{}, true
}

// runTx 跑一个事务，并把"事务里到底哪一步失败了"如实带回来。
//
// `demoapp.Tx` 在 fn 返回 error 时给的是一个 `ROLLED_BACK` 信封（它拿不到原始错误码），
// 所以这里把真正的 HostError 记在外层变量里 —— 页面上的错误提示条要显示的是
// `DB_DENIED` 这种**平台给的可执行错误**，不是一句笼统的"回滚了"。
func runTx(a *demoapp.App, what string, fn func() *demoapp.HostError) (demoapp.Response, bool) {
	var inner *demoapp.HostError
	herr := a.Tx(func() error {
		if e := fn(); e != nil {
			inner = e
			return e
		}
		return nil
	})
	if inner != nil {
		return hostFail(a, what, inner), false
	}
	if herr != nil {
		return hostFail(a, what, herr), false
	}
	return demoapp.Response{}, true
}

// countScalar 跑一条单列 count 查询。宿主拒绝时返回 (0,false) 并记一条 warn：
// 统计/总数是展示性信息，取不到就把页面上的数字显示成「—」，不让整页 500。
func countScalar(a *demoapp.App, sql string, args ...any) (int64, bool) {
	rows, herr := a.Query(sql, args...)
	if herr != nil {
		a.Log("warn", "统计查询被宿主拒绝（页面显示为「—」）："+herr.Error())
		return 0, false
	}
	if len(rows.Rows) == 0 || len(rows.Rows[0]) == 0 {
		return 0, true
	}
	n, err := strconv.ParseInt(strings.TrimSpace(demoapp.Stringify(rows.Rows[0][0])), 10, 64)
	if err != nil {
		a.Log("warn", "统计查询返回了非数字："+demoapp.Stringify(rows.Rows[0][0]))
		return 0, false
	}
	return n, true
}

// validateText 按字符数校验一段文本；返回空串表示通过，否则返回给人看的错误说明。
func validateText(label, value string, min, max int) string {
	n := utf8.RuneCountInString(value)
	if n < min {
		return fmt.Sprintf("%s不能为空（至少 %d 个字）", label, min)
	}
	if n > max {
		return fmt.Sprintf("%s最多 %d 个字，现在有 %d 个", label, max, n)
	}
	return ""
}

// parsePage 解析页码：非法/越界一律回到第 1 页（不报错 —— 翻页参数不该让页面打不开）。
func parsePage(raw string) int {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n < 1 {
		return 1
	}
	if n > 100000 {
		return 100000
	}
	return n
}

// escapeLike 转义 LIKE 的通配符（配合 SQL 里的 `ESCAPE '\'`）：
// 用户搜 "100%" 时不该变成"匹配任意串"。
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

// trimTo 按字符数截断（多于 max 个字符时去掉尾巴）。
func trimTo(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	runes := []rune(s)
	return string(runes[:max])
}

// timeLayout 是时间列的统一写法：**定长到毫秒**的 UTC RFC3339。
//
// 两个理由，缺一不可：
//  1. **格式必须逐字节一致**（定长、同偏移量），否则 SQL 里的字符串比较排序会错；
//  2. **精度必须到毫秒**。`time.RFC3339` 只到秒 —— 同一秒内建的主题会得到完全相同的
//     字符串，`ORDER BY last_reply_at DESC` 就退化成任意顺序（实测踩到：连发两条主题，
//     列表顺序与创建顺序相反）。Go 的 `RFC3339Nano` 又不能用：它会裁掉尾随零，
//     长度可变，字符串比较同样会错。
//
// 所以全仓只有这一个时间写法，展示时才在前端转成本地时间。
const timeLayout = "2006-01-02T15:04:05.000Z"

func nowUTC() string { return time.Now().UTC().Format(timeLayout) }

// newID 生成业务主键。
//
// 平台保留列 `_row_id` 应用看不见也不能提，所以主键必须自己造：
// 毫秒时间戳（天然有序、便于排障）+ 3 字节随机后缀（同一毫秒内并发也不撞）。
func newID() string {
	buf := make([]byte, 3)
	if _, err := rand.Read(buf); err != nil {
		// 随机源拿不到不该让写入失败：退回纳秒时间戳（配合毫秒前缀，碰撞概率仍极低）。
		return fmt.Sprintf("%d-%s", time.Now().UnixMilli(), strconv.FormatInt(time.Now().UnixNano(), 36))
	}
	return fmt.Sprintf("%d-%x", time.Now().UnixMilli(), buf)
}

// accountOf 返回"当前账号"的展示文本（无身份时给一句人话，不显示空白）。
func accountOf(a *demoapp.App) string {
	if name := strings.TrimSpace(a.Username()); name != "" {
		return name
	}
	return "（没有身份）"
}

// ===== 行投影：一律按**列名**取值，不按位置 =====

// cellText / cellInt / cellBool 按列名取值：SQL 的列顺序改了也不会把数据读串行。
func cellText(rows demoapp.Rows, row []any, name string) string {
	for i, col := range rows.Columns {
		if col == name && i < len(row) {
			return demoapp.Stringify(row[i])
		}
	}
	return ""
}

func cellInt(rows demoapp.Rows, row []any, name string) int {
	n, err := strconv.Atoi(strings.TrimSpace(cellText(rows, row, name)))
	if err != nil {
		return 0
	}
	return n
}

func cellBool(rows demoapp.Rows, row []any, name string) bool { return cellInt(rows, row, name) != 0 }

// ===== 响应 DTO =====

type meDTO struct {
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Dept        string `json:"dept"`
	IsPublisher bool   `json:"is_publisher"`
}

func meDTOOf(a *demoapp.App) meDTO {
	out := meDTO{Username: a.Username(), DisplayName: a.DisplayName()}
	if a.Req.User != nil {
		out.Dept = a.Req.User.Dept
		out.IsPublisher = a.Req.User.IsPublisher
	}
	return out
}

type boardDTO struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Sort        int    `json:"sort"`
	TopicCount  int    `json:"topic_count"`
}

type topicDTO struct {
	ID          string `json:"id"`
	BoardID     string `json:"board_id"`
	Title       string `json:"title"`
	Body        string `json:"body,omitempty"`
	Author      string `json:"author"`
	AuthorName  string `json:"author_display"`
	Pinned      bool   `json:"pinned"`
	ReplyCount  int    `json:"reply_count"`
	LastReplyAt string `json:"last_reply_at"`
	CreatedAt   string `json:"created_at"`
}

func topicDTOOf(rows demoapp.Rows, row []any) topicDTO {
	return topicDTO{
		ID:          cellText(rows, row, "id"),
		BoardID:     cellText(rows, row, "board_id"),
		Title:       cellText(rows, row, "title"),
		Body:        cellText(rows, row, "body"),
		Author:      cellText(rows, row, "author"),
		AuthorName:  cellText(rows, row, "author_display"),
		Pinned:      cellBool(rows, row, "pinned"),
		ReplyCount:  cellInt(rows, row, "reply_count"),
		LastReplyAt: cellText(rows, row, "last_reply_at"),
		CreatedAt:   cellText(rows, row, "created_at"),
	}
}

type postDTO struct {
	ID         string `json:"id"`
	TopicID    string `json:"topic_id"`
	Body       string `json:"body"`
	Author     string `json:"author"`
	AuthorName string `json:"author_display"`
	CreatedAt  string `json:"created_at"`
}

// ===== 宿主失败 → 500 信封 =====

// hostFail 把平台的业务失败翻译成页面能显示的错误信封。
//
// 错误码带 `HOST_` 前缀（`HOST_DB_DENIED` / `HOST_TX_...`），页面的提示条会把 code 与
// message 原样显示出来 —— 这正是演示要讲的一半：平台拒绝时给的是**可执行的错误**，
// 不是一句"操作失败"。
func hostFail(a *demoapp.App, what string, err *demoapp.HostError) demoapp.Response {
	a.Log("error", what+"失败："+err.Error())
	return demoapp.Fail(500, "HOST_"+err.Code, what+"失败（"+err.Method+"）："+err.Message)
}

// ===== 403 页（不通过准入时给的自制页面）=====

// deniedPage 是准入不通过时的页面：**必须显示本人账号**，否则名单拼错了没人发现。
//
// 这一页不引用 `/static/*`：它要能在"应用其它资源都还没准备好"的最坏情况下独立显示。
func deniedPage(a *demoapp.App, reason string, cfg demoapp.Config) string {
	account := html.EscapeString(accountOf(a))
	who := html.EscapeString(strings.TrimSpace(a.DisplayName()))
	if who == "" {
		who = account
	}
	accessNote := "本应用的访问模式是「" + html.EscapeString(cfg.Access) + "」"
	if cfg.Access == "whitelist" {
		accessNote = fmt.Sprintf("本应用的访问模式是「名单」，名单里有 %d 个账号", len(cfg.Whitelist))
	}
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>没有访问权限 · 内部小论坛</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: radial-gradient(120% 120% at 12% 0%, #e8ecff 0%, #f6f7fb 46%, #eef1f8 100%);
    color: #1c1f2a; padding: 32px;
  }
  .card {
    width: min(560px, 100%); background: rgba(255,255,255,.82); border: 1px solid rgba(20,24,48,.10);
    border-radius: 20px; padding: 34px 34px 30px; box-shadow: 0 24px 60px -28px rgba(24,32,80,.42);
    backdrop-filter: blur(16px) saturate(1.3); animation: rise .42s cubic-bezier(.2,.8,.2,1) both;
  }
  @keyframes rise { from { opacity: 0; transform: translateY(14px) scale(.985); } to { opacity: 1; transform: none; } }
  .badge {
    width: 52px; height: 52px; border-radius: 15px; display: grid; place-items: center; margin-bottom: 18px;
    background: linear-gradient(140deg, #6d8bff, #9a6bff 58%, #ff7ab8); box-shadow: 0 12px 26px -14px rgba(90,90,255,.9);
  }
  h1 { font-size: 20px; margin: 0 0 10px; letter-spacing: .2px; }
  p { margin: 0 0 12px; color: #4a5068; }
  .who {
    margin: 18px 0 6px; padding: 14px 16px; border-radius: 13px; background: rgba(109,139,255,.10);
    border: 1px solid rgba(109,139,255,.24); color: #2a3150;
  }
  .who b { font-size: 17px; letter-spacing: .4px; }
  code { font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; font-size: 13px; }
  .foot { margin-top: 18px; color: #737a92; font-size: 13px; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
  @media (prefers-color-scheme: dark) {
    body { background: radial-gradient(120% 120% at 12% 0%, #171a2e 0%, #0e1018 52%, #0b0d14 100%); color: #e8ebf6; }
    .card { background: rgba(22,25,40,.78); border-color: rgba(150,165,255,.16); box-shadow: 0 26px 64px -30px #000; }
    p { color: #a4acc6; }
    .who { background: rgba(109,139,255,.14); border-color: rgba(120,150,255,.26); color: #d7ddff; }
    .foot { color: #7d85a0; }
  }
</style>
</head>
<body>
  <main class="card">
    <div class="badge" aria-hidden="true">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"
           stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="10" rx="2.5"/>
        <path d="M8 10V7.5a4 4 0 0 1 8 0V10"/></svg>
    </div>
    <h1>这个应用没有对你开放</h1>
    <p>` + html.EscapeString(reason) + `</p>
    <div class="who">
      你当前登录的账号是 <b><code>` + account + `</code></b>` + fromWho(who, account) + `
    </div>
    <p class="foot">` + accessNote + `。如果这不对，把上面这行账号原样发给应用发布者核对名单。</p>
  </main>
</body>
</html>`
}

// fromWho 只在展示名与账号不同的时候才多写一句，避免出现"张伟（张伟）"这种废话。
func fromWho(display, account string) string {
	if display == account {
		return ""
	}
	return `（` + display + `）`
}
