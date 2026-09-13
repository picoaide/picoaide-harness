package telemetry

import (
	"database/sql"
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

const skillCallPath = "/api/client/v2/telemetry/skill-call"

// grantSkill 给用户授权一个技能(app_grants,kind='skill')—— 限流等既有用例
// 在 srvcore-2 之后需要先过可见性这一关。
func grantSkill(t *testing.T, db *sql.DB, name, username string) {
	t.Helper()
	if err := serverstore.GrantApp(db, serverstore.AppKindSkill, name, username, string(serverstore.GranteeUser)); err != nil {
		t.Fatalf("GrantApp(%s, %s): %v", name, username, err)
	}
}

// marketSkillCalls 读回市场技能的调用计数(展示版本聚合行)。
func marketSkillCalls(t *testing.T, db *sql.DB, name string) int64 {
	t.Helper()
	s, err := serverstore.GetSkill(db, name)
	if err != nil {
		t.Fatalf("GetSkill(%s): %v", name, err)
	}
	return s.Calls
}

// srvcore-2(P2,审计 2026-09-13):POST /api/client/v2/telemetry/skill-call 对
// 计数目标没有任何可见性/授权校验 —— 任意登录员工都能给**对自己不可见**的
// 技能刷 calls(读侧 404 / 空列表,写侧 200 + calls+1)。
//
// 回归判据:写侧复用读侧的可见性口径(admin 恒全量;其余按 skill 授权名单),
// 不可见技能的计数一律不落。
//
// R7-F3-N2(复核 2026-09-13):**不换状态码** —— 对外与"平台上不存在"同为
// 200 + {"ok":true},否则"存在但不可见"(404)与"不存在"(200)可区分,端点
// 就成了技能存在性预言机(读侧刻意同码 404;逐字节等价见
// skill_call_oracle_r7_test.go)。
func TestReportSkillCallDoesNotCountInvisibleSkill(t *testing.T) {
	r, db, token := newTestEnv(t) // alice:无任何授权
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: "secret-skill", Version: "1.0.0", Enabled: 1, Archive: []byte("pkg"),
	}); err != nil {
		t.Fatal(err)
	}

	// 前提:alice 对 secret-skill 无任何授权(读侧口径:严格默认拒绝)。
	w := post(r, token, skillCallPath, `{"name":"secret-skill"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("invisible skill report = %d body=%s, want 200(静默忽略,不得给不可见技能计数)",
			w.Code, w.Body.String())
	}
	if got := marketSkillCalls(t, db, "secret-skill"); got != 0 {
		t.Fatalf("invisible skill calls = %d, want 0(未授权写必须被拒)", got)
	}

	// 带 version 的精确目标同样受管:未授权版本行不得被计数。
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: "secret-versioned", Version: "2.0.0", Enabled: 1, Archive: []byte("pkg"),
	}); err != nil {
		t.Fatal(err)
	}
	w = post(r, token, skillCallPath, `{"name":"secret-versioned","version":"2.0.0"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("invisible versioned skill report = %d body=%s, want 200", w.Code, w.Body.String())
	}
	rel, err := serverstore.GetRelease(db, serverstore.AppKindSkill, "secret-versioned", "2.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if rel.Calls != 0 {
		t.Fatalf("invisible version calls = %d, want 0", rel.Calls)
	}

	// 授权之后同一请求必须放行并计数(修复不得误伤合法上报)。
	if err := serverstore.GrantApp(db, serverstore.AppKindSkill, "secret-skill", "alice", string(serverstore.GranteeUser)); err != nil {
		t.Fatal(err)
	}
	w = post(r, token, skillCallPath, `{"name":"secret-skill"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("granted skill report = %d body=%s, want 200", w.Code, w.Body.String())
	}
	if got := marketSkillCalls(t, db, "secret-skill"); got != 1 {
		t.Fatalf("granted skill calls = %d, want 1", got)
	}
}

// 修可见性时必须保住既有的三条合法路径:
//   - admin 恒全量(不落授权表);
//   - 组织共享技能的作者本人(读侧 ListVisibleSharedSkills 的作者例外);
//   - 平台上不存在的名字 = 本地创作技能,沿用"静默忽略"(200 且不计数)。
func TestReportSkillCallKeepsLegitimateTargets(t *testing.T) {
	r, db, token := newTestEnv(t)

	// admin 恒全量。
	adminHash, err := util.HashPassword("root123456")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateUser(db, &serverstore.User{
		Username: "root", PasswordHash: adminHash, Source: "local", Status: 1,
		IsAdmin: true, Role: serverstore.RoleSuperAdmin,
	}); err != nil {
		t.Fatal(err)
	}
	root, err := serverstore.GetUserByUsername(db, "root")
	if err != nil {
		t.Fatal(err)
	}
	adminToken, err := serverauth.IssueToken(db, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: "admin-only-skill", Version: "1.0.0", Enabled: 1, Archive: []byte("pkg"),
	}); err != nil {
		t.Fatal(err)
	}
	if w := post(r, adminToken, skillCallPath, `{"name":"admin-only-skill"}`); w.Code != http.StatusOK {
		t.Fatalf("admin report = %d body=%s, want 200", w.Code, w.Body.String())
	}
	if got := marketSkillCalls(t, db, "admin-only-skill"); got != 1 {
		t.Fatalf("admin skill calls = %d, want 1", got)
	}

	// 组织共享技能:作者本人(读侧可见)上报自己的技能必须放行。
	if _, err := serverstore.CreateSharedSkill(db, &serverstore.SharedSkill{
		Name: "org-x", Version: "1.0.0", Author: "alice", Status: serverstore.SharedSkillApproved,
	}); err != nil {
		t.Fatal(err)
	}
	if w := post(r, token, skillCallPath, `{"name":"org-x","version":"1.0.0"}`); w.Code != http.StatusOK {
		t.Fatalf("author report = %d body=%s, want 200", w.Code, w.Body.String())
	}
	if ss, err := serverstore.GetSharedSkill(db, "org-x", "1.0.0"); err != nil {
		t.Fatal(err)
	} else if ss.Calls != 1 {
		t.Fatalf("author shared skill calls = %d, want 1", ss.Calls)
	}

	// 本地创作技能(平台上不存在):既有语义是静默成功且不计数。
	w := post(r, token, skillCallPath, `{"name":"local-only"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("unknown local skill report = %d body=%s, want 200(静默忽略)", w.Code, w.Body.String())
	}
}
