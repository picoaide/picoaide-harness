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
