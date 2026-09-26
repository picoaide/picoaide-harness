package clientrelease

// R28-FIX41 ③ 回归：显式配置的"对外地址"**绝不能**把 userinfo（凭据）带进公开面。
//
// 被审形态（R28 审计 AB1-01 = P2，真跑复现）：`normalizeBaseURL` 是"对外地址"的唯一
// 规范化实现，修前只查 scheme/host 就返回 `strings.TrimRight(raw,"/")` **原串**
// ⇒ settings `server.base_url` 写成 `https://user:pass@host` 时，**公开未认证**端点
// `/api/client/v2/updates/manifest` 下发的下载 URL 逐字是
//
//	asset url = "https://AB1USER:AB1SECRET@harness.example.com/updates/client/Setup.exe"
//
// 任何未登录调用者都能直接读到凭据。同一取值还有第二条暴露路径（不可变审计行），
// 那条由 llmgateway 面收口（见报告 ③ 的两条路径分工）。
//
// 本文件的判据：
//   - 条 1（能力级、真路由）：配置带 userinfo ⇒ 清单**不得**含凭据，且必须退回请求头
//     推导的来源（配置正常的部署照常可用）；
//   - 条 2：环境变量那条路径（`PICOAI_PUBLIC_BASE_URL`）非法时**明确拒绝**并给出原因；
//   - 条 3：`normalizeBaseURL` 的取值表 —— 正例逐字不变（这是"最小改动"的判据），
//     带 userinfo 的各种形态一律拒绝；
//   - 条 4：被忽略时的告警**不含原始取值**（否则告警本身成为第二条泄漏路径）。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// captureWarns 接管告警出口并复位两个"只告警一次"闸，返回收集到的文案。
func captureWarns(t *testing.T) *[]string {
	t.Helper()
	var got []string
	var mu sync.Mutex
	prevWarn := logWarn
	logWarn = func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		line := format
		for _, a := range args {
			if s, ok := a.(string); ok {
				line += " " + s
			}
		}
		got = append(got, line)
	}
	originWarnMu.Lock()
	prevOrigin := originWarned
	originWarned = false
	originWarnMu.Unlock()
	configuredBaseWarnMu.Lock()
	prevConfigured := configuredBaseWarned
	configuredBaseWarned = false
	configuredBaseWarnMu.Unlock()
	t.Cleanup(func() {
		logWarn = prevWarn
		originWarnMu.Lock()
		originWarned = prevOrigin
		originWarnMu.Unlock()
		configuredBaseWarnMu.Lock()
		configuredBaseWarned = prevConfigured
		configuredBaseWarnMu.Unlock()
	})
	return &got
}

// resetWarnGates 复位两个"只告警一次"闸（同一用例里要观察第二轮告警时用）。
func resetWarnGates() {
	originWarnMu.Lock()
	originWarned = false
	originWarnMu.Unlock()
	configuredBaseWarnMu.Lock()
	configuredBaseWarned = false
	configuredBaseWarnMu.Unlock()
}

// withConfiguredBase 注入"服务端配置的对外地址"（生产由 cmd/server 注入）。
func withConfiguredBase(t *testing.T, value string) {
	t.Helper()
	prev := PublicBaseResolver
	PublicBaseResolver = func() string { return value }
	t.Cleanup(func() { PublicBaseResolver = prev })
}

// bodyJSON 把清单响应序列化（判据只关心"凭据在不在响应里"）。
func bodyJSON(t *testing.T, body map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("序列化清单响应: %v", err)
	}
	return string(raw)
}

// TestManifestNeverLeaksUserinfoFromConfiguredBaseURL 是条 1（承重）。
func TestManifestNeverLeaksUserinfoFromConfiguredBaseURL(t *testing.T) {
	const (
		user = "AB1USER"
		pass = "AB1SECRET"
	)
	withReleaseDir(t, oneAsset(t), nil)
	t.Setenv(PublicBaseURLEnv, "")
	warns := captureWarns(t)

	r := newRouter("2.7.0")
	secureReq := func(req *http.Request) {
		req.Host = "harness.example.com"
		req.Header.Set("X-Forwarded-Proto", "https")
	}

	withConfiguredBase(t, "https://"+user+":"+pass+"@harness.example.com/path")
	body := getManifest(t, r, secureReq)
	serialized := bodyJSON(t, body)

	// ① 凭据绝不能出现在响应里的任何位置（不只是 url 字段）。
	if strings.Contains(serialized, pass) || strings.Contains(serialized, user) {
		t.Fatalf("公开清单里出现了配置中的凭据（AB1-01 的形态）: %s", serialized)
	}
	// ② 带 userinfo 的配置必须被**拒绝**（不是静默剔除后继续拿它当基地址）：
	//    来源退回请求头推导 ⇒ 仍给出可下载的 https 地址（配置正常的部署不受影响）。
	got := assetURL(body, "win-x64")
	want := "https://harness.example.com/updates/client/Setup.exe"
	if got != want {
		t.Fatalf("带 userinfo 的对外地址必须被拒绝并退回请求头推导: asset url = %q, want %q", got, want)
	}
	if strings.Contains(got, "@") {
		t.Fatalf("下载 URL 不得含 userinfo: %q", got)
	}
	// ③ 必须留下"配置被忽略"的告警（不是静默）。
	if len(*warns) == 0 {
		t.Fatal("配置被忽略却没有告警 —— 静默剔除会让管理员以为凭据生效了")
	}
	// ④ 告警本身不得回显原始取值（否则它是第二条泄漏路径）。
	for _, line := range *warns {
		if strings.Contains(line, pass) || strings.Contains(line, user) {
			t.Fatalf("告警回显了凭据: %s", line)
		}
		if !strings.Contains(line, "userinfo") {
			t.Fatalf("告警必须点明被拒的原因（userinfo）: %s", line)
		}
	}

	// ⑤ 反向对照：**不带** userinfo 的同一形态配置照常生效（证明拒绝只针对凭据，
	//    不是把整条配置路径关掉）。
	resetWarnGates()
	withConfiguredBase(t, "https://harness.example.com/picoaide/")
	if got := assetURL(getManifest(t, r, secureReq), "win-x64"); got != "https://harness.example.com/picoaide/updates/client/Setup.exe" {
		t.Fatalf("无 userinfo 的配置必须逐字照旧生效: %q", got)
	}
}

// TestManifestRejectsEnvBaseURLWithUserinfo 是条 2：环境变量这条路径非法时的处理。
func TestManifestRejectsEnvBaseURLWithUserinfo(t *testing.T) {
	withReleaseDir(t, oneAsset(t), nil)
	withConfiguredBase(t, "")
	captureWarns(t)
	r := newRouter("2.7.0")

	t.Setenv(PublicBaseURLEnv, "https://AB1USER:AB1SECRET@harness.example.com")
	body := getManifest(t, r, func(req *http.Request) {
		req.Host = "harness.example.com"
		req.Header.Set("X-Forwarded-Proto", "https") // 请求头安全也不能救回带凭据的配置
	})
	if _, ok := body["client"]; ok {
		t.Fatalf("非法配置下不得下发 client 段: %v", body)
	}
	reason, _ := body["client_unavailable"].(string)
	if !strings.Contains(reason, PublicBaseURLEnv) || !strings.Contains(reason, "userinfo") {
		t.Fatalf("client_unavailable 必须点名环境变量与 userinfo: %q", reason)
	}
	if strings.Contains(bodyJSON(t, body), "AB1SECRET") {
		t.Fatalf("响应里出现了凭据: %s", bodyJSON(t, body))
	}
}

// TestManifestIsNotCacheable 是 ④③ 判定的承重判据（"无条件采信 XFP"为什么不是 P2）。
//
// 伪造 `X-Forwarded-Proto: https` 只改**它自己那一次请求**的响应（清单 URL 的 scheme、
// `Set-Cookie; Secure`）。要让它够到**别的用户**，只有一条路：这一次响应被某个共享缓存
// 保存下来、再发给别人。所以"清单不可缓存"就是"不升级为 P2"的前提，必须真跑钉住 ——
// 而不是只在注释里声称。
func TestManifestIsNotCacheable(t *testing.T) {
	withReleaseDir(t, oneAsset(t), nil)
	t.Setenv(PublicBaseURLEnv, "")

	r := newRouter("2.7.0")
	req := httptest.NewRequest(http.MethodGet, "/api/client/v2/updates/manifest", nil)
	req.Host = "ai.example.com"
	req.Header.Set("X-Forwarded-Proto", "https") // 伪造者自己声明来源
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("清单必须不可缓存（否则伪造的 XFP 可经共享缓存投毒给别的用户 ⇒ 那条路一旦成立就是 P2）: Cache-Control = %q", cc)
	}
	for _, h := range []string{"Expires", "Age", "ETag", "Last-Modified"} {
		if v := w.Header().Get(h); v != "" {
			t.Fatalf("不可缓存的响应不该带 %s: %q", h, v)
		}
	}
}

// TestNormalizeBaseURLRejectsUserinfo 是条 3：取值表（正例逐字不变 = 最小改动）。
func TestNormalizeBaseURLRejectsUserinfo(t *testing.T) {
	valid := []struct{ raw, want string }{
		{"https://harness.example.com", "https://harness.example.com"},
		{"https://harness.example.com/", "https://harness.example.com"},
		{"https://harness.example.com/picoaide/", "https://harness.example.com/picoaide"},
		{"http://127.0.0.1:9000", "http://127.0.0.1:9000"},
	}
	for _, tc := range valid {
		got, ok := normalizeBaseURL(tc.raw)
		if !ok || got != tc.want {
			t.Fatalf("normalizeBaseURL(%q) = (%q, %v), want (%q, true) —— 正例必须逐字不变", tc.raw, got, ok, tc.want)
		}
	}
	invalid := []string{
		"https://AB1USER:AB1SECRET@harness.example.com",
		"https://AB1USER:AB1SECRET@harness.example.com/path/",
		"https://AB1USER@harness.example.com",
		"https://:AB1SECRET@harness.example.com", // 空用户名 + 口令
		"https://@harness.example.com",           // 空 userinfo（畸形形态）
		"http://user:pass@127.0.0.1:9000",        // 回环也不放行：下载面是公开未认证的
	}
	for _, raw := range invalid {
		if got, ok := normalizeBaseURL(raw); ok {
			t.Fatalf("normalizeBaseURL(%q) = (%q, true)，必须拒绝：返回值会被拼进公开未认证的下载 URL "+
				"（R28 AB1-01：asset url = https://USER:SECRET@host/updates/client/Setup.exe）", raw, got)
		}
	}
}
