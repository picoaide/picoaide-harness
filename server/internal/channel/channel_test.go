package channel

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// withDir 用临时目录充当镜像内的渠道目录。
func withDir(t *testing.T, files map[string]string) {
	t.Helper()
	Dir = t.TempDir()
	t.Cleanup(func() { Dir = defaultDir })
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(Dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

const officialJSON = `{
  "schema": 1,
  "channel_id": "official",
  "identity": {"display_name": "示例科技 AI 平台", "short_name": "示例科技", "tagline": "企业级 AI 办公智能体平台", "title": "示例科技 AI 平台"},
  "copy": {
    "login_display_name": "示例科技",
    "login_tagline": "企业级 AI 办公智能体平台",
    "login_welcome": "欢迎使用",
    "client_display_name": "示例科技 AI 助手",
    "client_tagline": "内网智能体",
    "portal_welcome": "统一接入企业内网 AI 能力。"
  },
  "assets": {"logo": "logo.svg", "logo_dark": "logo-dark.svg", "favicon": "logo.svg", "accent": "#123456"}
}`

func TestLoadReadsChannelConfig(t *testing.T) {
	withDir(t, map[string]string{"channel.json": officialJSON, "logo.svg": "<svg/>", "logo-dark.svg": "<svg/>"})
	cfg := Load()

	if cfg.ChannelID != "official" {
		t.Errorf("channel_id = %q", cfg.ChannelID)
	}
	if cfg.Identity.DisplayName != "示例科技 AI 平台" {
		t.Errorf("display_name = %q", cfg.Identity.DisplayName)
	}
	if cfg.Copy.PortalWelcome != "统一接入企业内网 AI 能力。" {
		t.Errorf("portal_welcome = %q", cfg.Copy.PortalWelcome)
	}
	if cfg.Assets.Accent != "#123456" {
		t.Errorf("accent = %q", cfg.Assets.Accent)
	}
}

// 渠道目录缺失(本地构建未带渠道配置)时必须回落内置值,而不是报错/空名称。
func TestLoadFallsBackWhenMissingOrBroken(t *testing.T) {
	withDir(t, nil) // 目录存在但无 channel.json
	if cfg := Load(); cfg.Identity.DisplayName == "" || cfg.ChannelID == "" {
		t.Fatalf("缺失配置时未回落: %+v", cfg)
	}

	withDir(t, map[string]string{"channel.json": "{ not json"})
	if cfg := Load(); cfg.Identity.DisplayName == "" {
		t.Fatalf("损坏配置时未回落: %+v", cfg)
	}

	withDir(t, map[string]string{"channel.json": `{"schema":1}`}) // 无 channel_id
	if cfg := Load(); cfg.Identity.DisplayName == "" {
		t.Fatalf("无 channel_id 时未回落: %+v", cfg)
	}
}

// 省略字段时按官方值补齐(渠道配置允许只写差异)。
func TestLoadAppliesDefaults(t *testing.T) {
	withDir(t, map[string]string{"channel.json": `{"schema":1,"channel_id":"acme",
      "identity":{"display_name":"Acme AI"}}`})
	cfg := Load()
	if cfg.Identity.Title != "Acme AI" {
		t.Errorf("title 未从 display_name 派生: %q", cfg.Identity.Title)
	}
	if cfg.Copy.LoginDisplayName == "" || cfg.Copy.ClientDisplayName == "" {
		t.Errorf("copy 未补齐: %+v", cfg.Copy)
	}
}

// 下发内容:logo_url 只在渠道目录里真有文件时才给(避免 404 图片链接)。
func TestBuildResponseLogoOnlyWhenAssetExists(t *testing.T) {
	withDir(t, map[string]string{"channel.json": officialJSON, "logo.svg": "<svg/>"})
	resp := BuildResponse(Load())

	if resp.ChannelID != "official" || resp.Title != "示例科技 AI 平台" {
		t.Errorf("channel/title = %q/%q", resp.ChannelID, resp.Title)
	}
	if resp.Login.DisplayName != "示例科技" || resp.Client.DisplayName != "示例科技 AI 助手" {
		t.Errorf("login/client 名称 = %q/%q", resp.Login.DisplayName, resp.Client.DisplayName)
	}
	if resp.Accent != "#123456" {
		t.Errorf("accent = %q", resp.Accent)
	}
	// 相对路径:客户端按自己的 serverURL 绝对化(沿用旧契约)
	if resp.Login.LogoURL != "/api/client/v2/channel/logo" {
		t.Errorf("logo_url = %q", resp.Login.LogoURL)
	}
	// 渠道配置里的 favicon 指向 logo.svg(文件存在)→ 走 favicon 端点,
	// 而不是旧的"favicon_url 也指向 /channel/logo"(那样字节是浅色 logo)。
	if resp.FaviconURL != "/api/client/v2/channel/favicon" {
		t.Errorf("favicon_url = %q", resp.FaviconURL)
	}
	if resp.Client.LogoURL != "/api/client/v2/channel/logo" {
		t.Errorf("client.logo_url = %q", resp.Client.LogoURL)
	}
}

func TestBuildResponseOmitsMissingLogo(t *testing.T) {
	withDir(t, map[string]string{"channel.json": officialJSON}) // 目录里没有 logo 文件
	resp := BuildResponse(Load())
	if resp.Login.LogoURL != "" || resp.FaviconURL != "" {
		t.Fatalf("文件不存在时不该给 URL: logo=%q favicon=%q", resp.Login.LogoURL, resp.FaviconURL)
	}
}

// ---- 缺陷 3 回归(2026-09-10):favicon/暗色 logo 的字节永远下发不了 ----
//
// 旧实现里 logo_url 与 favicon_url **都**指向 /api/client/v2/channel/logo,
// 而该 handler 恒取浅色版(LogoPath(false));LogoPath(true) 与素材 favicon
// 都没有任何调用方。响应里也没有 client.logo_url —— 客户端读它恒 undefined。
// 修法:三个独立端点(logo / logo-dark / favicon)+ 响应按"素材是否配置"下发。

// threeAssetsJSON 三套素材齐全的渠道配置。
const threeAssetsJSON = `{
  "schema": 1,
  "channel_id": "acme",
  "identity": {"display_name": "Acme AI"},
  "assets": {"logo": "logo.svg", "logo_dark": "logo-dark.svg", "favicon": "favicon.svg"}
}`

// jsonKeys 把响应体序列化后取顶层/嵌套键(验证 omitempty 契约)。
func marshalResponse(t *testing.T, resp Response) map[string]any {
	t.Helper()
	raw, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// nest 取嵌套对象(login/client)。
func nest(t *testing.T, body map[string]any, key string) map[string]any {
	t.Helper()
	m, _ := body[key].(map[string]any)
	if m == nil {
		t.Fatalf("响应缺少 %s 段: %v", key, body)
	}
	return m
}

// 三套素材齐全:四个字段各自指向**正确**的端点(这是缺陷的核心断言)。
func TestBuildResponseSeparatesLogoDarkFaviconAndClientLogo(t *testing.T) {
	withDir(t, map[string]string{
		"channel.json": threeAssetsJSON,
		"logo.svg":     "L", "logo-dark.svg": "D", "favicon.svg": "F",
	})
	resp := BuildResponse(Load())
	if resp.Login.LogoURL != LogoURLPath {
		t.Errorf("login.logo_url = %q, want %q", resp.Login.LogoURL, LogoURLPath)
	}
	if resp.Login.LogoURLDark != LogoDarkURLPath {
		t.Errorf("login.logo_url_dark = %q, want %q", resp.Login.LogoURLDark, LogoDarkURLPath)
	}
	if resp.FaviconURL != FaviconURLPath {
		t.Errorf("favicon_url = %q, want %q", resp.FaviconURL, FaviconURLPath)
	}
	if resp.Client.LogoURL != LogoURLPath {
		t.Errorf("client.logo_url = %q, want %q(客户端读的就是它)", resp.Client.LogoURL, LogoURLPath)
	}

	body := marshalResponse(t, resp)
	login := nest(t, body, "login")
	client := nest(t, body, "client")
	for key, want := range map[string]string{
		"logo_url": LogoURLPath, "logo_url_dark": LogoDarkURLPath,
	} {
		if login[key] != want {
			t.Errorf("JSON login.%s = %v, want %q", key, login[key], want)
		}
	}
	if client["logo_url"] != LogoURLPath {
		t.Errorf("JSON client.logo_url = %v, want %q", client["logo_url"], LogoURLPath)
	}
	if body["favicon_url"] != FaviconURLPath {
		t.Errorf("JSON favicon_url = %v, want %q", body["favicon_url"], FaviconURLPath)
	}
}

// 只配 logo:暗色版与 favicon 字段必须整个缺失(客户端"缺字段=不采纳")。
func TestBuildResponseOmitsUnconfiguredDarkAndFavicon(t *testing.T) {
	withDir(t, map[string]string{
		"channel.json": `{"schema":1,"channel_id":"acme","identity":{"display_name":"Acme AI"},
          "assets":{"logo":"logo.svg","logo_dark":"logo-dark.svg","favicon":"favicon.svg"}}`,
		"logo.svg": "L", // 只放了浅色 logo 文件
	})
	resp := BuildResponse(Load())
	if resp.Login.LogoURL != LogoURLPath || resp.Client.LogoURL != LogoURLPath {
		t.Errorf("浅色 logo 应可用: login=%q client=%q", resp.Login.LogoURL, resp.Client.LogoURL)
	}
	if resp.Login.LogoURLDark != "" || resp.FaviconURL != "" {
		t.Errorf("文件缺失时不得给 URL: dark=%q favicon=%q", resp.Login.LogoURLDark, resp.FaviconURL)
	}

	body := marshalResponse(t, resp)
	login := nest(t, body, "login")
	if _, ok := login["logo_url_dark"]; ok {
		t.Errorf("未配置 logo_dark 时 JSON 不该有 login.logo_url_dark: %v", login)
	}
	if _, ok := body["favicon_url"]; ok {
		t.Errorf("未配置 favicon 时 JSON 不该有 favicon_url: %v", body)
	}
}

// 什么都没配:字段全缺(而不是给出会 404 的链接),端点一律 404 JSON 信封。
func TestBuildResponseWithoutAnyAsset(t *testing.T) {
	withDir(t, map[string]string{"channel.json": `{"schema":1,"channel_id":"acme","identity":{"display_name":"Acme AI"}}`})
	resp := BuildResponse(Load())
	if resp.Login.LogoURL != "" || resp.Login.LogoURLDark != "" || resp.FaviconURL != "" || resp.Client.LogoURL != "" {
		t.Fatalf("未配置素材时字段必须全缺: %+v", resp)
	}
	body := marshalResponse(t, resp)
	for _, key := range []string{"favicon_url"} {
		if _, ok := body[key]; ok {
			t.Errorf("JSON 不该有 %s: %v", key, body)
		}
	}
	login := nest(t, body, "login")
	for _, key := range []string{"logo_url", "logo_url_dark"} {
		if _, ok := login[key]; ok {
			t.Errorf("JSON login 不该有 %s: %v", key, login)
		}
	}
	if _, ok := nest(t, body, "client")["logo_url"]; ok {
		t.Errorf("JSON client 不该有 logo_url: %v", body)
	}

	// 三个端点都必须 404 JSON 信封(与既有 logo 行为一致)。
	for _, path := range []string{"/channel/logo", "/channel/logo-dark", "/channel/favicon"} {
		w := httptest.NewRecorder()
		assetRouter().ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404", path, w.Code)
		}
		if !strings.Contains(w.Body.String(), `"error"`) {
			t.Errorf("GET %s 非 JSON 错误信封: %s", path, w.Body.String())
		}
	}
}

// 端点按素材各自下发**正确的字节**(缺陷的核心:字节必须真的能下发)。
func TestAssetEndpointsServeTheirOwnBytes(t *testing.T) {
	withDir(t, map[string]string{
		"channel.json": threeAssetsJSON,
		"logo.svg":     "LIGHT", "logo-dark.svg": "DARK", "favicon.svg": "ICON",
	})
	r := assetRouter()

	cases := []struct{ path, want string }{
		{"/channel/logo", "LIGHT"},
		{"/channel/logo-dark", "DARK"},
		{"/channel/favicon", "ICON"},
	}
	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, tc.path, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("GET %s = %d, want 200", tc.path, w.Code)
			}
			if w.Body.String() != tc.want {
				t.Fatalf("GET %s body = %q, want %q", tc.path, w.Body.String(), tc.want)
			}
		})
	}
}

// 只配 logo(无 logo_dark/favicon)时:只有 logo 端点可用。
func TestAssetEndpointsWithoutDarkAndFavicon(t *testing.T) {
	withDir(t, map[string]string{
		"channel.json": `{"schema":1,"channel_id":"acme","identity":{"display_name":"Acme AI"},
          "assets":{"logo":"logo.svg"}}`,
		"logo.svg": "LIGHT",
	})
	r := assetRouter()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/channel/logo", nil))
	if w.Code != http.StatusOK || w.Body.String() != "LIGHT" {
		t.Fatalf("logo = %d %q", w.Code, w.Body.String())
	}
	for _, path := range []string{"/channel/logo-dark", "/channel/favicon"} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404", path, w.Code)
		}
	}
}

// assetRouter 用渠道 handler 自建路由树(生产路径在 internal/router 声明,
// 这里按同一模板挂,验证 handler 行为)。
func assetRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	h := NewHandlers()
	r := gin.New()
	r.GET("/channel/logo", h.Logo)
	r.GET("/channel/logo-dark", h.LogoDark)
	r.GET("/channel/favicon", h.Favicon)
	return r
}

// 素材名含路径分隔符时必须拒绝(防御渠道配置被写成路径穿越)。
func TestAssetNameRejectsTraversal(t *testing.T) {
	withDir(t, map[string]string{"channel.json": officialJSON})
	for _, bad := range []string{"../secret", "a/b.svg", `..\x`, ""} {
		if assetExists(bad) {
			t.Errorf("assetExists(%q) = true, want false", bad)
		}
	}
}

func TestLogoPathPicksDarkVariant(t *testing.T) {
	withDir(t, map[string]string{"channel.json": officialJSON, "logo.svg": "L", "logo-dark.svg": "D"})
	if got := LogoPath(false); filepath.Base(got) != "logo.svg" {
		t.Errorf("LogoPath(false) = %q", got)
	}
	if got := LogoPath(true); filepath.Base(got) != "logo-dark.svg" {
		t.Errorf("LogoPath(true) = %q", got)
	}
}

// ---- 深链 scheme（OIDC 回调跳回客户端用的那个）----
//
// 浏览器从 IdP 回调跳回客户端时会弹"打开 <scheme>?"的确认框 —— 渠道客户不该
// 在这里看到厂商名。三处必须一致：客户端打包时的 protocols、客户端解析
// (desktop-channel.ts)、以及服务端这里拼串。

func TestDeepLinkSchemeFollowsChannel(t *testing.T) {
	withDir(t, map[string]string{"channel.json": `{
      "schema": 1, "channel_id": "acme",
      "identity": {"display_name": "Acme AI"},
      "desktop": {"deep_link_scheme": "acmeai"}
    }`})
	if got := DeepLinkScheme(); got != "acmeai" {
		t.Fatalf("DeepLinkScheme() = %q, want acmeai", got)
	}
}

func TestDeepLinkSchemeDefaultsToOfficial(t *testing.T) {
	// 渠道配置没写这一项 → 官方值（行为与改造前完全一致）。
	withDir(t, map[string]string{"channel.json": officialJSON})
	if got := DeepLinkScheme(); got != DefaultDeepLinkScheme {
		t.Fatalf("DeepLinkScheme() = %q, want %q", got, DefaultDeepLinkScheme)
	}
	// 渠道目录整个缺失（本地开发）同样回落官方值。
	withDir(t, nil)
	if got := DeepLinkScheme(); got != DefaultDeepLinkScheme {
		t.Fatalf("DeepLinkScheme() with no config = %q, want %q", got, DefaultDeepLinkScheme)
	}
}

func TestDeepLinkSchemeRejectsMalformed(t *testing.T) {
	// 畸形 scheme 会让浏览器回调彻底打不开客户端；回落官方值至少还能用。
	for _, bad := range []string{"ACME", "acme ai", "1acme", "-acme", ""} {
		withDir(t, map[string]string{"channel.json": `{
          "schema": 1, "channel_id": "acme",
          "desktop": {"deep_link_scheme": "` + bad + `"}
        }`})
		if got := DeepLinkScheme(); got != DefaultDeepLinkScheme {
			t.Fatalf("DeepLinkScheme() with %q = %q, want %q", bad, got, DefaultDeepLinkScheme)
		}
	}
}
