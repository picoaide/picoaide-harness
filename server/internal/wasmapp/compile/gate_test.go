package compile

import (
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件覆盖**上传频率闸门**（§4.3 第 147 行「上传频率」/ §10.3 第 36 项）：
//
//	每用户 30 次/小时（滑动窗口） + 同时最多 1 次编译中的上传
//
// 变异方式：
//   - 去掉频率判据（改成恒 true）⇒ TestAllowUploadRejects31st 红；
//   - 去掉并发判据 ⇒ TestAllowUploadRejectsConcurrentSecond 红；
//   - 把滑动窗口改成"固定窗口"⇒ TestAllowUploadSlidingWindowAcrossHourBoundary 红
//     （固定窗口在整点边界上允许 2× 突发，这是本用例专门钉的）；
//   - 让被拒的请求也计数 ⇒ TestRejectedUploadDoesNotConsumeQuota 红。

func TestAllowUploadAllowsUpToHourlyLimit(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)
	now := time.Now()

	for i := 0; i < limits.UploadRatePerHour; i++ {
		ok, retry := c.AllowUpload(1, now)
		if !ok {
			t.Fatalf("第 %d 次（≤ 上限 %d）应放行，却被拒（retryAfter=%v）", i+1, limits.UploadRatePerHour, retry)
		}
		c.ReleaseUpload(1) // 每次编译立刻结束 ⇒ 并发不成为瓶颈，专测频率
	}
	used, inflight := c.UploadState(1, now)
	if used != limits.UploadRatePerHour || inflight != 0 {
		t.Fatalf("用量统计不符：used=%d inflight=%d", used, inflight)
	}
}

func TestAllowUploadRejects31st(t *testing.T) {
	// §10.3 第 36 项的判据："第 31 次 429"。
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)
	now := time.Now()

	for i := 0; i < limits.UploadRatePerHour; i++ {
		if ok, _ := c.AllowUpload(1, now); !ok {
			t.Fatalf("第 %d 次应放行", i+1)
		}
		c.ReleaseUpload(1)
	}
	ok, retry := c.AllowUpload(1, now)
	if ok {
		t.Fatal("第 31 次必须被拒（每用户 30 次/小时）")
	}
	// retryAfter 必须指向"最早那次滑出窗口"的时刻，而不是一个凭空的值。
	if retry <= 0 || retry > time.Hour {
		t.Fatalf("retryAfter 应在 (0, 1h] 内，实际 %v", retry)
	}
}

func TestAllowUploadSlidingWindowAcrossHourBoundary(t *testing.T) {
	// 滑动窗口的关键性质：**不做整点重置**。
	// 用满 30 次后，过 30 分钟仍然不能再用（固定窗口实现会在这里放行 30 次 = 2× 突发）。
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)
	base := time.Now()
	for i := 0; i < limits.UploadRatePerHour; i++ {
		if ok, _ := c.AllowUpload(7, base); !ok {
			t.Fatalf("第 %d 次应放行", i+1)
		}
		c.ReleaseUpload(7)
	}
	if ok, _ := c.AllowUpload(7, base.Add(30*time.Minute)); ok {
		t.Fatal("半小时后仍在滑动窗口内，必须继续被拒（固定窗口实现会在这里误放行）")
	}
	// 满一小时后最早那次滑出 ⇒ 放行一次。
	if ok, retry := c.AllowUpload(7, base.Add(time.Hour+time.Second)); !ok {
		t.Fatalf("窗口滑过后应放行，实际被拒（retryAfter=%v）", retry)
	}
}

func TestAllowUploadRejectsConcurrentSecond(t *testing.T) {
	// §10.3 第 36 项第二条："并发上传第 2 个被拒"（同时最多 1 次编译中的上传）。
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)
	now := time.Now()

	ok, _ := c.AllowUpload(42, now)
	if !ok {
		t.Fatal("第一个上传应放行")
	}
	if ok, retry := c.AllowUpload(42, now); ok {
		t.Fatal("同一用户同时的第二个上传必须被拒")
	} else if retry <= 0 {
		t.Errorf("并发被拒应给出 retryAfter：%v", retry)
	}
	// 释放后又能进（并发占位是"在编译中"的计数，不是永久锁）。
	c.ReleaseUpload(42)
	if ok, _ := c.AllowUpload(42, now); !ok {
		t.Fatal("释放并发占位后应能再次上传")
	}
}

func TestRejectedUploadDoesNotConsumeQuota(t *testing.T) {
	// 被拒的请求（并发维度）**不消耗**小时额度：否则"同时点两次"会白白吃掉一次
	// 用户能感知的额度（30 次/小时）。
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)
	now := time.Now()

	if ok, _ := c.AllowUpload(9, now); !ok {
		t.Fatal("第一次应放行")
	}
	for i := 0; i < 5; i++ {
		if ok, _ := c.AllowUpload(9, now); ok {
			t.Fatal("并发被拒的调用不该放行")
		}
	}
	used, inflight := c.UploadState(9, now)
	if used != 1 {
		t.Errorf("被拒的调用不该计入小时额度：used=%d（期望 1）", used)
	}
	if inflight != 1 {
		t.Errorf("并发占位应为 1：%d", inflight)
	}
}

func TestAllowUploadIsPerUser(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)
	now := time.Now()

	for i := 0; i < limits.UploadRatePerHour; i++ {
		if ok, _ := c.AllowUpload(100, now); !ok {
			t.Fatalf("用户 100 第 %d 次应放行", i+1)
		}
		c.ReleaseUpload(100)
	}
	if ok, _ := c.AllowUpload(100, now); ok {
		t.Fatal("用户 100 应已达上限")
	}
	// 另一个用户不受影响（配额是按用户的，不是全局的）。
	if ok, _ := c.AllowUpload(200, now); !ok {
		t.Fatal("用户 200 不该受用户 100 的配额影响")
	}
}

func TestAllowUploadConcurrencyIsPerUser(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)
	now := time.Now()
	if ok, _ := c.AllowUpload(1, now); !ok {
		t.Fatal("用户 1 第一个应放行")
	}
	// 用户 1 正在编译中，但用户 2 的各占各的并发位。
	if ok, _ := c.AllowUpload(2, now); !ok {
		t.Fatal("并发上限是按用户的：用户 2 不该被用户 1 的编译挡住")
	}
}

func TestAllowUploadZeroTimeUsesNow(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)
	if ok, _ := c.AllowUpload(1, time.Time{}); !ok {
		t.Fatal("now 传零值应回落 time.Now() 而不是拒绝")
	}
}

func TestReleaseUploadWithoutAllowIsSafe(t *testing.T) {
	// ReleaseUpload 会被 defer 调用；未 Allow 就 Release 不得把计数压成负数。
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)
	c.ReleaseUpload(12345)
	c.ReleaseUpload(12345)
	if _, inflight := c.UploadState(12345, time.Now()); inflight != 0 {
		t.Fatalf("并发计数不得为负：%d", inflight)
	}
	// 之后仍应能正常上传（证明上面的误调用没破坏状态）。
	if ok, _ := c.AllowUpload(12345, time.Now()); !ok {
		t.Fatal("误 Release 之后应仍能上传")
	}
}

func TestUploadLimitValueComesFromLimits(t *testing.T) {
	// §4 铁律：数值唯一真源是 limits。这里锁住"本包没有偷偷改上限"。
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)
	if c.opt.UploadRatePerHour != limits.UploadRatePerHour {
		t.Errorf("默认频率上限应取自 limits：%d ≠ %d", c.opt.UploadRatePerHour, limits.UploadRatePerHour)
	}
	if c.opt.UploadConcurrentCompiles != limits.UploadConcurrentCompiles {
		t.Errorf("默认并发上限应取自 limits：%d ≠ %d", c.opt.UploadConcurrentCompiles, limits.UploadConcurrentCompiles)
	}
	if limits.UploadRatePerHour != 30 {
		t.Errorf("设计文档 §4.3 规定 30 次/小时，limits 却是 %d", limits.UploadRatePerHour)
	}
}
