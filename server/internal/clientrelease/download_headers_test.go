package clientrelease

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ===========================================================================
// 安装包下载端点的**显式响应头**（R3-A A-12）
// ===========================================================================
//
// 缺陷形态（审计第三轮 A-12，加固项）：`file()` 只设 Cache-Control 与写截止，
// 然后直接 `http.ServeFile` —— 于是
//   - **没有 `X-Content-Type-Options: nosniff`**：类型由客户端嗅探决定；
//   - **没有 Content-Disposition**：浏览器可以**内联渲染**下载内容，
//     同源 + 被嗅成 HTML 就是一个现成的 XSS 面；
//   - Content-Type 由 ServeFile 按扩展名/内容推导（运行镜像里可能没有 mime
//     数据库，未知扩展名直接走**内容嗅探**）。
//
// 本文件把"下载面"的三条硬约束钉住：
//  1. `nosniff` 必须在（浏览器不得改写类型判定）；
//  2. Content-Type 必须是**平台声明的安装包类型**，与文件内容无关
//     （用例特意让 `.dmg` 里装 HTML 字节 —— 嗅探实现会给出 text/html）；
//  3. `Content-Disposition: attachment` + 正确的文件名（不得内联渲染）。
//
// 取舍（为什么是 attachment 而不是 inline）：这条路由服务的全部是安装包
// （白名单只有 .dmg/.exe/.appimage/.deb/.zip/.tar.gz/.msi/.pkg），没有任何一种
// 需要浏览器内联渲染；而 inline 的收益是零、代价是一个同源渲染面。
func TestFileDownloadHeadersAreExplicit(t *testing.T) {
	// 内容全部是 HTML（最坏形态）：任何"按内容嗅探"的实现都会给出 text/html，
	// 而平台必须按**扩展名**声明安装包类型。
	const htmlBytes = "<html><script>alert(1)</script></html>"
	withReleaseDir(t, testInfo(t, "2.7.0", nil), map[string]string{
		"PicoAide-2.7.0.dmg": htmlBytes,
		"Setup-2.7.0.exe":    htmlBytes,
		"app.AppImage":       htmlBytes,
		"picoaide.deb":       htmlBytes,
		"win.zip":            htmlBytes,
		"pkg.tar.gz":         htmlBytes,
		"installer.msi":      htmlBytes,
		"mac.pkg":            htmlBytes,
		"PicoAide-2.7.0.DMG": htmlBytes, // 扩展名大小写不敏感
	})
	r := newRouter("2.7.0")

	cases := []struct {
		name     string
		wantType string
	}{
		{"PicoAide-2.7.0.dmg", "application/x-apple-diskimage"},
		{"PicoAide-2.7.0.DMG", "application/x-apple-diskimage"},
		{"Setup-2.7.0.exe", "application/vnd.microsoft.portable-executable"},
		{"app.AppImage", "application/vnd.appimage"},
		{"picoaide.deb", "application/vnd.debian.binary-package"},
		{"win.zip", "application/zip"},
		{"pkg.tar.gz", "application/gzip"},
		{"installer.msi", "application/x-msi"},
		{"mac.pkg", "application/vnd.apple.installer+xml"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/updates/client/"+tc.name, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
			}
			// 判据 ①：类型判定权归平台（浏览器不得嗅探改写）。
			if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
				t.Fatalf("X-Content-Type-Options = %q, want nosniff", got)
			}
			// 判据 ②：声明的类型必须来自扩展名，而不是文件内容
			// （内容故意是 HTML；嗅探实现会在这里给出 text/html）。
			if got := w.Header().Get("Content-Type"); got != tc.wantType {
				t.Fatalf("Content-Type = %q, want %q（不得按内容嗅探）", got, tc.wantType)
			}
			// 判据 ③：一律作为附件下载，且文件名正确（RFC 6266/5987 编码由 mime 包负责）。
			cd := w.Header().Get("Content-Disposition")
			if !strings.HasPrefix(cd, "attachment") {
				t.Fatalf("Content-Disposition = %q, want attachment…（下载面不得内联渲染）", cd)
			}
			if !strings.Contains(cd, "filename="+`"`+tc.name+`"`) {
				t.Fatalf("Content-Disposition = %q，缺正确文件名 %q", cd, tc.name)
			}
		})
	}
}

// TestFileDownloadHeadersSurviveRangeRequests 钉住**断点续传**路径同样带头。
//
// 为什么单独钉：`http.ServeFile` 的 206 分支是另一条写法（serveContent 自己写头），
// 只在 200 分支上带头会让"续传得到的响应"退回嗅探语义 —— 而安装包（几十上百 MB）
// 恰恰最常走 Range。
func TestFileDownloadHeadersSurviveRangeRequests(t *testing.T) {
	body := strings.Repeat("PA", 512)
	withReleaseDir(t, testInfo(t, "2.7.0", nil), map[string]string{"ok.exe": body})
	r := newRouter("2.7.0")

	req := httptest.NewRequest(http.MethodGet, "/updates/client/ok.exe", nil)
	req.Header.Set("Range", "bytes=0-9")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusPartialContent || w.Body.String() != body[:10] {
		t.Fatalf("range status=%d body=%q", w.Code, w.Body.String())
	}
	if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("206 也要带 nosniff，得到 %q", got)
	}
	if got := w.Header().Get("Content-Type"); got != "application/vnd.microsoft.portable-executable" {
		t.Fatalf("206 Content-Type = %q（不得退回嗅探）", got)
	}
	if cd := w.Header().Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment") {
		t.Fatalf("206 Content-Disposition = %q，want attachment…", cd)
	}
}

// TestFileNotFoundIsNotSniffable 是**反向用例的邻接面**：非法/不存在的下载请求
// 仍然 404 + JSON 信封，且同样带 nosniff（错误面的类型也不该由嗅探决定）。
// 这条同时防止"为了让头存在而把 404 改成 200"这类过度修复。
func TestFileNotFoundIsNotSniffable(t *testing.T) {
	withReleaseDir(t, testInfo(t, "2.7.0", nil), map[string]string{"notes.txt": "<html>x</html>"})
	r := newRouter("2.7.0")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/updates/client/notes.txt", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("非白名单扩展名必须 404，得到 %d", w.Code)
	}
	if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("404 也应带 nosniff，得到 %q", got)
	}
	if cd := w.Header().Get("Content-Disposition"); cd != "" {
		t.Fatalf("404 不该带 Content-Disposition，得到 %q", cd)
	}
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "json") {
		t.Fatalf("404 应是 JSON 信封类型，得到 %q", ct)
	}
}
