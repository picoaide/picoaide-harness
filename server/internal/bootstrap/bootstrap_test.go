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
	_, err = serverstore.AddSkill(db, &serverstore.Skill{Name: "ppt-gen", Version: "1.2.0", Description: "PPT 生成", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, err = serverstore.AddSkill(db, &serverstore.Skill{Name: "off", Version: "0.1.0", Enabled: 0})
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

	w, out := getJSON(t, r, "/api/client/v2/config/bootstrap", token)
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
	if web["allow_private"] != nil || web["search_endpoint"] != nil {
		t.Fatalf("web = %v (allow_private/search_endpoint must be removed)", web)
	}
	// no token → 401
	if w, _ := getJSON(t, r, "/api/client/v2/config/bootstrap", ""); w.Code != http.StatusUnauthorized {
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
	_, out := getJSON(t, r, "/api/client/v2/config/bootstrap", token)
	if out["default_model"] != "deepseek-chat" {
		t.Fatalf("fallback default_model = %v, want deepseek-chat", out["default_model"])
	}
}

func TestBootstrapWebSettings(t *testing.T) {
	r, db := setup(t)
	// 2026-09:web.allow_private / web.search_endpoint 已删除,不再下发;
	// 旧 setting 值仍存在时也必须不出现在响应里(客户端不消费)。
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
	_, out := getJSON(t, r, "/api/client/v2/config/bootstrap", token)
	web := out["web"].(map[string]any)
	if web["allow_private"] != nil || web["search_endpoint"] != nil {
		t.Fatalf("web = %v (allow_private/search_endpoint must be removed)", web)
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
	_, out := getJSON(t, r, "/api/client/v2/config/bootstrap", token)
	web := out["web"].(map[string]any)
	if web["default_thinking_level"] != "max" {
		t.Fatalf("default default_thinking_level = %v, want max", web["default_thinking_level"])
	}
	// 非法值回落 max
	if err := serverstore.SetSetting(db, "web.default_thinking_level", "ultra"); err != nil {
		t.Fatal(err)
	}
	_, out = getJSON(t, r, "/api/client/v2/config/bootstrap", token)
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

	w, out := getJSON(t, r, "/api/client/v2/config/bootstrap", token)
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
// connectors[];禁用后不再下发。0045 已把 GlitchTip 连接器下架(enabled=0),
// 因此 bootstrap 只下发 moka + sales-easy, glitchtip 不在列表中
// (错误上报走独立 Sentry DSN, 不依赖连接器);定义 defaultValue 注入
// 逻辑保留,由 TestInjectGlitchTipDefaults 直接单测(重新启用场景仍可用)。
func TestBootstrapConnectors(t *testing.T) {
	r, db := setup(t)
	u, _ := serverstore.GetUserByUsername(db, "alice")
	token, _ := serverauth.IssueToken(db, u.ID)

	_, out := getJSON(t, r, "/api/client/v2/config/bootstrap", token)
	conns := out["connectors"].([]any)
	if len(conns) < 2 {
		t.Fatalf("connectors = %d, want >= 2 (种子 moka+sales-easy)", len(conns))
	}
	byID := map[string]map[string]any{}
	for _, c := range conns {
		m := c.(map[string]any)
		byID[m["id"].(string)] = m
	}
	// moka / sales-easy 在;glitchtip(0045 下架)不在。
	if byID["moka"] == nil || byID["sales-easy"] == nil {
		t.Fatalf("enabled seeds missing: %v", byID)
	}
	if byID["glitchtip"] != nil {
		t.Fatalf("disabled glitchtip still in connectors")
	}

	// 禁用 moka → 不再出现。
	if err := serverstore.SetConnectorEnabled(db, "moka", false); err != nil {
		t.Fatal(err)
	}
	_, out = getJSON(t, r, "/api/client/v2/config/bootstrap", token)
	conns = out["connectors"].([]any)
	for _, c := range conns {
		m := c.(map[string]any)
		if m["id"] == "moka" {
			t.Fatalf("disabled moka still in connectors")
		}
	}
}

// TestInjectGlitchTipDefaults: 服务端配置的 GlitchTip 地址/组织合成进
// tokenFields 的 defaultValue(0045 下架后仍保留该注入逻辑,重新启用
// GlitchTip 连接器时客户端表单自动预填)。
func TestInjectGlitchTipDefaults(t *testing.T) {
	defJSON := `{"tokenFields":[{"key":"GLITCHTIP_BASE_URL","label":"服务地址","type":"text","required":true},{"key":"GLITCHTIP_TOKEN","label":"Token","type":"password","required":true},{"key":"GLITCHTIP_ORGANIZATION","label":"组织 slug","type":"text","required":true}],"mcp":[{"serverName":"glitchtip"}]}`

	// 空配置 → 原样返回。
	if out := injectGlitchTipDefaults(defJSON, "", ""); out != defJSON {
		t.Fatalf("no-op expected, got %s", out)
	}
	// 地址+组织 → 两个 defaultValue。
	out := injectGlitchTipDefaults(defJSON, "https://gt.example.com", "picoaide")
	for _, want := range []string{`"defaultValue":"https://gt.example.com"`, `"defaultValue":"picoaide"`} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %s in %s", want, out)
		}
	}
	// 只配地址 → 只有 BASE_URL 有 defaultValue, 组织无默认值。
	out = injectGlitchTipDefaults(defJSON, "https://gt.example.com", "")
	if !strings.Contains(out, `"defaultValue":"https://gt.example.com"`) || strings.Contains(out, `"defaultValue":"picoaide"`) {
		t.Fatalf("partial inject wrong: %s", out)
	}
	// 非法 JSON → 原样返回。
	if out := injectGlitchTipDefaults("{not json", "https://x", "y"); out != "{not json" {
		t.Fatalf("invalid json expected passthrough, got %s", out)
	}
}
