package marketplace

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

func marketAdminSetup(t *testing.T) (http.Handler, *sql.DB, map[string]string) {
	t.Helper()
	// 登录限流器(10/5min/ip+user)是惰性单例:多个测试各自 login 同一账号
	// 会触发 429。测试环境按 ratelimit.go 约定放宽(首次 login 前设置生效,
	// 单例在整个测试二进制生命周期内保持该配置)。
	t.Setenv("PICOAI_LOGIN_MAX_ATTEMPTS", "1000")
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef0123456789abcdef")
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/mkt.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateUserWithPassword(db, "boss", "pw123456"); err != nil {
		t.Fatal(err)
	}
	u, _ := serverstore.GetUserByUsername(db, "boss")
	u.IsAdmin = true
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	serverauth.RegisterAdminRoutes(r, db)
	RegisterAdminRoutes(r, db, t.TempDir())

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/login", strings.NewReader(`{"username":"boss","password":"pw123456"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	csrf := out["csrf_token"].(string)
	sess := ""
	for _, ck := range w.Result().Cookies() {
		if ck.Name == "picoaide_session" {
			sess = ck.Value
		}
	}
	hdr := map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}
	return r, db, hdr
}

func mreq(t *testing.T, r http.Handler, method, path, body string, hdr map[string]string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func TestAdminSkillsMCPAndDownloads(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()

	w, _ := mreq(t, r, "POST", "/api/admin/skills",
		`{"name":"demo","git_url":"https://example.com/demo.git","version":"1.0.0"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create skill: %d %s", w.Code, w.Body.String())
	}
	if w, _ := mreq(t, r, "POST", "/api/admin/skills", `{"name":"../evil","git_url":"https://x"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("bad skill name accepted: %d", w.Code)
	}
	if w, _ := mreq(t, r, "DELETE", "/api/admin/skills/demo", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("disable skill: %d", w.Code)
	}
	s, err := serverstore.GetSkill(db, "demo")
	if err != nil || s.Enabled != 0 {
		t.Fatalf("skill not disabled: %+v %v", s, err)
	}

	w, out := mreq(t, r, "POST", "/api/admin/mcp",
		`{"name":"xhs","transport":"http","url":"http://127.0.0.1:3000/mcp","env":{"APP_SECRET":"topsecret"},"headers":{"Authorization":"Bearer tok"}}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create mcp: %d %s", w.Code, w.Body.String())
	}
	id := int64(out["mcp"].(map[string]any)["id"].(float64))
	m, _ := serverstore.GetMCPServer(db, id)
	if m.Env["APP_SECRET"] == "topsecret" || !strings.HasPrefix(m.Env["APP_SECRET"], "enc:v1:") {
		t.Fatalf("mcp env not encrypted: %+v", m.Env)
	}
	if w, _ := mreq(t, r, "DELETE", fmt.Sprintf("/api/admin/mcp/%d", id), "", hdr); w.Code != http.StatusOK {
		t.Fatalf("disable mcp: %d", w.Code)
	}
	m, _ = serverstore.GetMCPServer(db, id)
	if m.Enabled != 0 {
		t.Fatal("mcp not disabled")
	}

	aliceID, _ := serverstore.CreateUser(db, &serverstore.User{Username: "alice", Source: "local"})
	if err := serverstore.RecordDownload(db, aliceID, id); err != nil {
		t.Fatal(err)
	}
	w, out = mreq(t, r, "GET", "/api/admin/mcp-downloads", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("downloads: %d", w.Code)
	}
	rows := out["downloads"].([]any)
	if len(rows) != 1 {
		t.Fatalf("downloads rows = %d", len(rows))
	}
	d := rows[0].(map[string]any)
	if d["username"] != "alice" {
		t.Fatalf("download username = %v", d["username"])
	}
}

func TestNonAdminForbidden(t *testing.T) {
	r, db, _ := marketAdminSetup(t)
	defer db.Close()
	if _, err := serverstore.CreateUserWithPassword(db, "eve", "evepw"); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/login", strings.NewReader(`{"username":"eve","password":"evepw"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("non-admin login status = %d", w.Code)
	}
}

// 审计 A5-H1: 管理列表必须携带 enabled(前端据此渲染徽标与下架/重新上架按钮),
// 且仅敏感 key 掩码、非敏感值(如 TIMEOUT)明文可见便于编辑回填。
func TestAdminMCPEnabledAndSensitiveMask(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	w, out := mreq(t, r, "POST", "/api/admin/mcp",
		`{"name":"files","transport":"stdio","command":"node","env":{"API_KEY":"secret-1","TIMEOUT":"30"}}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create mcp: %d %s", w.Code, w.Body.String())
	}
	id := int64(out["mcp"].(map[string]any)["id"].(float64))
	if en := out["mcp"].(map[string]any)["enabled"]; en != true {
		t.Fatalf("create response enabled = %v, want true", en)
	}
	env := out["mcp"].(map[string]any)["env"].(map[string]any)
	if env["API_KEY"] != "***" || env["TIMEOUT"] != "30" {
		t.Fatalf("create response env = %v, want API_KEY masked + TIMEOUT visible", env)
	}

	w, out = mreq(t, r, "GET", "/api/admin/mcp", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("list: %d", w.Code)
	}
	rows := out["mcp"].([]any)
	if len(rows) != 1 {
		t.Fatalf("mcp rows = %d", len(rows))
	}
	m := rows[0].(map[string]any)
	if m["enabled"] != true {
		t.Fatalf("list enabled = %v, want true", m["enabled"])
	}
	env = m["env"].(map[string]any)
	if env["API_KEY"] != "***" || env["TIMEOUT"] != "30" {
		t.Fatalf("list env = %v", env)
	}

	// 下架后 enabled=false
	if w, _ := mreq(t, r, "DELETE", fmt.Sprintf("/api/admin/mcp/%d", id), "", hdr); w.Code != http.StatusOK {
		t.Fatalf("disable: %d", w.Code)
	}
	w, out = mreq(t, r, "GET", "/api/admin/mcp", "", hdr)
	m = out["mcp"].([]any)[0].(map[string]any)
	if m["enabled"] != false {
		t.Fatalf("after disable enabled = %v, want false", m["enabled"])
	}
}

// 审计 A5-H2: 更新凭证时,掩码 "***" / enc:v1: 前缀值必须保持现有存储值,
// 回传列表原样不可覆盖真实密钥;未出现的 key 删除;nil 表示整体不变。
func TestAdminMCPUpdateCredentialMerge(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	w, out := mreq(t, r, "POST", "/api/admin/mcp",
		`{"name":"files","transport":"stdio","command":"node",
		  "env":{"API_KEY":"secret-1","TIMEOUT":"30"},
		  "headers":{"Authorization":"Bearer tok"}}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create mcp: %d %s", w.Code, w.Body.String())
	}
	id := int64(out["mcp"].(map[string]any)["id"].(float64))
	before, err := serverstore.GetMCPServer(db, id)
	if err != nil {
		t.Fatal(err)
	}
	origKey := before.Env["API_KEY"]
	if !strings.HasPrefix(origKey, util.EncPrefix) {
		t.Fatalf("API_KEY not encrypted: %q", origKey)
	}

	// 1) 回传掩码 ***:API_KEY 保持原密文,TIMEOUT 覆盖为新值
	w, _ = mreq(t, r, "PUT", fmt.Sprintf("/api/admin/mcp/%d", id),
		`{"env":{"API_KEY":"***","TIMEOUT":"5000"}}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("update masked: %d %s", w.Code, w.Body.String())
	}
	after, _ := serverstore.GetMCPServer(db, id)
	if after.Env["API_KEY"] != origKey {
		t.Fatalf("API_KEY overwritten: %q != %q", after.Env["API_KEY"], origKey)
	}
	if after.Env["TIMEOUT"] != "5000" {
		t.Fatalf("TIMEOUT = %q, want 5000", after.Env["TIMEOUT"])
	}
	// headers 未传 → 整体不变
	if after.Headers["Authorization"] != before.Headers["Authorization"] {
		t.Fatalf("headers changed without being sent: %v", after.Headers)
	}

	// 2) enc:v1: 前缀回传同样保持(防伪造密文注入)
	w, _ = mreq(t, r, "PUT", fmt.Sprintf("/api/admin/mcp/%d", id),
		`{"env":{"API_KEY":"`+origKey+`"}}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("update enc passthrough: %d %s", w.Code, w.Body.String())
	}
	after, _ = serverstore.GetMCPServer(db, id)
	if after.Env["API_KEY"] != origKey {
		t.Fatalf("enc passthrough overwrote API_KEY: %q", after.Env["API_KEY"])
	}

	// 3) 未出现的 key 删除(整 map 语义);{} 清空整个 env
	w, _ = mreq(t, r, "PUT", fmt.Sprintf("/api/admin/mcp/%d", id), `{"env":{}}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("clear env: %d", w.Code)
	}
	after, _ = serverstore.GetMCPServer(db, id)
	if len(after.Env) != 0 {
		t.Fatalf("env not cleared: %v", after.Env)
	}
	if after.Headers["Authorization"] != before.Headers["Authorization"] {
		t.Fatalf("headers must survive env clear: %v", after.Headers)
	}
}

// 审计 A5-M1: 重新上架端点 —— 下架后可恢复,未知资源 404。
func TestAdminMCPEnable(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	w, out := mreq(t, r, "POST", "/api/admin/mcp", `{"name":"files","transport":"stdio"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	id := int64(out["mcp"].(map[string]any)["id"].(float64))
	if w, _ := mreq(t, r, "DELETE", fmt.Sprintf("/api/admin/mcp/%d", id), "", hdr); w.Code != http.StatusOK {
		t.Fatalf("disable: %d", w.Code)
	}
	if w, _ := mreq(t, r, "POST", fmt.Sprintf("/api/admin/mcp/%d/enable", id), "", hdr); w.Code != http.StatusOK {
		t.Fatalf("enable: %d", w.Code)
	}
	m, _ := serverstore.GetMCPServer(db, id)
	if m.Enabled != 1 {
		t.Fatalf("after enable enabled=%d, want 1", m.Enabled)
	}
	if w, _ := mreq(t, r, "POST", "/api/admin/mcp/99999/enable", "", hdr); w.Code != http.StatusNotFound {
		t.Fatalf("enable unknown = %d, want 404", w.Code)
	}
}

func TestAdminSkillEnable(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	w, _ := mreq(t, r, "POST", "/api/admin/skills",
		`{"name":"demo","git_url":"https://example.com/demo.git","version":"1.0.0"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create skill: %d %s", w.Code, w.Body.String())
	}
	if w, _ := mreq(t, r, "DELETE", "/api/admin/skills/demo", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("disable skill: %d", w.Code)
	}
	s, _ := serverstore.GetSkill(db, "demo")
	if s.Enabled != 0 {
		t.Fatalf("skill not disabled: %d", s.Enabled)
	}
	if w, _ := mreq(t, r, "POST", "/api/admin/skills/demo/enable", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("enable skill: %d", w.Code)
	}
	s, _ = serverstore.GetSkill(db, "demo")
	if s.Enabled != 1 {
		t.Fatalf("skill not re-enabled: %d", s.Enabled)
	}
	if w, _ := mreq(t, r, "POST", "/api/admin/skills/nope/enable", "", hdr); w.Code != http.StatusNotFound {
		t.Fatalf("enable unknown skill = %d, want 404", w.Code)
	}
}

// 审计 A5-M8: 技能下架必须留审计痕迹(与 mcp_disable 一致)。
func TestAdminSkillDisableAudit(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	if w, _ := mreq(t, r, "POST", "/api/admin/skills",
		`{"name":"demo","git_url":"https://example.com/demo.git"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create skill: %d", w.Code)
	}
	if w, _ := mreq(t, r, "DELETE", "/api/admin/skills/demo", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("disable skill: %d", w.Code)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM kb_audit_logs WHERE action = 'skill_disable' AND detail = 'demo'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("skill_disable audit rows = %d, want 1", n)
	}
}

// 审计 A5-M9(0026): 同名插件创建冲突返回 VALIDATION(与技能一致)。
func TestAdminCreateMCPDuplicateName(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	body := `{"name":"files","transport":"stdio","command":"node"}`
	if w, _ := mreq(t, r, "POST", "/api/admin/mcp", body, hdr); w.Code != http.StatusOK {
		t.Fatalf("create #1: %d", w.Code)
	}
	w, out := mreq(t, r, "POST", "/api/admin/mcp", body, hdr)
	if w.Code != http.StatusBadRequest || !hasErrCode(w, "VALIDATION") {
		t.Fatalf("create #2 = %d %v, want 400 VALIDATION", w.Code, out)
	}
}

// 审计 A5-M7: PUT grants 只接受 groups 字段 —— 误传 username 必须报错,
// 而不是被当作空组静默清空部门授权。
func TestAdminGrantsRejectUnknownFields(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	if w, _ := mreq(t, r, "POST", "/api/admin/skills",
		`{"name":"demo","git_url":"https://example.com/demo.git"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create skill: %d", w.Code)
	}
	if _, err := serverstore.CreateDepartment(db, "研发部", 0, 0, ""); err != nil {
		t.Fatal(err)
	}
	// 先正常设置部门授权
	if w, _ := mreq(t, r, "PUT", "/api/admin/skills/demo/grants", `{"groups":["研发部"]}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("set grants: %d", w.Code)
	}
	// 误传 username → 400,且不得清空既有授权
	w, out := mreq(t, r, "PUT", "/api/admin/skills/demo/grants", `{"username":"alice"}`, hdr)
	if w.Code != http.StatusBadRequest || !hasErrCode(w, "VALIDATION") {
		t.Fatalf("unknown field = %d %v, want 400 VALIDATION", w.Code, out)
	}
	grants, _ := serverstore.ListSkillGrants(db, "demo")
	if len(grants) != 1 || grants[0].Grantee != "研发部" {
		t.Fatalf("grants after rejected put = %+v, want 研发部 intact", grants)
	}
	// MCP 侧同样拒绝
	if w, _ := mreq(t, r, "POST", "/api/admin/mcp", `{"name":"files","transport":"stdio"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create mcp: %d", w.Code)
	}
	if w, _ := mreq(t, r, "PUT", "/api/admin/mcp/1/grants", `{"username":"alice"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("mcp unknown field = %d, want 400", w.Code)
	}
}

// 审计 A5-L10: 技能 Git 地址只允许 http/https 远程仓库(file:// 等拒绝)。
func TestAdminSkillGitURLValidation(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	for _, u := range []string{"file:///tmp/repo", "ftp://host/repo", "not-a-url", "https://"} {
		w, _ := mreq(t, r, "POST", "/api/admin/skills",
			`{"name":"demo","git_url":"`+u+`"}`, hdr)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("create with git_url %q = %d, want 400", u, w.Code)
		}
	}
	if w, _ := mreq(t, r, "POST", "/api/admin/skills",
		`{"name":"demo","git_url":"https://example.com/demo.git"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create with https = %d", w.Code)
	}
	// 更新时把 git_url 改为非法值同样拒绝
	w, _ := mreq(t, r, "PUT", "/api/admin/skills/demo", `{"git_url":"file:///tmp/x"}`, hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("update with file git_url = %d, want 400", w.Code)
	}
}
