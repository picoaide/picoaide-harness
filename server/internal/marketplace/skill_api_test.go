package marketplace

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

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

	// 0052:git 源已移除,内容一律来自 DB 中的归档;校验和与归档原子写入,
	// 夹具同样必须用真实 sha256(下载响应头据此让客户端校验完整性)。
	demoArchive := skillArchiveBytes(t, "demo")
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: "demo", Version: "1.0.0", Description: "demo skill",
		Author: "pico", Enabled: 1, Archive: demoArchive, Checksum: sha256Hex(demoArchive),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: "hidden", Version: "1.0.0", Enabled: 0, Archive: skillArchiveBytes(t, "hidden"),
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

	// archive: downloads a valid zip with version header (git 模式包为 zip)
	w = doReq(r, "GET", "/api/client/v2/marketplace/skills/demo/archive", token)
	if w.Code != http.StatusOK {
		t.Fatalf("archive status = %d, body %s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/zip" {
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
	// 0052:metadata.yaml 是旧 git 构建的产物;上传归档的清单在 SKILL.md
	// frontmatter 里,归档只需带 SKILL.md。
	names := tarNames(t, w.Body.Bytes())
	if !names["SKILL.md"] {
		t.Fatalf("archive entries = %v", names)
	}
	// second request: 同一份 DB 归档,校验和稳定
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
func TestSkillNewArchiveServedImmediately(t *testing.T) {
	// 0052:git clone 缓存已随 git 模式一并移除。此处验证新语义——管理员
	// 上传新版归档后,客户端下载立刻拿到新版本内容,不会残留旧包。
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	t.Setenv("PICOAI_LOGIN_MAX_ATTEMPTS", "1000")
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef0123456789abcdef")
	uid, err := serverstore.CreateUserWithPassword(db, "alice", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateUserWithPassword(db, "boss", "pw123456"); err != nil {
		t.Fatal(err)
	}
	boss, _ := serverstore.GetUserByUsername(db, "boss")
	boss.IsAdmin = true
	if err := serverstore.UpdateUser(db, boss); err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	cacheDir := t.TempDir()
	NewAPI(db, cacheDir).RegisterRoutes(r)
	serverauth.RegisterAdminRoutes(r, db)
	RegisterAdminRoutes(r, db, cacheDir)

	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: "demo", Version: "1.0.0", Enabled: 1,
		Archive: skillArchiveBytes(t, "demo"), Checksum: "seed",
	}); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantSkill(db, "demo", "alice", serverstore.GranteeUser); err != nil {
		t.Fatal(err)
	}
	w := doReq(r, "GET", "/api/client/v2/marketplace/skills/demo/archive", token)
	if w.Code != http.StatusOK || w.Header().Get("X-Skill-Version") != "1.0.0" {
		t.Fatalf("v1 download = %d version=%q", w.Code, w.Header().Get("X-Skill-Version"))
	}

	// 管理员上传 v2 归档(唯一的内容入口)。
	v2 := makeZip(t, map[string]string{"SKILL.md": skillMd("demo", "2.0.0")})
	body := `{"version":"2.0.0","archive":"` + base64.StdEncoding.EncodeToString(v2) + `"}`
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills/demo/archive", body, adminHdr(t, r)); w.Code != http.StatusOK {
		t.Fatalf("upload v2: %d %s", w.Code, w.Body.String())
	}

	w = doReq(r, "GET", "/api/client/v2/marketplace/skills/demo/archive", token)
	if w.Code != http.StatusOK {
		t.Fatalf("v2 download = %d %s", w.Code, w.Body.String())
	}
	if v := w.Header().Get("X-Skill-Version"); v != "2.0.0" {
		t.Fatalf("下载到的仍是旧版本 %q, want 2.0.0", v)
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
func tarNames(t *testing.T, data []byte) map[string]bool {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, zf := range zr.File {
		names[zf.Name] = true
	}
	return names
}
