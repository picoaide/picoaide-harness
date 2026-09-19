package main

import (
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/memprofile"
)

// 本文件是「平台限制项」**保存路径**的装配级门禁（审计 R1-rt-8）。
//
// 现场：四笔账里没有 SQLite 页缓存这一笔，而控制台允许
// `appdb_cache_kib=65536` + `app_db_readers=16` + `max_instances=256`
// ⇒ (1+16) × 64 MiB × 256 ≈ 272 GiB 的理论常驻，保存判据却仍然通过。
//
// 变异验证（改回缺陷实现时哪条必红）：
//   - 把 applimits.BudgetFor 的 AppDBPageCachePerHandleBytes 去掉 ⇒
//     TestLimitsSaveRejectsOverBudgetAppDBCache 必红（保存被放行）；
//   - 把 wasmLimitsHolder.Plan() 里的 AppDBPageCachePerHandleBytes 去掉 ⇒
//     TestLimitsPlanCarriesEffectivePageCache 必红（启动自检与保存判据两套口径）。

// TestLimitsSaveRejectsOverBudgetAppDBCache：极大页缓存 + 大并发的组合**保存时必须被拒**。
//
// 判据不依赖注入：这条限制项组合在任何真实机器上都超水位（272 GiB 级），
// 只有在"可用内存读不到"或"机器内存 > 411 GiB"时才跳过（并如实说明原因）。
func TestLimitsSaveRejectsOverBudgetAppDBCache(t *testing.T) {
	avail := readMemoryAvailability()
	if !avail.Known() {
		t.Skipf("本机读不到可用内存（%s），保存路径按设计跳过水位判定", avail.Detail)
	}
	// 被拒的那组账约 288 GiB；水位是可用内存的 70% ⇒ 需要 > 411 GiB 才可能通过。
	if avail.Bytes > 411<<30 {
		t.Skipf("本机可用内存 %d GiB 大于被测组合的账（测试前提不成立）", avail.Bytes>>30)
	}

	h := newWasmLimitsHolder(nil, memprofile.Default())
	huge := applimits.Defaults()
	huge.MaxInstances = applimits.MaxInstances
	huge.AppDBCacheKiB = applimits.MaxAppDBCacheKiB
	huge.AppDBReaders = limits.AppDBReadersMax
	if err := huge.Validate(); err != nil {
		t.Fatalf("这组值本身必须合法（否则测的不是保存判据）：%v", err)
	}
	_, aerr := h.Apply(huge.Encode())
	if aerr == nil {
		t.Fatal("272 GiB 级页缓存组合必须被保存判据拒绝（页缓存不进账 = 控制台可把机器配爆）")
	}
	if aerr.Code != apperr.CodeValidation {
		t.Fatalf("拒绝必须是校验类错误（控制台按它渲染提示），得到 %s：%s", aerr.Code, aerr.Message)
	}
	body := aerr.JSON()
	for _, want := range []string{"appdb_cache_bytes", "total_bytes", "appdb_cache_kib"} {
		if !strings.Contains(body, want) {
			t.Fatalf("错误信封应给出可操作明细/提示（%s）：%s", want, body)
		}
	}
	// 明细里的页缓存这笔必须是**真的算过**的数（变异：BudgetFor 不算它 ⇒ 这里是 0 ⇒ 必红）。
	wantCache := int64(1+limits.AppDBReadersMax) * (int64(applimits.MaxAppDBCacheKiB) << 10) * int64(applimits.MaxInstances)
	gotCache, ok := aerr.Details["appdb_cache_bytes"].(int64)
	if !ok {
		t.Fatalf("明细里缺少页缓存这笔的数值：%#v", aerr.Details)
	}
	if gotCache != wantCache {
		t.Fatalf("页缓存这笔 = %d（%d MiB），期望 %d（%d MiB）—— 页缓存没进保存判据的账",
			gotCache, gotCache>>20, wantCache, wantCache>>20)
	}
	if total, ok := aerr.Details["total_bytes"].(int64); !ok || total < gotCache {
		t.Fatalf("总账必须含页缓存这笔：total=%v cache=%d", aerr.Details["total_bytes"], gotCache)
	}
	// 保存被拒 ⇒ 当前生效值不变（不许"拒了但已经改了一半"）。
	if got := h.Get(); got.MaxInstances != applimits.Defaults().MaxInstances {
		t.Fatalf("被拒的保存不得改动生效值：%s", got.Encode())
	}
}

// TestLimitsPlanCarriesEffectivePageCache：启动自检用的 Plan 必须带上**当前生效**的
// 页缓存单价（否则保存判据算 272 GiB、启动自检却只算四笔 —— 两条口径分叉）。
func TestLimitsPlanCarriesEffectivePageCache(t *testing.T) {
	h := newWasmLimitsHolder(nil, memprofile.Default())
	l := h.Get()
	plan := h.Plan()
	if want := l.AppDBPageCachePerHandleBytes(); plan.AppDBPageCachePerHandleBytes != want {
		t.Fatalf("Plan 的页缓存单价 = %d，生效值 = %d（装配漏接）", plan.AppDBPageCachePerHandleBytes, want)
	}
	// 改一个旋钮（appdb_cache_kib 翻倍）⇒ Plan 必须跟着变（不是编译期常量）。
	next := l
	next.AppDBCacheKiB = l.AppDBCacheKiB * 2
	if _, aerr := h.Apply(next.Encode()); aerr != nil {
		t.Fatalf("翻倍页缓存的组合应仍在合法范围内：%v", aerr)
	}
	if got, want := h.Plan().AppDBPageCachePerHandleBytes, next.AppDBPageCachePerHandleBytes(); got != want {
		t.Fatalf("改 appdb_cache_kib 后 Plan 单价 = %d，期望 %d", got, want)
	}
}
