package sharedskills

// A2-01（审计 2026-09-26，P2）的**路由级**判据（组织技能面）：组的依赖查询失败
// ⇒ **500**，不是 401。
//
// 为什么单独一条：三个技能面（组织 / 市场 / 能力中心聚合）各有一个 `viewer()`，
// 修前各自把 `UserEffectiveGroups` 的失败塌成 `401 AUTH_REQUIRED`。三处现在都委托
// 给唯一真源 `serverauth.ViewerGroups`，本用例钉住**这一面**没有退回去自己写一份
// （变异：把 `viewer` 改回"出错即 ok=false + 401" ⇒ 本用例红）。
//
// 为什么"不是 401"是硬要求：客户端把 401 读作 `auth_expired` ⇒ 清会话 + 删磁盘
// 令牌 ⇒ 一次 PG 抖动让全体在线员工被登出。

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestViewerGroupFailureReturns500Not401OnSharedSkills(t *testing.T) {
	r, db, _, userHdr, _ := setup(t)
	// 注入依赖故障：`user_groups` 是 `UserEffectiveGroups` 的第一条查询
	// （BearerAuth 本身仍会通过 —— 它只查 api_tokens/users，故障点正好落在 viewer）。
	if _, err := db.Exec(`ALTER TABLE user_groups RENAME TO user_groups_a2probe`); err != nil {
		t.Fatalf("注入依赖故障: %v", err)
	}

	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/client/v2/shared-skills", nil)
	for k, v := range userHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)

	body := strings.TrimSpace(w.Body.String())
	t.Logf("组查询失败 ⇒ status=%d body=%s", w.Code, body)
	if w.Code == http.StatusUnauthorized {
		t.Fatalf("组查询依赖故障被回成 401（%s）—— 客户端读作 auth_expired ⇒ 清会话 + 删磁盘令牌", body)
	}
	if w.Code != http.StatusInternalServerError || !strings.Contains(body, `"code":"INTERNAL"`) {
		t.Fatalf("组查询失败 ⇒ %d %s, want 500 INTERNAL", w.Code, body)
	}
}
