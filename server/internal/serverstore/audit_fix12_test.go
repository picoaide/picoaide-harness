package serverstore

import (
	"database/sql"
	"os"
	"strings"
	"testing"
)

// readFileString 读源码(静态守卫用)。
func readFileString(path string) (string, error) {
	b, err := os.ReadFile(path)
	return string(b), err
}

// FIX-12(审计 2026-09-12,P1):审计写入失败静默丢条目 + VerifyAuditChain 零调用。
//
// 两个缺陷面:
//
//  1. **丢失不被发现**。80 个调用点全是 `_ = serverstore.AuditLog(...)`;
//     worker 里任何一条失败都走 `defer tx.Rollback()` 丢掉**整批**
//     (最多 20 条),既不重试也不打日志、不计数。安全审计里"静默丢条目"
//     等价于"没有审计"。
//  2. **不变式没有执行者**。VerifyAuditChain(哈希链校验器)在生产代码里
//     零调用 —— 只有测试调它。
//
// 修法:①失败分支 ERROR 日志 + 进程内计数;②worker 有界重试 + 批量写用
// SAVEPOINT 逐条隔离(允许部分成功);③启动校验 + `GET /admin/audit/verify`。

// auditFailTable 造出一个只会让 audit_logs 写入失败的环境:把 detail 列改成
// 一个带 CHECK 的窄类型,超过阈值的 detail 会被 PG 拒绝。
//
// 之所以不用 DROP TABLE:那会连 worker 的 SELECT/INSERT 一起打掉,变成
// "整批失败",测不出"部分成功"。这里只让**特定条目**失败。
func auditFailTable(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`ALTER TABLE audit_logs ADD CONSTRAINT audit_detail_len CHECK (length(detail) <= 8)`); err != nil {
		t.Fatal(err)
	}
}

func auditCount(t *testing.T, db *sql.DB, detail string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE detail = ?`, detail).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// TestAuditBatchPartialSuccess 锁"允许部分成功":一批里坏 1 条不得丢掉其余。
// 修复前是整批回滚 —— 一批最多 20 条,坏 1 条 = 丢 20 条。
//
// ⚠️ 必须**直接调 writeAuditBatch**:AuditLog 会阻塞等 req.done,所以并发的
// AuditLog 调用也会被 worker 逐条处理成"每批 1 条",部分成功就退化成恒真。
// 批量语义只有这一层能看到。
func TestAuditBatchPartialSuccess(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	auditFailTable(t, db)

	done := make(chan error, 3)
	batch := []auditRequest{
		{username: "admin", action: "act_good_1", detail: "ok-1", done: done},
		{username: "admin", action: "act_bad", detail: "this-detail-is-way-too-long", done: done},
		{username: "admin", action: "act_good_2", detail: "ok-2", done: done},
	}
	errs := writeAuditBatch(db, batch)
	if len(errs) != len(batch) {
		t.Fatalf("errs len = %d, want %d(必须逐条返回错误)", len(errs), len(batch))
	}
	if errs[0] != nil {
		t.Fatalf("第 1 条不该失败: %v", errs[0])
	}
	if errs[1] == nil {
		t.Fatal("超长 detail 的条目必须返回错误(不得静默成功)")
	}
	if errs[2] != nil {
		t.Fatalf("第 3 条不该失败: %v", errs[2])
	}
	// 关键断言:坏条目的邻居必须**落库**。
	if n := auditCount(t, db, "ok-1"); n != 1 {
		t.Fatalf("good-1 rows = %d, want 1 —— 单条失败连累了整批(部分成功未生效)", n)
	}
	if n := auditCount(t, db, "ok-2"); n != 1 {
		t.Fatalf("good-2 rows = %d, want 1 —— 单条失败连累了整批", n)
	}
	if n := auditCount(t, db, "this-detail-is-way-too-long"); n != 0 {
		t.Fatalf("bad rows = %d, want 0", n)
	}
	// 链必须仍然完整(部分成功不得造成分叉)。
	if id, err := VerifyAuditChain(db); err != nil || id != 0 {
		t.Fatalf("部分成功后链必须完整: id=%d err=%v", id, err)
	}
}

// TestAuditWriteFailureIsCounted 锁"丢失必须可见":失败既要返回错误,也要
// 在进程内计数器上留下痕迹(AuditWriteStats)。
func TestAuditWriteFailureIsCounted(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	auditFailTable(t, db)

	beforeFail, beforeDrop, _ := AuditWriteStats()

	err := AuditLog(db, "admin", "act_fail", "this-detail-is-way-too-long")
	if err == nil {
		t.Fatal("必须返回错误")
	}

	afterFail, afterDrop, _ := AuditWriteStats()
	if afterFail <= beforeFail {
		t.Fatalf("write_failures 未增长(%d → %d):失败仍然不可见", beforeFail, afterFail)
	}
	if afterDrop <= beforeDrop {
		t.Fatalf("dropped_entries 未增长(%d → %d):丢失条目必须计数", beforeDrop, afterDrop)
	}

	// 成功路径不得污染计数。
	okFail, okDrop, _ := AuditWriteStats()
	if err := AuditLog(db, "admin", "act_ok", "ok"); err != nil {
		t.Fatal(err)
	}
	if f, d, _ := AuditWriteStats(); f != okFail || d != okDrop {
		t.Fatalf("成功写入改变了失败计数: failures %d→%d dropped %d→%d", okFail, f, okDrop, d)
	}
}

// TestAuditRetryHappensOnTransientFailure 锁"worker 重试":瞬时故障
// (第一次 INSERT 失败、第二次成功)必须被重试救回来。
//
// 做法:建一个 BEFORE INSERT 触发器,只在**第一次**插入某个 action 时抛错。
func TestAuditRetryHappensOnTransientFailure(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()

	// 计数必须**跨事务回滚存活**:触发器抛错会连它自己写的计数一起回滚,
	// 于是每次重试都看到"第一次" → 永远失败。sequence 的 nextval 不受事务
	// 回滚影响,正是这里需要的语义。
	if _, err := db.Exec(`CREATE SEQUENCE IF NOT EXISTS audit_flaky_seq`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE OR REPLACE FUNCTION audit_flaky_fail() RETURNS trigger AS $$
BEGIN
  IF NEW.action = 'act_flaky' AND nextval('audit_flaky_seq') = 1 THEN
    RAISE EXCEPTION 'transient audit failure';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TRIGGER audit_flaky_trg BEFORE INSERT ON audit_logs
FOR EACH ROW EXECUTE FUNCTION audit_flaky_fail()`); err != nil {
		t.Fatal(err)
	}

	beforeF, beforeD, beforeR := AuditWriteStats()
	if err := AuditLog(db, "admin", "act_flaky", "d"); err != nil {
		t.Fatalf("瞬时失败必须被重试救回, got %v", err)
	}
	if n := auditCount(t, db, "d"); n != 1 {
		t.Fatalf("rows = %d, want 1(重试后落库)", n)
	}
	if _, _, retries := AuditWriteStats(); retries <= beforeR {
		t.Fatalf("retries 未增长(%d → %d)—— 重试没有发生", beforeR, retries)
	}
	// 重试成功 = 没有数据丢失,也不该记成失败(否则 failures 无法用来告警)。
	if _, dropped, _ := AuditWriteStats(); dropped != beforeD {
		t.Fatalf("dropped %d → %d, want 不变(重试成功不算丢失)", beforeD, dropped)
	}
	if f, _, _ := AuditWriteStats(); f != beforeF {
		t.Fatalf("failures %d → %d, want 不变(重试成功不算失败事件)", beforeF, f)
	}
	// 只落一条,不得因重试产生重复条目。
	if n := auditCount(t, db, "d"); n != 1 {
		t.Fatalf("rows = %d, want 1(重试不得写重复条目)", n)
	}
	if id, err := VerifyAuditChain(db); err != nil || id != 0 {
		t.Fatalf("链必须完整: id=%d err=%v", id, err)
	}
}

// TestVerifyAuditChainIsWiredIntoProduction 是**静态守卫**:确认
// VerifyAuditChain 在生产代码里真的有执行者(启动校验 + 结果对外可查)。
//
// 单测能覆盖算法,但覆盖不了"有没有人调用它" —— 这条审计的原始缺陷正是
// "算法正确而执行者为零"。这里直接扫源码,防止有人把执行者删掉。
//
// 为什么是这两个文件而不是新端点:`internal/router` 是路由唯一真源,新增
// admin 路由会让 test mirror 与生产路由表失配(router 的 parity 测试直接红),
// 所以结果复用**已注册**的 server-info 端点暴露。
func TestVerifyAuditChainIsWiredIntoProduction(t *testing.T) {
	files := map[string]struct{ needle, what string }{
		"../../cmd/server/main.go": {
			"RunAndRecordAuditChainCheck", "启动校验(VerifyAuditChain 的调用者)"},
		"../../internal/serverauth/sysinfo.go": {
			"AuditChainStatus", "把校验结果暴露给 admin server-info"},
	}
	for path, want := range files {
		src, err := readFileString(path)
		if err != nil {
			t.Fatalf("读 %s: %v", path, err)
		}
		if !strings.Contains(src, want.needle) {
			t.Errorf("%s 里没有 %s —— %s 缺失,哈希链又变成没有执行者的不变式",
				path, want.needle, want.what)
		}
	}
	// 反向守卫:VerifyAuditChain 必须真的被 RunAndRecordAuditChainCheck 调用
	// (否则"执行者"只是换了个名字的空壳)。
	src, err := readFileString("audit.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(src, "brokenID, err := VerifyAuditChain(db)") {
		t.Error("RunAndRecordAuditChainCheck 不再调用 VerifyAuditChain —— 执行者是空壳")
	}
}

// TestAuditChainStatusRecorded 锁结果缓存:校验结果必须可被 server-info 读出。
func TestAuditChainStatusRecorded(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	if err := AuditLog(db, "admin", "act_chain", "d"); err != nil {
		t.Fatal(err)
	}
	brokenID, err := RunAndRecordAuditChainCheck(db)
	if err != nil || brokenID != 0 {
		t.Fatalf("verify: broken=%d err=%v", brokenID, err)
	}
	checked, intact, gotBroken, at, errMsg := AuditChainStatus()
	if !checked {
		t.Fatal("checked = false, want true(结果未记录)")
	}
	if !intact || gotBroken != 0 {
		t.Fatalf("intact=%v brokenID=%d, want true/0", intact, gotBroken)
	}
	if at == "" {
		t.Fatal("checkedAt 为空")
	}
	if errMsg != "" {
		t.Fatalf("errMsg = %q, want 空", errMsg)
	}

	// 篡改后重跑:必须报 broken 且被记录下来。
	var id int64
	if err := db.QueryRow(`SELECT id FROM audit_logs ORDER BY id DESC LIMIT 1`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE audit_logs SET detail = 'tampered' WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	brokenID, err = RunAndRecordAuditChainCheck(db)
	if err == nil || brokenID == 0 {
		t.Fatalf("篡改后 broken=%d err=%v, want 非零 + 错误", brokenID, err)
	}
	checked, intact, gotBroken, _, errMsg = AuditChainStatus()
	if !checked || intact || gotBroken == 0 || errMsg == "" {
		t.Fatalf("篡改后的状态 = checked:%v intact:%v broken:%d err:%q, want 已校验/不完整/非零/有错",
			checked, intact, gotBroken, errMsg)
	}
}
