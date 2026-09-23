// Command shared-notes 是应用平台上的一个**真实小应用**：团队共享便签墙。
//
// 它是作者与 AI 的黄金路径样板（拷走这个目录就能改出自己的应用），形态是
// **前后端分离**：
//
//	web/index.html  页面结构      ┐
//	web/app.css     样式          ├─ 随包静态资源（宿主按路径直出）
//	web/app.js      取数与渲染     ┘
//	main.go         wasm 后端：只回 JSON（入口页由它读了 index.html 再返回）
//
// 刻意覆盖了一篇应用代码必须处理好的八件事：
//
//  1. 读请求帧（RS + 十进制长度 + '\n' + JSON）→ 取当前使用者 `user`；
//  2. 读自己的配置 `picoaide.app.json`（assets.read）→ 白名单判定；
//  3. 无权限页**显示本人账号**（作者发现名单拼错的唯一途径）；
//  4. 入口 `/` 由 wasm 自己答（先判名单，再 assets.read("index.html")），
//     `/static/*` 由宿主直出（apps 里的资源存在就直出，不执行 wasm）；
//  5. 业务 API 一律回 JSON（成功与失败都是 JSON 信封），失败码由页面翻译成人话；
//  6. db.define 幂等建表 + db.query 列表 + db.exec 写入（单语句、参数化）；
//  7. AI 走**客户端 AI loop**：wasm 侧**没有任何 AI 调用** —— 页面里的 JS 直接 fetch
//     客户端保留路径（**双下划线**，见 aiChatPath 常量），流式拿到回答后 POST 回本应用的
//     `/api/summaries`，由 wasm 写进应用库并在页面回显；
//  8. 每个分支都写且只写一帧响应信封；日志走 log 宿主调用（不污染 stdout 协议）。
//
// 平台没有的能力（不要试图在示例上"扩展"出来）：联网、文件、线程、子进程、环境变量、
// cookie（自定义协议下 `document.cookie` 恒为空、`Set-Cookie` 不落盘 ⇒ 状态只能进应用库）、
// PRAGMA/ATTACH/DDL、员工名录。同一应用内所有用户共享数据 —— 所以便签是"团队共享"的。
//
// 编译（四条状态目录见 README，漏了会看到 `package fmt is not in std`）：
//
//	GOOS=wasip1 GOARCH=wasm go build -o shared-notes.wasm .
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ===== 帧协议（ABI picoaide-app/1）=====

// frameMagic 是帧起始字节：ASCII RS（Record Separator）。
const frameMagic byte = 0x1e

// maxFrameBytes 是单帧上限（平台侧为 1 MiB）：超限直接报错，不要先分配内存再判断。
const maxFrameBytes = 1 << 20

// appConfigFile 是随包提交的配置文件名（平台在发布期把它抽到资源目录里）。
const appConfigFile = "picoaide.app.json"

// indexFile 是入口页在包内的逻辑路径：入口**必须由 wasm 自己答**（先判名单），
// 所以它不能用"宿主直出"那条路（宿主对入口文档一律交给 wasm）。
const indexFile = "index.html"

// request 是宿主 → 应用的请求帧。每一个请求都带完整身份：实例每请求新建，无状态。
type request struct {
	ABI     string            `json:"abi"`
	AppID   string            `json:"app_id"`
	Version string            `json:"version"`
	Auth    authInfo          `json:"auth"`
	User    *user             `json:"user"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Query   map[string]string `json:"query"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

// authInfo 取自应用的 access 配置。写侧只接受 login / whitelist（平台一律要求登录）；
// 历史配置里的 public 由读取侧按 login 处理，所以"匿名模式"已是历史形态 ——
// 下面的 public 分支只为兼容历史应用保留，正常路径不会再走到。
type authInfo struct {
	Mode     string `json:"mode"`
	Verified bool   `json:"verified"`
}

// user 是当前使用者。平台只给本人信息：没有名单、没有平台角色。
// ID 与 Username 是稳定键（display_name/dept 会变，不要用来做业务归属）。
type user struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Dept        string `json:"dept"`
	IsPublisher bool   `json:"is_publisher"`
}

// response 是最终响应信封：status + headers + body，写完这一帧后不得再写任何帧。
type response struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

// rpcRequest / rpcResponse 是应用 ↔ 宿主的 JSON-RPC 2.0 往返。
type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *rpcError       `json:"error"`
}

// rpcError 是宿主返回的平台错误码（码是字符串，不是 JSON-RPC 数字码）。
type rpcError struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details"`
}

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil {
		// stderr 不参与协议：平台把它当日志尾巴捕获，用于诊断。
		fmt.Fprintf(os.Stderr, "shared-notes: %v\n", err)
		os.Exit(1)
	}
}

// run 是应用的全部流程：读请求 → 判准入 → 调宿主 → 写响应。
func run(stdin io.Reader, stdout io.Writer) error {
	in := bufio.NewReader(stdin)
	out := stdout
	h := &host{in: in, out: out}

	req, err := readRequest(in)
	if err != nil {
		// 连请求帧都读不出来时，也要给宿主一个合法响应帧（否则只能是"无响应"）。
		return writeHTML(out, 500, errorPage("内部错误", "无法读取请求，请重试或联系应用负责人。"))
	}

	// 身份：平台一律要求登录（没有匿名面）。login / whitelist 要求宿主已验证身份
	//（这里是防御式自查，也是本地预览能验证的分支）；public 是历史配置值，
	// 读取侧已按 login 处理，保留该分支只为兼容历史应用，不要在新应用里依赖它。
	switch req.Auth.Mode {
	case "login", "whitelist":
		if req.User == nil || !req.Auth.Verified {
			return writeJSON(out, 401, apiFail("AUTH_REQUIRED", "本应用需要登录后使用。"))
		}
	case "public":
		// 历史形态（平台已不再产生匿名请求）：下面所有分支都必须能处理 user == nil。
	default:
		// 未知模式一律拒（宁可不可用，也不要在看不懂的模式下放行）。
		return writeJSON(out, 500, apiFail("CONFIG_UNREADABLE", "应用配置无法识别，请联系应用负责人重新发布。"))
	}

	// 自己的配置：准入名单在包里，运行期不可改（改名单 = 发新版本）。
	cfg, cfgErr := loadConfig(h)
	if cfgErr != nil {
		_ = h.logf("error", "读取 %s 失败: %v", appConfigFile, cfgErr)
		return writeHTML(out, 500, errorPage("配置读取失败", "应用配置缺失或损坏，请联系应用负责人重新发布。"))
	}
	_ = h.logf("info", "request method=%s path=%s user=%s", req.Method, req.Path, usernameOf(req.User))

	if !allowed(cfg, req.User) {
		// 无权限页必须显示本人账号：平台不提供员工名录，作者只能靠这一页发现名单拼写错误。
		return writeHTML(out, 403, noAccessPage(req.User, cfg))
	}

	// 建表是幂等的；每个请求都调一次，省掉"迁移脚本"这个概念（平台也不支持 DDL）。
	if err := defineSchema(h); err != nil {
		return hostFailure(out, h, req, "建表失败", err)
	}

	switch {
	case req.Method == "GET" && isEntry(req.Path):
		// 入口页由应用自己答：先生成 HTML 壳，页面里的 JS 再向 /api/* 取数据。
		body, err := readAsset(h, indexFile)
		if err != nil {
			return hostFailure(out, h, req, "读取页面失败", err)
		}
		return writeHTML(out, 200, body)
	case req.Method == "GET" && req.Path == "/api/whoami":
		return writeJSON(out, 200, map[string]any{"user": identity(req.User), "app": appInfo(cfg)})
	case req.Method == "GET" && req.Path == "/api/ai-prompt":
		// 提示词由 **wasm（应用侧）** 拼好并按桥的上限截断：客户端 AI loop 对单条消息
		// 有 16 KiB 硬上限，便签的条数与长度都不可控，所以在应用侧先截断 ——
		// 宁可少总结几条，也不要整次调用失败。
		notes, _, err := listNotes(h, listLimit)
		if err != nil {
			return hostFailure(out, h, req, "读取便签失败", err)
		}
		return writeJSON(out, 200, map[string]any{"prompt": pagePrompt(notes), "notes": len(notes)})
	case req.Method == "GET" && req.Path == "/api/notes":
		notes, truncated, err := listNotes(h, listLimit)
		if err != nil {
			return hostFailure(out, h, req, "读取便签失败", err)
		}
		summaries, sTrunc, err := listSummaries(h, summaryLimit)
		if err != nil {
			return hostFailure(out, h, req, "读取 AI 总结失败", err)
		}
		return writeJSON(out, 200, map[string]any{
			"notes":     notes,
			"summaries": summaries,
			"truncated": truncated || sTrunc,
		})
	case req.Method == "POST" && req.Path == "/api/notes":
		var payload struct {
			Body string `json:"body"`
		}
		if err := json.Unmarshal([]byte(req.Body), &payload); err != nil {
			return writeJSON(out, 400, apiFail("VALIDATION", "请求体不是合法 JSON。"))
		}
		body := strings.TrimSpace(payload.Body)
		if body == "" {
			return writeJSON(out, 400, apiFail("VALIDATION", "便签内容不能为空。"))
		}
		if _, err := h.call(hostDBExec, sqlParams{
			SQL:  "INSERT INTO notes (author, body, created_at) VALUES (?, ?, ?)",
			Args: []any{usernameOf(req.User), clipRunes(body, bodyMaxRunes), time.Now().UTC().Format(time.RFC3339)},
		}); err != nil {
			return hostFailure(out, h, req, "保存便签失败", err)
		}
		return writeJSON(out, 200, map[string]any{"ok": true})
	case req.Method == "POST" && req.Path == "/api/summaries":
		// AI 结果**回传落库**：这条路由的请求来自页面里的 JS（客户端 AI loop 拿到回答后
		// POST 过来），wasm 侧只做校验 + 入库 —— 它自己一行 AI 调用都没有。
		var payload struct {
			Summary string `json:"summary"`
		}
		if err := json.Unmarshal([]byte(req.Body), &payload); err != nil {
			return writeJSON(out, 400, apiFail("VALIDATION", "请求体不是合法 JSON。"))
		}
		answer := strings.TrimSpace(payload.Summary)
		if answer == "" {
			return writeJSON(out, 400, apiFail("VALIDATION", "AI 回答是空的，没有落库。"))
		}
		if err := saveSummary(h, req.User, clipRunes(answer, summaryMaxRunes)); err != nil {
			return hostFailure(out, h, req, "保存 AI 总结失败", err)
		}
		return writeJSON(out, 200, map[string]any{"ok": true})
	}

	// 子资源兜底：正常情况下 `/static/*` 由宿主直出、根本不会进到 wasm；这里再读一次
	// 包内资源，是为了在"宿主没直出"（路径不在直出规则里、或资源名与路由不一致）时
	// 仍然可用 —— 而不是给用户一个空白页。
	if req.Method == "GET" || req.Method == "HEAD" {
		if asset, ok := staticAsset(req.Path); ok {
			body, err := readAsset(h, asset)
			if err == nil {
				return writeAsset(out, contentTypeOf(asset), body)
			}
			_ = h.logf("warn", "包内没有资源 %s（请求路径 %s）: %v", asset, req.Path, err)
		}
	}

	if strings.HasPrefix(req.Path, "/api/") {
		return writeJSON(out, 404, apiFail("NOT_FOUND", "没有这个接口。"))
	}
	return writeHTML(out, 404, errorPage("页面不存在", "检查一下链接，或回到应用首页。"))
}

// ===== 业务逻辑 =====

// listLimit 是一次列表请求最多显示多少条便签（配合 db.query 的 LIMIT，避免拉全表）。
const listLimit = 50

// AI 总结相关的上限（都归应用自己管）：
//   - summaryLimit：页面最多回显几条已落库的总结；
//   - noteLimit / noteRunes：拼提示词时最多带几条便签、每条截多长；
//   - bodyMaxRunes / summaryMaxRunes：入库前的兜底截断。
//
// 前几个常量是**必须**的：客户端 AI loop 对单条消息的上限是 16 KiB（超了整次调用直接
// 400 app_ai_invalid），而便签的条数与长度都不可控 ⇒ 在应用侧先截断，宁可少总结几条，
// 也不要整次调用失败。
const (
	summaryLimit    = 3
	noteLimit       = 20
	noteRunes       = 200
	bodyMaxRunes    = 4000
	summaryMaxRunes = 4000
)

// note 是一条便签（表结构由 db.define 声明；平台自动维护行号列 `_row_id`，应用看不到，
// 也绝不能在 SQL 里提到它或它的别名 rowid/_rowid_/oid）。
type note struct {
	Author    string `json:"author"`
	Body      string `json:"body"`
	CreatedAt string `json:"created_at"`
}

// summary 是一条已落库的 AI 总结：由**页面**调客户端 AI loop 拿回回答、POST 回
// /api/summaries，再由 wasm 写进应用库。
type summary struct {
	Author    string `json:"author"`
	Body      string `json:"summary"`
	CreatedAt string `json:"created_at"`
}

// defineSchema 声明表结构。重复调用幂等（返回 created=false 表示表已存在）。
func defineSchema(h *host) error {
	_, err := h.call(hostDBDefine, defineParams{
		Table: "notes",
		Columns: []columnDef{
			{Name: "author", Type: "text"},
			{Name: "body", Type: "text"},
			{Name: "created_at", Type: "datetime"},
		},
	})
	if err != nil {
		return err
	}
	// 第二张表存 AI 总结：**结果落库**用的就是普通的 db.define / db.exec / db.query，
	// AI 本身不在这条路径上（wasm 侧没有 AI）。
	_, err = h.call(hostDBDefine, defineParams{
		Table: "summaries",
		Columns: []columnDef{
			{Name: "author", Type: "text"},
			{Name: "summary", Type: "text"},
			{Name: "created_at", Type: "datetime"},
		},
	})
	return err
}

// listNotes 读最近若干条便签。
//
// 注意三点（都是平台硬规则）：一次一条语句；值走参数化 args；**不要提到平台保留列**。
func listNotes(h *host, limit int) ([]note, bool, error) {
	raw, err := h.call(hostDBQuery, sqlParams{
		SQL:  "SELECT author, body, created_at FROM notes ORDER BY created_at DESC LIMIT ?",
		Args: []any{limit},
	})
	if err != nil {
		return nil, false, err
	}
	var res queryResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, false, fmt.Errorf("解析查询结果: %w", err)
	}
	notes := make([]note, 0, len(res.Rows))
	for _, row := range res.Rows {
		if len(row) < 3 {
			continue
		}
		notes = append(notes, note{Author: cell(row[0]), Body: cell(row[1]), CreatedAt: cell(row[2])})
	}
	return notes, res.Truncated, nil
}

// listSummaries 读最近几条 AI 总结（最新在前；表里的行都由 /api/summaries 写入）。
//
// **按列名取值、不按位置取值**：列名对不上就当作"还没有总结"（本地预览脚本的假宿主是
// 内存版，缺列时不该把便签当成总结渲染）。
func listSummaries(h *host, limit int) ([]summary, bool, error) {
	raw, err := h.call(hostDBQuery, sqlParams{
		SQL:  "SELECT author, summary, created_at FROM summaries ORDER BY created_at DESC LIMIT ?",
		Args: []any{limit},
	})
	if err != nil {
		return nil, false, err
	}
	var res queryResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, false, fmt.Errorf("解析查询结果: %w", err)
	}
	ai, si, ci := colIndex(res.Columns, "author"), colIndex(res.Columns, "summary"), colIndex(res.Columns, "created_at")
	if ai < 0 || si < 0 || ci < 0 {
		return nil, res.Truncated, nil
	}
	summaries := make([]summary, 0, len(res.Rows))
	for _, row := range res.Rows {
		summaries = append(summaries, summary{
			Author:    cellAt(row, ai),
			Body:      cellAt(row, si),
			CreatedAt: cellAt(row, ci),
		})
	}
	return summaries, res.Truncated, nil
}

// saveSummary 把客户端 AI loop 拿回来的回答写进应用库 —— **应用里唯一写 AI 结果的地方**。
//
// 作者记当前使用者：同一应用内所有人共享数据，所以要留痕"这条总结是谁生成的"。
func saveSummary(h *host, u *user, answer string) error {
	_, err := h.call(hostDBExec, sqlParams{
		SQL:  "INSERT INTO summaries (author, summary, created_at) VALUES (?, ?, ?)",
		Args: []any{usernameOf(u), answer, time.Now().UTC().Format(time.RFC3339)},
	})
	return err
}

// pagePrompt 把最近便签拼成**一条 user 消息**（客户端 AI loop 只接受 user / assistant
// 两种角色：应用不能声明系统提示，桥也不注入记忆与用户历史 —— 想给模型的指令就写在消息正文里）。
//
// 逐条截断 + 限量见上面的常量：桥对单条消息有 16 KiB 硬上限。
func pagePrompt(notes []note) string {
	if len(notes) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("请用不超过五句话总结下面这些团队便签的要点与待办：\n")
	for i, n := range notes {
		if i >= noteLimit {
			break
		}
		fmt.Fprintf(&sb, "- %s（%s）：%s\n", n.Author, n.CreatedAt, clipRunes(n.Body, noteRunes))
	}
	return sb.String()
}

// allowed 判定当前使用者是否可用 —— **准入在应用自己这里判**（平台不比对名单）。
//
// access 写侧只有两个取值（平台一律要求登录，没有匿名面）：
//   - login     ＋ 名单为空 ⇒ 登录后全员可用（"登陆后使用（默认全员）"）；
//   - whitelist ＋ 名单非空 ⇒ 只有名单里的账号可用；
//   - 配了名单就一律按名单判；历史 public（读取侧已按 login 处理）只是兼容形态。
//
// 平台不校验名单里的账号是否存在（那是账号枚举接口），所以拼错只能靠"无权限页显示本人账号"发现。
// 名单匹配 username 或 user.id 两种写法都支持（id 更稳：用户名理论上可改）。
func allowed(cfg appConfig, u *user) bool {
	if len(cfg.Whitelist) == 0 {
		// 没配名单：whitelist 模式会被平台拒发布，这里按"不可用"兜底（防御式）。
		return cfg.Access != "whitelist"
	}
	if u == nil {
		return false
	}
	id := strconv.FormatInt(u.ID, 10)
	for _, entry := range cfg.Whitelist {
		if entry == u.Username || entry == id || strings.EqualFold(entry, u.Username) {
			return true
		}
	}
	return false
}

// ===== 路由与静态资源 =====

// aiChatPath 是宿主保留的**客户端 AI loop** 路径（**双下划线** `__picoaide`）。
//
// 它由客户端协议 handler **本地**处理、绝不转发服务端；整个 `__picoaide/` 是保留命名空间，
// 随包资源不得占用该前缀（发布期 ASSET_DENIED + reason=reserved_path_prefix），
// 应用内部写同名路由也没用 —— 请求在宿主层就被截走。
//
// ⚠️ **唯一真源**：页面脚本里的路径由装配时从这里注入（见 pageScriptTag），别处不要再抄字面量。
const aiChatPath = "/__picoaide/ai/chat"

// isEntry 判定入口文档路径。入口**必须由 wasm 自己答**：名单判定在应用手里，
// 宿主对入口一律不直出（否则不在名单里的人只会看到一个空壳页面）。
func isEntry(p string) bool {
	return p == "/" || p == "/index.html"
}

// staticAsset 把请求路径映射到包内逻辑路径（只处理 GET/HEAD 的子资源）。
//
// 正常情况下 `/static/app.css` 这类请求**到不了这里**：宿主按路径直出（资源存在就直出，
// 不执行 wasm）。这一层是兜底，也让本地预览与线上行为一致。
func staticAsset(p string) (string, bool) {
	clean := path.Clean("/" + strings.TrimPrefix(p, "/"))
	if clean == "/" || clean == "/index.html" {
		return indexFile, true
	}
	rel := strings.TrimPrefix(clean, "/")
	if rel == "" || strings.HasPrefix(rel, "api/") || strings.HasPrefix(rel, "__picoaide/") {
		return "", false
	}
	if strings.Contains(rel, "..") {
		return "", false
	}
	return rel, true
}

// contentTypeOf 按扩展名给 Content-Type（响应头只允许平台枚举里的那几种）。
func contentTypeOf(logical string) string {
	switch strings.ToLower(path.Ext(logical)) {
	case ".html", ".htm":
		return "text/html; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".json":
		return "application/json; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".ico":
		return "image/x-icon"
	case ".woff2":
		return "font/woff2"
	case ".woff":
		return "font/woff"
	default:
		return "text/plain; charset=utf-8"
	}
}

// readAsset 读包内资源（assets.read），并按判别字段 encoding 取内容。
//
// 资源是文本还是二进制由 `encoding` 说了算（`text` / `base64` / `empty`），
// 不要用 size == 0 去猜。
func readAsset(h *host, logical string) (string, error) {
	raw, err := h.call(hostAssetsRead, assetsReadParams{Path: logical})
	if err != nil {
		return "", err
	}
	var res struct {
		ContentType string `json:"content_type"`
		Size        int    `json:"size"`
		Encoding    string `json:"encoding"`
		Text        string `json:"text"`
		Base64      string `json:"base64"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return "", fmt.Errorf("解析 assets.read 结果: %w", err)
	}
	switch res.Encoding {
	case "text":
		return res.Text, nil
	case "empty":
		return "", nil
	default:
		// 本示例只用文本资源；二进制资源应把 base64 解出来再作为响应体写回。
		return "", fmt.Errorf("资源 %s 不是文本（encoding=%s），示例不支持二进制", logical, res.Encoding)
	}
}

// ===== 页面（只有错误页/无权限页由 wasm 渲染；正常页面是 web/index.html）=====

// noAccessPage 是无权限页：**必须显示本人账号**，否则作者无从发现名单拼写错误。
func noAccessPage(u *user, cfg appConfig) string {
	var b strings.Builder
	b.WriteString("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">")
	b.WriteString("<title>无访问权限</title></head><body>")
	fmt.Fprintf(&b, "<h1>%s</h1>", escapeHTML(appTitle(cfg)))
	b.WriteString("<p>你不在这个应用的使用名单里。</p>")
	fmt.Fprintf(&b, "<p>你的账号：<strong>%s</strong>（ID %d）</p>", escapeHTML(usernameOf(u)), idOf(u))
	if u != nil && u.DisplayName != "" {
		fmt.Fprintf(&b, "<p>显示名：%s</p>", escapeHTML(u.DisplayName))
	}
	b.WriteString("<p>把这个账号发给应用负责人，让他加进名单并发布新版本。</p>")
	b.WriteString("</body></html>")
	return b.String()
}

// errorPage 是极简错误页（wasm 自己渲染的那几个分支用）。
func errorPage(title, msg string) string {
	return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>" +
		escapeHTML(title) + "</title></head><body><h1>" + escapeHTML(title) +
		"</h1><p>" + escapeHTML(msg) + "</p></body></html>"
}

// appTitle 用配置里的用途做标题；缺省给一个中性名字。
func appTitle(cfg appConfig) string {
	if cfg.Purpose != "" {
		return cfg.Purpose
	}
	return "团队共享便签"
}

// identity 是给页面看的身份（只给本人信息，没有任何平台凭证）。
func identity(u *user) map[string]any {
	return map[string]any{
		"id":           idOf(u),
		"username":     usernameOf(u),
		"display_name": displayNameOf(u),
		"is_publisher": u != nil && u.IsPublisher,
	}
}

// appInfo 是给页面看的应用信息（标题 + AI 保留路径）。
func appInfo(cfg appConfig) map[string]any {
	return map[string]any{"title": appTitle(cfg), "ai_chat_path": aiChatPath}
}

// escapeHTML 只用于 wasm 自己拼的那两个错误页（页面本体是静态资源，不经过这里）。
func escapeHTML(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&#39;")
	return r.Replace(s)
}

// hostFailure 把宿主调用失败翻译成 JSON 错误信封，并把原始码打进日志（诊断的第一手材料）。
func hostFailure(out io.Writer, h *host, req *request, what string, err error) error {
	code, msg := "UNKNOWN", err.Error()
	if rpc, ok := asRPCError(err); ok {
		code, msg = string(rpc.Code), rpc.Message
	}
	_ = h.logf("error", "%s: code=%s message=%s", what, code, msg)
	payload := apiFail(codeFor(code), humanMessage(what, code, msg))
	if strings.HasPrefix(req.Path, "/api/") {
		return writeJSON(out, statusFor(code), payload)
	}
	return writeHTML(out, statusFor(code), errorPage(what, humanMessage(what, code, msg)))
}

// codeFor 把平台错误码映射成给页面看的短码（页面按它决定文案与是否重试）。
//
// 这里没有 AI 相关的码：AI 错误发生在**页面**对客户端 AI loop 的调用上，由脚本按
// 六个信封码自己处理，不会以宿主错误码的形式回到 wasm。
func codeFor(code string) string {
	switch code {
	case codeDBLimit:
		return "DB_FULL"
	case codeAppQueueFull:
		return "BUSY"
	case codeAuthRequired:
		return "AUTH_REQUIRED"
	case codeDBDenied:
		return "DB_DENIED"
	case "RUNTIME_TIMEOUT", "HOST_CALL_OVER_BUDGET", "MODULE_KILLED":
		return "TIMEOUT"
	default:
		return "INTERNAL"
	}
}

// statusFor 把失败码映射成给打开应用的客户端看的 HTTP 状态。
func statusFor(code string) int {
	switch code {
	case codeDBLimit:
		return 507
	case codeAppQueueFull:
		return 429
	case codeAuthRequired:
		return 401
	case codeDBDenied:
		return 403
	case "RUNTIME_TIMEOUT", "HOST_CALL_OVER_BUDGET", "MODULE_KILLED":
		return 504
	default:
		return 500
	}
}

// humanMessage 给常见码一句可操作的话（不要把平台内部细节暴露给用户）。
func humanMessage(what, code, fallback string) string {
	switch code {
	case codeDBLimit:
		return "应用数据已达平台上限，请联系应用负责人清理历史数据。"
	case codeAppQueueFull:
		return "当前使用的人有点多，请稍后重试。"
	case codeAuthRequired:
		return "请先登录后再使用本应用。"
	default:
		return what + "：" + fallback
	}
}

// ===== 宿主调用客户端 =====

// 宿主方法名（示例用到的封闭清单；完整清单见 references/abi.md）。
//
// ⚠️ 这里**没有 AI**：宿主能力是封闭清单，应用里的 AI 只能走页面里的客户端 AI loop
// （见 aiChatPath）—— wasm 侧调不到模型。
const (
	hostDBDefine   = "db.define"
	hostDBQuery    = "db.query"
	hostDBExec     = "db.exec"
	hostLog        = "log"
	hostAssetsRead = "assets.read"
)

// 平台错误码（只列应用会分支处理的几个；完整表见 references/abi.md）。
const (
	codeAuthRequired = "AUTH_REQUIRED"
	codeDBDenied     = "DB_DENIED"
	codeDBLimit      = "DB_LIMIT"
	codeAppQueueFull = "APP_QUEUE_FULL"
)

// host 封装一次「写请求帧 → 读响应帧」的往返。
type host struct {
	in     *bufio.Reader
	out    io.Writer
	nextID int
}

// call 发起一次宿主调用。返回的 error 只表示**协议层**失败或宿主返回了 error；
// 需要区分平台错误码时用 asRPCError。
func (h *host) call(method string, params any) (json.RawMessage, error) {
	h.nextID++
	payload, err := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: h.nextID, Method: method, Params: params})
	if err != nil {
		return nil, fmt.Errorf("编码 %s 请求: %w", method, err)
	}
	if err := writeFrame(h.out, payload); err != nil {
		return nil, fmt.Errorf("发送 %s 请求: %w", method, err)
	}
	respPayload, err := readFrame(h.in)
	if err != nil {
		return nil, fmt.Errorf("等待 %s 响应: %w", method, err)
	}
	var resp rpcResponse
	if err := json.Unmarshal(respPayload, &resp); err != nil {
		return nil, fmt.Errorf("解析 %s 响应: %w", method, err)
	}
	if resp.Error != nil {
		return nil, resp.Error
	}
	return resp.Result, nil
}

// logf 打一条应用日志（走 log 宿主调用，不要写 stdout —— stdout 只走协议帧）。
func (h *host) logf(level, format string, args ...any) error {
	_, err := h.call(hostLog, logParams{Level: level, Message: fmt.Sprintf(format, args...)})
	return err
}

// asRPCError 从错误里取出平台错误码。
func asRPCError(err error) (*rpcError, bool) {
	var rpc *rpcError
	if errors.As(err, &rpc) {
		return rpc, true
	}
	return nil, false
}

// Error 让 rpcError 实现 error（errors.As 依赖它）。
func (e *rpcError) Error() string { return e.Code + ": " + e.Message }

// ===== 宿主调用的参数/结果结构（与 references/abi.md 的方法表一一对应）=====

type columnDef struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type defineParams struct {
	Table   string      `json:"table"`
	Columns []columnDef `json:"columns"`
}

type sqlParams struct {
	SQL  string `json:"sql"`
	Args []any  `json:"args"`
}

type queryResult struct {
	Columns   []string `json:"columns"`
	Rows      [][]any  `json:"rows"`
	Truncated bool     `json:"truncated"`
}

type logParams struct {
	Level   string `json:"level"`
	Message string `json:"message"`
}

type assetsReadParams struct {
	Path string `json:"path"`
}

// appConfig 是 picoaide.app.json 的结构（字段集合封闭：多一个字段平台就拒发布；
// 完整字段规格见 skill 的 references/app-config.md）。
//
// access 写侧只有两个取值（平台一律要求登录）：login 要求登录、登录后全员可用
// （缺省）；whitelist 要求登录 + 名单准入。历史 public 读取侧按 login 处理，不要再写。
// **名单判定在应用自己这里**（平台不比对）。
type appConfig struct {
	Access          string   `json:"access"`
	Whitelist       []string `json:"whitelist"`
	Purpose         string   `json:"purpose"`
	DataSensitivity string   `json:"data_sensitivity"`
	Owner           string   `json:"owner"`
}

// loadConfig 读应用自己的配置：发布期它和静态资源一起被抽到宿主磁盘，用 assets.read 取。
func loadConfig(h *host) (appConfig, error) {
	text, err := readAsset(h, appConfigFile)
	if err != nil {
		return appConfig{}, err
	}
	var cfg appConfig
	if err := json.Unmarshal([]byte(text), &cfg); err != nil {
		return appConfig{}, fmt.Errorf("解析 %s: %w", appConfigFile, err)
	}
	return cfg, nil
}

// ===== 帧读写 =====

// readRequest 读一个请求帧并解析。
func readRequest(in *bufio.Reader) (*request, error) {
	payload, err := readFrame(in)
	if err != nil {
		return nil, err
	}
	var req request
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, fmt.Errorf("解析请求帧: %w", err)
	}
	return &req, nil
}

// readFrame 读一个完整帧。**一次读满**，不要用会预读的流式解码器。
//
// ⚠️ 不要假设"读会阻塞"：本地用 Node 的 node:wasi 预览时，stdin 是**非阻塞**的，
// 读不到数据会立刻返回 EAGAIN（Go 里表现为 `read /dev/stdin: Try again`）。
// 平台宿主的管道是阻塞的，但应用必须两种环境都能跑 ⇒ 遇到 EAGAIN 短暂让出后重试。
func readFrame(in *bufio.Reader) ([]byte, error) {
	first, err := readByte(in)
	if err != nil {
		return nil, err
	}
	if first != frameMagic {
		return nil, fmt.Errorf("stdin 上出现非帧字节 0x%02x（stdin 只用于接收宿主帧）", first)
	}
	digits := make([]byte, 0, 8)
	for {
		b, err := readByte(in)
		if err != nil {
			return nil, err
		}
		if b == '\n' {
			break
		}
		if b < '0' || b > '9' || len(digits) >= 10 {
			return nil, errors.New("非法的帧长度前缀")
		}
		digits = append(digits, b)
	}
	n, err := strconv.Atoi(string(digits))
	if err != nil {
		return nil, fmt.Errorf("非法的帧长度 %q", digits)
	}
	if n > maxFrameBytes {
		return nil, fmt.Errorf("帧长度 %d 超过上限 %d", n, maxFrameBytes)
	}
	payload := make([]byte, n)
	if n > 0 {
		if err := readExact(in, payload); err != nil {
			return nil, fmt.Errorf("帧未读满: %w", err)
		}
	}
	return payload, nil
}

// readByte 读一个字节，遇到 EAGAIN 重试（见 readFrame 的说明）。
func readByte(in *bufio.Reader) (byte, error) {
	deadline := time.Now().Add(readRetryBudget)
	for {
		b, err := in.ReadByte()
		if err == nil {
			return b, nil
		}
		if !isAgain(err) {
			return 0, err
		}
		if time.Now().After(deadline) {
			return 0, fmt.Errorf("等待宿主数据超时: %w", err)
		}
		time.Sleep(readRetryInterval)
	}
}

// readExact 读满 buf，遇到 EAGAIN 重试（部分读到的字节不会丢）。
func readExact(in io.Reader, buf []byte) error {
	deadline := time.Now().Add(readRetryBudget)
	off := 0
	for off < len(buf) {
		n, err := in.Read(buf[off:])
		off += n
		if off >= len(buf) {
			return nil
		}
		if err != nil {
			if !isAgain(err) {
				return err
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("等待宿主数据超时: %w", err)
			}
			time.Sleep(readRetryInterval)
		}
	}
	return nil
}

// isAgain 判定"暂时没有数据"（非阻塞读写的 EAGAIN）。
//
// 只认 EAGAIN：wasip1 上 would-block 就是 EAGAIN，EWOULDBLOCK 在部分平台没有定义
// （编译目标不同会让"看起来等价"的常量消失，这也是为什么要真编译一遍示例）。
func isAgain(err error) bool {
	return errors.Is(err, syscall.EAGAIN)
}

// readRetryBudget / readRetryInterval 是本示例对"非阻塞 stdin"的容忍度：
// 平台的 guest 预算只有 10 秒，所以等待上限必须远小于它。
const (
	readRetryBudget   = 2 * time.Second
	readRetryInterval = time.Millisecond
)

// writeJSON 写一个 JSON 响应（成功与失败都走这里：页面只认一种形状）。
func writeJSON(out io.Writer, status int, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return writeHTML(out, 500, errorPage("内部错误", "无法生成响应。"))
	}
	return writeEnvelope(out, status, "application/json; charset=utf-8", string(body))
}

// writeHTML 写一个 HTML 响应（只有错误页与无权限页由 wasm 渲染）。
func writeHTML(out io.Writer, status int, body string) error {
	return writeEnvelope(out, status, "text/html; charset=utf-8", body)
}

// writeAsset 写一个静态资源响应（子资源兜底分支用）。
func writeAsset(out io.Writer, contentType, body string) error {
	return writeEnvelope(out, 200, contentType, body)
}

// apiFail 生成错误信封 `{"error":{"code","message"}}`（页面按 code 分支、把 message 显示给人）。
func apiFail(code, message string) map[string]any {
	return map[string]any{"error": map[string]any{"code": code, "message": message}}
}

// writeEnvelope 写最终响应信封（写好立刻 flush）。
func writeEnvelope(out io.Writer, status int, contentType, body string) error {
	payload, err := json.Marshal(response{
		Status:  status,
		Headers: map[string]string{"Content-Type": contentType},
		Body:    body,
	})
	if err != nil {
		return fmt.Errorf("编码响应信封: %w", err)
	}
	return writeFrame(out, payload)
}

// writeFrame 写一帧（RS + 十进制长度 + '\n' + JSON）。
//
// 与读同理：非阻塞 stdout 下写也可能返回 EAGAIN ⇒ 走 writeAll 重试。
func writeFrame(out io.Writer, payload []byte) error {
	var header []byte
	header = append(header, frameMagic)
	header = strconv.AppendInt(header, int64(len(payload)), 10)
	header = append(header, '\n')
	if err := writeAll(out, header); err != nil {
		return err
	}
	if len(payload) == 0 {
		return nil
	}
	return writeAll(out, payload)
}

// writeAll 写满 b，遇到 EAGAIN 重试。
func writeAll(out io.Writer, b []byte) error {
	deadline := time.Now().Add(readRetryBudget)
	for len(b) > 0 {
		n, err := out.Write(b)
		b = b[n:]
		if err == nil {
			continue
		}
		if !isAgain(err) {
			return err
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("写协议帧超时: %w", err)
		}
		time.Sleep(readRetryInterval)
	}
	return nil
}

// ===== 小工具 =====

// usernameOf / displayNameOf / idOf 对 nil 安全：平台一律要求登录（没有匿名面），
// 正常路径 user 不会是 nil；这三处判空只为兜住历史 public 应用与防御式分支。
func usernameOf(u *user) string {
	if u == nil {
		return "（未登录）"
	}
	return u.Username
}

func displayNameOf(u *user) string {
	if u == nil {
		return "匿名访问"
	}
	if u.DisplayName == "" {
		return u.Username
	}
	return u.DisplayName
}

func idOf(u *user) int64 {
	if u == nil {
		return 0
	}
	return u.ID
}

// cell 把查询结果里的一个值渲染成字符串（TEXT 列给字符串，数值列给数字）。
func cell(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		return fmt.Sprint(t)
	}
}

// colIndex 按列名找下标（大小写不敏感）；找不到返回 -1。
//
// **按列名取值、不按位置取值**：SELECT 的列顺序改了也不会把数据读串行。
func colIndex(cols []string, name string) int {
	for i, c := range cols {
		if strings.EqualFold(c, name) {
			return i
		}
	}
	return -1
}

// cellAt 按下标取一格；下标越界（-1）返回空串。
func cellAt(row []any, i int) string {
	if i < 0 || i >= len(row) {
		return ""
	}
	return cell(row[i])
}

// clipRunes 按字符截断（避免把一个多字节字符截成半个塞进提示词或数据库）。
func clipRunes(s string, max int) string {
	rs := []rune(s)
	if len(rs) <= max {
		return s
	}
	return string(rs[:max]) + "…"
}
