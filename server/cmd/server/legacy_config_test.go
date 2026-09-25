package main

// R15C-R-03（审计 2026-09-25，P2）的判据：已废除配置必须在**启动期**吵。
//
// 设计承诺（明文）：`docs/planning/2026-09-19-wasm-client-only-design.md` §12 ——
// 「`.env`/`settings` 里残留的 `PICOAI_APPS_BASE_DOMAIN`/`wasm.apps_base_domain`
// 现在**静默失效**，**启动要 warn 并给清理命令**」；`docs/deploy/AI-DEPLOY.md`
// 的"存量部署清理"节也写着「启动期会打一条 warn 提醒」。
//
// 修复前实测：三条废除项（两条 env + 一条 settings 键）同时存在时 37 行启动日志
// 相关关键词命中 **0** 次，服务照常启动 —— 典型"改了配置但静默失效"。
//
// 判据（变异即红）：
//   - 删掉 warnLegacyConfig 的 env 分支 ⇒ TestDeprecatedEnvIsWarnedWithCleanup 红；
//   - 删掉 settings 分支 ⇒ TestDeprecatedSettingIsWarned 红；
//   - 把"读取失败"当成"没设置"（吞掉 err）⇒ TestDeprecatedSettingReadFailureIsNotSilent 红；
//   - 把 main.go 里的 warnLegacyConfig(db) 删掉/挪走 ⇒ TestStartupCallsLegacyConfigCheck 红。

import (
	"bytes"
	"database/sql"
	"errors"
	"log"
	"os"
	"strings"
	"testing"
)

// captureLegacyLog 捕获本用例期间的全局 log 输出。
func captureLegacyLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(prev) })
	return &buf
}

// stubSettingReader 替换 settings 读取面（生产 = serverstore.GetSetting）。
func stubSettingReader(t *testing.T, value string, ok bool, err error) {
	t.Helper()
	prev := legacyConfigSettingReader
	t.Cleanup(func() { legacyConfigSettingReader = prev })
	legacyConfigSettingReader = func(*sql.DB, string) (string, bool, error) { return value, ok, err }
}

func TestDeprecatedEnvIsWarnedWithCleanup(t *testing.T) {
	t.Setenv("PICOAI_APPS_BASE_DOMAIN", "apps.example.com")
	t.Setenv("PICOAI_TRUSTED_PROXIES_EXPLICIT", "1")
	stubSettingReader(t, "", false, nil) // settings 侧无残留
	logs := captureLegacyLog(t)

	if hits := warnLegacyConfig(nil); hits != 2 {
		t.Fatalf("命中条目数 = %d, want 2（两条废除 env）", hits)
	}
	out := logs.String()
	for _, want := range []string{
		"WARNING: deprecated configuration still set",
		"PICOAI_APPS_BASE_DOMAIN",
		"PICOAI_TRUSTED_PROXIES_EXPLICIT",
		"no longer read",                             // 已废除
		"Replacement:",                               // 替代项
		"sed -i '/^PICOAI_APPS_BASE_DOMAIN=/d' .env", // 可执行清理命令
		"docs/deploy/AI-DEPLOY.md",                   // 在哪份文档
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("启动告警缺少 %q, 实得:\n%s", want, out)
		}
	}
	// 反向对照：不得把取值打进日志（这些键里可能含对外主机名）。
	if strings.Contains(out, "apps.example.com") {
		t.Fatalf("告警不得回显配置取值:\n%s", out)
	}
}

func TestDeprecatedEnvAbsentIsQuiet(t *testing.T) {
	// 注入"不存在"的判定面（生产 = os.LookupEnv）。
	prev := legacyConfigEnvPresent
	t.Cleanup(func() { legacyConfigEnvPresent = prev })
	legacyConfigEnvPresent = func(string) (string, bool) { return "", false }
	stubSettingReader(t, "", false, nil)
	logs := captureLegacyLog(t)

	if hits := warnLegacyConfig(nil); hits != 0 {
		t.Fatalf("无残留时命中条目数 = %d, want 0", hits)
	}
	if strings.Contains(logs.String(), "deprecated configuration still set") {
		t.Fatalf("无残留时不得打印告警:\n%s", logs.String())
	}
}

// TestDeprecatedEnvEmptyValueStillWarns 是本条的"读不到当没设置"对照面之一：
// `os.Getenv` 会把"显式设为空串"和"没设置"混为一谈，而**残留就是残留**（空值同样
// 说明还有人按旧文档在配）—— 因此判定必须用 LookupEnv。
func TestDeprecatedEnvEmptyValueStillWarns(t *testing.T) {
	t.Setenv("PICOAI_TRUSTED_PROXIES_EXPLICIT", "")
	stubSettingReader(t, "", false, nil)
	logs := captureLegacyLog(t)
	hits := warnLegacyConfig(nil)
	if hits < 1 || !strings.Contains(logs.String(), "PICOAI_TRUSTED_PROXIES_EXPLICIT") {
		t.Fatalf("设为空串的废除 env 同样是残留（必须用 LookupEnv 判定）, hits=%d 日志:\n%s",
			hits, logs.String())
	}
}

func TestDeprecatedSettingIsWarned(t *testing.T) {
	prev := legacyConfigEnvPresent
	t.Cleanup(func() { legacyConfigEnvPresent = prev })
	legacyConfigEnvPresent = func(string) (string, bool) { return "", false }
	stubSettingReader(t, "apps.example.com", true, nil)
	logs := captureLegacyLog(t)
	db := placeholderDB(t) // reader 被替换成桩，db 只用于跳过"无库句柄"分支

	if hits := warnLegacyConfig(db); hits != 1 {
		t.Fatalf("命中条目数 = %d, want 1（settings 残留）", hits)
	}
	out := logs.String()
	for _, want := range []string{
		"settings key wasm.apps_base_domain",
		"no longer read",
		"DELETE FROM settings WHERE key='wasm.apps_base_domain'",
		"docs/planning/2026-09-19-wasm-client-only-design.md",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("settings 残留告警缺少 %q, 实得:\n%s", want, out)
		}
	}
}

// TestDeprecatedSettingReadFailureIsNotSilent 钉住"**读不到 ≠ 没设置**"：
// settings 读取失败时必须打一条**不同的** error 行，明确说"该键没有被验证"。
func TestDeprecatedSettingReadFailureIsNotSilent(t *testing.T) {
	prev := legacyConfigEnvPresent
	t.Cleanup(func() { legacyConfigEnvPresent = prev })
	legacyConfigEnvPresent = func(string) (string, bool) { return "", false }
	stubSettingReader(t, "", false, errors.New("relation \"settings\" does not exist"))
	logs := captureLegacyLog(t)
	db := placeholderDB(t) // reader 被替换成桩，db 只用于跳过"无库句柄"分支

	hits := warnLegacyConfig(db)
	out := logs.String()
	if !strings.Contains(out, "could not read settings key wasm.apps_base_domain") {
		t.Fatalf("读取失败必须有独立告警行, 实得:\n%s", out)
	}
	if !strings.Contains(out, "NOT verified") {
		t.Fatalf("读取失败必须明说「不是'没设置'」, 实得:\n%s", out)
	}
	if hits != 0 {
		t.Fatalf("读取失败不得计为命中（那是「未验证」, 不是「有残留」）: hits=%d", hits)
	}
}

// TestDeprecatedSettingCheckWithoutDBIsNotSilent：没有库句柄（无 DB 启动/测试路由树）
// 时也要留痕说明"这条检查没跑"，不能静默通过。
func TestDeprecatedSettingCheckWithoutDBIsNotSilent(t *testing.T) {
	prev := legacyConfigEnvPresent
	t.Cleanup(func() { legacyConfigEnvPresent = prev })
	legacyConfigEnvPresent = func(string) (string, bool) { return "", false }
	logs := captureLegacyLog(t)

	warnLegacyConfig(nil)
	if !strings.Contains(logs.String(), "check skipped: no database handle") {
		t.Fatalf("无库句柄时必须说明检查未执行, 实得:\n%s", logs.String())
	}
}

func TestStartupCallsLegacyConfigCheck(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	idx := strings.Index(string(src), "warnLegacyConfig(db)")
	if idx < 0 {
		t.Fatal("main() 未调用 warnLegacyConfig(db) —— 已废除配置在启动期又是静默的（R15C-R-03 复发）")
	}
	// 必须排在迁移之后（否则 settings 表可能还不存在，检查会落到"读不到"分支）。
	if mig := strings.Index(string(src), "ApplyMigrations"); mig >= 0 && idx < mig {
		t.Fatal("warnLegacyConfig 排在 ApplyMigrations 之前（settings 表尚不存在）")
	}
}
