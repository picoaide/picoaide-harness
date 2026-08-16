package llmgateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"testing"
)

// seedEmbeddingModel reuses the fake upstream for model "bge-m3" so the
// embeddings route and the in-process Embedder share the same routing path.
func seedEmbeddingModel(t *testing.T, db *sql.DB, f *fakeUpstream) {
	t.Helper()
	if _, err := db.Exec(`UPDATE gateway_providers SET models = '["deepseek-chat","bge-m3"]' WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO models (name, provider_id, display_name) VALUES ('bge-m3', 1, 'BGE-M3')`); err != nil {
		t.Fatal(err)
	}
}

func TestEmbeddingsRoute(t *testing.T) {
	f := newFakeUpstream(t)
	f.nonStream = `{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.1,0.2,0.3]}],"model":"bge-m3","usage":{"prompt_tokens":4,"total_tokens":4}}`
	r, db, token := newGateway(t, f)
	defer db.Close()
	seedEmbeddingModel(t, db, f)

	w := doPost(t, r, "/v1/embeddings", `{"model":"bge-m3","input":"报销政策"}`, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out["model"] != "bge-m3" {
		t.Fatalf("model = %v", out["model"])
	}
	// upstream Authorization is replaced with the upstream key
	if auth := f.gotAuth.Load(); auth != "Bearer sk-upstream-test" {
		t.Fatalf("upstream auth = %v", auth)
	}
	// usage metered for the caller
	var n int64
	if err := db.QueryRow("SELECT COUNT(*) FROM usage WHERE user_id = ? AND model = 'bge-m3'", 1).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("usage rows = %d, want 1", n)
	}
}

func TestEmbeddingsRouteArrayInput(t *testing.T) {
	f := newFakeUpstream(t)
	f.nonStream = `{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.1]},{"object":"embedding","index":1,"embedding":[0.2]}],"model":"bge-m3","usage":{"prompt_tokens":8,"total_tokens":8}}`
	r, db, token := newGateway(t, f)
	defer db.Close()
	seedEmbeddingModel(t, db, f)

	w := doPost(t, r, "/v1/embeddings", `{"model":"bge-m3","input":["a","b"]}`, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", w.Code, w.Body.String())
	}
}

func TestEmbeddingsRouteUnknownModel(t *testing.T) {
	r, db, token := newGateway(t, nil)
	defer db.Close()
	w := doPost(t, r, "/v1/embeddings", `{"model":"nope","input":"x"}`, token, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestEmbeddingsRouteAuthAndValidation(t *testing.T) {
	r, db, _ := newGateway(t, nil)
	defer db.Close()
	// no token → 401
	w := doPost(t, r, "/v1/embeddings", `{"model":"bge-m3","input":"x"}`, "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("no token status = %d, want 401", w.Code)
	}
}

func TestEmbedderInProcess(t *testing.T) {
	f := newFakeUpstream(t)
	f.nonStream = `{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.5,0.5]},{"object":"embedding","index":1,"embedding":[-0.5,0.5]}],"model":"bge-m3","usage":{"prompt_tokens":6,"total_tokens":6}}`
	r, db, _ := newGateway(t, f)
	defer db.Close()
	seedEmbeddingModel(t, db, f)
	_ = r

	e := NewEmbedder(db)
	vecs, tokens, err := e.Embed(context.Background(), "bge-m3", []string{"甲", "乙"})
	if err != nil {
		t.Fatal(err)
	}
	if len(vecs) != 2 || len(vecs[0]) != 2 {
		t.Fatalf("vecs = %v", vecs)
	}
	if vecs[0][0] != 0.5 || vecs[1][0] != -0.5 {
		t.Fatalf("vecs = %v", vecs)
	}
	if tokens != 6 {
		t.Fatalf("tokens = %d, want 6", tokens)
	}
}

func TestEmbedderFailover(t *testing.T) {
	f1 := newFakeUpstream(t)
	f1.status = http.StatusInternalServerError
	f2 := newFakeUpstream(t)
	f2.nonStream = `{"object":"list","data":[{"object":"embedding","index":0,"embedding":[1.0]}],"model":"bge-m3","usage":{"total_tokens":3}}`
	r, db, _ := newGateway(t, f1)
	defer db.Close()
	seedEmbeddingModel(t, db, f1)
	// second provider behind the same model
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES ('fake2', ?, ?, '["bge-m3"]')`, f2.baseURL, upstreamKey); err != nil {
		t.Fatal(err)
	}
	_ = r

	e := NewEmbedder(db)
	vecs, _, err := e.Embed(context.Background(), "bge-m3", []string{"x"})
	if err != nil {
		t.Fatalf("failover embed: %v", err)
	}
	if len(vecs) != 1 || vecs[0][0] != 1.0 {
		t.Fatalf("vecs = %v", vecs)
	}
}
