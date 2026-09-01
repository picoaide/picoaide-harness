package marketplace

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"database/sql"
	"encoding/base64"
	"encoding/json"
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
	// 登录限流器(10/5min/ip+user)是惰性单例:多个测试各自 login 同一账号
	// 会触发 429。测试环境按 ratelimit.go 约定放宽(首次 login 前设置生效,
	// 单例在整个测试二进制生命周期内保持该配置)。
	t.Setenv("PICOAI_LOGIN_MAX_ATTEMPTS", "1000")
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef0123456789abcdef")
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
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
	req := httptest.NewRequest("POST", "/api/server/admin/login", strings.NewReader(`{"username":"boss","password":"pw123456"}`))
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

func TestAdminSkillsCRUD(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()

	w, _ := mreq(t, r, "POST", "/api/server/admin/skills",
		`{"name":"demo","git_url":"https://example.com/demo.git","version":"1.0.0"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create skill: %d %s", w.Code, w.Body.String())
	}
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills", `{"name":"../evil","git_url":"https://x"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("bad skill name accepted: %d", w.Code)
	}
	if w, _ := mreq(t, r, "DELETE", "/api/server/admin/skills/demo", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("disable skill: %d", w.Code)
	}
	s, err := serverstore.GetSkill(db, "demo")
	if err != nil || s.Enabled != 0 {
		t.Fatalf("skill not disabled: %+v %v", s, err)
	}
	// 列表返回技能
	if w, out := mreq(t, r, "GET", "/api/server/admin/skills", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("list skills: %d", w.Code)
	} else if rows := out["skills"].([]any); len(rows) != 1 {
		t.Fatalf("skills rows = %d, want 1", len(rows))
	}
}

func TestNonAdminForbidden(t *testing.T) {
	r, db, _ := marketAdminSetup(t)
	defer db.Close()
	if _, err := serverstore.CreateUserWithPassword(db, "eve", "evepw"); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/server/admin/login", strings.NewReader(`{"username":"eve","password":"evepw"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("non-admin login status = %d", w.Code)
	}
}

func TestAdminSkillEnable(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	w, _ := mreq(t, r, "POST", "/api/server/admin/skills",
		`{"name":"demo","git_url":"https://example.com/demo.git","version":"1.0.0"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create skill: %d %s", w.Code, w.Body.String())
	}
	if w, _ := mreq(t, r, "DELETE", "/api/server/admin/skills/demo", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("disable skill: %d", w.Code)
	}
	s, _ := serverstore.GetSkill(db, "demo")
	if s.Enabled != 0 {
		t.Fatalf("skill not disabled: %d", s.Enabled)
	}
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills/demo/enable", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("enable skill: %d", w.Code)
	}
	s, _ = serverstore.GetSkill(db, "demo")
	if s.Enabled != 1 {
		t.Fatalf("skill not re-enabled: %d", s.Enabled)
	}
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills/nope/enable", "", hdr); w.Code != http.StatusNotFound {
		t.Fatalf("enable unknown skill = %d, want 404", w.Code)
	}
}

// 审计 A5-M8: 技能下架必须留审计痕迹。
func TestAdminSkillDisableAudit(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills",
		`{"name":"demo","git_url":"https://example.com/demo.git"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create skill: %d", w.Code)
	}
	if w, _ := mreq(t, r, "DELETE", "/api/server/admin/skills/demo", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("disable skill: %d", w.Code)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM audit_logs WHERE action = 'skill_disable' AND detail = 'demo'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("skill_disable audit rows = %d, want 1", n)
	}
}

// 审计 A5-M7: PUT grants 只接受 groups 字段 —— 误传 username 必须报错,
// 而不是被当作空组静默清空部门授权。
func TestAdminGrantsRejectUnknownFields(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills",
		`{"name":"demo","git_url":"https://example.com/demo.git"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create skill: %d", w.Code)
	}
	if _, err := serverstore.CreateDepartment(db, "研发部", 0, 0, ""); err != nil {
		t.Fatal(err)
	}
	// 先正常设置部门授权
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/skills/demo/grants", `{"groups":["研发部"]}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("set grants: %d", w.Code)
	}
	// 误传 username → 400,且不得清空既有授权
	w, out := mreq(t, r, "PUT", "/api/server/admin/skills/demo/grants", `{"username":"alice"}`, hdr)
	if w.Code != http.StatusBadRequest || !hasErrCode(w, "VALIDATION") {
		t.Fatalf("unknown field = %d %v, want 400 VALIDATION", w.Code, out)
	}
	grants, _ := serverstore.ListSkillGrants(db, "demo")
	if len(grants) != 1 || grants[0].Grantee != "研发部" {
		t.Fatalf("grants after rejected put = %+v, want 研发部 intact", grants)
	}
}

// 审计 A5-L10: 技能 Git 地址只允许 http/https 远程仓库(file:// 等拒绝)。
func TestAdminSkillGitURLValidation(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	for _, u := range []string{"file:///tmp/repo", "ftp://host/repo", "not-a-url", "https://"} {
		w, _ := mreq(t, r, "POST", "/api/server/admin/skills",
			`{"name":"demo","git_url":"`+u+`"}`, hdr)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("create with git_url %q = %d, want 400", u, w.Code)
		}
	}
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills",
		`{"name":"demo","git_url":"https://example.com/demo.git"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create with https = %d", w.Code)
	}
	// 更新时把 git_url 改为非法值同样拒绝
	w, _ := mreq(t, r, "PUT", "/api/server/admin/skills/demo", `{"git_url":"file:///tmp/x"}`, hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("update with file git_url = %d, want 400", w.Code)
	}
}

// makeZip builds a minimal zip with the given entries (helper for the
// upload-mode tests). zip 是新的上传格式。
func makeZip(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range entries {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// makeTarGz builds a gzipped tar (legacy upload format, still accepted).
func makeTarGz(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	for name, content := range entries {
		if err := tw.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeReg, Size: int64(len(content))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			t.Fatal(err)
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

// TestAdminSkillUploadArchive: POST /api/admin/skills/:name/archive switches
// the skill to upload mode — the archive is stored in the DB row, the git
// source is cleared, and the employee download serves the DB bytes + counts.
// skillMd builds a SKILL.md satisfying the strict publish contract
// (决策 2026-09-01 §5.1):管理端上架与员工上传共用同一套必填字段规则。
func skillMd(name, version string) string {
	return "---\n" +
		"name: " + name + "\n" +
		"title: " + name + " 技能\n" +
		"version: " + version + "\n" +
		"description: 用于集成测试的市场技能包,描述需要满足最短长度要求。\n" +
		"author: tester\n" +
		"category: 测试\n" +
		"---\n\n# " + name + "\n\n本技能是服务端集成测试使用的夹具包,正文需要足够长才能通过空壳校验,因此这里补充了一段用于说明用途的文字。\n"
}

func TestAdminSkillUploadArchive(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills",
		`{"name":"demo","git_url":"https://example.com/demo.git","version":"1.0.0"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create skill: %d", w.Code)
	}
	archive := makeZip(t, map[string]string{"SKILL.md": skillMd("demo", "2.0.0")})
	body := `{"version":"2.0.0","archive":"` + base64.StdEncoding.EncodeToString(archive) + `"}`
	if w, out := mreq(t, r, "POST", "/api/server/admin/skills/demo/archive", body, hdr); w.Code != http.StatusOK {
		t.Fatalf("upload archive: %d %s (%v)", w.Code, w.Body.String(), out)
	}
	s, err := serverstore.GetSkill(db, "demo")
	if err != nil {
		t.Fatal(err)
	}
	if s.Source != "upload" || s.Version != "2.0.0" || s.Checksum == "" {
		t.Fatalf("after upload = %+v", s)
	}
	if len(s.Archive) == 0 || s.GitURL != "" {
		t.Fatalf("archive must be stored in DB and git cleared, got %+v", s)
	}
	// 非法归档(缺 SKILL.md)→ 422。
	bad := makeZip(t, map[string]string{"readme.md": "x"})
	w, _ := mreq(t, r, "POST", "/api/server/admin/skills/demo/archive",
		`{"version":"3.0.0","archive":"`+base64.StdEncoding.EncodeToString(bad)+`"}`, hdr)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad archive = %d, want 422", w.Code)
	}
	s, _ = serverstore.GetSkill(db, "demo")
	if s.Version != "2.0.0" {
		t.Fatalf("bad upload must not mutate row, version=%s", s.Version)
	}
	// 员工下载:需授权 + 返回 DB 归档字节。
	uid, err := serverstore.CreateUserWithPassword(db, "alice", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantSkill(db, "demo", "alice", serverstore.GranteeUser); err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	api := NewAPI(db, t.TempDir())
	rr := gin.New()
	api.RegisterRoutes(rr)
	req := httptest.NewRequest("GET", "/api/client/v2/marketplace/skills/demo/archive", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	wr := httptest.NewRecorder()
	rr.ServeHTTP(wr, req)
	if wr.Code != http.StatusOK {
		t.Fatalf("employee download = %d %s", wr.Code, wr.Body.String())
	}
	if !bytes.Equal(wr.Body.Bytes(), archive) {
		t.Fatalf("downloaded archive differs from uploaded")
	}
	if ct := wr.Header().Get("Content-Type"); ct != "application/zip" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if v := wr.Header().Get("X-Skill-Version"); v != "2.0.0" {
		t.Fatalf("x-skill-version = %q", v)
	}
	s, _ = serverstore.GetSkill(db, "demo")
	if s.Downloads != 1 {
		t.Fatalf("downloads = %d, want 1", s.Downloads)
	}
}

// TestAdminSkillUploadArchiveTarGzCompat: 旧 tar.gz 归档仍可上传(向后兼容),
// 下载按格式回 application/gzip + .tar.gz 文件名。
func TestAdminSkillUploadArchiveTarGzCompat(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills",
		`{"name":"oldfmt","git_url":"https://example.com/demo.git","version":"1.0.0"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create skill: %d", w.Code)
	}
	archive := makeTarGz(t, map[string]string{"SKILL.md": skillMd("oldfmt", "2.0.0")})
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills/oldfmt/archive",
		`{"version":"2.0.0","archive":"`+base64.StdEncoding.EncodeToString(archive)+`"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("upload tar.gz archive: %d", w.Code)
	}
	uid, err := serverstore.CreateUserWithPassword(db, "bob", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantSkill(db, "oldfmt", "bob", serverstore.GranteeUser); err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	api := NewAPI(db, t.TempDir())
	rr := gin.New()
	api.RegisterRoutes(rr)
	req := httptest.NewRequest("GET", "/api/client/v2/marketplace/skills/oldfmt/archive", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	wr := httptest.NewRecorder()
	rr.ServeHTTP(wr, req)
	if wr.Code != http.StatusOK {
		t.Fatalf("employee download = %d %s", wr.Code, wr.Body.String())
	}
	if ct := wr.Header().Get("Content-Type"); ct != "application/gzip" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if disp := wr.Header().Get("Content-Disposition"); !strings.Contains(disp, "oldfmt-2.0.0.tar.gz") {
		t.Fatalf("Content-Disposition = %q", disp)
	}
}

// TestAdminSkillUploadVersionGuard: 上传模式技能走元数据 PUT 改版本必须
// 拒绝(版本由「上传新版」端点原子写入,与归档/校验和一致)。
func TestAdminSkillUploadVersionGuard(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills",
		`{"name":"demo","git_url":"https://example.com/demo.git","version":"1.0.0"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create skill: %d", w.Code)
	}
	archive := makeZip(t, map[string]string{"SKILL.md": skillMd("demo", "2.0.0")})
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills/demo/archive",
		`{"version":"2.0.0","archive":"`+base64.StdEncoding.EncodeToString(archive)+`"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("upload archive: %d", w.Code)
	}
	// 元数据 PUT 改版本 → 400。
	w, out := mreq(t, r, "PUT", "/api/server/admin/skills/demo", `{"version":"3.0.0"}`, hdr)
	if w.Code != http.StatusBadRequest || !hasErrCode(w, "VALIDATION") {
		t.Fatalf("version put = %d %v, want 400 VALIDATION", w.Code, out)
	}
	s, _ := serverstore.GetSkill(db, "demo")
	if s.Version != "2.0.0" {
		t.Fatalf("version must stay 2.0.0, got %s", s.Version)
	}
}

// TestAdminSkillUploadRejectsNonCompliantPackage: 严格发布契约在管理端同样
// 生效(决策 2026-09-01 §5)。这三类包在本次改造前都能上架成功,但装到客户端
// 后会被上游 skill-filesystem 静默忽略——「上传成功但技能不存在」。
func TestAdminSkillUploadRejectsNonCompliantPackage(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills",
		`{"name":"demo","git_url":"https://example.com/demo.git","version":"1.0.0"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create skill: %d", w.Code)
	}
	post := func(md, formVersion string) (int, string) {
		archive := makeZip(t, map[string]string{"SKILL.md": md})
		body := `{"version":"` + formVersion + `","archive":"` + base64.StdEncoding.EncodeToString(archive) + `"}`
		w, _ := mreq(t, r, "POST", "/api/server/admin/skills/demo/archive", body, hdr)
		return w.Code, w.Body.String()
	}

	// 中文 name:上游 kebab 文法拒绝加载。
	cn := strings.Replace(skillMd("demo", "2.0.0"), "name: demo", "name: 演示技能", 1)
	if code, body := post(cn, "2.0.0"); code != 422 || !strings.Contains(body, "INVALID_APP_ID") {
		t.Fatalf("中文 name = %d %s, want 422 INVALID_APP_ID", code, body)
	}
	// UTF-8 BOM:frontmatter 解析失败。
	if code, body := post("\ufeff"+skillMd("demo", "2.0.0"), "2.0.0"); code != 422 || !strings.Contains(body, "BOM_DETECTED") {
		t.Fatalf("BOM = %d %s, want 422 BOM_DETECTED", code, body)
	}
	// 缺 title(必填展示名)。
	noTitle := strings.Replace(skillMd("demo", "2.0.0"), "title: demo 技能\n", "", 1)
	if code, body := post(noTitle, "2.0.0"); code != 422 || !strings.Contains(body, "MISSING_FIELD") {
		t.Fatalf("缺 title = %d %s, want 422 MISSING_FIELD", code, body)
	}
	// 表单版本与包内版本不一致:管理端是显式意图,必须报错而非静默取其一。
	if code, body := post(skillMd("demo", "2.0.0"), "3.0.0"); code != 422 || !strings.Contains(body, "MANIFEST_MISMATCH") {
		t.Fatalf("版本不一致 = %d %s, want 422 MANIFEST_MISMATCH", code, body)
	}
	// 合规包 + 一致版本 → 通过。
	if code, body := post(skillMd("demo", "2.0.0"), "2.0.0"); code != http.StatusOK {
		t.Fatalf("合规包应通过, got %d %s", code, body)
	}
	s, err := serverstore.GetSkill(db, "demo")
	if err != nil || s.Version != "2.0.0" {
		t.Fatalf("skill = %+v err=%v", s, err)
	}
}

// TestAdminSkillPreview: 管理员审批前必须能看到「上传了什么」——列出归档
// 全部文件并逐个查看内容(此前只有组织共享库有此能力,市场技能没有)。
func TestAdminSkillPreview(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills",
		`{"name":"demo","git_url":"https://example.com/demo.git","version":"1.0.0"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create skill: %d", w.Code)
	}
	// 未上传归档时:明确告知不可预览,而不是空响应。
	if w, _ := mreq(t, r, "GET", "/api/server/admin/skills/demo/preview", "", hdr); w.Code != http.StatusNotFound {
		t.Fatalf("未上传归档的预览 = %d, want 404", w.Code)
	}
	archive := makeZip(t, map[string]string{
		"SKILL.md":            skillMd("demo", "2.0.0"),
		"references/notes.md": "# 参考资料\n\n审批时应当能看到这个文件。\n",
	})
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills/demo/archive",
		`{"version":"2.0.0","archive":"`+base64.StdEncoding.EncodeToString(archive)+`"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("upload archive: %d", w.Code)
	}
	// 预览:文件清单 + SKILL.md 正文。
	w, out := mreq(t, r, "GET", "/api/server/admin/skills/demo/preview", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("preview = %d %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	for _, want := range []string{"SKILL.md", "references/notes.md", "demo 技能", "2.0.0"} {
		if !strings.Contains(body, want) {
			t.Fatalf("preview 缺少 %q: %v", want, out)
		}
	}
	// 逐文件查看。
	w, _ = mreq(t, r, "GET", "/api/server/admin/skills/demo/file?path=references%2Fnotes.md", "", hdr)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "审批时应当能看到这个文件") {
		t.Fatalf("file preview = %d %s", w.Code, w.Body.String())
	}
	// 越界路径必须拒绝。
	if w, _ := mreq(t, r, "GET", "/api/server/admin/skills/demo/file?path=..%2F..%2Fetc%2Fpasswd", "", hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("路径越界 = %d, want 400", w.Code)
	}
	// 归档中不存在的文件 → 404。
	if w, _ := mreq(t, r, "GET", "/api/server/admin/skills/demo/file?path=nope.md", "", hdr); w.Code != http.StatusNotFound {
		t.Fatalf("不存在文件 = %d, want 404", w.Code)
	}
}
