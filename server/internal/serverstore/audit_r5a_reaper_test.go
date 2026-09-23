package serverstore

// R5-A-12 的 store 级判据（审计 2026-09-23，P1）：回收批次不得被"永久失败行"占满。
//
// 缺陷形态：候选集 = {已过期 ∧ 标记不在租约内}，旧排序只有 `expires_at ASC`；一条
// 上游 DELETE 永久失败的行被释放认领后，下轮仍然满足这两个条件且 `expires_at` 不变
// ⇒ 重新排回最前。≥ 批次上限的永久失败行因此把每一轮占满，更晚过期的文件**永不进入
// 候选**（上游配额单调泄漏）。修法 = 按尝试次数（`reap_gen`）分层排序 + 把达到阈值的
// 行点名到可观测面。

import (
	"testing"
	"time"
)

// TestListExpiredPrefersNeverFailedRowsOverRetriedOnes 是 R5-A-12 的根因判据：
// 批次必须**优先**从未失败过的行（reap_gen=0），无论它们的 expires_at 有多新。
//
// 构造：3 条"很旧但已失败过"的行（gen=5）+ 2 条"较新且从未失败"的行（gen=0），
// 批次上限 2 ⇒ 候选必须恰好是那 2 条从未失败的行。旧排序（只按 expires_at）会
// 取到最旧的失败行 ⇒ 必红。
func TestListExpiredPrefersNeverFailedRowsOverRetriedOnes(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	uid := mustUser(t, db, "r5a-reaper-order")

	past := time.Now().Add(-time.Hour)
	insert := func(id string, expiresAt time.Time, gen int64) {
		t.Helper()
		if _, err := db.Exec(`INSERT INTO gateway_files (file_id, user_id, created_at, expires_at, size_bytes, reap_gen)
			VALUES (?, ?, now() - interval '30 days', ?, 100, ?)`, id, uid, expiresAt, gen); err != nil {
			t.Fatal(err)
		}
	}
	// 旧的失败行（gen=5）—— 旧排序下会占满批次。
	insert("file-old-failed-1", past.Add(-5*time.Hour), 5)
	insert("file-old-failed-2", past.Add(-4*time.Hour), 5)
	insert("file-old-failed-3", past.Add(-3*time.Hour), 5)
	// 较新的"从未失败"行（gen=0）。
	insert("file-fresh-a", past, 0)
	insert("file-fresh-b", past.Add(30*time.Second), 0)

	ids, err := ListExpiredGatewayFiles(db, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 {
		t.Fatalf("批次 = %v, want 2 条", ids)
	}
	for _, id := range ids {
		if id != "file-fresh-a" && id != "file-fresh-b" {
			t.Fatalf("批次被已失败过的行占位：%v（从未失败的行必须优先 —— R5-A-12 的队头阻塞）", ids)
		}
	}

	// 分层是"先按尝试次数、再按过期时间"：同一层内仍按 expires_at 升序。
	ids, err = ListExpiredGatewayFiles(db, 5)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"file-fresh-a", "file-fresh-b", "file-old-failed-1", "file-old-failed-2", "file-old-failed-3"}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("批次顺序 = %v, want %v", ids, want)
		}
	}
}

// TestGatewayFileReapBacklogNamesStuckRows：反复失败的行必须被**点名**（计数 + 样例），
// 否则配额泄漏只有"每轮 500 failed"这一条线索（R5-A-12 的可观测性要求）。
func TestGatewayFileReapBacklogNamesStuckRows(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	uid := mustUser(t, db, "r5a-reaper-backlog")
	past := time.Now().Add(-time.Hour)
	insert := func(id string, gen int64) {
		t.Helper()
		if _, err := db.Exec(`INSERT INTO gateway_files (file_id, user_id, created_at, expires_at, size_bytes, reap_gen)
			VALUES (?, ?, now() - interval '30 days', ?, 100, ?)`, id, uid, past, gen); err != nil {
			t.Fatal(err)
		}
	}
	insert("file-ok", 1)                                    // 试过一次就成功了？(还留着 ⇒ 失败过一次)
	insert("file-stuck-1", GatewayFileReapStuckThreshold)   // 恰好到阈值
	insert("file-stuck-2", GatewayFileReapStuckThreshold+3) // 超过阈值
	// 未过期的行不进统计。
	if _, err := db.Exec(`INSERT INTO gateway_files (file_id, user_id, created_at, expires_at, size_bytes, reap_gen)
		VALUES ('file-live', ?, now(), now() + interval '1 day', 100, 99)`, uid); err != nil {
		t.Fatal(err)
	}

	bl, err := GatewayFileReapBacklogStats(db)
	if err != nil {
		t.Fatal(err)
	}
	if bl.Expired != 3 {
		t.Fatalf("Expired = %d, want 3（只统计已过期行）", bl.Expired)
	}
	if bl.Retrying != 3 {
		t.Fatalf("Retrying = %d, want 3", bl.Retrying)
	}
	if bl.Stuck != 2 {
		t.Fatalf("Stuck = %d, want 2（阈值 %d）", bl.Stuck, GatewayFileReapStuckThreshold)
	}
	if bl.MaxAttempts != GatewayFileReapStuckThreshold+3 {
		t.Fatalf("MaxAttempts = %d, want %d", bl.MaxAttempts, GatewayFileReapStuckThreshold+3)
	}
	if len(bl.StuckSample) != 2 {
		t.Fatalf("StuckSample = %v, want 2 条点名", bl.StuckSample)
	}
	if bl.StuckSample[0].FileID != "file-stuck-2" {
		t.Fatalf("点名顺序应按尝试次数降序，首条 = %s", bl.StuckSample[0].FileID)
	}
}
