package serverstore

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestKBCrud(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	fid, err := CreateKBFolder(db, "研发文档", 0)
	if err != nil || fid == 0 {
		t.Fatalf("CreateKBFolder: %d %v", fid, err)
	}
	did, err := CreateKBDocument(db, fid, "知识库使用手册", "这是知识库的使用说明内容", "text", 0, "upload", "alice")
	if err != nil || did == 0 {
		t.Fatalf("CreateKBDocument: %d %v", did, err)
	}

	doc, err := GetKBDocument(db, did)
	if err != nil {
		t.Fatalf("GetKBDocument: %v", err)
	}
	if doc.FolderID != fid || doc.Title != "知识库使用手册" || doc.CreatedBy != "alice" || doc.Size != int64(len("这是知识库的使用说明内容")) {
		t.Fatalf("doc = %+v", doc)
	}

	folders, err := ListKBFolders(db)
	if err != nil || len(folders) != 1 || folders[0].Name != "研发文档" {
		t.Fatalf("ListKBFolders: %v %v", folders, err)
	}

	if err := DeleteKBDocument(db, did); err != nil {
		t.Fatalf("DeleteKBDocument: %v", err)
	}
	if _, err := GetKBDocument(db, did); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetKBDocument after delete: %v, want ErrNotFound", err)
	}
	if err := DeleteKBDocument(db, did); !errors.Is(err, ErrNotFound) {
		t.Fatalf("DeleteKBDocument twice: %v, want ErrNotFound", err)
	}
}

func TestKBPermissions(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	f1, _ := CreateKBFolder(db, "team-a", 0)
	f2, _ := CreateKBFolder(db, "team-b", 0)
	f3, _ := CreateKBFolder(db, "ops", 0)

	if err := GrantFolderUser(db, f1, "alice"); err != nil {
		t.Fatalf("GrantFolderUser: %v", err)
	}
	if err := GrantFolderGroup(db, f2, "devs"); err != nil {
		t.Fatalf("GrantFolderGroup: %v", err)
	}

	acc := map[int64]bool{}
	ids, err := GetAccessibleFolderIDs(db, "alice", []string{"devs"})
	if err != nil {
		t.Fatalf("GetAccessibleFolderIDs: %v", err)
	}
	for _, id := range ids {
		acc[id] = true
	}
	for _, want := range []int64{f1, f2} {
		if !acc[want] {
			t.Errorf("folder %d not accessible", want)
		}
	}
	if acc[0] {
		t.Errorf("folder 0 implicitly accessible (strict default)")
	}
	if acc[f3] {
		t.Errorf("folder %d should not be accessible", f3)
	}

	// without the group, f2 is not accessible
	acc = map[int64]bool{}
	ids, _ = GetAccessibleFolderIDs(db, "alice", nil)
	for _, id := range ids {
		acc[id] = true
	}
	if acc[f2] {
		t.Errorf("folder %d accessible without group", f2)
	}
	if !acc[f1] {
		t.Errorf("direct grant lost")
	}
	if acc[0] {
		t.Errorf("folder 0 implicitly accessible (strict default)")
	}

	// different user without grants sees nothing (no implicit global root)
	ids, _ = GetAccessibleFolderIDs(db, "bob", nil)
	if len(ids) != 0 {
		t.Fatalf("bob accessible = %v, want empty", ids)
	}
}

func TestKBRevoke(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	fid, err := CreateKBFolder(db, "team", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := GrantFolderUser(db, fid, "alice"); err != nil {
		t.Fatal(err)
	}
	if err := GrantFolderGroup(db, fid, "devs"); err != nil {
		t.Fatal(err)
	}
	users, groups, err := ListKBFolderGrants(db, fid)
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 1 || users[0] != "alice" || len(groups) != 1 || groups[0] != "devs" {
		t.Fatalf("grants = %v %v", users, groups)
	}

	// revoke user grant: permission check must drop the folder
	if err := RevokeFolderUser(db, fid, "alice"); err != nil {
		t.Fatalf("RevokeFolderUser: %v", err)
	}
	ids, err := GetAccessibleFolderIDs(db, "alice", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range ids {
		if id == fid {
			t.Fatal("folder still accessible after revoke")
		}
	}
	// idempotent: revoking again (or a non-existent grant) is not an error
	if err := RevokeFolderUser(db, fid, "alice"); err != nil {
		t.Fatalf("RevokeFolderUser twice: %v", err)
	}
	if err := RevokeFolderUser(db, fid, "nobody"); err != nil {
		t.Fatalf("RevokeFolderUser nonexistent: %v", err)
	}

	// group revoke
	if err := RevokeFolderGroup(db, fid, "devs"); err != nil {
		t.Fatalf("RevokeFolderGroup: %v", err)
	}
	if err := RevokeFolderGroup(db, fid, "devs"); err != nil {
		t.Fatalf("RevokeFolderGroup twice: %v", err)
	}
	users, groups, _ = ListKBFolderGrants(db, fid)
	if len(users) != 0 || len(groups) != 0 {
		t.Fatalf("grants after revoke = %v %v, want empty", users, groups)
	}
}

func TestKBUpdateDocument(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	did, err := CreateKBDocument(db, 0, "旧标题", "旧内容", "text", 0, "upload", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if err := UpdateKBDocument(db, did, "新标题", "新内容", "markdown"); err != nil {
		t.Fatalf("UpdateKBDocument: %v", err)
	}
	doc, err := GetKBDocument(db, did)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Title != "新标题" || doc.Content != "新内容" || doc.ContentType != "markdown" || doc.Size != int64(len("新内容")) {
		t.Fatalf("doc = %+v", doc)
	}
	if err := UpdateKBDocument(db, 99999, "x", "y", "text"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("UpdateKBDocument nonexistent: %v, want ErrNotFound", err)
	}
}

func TestKBAuditLog(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	if err := AuditLog(db, "alice", "kb_upload", "folder=1 title=x"); err != nil {
		t.Fatalf("AuditLog: %v", err)
	}
	logs, err := ListAuditLogs(db, 10)
	if err != nil || len(logs) != 1 {
		t.Fatalf("ListAuditLogs: %v %v", logs, err)
	}
	if logs[0].Username != "alice" || logs[0].Action != "kb_upload" || logs[0].Detail != "folder=1 title=x" {
		t.Fatalf("log = %+v", logs[0])
	}
	for i := 0; i < 5; i++ {
		if err := AuditLog(db, "bob", "kb_delete", "doc#"+string(rune('a'+i))); err != nil {
			t.Fatal(err)
		}
	}
	paged, total, err := ListAuditLogsPaged(db, 1, 3)
	if err != nil || total != 6 || len(paged) != 3 {
		t.Fatalf("paged: len=%d total=%d err=%v", len(paged), total, err)
	}
	if paged[0].Username != "bob" || paged[0].Action != "kb_delete" {
		t.Fatalf("paged[0] = %+v", paged[0])
	}
}

func TestKBDocumentsPaged(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if _, err := CreateKBDocument(db, 1, "doc"+string(rune('a'+i)), "content", "text", 0, "webadmin", "alice"); err != nil {
			t.Fatal(err)
		}
	}
	docs, total, err := ListKBDocumentsPaged(db, 1, 1, 2)
	if err != nil || total != 5 || len(docs) != 2 {
		t.Fatalf("paged: len=%d total=%d err=%v", len(docs), total, err)
	}
	if docs[0].Title != "docd" {
		t.Fatalf("newest first with offset: %+v", docs[0])
	}
	first, _, err := ListKBDocumentsPaged(db, 1, 0, 2)
	if err != nil || first[0].Title != "doce" {
		t.Fatalf("newest first: %+v %v", first, err)
	}
	all, err := ListKBDocuments(db, 1)
	if err != nil || len(all) != 5 {
		t.Fatalf("unpaged: %v %d", err, len(all))
	}
}

// claim is exclusive: a second claim while one is outstanding finds nothing
func TestKBClaimIsExclusive(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	id, err := CreatePendingKBDocument(db, 0, "独占文档", "text", 10, "upload", "admin")
	if err != nil || id == 0 {
		t.Fatalf("CreatePendingKBDocument: %d %v", id, err)
	}
	claimed, err := ClaimPendingKBDocument(db)
	if err != nil || claimed.ID != id {
		t.Fatalf("first claim: %+v %v", claimed, err)
	}
	// second worker sees an empty queue (row is claimed, not pending)
	if _, err := ClaimPendingKBDocument(db); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second claim: %v, want ErrNotFound", err)
	}
	doc, _ := GetKBDocument(db, id)
	if doc.Status != "processing" {
		t.Fatalf("claimed doc status = %q, want processing", doc.Status)
	}
	// release returns it to the queue
	if err := ReleaseClaim(db, id); err != nil {
		t.Fatal(err)
	}
	doc, _ = GetKBDocument(db, id)
	if doc.Status != "pending" {
		t.Fatalf("released doc status = %q, want pending", doc.Status)
	}
	// release is a no-op once completed (claim again → complete → release)
	if _, err := ClaimPendingKBDocument(db); err != nil {
		t.Fatal(err)
	}
	if err := CompleteKBDocument(db, id, "ok", ""); err != nil {
		t.Fatal(err)
	}
	if err := ReleaseClaim(db, id); err != nil {
		t.Fatal(err)
	}
	doc, _ = GetKBDocument(db, id)
	if doc.Status != "ready" {
		t.Fatalf("ready doc released back to queue: %+v", doc)
	}
	// reset returns processing rows to pending (crash recovery)
	id2, _ := CreatePendingKBDocument(db, 0, "崩溃残留", "text", 10, "upload", "admin")
	if _, err := ClaimPendingKBDocument(db); err != nil {
		t.Fatal(err)
	}
	if err := ResetProcessingClaims(db); err != nil {
		t.Fatal(err)
	}
	doc, _ = GetKBDocument(db, id2)
	if doc.Status != "pending" {
		t.Fatalf("reset doc status = %q, want pending", doc.Status)
	}
}

// concurrent claims must never produce orphans: each worker gets a distinct
// row (the UPDATE + re-SELECT pair is serialized)
func TestKBConcurrentClaimsNoOrphans(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		if _, err := CreatePendingKBDocument(db, 0, "并发文档", "text", 10, "upload", "admin"); err != nil {
			t.Fatal(err)
		}
	}
	ids := map[int64]bool{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				d, err := ClaimPendingKBDocument(db)
				if errors.Is(err, ErrNotFound) {
					return
				}
				if err != nil {
					t.Error(err)
					return
				}
				mu.Lock()
				if ids[d.ID] {
					t.Errorf("doc %d claimed twice", d.ID)
				}
				ids[d.ID] = true
				mu.Unlock()
				if err := CompleteKBDocument(db, d.ID, "ok", ""); err != nil {
					t.Error(err)
					return
				}
			}
		}()
	}
	wg.Wait()
	if len(ids) != 20 {
		t.Fatalf("claimed %d distinct docs, want 20 (orphans left)", len(ids))
	}
	var n int64
	if err := db.QueryRow("SELECT COUNT(*) FROM kb_documents WHERE status='processing'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("%d orphan processing rows", n)
	}
}

// C-4: a pending row whose raw upload file never landed (INSERT/Rename race,
// manual deletion) is skipped — not marked error, not extracted.
func TestProcessPendingSkipsMissingFile(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	id, err := CreatePendingKBDocument(db, 0, "待处理文档", "text", 123, "upload", "admin")
	if err != nil || id == 0 {
		t.Fatalf("CreatePendingKBDocument: %d %v", id, err)
	}
	doc, err := GetKBDocument(db, id)
	if err != nil || doc.Status != "pending" || doc.Size != 123 {
		t.Fatalf("pending doc = %+v %v", doc, err)
	}
	claimed, err := ClaimPendingKBDocument(db)
	if err != nil || claimed.ID != id {
		t.Fatalf("claim: %+v %v", claimed, err)
	}
	if err := CompleteKBDocument(db, id, "提取后的文本", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := ClaimPendingKBDocument(db); !errors.Is(err, ErrNotFound) {
		t.Fatalf("claim after complete: %v, want ErrNotFound", err)
	}
	doc, _ = GetKBDocument(db, id)
	if doc.Status != "ready" || doc.Content != "提取后的文本" || doc.Size != int64(len("提取后的文本")) || doc.Error != "" {
		t.Fatalf("ready doc = %+v", doc)
	}
	id2, err := CreatePendingKBDocument(db, 0, "坏文件", "pdf", 9, "upload", "admin")
	if err != nil || id2 == 0 {
		t.Fatalf("CreatePendingKBDocument 2: %d %v", id2, err)
	}
	if err := CompleteKBDocument(db, id2, "", "pdf 解析失败"); err != nil {
		t.Fatal(err)
	}
	doc, _ = GetKBDocument(db, id2)
	if doc.Status != "error" || doc.Content != "" || !strings.Contains(doc.Error, "解析失败") {
		t.Fatalf("error doc = %+v", doc)
	}
	if err := RetryKBDocument(db, id2); err != nil {
		t.Fatal(err)
	}
	doc, _ = GetKBDocument(db, id2)
	if doc.Status != "pending" || doc.Error != "" {
		t.Fatalf("retried doc = %+v", doc)
	}
	if err := RetryKBDocument(db, 99999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("retry missing: %v, want ErrNotFound", err)
	}
}

// C-3: the claim is exclusive (one worker owns a row); a stale worker's
// failure must never clobber a successful extraction.
func TestKBDoubleWorkerRace(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	id, err := CreatePendingKBDocument(db, 0, "竞态文档", "text", 10, "upload", "admin")
	if err != nil || id == 0 {
		t.Fatalf("CreatePendingKBDocument: %d %v", id, err)
	}
	// worker 1 claims (pending → processing) and completes successfully
	if _, err := ClaimPendingKBDocument(db); err != nil {
		t.Fatal(err)
	}
	if err := CompleteKBDocument(db, id, "提取成功", ""); err != nil {
		t.Fatal(err)
	}
	// worker 2 holds a stale claim (no-op: the row is already ready), its
	// file is gone, it reports an error — the row must stay ready
	if err := CompleteKBDocument(db, id, "", "文件不存在"); err != nil {
		t.Fatal(err)
	}
	doc, _ := GetKBDocument(db, id)
	if doc.Status != "ready" || doc.Content != "提取成功" || doc.Error != "" {
		t.Fatalf("ready doc clobbered by stale worker: %+v", doc)
	}
	// error first, then a stale success completion: status stays error
	id2, _ := CreatePendingKBDocument(db, 0, "反向竞态", "text", 10, "upload", "admin")
	if err := CompleteKBDocument(db, id2, "", "解析失败"); err != nil {
		t.Fatal(err)
	}
	if err := CompleteKBDocument(db, id2, "迟到的成功", ""); err != nil {
		t.Fatal(err)
	}
	doc, _ = GetKBDocument(db, id2)
	if doc.Status != "error" || doc.Error == "" {
		t.Fatalf("error doc clobbered by stale success: %+v", doc)
	}
}

// 审计 6-K6: audit logs older than the retention window are purged.
func TestPurgeOldAuditLogs(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	if err := AuditLog(db, "alice", "kb_upload", "doc#1"); err != nil {
		t.Fatal(err)
	}
	if err := AuditLog(db, "bob", "kb_upload", "doc#2"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE kb_audit_logs SET created_at = ? WHERE username = 'alice'",
		time.Now().AddDate(0, 0, -120).Format("2006-01-02 15:04:05")); err != nil {
		t.Fatal(err)
	}
	if err := PurgeOldAuditLogs(db, time.Now().AddDate(0, 0, -90)); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM kb_audit_logs").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("audit logs left = %d, want 1 (only the recent one)", n)
	}
}
