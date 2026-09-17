package llmgateway

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// TestValidateErrorReportingDSN 覆盖错误上报 DSN 准入校验的三类结论。
//
// 现场来源(REQUEST F6/F8):GlitchTip 缺 GLITCHTIP_DOMAIN 时后台"客户端密钥"
// 页展示 `http://…@localhost:8000/1`,管理员照抄保存 ⇒ 每台客户端把事件发往
// 自己的电脑 ⇒ 后台 20 天零真实错误。本用例把该值钉死为 reject。
func TestValidateErrorReportingDSN(t *testing.T) {
	accept := []struct {
		name string
		dsn  string
	}{
		{"empty means disabled", ""},
		{"blank means disabled", "   "},
		{"production shape https", "https://0123456789abcdef0123456789abcdef@glitchtip.example.com/1"},
		{"explicit port", "https://key@glitchtip.example.com:8443/1"},
		{"path prefix", "https://key@glitchtip.example.com/sentry/1"},
		{"secret in userinfo", "https://key:secret@glitchtip.example.com/1"},
		{"non-one project id", "https://key@sub.glitchtip.example.com/42"},
	}
	for _, tc := range accept {
		t.Run("accept/"+tc.name, func(t *testing.T) {
			got := InspectErrorReportingDSN(tc.dsn)
			if got.Verdict != ErrorReportingDSNAccept {
				t.Fatalf("InspectErrorReportingDSN(%q) verdict = %s message = %q, want accept", tc.dsn, got.Verdict, got.Message)
			}
			if got.Message != "" {
				t.Fatalf("accept must not carry a message, got %q", got.Message)
			}
			if err := ValidateErrorReportingDSN(tc.dsn); err != nil {
				t.Fatalf("ValidateErrorReportingDSN(%q) = %v, want nil", tc.dsn, err)
			}
		})
	}

	reject := []struct {
		name    string
		dsn     string
		message string
	}{
		{"loopback hostname with port (field value)", "http://key@localhost:8000/1", ErrorReportingDSNBlockedMessage},
		{"loopback hostname", "http://key@localhost/1", ErrorReportingDSNBlockedMessage},
		{"loopback hostname uppercase", "https://key@LOCALHOST/1", ErrorReportingDSNBlockedMessage},
		{"localhost reserved subdomain", "https://key@glitchtip.localhost/1", ErrorReportingDSNBlockedMessage},
		{"ipv4 loopback", "http://key@127.0.0.1/1", ErrorReportingDSNBlockedMessage},
		{"abbreviated ipv4 loopback", "http://key@127.1.2.3/1", ErrorReportingDSNBlockedMessage},
		{"ipv6 loopback", "http://key@[::1]/1", ErrorReportingDSNBlockedMessage},
		{"cloud metadata ipv4", "http://key@169.254.169.254/1", ErrorReportingDSNBlockedMessage},
		{"unspecified ipv4", "http://key@0.0.0.0/1", ErrorReportingDSNBlockedMessage},
		{"ipv6 link local", "http://key@[fe80::1]/1", ErrorReportingDSNBlockedMessage},
		{"cloud metadata hostname", "http://key@metadata.google.internal/1", ErrorReportingDSNBlockedMessage},
		{"aws ipv6 metadata", "http://key@[fd00:ec2::254]/1", ErrorReportingDSNBlockedMessage},
		// S10-2(2026-09-17):接受面 = 客户端 SDK 能解析的形状。中文域名(IDN)与
		// 字面 IPv6 都会让 makeDsn 返回 undefined(SDK 连 transport 都不建)。
		{"idn hostname not parseable by sdk", "https://key@glitchtip.中国/1", ErrorReportingDSNUnsupportedHostMessage},
		{"literal ipv6 not parseable by sdk", "https://key@[2001:db8::1]/1", ErrorReportingDSNUnsupportedHostMessage},
		{"ipv6 ula is rejected not warned", "https://key@[fd00::1]/1", ErrorReportingDSNUnsupportedHostMessage},
		{"non http scheme", "ftp://key@glitchtip.example.com/1", ErrorReportingDSNSchemeMessage},
		{"missing scheme", "glitchtip.example.com/1", ErrorReportingDSNMalformedMessage},
		{"missing public key", "https://glitchtip.example.com/1", ErrorReportingDSNKeyMessage},
		{"empty public key", "https://@glitchtip.example.com/1", ErrorReportingDSNKeyMessage},
		{"missing project id", "https://key@glitchtip.example.com/", ErrorReportingDSNProjectMessage},
		{"non numeric project id", "https://key@glitchtip.example.com/abc", ErrorReportingDSNProjectMessage},
		{"zero project id", "https://key@glitchtip.example.com/0", ErrorReportingDSNProjectMessage},
	}
	for _, tc := range reject {
		t.Run("reject/"+tc.name, func(t *testing.T) {
			got := InspectErrorReportingDSN(tc.dsn)
			if got.Verdict != ErrorReportingDSNReject {
				t.Fatalf("InspectErrorReportingDSN(%q) verdict = %s, want reject", tc.dsn, got.Verdict)
			}
			if got.Message != tc.message {
				t.Fatalf("message = %q, want %q", got.Message, tc.message)
			}
			if err := ValidateErrorReportingDSN(tc.dsn); err == nil {
				t.Fatalf("ValidateErrorReportingDSN(%q) = nil, want error", tc.dsn)
			} else if err.Error() != tc.message {
				t.Fatalf("ValidateErrorReportingDSN error = %q, want %q", err.Error(), tc.message)
			}
		})
	}

	warn := []struct {
		name    string
		dsn     string
		message string
	}{
		{"plain http public host", "http://key@glitchtip.example.com/1", ErrorReportingDSNPlainHTTPMessage},
		{"private 10/8", "https://key@10.0.0.5/1", ErrorReportingDSNPrivateMessage},
		{"private 192.168/16", "https://key@192.168.1.10/1", ErrorReportingDSNPrivateMessage},
		{"private 172.16/12", "https://key@172.16.3.4/1", ErrorReportingDSNPrivateMessage},
		{"http and private", "http://key@10.0.0.5/1", ErrorReportingDSNPlainHTTPMessage + "；" + ErrorReportingDSNPrivateMessage},
	}
	for _, tc := range warn {
		t.Run("warn/"+tc.name, func(t *testing.T) {
			got := InspectErrorReportingDSN(tc.dsn)
			if got.Verdict != ErrorReportingDSNWarn {
				t.Fatalf("InspectErrorReportingDSN(%q) verdict = %s, want warn", tc.dsn, got.Verdict)
			}
			if got.Message != tc.message {
				t.Fatalf("message = %q, want %q", got.Message, tc.message)
			}
			// 告警不阻断:私网/明文是内网自建 GlitchTip 的合法场景。
			if err := ValidateErrorReportingDSN(tc.dsn); err != nil {
				t.Fatalf("warn must not block saving, got %v", err)
			}
		})
	}
}

// TestInspectErrorReportingDSNStoreEndpoint 钉住由 DSN 推导的 ingest 端点
// (P0-4 的"发送测试事件"与客户端 SDK 走同一地址),并确认端点里**不含**公钥。
func TestInspectErrorReportingDSNStoreEndpoint(t *testing.T) {
	cases := []struct {
		dsn      string
		endpoint string
	}{
		{"https://key@glitchtip.example.com/1", "https://glitchtip.example.com/api/1/store/"},
		{"https://key@glitchtip.example.com:8443/1", "https://glitchtip.example.com:8443/api/1/store/"},
		{"https://key@glitchtip.example.com/sentry/7", "https://glitchtip.example.com/sentry/api/7/store/"},
		{"http://key@10.0.0.5/1", "http://10.0.0.5/api/1/store/"},
	}
	for _, tc := range cases {
		got := InspectErrorReportingDSN(tc.dsn)
		if got.StoreEndpoint != tc.endpoint {
			t.Fatalf("InspectErrorReportingDSN(%q).StoreEndpoint = %q, want %q", tc.dsn, got.StoreEndpoint, tc.endpoint)
		}
		if strings.Contains(got.StoreEndpoint, "key") {
			t.Fatalf("store endpoint %q must not carry the public key", got.StoreEndpoint)
		}
		if got.PublicKey != "key" {
			t.Fatalf("PublicKey = %q, want key", got.PublicKey)
		}
	}
}

// TestErrorReportingStoreEndpointIPv6Brackets 钉住 ingest 端点的方括号拼装。
//
// 2026-09-17(S10-3):`u.Hostname()` 会把字面 IPv6 的方括号剥掉(Go 文档明确),
// 直接拼 URL 得到 `https://2001:db8::1/api/1/store/`,连 `http.NewRequest` 都报
// `invalid port ":db8::1" after host` —— "发送测试事件"因此永远走不到出站。
// 判定仍用裸主机名,只有拼 URL 时按需补回方括号。
//
// TQ-11(审计 2026-09-17,r2 test-quality):本用例调的是**未导出 helper**,
// 而 S10-2 之后它在生产里**不可达**(InspectErrorReportingDSN 对任何含 ':' 的
// host 先返回 "SDK 不支持" 的 reject,dsn.go 的 sdkParseableErrorReportingDSNHost)
// —— 也就是说它只是**纵深防御**单测,不代表端到端覆盖。管理员可见的那条
// 可达行为(IPv6 DSN ⇒ reject + 空 StoreEndpoint)由下面的
// TestErrorReportingDSNIPv6ReachableVerdict 断言,别再把这个用例读成端到端证据。
func TestErrorReportingStoreEndpointIPv6Brackets(t *testing.T) {
	cases := []struct {
		name     string
		scheme   string
		host     string
		port     string
		prefix   string
		project  string
		endpoint string
	}{
		{"ipv6 literal", "https", "2001:db8::1", "", "", "1", "https://[2001:db8::1]/api/1/store/"},
		{"ipv6 literal with port and prefix", "http", "2001:db8::1", "8080", "sentry", "7", "http://[2001:db8::1]:8080/sentry/api/7/store/"},
		{"ipv6 loopback", "https", "::1", "", "", "1", "https://[::1]/api/1/store/"},
		{"domain untouched", "https", "glitchtip.example.com", "", "", "1", "https://glitchtip.example.com/api/1/store/"},
		{"ipv4 untouched", "http", "10.0.0.5", "", "", "1", "http://10.0.0.5/api/1/store/"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := errorReportingStoreEndpoint(tc.scheme, tc.host, tc.port, tc.prefix, tc.project)
			if got != tc.endpoint {
				t.Fatalf("errorReportingStoreEndpoint = %q, want %q", got, tc.endpoint)
			}
			// 端点的存在意义就是被 http.NewRequest 用作出站 URL:缺方括号时这一步必红。
			if _, err := http.NewRequest(http.MethodPost, got, nil); err != nil {
				t.Fatalf("store endpoint %q must be a constructible request URL: %v", got, err)
			}
		})
	}
}

// TestErrorReportingDSNIPv6ReachableVerdict 断言 IPv6 DSN 在**可达面**上的结论
// (TQ-11,审计 2026-09-17,r2 test-quality)。
//
// 上面的方括号单测只覆盖未导出 helper,而它的生产调用点在 S10-2 之后不可达
// (含 ':' 的 host 先被 reject)。管理员"发送测试事件"真正会看到的结论在这里:
// IPv6 字面量 ⇒ reject + 空 StoreEndpoint(handler 因此回 400 文案,而不是拿着
// 一条拼不出来的端点去出站,也不是 200 假绿)。环回/链路本地/metadata 的 IPv6
// 仍走更准确的"不能指向本机"文案。
func TestErrorReportingDSNIPv6ReachableVerdict(t *testing.T) {
	cases := []struct {
		name    string
		dsn     string
		message string
	}{
		{"ipv6 literal", "https://key@[2001:db8::1]/1", ErrorReportingDSNUnsupportedHostMessage},
		{"ipv6 literal with port and prefix", "http://key@[2001:db8::1]:8080/sentry/7", ErrorReportingDSNUnsupportedHostMessage},
		{"ipv6 ula", "https://key@[fd00::1]/1", ErrorReportingDSNUnsupportedHostMessage},
		{"ipv6 loopback", "https://key@[::1]/1", ErrorReportingDSNBlockedMessage},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := InspectErrorReportingDSN(tc.dsn)
			if got.Verdict != ErrorReportingDSNReject {
				t.Fatalf("InspectErrorReportingDSN(%q) verdict = %s, want reject", tc.dsn, got.Verdict)
			}
			if got.Message != tc.message {
				t.Fatalf("message = %q, want %q", got.Message, tc.message)
			}
			// 关键:被拒的 DSN 不得留下一条可供"发送测试事件"出站的端点。
			if got.StoreEndpoint != "" {
				t.Fatalf("rejected DSN must not carry a store endpoint, got %q", got.StoreEndpoint)
			}
			if err := ValidateErrorReportingDSN(tc.dsn); err == nil {
				t.Fatalf("ValidateErrorReportingDSN(%q) = nil, want error", tc.dsn)
			}
		})
	}
}

// TestErrorReportingStoreEndpointKeepsEscapedPathPrefix 钉住 ingest 端点里的路径
// 前缀**保持原文**(不 percent-decode)。
//
// 2026-09-17(S10-2 修复轮 2,新发现 P3):项目 ID 与前缀此前取自 `u.Path`(已解码),
// `/%2e%2e/1` 于是拼出 `https://host/../api/1/store/` —— 与实际出站(HTTP 客户端会
// 规范化 `..`)以及客户端 SDK 的 `getBaseApiEndpoint`(path 取自原始串)都不一致;
// `/%31` 更严重:解码后被当成项目 1 而放行,SDK 却因为 projectId 是 `%31` 直接
// 返回 undefined。端点必须与语料同源:原文路径。
func TestErrorReportingStoreEndpointKeepsEscapedPathPrefix(t *testing.T) {
	cases := []struct {
		name     string
		dsn      string
		endpoint string
		project  string
	}{
		{"escaped dot segments stay escaped", "https://key@host.example/%2e%2e/1", "https://host.example/%2e%2e/api/1/store/", "1"},
		{"plain prefix", "https://key@host.example/sentry/7", "https://host.example/sentry/api/7/store/", "7"},
		{"escaped slash does not split the project id", "https://key@host.example/1%2F2", "https://host.example/api/1/store/", "1"},
		{"empty segment in prefix is preserved", "https://key@host.example/a//1", "https://host.example/a//api/1/store/", "1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := InspectErrorReportingDSN(tc.dsn)
			if got.Verdict != ErrorReportingDSNAccept {
				t.Fatalf("InspectErrorReportingDSN(%q) = %s %q, want accept", tc.dsn, got.Verdict, got.Message)
			}
			if got.StoreEndpoint != tc.endpoint {
				t.Fatalf("StoreEndpoint = %q, want %q", got.StoreEndpoint, tc.endpoint)
			}
			if got.ProjectID != tc.project {
				t.Fatalf("ProjectID = %q, want %q", got.ProjectID, tc.project)
			}
			if strings.Contains(got.StoreEndpoint, "..") {
				t.Fatalf("store endpoint %q must not carry decoded dot segments", got.StoreEndpoint)
			}
			// 端点要能被 http.NewRequest 用作真实出站 URL。
			if _, err := http.NewRequest(http.MethodPost, got.StoreEndpoint, nil); err != nil {
				t.Fatalf("store endpoint %q must be a constructible request URL: %v", got.StoreEndpoint, err)
			}
		})
	}
}

// TestErrorReportingDSNProjectIDRange 钉住项目 ID 的范围判定口径:int64 且 > 0。
//
// 2026-09-17(S10-2 修复轮 2,P3):TS 镜像此前用 `Number(projectId) > 0` —— 22 位
// 以上溢出成 1e22/Infinity 仍然 `> 0`,于是页面放行、服务端(strconv 溢出)拒绝。
// 上界逐字对齐 `strconv.ParseInt(digits, 10, 64)`(webadmin 侧用 BigInt 比较)。
func TestErrorReportingDSNProjectIDRange(t *testing.T) {
	cases := []struct {
		project string
		accept  bool
	}{
		{"1", true},
		{"007", true},
		{"9223372036854775807", true},  // int64 上界
		{"9223372036854775808", false}, // 上界 +1
		{"9999999999999999999999", false},
		{strings.Repeat("1", 1900), false},
	}
	for _, tc := range cases {
		t.Run(tc.project[:min(len(tc.project), 24)], func(t *testing.T) {
			got := InspectErrorReportingDSN("https://key@host.example/" + tc.project)
			if tc.accept {
				if got.Verdict != ErrorReportingDSNAccept {
					t.Fatalf("project %q = %s %q, want accept", tc.project, got.Verdict, got.Message)
				}
				if got.ProjectID != tc.project {
					t.Fatalf("ProjectID = %q, want %q", got.ProjectID, tc.project)
				}
				return
			}
			if got.Verdict != ErrorReportingDSNReject || got.Message != ErrorReportingDSNProjectMessage {
				t.Fatalf("project %q = %s %q, want reject %q", tc.project, got.Verdict, got.Message, ErrorReportingDSNProjectMessage)
			}
		})
	}
}

// TestErrorReportingDSNLengthCountsBytes 钉住长度上限的口径:**UTF-8 字节**。
//
// 2026-09-17(S10-2/S12-02):中文域名这类多字节主机如果在长度判定上被当成"字符"，
// 同一串会先落到 SDK 兼容性文案(两侧结论与文案都会分叉)。Go 的 `len(raw)` 本来
// 就是字节数,webadmin 镜像必须同口径(dsn.ts 的 utf8ByteLength)。
func TestErrorReportingDSNLengthCountsBytes(t *testing.T) {
	// 12 + 700×3 + 10 = 2122 字节 > 2048,字符数只有 722 —— 按字符判会误落到
	// "SDK 解析不了 IDN"的文案。
	long := "https://key@" + strings.Repeat("中", 700) + ".example/1"
	if got := InspectErrorReportingDSN(long); got.Verdict != ErrorReportingDSNReject || got.Message != ErrorReportingDSNTooLongMessage {
		t.Fatalf("multi-byte over-long DSN = %s %q, want reject 过长", got.Verdict, got.Message)
	}
}

// TestErrorReportingDSNRejectsQueryOrFragmentInPathPrefix 钉住 S10-2 修复轮 5
// (2026-09-17,r4v 复核)的新拒绝面:**首个 `?`/`#` 出现在最后一个 '/' 之前**
// (等价于切出的路径前缀含 `?`/`#`)的 DSN 一律拒。
//
// 为什么必须拒:这类串的 makeDsn **能成功**(修复轮 3 因此把接受面放宽成
// "SDK 可解析"),但 @sentry/node 的 transports/http.js 对新 URL 取
// `pathname+search` 发请求 —— `https://host/1?x=/api/2/envelope/?sentry_key=…`
// 的 pathname 只剩 `/1`,`/api/2/envelope/` 与 sentry_key 一起被吞,事件必然 404,
// 而保存仍回 200 {ok:true}。判据从「SDK 解析得了」收紧为「SDK 真发得出去」。
//
// 与语料的分工:语料(两侧共用)冻结形状与文案;这里钉规则本身 —— 拒绝文案、
// **StoreEndpoint 必须为空**(否则"发送测试事件"还会拿着一条不可投递的端点出站),
// 以及"`?`/`#` 只落在项目 ID 段里仍接受"这条边界(防止将来把规则误读成
// "任何 ? / # 都拒",把 `/1?x=2` 这种合法 DSN 一起拒掉)。
func TestErrorReportingDSNRejectsQueryOrFragmentInPathPrefix(t *testing.T) {
	reject := []struct {
		name string
		dsn  string
	}{
		{"query whose value has a slash", "https://key@host.example/1?x=/2"},
		{"fragment with a slash", "https://key@host.example/1#/2"},
		{"query whose value is a url", "https://key@host.example/1?x=http://y"},
		{"query whose value contains a slash", "https://key@host.example/1?a=b/c"},
		{"fragment swallows the api path", "https://key@host.example/1#/a"},
		{"trailing slash then query", "https://key@host.example/1/?x=/2"},
		{"empty path then query", "https://key@host.example/?x=/2"},
		{"empty path then query with slash", "https://key@host.example/?q=1/2"},
		{"path prefix then query", "https://key@host.example/sentry/1?x=/2"},
		{"path prefix then fragment", "https://key@host.example/sentry/1#/2"},
		{"double slash prefix then query", "https://key@host.example//1?x=/2"},
		{"escaped prefix then query", "https://key@host.example/%2e%2e/1?x=/2"},
	}
	for _, tc := range reject {
		t.Run("reject/"+tc.name, func(t *testing.T) {
			got := InspectErrorReportingDSN(tc.dsn)
			if got.Verdict != ErrorReportingDSNReject || got.Message != ErrorReportingDSNProjectQueryMessage {
				t.Fatalf("InspectErrorReportingDSN(%q) = %s %q, want reject %q", tc.dsn, got.Verdict, got.Message, ErrorReportingDSNProjectQueryMessage)
			}
			// 被拒的 DSN 不得留下可供"发送测试事件"出站的端点。
			if got.StoreEndpoint != "" {
				t.Fatalf("rejected DSN must not carry a store endpoint, got %q", got.StoreEndpoint)
			}
			if err := ValidateErrorReportingDSN(tc.dsn); err == nil || err.Error() != ErrorReportingDSNProjectQueryMessage {
				t.Fatalf("ValidateErrorReportingDSN(%q) = %v, want %q", tc.dsn, err, ErrorReportingDSNProjectQueryMessage)
			}
		})
	}

	// `?`/`#` 落在**项目 ID 段**里(路径前缀为空)不受新规则影响:SDK 的 path 为空,
	// 拼出的 envelope URL 仍是干净的 `/api/<项目ID>/envelope/`。
	accept := []struct {
		name      string
		dsn       string
		projectID string
		endpoint  string
	}{
		{"query after the project segment", "https://key@host.example/1?x=2", "1", "https://host.example/api/1/store/"},
		{"fragment after the project segment", "https://key@host.example/1#x", "1", "https://host.example/api/1/store/"},
		{"empty query", "https://key@host.example/1?", "1", "https://host.example/api/1/store/"},
		{"empty fragment", "https://key@host.example/1#", "1", "https://host.example/api/1/store/"},
		{"query and fragment after the project segment", "https://key@host.example/1?x=2#y", "1", "https://host.example/api/1/store/"},
		{"fragment after a prefixed project segment", "https://key@host.example/sentry/1#x", "1", "https://host.example/sentry/api/1/store/"},
		{"empty segment prefix then query in project segment", "https://key@host.example//1?x=2", "1", "https://host.example/api/1/store/"},
		{"escaped question mark is not a delimiter", "https://key@host.example/a%3Fb/1", "1", "https://host.example/a%3Fb/api/1/store/"},
		{"escaped hash is not a delimiter", "https://key@host.example/a%23b/1", "1", "https://host.example/a%23b/api/1/store/"},
	}
	for _, tc := range accept {
		t.Run("accept/"+tc.name, func(t *testing.T) {
			got := InspectErrorReportingDSN(tc.dsn)
			if got.Verdict != ErrorReportingDSNAccept {
				t.Fatalf("InspectErrorReportingDSN(%q) = %s %q, want accept", tc.dsn, got.Verdict, got.Message)
			}
			if got.ProjectID != tc.projectID {
				t.Fatalf("ProjectID = %q, want %q", got.ProjectID, tc.projectID)
			}
			if got.StoreEndpoint != tc.endpoint {
				t.Fatalf("StoreEndpoint = %q, want %q", got.StoreEndpoint, tc.endpoint)
			}
			assertDeliverableStoreEndpoint(t, tc.dsn, got)
		})
	}
}

// TestErrorReportingDSNCorpusEndpointsAreDeliverable 对**全部**已接受语料行断言
// 投递面不变量(与 r4v 的 SDK 判据同构):
//
//	客户端:`new URL(getEnvelopeEndpointWithUrlEncodedAuth(makeDsn(d))).pathname`
//	        必须含 `/api/<项目ID>/envelope/`;
//	Go 侧:url.Parse(StoreEndpoint).EscapedPath() 必须以 `/api/<项目ID>/store/` 结尾。
//
// 两者是同一件事的两半 —— @sentry/node 的 transports/http.js:105/123 发的就是
// `pathname+search`,路径里没有 API 段就等于事件 404。S10-2 修复轮 5 之前,
// 有 1,310 条新接受行在这条判据下全红(路径前缀里的 `?`/`#` 把 API 段吞进
// query/fragment)。语料加了新行时这条断言自动覆盖,不需要逐行维护。
func TestErrorReportingDSNCorpusEndpointsAreDeliverable(t *testing.T) {
	cases := loadErrorReportingDSNCorpus(t)
	checked := 0
	for _, tc := range cases {
		inspection := InspectErrorReportingDSN(tc.DSN)
		if inspection.Rejected() {
			if inspection.StoreEndpoint != "" {
				t.Fatalf("rejected DSN %q must not carry a store endpoint, got %q", tc.DSN, inspection.StoreEndpoint)
			}
			continue
		}
		// 空串 = 未启用(允许清空),没有"投递面"可言。
		if strings.TrimSpace(tc.DSN) == "" {
			continue
		}
		if inspection.StoreEndpoint == "" {
			t.Fatalf("accepted DSN %q must carry a store endpoint", tc.DSN)
		}
		assertDeliverableStoreEndpoint(t, tc.DSN, inspection)
		checked++
	}
	if checked < 20 {
		t.Fatalf("only %d accepted corpus rows checked, want at least 20", checked)
	}
	t.Logf("deliverable store endpoints checked: %d", checked)
}

// assertDeliverableStoreEndpoint 断言端点的**路径**仍以 /api/<项目ID>/store/ 结尾
// (即 `?`/`#` 没有把 API 段吞进 query/fragment)。
func assertDeliverableStoreEndpoint(t *testing.T, dsn string, inspection ErrorReportingDSN) {
	t.Helper()
	parsed, err := url.Parse(inspection.StoreEndpoint)
	if err != nil {
		t.Fatalf("DSN %q: store endpoint %q is not a URL: %v", dsn, inspection.StoreEndpoint, err)
	}
	suffix := "/api/" + inspection.ProjectID + "/store/"
	if !strings.HasSuffix(parsed.EscapedPath(), suffix) {
		t.Fatalf("DSN %q: store endpoint path %q must end with %q (a query/fragment must not swallow the API segment)", dsn, parsed.EscapedPath(), suffix)
	}
}
