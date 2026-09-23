package llmgateway

import (
	"fmt"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// TestDeleteModelRemovesUpstreamRoute 覆盖 P1-8:删除模型必须同时从
// gateway_providers.models JSON 移除该名,否则 mergeModelNames 仍让路由匹配到
// 已删模型——模型从 /v1/models 消失却仍可调用,且 ModelPrices 查不到行 → cost=0。
func TestDeleteModelRemovesUpstreamRoute(t *testing.T) {
	InvalidateUpstreams()
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	orig := DecryptSecret
	DecryptSecret = func(s string) (string, error) { return s, nil }
	t.Cleanup(func() {
		DecryptSecret = orig
		InvalidateUpstreams()
	})

	pid, err := serverstore.AddGatewayProvider(db, &serverstore.GatewayProvider{
		Name: "p1-8", BaseURL: "http://up", APIKeyEnc: "k", Models: []string{"m1", "m2"}, Enabled: 1, Protocol: "openai",
	})
	if err != nil {
		t.Fatal(err)
	}
	// models 表镜像(渠道同步建行)——正是路由第二个来源
	if err := serverstore.SyncProviderModels(db, pid, []string{"m1", "m2"}); err != nil {
		t.Fatal(err)
	}
	InvalidateUpstreams()

	if ups, err := MatchModelsByProtocol(db, "m1", "openai"); err != nil || len(ups) != 1 {
		t.Fatalf("before delete: route m1 = %+v err=%v, want 1 upstream", ups, err)
	}

	var id int64
	if err := db.QueryRow(`SELECT id FROM models WHERE provider_id = ? AND name = 'm1'`, pid).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.DeleteModel(db, id); err != nil {
		t.Fatal(err)
	}
	InvalidateUpstreams()

	// 删除后:路由不再匹配该模型(等价于 /v1/chat/completions 返回 MODEL_NOT_FOUND)
	ups, err := MatchModelsByProtocol(db, "m1", "openai")
	if err != nil {
		t.Fatal(err)
	}
	if len(ups) != 0 {
		t.Fatalf("deleted model still routable: %+v", ups)
	}
	// 其它模型不受影响
	if ups2, err := MatchModelsByProtocol(db, "m2", "openai"); err != nil || len(ups2) != 1 {
		t.Fatalf("sibling model route = %+v err=%v, want 1", ups2, err)
	}
	var raw string
	if err := db.QueryRow(`SELECT models FROM gateway_providers WHERE id = ?`, pid).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, "m1") {
		t.Fatalf("provider models JSON still lists deleted model: %s", raw)
	}
}

// TestCatalogBounceKeepsPriceAndRoute 覆盖 G-02(审计 2026-09-23,P1)的完整往返:
// 上游 /models 目录抖动一轮 —— 该模型必须从**路由池与客户端目录**里消失
// (可用性过滤),但**定价与 default_params 一字未动**;下一轮目录恢复后重新
// 可路由且价格不变。旧行为:抖动即物理 DELETE(价格随之消失),下一轮以无价
// 新行插回 ⇒ 该模型永久免费,而且无日志、无审计。
func TestCatalogBounceKeepsPriceAndRoute(t *testing.T) {
	InvalidateUpstreams()
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	orig := DecryptSecret
	DecryptSecret = func(s string) (string, error) { return s, nil }
	t.Cleanup(func() {
		DecryptSecret = orig
		InvalidateUpstreams()
	})

	pid, err := serverstore.AddGatewayProvider(db, &serverstore.GatewayProvider{
		Name: "p-bounce", BaseURL: "http://up", APIKeyEnc: "k", Enabled: 1, Protocol: "openai",
	})
	if err != nil {
		t.Fatal(err)
	}
	const params = `{"context_length":128000,"max_output":8192}`
	if err := serverstore.SyncProviderModel(db, pid, "m-bounce", params); err != nil {
		t.Fatal(err)
	}
	var modelID int64
	if err := db.QueryRow(`SELECT id FROM models WHERE provider_id = ? AND name = 'm-bounce'`, pid).Scan(&modelID); err != nil {
		t.Fatal(err)
	}
	in, out := 3.0, 7.0
	if err := serverstore.UpdateModel(db, &serverstore.Model{
		ID: modelID, Name: "m-bounce", ProviderID: pid, DisplayName: "m-bounce",
		DefaultParams: params, InputModalities: []string{"text"},
		InputPricePer1M: &in, OutputPricePer1M: &out,
	}); err != nil {
		t.Fatal(err)
	}
	InvalidateUpstreams()

	routeCount := func() int {
		t.Helper()
		ups, err := MatchModelsByProtocol(db, "m-bounce", "openai")
		if err != nil {
			t.Fatal(err)
		}
		return len(ups)
	}
	listedCount := func() int {
		t.Helper()
		ms, err := ListModels(db)
		if err != nil {
			t.Fatal(err)
		}
		return len(ms)
	}
	// price 返回(输入价, 输出价, default_params, catalog_missing)
	price := func() (float64, float64, string, bool) {
		t.Helper()
		pin, pout, _ := serverstore.ModelPricesForProvider(db, pid, "m-bounce")
		m, err := serverstore.GetModel(db, modelID)
		if err != nil {
			t.Fatalf("模型行消失(定价已被摧毁): %v", err)
		}
		return pin, pout, m.DefaultParams, m.CatalogMissing
	}

	if routeCount() != 1 || listedCount() != 1 {
		t.Fatalf("目录正常时 route=%d models=%d, want 1/1", routeCount(), listedCount())
	}

	// ── 一轮抖动:上游目录里没有这个模型(超时/降级/返回子集)
	removed, err := serverstore.RemoveMissingProviderModels(db, pid, nil)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
	InvalidateUpstreams()
	if n := routeCount(); n != 0 {
		t.Fatalf("目录缺失的模型仍可路由(%d 个上游):可用性过滤未生效", n)
	}
	if n := listedCount(); n != 0 {
		t.Fatalf("目录缺失的模型仍在客户端目录(%d 行)", n)
	}
	pin, pout, pparams, missing := price()
	if pin != in || pout != out {
		t.Fatalf("抖动后价格 = %v/%v, want %v/%v", pin, pout, in, out)
	}
	if pparams != params {
		t.Fatalf("抖动后 default_params = %q, want %q", pparams, params)
	}
	if !missing {
		t.Fatalf("抖动后 catalog_missing = false, want true(有价行必须停用而非删除)")
	}

	// ── 下一轮目录恢复:同名模型回来了
	if err := serverstore.SyncProviderModel(db, pid, "m-bounce", params); err != nil {
		t.Fatal(err)
	}
	InvalidateUpstreams()
	if n := routeCount(); n != 1 {
		t.Fatalf("目录恢复后仍不可路由:route=%d, want 1", n)
	}
	if n := listedCount(); n != 1 {
		t.Fatalf("目录恢复后仍不在客户端目录:models=%d, want 1", n)
	}
	pin, pout, pparams, missing = price()
	if pin != in || pout != out {
		t.Fatalf("往返后价格 = %v/%v, want %v/%v(目录抖动不得改变定价)", pin, pout, in, out)
	}
	if pparams != params {
		t.Fatalf("往返后 default_params = %q, want %q", pparams, params)
	}
	if missing {
		t.Fatalf("目录恢复后 catalog_missing 仍为 true")
	}
}

// TestLoadUpstreamsSkipsBrokenProvider: one provider with an undecryptable
// key must not abort the whole gateway; the healthy provider still loads.
func TestLoadUpstreamsSkipsBrokenProvider(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, enabled) VALUES ('good', 'https://a', 'decryptable', '["m1"]', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, enabled) VALUES ('bad', 'https://b', 'broken', '["m2"]', 1)`); err != nil {
		t.Fatal(err)
	}

	orig := DecryptSecret
	DecryptSecret = func(s string) (string, error) {
		if s == "broken" {
			return "", fmt.Errorf("cannot decrypt")
		}
		return s, nil
	}
	t.Cleanup(func() { DecryptSecret = orig })

	ups, err := LoadUpstreams(db)
	if err != nil {
		t.Fatalf("LoadUpstreams = %v, want nil", err)
	}
	if len(ups) != 1 || ups[0].Name != "good" {
		t.Fatalf("ups = %+v, want only the good provider", ups)
	}
	if len(ups[0].Models) != 1 || ups[0].Models[0] != "m1" {
		t.Fatalf("models = %v", ups[0].Models)
	}
}
