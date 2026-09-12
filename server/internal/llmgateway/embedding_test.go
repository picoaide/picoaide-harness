package llmgateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
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

// 2026-09-11:embedding 路径同样受**余额闸门**约束(配额已下线)。
func TestEmbeddingsBalanceGateBlocked(t *testing.T) {
	f := newFakeUpstream(t)
	f.nonStream = `{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.1]}],"model":"bge-m3","usage":{"prompt_tokens":4,"total_tokens":4}}`
	r, db, token := newGateway(t, f)
	defer db.Close()
	seedEmbeddingModel(t, db, f)

	if err := serverstore.SaveBalanceSettings(db, serverstore.BalanceSettings{Enabled: true, MonthlyMode: serverstore.BalanceModeAdd}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.SetUserBalance(db, 1, 1, "t", "tester"); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.SetUserBalance(db, 1, 0, "t", "tester"); err != nil {
		t.Fatal(err)
	}

	w := doPost(t, r, "/v1/embeddings", `{"model":"bge-m3","input":"报销政策"}`, token, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if code := out["error"].(map[string]any)["code"]; code != "BALANCE_EXHAUSTED" {
		t.Fatalf("code = %v", code)
	}
	if n := f.requests.Load(); n != 0 {
		t.Fatalf("upstream calls = %d, want 0", n)
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

// P1-4(审计 2026-09-12):embedder 的出站 client 必须与 chat/sse 装同一套
// 拨号期 IP 复检(防 DNS rebinding 把 provider API key 发往云 metadata)。
// 旧实现 `&http.Client{Timeout:...}` 的 Transport == nil → http.DefaultTransport,
// 保存时的静态校验管不到运行期解析结果。
func TestEmbedderOutboundTransportHasDialRecheck(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	e := NewEmbedder(db)
	tr, ok := e.client.Transport.(*http.Transport)
	if !ok || tr == nil {
		t.Fatalf("embedder transport = %#v, want *http.Transport(不能是 DefaultTransport 裸奔)", e.client.Transport)
	}
	if tr.DialContext == nil {
		t.Fatal("embedder transport 未安装 DialContext:缺拨号期 IP 复检")
	}
	got := reflect.ValueOf(tr.DialContext).Pointer()
	want := reflect.ValueOf(util.SafeOutboundDialContext).Pointer()
	if got != want {
		t.Fatal("embedder transport 的 DialContext 不是 util.SafeOutboundDialContext")
	}
}

// P1-4 行为验证:provider 指向云 metadata(169.254.169.254)时必须在拨号期
// 直接被拒(而不是把带 key 的请求发出去)。
func TestEmbedderBlocksMetadataUpstreamAtDial(t *testing.T) {
	_, db, _ := newGateway(t, nil)
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models)
VALUES ('meta', 'http://169.254.169.254', ?, '["bge-m3"]')`, upstreamKey); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO models (name, provider_id, display_name) VALUES ('bge-m3', 1, 'BGE-M3')`); err != nil {
		t.Fatal(err)
	}
	e := NewEmbedder(db)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err := e.Embed(ctx, "bge-m3", []string{"x"})
	if err == nil || !strings.Contains(err.Error(), "link-local/metadata") {
		t.Fatalf("err = %v, want link-local/metadata blocked at dial", err)
	}
}

// P0-B(审计 2026-09-12):embedding 解析边界同样把上游回报的负 token 归零
// (否则负费用 → refund → 余额凭空增加)。
func TestEmbedderClampsNegativeTokens(t *testing.T) {
	f := newFakeUpstream(t)
	f.nonStream = `{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.1]}],"model":"bge-m3","usage":{"prompt_tokens":-9,"total_tokens":-9}}`
	_, db, _ := newGateway(t, f)
	defer db.Close()
	seedEmbeddingModel(t, db, f)
	e := NewEmbedder(db)
	_, tokens, err := e.Embed(context.Background(), "bge-m3", []string{"x"})
	if err != nil {
		t.Fatal(err)
	}
	if tokens != 0 {
		t.Fatalf("tokens = %d, want 0(负 token 必须归零)", tokens)
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
