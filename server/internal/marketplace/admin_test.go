package marketplace

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

func marketAdminSetup(t *testing.T) (http.Handler, *sql.DB, map[string]string) {
	t.Helper()
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef0123456789abcdef")
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/mkt.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateUserWithPassword(db, "boss", "pw123456"); err != nil {
		t.Fatal(err)
	}
	u, _ := serverstore.GetUserByUsername(db, "boss")
	u.IsAdmin = true
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	serverauth.RegisterAdminRoutes(r, db)
	RegisterAdminRoutes(r, db, t.TempDir())

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/login", strings.NewReader(`{"username":"boss","password":"pw123456"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	csrf := out["csrf_token"].(string)
	sess := ""
	for _, ck := range w.Result().Cookies() {
		if ck.Name == "picoaide_session" {
			sess = ck.Value
		}
	}
	hdr := map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}
	return r, db, hdr
}

func mreq(t *testing.T, r http.Handler, method, path, body string, hdr map[string]string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func TestAdminSkillsMCPAndDownloads(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()

	w, _ := mreq(t, r, "POST", "/api/admin/skills",
		`{"name":"demo","git_url":"https://example.com/demo.git","version":"1.0.0"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create skill: %d %s", w.Code, w.Body.String())
	}
	if w, _ := mreq(t, r, "POST", "/api/admin/skills", `{"name":"../evil","git_url":"https://x"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("bad skill name accepted: %d", w.Code)
	}
	if w, _ := mreq(t, r, "DELETE", "/api/admin/skills/demo", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("disable skill: %d", w.Code)
	}
	s, err := serverstore.GetSkill(db, "demo")
	if err != nil || s.Enabled != 0 {
		t.Fatalf("skill not disabled: %+v %v", s, err)
	}

	w, out := mreq(t, r, "POST", "/api/admin/mcp",
		`{"name":"xhs","transport":"http","url":"http://127.0.0.1:3000/mcp","env":{"APP_SECRET":"topsecret"},"headers":{"Authorization":"Bearer tok"}}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create mcp: %d %s", w.Code, w.Body.String())
	}
	id := int64(out["mcp"].(map[string]any)["id"].(float64))
	m, _ := serverstore.GetMCPServer(db, id)
	if m.Env["APP_SECRET"] == "topsecret" || !strings.HasPrefix(m.Env["APP_SECRET"], "enc:v1:") {
		t.Fatalf("mcp env not encrypted: %+v", m.Env)
	}
	if w, _ := mreq(t, r, "DELETE", fmt.Sprintf("/api/admin/mcp/%d", id), "", hdr); w.Code != http.StatusOK {
		t.Fatalf("disable mcp: %d", w.Code)
	}
	m, _ = serverstore.GetMCPServer(db, id)
	if m.Enabled != 0 {
		t.Fatal("mcp not disabled")
	}

	aliceID, _ := serverstore.CreateUser(db, &serverstore.User{Username: "alice", Source: "local"})
	if err := serverstore.RecordDownload(db, aliceID, id); err != nil {
		t.Fatal(err)
	}
	w, out = mreq(t, r, "GET", "/api/admin/mcp-downloads", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("downloads: %d", w.Code)
	}
	rows := out["downloads"].([]any)
	if len(rows) != 1 {
		t.Fatalf("downloads rows = %d", len(rows))
	}
	d := rows[0].(map[string]any)
	if d["username"] != "alice" {
		t.Fatalf("download username = %v", d["username"])
	}
}

func TestNonAdminForbidden(t *testing.T) {
	r, db, _ := marketAdminSetup(t)
	defer db.Close()
	if _, err := serverstore.CreateUserWithPassword(db, "eve", "evepw"); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/login", strings.NewReader(`{"username":"eve","password":"evepw"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("non-admin login status = %d", w.Code)
	}
}
