package router

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/bootstrap"
	"github.com/picoaide/picoaide/internal/capabilities"
	"github.com/picoaide/picoaide/internal/channel"
	"github.com/picoaide/picoaide/internal/clientrelease"
	"github.com/picoaide/picoaide/internal/connectors"
	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/portal"
	"github.com/picoaide/picoaide/internal/reports"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/sharedskills"
	"github.com/picoaide/picoaide/internal/telemetry"
	"github.com/picoaide/picoaide/internal/util"
)

// buildRouterWithDB 是 buildTestRouter 的"真库"版本：给需要认证的路由用。
// 与 main.go 的装配逐字段同形，只是数据目录落到 t.TempDir()。
func buildRouterWithDB(t *testing.T, db *sql.DB) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	r := gin.New()
	Register(r, Deps{
		DB:            db,
		Auth:          serverauth.New(db).Handlers(),
		Admin:         (&serverauth.AdminAPI{DB: db}).Handlers(),
		Appstore:      appstore.NewHandlers(db),
		Bootstrap:     bootstrap.NewHandlers(db),
		Channel:       channel.NewHandlers(),
		PortalAdmin:   portal.NewAdminHandlers(db),
		ClientRelease: clientrelease.NewHandlers(func() string { return "2.7.2" }, "official"),
		Market:        marketplace.NewHandlers(db, dir+"/skills-cache"),
		Agentshare:    agentshare.NewHandlers(db, dir+"/agent-presets-cache"),
		Shared:        sharedskills.NewHandlers(db, dir+"/shared-skills-cache"),
		Capability:    capabilities.NewHandlers(db, dir+"/skills-cache"),
		Connector:     connectors.NewHandlers(db),
		Telemetry:     telemetry.NewHandlers(db),
		Gateway:       llmgateway.NewHandlers(db),
		Reports:       reports.NewHandlers(db),
	})
	return r
}

// TestGatewayV1EnforcesPasswordChangeGuard 钉住"0057 强制改密守卫覆盖 LLM 网关"。
//
// 背景（2026-09-12 服务端安全审计）：守卫实现在 serverauth.BearerAuth 的白名单
// （`passwordChangeAllowed` 只放行改密/me/logout），而 /v1/* 与无前缀网关端点都在
// `r.Group(..., serverauth.BearerAuth(d.DB))` 之下 —— 因此被管理员重置密码、
// 处于强制改密态的员工**不能**靠直接调 /v1/chat/completions 绕过强制改密消耗余额。
// 这条断言把"网关组确实挂了守卫"变成可执行事实：有人把 /v1 改成别的中间件、
// 或把网关路径加进白名单，测试即红。
func TestGatewayV1EnforcesPasswordChangeGuard(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	const password = "pw1234567890"
	if _, err := serverstore.CreateUserWithPassword(db, "guard1", password); err != nil {
		t.Fatalf("create user: %v", err)
	}
	u, err := serverstore.GetUserByUsername(db, "guard1")
	if err != nil {
		t.Fatalf("load user: %v", err)
	}
	hash, err := util.HashPassword(password)
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	// mustChange=true ⇒ 账号进入强制改密态。
	if err := serverstore.UpdateUserPassword(db, u.ID, hash, true); err != nil {
		t.Fatalf("set must-change: %v", err)
	}
	tok, err := serverauth.IssueToken(db, u.ID)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}

	r := buildRouterWithDB(t, db)
	call := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w
	}

	for _, path := range []string{"/v1/chat/completions", "/chat/completions"} {
		w := call(http.MethodPost, path, `{"model":"m","messages":[{"role":"user","content":"hi"}]}`)
		if w.Code != http.StatusForbidden {
			t.Fatalf("%s must be blocked while password_must_change=1, got %d %s", path, w.Code, w.Body.String())
		}
		var out map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatalf("%s: decode error body: %v", path, err)
		}
		e, _ := out["error"].(map[string]any)
		if e["code"] != "PASSWORD_CHANGE_REQUIRED" {
			t.Fatalf("%s: unexpected error envelope %v", path, out)
		}
	}
	// /v1/models 是 GET，同样不是白名单路径 ⇒ 一并拦下（避免用只读端点探测额度）。
	if w := call(http.MethodGet, "/v1/models", ""); w.Code != http.StatusForbidden {
		t.Fatalf("/v1/models must be blocked too, got %d %s", w.Code, w.Body.String())
	}
	// 白名单仍然可用：改密前也必须能读自己、能改密。
	if w := call(http.MethodGet, "/api/client/v2/auth/me", ""); w.Code != http.StatusOK {
		t.Fatalf("auth/me must stay reachable in must-change state, got %d %s", w.Code, w.Body.String())
	}
}
