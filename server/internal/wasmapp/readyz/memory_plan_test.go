package readyz_test

import (
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/readyz"
)

// 本文件是「内存四笔账改按部署档位计算」的回归（2026-09-18）。
//
// 变异验证（交付时实跑过，勿删）：
//   - 把 ComputeMemoryBudgetFor 里的 plan 换成 DefaultMemoryPlan()（忽略入参）
//     ⇒ TestPlanScalesFourAccounts 必红；
//   - 把 withDefaults 的回落去掉 ⇒ TestZeroPlanFallsBackToDefault 必红。

// TestDefaultPlanPreservesHistoricalNumbers：默认档必须与历史（编译期常量）逐一相同 ——
// 不设档位的部署行为不得改变。
func TestDefaultPlanPreservesHistoricalNumbers(t *testing.T) {
	b := readyz.ComputeMemoryBudget(1 << 40) // 大内存，只为拿分解值
	if b.Instances != readyz.InstancePoolBytes {
		t.Fatalf("默认档实例池 = %d，历史值 = %d", b.Instances, readyz.InstancePoolBytes)
	}
	if b.CacheResident != readyz.CacheResidentBytes {
		t.Fatalf("默认档缓存驻留 = %d，历史值 = %d", b.CacheResident, readyz.CacheResidentBytes)
	}
	if b.CompilePeak != readyz.CompilePeakBytes {
		t.Fatalf("默认档编译峰值 = %d，历史值 = %d", b.CompilePeak, readyz.CompilePeakBytes)
	}
	if b.UploadPeak != int64(limits.UploadPeakPerUploadBytes) {
		t.Fatalf("默认档上传峰值 = %d，历史值 = %d", b.UploadPeak, limits.UploadPeakPerUploadBytes)
	}
	if b.Profile != "default" {
		t.Fatalf("默认档名应为 default，得到 %q", b.Profile)
	}
}

// TestPlanScalesFourAccounts：换档位必须真的改变四笔账（而不是只改个名字）。
func TestPlanScalesFourAccounts(t *testing.T) {
	const available = 992 << 20
	small := readyz.MemoryPlan{
		Profile:             "small",
		Instances:           3,
		InstanceMemoryBytes: 1024 * 64 << 10, // 64 MiB（与 R22 一致）
		ModuleCacheBytes:    64 << 20,
	}
	b := readyz.ComputeMemoryBudgetFor(available, small)
	// 3 × 64 MiB = 192 MiB；+256 +118 +64 = 630 MiB
	if want := int64(630 << 20); b.Total != want {
		t.Fatalf("small 档 total = %dMiB，期望 %dMiB", b.Total>>20, want>>20)
	}
	if !b.OK {
		t.Fatalf("small 档应通过 992 MiB 机器的水位检查：limit=%dMiB", b.Limit>>20)
	}
	if b.Profile != "small" {
		t.Fatalf("档位名应透传，得到 %q", b.Profile)
	}
	// 同一台机器上默认档必须仍被拒（判据未放宽，只是多了一个可选档位）。
	def := readyz.ComputeMemoryBudgetFor(available, readyz.DefaultMemoryPlan())
	if def.OK {
		t.Fatalf("默认档不应通过：total=%dMiB limit=%dMiB", def.Total>>20, def.Limit>>20)
	}
	if def.Total <= b.Total {
		t.Fatalf("默认档的账必须大于 small 档：%d vs %d", def.Total, b.Total)
	}
}

// TestZeroPlanFallsBackToDefault：只填关心的一两项也必须算出完整的账（零值回落默认）。
func TestZeroPlanFallsBackToDefault(t *testing.T) {
	only := readyz.MemoryPlan{Profile: "partial", Instances: 1}
	b := readyz.ComputeMemoryBudgetFor(8<<30, only)
	def := readyz.DefaultMemoryPlan()
	// 只声明了并发 1：实例池 = 1 × 默认单实例内存；其余两笔回落默认。
	if want := def.InstanceMemoryBytes; b.Instances != want {
		t.Fatalf("并发 1 × 默认实例内存 = %d，得到 %d", want, b.Instances)
	}
	if b.CacheResident != def.ModuleCacheBytes || b.CompilePeak != def.CompilePeakBytes {
		t.Fatalf("未填的缓存/编译峰值应回落默认：%+v", b)
	}
	if !b.OK {
		t.Fatalf("8 GiB 可用内存下部分档位也应通过：total=%dMiB", b.Total>>20)
	}
}

// TestCheckStartupMemoryForCarriesProfile：错误信封必须带档位名（排障时先看它）。
func TestCheckStartupMemoryForCarriesProfile(t *testing.T) {
	_, err := readyz.CheckStartupMemoryFor(1, readyz.DefaultMemoryPlan())
	if err == nil {
		t.Fatal("极小可用内存 + 默认档 ⇒ 必须出错")
	}
	msg := err.Error()
	if !strings.Contains(msg, "拒绝启动") {
		t.Fatalf("错误文案应说明拒绝启动：%s", msg)
	}
	// hints/details 走 JSON 信封（Error() 只渲染 code+message），排障面要看它们。
	body := err.JSON()
	if !strings.Contains(body, "PICOAI_WASM_MEMORY_PROFILE") {
		t.Fatalf("错误应提示可用档位（环境变量名）：%s", body)
	}
	if !strings.Contains(body, `"profile":"default"`) {
		t.Fatalf("错误应带本次判定用的档位名：%s", body)
	}
	if _, err := readyz.CheckStartupMemoryFor(0, readyz.DefaultMemoryPlan()); err != nil {
		t.Fatalf("读不到可用内存（≤0）时不得拒绝启动：%v", err)
	}
}
