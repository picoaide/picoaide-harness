package serverstore

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sync"
	"testing"
	"time"
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
	logs, _, err := ListAuditLogsPaged(db, 0, 10)
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

	if err := PurgeOldAuditLogs(db, now.AddDate(0, 0, -180)); err != nil {
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
