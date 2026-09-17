package capabilities

// SG-4(审计 2026-09-17,r2 server-gateway P3):组织共享**智能体**上下架端点。
//
// 背景:智能体侧的读闸门一直是齐的(员工清单 ListVisibleAgentPresets、
// agentshare.listVisible、serveArchive 都按 apps.enabled 过滤),但**没有任何
// 写入点** —— marketplace 的 SetAppEnabled 只放行市场渠道行,组织和共享库只能
// 走 DELETE(软删,名字与版本号永久占位)。技能侧在 2026-09-15 拿到了
// PUT /shared-skills/:name/enabled,本用例把智能体侧的对称端点
// (PUT /agent-presets/:name/enabled)与审批页下发的 enabled 字段一起钉住:
// 端点消失 / 渠道守卫被摘 / approvals 不再下发 enabled,任一处回归都会红。

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

const agentEnabledName = "ppt-gen"

// setupAgentEnabled 起一棵与生产同前缀的路由树:管理登录 + 能力中心审批队列 +
// 组织智能体管理端点 + 员工智能体面。
func setupAgentEnabled(t *testing.T) (*gin.Engine, *sql.DB, map[string]string, map[string]string, map[string]string) {
	t.Helper()
	t.Setenv("PICOAI_LOGIN_MAX_ATTEMPTS", "1000")
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef0123456789abcdef")
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	tokens := map[string]string{}
	for _, name := range []string{"alice", "bob"} {
		uid, err := serverstore.CreateUserWithPassword(db, name, "pw123456")
		if err != nil {
			t.Fatal(err)
		}
		token, err := serverauth.IssueToken(db, uid)
		if err != nil {
			t.Fatal(err)
		}
		tokens[name] = token
	}
	if _, err := serverstore.CreateUserWithPassword(db, "boss", "pw123456"); err != nil {
		t.Fatal(err)
	}
	boss, err := serverstore.GetUserByUsername(db, "boss")
	if err != nil {
		t.Fatal(err)
	}
	boss.IsAdmin = true
	if err := serverstore.UpdateUser(db, boss); err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	serverauth.RegisterAdminRoutes(r, db)
	cacheDir := t.TempDir() + "/cache"
	RegisterAdminRoutes(r, db, cacheDir)
	agentshare.RegisterRoutes(r, db, cacheDir)
	agentshare.RegisterAdminRoutes(r, db, cacheDir)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/server/admin/login", strings.NewReader(`{"username":"boss","password":"pw123456"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("admin login = %d %s", w.Code, w.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	csrf, _ := out["csrf_token"].(string)
	sess := ""
	for _, ck := range w.Result().Cookies() {
		if ck.Name == "picoaide_session" {
			sess = ck.Value
		}
	}
	if sess == "" || csrf == "" {
		t.Fatalf("admin session/csrf missing: %v", w.Result().Cookies())
	}
	return r, db,
		map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf},
		map[string]string{"Authorization": "Bearer " + tokens["alice"]},
		map[string]string{"Authorization": "Bearer " + tokens["bob"]}
}

// do 发一个请求并返回状态码与响应体。
func do(t *testing.T, r http.Handler, hdr map[string]string, method, path, body string) (int, string) {
	t.Helper()
	var rd *strings.Reader
	if body == "" {
		rd = strings.NewReader("")
	} else {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, rd)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w.Code, w.Body.String()
}

// approvalsEnabled 读审批队列里该智能体行的 enabled 字段(审批页据此渲染
// 「已下架」徽标与上架/下架按钮)。
func approvalsEnabled(t *testing.T, r http.Handler, adminHdr map[string]string, name string) bool {
	t.Helper()
	code, body := do(t, r, adminHdr, "GET", "/api/server/admin/capabilities/approvals?status=approved&type=agent", "")
	if code != http.StatusOK {
		t.Fatalf("approvals = %d %s", code, body)
	}
	var out struct {
		Approvals []struct {
			Name    string `json:"name"`
			Enabled bool   `json:"enabled"`
		} `json:"approvals"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("approvals body: %v (%s)", err, body)
	}
	for _, row := range out.Approvals {
		if row.Name == name {
			return row.Enabled
		}
	}
	t.Fatalf("审批队列里找不到 %s: %s", name, body)
	return false
}

// employeeSeesAgent 判定员工面清单里是否能看到该智能体。
func employeeSeesAgent(t *testing.T, r http.Handler, userHdr map[string]string, name string) bool {
	t.Helper()
	code, body := do(t, r, userHdr, "GET", "/api/client/v2/agent-presets", "")
	if code != http.StatusOK {
		t.Fatalf("employee list = %d %s", code, body)
	}
	return strings.Contains(body, `"`+name+`"`)
}

func TestAgentAdminEnabledEndpoint(t *testing.T) {
	r, db, adminHdr, aliceHdr, _ := setupAgentEnabled(t)

	// 造一条 approved 的组织智能体并授权给 alice(双门制:授权 + 上下架)。
	if _, err := serverstore.CreateAgentPreset(db, &serverstore.AgentPreset{
		Name: agentEnabledName, DisplayName: "PPT 生成", Version: "1.0.0",
		Author: "alice", Status: serverstore.AgentPresetApproved, Archive: []byte("zip"),
	}); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantApp(db, serverstore.AppKindAgent, agentEnabledName, "alice", string(serverstore.GranteeUser)); err != nil {
		t.Fatal(err)
	}

	// 上架态:审批页 enabled=true,员工可见。
	if !approvalsEnabled(t, r, adminHdr, agentEnabledName) {
		t.Fatal("新审批通过的智能体应处于上架状态(审批页 enabled 应为 true)")
	}
	if !employeeSeesAgent(t, r, aliceHdr, agentEnabledName) {
		t.Fatal("上架且已授权的智能体应出现在员工清单里")
	}

	// 下架:员工面等同不存在(不泄露存在性),管理端照旧看得到。
	code, body := do(t, r, adminHdr, "PUT", "/api/server/admin/agent-presets/"+agentEnabledName+"/enabled", `{"enabled":false}`)
	if code != http.StatusOK {
		t.Fatalf("disable = %d %s", code, body)
	}
	if approvalsEnabled(t, r, adminHdr, agentEnabledName) {
		t.Fatal("下架后审批页 enabled 应为 false")
	}
	if employeeSeesAgent(t, r, aliceHdr, agentEnabledName) {
		t.Fatal("下架后员工清单仍能看到该智能体")
	}
	// 数据保留:下架不删行(软删会把名字与版本号永久烧掉,这正是本端点存在的理由)。
	if _, err := serverstore.GetAgentPreset(db, agentEnabledName); err != nil {
		t.Fatalf("下架不得删除行: %v", err)
	}

	// 审计留痕(与市场智能体上下架、共享技能同精神)。
	rows, _, err := serverstore.ListAuditLogsPagedFiltered(db, 0, 50, "agent_preset_disable", "")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, row := range rows {
		if strings.Contains(row.Detail, agentEnabledName) {
			found = true
		}
	}
	if !found {
		t.Fatalf("下架未留下 agent_preset_disable 审计: %+v", rows)
	}

	// 重新上架:可逆(替代"软删换下线"的关键诉求)。
	code, body = do(t, r, adminHdr, "PUT", "/api/server/admin/agent-presets/"+agentEnabledName+"/enabled", `{"enabled":true}`)
	if code != http.StatusOK {
		t.Fatalf("re-enable = %d %s", code, body)
	}
	if !approvalsEnabled(t, r, adminHdr, agentEnabledName) {
		t.Fatal("重新上架后审批页 enabled 应为 true")
	}
	if !employeeSeesAgent(t, r, aliceHdr, agentEnabledName) {
		t.Fatal("重新上架后员工应恢复可见")
	}
	rows, _, err = serverstore.ListAuditLogsPagedFiltered(db, 0, 50, "agent_preset_enable", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) == 0 {
		t.Fatal("重新上架未留下 agent_preset_enable 审计")
	}
}

// 端点守卫:入参、未知名字、跨渠道(市场智能体不由本端点管)。
func TestAgentAdminEnabledEndpointGuards(t *testing.T) {
	r, db, adminHdr, _, _ := setupAgentEnabled(t)

	for _, body := range []string{`{}`, `{"enabled":"yes"}`, `not-json`} {
		code, resp := do(t, r, adminHdr, "PUT", "/api/server/admin/agent-presets/nope/enabled", body)
		if code != http.StatusBadRequest {
			t.Fatalf("body %q = %d %s, want 400", body, code, resp)
		}
	}

	code, resp := do(t, r, adminHdr, "PUT", "/api/server/admin/agent-presets/ghost/enabled", `{"enabled":false}`)
	if code != http.StatusNotFound {
		t.Fatalf("未知智能体 = %d %s, want 404", code, resp)
	}

	// 市场渠道行:本端点不碰(跨渠道写由 marketplace 同向阻断);requireOrgAgent
	// 把市场行一律当不存在(404,不泄露存在性)。
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindAgent, AppID: "market-agent", Title: "market-agent",
		Channel: serverstore.AppChannelMarket, Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}
	code, resp = do(t, r, adminHdr, "PUT", "/api/server/admin/agent-presets/market-agent/enabled", `{"enabled":false}`)
	if code != http.StatusNotFound {
		t.Fatalf("市场渠道智能体 = %d %s, want 404(本端点只服务组织库)", code, resp)
	}
	app, err := serverstore.GetApp(db, serverstore.AppKindAgent, "market-agent")
	if err != nil {
		t.Fatal(err)
	}
	if app.Enabled != 1 {
		t.Fatal("跨渠道请求不得改动市场智能体的 enabled")
	}
}

// 未授权员工在两种状态下都看不到(授权门不受上下架影响,双门制)。
func TestAgentEnabledKeepsGrantGate(t *testing.T) {
	r, db, adminHdr, _, bobHdr := setupAgentEnabled(t)
	if _, err := serverstore.CreateAgentPreset(db, &serverstore.AgentPreset{
		Name: agentEnabledName, DisplayName: "PPT 生成", Version: "1.0.0",
		Author: "alice", Status: serverstore.AgentPresetApproved, Archive: []byte("zip"),
	}); err != nil {
		t.Fatal(err)
	}
	// bob 未获授权(也不是作者)⇒ 即使上架也不可见。
	if employeeSeesAgent(t, r, bobHdr, agentEnabledName) {
		t.Fatal("未授权的智能体不得出现在员工清单里(授权门)")
	}
	if code, resp := do(t, r, adminHdr, "PUT", "/api/server/admin/agent-presets/"+agentEnabledName+"/enabled", `{"enabled":false}`); code != http.StatusOK {
		t.Fatalf("disable = %d %s", code, resp)
	}
	if employeeSeesAgent(t, r, bobHdr, agentEnabledName) {
		t.Fatal("未授权 + 下架同样不可见")
	}
}
