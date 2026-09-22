package llmgateway

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// 出站请求体加工（2026-09-22）：user_id 注入 + file_id 引用归属校验
// ---------------------------------------------------------------------------

// upstreamBody 取假上游收到的最后一次请求体（解析成 map）。
func upstreamBody(t *testing.T, up *fakeFilesUpstream) map[string]any {
	t.Helper()
	raw, _ := up.body.Load().(string)
	var body map[string]any
	if err := json.Unmarshal([]byte(raw), &body); err != nil {
		t.Fatalf("上游收到的请求体不是 JSON: %s", raw)
	}
	return body
}

// TestChatInjectsPlatformUserIDOverridingClientValue：每员工注入 `u<id>`，并**覆盖**
// 客户端自带值（否则第三方客户端可伪造他人身份做 KVCache 投毒/隔离逃逸）。
func TestChatInjectsPlatformUserIDOverridingClientValue(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	reqBody := `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"user_id":"spoofed-by-client"}`
	if w := doPost(t, gw.r, "/v1/chat/completions", reqBody, gw.tokenA, nil); w.Code != http.StatusOK {
		t.Fatalf("chat status = %d (%s)", w.Code, w.Body.String())
	}
	got, _ := upstreamBody(t, up)["user_id"].(string)
	want := fmt.Sprintf("u%d", gw.uidA)
	if got != want {
		t.Fatalf("上游 user_id = %q, want %q（平台侧注入并覆盖）", got, want)
	}
}

// TestChatInjectsPlatformUserIDWhenAbsent：客户端没给 user_id 时也要注入。
func TestChatInjectsPlatformUserIDWhenAbsent(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	reqBody := `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}`
	if w := doPost(t, gw.r, "/v1/chat/completions", reqBody, gw.tokenA, nil); w.Code != http.StatusOK {
		t.Fatalf("chat status = %d (%s)", w.Code, w.Body.String())
	}
	if got, _ := upstreamBody(t, up)["user_id"].(string); got != fmt.Sprintf("u%d", gw.uidA) {
		t.Fatalf("上游 user_id = %q, want u%d", got, gw.uidA)
	}
}

// TestAnthropicMessagesInjectsMetadataUserID：Anthropic 形态写 `metadata.user_id`
// （官方口径），同样覆盖客户端自带值，且不动 metadata 里别的键。
func TestAnthropicMessagesInjectsMetadataUserID(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	// Anthropic 路由只匹配 protocol=anthropic|both 的 provider。
	if _, err := gw.db.Exec(`UPDATE gateway_providers SET protocol = 'both'`); err != nil {
		t.Fatal(err)
	}
	InvalidateUpstreams() // 上游路由有 30s 缓存，改库后必须失效

	reqBody := `{"model":"deepseek-chat","max_tokens":64,"messages":[{"role":"user","content":"hi"}],"metadata":{"user_id":"spoofed","trace":"keep-me"}}`
	if w := doPost(t, gw.r, "/v1/messages", reqBody, gw.tokenA, nil); w.Code != http.StatusOK {
		t.Fatalf("messages status = %d (%s)", w.Code, w.Body.String())
	}
	meta, _ := upstreamBody(t, up)["metadata"].(map[string]any)
	if meta == nil {
		t.Fatalf("上游请求体缺 metadata")
	}
	if got, _ := meta["user_id"].(string); got != fmt.Sprintf("u%d", gw.uidA) {
		t.Fatalf("metadata.user_id = %q, want u%d", got, gw.uidA)
	}
	if got, _ := meta["trace"].(string); got != "keep-me" {
		t.Fatalf("metadata 其它键被破坏: %v", meta)
	}
}

// TestUndocumentedEndpointsDoNotGetUserID：官方文档没有 user_id 字段的端点
// （FIM / Responses）不注入未文档化字段，但仍走过出站加工（归属校验）。
func TestUndocumentedEndpointsDoNotGetUserID(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	if w := doPost(t, gw.r, "/v1/completions", `{"model":"deepseek-chat","prompt":"def f("}`, gw.tokenA, nil); w.Code != http.StatusOK {
		t.Fatalf("fim status = %d (%s)", w.Code, w.Body.String())
	}
	if _, present := upstreamBody(t, up)["user_id"]; present {
		t.Fatalf("FIM 请求不应注入未文档化的 user_id")
	}
}

// TestChatRejectsForeignFileReference：**本次审计外的真实洞** —— 员工知道了别人的
// file_id 后在聊天里引用它，上游会把别人的图片当输入读进去。归属台账在聊天路径上
// 同样必须生效：非本人的 id ⇒ 404，且**整条聊天请求都不发往上游**。
func TestChatRejectsForeignFileReference(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	// A 上传一张图（记归属）
	body, ct := multipartBytes(t, "alice-secret-image")
	if w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(body), gw.tokenA, ct); w.Code != http.StatusOK {
		t.Fatalf("A 上传失败: %d %s", w.Code, w.Body.String())
	}
	if err := serverstore.RecordGatewayFile(gw.db, "file-abc", gw.uidA, nil); err != nil {
		t.Fatal(err)
	}
	hitsAfterUpload := up.hits.Load()

	// B 引用 A 的 file_id
	reqBody := `{"model":"deepseek-chat","messages":[{"role":"user","content":[{"type":"text","text":"看图"},{"type":"file","file_id":"file-abc"}]}]}`
	w := doPost(t, gw.r, "/v1/chat/completions", reqBody, gw.tokenB, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("B 引用他人文件 status = %d (%s), want 404", w.Code, w.Body.String())
	}
	if up.hits.Load() != hitsAfterUpload {
		t.Fatalf("越权聊天请求被发往上游了：hits %d → %d", hitsAfterUpload, up.hits.Load())
	}
	if !strings.Contains(w.Body.String(), "NOT_FOUND") {
		t.Fatalf("错误信封缺 NOT_FOUND: %s", w.Body.String())
	}
}

// TestChatAllowsOwnFileReference：自己的 file_id 正常转发，并且引用字段原样保留。
func TestChatAllowsOwnFileReference(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	if err := serverstore.RecordGatewayFile(gw.db, "file-abc", gw.uidA, nil); err != nil {
		t.Fatal(err)
	}

	reqBody := `{"model":"deepseek-chat","messages":[{"role":"user","content":[{"type":"file","file_id":"file-abc"}]}]}`
	if w := doPost(t, gw.r, "/v1/chat/completions", reqBody, gw.tokenA, nil); w.Code != http.StatusOK {
		t.Fatalf("引用自己的文件应放行，实得 %d (%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(up.body.Load().(string), `"file_id":"file-abc"`) {
		t.Fatalf("出站体丢了 file_id 引用: %s", up.body.Load())
	}
}

// TestFileIDMentionedInsideStringsIsNotAReference：`file_id` 出现在**字符串内容**里
// （消息正文、工具参数 JSON 文本）不是引用 —— 不能误伤。
func TestFileIDMentionedInsideStringsIsNotAReference(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	reqBody := `{"model":"deepseek-chat","messages":[{"role":"user","content":"请解释 {\"file_id\":\"file-api-someone-else\"} 是什么"},{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"f","arguments":"{\"file_id\":\"file-api-someone-else\"}"}}]},{"role":"tool","tool_call_id":"c1","content":"ok"}]}`
	if w := doPost(t, gw.r, "/v1/chat/completions", reqBody, gw.tokenA, nil); w.Code != http.StatusOK {
		t.Fatalf("字符串里的 file_id 被误判为引用: %d %s", w.Code, w.Body.String())
	}
}

// TestFileIDInsideToolSchemaIsNotAReference：工具 schema 的属性默认值/示例里带
// file_id 字样是**合法**的（上游不把 schema 当引用解析），不能因此 404 ——
// 本平台客户大量使用 MCP 工具（现场单个会话 300+ 个工具定义）。
func TestFileIDInsideToolSchemaIsNotAReference(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	reqBody := `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"tools":[{"type":"function","function":{"name":"read","description":"read a file","parameters":{"type":"object","properties":{"file_id":{"type":"string","default":"file-api-someone-else","examples":["file-api-also-someone"]}}}}}],"response_format":{"type":"json_schema","json_schema":{"schema":{"type":"object","properties":{"file_id":{"const":"file-api-in-schema"}}}}}}`
	if w := doPost(t, gw.r, "/v1/chat/completions", reqBody, gw.tokenA, nil); w.Code != http.StatusOK {
		t.Fatalf("工具 schema 里的 file_id 被误判为引用: %d %s", w.Code, w.Body.String())
	}
}

// TestChatRejectsMalformedFileReference：形状非法的 id 按"不存在"处理（不进上游 URL/引用）。
func TestChatRejectsMalformedFileReference(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	reqBody := `{"model":"deepseek-chat","messages":[{"role":"user","content":[{"type":"file","file_id":"../../user/balance"}]}]}`
	if w := doPost(t, gw.r, "/v1/chat/completions", reqBody, gw.tokenA, nil); w.Code != http.StatusNotFound {
		t.Fatalf("非法 file_id status = %d (%s), want 404", w.Code, w.Body.String())
	}
	if up.hits.Load() != 0 {
		t.Fatalf("非法引用不应触达上游（%d 次）", up.hits.Load())
	}
}

// TestEveryChatHandlerRunsOutboundProcessing：源码级收口 —— 聊天类 handler 都必须
// 走出站加工（否则新增端点会重新长出"引用他人文件"的洞），且用对模式。
//
// 2026-09-22 审计 F 路指出旧版按"文件名字面量匹配调用串"有两侧问题：等价重构
// （`mode := identityOpenAI` 后再传）会假红（M6），而新增第五条路径会假绿（M7）。
// 现在拆成两条：
//   - 本用例只钉"哪个文件必须出现出站加工 + 用对模式"（容忍重构）；
//   - 转发实参的来源由 TestForwardHelpersReceiveProcessedBody 用 AST 判定
//     （容忍重命名、不容忍把 raw 转发出去）；把客户端体发往上游的新函数还会被
//     sanitize_test.go 的允许清单判据拦住。
func TestEveryChatHandlerRunsOutboundProcessing(t *testing.T) {
	cases := map[string]string{
		"handler.go":     "identityOpenAI",
		"messages.go":    "identityAnthropic",
		"responses.go":   "identityResponses",
		"completions.go": "identityNone",
	}
	for file, mode := range cases {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		src := string(raw)
		if !strings.Contains(src, "prepareOutboundBody(") {
			t.Errorf("%s 未调用 prepareOutboundBody —— file_id 归属校验/user_id 注入会在这条路径上失效", file)
		}
		if !strings.Contains(src, mode) {
			t.Errorf("%s 未使用 %s（模式漂移会让该端点漏注入或多注入）", file, mode)
		}
	}
	// embeddings 的客户端体**从不转发**（出站体由 Embedder 自建）⇒ 不得再挂在出站加工上
	// （审计 F 路 P2-4：那是空转 + 纯误伤的 404 面）。
	raw, err := os.ReadFile("embedding.go")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "prepareOutboundBody(") {
		t.Error("embedding.go 不该调用 prepareOutboundBody（客户端体不转发）")
	}
}

// TestForwardHelpersReceiveProcessedBody：AST 级不变量 —— 每个
// `a.forward*(…, X, …)` 的实参 X 必须**派生自** prepareOutboundBody 的返回值
// （允许 `X := outbound` 这类同函数内的赋值传递，不允许改名/重排绕过）。
//
// 这条把审计 F 路 M4/M5/M6 三类变异从"源码字符串指纹"升级成"数据流判据"：
// 把转发种子改成 raw、或把出站体换成一个与加工无关的变量，都会红；而纯粹的重命名
// 与中间变量不会假红。
func TestForwardHelpersReceiveProcessedBody(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	forwardMethods := map[string]bool{"forward": true, "forwardEndpoint": true, "forwardAnthropic": true}
	checked := 0
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		fset := token.NewFileSet()
		f, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			// ① 收集本函数里"来自 prepareOutboundBody 的变量名"，并按同函数赋值传递闭包。
			processed := map[string]bool{}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				assign, ok := n.(*ast.AssignStmt)
				if !ok {
					return true
				}
				fromProcessed := false
				for _, rhs := range assign.Rhs {
					if call, ok := rhs.(*ast.CallExpr); ok {
						if id, ok := call.Fun.(*ast.Ident); ok && id.Name == "prepareOutboundBody" {
							fromProcessed = true
						}
						for _, arg := range call.Args {
							if id, ok := arg.(*ast.Ident); ok && processed[id.Name] {
								fromProcessed = true
							}
						}
					}
					if id, ok := rhs.(*ast.Ident); ok && processed[id.Name] {
						fromProcessed = true
					}
				}
				if !fromProcessed {
					return true
				}
				for _, lhs := range assign.Lhs {
					if id, ok := lhs.(*ast.Ident); ok && id.Name != "_" {
						processed[id.Name] = true
					}
				}
				return true
			})
			// ② 每个转发调用的实参里必须有一个是这些变量。
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok || !forwardMethods[sel.Sel.Name] {
					return true
				}
				checked++
				for _, arg := range call.Args {
					if id, ok := arg.(*ast.Ident); ok && processed[id.Name] {
						return true
					}
				}
				t.Errorf("%s: %s.%s 的实参里没有 prepareOutboundBody 的产物 —— "+
					"客户端原始字节被直接转发了（出站体加工在这条路径上失效）",
					name, exprString(sel.X), sel.Sel.Name)
				return true
			})
		}
	}
	if checked < 4 {
		t.Fatalf("只扫到 %d 个转发调用点，预期 ≥4（chat/FIM/responses/messages 各一处候选循环）—— 判据面疑似漂移", checked)
	}
}

// exprString 打印 AST 表达式（本文件只用它给转发调用点定位）。
func exprString(e ast.Expr) string {
	var buf bytes.Buffer
	if err := format.Node(&buf, token.NewFileSet(), e); err != nil {
		return "?"
	}
	return buf.String()
}

// TestOutboundGateCannotBeBypassedByUnparsableForBody（审计 G-1，P1）：
// `{"junk":1e999}` 让 map 解析失败、而结构体解析（skip() 容忍未知字段）成功 ——
// 旧实现"解析失败即原样放行"于是把**闸门整体跳过**：他人 file_id 与伪造 user_id
// 一起出境并拿到 200。现在改为 fail-closed（本地 400/404），本用例钉住这一点。
func TestOutboundGateCannotBeBypassedByUnparsableForBody(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	if err := serverstore.RecordGatewayFile(gw.db, "file-abc", gw.uidA, nil); err != nil {
		t.Fatal(err)
	}

	// B 用"解析器分歧体"夹带 A 的 file_id + 伪造 user_id
	reqBody := `{"junk":1e999,"model":"deepseek-chat","user_id":"spoofed","messages":[{"role":"user","content":[{"type":"file","file_id":"file-abc"}]}]}`
	w := doPost(t, gw.r, "/v1/chat/completions", reqBody, gw.tokenB, nil)
	if w.Code == http.StatusOK {
		t.Fatalf("闸门被绕过：请求体出境且 200（%s）", w.Body.String())
	}
	if up.hits.Load() != 0 {
		t.Fatalf("构造体被发往上游了（%d 次）", up.hits.Load())
	}
}

// TestOutboundBodyRejectsNonObjectOrInvalidJSON（审计 G-3）：`null` / 数组 / 非法 JSON
// 一律本地 400（旧实现在 `null` 上写 nil map panic ⇒ 500 INTERNAL，而 500 会被客户端
// 判成可重试，等于把 panic 栈变成可重复触发的路径）。
func TestOutboundBodyRejectsNonObjectOrInvalidJSON(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	for _, body := range []string{`null`, `[]`, `"text"`, `{`, `{"model":}`} {
		w := doPost(t, gw.r, "/v1/chat/completions", body, gw.tokenA, nil)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("body=%q status = %d (%s), want 400", body, w.Code, w.Body.String())
		}
	}
	if up.hits.Load() != 0 {
		t.Fatalf("非法体不应触达上游（%d 次）", up.hits.Load())
	}
}

// TestLargeBodyFastPathKeepsOriginalBytes（审计 G-2）：大体积、无引用、无自带 user_id
// 的请求走零重编码快路径 —— 原有字节**逐字保留**、只在末尾追加平台 user_id。
//
// 判据刻意用"逐字节等于原文 + 后缀"来钉：若有人把它改回 parse+marshal，键序/空白/
// HTML 转义都会变，本用例立刻变红（内存放大就是从这里来的）。
func TestLargeBodyFastPathKeepsOriginalBytes(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	// 含 < > & 与不规则空白：一旦走 marshal 就会被转义/规范化
	content := "<b>&amp;</b>  " + strings.Repeat("z", 70<<10)
	reqBody := `{"model":"deepseek-chat","messages":[{"role":"user","content":"` + content + `"}]}`
	if len(reqBody) < fastPathMinBytes {
		t.Fatalf("用例体量 %d 未达快路径门槛 %d", len(reqBody), fastPathMinBytes)
	}
	if w := doPost(t, gw.r, "/v1/chat/completions", reqBody, gw.tokenA, nil); w.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", w.Code, w.Body.String())
	}
	got, _ := up.body.Load().(string)
	want := reqBody[:len(reqBody)-1] + `,"user_id":"` + platformUserID(gw.uidA) + `"}`
	if got != want {
		t.Fatalf("快路径未逐字保留请求体（重编码会让内存放大 4~17 倍）:\n got前缀=%q\nwant前缀=%q", got[:120], want[:120])
	}
}

// TestSlowPathKeepsHTMLUnescaped（审计 G-2）：需要重编码的路径（这里有自带 user_id）
// 也必须 SetEscapeHTML(false) —— 否则正文里的 < > & 膨胀成 \u003c 等，输出涨 ~1.9 倍。
func TestSlowPathKeepsHTMLUnescaped(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	reqBody := `{"model":"deepseek-chat","user_id":"spoofed","messages":[{"role":"user","content":"<b>&amp;</b>"}]}`
	if w := doPost(t, gw.r, "/v1/chat/completions", reqBody, gw.tokenA, nil); w.Code != http.StatusOK {
		t.Fatalf("status = %d (%s)", w.Code, w.Body.String())
	}
	got, _ := up.body.Load().(string)
	if strings.Contains(got, `\u003c`) || strings.Contains(got, `\u0026`) {
		t.Fatalf("正文里的 HTML 字符被转义（输出膨胀）: %s", got)
	}
	if !strings.Contains(got, "<b>&amp;</b>") {
		t.Fatalf("正文被改动: %s", got)
	}
	if !strings.Contains(got, `"user_id":"`+platformUserID(gw.uidA)+`"`) {
		t.Fatalf("未覆盖客户端 user_id: %s", got)
	}
}

// TestFilesAPISkipsAnthropicOnlyProvider（审计 G-5）：Files 面是 OpenAI 形状，
// 选中 anthropic-only provider 会拼出 <base>/anthropic/files 永久 404 并静默回落。
func TestFilesAPISkipsAnthropicOnlyProvider(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	if _, err := gw.db.Exec(`UPDATE gateway_providers SET protocol = 'anthropic'`); err != nil {
		t.Fatal(err)
	}
	InvalidateUpstreams()

	body, ct := multipartBytes(t, "x")
	w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(body), gw.tokenA, ct)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("anthropic-only provider 下 status = %d (%s), want 503（宁可明确失败也不静默回落）", w.Code, w.Body.String())
	}
	if up.hits.Load() != 0 {
		t.Fatalf("不应触达 anthropic-only 上游（%d 次）", up.hits.Load())
	}
}

// ---------------------------------------------------------------------------
// 内存基准（审计 2026-09-22 G-2/F5）：量化"零重编码快路径"相对解析+重编码的收益。
// 默认不跑（-bench 才跑），结果用于容量决策（64MiB 上限 × 并发 = 多少活堆）。
// ---------------------------------------------------------------------------

func benchBody(tb testing.TB, filler string, withFileRef bool) []byte {
	tb.Helper()
	content := strings.Repeat(filler, 4<<20)
	ref := ""
	if withFileRef {
		ref = `,{"type":"file","file_id":"file-api-bench"}`
	}
	return []byte(`{"model":"deepseek-chat","messages":[{"role":"user","content":[{"type":"text","text":"` + content + `"}` + ref + `]}]}`)
}

func BenchmarkPrepareOutboundBodyFastPath4MiB(b *testing.B) {
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	raw := benchBody(b, "z", false)
	b.SetBytes(int64(len(raw)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, ok := prepareOutboundBody(c, nil, 1, raw, identityOpenAI); !ok {
			b.Fatal("rejected")
		}
	}
}

func BenchmarkPrepareOutboundBodySlowPath4MiB(b *testing.B) {
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	// 带自带 user_id ⇒ 必须解析+重编码（最坏路径）
	raw := bytes.Replace(benchBody(b, "z", false), []byte(`"model"`), []byte(`"user_id":"spoofed","model"`), 1)
	b.SetBytes(int64(len(raw)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, ok := prepareOutboundBody(c, nil, 1, raw, identityOpenAI); !ok {
			b.Fatal("rejected")
		}
	}
}

// ---------------------------------------------------------------------------
// 2026-09-22 审计 F 路（第 3 轮）修复面的判据
// ---------------------------------------------------------------------------

// TestResponsesInjectsOfficialUserField（F 路 P1-1）：Responses API 的官方文档
// （create-response 的顶层 `user`，用途同样是内容安全/KVCache/调度隔离）此前被误判为
// "官方没有该字段" → 该路径仍共享空隔离域，且客户端自带的 `user` 能冒充他人域。
func TestResponsesInjectsOfficialUserField(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	reqBody := `{"model":"deepseek-chat","input":"hi","user":"spoofed-by-client","metadata":{"trace":"keep-me"}}`
	if w := doPost(t, gw.r, "/v1/responses", reqBody, gw.tokenA, nil); w.Code != http.StatusOK {
		t.Fatalf("responses status = %d (%s)", w.Code, w.Body.String())
	}
	body := upstreamBody(t, up)
	if got, _ := body["user"].(string); got != fmt.Sprintf("u%d", gw.uidA) {
		t.Fatalf("上游 user = %q, want u%d（平台侧注入并覆盖客户端值）", got, gw.uidA)
	}
	if _, present := body["user_id"]; present {
		t.Fatalf("Responses 形态不应写 user_id（官方字段名是 user）: %v", body)
	}
	if meta, _ := body["metadata"].(map[string]any); meta == nil || meta["trace"] != "keep-me" {
		t.Fatalf("重新编码破坏了原有字段: %v", body)
	}
}

// TestFIMStillDoesNotGetUserFields：FIM（`/completions`）官方文档确实没有用户标识
// 字段 —— 保持不注入（与 Responses 的区别是审计 F 路逐条核对官方文档后的结论）。
func TestFIMStillDoesNotGetUserFields(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	if w := doPost(t, gw.r, "/v1/completions", `{"model":"deepseek-chat","prompt":"def f("}`, gw.tokenA, nil); w.Code != http.StatusOK {
		t.Fatalf("fim status = %d (%s)", w.Code, w.Body.String())
	}
	body := upstreamBody(t, up)
	if _, present := body["user"]; present {
		t.Fatalf("FIM 请求不应注入 user 字段: %v", body)
	}
	if _, present := body["user_id"]; present {
		t.Fatalf("FIM 请求不应注入 user_id 字段: %v", body)
	}
}

// TestFastPathAppendsResponsesUserKey：大体积快路径必须按模式写对键名 ——
// Responses 的 `user` 与正文里的 `"role":"user"` 必须区分（裸 `user` 子串匹配会让
// 快路径永不命中，白付一次全量 map 往返）。
func TestFastPathAppendsResponsesUserKey(t *testing.T) {
	big := func(extra string) []byte {
		pad := strings.Repeat("x", fastPathMinBytes)
		return []byte(`{"model":"m","input":[{"role":"user","content":"` + pad + `"}]` + extra + `}`)
	}
	out, ok := fastPathUserID(big(""), 7, identityResponses)
	if !ok {
		t.Fatal("Responses 大体积体（正文含 role:user）应走快路径")
	}
	got := string(out)
	if !strings.HasSuffix(got, `,"user":"u7"}`) {
		t.Fatalf("快路径没有按 Responses 形态追加 user 键: %s", got[len(got)-40:])
	}
	if !strings.Contains(got, `"role":"user"`) {
		t.Fatal("快路径改动了原有字节")
	}
	// 客户端自带 `"user":` ⇒ 交给慢路径（覆盖语义），快路径必须弃权。
	if _, ok := fastPathUserID(big(`,"user":"spoofed"`), 7, identityResponses); ok {
		t.Fatal("客户端已带 user 键时应走慢路径覆盖，而不是追加重复键")
	}
	// chat 形态仍写 user_id。
	out, ok = fastPathUserID(big(""), 7, identityOpenAI)
	if !ok || !strings.HasSuffix(string(out), `,"user_id":"u7"}`) {
		t.Fatalf("chat 快路径键名错误: ok=%v tail=%s", ok, func() string {
			s := string(out)
			if len(s) > 40 {
				return s[len(s)-40:]
			}
			return s
		}())
	}
}

// TestSchemaOnlyKeysAreLoadBearing（F 路 P2-1，变异 M13）：schema 子树里**直接以
// `file_id` 为键的字符串**（属性简写/示例形态）不是文件引用，`schemaOnlyKeys` 的每个
// 顶层键都必须真的承重。
//
// 旧夹具把示例 id 放在 `default`/`examples` 里 —— collectFileRefs 本来就只看"键就是
// file_id"的位置，所以把 schemaOnlyKeys 清空都测不出判别力（F 路实测 M13 绿）。这里
// 每个子用例都构造"只有该键在保护它"的形态，单独去掉哪一个键都会让对应用例 404。
//
// 注：`tools` 与 `function` 是**纵深防御**关系 —— OpenAI 的工具定义形态是
// `tools[].function.parameters`，两把键同时罩着同一段子树，所以只去掉 `tools`
// （或只去掉 `function`）都不构成单点失效；真正的单点是"整张表被清空"。四个子用例
// 分别由 `tools`/`functions`/`tool_choice`/`response_format` 单独承重。
func TestSchemaOnlyKeysAreLoadBearing(t *testing.T) {
	cases := []struct {
		key  string
		body string
	}{
		{"tools", `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"tools":[{"type":"function","function":{"name":"read","parameters":{"type":"object","properties":{"file_id":"file-api-tools"}}}}]}`},
		{"functions", `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"functions":[{"name":"legacy","parameters":{"type":"object","properties":{"file_id":"file-api-functions"}}}]}`},
		{"tool_choice", `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"tool_choice":{"file_id":"file-api-choice"}}`},
		{"response_format", `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"response_format":{"json_schema":{"schema":{"properties":{"file_id":"file-api-schema"}}}}}`},
	}
	for _, tc := range cases {
		t.Run(tc.key, func(t *testing.T) {
			up := newFakeFilesUpstream(t)
			gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
			if w := doPost(t, gw.r, "/v1/chat/completions", tc.body, gw.tokenA, nil); w.Code != http.StatusOK {
				t.Fatalf("schema 子树（%s）里的 file_id 字符串被误判为引用: %d %s",
					tc.key, w.Code, w.Body.String())
			}
		})
	}
	// 反向对照：真正的引用（消息内容部件）在同一份请求里必须仍然被拦（跳过面只收窄
	// 误报，不放宽安全）。
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	real := `{"model":"deepseek-chat","messages":[{"role":"user","content":[{"type":"file","file_id":"file-api-real"}]}],"tools":[{"type":"function","function":{"parameters":{"properties":{"file_id":"file-api-tools"}}}}]}`
	if w := doPost(t, gw.r, "/v1/chat/completions", real, gw.tokenA, nil); w.Code != http.StatusNotFound {
		t.Fatalf("消息内容里的跨员工 file_id 引用必须仍被拦: %d %s", w.Code, w.Body.String())
	}
}

// TestStreamMeteringUsesClientRawBytes（F 路 P2-2，变异 M12）：上游整条流不报 usage 时
// 按**客户端原始字节**估算 prompt。本例里客户端自带一个很长的 user_id，出站体会把它
// 覆盖成 `u<id>`（出站体显著更短）⇒ 若计量种子误用出站体，估算值必然偏小。
func TestStreamMeteringUsesClientRawBytes(t *testing.T) {
	f := newFakeUpstream(t)
	f.streamResp = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n"
	r, db, token := newGateway(t, f)

	spoof := strings.Repeat("s", 400)
	body := `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"user_id":"` + spoof + `","stream":true}`
	w := doPost(t, r, "/v1/chat/completions", body, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var pt int64
	var estimated bool
	if err := db.QueryRow("SELECT prompt_tokens, estimated FROM usage").Scan(&pt, &estimated); err != nil {
		t.Fatal(err)
	}
	wantRaw, _ := estimatePromptTokensFromBody([]byte(body))
	outbound := strings.Replace(body, spoof, fmt.Sprintf("u%d", 1), 1)
	wantOutbound, _ := estimatePromptTokensFromBody([]byte(outbound))
	if wantRaw == wantOutbound {
		t.Fatalf("夹具无判别力：raw/outbound 估算相同（%d）", wantRaw)
	}
	if !estimated {
		t.Fatalf("上游未报 usage，应落 estimated 行")
	}
	if pt != wantRaw {
		t.Fatalf("prompt_tokens = %d, want %d（按客户端原始字节估算；用出站体会得到 %d）", pt, wantRaw, wantOutbound)
	}
}

// TestAnthropicRejectsNonObjectMetadata（F 路 P2-7）：`metadata` 存在但不是对象时
// **400 收口**，不再静默改写成新对象并丢弃客户端原值。
func TestAnthropicRejectsNonObjectMetadata(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	if _, err := gw.db.Exec(`UPDATE gateway_providers SET protocol = 'both'`); err != nil {
		t.Fatal(err)
	}
	InvalidateUpstreams()

	reqBody := `{"model":"deepseek-chat","max_tokens":64,"messages":[{"role":"user","content":"hi"}],"metadata":"not-an-object"}`
	w := doPost(t, gw.r, "/v1/messages", reqBody, gw.tokenA, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("metadata 非对象 status = %d (%s), want 400", w.Code, w.Body.String())
	}
	if up.hits.Load() != 0 {
		t.Fatalf("畸形 metadata 的请求被发往上游了（%d 次）", up.hits.Load())
	}
}

// TestEmbeddingsBodyIsNotOutboundProcessed（F 路 P2-4）：embeddings 的客户端体
// 从不转发（出站体由 Embedder 自建）⇒ 不该出现"file_id 键导致 404"的纯误伤面。
func TestEmbeddingsBodyIsNotOutboundProcessed(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	reqBody := `{"model":"deepseek-chat","input":["hello"],"file_id":"file-api-someone-else"}`
	w := doPost(t, gw.r, "/v1/embeddings", reqBody, gw.tokenA, nil)
	if w.Code == http.StatusNotFound {
		t.Fatalf("embeddings 不应因 file_id 键 404（客户端体不转发）: %s", w.Body.String())
	}
}

// TestTooManyFileReferencesRejected（F 路 P2-3）：引用数上限挡住"用超大请求体换
// 闸门前的排队时间"（同时避免 `IN (...)` 撞 PG 参数上限）。
func TestTooManyFileReferencesRejected(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	parts := make([]string, 0, DefaultMaxFileRefsPerRequest+1)
	for i := 0; i <= DefaultMaxFileRefsPerRequest; i++ {
		parts = append(parts, fmt.Sprintf(`{"type":"file","file_id":"file-%d"}`, i))
	}
	reqBody := `{"model":"deepseek-chat","messages":[{"role":"user","content":[` + strings.Join(parts, ",") + `]}]}`
	w := doPost(t, gw.r, "/v1/chat/completions", reqBody, gw.tokenA, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("超量引用 status = %d (%s), want 400", w.Code, w.Body.String())
	}
	if up.hits.Load() != 0 {
		t.Fatalf("超量引用请求被发往上游了（%d 次）", up.hits.Load())
	}
}

// TestManyOwnedFileReferencesPassInOneQuery：批量归属查询的正确性 —— 登记 300 个
// 自己的文件、请求引用其中 256 个（上限内）必须整体放行；其中只要有一个不是自己的，
// 整个请求 404。
func TestManyOwnedFileReferencesPassInOneQuery(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	ids := make([]string, 0, DefaultMaxFileRefsPerRequest)
	parts := make([]string, 0, DefaultMaxFileRefsPerRequest)
	for i := 0; i < DefaultMaxFileRefsPerRequest; i++ {
		id := fmt.Sprintf("file-own-%d", i)
		ids = append(ids, id)
		parts = append(parts, fmt.Sprintf(`{"type":"file","file_id":"%s"}`, id))
	}
	owned, err := serverstore.GatewayFilesOwnedBy(gw.db, ids, gw.uidA)
	if err != nil {
		t.Fatal(err)
	}
	if len(owned) != 0 {
		t.Fatalf("未登记的文件不应判为归属: %d", len(owned))
	}
	for _, id := range ids {
		if err := serverstore.RecordGatewayFile(gw.db, id, gw.uidA, nil); err != nil {
			t.Fatal(err)
		}
	}
	reqBody := `{"model":"deepseek-chat","messages":[{"role":"user","content":[` + strings.Join(parts, ",") + `]}]}`
	if w := doPost(t, gw.r, "/v1/chat/completions", reqBody, gw.tokenA, nil); w.Code != http.StatusOK {
		t.Fatalf("引用 %d 个自己的文件应放行，实得 %d (%s)", len(ids), w.Code, w.Body.String())
	}

	// 换一个不属于 B 的 id 混进来 ⇒ 整条 404 且不触达上游。
	hits := up.hits.Load()
	mixed := `{"model":"deepseek-chat","messages":[{"role":"user","content":[` +
		strings.Join(parts[:DefaultMaxFileRefsPerRequest-1], ",") + `,{"type":"file","file_id":"file-of-someone-else"}]}]}`
	if w := doPost(t, gw.r, "/v1/chat/completions", mixed, gw.tokenB, nil); w.Code != http.StatusNotFound {
		t.Fatalf("B 引用他人文件 status = %d (%s), want 404", w.Code, w.Body.String())
	}
	if up.hits.Load() != hits {
		t.Fatalf("越权请求触达上游了（%d → %d）", hits, up.hits.Load())
	}
}
