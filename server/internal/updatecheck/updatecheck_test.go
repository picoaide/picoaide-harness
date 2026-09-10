package updatecheck

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// 更新服务器 latest.json 的最小样本(见 R2 手册 §6)。
const manifestBody = `{
  "schema": 1,
  "channel_id": "official",
  "server": {"version": "2.6.0", "image_tag": "v2.6.0",
             "image_ref": "ghcr.io/picoaide/picoaide-harness-server:v2.6.0"},
  "client": {"version": "2.6.0"},
  "published_at": "2026-09-10T00:00:00Z"
}`

func manifestServer(t *testing.T, body string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept") != "application/json" {
			t.Errorf("unexpected Accept header: %q", r.Header.Get("Accept"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
}

func TestCheckUpdateAvailable(t *testing.T) {
	srv := manifestServer(t, manifestBody)
	defer srv.Close()

	c := &Checker{Client: srv.Client(), Endpoint: srv.URL}
	res, err := c.Check(context.Background(), "2.5.1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Latest != "2.6.0" {
		t.Errorf("Latest = %q, want 2.6.0", res.Latest)
	}
	if !res.UpdateAvailable {
		t.Error("UpdateAvailable = false, want true")
	}
	if res.Current != "2.5.1" {
		t.Errorf("Current = %q, want 2.5.1", res.Current)
	}
	// image_tag 是运维/webadmin 展示的升级目标,必须原样带出
	if res.ImageTag != "v2.6.0" {
		t.Errorf("ImageTag = %q, want v2.6.0", res.ImageTag)
	}
	if res.ManifestURL != srv.URL {
		t.Errorf("ManifestURL = %q, want %q", res.ManifestURL, srv.URL)
	}
	if res.CheckedAt == "" {
		t.Error("CheckedAt empty")
	}
}

func TestCheckUpToDate(t *testing.T) {
	srv := manifestServer(t, `{"channel_id":"official","schema":1,"server":{"version":"2.5.1"},"client":{"version":"2.5.1"}}`)
	defer srv.Close()

	c := &Checker{Client: srv.Client(), Endpoint: srv.URL}
	res, err := c.Check(context.Background(), "2.5.1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.UpdateAvailable {
		t.Error("UpdateAvailable = true, want false")
	}
	if res.Latest != "2.5.1" {
		t.Errorf("Latest = %q, want 2.5.1", res.Latest)
	}
}

// 预发布版本必须被接受(发布渠道由 latest.json 的内容决定,不再依赖
// GitHub releases/latest 天然排除预发布的语义)。
func TestCheckPrereleaseVersionAccepted(t *testing.T) {
	srv := manifestServer(t, `{"channel_id":"official","schema":1,"server":{"version":"2.7.0-rc.1","image_tag":"v2.7.0-rc.1"},"client":{"version":"2.7.0-rc.1"}}`)
	defer srv.Close()

	c := &Checker{Client: srv.Client(), Endpoint: srv.URL}
	res, err := c.Check(context.Background(), "2.6.0")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Latest != "2.7.0-rc.1" {
		t.Errorf("Latest = %q, want 2.7.0-rc.1", res.Latest)
	}
	// core 2.7.0 > 2.6.0 → 可升级
	if !res.UpdateAvailable {
		t.Error("UpdateAvailable = false, want true (2.7.0-rc.1 core > 2.6.0)")
	}
}

func TestCheckUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := &Checker{Client: srv.Client(), Endpoint: srv.URL}
	_, err := c.Check(context.Background(), "2.5.1")
	if err == nil {
		t.Fatal("expected error for 500 response, got nil")
	}
	if !strings.Contains(err.Error(), ErrUnavailable.Error()) {
		t.Errorf("error %v should wrap ErrUnavailable", err)
	}
}

// 更新服务器前置重定向属于配置错误(R2 手册 §3.1):必须报错而不是静默跟随。
func TestCheckRejectsRedirect(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(manifestBody))
	}))
	defer target.Close()

	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer redirector.Close()

	// 生产客户端构造(含 CheckRedirect 拒绝策略)
	c := New()
	c.Endpoint = redirector.URL
	_, err := c.Check(context.Background(), "2.5.1")
	if err == nil {
		t.Fatal("expected error for redirect, got nil (静默跟随重定向会掩盖配置错误)")
	}
	if !strings.Contains(err.Error(), ErrUnavailable.Error()) {
		t.Errorf("error %v should wrap ErrUnavailable", err)
	}
}

func TestCheckInvalidVersion(t *testing.T) {
	srv := manifestServer(t, `{"channel_id":"official","schema":1,"server":{"version":"not-a-version"}}`)
	defer srv.Close()

	c := &Checker{Client: srv.Client(), Endpoint: srv.URL}
	if _, err := c.Check(context.Background(), "2.5.1"); err == nil {
		t.Fatal("expected error for invalid server.version, got nil")
	}
}

// 缺少 server.version(字段缺失或空)同样是错误——不能当成"无更新"。
func TestCheckMissingVersion(t *testing.T) {
	srv := manifestServer(t, `{"schema":1,"channel_id":"official"}`)
	defer srv.Close()

	c := &Checker{Client: srv.Client(), Endpoint: srv.URL}
	if _, err := c.Check(context.Background(), "2.5.1"); err == nil {
		t.Fatal("expected error for missing server.version, got nil")
	}
}

func TestDevCurrentNeverUpdates(t *testing.T) {
	srv := manifestServer(t, `{"channel_id":"official","schema":1,"server":{"version":"99.0.0"}}`)
	defer srv.Close()

	c := &Checker{Client: srv.Client(), Endpoint: srv.URL}
	res, err := c.Check(context.Background(), "dev")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.UpdateAvailable {
		t.Error("dev build should never report update available")
	}
}

// 端点解析:PICOAI_UPDATE_ENDPOINT 覆盖默认值;关闭值返回空(不启用检查)。
func TestResolveEndpoint(t *testing.T) {
	cases := []struct {
		name string
		set  bool
		val  string
		want string
	}{
		{"default when unset", false, "", DefaultEndpoint},
		{"channel override", true, "https://release.picoaide.com/acme/latest.json", "https://release.picoaide.com/acme/latest.json"},
		{"empty disables", true, "", ""},
		{"off disables", true, "off", ""},
		{"dash disables", true, "-", ""},
		{"none disables", true, "NONE", ""},
		{"trim spaces", true, "  https://example.test/latest.json  ", "https://example.test/latest.json"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// t.Setenv 只能设值;测"真正未设置"需要先注册恢复再 Unsetenv。
			t.Setenv(EndpointEnv, "placeholder")
			if tc.set {
				t.Setenv(EndpointEnv, tc.val)
			} else {
				if err := os.Unsetenv(EndpointEnv); err != nil {
					t.Fatalf("Unsetenv: %v", err)
				}
			}
			if got := ResolveEndpoint(); got != tc.want {
				t.Fatalf("ResolveEndpoint() = %q, want %q", got, tc.want)
			}
		})
	}
}

// 未配置端点(显式关闭)时返回 ErrNoEndpoint,交由调用方静默降级。
func TestCheckNoEndpoint(t *testing.T) {
	t.Setenv(EndpointEnv, "off")
	c := New()
	if _, err := c.Check(context.Background(), "2.5.1"); err == nil {
		t.Fatal("expected ErrNoEndpoint, got nil")
	}
}

func TestCompareSemVer(t *testing.T) {
	cases := []struct {
		left, right string
		want        int
	}{
		{"2.5.1", "2.5.1", 0},
		{"2.5.1", "2.5.2", -1},
		{"2.6.0", "2.5.9", 1},
		{"2.10.0", "2.9.0", 1}, // 位数不同:按长度比较,避免字典序陷阱
		{"10.0.0", "9.99.99", 1},
		{"dev", "2.0.0", 0},        // 非法输入视为相等
		{"2.5.1-rc.1", "2.5.1", 0}, // 预发布不影响 core 比较
	}
	for _, tc := range cases {
		if got := CompareSemVer(tc.left, tc.right); got != tc.want {
			t.Errorf("CompareSemVer(%q, %q) = %d, want %d", tc.left, tc.right, got, tc.want)
		}
	}
}

func TestIsStableSemVer(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"2.5.1", true},
		{"v2.5.1", true},
		{"2.5", false},
		{"2.5.1-rc.1", false},
		{"2.5.1+build", true},
		{"2.05.1", false},
		{"dev", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := IsStableSemVer(tc.in); got != tc.want {
			t.Errorf("IsStableSemVer(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestIsSemVer(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"2.5.1", true},
		{"2.7.0-rc.1", true},
		{"2.7.0-beta.11", true},
		{"2.7.0-rc.1+build.5", true},
		{"2.5", false},
		{"v2.5.1", false}, // IsSemVer 不接受 v 前缀(由 NormalizeVersion 处理)
		{"2.7.0-", false},
		{"2.7.0-rc..1", false},
		{"dev", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := IsSemVer(tc.in); got != tc.want {
			t.Errorf("IsSemVer(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestNormalizeVersion(t *testing.T) {
	cases := []struct{ in, want string }{
		{"2.6.0", "2.6.0"},
		{"v2.6.0", "2.6.0"},
		{" 2.6.0 ", "2.6.0"},
		{"2.7.0-rc.1", "2.7.0-rc.1"},
		{"v2.7.0-rc.1", "2.7.0-rc.1"},
		{"not-a-version", ""},
		{"", ""},
	}
	for _, tc := range cases {
		if got := NormalizeVersion(tc.in); got != tc.want {
			t.Errorf("NormalizeVersion(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestParseCanonicalStable(t *testing.T) {
	cases := []struct{ in, want string }{
		{"v2.5.1", "2.5.1"},
		{"2.5.1", "2.5.1"},
		{"2.5.1-rc.1", ""},
		{"2.5", ""},
		{"dev", ""},
	}
	for _, tc := range cases {
		if got := ParseCanonicalStable(tc.in); got != tc.want {
			t.Errorf("ParseCanonicalStable(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// ---- 渠道隔离(2026-09-10):品牌/预发/官方三渠道互不升级 ----

// 清单渠道与本服务端渠道不一致时必须报错(不是"无更新")。
// 静默接受 = 品牌服务端被官方清单升级成官方版、品牌与渠道配置丢失。
func TestCheckRejectsForeignChannel(t *testing.T) {
	srv := manifestServer(t, `{"schema":1,"channel_id":"official","server":{"version":"9.9.9","image_tag":"v9.9.9"}}`)
	defer srv.Close()

	c := &Checker{Client: srv.Client(), Endpoint: srv.URL, ExpectedChannel: "acme"}
	_, err := c.Check(context.Background(), "2.5.1")
	if err == nil {
		t.Fatal("品牌渠道服务端接受了官方渠道的清单 —— 跨渠道升级未被拦住")
	}
	if !strings.Contains(err.Error(), ErrUnavailable.Error()) {
		t.Errorf("error %v should wrap ErrUnavailable", err)
	}
	if !strings.Contains(err.Error(), "acme") || !strings.Contains(err.Error(), "official") {
		t.Errorf("错误信息应同时点出双方渠道,便于定位: %v", err)
	}
}

// 清单缺 channel_id 同样拒绝:缺字段不能当作"默认官方"。
func TestCheckRejectsMissingChannelID(t *testing.T) {
	srv := manifestServer(t, `{"schema":1,"server":{"version":"9.9.9"}}`)
	defer srv.Close()

	c := &Checker{Client: srv.Client(), Endpoint: srv.URL, ExpectedChannel: "official"}
	if _, err := c.Check(context.Background(), "2.5.1"); err == nil {
		t.Fatal("缺少 channel_id 的清单被接受")
	}
}

// 渠道一致时正常放行(回归:隔离不能把正常路径也拦掉)。
func TestCheckAcceptsMatchingChannel(t *testing.T) {
	srv := manifestServer(t, `{"schema":1,"channel_id":"beta","server":{"version":"9.9.9","image_tag":"v9.9.9"}}`)
	defer srv.Close()

	c := &Checker{Client: srv.Client(), Endpoint: srv.URL, ExpectedChannel: "beta"}
	res, err := c.Check(context.Background(), "2.5.1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.UpdateAvailable || res.Latest != "9.9.9" {
		t.Errorf("同渠道清单应正常放行: %+v", res)
	}
}

func TestIsChannelID(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"official", true}, {"beta", true}, {"acme", true}, {"acme-corp", true},
		{"a1", true}, {"", false}, {"Official", false}, {"-acme", false},
		{"acme-", false}, {"acme corp", false}, {"acme_corp", false},
		{"a", true}, {strings.Repeat("a", 32), true}, {strings.Repeat("a", 33), false},
	}
	for _, tc := range cases {
		if got := IsChannelID(tc.in); got != tc.want {
			t.Errorf("IsChannelID(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

// ResolveChannel:显式 env 优先;否则从端点路径推导;都不成立回落官方。
func TestResolveChannel(t *testing.T) {
	cases := []struct {
		name     string
		channel  string
		endpoint string
		want     string
	}{
		{"explicit channel wins", "acme", "https://release.picoaide.com/official/latest.json", "acme"},
		{"derive from endpoint path", "", "https://release.picoaide.com/acme/latest.json", "acme"},
		{"derive beta from path", "", "https://release.picoaide.com/beta/latest.json", "beta"},
		{"invalid explicit falls back to official", "ACME!", "", OfficialChannel},
		{"no config defaults official", "", "", OfficialChannel},
		{"endpoint without channel segment", "", "https://example.test/latest.json", OfficialChannel},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(ChannelEnv, tc.channel)
			t.Setenv(EndpointEnv, tc.endpoint)
			got := ResolveChannel()
			if tc.name == "endpoint without channel segment" {
				// 路径首段不是合法渠道 id 时不应把它当渠道 —— 这里断言回落官方
				if got != OfficialChannel {
					t.Fatalf("ResolveChannel() = %q, want %q", got, OfficialChannel)
				}
				return
			}
			if got != tc.want {
				t.Fatalf("ResolveChannel() = %q, want %q", got, tc.want)
			}
		})
	}
}
