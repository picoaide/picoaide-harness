package knowledge

import (
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// indexTextDoc creates a doc through the full indexing path (content +
// chunks) and returns its id.
func TestIndexDocumentCreatesChunks(t *testing.T) {
	db := kbDB(t)
	folder, err := serverstore.CreateKBFolder(db, "alice-docs", 0)
	if err != nil {
		t.Fatal(err)
	}
	content := "第一章 制度\n第一条 报销标准\n差旅费按标准报销。\n" + strings.Repeat("补充内容。", 50)
	id, err := IndexDocument(db, folder, "差旅制度", content, "text", "upload", "alice")
	if err != nil {
		t.Fatal(err)
	}
	n, err := serverstore.CountChunksByDoc(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if n < 1 {
		t.Fatalf("chunk count = %d, want >= 1", n)
	}
	chunks, err := serverstore.ListChunksByDoc(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if chunks[0].TitlePath == "" {
		t.Fatalf("first chunk has no title path")
	}
	// chunk content and full content must agree at the passage level
	if !strings.Contains(chunks[0].Content, "差旅费按标准报销") {
		t.Fatalf("first chunk content = %q", chunks[0].Content)
	}
}

func TestUpdateDocumentRechunks(t *testing.T) {
	db := kbDB(t)
	folder, err := serverstore.CreateKBFolder(db, "alice-docs", 0)
	if err != nil {
		t.Fatal(err)
	}
	id, err := IndexDocument(db, folder, "旧标题", "旧内容段落", "text", "upload", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if err := UpdateDocument(db, id, "新标题", "全新内容段落"); err != nil {
		t.Fatal(err)
	}
	chunks, err := serverstore.ListChunksByDoc(db, id)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range chunks {
		if strings.Contains(c.Content, "旧内容") {
			t.Fatalf("stale chunk content after update: %q", c.Content)
		}
	}
	found := false
	for _, c := range chunks {
		if strings.Contains(c.Content, "全新内容") {
			found = true
		}
	}
	if !found {
		t.Fatalf("no chunk with new content: %v", chunks)
	}
}

func TestDeleteDocumentCleansChunks(t *testing.T) {
	db := kbDB(t)
	folder, err := serverstore.CreateKBFolder(db, "alice-docs", 0)
	if err != nil {
		t.Fatal(err)
	}
	id, err := IndexDocument(db, folder, "待删除", strings.Repeat("内容", 500), "text", "upload", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if n, _ := serverstore.CountChunksByDoc(db, id); n == 0 {
		t.Fatal("expected chunks before delete")
	}
	if err := serverstore.DeleteKBDocument(db, id); err != nil {
		t.Fatal(err)
	}
	if n, _ := serverstore.CountChunksByDoc(db, id); n != 0 {
		t.Fatalf("chunks left after delete: %d", n)
	}
}

func TestBackfillChunks(t *testing.T) {
	db := kbDB(t)
	folder, err := serverstore.CreateKBFolder(db, "alice-docs", 0)
	if err != nil {
		t.Fatal(err)
	}
	// legacy doc created without chunks (pre-0014 path)
	id, err := serverstore.CreateKBDocument(db, folder, "旧文档", strings.Repeat("历史内容段落。", 100), "text", 0, "upload", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if n, _ := serverstore.CountChunksByDoc(db, id); n != 0 {
		t.Fatalf("fresh doc should have no chunks, got %d", n)
	}
	if err := BackfillChunks(db); err != nil {
		t.Fatal(err)
	}
	if n, _ := serverstore.CountChunksByDoc(db, id); n == 0 {
		t.Fatal("backfill created no chunks")
	}
}

func TestSearchChunksMidToken(t *testing.T) {
	db := kbDB(t)
	folder, err := serverstore.CreateKBFolder(db, "alice-docs", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantFolderUser(db, folder, "alice"); err != nil {
		t.Fatal(err)
	}
	content := "第一章 报销制度\n" + strings.Repeat("背景介绍内容无关。\n", 30) + "差旅费报销政策及流程说明\n" + strings.Repeat("后续补充段落内容。\n", 20)
	id, err := IndexDocument(db, folder, "报销制度", content, "text", "upload", "alice")
	if err != nil {
		t.Fatal(err)
	}
	// 4-rune query: trigram substring on chunk text, mid-token in the doc
	res, total, err := SearchChunks(db, "alice", nil, "报销政策", 1, 10)
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(res) != 1 {
		t.Fatalf("total=%d len=%d, want 1/1", total, len(res))
	}
	if res[0].DocID != id {
		t.Fatalf("hit doc %d, want %d", res[0].DocID, id)
	}
	if !strings.Contains(res[0].Content, "报销政策") {
		t.Fatalf("hit content missing the passage: %q", res[0].Content)
	}
	if res[0].Score <= 0 {
		t.Fatalf("score = %f, want > 0", res[0].Score)
	}
}

func TestSearchChunksShortWord(t *testing.T) {
	db := kbDB(t)
	folder, err := serverstore.CreateKBFolder(db, "alice-docs", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantFolderUser(db, folder, "alice"); err != nil {
		t.Fatal(err)
	}
	// "报销" is 2 runes: chunk trigram cannot match, LIKE path must recall
	id, err := IndexDocument(db, folder, "报销手册", "第一段描述背景信息。\n差旅费报销单据需要粘贴。\n", "text", "upload", "alice")
	if err != nil {
		t.Fatal(err)
	}
	res, total, err := SearchChunks(db, "alice", nil, "报销单据", 1, 10)
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(res) != 1 || res[0].DocID != id {
		t.Fatalf("short-word recall: total=%d res=%v", total, res)
	}
}

func TestSearchChunksPermission(t *testing.T) {
	db := kbDB(t)
	aliceFolder, bobFolder := seedDocs(t, db)
	// alice's folder: full content with 报销 policy passage
	if _, err := IndexDocument(db, aliceFolder, "差旅政策", "差旅费报销政策及流程说明\n", "text", "upload", "alice"); err != nil {
		t.Fatal(err)
	}
	// bob's folder: same passage, bob only
	if _, err := IndexDocument(db, bobFolder, "机密政策", "差旅费报销政策及流程说明\n", "text", "upload", "bob"); err != nil {
		t.Fatal(err)
	}
	res, total, err := SearchChunks(db, "alice", nil, "报销政策", 1, 10)
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(res) != 1 {
		t.Fatalf("alice sees %d hits, want 1 (bob's doc must be filtered)", total)
	}
	_ = res
}

func TestSearchChunksRelevanceAndSnippet(t *testing.T) {
	db := kbDB(t)
	folder, err := serverstore.CreateKBFolder(db, "alice-docs", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantFolderUser(db, folder, "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := IndexDocument(db, folder, "政策一", "差旅费报销政策及流程说明。\n", "text", "upload", "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := IndexDocument(db, folder, "无关文档", "这是一份与差旅无关的文档内容。\n", "text", "upload", "alice"); err != nil {
		t.Fatal(err)
	}
	res, total, err := SearchChunks(db, "alice", nil, "报销政策", 1, 10)
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || res[0].Title != "政策一" {
		t.Fatalf("unrelated doc leaked: total=%d res=%v", total, res)
	}
	// snippet is the matched chunk, not the whole doc
	if len([]rune(res[0].Content)) > maxChunkRunes+overlapRunes {
		t.Fatalf("snippet too long: %d runes", len([]rune(res[0].Content)))
	}
}
