package llmgateway

import (
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// 每用户限流缺省 0 = 不限制（2026-09-22 与官方口径一致：官方只限账号级并发、
// 不设请求速率上限）。这条判据钉住"管理端能保存 0 且落库"——只钉常量的话，
// 校验层（admin.go 的 0~100000）与 GET 回显（缺省 "0"）漂移时不会红。
func TestGatewayRateLimitZeroIsAcceptedAndStored(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, out := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"rate_limit":"0"}`, hdr); w.Code != 200 {
		t.Fatalf("PUT rate_limit=0 被拒: %d %s", w.Code, out)
	}
	if got, _, _ := serverstore.GetSetting(db, "gateway.rate_limit"); got != "0" {
		t.Fatalf("gateway.rate_limit = %q, want \"0\"", got)
	}
	// GET 必须原样回 0（页面的 min=0 与校验文案都以它为准）
	w, out := adminReq(t, r, "GET", "/api/server/admin/gateway", "", hdr)
	if w.Code != 200 {
		t.Fatalf("GET gateway: %d", w.Code)
	}
	if got, _ := out["rate_limit"].(string); got != "0" {
		t.Fatalf("GET rate_limit = %v, want \"0\"", out["rate_limit"])
	}
}

// 未配置过限流的部署：GET 必须回 "0"（缺省 = 不限制），页面保存才不会因为
// 前端校验把自己拦住（审计 2026-09-22 P0 的服务端侧对照）。
func TestGatewayRateLimitDefaultEchoesZeroWhenUnset(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	w, out := adminReq(t, r, "GET", "/api/server/admin/gateway", "", hdr)
	if w.Code != 200 {
		t.Fatalf("GET gateway: %d", w.Code)
	}
	if got, _ := out["rate_limit"].(string); got != "0" {
		t.Fatalf("未配置时 GET rate_limit = %v, want \"0\"（缺省不限制）", out["rate_limit"])
	}
}

// 越界值仍必须被拒（0~100000 之外）。
func TestGatewayRateLimitRejectsOutOfRange(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	for _, body := range []string{`{"rate_limit":"-1"}`, `{"rate_limit":"100001"}`, `{"rate_limit":"abc"}`} {
		if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", body, hdr); w.Code != 400 {
			t.Fatalf("PUT %s 应 400，实得 %d", body, w.Code)
		}
	}
}
