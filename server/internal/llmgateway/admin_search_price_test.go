package llmgateway

import (
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// TestAdminGatewaySearchPrice 覆盖 0085 的管理端读写与校验：
// 数字/空串合法；负数、非数字、超上限 400；GET 永远返回具体数值（缺省 "0"）。
func TestAdminGatewaySearchPrice(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	w, out := adminReq(t, r, "GET", "/api/server/admin/gateway", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("gateway get: %d", w.Code)
	}
	if out["search_price_per_1k"] != "0" {
		t.Fatalf("default search_price_per_1k = %v, want \"0\"", out["search_price_per_1k"])
	}

	// JSON number（FlexibleString 兼容第三方直连）
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"search_price_per_1k":5}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("set search price (number): %d %s", w.Code, w.Body.String())
	}
	v, ok, _ := serverstore.GetSetting(db, serverstore.SearchPriceSetting)
	if !ok || v != "5" {
		t.Fatalf("search price not persisted: %q ok=%v", v, ok)
	}
	w, out = adminReq(t, r, "GET", "/api/server/admin/gateway", "", hdr)
	if w.Code != http.StatusOK || out["search_price_per_1k"] != "5" {
		t.Fatalf("readback: %d %v", w.Code, out["search_price_per_1k"])
	}

	// 字符串形态（webadmin 的输入框）
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"search_price_per_1k":"7.5"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("set search price (string): %d %s", w.Code, w.Body.String())
	}
	if v, _, _ := serverstore.GetSetting(db, serverstore.SearchPriceSetting); v != "7.5" {
		t.Fatalf("string search price not persisted: %q", v)
	}

	// 非法值：负数 / 非数字 / 超上限 —— 全部 400 且不改库
	for _, body := range []string{
		`{"search_price_per_1k":-1}`,
		`{"search_price_per_1k":"abc"}`,
		`{"search_price_per_1k":1000.5}`,
	} {
		if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", body, hdr); w.Code != http.StatusBadRequest {
			t.Fatalf("invalid %s accepted: %d", body, w.Code)
		}
	}
	if v, _, _ := serverstore.GetSetting(db, serverstore.SearchPriceSetting); v != "7.5" {
		t.Fatalf("invalid PUT changed stored value: %q", v)
	}

	// 空串 = 关闭按次计费
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"search_price_per_1k":""}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("clear search price: %d %s", w.Code, w.Body.String())
	}
	w, out = adminReq(t, r, "GET", "/api/server/admin/gateway", "", hdr)
	if w.Code != http.StatusOK || out["search_price_per_1k"] != "0" {
		t.Fatalf("after clear: %d %v, want \"0\"", w.Code, out["search_price_per_1k"])
	}
}
