package llmgateway

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// P0-4（2026-09-20 DSH 0.1.6 升级审计）：上游 0.1.6 起 `session-log-deepseek` 默认
// 开启，往每个带会话的 LLM 请求体顶层塞 `dsh_session_log`（会话正文/工具参数/工作区
// 路径），而网关把请求体逐字节转发给客户配置的供应商。客户端侧已 disable 该行；
// 本组用例守服务端侧的第二道闸门（`sanitize.go`）。

func TestStripUpstreamExtensionsRemovesDeepseekSessionLog(t *testing.T) {
	body := []byte(`{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],` +
		`"dsh_session_log":{"session":"secret-content","workspace":"/home/alice/proj"}}`)
	out, stripped, err := stripUpstreamExtensions(body)
	if err != nil {
		t.Fatalf("strip returned error: %v", err)
	}
	if !stripped {
		t.Fatal("dsh_session_log was not stripped")
	}
	var parsed map[string]any
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("stripped body is not JSON: %v", err)
	}
	if _, ok := parsed["dsh_session_log"]; ok {
		t.Fatal("dsh_session_log still present after strip")
	}
	if parsed["model"] != "deepseek-chat" {
		t.Fatalf("model field was altered: %v", parsed["model"])
	}
	msgs, _ := parsed["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("messages were altered: %v", parsed["messages"])
	}
	if strings.Contains(string(out), "secret-content") || strings.Contains(string(out), "/home/alice/proj") {
		t.Fatalf("session content leaked into the sanitized body: %s", string(out))
	}
}

// 前缀族：不只 `dsh_session_log`，任何 `dsh_` 顶层键都是上游私有扩展
// （0.1.6 这个字段就是默认开启、无声新增的，钉单个键名会再踩一遍）。
func TestStripUpstreamExtensionsRemovesWholePrefixFamily(t *testing.T) {
	body := []byte(`{"model":"m","dsh_session_log":1,"dsh_future_field":{"a":2},"messages":[]}`)
	out, stripped, err := stripUpstreamExtensions(body)
	if err != nil || !stripped {
		t.Fatalf("strip = (%q, %v, %v), want stripped", string(out), stripped, err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatal(err)
	}
	for key := range parsed {
		if strings.HasPrefix(key, "dsh_") {
			t.Fatalf("dsh_ prefixed key survived: %s", key)
		}
	}
}

// 零改动路径必须是**同一段字节**：网关既有语义是逐字节转发，净化不能顺手改键序/空白。
func TestStripUpstreamExtensionsKeepsBytesWhenNothingToStrip(t *testing.T) {
	body := []byte("{\n  \"model\": \"m\",\n  \"messages\": []\n}\n")
	out, stripped, err := stripUpstreamExtensions(body)
	if err != nil || stripped {
		t.Fatalf("strip = (stripped=%v, err=%v), want untouched", stripped, err)
	}
	if !bytes.Equal(out, body) {
		t.Fatalf("body was re-encoded without cause:\n before=%q\n after =%q", body, out)
	}
}

// 前缀只出现在**值**里（例如某条消息的正文提到 dsh_）不得触发剔除或重编码。
func TestStripUpstreamExtensionsIgnoresPrefixInsideValues(t *testing.T) {
	body := []byte(`{"model":"m","messages":[{"role":"user","content":"what is dsh_session_log?"}]}`)
	out, stripped, err := stripUpstreamExtensions(body)
	if err != nil || stripped {
		t.Fatalf("strip = (stripped=%v, err=%v), want untouched", stripped, err)
	}
	if !bytes.Equal(out, body) {
		t.Fatal("body was re-encoded although the prefix only appeared inside a value")
	}
}

// 嵌套结构里的同名键**不是**上游的扩展面（上游只写顶层），不动它。
func TestStripUpstreamExtensionsLeavesNestedKeysAlone(t *testing.T) {
	body := []byte(`{"model":"m","metadata":{"dsh_session_log":"keep-me"}}`)
	out, stripped, err := stripUpstreamExtensions(body)
	if err != nil {
		t.Fatal(err)
	}
	if stripped {
		t.Fatal("nested key must not be treated as an upstream extension")
	}
	if !bytes.Contains(out, []byte("keep-me")) {
		t.Fatal("nested value disappeared")
	}
}

// 非 JSON 对象（数组/字符串/坏 JSON）必须原样返回；含前缀的坏 JSON 还要报错
// （调用方据此留痕）。净化动作绝不能让一个合法请求失败，也不能吞掉体。
func TestStripUpstreamExtensionsPassesThroughNonObjects(t *testing.T) {
	for name, body := range map[string]string{
		"array":       `[{"dsh_session_log":1}]`,
		"string":      `"dsh_session_log"`,
		"invalidJSON": `{"dsh_session_log":`,
		// 空前缀都不含 ⇒ 走零改动快路径，不解析也不报错（空体到不了转发入口，
		// 真·非法请求由下游供应商拒绝）。
		"empty": ``,
	} {
		t.Run(name, func(t *testing.T) {
			raw := []byte(body)
			out, stripped, err := stripUpstreamExtensions(raw)
			if stripped {
				t.Fatalf("%s: stripped = true, want false", name)
			}
			if !bytes.Equal(out, raw) {
				t.Fatalf("%s: body changed to %q", name, string(out))
			}
			if body == `{"dsh_session_log":` && err == nil {
				t.Fatalf("%s: expected a parse error", name)
			}
		})
	}
}

// sanitizeOutboundBody 是转发入口用的包装：失败只降级为原样转发，不 panic、不改体。
func TestSanitizeOutboundBodyDegradesToRawOnParseFailure(t *testing.T) {
	raw := []byte(`{"dsh_session_log":`)
	if out := sanitizeOutboundBody(raw); !bytes.Equal(out, raw) {
		t.Fatalf("sanitizeOutboundBody changed a malformed body: %q", string(out))
	}
}

// 防漏判据（本次 P0 的教训）：任何把客户端体发给上游的地方都必须先过净化。
// 四个契约路径由三个转发入口覆盖，`bytes.NewReader(raw)` 是它们的共同指纹 ——
// 将来新增协议若忘了接净化，这条用例会红。
func TestEveryForwardHelperSanitizesOutboundBody(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	// 只看**代码行**：注释里也会出现同样的字符串（本文件与 sanitize.go 的注释就有），
	// 不剥注释会让判据在"注释提到它"时假红。`://` 之后的 `//` 属于字符串，保护一下。
	reader := regexp.MustCompile(`bytes\.NewReader\(raw\)`)
	found := 0
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		source, err := os.ReadFile(filepath.Clean(name))
		if err != nil {
			t.Fatal(err)
		}
		text := stripLineComments(string(source))
		if !reader.MatchString(text) {
			continue
		}
		// 以函数为粒度切分，找出真正使用 raw 的那个函数体。
		for _, chunk := range splitGoFuncs(text) {
			if !reader.MatchString(chunk) {
				continue
			}
			found++
			if !strings.Contains(chunk, "sanitizeOutboundBody(raw)") {
				t.Fatalf("%s: 一个把 raw 直接发给上游的函数没有调用 sanitizeOutboundBody —— "+
					"新增协议路径必须接服务端净化闸门（P0-4）", name)
			}
		}
	}
	if found == 0 {
		t.Fatal("没有扫到任何 bytes.NewReader(raw) 调用点，判据会空转")
	}
	if found < 3 {
		t.Fatalf("只扫到 %d 个转发入口，预期 3 个（forward/forwardEndpoint/forwardAnthropic）—— 判据面疑似漂移", found)
	}
}

// stripLineComments 去掉行注释，保留 `://`（URL 字面量）里的双斜杠。
func stripLineComments(source string) string {
	lines := strings.Split(source, "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		if i := strings.Index(line, "//"); i >= 0 && !strings.Contains(line[:i], ":/") {
			line = line[:i]
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

// splitGoFuncs 以 `\nfunc ` 为界粗切源码，用于按函数粒度做形状断言。
func splitGoFuncs(source string) []string {
	lines := strings.Split(source, "\n")
	var chunks []string
	var current []string
	for _, line := range lines {
		if strings.HasPrefix(line, "func ") && len(current) > 0 {
			chunks = append(chunks, strings.Join(current, "\n"))
			current = current[:0]
		}
		current = append(current, line)
	}
	if len(current) > 0 {
		chunks = append(chunks, strings.Join(current, "\n"))
	}
	return chunks
}
