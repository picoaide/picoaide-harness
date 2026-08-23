package knowledge

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func kbDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := serverstore.Open(filepath.Join(t.TempDir(), "kb.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := serverstore.ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	return db
}

// seedDocs inserts folders/docs: aliceFolder has alice grant, bobFolder has
// bob grant. One doc per folder. Returns both folder ids.
func seedDocs(t *testing.T, db *sql.DB) (aliceFolder, bobFolder int64) {
	t.Helper()
	aliceFolder, err := serverstore.CreateKBFolder(db, "alice-docs", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantFolderUser(db, aliceFolder, "alice"); err != nil {
		t.Fatal(err)
	}
	bobFolder, err = serverstore.CreateKBFolder(db, "bob-docs", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantFolderUser(db, bobFolder, "bob"); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateKBDocument(db, aliceFolder, "知识库使用手册", "这是知识库的使用说明内容", "text", 0, "upload", "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateKBDocument(db, bobFolder, "机密文档", "只有 bob 能看的内容", "text", 0, "upload", "bob"); err != nil {
		t.Fatal(err)
	}
	return aliceFolder, bobFolder
}

func TestSearchChinesePrefix(t *testing.T) {
	db := kbDB(t)
	seedDocs(t, db)

	res, total, err := Search(db, "alice", nil, "知识", 1, 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if total != 1 || len(res) != 1 {
		t.Fatalf("total=%d res=%d, want 1/1", total, len(res))
	}
	if res[0].Title != "知识库使用手册" {
		t.Fatalf("title = %q", res[0].Title)
	}

	// mid-token query: FTS prefix fails, LIKE fallback must hit
	res, total, err = Search(db, "alice", nil, "手册", 1, 10)
	if err != nil {
		t.Fatalf("Search mid-token: %v", err)
	}
	if total != 1 || res[0].Title != "知识库使用手册" {
		t.Fatalf("mid-token total=%d res=%v, want 知识库使用手册", total, res)
	}
}

func TestSearchMaliciousQuery(t *testing.T) {
	db := kbDB(t)
	seedDocs(t, db)

	for _, q := range []string{`" OR ' --`, `知识 OR " --`, `*():"`, `a"b*c`} {
		res, total, err := Search(db, "alice", nil, q, 1, 10)
		if err != nil {
			t.Fatalf("Search(%q) errored: %v", q, err)
		}
		if res == nil {
			t.Fatalf("Search(%q) returned nil slice", q)
		}
		_ = total
	}

	// all-stripped query returns empty, not an error
	res, total, err := Search(db, "alice", nil, `"*():`, 1, 10)
	if err != nil || total != 0 || len(res) != 0 {
		t.Fatalf("stripped query: res=%v total=%d err=%v, want empty", res, total, err)
	}
}

func TestSearchPermissionFilter(t *testing.T) {
	db := kbDB(t)
	seedDocs(t, db)

	// alice must not see bob's doc
	res, total, err := Search(db, "alice", nil, "机密", 1, 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if total != 0 || len(res) != 0 {
		t.Fatalf("alice sees bob's doc: total=%d", total)
	}

	// bob sees his own
	res, total, _ = Search(db, "bob", nil, "机密", 1, 10)
	if total != 1 || len(res) != 1 {
		t.Fatalf("bob search: total=%d res=%d", total, len(res))
	}
}

func TestSearchPagination(t *testing.T) {
	db := kbDB(t)
	aliceFolder, _ := seedDocs(t, db)
	for i := 0; i < 4; i++ {
		if _, err := serverstore.CreateKBDocument(db, aliceFolder, "公共文档", "公共知识内容", "text", 0, "upload", "alice"); err != nil {
			t.Fatal(err)
		}
	}
	// alice has 5 accessible docs total
	res, total, err := Search(db, "alice", nil, "知识", 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	if total != 5 {
		t.Fatalf("total = %d, want 5", total)
	}
	if len(res) != 2 {
		t.Fatalf("page1 len = %d, want 2", len(res))
	}
	res, total, err = Search(db, "alice", nil, "知识", 3, 2)
	if err != nil {
		t.Fatal(err)
	}
	if total != 5 || len(res) != 1 {
		t.Fatalf("page3: total=%d len=%d, want 5/1", total, len(res))
	}
}

func TestRevokeInvalidatesSearch(t *testing.T) {
	db := kbDB(t)
	aliceFolder, _ := seedDocs(t, db)

	res, total, err := Search(db, "alice", nil, "知识", 1, 10)
	if err != nil || total != 1 {
		t.Fatalf("before revoke: total=%d err=%v", total, err)
	}
	if err := serverstore.RevokeFolderUser(db, aliceFolder, "alice"); err != nil {
		t.Fatal(err)
	}
	// permission is checked per query: revoke takes effect immediately
	res, total, err = Search(db, "alice", nil, "知识", 1, 10)
	if err != nil || total != 0 || len(res) != 0 {
		t.Fatalf("after revoke: total=%d res=%v err=%v, want empty", total, res, err)
	}
}

func TestUpdateDocumentReindexesFTS(t *testing.T) {
	db := kbDB(t)
	aliceFolder, _ := seedDocs(t, db)

	id, err := IndexDocument(db, aliceFolder, "变更日志", "旧版本功能描述", "text", "upload", "admin")
	if err != nil {
		t.Fatal(err)
	}
	res, total, _ := Search(db, "alice", nil, "旧版本功能", 1, 10)
	if total != 1 || res[0].ID != id {
		t.Fatalf("before update: total=%d", total)
	}

	if err := UpdateDocument(db, id, "变更日志", "全新特性描述"); err != nil {
		t.Fatal(err)
	}
	// new content searchable
	res, total, _ = Search(db, "alice", nil, "全新特性", 1, 10)
	if total != 1 || res[0].ID != id {
		t.Fatalf("new content: total=%d res=%v", total, res)
	}
	// old content gone from the index
	res, total, _ = Search(db, "alice", nil, "旧版本功能", 1, 10)
	if total != 0 || len(res) != 0 {
		t.Fatalf("old content still hits: total=%d res=%v", total, res)
	}
	// title update reflected
	res, total, _ = Search(db, "alice", nil, "变更日志", 1, 10)
	if total != 1 || res[0].Title != "变更日志" {
		t.Fatalf("title search: total=%d res=%v", total, res)
	}
	// size recomputed
	doc, err := serverstore.GetKBDocument(db, id)
	if err != nil || doc.Size != int64(len("全新特性描述")) {
		t.Fatalf("size = %d err=%v", doc.Size, err)
	}
}

func TestIndexDocument(t *testing.T) {
	db := kbDB(t)
	aliceFolder, _ := seedDocs(t, db)

	// txt/md accepted as-is; docx/pdf extraction lands in task 4.2
	id, err := IndexDocument(db, aliceFolder, "读我", "这是读我文件的内容", "text", "upload", "alice")
	if err != nil || id == 0 {
		t.Fatalf("IndexDocument: %d %v", id, err)
	}
	doc, err := serverstore.GetKBDocument(db, id)
	if err != nil || doc.Title != "读我" {
		t.Fatalf("GetKBDocument: %v %+v", err, doc)
	}
}

// C-5: pagination stays correct on a large dataset; total is exact and pages
// never overlap or drop hits (SQL-level LIMIT/OFFSET + separate COUNT).
func TestSearchLargePagination(t *testing.T) {
	db := kbDB(t)
	aliceFolder, _ := seedDocs(t, db)
	for i := 0; i < 247; i++ {
		if _, err := serverstore.CreateKBDocument(db, aliceFolder,
			fmt.Sprintf("公共文档%d", i), "公共知识内容 填充文本", "text", 0, "upload", "alice"); err != nil {
			t.Fatal(err)
		}
	}
	const totalWant = 248 // 1 seed + 247
	seen := map[int64]bool{}
	sum := 0
	pages := 0
	for page := 1; ; page++ {
		res, total, err := Search(db, "alice", nil, "知识", page, 20)
		if err != nil {
			t.Fatal(err)
		}
		if total != totalWant {
			t.Fatalf("page %d total = %d, want %d", page, total, totalWant)
		}
		if len(res) == 0 {
			break
		}
		pages++
		if pages > 20 {
			t.Fatalf("more than 20 pages for %d hits", totalWant)
		}
		for _, r := range res {
			if seen[r.ID] {
				t.Fatalf("doc %d duplicated across pages", r.ID)
			}
			seen[r.ID] = true
		}
		sum += len(res)
	}
	if sum != totalWant || len(seen) != totalWant {
		t.Fatalf("sum=%d unique=%d, want %d", sum, len(seen), totalWant)
	}
}

// C-4: a pending row whose raw upload file never landed (INSERT/Rename race,
// manual deletion) is skipped — not marked error, not extracted.
func TestProcessPendingSkipsMissingFile(t *testing.T) {
	db := kbDB(t)
	id, err := serverstore.CreatePendingKBDocument(db, 0, "孤儿文档", "text", 5, "upload", "admin")
	if err != nil || id == 0 {
		t.Fatalf("CreatePendingKBDocument: %d %v", id, err)
	}
	if processNextPending(db, t.TempDir()) {
		t.Fatal("processNextPending with missing file returned true")
	}
	doc, err := serverstore.GetKBDocument(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Status != "pending" || doc.Error != "" {
		t.Fatalf("doc = %+v, want pending with no error (skipped)", doc)
	}
}

// H2: an orphaned pending row (raw file missing beyond the grace period,
// e.g. crash mid-save + startup temp sweep) is marked error so it can never
// block the queue head; healthy docs behind it still drain.
func TestProcessPendingOrphanMarkedError(t *testing.T) {
	db := kbDB(t)
	dir := t.TempDir()
	id, err := serverstore.CreatePendingKBDocument(db, 0, "孤儿文档", "text", 5, "upload", "admin")
	if err != nil || id == 0 {
		t.Fatalf("CreatePendingKBDocument: %d %v", id, err)
	}
	// age the row beyond the grace period (INSERT→Rename window is ~instant)
	if _, err := db.Exec("UPDATE kb_documents SET created_at = datetime('now','localtime','-1 hour') WHERE id = ?", id); err != nil {
		t.Fatal(err)
	}
	if !processNextPending(db, dir) {
		t.Fatal("processNextPending should report work for an orphaned row")
	}
	doc, err := serverstore.GetKBDocument(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Status != "error" || !strings.Contains(doc.Error, "原始文件") {
		t.Fatalf("doc = %+v, want error (orphan, missing raw file)", doc)
	}
	// a healthy doc behind the orphan still drains in the next call
	id2, err := serverstore.CreatePendingKBDocument(db, 0, "健康文档", "text", 5, "upload", "admin")
	if err != nil || id2 == 0 {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, strconv.FormatInt(id2, 10)), []byte("健康内容"), 0644); err != nil {
		t.Fatal(err)
	}
	if !processNextPending(db, dir) {
		t.Fatal("healthy doc should be processed")
	}
	d2, err := serverstore.GetKBDocument(db, id2)
	if err != nil {
		t.Fatal(err)
	}
	if d2.Status != "ready" {
		t.Fatalf("healthy doc = %+v, want ready", d2)
	}
}

// 审计 6-K4: orphaned kb-* temp files from crashed uploads are swept at
// startup; numeric raw-upload files (keyed by doc id) are kept.
func TestCleanupUploadTempFiles(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"kb-12345", "kb-abc", "42"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	CleanupUploadTempFiles(dir)
	for _, name := range []string{"kb-12345", "kb-abc"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("temp file %s not swept", name)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "42")); err != nil {
		t.Fatalf("raw upload file removed: %v", err)
	}
}
