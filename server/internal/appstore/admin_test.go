package appstore

import (
	"errors"
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

// TestTransferOwnerOfficial 0059: 归属官方 / 转回用户的完整语义。
func TestTransferOwnerOfficial(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	if _, err := serverstore.CreateUserWithPassword(db, "alice", "alice123456"); err != nil {
		t.Fatal(err)
	}
	if _, err := Publish(db, req("review-bot", "1.0.0", "x1", "alice")); err != nil {
		t.Fatal(err)
	}
	// 智能体副本: kind=agent + market 渠道(市场内容才有官方语义; 组织库
	// 行与市场通道互斥, 若用 channel=org 会在官方检查前命中 NAME_TAKEN)。
	agentReq := req("review-agent", "1.0.0", "xa", "alice")
	agentReq.Kind = serverstore.AppKindAgent
	agentReq.Channel = serverstore.AppChannelMarket
	agentReq.Manifest.Title = "review-agent 智能体"
	agentReq.Manifest.Author = "alice"
	if _, err := Publish(db, agentReq); err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := NewHandlers(db)
	r.PUT("/apps/:kind/:app_id/owner", func(c *gin.Context) {
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
	// 1) 归属官方(skill 与 agent 各一)
	for _, kind := range []string{"skill", "agent"} {
		name := "review-bot"
		if kind == "agent" {
			name = "review-agent"
		}
		if w := do("/apps/"+kind+"/"+name+"/owner", `{"official":true}`); w.Code != http.StatusOK {
			t.Fatalf("to official %s: %d %s", kind, w.Code, w.Body.String())
		}
		app, err := serverstore.GetApp(db, kindIf(serverstore.AppKindSkill, serverstore.AppKindAgent, kind), name)
		if err != nil {
			t.Fatal(err)
		}
		if app.Official != 1 || app.Owner != "" {
			t.Fatalf("after official %s: %+v", kind, app)
		}
	}
	// 2) 员工(非管理员)发布官方内容 → OFFICIAL_LOCKED
	_, perr := Publish(db, PublishRequest{
		Kind: serverstore.AppKindAgent, AppID: "review-agent", Channel: serverstore.AppChannelMarket,
		Publisher: "carol", Manifest: Manifest{Version: "2.0.0", Title: "x",
			Description: "一个用于测试的演示智能体", Author: "carol", Category: "demo", Changelog: "v2"},
	})
	if perr == nil {
		t.Fatal("employee publish official should be locked")
	}
	var ae *Error
	if !errors.As(perr, &ae) || ae.Code != CodeOfficialLocked {
		t.Fatalf("employee publish official: want OFFICIAL_LOCKED, got %v", perr)
	}
	// 3) 管理员发布官方内容通过
	if _, perr := Publish(db, PublishRequest{
		Kind: serverstore.AppKindAgent, AppID: "review-agent", Channel: serverstore.AppChannelMarket,
		Publisher: "admin", AdminPublish: true, Manifest: Manifest{Version: "2.0.0", Title: "x",
			Description: "一个用于测试的演示智能体", Author: "admin", Category: "demo", Changelog: "v2"},
	}); perr != nil {
		t.Fatalf("admin publish official failed: %v", perr)
	}
	// 4) 转回用户
	if w := do("/apps/agent/review-agent/owner", `{"owner":"alice"}`); w.Code != http.StatusOK {
		t.Fatal("transfer back failed")
	}
	app, _ := serverstore.GetApp(db, serverstore.AppKindAgent, "review-agent")
	if app.Official != 0 || app.Owner != "alice" {
		t.Fatalf("after transfer back: %+v", app)
	}
	// 5) 互斥与空体
	if w := do("/apps/agent/review-agent/owner", `{"owner":"alice","official":true}`); w.Code != http.StatusBadRequest {
		t.Fatalf("mutex not enforced: %d", w.Code)
	}
	if w := do("/apps/agent/review-agent/owner", `{}`); w.Code != http.StatusBadRequest {
		t.Fatalf("empty body not rejected: %d", w.Code)
	}
}

func kindIf(skill, agent, kind string) string {
	if kind == "agent" {
		return agent
	}
	return skill
}
