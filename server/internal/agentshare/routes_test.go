package agentshare

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
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

// makeArchive builds a gzipped tar with the given entries (path -> content).
// A "SYMLINK" content marks a symlink entry; "LINK" a hardlink entry.
func makeArchive(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	for name, content := range entries {
		switch content {
		case "SYMLINK":
			if err := tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"}); err != nil {
				t.Fatal(err)
			}
		case "LINK":
			if err := tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeLink, Linkname: "x"}); err != nil {
				t.Fatal(err)
			}
		default:
			if err := tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Size: int64(len(content))}); err != nil {
				t.Fatal(err)
			}
			if _, err := tw.Write([]byte(content)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

const testComposition = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: hi
`

// setup builds the full test router with an admin account and one employee.
func setup(t *testing.T) (http.Handler, *sql.DB, map[string]string, map[string]string, map[string]string) {
	t.Helper()
	t.Setenv("PICOAI_LOGIN_MAX_ATTEMPTS", "1000")
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef0123456789abcdef")
	db, err := serverstore.EnsureMigrated(serverstore.DBConfig{Path: fmt.Sprintf("%s/agentshare.db", t.TempDir())})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	// alice + bob: two employees with direct bearer tokens.
	tokens := map[string]string{}
	for _, name := range []string{"alice", "bob"} {
		uid, err := serverstore.CreateUserWithPassword(db, name, "pw123456")
		if err != nil {
			t.Fatal(err)
		}
		token, err := serverauth.IssueToken(db, uid)
		if err != nil {
			t.Fatal(err)
		}
		tokens[name] = token
	}
	if _, err := serverstore.CreateUserWithPassword(db, "boss", "pw123456"); err != nil {
		t.Fatal(err)
	}
	us, _ := serverstore.GetUserByUsername(db, "boss")
	us.IsAdmin = true
	if err := serverstore.UpdateUser(db, us); err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	serverauth.RegisterAdminRoutes(r, db)
	RegisterRoutes(r, db, t.TempDir()+"/cache")
	RegisterAdminRoutes(r, db, t.TempDir()+"/cache")

	// Admin login (session + CSRF).
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/login", strings.NewReader(`{"username":"boss","password":"pw123456"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	csrf, _ := out["csrf_token"].(string)
	sess := ""
	for _, ck := range w.Result().Cookies() {
		if ck.Name == "picoaide_session" {
			sess = ck.Value
		}
	}
	adminHdr := map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}

	return r, db, adminHdr,
		map[string]string{"Authorization": "Bearer " + tokens["alice"]},
		map[string]string{"Authorization": "Bearer " + tokens["bob"]}
}

func uploadBody(name, desc string, archive []byte) string {
	body, _ := json.Marshal(map[string]string{
		"name": name, "description": desc, "archive": base64.StdEncoding.EncodeToString(archive),
	})
	return string(body)
}

func TestUploadAndApproveFlow(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()

	// alice uploads; row is pending.
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/agent-presets", strings.NewReader(uploadBody("ppt-gen", "生成PPT", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "preset.yml": "name: PPT 生成\n"}))))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range userHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("upload = %d %s", w.Code, w.Body.String())
	}

	p, err := serverstore.GetAgentPreset(db, "ppt-gen")
	if err != nil || p.Status != serverstore.AgentPresetPending || p.Author != "alice" || p.Checksum == "" {
		t.Fatalf("row = %+v err=%v", p, err)
	}

	// Employee download while pending → 404 (not approved).
	reqA := httptest.NewRequest("GET", "/api/agent-presets/ppt-gen/archive", nil)
	for k, v := range userHdr {
		reqA.Header.Set(k, v)
	}
	wA := httptest.NewRecorder()
	r.ServeHTTP(wA, reqA)
	if wA.Code != http.StatusNotFound {
		t.Fatalf("pending download = %d", wA.Code)
	}

	// Admin list sees the pending row; approve it.
	wL := httptest.NewRecorder()
	reqL := httptest.NewRequest("GET", "/api/admin/agent-presets?status=pending", nil)
	for k, v := range adminHdr {
		reqL.Header.Set(k, v)
	}
	r.ServeHTTP(wL, reqL)
	if wL.Code != 200 || !strings.Contains(wL.Body.String(), "ppt-gen") {
		t.Fatalf("admin list = %d %s", wL.Code, wL.Body.String())
	}

	wApp := httptest.NewRecorder()
	reqApp := httptest.NewRequest("POST", "/api/admin/agent-presets/ppt-gen/approve", nil)
	for k, v := range adminHdr {
		reqApp.Header.Set(k, v)
	}
	r.ServeHTTP(wApp, reqApp)
	if wApp.Code != 200 {
		t.Fatalf("approve = %d %s", wApp.Code, wApp.Body.String())
	}

	// Employee download now succeeds with integrity headers.
	reqA2 := httptest.NewRequest("GET", "/api/agent-presets/ppt-gen/archive", nil)
	for k, v := range userHdr {
		reqA2.Header.Set(k, v)
	}
	wA2 := httptest.NewRecorder()
	r.ServeHTTP(wA2, reqA2)
	if wA2.Code != 200 {
		t.Fatalf("approved download = %d", wA2.Code)
	}
	if wA2.Header().Get("X-Preset-Checksum") != p.Checksum {
		t.Fatalf("checksum header = %q", wA2.Header().Get("X-Preset-Checksum"))
	}

	// Audit rows exist (upload + approve).
	n, _ := serverstore.ListAuditLogs(db, 10)
	if len(n) < 2 {
		t.Fatalf("audit = %d rows, want >= 2", len(n))
	}
}

func TestUploadValidation(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()

	post := func(body string) int {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/agent-presets", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		for k, v := range userHdr {
			req.Header.Set(k, v)
		}
		r.ServeHTTP(w, req)
		return w.Code
	}

	cases := []struct {
		name string
		body string
		want int
	}{
		{"bad id uppercase", uploadBody("My-Preset", "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition})), 400},
		{"bad id traversal", uploadBody("../x", "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition})), 400},
		{"no archive", `{"name":"abc","description":"x","archive":""}`, 400},
		{"bad base64", `{"name":"abc","archive":"@@@"}`, 400},
		{"empty archive", uploadBody("abc", "", []byte{}), 400},
		{"no composition", uploadBody("abc", "", makeArchive(t, map[string]string{"README.md": "hi"})), 422},
		{"symlink", uploadBody("abc", "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "evil": "SYMLINK"})), 422},
		{"traversal entry", uploadBody("abc", "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "../evil": "x"})), 422},
	}
	for _, c := range cases {
		if got := post(c.body); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}

	// Oversized archive (> MaxArchiveBytes): incompressible random bytes so
	// the gzip stream cannot shrink below the limit.
	big := makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "big.bin": string(randomBytes(17 << 20))})
	if got := post(uploadBody("big", "", big)); got != 422 {
		t.Errorf("oversized: got %d, want 422", got)
	}

	// Duplicate name: upload once, then again → 409 (pending).
	if got := post(uploadBody("dup", "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition}))); got != 201 {
		t.Fatalf("first dup upload = %d", got)
	}
	if got := post(uploadBody("dup", "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition}))); got != 409 {
		t.Fatalf("second dup upload = %d, want 409", got)
	}

	// Reject then resubmit is allowed; row resets to pending.
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/agent-presets/dup/reject", nil)
	for k, v := range adminHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("reject = %d", w.Code)
	}
	if got := post(uploadBody("dup", "新描述", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition}))); got != 201 {
		t.Fatalf("resubmit after reject = %d, want 201", got)
	}
	p, _ := serverstore.GetAgentPreset(db, "dup")
	if p.Status != serverstore.AgentPresetPending || p.Description != "新描述" {
		t.Fatalf("resubmitted row = %+v", p)
	}
}

func TestPendingCap(t *testing.T) {
	r, db, _, userHdr, _ := setup(t)
	defer db.Close()

	post := func(name string) int {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/agent-presets", strings.NewReader(uploadBody(name, "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition}))))
		req.Header.Set("Content-Type", "application/json")
		for k, v := range userHdr {
			req.Header.Set(k, v)
		}
		r.ServeHTTP(w, req)
		return w.Code
	}
	for i := 0; i < pendingCap; i++ {
		if got := post(fmt.Sprintf("cap-%d", i)); got != 201 {
			t.Fatalf("upload %d = %d", i, got)
		}
	}
	if got := post("cap-over"); got != 429 {
		t.Fatalf("over cap = %d, want 429", got)
	}
}

func TestVisibilityAndAdminDelete(t *testing.T) {
	r, db, adminHdr, userHdr, bobHdr := setup(t)
	defer db.Close()

	// alice uploads.
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/agent-presets", strings.NewReader(uploadBody("shared-1", "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition}))))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range userHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != 201 {
		t.Fatalf("alice upload = %d", w.Code)
	}

	list := func(hdr map[string]string) string {
		wL := httptest.NewRecorder()
		reqL := httptest.NewRequest("GET", "/api/agent-presets", nil)
		for k, v := range hdr {
			reqL.Header.Set(k, v)
		}
		r.ServeHTTP(wL, reqL)
		return wL.Body.String()
	}
	// bob's list does not include alice's pending row.
	if strings.Contains(list(bobHdr), "shared-1") {
		t.Fatal("bob sees alice pending row")
	}
	// alice's own list shows it.
	if !strings.Contains(list(userHdr), "shared-1") {
		t.Fatal("alice does not see own row")
	}

	// Admin rejects → bob still cannot see; alice still can (with status).
	wA := httptest.NewRecorder()
	reqA := httptest.NewRequest("POST", "/api/admin/agent-presets/shared-1/reject", nil)
	for k, v := range adminHdr {
		reqA.Header.Set(k, v)
	}
	r.ServeHTTP(wA, reqA)
	if !strings.Contains(list(userHdr), "rejected") {
		t.Fatal("alice does not see rejected status of own row")
	}
	if strings.Contains(list(bobHdr), "shared-1") {
		t.Fatal("bob sees rejected row")
	}

	// Admin deletes → row gone for everyone.
	wD := httptest.NewRecorder()
	reqD := httptest.NewRequest("DELETE", "/api/admin/agent-presets/shared-1", nil)
	for k, v := range adminHdr {
		reqD.Header.Set(k, v)
	}
	r.ServeHTTP(wD, reqD)
	if wD.Code != 200 {
		t.Fatalf("delete = %d", wD.Code)
	}
	if strings.Contains(list(userHdr), "shared-1") {
		t.Fatal("row visible after delete")
	}
}

// randomBytes returns n cryptographically random bytes (incompressible).
func randomBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}
