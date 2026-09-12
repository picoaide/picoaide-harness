package updatecheck

import (
	"context"
	"testing"
)

// FIX-23(审计 2026-09-12,P1):updatecheck 对"预发布当前版本"永不报告更新。
//
// 缺陷形态:Check 里用 ParseCanonicalStableValid(current) 决定要不要比较,
// 而它经 IsStableSemVer **拒绝一切带 "-" 的版本**。于是服务端自身是预发布时
// ok=false,UpdateAvailable 恒为 false —— beta 渠道的升级提示永久失效。
//
// 为什么这是常规状态而不是边缘情况:CI 的 VERSION = `${{ github.ref_name }}`
// (ci.yml) → Dockerfile `-X main.version` → main.go SetBuildVersion →
// sysinfo.go Check(ctx, buildVersion)。beta/official 渠道发出来的版本号
// 就是 2.7.2-beta.7 这样的预发布。
//
// 审计实测:cur=2.7.2-beta.7 + latest=2.8.0 → false(稳定版对照 cur=v2.7.1 → true)。
//
// 修法:改用 NormalizeVersion(接受预发布);比较仍是 CompareSemVer 的 core
// 语义,所以 beta→beta 不会提示(只有 core 变大才提示)。

func checkWithCurrent(t *testing.T, manifest, current string) *Result {
	t.Helper()
	srv := manifestServer(t, manifest)
	defer srv.Close()
	c := &Checker{Client: srv.Client(), Endpoint: srv.URL}
	res, err := c.Check(context.Background(), current)
	if err != nil {
		t.Fatalf("Check(%q): %v", current, err)
	}
	return res
}

func manifestWith(serverVersion string) string {
	return `{"channel_id":"official","schema":1,"server":{"version":"` + serverVersion +
		`","image_tag":"v` + serverVersion + `"},"client":{"version":"` + serverVersion + `"}}`
}

// TestCheckPrereleaseCurrentReportsUpdate 是核心回归锁:预发布当前版本必须
// 能报出更新。
func TestCheckPrereleaseCurrentReportsUpdate(t *testing.T) {
	res := checkWithCurrent(t, manifestWith("2.8.0"), "2.7.2-beta.7")
	if !res.UpdateAvailable {
		t.Fatalf("cur=2.7.2-beta.7 + latest=2.8.0 → UpdateAvailable=false, want true"+
			"(预发布当前版本此前永远不提示更新); res=%+v", res)
	}
	if res.Latest != "2.8.0" {
		t.Fatalf("Latest = %q, want 2.8.0", res.Latest)
	}
	if res.Current != "2.7.2-beta.7" {
		t.Fatalf("Current = %q, want 2.7.2-beta.7(原样带出构建版本)", res.Current)
	}

	// 带 v 前缀的预发布同样成立(CI ref_name 是 "v2.7.2-beta.7")。
	if res := checkWithCurrent(t, manifestWith("2.8.0"), "v2.7.2-beta.7"); !res.UpdateAvailable {
		t.Fatalf("cur=v2.7.2-beta.7 + latest=2.8.0 → false, want true")
	}
	// rc 后缀同理。
	if res := checkWithCurrent(t, manifestWith("3.0.0"), "2.7.2-rc.1"); !res.UpdateAvailable {
		t.Fatalf("cur=2.7.2-rc.1 + latest=3.0.0 → false, want true")
	}
}

// TestCheckPrereleaseCurrentNoDowngradePrompt 是防误伤:core 没变大(或更小)
// 时**不得**提示更新 —— 修复不能让 beta 用户被反复提示"升级"到同版本。
func TestCheckPrereleaseCurrentNoDowngradePrompt(t *testing.T) {
	cases := []struct{ current, latest string }{
		{"2.7.2-beta.7", "2.7.2-beta.7"}, // 同版本
		{"2.7.2-beta.7", "2.7.2-beta.8"}, // 同 core 的更高预发布
		{"2.7.2-beta.7", "2.7.2"},        // 同 core 的正式版
		{"2.7.2-beta.7", "2.7.1"},        // 目标更旧
		{"2.8.0", "2.7.2-beta.7"},        // 稳定版当前,目标是更旧预发布
	}
	for _, tc := range cases {
		res := checkWithCurrent(t, manifestWith(tc.latest), tc.current)
		if res.UpdateAvailable {
			t.Errorf("cur=%s latest=%s → UpdateAvailable=true, want false(core 未变大)", tc.current, tc.latest)
		}
	}
}

// TestCheckStableCurrentStillWorks 是防回归:稳定版当前版本的行为不能被改坏。
func TestCheckStableCurrentStillWorks(t *testing.T) {
	if res := checkWithCurrent(t, manifestWith("2.6.0"), "2.5.1"); !res.UpdateAvailable {
		t.Error("稳定版 2.5.1 → 2.6.0 必须提示更新")
	}
	if res := checkWithCurrent(t, manifestWith("2.5.1"), "2.5.1"); res.UpdateAvailable {
		t.Error("稳定版同版本不得提示更新")
	}
	if res := checkWithCurrent(t, manifestWith("2.6.0"), "v2.5.1"); !res.UpdateAvailable {
		t.Error("带 v 前缀的稳定版必须提示更新")
	}
}

// TestCheckUnparseableCurrentStaysSilent 是安全方向的防回归:当前版本无法
// 解析(本地 dev 构建)时保持 false —— 绝不能变成"永远可升级"。
func TestCheckUnparseableCurrentStaysSilent(t *testing.T) {
	for _, cur := range []string{"dev", "", "unknown", "v", "1.2", "abc-def"} {
		res := checkWithCurrent(t, manifestWith("2.8.0"), cur)
		if res.UpdateAvailable {
			t.Errorf("cur=%q(不可解析)→ UpdateAvailable=true, want false", cur)
		}
	}
}
