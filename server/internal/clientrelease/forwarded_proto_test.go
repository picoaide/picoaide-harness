package clientrelease

import (
	"net/http"
	"strings"
	"testing"
)

// ===========================================================================
// `X-Forwarded-Proto` 的取值域（第二十七轮审计 AA2-02）
// ===========================================================================
//
// 病根：同一个头在本仓曾有三处三种口径 —— 本包 `resolveOrigin` 全等比较
// `== "https"`、`serverauth.secureCookieFor` 用 `EqualFold`（不认列表/空白）、
// `wasmapp/appproof` 只判非空。三者的取值域都小于**真实解析面**（HTTP 的 scheme
// 大小写不敏感；多跳链路里 XFP 是逗号分隔列表；代理拼接时常带空白），于是
// `HTTPS` / `https ` / `https, http` 这些代理常态形态下：
//   - 清单 HTTP 200 但 `client.assets.*.url` 全空（门户下载卡同时消失，全文只有
//     一行进程级 warn）—— 本文件的消费点 A；
//   - 管理会话 cookie 丢掉 `Secure`（应用侧没有 HSTS）—— serverauth 侧的消费点 B，
//     由 `internal/serverauth/forwarded_proto_test.go` 对同一张表交叉验证。
//
// 现在判定只有一份实现：`ForwardedProtoIsHTTPS`。下面这张表是**唯一的期望语料**
// （serverauth 侧用同一组形态断言"消费点 B 的结论 == 共享实现的结论"）。
// ===========================================================================

// xfpShapes 是两种代理形态（大小写 / 空白 / 多跳列表 / 畸形 / 未知 scheme）的期望语料。
//
// 期望值一律按**保守正确**定：
//   - 大小写不敏感、忽略首尾空白；
//   - 多跳列表取**最左**段（代理把"自己收到的协议"追加在右侧，最左段才是客户端
//     侧那一跳；与 wasmapp/appproof.ServerURL 同口径）；
//   - 判不出来就是 false（fail-closed）—— 空值、未知 scheme、最左段为空的畸形
//     形态都不乐观假设成 https。
var xfpShapes = []struct {
	header string
	want   bool
	note   string
}{
	{"https", true, "现状形态（修前唯一被认的取值）"},
	{"HTTPS", true, "全大写"},
	{"Https", true, "混合大小写"},
	{"https ", true, "尾随空白"},
	{" https", true, "前导空白"},
	{"https, http", true, "多跳：最左 = 客户端侧 https"},
	{"HTTPS , HTTP", true, "多跳 + 大小写 + 空白"},
	{"http, https", false, "多跳：最左 = 客户端侧 http ⇒ 不给 https 地址、不打 Secure"},
	{"http", false, "明文"},
	{"", false, "无头（fail-closed）"},
	{"wss", false, "未知 scheme"},
	{"on", false, "非 scheme 形态（某些扫描器的取值）"},
	{", https", false, "畸形：最左段为空 ⇒ 判不出即非 https"},
}

func TestForwardedProtoIsHTTPSTable(t *testing.T) {
	for _, tc := range xfpShapes {
		t.Run(xfpShapeName(tc.header), func(t *testing.T) {
			if got := ForwardedProtoIsHTTPS(tc.header); got != tc.want {
				t.Fatalf("ForwardedProtoIsHTTPS(%q) = %v, want %v（%s）", tc.header, got, tc.want, tc.note)
			}
		})
	}
}

// xfpShapeName 给空头一个可读的用例名（空串会自动变成 #00，排查时看不出是哪一行）。
func xfpShapeName(header string) string {
	if header == "" {
		return "(空)"
	}
	return header
}

// 消费点 A：清单 URL 生成。`want=true` 的形态必须给出**逐字相同**的 https 下载地址
// （修前的 `https` 行不得有任何行为变化），`want=false` 的形态必须不给 client 段
// —— 宁可不给 URL，也不给一个会被客户端整份丢弃的错 URL。
func TestManifestURLsFollowForwardedProtoTable(t *testing.T) {
	withReleaseDir(t, oneAsset(t), nil)
	t.Setenv(PublicBaseURLEnv, "")
	captureOriginWarnings(t) // 形态为"不可用"时会走 warnOriginUnavailable，这里只记账不刷屏
	r := newRouter("2.7.0")

	for _, tc := range xfpShapes {
		t.Run(xfpShapeName(tc.header), func(t *testing.T) {
			body := getManifest(t, r, func(req *http.Request) {
				req.Host = "ai.example.com"
				if tc.header != "" {
					req.Header.Set("X-Forwarded-Proto", tc.header)
				}
			})
			got := assetURL(body, "win-x64")
			want := ""
			if tc.want {
				want = "https://ai.example.com/updates/client/Setup.exe"
			}
			if got != want {
				t.Fatalf("XFP=%q 的 asset url = %q, want %q（%s）", tc.header, got, want, tc.note)
			}
			// 反向面：判不出 https 时必须**明说**不可用（而不是静默下发一份 assets 为空的清单）。
			_, unavailable := body["client_unavailable"]
			if tc.want && unavailable {
				t.Fatalf("XFP=%q 不该报 client_unavailable: %v", tc.header, body)
			}
			if !tc.want && !unavailable {
				t.Fatalf("XFP=%q 必须报 client_unavailable: %v", tc.header, body)
			}
			if !tc.want && strings.Contains(unavailableReason(body), "/updates/client/") {
				t.Fatalf("XFP=%q 的不可用原因里不该有链接: %v", tc.header, body["client_unavailable"])
			}
		})
	}
}

// unavailableReason 取 client_unavailable 的文本形态（缺失时空串）。
func unavailableReason(body map[string]any) string {
	s, _ := body["client_unavailable"].(string)
	return s
}
