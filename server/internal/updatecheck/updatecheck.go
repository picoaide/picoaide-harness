// Package updatecheck checks our own update server (Cloudflare R2 behind
// https://release.picoaide.com) for a newer stable server version.
//
// 2026-09-10 起更新源**只有** R2 静态 manifest,不再查询 GitHub Releases:
// 国内网络对 api.github.com 不可达且匿名限流(60 次/小时/IP,企业出口共用
// 一个 IP 时必然被限流),已整体弃用。manifest 格式见
// docs/planning/2026-09-10-r2-update-server-runbook.md §6。
package updatecheck

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// 渠道 id:官方(稳定)与 beta(我们自己内测)是保留渠道,其余为品牌渠道。
//
// **渠道隔离是正确性要求**:服务端只接受 channel_id 与自身渠道相等的清单 ——
// 否则品牌服务端会被官方清单升级成官方版、品牌与渠道配置丢失。
const (
	// OfficialChannel 稳定版渠道。
	OfficialChannel = "official"
	// BetaChannel 预发渠道(与官方渠道互不升级)。
	BetaChannel = "beta"
)

// DefaultEndpoint 是官方渠道的更新清单地址。
//
// 其它渠道用 DefaultEndpointFor(channel) 取自己的目录
// (如 https://release.picoaide.com/acme/latest.json)。仍保留本常量是因为
// 官方目录是唯一需要被硬编码引用的那一个(历史版本与文档都在用它)。
const DefaultEndpoint = "https://release.picoaide.com/official/latest.json"

// EndpointEnv 是覆盖更新清单地址的环境变量名。
const EndpointEnv = "PICOAI_UPDATE_ENDPOINT"

// ChannelEnv 是本服务端所属渠道的环境变量名(beta / official / 品牌 id)。
// 未设置时按端点 URL 推导(路径首段),推导不出则回落官方渠道。
const ChannelEnv = "PICOAI_CHANNEL"

// maxResponseBody caps the manifest JSON payload accepted from the service.
const maxResponseBody = 256 * 1024

// httpClientTimeout bounds the whole request (DNS + TLS + headers + body).
const httpClientTimeout = 8 * time.Second

// ErrUnavailable wraps any failure to obtain or parse the manifest so callers
// can degrade silently (nobody dies because a version check failed).
var ErrUnavailable = errors.New("version check unavailable")

// ErrNoEndpoint 表示既没有默认端点也没有配置环境变量——按"未启用更新检查"
// 处理(不是故障):本地开发构建与不接更新服务器的部署都会命中这条。
var ErrNoEndpoint = errors.New("no update endpoint configured")

// Result is one successful check against the update server.
type Result struct {
	// Current is the canonical version the server is running (may be "dev").
	Current string `json:"current"`
	// Latest is the canonical latest version published on the update server.
	Latest string `json:"latest"`
	// UpdateAvailable is true when Latest > Current (strict SemVer).
	UpdateAvailable bool `json:"update_available"`
	// ImageTag is the container tag carrying Latest (e.g. "v2.7.0"), so
	// operators and the webadmin page can show the exact upgrade target.
	ImageTag string `json:"image_tag,omitempty"`
	// ManifestURL is the endpoint that answered (support/debugging anchor).
	ManifestURL string `json:"manifest_url,omitempty"`
	// CheckedAt is the RFC3339 timestamp of the check (server time).
	CheckedAt string `json:"checked_at"`
}

// manifest 是更新服务器 latest.json 的结构(节选:只取服务端需要的字段)。
type manifest struct {
	Schema    int    `json:"schema"`
	ChannelID string `json:"channel_id"`
	Server    struct {
		Version  string `json:"version"`
		ImageTag string `json:"image_tag"`
	} `json:"server"`
	Client struct {
		Version string `json:"version"`
	} `json:"client"`
}

// Checker performs checks with an injectable client (tests use a local
// httptest server; nil uses the production client with a hard timeout).
type Checker struct {
	Client *http.Client
	// Endpoint overrides the resolved endpoint (tests).
	Endpoint string
	// ExpectedChannel 覆盖本服务端所属渠道(测试);空则用 ResolveChannel()。
	ExpectedChannel string
}

// New returns a Checker using the production timeout-bounded client.
func New() *Checker {
	return &Checker{Client: newHTTPClient()}
}

// newHTTPClient 构造生产客户端:硬超时 + **拒绝重定向**。
// 更新服务器必须直接返回 200(见 R2 手册 §3.1);默认的"跟随重定向"会把
// 配置错误伪装成成功,这里让它暴露成 ErrUnavailable。
func newHTTPClient() *http.Client {
	return &http.Client{
		Timeout: httpClientTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// resolveEndpointOverride 读取 PICOAI_UPDATE_ENDPOINT 的**显式**取值。
//
// 语义(2026-09-10 修正):**空串 = 未设置**,不是"关闭"。
// 仓库自带的 docker-compose.yml 用 `${PICOAI_UPDATE_ENDPOINT:-}` 传值,
// 未配置时容器里就是空串;旧语义把空串当"关闭更新检查",于是默认部署永远
// 不检查更新(fail-silent)。要关闭请显式写 off / none / - / disabled。
// @returns 显式端点(可能为空)与是否被显式关闭。
func resolveEndpointOverride() (endpoint string, disabled bool) {
	v, ok := os.LookupEnv(EndpointEnv)
	if !ok {
		return "", false
	}
	trimmed := strings.TrimSpace(v)
	switch strings.ToLower(trimmed) {
	case "":
		return "", false
	case "-", "off", "none", "disabled":
		return "", true
	default:
		return trimmed, false
	}
}

// DefaultEndpointFor 返回某渠道在更新服务器上的清单地址。
//
// 渠道目录就是渠道 id:`release.picoaide.com/<channel>/latest.json`。
// @param channel - 已确定的渠道 id。
// @returns 该渠道的默认清单地址。
func DefaultEndpointFor(channel string) string {
	return fmt.Sprintf("https://release.picoaide.com/%s/latest.json", channel)
}

// ResolveEndpoint 返回生效的更新清单地址。
//
// 显式覆盖优先;未覆盖时按**本部署渠道**取默认目录(渠道化部署因此默认
// 检查自己的目录,而不是官方的)。
// @param channel - 已确定的渠道 id(见 ResolveChannel)。
// @returns 清单地址;显式关闭更新检查时返回空串。
func ResolveEndpoint(channel string) string {
	if endpoint, disabled := resolveEndpointOverride(); disabled {
		return ""
	} else if endpoint != "" {
		return endpoint
	}
	return DefaultEndpointFor(channel)
}

// ChannelFile 镜像内渠道标记文件的路径。
//
// 由 Dockerfile 写入(`ARG CHANNEL` → `RUN echo "$CHANNEL" > /opt/picoaide/CHANNEL`),
// 是**镜像自带的**渠道声明:随镜像一起构建、不依赖部署时的 .env。它此前只被
// 写、从未被读,于是部署侧一个字符的笔误就能让渠道部署变成官方部署。
const ChannelFileEnv = "PICOAI_CHANNEL_FILE"

// defaultChannelFile 渠道标记文件默认位置(与 Dockerfile 一致)。
const defaultChannelFile = "/opt/picoaide/CHANNEL"

// ChannelFile 返回渠道标记文件路径(测试可改)。
var ChannelFile = func() string {
	if v := strings.TrimSpace(os.Getenv(ChannelFileEnv)); v != "" {
		return v
	}
	return defaultChannelFile
}()

// ResolveChannel 返回本部署所属渠道,以及"渠道是否可确定"。
//
// 优先级(高 → 低):
//  1. `PICOAI_CHANNEL` —— 部署侧的显式声明;
//  2. 镜像内标记文件 `/opt/picoaide/CHANNEL` —— 渠道化镜像自带,不依赖 .env;
//  3. 从 `PICOAI_UPDATE_ENDPOINT` 的路径首段推导 —— 只服务本地开发;
//  4. 都没有 → 官方渠道(本地开发)。
//
// **第二返回值为 false 表示"显式配置了渠道但无法确定"**,调用方必须 fail-loud
// (报检查不可用 / 拒绝启动),绝不能回落 official —— 那正是"渠道部署接受官方
// 清单、品牌被洗掉"这条最严重错误的入口。第 3 条被刻意排在镜像标记之后:
// 指向哪个目录就能把自己变成哪个渠道的推导是自我实现的,一旦它能覆盖镜像
// 声明,隔离校验就形同虚设。
// @returns 渠道 id 与是否可确定。
func ResolveChannel() (string, bool) {
	if v, ok := os.LookupEnv(ChannelEnv); ok {
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			// 显式设了就必须合法:拼错一个字符也不能变成官方部署。
			return trimmed, IsChannelID(trimmed)
		}
	}
	if raw, err := os.ReadFile(ChannelFile); err == nil {
		if trimmed := strings.TrimSpace(string(raw)); trimmed != "" {
			// 镜像自带的声明同样必须合法(构建参数写错时立即暴露)。
			return trimmed, IsChannelID(trimmed)
		}
	}
	if endpoint, disabled := resolveEndpointOverride(); !disabled && endpoint != "" {
		if u, err := url.Parse(endpoint); err == nil {
			// 路径形如 /<channel>/latest.json
			segments := strings.Split(strings.Trim(u.Path, "/"), "/")
			if len(segments) >= 1 && IsChannelID(segments[0]) {
				return segments[0], true
			}
		}
	}
	return OfficialChannel, true
}

// IsChannelID 报告 s 是否是合法渠道 id(小写字母/数字/连字符,1–32 位)。
// 与客户端 CHANNEL_ID_PATTERN 同源。
func IsChannelID(s string) bool {
	if len(s) == 0 || len(s) > 32 {
		return false
	}
	for i, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		case r == '-' && i > 0 && i < len(s)-1:
		default:
			return false
		}
	}
	return true
}

// CacheTTL 是缓存结果的有效期:版本检查是低频、低频变化的数据,
// 缓存 6 小时足以让"每次打开服务器信息页"都不打外网(无外网环境
// 尤其重要——首次失败后会周期性重试,而不是每次请求都卡 8 秒)。
const CacheTTL = 6 * time.Hour

// CachedChecker 包装 Checker 并缓存最近一次成功结果(TTL 内直接返回)。
// 并发安全;多个并发请求共享一次底层检查(singleflight 语义)。
type CachedChecker struct {
	inner *Checker

	mu      sync.Mutex
	cached  *Result
	checked time.Time
	done    chan struct{} // 非 nil 表示有检查在跑;close 表示完成
}

// NewCached returns a CachedChecker sharing the production client.
func NewCached() *CachedChecker {
	return &CachedChecker{inner: New()}
}

// Check 返回缓存结果(未过期)或并发触发一次真实检查。
// 缓存未命中/已过期时只有第一个调用者发起网络请求,其余等待同一个结果
// (done channel 合并);底层失败时返回错误但不缓存失败(下次重试)。
func (c *CachedChecker) Check(ctx context.Context, current string) (*Result, error) {
	c.mu.Lock()
	if c.cached != nil && time.Since(c.checked) < CacheTTL {
		res := *c.cached
		c.mu.Unlock()
		return &res, nil
	}
	if c.done != nil {
		// 已有并发检查在跑:等待它完成(最多 12s,覆盖底层 8s 超时)。
		wait := c.done
		c.mu.Unlock()
		select {
		case <-wait:
			c.mu.Lock()
			res := c.cached // 并发检查失败时 cached 保持旧值(nil 或过期前值)
			c.mu.Unlock()
			if res == nil {
				return nil, fmt.Errorf("%w: concurrent check failed", ErrUnavailable)
			}
			out := *res
			return &out, nil
		case <-time.After(12 * time.Second):
			return nil, fmt.Errorf("%w: concurrent check timed out", ErrUnavailable)
		}
	}
	done := make(chan struct{})
	c.done = done
	c.mu.Unlock()

	res, err := c.inner.Check(ctx, current)

	c.mu.Lock()
	if err == nil {
		c.cached = res
		c.checked = time.Now()
	}
	c.done = nil
	close(done)
	c.mu.Unlock()
	return res, err
}

// Check queries the update manifest and compares it against current.
// current is the running server version; a non-SemVer value such as "dev"
// is reported as not updated (local builds should not nag operators).
func (c *Checker) Check(ctx context.Context, current string) (*Result, error) {
	// 渠道先定,端点再按渠道取其默认目录 —— 渠道化部署因此默认检查自己的
	// 目录,而不是官方的。
	expected := c.ExpectedChannel
	if expected == "" {
		resolved, ok := ResolveChannel()
		if !ok {
			// 显式配置了渠道却无法解析:这是配置错误,必须让人看见。
			// 回落 official 会让渠道部署接受官方清单并把品牌洗掉。
			return nil, fmt.Errorf("%w: 渠道配置非法(%s=%q,镜像标记文件 %s)",
				ErrUnavailable, ChannelEnv, os.Getenv(ChannelEnv), ChannelFile)
		}
		expected = resolved
	}
	endpoint := c.Endpoint
	if endpoint == "" {
		endpoint = ResolveEndpoint(expected)
	}
	if endpoint == "" {
		return nil, ErrNoEndpoint
	}
	client := c.Client
	if client == nil {
		client = newHTTPClient()
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// 3xx 不会走到这里(Go 客户端默认跟随重定向,除非超过上限),但
		// 更新服务器前置任何跳转都属于配置错误,显式提示便于定位。
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			return nil, fmt.Errorf("%w: update server redirected (http %d) — 检查 URL 必须直接返回 200", ErrUnavailable, resp.StatusCode)
		}
		return nil, fmt.Errorf("%w: http %d", ErrUnavailable, resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBody+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if len(body) > maxResponseBody {
		return nil, fmt.Errorf("%w: response too large", ErrUnavailable)
	}

	var payload manifest
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	// 渠道隔离:清单声明的渠道必须与本服务端所属渠道一致。
	// 不匹配一律当作"检查不可用"(而不是"无更新"):这通常意味着端点配置
	// 指向了别的渠道目录,必须让人看见并修,绝不能静默跨渠道升级。
	if payload.ChannelID == "" {
		return nil, fmt.Errorf("%w: manifest has no channel_id", ErrUnavailable)
	}
	if payload.ChannelID != expected {
		return nil, fmt.Errorf("%w: manifest channel %q != this server's channel %q",
			ErrUnavailable, payload.ChannelID, expected)
	}

	// 版本号用完整 SemVer 解析(接受 2.7.0-rc.1 这类预发布):发布渠道过去
	// 用 GitHub Releases 的 latest 端点天然排除预发布,现在由"谁写了
	// latest.json"决定——写预发布进去就是预发布渠道。
	latest := NormalizeVersion(payload.Server.Version)
	if latest == "" {
		return nil, fmt.Errorf("%w: invalid server.version %q", ErrUnavailable, payload.Server.Version)
	}

	res := &Result{
		Current:     current,
		Latest:      latest,
		ImageTag:    payload.Server.ImageTag,
		ManifestURL: endpoint,
		CheckedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	// 版本比较按 core(M.m.p)判断是否需要升级;预发布只影响目标版本展示。
	//
	// FIX-23(审计 2026-09-12,P1):此前这里用 ParseCanonicalStableValid(current),
	// 而它**拒绝一切预发布**(IsStableSemVer 见到 "-" 即为 false)。于是当服务端
	// 自己就是预发布版本时 ok=false,UpdateAvailable 永远是 false ——
	// beta 渠道的"有新版本"提示永久失效。审计实测:
	//
	//	cur=2.7.2-beta.7, latest=2.8.0 → UpdateAvailable=false
	//	cur=v2.7.1(稳定版对照)        → true
	//
	// CI 的 VERSION 取 github.ref_name(→ Dockerfile → main.version →
	// SetBuildVersion → Check),所以 beta/official 渠道跑的**就是**预发布
	// 版本号 —— 这不是边缘情况,是常规发布状态。
	//
	// 改用 NormalizeVersion(接受预发布),比较走 CompareSemVer 的完整
	// SemVer 优先级(core + 预发布段):
	//   - 2.7.2-beta.7 → 2.8.0        : core 2.7.2 < 2.8.0 → true(正确提示)
	//   - 2.7.2-beta.7 → 2.7.2-beta.8 : core 相等,beta.8 > beta.7 → true
	//   - 2.7.2-beta.7 → 2.7.2        : 有预发布 < 无预发布   → true(转正)
	//   - 2.7.2        → 2.7.2-beta.8 : 稳定版 > 同 core 预发布 → false
	//   - 2.7.1        → 2.7.1        : 完全相等             → false
	//   - 2.8.0        → 2.7.2-beta.7 : 更旧                 → false(不提示降级)
	// 解析不出来(本地 dev 构建的 "dev" 等)仍保持 false:版本号不可比时
	// **不提示**是安全方向(否则开发机会变成"永远可升级")。
	if cur := NormalizeVersion(current); cur != "" {
		res.UpdateAvailable = CompareSemVer(latest, cur) > 0
	}
	return res, nil
}

// ParseCanonicalStable parses a canonical stable SemVer with an optional
// lowercase "v" prefix; the prefix is stripped. Prerelease/build versions
// are rejected.
func ParseCanonicalStable(tag string) string {
	v := strings.TrimPrefix(tag, "v")
	if !IsStableSemVer(v) {
		return ""
	}
	return v
}

// ParseCanonicalStableValid is ParseCanonicalStable with a validity signal.
func ParseCanonicalStableValid(v string) (string, bool) {
	canonical := ParseCanonicalStable(v)
	return canonical, canonical != ""
}

// IsStableSemVer reports whether v is strict stable SemVer (M.m.p).
func IsStableSemVer(v string) bool {
	// prerelease present → not stable(在任何其它校验之前判定,避免与
	// normalizeCore 的剥离顺序产生分歧)
	if strings.Contains(strings.TrimPrefix(strings.TrimSpace(v), "v"), "-") {
		return false
	}
	return normalizeCore(v) != ""
}

// NormalizeVersion 把 manifest 里的版本号规范化为"无 v 前缀"的完整 SemVer
// (可含预发布段,如 2.7.0-rc.1);非法返回空串。
func NormalizeVersion(v string) string {
	v = strings.TrimSpace(v)
	trimmed := strings.TrimPrefix(v, "v")
	if !IsSemVer(trimmed) {
		return ""
	}
	return trimmed
}

// IsSemVer reports whether v is SemVer 2.0.0 (M.m.p with optional
// -prerelease and +build). "v" prefix is NOT accepted here.
func IsSemVer(v string) bool {
	// v 前缀由 NormalizeVersion 负责剥离;这里严格要求无前缀,
	// 否则 "v2.5.1" 会被 normalizeCore 悄悄放行,契约与实现不一致。
	if v == "" || strings.HasPrefix(v, "v") {
		return false
	}
	// 拆出 build metadata 与 prerelease
	core := v
	if i := strings.IndexByte(core, '+'); i >= 0 {
		build := core[i+1:]
		if build == "" || !isDotSeparatedIdentifiers(build, true) {
			return false
		}
		core = core[:i]
	}
	if i := strings.IndexByte(core, '-'); i >= 0 {
		pre := core[i+1:]
		if pre == "" || !isDotSeparatedIdentifiers(pre, false) {
			return false
		}
		core = core[:i]
	}
	return normalizeCore(core) != ""
}

// isDotSeparatedIdentifiers 校验 prerelease/build 的点分段标识符。
// allowLeadingZero 为 true 时(build)允许纯数字带前导零。
func isDotSeparatedIdentifiers(s string, allowLeadingZero bool) bool {
	for _, part := range strings.Split(s, ".") {
		if part == "" {
			return false
		}
		for _, r := range part {
			switch {
			case r >= '0' && r <= '9', r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r == '-':
			default:
				return false
			}
		}
		if !allowLeadingZero && isNumeric(part) && len(part) > 1 && part[0] == '0' {
			return false
		}
	}
	return true
}

// normalizeCore 校验并返回 M.m.p 核心段;非法返回空串。
func normalizeCore(v string) string {
	core := v
	if i := strings.IndexByte(core, '+'); i >= 0 {
		core = core[:i]
	}
	core = strings.TrimPrefix(core, "v")
	if i := strings.IndexByte(core, '-'); i >= 0 {
		core = core[:i]
	}
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return ""
	}
	for _, p := range parts {
		if !isNumeric(p) || (len(p) > 1 && p[0] == '0') {
			return ""
		}
	}
	return core
}

func isNumeric(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// CompareSemVer returns -1/0/1 for left vs right using full SemVer 2.0.0
// precedence: core M.m.p 按数值比较(build metadata 忽略),core 相等时再比较
// 预发布段 —— 无预发布优先级更高(= 稳定版 > 同 core 预发布),预发布标识符
// 按 §11 逐段比较(纯数字按数值、字母数字按 ASCII、数字 < 字母、段数多者更大)。
//
// FIX-23-r3(审计 2026-09-13,P1):上一轮 FIX-23 只把 Check 的准入从
// ParseCanonicalStableValid 换成 NormalizeVersion(接受预发布),比较本身仍是
// **core-only**,于是 beta 渠道最常见的升级形态 ——
//
//	CompareSemVer("2.7.2-beta.8", "2.7.2-beta.7") == 0  ⇒ 永不提示更新
//
// —— 让预发布当前版本能提示跨 core 升级,却提示不了同 core 的下一次预发布。
// 预发布段必须参与比较。
//
// 稳定版之间的行为逐条不变:仍只由 core 决定(2.5.1 vs 2.6.0 = -1);
// 非法输入(dev 等)仍视为相等(0)—— 版本号不可比时"不提示"是安全方向。
func CompareSemVer(left, right string) int {
	lv, lok := parseVersionPrecedence(left)
	rv, rok := parseVersionPrecedence(right)
	if !lok || !rok {
		return 0
	}
	if c := compareCoreSegments(lv.core, rv.core); c != 0 {
		return c
	}
	return comparePrerelease(lv.pre, rv.pre)
}

// versionPrecedence 是参与优先级比较的两个部分:core 三段 + 预发布段原文。
type versionPrecedence struct {
	core [3]string
	pre  string
}

// parseVersionPrecedence 解析版本号(容忍 v 前缀与 build metadata)。
func parseVersionPrecedence(v string) (versionPrecedence, bool) {
	var out versionPrecedence
	core, ok := parseCore(v)
	if !ok {
		return out, false
	}
	out.core = core
	out.pre = prereleaseOf(v)
	return out, true
}

// prereleaseOf 取出版本号的预发布段(去掉 v 前缀与 build metadata);无预发布
// 返回空串(空串在比较里代表"稳定版",优先级最高)。
func prereleaseOf(v string) string {
	s := strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexByte(s, '+'); i >= 0 {
		s = s[:i]
	}
	if i := strings.IndexByte(s, '-'); i >= 0 {
		return s[i+1:]
	}
	return ""
}

// compareCoreSegments 比较 M.m.p 三段:先比位数再比字典序 = 无溢出的数值比较
// (原有语义,保持逐字节不变)。
func compareCoreSegments(l, r [3]string) int {
	for i := 0; i < 3; i++ {
		a, b := l[i], r[i]
		if len(a) != len(b) {
			if len(a) < len(b) {
				return -1
			}
			return 1
		}
		if a != b {
			if a < b {
				return -1
			}
			return 1
		}
	}
	return 0
}

// comparePrerelease 按 SemVer 2.0.0 §11.3/§11.4 比较预发布段。空串 = 无预发布
// (= 稳定版),优先级**高于**同 core 的任何预发布。
func comparePrerelease(l, r string) int {
	switch {
	case l == "" && r == "":
		return 0
	case l == "":
		return 1
	case r == "":
		return -1
	}
	lp, rp := strings.Split(l, "."), strings.Split(r, ".")
	for i := 0; i < len(lp) && i < len(rp); i++ {
		if c := comparePrereleaseIdentifier(lp[i], rp[i]); c != 0 {
			return c
		}
	}
	// 前缀全相等:段数多者更大(beta.1 > beta)。
	switch {
	case len(lp) < len(rp):
		return -1
	case len(lp) > len(rp):
		return 1
	}
	return 0
}

// comparePrereleaseIdentifier 比较单个预发布标识符:
//   - 纯数字按数值比较(用"位数 + 字典序"实现,避免整数溢出,beta.1000 > beta.999);
//   - 纯数字 < 字母数字(beta.2 < beta.alpha);
//   - 其它按 ASCII 字典序(beta < rc;alpha < beta)。
func comparePrereleaseIdentifier(a, b string) int {
	an, bn := isNumeric(a), isNumeric(b)
	switch {
	case an && bn:
		if len(a) != len(b) {
			if len(a) < len(b) {
				return -1
			}
			return 1
		}
	case an:
		return -1
	case bn:
		return 1
	}
	if a == b {
		return 0
	}
	if a < b {
		return -1
	}
	return 1
}

// parseCore 解析版本的核心 M.m.p 三段(容忍 v 前缀与预发布/build 段),
// 返回三段的原始字符串以支持无损数值比较。
func parseCore(v string) ([3]string, bool) {
	var out [3]string
	core := normalizeCore(v)
	if core == "" {
		return out, false
	}
	parts := strings.Split(core, ".")
	copy(out[:], parts)
	return out, true
}
