package api

import (
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/readyz"
)

// 发布面水位闸门的回归用例（审计 P1-1：`readyz.AllowPublish` 曾**零调用方** ——
// 磁盘低于 1 GiB / 编译缓存超上限 / 编译队列满时，发布照样进入编译与落库）。
//
// 变异验证（改回缺陷实现时哪条必红）：
//   - 删掉 publish() 里的 `h.publishGate()` 调用 ⇒
//     TestPublishRejectedBelowDiskWatermark、TestPublishGateWritesNoReleaseAndNoAudit 必红；
//   - 删掉 validate() 里的调用 ⇒ TestValidateIsGatedToo 必红；
//   - 把 h.opt.Ready 换成恒返回 nil 的实现 ⇒ 上面三条必红（健康态用例不受影响）。

// lowDiskChecker 造一个"磁盘水位远低于红线"的探针（1 字节 « MinDiskFreeBytes=1 GiB）。
//
// 用注入的 DiskFree 而不是真去改磁盘：闸门判据必须确定性可测。
func lowDiskChecker(t *testing.T) *readyz.Checker {
	t.Helper()
	return readyz.New(readyz.Options{
		DataRoot: t.TempDir(),
		DiskFree: func(string) (int64, error) { return 1, nil },
	})
}

// healthyChecker 造一个健康水位的探针。
func healthyChecker(t *testing.T) *readyz.Checker {
	t.Helper()
	return readyz.New(readyz.Options{
		DataRoot: t.TempDir(),
		DiskFree: func(string) (int64, error) { return readyz.MinDiskFreeBytes * 4, nil },
	})
}

// TestPublishRejectedBelowDiskWatermark：低水位 ⇒ 503 信封（暂时不可用），
// 且**不做任何实际工作**（不落版本行、不写审计、不走进编译）。
func TestPublishRejectedBelowDiskWatermark(t *testing.T) {
	env := newTestEnv(t, func(o *Options) { o.Ready = lowDiskChecker(t) })
	wasm := testGuestModule(t)
	auditBefore := env.countAudit()

	w := env.req(http.MethodPost, "/api/client/v2/apps/wasm/gate-app/releases",
		env.tokens["alice"], env.payload("gate-app", "1.0.0", wasm, goodConfig()))
	eb := env.decodeErr(w, http.StatusServiceUnavailable)
	if eb.Error.Code != string(apperr.CodeInternal) {
		t.Fatalf("code=%s want INTERNAL（复用既有码；503 由 AllowPublish 显式指定）", eb.Error.Code)
	}
	if eb.Error.Details["reasons"] == nil {
		t.Fatalf("拒绝必须带具体原因（运维/AI 要据此知道挡在哪一项）：%s", w.Body.String())
	}
	if got := env.countReleases("gate-app"); got != 0 {
		t.Fatalf("被闸门拒绝的发布不得产生版本行：%d", got)
	}
	if got := env.countAudit(); got != auditBefore {
		t.Fatalf("被闸门拒绝的发布不得写审计（与限流/占位被拒同口径）：%d → %d", auditBefore, got)
	}
}

// TestPublishGateWritesNoReleaseAndNoAudit 是上一条的"同一断言、显式命名"版本：
// 把两条最关键的副作用（库里出现行、审计出现条目）单独钉住，避免以后有人把断言删了。
func TestPublishGateWritesNoReleaseAndNoAudit(t *testing.T) {
	env := newTestEnv(t, func(o *Options) { o.Ready = lowDiskChecker(t) })
	wasm := testGuestModule(t)
	before := env.countAudit()
	w := env.req(http.MethodPost, "/api/client/v2/apps/wasm/gate-app-2/releases",
		env.tokens["alice"], env.payload("gate-app-2", "1.0.0", wasm, goodConfig()))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d want 503; body=%s", w.Code, w.Body.String())
	}
	if got := env.countReleases("gate-app-2"); got != 0 {
		t.Fatalf("release 行数=%d want 0", got)
	}
	if got := env.countAudit(); got != before {
		t.Fatalf("审计条数=%d want %d", got, before)
	}
}

// TestPublishPassesWithHealthyChecker：健康水位 ⇒ 闸门放行，发布链路照常（201 + 落行）。
// 这条同时防"闸门装反了"（恒拒绝）。
func TestPublishPassesWithHealthyChecker(t *testing.T) {
	env := newTestEnv(t, func(o *Options) { o.Ready = healthyChecker(t) })
	wasm := testGuestModule(t)
	env.publishOK(env.tokens["alice"], "healthy-app", "1.0.0", wasm, goodConfig())
	if got := env.countReleases("healthy-app"); got != 1 {
		t.Fatalf("健康水位下发布应落一行：%d", got)
	}
}

// TestValidateIsGatedToo：预检也过闸门。
//
// 理由（写进 publish.go 的注释）：validate 不落盘、不占执行槽，但它**真的编译**
// （占单进程串行编译池 + 写编译缓存）；而闸门要挡的"磁盘低水位/缓存超上限"正是
// "再来一次编译会更糟"的条件。只闸 publish 会留下用 validate 继续消耗编译资源的旁路。
func TestValidateIsGatedToo(t *testing.T) {
	env := newTestEnv(t, func(o *Options) { o.Ready = lowDiskChecker(t) })
	wasm := testGuestModule(t)
	auditBefore := env.countAudit()

	w := env.req(http.MethodPost, "/api/client/v2/apps/wasm/validate",
		env.tokens["alice"], env.payload("gate-app", "1.0.0", wasm, goodConfig()))
	env.decodeErr(w, http.StatusServiceUnavailable)
	// 预检本来就不落盘、不进审计（§4.9）—— 闸门拒绝时更不该有。
	if got := env.countReleases("gate-app"); got != 0 {
		t.Fatalf("预检不得落版本行：%d", got)
	}
	if got := env.countAudit(); got != auditBefore {
		t.Fatalf("预检不得写审计：%d → %d", auditBefore, got)
	}
}

// TestValidatePassesWithHealthyChecker：健康水位下预检照常 200（闸门不是恒拒绝）。
func TestValidatePassesWithHealthyChecker(t *testing.T) {
	env := newTestEnv(t, func(o *Options) { o.Ready = healthyChecker(t) })
	wasm := testGuestModule(t)
	w := env.req(http.MethodPost, "/api/client/v2/apps/wasm/validate",
		env.tokens["alice"], env.payload("healthy-app", "1.0.0", wasm, goodConfig()))
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d want 200; body=%s", w.Code, w.Body.String())
	}
}

// TestPublishGateNilCheckerSkips：Ready 为 nil ⇒ 不校验（保留最小装配与既有测试）。
func TestPublishGateNilCheckerSkips(t *testing.T) {
	env := newTestEnv(t) // 不注入 Ready
	if env.h.opt.Ready != nil {
		t.Fatal("默认装配不该有 Ready")
	}
	wasm := testGuestModule(t)
	env.publishOK(env.tokens["alice"], "no-gate-app", "1.0.0", wasm, goodConfig())
}
