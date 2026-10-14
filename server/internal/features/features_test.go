package features

import (
	"reflect"
	"testing"
)

// 本文件的用例**不带 build tag**：它在 6 种（4 种 skills/apps × 2 种 connectors）
// 编译组合下都必须通过 —— 判据只断言"内部自洽 + 契约字面量"，不断言任何一种
// 具体开关状态（那是构建入口的事，由 scripts/check-go-build-tags.mjs 的矩阵判据守）。

// TestModuleNamesMatchChannelContract 钉住模块名字面量：它们是对外契约（渠道配置与
// 客户端组装清单按字符串比对），改名不是重构而是换契约。
func TestModuleNamesMatchChannelContract(t *testing.T) {
	if ModuleSkills != "skills" {
		t.Fatalf("ModuleSkills = %q，契约要求 %q", ModuleSkills, "skills")
	}
	if ModuleApps != "apps" {
		t.Fatalf("ModuleApps = %q，契约要求 %q", ModuleApps, "apps")
	}
	if ModuleConnectors != "connectors" {
		t.Fatalf("ModuleConnectors = %q，契约要求 %q", ModuleConnectors, "connectors")
	}
	want := []string{"skills", "apps", "connectors"}
	if got := AllModules(); !reflect.DeepEqual(got, want) {
		t.Fatalf("AllModules() = %v，契约要求 %v（顺序也是契约：Enabled 的返回顺序由它派生）", got, want)
	}
}

// TestEnabledAgreesWithHas 是"两处判定不许漂移"的判据：Enabled() 必须恰好是
// AllModules() 里 Has() 为真的那个子序列。
func TestEnabledAgreesWithHas(t *testing.T) {
	enabled := Enabled()
	seen := map[string]bool{}
	for _, name := range enabled {
		if seen[name] {
			t.Fatalf("Enabled() 里 %q 出现两次：%v", name, enabled)
		}
		seen[name] = true
		if !Has(name) {
			t.Fatalf("Enabled() 含 %q 而 Has(%q) = false：%v", name, name, enabled)
		}
	}
	for _, name := range AllModules() {
		if Has(name) && !seen[name] {
			t.Fatalf("Has(%q) = true 而 Enabled() = %v 不含它", name, enabled)
		}
		if !Has(name) && seen[name] {
			t.Fatalf("Has(%q) = false 而 Enabled() = %v 含它", name, enabled)
		}
	}
	if len(enabled) != len(seen) {
		t.Fatalf("Enabled() = %v 有重复项", enabled)
	}
}

// TestEnabledIsOrderedSubsequenceOfAllModules：Enabled 的顺序必须由 AllModules 决定
// （构建产物与日志里同一组合的取值逐字节稳定）。
func TestEnabledIsOrderedSubsequenceOfAllModules(t *testing.T) {
	enabled := Enabled()
	next := 0
	for _, name := range AllModules() {
		if next < len(enabled) && enabled[next] == name {
			next++
		}
	}
	if next != len(enabled) {
		t.Fatalf("Enabled() = %v 不是 AllModules() = %v 的有序子序列", enabled, AllModules())
	}
}

// TestEnabledIsNeverNil：空集必须是 `[]string{}` 而不是 nil（拿它序列化/比较的调用点
// 不该因为开关状态不同而拿到两种形态）。
func TestEnabledIsNeverNil(t *testing.T) {
	if Enabled() == nil {
		t.Fatal("Enabled() 返回 nil：全关时也必须是空切片")
	}
}

// TestHasRejectsUnknown：未知名字一律 false（不 panic、不按前缀猜）。
func TestHasRejectsUnknown(t *testing.T) {
	for _, name := range []string{"", "Skills", "SKILLS", "skill", "apps ", "wasmapp", "connector"} {
		if Has(name) {
			t.Fatalf("Has(%q) = true：未知名字必须是 false", name)
		}
	}
}

// TestConveniencePredicatesAgreeWithHas：三个便捷形态与 Has 同源。
func TestConveniencePredicatesAgreeWithHas(t *testing.T) {
	if HasSkills() != Has(ModuleSkills) {
		t.Fatalf("HasSkills() = %v 与 Has(%q) = %v 不一致", HasSkills(), ModuleSkills, Has(ModuleSkills))
	}
	if HasApps() != Has(ModuleApps) {
		t.Fatalf("HasApps() = %v 与 Has(%q) = %v 不一致", HasApps(), ModuleApps, Has(ModuleApps))
	}
	if HasConnectors() != Has(ModuleConnectors) {
		t.Fatalf("HasConnectors() = %v 与 Has(%q) = %v 不一致", HasConnectors(), ModuleConnectors, Has(ModuleConnectors))
	}
}

// TestAllModulesReturnsCopy：调用点改写返回值不得污染包级真源。
func TestAllModulesReturnsCopy(t *testing.T) {
	got := AllModules()
	got[0] = "mutated"
	if AllModules()[0] == "mutated" {
		t.Fatal("AllModules() 交出了内部切片：调用点的改写污染了包级真源")
	}
}
