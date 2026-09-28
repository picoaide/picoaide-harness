package marketplace

// A2-01（审计 2026-09-26，P2）的**路由级**判据（市场技能面）：组的依赖查询失败
// ⇒ **500**，不是 401（与组织面、能力中心聚合面同款；三处共用
// `serverauth.ViewerGroups` / `WriteViewerError` 的实现）。
//
// 变异（必须变红）：把 `(*API).viewer` 改回"出错即 ok=false + 401"。

import (
	"net/http"
	"testing"
)

func TestViewerGroupFailureReturns500Not401OnMarketplace(t *testing.T) {
	r, db, token, _ := newTestRouter(t)
	if _, err := db.Exec(`ALTER TABLE user_groups RENAME TO user_groups_a2probe`); err != nil {
		t.Fatalf("注入依赖故障: %v", err)
	}

	w := doReq(r, "GET", "/api/client/v2/marketplace/skills", token)
	t.Logf("组查询失败 ⇒ status=%d body=%s", w.Code, w.Body.String())
	if w.Code == http.StatusUnauthorized {
		t.Fatalf("组查询依赖故障被回成 401（%s）—— 客户端读作 auth_expired ⇒ 清会话 + 删磁盘令牌", w.Body.String())
	}
	if w.Code != http.StatusInternalServerError || !hasErrCode(w, "INTERNAL") {
		t.Fatalf("组查询失败 ⇒ %d %s, want 500 INTERNAL", w.Code, w.Body.String())
	}
}
