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

// TestGatewayFileOwnershipNeverTransfers：同一 file_id 重复登记只保留一行，且
// **归属不转手**（首次上传者恒为归属人）。
//
// 为什么不是"最后上传者胜"：那等于"知道目标图片字节的人重传一次就能把归属抢走"，
// 原主的聊天引用会整体 404；首次胜的失败面只是第二个上传者退回 base64 内联。
func TestGatewayFileOwnershipNeverTransfers(t *testing.T) {
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
	if owner, ok, err := GatewayFileOwner(db, "file-api-x"); err != nil || !ok || owner != alice {
		t.Fatalf("owner = %d/%v/%v, want %d（首次上传者，归属不转手）", owner, ok, err, alice)
	}
	// 同一归属重复登记仍应刷新过期时间（续期的正常路径）。
	later := time.Now().Add(48 * time.Hour)
	if err := RecordGatewayFile(db, "file-api-x", alice, &later); err != nil {
		t.Fatal(err)
	}
	var expires *time.Time
	if err := db.QueryRow(`SELECT expires_at FROM gateway_files WHERE file_id = 'file-api-x'`).Scan(&expires); err != nil {
		t.Fatal(err)
	}
	if expires == nil || expires.Before(time.Now().Add(47*time.Hour)) {
		t.Fatalf("同一归属的续期未生效: %v", expires)
	}
}

// mustUser 复用 migration_0062_test.go 里的同名助手（插 0061 列集，够本文件用）。

// TestGatewayFileExpiredRowIsNotOwned：过期行按"不存在"处理（与列表过滤口径一致）。
// 上游对过期文件同样 404；若本地还认它是"自己的"，调用方拿到的会是上游 404 而不是
// 干净的"文件不存在"（审计 2026-09-22 G-6 指出两处口径曾相反）。
func TestGatewayFileExpiredRowIsNotOwned(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-files-alice")

	past := time.Now().Add(-time.Minute)
	if err := RecordGatewayFile(db, "file-api-old", alice, &past); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := GatewayFileOwner(db, "file-api-old"); err != nil || ok {
		t.Fatalf("过期行不应算作有效归属: ok=%v err=%v", ok, err)
	}
	if owned, err := GatewayFileOwnedBy(db, "file-api-old", alice); err != nil || owned {
		t.Fatalf("过期行不应判为归属自己: owned=%v err=%v", owned, err)
	}
	// 行本身仍在（由 purge 负责回收），确认上面的 false 来自 expires_at 判定
	var rows int
	if err := db.QueryRow(`SELECT count(*) FROM gateway_files WHERE file_id = 'file-api-old'`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("行应还在（等 purge 回收），rows=%d", rows)
	}
}

// TestPurgeExpiredSkipsRowsLockedByAnotherTx（审计 2026-09-22 P2-1）：purge 走
// 同事务两步（SELECT ... FOR UPDATE SKIP LOCKED → DELETE），被并发事务持锁的过期行
// 必须**跳过**而不是按旧快照删掉 —— 否则并发续期（把 expires_at 推到未来）的活行会被
// 误删，受害者随后的聊天引用该 file_id 会整体 404。
func TestPurgeExpiredSkipsRowsLockedByAnotherTx(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	alice := mustUser(t, db, "gw-files-alice")

	past := time.Now().Add(-time.Minute)
	if err := RecordGatewayFile(db, "file-api-locked", alice, &past); err != nil {
		t.Fatal(err)
	}
	if err := RecordGatewayFile(db, "file-api-free", alice, &past); err != nil {
		t.Fatal(err)
	}

	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	// 模拟"并发续期事务"：持有该行行锁（真实场景里它随后会把 expires_at 推到未来）
	if _, err := tx.Exec(`SELECT file_id FROM gateway_files WHERE file_id = 'file-api-locked' FOR UPDATE`); err != nil {
		t.Fatal(err)
	}

	n, err := PurgeExpiredGatewayFiles(db, 10)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("purged = %d, want 1（被锁行必须跳过）", n)
	}
	var lockedRows int
	if err := db.QueryRow(`SELECT count(*) FROM gateway_files WHERE file_id = 'file-api-locked'`).Scan(&lockedRows); err != nil {
		t.Fatal(err)
	}
	if lockedRows != 1 {
		t.Fatalf("被并发持锁的行被误删了（lockedRows=%d）", lockedRows)
	}
	var freeRows int
	if err := db.QueryRow(`SELECT count(*) FROM gateway_files WHERE file_id = 'file-api-free'`).Scan(&freeRows); err != nil {
		t.Fatal(err)
	}
	if freeRows != 0 {
		t.Fatalf("未被锁的过期行应被清掉（freeRows=%d）", freeRows)
	}
}

// TestGatewayFilesOwnedByBatch：批量归属判定（审计 2026-09-22 F 路 P2-3）——
// 网关的聊天引用校验从"每个引用一次串行查询"改成一次 `IN (...)`，语义必须与逐个判定
// 完全一致：只返回**本人的、未过期的**那些 id；他人的、未登记的、已过期的都不在结果里。
func TestGatewayFilesOwnedByBatch(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)

	alice := mustUser(t, db, "gw-batch-alice")
	bob := mustUser(t, db, "gw-batch-bob")
	future := time.Now().Add(time.Hour)
	past := time.Now().Add(-time.Minute)

	for _, id := range []string{"b-own-1", "b-own-2", "b-own-3"} {
		if err := RecordGatewayFile(db, id, alice, &future); err != nil {
			t.Fatal(err)
		}
	}
	if err := RecordGatewayFile(db, "b-bob", bob, &future); err != nil {
		t.Fatal(err)
	}
	if err := RecordGatewayFile(db, "b-expired", alice, &past); err != nil {
		t.Fatal(err)
	}
	if err := RecordGatewayFile(db, "b-permanent", alice, nil); err != nil {
		t.Fatal(err)
	}

	ids := []string{"b-own-1", "b-own-2", "b-own-3", "b-bob", "b-expired", "b-permanent", "b-unregistered"}
	owned, err := GatewayFilesOwnedBy(db, ids, alice)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"b-own-1": true, "b-own-2": true, "b-own-3": true, "b-permanent": true}
	if len(owned) != len(want) {
		t.Fatalf("owned = %v, want %v", owned, want)
	}
	for id := range want {
		if _, ok := owned[id]; !ok {
			t.Fatalf("缺少本人未过期的 %s: %v", id, owned)
		}
	}
	// 与逐个判定逐条对拍（批量实现不得放宽/收紧语义）。
	for _, id := range ids {
		one, err := GatewayFileOwnedBy(db, id, alice)
		if err != nil {
			t.Fatal(err)
		}
		_, batch := owned[id]
		if one != batch {
			t.Fatalf("%s: 批量=%v 逐个=%v", id, batch, one)
		}
	}
	// 空输入不发查询、返回空集。
	if got, err := GatewayFilesOwnedBy(db, nil, alice); err != nil || len(got) != 0 {
		t.Fatalf("空输入: %v/%v", got, err)
	}
}

// TestGatewayFileExpiredRowCanBeReclaimed：**过期行允许被重新占用**（审计 2026-09-22
// R4 N-3）。上游若按内容去重、把同一个 file_id 再发给第二个上传者，而原行已过期时，
// 归属必须能转给新的上传者 —— 否则他引用自己刚上传的文件会被判 404（与
// GatewayFileOwner 的"过期 = 不存在"口径相反）。
// 存活行仍然**不转手**（防"重传抢归属"），永久文件（expires_at IS NULL）永不转手。
func TestGatewayFileExpiredRowCanBeReclaimed(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)

	alice := mustUser(t, db, "gw-reclaim-alice")
	bob := mustUser(t, db, "gw-reclaim-bob")
	past := time.Now().Add(-time.Minute)
	future := time.Now().Add(time.Hour)

	// ① 过期行 → B 上传同名 id 后归属转到 B。
	if err := RecordGatewayFile(db, "r-expired", alice, &past); err != nil {
		t.Fatal(err)
	}
	if owned, err := GatewayFileOwnedBy(db, "r-expired", bob); err != nil || owned {
		t.Fatalf("过期行在重新登记前不该属于 B: %v/%v", owned, err)
	}
	if err := RecordGatewayFile(db, "r-expired", bob, &future); err != nil {
		t.Fatal(err)
	}
	if owned, err := GatewayFileOwnedBy(db, "r-expired", bob); err != nil || !owned {
		t.Fatalf("过期行重新上传后应归属 B: %v/%v", owned, err)
	}
	if owned, err := GatewayFileOwnedBy(db, "r-expired", alice); err != nil || owned {
		t.Fatalf("归属应已转给 B，A 不该仍拥有: %v/%v", owned, err)
	}

	// ② 存活行 → 不转手（防重传抢归属）。
	if err := RecordGatewayFile(db, "r-live", alice, &future); err != nil {
		t.Fatal(err)
	}
	if err := RecordGatewayFile(db, "r-live", bob, &future); err != nil {
		t.Fatal(err)
	}
	if owned, _ := GatewayFileOwnedBy(db, "r-live", alice); !owned {
		t.Fatal("存活行的归属被抢走了")
	}
	if owned, _ := GatewayFileOwnedBy(db, "r-live", bob); owned {
		t.Fatal("存活行不该转手给第二个上传者")
	}

	// ③ 永久文件（无过期时间）→ 永不转手。
	if err := RecordGatewayFile(db, "r-perm", alice, nil); err != nil {
		t.Fatal(err)
	}
	if err := RecordGatewayFile(db, "r-perm", bob, &future); err != nil {
		t.Fatal(err)
	}
	if owned, _ := GatewayFileOwnedBy(db, "r-perm", bob); owned {
		t.Fatal("永久文件不该被他人占用")
	}
	if owner, ok, _ := GatewayFileOwner(db, "r-perm"); !ok || owner != alice {
		t.Fatalf("永久文件归属漂移: %d/%v", owner, ok)
	}
}
