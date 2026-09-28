package capabilities

// A2-01（审计 2026-09-26，P2）的**路由级**判据（能力中心聚合面）：组的依赖查询
// 失败 ⇒ **500**，不是 401（与组织/市场两个技能面同款；三处共用
// `serverauth.ViewerGroups` / `WriteViewerError` 的实现）。
//
// 变异（必须变红）：把本包的 `viewer` 改回"出错即 ok=false + 401"。

import (
	"net/http"
	"strings"
	"testing"
)

func TestViewerGroupFailureReturns500Not401OnCapabilities(t *testing.T) {
	r, db, _, userTokens := setupRouter(t)
	if _, err := db.Exec(`ALTER TABLE user_groups RENAME TO user_groups_a2probe`); err != nil {
		t.Fatalf("注入依赖故障: %v", err)
	}

	w := doGet(t, r, "/api/client/v2/capabilities", map[string]string{
		"Authorization": "Bearer " + userTokens["alice"],
	})
	body := strings.TrimSpace(w.Body.String())
	t.Logf("组查询失败 ⇒ status=%d body=%s", w.Code, body)
	if w.Code == http.StatusUnauthorized {
		t.Fatalf("组查询依赖故障被回成 401（%s）—— 客户端读作 auth_expired ⇒ 清会话 + 删磁盘令牌", body)
	}
	if w.Code != http.StatusInternalServerError || !strings.Contains(body, `"code":"INTERNAL"`) {
		t.Fatalf("组查询失败 ⇒ %d %s, want 500 INTERNAL", w.Code, body)
	}
}
