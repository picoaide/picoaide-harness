package marketplace

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// newTestRouter builds a migrated DB with user alice, a registered token,
// and a marketplace router; returns router, db, token, api.
func newTestRouter(t *testing.T) (*gin.Engine, *sql.DB, string, *API) {
	t.Helper()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	if err := serverstore.ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	uid, err := serverstore.CreateUserWithPassword(db, "alice", "secret123")
	if err != nil {
		t.Fatal(err)
	}
	// API-behavior tests use the admin view (permission filtering is covered
	// separately in perm_test.go)
	u, _ := serverstore.GetUserByUsername(db, "alice")
	u.IsAdmin = true
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	api := NewAPI(db, filepath.Join(t.TempDir(), "skills-cache"))
	r := gin.New()
	api.RegisterRoutes(r)
	t.Cleanup(func() { db.Close() })
	return r, db, token, api
}

func doReq(r *gin.Engine, method, path, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func decodeJSON(t *testing.T, w *httptest.ResponseRecorder, v any) {
	t.Helper()
	if err := json.Unmarshal(w.Body.Bytes(), v); err != nil {
		t.Fatalf("decode %s: %v", w.Body.String(), err)
	}
}

func hasErrCode(w *httptest.ResponseRecorder, code string) bool {
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		return false
	}
	return body.Error.Code == code
}

func TestSkillAPI(t *testing.T) {
	r, db, token, _ := newTestRouter(t)

	src := makeGitRepo(t, filepath.Join(t.TempDir(), "skill-src"))
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: "demo", Version: "1.0.0", Description: "demo skill",
		Author: "pico", GitURL: src, GitRef: "main", Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: "hidden", Version: "1.0.0", GitURL: src, Enabled: 0,
	}); err != nil {
		t.Fatal(err)
	}

	// list: enabled only
	w := doReq(r, "GET", "/api/client/v2/marketplace/skills", token)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d, body %s", w.Code, w.Body.String())
	}
	var list struct {
		Skills []map[string]any `json:"skills"`
	}
	decodeJSON(t, w, &list)
	if len(list.Skills) != 1 || list.Skills[0]["name"] != "demo" {
		t.Fatalf("list = %+v", list.Skills)
	}

	// detail
	w = doReq(r, "GET", "/api/client/v2/marketplace/skills/demo", token)
	if w.Code != http.StatusOK {
		t.Fatalf("detail status = %d, body %s", w.Code, w.Body.String())
	}
	var det struct {
		Skill map[string]any `json:"skill"`
	}
	decodeJSON(t, w, &det)
	if det.Skill["version"] != "1.0.0" || det.Skill["description"] != "demo skill" {
		t.Fatalf("detail = %+v", det.Skill)
	}

	// unknown skill -> 404
	w = doReq(r, "GET", "/api/client/v2/marketplace/skills/nope", token)
	if w.Code != http.StatusNotFound || !hasErrCode(w, "NOT_FOUND") {
		t.Fatalf("unknown skill = %d, body %s", w.Code, w.Body.String())
	}

	// archive: downloads a valid tar.gz with version header
	w = doReq(r, "GET", "/api/client/v2/marketplace/skills/demo/archive", token)
	if w.Code != http.StatusOK {
		t.Fatalf("archive status = %d, body %s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/gzip" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if v := w.Header().Get("X-Skill-Version"); v != "1.0.0" {
		t.Fatalf("X-Skill-Version = %q", v)
	}
	// checksum: sha256 of the served body, persisted to the skills row
	sum := sha256.Sum256(w.Body.Bytes())
	want := hex.EncodeToString(sum[:])
	if cs := w.Header().Get("X-Skill-Checksum"); cs != want {
		t.Fatalf("X-Skill-Checksum = %q, want %q", cs, want)
	}
	got, err := serverstore.GetSkill(db, "demo")
	if err != nil {
		t.Fatal(err)
	}
	if got.Checksum != want {
		t.Fatalf("persisted checksum = %q, want %q", got.Checksum, want)
	}
	names := tarNames(t, w.Body.Bytes())
	if !names["metadata.yaml"] || !names["SKILL.md"] {
		t.Fatalf("archive entries = %v", names)
	}
	// second request: cache hit, same checksum
	w = doReq(r, "GET", "/api/client/v2/marketplace/skills/demo/archive", token)
	if w.Code != http.StatusOK {
		t.Fatalf("archive cache status = %d", w.Code)
	}
	if cs := w.Header().Get("X-Skill-Checksum"); cs != want {
		t.Fatalf("cache checksum = %q, want %q", cs, want)
	}

	// no token -> 401 on every endpoint
	for _, p := range []string{"/api/client/v2/marketplace/skills", "/api/client/v2/marketplace/skills/demo", "/api/client/v2/marketplace/skills/demo/archive"} {
		if w := doReq(r, "GET", p, ""); w.Code != http.StatusUnauthorized {
			t.Fatalf("no-token %s = %d", p, w.Code)
		}
	}

	// C-10: a disabled skill is not downloadable — same 404 as a missing one
	w = doReq(r, "GET", "/api/client/v2/marketplace/skills/hidden/archive", token)
	if w.Code != http.StatusNotFound || !hasErrCode(w, "NOT_FOUND") {
		t.Fatalf("disabled skill archive = %d, body %s; want 404 NOT_FOUND", w.Code, w.Body.String())
	}
}

// C-6: updating a skill's version invalidates the cached repo, so the next
// download rebuilds from the new source instead of serving a stale archive
// (or failing the version check forever with 502).
func TestSkillCacheInvalidatedOnUpdate(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	if err := serverstore.ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := serverstore.CreateUserWithPassword(db, "boss", "pw123456"); err != nil {
		t.Fatal(err)
	}
	u, _ := serverstore.GetUserByUsername(db, "boss")
	u.IsAdmin = true
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}
	uid, err := serverstore.CreateUserWithPassword(db, "alice", "secret123")
	if err != nil {
		t.Fatal(err)
	}
	// admin view for API-behavior assertions (permission filtering is
	// covered in perm_test.go)
	au, _ := serverstore.GetUserByUsername(db, "alice")
	au.IsAdmin = true
	if err := serverstore.UpdateUser(db, au); err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	cacheDir := filepath.Join(t.TempDir(), "skills-cache")
	api := NewAPI(db, cacheDir)
	r := gin.New()
	api.RegisterRoutes(r)
	serverauth.RegisterAdminRoutes(r, db)
	RegisterAdminRoutes(r, db, cacheDir)

	src := makeGitRepo(t, filepath.Join(t.TempDir(), "skill-src"))
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: "demo", Version: "1.0.0", GitURL: src, GitRef: "main", Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}
	// grant alice so the admin-view archive download is unambiguous
	if err := serverstore.GrantSkill(db, "demo", "alice", serverstore.GranteeUser); err != nil {
		t.Fatal(err)
	}
	w := doReq(r, "GET", "/api/client/v2/marketplace/skills/demo/archive", token)
	if w.Code != http.StatusOK {
		t.Fatalf("v1 download: %d %s", w.Code, w.Body.String())
	}
	if v := w.Header().Get("X-Skill-Version"); v != "1.0.0" {
		t.Fatalf("v1 version header = %q", v)
	}

	// source moves to v2, then the admin bumps the DB row (the cache
	// invalidation lives in the admin update path)
	rewriteRepoVersion(t, src, "2.0.0")
	w, _ = mreq(t, r, "PUT", "/api/server/admin/skills/demo", `{"version":"2.0.0"}`, adminHdr(t, r))
	if w.Code != http.StatusOK {
		t.Fatalf("admin update: %d %s", w.Code, w.Body.String())
	}

	// the download must serve the NEW package, not the stale cached clone
	w = doReq(r, "GET", "/api/client/v2/marketplace/skills/demo/archive", token)
	if w.Code != http.StatusOK {
		t.Fatalf("v2 download = %d, body %s; want 200 (stale cache must be invalidated)", w.Code, w.Body.String())
	}
	if v := w.Header().Get("X-Skill-Version"); v != "2.0.0" {
		t.Fatalf("stale cache served %q, want 2.0.0", v)
	}
	if names := tarNames(t, w.Body.Bytes()); !names["metadata.yaml"] {
		t.Fatal("v2 archive missing metadata.yaml")
	}
}

// adminHdr logs into the admin API and returns session+CSRF headers.
func adminHdr(t *testing.T, r http.Handler) map[string]string {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/server/admin/login", strings.NewReader(`{"username":"boss","password":"pw123456"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	csrf, _ := out["csrf_token"].(string)
	sess := ""
	for _, ck := range w.Result().Cookies() {
		if ck.Name == "picoaide_session" {
			sess = ck.Value
		}
	}
	return map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}
}

// rewriteRepoVersion bumps metadata.yaml's version in a committed git repo.
func rewriteRepoVersion(t *testing.T, dir, version string) {
	t.Helper()
	metaPath := filepath.Join(dir, "metadata.yaml")
	data, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatal(err)
	}
	out := regexp.MustCompile(`version: .*`).ReplaceAllString(string(data), "version: "+version)
	if err := os.WriteFile(metaPath, []byte(out), 0644); err != nil {
		t.Fatal(err)
	}
	repo, err := git.PlainOpen(dir)
	if err != nil {
		t.Fatal(err)
	}
	w, err := repo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Add("metadata.yaml"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Commit("bump to "+version, &git.CommitOptions{
		Author: &object.Signature{Name: "t", Email: "t@t", When: time.Now()},
	}); err != nil {
		t.Fatal(err)
	}
	// the clone pulls branch "main": point it at the new commit
	h, err := repo.Head()
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.Storer.SetReference(plumbing.NewHashReference(plumbing.NewBranchReferenceName("main"), h.Hash())); err != nil {
		t.Fatal(err)
	}
}

func tarNames(t *testing.T, data []byte) map[string]bool {
	t.Helper()
	gr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gr)
	names := map[string]bool{}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		names[hdr.Name] = true
	}
	return names
}

// ---- Skill 版本检测 /api/marketplace/skills/updates ----

func TestSkillUpdates(t *testing.T) {
	r, db, token, _ := newTestRouter(t) // alice = admin

	src := makeGitRepo(t, filepath.Join(t.TempDir(), "skill-src"))
	for _, sk := range []serverstore.Skill{
		{Name: "upd", Version: "1.2.0", Description: "会更新", Author: "pico", GitURL: src, GitRef: "main", Enabled: 1},
		{Name: "same", Version: "1.0.0", Description: "版本一致", GitURL: src, GitRef: "main", Enabled: 1},
		{Name: "gone", Version: "3.0.0", Description: "下架", GitURL: src, GitRef: "main", Enabled: 0},
	} {
		if _, err := serverstore.AddSkill(db, &sk); err != nil {
			t.Fatal(err)
		}
	}

	// 有更新 + 无更新 + 下架不出现
	w := doReq(r, "GET", "/api/client/v2/marketplace/skills/updates?installed=upd:1.0.0,same:1.0.0,gone:0.1.0", token)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var out struct {
		Updates []struct {
			Name        string `json:"name"`
			Version     string `json:"version"`
			Description string `json:"description"`
			Author      string `json:"author"`
			ArchiveURL  string `json:"archive_url"`
		} `json:"updates"`
		Count int `json:"count"`
	}
	decodeJSON(t, w, &out)
	if out.Count != 1 || len(out.Updates) != 1 {
		t.Fatalf("updates = %+v, want 1 (only upd)", out)
	}
	u := out.Updates[0]
	if u.Name != "upd" || u.Version != "1.2.0" || u.Description != "会更新" || u.Author != "pico" {
		t.Fatalf("update item = %+v", u)
	}
	if u.ArchiveURL != "/api/client/v2/marketplace/skills/upd/archive" {
		t.Fatalf("archive_url = %q", u.ArchiveURL)
	}

	// 无更新 → 空
	w = doReq(r, "GET", "/api/client/v2/marketplace/skills/updates?installed=upd:1.2.0,same:1.0.0", token)
	decodeJSON(t, w, &out)
	if out.Count != 0 || len(out.Updates) != 0 {
		t.Fatalf("no-update = %+v, want empty", out)
	}

	// 未带 installed → 等价空(不返回任何技能)
	w = doReq(r, "GET", "/api/client/v2/marketplace/skills/updates", token)
	decodeJSON(t, w, &out)
	if out.Count != 0 {
		t.Fatalf("no installed = %+v, want empty", out)
	}

	// 非法 installed → 400
	w = doReq(r, "GET", "/api/client/v2/marketplace/skills/updates?installed=badformat", token)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad format status = %d, want 400", w.Code)
	}
	w = doReq(r, "GET", "/api/client/v2/marketplace/skills/updates?installed="+strings.Repeat("a:1,", 101), token)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("too many status = %d, want 400", w.Code)
	}

	// 未登录 → 401
	w = doReq(r, "GET", "/api/client/v2/marketplace/skills/updates?installed=upd:1.0.0", "")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("no token status = %d, want 401", w.Code)
	}
}

// 普通用户:未授权技能不进入 updates(不泄露存在性)
func TestSkillUpdatesPermissionFilter(t *testing.T) {
	r0, db, token, _, _ := marketUserSetup(t) // alice 普通用户(无授权)
	r := r0.(*gin.Engine)
	src := makeGitRepo(t, filepath.Join(t.TempDir(), "skill-src"))
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{Name: "secret", Version: "2.0.0", GitURL: src, GitRef: "main", Enabled: 1}); err != nil {
		t.Fatal(err)
	}

	w := doReq(r, "GET", "/api/client/v2/marketplace/skills/updates?installed=secret:1.0.0", token)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var out struct {
		Updates []map[string]any `json:"updates"`
		Count   int              `json:"count"`
	}
	decodeJSON(t, w, &out)
	if out.Count != 0 || len(out.Updates) != 0 {
		t.Fatalf("unauthorized skill leaked: %+v", out)
	}

	// 授权后出现
	if err := serverstore.GrantSkill(db, "secret", "alice", serverstore.GranteeUser); err != nil {
		t.Fatal(err)
	}
	w = doReq(r, "GET", "/api/client/v2/marketplace/skills/updates?installed=secret:1.0.0", token)
	decodeJSON(t, w, &out)
	if out.Count != 1 || out.Updates[0]["name"] != "secret" {
		t.Fatalf("granted updates = %+v", out)
	}
}
