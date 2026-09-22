package llmgateway

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"

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
// 走出站加工（否则新增端点会重新长出"引用他人文件"的洞）。
func TestEveryChatHandlerRunsOutboundProcessing(t *testing.T) {
	cases := map[string]string{
		"handler.go":     "identityOpenAI",
		"messages.go":    "identityAnthropic",
		"responses.go":   "identityNone",
		"completions.go": "identityNone",
		"embedding.go":   "identityNone",
	}
	for file, mode := range cases {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		src := string(raw)
		if !strings.Contains(src, "prepareOutboundBody(c, a.DB, user.ID, raw, "+mode+")") {
			t.Errorf("%s 未按 %s 调用 prepareOutboundBody —— file_id 归属校验/user_id 注入会在这条路径上失效", file, mode)
		}
	}
}
