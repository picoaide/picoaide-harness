package appstore

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func TestTransferOwnerHandler(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	if _, err := serverstore.CreateUserWithPassword(db, "alice", "alice123456"); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateUserWithPassword(db, "bob", "bob123456"); err != nil {
		t.Fatal(err)
	}
	if _, err := Publish(db, req("cap-transfer", "1.0.0", "x1", "alice")); err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := NewHandlers(db)
	r.PUT("/apps/:kind/:app_id/owner", func(c *gin.Context) {
		// 模拟 AdminAuth:管理会话写入 admin_user 上下文(生产路径经 AdminAuth)。
		c.Set("admin_user", &serverstore.User{Username: "admin"})
		h.TransferOwner(c)
	})
	do := func(path, body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPut, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		return w
	}

	// 成功转移。
	w := do("/apps/skill/cap-transfer/owner", `{"owner":"bob"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("transfer = %d body=%s", w.Code, w.Body.String())
	}
	app, err := serverstore.GetApp(db, serverstore.AppKindSkill, "cap-transfer")
	if err != nil || app.Owner != "bob" {
		t.Fatalf("owner = %q err=%v, want bob", app.Owner, err)
	}
	// 审计留痕(动作 + 新旧值)。
	rows, _, err := serverstore.ListAuditLogsPagedFiltered(db, 0, 50, "app_owner_transfer", "")
	if err != nil || len(rows) != 1 {
		t.Fatalf("audit rows = %d err=%v", len(rows), err)
	}
	if !strings.Contains(rows[0].Detail, "skill:cap-transfer") || !strings.Contains(rows[0].Detail, "alice → bob") {
		t.Fatalf("audit detail = %q", rows[0].Detail)
	}

	// 幂等:同归属再次转移 = 成功且不新增审计。
	w = do("/apps/skill/cap-transfer/owner", `{"owner":"bob"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("idempotent transfer = %d", w.Code)
	}
	rows, _, _ = serverstore.ListAuditLogsPagedFiltered(db, 0, 50, "app_owner_transfer", "")
	if len(rows) != 1 {
		t.Fatalf("idempotent 不应新增审计: %d", len(rows))
	}

	// 参数校验。
	if w := do("/apps/skill/cap-transfer/owner", `{"owner":""}`); w.Code != http.StatusBadRequest {
		t.Fatalf("空 owner = %d", w.Code)
	}
	if w := do("/apps/skill/cap-transfer/owner", `{"owner":"ghost"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("目标不存在 = %d", w.Code)
	}
	if w := do("/apps/skill/ghost-app/owner", `{"owner":"bob"}`); w.Code != http.StatusNotFound {
		t.Fatalf("app 不存在 = %d", w.Code)
	}
	if w := do("/apps/widget/cap-transfer/owner", `{"owner":"bob"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("非法 kind = %d", w.Code)
	}
	if w := do("/apps/skill/Bad-Name/owner", `{"owner":"bob"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("非法 app_id = %d", w.Code)
	}
}

func TestTransferOwnerAuditDetailFormat(t *testing.T) {
	got := TransferOwnerAuditDetail("skill", "my-skill", "我的技能", "alice", "bob")
	want := "skill:my-skill 「我的技能」 归属 alice → bob"
	if got != want {
		t.Fatalf("detail = %q, want %q", got, want)
	}
}
