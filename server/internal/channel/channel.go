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
	"fmt"
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
	// Desktop 是随包分发给**客户端**的那部分渠道配置。服务端读其中两项:
	// 深链 scheme(OIDC 回调拼串)与**应用 origin scheme**(客户端专属访问模型里
	// 应用页的 origin,见下)。
	Desktop struct {
		DeepLinkScheme string `json:"deep_link_scheme"`
		// AppOriginScheme 是应用页在客户端里的 origin scheme(2026-09-19 契约 §10)。
		//
		// 为什么服务端必须知道它:客户端协议 handler 把 `picoaide-app://<app_id>/…`
		// 上的请求转成平台信封,平台要用**同一个** scheme 组装"自身源"做跨源写判据,
		// 并对信封里的 host 做逐字符校验。两端 scheme 不一致 ⇒ 所有非幂等请求 403。
		AppOriginScheme string `json:"app_origin_scheme"`
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

// DefaultAppOriginScheme 是**没有渠道配置**(本地开发)时应用页 origin 的 scheme。
//
// 取值 = 官方渠道的 `desktop.app_origin_scheme`,也是改造前 appserver.ClientScheme
// 的硬编码值 —— 逐字节相同,所以"没带渠道配置的本地构建"行为不变。
const DefaultAppOriginScheme = "picoaide-app"

// appOriginSchemePattern 与客户端(open-app.ts / browser guard)及 CI 的校验同源。
//
// 形状与 deepLinkSchemePattern 逐字一致(`^[a-z][a-z0-9+.-]{1,31}$`,即总长 2..32):
// 两端各写一份正则就会漂移,而漂移的后果是"服务端拒绝、客户端照发"(所有非幂等请求
// 403)或反过来(写入一个浏览器拒绝注册的 scheme)。审计 R1-SRV-9 / CHN-15:
// **长度上界是 32 不是无界** —— RFC 3986 没有上界,但 Chromium 的
// registerSchemesAsPrivileged 与 OS 协议注册都有,所以这里冻结成与深链同一个形状。
var appOriginSchemePattern = deepLinkSchemePattern

// ReservedAppOriginSchemes 是契约 §10 **冻结**的保留 scheme 名单（有序）。
//
// 这是**跨端对拍的唯一真源**（CTL-5 / 接缝 J11）：CI 的渠道校验、客户端
// （desktop-channel.ts / open-app.ts）与本包必须引用同一个集合，任何一处多一个少
// 一个都会造成"某个渠道能构建、客户端却注册不了"（反过来是"服务端拒绝启动"）。
//
// 名单取值直接来自 §10 原文：`http/https/file/data/javascript/about`。
// **不要**在这里加"我觉得也该拦"的项 —— 加在这里就等于改了对外契约；
// 服务端自己的额外加固见 ExtraReservedAppOriginSchemes 的注释（两者刻意分开）。
var ReservedAppOriginSchemes = []string{
	"http", "https", "file", "data", "javascript", "about",
}

// ExtraReservedAppOriginSchemes 是**服务端侧的额外加固**（不是契约的一部分）。
//
// 这些是 Chromium/OS 自己占用或语义特殊的 scheme：拿它们当应用 origin 的后果不是
// "不好看"而是"整个客户端坏掉"（`chrome-extension` 无法由应用注册、`blob`/`ws(s)`
// 有内建语义、`mailto`/`tel` 是外部处理器）。服务端在这里**更严**是安全方向：
//
//   - 危险方向 = 服务端接受一个客户端注册不了的 scheme（⇒ 全部非幂等请求 403，
//     且故障与配置看不出关系）—— 本集合把这类值挡在启动期；
//   - 反向代价 = 某渠道配了这里的值，CI 不拦而服务端拒绝启动：**fail-loud 且可诊断**
//     （启动日志点名 scheme），由渠道配置修掉即可。
//
// 对拍纪律：`TestReservedAppOriginSchemeContract` 断言 §10 的六项与客户端/CI 的
// 冻结集合逐字一致，并断言本集合与它**不相交**（否则"唯一真源"就名不副实）。
var ExtraReservedAppOriginSchemes = []string{
	"blob", "ws", "wss", "ftp", "chrome", "chrome-extension", "mailto", "tel",
}

// reservedAppOriginSchemes 是上面两个集合的合并查询视图（由它们派生，不手写）。
var reservedAppOriginSchemes = func() map[string]struct{} {
	m := make(map[string]struct{}, len(ReservedAppOriginSchemes)+len(ExtraReservedAppOriginSchemes))
	for _, s := range ReservedAppOriginSchemes {
		m[s] = struct{}{}
	}
	for _, s := range ExtraReservedAppOriginSchemes {
		m[s] = struct{}{}
	}
	return m
}()

// ValidAppOriginScheme 报告 s 是否是合法的应用 origin scheme(形状 + 保留名单)。
func ValidAppOriginScheme(s string) bool {
	scheme := strings.TrimSpace(s)
	if !appOriginSchemePattern.MatchString(scheme) {
		return false
	}
	_, reserved := reservedAppOriginSchemes[scheme]
	return !reserved
}

// AppOriginScheme 返回本渠道应用页 origin 的 scheme(契约 §10「唯一合法 scheme」)。
//
// fail-loud 边界(R1-OPS-4/CHN-6 订正,**不要放宽**):
//   - **渠道目录/文件缺失** ⇒ 中性 fallback `DefaultAppOriginScheme`,不报错。
//     渠道配置缺失只意味着"镜像没带渠道配置"(本地开发构建),此时服务端仍应可用
//     —— 与 Load() 的既有约定完全一致。
//   - **配置存在但字段缺失或非法** ⇒ 返回错误,由启动期调用方拒绝启动。
//     发行镜像里这是交付事故:放行等于"服务端猜一个 scheme",而客户端注册的是渠道
//     自己配的那个 ⇒ 全部非幂等请求 403,且故障现象与配置毫无关系(排障会跑偏)。
//   - 与 `deep_link_scheme` 同值同样拒绝:两者在客户端里是两个不同的注册项,
//     同值会让"深链"与"应用页"在协议栈层面撞在一起。
//
// 用 **(值, error)** 而不是"直接返回兜底值":唯一的调用方是启动装配,
// 它必须能区分"没有配置"与"配置写错了"。
func AppOriginScheme() (string, error) {
	cfg, present := loadPresent()
	if !present {
		return DefaultAppOriginScheme, nil
	}
	scheme := strings.TrimSpace(cfg.Desktop.AppOriginScheme)
	if scheme == "" {
		return "", fmt.Errorf("渠道配置 %s 缺少 desktop.app_origin_scheme（全部渠道必填；"+
			"official/beta 取 %q）", filepath.Join(Dir, "channel.json"), DefaultAppOriginScheme)
	}
	if !ValidAppOriginScheme(scheme) {
		return "", fmt.Errorf("渠道配置的 desktop.app_origin_scheme %q 非法（须匹配 ^[a-z][a-z0-9+.-]{1,31}$ 且不是保留协议）", scheme)
	}
	if link := strings.TrimSpace(cfg.Desktop.DeepLinkScheme); link != "" && link == scheme {
		return "", fmt.Errorf("渠道配置的 desktop.app_origin_scheme 不得与 desktop.deep_link_scheme 同值（都是 %q）", scheme)
	}
	return scheme, nil
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
	cfg, _ := loadPresent()
	return cfg
}

// loadPresent 与 Load 同源,但额外报告"渠道配置文件是否**存在且可解析**"。
//
// 存在的意义只有一个:让 fail-loud 的边界能落在"配置写错了"而不是"没有配置"
// (见 AppOriginScheme 的注释)。解析失败按"不存在"处理 —— Load 的既有约定是
// 坏配置回落中性值,这里不改变它。
func loadPresent() (Config, bool) {
	raw, err := os.ReadFile(filepath.Join(Dir, "channel.json"))
	if err != nil || len(raw) > maxConfigBytes {
		return fallback(), false
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil || cfg.ChannelID == "" {
		return fallback(), false
	}
	applyDefaults(&cfg)
	return cfg, true
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
// dark=true 且渠道配了 logo_dark 时给暗色版,否则给浅色版。
//
// 别拿"门户背景是亮色"当作默认发浅色版的理由:门户跟随系统深浅色
// (prefers-color-scheme),由模板里的 <picture><source media=...> 在
// 本端点与 LogoDarkPath 之间二选一 —— 服务端不知道访客用哪个主题。
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
