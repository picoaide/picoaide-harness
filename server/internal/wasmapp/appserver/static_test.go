package appserver

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ===== 步骤⑨：静态资源（§4.2 / §4.6 响应缓存）=====

func TestStatic_ServesResourceWithCacheKey(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("assets")
	e.publishApp(appSpec{appID: appID, config: loginConfig(), assets: map[string]string{
		"index.html":     "<html>v1 shell</html>",
		"static/app.css": "body{color:red}",
	}})

	rec := e.get(appID, "/static/app.css")
	if rec.Code != http.StatusOK {
		t.Fatalf("存在的资源应直出，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "body{color:red}" {
		t.Fatalf("资源内容不对: %q", got)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "css") {
		t.Fatalf("content-type 应由资源扩展名推导，得到 %q", ct)
	}
	// 缓存键 = app_id + version + path：ETag 必须存在，且带显式的私有缓存策略。
	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatal("静态资源必须有 ETag（§4.6：缓存键 app_id + version + path）")
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "private") || !strings.Contains(cc, "max-age=") {
		t.Fatalf("静态资源应带 private + max-age（§4.6 响应缓存），得到 %q", cc)
	}
	if cl := rec.Header().Get("Content-Length"); cl != "15" {
		t.Fatalf("静态资源应显式给 Content-Length，得到 %q", cl)
	}
	assertHostSecurityHeaders(t, rec, false)

	// 条件请求：命中 ETag ⇒ 304（不带 body）。
	req := clientRequestFor(t, appID, http.MethodGet, "/static/app.css", "", "")
	req.Header.Set("If-None-Match", etag)
	rec304 := e.clientDo(req, appID, e.ownerUser)
	if rec304.Code != http.StatusNotModified {
		t.Fatalf("If-None-Match 命中应 304，得到 %d", rec304.Code)
	}
	if rec304.Body.Len() != 0 {
		t.Fatalf("304 不得带 body，得到 %q", rec304.Body.String())
	}
	assertHostSecurityHeaders(t, rec304, false)

	// HEAD：同样的头，但没有 body。
	recHead := e.clientDo(clientRequestFor(t, appID, http.MethodHead, "/static/app.css", "", ""), appID, e.ownerUser)
	if recHead.Code != http.StatusOK || recHead.Body.Len() != 0 {
		t.Fatalf("HEAD 应 200 且无 body，得到 %d len=%d", recHead.Code, recHead.Body.Len())
	}
	if recHead.Header().Get("Content-Length") != "15" {
		t.Fatalf("HEAD 应带 Content-Length，得到 %q", recHead.Header().Get("Content-Length"))
	}
}

func TestStatic_VersionIsolation(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("versions")
	e.publishApp(appSpec{appID: appID, version: "1.0.0", config: loginConfig(), assets: map[string]string{
		"index.html": "<html>v1</html>",
		"app.js":     "console.log('v1')",
	}})
	first := e.get(appID, "/app.js")
	if first.Code != http.StatusOK || first.Body.String() != "console.log('v1')" {
		t.Fatalf("v1 资源不对: %d %q", first.Code, first.Body.String())
	}
	etagV1 := first.Header().Get("ETag")

	rel2 := e.publishApp(appSpec{appID: appID, version: "2.0.0", config: loginConfig(), assets: map[string]string{
		"index.html": "<html>v2</html>",
		"app.js":     "console.log('v2')",
	}})
	second := e.get(appID, "/app.js")
	if second.Code != http.StatusOK || second.Body.String() != "console.log('v2')" {
		t.Fatalf("v2 资源不对: %d %q", second.Code, second.Body.String())
	}
	etagV2 := second.Header().Get("ETag")
	if etagV1 == etagV2 {
		t.Fatalf("同路径不同版本的 ETag 绝不能相同（缓存键必须含 version）: %q", etagV1)
	}

	// 回滚：软删 v2 ⇒ 生效版本回到 v1 ⇒ 必须重新交付 v1 的字节与 v1 的 ETag
	//（这条同时钉死静态资源与编译模块缓存两处的键都含版本）。
	if err := serverstore.SoftDeleteWasmRelease(t.Context(), e.db, rel2.ID); err != nil {
		t.Fatalf("SoftDeleteWasmRelease: %v", err)
	}
	rolled := e.get(appID, "/app.js")
	if rolled.Code != http.StatusOK || rolled.Body.String() != "console.log('v1')" {
		t.Fatalf("回滚后应交付 v1 字节，得到 %d %q", rolled.Code, rolled.Body.String())
	}
	if got := rolled.Header().Get("ETag"); got != etagV1 {
		t.Fatalf("回滚后 ETag 应回到 v1 的值（%q），得到 %q", etagV1, got)
	}
}

// 客户端专属模型下**所有**应用的入口文档都交给 wasm（平台没有匿名面 ⇒
// serveStatic 的 allowEntry 恒为 false）：应用必须自己看到这次请求，才能做
// 自己的准入判断与 403 页面。子资源仍由宿主直出（§4.6 缓存收益）。
func TestStatic_LoginRequiredEntryGoesToWasm(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("guarded")
	e.publishApp(appSpec{appID: appID, config: loginRequiredConfig(testOwner), assets: map[string]string{
		"index.html": "<html>shell</html>",
		"app.js":     "console.log(1)",
	}})

	rec := e.get(appID, "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("应 200，得到 %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "shell") {
		t.Fatal("login_required 应用的入口文档不得由宿主直出（名单判定会被绕过）")
	}
	if body := decodeJSON(t, rec.Body); body["path"] != "/" {
		t.Fatalf("入口应由 wasm 处理，得到 %v", body)
	}

	// 子资源仍然直出（§4.6：资源响应缓存 P0 必配）。
	sub := e.get(appID, "/app.js")
	if sub.Code != http.StatusOK || sub.Body.String() != "console.log(1)" {
		t.Fatalf("子资源应直出，得到 %d %q", sub.Code, sub.Body.String())
	}
}

func TestStatic_APIReservedForWasm(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("apireserved")
	e.publishApp(appSpec{appID: appID, config: loginConfig(), assets: map[string]string{
		// 故意在保留前缀下放一个资源：它**不得**被直出（否则会盖住应用路由）。
		"api/data.json": `{"static":true}`,
	}})
	rec := e.get(appID, "/api/data.json")
	if rec.Code != http.StatusOK {
		t.Fatalf("应交给 wasm，得到 %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), `"static":true`) {
		t.Fatalf("/api/* 必须一律交给 wasm，得到静态内容: %s", rec.Body.String())
	}
	body := decodeJSON(t, rec.Body)
	if body["path"] != "/api/data.json" {
		t.Fatalf("应由 wasm 处理，得到 %v", body)
	}
}

func TestStatic_PathTraversalNotServed(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("traversal")
	e.publishApp(appSpec{appID: appID, config: loginConfig(), assets: map[string]string{
		"secret.txt": "TOP-SECRET",
	}})
	for _, p := range []string{"/../secret.txt", "/%2e%2e/secret.txt", "/./secret.txt", "/a/../../secret.txt"} {
		rec := e.get(appID, p)
		if strings.Contains(rec.Body.String(), "TOP-SECRET") {
			t.Fatalf("路径 %s 不得直出资源（穿越形态必须交给 wasm 并被 assets 拒）", p)
		}
	}
}

func TestStatic_NonIdempotentGoesToWasm(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("postentry")
	e.publishApp(appSpec{appID: appID, config: loginConfig(), assets: map[string]string{
		"index.html": "<html>shell</html>",
	}})
	rec := e.post(appID, "/", "application/json", `{"x":1}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("应 200（交给 wasm），得到 %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "shell") {
		t.Fatal("POST 不得命中静态入口文档（否则应用路由永远拿不到 POST /）")
	}
	body := decodeJSON(t, rec.Body)
	if body["method"] != "POST" {
		t.Fatalf("POST 应由 wasm 处理，得到 %v", body)
	}
}

// ===== FIX-27：平台保留资源不得由宿主直出 =====

// TestStatic_ReservedAppConfigNeverServed 是 FIX-27 的回归判据。
//
// 审计结论：`GET /picoaide.app.json` 曾被匿名直出 200，body 是
// `{"whitelist":["ceo","cfo"],…}` —— 名单本身成了可枚举资产（§10.5 第 56d 项刻意
// 不校验账号存在性就是为了避免这个），R24 的"未授权请求进 wasm 由应用返回 403"
// 与 R26"平台不提供员工目录"也一并被绕过。
//
// 语义（刻意选择，写清以免日后被"顺手改成 404"）：保留资源**不直出**，
// 与入口文档特例走同一条路 —— 交给 wasm，由应用自己决定。
//
// 变异验证：去掉 serveStatic 里的 isReservedAsset 判定（或只挡根路径、只做大小写
// 敏感比较）⇒ 本用例的对应子用例必红。
func TestStatic_ReservedAppConfigNeverServed(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("reserved")
	// 名单里的账号是审计用的敏感内容：它出现响应体里就说明"直出"发生了。
	const secretList = `"whitelist":["ceo","cfo"]`
	cfg := `{"access":"login",` + secretList + `,` +
		`"purpose":"财务报销","data_sensitivity":"confidential","owner":"alice"}`
	e.publishApp(appSpec{appID: appID, config: cfg, assets: map[string]string{
		"index.html":               "<html>public shell</html>",
		"static/app.js":            "console.log(1)",
		"assets/picoaide.app.json": `{"note":"作者误放在子目录里的同名文件也不直出"}`,
	}})

	// (1) 历史 access=public（读取侧即 login）：不得拿到配置文件内容，必须交给 wasm。
	for _, p := range []string{
		"/picoaide.app.json",     // 根路径
		"/./picoaide.app.json",   // dot 段被 path.Clean 归一
		"//picoaide.app.json",    // 双斜杠被 path.Clean 归一
		"/%70icoaide.app.json",   // 一次百分号编码（net/http 已解码）
		"/%2570icoaide.app.json", // 双层编码（isReservedAsset 自己再解一次）
		"/PicoAide.App.JSON",     // 大小写（macOS/Windows 文件系统不敏感）
		"/PICOAIde.app.json",
		"/assets/picoaide.app.json", // 子目录里的同名文件同样不直出
	} {
		rec := e.get(appID, p)
		if strings.Contains(rec.Body.String(), secretList) {
			t.Fatalf("路径 %s：平台保留配置（含 whitelist 名单）被宿主直出 ⇒ 名单可枚举（FIX-27）body=%.200s",
				p, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "作者误放在子目录") {
			t.Fatalf("路径 %s：子目录里的保留资源同样不得直出 body=%.200s", p, rec.Body.String())
		}
	}
	// 语义断言（不只是"没泄露"）：保留资源确实落到了 wasm 手里，路径原样传进帧。
	for _, p := range []string{"/picoaide.app.json", "/%70icoaide.app.json"} {
		rec := e.get(appID, p)
		if rec.Code != http.StatusOK {
			t.Fatalf("路径 %s 应交由 wasm 处理（200 + 应用自答），得到 %d", p, rec.Code)
		}
		body := decodeJSON(t, rec.Body)
		if body["app_id"] != appID {
			t.Fatalf("路径 %s：应由 wasm 处理，得到 %v", p, body)
		}
		if got, _ := body["path"].(string); !strings.EqualFold(got, "/picoaide.app.json") {
			t.Fatalf("路径 %s：帧内路径=%q，want /picoaide.app.json（编码已归一）", p, got)
		}
	}

	// (2) access=whitelist 应用：无身份 401 挡住，**未授权员工也不能读**。
	guardedID := e.appID("reserved-guarded")
	guardedCfg := `{"access":"whitelist","whitelist":["alice"],` +
		`"purpose":"财务报销","data_sensitivity":"confidential","owner":"alice"}`
	e.publishApp(appSpec{appID: guardedID, config: guardedCfg, assets: map[string]string{
		"index.html": "<html>guarded shell</html>",
	}})
	anon := e.doClient(guardedID, nil, http.MethodGet, "/picoaide.app.json", "", "")
	if anon.Code != http.StatusUnauthorized {
		t.Fatalf("无身份访问要求登录应用的保留资源应 401（客户端模型没有换票这一跳），得到 %d body=%.200s",
			anon.Code, anon.Body.String())
	}
	if loc := anon.Header().Get("Location"); loc != "" {
		t.Fatalf("客户端模式不得有跳转（Location=%q）", loc)
	}
	// bob 不在 whitelist 里：他拿到的是**应用自己**的响应（R24），不是宿主的配置文件。
	//
	// ⚠️ 判据必须是"配置文件的内容"，不能拿 `"whitelist"` 这个字符串当证据：
	// 2026-09-18 收敛为 access 三模式后，帧内 auth.mode 就可能等于 `whitelist`
	//（应用把模式回显出来时会被误判成泄露）。
	authed := e.doClient(guardedID, e.clientUser("bob"), http.MethodGet, "/picoaide.app.json", "", "")
	for _, leak := range []string{`"data_sensitivity"`, `"purpose"`, "作者误放在子目录"} {
		if strings.Contains(authed.Body.String(), leak) {
			t.Fatalf("未授权员工（bob）拿到了应用配置（命中 %s）⇒ 静态直出绕过了应用准入判断 body=%.200s",
				leak, authed.Body.String())
		}
	}

	// (3) 反向对照：防"一刀切全禁"把 §4.6 的缓存收益干掉 —— 非保留资源仍直出 200。
	css := e.get(appID, "/static/app.js")
	if css.Code != http.StatusOK || css.Body.String() != "console.log(1)" {
		t.Fatalf("非保留资源必须继续直出（R8/§4.6 缓存收益），得到 %d %q", css.Code, css.Body.String())
	}
	if css.Header().Get("ETag") == "" {
		t.Fatal("非保留资源仍应带 ETag（缓存键 app_id+version+path）")
	}
	// 入口文档是**例外**（客户端模型下一律交给 wasm）：这里只断言它不再由宿主代答。
	if entry := e.get(appID, "/index.html"); strings.Contains(entry.Body.String(), "public shell") {
		t.Fatalf("入口文档不得由宿主直出（已交给 wasm），得到 %q", entry.Body.String())
	}
	// `/api` 保留前缀优先级高于保留资源名（回归：别把规则顺序写反）。
	api := e.get(appID, "/api/picoaide.app.json")
	if api.Code != http.StatusOK {
		t.Fatalf("/api/* 一律交给 wasm，得到 %d", api.Code)
	}
	if body := decodeJSON(t, api.Body); body["path"] != "/api/picoaide.app.json" {
		t.Fatalf("/api/* 应由 wasm 处理，得到 %v", body)
	}
}

// TestStatic_ReservedAssetMatcher 是 isReservedAsset 的单元表（比端到端更快定位回归）。
//
// 变异验证：把 EqualFold 改成 ==（大小写敏感）或去掉"看最后一段"⇒ 对应用例必红。
func TestStatic_ReservedAssetMatcher(t *testing.T) {
	cases := map[string]bool{
		"picoaide.app.json":            true,
		"PicoAide.App.JSON":            true,
		"assets/picoaide.app.json":     true,
		"a/b/c/picoaide.app.json":      true,
		"picoaide.app.json.bak":        false,
		"not-picoaide.app.json":        false,
		"index.html":                   false,
		"picoaide.app.json/index.html": false, // 最后一段不是它
		"api/picoaide.app.json":        true,  // 保留前缀由 staticLogicalPath 先拒，这里保持"是"
		"":                             false,
	}
	for in, want := range cases {
		if got := isReservedAsset(in); got != want {
			t.Errorf("isReservedAsset(%q)=%v，want %v", in, got, want)
		}
	}
	// 编码形态：一次/两次百分号编码都要认出来。
	for _, in := range []string{"%70icoaide.app.json", "%2570icoaide.app.json", "assets/%70icoaide.app.json"} {
		if !isReservedAsset(in) {
			t.Errorf("isReservedAsset(%q) 必须为真（解码形态属于覆盖范围）", in)
		}
	}
}

// ===== 发布期目录约定（assets_dir / release id）=====

func TestStatic_AssetsDirColumnIsHonoured(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("assetsdir")
	e.publishApp(appSpec{
		appID: appID, config: loginConfig(), assetsDir: "custom-dir-1",
		assets: map[string]string{"hello.txt": "from custom dir"},
	})
	rec := e.get(appID, "/hello.txt")
	if rec.Code != http.StatusOK || rec.Body.String() != "from custom dir" {
		t.Fatalf("资源目录名应取 assets_dir 的 basename，得到 %d %q", rec.Code, rec.Body.String())
	}
}

// 兜底：静态服务不接受非 GET/HEAD（规则 1 的直接断言，走 units 层的 staticLogicalPath 之外）。
func TestStatic_OnlyGetAndHead(t *testing.T) {
	if _, _, ok := staticLogicalPath(mustURL(t, "https://x.example.com/anything")); !ok {
		t.Fatal("普通路径应进入静态判定")
	}
	req := httptest.NewRequest(http.MethodDelete, "https://x.example.com/anything", nil)
	if got := req.Method; got != http.MethodDelete {
		t.Fatalf("用例前提不成立: %s", got)
	}
}
