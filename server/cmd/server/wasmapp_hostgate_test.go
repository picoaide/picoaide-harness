package main

// ---- R1-sec-3 的配套装配：HostGate.ExtraMainHosts 必须与"主站源"同源（2026-09-19）----
//
// 背景：`edge.MatchHost` 收紧之后只认两支 —— 主站（`host == 基域`）与应用子域
// （`<label>.<基域>`），**其余主机名一律 HostUnknown ⇒ 404**（不再回落主站，否则任意域名
// 都能镜像门户与管理台登录页）。而"主站主机名 ≠ 应用基域"是真实部署形态
// （`server/.env.example` 的示例就是基域 `apps.example.com`、主站 `example.com`）⇒
// 不把主站主机名显式列进 `ExtraMainHosts`，这类部署升级后**主站与管理台全部 404**。
//
// 本文件的用例驱动的是**生产装配用的那段代码**（newHostGate / extraMainHosts），
// 不是另写一份等价逻辑 —— 否则"装配时忘了传字段"这类缺陷照样能全绿。
//
// 变异验证：把 newHostGate 里的 `ExtraMainHosts: extraMainHosts(...)` 去掉（或改成 nil）
// ⇒ TestHostGateServesConfiguredMainHostOutsideBaseDomain 红（配置的主站主机名拿回 404）。

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/picoaide/picoaide/internal/clientrelease"
	"github.com/picoaide/picoaide/internal/wasmapp/edge"
)

// stubAppHandler 是 edge.AppHandler 的测试替身（生产实现是 appserver.Server）。
type stubAppHandler struct {
	hits *int
}

func (s stubAppHandler) ServeApp(w http.ResponseWriter, _ *http.Request, appLabel string) {
	*s.hits++
	_, _ = io.WriteString(w, "app:"+appLabel)
}

// newHostGateHarness 用**生产装配代码**（newHostGate）搭一个最小门控：
// 主站处理器只回一句 "main"（够判"进没进主站"），应用处理器回 "app:<label>"。
type hostGateHarness struct {
	gate     *edge.HostGate
	mainHits int
	appHits  int
}

func newHostGateHarness(baseDomain, baseHostAtStartup string) *hostGateHarness {
	h := &hostGateHarness{}
	main := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		h.mainHits++
		_, _ = io.WriteString(w, "main")
	})
	h.gate = newHostGate(func() string { return baseDomain }, baseHostAtStartup, stubAppHandler{hits: &h.appHits})
	h.gate.Main = main
	return h
}

// do 发一个请求（只带 Host 头，路径可选），返回 (状态码, body, main 是否被触达)。
func (h *hostGateHarness) do(method, host, path string) (int, string, bool) {
	before := h.mainHits
	r := httptest.NewRequest(method, "https://"+host+path, nil)
	rec := httptest.NewRecorder()
	h.gate.ServeHTTP(rec, r)
	return rec.Code, rec.Body.String(), h.mainHits > before
}

// withPublicBaseURL 临时设置"服务端对外地址"的两个真源（env > 控制台设置），
// 用完还原 —— 与生产读的那两个来源完全一致（clientrelease.PublicBaseURLEnv > PublicBaseResolver）。
func withPublicBaseURL(t *testing.T, envValue, settingValue string) {
	t.Helper()
	prevEnv := clientrelease.PublicBaseURLEnv
	prevResolver := clientrelease.PublicBaseResolver
	t.Setenv(prevEnv, envValue)
	clientrelease.PublicBaseResolver = func() string { return settingValue }
	t.Cleanup(func() { clientrelease.PublicBaseResolver = prevResolver })
}

// TestHostGateServesConfiguredMainHostOutsideBaseDomain 是判据①：
// 配了对外地址、且**主站域 ≠ 基域** ⇒ 该主站 Host 的 `/` 与 `/admin/` 正常（不再 404），
// 而任意其它域名仍然 404（R1-sec-3 的钓鱼面不能被这道配置打开）。
func TestHostGateServesConfiguredMainHostOutsideBaseDomain(t *testing.T) {
	withPublicBaseURL(t, "https://r1mainsite.test", "")
	const base = "apps.r1.test"
	h := newHostGateHarness(base, base)

	// 主站主机名：门户与管理台都必须可达（"正常"= 进主站，而不是 404）。
	for _, path := range []string{"/", "/admin/", "/portal", "/login"} {
		code, body, reached := h.do(http.MethodGet, "r1mainsite.test", path)
		if !reached || code != http.StatusOK || body != "main" {
			t.Fatalf("主站 Host 的 %s 必须进主站（code=%d body=%q reached=%v）", path, code, body, reached)
		}
	}
	// 任意其它域名仍然 404（不回落主站）。
	for _, host := range []string{"evil.test", "r1mainsite.test.evil.test", "127.0.0.1", "localhost"} {
		code, _, reached := h.do(http.MethodGet, host, "/")
		if reached {
			t.Fatalf("未知主机 %q 进了主站（R1-sec-3 的钓鱼面回归）", host)
		}
		if code != http.StatusNotFound {
			t.Fatalf("未知主机 %q 应 404，得到 %d", host, code)
		}
	}
	// 基域本身仍进主站；应用子域仍进应用分支（不受 ExtraMainHosts 影响）。
	if code, body, _ := h.do(http.MethodGet, base, "/"); code != http.StatusOK || body != "main" {
		t.Fatalf("基域应进主站，得到 %d %q", code, body)
	}
	if code, body, _ := h.do(http.MethodGet, "my-app."+base, "/"); code != http.StatusOK || body != "app:my-app" {
		t.Fatalf("应用子域应进应用分支，得到 %d %q", code, body)
	}
	// 编排探针在任意 Host 下照旧可达（由 HostGate 自己的规则保证，这里回归防误伤）。
	if code, _, reached := h.do(http.MethodGet, "127.0.0.1", "/healthz"); !reached || code != http.StatusOK {
		t.Fatalf("编排探针 /healthz 必须仍然可达，得到 %d reached=%v", code, reached)
	}
}

// TestHostGateExtraMainHostsFollowsMainOriginSource 是判据①的**取值面**：
// 清单内容必须来自"主站源"的既有真源（env > 控制台设置 > 按基域推导），
// 且与基域无关的取值一律不进清单。
func TestHostGateExtraMainHostsFollowsMainOriginSource(t *testing.T) {
	const base = "apps.r1.test"

	// ① 环境变量优先（显式配置即唯一权威）。
	withPublicBaseURL(t, "https://r1mainsite.test", "https://ignored.example.com")
	if got := newHostGateHarness(base, base).gate.ExtraMainHosts; len(got) != 1 || got[0] != "r1mainsite.test" {
		t.Fatalf("env 应优先，得到 %v", got)
	}

	// ② env 为空 ⇒ 控制台设置（settings server.base_url）生效，且端口/路径被剥掉。
	withPublicBaseURL(t, "", "https://console.example.com:8443/base")
	if got := newHostGateHarness(base, base).gate.ExtraMainHosts; len(got) != 1 || got[0] != "console.example.com" {
		t.Fatalf("应取控制台设置并剥掉端口/路径，得到 %v", got)
	}

	// ③ 两者都空 ⇒ 按**应用基域**推导（判据③；与 session.ticketNonceDecision 同口径）。
	withPublicBaseURL(t, "", "")
	if got := newHostGateHarness(base, base).gate.ExtraMainHosts; len(got) != 1 || got[0] != base {
		t.Fatalf("未配对外地址时应推导出基域主机名，得到 %v", got)
	}

	// ④ 未配基域 ⇒ 空清单（判据④：MatchHost 全判主站，门控不涉及）。
	withPublicBaseURL(t, "", "")
	if got := newHostGateHarness("", "").gate.ExtraMainHosts; len(got) != 0 {
		t.Fatalf("未配基域时清单应为空，得到 %v", got)
	}

	// ⑤ 不可解析的对外地址（漏 scheme）⇒ 与"未配置"同等处理（推导基域）。
	withPublicBaseURL(t, "", "r1mainsite.test")
	if got := newHostGateHarness(base, base).gate.ExtraMainHosts; len(got) != 1 || got[0] != base {
		t.Fatalf("不可解析的对外地址应回落到基域推导，得到 %v", got)
	}
}

// TestHostGateUnchangedWhenMainHostEqualsBaseDomain 是判据②：
// 主站域 == 基域（推荐形态）时行为与升级前一致 —— 主站照常、未知主机仍然 404。
func TestHostGateUnchangedWhenMainHostEqualsBaseDomain(t *testing.T) {
	withPublicBaseURL(t, "https://harness.example.com", "")
	const base = "harness.example.com"
	h := newHostGateHarness(base, base)

	if code, body, _ := h.do(http.MethodGet, base+"/", "/"); code != http.StatusOK || body != "main" {
		t.Fatalf("基域应进主站，得到 %d %q", code, body)
	}
	if code, body, _ := h.do(http.MethodGet, base, "/admin/"); code != http.StatusOK || body != "main" {
		t.Fatalf("主站域的管理台应进主站，得到 %d %q", code, body)
	}
	if _, _, reached := h.do(http.MethodGet, "evil.test", "/"); reached {
		t.Fatal("未知主机不得进主站")
	}
}

// TestHostGateNoBaseDomainKeepsLegacyBehavior 是判据④：
// 未配应用基域 ⇒ 一切主机名照旧进主站（门控等于没挂），清单为空。
func TestHostGateNoBaseDomainKeepsLegacyBehavior(t *testing.T) {
	withPublicBaseURL(t, "", "")
	h := newHostGateHarness("", "")
	if len(h.gate.ExtraMainHosts) != 0 {
		t.Fatalf("未配基域时清单应为空，得到 %v", h.gate.ExtraMainHosts)
	}
	for _, host := range []string{"any.example.com", "127.0.0.1", "localhost"} {
		code, body, reached := h.do(http.MethodGet, host, "/")
		if !reached || code != http.StatusOK || body != "main" {
			t.Fatalf("未配基域时 %q 应照旧进主站，得到 %d %q reached=%v", host, code, body, reached)
		}
	}
}
