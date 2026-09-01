package marketplace

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// skillArchiveBytes 构造一个合规技能归档(0052:git 模式移除后,内容一律
// 来自上传的归档)。
func skillArchiveBytes(t *testing.T, name string) []byte {
	t.Helper()
	md := "---\nname: " + name + "\ntitle: " + name + " 技能\nversion: 1.0.0\n" +
		"description: 权限测试使用的技能包,描述需要满足最短长度要求。\nauthor: test\ncategory: 测试\n---\n\n" +
		"本技能是权限测试夹具,正文需要足够长才能通过空壳校验,因此补充这段说明文字。\n"
	return makeZip(t, map[string]string{"SKILL.md": md})
}

func marketUserSetup(t *testing.T) (http.Handler, *sql.DB, string, int64, string) {
	t.Helper()
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef0123456789abcdef")
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	uid, err := serverstore.CreateUserWithPassword(db, "alice", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: "data-extract", Version: "1.0.0", Description: "数据提取",
		Author: "test", Enabled: 1, Archive: skillArchiveBytes(t, "data-extract"),
	}); err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	NewAPI(db, t.TempDir()).RegisterRoutes(r)
	return r, db, token, uid, ""
}

func bearerGet(t *testing.T, r http.Handler, path, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// strict default: nothing visible or downloadable without a grant
func TestMarketplaceStrictDefault(t *testing.T) {
	r, db, token, uid, _ := marketUserSetup(t)

	// skill list: empty
	w := bearerGet(t, r, "/api/client/v2/marketplace/skills", token)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"skills":[]`) {
		t.Fatalf("skill list = %d %s, want empty", w.Code, w.Body.String())
	}
	// single skill lookup: 404 (no existence leak)
	w = bearerGet(t, r, "/api/client/v2/marketplace/skills/data-extract", token)
	if w.Code != http.StatusNotFound {
		t.Fatalf("getSkill = %d, want 404", w.Code)
	}
	// archive: 404
	w = bearerGet(t, r, "/api/client/v2/marketplace/skills/data-extract/archive", token)
	if w.Code != http.StatusNotFound {
		t.Fatalf("archive = %d, want 404", w.Code)
	}
	_ = db
	_ = uid
}

// direct user grant opens the resource (list + archive + config)
func TestMarketplaceUserGrant(t *testing.T) {
	r, db, token, _, _ := marketUserSetup(t)
	if err := serverstore.GrantSkill(db, "data-extract", "alice", serverstore.GranteeUser); err != nil {
		t.Fatal(err)
	}
	w := bearerGet(t, r, "/api/client/v2/marketplace/skills", token)
	if !strings.Contains(w.Body.String(), "data-extract") {
		t.Fatalf("skill list missing granted skill: %s", w.Body.String())
	}
	w = bearerGet(t, r, "/api/client/v2/marketplace/skills/data-extract", token)
	if w.Code != http.StatusOK {
		t.Fatalf("getSkill = %d, want 200", w.Code)
	}
	w = bearerGet(t, r, "/api/client/v2/marketplace/skills/data-extract/archive", token)
	if w.Code != http.StatusOK {
		t.Fatalf("archive = %d, want 200 (%s)", w.Code, w.Body.String())
	}
	// revoke takes effect immediately
	if err := serverstore.RevokeSkill(db, "data-extract", "alice", serverstore.GranteeUser); err != nil {
		t.Fatal(err)
	}
	w = bearerGet(t, r, "/api/client/v2/marketplace/skills", token)
	if !strings.Contains(w.Body.String(), `"skills":[]`) {
		t.Fatalf("after revoke list = %s, want empty", w.Body.String())
	}
}

// group grants resolve through the user's group membership
func TestMarketplaceGroupGrant(t *testing.T) {
	r, db, token, uid, _ := marketUserSetup(t)
	if err := serverstore.GrantSkill(db, "data-extract", "研发部", serverstore.GranteeGroup); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SyncUserGroups(db, uid, []string{"研发部"}); err != nil {
		t.Fatal(err)
	}
	w := bearerGet(t, r, "/api/client/v2/marketplace/skills", token)
	if !strings.Contains(w.Body.String(), "data-extract") {
		t.Fatalf("group grant not visible: %s", w.Body.String())
	}
	// leave the group → gone
	if err := serverstore.SyncUserGroups(db, uid, nil); err != nil {
		t.Fatal(err)
	}
	w = bearerGet(t, r, "/api/client/v2/marketplace/skills", token)
	if !strings.Contains(w.Body.String(), `"skills":[]`) {
		t.Fatalf("after group removal list = %s, want empty", w.Body.String())
	}
}

// admin (IsAdmin) sees everything without grants
func TestMarketplaceAdminSeesAll(t *testing.T) {
	r, db, _, _, _ := marketUserSetup(t)
	adminID, err := serverstore.CreateUserWithPassword(db, "boss", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	u, _ := serverstore.GetUserByUsername(db, "boss")
	u.IsAdmin = true
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, adminID)
	if err != nil {
		t.Fatal(err)
	}
	w := bearerGet(t, r, "/api/client/v2/marketplace/skills", token)
	if !strings.Contains(w.Body.String(), "data-extract") {
		t.Fatalf("admin skill list = %s", w.Body.String())
	}
}

// admin grant API: grant / list / revoke with audit trail
func TestAdminGrantAPI(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	if _, err := serverstore.CreateUserWithPassword(db, "alice", "pw123456"); err != nil {
		t.Fatal(err)
	}
	// seed a skill
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: "data-extract", Version: "1.0.0", Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateDepartment(db, "研发部", 0, 0, ""); err != nil {
		t.Fatal(err)
	}

	// grant user + group on skill
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/skills/data-extract/grant", `{"username":"alice"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("grant user: %d %s", w.Code, w.Body.String())
	}
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/skills/data-extract/grant", `{"group":"研发部"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("grant group: %d %s", w.Code, w.Body.String())
	}
	// list
	w, out := mreq(t, r, "GET", "/api/server/admin/skills/data-extract/grants", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("list grants: %d %s", w.Code, w.Body.String())
	}
	grants := out["grants"].([]any)
	if len(grants) != 2 {
		t.Fatalf("grants = %v, want 2", grants)
	}
	// both username+group in one request → rejected
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/skills/data-extract/grant", `{"username":"a","group":"b"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("ambiguous grant = %d, want 400", w.Code)
	}
	// revoke
	if w, _ := mreq(t, r, "DELETE", "/api/server/admin/skills/data-extract/grant", `{"username":"alice"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", w.Code, w.Body.String())
	}
	w, out = mreq(t, r, "GET", "/api/server/admin/skills/data-extract/grants", "", hdr)
	if len(out["grants"].([]any)) != 1 {
		t.Fatalf("after revoke grants = %v", out["grants"])
	}
	// audit trail written for grant + revoke
	logs, err := serverstore.ListAuditLogs(db, 10)
	if err != nil {
		t.Fatal(err)
	}
	actions := map[string]bool{}
	for _, l := range logs {
		actions[l.Action] = true
	}
	for _, want := range []string{"skill_grant", "skill_revoke"} {
		if !actions[want] {
			t.Fatalf("audit missing %s: %v", want, actions)
		}
	}
	// grants on unknown resources → 404
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/skills/nope/grant", `{"username":"alice"}`, hdr); w.Code != http.StatusNotFound {
		t.Fatalf("unknown skill grant = %d, want 404", w.Code)
	}
	// grants to a non-existent user → 400 (typos must not silently persist)
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/skills/data-extract/grant", `{"username":"no-such-user"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("unknown user grant = %d, want 400", w.Code)
	}
	// grants to a non-existent group → 400(拼错的部门名不得静默落库)
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/skills/data-extract/grant", `{"group":"no-such-dept"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("unknown group grant = %d, want 400", w.Code)
	}
}

// 整组替换端点:一次提交多部门授权,原子替换组授权
func TestAdminReplaceGrantsAPI(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	if _, err := serverstore.CreateUserWithPassword(db, "alice", "pw123456"); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateDepartment(db, "研发部", 0, 0, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateDepartment(db, "人事部", 0, 0, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: "data-extract", Version: "1.0.0", Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}
	// 一次提交两个部门(共享)
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/skills/data-extract/grants", `{"groups":["研发部","人事部"]}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("replace skill grants: %d %s", w.Code, w.Body.String())
	}
	_, out := mreq(t, r, "GET", "/api/server/admin/skills/data-extract/grants", "", hdr)
	grants := out["grants"].([]any)
	if len(grants) != 2 {
		t.Fatalf("skill grants = %v, want 2 departments", grants)
	}
	// 空列表清空
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/skills/data-extract/grants", `{"groups":[]}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("clear grants: %d", w.Code)
	}
	_, out = mreq(t, r, "GET", "/api/server/admin/skills/data-extract/grants", "", hdr)
	if len(out["grants"].([]any)) != 0 {
		t.Fatalf("grants after clear = %v", out["grants"])
	}
	// 不存在的部门 → 400
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/skills/data-extract/grants", `{"groups":["不存在"]}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("unknown dept = %d, want 400", w.Code)
	}
	// 审计
	logs, err := serverstore.ListAuditLogs(db, 5)
	if err != nil || logs[0].Action != "skill_grants_replace" {
		t.Fatalf("audit = %+v %v", logs, err)
	}
}
