// Command board 是内置演示应用「留言板」：**最小可用形态**的样板 ——
// 一张表、一次写入、一个列表，外加一份名单准入（`access = whitelist`）。
//
// 它刻意不炫技：没有多表关系、没有分页、没有事务、没有 AI。演示要讲清楚的是
// 「一个能用的应用到底需要平台给什么」——答案是四件事：
//
//  1. **一份自己的数据库**：`db.define` 建表（DDL 只能由平台代执行）、
//     `db.query` 读、`db.exec` 写；值一律走 `?` 占位（平台不替你参数化）。
//  2. **身份**：请求帧里带 `user{id,username,display_name,dept,is_publisher}`，
//     应用不做登录、也拿不到别人的身份。
//  3. **准入**：`access=whitelist` 时平台只把「模式」告诉应用（R24），
//     **名单比对由应用自己读 `picoaide.app.json` 完成**；名单外的人必须看到
//     一页写着**本人账号 + 当前名单 + 负责人**的提示 —— 那是作者发现名单拼错的
//     唯一途径。
//  4. **一块界面**：`/static/*` 由宿主按路径直出（不经过 wasm），入口 `/` 走 wasm
//     —— 所以「先判名单、再给页面」这件事只有读 `index.html` 这一条路。
//
// 与平台契约有关的三条硬约束（写在这里，免得后来者踩）：
//   - 表名/列名只能 `^[a-z][a-z0-9_]{0,30}$`；类型只有 text/int/real/bool/datetime；
//     **没有自增主键**（保留列 `_row_id` 应用看不到也不能提）⇒ 业务主键自己生成；
//   - SQL 只允许单条 SELECT/INSERT/UPDATE/DELETE，`?` 占位放进 args；
//   - 事务内只允许 db.query/db.exec —— 本应用不需要事务，所以一次 tx 都没开。
//
// @module board
package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"html"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/picoaide/picoaide/demoapps/internal/demoapp"
)

const (
	/** 应用自己的表名（一张表就是全部数据模型）。 */
	tableName = "board_notes"

	/** 留言正文的长度上限（按**字符**算，不是字节 —— 中文与 emoji 都是 1 个字符）。 */
	bodyMaxRunes = 500

	/** `GET /api/notes` 的默认条数与上限。 */
	limitDefault = 100
	limitMax     = 200

	/** 播种留言的作者：写成应用自己，读者一眼能看出「这不是某个人写的」。 */
	seedAuthor  = "board"
	seedDisplay = "留言板 · 系统"
	seedDept    = "应用"
)

// noteColumns 是这张表的全部列。
//
// 业务主键 `id` 是 text：平台没有自增主键（保留列应用看不到也不能提），
// 键必须应用自己生成（见 newID）。
var noteColumns = []demoapp.Column{
	{Name: "id", Type: "text"},
	{Name: "body", Type: "text"},
	{Name: "author", Type: "text"},
	{Name: "author_display", Type: "text"},
	{Name: "created_at", Type: "int"}, // 毫秒时间戳
	{Name: "dept", Type: "text"},
}

func main() {
	// stdio 的阻塞模式由 `demoapp.Main` 统一拨正（wasip1 上可能是非阻塞的，
	// 漏掉它第一个宿主调用就会 EAGAIN）—— 见 `demoapps/internal/demoapp` 的注释，
	// 不要在应用里再抄一遍。
	demoapp.Main(handle)
}

// note 是一条留言（API 的 JSON 形状，也是页面渲染的数据源）。
type note struct {
	ID            string `json:"id"`
	Body          string `json:"body"`
	Author        string `json:"author"`
	AuthorDisplay string `json:"author_display"`
	CreatedAt     int64  `json:"created_at"`
	Dept          string `json:"dept"`
}

// handle 是唯一的请求入口。
//
// 顺序是刻意的：**先判名单，再路由**。名单外的人不该有机会碰到任何一条业务分支
// （包括"这个路径存不存在"这种信息）。
func handle(app *demoapp.App) demoapp.Response {
	path := app.Path()

	// `/` 里 ok, reason, cfg := app.AccessAllowed()：平台只告诉模式，名单由应用自己比。
	ok, reason, cfg := app.AccessAllowed()
	if !ok {
		if isAPIPath(path) {
			// API 面给 JSON 信封（页面自己会把 code/message 显示出来）。
			return demoapp.Fail(403, "ACCESS_DENIED", reason)
		}
		// 页面面给自制 403 页：必须显示本人账号、当前名单、负责人。
		return demoapp.HTML(403, deniedPage(app, cfg, reason))
	}

	switch {
	case path == "/" || path == "/index.html":
		return entry(app)
	case path == "/api/me":
		return meResponse(app, cfg)
	case path == "/api/notes":
		switch app.Req.Method {
		case "GET":
			return listNotes(app)
		case "POST":
			return createNote(app)
		default:
			return demoapp.Fail(405, "METHOD_NOT_ALLOWED", "/api/notes 只接受 GET 与 POST，收到 "+app.Req.Method)
		}
	case strings.HasPrefix(path, "/api/notes/"):
		if app.Req.Method != "DELETE" {
			return demoapp.Fail(405, "METHOD_NOT_ALLOWED", "这个路径只接受 DELETE，收到 "+app.Req.Method)
		}
		return deleteNote(app, strings.TrimPrefix(path, "/api/notes/"))
	}

	return demoapp.Fail(404, "NOT_FOUND", "这个应用没有路径 "+path)
}

func isAPIPath(path string) bool { return path == "/api" || strings.HasPrefix(path, "/api/") }

// ---------------------------------------------------------------------------
// 入口页面
// ---------------------------------------------------------------------------

// entry 通过名单后返回包内 `index.html`。
//
// 顺带在这里做「首次访问自动建表 + 播种」：入口是每个人都会走的那一跳，
// 放在这儿就不需要额外的初始化钩子（平台也没有"应用启动"这个概念 ——
// 每个请求都是新实例）。失败**不拦页面**：页面自己有错误态，把宿主给的
// 能力码显示出来比一页 500 更有用。
func entry(app *demoapp.App) demoapp.Response {
	if herr := ensureSchema(app); herr != nil {
		app.Log("warn", "board: 建表/播种失败，页面照常返回（列表接口会显示这个错误）: "+herr.Error())
	}
	markup, herr := app.EntryHTML()
	if herr != nil {
		return demoapp.Fail(500, "ENTRY_MISSING", "读不到入口页面 index.html："+herr.Error())
	}
	return demoapp.HTML(200, markup)
}

// ---------------------------------------------------------------------------
// 建表与播种
// ---------------------------------------------------------------------------

// ensureSchema 保证表存在；**只在「这次请求真的建了表」且表是空的时候**播种。
//
// 幂等判据（两条，命中任一条就跳过播种）：
//   - `created == false`：表早就存在 ⇒ 播种在第一次访问时就做过了；
//   - 表里已经有数据：作者可能删掉过欢迎留言又自己写过 —— 绝不再塞回去。
//
// ⚠️ 已知取舍：两个**同时**发生的首次请求可能各播一次（应用层没有跨请求锁，
// 平台也没有 upsert）。首次访问是一个人的一次页面加载，实际撞不上；真要严丝合缝
// 得靠 db.tx 把「查空 + 写入」包起来，而演示要的是最小形态，这里如实说明。
func ensureSchema(app *demoapp.App) *demoapp.HostError {
	created, herr := app.Define(tableName, noteColumns)
	if herr != nil {
		return herr
	}
	if !created {
		return nil
	}
	rows, herr := app.Query("SELECT id FROM "+tableName+" LIMIT ?", 1)
	if herr != nil {
		return herr
	}
	if len(rows.Rows) > 0 {
		return nil
	}
	return seedNotes(app)
}

// seedNotes 播 3 条欢迎留言（由旧到新，所以最上面那条是问候语）。
//
// 时间戳刻意拉开 1 分钟：列表按 `created_at DESC` 排，同一毫秒的 3 条顺序不稳定。
func seedNotes(app *demoapp.App) *demoapp.HostError {
	now := time.Now().UnixMilli()
	seeds := []struct {
		body string
		at   int64
	}{
		{"删除只对「作者本人」与「应用发布者」开放 —— 自己发一条，再把它删掉试试。", now - 120_000},
		{"你看到的每一条都存在应用自己的库里（db.define 建表 / db.exec 写入 / db.query 读取），刷新页面不会丢。", now - 60_000},
		{"欢迎来到留言板 👋 这个应用只有一张表、一次写入、一个列表 —— 这就是「最小可用形态」。", now},
	}
	for _, s := range seeds {
		if _, herr := app.Exec(
			"INSERT INTO "+tableName+" (id, body, author, author_display, created_at, dept) VALUES (?, ?, ?, ?, ?, ?)",
			newID(), s.body, seedAuthor, seedDisplay, s.at, seedDept,
		); herr != nil {
			return herr
		}
	}
	return nil
}

// newID 生成业务主键：毫秒时间戳（36 进制）+ 4 字节随机后缀。
//
// 平台不给自增主键，键只能应用自己生成。时间戳在前让键**大致有序**（排障时一眼
// 看出先后），随机后缀负责同一毫秒内的唯一性（1/4G 的碰撞概率，演示足够）。
// 随机源走 wasip1 的 `random_get`（crypto/rand 在 wasm 上就是这个实现）；
// 万一取不到熵也不让写入失败 —— 退回纯时间戳。
func newID() string {
	stamp := strconv.FormatInt(time.Now().UnixMilli(), 36)
	var suffix [4]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return stamp
	}
	return stamp + "-" + hex.EncodeToString(suffix[:])
}

// ---------------------------------------------------------------------------
// API：身份与配置摘要
// ---------------------------------------------------------------------------

// meResponse 返回「我是谁 + 这个应用怎么配的」。
//
// 页面用它决定：显示什么身份、要不要给某条留言画删除按钮（作者本人或发布者）。
// 名单本身**不在这里下发**（完整名单只出现在 403 页上，那是给作者排错的）；
// 这里只给条数，够页面提示「名单里有 N 个账号」。
func meResponse(app *demoapp.App, cfg demoapp.Config) demoapp.Response {
	user := map[string]any{}
	if app.Req.User != nil {
		u := app.Req.User
		user = map[string]any{
			"id":           u.ID,
			"username":     u.Username,
			"display_name": app.DisplayName(), // 展示名缺失时回落账号（底座已实现）
			"dept":         u.Dept,
			"is_publisher": u.IsPublisher,
		}
	}
	return demoapp.JSON(200, map[string]any{
		"app": map[string]any{
			"id":      app.Req.AppID,
			"version": app.Req.Version,
			"abi":     app.Req.ABI,
			"mode":    string(app.Req.Auth.Mode), // public / login / whitelist
		},
		"user": user,
		"config": map[string]any{
			"access":           cfg.Access,
			"owner":            cfg.Owner,
			"whitelist_count":  len(cfg.Whitelist),
			"purpose":          cfg.Purpose,
			"data_sensitivity": cfg.DataSensitivity,
		},
		"limits": map[string]any{
			"body_max":      bodyMaxRunes,
			"limit_default": limitDefault,
			"limit_max":     limitMax,
		},
	})
}

// ---------------------------------------------------------------------------
// API：读列表
// ---------------------------------------------------------------------------

// listNotes 按 `created_at` 倒序返回留言（默认 100 条，上限 200）。
//
// SQL 只有一条：列名写全（不写 `SELECT *`，列序变化时页面不会错位），
// 排序与截断都交给数据库 —— 应用不做「取回来再排」这种假分页。
func listNotes(app *demoapp.App) demoapp.Response {
	if herr := ensureSchema(app); herr != nil {
		return hostFail(herr)
	}

	limit, ok := parseLimit(app.QueryParam("limit"))
	if !ok {
		return demoapp.Fail(400, "VALIDATION", fmt.Sprintf("limit 必须是正整数（缺省 %d，上限 %d）", limitDefault, limitMax))
	}

	rows, herr := app.Query(
		"SELECT id, body, author, author_display, created_at, dept FROM "+tableName+" ORDER BY created_at DESC LIMIT ?",
		limit,
	)
	if herr != nil {
		return hostFail(herr)
	}

	notes := make([]note, 0, len(rows.Rows))
	cols := indexColumns(rows.Columns)
	for _, row := range rows.Rows {
		notes = append(notes, note{
			ID:            cols.text(row, "id"),
			Body:          cols.text(row, "body"),
			Author:        cols.text(row, "author"),
			AuthorDisplay: cols.text(row, "author_display"),
			CreatedAt:     cols.int64(row, "created_at"),
			Dept:          cols.text(row, "dept"),
		})
	}
	return demoapp.JSON(200, map[string]any{
		"notes":     notes,
		"count":     len(notes),
		"limit":     limit,
		"truncated": rows.Truncated,
	})
}

// parseLimit 解析 ?limit=。缺省 100；超过上限**收敛到上限**（不报错，页面传 500
// 只是想要"最近的全部"）；非数字或 ≤0 是用法错误 ⇒ 400（不静默兜底，避免
// "参数写错了看起来像没数据"）。
func parseLimit(raw string) (int, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return limitDefault, true
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, false
	}
	if n > limitMax {
		return limitMax, true
	}
	return n, true
}

// ---------------------------------------------------------------------------
// API：写一条
// ---------------------------------------------------------------------------

// createNote 处理 `POST /api/notes`，体是 `{"body":"..."}`。
//
// 校验（1–500 字）在**写之前**做完：空/超长一律 400 `VALIDATION`。
// 正文先 TrimSpace —— 用户不小心带的前后空白不该占字数、也不该变成一条空留言。
func createNote(app *demoapp.App) demoapp.Response {
	if herr := ensureSchema(app); herr != nil {
		return hostFail(herr)
	}

	var req struct {
		Body string `json:"body"`
	}
	if !app.BodyJSON(&req) {
		return demoapp.Fail(400, "VALIDATION", `请求体必须是 JSON 对象，形如 {"body":"写点什么"}`)
	}

	body := strings.TrimSpace(req.Body)
	length := utf8.RuneCountInString(body)
	switch {
	case length == 0:
		return demoapp.Fail(400, "VALIDATION", "留言正文不能为空")
	case length > bodyMaxRunes:
		return demoapp.Fail(400, "VALIDATION", fmt.Sprintf("留言正文最多 %d 字，这条有 %d 字", bodyMaxRunes, length))
	}

	item := note{
		ID:            newID(),
		Body:          body,
		Author:        app.Username(),
		AuthorDisplay: app.DisplayName(),
		CreatedAt:     time.Now().UnixMilli(),
		Dept:          deptOf(app),
	}
	// 值一律 `?` 占位放进 args —— 平台不做参数化，拼接就是注入。
	if _, herr := app.Exec(
		"INSERT INTO "+tableName+" (id, body, author, author_display, created_at, dept) VALUES (?, ?, ?, ?, ?, ?)",
		item.ID, item.Body, item.Author, item.AuthorDisplay, item.CreatedAt, item.Dept,
	); herr != nil {
		return hostFail(herr)
	}

	// log 是六个原语之一（单条 ≤4 KiB、每请求 ≤100 条）。事务外调用。
	app.Log("info", fmt.Sprintf("board: 新留言 %s，作者 %s，%d 字", item.ID, item.Author, length))

	// 201 + 完整对象：页面拿它直接插卡片，不需要再拉一次列表。
	return demoapp.JSON(201, map[string]any{"note": item})
}

// ---------------------------------------------------------------------------
// API：删一条
// ---------------------------------------------------------------------------

// deleteNote 处理 `DELETE /api/notes/<id>`：**只允许作者本人或应用发布者**。
//
// 顺序不能反：先 SELECT 出作者做权力判定，判过了才 DELETE。
// （先删再判等于把别人删掉了才发现不该删 —— 没有事务就真回不去了。）
func deleteNote(app *demoapp.App, rawID string) demoapp.Response {
	id := strings.TrimSpace(rawID)
	if id == "" {
		return demoapp.Fail(400, "VALIDATION", "缺少留言 id：路径形如 /api/notes/<id>")
	}
	if herr := ensureSchema(app); herr != nil {
		return hostFail(herr)
	}

	rows, herr := app.Query("SELECT author FROM "+tableName+" WHERE id = ? LIMIT ?", id, 1)
	if herr != nil {
		return hostFail(herr)
	}
	if len(rows.Rows) == 0 {
		return demoapp.Fail(404, "NOT_FOUND", "这条留言不存在（可能已经被别人删掉了）")
	}
	author := indexColumns(rows.Columns).text(rows.Rows[0], "author")

	me := app.Username()
	publisher := app.Req.User != nil && app.Req.User.IsPublisher
	if !strings.EqualFold(strings.TrimSpace(author), me) && !publisher {
		// 403 而不是 404：这条留言对名单内的人是可见的，藏着掖着反而费解。
		return demoapp.Fail(403, "FORBIDDEN", "只有留言作者本人或应用发布者可以删除：这条属于 "+author)
	}

	affected, herr := app.Exec("DELETE FROM "+tableName+" WHERE id = ?", id)
	if herr != nil {
		return hostFail(herr)
	}
	if affected == 0 {
		// 判定与删除之间被别人删掉了（真实竞态，如实返回 404）。
		return demoapp.Fail(404, "NOT_FOUND", "这条留言不存在（可能已经被别人删掉了）")
	}

	app.Log("info", fmt.Sprintf("board: 删除留言 %s（操作者 %s，发布者=%v）", id, me, publisher))
	return demoapp.JSON(200, map[string]any{"deleted": true, "id": id})
}

// ---------------------------------------------------------------------------
// 查询结果取值
// ---------------------------------------------------------------------------

// columns 是「列名 → 下标」的映射。
//
// 为什么按名字取而不是按下标：`Rows.Columns` 是平台给的**权威列序**，按下标写死
// 会在 SQL 列序调整时静默错位（把时间戳显示成正文）。找不到的列取值为零值
// —— 宁可少显示，不可错位。
type columns map[string]int

// indexColumns 把平台回的列名表变成查找表（列名大小写不敏感）。
func indexColumns(names []string) columns {
	m := make(columns, len(names))
	for i, name := range names {
		m[strings.ToLower(strings.TrimSpace(name))] = i
	}
	return m
}

func (c columns) at(row []any, name string) (any, bool) {
	i, ok := c[strings.ToLower(name)]
	if !ok || i < 0 || i >= len(row) {
		return nil, false
	}
	return row[i], true
}

func (c columns) text(row []any, name string) string {
	v, ok := c.at(row, name)
	if !ok {
		return ""
	}
	return demoapp.Stringify(v)
}

func (c columns) int64(row []any, name string) int64 {
	v, ok := c.at(row, name)
	if !ok {
		return 0
	}
	switch t := v.(type) {
	case float64: // 平台按 SQLite 原生类型回：整数也是 float64
		return int64(t)
	case int64:
		return t
	case string:
		n, _ := strconv.ParseInt(t, 10, 64)
		return n
	default:
		return 0
	}
}

// deptOf 取部门（帧里没有用户时为「未登录」—— 正常路径不会发生：名单判定在先）。
func deptOf(app *demoapp.App) string {
	if app.Req.User == nil {
		return ""
	}
	return app.Req.User.Dept
}

// hostFail 把一次宿主调用失败翻译成 500 信封。
//
// **原样带上平台给的能力码与提示**（如 `DB_DENIED` + hints），而不是压成一句
// 「操作失败」—— 演示的一半价值就是让人看到平台拒绝时给的是什么。
func hostFail(herr *demoapp.HostError) demoapp.Response {
	if herr == nil {
		return demoapp.Fail(500, "HOST_ERROR", "宿主调用失败（没有更多信息）")
	}
	code := herr.Code
	if code == "" {
		code = "HOST_ERROR"
	}
	return demoapp.Fail(500, code, herr.Error())
}

// ---------------------------------------------------------------------------
// 403 页面（**自制**，不是平台给的）
// ---------------------------------------------------------------------------

// deniedPage 是名单外的人看到的那一页。
//
// 四件必须显示的东西（缺一个作者就得靠猜）：
//  1. 为什么被拒（reason 原文）；
//  2. **本人账号**（平台注入的登录身份）—— 用户以为"我没登录"时，这行能自证；
//  3. 当前名单的**全部账号**，并对"只差大小写/空格"的条目直接点出来；
//  4. 应用负责人（cfg.Owner）与"请联系他"的动作指引。
//
// 样式全部内联：这一页可能在静态资源出问题（或作者还没打包 web/）时也要能看。
func deniedPage(app *demoapp.App, cfg demoapp.Config, reason string) string {
	me := app.Username()
	display := app.DisplayName()
	dept := deptOf(app)

	var b strings.Builder
	b.WriteString(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`)
	b.WriteString(`<meta name="viewport" content="width=device-width,initial-scale=1">`)
	b.WriteString(`<title>留言板 · 你的账号不在名单里</title>`)
	b.WriteString(deniedStyle)
	b.WriteString(`</head><body><main class="wrap">`)

	b.WriteString(`<p class="kicker">403 · 没有访问权限</p>`)
	b.WriteString(`<h1>你的账号不在这个应用的名单里</h1>`)
	fmt.Fprintf(&b, `<p class="reason">原因：<strong>%s</strong></p>`, html.EscapeString(reason))

	// ① 本人账号
	b.WriteString(`<section class="card me"><h2>你的账号（平台注入的登录身份）</h2>`)
	if me == "" {
		b.WriteString(`<p class="acct"><code>（这次请求没有身份）</code></p>`)
	} else {
		fmt.Fprintf(&b, `<p class="acct"><code>%s</code>`, html.EscapeString(me))
		if display != "" && display != me {
			fmt.Fprintf(&b, ` <span class="soft">%s</span>`, html.EscapeString(display))
		}
		if dept != "" {
			fmt.Fprintf(&b, ` <span class="soft">· %s</span>`, html.EscapeString(dept))
		}
		b.WriteString(`</p>`)
	}
	b.WriteString(`<p class="soft">拿上面这串账号与下面的名单<strong>逐字</strong>对照 —— 大小写、空格、下划线都算数。` +
		`应用拿到的是客户端登录的账号，不是显示名。</p></section>`)

	// ② 当前名单
	fmt.Fprintf(&b, `<section class="card"><h2>当前名单（%d 个账号）</h2>`, len(cfg.Whitelist))
	if len(cfg.Whitelist) == 0 {
		b.WriteString(`<p class="warn">名单是<strong>空的</strong>：这个应用现在谁都进不来。` +
			`把账号填进应用配置的 <code>whitelist</code> 里（或用应用中心重新发布一版）即可。</p>`)
	} else {
		b.WriteString(`<ul class="list">`)
		for _, name := range cfg.Whitelist {
			fmt.Fprintf(&b, `<li><code>%s</code>`, html.EscapeString(name))
			if hint := whitelistHint(name, me); hint != "" {
				fmt.Fprintf(&b, `<span class="near">%s</span>`, html.EscapeString(hint))
			}
			b.WriteString(`</li>`)
		}
		b.WriteString(`</ul>`)
	}
	b.WriteString(`<p class="soft">名单是应用自己的配置（<code>picoaide.app.json</code> 的 <code>whitelist</code>，访问模式 <code>access=`)
	b.WriteString(html.EscapeString(cfg.Access))
	b.WriteString(`</code>）：平台只负责要求登录并告知模式，<strong>名单比对由应用自己完成</strong>。` +
		`比对口径是<strong>忽略大小写与首尾空格</strong>，所以这两样不会是被拒的原因 —— 请重点看拼写。</p></section>`)

	// ③ 负责人
	b.WriteString(`<section class="card owner"><h2>怎么办</h2><p>`)
	if strings.TrimSpace(cfg.Owner) != "" {
		fmt.Fprintf(&b, `请联系应用负责人 <strong>%s</strong>，把你的账号加进名单。`, html.EscapeString(cfg.Owner))
	} else {
		b.WriteString(`这个应用没有登记负责人：请找管理员在应用中心补上，并把你加进名单。`)
	}
	b.WriteString(`</p></section>`)

	fmt.Fprintf(&b, `<p class="foot">应用 <code>%s</code> · 访问模式 <code>%s</code></p>`,
		html.EscapeString(app.Req.AppID), html.EscapeString(cfg.Access))
	b.WriteString(`</main></body></html>`)
	return b.String()
}

// whitelistHint 判断名单里的这一条与本人账号「差在哪」——这是整页最有价值的一行。
//
// ⚠️ 先看清底座 `AccessAllowed()` 的比对口径：两边都 `ToLower` + `TrimSpace` 之后再比。
// 也就是说**只差大小写、只差首尾空格一定能进得来**，根本走不到这一页 —— 会把人挡在外面的
// 只有两种真实形态：名单里**多打了空格**，或者**拼错了**。提示就针对这两种给
// （第一版写了"只差大小写/首尾空格"，实测永远不可能命中，是死代码）。
func whitelistHint(entry, me string) string {
	if me == "" {
		return ""
	}
	compact := strings.Join(strings.Fields(entry), "") // 去掉全部空白（含 Tab/全角空格）
	if compact == "" {
		return "← 这是个空账号，等于没人"
	}
	if strings.EqualFold(compact, me) {
		return "← 和你的账号只差空格"
	}
	if distance := editDistanceWithin(strings.ToLower(compact), strings.ToLower(me), hintMaxDistance); distance > 0 {
		return fmt.Sprintf("← 和你的账号只差 %d 个字符（拼错了？）", distance)
	}
	return ""
}

// hintMaxDistance 是「像不像同一个账号」的编辑距离上限：
// 超过就只是另一个人的账号，不该乱猜（免得整页都是提示，反而看不出问题）。
const hintMaxDistance = 2

// editDistanceWithin 算 Levenshtein 距离；**超过 max 直接返回 0**（只关心"够不够像"，
// 不关心确切值）。名单是短字符串，O(n·m) 完全够用，也就不引第三方库。
func editDistanceWithin(a, b string, max int) int {
	ra, rb := []rune(a), []rune(b)
	if len(ra)-len(rb) > max || len(rb)-len(ra) > max {
		return 0
	}
	prev := make([]int, len(rb)+1)
	curr := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		curr[0] = i
		best := curr[0]
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			curr[j] = min(prev[j]+1, curr[j-1]+1, prev[j-1]+cost)
			best = min(best, curr[j])
		}
		if best > max { // 这一行已经没救了：距离只会越滚越大
			return 0
		}
		prev, curr = curr, prev
	}
	if prev[len(rb)] == 0 || prev[len(rb)] > max {
		return 0
	}
	return prev[len(rb)]
}

// deniedStyle 是 403 页的内联样式（与主页面同一套设计语言，深色模式自适应）。
const deniedStyle = `<style>
:root{--bg:#eef1f8;--ink:#111827;--soft:#5b6784;--line:rgba(17,24,39,.10);--card:rgba(255,255,255,.72);--accent:#4f6bff;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#080b14;--ink:#e8ecf7;--soft:#9aa6c4;--line:rgba(255,255,255,.12);--card:rgba(20,26,44,.66);--accent:#8ea2ff;--warn:#fbbf24}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:
 radial-gradient(60% 50% at 15% 0%,rgba(79,107,255,.22),transparent 60%),
 radial-gradient(50% 45% at 85% 5%,rgba(123,63,228,.18),transparent 62%),
 var(--bg);color:var(--ink);
 font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7}
.wrap{max-width:52rem;margin:0 auto;padding:8vh 1.2rem 4rem}
.kicker{margin:0;font-size:.78rem;letter-spacing:.18em;text-transform:uppercase;color:var(--soft)}
h1{margin:.2rem 0 1.2rem;font-size:clamp(1.5rem,3.4vw,2.2rem);line-height:1.25}
h2{margin:0 0 .6rem;font-size:.82rem;letter-spacing:.06em;text-transform:uppercase;color:var(--soft)}
.reason{margin:0 0 1.4rem;color:var(--soft)}
.card{background:var(--card);border:1px solid var(--line);border-radius:1rem;padding:1.1rem 1.25rem;margin:0 0 1rem;
 backdrop-filter:blur(14px) saturate(1.2);box-shadow:0 20px 44px -30px rgba(15,23,42,.55)}
.me{border-color:rgba(79,107,255,.45)}
.acct{margin:.1rem 0 .5rem;font-size:1.35rem;display:flex;flex-wrap:wrap;align-items:baseline;gap:.5rem}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.95em;background:rgba(79,107,255,.12);
 border:1px solid var(--line);border-radius:.4rem;padding:.1rem .4rem;word-break:break-all}
.soft{color:var(--soft);font-size:.9rem;margin:.2rem 0}
.warn{color:var(--warn);margin:.2rem 0}
.list{margin:.2rem 0 .6rem;padding:0;list-style:none;display:grid;gap:.35rem}
.list li{display:flex;flex-wrap:wrap;align-items:baseline;gap:.5rem}
.near{color:var(--warn);font-size:.85rem}
.foot{color:var(--soft);font-size:.82rem;margin-top:1.6rem;border-top:1px solid var(--line);padding-top:.8rem}
@media (prefers-reduced-motion:reduce){*{animation:none !important;transition:none !important}}
</style>`
