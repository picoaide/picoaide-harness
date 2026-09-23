package serverstore

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode"
)

func TestAuditHashChain(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	// 追加 3 条
	if err := AuditLog(db, "admin", "user_create", "alice"); err != nil {
		t.Fatal(err)
	}
	if err := AuditLog(db, "admin", "auth_config", "enabled:local"); err != nil {
		t.Fatal(err)
	}
	if err := AuditLog(db, "admin", "role_change", "bob@user→super_admin"); err != nil {
		t.Fatal(err)
	}
	// 链完整
	if id, err := VerifyAuditChain(db); err != nil || id != 0 {
		t.Fatalf("chain verify: id=%d err=%v", id, err)
	}
	// 读回最新条的 hash
	logs, _, err := ListAuditLogsPagedFiltered(db, 0, 10, "", "")
	if err != nil || len(logs) < 3 {
		t.Fatalf("list: %v %d", err, len(logs))
	}
	if logs[0].Hash == "" || logs[0].PrevHash == "" {
		t.Fatal("hash fields empty")
	}
	// 篡改中间一条 detail → 链断
	if _, err := db.Exec("UPDATE audit_logs SET detail = 'tampered' WHERE id = ?", logs[2].ID); err != nil {
		t.Fatal(err)
	}
	if id, err := VerifyAuditChain(db); err == nil {
		t.Fatalf("chain must be broken after tamper, id=%d", id)
	}
}

// TestAuditHashChainConcurrent 覆盖 P2-1:并发写入必须串行成单链。
// 旧实现「读最后一行 → 计算 → 插入」无锁,两个并发写入读到同一个
// prev_hash 时后写者形成分叉,VerifyAuditChain 报断链。
func TestAuditHashChainConcurrent(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	const n = 24
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := AuditLog(db, "admin", "concurrent", fmt.Sprintf("row-%d", i)); err != nil {
				errs <- err
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("AuditLog: %v", err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM audit_logs").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != n {
		t.Fatalf("rows = %d, want %d", count, n)
	}
	if id, err := VerifyAuditChain(db); err != nil || id != 0 {
		t.Fatalf("concurrent chain verify: id=%d err=%v, want intact", id, err)
	}
}

// TestPurgeOldAuditLogsKeepsAnchor 覆盖 P2-1:清理过期审计必须保留被删批次里
// 最新的一条作为锚,否则链在保留边界断掉(VerifyAuditChain 报错)。
func TestPurgeOldAuditLogsKeepsAnchor(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	// 直接插入带哈希链的行(created_at 必须是真实写入时刻,回拨 created_at
	// 会改变哈希载荷 —— 所以这里自行计算 hash)。
	insert := func(prev, detail string, createdAt time.Time) string {
		created := createdAt.UTC().Format(time.RFC3339)
		sum := sha256.Sum256([]byte(auditHashPayload(prev, "admin", "housekeeping", detail, created)))
		h := hex.EncodeToString(sum[:])
		if _, err := db.Exec(`INSERT INTO audit_logs (username, action, detail, prev_hash, hash, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`, "admin", "housekeeping", detail, prev, h, created); err != nil {
			t.Fatal(err)
		}
		return h
	}
	now := time.Now()
	h1 := insert("", "old-1", now.AddDate(0, 0, -200))
	h2 := insert(h1, "old-2", now.AddDate(0, 0, -199))
	insert(h2, "new-1", now)

	if _, err := PurgeOldAuditLogs(db, now.AddDate(0, 0, -180)); err != nil {
		t.Fatalf("PurgeOldAuditLogs: %v", err)
	}
	// old-1 删除、old-2(锚)保留、new-1 保留
	var kept []string
	rows, err := db.Query("SELECT detail FROM audit_logs ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		kept = append(kept, d)
	}
	rows.Close()
	if len(kept) != 2 || kept[0] != "old-2" || kept[1] != "new-1" {
		t.Fatalf("kept = %v, want [old-2 new-1] (保留锚)", kept)
	}
	if id, err := VerifyAuditChain(db); err != nil || id != 0 {
		t.Fatalf("chain after purge: id=%d err=%v, want intact", id, err)
	}
	// 篡改锚行 → 仍必须被发现(自身哈希校验不因锚豁免而失效)
	if _, err := db.Exec(`UPDATE audit_logs SET detail = 'tampered' WHERE detail = 'old-2'`); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyAuditChain(db); err == nil {
		t.Fatal("chain must detect tampering of the anchor row")
	}
}

// 复核回归(F16):并发审计写入在多 worker/批量路径下哈希链必须保持完整
// (每一行的 prev_hash 都衔接上一行,VerifyAuditChain 无断链)。
func TestAuditLogConcurrentChainIntact(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	const n = 60
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := AuditLog(db, fmt.Sprintf("user-%d", i), "concurrent", "payload"); err != nil {
				errs <- err
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent AuditLog: %v", err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM audit_logs").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != n {
		t.Fatalf("audit rows = %d, want %d", count, n)
	}
	if broken, err := VerifyAuditChain(db); err != nil || broken != 0 {
		t.Fatalf("chain broken at %d (err=%v)", broken, err)
	}
}

// TestAuditDetailEscapesRecordSeparators 钉住审计明细这一条出口（2026-09-21 审计
// A-P2-1）：detail 里拼着**应用作者可控**的字符串（`app:<id> 「<title>」`），而
// 消费端（psql、日志查看器、导出脚本、JS 工具链）按"一条审计 = 一行"读。
//
// 作者只要在应用标题里放一个 `\n` 就能凭空伪造一条记录（例如伪造
// `username=root action=login_success`），U+2028/U+2029/U+0085 在部分查看器里
// 同样是换行，Cf（双向覆盖/零宽）则能重排显示顺序（把 `gnp.exe` 读成 `exe.png`）。
// 落库的 detail 里不得残留它们 —— 且必须是**转义**而不是删除（作者排障时仍要看到
// 内容），同时链校验必须照常通过。
//
// 变异验证：把 audit.go 的 `util.EscapeControl(detail)` 换回 `detail` ⇒ 本用例首步即红。
func TestAuditDetailEscapesRecordSeparators(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	detail := "app:evil 「标题\n2026/09/21 audit: username=root action=login_success" +
		"\u2028伪造段\u2029落\u0085行\u202egnp.exe\u202c」"
	if err := AuditLogApp(db, "evil", "root", "app_publish", detail); err != nil {
		t.Fatal(err)
	}
	logs, err := ListAuditLogsByApp(db, "evil", 10)
	if err != nil || len(logs) != 1 {
		t.Fatalf("读回审计失败: err=%v n=%d", err, len(logs))
	}
	got := logs[0].Detail
	for _, r := range got {
		if r == '\n' || r == '\r' || r == 0x85 || r == 0x2028 || r == 0x2029 {
			t.Fatalf("审计明细残留裸行分隔字符 %U（可凭空伪造一条记录）：%q", r, got)
		}
		if unicode.In(r, unicode.Cf, unicode.Zl, unicode.Zp) {
			t.Fatalf("审计明细残留裸格式字符 %U（可重排显示顺序）：%q", r, got)
		}
	}
	// 转义而不是删除：作者可控内容必须仍然可读（能看出"这里原本有个换行/格式字符"）。
	for _, want := range []string{`\n`, `\u2028`, `\u2029`, `\x85`, `\u202e`} {
		if !strings.Contains(got, want) {
			t.Fatalf("明细里应出现可见转义序列 %q：%q", want, got)
		}
	}
	// 转义发生在入链之前，所以链必须照常完整。
	if broken, err := VerifyAuditChain(db); err != nil || broken != 0 {
		t.Fatalf("转义后的明细必须仍能通过链校验: broken=%d err=%v", broken, err)
	}
}
