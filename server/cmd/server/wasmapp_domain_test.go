package main

import (
	"database/sql"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/anonlimit"
	wasmapi "github.com/picoaide/picoaide/internal/wasmapp/api"
)

// 应用泛域名配置的单测（2026-09-18 用户要求「管理端支持应用域名的泛域名配置」）。
//
// 判据：
//   - 校验器接受真实域名（含显式 http:// = 明文部署）、拒绝通配符/端口/IP/单标签；
//   - 持有者优先级：控制台设置 > 环境变量（**含显式清空**）；
//   - **启用子域时必须跑与启动期同一批 fail-closed 自检**（R35 可信代理）——
//     否则"先不配基域启动、再从控制台打开"就绕过了它们；
//   - 保存成功后运行期立即生效（不需要重启）。

func TestNormalizeBaseDomain(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    string
		wantErr string // 期望的 details.reason；空 = 应当通过
	}{
		{name: "裸域名", in: "example.com", want: "example.com"},
		{name: "带子域", in: "apps.example.com", want: "apps.example.com"},
		{name: "大写与尾点归一化", in: "  Apps.Example.COM.  ", want: "apps.example.com"},
		{name: "显式 https 前缀去掉", in: "https://apps.example.com", want: "apps.example.com"},
		{name: "显式 http 前缀保留（明文部署）", in: "http://apps.example.com", want: "http://apps.example.com"},
		{name: "空 = 关闭子域", in: "   ", want: ""},
		{name: "通配符被拒", in: "*.example.com", wantErr: "wildcard_not_allowed"},
		{name: "带端口被拒", in: "example.com:8443", wantErr: "not_a_bare_host"},
		{name: "带路径被拒", in: "example.com/apps", wantErr: "not_a_bare_host"},
		{name: "IP 被拒", in: "10.0.0.1", wantErr: "ip_not_allowed"},
		{name: "单标签被拒", in: "intranet", wantErr: "single_label"},
		{name: "下划线被拒", in: "app_s.example.com", wantErr: "bad_label"},
		{name: "连字符在首尾被拒", in: "-app.example.com", wantErr: "bad_label"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := normalizeBaseDomain(c.in)
			if c.wantErr == "" {
				if err != nil {
					t.Fatalf("normalizeBaseDomain(%q) 报错: %v", c.in, err)
				}
				if got != c.want {
					t.Fatalf("normalizeBaseDomain(%q) = %q, want %q", c.in, got, c.want)
				}
				return
			}
			if err == nil {
				t.Fatalf("normalizeBaseDomain(%q) 应当报 %s，实际通过（=%q）", c.in, c.wantErr, got)
			}
			if reason, _ := err.Details["reason"].(string); reason != c.wantErr {
				t.Fatalf("normalizeBaseDomain(%q) 的 reason = %q, want %q（details=%v）", c.in, reason, c.wantErr, err.Details)
			}
			// 每个拒绝都必须带 hints：控制台要能直接告诉管理员"该怎么填"。
			if len(err.Hints) == 0 {
				t.Fatalf("normalizeBaseDomain(%q) 的错误缺少 hints", c.in)
			}
		})
	}
}

// TestBaseDomainHolderSettingBeatsEnv 覆盖优先级与"保存即生效"。
func TestBaseDomainHolderSettingBeatsEnv(t *testing.T) {
	db := requireRealDB(t)
	t.Setenv(anonlimit.EnvTrustedProxies, "172.28.0.2")
	t.Setenv(anonlimit.EnvTrustedProxiesExplicit, "1")

	// ① 库里没有设置行 ⇒ 回落环境变量。
	h := newBaseDomainHolder(db, "env.example.com")
	if h.Get() != "env.example.com" || h.Source() != "env" {
		t.Fatalf("初始应回落环境变量，得到 value=%q source=%q", h.Get(), h.Source())
	}
	// ② 控制台保存 ⇒ 立即生效（不需要重启），来源变 setting，落库。
	if err := h.Apply("apps.example.com"); err != nil {
		t.Fatalf("保存基域失败: %v", err)
	}
	if h.Get() != "apps.example.com" || h.Source() != "setting" {
		t.Fatalf("保存后未生效: value=%q source=%q", h.Get(), h.Source())
	}
	// ③ 同一份设置对**新进程**同样有效（真的落库了，不只是内存）。
	h2 := newBaseDomainHolder(db, "env.example.com")
	if h2.Get() != "apps.example.com" || h2.Source() != "setting" {
		t.Fatalf("设置未持久化: value=%q source=%q", h2.Get(), h2.Source())
	}
	// ④ **显式清空**同样压过环境变量（否则控制台关不掉部署期写死的基域）。
	if err := h2.Apply(""); err != nil {
		t.Fatalf("清空基域失败: %v", err)
	}
	h3 := newBaseDomainHolder(db, "env.example.com")
	if h3.Get() != "" || h3.Source() != "setting" {
		t.Fatalf("显式清空应压过环境变量: value=%q source=%q", h3.Get(), h3.Source())
	}
	// 设置行确实写着空串（而不是被删掉）。
	if raw, ok, err := readBaseDomainSetting(t, db); err != nil || !ok || raw != "" {
		t.Fatalf("设置行应存在且为空串: ok=%v raw=%q err=%v", ok, raw, err)
	}
}

// TestBaseDomainEnableRunsStartupGuards 覆盖"运行期启用也要过同一批自检"。
//
// 这条是本功能最容易漏的地方：启动自检保护的是运行期语义，而控制台让"启用"
// 可以在运行期发生 —— 不在这里复用判据就等于开了一条绕过它们的路。
func TestBaseDomainEnableRunsStartupGuards(t *testing.T) {
	db := requireRealDB(t)
	// 未显式配置可信代理 ⇒ 启用必须被拒（R35）。
	t.Setenv(anonlimit.EnvTrustedProxies, "")
	t.Setenv(anonlimit.EnvTrustedProxiesExplicit, "")

	h := newBaseDomainHolder(db, "")
	if err := h.Apply("apps.example.com"); err == nil {
		t.Fatal("未显式配置可信代理时启用子域必须被拒（R35）")
	} else if len(err.Hints) == 0 {
		t.Fatalf("拒绝必须带 hints（告诉管理员差什么）: %+v", err)
	}
	if h.Get() != "" {
		t.Fatalf("被拒之后不得生效: %q", h.Get())
	}
	// 库里也不该留下设置行（失败的保存不落库）。
	if raw, ok, err := readBaseDomainSetting(t, db); err != nil || ok {
		t.Fatalf("失败的保存不该落库: ok=%v raw=%q err=%v", ok, raw, err)
	}
	// 配好可信代理后可保存。
	t.Setenv(anonlimit.EnvTrustedProxies, "172.28.0.2,10.0.0.0/8")
	t.Setenv(anonlimit.EnvTrustedProxiesExplicit, "1")
	if err := h.Apply("apps.example.com"); err != nil {
		t.Fatalf("配好可信代理后应可保存: %v", err)
	}
	if h.Get() != "apps.example.com" {
		t.Fatalf("保存后未生效: %q", h.Get())
	}
	// 关闭子域不需要过自检（没有匿名流量进子域这回事）。
	if err := h.Apply(""); err != nil {
		t.Fatalf("关闭子域应总是允许: %v", err)
	}
}

// readBaseDomainSetting 直接读设置行（验证"失败不落库 / 清空留空串"）。
// @param db - 测试库。
// @returns 值、是否存在、错误。
func readBaseDomainSetting(t *testing.T, db *sql.DB) (string, bool, error) {
	t.Helper()
	return serverstore.GetSetting(db, wasmapi.SettingAppsBaseDomain)
}
