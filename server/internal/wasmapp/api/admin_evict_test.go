package api

import (
	"net/http"
	"sync"
	"testing"
)

// ===========================================================================
// P1-8：管理端下架 / 冻结必须逐出进程内驻留
//
// 现场（2026-09-19 审计）：发布者路径（api/release.go 的 setPublished / deleteApp）
// 会调用 h.evictApp，**管理端不会** —— 而文档与装配注释都声称"下架/冻结/删除"
// 都在内。唯一门禁是 cmd/server 的一条源码 grep（断言 `OnAppEvict: func(...)`
// 这行字符串还在），它**分不清 handler 有没有真的调用**，所以缺陷一路绿灯。
//
// 本文件用**计数假钩子**做行为断言（handler → 钩子），装配期"钩子 → appserver"
// 那一段由 cmd/server 的 TestWasmAdminDisposalEvictsRuntimeCache 用真装配 + 真模块
// 缓存断言（两条合起来覆盖整条链，不再需要 grep）。
//
// 变异验证（改回旧实现必红）：
//   - 去掉 adminUnpublish 里的 h.evictApp(appID) ⇒ TestAdminUnpublishEvictsRuntime 红；
//   - 去掉 adminFreeze 里的 h.evictApp(appID) ⇒ TestAdminFreezeEvictsRuntime 红；
//   - 把逐出挪到"失败路径"上（例如 SetWasmAppEnabled 失败之后）⇒ 两个用例的
//     "不该逐出的场景"断言红。
// ---------------------------------------------------------------------------

// evictRecorder 是注入的计数假钩子（线程安全：请求在测试 goroutine 里同步完成，
// 但保留锁以免未来改成并发用例时出现数据竞争）。
type evictRecorder struct {
	mu    sync.Mutex
	calls []string
}

func (r *evictRecorder) hook(appID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, appID)
}

func (r *evictRecorder) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.calls...)
}

func (r *evictRecorder) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = nil
}

// newEvictEnv 造一个带计数逐出钩子的环境。
func newEvictEnv(t *testing.T) (*testEnv, *evictRecorder) {
	t.Helper()
	rec := &evictRecorder{}
	e := newTestEnv(t, func(o *Options) { o.OnAppEvict = rec.hook })
	return e, rec
}

// TestAdminUnpublishEvictsRuntime：管理员下架 ⇒ 恰好逐出一次该应用。
func TestAdminUnpublishEvictsRuntime(t *testing.T) {
	e, rec := newEvictEnv(t)
	e.publishOK(e.tokens["alice"], "evict-unpub", "1.0.0", testGuestModule(t), goodConfig())

	e.decodeJSON(e.req(http.MethodPost, "/api/server/admin/wasm-apps/evict-unpub/unpublish", "", nil),
		http.StatusOK, &struct{}{})
	if got := rec.snapshot(); len(got) != 1 || got[0] != "evict-unpub" {
		t.Fatalf("管理员下架必须逐出一次 evict-unpub，得到 %v", got)
	}
	// 幂等路径（已是下架态）不再重复逐出：没有状态变更就没有"刚空出来"的驻留。
	rec.reset()
	e.decodeJSON(e.req(http.MethodPost, "/api/server/admin/wasm-apps/evict-unpub/unpublish", "", nil),
		http.StatusOK, &struct{}{})
	if got := rec.snapshot(); len(got) != 0 {
		t.Fatalf("重复下架不应再次逐出，得到 %v", got)
	}
	// 上架**不**逐出（逐出只对"停止服务"的处置有意义；上架后首个请求会重新编译）。
	e.decodeJSON(e.req(http.MethodPost, "/api/server/admin/wasm-apps/evict-unpub/publish", "", nil),
		http.StatusOK, &struct{}{})
	if got := rec.snapshot(); len(got) != 0 {
		t.Fatalf("上架不应逐出，得到 %v", got)
	}
}

// TestAdminFreezeEvictsRuntime：管理员冻结 ⇒ 恰好逐出一次；解冻不逐出。
func TestAdminFreezeEvictsRuntime(t *testing.T) {
	e, rec := newEvictEnv(t)
	e.publishOK(e.tokens["alice"], "evict-freeze", "1.0.0", testGuestModule(t), goodConfig())

	e.decodeJSON(e.req(http.MethodPost, "/api/server/admin/wasm-apps/evict-freeze/freeze", "", nil),
		http.StatusOK, &struct{}{})
	if got := rec.snapshot(); len(got) != 1 || got[0] != "evict-freeze" {
		t.Fatalf("管理员冻结必须逐出一次 evict-freeze，得到 %v", got)
	}
	// 重复冻结（已是冻结态）不逐出。
	rec.reset()
	e.decodeJSON(e.req(http.MethodPost, "/api/server/admin/wasm-apps/evict-freeze/freeze", "", nil),
		http.StatusOK, &struct{}{})
	if got := rec.snapshot(); len(got) != 0 {
		t.Fatalf("重复冻结不应再次逐出，得到 %v", got)
	}
	// 解冻不逐出（冻结期间本就没有驻留；解冻也还没恢复服务）。
	e.decodeJSON(e.req(http.MethodPost, "/api/server/admin/wasm-apps/evict-freeze/freeze", "",
		map[string]any{"frozen": false}), http.StatusOK, &struct{}{})
	if got := rec.snapshot(); len(got) != 0 {
		t.Fatalf("解冻不应逐出，得到 %v", got)
	}
}

// TestEvictHookAbsentIsNotFatal：钩子未注入时管理端处置必须照常成功
// （本包对 appserver 零依赖；内存由空闲 TTL 兜底，见 evictApp 的注释）。
func TestEvictHookAbsentIsNotFatal(t *testing.T) {
	e := newTestEnv(t) // 不注入 OnAppEvict
	e.publishOK(e.tokens["alice"], "no-hook", "1.0.0", testGuestModule(t), goodConfig())
	e.decodeJSON(e.req(http.MethodPost, "/api/server/admin/wasm-apps/no-hook/unpublish", "", nil),
		http.StatusOK, &struct{}{})
}
