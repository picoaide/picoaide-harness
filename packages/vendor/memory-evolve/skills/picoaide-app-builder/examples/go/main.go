// Command shared-notes 是 PicoAide 应用平台上的一个**真实小应用**：团队共享便签墙。
//
// 它是作者与 AI 的黄金路径样板（拷走这个目录就能改出自己的应用），刻意覆盖了
// 一篇应用代码必须处理好的六件事：
//
//  1. 读请求帧（RS + 十进制长度 + '\n' + JSON）→ 取当前使用者 `user`；
//  2. 读自己的配置 `picoaide.app.json`（assets.read）→ 白名单判定；
//  3. 无权限页**显示本人账号**（作者发现名单拼错的唯一途径）；
//  4. db.define 幂等建表 + db.query 列表 + db.exec 写入（单语句、参数化）；
//  5. ai.chat 生成摘要：阻塞调用、等待态、余额不足要给人话而不是 500；
//  6. 每个分支都写且只写一帧响应信封；日志走 log 宿主调用（不污染 stdout 协议）。
//
// 平台没有的能力（不要试图在示例上"扩展"出来）：联网、文件、线程、子进程、环境变量、
// PRAGMA/ATTACH/DDL、员工名录。同一应用内所有用户共享数据 —— 所以便签是"团队共享"的。
//
// 编译：GOOS=wasip1 GOARCH=wasm go build -o shared-notes.wasm .
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/url"
	"os"
	"sort"
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

// authInfo 取自应用的 access 配置（2026-09-18 起只有三个取值：
// public / login / whitelist）。
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

// run 是应用的全部流程：读请求 → 调宿主 → 写响应。
func run(stdin io.Reader, stdout io.Writer) error {
	in := bufio.NewReader(stdin)
	out := stdout
	h := &host{in: in, out: out}

	req, err := readRequest(in)
	if err != nil {
		// 连请求帧都读不出来时，也要给宿主一个合法响应帧（否则只能是"无响应"）。
		return writeResponse(out, 500, textPage("内部错误", "无法读取请求，请重试或联系管理员。"))
	}

	// 身份：只有 public 允许匿名走到业务逻辑；login / whitelist 要求宿主已验证身份
	//（宿主在未登录时已经 302 换票，这里是防御式自查，也是本地预览能验证的分支）。
	switch req.Auth.Mode {
	case "login", "whitelist":
		if req.User == nil || !req.Auth.Verified {
			return writeResponse(out, 401, textPage("请先登录", "本应用需要登录后使用。"))
		}
	case "public":
		// 允许匿名：下面所有分支都必须能处理 user == nil。
	default:
		// 未知模式一律拒（宁可不可用，也不要在看不懂的模式下放行）。
		return writeResponse(out, 500, textPage("配置无法识别", "请联系应用负责人重新发布。"))
	}

	// 自己的配置：准入名单在包里，运行期不可改（改名单 = 发新版本）。
	cfg, cfgErr := loadConfig(h)
	if cfgErr != nil {
		_ = h.logf("error", "读取 %s 失败: %v", appConfigFile, cfgErr)
		return writeResponse(out, 500, textPage("配置读取失败", "应用配置缺失或损坏，请联系应用负责人重新发布。"))
	}
	_ = h.logf("info", "request method=%s path=%s user=%s", req.Method, req.Path, usernameOf(req.User))

	if !allowed(cfg, req.User) {
		// 无权限页必须显示本人账号：平台不提供员工名录，作者只能靠这一页发现名单拼写错误。
		return writeResponse(out, 403, noAccessPage(req.User, cfg))
	}

	// 建表是幂等的；每个请求都调一次，省掉"迁移脚本"这个概念（平台也不支持 DDL）。
	if err := defineSchema(h); err != nil {
		return hostFailure(out, h, "建表失败", err)
	}

	switch {
	case req.Method == "GET" && (req.Path == "/" || req.Path == "/index.html"):
		notes, err := listNotes(h, listLimit)
		if err != nil {
			return hostFailure(out, h, "读取便签失败", err)
		}
		return writeResponse(out, 200, page(req, cfg, notes, ""))
	case req.Method == "POST" && req.Path == "/api/notes":
		form, _ := url.ParseQuery(req.Body)
		body := strings.TrimSpace(form.Get("body"))
		if body == "" {
			notes, _ := listNotes(h, listLimit)
			return writeResponse(out, 400, page(req, cfg, notes, "便签内容不能为空。"))
		}
		if _, err := h.call(hostDBExec, sqlParams{
			SQL:  "INSERT INTO notes (author, body, created_at) VALUES (?, ?, ?)",
			Args: []any{usernameOf(req.User), body, time.Now().UTC().Format(time.RFC3339)},
		}); err != nil {
			return hostFailure(out, h, "保存便签失败", err)
		}
		notes, err := listNotes(h, listLimit)
		if err != nil {
			return hostFailure(out, h, "读取便签失败", err)
		}
		return writeResponse(out, 200, page(req, cfg, notes, "已保存。"))
	case req.Method == "POST" && req.Path == "/api/summary":
		summary, err := summarize(h)
		if err != nil {
			return hostFailure(out, h, "生成摘要失败", err)
		}
		notes, err := listNotes(h, listLimit)
		if err != nil {
			return hostFailure(out, h, "读取便签失败", err)
		}
		return writeResponse(out, 200, page(req, cfg, notes, summary))
	default:
		return writeResponse(out, 404, textPage("页面不存在", "检查一下链接，或回到应用首页。"))
	}
}

// ===== 业务逻辑 =====

// listLimit 是一次列表请求最多显示多少条便签（配合 db.query 的 LIMIT，避免拉全表）。
const listLimit = 50

// note 是一条便签（表结构由 db.define 声明；平台自动维护行号列，应用看不到）。
type note struct {
	Author    string
	Body      string
	CreatedAt string
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
	return err
}

// listNotes 读最近若干条便签。
//
// 注意三点（都是平台硬规则）：一次一条语句；值走参数化 args；**不要提到平台保留的行号列**。
func listNotes(h *host, limit int) ([]note, error) {
	raw, err := h.call(hostDBQuery, sqlParams{
		SQL:  "SELECT author, body, created_at FROM notes ORDER BY created_at DESC LIMIT ?",
		Args: []any{limit},
	})
	if err != nil {
		return nil, err
	}
	var res queryResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, fmt.Errorf("解析查询结果: %w", err)
	}
	notes := make([]note, 0, len(res.Rows))
	for _, row := range res.Rows {
		if len(row) < 3 {
			continue
		}
		notes = append(notes, note{Author: cell(row[0]), Body: cell(row[1]), CreatedAt: cell(row[2])})
	}
	return notes, nil
}

// summarize 用当前使用者的身份与额度调一次 AI，给最近便签生成摘要。
//
// ai.chat 是**阻塞**调用（非流式，最长 30 秒）：界面上要有等待态；
// 余额不足是 AI_BALANCE_INSUFFICIENT（402）——提示本人去看余额，不要在页面显示金额。
func summarize(h *host) (string, error) {
	notes, err := listNotes(h, listLimit)
	if err != nil {
		return "", err
	}
	if len(notes) == 0 {
		return "还没有便签，先写一条吧。", nil
	}
	var sb strings.Builder
	for _, n := range notes {
		fmt.Fprintf(&sb, "- %s（%s）：%s\n", n.Author, n.CreatedAt, clipRunes(n.Body, 200))
	}
	raw, err := h.call(hostAIChat, aiChatParams{
		Messages: []chatMessage{
			{Role: "system", Content: "你是团队便签助手：用不超过五句话总结这些便签的要点与待办。"},
			{Role: "user", Content: sb.String()},
		},
	})
	if err != nil {
		if rpc, ok := asRPCError(err); ok && rpc.Code == codeAIBalanceInsufficient {
			return "AI 摘要暂时不可用：你的账户余额不足，请到桌面客户端查看余额后重试。", nil
		}
		return "", err
	}
	var res aiChatResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return "", fmt.Errorf("解析 AI 结果: %w", err)
	}
	return strings.TrimSpace(res.Content), nil
}

// allowed 判定当前使用者是否可用 —— **准入在应用自己这里判**（平台不比对名单）。
//
// access 三模式下的语义：
//   - public    ＋ 名单为空 ⇒ 人人可用（含匿名）；
//   - login     ＋ 名单为空 ⇒ 登录后全员可用（"登陆后使用（默认全员）"）；
//   - whitelist ＋ 名单非空 ⇒ 只有名单里的账号可用；
//   - 配了名单就一律按名单判（匿名必然不在名单里 ⇒ 走到无权限页）。
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

// ===== 页面 =====

// page 渲染便签墙（内联 CSS；平台 CSP 允许自身源的 inline 样式，脚本要外链或内联在包里）。
func page(req *request, cfg appConfig, notes []note, flash string) string {
	var b strings.Builder
	b.WriteString("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">")
	b.WriteString("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">")
	fmt.Fprintf(&b, "<title>%s</title>", html.EscapeString(appTitle(cfg)))
	b.WriteString("<style>body{font-family:system-ui,sans-serif;max-width:52rem;margin:0 auto;padding:1rem}")
	b.WriteString("form{display:flex;gap:.5rem;margin:1rem 0}textarea{flex:1;min-height:3rem}")
	b.WriteString("li{margin:.5rem 0;padding:.5rem;border:1px solid #ddd;border-radius:.5rem}")
	b.WriteString(".meta{color:#666;font-size:.85rem}</style></head><body>")
	fmt.Fprintf(&b, "<h1>%s</h1>", html.EscapeString(appTitle(cfg)))
	fmt.Fprintf(&b, "<p class=\"meta\">当前身份：%s（%s）</p>",
		html.EscapeString(usernameOf(req.User)), html.EscapeString(displayNameOf(req.User)))
	if flash != "" {
		fmt.Fprintf(&b, "<p><strong>%s</strong></p>", html.EscapeString(flash))
	}
	fmt.Fprintf(&b, "<form method=\"post\" action=\"/api/notes\"><textarea name=\"body\" maxlength=\"2000\" "+
		"placeholder=\"写点什么给同事看…\"></textarea><button type=\"submit\">发布</button></form>")
	fmt.Fprintf(&b, "<form method=\"post\" action=\"/api/summary\"><button type=\"submit\">用 AI 总结最近便签</button>")
	b.WriteString("<span class=\"meta\">（会等几秒，费用从你自己的额度扣）</span></form>")
	if len(notes) == 0 {
		b.WriteString("<p>还没有便签。</p>")
	} else {
		b.WriteString("<ul>")
		for _, n := range notes {
			fmt.Fprintf(&b, "<li><div>%s</div><div class=\"meta\">%s · %s</div></li>",
				html.EscapeString(n.Body), html.EscapeString(n.Author), html.EscapeString(n.CreatedAt))
		}
		b.WriteString("</ul>")
	}
	b.WriteString("</body></html>")
	return b.String()
}

// noAccessPage 是无权限页：**必须显示本人账号**，否则作者无从发现名单拼写错误。
func noAccessPage(u *user, cfg appConfig) string {
	var b strings.Builder
	b.WriteString("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">")
	b.WriteString("<title>无访问权限</title></head><body>")
	fmt.Fprintf(&b, "<h1>%s</h1>", html.EscapeString(appTitle(cfg)))
	b.WriteString("<p>你不在这个应用的使用名单里。</p>")
	fmt.Fprintf(&b, "<p>你的账号：<strong>%s</strong>（ID %d）</p>",
		html.EscapeString(usernameOf(u)), idOf(u))
	if u != nil && u.DisplayName != "" {
		fmt.Fprintf(&b, "<p>显示名：%s</p>", html.EscapeString(u.DisplayName))
	}
	b.WriteString("<p>把这个账号发给应用负责人，让他加进名单并发布新版本。</p>")
	b.WriteString("</body></html>")
	return b.String()
}

// textPage 是极简纯文本页（错误提示用）。
func textPage(title, msg string) string {
	return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>" +
		html.EscapeString(title) + "</title></head><body><h1>" + html.EscapeString(title) +
		"</h1><p>" + html.EscapeString(msg) + "</p></body></html>"
}

// appTitle 用配置里的用途做标题；缺省给一个中性名字。
func appTitle(cfg appConfig) string {
	if cfg.Purpose != "" {
		return cfg.Purpose
	}
	return "团队共享便签"
}

// hostFailure 把宿主调用失败翻译成人话，并把原始码打进日志（诊断的第一手材料）。
func hostFailure(out io.Writer, h *host, what string, err error) error {
	code, msg := "UNKNOWN", err.Error()
	if rpc, ok := asRPCError(err); ok {
		code, msg = string(rpc.Code), rpc.Message
	}
	_ = h.logf("error", "%s: code=%s message=%s", what, code, msg)
	return writeResponse(out, statusFor(code), textPage(what, humanMessage(code, msg)))
}

// statusFor 把失败码映射成给浏览器看的 HTTP 状态。
func statusFor(code string) int {
	switch code {
	case codeDBLimit:
		return 507
	case codeAppQueueFull, codeAIRateLimited:
		return 429
	case codeAIBalanceInsufficient:
		return 402
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
func humanMessage(code, fallback string) string {
	switch code {
	case codeDBLimit:
		return "应用数据已达平台上限，请联系应用负责人清理历史数据。"
	case codeAppQueueFull:
		return "当前使用的人有点多，请稍后重试。"
	case codeAIRateLimited:
		return "AI 调用太频繁了，请稍后重试。"
	case codeAIBalanceInsufficient:
		return "你的账户余额不足，请到桌面客户端查看余额后重试。"
	case codeAuthRequired:
		return "请先登录后再使用本应用。"
	default:
		return fallback
	}
}

// ===== 宿主调用客户端 =====

// 宿主方法名（封闭清单：这九个就是全部能力）。
const (
	hostDBDefine   = "db.define"
	hostDBQuery    = "db.query"
	hostDBExec     = "db.exec"
	hostAIChat     = "ai.chat"
	hostLog        = "log"
	hostAssetsRead = "assets.read"
)

// 平台错误码（只列应用会分支处理的几个；完整表见 references/abi.md）。
const (
	codeAIBalanceInsufficient = "AI_BALANCE_INSUFFICIENT"
	codeAIRateLimited         = "AI_RATE_LIMITED"
	codeAuthRequired          = "AUTH_REQUIRED"
	codeDBDenied              = "DB_DENIED"
	codeDBLimit               = "DB_LIMIT"
	codeAppQueueFull          = "APP_QUEUE_FULL"
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

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type aiChatParams struct {
	Messages []chatMessage `json:"messages"`
}

type aiChatResult struct {
	Content string `json:"content"`
	Model   string `json:"model"`
}

type logParams struct {
	Level   string `json:"level"`
	Message string `json:"message"`
}

// appConfig 是 picoaide.app.json 的结构（字段集合封闭：多一个字段平台就拒发布；
// 完整字段规格见 skill 的 references/app-config.md）。
//
// access 三模式（2026-09-18 收敛）：public 允许匿名；login 要求登录、登录后全员可用
// （缺省）；whitelist 要求登录 + 名单准入。**名单判定在应用自己这里**（平台不比对）。
type appConfig struct {
	Access          string   `json:"access"`
	Whitelist       []string `json:"whitelist"`
	Purpose         string   `json:"purpose"`
	DataSensitivity string   `json:"data_sensitivity"`
	Owner           string   `json:"owner"`
}

// loadConfig 读应用自己的配置：发布期它和静态资源一起被抽到宿主磁盘，用 assets.read 取。
func loadConfig(h *host) (appConfig, error) {
	raw, err := h.call(hostAssetsRead, assetsReadParams{Path: appConfigFile})
	if err != nil {
		return appConfig{}, err
	}
	var res struct {
		ContentType string `json:"content_type"`
		Size        int    `json:"size"`
		Text        string `json:"text"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return appConfig{}, fmt.Errorf("解析 assets.read 结果: %w", err)
	}
	var cfg appConfig
	if err := json.Unmarshal([]byte(res.Text), &cfg); err != nil {
		return appConfig{}, fmt.Errorf("解析 %s: %w", appConfigFile, err)
	}
	return cfg, nil
}

type assetsReadParams struct {
	Path string `json:"path"`
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

// writeResponse 写最终响应信封（写好立刻 flush）。
func writeResponse(out io.Writer, status int, body string) error {
	payload, err := json.Marshal(response{
		Status:  status,
		Headers: map[string]string{"Content-Type": "text/html; charset=utf-8"},
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

// usernameOf / displayNameOf / idOf 对 nil 安全：匿名请求（public 应用）时 user 是 null。
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

// clipRunes 按字符截断（避免把半个 UTF-8 字符塞进提示词）。
func clipRunes(s string, max int) string {
	rs := []rune(s)
	if len(rs) <= max {
		return s
	}
	return string(rs[:max]) + "…"
}

// sortedWhitelist 只用于日志/排查：把名单排序后输出，便于人工核对。
func sortedWhitelist(cfg appConfig) string {
	cp := append([]string(nil), cfg.Whitelist...)
	sort.Strings(cp)
	return strings.Join(cp, ",")
}
