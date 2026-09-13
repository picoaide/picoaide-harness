package llmgateway

// P1-6 回归:计费取价必须跟随**实际命中的 provider**(审计 2026-09-13)。
// 旧实现只按 `WHERE name = ?` 取价(无 ORDER BY),同名模型挂多 provider 时
// 取物理首行 —— 一次 UPDATE(每小时渠道同步的 ON CONFLICT DO UPDATE)就能让
// 单价从 1.00 变成 100.00,未定价的同名行更会让该模型整体 0 元。

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

func TestAuditFixPricingFollowsChosenProvider(t *testing.T) {
	DecryptSecret = func(s string) (string, error) { return s, nil }
	InvalidateUpstreams()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "alice", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}

	// provider#1 指向不可达地址(触发 failover),同名模型定价 1 元/1M
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES
		('cheap', 'http://127.0.0.1:9', 'k1', '["dup-model"]')`); err != nil {
		t.Fatal(err)
	}
	// provider#2 可达,同名模型定价 100 元/1M
	f := &fakeUpstream{status: http.StatusOK, nonStream: `{"id":"x","usage":{"prompt_tokens":1000,"completion_tokens":1000}}`}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, f.nonStream)
	}))
	t.Cleanup(f.srv.Close)
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES
		('pricey', ?, 'k2', '["dup-model"]')`, f.srv.URL); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO models (name, provider_id, display_name, input_price_per_1m, output_price_per_1m) VALUES
		('dup-model', 1, 'dup@cheap', 1, 1), ('dup-model', 2, 'dup@pricey', 100, 100)`); err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterRoutes(r, db)

	w := doPost(t, r, "/v1/chat/completions", `{"model":"dup-model","messages":[{"role":"user","content":"hi"}]}`, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var providerID, pt, ct int64
	var cost float64
	if err := db.QueryRow(`SELECT provider_id, prompt_tokens, completion_tokens, cost FROM usage ORDER BY id DESC LIMIT 1`).
		Scan(&providerID, &pt, &ct, &cost); err != nil {
		t.Fatal(err)
	}
	if providerID != 2 {
		t.Fatalf("usage.provider_id = %d, want 2(实际命中的 provider 必须落库)", providerID)
	}
	// provider#2 的 100 元/1M 才是正确单价:1000+1000 token = 2000/1M*100 = 0.2 元;
	// 若按 provider#1 的 1 元/1M 会算成 0.002 元(100 倍差价)。
	want := 0.2
	if diff := cost - want; diff > 1e-9 || diff < -1e-9 {
		t.Fatalf("cost = %.9f, want %.9f(必须按实际命中的 provider#2 取价)", cost, want)
	}

	// 反向:同名行的物理顺序变化(模拟每小时同步的 UPDATE)不得再影响计价
	if _, err := db.Exec(`UPDATE models SET display_name='dup@cheap-v2' WHERE provider_id = 1 AND name='dup-model'`); err != nil {
		t.Fatal(err)
	}
	serverstore.InvalidateModelConfig()
	in, out, _ := serverstore.ModelPricesForProvider(db, 2, "dup-model")
	if in != 100 || out != 100 {
		t.Fatalf("provider#2 取价 = %v/%v, want 100/100", in, out)
	}
	if in0, _, _ := serverstore.ModelPricesForProvider(db, 0, "dup-model"); in0 != 1 {
		t.Fatalf("providerID=0 的 name 口径应确定性取 provider_id 最小行(1 元), got %v", in0)
	}
}
