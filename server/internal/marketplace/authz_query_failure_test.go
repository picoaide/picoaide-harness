package marketplace

// 第二十二轮复审 V2-B3（P2）的**路由级**判据：市场技能面的**第二道授权查询**
// （`AccessibleSkillNames`）的依赖故障必须与"确实未授权"分开。
//
// ## 缺陷形态（判据要杀的东西）
//
// 修前 `getSkill` 与 `downloadArchive` 各有一份同形分支：
//
//	if err != nil || !containsName(names, s.Name) { 404 "技能不存在" }
//
// ⇒ 一次 PG 抖动（授权表不可读）在员工侧表现为「技能没了」：客户端把 404 读作
// **终态**（不重试），而**同一台服务端**在同一次故障下组织面回 **500**
// （`sharedskills.download` 的同类查询）—— 同一个故障两种口径；且该分支此前
// **零日志**，排障时完全不可见。
//
// A2-01（本轮修复）已经把 `viewer()` 那一层（组查询）从 401 改成 500，但**紧跟其后的
// 这一道授权查询没跟上** —— 典型的"同族只收口一半"。
//
// ## 判据（三态都要钉住，缺一条就能靠"一律 500"或"一律 404"变绿）
//
//	已授权 + 依赖正常          ⇒ 200（自校准：夹具真的授权成功了）
//	依赖故障（授权表不可读）    ⇒ 500 INTERNAL（**不是** 404），且**有日志**
//	真未授权（依赖正常）        ⇒ 404（不泄露存在性，语义不得放宽）
//
// 两条路由（`getSkill` 与 `downloadArchive`）都必须满足。
//
// ## 变异（必须变红）
//
//   - 把两处改回 `if err != nil || !containsName(...)` ⇒ 500 那几条红；
//   - 只改一条路由（另一条漏改）⇒ 该路由的 500 那条红（同族两处必须一起）；
//   - 去掉 `log.Printf` ⇒ 日志那条红；
//   - 把依赖故障也回 404 ⇒ 500 那几条红；
//   - 把"未授权"也回 500 ⇒ 负控那条红。

import (
	"bytes"
	"log"
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

func TestAuthzQueryFailureReturns500Not404OnMarketplace(t *testing.T) {
	r, db, _, _ := newTestRouter(t)

	const name = "authz-query-skill"
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: name, Version: "1.0.0", Description: "authz query probe",
		Author: "alice", Enabled: 1, Checksum: "", Archive: skillArchiveBytes(t, name),
	}); err != nil {
		t.Fatalf("播种市场技能: %v", err)
	}

	// bob：非 admin 员工，被显式授权 ⇒ 基线 200（自校准：不然"依赖故障 ⇒ 500"
	// 与"本来就 404"分不开）。
	bobID, err := serverstore.CreateUserWithPassword(db, "bob", "secret123")
	if err != nil {
		t.Fatal(err)
	}
	bobTok, err := serverauth.IssueToken(db, bobID)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantSkill(db, name, "bob", serverstore.GranteeUser); err != nil {
		t.Fatalf("授权 bob: %v", err)
	}
	// carol：非 admin、**未**授权 ⇒ 负控（依赖正常时的 404）。
	carolID, err := serverstore.CreateUserWithPassword(db, "carol", "secret123")
	if err != nil {
		t.Fatal(err)
	}
	carolTok, err := serverauth.IssueToken(db, carolID)
	if err != nil {
		t.Fatal(err)
	}

	paths := map[string]string{
		"getSkill":        "/api/client/v2/marketplace/skills/" + name,
		"downloadArchive": "/api/client/v2/marketplace/skills/" + name + "/archive",
	}

	// —— ① 自校准 + 负控（依赖正常）。
	for label, p := range paths {
		if w := doReq(r, "GET", p, bobTok); w.Code != http.StatusOK {
			t.Fatalf("%s 基线 = %d %s, want 200（夹具没授权成功，后面的断言失去意义）", label, w.Code, w.Body.String())
		}
		if w := doReq(r, "GET", p, carolTok); w.Code != http.StatusNotFound || !hasErrCode(w, "NOT_FOUND") {
			t.Fatalf("%s 真未授权 ⇒ %d %s, want 404 NOT_FOUND（不泄露存在性，语义不得放宽）",
				label, w.Code, w.Body.String())
		}
	}

	// —— ② 依赖故障：授权表不可读。
	if _, err := db.Exec(`ALTER TABLE app_grants RENAME TO app_grants_a2b3probe`); err != nil {
		t.Fatalf("注入依赖故障: %v", err)
	}

	var logged bytes.Buffer
	prevOut := log.Writer()
	prevFlags := log.Flags()
	log.SetOutput(&logged)
	defer func() { log.SetOutput(prevOut); log.SetFlags(prevFlags) }()

	for label, p := range paths {
		w := doReq(r, "GET", p, bobTok)
		t.Logf("%s 授权表不可读 ⇒ status=%d body=%s", label, w.Code, strings.TrimSpace(w.Body.String()))
		if w.Code == http.StatusNotFound {
			t.Fatalf("%s：授权查询的依赖故障被回成 404「技能不存在」（%s）—— "+
				"客户端读作终态（不重试），而组织面在同一次故障下回 500 ⇒ 同一故障两种口径",
				label, strings.TrimSpace(w.Body.String()))
		}
		if w.Code != http.StatusInternalServerError || !hasErrCode(w, "INTERNAL") {
			t.Fatalf("%s：依赖故障 ⇒ %d %s, want 500 INTERNAL", label, w.Code, w.Body.String())
		}
	}

	if !strings.Contains(logged.String(), "accessible skill names lookup failed") {
		t.Fatalf("授权查询依赖故障**零日志**（该分支修前完全静默，排障时不可见）；实际日志=%q", logged.String())
	}
}
