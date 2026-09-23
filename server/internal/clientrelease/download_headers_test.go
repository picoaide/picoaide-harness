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
//
// # 断言介质：必须读 `w.Result().Header`，不能读 `w.Header()`（R3-A 复审 F2）
//
// `httptest.ResponseRecorder.Header()` 返回的是**活 map** —— 响应"写完之后"再塞进去
// 的头它照样看得到，于是这类用例对"头写了、但写在 `http.ServeFile` 之后（真连接上
// 不生效）"的**时序缺陷完全免疫**（复审实测：把两条头挪到 ServeFile 之后，本文件
// 全部用例仍绿，而真实 TCP 探针立刻红）。
//
// `w.Result().Header` 是 `WriteHeader` 那一刻的**冻结快照**（Go 的
// ResponseRecorder 在 WriteHeader 里 Clone 一次），读到的就是真实连接会发出的那一份
// 头 —— 这正是本文件要钉的东西；`TestFileDownloadHeadersOverRealHTTP` 再用真实 TCP
// 交叉验证这套介质本身没有说谎。
//
// 路由树必须与生产同形（`GET` + `HEAD`，见 internal/router 的申报）：只注册 GET 的
// 测试树测不到 HEAD 分支。因此下面的主判据对 **GET 与 HEAD 各跑一遍**。
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
		// 生产路由树是 GET + HEAD（internal/router）。HEAD 走的是同一个 handler，
		// 但响应形状不同（无 body），历史上正是"HEAD 侥幸带上头"掩盖了时序缺陷
		//（服务端对 HEAD 会缓冲整份响应），所以两个方法都要判。
		for _, method := range []string{http.MethodGet, http.MethodHead} {
			t.Run(method+" "+tc.name, func(t *testing.T) {
				w := httptest.NewRecorder()
				r.ServeHTTP(w, httptest.NewRequest(method, "/updates/client/"+tc.name, nil))
				if w.Code != http.StatusOK {
					t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
				}
				if method == http.MethodHead && w.Body.Len() != 0 {
					t.Fatalf("HEAD 不得有响应体，实得 %d 字节", w.Body.Len())
				}
				// 判据 ①：类型判定权归平台（浏览器不得嗅探改写）。
				if got := w.Result().Header.Get("X-Content-Type-Options"); got != "nosniff" {
					t.Fatalf("X-Content-Type-Options = %q, want nosniff", got)
				}
				// 判据 ②：声明的类型必须来自扩展名，而不是文件内容
				// （内容故意是 HTML；嗅探实现会在这里给出 text/html）。
				if got := w.Result().Header.Get("Content-Type"); got != tc.wantType {
					t.Fatalf("Content-Type = %q, want %q（不得按内容嗅探）", got, tc.wantType)
				}
				// 判据 ③：一律作为附件下载，且文件名正确（RFC 6266/5987 编码由 mime 包负责）。
				cd := w.Result().Header.Get("Content-Disposition")
				if !strings.HasPrefix(cd, "attachment") {
					t.Fatalf("Content-Disposition = %q, want attachment…（下载面不得内联渲染）", cd)
				}
				if !strings.Contains(cd, "filename="+`"`+tc.name+`"`) {
					t.Fatalf("Content-Disposition = %q，缺正确文件名 %q", cd, tc.name)
				}
			})
		}
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
	if got := w.Result().Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("206 也要带 nosniff，得到 %q", got)
	}
	if got := w.Result().Header.Get("Content-Type"); got != "application/vnd.microsoft.portable-executable" {
		t.Fatalf("206 Content-Type = %q（不得退回嗅探）", got)
	}
	if cd := w.Result().Header.Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment") {
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
	if got := w.Result().Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("404 也应带 nosniff，得到 %q", got)
	}
	if cd := w.Result().Header.Get("Content-Disposition"); cd != "" {
		t.Fatalf("404 不该带 Content-Disposition，得到 %q", cd)
	}
	if ct := w.Result().Header.Get("Content-Type"); !strings.Contains(ct, "json") {
		t.Fatalf("404 应是 JSON 信封类型，得到 %q", ct)
	}
}

// TestFileDownloadHeadersOverRealHTTP 用**真实 TCP** 再判一遍同一组头（R3-A 复审 F2）。
//
// 为什么在 `w.Result().Header` 之外还要这一条：前者依赖"ResponseRecorder 在
// WriteHeader 时冻结快照"这一实现细节，而本文件钉的是**线上行为**。真实连接上
// `net/http` 一旦发出响应头就不再接受新头，因此"头写在 ServeFile 之后"这类时序缺陷
// 在这里必然暴露（复审的原始探针就是这么判红的）。
//
// 覆盖面：200、Range 206、HEAD、以及 404（错误面）。
func TestFileDownloadHeadersOverRealHTTP(t *testing.T) {
	body := strings.Repeat("PA", 512)
	withReleaseDir(t, testInfo(t, "2.7.0", nil), map[string]string{
		"ok.exe":    body,
		"notes.txt": "<html>x</html>",
	})

	srv := httptest.NewServer(newRouter("2.7.0"))
	defer srv.Close()
	client := srv.Client()

	cases := []struct {
		name        string
		method      string
		path        string
		rangeHeader string
		wantStatus  int
	}{
		{name: "200", method: http.MethodGet, path: "/updates/client/ok.exe", wantStatus: http.StatusOK},
		{name: "206", method: http.MethodGet, path: "/updates/client/ok.exe", rangeHeader: "bytes=0-9", wantStatus: http.StatusPartialContent},
		{name: "HEAD", method: http.MethodHead, path: "/updates/client/ok.exe", wantStatus: http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest(tc.method, srv.URL+tc.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			if tc.rangeHeader != "" {
				req.Header.Set("Range", tc.rangeHeader)
			}
			resp, err := client.Do(req)
			if err != nil {
				t.Fatalf("真实请求失败: %v", err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != tc.wantStatus {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.wantStatus)
			}
			if got := resp.Header.Get("X-Content-Type-Options"); got != "nosniff" {
				t.Fatalf("真实连接上 nosniff = %q（头必须在 ServeFile 之前写好）", got)
			}
			if got := resp.Header.Get("Content-Type"); got != "application/vnd.microsoft.portable-executable" {
				t.Fatalf("真实连接上 Content-Type = %q", got)
			}
			if cd := resp.Header.Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment") {
				t.Fatalf("真实连接上 Content-Disposition = %q（时序缺陷在这里必然暴露）", cd)
			}
		})
	}

	// 404 面：同一介质上的反向判据（JSON 信封 + nosniff、且不带 attachment）。
	resp, err := client.Get(srv.URL + "/updates/client/notes.txt")
	if err != nil {
		t.Fatalf("真实请求失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
	if got := resp.Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("404 真实连接上 nosniff = %q", got)
	}
	if cd := resp.Header.Get("Content-Disposition"); cd != "" {
		t.Fatalf("404 不该带 Content-Disposition，得到 %q", cd)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "json") {
		t.Fatalf("404 应是 JSON 信封类型，得到 %q", ct)
	}
}
