package capabilities

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

func setupRouter(t *testing.T) (*gin.Engine, *sql.DB, map[string]string, map[string]string) {
	t.Helper()
	t.Setenv("PICOAI_LOGIN_MAX_ATTEMPTS", "1000")
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef0123456789abcdef")
	db, err := serverstore.EnsureMigrated(serverstore.DBConfig{Path: fmt.Sprintf("%s/capabilities.db", t.TempDir())})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	userTokens := map[string]string{}
	for _, name := range []string{"alice", "bob"} {
		uid, err := serverstore.CreateUserWithPassword(db, name, "pw123456")
		if err != nil {
			t.Fatal(err)
		}
		token, err := serverauth.IssueToken(db, uid)
		if err != nil {
			t.Fatal(err)
		}
		userTokens[name] = token
	}
	// admin
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
	cacheDir := t.TempDir() + "/cache"
	marketplace.RegisterRoutes(r, db, cacheDir)
	marketplace.RegisterAdminRoutes(r, db, cacheDir)
	RegisterRoutes(r, db, cacheDir)
	RegisterAdminRoutes(r, db, cacheDir)

	// admin login
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/login", strings.NewReader(`{"username":"boss","password":"pw123456"}`))
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
	return r, db, adminHdr, userTokens
}

func doGet(t *testing.T, r *gin.Engine, path string, hdr map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	return w
}

func TestMergeVersions(t *testing.T) {
	// 1.0.0 与 1.10.0 的数值感知排序。
	items := []CapabilityItem{
		{Kind: KindSkill, Source: SourceOrg, Name: "codeql", Version: "1.0.0", Status: "approved", Quality: "official"},
		{Kind: KindSkill, Source: SourceOrg, Name: "codeql", Version: "1.10.0", Status: "approved"},
		{Kind: KindSkill, Source: SourceOrg, Name: "codeql", Version: "1.2.0", Status: "approved"},
		{Kind: KindAgent, Source: SourceOrg, Name: "codeql", Version: "1.0.0", Status: "approved"},
	}
	merged := mergeVersions(items, map[string][]string{})
	// 技能归并一条,当前版本 = 1.10.0,versions = [1.0.0,1.2.0,1.10.0];Agent 一条。
	if len(merged) != 2 {
		t.Fatalf("merged len=%d, want 2", len(merged))
	}
	found := false
	for _, m := range merged {
		if m.Kind == KindSkill && m.Name == "codeql" {
			found = true
			if m.Version != "1.10.0" {
				t.Fatalf("codeql version=%s, want 1.10.0", m.Version)
			}
			if len(m.Versions) != 3 || m.Versions[0] != "1.0.0" || m.Versions[1] != "1.2.0" || m.Versions[2] != "1.10.0" {
				t.Fatalf("versions=%v", m.Versions)
			}
			if m.Quality != "official" {
				t.Fatalf("quality should survive final sort=%q", m.Quality)
			}
		}
	}
	if !found {
		t.Fatal("codeql skill missing")
	}
}

func TestMergeVersionsOwnNonApproved(t *testing.T) {
	// 作者自己的 pending 行:无 approved 时保留;有 approved 时归并展示行。
	items := []CapabilityItem{
		{Kind: KindSkill, Source: SourceOrg, Name: "x", Version: "1.0.0", Status: "pending"},
	}
	merged := mergeVersions(items, map[string][]string{})
	if len(merged) != 1 {
		t.Fatalf("len=%d, want 1", len(merged))
	}
	if merged[0].Status != "pending" {
		t.Fatalf("status=%s", merged[0].Status)
	}
	items = append(items, CapabilityItem{Kind: KindSkill, Source: SourceOrg, Name: "x", Version: "1.0.0", Status: "approved"})
	merged = mergeVersions(items, map[string][]string{})
	if len(merged) != 1 || merged[0].Status != "approved" {
		t.Fatalf("with approved: len=%d status=%s", len(merged), merged[0].Status)
	}
}

func TestListCapabilitiesVisibility(t *testing.T) {
	r, db, _, userTokens := setupRouter(t)
	defer db.Close()
	// 直接插入共享技能(作者 alice,pending)与一个共享技能(bob,approved 未授权)。
	if _, err := serverstore.CreateSharedSkill(db, &serverstore.SharedSkill{Name: "tests", Version: "1.0.0", Author: "alice", Status: serverstore.SharedSkillPending, DisplayName: "test"}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateSharedSkill(db, &serverstore.SharedSkill{Name: "tests", Version: "2.0.0", Author: "bob", Status: serverstore.SharedSkillApproved}); err != nil {
		t.Fatal(err)
	}
	aliceHdr := map[string]string{"Authorization": "Bearer " + userTokens["alice"]}
	w := doGet(t, r, "/api/capabilities", aliceHdr)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Items []CapabilityItem `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	// alice 只看到自己的 pending (tests@1.0.0),bob 的 approved 未授权不可见。
	if len(resp.Items) != 1 || resp.Items[0].Name != "tests" || resp.Items[0].Version != "1.0.0" || resp.Items[0].Status != "pending" {
		t.Fatalf("items=%+v", resp.Items)
	}
}

func TestListApprovalsQueue(t *testing.T) {
	r, db, adminHdr, _ := setupRouter(t)
	defer db.Close()
	// 插一个 pending 技能与一个 pending agent。
	if _, err := serverstore.CreateSharedSkill(db, &serverstore.SharedSkill{Name: "s1", Version: "1.0.0", Author: "alice", Status: serverstore.SharedSkillPending}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateAgentPreset(db, &serverstore.AgentPreset{Name: "a1", Version: "1.0.0", Author: "alice", Status: serverstore.AgentPresetPending}); err != nil {
		t.Fatal(err)
	}
	w := doGet(t, r, "/api/admin/capabilities/approvals", adminHdr)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Approvals []ApprovalRow `json:"approvals"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Approvals) != 2 {
		t.Fatalf("approvals=%+v", resp.Approvals)
	}
	// kind 区分,base_path 指向原域端点。
	for _, a := range resp.Approvals {
		if a.Kind == KindSkill && a.BasePath != "/api/admin/shared-skills/s1/1.0.0" {
			t.Fatalf("skill base=%s", a.BasePath)
		}
		if a.Kind == KindAgent && a.BasePath != "/api/admin/agent-presets/a1/1.0.0" {
			t.Fatalf("agent base=%s", a.BasePath)
		}
	}
}

func TestListApprovalsTypeFilter(t *testing.T) {
	r, db, adminHdr, _ := setupRouter(t)
	defer db.Close()
	if _, err := serverstore.CreateSharedSkill(db, &serverstore.SharedSkill{Name: "s1", Version: "1.0.0", Author: "alice", Status: serverstore.SharedSkillPending}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateAgentPreset(db, &serverstore.AgentPreset{Name: "a1", Version: "1.0.0", Author: "alice", Status: serverstore.AgentPresetPending}); err != nil {
		t.Fatal(err)
	}
	w := doGet(t, r, "/api/admin/capabilities/approvals?type=skill", adminHdr)
	var resp struct {
		Approvals []ApprovalRow `json:"approvals"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Approvals) != 1 || resp.Approvals[0].Kind != KindSkill {
		t.Fatalf("skill filter approvals=%+v", resp.Approvals)
	}
}
