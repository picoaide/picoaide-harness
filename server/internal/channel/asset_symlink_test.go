package channel

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// ---------------------------------------------------------------------------
// 渠道素材必须是渠道目录内的**普通文件**（2026-09-26 第二十三轮审计 W5-01）
//
// 威胁链（审计四步实测）：三个素材端点（/channel/logo、/channel/logo-dark、
// /channel/favicon）按产品设计**未认证**（登录页在未登录时就要拿 logo），而渠道
// 目录由 CI 从私有渠道仓注入 —— 是不可信输入。旧实现用 `os.Stat` 判"素材存在"
// （**跟随**符号链接，只排目录）再用 `http.ServeFile` 按路径打开（同样跟随），
// 于是渠道包把一个素材做成符号链接，就等于把**容器内任意可读文件**挂到了未认证
// 端点上（实测三端点全 200 且 body 是渠道目录之外文件的内容）。
//
// 防线只有一条：**素材必须是渠道目录里的普通文件**。目录、符号链接、设备、FIFO
// 一律按"不存在"处理（404，与"未配置"同一个信封，不新增响应形态）。
//
// 同族口径与本仓其它素材加载路径一致（wasmapp/skillseed、archiveutil、appdb、
// cachetrust 全都拒符号链接）；构建期同判在 `scripts/ci-channels.sh`
// （`lstatSync(...).isFile()`）—— `cp -a` 与 `docker COPY` 都不 dereference，
// 所以只在服务端拦是"只拦一半"。
// ---------------------------------------------------------------------------

// secretMarker 是渠道目录之外那个文件的特征串：断言它**不出现在响应体里**。
// "没返回该文件内容"比"状态码不是 200"更贴近真正要保证的事 —— 拒绝路径的 JSON
// 信封也必须干净。
const secretMarker = "TOP-SECRET-OUTSIDE-CHANNEL-DIR"

// setupAssetDir 搭出"渠道目录 + 一个同级的目录外目录"。
//
// 为什么要目录外目录：符号链接的目标必须真的存在（否则测的是"悬空链接"，那是
// 另一条用例），且绝对路径与相对路径两种目标形态都要覆盖。
func setupAssetDir(t *testing.T, files map[string]string) (dir, outside string) {
	t.Helper()
	dir = t.TempDir()
	outside = t.TempDir() // 与 dir 同级：同一个用例临时根下的兄弟目录
	Dir = dir
	t.Cleanup(func() { Dir = defaultDir })
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir, outside
}

// linkAsset 在渠道目录里建一个符号链接；环境不支持（如未开开发者模式的 Windows）
// 时跳过，而不是误报红 —— 触发条件构造不出来时断言没有意义。
func linkAsset(t *testing.T, dir, name, target string) {
	t.Helper()
	if err := os.Symlink(target, filepath.Join(dir, name)); err != nil {
		t.Skipf("本环境不支持符号链接（%v）：该用例的触发条件构造不出来", err)
	}
}

// getOn 在**已构造好的**路由树上请求（用于"构造之后环境又变了"的时序用例）。
func getOn(router *gin.Engine, route string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, route, nil))
	return w
}

// assetRoutes 三个素材端点与各自的"未配置"文案。
func assetRoutes() map[string]string {
	return map[string]string{
		"/channel/logo":      "渠道未配置 logo",
		"/channel/logo-dark": "渠道未配置暗色 logo",
		"/channel/favicon":   "渠道未配置 favicon",
	}
}

// head 与 get 同形，但发 HEAD —— 生产 router 对三个素材路由**同时**注册 GET 与
// HEAD（internal/router/router.go），HEAD 走的是同一个 handler，不能成为旁路。
func head(t *testing.T, route string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	assetRouter().ServeHTTP(w, httptest.NewRequest(http.MethodHead, route, nil))
	return w
}

// 三个素材各做成指向渠道目录之外普通文件的符号链接：一律 404、不外泄字节、
// URL 也不下发。相对目标与绝对目标两种形态都要覆盖（历史绕过常只堵一种）。
func TestAssetSymlinksOutsideChannelDirAreNotServed(t *testing.T) {
	for _, form := range []string{"absolute", "relative"} {
		t.Run(form, func(t *testing.T) {
			dir, outside := setupAssetDir(t, map[string]string{"channel.json": guardJSON})
			secret := filepath.Join(outside, "outside.txt")
			if err := os.WriteFile(secret, []byte(secretMarker), 0o644); err != nil {
				t.Fatal(err)
			}
			target := secret
			if form == "relative" {
				target = filepath.Join("..", filepath.Base(outside), "outside.txt")
			}
			for _, name := range []string{"logo.svg", "logo-dark.svg", "favicon.png"} {
				linkAsset(t, dir, name, target)
			}

			// 1) 未认证端点的 HTTP 面：三个端点都必须 404 且字节不外泄。
			for route, message := range assetRoutes() {
				w := get(t, route)
				if w.Code != http.StatusNotFound {
					t.Fatalf("GET %s = %d（body=%q）：符号链接素材被下发", route, w.Code, w.Body.String())
				}
				if strings.Contains(w.Body.String(), secretMarker) {
					t.Fatalf("GET %s 的响应体泄露了渠道目录之外的文件内容：%q", route, w.Body.String())
				}
				if code, got := errorEnvelope(t, w); code != "NOT_FOUND" || got != message {
					t.Errorf("GET %s 拒绝信封 = %s/%q，want NOT_FOUND/%q", route, code, got, message)
				}
				assertAssetSecurityHeaders(t, w)
			}

			// 1b) HEAD 走同一个 handler，同样不得下发（生产路由 GET+HEAD 成对注册）。
			for route := range assetRoutes() {
				w := head(t, route)
				if w.Code != http.StatusNotFound {
					t.Fatalf("HEAD %s = %d：符号链接素材经 HEAD 被下发", route, w.Code)
				}
				if strings.Contains(w.Body.String(), secretMarker) {
					t.Fatalf("HEAD %s 的响应体泄露了渠道目录之外的文件内容：%q", route, w.Body.String())
				}
			}

			// 2) 下发内容面：素材 URL 也不该出现在 /channel 响应里 ——
			//    给客户端一个必然 404 的链接比不给更糟（omitempty 的语义）。
			resp := BuildResponse(Load())
			if resp.Login.LogoURL != "" || resp.Client.LogoURL != "" ||
				resp.Login.LogoURLDark != "" || resp.FaviconURL != "" {
				t.Errorf("符号链接素材仍被写进下发内容：login=%q client=%q dark=%q favicon=%q",
					resp.Login.LogoURL, resp.Client.LogoURL, resp.Login.LogoURLDark, resp.FaviconURL)
			}
		})
	}
}

// 指向**目录**的链接、悬空链接、以及真实目录：与"不存在"同判。
// （旧实现只排"目录本身"，链接到目录仍被判存在，随后 ServeFile 会走目录重定向/
// 目录列表那条路。）
func TestAssetSymlinkToDirectoryAndDanglingAreNotServed(t *testing.T) {
	dir, outside := setupAssetDir(t, map[string]string{"channel.json": guardJSON})
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	linkAsset(t, dir, "logo.svg", outside)                                           // 指向目录外的目录
	linkAsset(t, dir, "logo-dark.svg", filepath.Join(outside, "does-not-exist.svg")) // 悬空
	linkAsset(t, dir, "favicon.png", "sub")                                          // 指向目录内的目录
	if err := os.Mkdir(filepath.Join(dir, "plain-dir.svg"), 0o755); err != nil {     // 真实目录（非链接）
		t.Fatal(err)
	}

	for route := range assetRoutes() {
		if w := get(t, route); w.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d（body=%q）：非普通文件被当成素材", route, w.Code, w.Body.String())
		}
	}
	for _, name := range []string{"logo.svg", "logo-dark.svg", "favicon.png", "plain-dir.svg"} {
		if assetExists(name) {
			t.Errorf("assetExists(%q) = true：非普通文件必须按不存在处理", name)
		}
		if assetPath(name) != "" {
			t.Errorf("assetPath(%q) != \"\"：非普通文件不得解析成下发路径", name)
		}
	}
}

// 判据与打开之间不能有窗口：handler 在**构造期**就把路径解析成了字符串，若只在
// 那一刻判一次，启动之后把素材换成符号链接就又能读到渠道目录之外的文件（旧写法
// 每次请求都按路径重新打开）。本用例构造的正是这个时序：先建路由，再换链接。
func TestAssetSwapAfterStartupIsNotServed(t *testing.T) {
	dir, outside := setupAssetDir(t, map[string]string{
		"channel.json": guardJSON,
		"logo.svg":     cleanSVG,
	})
	secret := filepath.Join(outside, "outside.txt")
	if err := os.WriteFile(secret, []byte(secretMarker), 0o644); err != nil {
		t.Fatal(err)
	}
	router := assetRouter() // 构造期：此刻 logo.svg 是普通文件

	// 启动后把普通文件换成符号链接（同一路径），再请求。
	if err := os.Remove(filepath.Join(dir, "logo.svg")); err != nil {
		t.Fatal(err)
	}
	linkAsset(t, dir, "logo.svg", secret)

	w := getOn(router, "/channel/logo")
	if w.Code != http.StatusNotFound {
		t.Fatalf("GET /channel/logo = %d（body=%q）：素材被换成符号链接后仍被下发", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), secretMarker) {
		t.Fatalf("响应体泄露了渠道目录之外的文件内容：%q", w.Body.String())
	}

	// 同一时序下换成**目录**也必须 404（而不是目录重定向或目录列表）。
	if err := os.Remove(filepath.Join(dir, "logo.svg")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "logo.svg"), 0o755); err != nil {
		t.Fatal(err)
	}
	if w := getOn(router, "/channel/logo"); w.Code != http.StatusNotFound {
		t.Fatalf("素材被换成目录后 GET /channel/logo = %d，want 404", w.Code)
	}
}

// assetIdentityMatches 是"判据与打开是同一个对象"的谓词。
//
// 那个窗口（Lstat 之后、Open 之前被换成符号链接）在测试里没法确定性复现，但谓词
// 本身可以直接喂**真实 FileInfo** 判真假 —— 于是"去掉 os.SameFile"或"去掉
// IsRegular"这两条回退都有确定性判据。
func TestAssetIdentityMatchesRejectsSymlinkSwap(t *testing.T) {
	dir, outside := setupAssetDir(t, map[string]string{
		"channel.json": guardJSON,
		"real.svg":     cleanSVG,
	})
	secret := filepath.Join(outside, "outside.txt")
	if err := os.WriteFile(secret, []byte(secretMarker), 0o644); err != nil {
		t.Fatal(err)
	}
	linkAsset(t, dir, "link.svg", secret)

	statPath := func(path string) os.FileInfo {
		t.Helper()
		st, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		return st
	}
	statFD := func(path string) os.FileInfo {
		t.Helper()
		f, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = f.Close() })
		st, err := f.Stat()
		if err != nil {
			t.Fatal(err)
		}
		return st
	}

	// 正向：同一个普通文件的两个视角必须匹配（否则合法素材会被误拒）。
	if !assetIdentityMatches(statPath(filepath.Join(dir, "real.svg")), statFD(filepath.Join(dir, "real.svg"))) {
		t.Fatalf("同一个普通文件的两个视角被判为不同对象")
	}
	// 关键形态：Lstat 看到的是**符号链接**，fd 打开的是链接目标 ⇒ 必须不匹配。
	// （这正是"判据之后、打开之前被换成链接"的后果，服务端必须拒。）
	if assetIdentityMatches(statPath(filepath.Join(dir, "link.svg")), statFD(secret)) {
		t.Fatalf("符号链接与其目标被判为同一对象：TOCTOU 窗口失守")
	}
	// 非普通文件即使"是同一个对象"也不算素材（目录/设备/FIFO 一律拒）。
	if dirInfo := statPath(dir); assetIdentityMatches(dirInfo, dirInfo) {
		t.Fatalf("目录被判为可下发的素材")
	}
}

// 正向控制：普通文件照常 200、字节一致、URL 照常下发 —— 防止"拒符号链接"的实现
// 顺手把正常渠道也打死（回归面比缺陷面更常见）。
func TestAssetRegularFilesStillServedAndAdvertised(t *testing.T) {
	setupAssetDir(t, map[string]string{
		"channel.json":  guardJSON,
		"logo.svg":      cleanSVG,
		"logo-dark.svg": cleanSVG,
		"favicon.png":   fakePNG,
	})
	for route, want := range map[string]string{
		"/channel/logo":      cleanSVG,
		"/channel/logo-dark": cleanSVG,
		"/channel/favicon":   fakePNG,
	} {
		w := get(t, route)
		if w.Code != http.StatusOK {
			t.Fatalf("GET %s = %d（body=%q），want 200", route, w.Code, w.Body.String())
		}
		if w.Body.String() != want {
			t.Errorf("GET %s 字节与磁盘不一致", route)
		}
		assertAssetSecurityHeaders(t, w)
	}
	resp := BuildResponse(Load())
	if resp.Login.LogoURL != LogoURLPath || resp.Client.LogoURL != LogoURLPath ||
		resp.Login.LogoURLDark != LogoDarkURLPath || resp.FaviconURL != FaviconURLPath {
		t.Errorf("普通文件素材的 URL 没有照常下发：%+v", resp)
	}
	// 校准：HEAD 必须真的走通 —— 否则符号链接用例里的"HEAD 404"可能只是路由没挂
	// （gin 对未注册方法一律 404），那条断言就是假绿。
	for route := range assetRoutes() {
		if w := head(t, route); w.Code != http.StatusOK {
			t.Fatalf("HEAD %s = %d，want 200（HEAD 路由必须真的挂上）", route, w.Code)
		}
	}
}

// channel.json 自己同样必须是普通文件（W5-01 的同族）：跟随链接读配置 = 让渠道包
// 指定"读容器内哪个文件当渠道配置"，而配置字段会经**未认证**的
// /api/client/v2/channel 回显出去。非普通文件按"没有配置"处理（回落中性占位，
// 与读不到同一语义）。
func TestChannelManifestSymlinkIsIgnored(t *testing.T) {
	dir, outside := setupAssetDir(t, nil)
	const leaked = "LEAKED-CONFIG-FROM-OUTSIDE"
	evil := `{"schema":1,"channel_id":"acme","identity":{"display_name":"` + leaked + `"}}`
	secret := filepath.Join(outside, "channel.json")
	if err := os.WriteFile(secret, []byte(evil), 0o644); err != nil {
		t.Fatal(err)
	}
	linkAsset(t, dir, "channel.json", secret)
	if cfg := Load(); cfg.ChannelID == "acme" || cfg.Identity.DisplayName == leaked {
		t.Fatalf("渠道配置经符号链接被采信：%+v", cfg)
	}

	// 正向控制：同一份字节写成普通文件时必须照常被采信 ——
	// 否则上面的断言可能只是"测试根本没生效"。
	if err := os.Remove(filepath.Join(dir, "channel.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "channel.json"), []byte(evil), 0o644); err != nil {
		t.Fatal(err)
	}
	if cfg := Load(); cfg.ChannelID != "acme" || cfg.Identity.DisplayName != leaked {
		t.Fatalf("普通 channel.json 未被采信（正向控制失效）：%+v", cfg)
	}
}

// W5-04：素材 URL 不带版本，`public, max-age=86400` 会让渠道升级后的旧 logo 在
// 浏览器/Electron 会话里滞留最长一天（门户 HTML 自身是 no-store ⇒"页面是新的、
// 图是旧的"）。改为与 /channel 同口径的 no-cache：每次带 Last-Modified 重校验，
// 未变即 304（体量在 KB 量级，字节与磁盘一样便宜），升级立即生效。
func TestAssetCacheControlRevalidates(t *testing.T) {
	const want = "no-cache"
	setupAssetDir(t, map[string]string{
		"channel.json":  guardJSON,
		"logo.svg":      cleanSVG,
		"logo-dark.svg": cleanSVG,
		"favicon.png":   fakePNG,
	})
	for route := range assetRoutes() {
		w := get(t, route)
		if w.Code != http.StatusOK {
			t.Fatalf("GET %s = %d，want 200", route, w.Code)
		}
		if got := w.Header().Get("Cache-Control"); got != want {
			t.Errorf("GET %s Cache-Control = %q，want %q", route, got, want)
		}
	}
}
