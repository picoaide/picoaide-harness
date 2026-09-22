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
	out, err := sanitizeOutboundBody(nil, body)
	if err != nil {
		t.Fatalf("strip returned error: %v", err)
	}
	if string(out) == string(body) {
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
	out, err := sanitizeOutboundBody(nil, body)
	if err != nil || string(out) == string(body) {
		t.Fatalf("strip = (%q, %v), want stripped", string(out), err)
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
	out, err := sanitizeOutboundBody(nil, body)
	if err != nil {
		t.Fatalf("strip err=%v, want untouched", err)
	}
	if !bytes.Equal(out, body) {
		t.Fatalf("body was re-encoded without cause:\n before=%q\n after =%q", body, out)
	}
}

// 前缀只出现在**值**里（例如某条消息的正文提到 dsh_）不得触发剔除或重编码。
func TestStripUpstreamExtensionsIgnoresPrefixInsideValues(t *testing.T) {
	body := []byte(`{"model":"m","messages":[{"role":"user","content":"what is dsh_session_log?"}]}`)
	out, err := sanitizeOutboundBody(nil, body)
	if err != nil {
		t.Fatalf("strip err=%v, want untouched", err)
	}
	if !bytes.Equal(out, body) {
		t.Fatal("body was re-encoded although the prefix only appeared inside a value")
	}
}

// 嵌套结构里的同名键**不是**上游的扩展面（上游只写顶层），不动它。
func TestStripUpstreamExtensionsLeavesNestedKeysAlone(t *testing.T) {
	body := []byte(`{"model":"m","metadata":{"dsh_session_log":"keep-me"}}`)
	out, err := sanitizeOutboundBody(nil, body)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != string(body) {
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
			out, err := sanitizeOutboundBody(nil, raw)
			// 非对象 / 坏 JSON：必须报错（fail-closed），且不得返回被改过的体。
			if body == `{"dsh_session_log":` || body == `[{"dsh_session_log":1}]` || body == `"dsh_session_log"` {
				if err == nil {
					t.Fatalf("%s: expected an error (fail-closed)", name)
				}
				return
			}
			if err != nil {
				t.Fatalf("%s: unexpected error %v", name, err)
			}
			if !bytes.Equal(out, raw) {
				t.Fatalf("%s: body changed to %q", name, string(out))
			}
		})
	}
}

// sanitizeOutboundBody 是转发入口用的包装：**解析失败必须 fail-closed**（返回错误），
// 不能"降级为原样转发"。旧行为（原样转发）是审计 2026-09-22 F 路 P0-1 的一半根因：
// 任何一个 fail-open 的闸门都会成为整条校验链的绕过入口。
func TestSanitizeOutboundBodyFailsClosedOnParseFailure(t *testing.T) {
	raw := []byte(`{"dsh_session_log":`)
	if _, err := sanitizeOutboundBody(nil, raw); err == nil {
		t.Fatal("sanitizeOutboundBody 对解析失败的体返回 nil 错误（fail-open）")
	}
	// 带前缀但不是对象（数组/标量）：同样不放过。
	for _, bad := range []string{`{"dsh_session_log":[1,2]`, `{"dsh_a":1,"dsh_b":`, `[{"dsh_a":1}]`} {
		if _, err := sanitizeOutboundBody(nil, []byte(bad)); err == nil {
			t.Fatalf("sanitizeOutboundBody 对带前缀的坏体 %s 返回 nil 错误", bad)
		}
	}
	// 不带前缀的体**不解析**（零重编码快路径）——合法性由更早的 prepareOutboundBody
	// 负责，本函数不是唯一的闸门。
	if out, err := sanitizeOutboundBody(nil, []byte(`[1,2]`)); err != nil || string(out) != `[1,2]` {
		t.Fatalf("无前缀的体应逐字节透传: err=%v out=%q", err, string(out))
	}
	// 合法对象且无前缀：逐字节不变（零重编码）。
	same := []byte(`{"model":"m","messages":[]}`)
	out, err := sanitizeOutboundBody(nil, same)
	if err != nil || !bytes.Equal(out, same) {
		t.Fatalf("无前缀的合法体被改动或拒绝：err=%v out=%q", err, string(out))
	}
}

// 防漏判据（本次 P0 的教训）：任何**构造上游请求**的函数都必须先过净化。
//
// 2026-09-22 审计 F 路把旧版判据打穿了两处（M7/M7b）：
//   - 旧指纹是"变量名恰为 raw + bytes.NewReader"，换个变量名/构造器就看不见；
//     新判据锚在 `http.NewRequest`（构造出站请求这个**动作**）本身；
//   - 旧版还靠 `stripLineComments` 剥注释，而它的 `://` 保护写错，含 URL 字面量的
//     一行会被整行截断 ⇒ 同一行的指纹消失（M7b 实测守卫仍绿）。现已改成带字符串
//     状态的扫描器（见下），并用 `stripLineCommentsIsStringAware` 自证。
//
// 允许清单：构造请求但**不做**客户端体净化的函数（每条都要写清为什么）。
// 清单本身也受判据约束：条目必须真的被扫到（禁止留死条目）。
var outboundRequestAllowlist = map[string]string{
	"balance.go:fetchDeepSeekBalance":                          "余额探针：服务端自建 GET，无客户端体",
	"embedding.go:Embed":                                       "集成路径：出站体由服务端按解析后的 input 自建",
	"errorreporting_test_event.go:sendErrorReportingTestEvent": "错误上报测试探针：体是服务端自建事件",
	"files.go:handleFilesUpload":                               "Files API 直通：客户端体**就是文件字节**，无 JSON 字段面",
	"files.go:doFilesMeta":                                     "Files 元数据 GET/DELETE：无请求体",
}

func TestEveryForwardHelperSanitizesOutboundBody(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	requestCtor := regexp.MustCompile(`http\.NewRequest`)
	hitAllowlist := map[string]bool{}
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
		for _, chunk := range splitGoFuncs(text) {
			if !requestCtor.MatchString(chunk) {
				continue
			}
			found++
			fn := goFuncName(chunk)
			if reason, ok := outboundRequestAllowlist[name+":"+fn]; ok {
				hitAllowlist[name+":"+fn] = true
				_ = reason
				continue
			}
			if !strings.Contains(chunk, "sanitizeOutboundBody(") {
				t.Fatalf("%s: %s 构造了上游请求但没有调用 sanitizeOutboundBody —— "+
					"新增转发路径必须接服务端净化闸门（P0-4），确属无客户端体请登记 outboundRequestAllowlist 并写明理由",
					name, fn)
			}
		}
	}
	if found == 0 {
		t.Fatal("没有扫到任何 http.NewRequest 调用点，判据会空转")
	}
	if found < 3 {
		t.Fatalf("只扫到 %d 个上游请求构造点，预期至少 3 个 —— 判据面疑似漂移", found)
	}
	for key := range outboundRequestAllowlist {
		if !hitAllowlist[key] {
			t.Fatalf("outboundRequestAllowlist 有条目 %q 从未被扫到（死条目/函数改名未同步）", key)
		}
	}
}

// TestStripLineCommentsIsStringAware：剥注释器自身的判据（M7b 的根因）。
// 含 URL 字面量、含转义引号、含行内 `//` 字符串的行必须**保住代码部分**。
func TestStripLineCommentsIsStringAware(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{`req, _ := http.NewRequestWithContext(ctx, "POST", "http://up.example/v1/x", bytes.NewReader(raw)) // 发上游`,
			`req, _ := http.NewRequestWithContext(ctx, "POST", "http://up.example/v1/x", bytes.NewReader(raw)) `},
		{`x := "a//b" // 注释`, `x := "a//b" `},
		{`y := ` + "`raw // string`" + ` // tail`, `y := ` + "`raw // string`" + ` `},
		{`// 整行注释`, ``},
		{`z := "esc\"// not-comment"`, `z := "esc\"// not-comment"`},
	}
	for _, tc := range cases {
		if got := stripLineComments(tc.in); got != tc.want {
			t.Fatalf("stripLineComments(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// goFuncName 取粗切函数块的方法名（`func (a *API) foo(` → "foo"，`func bar(` → "bar"）。
func goFuncName(chunk string) string {
	first := chunk
	if i := strings.IndexByte(chunk, '\n'); i >= 0 {
		first = chunk[:i]
	}
	first = strings.TrimPrefix(strings.TrimSpace(first), "func ")
	if strings.HasPrefix(first, "(") {
		i := strings.Index(first, ")")
		if i < 0 {
			return first
		}
		first = strings.TrimSpace(first[i+1:])
	}
	if i := strings.IndexByte(first, '('); i >= 0 {
		first = first[:i]
	}
	return strings.TrimSpace(first)
}

// stripLineComments 去掉行注释，保留字符串字面量里的 `//`。
//
// 不要退回"看 `://` 在不在"的写法：`line[:i]` 恰好不含 `http://` 里紧跟 `:` 的那个
// `/`，保护永远不生效（审计 F 路 M7b 实测）。
func stripLineComments(source string) string {
	lines := strings.Split(source, "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		cut := len(line)
		var quote byte // 0=不在字符串里；'"' 或 '`'
		for i := 0; i < len(line); i++ {
			ch := line[i]
			switch {
			case quote != 0:
				if quote == '"' && ch == '\\' {
					i++ // 跳过被转义的字符
					continue
				}
				if ch == quote {
					quote = 0
				}
			case ch == '"' || ch == '`':
				quote = ch
			case ch == '/' && i+1 < len(line) && line[i+1] == '/':
				cut = i
				i = len(line)
			}
		}
		out = append(out, line[:cut])
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

// TestFullBodyRoundTripsAreCentralized：整 body 的**重编码**只允许出现在
// `body_memory.go` 的 `rewriteJSONObjectBody`（内存闸门 + 统一编码口径的唯一入口）。
//
// 这条守卫直接针对审计 2026-09-22 R4 P1-1：`sanitize.go` 曾自带 `json.Marshal`
// （不过闸门 + 默认 HTML 转义，出站体膨胀 6×，且能被 `dsh_` 键用来绕过内存闸门）。
// 允许清单里的每一条都要写清"为什么它不是客户端请求体的往返"。
// 登记形式是「文件 → (出现次数, 理由)」：次数一并钉住，**新增一处 marshal 就会红**
// （整文件白名单会把这个文件永久放行）。确属正当小体时同步改数字并复核。
var bodyMarshalAllowlist = map[string]struct {
	count  int
	reason string
}{
	"embedding.go":                 {2, "服务端自建 {model,input} 出站体（客户端体不转发）"},
	"errorreporting_test_event.go": {1, "服务端自建的诊断事件体"},
	"files.go":                     {1, "上游**响应**信封重写（列表过滤用，≤4MiB 响应体）"},
	"handler.go":                   {2, "① 上游错误信封重建 ② 单个流式元数据值的字节量（都不是整 body 往返）"},
	"sync.go":                      {1, "模型 sync 时重建 default_params（服务端配置小体，与请求体无关）"},
}

func TestFullBodyRoundTripsAreCentralized(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	marshal := regexp.MustCompile(`json\.Marshal\(|json\.NewEncoder\(`)
	hit := map[string]bool{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		if name == "body_memory.go" {
			continue // 唯一实现所在地
		}
		source, err := os.ReadFile(filepath.Clean(name))
		if err != nil {
			t.Fatal(err)
		}
		n := len(marshal.FindAllString(stripLineComments(string(source)), -1))
		if n == 0 {
			continue
		}
		if entry, ok := bodyMarshalAllowlist[name]; ok {
			hit[name] = true
			if entry.count != n {
				t.Fatalf("%s 的 json.Marshal/json.NewEncoder 出现次数由 %d 变为 %d —— "+
					"新增/删除的整 body 重编码必须走 rewriteJSONObjectBody；"+
					"确属服务端自建的小体请同步更新 bodyMarshalAllowlist 的理由与次数", name, entry.count, n)
			}
			continue
		}
		t.Fatalf("%s 里出现了 json.Marshal/json.NewEncoder —— 整 body 重编码必须走 "+
			"rewriteJSONObjectBody（否则绕过内存闸门 + 编码口径不一致）；"+
			"确属服务端自建的小体请登记 bodyMarshalAllowlist 并写清理由", name)
	}
	for name := range bodyMarshalAllowlist {
		if !hit[name] {
			t.Fatalf("bodyMarshalAllowlist 有条目 %q 已不再出现（死条目）", name)
		}
	}
}
