package connectors

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

func setup(t *testing.T) (*gin.Engine, *sql.DB, map[string]string) {
	t.Helper()
	t.Setenv("PICOAI_LOGIN_MAX_ATTEMPTS", "1000")
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef0123456789abcdef")
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	if _, err := serverstore.CreateUserWithPassword(db, "boss", "pw123456"); err != nil {
		t.Fatal(err)
	}
	us, _ := serverstore.GetUserByUsername(db, "boss")
	us.IsAdmin = true
	if err := serverstore.UpdateUser(db, us); err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	serverauth.RegisterAdminRoutes(r, db)
	RegisterAdminRoutes(r, db)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/server/admin/login", strings.NewReader(`{"username":"boss","password":"pw123456"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	csrf, _ := out["csrf_token"].(string)
	sess := ""
	for _, ck := range w.Result().Cookies() {
		if ck.Name == "picoaide_session" {
			sess = ck.Value
		}
	}
	adminHdr := map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}
	return r, db, adminHdr
}

func doJSON(t *testing.T, r http.Handler, method, path string, body string, hdr map[string]string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

// TestConnectorAdminLifecycle: 列表(种子2)→ 创建 → 更新 → 禁用(下发过滤)
// → 删除。创建重复 id 409;非法参数 400。
func TestConnectorAdminLifecycle(t *testing.T) {
	r, db, hdr := setup(t)

	// 列表含种子。
	w, out := doJSON(t, r, "GET", "/api/server/admin/connectors", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("list = %d %s", w.Code, w.Body.String())
	}
	conns := out["connectors"].([]any)
	if len(conns) < 3 {
		t.Fatalf("listed = %d, want >= 3", len(conns))
	}

	// 创建。
	body := `{"id":"feishu","name":"飞书","description":"协作","auth_mode":"token",
		"definition":"{\"tokenFields\":[{\"key\":\"TOKEN\",\"label\":\"Token\",\"type\":\"password\",\"required\":true}],\"mcp\":[{\"serverName\":\"feishu\",\"transport\":\"streamable-http\",\"url\":\"https://mcp.example.com\"}]}","enabled":true}`
	w, out = doJSON(t, r, "POST", "/api/server/admin/connectors", body, hdr)
	if w.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}
	if out["connector"].(map[string]any)["id"] != "feishu" {
		t.Fatalf("created id = %v", out["connector"])
	}
	// 重复 id → 409。
	w, _ = doJSON(t, r, "POST", "/api/server/admin/connectors", body, hdr)
	if w.Code != http.StatusConflict {
		t.Fatalf("dup create = %d, want 409", w.Code)
	}
	// 非法参数 → 400。
	w, _ = doJSON(t, r, "POST", "/api/server/admin/connectors",
		`{"id":"x!","name":"X","auth_mode":"cli","definition":"{}"}`, hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid create = %d, want 400", w.Code)
	}

	// 更新名称/启用状态。
	upd := `{"name":"飞书协作","description":"更新","auth_mode":"token",
		"definition":"{\"tokenFields\":[{\"key\":\"TOKEN\",\"label\":\"Token\",\"type\":\"password\",\"required\":true}],\"mcp\":[{\"serverName\":\"feishu\",\"transport\":\"streamable-http\",\"url\":\"https://mcp.example.com\"}]}","enabled":false}`
	w, out = doJSON(t, r, "PUT", "/api/server/admin/connectors/feishu", upd, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("update = %d %s", w.Code, w.Body.String())
	}
	if out["connector"].(map[string]any)["enabled"] != false {
		t.Fatalf("enabled after update = %v, want false", out["connector"])
	}
	// 更新不存在的 id → 404。
	w, _ = doJSON(t, r, "PUT", "/api/server/admin/connectors/nope", upd, hdr)
	if w.Code != http.StatusNotFound {
		t.Fatalf("update missing = %d, want 404", w.Code)
	}

	// 禁用开关端点。
	w, _ = doJSON(t, r, "PUT", "/api/server/admin/connectors/moka/enabled", `{"enabled":false}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("disable moka = %d", w.Code)
	}
	if err := serverstore.SetConnectorEnabled(db, "moka", false); err != nil {
		t.Fatal(err)
	}
	enabled, _ := serverstore.ListEnabledConnectors(db)
	for _, c := range enabled {
		if c.ID == "moka" {
			t.Fatalf("moka still in enabled list")
		}
	}

	// 删除。
	w, _ = doJSON(t, r, "DELETE", "/api/server/admin/connectors/feishu", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("delete = %d", w.Code)
	}
	if _, err := serverstore.GetConnector(db, "feishu"); err != serverstore.ErrNotFound {
		t.Fatalf("after delete err = %v", err)
	}
	// 删除不存在 → 404。
	w, _ = doJSON(t, r, "DELETE", "/api/server/admin/connectors/nope", "", hdr)
	if w.Code != http.StatusNotFound {
		t.Fatalf("delete missing = %d, want 404", w.Code)
	}

	// 审计留痕。
	logs, _ := serverstore.ListAuditLogs(db, 20)
	actions := map[string]bool{}
	for _, l := range logs {
		actions[l.Action] = true
	}
	for _, a := range []string{"connector_create", "connector_update", "connector_enabled", "connector_delete"} {
		if !actions[a] {
			t.Fatalf("audit missing %s", a)
		}
	}
}
