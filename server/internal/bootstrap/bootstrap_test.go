package bootstrap

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

func setup(t *testing.T) (*gin.Engine, *sql.DB) {
	t.Helper()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	// providers + models
	pid, err := serverstore.AddGatewayProvider(db, &serverstore.GatewayProvider{
		Name: "deepseek", BaseURL: "https://api.deepseek.com", Enabled: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.AddModel(db, &serverstore.Model{Name: "deepseek-chat", ProviderID: pid, DisplayName: "DeepSeek Chat"}); err != nil {
		t.Fatal(err)
	}
	// skill (one enabled, one disabled)
	_, err = serverstore.AddSkill(db, &serverstore.Skill{Name: "ppt-gen", Version: "1.2.0", Description: "PPT 生成", GitURL: "https://x/ppt", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, err = serverstore.AddSkill(db, &serverstore.Skill{Name: "off", Version: "0.1.0", GitURL: "https://x/off", Enabled: 0})
	if err != nil {
		t.Fatal(err)
	}
	// user + token
	if _, err := serverstore.CreateUserWithPassword(db, "alice", "pw123456"); err != nil {
		t.Fatal(err)
	}
	// 严格授权:alice 可见被授权的技能;未授权的不可见
	if err := serverstore.GrantSkill(db, "ppt-gen", "alice", serverstore.GranteeUser); err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterRoutes(r, db)
	return r, db
}

func getJSON(t *testing.T, r http.Handler, path, token string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func TestBootstrap(t *testing.T) {
	r, db := setup(t)
	u, _ := serverstore.GetUserByUsername(db, "alice")
	token, _ := serverauth.IssueToken(db, u.ID)

	w, out := getJSON(t, r, "/api/config/bootstrap", token)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if out["default_model"] != "deepseek-chat" {
		t.Fatalf("default_model = %v", out["default_model"])
	}
	models := out["models"].([]any)
	if len(models) != 1 {
		t.Fatalf("models = %v", models)
	}
	skills := out["skills"].([]any)
	if len(skills) != 1 {
		t.Fatalf("skills = %v (disabled must be excluded)", skills)
	}
	web := out["web"].(map[string]any)
	if web["allow_private"] != false {
		t.Fatalf("web = %v", web)
	}
	// no token → 401
	if w, _ := getJSON(t, r, "/api/config/bootstrap", ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("no token status = %d", w.Code)
	}
}

func TestBootstrapDefaultModelFallback(t *testing.T) {
	r, db := setup(t)
	if err := serverstore.SetSetting(db, "gateway.default_model", "nonexistent-model"); err != nil {
		t.Fatal(err)
	}
	u, _ := serverstore.GetUserByUsername(db, "alice")
	token, _ := serverauth.IssueToken(db, u.ID)
	_, out := getJSON(t, r, "/api/config/bootstrap", token)
	if out["default_model"] != "deepseek-chat" {
		t.Fatalf("fallback default_model = %v, want deepseek-chat", out["default_model"])
	}
}

func TestBootstrapWebSettings(t *testing.T) {
	r, db := setup(t)
	if err := serverstore.SetSetting(db, "web.allow_private", "true"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "web.search_endpoint", "https://search.example.com/q"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "web.default_thinking_level", "high"); err != nil {
		t.Fatal(err)
	}
	u, _ := serverstore.GetUserByUsername(db, "alice")
	token, _ := serverauth.IssueToken(db, u.ID)
	_, out := getJSON(t, r, "/api/config/bootstrap", token)
	web := out["web"].(map[string]any)
	if web["allow_private"] != true || web["search_endpoint"] != "https://search.example.com/q" {
		t.Fatalf("web = %v", web)
	}
	if web["default_thinking_level"] != "high" {
		t.Fatalf("default_thinking_level = %v, want high", web["default_thinking_level"])
	}
}

func TestBootstrapDefaultThinkingLevelFallback(t *testing.T) {
	r, db := setup(t)
	// 未配置 + 非法值 → 回落 max
	u, _ := serverstore.GetUserByUsername(db, "alice")
	token, _ := serverauth.IssueToken(db, u.ID)
	_, out := getJSON(t, r, "/api/config/bootstrap", token)
	web := out["web"].(map[string]any)
	if web["default_thinking_level"] != "max" {
		t.Fatalf("default default_thinking_level = %v, want max", web["default_thinking_level"])
	}
	// 非法值回落 max
	if err := serverstore.SetSetting(db, "web.default_thinking_level", "ultra"); err != nil {
		t.Fatal(err)
	}
	_, out = getJSON(t, r, "/api/config/bootstrap", token)
	web = out["web"].(map[string]any)
	if web["default_thinking_level"] != "max" {
		t.Fatalf("invalid default_thinking_level = %v, want max fallback", web["default_thinking_level"])
	}
}

func TestHealthzNoAuth(t *testing.T) {
	r, db := setup(t)
	// 无需 token,返回 200 + ok
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/healthz", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("healthz status = %d, body=%s", w.Code, w.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if out["ok"] != true {
		t.Fatalf("healthz body = %s", w.Body.String())
	}

	// DB 不可用 → 503
	db.Close()
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("healthz with closed db = %d, body=%s", w.Code, w.Body.String())
	}
}

// 严格授权:未授权用户 bootstrap 的技能建议清单为空(部门隔离)
func TestBootstrapStrictDefault(t *testing.T) {
	r, db := setup(t)
	if _, err := serverstore.CreateUserWithPassword(db, "nobody", "pw123456"); err != nil {
		t.Fatal(err)
	}
	u, _ := serverstore.GetUserByUsername(db, "nobody")
	token, _ := serverauth.IssueToken(db, u.ID)

	w, out := getJSON(t, r, "/api/config/bootstrap", token)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	skills := out["skills"].([]any)
	if len(skills) != 0 {
		t.Fatalf("nobody skills = %v, want empty", skills)
	}
	// models remain visible to everyone
	models := out["models"].([]any)
	if len(models) != 1 {
		t.Fatalf("models = %v, want the enabled model", models)
	}
}

// TestBootstrapConnectors: 0042 连接器下发——enabled 连接器出现在
// connectors[];禁用后不再下发;glitchtip 定义合成 BASE_URL/ORGANIZATION
// defaultValue(取代客户端特判)。
func TestBootstrapConnectors(t *testing.T) {
	r, db := setup(t)
	u, _ := serverstore.GetUserByUsername(db, "alice")
	token, _ := serverauth.IssueToken(db, u.ID)

	_, out := getJSON(t, r, "/api/config/bootstrap", token)
	conns := out["connectors"].([]any)
	if len(conns) < 2 {
		t.Fatalf("connectors = %d, want >= 2 (种子 moka+glitchtip)", len(conns))
	}
	byID := map[string]map[string]any{}
	for _, c := range conns {
		m := c.(map[string]any)
		byID[m["id"].(string)] = m
	}
	gt := byID["glitchtip"]
	if gt == nil {
		t.Fatalf("glitchtip missing")
	}
	defStr := gt["definition"].(string)
	if !strings.Contains(defStr, "GLITCHTIP_BASE_URL") {
		t.Fatalf("glitchtip definition lacks tokenFields: %s", defStr)
	}

	// 服务端配置 GlitchTip 地址/组织 → 定义 JSON 合成 defaultValue。
	if err := serverstore.SetSetting(db, "web.glitchtip_base_url", "https://gt.example.com"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "web.glitchtip_organization", "picoaide"); err != nil {
		t.Fatal(err)
	}
	_, out = getJSON(t, r, "/api/config/bootstrap", token)
	conns = out["connectors"].([]any)
	for _, c := range conns {
		m := c.(map[string]any)
		if m["id"] == "glitchtip" {
			defStr = m["definition"].(string)
		}
	}
	if !strings.Contains(defStr, `"defaultValue":"https://gt.example.com"`) {
		t.Fatalf("glitchtip definition lacks baseURL defaultValue: %s", defStr)
	}
	if !strings.Contains(defStr, `"defaultValue":"picoaide"`) {
		t.Fatalf("glitchtip definition lacks org defaultValue: %s", defStr)
	}

	// 禁用 moka → 不再出现。
	if err := serverstore.SetConnectorEnabled(db, "moka", false); err != nil {
		t.Fatal(err)
	}
	_, out = getJSON(t, r, "/api/config/bootstrap", token)
	conns = out["connectors"].([]any)
	for _, c := range conns {
		m := c.(map[string]any)
		if m["id"] == "moka" {
			t.Fatalf("disabled moka still in connectors")
		}
	}
}
