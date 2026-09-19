// Command appdemo 是随服务端镜像分发的**内置演示应用**（2026-09-19 用户要求：
// 「代码仓库里也要有几个 demo，各种权限模式的，安装以后就能给客户演示」）。
//
// 设计取舍：**一份 wasm，播种成三个应用**（demo-public / demo-login / demo-whitelist），
// 三种权限模式由平台侧的 `access` 配置决定，应用只负责把「我现在处在哪种模式、
// 平台给了我什么身份」如实渲染出来 —— 这恰好是演示要讲的重点（准入由平台管，
// 应用代码不用改）。
//
// 演示内容（页面上都能看到）：
//  1. 访问模式卡片：来自请求帧的 `auth.mode` / `auth.verified`；
//  2. 身份卡片：`user` 字段（匿名时为 nil ⇒ 不渲染任何账号信息，§7.1 第 4 条）；
//  3. 共享留言墙：db.define 建表 + db.query 读 + db.exec 写（同一应用内所有使用者共享）；
//  4. 宿主能力调用记录：本次请求真实调用过的方法与结果（不是写死的清单）；
//  5. **AI 前端桥范例**：wasm 侧没有任何 AI 调用 —— 服务端的 `ai.chat` 宿主能力已随
//     「客户端专属」改造**删除**，应用要调 AI 只能由页面里的 JS 直接 fetch 客户端保留路径
//     （双下划线 `__picoaide`，见下面的 aiChatPath 常量），拿到回答后再 POST 回应用自己的
//     `/ai-result`，由 wasm 写进应用库（db.define / db.exec / db.query）并在页面回显。
//
// 语言面：仅 portable Go 标准库 + 平台内部的 abi 契约包（内置演示随镜像构建，
// 与外部作者不同：外部作者照 skill 的 examples 自己实现帧协议）。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/url"
	"os"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
)

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "appdemo: %v\n", err)
		os.Exit(1)
	}
}

// trace 是一条宿主调用记录（回显到页面，证明"能力调用是真的发生了"）。
type trace struct {
	Method string
	OK     bool
	Note   string
}

func run(stdin io.Reader, stdout io.Writer) error {
	in := bufio.NewReader(stdin)
	out := bufio.NewWriter(stdout)

	payload, err := abi.ReadFrame(in)
	if err != nil {
		_ = writeResponse(out, 500, `<h1>协议错误</h1><p>读请求帧失败。</p>`)
		return fmt.Errorf("读请求帧: %w", err)
	}
	var req abi.Request
	if err := json.Unmarshal(payload, &req); err != nil {
		_ = writeResponse(out, 500, `<h1>协议错误</h1><p>解析请求帧失败。</p>`)
		return fmt.Errorf("解析请求帧: %w", err)
	}

	cl := &client{in: in, out: out}
	var traces []trace

	// 0) 读自己的配置（whitelist 由**应用**判：R24 明确平台不比对名单）。
	cfgRaw, cfgErr := readConfig(cl)
	allow, whitelist := decideAccess(req, cfgRaw, cfgErr)
	if !allow {
		html := renderDenied(req, whitelist)
		_ = writeResponse(out, 403, html)
		return nil
	}

	// 1) 声明表结构（DDL 只能由平台代执行；db.define 幂等）。
	res, rpcErr, err := cl.call(abi.MethodDBDefine, abi.DBDefineParams{
		Table: "wall",
		Columns: []abi.ColumnDef{
			{Name: "who", Type: "text"},
			{Name: "text", Type: "text"},
		},
	})
	traces = append(traces, mkTrace(abi.MethodDBDefine, res, rpcErr, err))

	// 1b) AI 问答的落库表：写它的是前端桥回传的 /ai-result（wasm 自己不调 AI）。
	res, rpcErr, err = cl.call(abi.MethodDBDefine, abi.DBDefineParams{
		Table: "ai_says",
		Columns: []abi.ColumnDef{
			{Name: "who", Type: "text"},
			{Name: "prompt", Type: "text"},
			{Name: "answer", Type: "text"},
		},
	})
	traces = append(traces, mkTrace(abi.MethodDBDefine, res, rpcErr, err))

	// 2) 写一条留言（POST /note，表单字段 note）。
	posted := ""
	if req.Method == "POST" && strings.HasPrefix(req.Path, "/note") {
		posted = formValue(req.Body, "note")
		if posted != "" {
			who := "匿名访客"
			if req.User != nil {
				who = req.User.Username
			}
			res, rpcErr, err = cl.call(abi.MethodDBExec, abi.SQLParams{
				SQL:  "INSERT INTO wall (who, text) VALUES (?, ?)",
				Args: []any{who, posted},
			})
			traces = append(traces, mkTrace(abi.MethodDBExec, res, rpcErr, err))
		}
	}

	// 3) 读回留言墙（最新 20 条）。
	var wall []wallRow
	res, rpcErr, err = cl.call(abi.MethodDBQuery, abi.SQLParams{
		SQL:  "SELECT who, text FROM wall ORDER BY _row_id DESC LIMIT 20",
		Args: []any{},
	})
	traces = append(traces, mkTrace(abi.MethodDBQuery, res, rpcErr, err))
	if rpcErr == nil && err == nil {
		var qr abi.QueryResult
		if json.Unmarshal(res, &qr) == nil {
			wi, ti := colIndex(qr.Columns, "who"), colIndex(qr.Columns, "text")
			for _, row := range qr.Rows {
				wall = append(wall, wallRow{Who: cell(row, wi), Text: cell(row, ti)})
			}
		}
	}

	// 4) 前端桥的**回传落库**端点：页面 JS 从宿主 AI 桥拿到回答后 POST 到这里。
	//    wasm 侧没有任何 AI 调用（服务端 ai.chat 已删除）：本分支只校验、入库、回显。
	//    结果由页面 JS 送进来，所以上限还得应用自己设（应用库的写入边界归应用管）。
	aiSaved := ""
	if req.Method == "POST" && strings.HasPrefix(req.Path, "/ai-result") {
		ask := formValueMax(req.Body, "prompt", 500)
		answer := formValueMax(req.Body, "answer", 4000)
		if answer != "" {
			who := "（未登录）"
			if req.User != nil {
				who = req.User.Username
			}
			res, rpcErr, err = cl.call(abi.MethodDBExec, abi.SQLParams{
				SQL:  "INSERT INTO ai_says (who, prompt, answer) VALUES (?, ?, ?)",
				Args: []any{who, ask, answer},
			})
			traces = append(traces, mkTrace(abi.MethodDBExec, res, rpcErr, err))
			if rpcErr == nil && err == nil {
				aiSaved = "AI 回答已写入应用库（作者：" + who + "）"
			}
		}
	}

	// 5) 读回已落库的 AI 问答（最新 5 条）：刷新页面也能看到 ⇒ 证明它真的进了库。
	var aiRows []aiRow
	res, rpcErr, err = cl.call(abi.MethodDBQuery, abi.SQLParams{
		SQL:  "SELECT who, prompt, answer FROM ai_says ORDER BY _row_id DESC LIMIT 5",
		Args: []any{},
	})
	traces = append(traces, mkTrace(abi.MethodDBQuery, res, rpcErr, err))
	if rpcErr == nil && err == nil {
		var qr abi.QueryResult
		if json.Unmarshal(res, &qr) == nil {
			wi, pi, ai := colIndex(qr.Columns, "who"), colIndex(qr.Columns, "prompt"), colIndex(qr.Columns, "answer")
			for _, row := range qr.Rows {
				aiRows = append(aiRows, aiRow{Who: cell(row, wi), Prompt: cell(row, pi), Answer: cell(row, ai)})
			}
		}
	}

	// 6) 日志（走 log 宿主调用：有级别与条数管理，不污染 stdout 帧）。
	if _, _, lerr := cl.call(abi.MethodLog, abi.LogParams{Level: "info", Message: "appdemo: " + req.Path}); lerr == nil {
		traces = append(traces, trace{Method: abi.MethodLog, OK: true})
	} else {
		traces = append(traces, trace{Method: abi.MethodLog, Note: lerr.Error()})
	}

	html := render(req, wall, aiRows, traces, posted, aiSaved)
	return writeResponse(out, 200, html)
}

// ===== 帧协议胶水（与 skill 示例同构，只是写得更短）=====

type client struct {
	in     *bufio.Reader
	out    *bufio.Writer
	nextID int64
}

func (c *client) call(method string, params any) (json.RawMessage, *abi.RPCErrorBody, error) {
	c.nextID++
	id, _ := json.Marshal(c.nextID)
	rawParams, err := json.Marshal(params)
	if err != nil {
		return nil, nil, err
	}
	reqPayload, err := json.Marshal(abi.RPCRequest{JSONRPC: "2.0", ID: id, Method: method, Params: rawParams})
	if err != nil {
		return nil, nil, err
	}
	if err := abi.WriteFrame(c.out, reqPayload); err != nil {
		return nil, nil, err
	}
	// ⚠️ 必须显式 Flush：abi.WriteFrame 只写缓冲（宿主看不到未刷出的帧，
	// 症状是 guest 一直等响应直到 RUNTIME_TIMEOUT，host_call_count=0）。
	if err := c.out.Flush(); err != nil {
		return nil, nil, err
	}
	respPayload, err := abi.ReadFrame(c.in)
	if err != nil {
		return nil, nil, err
	}
	var resp struct {
		Result json.RawMessage   `json:"result"`
		Error  *abi.RPCErrorBody `json:"error"`
	}
	if err := json.Unmarshal(respPayload, &resp); err != nil {
		return nil, nil, err
	}
	if resp.Error != nil {
		return nil, resp.Error, nil
	}
	return resp.Result, nil, nil
}

func mkTrace(method string, _ json.RawMessage, rpcErr *abi.RPCErrorBody, err error) trace {
	switch {
	case err != nil:
		return trace{Method: method, Note: "协议层失败: " + err.Error()}
	case rpcErr != nil:
		return trace{Method: method, Note: rpcErr.Code + ": " + rpcErr.Message}
	default:
		return trace{Method: method, OK: true}
	}
}

func writeResponse(out *bufio.Writer, status int, body string) error {
	payload, err := json.Marshal(abi.Response{
		Status:  status,
		Headers: map[string]string{"content-type": "text/html; charset=utf-8"},
		Body:    body,
	})
	if err != nil {
		return err
	}
	if err := abi.WriteFrame(out, payload); err != nil {
		return err
	}
	return out.Flush()
}

func formValue(body, key string) string {
	return formValueMax(body, key, 200)
}

// formValueMax 取表单字段并按**字符**（不是字节）截断：AI 回答可以长一些，但仍然要有上限
// —— 应用库的写入边界归应用自己管（平台另有更硬的行/库上限）。
func formValueMax(body, key string, max int) string {
	values, err := url.ParseQuery(body)
	if err != nil {
		return ""
	}
	v := strings.TrimSpace(values.Get(key))
	if rs := []rune(v); len(rs) > max {
		v = string(rs[:max])
	}
	return v
}

// ===== AI 前端桥（wasm 侧没有任何 AI 调用）=====

// aiChatPath 是宿主保留的**应用 AI 桥**路径（§21.2 冻结：**双下划线** `__picoaide`）。
//
// 它不是"平台接口"：请求由客户端协议 handler **本地**处理、绝不转发服务端；应用也不得
// 定义同前缀的自己路由（发布校验直接拒），其余 `__picoaide/*` 一律 404。
// 服务端的 `ai.chat` 宿主能力已删除，应用要 AI 只剩这一条路 —— 页面 JS fetch 它，
// 拿到回答后 POST 回应用自己的路由，由 wasm 落库。
//
// ⚠️ **唯一真源**：页面说明文字与脚本里的路径都从这个常量注入，别处不要再抄一份字面量。
const aiChatPath = "/__picoaide/ai/chat"

// aiBridgeForm 是「问 AI」表单（原生提交一律被脚本 preventDefault 掉，全程走 fetch）。
const aiBridgeForm = `<form id="ai-form"><input id="ai-prompt" type="text" maxlength="500" placeholder="问 AI 一句话…" autocomplete="off" required><button type="submit">问 AI</button><span id="ai-state" class="muted"></span></form><pre id="ai-out" class="ai-out" hidden></pre>`

// aiBridgeScriptTemplate 是应用页里的前端桥脚本（`%s` 处由 aiChatPath 注入）。
//
// 这一份就是完整范例：**前端 fetch 宿主 AI 桥 → 流式渲染 → 结果回传应用自己的路由 → wasm 落库**。
// 里面把三件事写全了：保留路径常量、SSE 解析（delta / done / error 三种事件）、
// 失败一律 JSON 信封（app_ai_denied / app_ai_unavailable / ai_balance_insufficient /
// ai_rate_limited / ai_cancelled，外加请求体非法的 app_ai_invalid）。
const aiBridgeScriptTemplate = `<script>
(function () {
  var PATH = "%s";
  var form = document.getElementById("ai-form");
  var input = document.getElementById("ai-prompt");
  var state = document.getElementById("ai-state");
  var out = document.getElementById("ai-out");
  // 元素缺失就先退出：在可能为 null 的元素上链式调用会抛错，后面的注册就全不执行了。
  if (!form || !input || !state || !out) return;

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

  form.addEventListener("submit", function (ev) {
    // 全程走 fetch：原生表单提交会被应用页的安全策略（form-action）挡下，所以先阻止默认提交。
    ev.preventDefault();
    var prompt = input.value.trim();
    if (prompt === "") return;
    state.textContent = "正在等 AI…（首次使用会先让你授权一次）";
    out.hidden = true;
    out.textContent = "";
    fetch(PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: prompt }], stream: true })
    }).then(function (resp) {
      if (!resp.ok) {
        // 失败一律 JSON 信封 {error:{code,message}} —— 把码显示出来，别只说"失败了"。
        return resp.json().catch(function () { return {}; }).then(function (body) {
          var err = (body && body.error) ? body.error : {};
          throw new Error((err.code || ("HTTP " + resp.status)) + (err.message ? "：" + err.message : ""));
        });
      }
      return readStream(resp, function (text) {
        out.hidden = false;
        out.textContent = text;
      }).then(function (answer) {
        answer = (answer || "").trim();
        if (answer === "") throw new Error("AI 返回了空回答");
        state.textContent = "已拿到回答，正在回传应用落库…";
        var data = new URLSearchParams();
        data.set("prompt", prompt);
        data.set("answer", answer);
        return fetch("/ai-result", { method: "POST", body: data }).then(function (savedResp) {
          if (!savedResp.ok) throw new Error("落库失败：HTTP " + savedResp.status);
          state.textContent = "已写入应用库，正在刷新…";
          location.reload();
        });
      });
    }).catch(function (err) {
      state.textContent = "AI 调用失败：" + ((err && err.message) ? err.message : String(err));
    });
  });
})();
</script>`

// ===== 页面 =====

func render(req abi.Request, rows []wallRow, aiRows []aiRow, traces []trace, posted, saved string) string {
	var b strings.Builder
	b.WriteString(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`)
	b.WriteString(`<meta name="viewport" content="width=device-width,initial-scale=1">`)
	fmt.Fprintf(&b, `<title>%s · 内置演示应用</title>`, html.EscapeString(req.AppID))
	b.WriteString(style)
	b.WriteString(`</head><body><main class="wrap">`)
	fmt.Fprintf(&b, `<h1>内置演示应用 <code>%s</code></h1>`, html.EscapeString(req.AppID))
	b.WriteString(`<p class="lede">这是随服务端镜像分发的演示应用：同一份 wasm，按平台的 <code>access</code> 配置播种成三种权限模式。准入由平台判定，应用代码不需要为权限模式写分支。</p>`)

	// 访问模式
	b.WriteString(`<section class="card"><h2>访问模式</h2><dl>`)
	fmt.Fprintf(&b, `<dt>mode</dt><dd><code>%s</code>（%s）</dd>`, html.EscapeString(string(req.Auth.Mode)), modeText(req.Auth.Mode))
	fmt.Fprintf(&b, `<dt>verified</dt><dd>%v</dd>`, req.Auth.Verified)
	fmt.Fprintf(&b, `<dt>ABI</dt><dd><code>%s</code></dd>`, html.EscapeString(req.ABI))
	fmt.Fprintf(&b, `<dt>版本</dt><dd>%s</dd>`, html.EscapeString(req.Version))
	b.WriteString(`</dl></section>`)

	// 身份
	b.WriteString(`<section class="card"><h2>平台注入的身份</h2>`)
	if req.User == nil {
		b.WriteString(`<p class="muted">本次请求是<strong>匿名</strong>的：请求帧里 <code>user</code> 为 <code>null</code>，应用不渲染任何账号信息（§7.1）。</p>`)
	} else {
		b.WriteString(`<dl>`)
		fmt.Fprintf(&b, `<dt>账号</dt><dd>%s</dd>`, html.EscapeString(req.User.Username))
		fmt.Fprintf(&b, `<dt>用户 ID</dt><dd>%d</dd>`, req.User.ID)
		fmt.Fprintf(&b, `<dt>显示名</dt><dd>%s</dd>`, html.EscapeString(orDash(req.User.DisplayName)))
		fmt.Fprintf(&b, `<dt>部门</dt><dd>%s</dd>`, html.EscapeString(orDash(req.User.Dept)))
		fmt.Fprintf(&b, `<dt>是否发布者</dt><dd>%v</dd>`, req.User.IsPublisher)
		b.WriteString(`</dl>`)
	}
	b.WriteString(`</section>`)

	// 留言墙
	fmt.Fprintf(&b, `<section class="card"><h2>共享留言墙（平台数据库，%d 条）</h2>`, len(rows))
	if posted != "" {
		fmt.Fprintf(&b, `<p class="ok">已写入：%s</p>`, html.EscapeString(posted))
	}
	b.WriteString(`<form method="post" action="/note"><input type="text" name="note" maxlength="200" placeholder="写一句话…" autocomplete="off" required><button type="submit">写入留言墙</button></form>`)
	if len(rows) == 0 {
		b.WriteString(`<p class="muted">还没有留言，写下第一条。</p>`)
	} else {
		b.WriteString(`<ul class="wall">`)
		for _, r := range rows {
			fmt.Fprintf(&b, `<li><strong>%s</strong>：%s</li>`, html.EscapeString(r.Who), html.EscapeString(r.Text))
		}
		b.WriteString(`</ul>`)
	}
	b.WriteString(`<p class="muted">同一应用内所有使用者共享这一份数据（平台不做行级隔离）。</p></section>`)

	// AI 前端桥范例（服务端 ai.chat 已删除：wasm 侧一行 AI 调用都没有）
	fmt.Fprintf(&b, `<section class="card"><h2>问 AI（前端桥范例）</h2><p class="muted">服务端的 <code>ai.chat</code> 宿主能力<strong>已删除</strong>：wasm 侧不再有任何 AI 调用。下面这个表单由页面里的 JS 直接调宿主保留路径 <code>POST %s</code>（<strong>双下划线</strong> <code>__picoaide</code>；由客户端协议 handler 本地处理、绝不转发平台），拿到回答后再 <code>POST</code> 回应用自己的 <code>/ai-result</code>，由 wasm 写进应用库并在下方回显。</p>`, html.EscapeString(aiChatPath))
	if req.User == nil {
		b.WriteString(`<p class="muted">AI 桥要按使用者授权与计费，需要已登录身份：历史 public 帧下不提供。</p>`)
	} else {
		b.WriteString(aiBridgeForm)
		fmt.Fprintf(&b, aiBridgeScriptTemplate, aiChatPath)
	}
	if saved != "" {
		fmt.Fprintf(&b, `<p class="ok">%s</p>`, html.EscapeString(saved))
	}
	if len(aiRows) == 0 {
		b.WriteString(`<p class="muted">应用库里还没有 AI 问答记录。</p>`)
	} else {
		b.WriteString(`<ul class="wall">`)
		for _, r := range aiRows {
			fmt.Fprintf(&b, `<li><strong>%s</strong> 问：%s<br>AI 答：%s</li>`,
				html.EscapeString(r.Who), html.EscapeString(r.Prompt), html.EscapeString(r.Answer))
		}
		b.WriteString(`</ul>`)
	}
	b.WriteString(`<p class="muted">AI 桥是页面直接调的保留路径、<strong>不是宿主能力调用</strong>，所以它不会出现在下面的「调用轨迹」里 —— 轨迹里出现的是这一次请求真正发生过的 <code>db.*</code> / <code>log</code> 调用。</p></section>`)

	// 宿主调用轨迹
	b.WriteString(`<section class="card"><h2>本次请求真实调用过的宿主能力</h2><ul class="traces">`)
	for _, t := range traces {
		switch {
		case t.OK:
			fmt.Fprintf(&b, `<li><code>%s</code> <span class="ok">ok</span></li>`, html.EscapeString(t.Method))
		case t.Note != "":
			fmt.Fprintf(&b, `<li><code>%s</code> <span class="err">%s</span></li>`, html.EscapeString(t.Method), html.EscapeString(t.Note))
		}
	}
	b.WriteString(`</ul><p class="muted">这一行不是写死的：它是本次请求里应用自己记录的调用序列。</p></section>`)
	fmt.Fprintf(&b, `<p class="foot">内置演示应用 · 应用标识 <code>%s</code> · 可被管理员删除（删除后不会重建）</p>`, html.EscapeString(req.AppID))
	b.WriteString(`</main></body></html>`)
	return b.String()
}

// wallRow 是留言墙的一行（从 QueryResult 的列/行对里取出来）。
type wallRow struct{ Who, Text string }

// aiRow 是一条已落库的 AI 问答（前端桥回传、wasm 落库，本页读回来回显）。
type aiRow struct{ Who, Prompt, Answer string }

func colIndex(cols []string, name string) int {
	for i, c := range cols {
		if strings.EqualFold(c, name) {
			return i
		}
	}
	return -1
}

func cell(row []any, i int) string {
	if i < 0 || i >= len(row) {
		return ""
	}
	return toStr(row[i])
}

// appConfig 是应用自己的配置文件（picoaide.app.json）里演示用到的字段。
type appConfig struct {
	Access    string   `json:"access"`
	Whitelist []string `json:"whitelist"`
}

// readConfig 通过 assets.read 读自己的配置（保留文件之一，见平台 §4.2）。
func readConfig(cl *client) (appConfig, error) {
	res, rpcErr, err := cl.call(abi.MethodAssetsRead, abi.AssetsReadParams{Path: "picoaide.app.json"})
	if err != nil {
		return appConfig{}, err
	}
	if rpcErr != nil {
		return appConfig{}, fmt.Errorf("%s: %s", rpcErr.Code, rpcErr.Message)
	}
	var ar abi.AssetsReadResult
	if err := json.Unmarshal(res, &ar); err != nil {
		return appConfig{}, err
	}
	text := ar.Text
	if text == "" && ar.Base64 != "" {
		// 配置是纯文本，正常走 text 分支；base64 分支留给二进制资源。
		text = ""
	}
	var cfg appConfig
	if err := json.Unmarshal([]byte(text), &cfg); err != nil {
		return appConfig{}, err
	}
	return cfg, nil
}

// decideAccess 按 R24 判定本次请求是否放行：平台只告诉模式，名单由应用自己比。
// 返回 (是否放行, 名单)。
func decideAccess(req abi.Request, cfg appConfig, cfgErr error) (bool, []string) {
	if req.Auth.Mode != abi.AuthModeWhitelist {
		return true, nil
	}
	if cfgErr != nil {
		// 读不到配置就无法判定 ⇒ fail-closed（宁可拒绝，也不放行未校验的访问）。
		return false, nil
	}
	if req.User == nil {
		return false, cfg.Whitelist
	}
	for _, name := range cfg.Whitelist {
		if strings.EqualFold(strings.TrimSpace(name), req.User.Username) {
			return true, cfg.Whitelist
		}
	}
	return false, cfg.Whitelist
}

// renderDenied 是"名单外"的页面：**必须显示本人账号**（R24 原话），
// 否则用户会以为是自己没登录。
func renderDenied(req abi.Request, whitelist []string) string {
	who := "（未登录）"
	if req.User != nil {
		who = req.User.Username
	}
	var b strings.Builder
	b.WriteString(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`)
	fmt.Fprintf(&b, `<title>%s · 无访问权限</title>`, html.EscapeString(req.AppID))
	b.WriteString(style)
	b.WriteString(`</head><body><main class="wrap"><h1>403 · 不在访问名单里</h1>`)
	fmt.Fprintf(&b, `<section class="card"><h2>你的账号</h2><p><code>%s</code></p>`, html.EscapeString(who))
	b.WriteString(`<p class="muted">这是 <code>access=whitelist</code> 的演示应用：平台只负责"要求登录并告知模式"，**名单比对由应用自己完成**（读自己的 <code>picoaide.app.json</code>）。</p></section>`)
	if len(whitelist) > 0 {
		b.WriteString(`<section class="card"><h2>当前名单</h2><ul>`)
		for _, w := range whitelist {
			fmt.Fprintf(&b, `<li><code>%s</code></li>`, html.EscapeString(w))
		}
		b.WriteString(`</ul><p class="muted">管理员可在应用配置里维护这份名单。</p></section>`)
	}
	fmt.Fprintf(&b, `<p class="foot">内置演示应用 · <code>%s</code></p></main></body></html>`, html.EscapeString(req.AppID))
	return b.String()
}

func modeText(m abi.AuthMode) string {
	switch m {
	case abi.AuthModePublic:
		return "匿名可达"
	case abi.AuthModeWhitelist:
		return "仅名单内账号"
	default:
		return "登录后即可访问"
	}
}

func orDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "—"
	}
	return s
}

func toStr(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case nil:
		return ""
	default:
		b, _ := json.Marshal(x)
		return string(b)
	}
}

const style = `<style>
:root{--bg:#f5f6f9;--card:#fff;--ink:#1c2333;--muted:#68718a;--line:#e4e7f0;--accent:#2f6df6;--ok:#0f7a55;--err:#b3382c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);line-height:1.65;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:56rem;margin:0 auto;padding:2.2rem 1rem 3rem}h1{font-size:1.6rem;margin:.1rem 0 .5rem}
h2{font-size:.8rem;margin:0 0 .6rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.lede{font-size:1rem;color:#39425a;margin:0 0 1.3rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:.85rem;padding:1rem 1.1rem;margin:0 0 1rem;box-shadow:0 1px 2px rgba(16,24,40,.04)}
dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:.2rem .9rem;font-size:.92rem}dt{color:var(--muted);white-space:nowrap}dd{margin:0;word-break:break-word}
code{background:#eef1f7;border:1px solid #e2e6f0;border-radius:.35rem;padding:.05rem .32rem;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85em}
form{display:flex;gap:.5rem;margin:.5rem 0 .7rem;flex-wrap:wrap}
input[type=text]{flex:1;min-width:12rem;padding:.55rem .75rem;border:1px solid var(--line);border-radius:.55rem;font:inherit}
button,.btn{cursor:pointer;border:0;border-radius:.55rem;background:var(--accent);color:#fff;padding:.55rem 1rem;font:inherit;text-decoration:none;display:inline-block}
.wall{margin:.2rem 0 .6rem;padding-left:1.1rem}.wall li{margin:.15rem 0}
.muted{color:var(--muted);font-size:.88rem}.ok{color:var(--ok)}.err{color:var(--err)}
.traces{margin:.2rem 0 .4rem;padding-left:1.1rem}.traces li{margin:.12rem 0;font-size:.9rem}
blockquote{margin:.6rem 0 0;padding:.6rem .8rem;border-left:3px solid var(--accent);background:#f7f9ff;border-radius:.3rem}
pre.ai-out{margin:.6rem 0 0;padding:.6rem .8rem;border:1px solid var(--line);border-radius:.4rem;background:#f7f9ff;white-space:pre-wrap;word-break:break-word;font:inherit}
.foot{color:var(--muted);font-size:.82rem;margin-top:1.6rem;border-top:1px solid var(--line);padding-top:.8rem}
</style>`
