package knowledge

import (
	"context"
	"math"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// fakeEmbedder maps exact texts to fixed vectors (8-dim), with semantic
// aliases: both "客户满意度" and "customer satisfaction" → same vector.
type fakeEmbedder struct {
	aliases map[string][]float32
}

func newFakeEmbedder() *fakeEmbedder {
	customer := []float32{0, 1, 0, 0, 0, 0, 0, 0}
	report := []float32{0, 0, 1, 0, 0, 0, 0, 0}
	return &fakeEmbedder{aliases: map[string][]float32{
		"客户满意度":                 customer,
		"customer satisfaction": customer,
		"满意度报告":                 report,
		"客户满意度调研报告":             report,
	}}
}

func (f *fakeEmbedder) Embed(_ context.Context, _ string, texts []string) ([][]float32, int64, error) {
	out := make([][]float32, len(texts))
	for i, t := range texts {
		if v, ok := f.aliases[t]; ok {
			out[i] = append([]float32(nil), v...)
			continue
		}
		// deterministic hash vector so every text embeds
		v := make([]float32, 8)
		s := 0.0
		for _, r := range t {
			s = s*1.7 + float64(r)
		}
		v[0] = float32(math.Mod(s, 1.0))
		v[1] = 1 - v[0]
		out[i] = v
	}
	return out, 0, nil
}

func TestEmbedMissingChunks(t *testing.T) {
	db := kbDB(t)
	folder, err := serverstore.CreateKBFolder(db, "alice-docs", 0)
	if err != nil {
		t.Fatal(err)
	}
	id, err := IndexDocument(db, folder, "调研", "客户满意度调研报告内容。\n", "text", "upload", "alice")
	if err != nil {
		t.Fatal(err)
	}
	nChunks, err := serverstore.CountChunksByDoc(db, id)
	if err != nil || nChunks == 0 {
		t.Fatalf("chunks: %d %v", nChunks, err)
	}
	if err := serverstore.SetSetting(db, EmbeddingModelSetting, "bge-m3"); err != nil {
		t.Fatal(err)
	}
	n, err := embedMissingChunks(context.Background(), db, newFakeEmbedder(), "bge-m3", id)
	if err != nil {
		t.Fatal(err)
	}
	if int64(n) != nChunks {
		t.Fatalf("embedded %d, want %d chunks", n, nChunks)
	}
	// idempotent: second pass embeds nothing
	n, err = embedMissingChunks(context.Background(), db, newFakeEmbedder(), "bge-m3", id)
	if err != nil || n != 0 {
		t.Fatalf("second pass: n=%d err=%v, want 0", n, err)
	}
	// vectors stored normalized (unit length)
	var raw []byte
	var dims int
	if err := db.QueryRow("SELECT vector, dims FROM kb_chunk_embeddings WHERE chunk_id = (SELECT id FROM kb_chunks WHERE doc_id = ? LIMIT 1)", id).Scan(&raw, &dims); err != nil {
		t.Fatal(err)
	}
	if len(raw) != dims*4 {
		t.Fatalf("blob %d bytes, dims %d", len(raw), dims)
	}
	v := decodeF32(raw)
	norm := 0.0
	for _, x := range v {
		norm += float64(x) * float64(x)
	}
	if math.Abs(norm-1) > 1e-4 {
		t.Fatalf("vector not normalized: %f", norm)
	}
}

// semantic recall: the query has zero lexical overlap with the document
// text, only the vector path can surface it.
func TestHybridSemanticRecall(t *testing.T) {
	db := kbDB(t)
	folder, err := serverstore.CreateKBFolder(db, "alice-docs", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantFolderUser(db, folder, "alice"); err != nil {
		t.Fatal(err)
	}
	// "customer satisfaction" query text must NOT appear anywhere in docs
	docID, err := IndexDocument(db, folder, "调研报告", "客户满意度调研报告内容包含大量细节。\n", "text", "upload", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, EmbeddingModelSetting, "bge-m3"); err != nil {
		t.Fatal(err)
	}
	SetEmbedder(newFakeEmbedder())
	t.Cleanup(func() { SetEmbedder(nil) })

	// embed the doc's chunks first (the background loop does this in prod)
	if _, err := embedMissingChunks(context.Background(), db, newFakeEmbedder(), "bge-m3", docID); err != nil {
		t.Fatal(err)
	}

	// lexical-only finds nothing
	res, total, err := SearchChunks(db, "alice", nil, "customer satisfaction", 1, 10)
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(res) != 1 {
		t.Fatalf("hybrid recall: total=%d res=%v, want the semantic-only doc", total, res)
	}
	if res[0].DocID != docID {
		t.Fatalf("hit doc %d, want %d", res[0].DocID, docID)
	}
	if res[0].Score <= 0 {
		t.Fatalf("score = %f, want > 0", res[0].Score)
	}
}

// fusion: a chunk that both lexical and vector agree on ranks above one
// only one route found.
func TestHybridFusionRanksDoubleHitFirst(t *testing.T) {
	db := kbDB(t)
	folder, err := serverstore.CreateKBFolder(db, "alice-docs", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantFolderUser(db, folder, "alice"); err != nil {
		t.Fatal(err)
	}
	// both: contains "报销政策" lexically AND vector-matches 客户满意度 alias
	if _, err := IndexDocument(db, folder, "双命中", "报销政策与客户满意度调研报告。\n", "text", "upload", "alice"); err != nil {
		t.Fatal(err)
	}
	// vector-only: 满意度报告 alias, no lexical overlap with the query
	if _, err := IndexDocument(db, folder, "向量命中", "纯语义内容的满意度分析报告。\n", "text", "upload", "alice"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, EmbeddingModelSetting, "bge-m3"); err != nil {
		t.Fatal(err)
	}
	SetEmbedder(newFakeEmbedder())
	t.Cleanup(func() { SetEmbedder(nil) })
	for _, docID := range []int64{1, 2} {
		if _, err := embedMissingChunks(context.Background(), db, newFakeEmbedder(), "bge-m3", docID); err != nil {
			t.Fatal(err)
		}
	}
	res, total, err := SearchChunks(db, "alice", nil, "客户满意度", 1, 10)
	if err != nil {
		t.Fatal(err)
	}
	if total != 2 || len(res) != 2 {
		t.Fatalf("total=%d len=%d, want 2/2", total, len(res))
	}
	if res[0].DocID != 1 {
		t.Fatalf("double-hit doc %d not first: %v", res[0].DocID, res)
	}
	if res[1].DocID != 2 {
		t.Fatalf("vector-only doc missing: %v", res)
	}
}

// degradation: no embedder configured → pure lexical search, no error.
func TestSearchChunksDegradesWithoutEmbedder(t *testing.T) {
	db := kbDB(t)
	folder, err := serverstore.CreateKBFolder(db, "alice-docs", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantFolderUser(db, folder, "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := IndexDocument(db, folder, "报销手册", "差旅费报销政策及流程说明。\n", "text", "upload", "alice"); err != nil {
		t.Fatal(err)
	}
	SetEmbedder(nil) // no vectors at all
	_ = serverstore.SetSetting(db, EmbeddingModelSetting, "bge-m3")
	res, total, err := SearchChunks(db, "alice", nil, "报销政策", 1, 10)
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(res) != 1 {
		t.Fatalf("degraded search: total=%d res=%v", total, res)
	}
	// embedder configured but upstream fails → still lexical, no error
	SetEmbedder(panicEmbedder{})
	res, total, err = SearchChunks(db, "alice", nil, "报销政策", 1, 10)
	if err != nil || total != 1 {
		t.Fatalf("embed-fail search: total=%d res=%v err=%v", total, res, err)
	}
}

// panicEmbedder fails every embed (upstream unavailable simulation).
type panicEmbedder struct{}

func (panicEmbedder) Embed(ctx context.Context, model string, texts []string) ([][]float32, int64, error) {
	return nil, 0, errEmbedUpstream
}
