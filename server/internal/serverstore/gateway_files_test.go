package serverstore

import (
	"testing"
	"time"
)

// 网关 Files API 归属台账（迁移 0077）的 DAO 判据。
// 背景：上游按 API key 划分文件命名空间，而全组织共用一个上游 key ⇒ 网关必须
// 自己记归属，否则任一登录员工可列出/删除全公司的文件。

func TestGatewayFileOwnershipLifecycle(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)

	alice := mustUser(t, db, "gw-files-alice")
	bob := mustUser(t, db, "gw-files-bob")

	future := time.Now().Add(time.Hour)
	if err := RecordGatewayFile(db, "file-api-a1", alice, &future); err != nil {
		t.Fatal(err)
	}
	// 永久文件（官方 expires_after 可省略 ⇒ 无过期时间）
	if err := RecordGatewayFile(db, "file-api-a2", alice, nil); err != nil {
		t.Fatal(err)
	}

	owner, ok, err := GatewayFileOwner(db, "file-api-a1")
	if err != nil || !ok || owner != alice {
		t.Fatalf("owner = %d/%v/%v, want %d/true/nil", owner, ok, err, alice)
	}
	if owned, err := GatewayFileOwnedBy(db, "file-api-a1", bob); err != nil || owned {
		t.Fatalf("他人的文件不得判为归属自己: owned=%v err=%v", owned, err)
	}
	if owned, err := GatewayFileOwnedBy(db, "file-api-a1", alice); err != nil || !owned {
		t.Fatalf("自己的文件应判为归属自己: owned=%v err=%v", owned, err)
	}
	if _, ok, err := GatewayFileOwner(db, "file-api-unknown"); err != nil || ok {
		t.Fatalf("未登记 id 必须 ok=false: ok=%v err=%v", ok, err)
	}

	ids, err := ListGatewayFileIDs(db, alice)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 {
		t.Fatalf("alice 的 file_id 集合 = %v, want 2 条", ids)
	}
	if ids, err := ListGatewayFileIDs(db, bob); err != nil || len(ids) != 0 {
		t.Fatalf("bob 不应看到他人文件: %v err=%v", ids, err)
	}

	if err := DeleteGatewayFileRow(db, "file-api-a1"); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := GatewayFileOwner(db, "file-api-a1"); err != nil || ok {
		t.Fatalf("删除后台账应消失: ok=%v err=%v", ok, err)
	}
}

func TestGatewayFileExpiredRowsAreInvisibleAndPurged(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-files-alice")

	past := time.Now().Add(-time.Minute)
	if err := RecordGatewayFile(db, "file-api-expired", alice, &past); err != nil {
		t.Fatal(err)
	}
	// 过期的行不再出现在"自己的文件"集合里（上游对过期文件返回 404）
	if ids, err := ListGatewayFileIDs(db, alice); err != nil || len(ids) != 0 {
		t.Fatalf("过期行不应出现在列表集合: %v err=%v", ids, err)
	}
	n, err := PurgeExpiredGatewayFiles(db, 10)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("purged = %d, want 1", n)
	}
	if _, ok, err := GatewayFileOwner(db, "file-api-expired"); err != nil || ok {
		t.Fatalf("清理后行应消失: ok=%v err=%v", ok, err)
	}
}

// TestGatewayFileUpsertKeepsSingleRow：同一 file_id 重复登记（上游对相同内容可能
// 返回既有 id）只保留一行，归属取最后一次。
func TestGatewayFileUpsertKeepsSingleRow(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-files-alice")
	bob := mustUser(t, db, "gw-files-bob")

	if err := RecordGatewayFile(db, "file-api-x", alice, nil); err != nil {
		t.Fatal(err)
	}
	if err := RecordGatewayFile(db, "file-api-x", bob, nil); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := db.QueryRow(`SELECT count(*) FROM gateway_files WHERE file_id = 'file-api-x'`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("rows = %d, want 1", rows)
	}
	if owner, ok, err := GatewayFileOwner(db, "file-api-x"); err != nil || !ok || owner != bob {
		t.Fatalf("owner = %d/%v/%v, want %d（最后一次上传者）", owner, ok, err, bob)
	}
}

// mustUser 复用 migration_0062_test.go 里的同名助手（插 0061 列集，够本文件用）。
