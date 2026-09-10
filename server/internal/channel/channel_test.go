package channel

import (
	"os"
	"path/filepath"
	"testing"
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
	if resp.FaviconURL != "/api/client/v2/channel/logo" {
		t.Errorf("favicon_url = %q", resp.FaviconURL)
	}
}

func TestBuildResponseOmitsMissingLogo(t *testing.T) {
	withDir(t, map[string]string{"channel.json": officialJSON}) // 目录里没有 logo 文件
	resp := BuildResponse(Load())
	if resp.Login.LogoURL != "" || resp.FaviconURL != "" {
		t.Fatalf("文件不存在时不该给 URL: logo=%q favicon=%q", resp.Login.LogoURL, resp.FaviconURL)
	}
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
