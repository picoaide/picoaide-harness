// Package updatecheck checks the public GitHub Releases API for a newer
// stable server version, mirroring the desktop client logic
// (packages/host/desktop/src/update-checker.ts) so both surfaces agree on
// the same release source and the same strict SemVer comparison rules.
package updatecheck

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ReleaseRepository is the GitHub repository owning public releases.
const ReleaseRepository = "picoaide/picoaide-harness"

// VersionEndpoint is the public endpoint returning the latest stable release.
const VersionEndpoint = "https://api.github.com/repos/" + ReleaseRepository + "/releases/latest"

// maxResponseBody caps the release JSON payload accepted from the service
// (mirrors the desktop client MAX_VERSION_RESPONSE_BYTES).
const maxResponseBody = 256 * 1024

// httpClientTimeout bounds the whole request (DNS + TLS + headers + body).
const httpClientTimeout = 8 * time.Second

// ErrUnavailable wraps any failure to obtain or parse the release info so
// callers can degrade silently (nobody dies because a version check failed).
var ErrUnavailable = errors.New("version check unavailable")

// Result is one successful check against the release service.
type Result struct {
	// Current is the canonical version the server is running (may be "dev").
	Current string `json:"current"`
	// Latest is the canonical latest stable release version.
	Latest string `json:"latest"`
	// UpdateAvailable is true when Latest > Current (strict SemVer).
	UpdateAvailable bool `json:"update_available"`
	// ReleaseURL links to the GitHub release page for operators.
	ReleaseURL string `json:"release_url"`
	// CheckedAt is the RFC3339 timestamp of the check (server time).
	CheckedAt string `json:"checked_at"`
}

// Checker performs checks with an injectable client (tests use a local
// httptest server; nil uses the production client with a hard timeout).
type Checker struct {
	Client *http.Client
	// Endpoint overrides VersionEndpoint (tests).
	Endpoint string
}

// New returns a Checker using the production timeout-bounded client.
func New() *Checker {
	return &Checker{Client: &http.Client{Timeout: httpClientTimeout}}
}

// CacheTTL 是缓存结果的有效期:版本检查是低频、低频变化的数据,
// 缓存 6 小时足以让"每次打开服务器信息页"都不打外网 API(无外网环境
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

// Check queries the release endpoint and compares it against current.
// current is the running server version; a non-SemVer value such as "dev"
// is reported as not updated (local builds should not nag operators).
func (c *Checker) Check(ctx context.Context, current string) (*Result, error) {
	endpoint := c.Endpoint
	if endpoint == "" {
		endpoint = VersionEndpoint
	}
	client := c.Client
	if client == nil {
		client = &http.Client{Timeout: httpClientTimeout}
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
		return nil, fmt.Errorf("%w: http %d", ErrUnavailable, resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBody+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if len(body) > maxResponseBody {
		return nil, fmt.Errorf("%w: response too large", ErrUnavailable)
	}

	var payload struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	latest := ParseCanonicalStable(payload.TagName)
	if latest == "" {
		return nil, fmt.Errorf("%w: invalid tag %q", ErrUnavailable, payload.TagName)
	}

	res := &Result{
		Current:    current,
		Latest:     latest,
		ReleaseURL: payload.HTMLURL,
		CheckedAt:  time.Now().UTC().Format(time.RFC3339),
	}
	if cur, ok := ParseCanonicalStableValid(current); ok {
		res.UpdateAvailable = CompareSemVer(latest, cur) > 0
	}
	return res, nil
}

// ParseCanonicalStable parses a canonical stable SemVer with an optional
// lowercase "v" prefix; the prefix is stripped. Prerelease/build versions
// are rejected (the releases/latest endpoint never returns them anyway).
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

// IsStableSemVer reports whether v is strict stable SemVer (M.m.p) with
// prerelease/build metadata stripped before validation being allowed.
func IsStableSemVer(v string) bool {
	core := v
	if i := strings.IndexByte(core, '+'); i >= 0 {
		core = core[:i]
	}
	core = strings.TrimPrefix(core, "v")
	if i := strings.IndexByte(core, '-'); i >= 0 {
		// prerelease present → not stable
		return false
	}
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return false
	}
	for _, p := range parts {
		if !isNumeric(p) || (len(p) > 1 && p[0] == '0') {
			return false
		}
	}
	return true
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

// CompareSemVer returns -1/0/1 for left vs right using strict SemVer
// precedence on the core M.m.p triple (numeric, no leading-zero overflow).
// Both inputs must be canonical stable SemVer (no v prefix, no prerelease);
// invalid inputs are treated as equal (0).
func CompareSemVer(left, right string) int {
	lc, lok := ParseCanonicalStableValid(left)
	rc, rok := ParseCanonicalStableValid(right)
	if !lok || !rok {
		return 0
	}
	lt := strings.Split(lc, ".")
	rt := strings.Split(rc, ".")
	for i := 0; i < 3; i++ {
		l, r := lt[i], rt[i]
		if len(l) != len(r) {
			if len(l) < len(r) {
				return -1
			}
			return 1
		}
		if l != r {
			if l < r {
				return -1
			}
			return 1
		}
	}
	return 0
}
