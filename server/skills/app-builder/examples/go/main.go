// Command shared-notes 是 PicoAide 应用平台上的一个**真实小应用**：团队共享便签墙。
//
// 它是作者与 AI 的黄金路径样板（拷走这个目录就能改出自己的应用），刻意覆盖了
// 一篇应用代码必须处理好的六件事：
//
//  1. 读请求帧（RS + 十进制长度 + '\n' + JSON）→ 取当前使用者 `user`；
//  2. 读自己的配置 `picoaide.app.json`（assets.read）→ 白名单判定；
//  3. 无权限页**显示本人账号**（作者发现名单拼错的唯一途径）；
//  4. db.define 幂等建表 + db.query 列表 + db.exec 写入（单语句、参数化）；
//  5. AI 走**前端桥**：服务端的 `ai.chat` 宿主能力已删除，wasm 侧**没有任何 AI 调用** ——
//     页面里的 JS 直接 fetch 客户端保留路径（**双下划线**，见 aiChatPath 常量），流式拿到回答后
//     POST 回本应用的 /api/summaries，由 wasm 写进应用库并在页面回显；
//  6. 每个分支都写且只写一帧响应信封；日志走 log 宿主调用（不污染 stdout 协议）。
//
// 平台没有的能力（不要试图在示例上"扩展"出来）：联网、文件、线程、子进程、环境变量、
// cookie（自定义协议下 `document.cookie` 恒为空、`Set-Cookie` 不落盘 ⇒ 状态只能进应用库）、
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

	// 身份：平台一律要求登录（没有匿名面）。login / whitelist 要求宿主已验证身份
	//（这里是防御式自查，也是本地预览能验证的分支）；public 是历史配置值，
	// 读取侧已按 login 处理，保留该分支只为兼容历史应用，不要在新应用里依赖它。
	switch req.Auth.Mode {
	case "login", "whitelist":
		if req.User == nil || !req.Auth.Verified {
			return writeResponse(out, 401, textPage("请先登录", "本应用需要登录后使用。"))
		}
	case "public":
		// 历史形态（平台已不再产生匿名请求）：下面所有分支都必须能处理 user == nil。
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
		summaries, err := listSummaries(h, summaryLimit)
		if err != nil {
			return hostFailure(out, h, "读取 AI 总结失败", err)
		}
		return writeResponse(out, 200, page(req, cfg, notes, summaries, ""))
	case req.Method == "POST" && req.Path == "/api/notes":
		form, _ := url.ParseQuery(req.Body)
		body := strings.TrimSpace(form.Get("body"))
		if body == "" {
			notes, _ := listNotes(h, listLimit)
			summaries, _ := listSummaries(h, summaryLimit)
			return writeResponse(out, 400, page(req, cfg, notes, summaries, "便签内容不能为空。"))
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
		summaries, err := listSummaries(h, summaryLimit)
		if err != nil {
			return hostFailure(out, h, "读取 AI 总结失败", err)
		}
		return writeResponse(out, 200, page(req, cfg, notes, summaries, "已保存。"))
	case req.Method == "POST" && req.Path == "/api/summaries":
		// AI 结果**回传落库**（§21.2 的「前端调 AI → 结果回传 wasm 落库」）。
		//
		// 这条路由的请求来自**页面里的 JS**（前端桥拿到回答之后 POST 过来），
		// wasm 侧只做校验 + 入库：它自己一行 AI 调用都没有（服务端的 ai.chat 已删除）。
		form, _ := url.ParseQuery(req.Body)
		answer := strings.TrimSpace(form.Get("summary"))
		if answer == "" {
			notes, _ := listNotes(h, listLimit)
			summaries, _ := listSummaries(h, summaryLimit)
			return writeResponse(out, 400, page(req, cfg, notes, summaries, "AI 回答是空的，没有落库。"))
		}
		if err := saveSummary(h, req.User, clipRunes(answer, summaryMaxRunes)); err != nil {
			return hostFailure(out, h, "保存 AI 总结失败", err)
		}
		notes, err := listNotes(h, listLimit)
		if err != nil {
			return hostFailure(out, h, "读取便签失败", err)
		}
		summaries, err := listSummaries(h, summaryLimit)
		if err != nil {
			return hostFailure(out, h, "读取 AI 总结失败", err)
		}
		return writeResponse(out, 200, page(req, cfg, notes, summaries, "AI 总结已存入应用库。"))
	default:
		return writeResponse(out, 404, textPage("页面不存在", "检查一下链接，或回到应用首页。"))
	}
}

// ===== 业务逻辑 =====

// listLimit 是一次列表请求最多显示多少条便签（配合 db.query 的 LIMIT，避免拉全表）。
const listLimit = 50

// AI 总结相关的三个上限（都归应用自己管）：
//   - summaryLimit：页面最多回显几条已落库的总结；
//   - summaryNoteCount / summaryNoteRunes：拼提示词时最多带几条便签、每条截多长。
//
// 后两个是**必须**的：前端桥对单条消息的上限是 16 KiB（超了整次调用直接 400 app_ai_invalid），
// 而便签的条数与长度都不可控 ⇒ 在应用侧先截断，宁可少总结几条，也不要整次调用失败。
const (
	summaryLimit     = 3
	summaryNoteCount = 20
	summaryNoteRunes = 200
	summaryMaxRunes  = 4000
)

// note 是一条便签（表结构由 db.define 声明；平台自动维护行号列，应用看不到）。
type note struct {
	Author    string
	Body      string
	CreatedAt string
}

// summary 是一条已落库的 AI 总结：由**页面**的前端桥拿回回答、POST 回 /api/summaries，
// 再由 wasm 写进应用库（这就是 §21.2 要的"前端调 AI → 结果回传 wasm 落库"）。
type summary struct {
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

// listSummaries 读最近几条 AI 总结（最新在前；表里的行都由 /api/summaries 写入）。
//
// 列名对不上就当作"还没有总结"：本地预览脚本（preview.mjs）的假宿主是内存版、只实现了
// notes 表 —— 任何 db.query 都会回便签行。线上平台按真实 SQL 返回，这条防御只在预览里生效，
// 免得把便签渲染成"AI 总结"。
func listSummaries(h *host, limit int) ([]summary, error) {
	raw, err := h.call(hostDBQuery, sqlParams{
		SQL:  "SELECT author, summary, created_at FROM summaries ORDER BY created_at DESC LIMIT ?",
		Args: []any{limit},
	})
	if err != nil {
		return nil, err
	}
	var res queryResult
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, fmt.Errorf("解析查询结果: %w", err)
	}
	ai, si, ci := colIndex(res.Columns, "author"), colIndex(res.Columns, "summary"), colIndex(res.Columns, "created_at")
	if ai < 0 || si < 0 || ci < 0 {
		return nil, nil
	}
	summaries := make([]summary, 0, len(res.Rows))
	for _, row := range res.Rows {
		summaries = append(summaries, summary{
			Author:    cellAt(row, ai),
			Body:      cellAt(row, si),
			CreatedAt: cellAt(row, ci),
		})
	}
	return summaries, nil
}

// saveSummary 把前端桥拿回来的回答写进应用库 —— **应用里唯一写 AI 结果的地方**。
//
// 作者记当前使用者：同一应用内所有人共享数据，所以要留痕"这条总结是谁生成的"。
//
// preview.mjs 的边界：那个假宿主是内存版、只实现了 notes 表，所以本地预览
// `--path /api/summaries` 会拿到 DB_DENIED（线上平台按真实 SQL 执行，不受影响）；
// 前端桥本身也不可能在预览里跑 —— 预览没有浏览器，wasm 侧本来也没有 AI。
func saveSummary(h *host, u *user, answer string) error {
	_, err := h.call(hostDBExec, sqlParams{
		SQL:  "INSERT INTO summaries (author, summary, created_at) VALUES (?, ?, ?)",
		Args: []any{usernameOf(u), answer, time.Now().UTC().Format(time.RFC3339)},
	})
	return err
}

// summaryPrompt 把最近便签拼成**一条 user 消息**（前端桥只接受 user / assistant 两种角色：
// 应用不能声明系统提示，桥也不注入记忆与用户历史 —— 想给模型的指令就写在消息正文里）。
//
// 逐条截断 + 限量见上面的常量：桥对单条消息有 16 KiB 硬上限。
func summaryPrompt(notes []note) string {
	var sb strings.Builder
	sb.WriteString("请用不超过五句话总结下面这些团队便签的要点与待办：\n")
	for i, n := range notes {
		if i >= summaryNoteCount {
			break
		}
		fmt.Fprintf(&sb, "- %s（%s）：%s\n", n.Author, n.CreatedAt, clipRunes(n.Body, summaryNoteRunes))
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

// ===== 页面 =====

// aiChatPath 是宿主保留的**应用 AI 桥**路径（§21.2 冻结：**双下划线** `__picoaide`）。
//
// 它由客户端协议 handler **本地**处理、绝不转发服务端；应用不得定义同前缀的自己路由
// （发布校验直接拒），其余 `__picoaide/*` 一律 404。服务端的 `ai.chat` 宿主能力已删除，
// 应用里的 AI 只剩这一条路：页面 JS fetch 它 → 结果 POST 回应用 → wasm 落库。
//
// ⚠️ **唯一真源**：页面说明与脚本里的路径都从这个常量注入，别处不要再抄一份字面量。
const aiChatPath = "/__picoaide/ai/chat"

// aiBridgeScriptTemplate 是前端桥的页面脚本（`%s` 处由 aiChatPath 注入）。
//
// 这一份就是完整链路：**按钮 → fetch 宿主 AI 桥（流式）→ 结果 POST 回 /api/summaries
// → wasm 落库 → 刷新读库**。照着改就能变成你自己的 AI 功能：
//   - 请求体只有 `{messages, stream}`，未知字段一律拒；role 只有 user / assistant；
//   - 流式响应是 `text/event-stream`：`delta` 事件带增量、`done` 收尾、`error` 报错；
//   - 失败一律 JSON 信封（`app_ai_denied` / `app_ai_unavailable` / `ai_balance_insufficient`
//     / `ai_rate_limited` / `ai_cancelled`，外加请求体非法的 `app_ai_invalid`）；
//   - 原生表单提交会被应用页的安全策略挡下，所以这里全程走 fetch。
//
// ⚠️ 路径只有 aiChatPath 一个真源，别在别处再抄一份字面量。
const aiBridgeScriptTemplate = `<script>
(function () {
  var PATH = "%s";
  var btn = document.getElementById("ai-summarize");
  var state = document.getElementById("ai-state");
  var out = document.getElementById("ai-out");
  var message = document.getElementById("ai-message");
  // 元素缺失就先退出：在可能为 null 的元素上链式调用会抛错，后面的注册就全不执行了。
  if (!btn || !state || !out) return;

  // 读流式回答：text/event-stream，event 为 delta / done / error，data 永远是单行 JSON。
  function readStream(resp, onDelta) {
    if (!resp.body || !resp.body.getReader) return resp.text();
    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    var acc = "";
    function handle(block) {
      var event = "message";
      var data = "";
      var lines = block.split("\n");
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf("event:") === 0) event = lines[i].slice(6).trim();
        else if (lines[i].indexOf("data:") === 0) data += lines[i].slice(5).trim();
      }
      if (data === "") return;
      var payload = null;
      try { payload = JSON.parse(data); } catch (e) { payload = null; }
      if (event === "delta") {
        acc += (payload && payload.delta) ? payload.delta : (payload === null ? data : "");
        onDelta(acc);
      } else if (event === "done") {
        if (payload && payload.content) { acc = payload.content; onDelta(acc); }
      } else if (event === "error") {
        throw new Error(payload && payload.error ? (payload.error.code + "：" + payload.error.message) : data);
      }
    }
    function pump() {
      return reader.read().then(function (chunk) {
        if (chunk.done) return acc;
        buffer += decoder.decode(chunk.value, { stream: true });
        var blocks = buffer.split("\n\n");
        buffer = blocks.pop();
        for (var i = 0; i < blocks.length; i++) handle(blocks[i]);
        return pump();
      });
    }
    return pump();
  }

  btn.addEventListener("click", function () {
    if (!message) { state.textContent = "还没有便签可以总结。"; return; }
    var text = "";
    try { text = JSON.parse(message.textContent); } catch (e) { text = ""; }
    if (text === "") { state.textContent = "还没有便签可以总结。"; return; }
    btn.disabled = true;
    state.textContent = "正在等 AI…（首次使用会先让你授权一次；费用记在你自己账上）";
    out.hidden = true;
    out.textContent = "";
    fetch(PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: text }], stream: true })
    }).then(function (resp) {
      if (!resp.ok) {
        // 失败一律 JSON 信封 {error:{code,message}} —— 把码显示出来，别只说"失败了"。
        return resp.json().catch(function () { return {}; }).then(function (body) {
          var err = (body && body.error) ? body.error : {};
          throw new Error((err.code || ("HTTP " + resp.status)) + (err.message ? "：" + err.message : ""));
        });
      }
      return readStream(resp, function (partial) {
        out.hidden = false;
        out.textContent = partial;
      }).then(function (answer) {
        answer = (answer || "").trim();
        if (answer === "") throw new Error("AI 返回了空回答");
        state.textContent = "已拿到回答，正在回传应用落库…";
        var data = new URLSearchParams();
        data.set("summary", answer);
        // 回传应用自己的路由：wasm 在那里把它写进 summaries 表。
        return fetch("/api/summaries", { method: "POST", body: data }).then(function (saved) {
          if (!saved.ok) throw new Error("落库失败：HTTP " + saved.status);
          state.textContent = "已写入应用库，正在刷新…";
          location.reload();
        });
      });
    }).catch(function (err) {
      btn.disabled = false;
      state.textContent = "AI 调用失败：" + ((err && err.message) ? err.message : String(err));
    });
  });
})();
</script>`

// page 渲染便签墙（内联 CSS；平台 CSP 允许自身源的 inline 样式，脚本要外链或内联在包里）。
func page(req *request, cfg appConfig, notes []note, summaries []summary, flash string) string {
	var b strings.Builder
	b.WriteString("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">")
	b.WriteString("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">")
	fmt.Fprintf(&b, "<title>%s</title>", html.EscapeString(appTitle(cfg)))
	b.WriteString("<style>body{font-family:system-ui,sans-serif;max-width:52rem;margin:0 auto;padding:1rem}")
	b.WriteString("form{display:flex;gap:.5rem;margin:1rem 0}textarea{flex:1;min-height:3rem}")
	b.WriteString("li{margin:.5rem 0;padding:.5rem;border:1px solid #ddd;border-radius:.5rem}")
	b.WriteString("pre{background:#f6f8fa;padding:.6rem;border-radius:.5rem;white-space:pre-wrap;word-break:break-word}")
	b.WriteString(".meta{color:#666;font-size:.85rem}</style></head><body>")
	fmt.Fprintf(&b, "<h1>%s</h1>", html.EscapeString(appTitle(cfg)))
	fmt.Fprintf(&b, "<p class=\"meta\">当前身份：%s（%s）</p>",
		html.EscapeString(usernameOf(req.User)), html.EscapeString(displayNameOf(req.User)))
	if flash != "" {
		fmt.Fprintf(&b, "<p><strong>%s</strong></p>", html.EscapeString(flash))
	}
	fmt.Fprintf(&b, "<form method=\"post\" action=\"/api/notes\"><textarea name=\"body\" maxlength=\"2000\" "+
		"placeholder=\"写点什么给同事看…\"></textarea><button type=\"submit\">发布</button></form>")
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

	// ── AI：前端桥（wasm 侧没有任何 AI 调用）──────────────────────────────
	b.WriteString("<h2>用 AI 总结（前端桥范例）</h2>")
	b.WriteString("<p class=\"meta\">wasm 调不到模型：下面这个按钮由页面里的 JS 直接 fetch 客户端保留路径 ")
	fmt.Fprintf(&b, "<code>POST %s</code>", html.EscapeString(aiChatPath))
	b.WriteString("（<strong>双下划线</strong> <code>__picoaide</code>，客户端协议 handler 本地处理、不经服务端），" +
		"把回答 POST 回本应用的 <code>/api/summaries</code>，由 wasm 写进应用库；" +
		"随后页面刷新，看到的就是库里的数据（同一应用内所有人可见）。</p>")
	b.WriteString("<button id=\"ai-summarize\" type=\"button\">用 AI 总结最近便签</button>")
	b.WriteString("<span class=\"meta\" id=\"ai-state\"></span>")
	b.WriteString("<pre id=\"ai-out\" hidden></pre>")
	fmt.Fprintf(&b, aiBridgeScriptTemplate, aiChatPath)
	if len(notes) > 0 {
		// 要发给模型的那条 user 消息由 **wasm（应用侧）**拼好并截断到桥的上限内，
		// 前端脚本只负责把它放进 messages。嵌进 <script> 用 json.Marshal：
		// 它默认把 <、>、& 转义成 \u003c 等，所以不会被提前闭合。
		if payload, err := json.Marshal(summaryPrompt(notes)); err == nil {
			fmt.Fprintf(&b, "<script type=\"application/json\" id=\"ai-message\">%s</script>", payload)
		}
	}
	b.WriteString("<h3>已落库的 AI 总结</h3>")
	if len(summaries) == 0 {
		b.WriteString("<p class=\"meta\">还没有总结。</p>")
	} else {
		b.WriteString("<ul>")
		for _, s := range summaries {
			fmt.Fprintf(&b, "<li><div>%s</div><div class=\"meta\">%s · %s</div></li>",
				html.EscapeString(s.Body), html.EscapeString(s.Author), html.EscapeString(s.CreatedAt))
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

// statusFor 把失败码映射成给打开应用的客户端看的 HTTP 状态。
//
// 这里没有 AI 相关的码：AI 错误发生在**页面**的前端桥调用上，由脚本按 §21.2 的
// JSON 信封自己处理，不会以宿主错误码的形式回到 wasm。
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
func humanMessage(code, fallback string) string {
	switch code {
	case codeDBLimit:
		return "应用数据已达平台上限，请联系应用负责人清理历史数据。"
	case codeAppQueueFull:
		return "当前使用的人有点多，请稍后重试。"
	case codeAuthRequired:
		return "请先登录后再使用本应用。"
	default:
		return fallback
	}
}

// ===== 宿主调用客户端 =====

// 宿主方法名（示例用到的封闭清单；完整清单见 references/abi.md）。
//
// ⚠️ 这里**没有 ai.chat**：服务端已删除该宿主能力，应用里的 AI 只能走页面里的前端桥
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
