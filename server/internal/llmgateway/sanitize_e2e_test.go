package llmgateway

import (
	"net/http"
	"strings"
	"testing"
)

// P0-4 端到端判据：**四条出站路径**都不得把上游 DSH 的私有扩展字段（本次是
// `dsh_session_log` = 会话正文/工具参数/工作区路径）转发给客户配置的供应商。
//
// 单元用例（sanitize_test.go）证明净化函数本身对；这一组证明它真的接在四条
// 转发路径上（三个转发入口 + 流式/非流式两种走法）。变异验证：去掉任一入口的
// `sanitizeOutboundBody(raw)` 调用，对应用例即红。
func TestGatewayStripsUpstreamExtensionsEndToEnd(t *testing.T) {
	const secret = "E2E_SESSION_BODY_MARKER"
	const extension = `"dsh_session_log":{"session":"` + secret + `","workspace":"/home/alice/proj"}`

	cases := []struct {
		name string
		path string
		body string
	}{
		{
			name: "chat/completions (non-stream)",
			path: "/v1/chat/completions",
			body: `{"model":"deepseek-chat","stream":false,"messages":[{"role":"user","content":"hi"}],` + extension + `}`,
		},
		{
			name: "chat/completions (stream)",
			path: "/v1/chat/completions",
			body: `{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"hi"}],` + extension + `}`,
		},
		{
			name: "completions",
			path: "/v1/completions",
			body: `{"model":"deepseek-chat","stream":false,"prompt":"hi",` + extension + `}`,
		},
		{
			name: "responses",
			path: "/v1/responses",
			body: `{"model":"deepseek-chat","stream":false,"input":"hi",` + extension + `}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeUpstream(t)
			r, _, token := newGateway(t, f)
			w := doPost(t, r, tc.path, tc.body, token, nil)
			if w.Code != http.StatusOK {
				t.Fatalf("%s: status = %d, body = %s", tc.name, w.Code, w.Body.String())
			}
			got, _ := f.gotBody.Load().(string)
			if got == "" {
				t.Fatalf("%s: fake upstream saw no body", tc.name)
			}
			if strings.Contains(got, "dsh_session_log") {
				t.Fatalf("%s: upstream received the extension field: %s", tc.name, got)
			}
			if strings.Contains(got, secret) {
				t.Fatalf("%s: 会话正文出境（marker 出现在上游请求体里）: %s", tc.name, got)
			}
			// 正常字段必须原样保留（净化不能顺手改契约字段）。
			if !strings.Contains(got, `"model":"deepseek-chat"`) {
				t.Fatalf("%s: model field lost: %s", tc.name, got)
			}
		})
	}
}

// 反向对照：请求体里**没有**扩展字段时，转发内容与净化前一致（不能因为接了净化
// 就丢掉 messages/prompt/input 这些契约字段）。
func TestGatewayKeepsContractFieldsWithoutExtensions(t *testing.T) {
	f := newFakeUpstream(t)
	r, _, token := newGateway(t, f)
	w := doPost(t, r, "/v1/chat/completions",
		`{"model":"deepseek-chat","stream":false,"messages":[{"role":"user","content":"KEEP_ME_MARKER"}]}`,
		token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	got, _ := f.gotBody.Load().(string)
	if !strings.Contains(got, "KEEP_ME_MARKER") {
		t.Fatalf("messages lost on the no-extension path: %s", got)
	}
	if strings.Contains(got, "dsh_") {
		t.Fatalf("unexpected dsh_ key injected into the outbound body: %s", got)
	}
}

// 第四条路径（Anthropic Messages）单独走一个 anthropic-protocol 供应商 —— 它用
// 独立的转发入口 `forwardAnthropic`，是最容易被漏掉的一条（源码形状守卫也能抓，
// 但行为判据更硬）。
func TestGatewayStripsUpstreamExtensionsOnMessages(t *testing.T) {
	const secret = "E2E_MESSAGES_SESSION_MARKER"
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	var providerID int64
	if err := db.QueryRow(
		`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, protocol)
		 VALUES ('fake-anthropic', ?, ?, '["claude-x"]', 'anthropic') RETURNING id`,
		f.baseURL, upstreamKey,
	).Scan(&providerID); err != nil {
		t.Fatalf("seed anthropic provider: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO models (name, provider_id, display_name) VALUES ('claude-x', $1, 'Claude X')`,
		providerID,
	); err != nil {
		t.Fatalf("seed anthropic model: %v", err)
	}
	body := `{"model":"claude-x","stream":false,"max_tokens":16,` +
		`"messages":[{"role":"user","content":"hi"}],` +
		`"dsh_session_log":{"session":"` + secret + `"}}`
	w := doPost(t, r, "/v1/messages", body, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	got, _ := f.gotBody.Load().(string)
	if strings.Contains(got, "dsh_session_log") || strings.Contains(got, secret) {
		t.Fatalf("/v1/messages 把扩展字段转发给了上游: %s", got)
	}
	if !strings.Contains(got, `"model":"claude-x"`) {
		t.Fatalf("/v1/messages lost the model field: %s", got)
	}
}
