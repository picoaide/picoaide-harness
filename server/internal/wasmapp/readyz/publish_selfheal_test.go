package readyz

// 本文件是**发布闸门同步自愈**（2026-09-23 现场 P0-b）的判据。
//
// 缺陷形态（生产实例实测）：磁盘编译缓存超上限（578263173 > 536870912）⇒ /readyz 503
// ⇒ 未认证的 `POST /api/client/v2/apps/wasm/validate` 由 503 变 401（发布面整体不可用）。
// **删掉缓存条目立刻恢复 200；不删就永不恢复**。根因是两条自锁：
//   - 唯一的回收触发点是"编译作业之后"（compile/compiler.go 的 runJob），
//     而执行侧（runtime 的 wazero 磁盘缓存）也在写缓存 ⇒ "只服务、不发布"的时段缓存只涨；
//   - 超限本身把发布闸门关上 ⇒ 不再有编译作业 ⇒ 回收再也不会被触发。
//
// 本文件钉住的是闸门这一半：命中"编译缓存超上限"时**先同步回收一次再判**。
//
// 变异验证（实跑，见交付报告）：
//   - 删掉 AllowPublish 里对 healCompileCacheOverflow 的调用 ⇒
//     TestAllowPublishReclaimsAndPasses 红（超限时不再自愈，恒 503）；
//   - 把"回收后再判"改成"只看回收有没有报错" ⇒
//     TestAllowPublishReclaimStillOverKeeps503 红；
//   - 把未接线/失败方向改成放行（返回 nil）⇒
//     TestAllowPublishWithoutHookNamesAssemblyGap、TestAllowPublishReclaimFailureKeeps503 红；
//   - 让自愈顺带清掉别的阻塞理由 ⇒ TestAllowPublishKeepsOtherBlockersFailClosed 红；
//   - 超限判定改回编译期常量 ⇒ TestAllowPublishUsesEffectiveCacheLimit 红。

import (
	"strings"
	"sync"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// fakeCache 是可变的编译器水位夹具（含**生效**上限与调用计数）。
type fakeCache struct {
	mu    sync.Mutex
	bytes int64
	max   int64
	files int
	calls int
	// reclaim 是"回收"的行为（默认不动水位，用来构造"回收后仍超限"）。
	reclaim func(removed int, freed int64, err error) (int, int64, error)
}

func newFakeCache(bytes, max int64) *fakeCache {
	return &fakeCache{bytes: bytes, max: max, files: 1}
}

func (f *fakeCache) snapshot() CompilerStatsSnapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return CompilerStatsSnapshot{
		CacheBytes:    f.bytes,
		CacheFiles:    f.files,
		CacheMaxBytes: f.max,
	}
}

// hook 返回一个"回收"钩子：把本次删除数/释放字节交给 reclaim 决定，并计数调用次数。
func (f *fakeCache) hook(removed int, freed int64, err error) func() (int, int64, error) {
	f.reclaim = func(int, int64, error) (int, int64, error) { return removed, freed, err }
	return func() (int, int64, error) {
		f.mu.Lock()
		f.calls++
		f.mu.Unlock()
		return removed, freed, err
	}
}

// healHook 返回一个"真的把水位降下来"的钩子（模拟 compile.ReclaimCache 成功）。
func (f *fakeCache) healHook(to int64) func() (int, int64, error) {
	return func() (int, int64, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.calls++
		before := f.bytes
		f.bytes = to
		return 3, before - to, nil
	}
}

func (f *fakeCache) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// overLimitOpts 造一个"只有缓存超限"的探针配置（其余水位全部健康）。
func overLimitOpts(t *testing.T, f *fakeCache) Options {
	t.Helper()
	o := fixedOpts(MinDiskFreeBytes*4, nil)
	o.Compiler = f.snapshot
	return o
}

// TestAllowPublishSelfLocksWithoutReclaim 是**现场形态的复现**（旧形态）：
// 缓存超限 + 没有同步回收钩子 ⇒ 每一次发布判定都是 503，且**水位一点没降**
// （没有任何人回收）—— 自我锁死，不会自愈。
func TestAllowPublishSelfLocksWithoutReclaim(t *testing.T) {
	f := newFakeCache(int64(limits.CompileCacheMaxBytes)+1, int64(limits.CompileCacheMaxBytes))
	c := New(overLimitOpts(t, f))
	var last *apperr.Error
	for i := 0; i < 5; i++ {
		last = c.AllowPublish()
		if last == nil {
			t.Fatalf("第 %d 次判定：超限且无人回收时必须拒绝发布（现场形态）", i+1)
		}
	}
	if got := f.snapshot().CacheBytes; got != int64(limits.CompileCacheMaxBytes)+1 {
		t.Fatalf("没有回收钩子时水位不得变化：%d", got)
	}
	// 理由必须点名"缓存超上限"（现场排障要的第一个数）。
	if !strings.Contains(strings.Join(reasonsOf(t, last), " "), reasonCompileCacheOver) {
		t.Fatalf("reasons 必须点名缓存超限：%v", reasonsOf(t, last))
	}
}

// TestAllowPublishReclaimsAndPasses：命中超限 ⇒ **先同步回收一次**，回收后达标 ⇒ 放行。
func TestAllowPublishReclaimsAndPasses(t *testing.T) {
	f := newFakeCache(2000, 1000)
	o := overLimitOpts(t, f)
	o.ReclaimCompileCache = f.healHook(500)
	if err := New(o).AllowPublish(); err != nil {
		t.Fatalf("同步回收达标后必须放行：%v", err)
	}
	if got := f.callCount(); got != 1 {
		t.Fatalf("回收钩子必须恰好被调一次：%d", got)
	}
}

// TestAllowPublishReclaimStillOverKeeps503：回收**没报错但水位没降** ⇒ 仍然 503，
// 且理由点名"同步回收后仍超限"并给出三个数（删了几条 / 释放多少 / 现在 vs 上限）。
func TestAllowPublishReclaimStillOverKeeps503(t *testing.T) {
	f := newFakeCache(2000, 1000)
	o := overLimitOpts(t, f)
	o.ReclaimCompileCache = f.hook(0, 0, nil) // 什么都没删（例如条目全被占住）
	err := New(o).AllowPublish()
	if err == nil {
		t.Fatal("回收后仍超限必须继续拒绝发布")
	}
	reason := strings.Join(reasonsOf(t, err), " ")
	for _, want := range []string{"同步回收后仍超限", "2000", "1000"} {
		if !strings.Contains(reason, want) {
			t.Fatalf("可行动文案缺少 %q：%s", want, reason)
		}
	}
	if len(hintsOf(t, err)) < 3 {
		t.Fatalf("仍超限时必须追加可行动 hint：%v", hintsOf(t, err))
	}
}

// TestAllowPublishReclaimFailureKeeps503Actionable：回收**失败** ⇒ 仍然 503，
// 理由带失败原因，hint 指向权限/派生数据（可行动，不是"请联系管理员"）。
func TestAllowPublishReclaimFailureKeeps503Actionable(t *testing.T) {
	f := newFakeCache(2000, 1000)
	o := overLimitOpts(t, f)
	o.ReclaimCompileCache = f.hook(1, 400, errFake("permission denied"))
	err := New(o).AllowPublish()
	if err == nil {
		t.Fatal("回收失败必须继续拒绝发布（fail-closed）")
	}
	reason := strings.Join(reasonsOf(t, err), " ")
	if !strings.Contains(reason, "同步回收失败") || !strings.Contains(reason, "permission denied") {
		t.Fatalf("理由必须点名回收失败与原因：%s", reason)
	}
	hints := strings.Join(hintsOf(t, err), " ")
	if !strings.Contains(hints, limits.CompileCacheDirName) {
		t.Fatalf("hint 必须指向缓存目录（可行动）：%s", hints)
	}
}

// TestAllowPublishWithoutHookNamesAssemblyGap：钩子未接线（最小装配/装配缺失）⇒ 仍然 503，
// 但**必须点名装配缺失**（静默降级会让"为什么不自愈"永远查不到）。
func TestAllowPublishWithoutHookNamesAssemblyGap(t *testing.T) {
	f := newFakeCache(2000, 1000)
	o := overLimitOpts(t, f) // ReclaimCompileCache 保持 nil
	err := New(o).AllowPublish()
	if err == nil {
		t.Fatal("未接线时必须保持旧语义（超限即拒绝）")
	}
	reason := strings.Join(reasonsOf(t, err), " ")
	if !strings.Contains(reason, "未接线回收钩子") {
		t.Fatalf("理由必须点名钩子未接线：%s", reason)
	}
	if !strings.Contains(strings.Join(hintsOf(t, err), " "), "ReclaimCompileCache") {
		t.Fatalf("hint 必须点名缺的那个装配项：%v", hintsOf(t, err))
	}
}

// TestAllowPublishKeepsOtherBlockersFailClosed：自愈**只**解除缓存那一条 ——
// 同时存在别的阻塞理由（磁盘低水位）时，回收成功也仍然 503，且磁盘理由原样保留。
func TestAllowPublishKeepsOtherBlockersFailClosed(t *testing.T) {
	f := newFakeCache(2000, 1000)
	o := fixedOpts(1, nil) // 磁盘远低于红线
	o.Compiler = f.snapshot
	o.ReclaimCompileCache = f.healHook(500)
	err := New(o).AllowPublish()
	if err == nil {
		t.Fatal("磁盘低水位必须继续拒绝发布（自愈不得顺手清掉别的理由）")
	}
	reason := strings.Join(reasonsOf(t, err), " ")
	if !strings.Contains(reason, reasonDiskLow) {
		t.Fatalf("磁盘理由必须保留：%s", reason)
	}
	if strings.Contains(reason, reasonCompileCacheOver) {
		t.Fatalf("缓存理由已被同步回收解除，不该再出现：%s", reason)
	}
}

// TestAllowPublishUsesEffectiveCacheLimit：超限判定必须用**编译器生效上限**
// （快照里的 CacheMaxBytes），不是编译期常量 —— 否则"探针报超限、回收认为没超"
// 会让回收永远删不掉、503 永久化。
func TestAllowPublishUsesEffectiveCacheLimit(t *testing.T) {
	// 生效上限 8192 ⇒ 2000 字节**不算超限**（若错用编译期常量 512 MiB 也不会超，
	// 因此这里用"生效上限更小"的方向：上限 1000、水位 2000 ⇒ 必须超限）。
	small := newFakeCache(2000, 1000)
	o := overLimitOpts(t, small)
	o.ReclaimCompileCache = small.hook(0, 0, errFake("boom"))
	if err := New(o).AllowPublish(); err == nil {
		t.Fatal("生效上限 1000 而水位 2000 ⇒ 必须判超限")
	} else if !strings.Contains(strings.Join(reasonsOf(t, err), " "), "1000") {
		t.Fatalf("理由里的阈值必须是生效上限：%v", reasonsOf(t, err))
	}
	// 生效上限更大 ⇒ 同样水位不超限（这条挡住"错用编译期常量"的反向分叉）。
	big := newFakeCache(2000, 1<<20)
	if err := New(overLimitOpts(t, big)).AllowPublish(); err != nil {
		t.Fatalf("水位 2000 < 生效上限 1 MiB ⇒ 放行：%v", err)
	}
	// 快照没给上限（最小装配）时回落编译期常量：水位超常量 ⇒ 超限。
	legacy := newFakeCache(int64(limits.CompileCacheMaxBytes)+1, 0)
	o = overLimitOpts(t, legacy)
	o.ReclaimCompileCache = legacy.hook(0, 0, nil)
	if err := New(o).AllowPublish(); err == nil {
		t.Fatal("快照未给上限时必须回落编译期常量并判超限")
	}
}

// TestAllowPublishHealthyPathDoesNotReclaim：正常路径不得白跑回收（回收要扫整个目录）。
func TestAllowPublishHealthyPathDoesNotReclaim(t *testing.T) {
	f := newFakeCache(500, 1000)
	o := overLimitOpts(t, f)
	o.ReclaimCompileCache = f.healHook(0)
	if err := New(o).AllowPublish(); err != nil {
		t.Fatalf("健康水位必须放行：%v", err)
	}
	if got := f.callCount(); got != 0 {
		t.Fatalf("健康路径不得触发回收：%d 次", got)
	}
}

// ===== 小工具：从 *apperr.Error 里取 reasons / hints =====

// errFake 是"回收失败"的假错误（避免依赖 errors 包的措辞）。
type errFake string

func (e errFake) Error() string { return string(e) }

func reasonsOf(t *testing.T, e *apperr.Error) []string {
	t.Helper()
	if e == nil {
		t.Fatal("期望错误，得到 nil")
	}
	raw, ok := e.Details["reasons"].([]string)
	if !ok || len(raw) == 0 {
		t.Fatalf("details.reasons 必须是 []string 且非空：%#v", e.Details["reasons"])
	}
	return raw
}

func hintsOf(t *testing.T, e *apperr.Error) []string {
	t.Helper()
	if len(e.Hints) == 0 {
		t.Fatal("拒绝必须带 hints")
	}
	return e.Hints
}
