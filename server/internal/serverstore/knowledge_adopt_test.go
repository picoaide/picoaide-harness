package serverstore

import (
	"testing"
)

// H3: AdoptKBDocumentEdit overwrites title/content (replacing chunks) and
// transitions an error/pending doc to ready atomically — "edit takes over",
// so the async queue can never clobber the edited content afterwards.
func TestAdoptKBDocumentEdit(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	id, err := CreatePendingKBDocument(db, 0, "坏文档", "text", 5, "upload", "admin")
	if err != nil || id == 0 {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE kb_documents SET status='error', error='提取失败' WHERE id=?", id); err != nil {
		t.Fatal(err)
	}
	chunks := []KBChunk{{Seq: 1, Content: "修复后内容", CharStart: 0, CharEnd: 10}}
	if err := AdoptKBDocumentEdit(db, id, "修复后标题", "修复后内容", "text", chunks); err != nil {
		t.Fatalf("AdoptKBDocumentEdit: %v", err)
	}
	doc, err := GetKBDocument(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Status != "ready" || doc.Error != "" || doc.Content != "修复后内容" {
		t.Fatalf("doc after adopt = %+v", doc)
	}
	// a fresh pending row is also adoptable (edit wins over the queue)
	id2, _ := CreatePendingKBDocument(db, 0, "另一个", "text", 5, "upload", "admin")
	if err := AdoptKBDocumentEdit(db, id2, "t", "c", "text", nil); err != nil {
		t.Fatalf("adopt pending: %v", err)
	}
	d2, _ := GetKBDocument(db, id2)
	if d2.Status != "ready" {
		t.Fatalf("pending adopt = %+v", d2)
	}
}
