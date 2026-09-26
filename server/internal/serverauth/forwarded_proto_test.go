package serverauth

import (
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/clientrelease"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// ===========================================================================
// 管理会话 cookie 的 `Secure` 与清单 URL 生成必须**共用同一份** XFP 判定
// （第二十七轮审计 AA2-02 的消费点 B）
// ===========================================================================
//
// 修前：这里用 `strings.EqualFold(header, "https")`，取值域小于真实解析面 ——
// `https `（带空白）与 `https, http`（多跳列表）都判不出 https，管理会话 cookie
// 静默丢掉 `Secure`；同一时刻 clientrelease 的下载清单 `urls` 也是 0。
// 同一个事实被两处各判一次就必然分叉，所以判定只剩 clientrelease 的
// `ForwardedProtoIsHTTPS` 一份实现。
//
// 本文件用**同一组形态语料**（与 internal/clientrelease/forwarded_proto_test.go 的
// `xfpShapes` 逐字一致）钉住两件事：
//  1. 共享实现的取值域（大小写/空白/多跳列表/畸形/fail-closed）；
//  2. 消费点 B 的结论**等于**共享实现的结论 —— 走真实登录路由（/api/server/admin/login
//     → issueAdminSession → secureCookieFor → Set-Cookie），不是直调函数，
//     所以"serverauth 又自己写了一份判定"这种回退会立刻变红。
//
// 语料在两个包里各写一份是因为跨包的 `_test.go` 夹具不可导入；一致性由
// "两边都对同一组期望值断言 + 本文件同时断言共享实现的结论"保证。
// ===========================================================================

var secureCookieXFPCases = []struct {
	header string
	want   bool
	note   string
}{
	{"https", true, "现状形态"},
	{"HTTPS", true, "全大写"},
	{"Https", true, "混合大小写"},
	{"https ", true, "尾随空白"},
	{" https", true, "前导空白"},
	{"https, http", true, "多跳：最左 = 客户端侧 https"},
	{"HTTPS , HTTP", true, "多跳 + 大小写 + 空白"},
	{"http, https", false, "多跳：最左 = http ⇒ 不打 Secure"},
	{"http", false, "明文"},
	{"", false, "无头（fail-closed）"},
	{"wss", false, "未知 scheme"},
	{"on", false, "非 scheme 形态"},
	{", https", false, "畸形：最左段为空 ⇒ 判不出即非 https"},
}

func TestSecureCookieFollowsSharedForwardedProtoTable(t *testing.T) {
	r, db := adminRouter(t)
	// 前提：本用例要覆盖的是"未显式配置 server.secure_cookies"的缺省路径。
	// 设置缓存按 db 作用域键控，而 db 指针地址会被 GC 复用（见
	// ratelimit_isolation_test.go 顶部说明），所以显式失效一次再断言前提。
	serverstore.InvalidateSettings()
	t.Cleanup(serverstore.InvalidateSettings)
	if v, ok, err := serverstore.GetSetting(db, "server.secure_cookies"); err != nil || ok {
		t.Fatalf("前提不成立：server.secure_cookies 应为未配置（value=%q ok=%v err=%v）", v, ok, err)
	}

	for _, tc := range secureCookieXFPCases {
		t.Run(xfpCaseName(tc.header), func(t *testing.T) {
			// ① 共享实现本身的取值域（与 clientrelease 侧同一组期望值）。
			if got := clientrelease.ForwardedProtoIsHTTPS(tc.header); got != tc.want {
				t.Fatalf("clientrelease.ForwardedProtoIsHTTPS(%q) = %v, want %v（%s）", tc.header, got, tc.want, tc.note)
			}
			// ② 真实登录路由下发的 cookie：Secure 必须 == 共享实现的结论。
			hdr := map[string]string{}
			if tc.header != "" {
				hdr["X-Forwarded-Proto"] = tc.header
			}
			w, _ := doJSON(t, r, "POST", "/api/server/admin/login",
				`{"username":"boss","password":"pw123456"}`, hdr)
			if w.Code != http.StatusOK {
				t.Fatalf("登录失败：%d %s", w.Code, w.Body.String())
			}
			secure, found := sessionCookieSecure(w.Result().Cookies())
			if !found {
				t.Fatalf("登录响应里没有 %s cookie", sessionCookieName)
			}
			if secure != tc.want {
				t.Fatalf("XFP=%q 时 cookie Secure = %v, want %v（%s）：判定没有共用共享实现",
					tc.header, secure, tc.want, tc.note)
			}
		})
	}
}

// xfpCaseName 给空头一个可读的用例名。
func xfpCaseName(header string) string {
	if header == "" {
		return "(空)"
	}
	return header
}

// sessionCookieSecure 找管理会话 cookie 的 Secure 属性。
func sessionCookieSecure(cookies []*http.Cookie) (secure bool, found bool) {
	for _, ck := range cookies {
		if ck.Name == sessionCookieName {
			return ck.Secure, true
		}
	}
	return false, false
}
