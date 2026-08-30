package serverstore

import "testing"


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
