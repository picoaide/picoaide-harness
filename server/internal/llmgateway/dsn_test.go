package llmgateway

import (
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
		{"ipv6 ula", "https://key@[fd00::1]/1", ErrorReportingDSNPrivateMessage},
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
