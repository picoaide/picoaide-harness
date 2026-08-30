package capabilities

import (
	"database/sql"
	"encoding/json"
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
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
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

// reqDo issues an admin PUT/POST with CSRF/cookie headers (e.g. grant calls).
func reqDo(t *testing.T, r *gin.Engine, adminHdr map[string]string, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range adminHdr {
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
	w := doGet(t, r, "/api/client/v2/capabilities", aliceHdr)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Items []CapabilityItem `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	// 组织分区仅 approved(决策 2026-08-25):alice 的 own pending 不进 org
	// 分区(由「我的」上传状态展示);bob 的 approved 未授权不可见 → 空。
	if len(resp.Items) != 0 {
		t.Fatalf("items=%+v, want empty (org only approved + granted)", resp.Items)
	}
}

func TestListCapabilitiesAuthorOwnApproved(t *testing.T) {
	r, db, _, userTokens := setupRouter(t)
	defer db.Close()
	// alice 上传并已 approved 的技能:作者自己可见(作者恒可见自己),org 应返回。
	if _, err := serverstore.CreateSharedSkill(db, &serverstore.SharedSkill{Name: "mine", Version: "1.0.0", Author: "alice", Status: serverstore.SharedSkillApproved}); err != nil {
		t.Fatal(err)
	}
	aliceHdr := map[string]string{"Authorization": "Bearer " + userTokens["alice"]}
	w := doGet(t, r, "/api/client/v2/capabilities", aliceHdr)
	var resp struct {
		Items []CapabilityItem `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Items) != 1 || resp.Items[0].Name != "mine" || resp.Items[0].Status != "approved" {
		t.Fatalf("items=%+v, want own approved visible", resp.Items)
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
	w := doGet(t, r, "/api/server/admin/capabilities/approvals", adminHdr)
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
	// kind 区分,base_path 指向原域端点(2026-09 命名空间重构后为
	// /api/server/admin 前缀,勿回退旧 /api/admin)。
	for _, a := range resp.Approvals {
		if a.Kind == KindSkill && a.BasePath != "/api/server/admin/shared-skills/s1/1.0.0" {
			t.Fatalf("skill base=%s", a.BasePath)
		}
		if a.Kind == KindAgent && a.BasePath != "/api/server/admin/agent-presets/a1/1.0.0" {
			t.Fatalf("agent base=%s", a.BasePath)
		}
	}
	// 决策 2026-08-25:市场 skills 表同名冲突 -> 队列行 conflict=true。
	// 正常路径双向互斥会阻断,此处用 raw SQL 模拟竞态(共享技能上传后市场
	// 技能被上架),验证审批队列的冲突提示。
	if _, err := db.Exec(`INSERT INTO skills (name, version, description, author, git_url, git_ref, checksum, enabled)
		VALUES ('s1', '1.0.0', '', 'boss', 'https://example.com/repo.git', 'main', '', 1)`); err != nil {
		t.Fatalf("raw market seed: %v", err)
	}
	w2 := doGet(t, r, "/api/server/admin/capabilities/approvals", adminHdr)
	var resp2 struct {
		Approvals []ApprovalRow `json:"approvals"`
	}
	if err := json.Unmarshal(w2.Body.Bytes(), &resp2); err != nil {
		t.Fatal(err)
	}
	foundConflict := false
	for _, a := range resp2.Approvals {
		if a.Kind == KindSkill && a.Name == "s1" {
			foundConflict = a.Conflict
		}
	}
	if !foundConflict {
		t.Fatalf("s1 conflict flag = false, want true (%+v)", resp2.Approvals)
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
	w := doGet(t, r, "/api/server/admin/capabilities/approvals?type=skill", adminHdr)
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

// TestListApprovalsStatusAll 默认 pending;?status=all 返回全部状态
// (2026-09 修复:统一审批队列重建后旧页面的「已通过/已拒绝」tab 依赖全量)。
func TestListApprovalsStatusAll(t *testing.T) {
	r, db, adminHdr, _ := setupRouter(t)
	defer db.Close()
	if _, err := serverstore.CreateSharedSkill(db, &serverstore.SharedSkill{Name: "s1", Version: "1.0.0", Author: "alice", Status: serverstore.SharedSkillPending}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateSharedSkill(db, &serverstore.SharedSkill{Name: "s2", Version: "1.0.0", Author: "alice", Status: serverstore.SharedSkillApproved}); err != nil {
		t.Fatal(err)
	}
	// 默认 pending:只 1 条。
	w := doGet(t, r, "/api/server/admin/capabilities/approvals", adminHdr)
	var resp struct {
		Approvals []ApprovalRow `json:"approvals"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Approvals) != 1 || resp.Approvals[0].Status != "pending" {
		t.Fatalf("default pending approvals=%+v", resp.Approvals)
	}
	// status=all:2 条,且 downloads/calls 字段透传(缺省 0)。
	w2 := doGet(t, r, "/api/server/admin/capabilities/approvals?status=all", adminHdr)
	var resp2 struct {
		Approvals []ApprovalRow `json:"approvals"`
	}
	if err := json.Unmarshal(w2.Body.Bytes(), &resp2); err != nil {
		t.Fatal(err)
	}
	if len(resp2.Approvals) != 2 {
		t.Fatalf("status=all approvals=%+v", resp2.Approvals)
	}
}

// TestCapabilitiesMarketMerge 决策 2026-08-25:市场/组织合并为「市场」。
// ?source=market 返回合并(市场+组织可见项,各保留 source 徽章);
// ?source=org 仅组织;无参数全量(向后兼容)。
// 注:跨源同名已被强制互斥(上传/上架 409)阻断,合并内在不变量是
// 「同名不同源不会共存」,故本测试验证正常合并与 source 保留。
func TestCapabilitiesMarketMerge(t *testing.T) {
	r, db, _, userTokens := setupRouter(t)
	aliceHdr := map[string]string{"Authorization": "Bearer " + userTokens["alice"]}
	defer db.Close()
	// 市场技能(授权给 alice)。
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{Name: "market-only", Version: "1.0.0", Enabled: 1, GitURL: "https://example.com/m.git"}); err != nil {
		t.Fatalf("market only: %v", err)
	}
	// 共享库技能(approved + 授权给 alice)。
	if _, err := serverstore.CreateSharedSkill(db, &serverstore.SharedSkill{Name: "org-only", Version: "1.0.0", Author: "alice", Status: serverstore.SharedSkillApproved}); err != nil {
		t.Fatalf("shared org-only: %v", err)
	}
	// 直接授权 alice 可见市场技能(perm_test 同款:serverstore.GrantSkill)。
	if err := serverstore.GrantSkill(db, "market-only", "alice", serverstore.GranteeUser); err != nil {
		t.Fatalf("grant market-only: %v", err)
	}
	// 共享库 org-only 的作者是 alice(作者 own 任意状态均可见),无需额外授权。

	// ?source=market 合并:market-only(source=market) 与 org-only(source=org) 同在。
	w := doGet(t, r, "/api/client/v2/capabilities?source=market&type=skill", aliceHdr)
	var resp struct {
		Items []CapabilityItem `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	byName := map[string]CapabilityItem{}
	for _, it := range resp.Items {
		byName[it.Name] = it
	}
	if len(byName) != 2 {
		t.Fatalf("merged count=%d (%+v)", len(byName), resp.Items)
	}
	if byName["market-only"].Source != SourceMarket {
		t.Fatalf("market-only source=%s, want market", byName["market-only"].Source)
	}
	if byName["org-only"].Source != SourceOrg {
		t.Fatalf("org-only source=%s, want org", byName["org-only"].Source)
	}

	// ?source=org 仅组织,不泄漏市场。
	w2 := doGet(t, r, "/api/client/v2/capabilities?source=org&type=skill", aliceHdr)
	var resp2 struct {
		Items []CapabilityItem `json:"items"`
	}
	if err := json.Unmarshal(w2.Body.Bytes(), &resp2); err != nil {
		t.Fatal(err)
	}
	for _, it := range resp2.Items {
		if it.Name == "market-only" {
			t.Fatalf("org source leaked market-only")
		}
		if it.Source != SourceOrg {
			t.Fatalf("org item source=%s", it.Source)
		}
	}
}

// TestMergeMarketFirst 直接验证同名折叠(防御性):市场行优先、组织版本并入。
func TestMergeMarketFirst(t *testing.T) {
	items := []CapabilityItem{
		{Kind: KindSkill, Source: SourceMarket, Name: "dup", Version: "1.0.0", Status: "approved"},
		{Kind: KindSkill, Source: SourceOrg, Name: "dup", Version: "2.0.0", Status: "approved"},
		{Kind: KindSkill, Source: SourceOrg, Name: "only-org", Version: "1.0.0", Status: "approved"},
	}
	out := mergeMarketFirst(items)
	if len(out) != 2 {
		t.Fatalf("merged len=%d, want 2", len(out))
	}
	for _, it := range out {
		if it.Name == "dup" {
			if it.Source != SourceMarket {
				t.Fatalf("dup source=%s, want market", it.Source)
			}
			if len(it.Versions) < 2 {
				t.Fatalf("dup versions=%v, want org merged", it.Versions)
			}
		}
	}
}
