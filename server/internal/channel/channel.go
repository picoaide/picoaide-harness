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
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
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
//   - **配置存在但读不出来**(非普通文件/读失败/超限/JSON 非法/缺 channel_id) ⇒
//     返回错误(2026-10 审计:旧实现把它与"目录缺失"混成同一件事,于是坏配置静默
//     回落默认 scheme)。见 manifestState 的三态说明。
//   - **配置存在但字段缺失或非法** ⇒ 返回错误,由启动期调用方拒绝启动。
//     发行镜像里这是交付事故:放行等于"服务端猜一个 scheme",而客户端注册的是渠道
//     自己配的那个 ⇒ 全部非幂等请求 403,且故障现象与配置毫无关系(排障会跑偏)。
//   - 与 `deep_link_scheme` 同值同样拒绝:两者在客户端里是两个不同的注册项,
//     同值会让"深链"与"应用页"在协议栈层面撞在一起。
//
// 用 **(值, error)** 而不是"直接返回兜底值":唯一的调用方是启动装配,
// 它必须能区分"没有配置"与"配置写错了"。
func AppOriginScheme() (string, error) {
	m := loadPresent()
	if m.state == manifestAbsent {
		return DefaultAppOriginScheme, nil
	}
	if m.state == manifestBroken {
		// 2026-10 审计(本泳道):"存在但读不出来"在**发行镜像**里是交付事故,必须
		// fail-loud —— 旧实现与"没有配置"同语义(回落默认 scheme),于是镜像里的
		// channel.json 变成符号链接/坏 JSON 时,服务端会带着**猜出来的** scheme 起来,
		// 而客户端注册的是渠道自己配的那一个 ⇒ 全部非幂等应用请求 403,且故障现象
		// 与配置毫无关系。这里把病根(路径 + 具体原因)原样交给启动装配。
		reportManifestProblem(m.err)
		return "", fmt.Errorf("渠道配置存在但不可用（%s）；"+
			"发行镜像里的渠道配置必须可读 —— 请修渠道包里的 channel.json 后重新构建镜像", m.err)
	}
	cfg := m.cfg
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
// 配置**不存在**时返回**中性**兜底值(不含任何厂商品牌),不报错:渠道目录缺失
// 意味着"镜像没带渠道配置"(本地开发构建),此时服务端仍应可用。兜底值刻意不带
// 厂商名 —— 仓库里不留任何品牌描述,一切对外文案必须来自渠道包。
//
// 配置**存在但读不出来**(非普通文件/读失败/超限/解析失败)是**另一件事**,不再与
// "没有配置"共用同一语义:返回值仍是中性兜底值(Load 没有 error 出口,调用点遍布
// 门户/登录页/客户端下发面),但会打一行结构化 ERROR 点名**路径与病根**(见
// reportManifestProblem),需要 fail-loud 的启动期路径见 AppOriginScheme。
// 缺配置的**发行镜像**属交付事故,由 CI 在构建期强制该文件存在(见 ci.yml)。
func Load() Config {
	m := loadPresent()
	if m.state == manifestBroken {
		reportManifestProblem(m.err)
	}
	return m.cfg
}

// manifestState 是渠道配置文件的三态(2026-10 审计 FW-1 泳道登记的一条)。
//
// 为什么要三态:旧实现只有"可用 / 不可用"两态(loadPresent 的 bool),于是
//
//	① **文件不存在** = 正常(本地开发构建没带渠道配置)⇒ 中性占位;
//	② **文件存在但非普通文件 / 读不了 / 超限 / 解析失败** = 交付事故 ⇒ 也走中性占位,
//	   而且**一个字都不打**。品牌渠道因此静默变回占位 "Harness"、素材静默 404,
//	   现场没有任何线索指向 channel.json(排查会先去查渠道包的构建与部署)。
//
// ② 与 ① 的区别是本次修复的全部内容:行为(回落中性值)保持,但**出声**,
// 并且启动期路径(AppOriginScheme,cmd/server 的 resolveStartupChannel 会调)
// 对 ② fail-loud。
type manifestState int

const (
	// manifestAbsent 渠道目录里没有 channel.json —— 正常(本地开发构建)。
	manifestAbsent manifestState = iota
	// manifestOK 普通文件、读得到、体量合规、解析成功且带 channel_id。
	manifestOK
	// manifestBroken **存在但不可用**:符号链接/目录/设备/FIFO、Lstat 失败(非
	// ENOENT)、读失败、超过 maxConfigBytes、JSON 非法、缺 channel_id。
	manifestBroken
)

// manifestRead 是 loadPresent 的读取结论:配置 + 三态 + 病根。
type manifestRead struct {
	cfg   Config
	state manifestState
	// err 只在 manifestBroken 时非空,文案里带**绝对路径 + 具体原因**(指到病根)。
	err error
}

// loadPresent 与 Load 同源,但额外报告"渠道配置文件的三种情形"(见 manifestState)。
//
// 存在性的意义:让 fail-loud 的边界能落在"配置写错了"而不是"没有配置"
// (见 AppOriginScheme 的注释)。
func loadPresent() manifestRead {
	// channel.json 与素材同一条规则(见 assetRegular):必须是渠道目录内的**普通
	// 文件**。渠道目录里的东西由 CI 从私有渠道仓注入,而 `cp -a` 与 `docker COPY`
	// 都保留符号链接 ⇒ 跟随链接读配置,等于让渠道包指定"读容器内哪个文件当配置",
	// 而配置字段会经**未认证**的/api/client/v2/channel 回显出去(弱读取面)。
	// 这一条判据**不放宽**;变的是它命中之后的行为:从"当作没有配置"改成"出声"。
	path := filepath.Join(Dir, "channel.json")
	st, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return manifestRead{cfg: fallback(), state: manifestAbsent}
		}
		// 目录/文件存在但连属性都读不到(权限、EIO…)—— 不是"没有配置"。
		return brokenManifest(path, fmt.Errorf("渠道配置无法读取:%w", err))
	}
	if !st.Mode().IsRegular() {
		return brokenManifest(path, fmt.Errorf(
			"渠道配置不是普通文件(%s)。`cp -a` 与 `docker COPY` 会把渠道包里的链接/目录"+
				"原样带进镜像,所以这通常是渠道仓里放了符号链接或目录;"+
				"服务端不跟随它读配置(配置字段会经未认证的 /api/client/v2/channel 回显);"+
				"实际形态 = %s",
			path, modeKind(path, st.Mode())))
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return brokenManifest(path, fmt.Errorf("渠道配置读取失败(%s):%w", path, err))
	}
	if len(raw) > maxConfigBytes {
		return brokenManifest(path, fmt.Errorf("渠道配置超过体积上限(%s:%d > %d 字节)",
			path, len(raw), maxConfigBytes))
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return brokenManifest(path, fmt.Errorf("渠道配置不是合法 JSON(%s):%w", path, err))
	}
	if cfg.ChannelID == "" {
		return brokenManifest(path, fmt.Errorf("渠道配置缺少 channel_id(%s)", path))
	}
	applyDefaults(&cfg)
	return manifestRead{cfg: cfg, state: manifestOK}
}

// brokenManifest 构造 manifestBroken 结论:配置回落中性值 + 病根待出声。
func brokenManifest(path string, err error) manifestRead {
	return manifestRead{cfg: fallback(), state: manifestBroken, err: fmt.Errorf("%s:%w", path, err)}
}

// modeKind 把文件模式翻译成一句人话(符号链接还带上目标),让日志直接指到形态。
func modeKind(path string, mode os.FileMode) string {
	switch {
	case mode&os.ModeSymlink != 0:
		if target, err := os.Readlink(path); err == nil {
			return "符号链接 → " + target
		}
		return "符号链接"
	case mode.IsDir():
		return "目录"
	case mode&os.ModeNamedPipe != 0:
		return "FIFO"
	case mode&os.ModeSocket != 0:
		return "socket"
	case mode&os.ModeDevice != 0:
		return "设备文件"
	default:
		return mode.Type().String()
	}
}

// lastManifestProblem 保存上一次已经出过声的病根文案。
//
// 为什么需要去重:Load() 在每个请求上都会被调用(门户、登录页、三个素材端点),
// 而"渠道配置坏了"是**进程级的一次性事实** —— 每次请求打一行会把日志刷爆,
// 真正的病根反而被淹没。判据取"文案变了才再打一行":同一个病根只出声一次,
// 病根换了(例如从"符号链接"变成"JSON 非法")会再出声。素材路径共用同一个去重位。
var lastManifestProblem atomic.Pointer[string]

// reportManifestProblem 把"渠道配置存在但不可用"打出去(结构化、可 grep、指到病根)。
func reportManifestProblem(err error) {
	reportProblem("渠道配置文件存在但不可用,已回落中性占位(品牌会变成占位名、素材会 404)", err)
}

// reportAssetProblem 把"素材存在但不可用"打出去(端点仍是 404,但不再静默)。
//
// 素材与配置的区别:素材缺失(未配置 logo/favicon)是**正常**的,不出声;素材
// **在盘上但不是普通文件**(符号链接/目录/FIFO)是渠道包的问题,现场表现只有
// "登录页少了一张图",没有任何线索 —— 所以出声,并把形态(含链接目标)写出来。
func reportAssetProblem(err error) {
	reportProblem("渠道素材存在但不可用,端点按未配置返回 404(界面会缺图)", err)
}

// reportProblem 是上面两条的公共实现:同一个病根只出声一次(见 lastManifestProblem)。
func reportProblem(what string, err error) {
	if err == nil {
		return
	}
	msg := err.Error()
	if prev := lastManifestProblem.Load(); prev != nil && *prev == msg {
		return
	}
	lastManifestProblem.Store(&msg)
	log.Printf("ERROR channel: %s:%s", what, msg)
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

// errNotRegularAsset 素材不是普通文件(目录/符号链接/设备/FIFO 等)。
var errNotRegularAsset = errors.New("channel: asset is not a regular file")

// assetRegular 是"这个素材可用吗"的**唯一判据**:渠道目录内的**普通文件**才算素材。
//
// 必须 Lstat(不跟随符号链接)且要求 IsRegular —— 渠道目录由 CI 从私有渠道仓注入,
// 属**不可信输入**;`os.Stat` 会跟随链接,把"渠道目录之外的任意可读文件"判成素材,
// 而三个素材端点按产品设计**未认证**(见 internal/router:登录页在未登录时就要拿
// logo)⇒ 一个符号链接就等于把容器内任意可读文件挂到了未认证端点上(2026-09-26
// 审计 W5-01 实测:三个端点全 200 且 body 是渠道目录之外文件的内容)。
//
// 目录、符号链接、设备、FIFO 一律按"不存在"处理(404,与"未配置"同一个信封)。
// 口径与本仓其它素材加载路径一致:wasmapp/skillseed、archiveutil、appdb、
// cachetrust 全都拒符号链接;构建期同判在 scripts/ci-channels.sh(lstatSync().isFile(),
// 因为 `cp -a` 与 `docker COPY` 都不 dereference —— 只在服务端拦是"只拦一半")。
//
// **"未配置"与"配了但形态不对"必须分开出声**(2026-10 审计本泳道):
//   - 名字为空 / 配置里根本没写这个素材 ⇒ 静默返回"没有素材"(正常,端点 404 是产品语义);
//   - 盘上**存在但不是普通文件**、或 Lstat 报了非 ENOENT 的错(权限/EIO/ENOTDIR) ⇒
//     同样按"没有素材"处理(HTTP 语义不变,仍然 404 —— 匿名的三个素材端点不新增响应
//     形态),但打一行结构化 ERROR 点名路径与形态。旧实现这两种情形都静默,现场表现
//     只有"登录页少了一张图",没有任何线索指向渠道包。
//
// 名字形状(必须单段、非空)也在这里收口:渠道配置被写成 `../x` 时不得越出 Dir。
func assetRegular(name string) (os.FileInfo, error) {
	if name == "" || strings.ContainsAny(name, `/\`) {
		// "没配置这个素材" / 配置里的名字非法 —— 都不是"盘上有问题",不出声。
		return nil, errNotRegularAsset
	}
	path := filepath.Join(Dir, name)
	st, err := os.Lstat(path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			reportAssetProblem(fmt.Errorf("渠道素材无法读取(%s):%w", path, err))
		}
		return nil, err
	}
	if !st.Mode().IsRegular() {
		reportAssetProblem(fmt.Errorf(
			"渠道素材不是普通文件(%s,实际形态 = %s);服务端不跟随符号链接下发素材"+
				"(三个素材端点未认证,跟随链接等于把容器内任意可读文件挂出去)",
			path, modeKind(path, st.Mode())))
		return nil, errNotRegularAsset
	}
	return st, nil
}

// assetExists 判断渠道目录里有没有可下发的素材(= assetRegular 的布尔形态)。
func assetExists(name string) bool {
	_, err := assetRegular(name)
	return err == nil
}

// openAsset 打开渠道目录内的素材文件,只接受**普通文件**;返回已打开的 fd 与它的
// 文件信息。
//
// 为什么不是"先按路径判存在、再按路径打开"(旧写法 = os.Stat + http.ServeFile):
// 两次解析路径之间文件可以被换掉。这里把判据与打开绑成**同一个对象**:
//
//  1. assetRegular 的 Lstat —— 不跟随符号链接,拒一切非普通文件;
//  2. os.Open 拿 fd;
//  3. f.Stat + os.SameFile —— 关掉"第 1 步之后、第 2 步之前被换成另一个 inode
//     (含换成符号链接)"这个窗口。
//
// 调用方此后只读这个 fd(内容检查与下发都用它),不再解析路径一次 —— 这也是
// handlers.go 用 http.ServeContent 而不是 http.ServeFile 的原因。
//
// 残留(如实记下,不假装没有):第 1 步是普通文件、第 2 步之前被换成 **FIFO** 时,
// os.Open 会阻塞到有写者。该形态要求攻击者已经能在运行中的容器里写渠道目录
// (即已经拿到服务端账户),且旧实现在同一位置暴露得更宽(任何一次请求都跟随链接),
// 因此不引入平台相关的 O_NONBLOCK 去换一个更窄的洞。
func openAsset(name string) (*os.File, os.FileInfo, error) {
	lst, err := assetRegular(name)
	if err != nil {
		return nil, nil, err
	}
	f, err := os.Open(filepath.Join(Dir, name))
	if err != nil {
		return nil, nil, err
	}
	st, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, nil, err
	}
	if !assetIdentityMatches(lst, st) {
		_ = f.Close()
		return nil, nil, errNotRegularAsset
	}
	return f, st, nil
}

// assetIdentityMatches 报告"按路径看到的东西"(Lstat,不跟随链接)与"fd 打开的东西"
// 是不是**同一个普通文件** —— "判据与打开是同一个对象"这条不变式由它收口。
//
// 为什么单拎成一个谓词:那个窗口(第 1 步之后、第 2 步之前被换成符号链接)在测试里
// 没法确定性复现,但谓词本身可以直接喂真实 FileInfo 判真假 —— 符号链接与其目标是
// **不同**对象(这正是要拒的形态),目录/设备/FIFO 即使"同一个"也不算素材。
func assetIdentityMatches(byPath, byFD os.FileInfo) bool {
	return byFD.Mode().IsRegular() && os.SameFile(byPath, byFD)
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

// assetPath 把渠道目录内的素材名解析成绝对路径。
// 不存在 / 非法名 / **不是普通文件**(目录、符号链接、FIFO…)一律返回空 ——
// 见 assetRegular:这是"素材必须在本目录内"的唯一防线,而三个素材端点未认证。
func assetPath(name string) string {
	if !assetExists(name) {
		return ""
	}
	return filepath.Join(Dir, name)
}
