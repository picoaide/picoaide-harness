package capabilities

// 技能全链路（2026-09-15）：员工上传 → 管理员审批 → 员工可见/可装 → 授权他人
// → 下架后不可见不可下载。
//
// 为什么单独立一条链路测试：此前"技能"面的门禁是**三处分散**的（聚合清单、
// 员工下载、授权表），单点测试各自绿，但没人跑过"上传→审批→安装"的完整用户
// 路径；智能体面在 2026-09-13 P2-1 已经补过 enabled 闸门，技能面当时漏了，
// 于是"管理员下架后员工照样能看到、照样能下载"。本文件把两侧对齐并把链路钉死。
//
// 断言分两层：
//  1. 客户端真实调用的面：GET /api/client/v2/capabilities?source=own|market；
//  2. 安装通路：GET /api/client/v2/shared-skills/:name/:version/archive。

import (
	"archive/zip"
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/sharedskills"
)

const skillLifecycleName = "codeql-audit"

func lifecycleZip(t *testing.T, name, version string) []byte {
	t.Helper()
	md := "---\n" +
		"name: " + name + "\n" +
		"title: " + name + " 技能\n" +
		"version: " + version + "\n" +
		"description: 用于技能全链路集成测试的夹具包,描述需要满足最短长度要求。\n" +
		"author: tester\n" +
		"category: 测试\nchangelog: 全链路夹具的更新说明。\n" +
		"---\n\n# " + name + "\n\n本技能是服务端集成测试使用的夹具包,正文需要足够长才能通过空壳校验,因此这里补充了一段用于说明用途的文字。\n"
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte(md)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// setupSkillLifecycle 起一棵与生产同前缀的路由树：admin 登录 + 客户端能力面 +
// 技能上传/审核/授权面。
func setupSkillLifecycle(t *testing.T) (*gin.Engine, *sql.DB, map[string]string, map[string]string, map[string]string) {
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
	RegisterRoutes(r, db, cacheDir)
	RegisterAdminRoutes(r, db, cacheDir)
	sharedskills.RegisterRoutes(r, db, cacheDir)
	sharedskills.RegisterAdminRoutes(r, db, cacheDir)

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
	return r, db, map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf},
		map[string]string{"Authorization": "Bearer " + tokens["alice"]},
		map[string]string{"Authorization": "Bearer " + tokens["bob"]}
}

type skillItem struct {
	Name     string
	Version  string
	Status   string
	Source   string
	Versions []string
}

// capabilityItems 调客户端聚合面（客户端真实调用的那个面），返回 kind=skill 的条目。
func capabilityItems(t *testing.T, r *gin.Engine, hdr map[string]string, source string) []skillItem {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/client/v2/capabilities?source="+source, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("capabilities(%s) = %d %s", source, w.Code, w.Body.String())
	}
	var body struct {
		Items []struct {
			Kind     string   `json:"kind"`
			Name     string   `json:"name"`
			Version  string   `json:"version"`
			Status   string   `json:"status"`
			Source   string   `json:"source"`
			Versions []string `json:"versions"`
		} `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	out := []skillItem{}
	for _, it := range body.Items {
		if it.Kind != "skill" || it.Name != skillLifecycleName {
			continue
		}
		out = append(out, skillItem{it.Name, it.Version, it.Status, it.Source, it.Versions})
	}
	return out
}

func hasSkillVersion(items []skillItem, version, source string) bool {
	for _, it := range items {
		if it.Version == version && (source == "" || it.Source == source) {
			return true
		}
	}
	return false
}

func downloadSkill(t *testing.T, r *gin.Engine, hdr map[string]string, version string) int {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/client/v2/shared-skills/"+skillLifecycleName+"/"+version+"/archive", nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	return w.Code
}

func uploadSkill(t *testing.T, r *gin.Engine, hdr map[string]string, version string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{
		"name": skillLifecycleName, "version": version,
		"archive": base64.StdEncoding.EncodeToString(lifecycleZip(t, skillLifecycleName, version)),
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/client/v2/shared-skills", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("upload %s = %d %s", version, w.Code, w.Body.String())
	}
}

// toggleSkillEnabled 走管理端上下架端点（员工可见性/下载的开关）。
func toggleSkillEnabled(t *testing.T, r *gin.Engine, adminHdr map[string]string, name string, enabled bool) {
	t.Helper()
	body, _ := json.Marshal(map[string]bool{"enabled": enabled})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/server/admin/shared-skills/"+name+"/enabled", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range adminHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("set enabled=%v = %d %s", enabled, w.Code, w.Body.String())
	}
}

func TestSkillLifecycleUploadApproveInstall(t *testing.T) {
	r, _, adminHdr, aliceHdr, bobHdr := setupSkillLifecycle(t)

	// 1) 员工上传 → pending（作者自己能在「我的」看到，组织面不可见）。
	uploadSkill(t, r, aliceHdr, "1.0.0")
	own := capabilityItems(t, r, aliceHdr, "own")
	if !hasSkillVersion(own, "1.0.0", "") {
		t.Fatalf("作者「我的」看不到自己刚上传的技能: %+v", own)
	}
	for _, it := range own {
		if it.Version == "1.0.0" && it.Status != "pending" {
			t.Fatalf("上传后状态 = %q, want pending", it.Status)
		}
	}
	if hasSkillVersion(capabilityItems(t, r, aliceHdr, "market"), "1.0.0", "org") {
		t.Fatal("pending 行不应出现在组织面")
	}
	if code := downloadSkill(t, r, aliceHdr, "1.0.0"); code != http.StatusNotFound {
		t.Fatalf("pending 下载 = %d, want 404", code)
	}

	// 2) 管理员审批通过 → 作者在「我的」看到 approved，组织面可见、可下载安装。
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/server/admin/shared-skills/"+skillLifecycleName+"/1.0.0/approve", nil)
	for k, v := range adminHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("approve = %d %s", w.Code, w.Body.String())
	}
	own = capabilityItems(t, r, aliceHdr, "own")
	found := false
	for _, it := range own {
		if it.Version == "1.0.0" {
			found = true
			if it.Status != "approved" {
				t.Fatalf("审批后「我的」状态 = %q, want approved", it.Status)
			}
		}
	}
	if !found {
		t.Fatalf("审批后作者「我的」看不到: %+v", own)
	}
	// 作者本人（未落授权表）在组织面应可见并可直接安装。
	if !hasSkillVersion(capabilityItems(t, r, aliceHdr, "market"), "1.0.0", "org") {
		t.Fatal("审批通过后作者在组织面看不到自己的技能（客户端将无法安装）")
	}
	if code := downloadSkill(t, r, aliceHdr, "1.0.0"); code != http.StatusOK {
		t.Fatalf("作者下载已通过版本 = %d, want 200", code)
	}

	// 3) 未授权的同事：组织面不可见、下载 404（与不存在同码，不泄露存在性）。
	if hasSkillVersion(capabilityItems(t, r, bobHdr, "market"), "1.0.0", "org") {
		t.Fatal("未授权同事不应看到组织技能")
	}
	if code := downloadSkill(t, r, bobHdr, "1.0.0"); code != http.StatusNotFound {
		t.Fatalf("未授权下载 = %d, want 404", code)
	}

	// 4) 管理员授权给 bob（个人授权）→ 可见 + 可下载。
	wG := httptest.NewRecorder()
	reqG := httptest.NewRequest("PUT", "/api/server/admin/shared-skills/"+skillLifecycleName+"/grant",
		strings.NewReader(`{"username":"bob"}`))
	reqG.Header.Set("Content-Type", "application/json")
	for k, v := range adminHdr {
		reqG.Header.Set(k, v)
	}
	r.ServeHTTP(wG, reqG)
	if wG.Code != http.StatusOK {
		t.Fatalf("grant = %d %s", wG.Code, wG.Body.String())
	}
	if !hasSkillVersion(capabilityItems(t, r, bobHdr, "market"), "1.0.0", "org") {
		t.Fatal("授权后同事仍看不到组织技能")
	}
	if code := downloadSkill(t, r, bobHdr, "1.0.0"); code != http.StatusOK {
		t.Fatalf("授权后下载 = %d, want 200", code)
	}

	// 5) 管理员上下架端点下架 → 员工面不可见、不可下载；作者本人同样按员工处理。
	toggleSkillEnabled(t, r, adminHdr, skillLifecycleName, false)
	if hasSkillVersion(capabilityItems(t, r, bobHdr, "market"), "1.0.0", "org") {
		t.Fatal("下架后同事仍能看到组织技能（市场下架必须生效，对齐智能体面 P2-1）")
	}
	if code := downloadSkill(t, r, bobHdr, "1.0.0"); code != http.StatusNotFound {
		t.Fatalf("下架后同事下载 = %d, want 404", code)
	}
	if hasSkillVersion(capabilityItems(t, r, aliceHdr, "market"), "1.0.0", "org") {
		t.Fatal("下架后作者仍能在组织面看到该技能")
	}
	if code := downloadSkill(t, r, aliceHdr, "1.0.0"); code != http.StatusNotFound {
		t.Fatalf("下架后作者下载 = %d, want 404", code)
	}
	// 管理面(admin=true)照旧可读归档：审核与排障要看已下架内容（与 agentshare 同口径）。
	wAdm := httptest.NewRecorder()
	reqAdm := httptest.NewRequest("GET", "/api/server/admin/shared-skills/"+skillLifecycleName+"/1.0.0/archive", nil)
	for k, v := range adminHdr {
		reqAdm.Header.Set(k, v)
	}
	r.ServeHTTP(wAdm, reqAdm)
	if wAdm.Code != http.StatusOK {
		t.Fatalf("下架后管理面下载 = %d, want 200（管理面只读归档不受下架影响）", wAdm.Code)
	}

	// 6) 重新上架 → 可见性恢复（证明闸门是开关而不是单向删除）。
	toggleSkillEnabled(t, r, adminHdr, skillLifecycleName, true)
	if !hasSkillVersion(capabilityItems(t, r, bobHdr, "market"), "1.0.0", "org") {
		t.Fatal("重新上架后同事应恢复可见")
	}
	if code := downloadSkill(t, r, bobHdr, "1.0.0"); code != http.StatusOK {
		t.Fatalf("重新上架后下载 = %d, want 200", code)
	}
}

// 授权给「部门组」时，组内成员（含子部门继承）即可见可装——双门制的第二道门
// 走的是 UserEffectiveGroups，不是只有逐人授权一条路。
func TestSkillLifecycleGroupGrant(t *testing.T) {
	r, db, adminHdr, aliceHdr, bobHdr := setupSkillLifecycle(t)
	uploadSkill(t, r, aliceHdr, "1.0.0")
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/server/admin/shared-skills/"+skillLifecycleName+"/1.0.0/approve", nil)
	for k, v := range adminHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("approve = %d %s", w.Code, w.Body.String())
	}

	bob, err := serverstore.GetUserByUsername(db, "bob")
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SyncUserGroups(db, bob.ID, []string{"研发部"}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.GetOrCreateGroup(db, "研发部"); err != nil {
		t.Fatal(err)
	}
	// 授权给组之前：不可见。
	if hasSkillVersion(capabilityItems(t, r, bobHdr, "market"), "1.0.0", "org") {
		t.Fatal("加入部门但未授权组时不应可见")
	}
	wG := httptest.NewRecorder()
	reqG := httptest.NewRequest("PUT", "/api/server/admin/shared-skills/"+skillLifecycleName+"/grant",
		strings.NewReader(`{"group":"研发部"}`))
	reqG.Header.Set("Content-Type", "application/json")
	for k, v := range adminHdr {
		reqG.Header.Set(k, v)
	}
	r.ServeHTTP(wG, reqG)
	if wG.Code != http.StatusOK {
		t.Fatalf("group grant = %d %s", wG.Code, wG.Body.String())
	}
	if !hasSkillVersion(capabilityItems(t, r, bobHdr, "market"), "1.0.0", "org") {
		t.Fatal("授权给部门组后，组内成员应可见")
	}
	if code := downloadSkill(t, r, bobHdr, "1.0.0"); code != http.StatusOK {
		t.Fatalf("部门授权后下载 = %d, want 200", code)
	}
}

// 驳回链路：作者在「我的」看到拒因，组织面与下载一律 404；升版本重传并审批后恢复。
func TestSkillLifecycleRejectThenReupload(t *testing.T) {
	r, _, adminHdr, aliceHdr, bobHdr := setupSkillLifecycle(t)
	uploadSkill(t, r, aliceHdr, "1.0.0")

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/server/admin/shared-skills/"+skillLifecycleName+"/1.0.0/reject",
		strings.NewReader(`{"reason":"缺少使用说明"}`))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range adminHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("reject = %d %s", w.Code, w.Body.String())
	}
	own := capabilityItems(t, r, aliceHdr, "own")
	found := false
	for _, it := range own {
		if it.Version != "1.0.0" {
			continue
		}
		found = true
		if it.Status != "rejected" {
			t.Fatalf("驳回后「我的」状态 = %q, want rejected", it.Status)
		}
	}
	if !found {
		t.Fatalf("驳回后作者「我的」看不到自己的行: %+v", own)
	}
	if hasSkillVersion(capabilityItems(t, r, aliceHdr, "market"), "1.0.0", "org") {
		t.Fatal("rejected 行不应出现在组织面")
	}
	if code := downloadSkill(t, r, aliceHdr, "1.0.0"); code != http.StatusNotFound {
		t.Fatalf("rejected 下载 = %d, want 404", code)
	}
	// 升版本重传 → 审批 → 作者与同事（授权后）恢复可见。
	uploadSkill(t, r, aliceHdr, "1.0.1")
	wA := httptest.NewRecorder()
	reqA := httptest.NewRequest("POST", "/api/server/admin/shared-skills/"+skillLifecycleName+"/1.0.1/approve", nil)
	for k, v := range adminHdr {
		reqA.Header.Set(k, v)
	}
	r.ServeHTTP(wA, reqA)
	if wA.Code != http.StatusOK {
		t.Fatalf("approve 1.0.1 = %d %s", wA.Code, wA.Body.String())
	}
	if !hasSkillVersion(capabilityItems(t, r, aliceHdr, "market"), "1.0.1", "org") {
		t.Fatal("重传并审批后作者应可见新版本")
	}
	if hasSkillVersion(capabilityItems(t, r, bobHdr, "market"), "1.0.1", "org") {
		t.Fatal("未授权同事不应看到新版本")
	}
}

// 多版本：pending 的新版本不改变已通过版本的可用性；新版本通过后同名卡带全部版本。
func TestSkillLifecycleMultiVersion(t *testing.T) {
	r, _, adminHdr, aliceHdr, _ := setupSkillLifecycle(t)
	uploadSkill(t, r, aliceHdr, "1.0.0")
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/server/admin/shared-skills/"+skillLifecycleName+"/1.0.0/approve", nil)
	for k, v := range adminHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("approve 1.0.0 = %d %s", w.Code, w.Body.String())
	}
	uploadSkill(t, r, aliceHdr, "1.1.0")

	market := capabilityItems(t, r, aliceHdr, "market")
	for _, it := range market {
		if it.Version == "1.1.0" {
			t.Fatal("pending 的 1.1.0 不应作为展示版本出现在组织面")
		}
	}
	if !hasSkillVersion(market, "1.0.0", "org") {
		t.Fatalf("已通过版本必须保持可用: %+v", market)
	}
	// 第二个版本通过后：同名卡同时带 1.0.0 与 1.1.0。
	w2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("POST", "/api/server/admin/shared-skills/"+skillLifecycleName+"/1.1.0/approve", nil)
	for k, v := range adminHdr {
		req2.Header.Set(k, v)
	}
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("approve 1.1.0 = %d %s", w2.Code, w2.Body.String())
	}
	found := false
	for _, it := range capabilityItems(t, r, aliceHdr, "market") {
		if it.Source != "org" {
			continue
		}
		found = true
		if it.Version != "1.1.0" {
			t.Fatalf("展示版本应为最高的已通过版本, got %q", it.Version)
		}
		if len(it.Versions) != 2 {
			t.Fatalf("versions = %v, want [1.0.0 1.1.0]", it.Versions)
		}
	}
	if !found {
		t.Fatal("两个版本都通过后组织面应有该技能")
	}
}

// 管理端上下架端点（2026-09-15）：渠道守卫、入参校验、审计留痕、员工面效果。
func TestSkillAdminEnabledEndpoint(t *testing.T) {
	r, db, adminHdr, aliceHdr, bobHdr := setupSkillLifecycle(t)
	uploadSkill(t, r, aliceHdr, "1.0.0")
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/server/admin/shared-skills/"+skillLifecycleName+"/1.0.0/approve", nil)
	for k, v := range adminHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("approve = %d", w.Code)
	}

	// 管理端清单带 enabled 状态（前端据此渲染「已下架」与切换按钮）。
	listEnabled := func() bool {
		wl := httptest.NewRecorder()
		rl := httptest.NewRequest("GET", "/api/server/admin/shared-skills", nil)
		for k, v := range adminHdr {
			rl.Header.Set(k, v)
		}
		r.ServeHTTP(wl, rl)
		var body struct {
			Skills []struct {
				Name    string `json:"name"`
				Enabled bool   `json:"enabled"`
			} `json:"skills"`
		}
		if err := json.Unmarshal(wl.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		for _, s := range body.Skills {
			if s.Name == skillLifecycleName {
				return s.Enabled
			}
		}
		t.Fatalf("管理端清单里找不到 %s", skillLifecycleName)
		return false
	}
	if !listEnabled() {
		t.Fatal("新审批通过的技能应处于上架状态")
	}

	toggleSkillEnabled(t, r, adminHdr, skillLifecycleName, false)
	if listEnabled() {
		t.Fatal("下架后管理端清单的 enabled 应为 false")
	}
	if code := downloadSkill(t, r, aliceHdr, "1.0.0"); code != http.StatusNotFound {
		t.Fatalf("下架后作者下载 = %d, want 404", code)
	}

	// 审计留痕：可见性变更必须可追溯（与市场技能的 skill_disable 同精神）。
	rows, _, err := serverstore.ListAuditLogsPagedFiltered(db, 0, 50, "shared_skill_disable", "")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, row := range rows {
		if strings.Contains(row.Detail, skillLifecycleName) {
			found = true
		}
	}
	if !found {
		t.Fatalf("下架未留下 shared_skill_disable 审计: %+v", rows)
	}

	toggleSkillEnabled(t, r, adminHdr, skillLifecycleName, true)
	if !listEnabled() {
		t.Fatal("重新上架后 enabled 应为 true")
	}
	if code := downloadSkill(t, r, bobHdr, "1.0.0"); code != http.StatusNotFound {
		// bob 仍未授权：上架恢复的是"可见性开关"，不是"授权"（双门制）。
		t.Fatalf("未授权同事在重新上架后下载 = %d, want 404（授权门不受上下架影响）", code)
	}
	if !hasSkillVersion(capabilityItems(t, r, aliceHdr, "market"), "1.0.0", "org") {
		t.Fatal("重新上架后作者应恢复可见")
	}
}

// 端点自身的守卫：入参、未知技能、跨渠道（市场技能不由本端点管）。
func TestSkillAdminEnabledEndpointGuards(t *testing.T) {
	r, db, adminHdr, _, _ := setupSkillLifecycle(t)

	// 入参缺失/非法。
	for _, body := range []string{`{}`, `{"enabled":"yes"}`, `not-json`} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("PUT", "/api/server/admin/shared-skills/nope/enabled", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		for k, v := range adminHdr {
			req.Header.Set(k, v)
		}
		r.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("body %q = %d, want 400", body, w.Code)
		}
	}

	// 未知技能 → 404。
	w := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/server/admin/shared-skills/ghost/enabled", strings.NewReader(`{"enabled":false}`))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range adminHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("未知技能 = %d, want 404", w.Code)
	}

	// 市场渠道技能：本端点不碰（跨渠道写由 marketplace-8 同向阻断）。
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindSkill, AppID: "market-only", Title: "market-only",
		Channel: serverstore.AppChannelMarket, Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}
	wM := httptest.NewRecorder()
	reqM := httptest.NewRequest("PUT", "/api/server/admin/shared-skills/market-only/enabled", strings.NewReader(`{"enabled":false}`))
	reqM.Header.Set("Content-Type", "application/json")
	for k, v := range adminHdr {
		reqM.Header.Set(k, v)
	}
	r.ServeHTTP(wM, reqM)
	if wM.Code != http.StatusNotFound {
		t.Fatalf("市场渠道技能 = %d, want 404（本端点只服务组织库）", wM.Code)
	}
	app, err := serverstore.GetApp(db, serverstore.AppKindSkill, "market-only")
	if err != nil {
		t.Fatal(err)
	}
	if app.Enabled != 1 {
		t.Fatal("跨渠道请求不得改动市场技能的 enabled")
	}
}

// adminBearer 用管理员自己的 API token 走客户端面（与员工同一个中间件：
// BearerAuth → VerifyToken，IsAdmin 随行）。
func adminBearer(t *testing.T, db *sql.DB) map[string]string {
	t.Helper()
	boss, err := serverstore.GetUserByUsername(db, "boss")
	if err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, boss.ID)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]string{"Authorization": "Bearer " + token}
}

func approveSkill(t *testing.T, r *gin.Engine, adminHdr map[string]string, version string) {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/server/admin/shared-skills/"+skillLifecycleName+"/"+version+"/approve", nil)
	for k, v := range adminHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("approve %s = %d %s", version, w.Code, w.Body.String())
	}
}

func grantSkill(t *testing.T, r *gin.Engine, adminHdr map[string]string, username string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"username": username})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/server/admin/shared-skills/"+skillLifecycleName+"/grant", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range adminHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("grant %s = %d %s", username, w.Code, w.Body.String())
	}
}

// clientSkillList 调 /api/client/v2/shared-skills（能力中心之外的另一条客户端
// 清单面），返回 "name@version" 列表。
func clientSkillList(t *testing.T, r *gin.Engine, hdr map[string]string) []string {
	t.Helper()
	w := doGet(t, r, "/api/client/v2/shared-skills", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("客户端技能清单 = %d %s", w.Code, w.Body.String())
	}
	var body struct {
		Skills []struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		} `json:"skills"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, s := range body.Skills {
		out = append(out, s.Name+"@"+s.Version)
	}
	return out
}

func containsStr(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// 审计 2026-09-15 S11-2：客户端面的「下架」必须对**管理员**同样生效。
//
// 客户端安装通路的归档端点在路由树里恒以 admin=false 构造（与调用者是否管理员
// 无关），所以管理员在客户端清单里看到已下架行 = 可点但必 404 的死行。这正是
// agentshare 已经钉死的口径（listVisible 的 `&& enabled[...]`：管理员在客户端面
// 也不该看到可点但下载必 404 的行）。两条客户端清单（技能清单 +
// 能力中心聚合的组织分区）都要过滤，而管理面清单仍全量（下架不删数据）。
func TestSkillDisabledHiddenFromAdminClientLists(t *testing.T) {
	r, db, adminHdr, aliceHdr, bobHdr := setupSkillLifecycle(t)
	bossHdr := adminBearer(t, db)

	uploadSkill(t, r, aliceHdr, "1.0.0")
	approveSkill(t, r, adminHdr, "1.0.0")
	// 管理员自己也落授权（客户端下载门对 admin 没有豁免，只有作者/已授权可下），
	// 这样"上架可装 / 下架 404"才是同一主体的可比对。
	grantSkill(t, r, adminHdr, "boss")
	grantSkill(t, r, adminHdr, "bob")

	callers := []struct {
		who string
		hdr map[string]string
	}{
		{"管理员", bossHdr},
		{"员工", bobHdr},
		{"作者", aliceHdr},
	}
	// 正对照：上架时三种角色在两条客户端面都可见、可安装（夹具本身可见）。
	for _, c := range callers {
		if !hasSkillVersion(capabilityItems(t, r, c.hdr, "market"), "1.0.0", "org") {
			t.Fatalf("上架时%s在能力中心看不到组织技能（正对照失败）", c.who)
		}
		if !containsStr(clientSkillList(t, r, c.hdr), skillLifecycleName+"@1.0.0") {
			t.Fatalf("上架时%s在客户端技能清单看不到组织技能（正对照失败）", c.who)
		}
		if code := downloadSkill(t, r, c.hdr, "1.0.0"); code != http.StatusOK {
			t.Fatalf("上架时%s下载 = %d, want 200（正对照失败）", c.who, code)
		}
	}

	toggleSkillEnabled(t, r, adminHdr, skillLifecycleName, false)

	// 下架后：两条客户端面对三种角色都必须与「不存在」同语义（管理员也不例外）。
	for _, c := range callers {
		if hasSkillVersion(capabilityItems(t, r, c.hdr, "market"), "1.0.0", "org") {
			t.Fatalf("下架后%s仍能在能力中心看到组织技能（客户端面下架必须生效）", c.who)
		}
		if containsStr(clientSkillList(t, r, c.hdr), skillLifecycleName+"@1.0.0") {
			t.Fatalf("下架后%s仍能在客户端技能清单看到组织技能", c.who)
		}
		if code := downloadSkill(t, r, c.hdr, "1.0.0"); code != http.StatusNotFound {
			t.Fatalf("下架后%s下载 = %d, want 404", c.who, code)
		}
	}

	// 管理面清单仍全量：下架不等于删除，管理员要能重新上架/排障。
	w := doGet(t, r, "/api/server/admin/shared-skills", adminHdr)
	if w.Code != http.StatusOK {
		t.Fatalf("管理面清单 = %d %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), skillLifecycleName) {
		t.Fatal("管理面清单被下架过滤了（管理面必须全量，见 listAll）")
	}
}
