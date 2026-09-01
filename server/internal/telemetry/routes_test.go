package telemetry

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

func newTestEnv(t *testing.T) (*gin.Engine, *sql.DB, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	r := gin.New()
	RegisterRoutes(r, db)
	uid, err := serverstore.CreateUserWithPassword(db, "alice", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	return r, db, token
}

func post(r *gin.Engine, token, path, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	r.ServeHTTP(w, req)
	return w
}

func TestReportSkillCall(t *testing.T) {
	r, db, token := newTestEnv(t)
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{Name: "codeql", Version: "1.0.0", Enabled: 1}); err != nil {
		t.Fatal(err)
	}
	// 市场技能:name-only 上报命中。
	w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"codeql"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("market call = %d %s", w.Code, w.Body.String())
	}
	s, _ := serverstore.GetSkill(db, "codeql")
	if s.Calls != 1 {
		t.Fatalf("market calls = %d, want 1", s.Calls)
	}
	// 共享技能:name+version 优先命中 shared 表。
	if _, err := serverstore.CreateSharedSkill(db, &serverstore.SharedSkill{Name: "org-x", Version: "1.0.0", Author: "alice", Status: serverstore.SharedSkillApproved}); err != nil {
		t.Fatal(err)
	}
	w = post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"org-x","version":"1.0.0"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("shared call = %d %s", w.Code, w.Body.String())
	}
	ss, _ := serverstore.GetSharedSkill(db, "org-x", "1.0.0")
	if ss.Calls != 1 {
		t.Fatalf("shared calls = %d, want 1", ss.Calls)
	}
	// 未知技能单点静默成功(本地创作技能)。
	w = post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"local-only"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("unknown call = %d %s", w.Code, w.Body.String())
	}
	// 未认证 401。
	w = post(r, "badtoken", "/api/client/v2/telemetry/skill-call", `{"name":"x"}`)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unauth = %d", w.Code)
	}
	// 非法名 400。
	w = post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"a/b"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad name = %d %s", w.Code, w.Body.String())
	}
	// 空名 400。
	w = post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":""}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("empty name = %d", w.Code)
	}
}

func TestReportSkillCallInvalidJSON(t *testing.T) {
	r, _, token := newTestEnv(t)
	w := post(r, token, "/api/client/v2/telemetry/skill-call", `{broken`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("broken json = %d %s", w.Code, w.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if out["ok"] == true {
		t.Fatalf("broken json must not return ok")
	}
}
