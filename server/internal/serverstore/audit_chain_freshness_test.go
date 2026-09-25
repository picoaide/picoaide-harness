package serverstore

// R16C-03 的**读侧**判据（执行者的周期化在 internal/auditchain）。
//
// 缺陷形态：`/server-info` 的 `audit.chain_intact` 是"启动那一刻"的结论，而修前
// 没有任何字段表达"这条结论已经多久没刷新了" ⇒ 长跑实例（容器几个月不重启）里，
// 过期结论看起来与实时结论一模一样。修法给了两个执行者（启动 + 周期），并把
// **新鲜度**（AgeSeconds / Stale）与执行者（Source / Checks / Rows / DurationMS）
// 一起放进同一个结果缓存。
//
// 判据：① 刚校验过 ⇒ 不 stale；② 结论超过 AuditChainStaleAfter ⇒ stale；
// ③ 从未校验过 ⇒ stale（不知道就别声称是新的）；④ 校验**本身**失败（读不出来）
// 与"链断了"是两件事，都必须如实上报。

import (
	"database/sql"
	"errors"
	"testing"
	"time"
)

func TestAuditChainStatusReportsFreshness(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()

	// 注入时钟：新鲜度是"读的时候算的"，用 sleep 造陈旧结论只能写成 flaky 用例。
	prevClock := auditChainClock
	now := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	auditChainClock = func() time.Time { return now }
	t.Cleanup(func() { auditChainClock = prevClock })

	if err := AuditLog(db, "admin", "act_fresh", "d"); err != nil {
		t.Fatal(err)
	}
	if broken, err := RunAndRecordAuditChainCheck(db); err != nil || broken != 0 {
		t.Fatalf("干净链校验: broken=%d err=%v", broken, err)
	}
	d := AuditChainStatusDetail()
	if !d.Checked || !d.Intact || d.Stale {
		t.Fatalf("刚校验过的结论不该 stale: %+v", d)
	}
	if d.Source != "startup" {
		t.Fatalf("Source = %q, want startup（执行者标识）", d.Source)
	}
	if d.Checks != 1 {
		t.Fatalf("Checks = %d, want 1", d.Checks)
	}
	if d.AgeSeconds != 0 {
		t.Fatalf("AgeSeconds = %d, want 0", d.AgeSeconds)
	}

	// 周期执行者再跑一次：执行者与规模都要跟着更新（Rows 是"这一轮扫了多少行"）。
	rows := int64(0)
	var err error
	if rows, err = auditRowCount(db); err != nil {
		t.Fatal(err)
	}
	if broken, verr := RunAndRecordPeriodicAuditChainCheck(db); verr != nil || broken != 0 {
		t.Fatalf("周期链校验: broken=%d err=%v", broken, verr)
	}
	d = AuditChainStatusDetail()
	if d.Source != "periodic" || d.Checks != 2 {
		t.Fatalf("周期校验没有刷新执行者/次数: source=%q checks=%d", d.Source, d.Checks)
	}
	if d.Rows != rows {
		t.Fatalf("Rows = %d, want %d（扫描规模必须如实上报——全表扫描的开销要可见）", d.Rows, rows)
	}

	// 超过保质期 ⇒ stale。
	now = now.Add(AuditChainStaleAfter + time.Minute)
	d = AuditChainStatusDetail()
	if !d.Stale {
		t.Fatalf("结论超过 %s 后必须 stale: %+v", AuditChainStaleAfter, d)
	}
	if d.AgeSeconds <= int64(AuditChainStaleAfter.Seconds()) {
		t.Fatalf("AgeSeconds = %d, want > %d", d.AgeSeconds, int64(AuditChainStaleAfter.Seconds()))
	}
	// 但"过期"不等于"链断了"：intact 仍报最近一次的结论（调用方据 stale 判断可信度）。
	if !d.Intact {
		t.Fatalf("过期不该把 intact 改写成 false（两件事必须分开报）: %+v", d)
	}

	// 篡改 ⇒ 断链结论 + 仍然是最新（不 stale）。
	if _, err := db.Exec(`UPDATE audit_logs SET detail = 'TAMPERED' WHERE action = 'act_fresh'`); err != nil {
		t.Fatal(err)
	}
	auditChainClock = time.Now
	// 注意既有契约：断链时 VerifyAuditChain **同时**返回 brokenID 与 error
	// （"audit hash mismatch"），所以这里只看 brokenID。
	if broken, _ := RunAndRecordPeriodicAuditChainCheck(db); broken == 0 {
		t.Fatalf("篡改后必须报断链: broken=%d", broken)
	}
	d = AuditChainStatusDetail()
	if d.Intact || d.BrokenID == 0 || d.Stale {
		t.Fatalf("篡改后的结论: %+v", d)
	}
}

func TestAuditChainStatusUncheckedIsStale(t *testing.T) {
	// 从未校验过：AgeSeconds = -1 且 stale=true（"不知道"不得看起来像"是新的"）。
	// 用重置入口把缓存清成"本进程没校验过"的状态。
	resetAuditChainStatusForTest()
	d := AuditChainStatusDetail()
	if d.Checked {
		t.Fatal("重置后 Checked 应为 false")
	}
	if !d.Stale {
		t.Fatal("从未校验过的结论必须 stale=true")
	}
	if d.AgeSeconds != -1 {
		t.Fatalf("AgeSeconds = %d, want -1（未校验）", d.AgeSeconds)
	}
}

func TestAuditChainStatusSeparatesVerifyErrorFromBrokenChain(t *testing.T) {
	resetAuditChainStatusForTest()
	// 校验本身失败（读不出来）：Intact 必须为 false，且 Err 要能读出来 ——
	// "读不出来"与"链是好的"是两件事，绝不能静默当成后者。
	RecordAuditChainCheck(0, errors.New("boom: query failed"))
	d := AuditChainStatusDetail()
	if !d.Checked || d.Intact {
		t.Fatalf("校验失败时 Intact 必须为 false: %+v", d)
	}
	if d.Err == "" || d.BrokenID != 0 {
		t.Fatalf("校验失败必须与'断链'分开上报: %+v", d)
	}
}

// auditRowCount 是链上有效行数（判据用它对比 Rows）。
func auditRowCount(db *sql.DB) (int64, error) {
	var n int64
	err := db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE hash <> ''`).Scan(&n)
	return n, err
}

// resetAuditChainStatusForTest 把结果缓存清成"本进程还没校验过"。
func resetAuditChainStatusForTest() {
	auditChainMu.Lock()
	defer auditChainMu.Unlock()
	auditChainChecked = false
	auditChainBroken = 0
	auditChainAt = ""
	auditChainErr = ""
	auditChainSource = ""
	auditChainRows = 0
	auditChainDurMS = 0
	auditChainChecks = 0
}
