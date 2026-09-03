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

func TestMergeMarketFirstSortsVersions(t *testing.T) {
	// B5(2026-09-01):同名 market 行 [1.0.0,2.0.0] 与 org 行 [1.5.0] 折叠后,
	// versions 必须升序 [1.0.0,1.5.0,2.0.0](append 顺序会得到 1.0.0,2.0.0,1.5.0)。
	items := []CapabilityItem{
		{Kind: KindSkill, Source: SourceMarket, Name: "hub", Version: "2.0.0", Status: "approved", Versions: []string{"1.0.0", "2.0.0"}},
		{Kind: KindSkill, Source: SourceOrg, Name: "hub", Version: "1.5.0", Status: "approved", Versions: []string{"1.5.0"}},
	}
	merged := mergeMarketFirst(items)
	if len(merged) != 1 {
		t.Fatalf("len=%d, want 1", len(merged))
	}
	m := merged[0]
	if m.Source != SourceMarket {
		t.Fatalf("source=%s, want market first", m.Source)
	}
	want := []string{"1.0.0", "1.5.0", "2.0.0"}
	if len(m.Versions) != len(want) {
		t.Fatalf("versions=%v, want %v", m.Versions, want)
	}
	for i := range want {
		if m.Versions[i] != want[i] {
			t.Fatalf("versions=%v, want %v (ascending)", m.Versions, want)
		}
	}
	if m.Version != "2.0.0" {
		t.Fatalf("current version=%s, want 2.0.0 (market highest)", m.Version)
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

func TestListCapabilitiesSourceOwn(t *testing.T) {
	r, db, _, userTokens := setupRouter(t)
	defer db.Close()
	// alice 上传 pending + rejected 各一,bob 上传 approved 但未授权 alice。
	if _, err := serverstore.CreateSharedSkill(db, &serverstore.SharedSkill{Name: "waiting", Version: "1.0.0", Author: "alice", Status: serverstore.SharedSkillPending, DisplayName: "waiting"}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateSharedSkill(db, &serverstore.SharedSkill{Name: "denied", Version: "1.0.0", Author: "alice", Status: serverstore.SharedSkillRejected, Reason: "内容不合规"}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateSharedSkill(db, &serverstore.SharedSkill{Name: "notmine", Version: "1.0.0", Author: "bob", Status: serverstore.SharedSkillApproved}); err != nil {
		t.Fatal(err)
	}

	aliceHdr := map[string]string{"Authorization": "Bearer " + userTokens["alice"]}
	w := doGet(t, r, "/api/client/v2/capabilities?source=own", aliceHdr)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Items []CapabilityItem `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	// own 分区:alice 的 waiting(pending)/denied(rejected 含 reason)可见;
	// 他人 approved 不入 own。
	got := map[string]CapabilityItem{}
	for _, it := range resp.Items {
		got[it.Name] = it
	}
	if len(got) != 2 {
		t.Fatalf("items=%+v, want waiting+denied", resp.Items)
	}
	if it := got["waiting"]; it.Status != "pending" {
		t.Fatalf("waiting status=%s, want pending", it.Status)
	}
	if it := got["denied"]; it.Status != "rejected" || it.Reason != "内容不合规" {
		t.Fatalf("denied=%+v, want rejected with reason", it)
	}
	if _, ok := got["notmine"]; ok {
		t.Fatalf("own 分区不得包含他人条目: %+v", got["notmine"])
	}

	// bob 无 own 上传 → 空。这里 notmine 是 bob 自己上传的,own 分区应返回。
	bobHdr := map[string]string{"Authorization": "Bearer " + userTokens["bob"]}
	w2 := doGet(t, r, "/api/client/v2/capabilities?source=own", bobHdr)
	var resp2 struct {
		Items []CapabilityItem `json:"items"`
	}
	if err := json.Unmarshal(w2.Body.Bytes(), &resp2); err != nil {
		t.Fatal(err)
	}
	if len(resp2.Items) != 1 || resp2.Items[0].Name != "notmine" || resp2.Items[0].Status != "approved" {
		t.Fatalf("bob own items=%+v, want [notmine approved]", resp2.Items)
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
	// grants_base 是授权基路径(name-only,授权是资源级,同名多版本共享)——
	// 与含版本段的 base_path 不同;授权弹窗误用 base_path 会多出版本段 → 404。
	for _, a := range resp.Approvals {
		if a.Kind == KindSkill && a.GrantsBase != "/api/server/admin/shared-skills/s1" {
			t.Fatalf("skill grants_base=%s", a.GrantsBase)
		}
		if a.Kind == KindAgent && a.GrantsBase != "/api/server/admin/agent-presets/a1" {
			t.Fatalf("agent grants_base=%s", a.GrantsBase)
		}
	}
	// P2(迁移 0053):跨渠道同名冲突在统一应用模型里**结构上不可能**——
	// 一个 (kind, app_id) 只能属于一个渠道,市场与组织共用同一命名空间。
	// 因此这里改为断言该不变量本身:用市场语义登记同名技能会被直接拒绝,
	// 队列也就不会再出现「同名双份」的冲突行。
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{Name: "s1", Version: "9.0.0", Enabled: 1}); err == nil {
		t.Fatal("市场登记组织已占用的名字必须被拒绝(跨渠道同名互斥)")
	}
	w2 := doGet(t, r, "/api/server/admin/capabilities/approvals", adminHdr)
	var resp2 struct {
		Approvals []ApprovalRow `json:"approvals"`
	}
	if err := json.Unmarshal(w2.Body.Bytes(), &resp2); err != nil {
		t.Fatal(err)
	}
	skillRows := 0
	for _, a := range resp2.Approvals {
		if a.Kind == KindSkill && a.Name == "s1" {
			skillRows++
		}
	}
	if skillRows != 1 {
		t.Fatalf("s1 应当只有一条队列行(同名不可能跨渠道并存), got %d (%+v)", skillRows, resp2.Approvals)
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
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{Name: "market-only", Version: "1.0.0", Enabled: 1}); err != nil {
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

// TestCapabilitiesOfficialScore 0059: 聚合面 official/downloads/calls/score 字段与排序。
func TestCapabilitiesOfficialScore(t *testing.T) {
	r, db, adminHdr, userTokens := setupRouter(t)
	// 市场技能×3: alice 上传(普通)、官方(高 calls)、精选(中 calls)
	mk := func(name, version string, calls, downloads int64) {
		// 直接建 apps + release(绕过上传端点,聚焦聚合面)
		if err := serverstore.UpsertApp(db, &serverstore.App{
			Kind: serverstore.AppKindSkill, AppID: name, Title: name, Description: name,
			Owner: "alice", Channel: serverstore.AppChannelMarket, Enabled: 1,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := serverstore.CreateRelease(db, &serverstore.Release{
			Kind: serverstore.AppKindSkill, AppID: name, Version: "1.0.0", Title: name,
			Description: name, Author: "alice", Publisher: "alice", Status: serverstore.ReleaseStatusApproved,
		}); err != nil {
			t.Fatal(err)
		}
		// CreateRelease 不落计数列(计数由统计路径累加),测试直接置值。
		if _, err := db.Exec(`UPDATE app_releases SET downloads = ?, calls = ?
			WHERE kind = 'skill' AND app_id = ? AND version = '1.0.0'`, downloads, calls, name); err != nil {
			t.Fatal(err)
		}
	}
	mk("plain-skill", "1.0.0", 1, 2)
	mk("official-skill", "1.0.0", 500, 10)
	mk("featured-skill", "1.0.0", 100, 5)
	// 官方与精选标记(official 走 App 属性; featured 走 release quality)
	if err := serverstore.SetAppOfficial(db, serverstore.AppKindSkill, "official-skill", true, ""); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetReleaseQuality(db, serverstore.AppKindSkill, "featured-skill", "1.0.0", "featured"); err != nil {
		t.Fatal(err)
	}
	// 授权 alice 可见全部三个技能(市场授权制, alice 走授权制验证排序也一致)
	for _, n := range []string{"plain-skill", "official-skill", "featured-skill"} {
		if err := serverstore.GrantApp(db, serverstore.AppKindSkill, n, "alice", "user"); err != nil {
			t.Fatal(err)
		}
	}
	wr := doGet(t, r, "/api/client/v2/capabilities?source=market", map[string]string{"Authorization": "Bearer " + userTokens["alice"]})
	if wr.Code != http.StatusOK {
		t.Fatalf("status %d body=%s", wr.Code, wr.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(wr.Body.Bytes(), &out)
	items := out["items"].([]any)
	if len(items) < 3 {
		t.Fatalf("items = %d", len(items))
	}
	byName := map[string]map[string]any{}
	for _, it := range items {
		m := it.(map[string]any)
		byName[m["name"].(string)] = m
	}
	// official 字段与 score = calls*3+downloads
	if o := byName["official-skill"]; o["official"] != true || o["score"].(float64) != 500*3+10 {
		t.Fatalf("official row = %v", o)
	}
	if f := byName["featured-skill"]; f["official"] != false || f["score"].(float64) != 100*3+5 {
		t.Fatalf("featured row = %v", f)
	}
	if p := byName["plain-skill"]; p["official"] != false || p["score"].(float64) != 1*3+2 {
		t.Fatalf("plain row = %v", p)
	}
	// 排序: 官方 → 精选 → score 降序
	var order []string
	for _, it := range items {
		order = append(order, it.(map[string]any)["name"].(string))
	}
	found := map[string]int{}
	for i, n := range order {
		found[n] = i
	}
	if !(found["official-skill"] < found["featured-skill"] && found["featured-skill"] < found["plain-skill"]) {
		t.Fatalf("order = %v", order)
	}
	// 市场 DTO 官方字段投影(listSkillsAdmin 的输入面)
	skills, err := serverstore.ListSkills(db, false)
	if err != nil {
		t.Fatal(err)
	}
	sFound := false
	for _, sk := range skills {
		if sk.Name == "official-skill" && sk.Official == 1 {
			sFound = true
		}
	}
	if !sFound {
		t.Fatal("ListSkills missing official projection")
	}
	_ = adminHdr
}
