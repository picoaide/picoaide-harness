// Package channel 读取并下发本部署所属渠道的对外内容。
//
// 2026-09-10 起,原来那套"运行时品牌"被渠道配置取代:
//
//   - 内容的唯一来源是镜像内的渠道目录 /opt/picoaide/channel/
//     (构建时由 CI 从仓库 channels/<channel-id>/ 复制进来)。
//   - 没有上传接口、没有快照、没有开关:改内容 = 改渠道配置 → 重新构建镜像,
//     因此内容始终可审计、可追溯,也不会出现"某人改了线上品牌没人知道"。
//   - 客户端登录页、客户端界面、服务端门户读的都是**同一份**渠道内容。
//
// 渠道 id 与配置里的 channel_id 必须一致(updatecheck 也据此校验升级渠道,
// 见 internal/updatecheck 的渠道隔离)。
package channel

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// DirEnv 渠道目录在镜像内的位置(可由 Dockerfile 覆盖)。
const DirEnv = "PICOAI_CHANNEL_DIR"

// defaultDir 渠道目录默认位置。
const defaultDir = "/opt/picoaide/channel"

// maxConfigBytes 配置体积上限(防御异常文件)。
const maxConfigBytes = 64 * 1024

// Config 渠道配置(镜像内 channel.json 的结构)。
type Config struct {
	Schema    int    `json:"schema"`
	ChannelID string `json:"channel_id"`
	Identity  struct {
		DisplayName string `json:"display_name"`
		ShortName   string `json:"short_name"`
		Tagline     string `json:"tagline"`
		Title       string `json:"title"`
	} `json:"identity"`
	Copy struct {
		LoginDisplayName  string `json:"login_display_name"`
		LoginTagline      string `json:"login_tagline"`
		LoginWelcome      string `json:"login_welcome"`
		ClientDisplayName string `json:"client_display_name"`
		ClientTagline     string `json:"client_tagline"`
		PortalWelcome     string `json:"portal_welcome"`
	} `json:"copy"`
	Assets struct {
		Logo     string `json:"logo"`
		LogoDark string `json:"logo_dark"`
		Favicon  string `json:"favicon"`
		Accent   string `json:"accent"`
	} `json:"assets"`
	// Desktop 是随包分发给**客户端**的那部分渠道配置。服务端只读其中一项:
	// OIDC 回调要拼的深链 scheme —— 它必须与客户端注册/解析的 scheme 一致。
	Desktop struct {
		DeepLinkScheme string `json:"deep_link_scheme"`
	} `json:"desktop"`
}

// DefaultDeepLinkScheme 未配置时的深链 scheme(= 改造前的硬编码值)。
const DefaultDeepLinkScheme = "picoaide"

// deepLinkSchemePattern 与客户端 desktop-channel.ts 的校验同源(RFC 3986 scheme)。
var deepLinkSchemePattern = regexp.MustCompile(`^[a-z][a-z0-9+.-]{1,31}$`)

// DeepLinkScheme 返回本渠道客户端使用的深链 scheme。
//
// 浏览器从 IdP 回调跳回客户端时会弹出"打开 <scheme>?"的确认框 —— 渠道客户
// 不该在这里看到厂商名,所以渠道构建必须用自己的 scheme。**三处必须一致**:
// 客户端打包时的 protocols(scripts/channel-build.ts)、客户端解析
// (desktop-channel.ts)、以及本处服务端回调拼串。形状不合法时回落官方值:
// 一个畸形 scheme 会让浏览器回调彻底打不开客户端。
func DeepLinkScheme() string {
	scheme := strings.TrimSpace(Load().Desktop.DeepLinkScheme)
	if !ValidDeepLinkScheme(scheme) {
		return DefaultDeepLinkScheme
	}
	return scheme
}

// ValidDeepLinkScheme 报告 s 是否是合法的深链 scheme 形状(RFC 3986 scheme:
// 与客户端 desktop-channel.ts 的校验同源)。启动期校验与运行时回落共用它。
func ValidDeepLinkScheme(s string) bool {
	return deepLinkSchemePattern.MatchString(strings.TrimSpace(s))
}

// Dir 渠道目录(测试可改)。
var Dir = func() string {
	if v := os.Getenv(DirEnv); v != "" {
		return v
	}
	return defaultDir
}()

// Load 读取渠道配置。
//
// 配置缺失或损坏时返回**中性**兜底值(不含任何厂商品牌),而不是报错:渠道目录
// 缺失意味着"镜像没带渠道配置"(本地开发构建),此时服务端仍应可用。
// 兜底值刻意不带厂商名 —— 仓库里不留任何品牌描述,一切对外文案必须来自渠道包;
// 缺配置的**发行镜像**属交付事故,由 CI 在构建期强制该文件存在(见 ci.yml),
// 启动期另有一致性校验(见 cmd/server 的 resolveStartupChannel)。
func Load() Config {
	raw, err := os.ReadFile(filepath.Join(Dir, "channel.json"))
	if err != nil || len(raw) > maxConfigBytes {
		return fallback()
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil || cfg.ChannelID == "" {
		return fallback()
	}
	applyDefaults(&cfg)
	return cfg
}

// fallbackBrandName 渠道配置缺失时的中性占位(刻意不含厂商品牌)。
const fallbackBrandName = "Harness"

func fallback() Config {
	cfg := Config{Schema: 1, ChannelID: "official"}
	cfg.Identity.DisplayName = fallbackBrandName
	cfg.Identity.ShortName = fallbackBrandName
	cfg.Identity.Title = fallbackBrandName
	cfg.Copy.LoginDisplayName = fallbackBrandName
	cfg.Copy.ClientDisplayName = fallbackBrandName
	cfg.Assets.Accent = "#2563eb"
	return cfg
}

// applyDefaults 补齐空字段(渠道配置允许省略,省略时用官方值)。
func applyDefaults(cfg *Config) {
	def := fallback()
	setIfEmpty(&cfg.Identity.DisplayName, def.Identity.DisplayName)
	setIfEmpty(&cfg.Identity.ShortName, def.Identity.ShortName)
	setIfEmpty(&cfg.Identity.Title, cfg.Identity.DisplayName)
	setIfEmpty(&cfg.Copy.LoginDisplayName, cfg.Identity.ShortName)
	setIfEmpty(&cfg.Copy.ClientDisplayName, cfg.Identity.DisplayName)
	setIfEmpty(&cfg.Assets.Accent, def.Assets.Accent)
	// 标语/欢迎语允许为空(不强制显示),不做兜底。
}

func setIfEmpty(dst *string, v string) {
	if strings.TrimSpace(*dst) == "" {
		*dst = v
	}
}

// Response 是 GET /api/client/v2/channel 的响应体。
// 字段名与客户端消费方(enterprise 的 channel-sync)对齐。
//
// 字段全部 omitempty:客户端的契约是"缺字段 = 不采纳" —— 素材没配时给一个
// 会 404 的链接比不给更糟(登录页会显示破图)。
type Response struct {
	ChannelID string `json:"channel_id"`
	Title     string `json:"title"`
	Login     struct {
		DisplayName string `json:"display_name"`
		Tagline     string `json:"tagline"`
		Welcome     string `json:"welcome"`
		// LogoURL 浅色 logo(登录页背景是亮色)。
		LogoURL string `json:"logo_url,omitempty"`
		// LogoURLDark 暗色 logo;仅渠道配置了 assets.logo_dark 时才下发。
		LogoURLDark string `json:"logo_url_dark,omitempty"`
	} `json:"login"`
	Client struct {
		DisplayName string `json:"display_name"`
		Tagline     string `json:"tagline"`
		// LogoURL 客户端界面用的浅色 logo(客户端读的就是这个字段)。
		LogoURL string `json:"logo_url,omitempty"`
	} `json:"client"`
	FaviconURL string `json:"favicon_url,omitempty"`
	Accent     string `json:"accent,omitempty"`
}

// 素材下发地址(相对路径;客户端按自己的 serverURL 绝对化)。
// 三个端点各发各的字节 —— 曾被合并成一个(logo 端点恒发浅色 logo),
// 导致 favicon 与暗色 logo 永远下发不了。
const (
	// LogoURLPath 浅色 logo。
	LogoURLPath = "/api/client/v2/channel/logo"
	// LogoDarkURLPath 暗色 logo。
	LogoDarkURLPath = "/api/client/v2/channel/logo-dark"
	// FaviconURLPath 站点图标。
	FaviconURLPath = "/api/client/v2/channel/favicon"
)

// BuildResponse 由渠道配置构造下发内容。
// 每项 URL 只在**渠道目录里真有对应文件**时才给(避免 404 的图片链接)。
func BuildResponse(cfg Config) Response {
	var r Response
	r.ChannelID = cfg.ChannelID
	r.Title = cfg.Identity.Title
	r.Login.DisplayName = cfg.Copy.LoginDisplayName
	r.Login.Tagline = cfg.Copy.LoginTagline
	r.Login.Welcome = cfg.Copy.LoginWelcome
	r.Client.DisplayName = cfg.Copy.ClientDisplayName
	r.Client.Tagline = cfg.Copy.ClientTagline
	r.Accent = cfg.Assets.Accent
	if assetPath(cfg.Assets.Logo) != "" {
		r.Login.LogoURL = LogoURLPath
		r.Client.LogoURL = LogoURLPath
	}
	if assetPath(cfg.Assets.LogoDark) != "" {
		r.Login.LogoURLDark = LogoDarkURLPath
	}
	if assetPath(cfg.Assets.Favicon) != "" {
		r.FaviconURL = FaviconURLPath
	}
	return r
}

// assetExists 判断渠道目录里的素材文件是否存在且非目录。
func assetExists(name string) bool {
	if strings.ContainsAny(name, `/\`) || name == "" {
		return false
	}
	st, err := os.Stat(filepath.Join(Dir, name))
	return err == nil && !st.IsDir()
}

// LogoPath 返回要下发的 logo 文件的绝对路径(不存在则返回空)。
// 暗色场景优先 logo_dark(客户端按主题二选一,这里给浅色版:门户与登录页
// 背景都是亮色,深色版留给客户端界面自行处理)。
func LogoPath(dark bool) string {
	cfg := Load()
	name := cfg.Assets.Logo
	if dark && cfg.Assets.LogoDark != "" {
		name = cfg.Assets.LogoDark
	}
	return assetPath(name)
}

// LogoDarkPath 返回暗色版 logo 的绝对路径;渠道未配置 logo_dark 时返回空
// (不回落浅色版 —— 端点语义就是"暗色版",没做暗色版的渠道该 404)。
func LogoDarkPath() string { return assetPath(Load().Assets.LogoDark) }

// FaviconPath 返回站点图标(favicon)的绝对路径;未配置或文件不存在时返回空。
func FaviconPath() string { return assetPath(Load().Assets.Favicon) }

// assetPath 把渠道目录内的素材名解析成绝对路径(不存在/非法名返回空)。
func assetPath(name string) string {
	if !assetExists(name) {
		return ""
	}
	return filepath.Join(Dir, name)
}
