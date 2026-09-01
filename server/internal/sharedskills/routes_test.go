package sharedskills

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
	"net/url"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

func makeSkillArchive(t *testing.T, entries map[string]string) []byte {
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

// makeSkillTarGz builds a legacy gzipped-tar archive (still accepted).
func makeSkillTarGz(t *testing.T, entries map[string]string) []byte {
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

// skillMd builds a SKILL.md that satisfies the strict publish contract
// (决策 2026-09-01 §5.1):name 必须等于上传名,version 必须是包内真相。
func skillMd(name, version string) string {
	return "---\n" +
		"name: " + name + "\n" +
		"title: " + name + " 技能\n" +
		"version: " + version + "\n" +
		"description: 用于集成测试的技能包,描述需要满足最短长度要求。\n" +
		"author: tester\n" +
		"category: 测试\n" +
		"---\n\n# " + name + "\n\n本技能是服务端集成测试使用的夹具包,正文需要足够长才能通过空壳校验,因此这里补充了一段用于说明用途的文字。\n"
}

// skillUpload builds a complete, contract-compliant upload body.
func skillUpload(t *testing.T, name, version, desc string) string {
	t.Helper()
	return uploadBody(name, version, desc, makeSkillArchive(t, map[string]string{"SKILL.md": skillMd(name, version)}))
}

func setup(t *testing.T) (*gin.Engine, *sql.DB, map[string]string, map[string]string, map[string]string) {
	t.Helper()
	t.Setenv("PICOAI_LOGIN_MAX_ATTEMPTS", "1000")
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef0123456789abcdef")
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
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
	cacheDir := t.TempDir() + "/cache"
	RegisterRoutes(r, db, cacheDir)
	RegisterAdminRoutes(r, db, cacheDir)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/server/admin/login", strings.NewReader(`{"username":"boss","password":"pw123456"}`))
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

func uploadBody(name, version, desc string, archive []byte) string {
	body, _ := json.Marshal(map[string]string{
		"name": name, "version": version, "description": desc, "archive": base64.StdEncoding.EncodeToString(archive),
	})
	return string(body)
}

func rejectBody(reason string) string {
	body, _ := json.Marshal(map[string]string{"reason": reason})
	return string(body)
}

func TestUploadApproveFlow(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/client/v2/shared-skills",
		strings.NewReader(skillUpload(t, "codeql-audit", "1.0.0", "审计")))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range userHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("upload = %d %s", w.Code, w.Body.String())
	}
	s, err := serverstore.GetSharedSkill(db, "codeql-audit", "1.0.0")
	if err != nil || s.Status != serverstore.SharedSkillPending || s.Author != "alice" {
		t.Fatalf("row = %+v err=%v", s, err)
	}

	// Employee download while pending → 404.
	wA := httptest.NewRecorder()
	reqA := httptest.NewRequest("GET", "/api/client/v2/shared-skills/codeql-audit/1.0.0/archive", nil)
	for k, v := range userHdr {
		reqA.Header.Set(k, v)
	}
	r.ServeHTTP(wA, reqA)
	if wA.Code != http.StatusNotFound {
		t.Fatalf("pending download = %d", wA.Code)
	}

	// Admin preview.
	wP := httptest.NewRecorder()
	reqP := httptest.NewRequest("GET", "/api/server/admin/shared-skills/codeql-audit/1.0.0/preview", nil)
	for k, v := range adminHdr {
		reqP.Header.Set(k, v)
	}
	r.ServeHTTP(wP, reqP)
	if wP.Code != 200 || !strings.Contains(wP.Body.String(), "codeql") {
		t.Fatalf("preview = %d %s", wP.Code, wP.Body.String())
	}

	// Approve; employee download succeeds.
	wApp := httptest.NewRecorder()
	reqApp := httptest.NewRequest("POST", "/api/server/admin/shared-skills/codeql-audit/1.0.0/approve", nil)
	for k, v := range adminHdr {
		reqApp.Header.Set(k, v)
	}
	r.ServeHTTP(wApp, reqApp)
	if wApp.Code != 200 {
		t.Fatalf("approve = %d", wApp.Code)
	}
	wA2 := httptest.NewRecorder()
	reqA2 := httptest.NewRequest("GET", "/api/client/v2/shared-skills/codeql-audit/1.0.0/archive", nil)
	for k, v := range userHdr {
		reqA2.Header.Set(k, v)
	}
	r.ServeHTTP(wA2, reqA2)
	if wA2.Code != 200 {
		t.Fatalf("approved download = %d", wA2.Code)
	}
	if wA2.Header().Get("X-Skill-Checksum") != s.Checksum {
		t.Fatalf("checksum header = %q", wA2.Header().Get("X-Skill-Checksum"))
	}

	// Multi-version: upload 1.1.0 → approve → both visible.
	w2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("POST", "/api/client/v2/shared-skills",
		strings.NewReader(skillUpload(t, "codeql-audit", "1.1.0", "审计v2")))
	req2.Header.Set("Content-Type", "application/json")
	for k, v := range userHdr {
		req2.Header.Set(k, v)
	}
	r.ServeHTTP(w2, req2)
	if w2.Code != 201 {
		t.Fatalf("v2 upload = %d", w2.Code)
	}
	// Audit rows exist.
	n, _ := serverstore.ListAuditLogs(db, 10)
	if len(n) < 2 {
		t.Fatalf("audit = %d rows, want >= 2", len(n))
	}
}

func TestUploadValidation(t *testing.T) {
	r, db, adminHdr, userHdr, bobHdr := setup(t)
	defer db.Close()

	post := func(body string) int {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/client/v2/shared-skills", strings.NewReader(body))
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
		{"bad name", skillUpload(t, "My-Skill", "1.0.0", ""), 400},
		// 版本不再取自请求:包内 version 非 semver 才是版本错误(422)。
		{"bad version in package", uploadBody("okskill", "1.0.0", "",
			makeSkillArchive(t, map[string]string{"SKILL.md": skillMd("okskill", "v1")})), 422},
		// 身份错位:包内 name 与上传名不一致必须拒绝(否则装到磁盘后
		// 运行时按包内 name 注册,与市场卡片对不上)。
		{"identity mismatch", uploadBody("okskill", "1.0.0", "",
			makeSkillArchive(t, map[string]string{"SKILL.md": skillMd("other-name", "1.0.0")})), 422},
		// 必填字段缺失(此处以 title 为例,矩阵在 skillmanifest 单测里)。
		{"missing title", uploadBody("okskill", "1.0.0", "", makeSkillArchive(t, map[string]string{
			"SKILL.md": "---\nname: okskill\nversion: 1.0.0\ndescription: 描述足够长可以通过校验。\nauthor: t\ncategory: 测试\n---\n\n" +
				"正文需要足够长才能通过空壳校验,所以这里补一段说明文字用于测试。\n"})), 422},
		{"BOM", uploadBody("okskill", "1.0.0", "",
			makeSkillArchive(t, map[string]string{"SKILL.md": "\ufeff" + skillMd("okskill", "1.0.0")})), 422},
		{"no archive", `{"name":"abc","version":"1.0.0","archive":""}`, 400},
		{"no SKILL.md", uploadBody("abc", "1.0.0", "", makeSkillArchive(t, map[string]string{"README.md": "hi"})), 422},
	}
	for _, c := range cases {
		if got := post(c.body); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}

	// Duplicate name+version → 409; different version OK.
	if got := post(skillUpload(t, "dup", "1.0.0", "")); got != 201 {
		t.Fatalf("first upload = %d", got)
	}
	if got := post(skillUpload(t, "dup", "1.0.0", "")); got != 409 {
		t.Fatalf("duplicate = %d, want 409", got)
	}
	if got := post(skillUpload(t, "dup", "1.1.0", "")); got != 201 {
		t.Fatalf("v2 upload = %d, want 201", got)
	}

	// Reject requires reason.
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/server/admin/shared-skills/dup/1.0.0/reject", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range adminHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatalf("reject no reason = %d, want 400", w.Code)
	}

	// Reject with reason; resubmit resets.
	w2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("POST", "/api/server/admin/shared-skills/dup/1.0.0/reject", strings.NewReader(rejectBody("缺演示")))
	req2.Header.Set("Content-Type", "application/json")
	for k, v := range adminHdr {
		req2.Header.Set(k, v)
	}
	r.ServeHTTP(w2, req2)
	if w2.Code != 200 {
		t.Fatalf("reject = %d", w2.Code)
	}
	s, _ := serverstore.GetSharedSkill(db, "dup", "1.0.0")
	if s.Reason != "缺演示" {
		t.Fatalf("reason = %q", s.Reason)
	}
	// D3(决策 2026-09-01):版本即不可变快照——被拒的版本号同样永久占位,
	// 同版本重提必须 409 VERSION_EXISTS,作者只能升版本号重新提交。
	if got := post(skillUpload(t, "dup", "1.0.0", "")); got != 409 {
		t.Fatalf("被拒后同版本重提 = %d, want 409(版本不可复用)", got)
	}
	s, _ = serverstore.GetSharedSkill(db, "dup", "1.0.0")
	if s.Status != serverstore.SharedSkillRejected || s.Reason != "缺演示" {
		t.Fatalf("被拒行不得被重提改写: %+v", s)
	}
	// 升版本号后可以重新提交(1.1.0 在前面的用例里已占用,这里用 1.2.0)。
	if got := post(skillUpload(t, "dup", "1.2.0", "")); got != 201 {
		t.Fatalf("升版本号重提 = %d, want 201", got)
	}
	sNew, _ := serverstore.GetSharedSkill(db, "dup", "1.2.0")
	if sNew.Status != serverstore.SharedSkillPending {
		t.Fatalf("新版本行 = %+v, want pending", sNew)
	}
	// 内容未变更:换个版本号但内容完全一致 → CONTENT_UNCHANGED。
	if got := post(skillUpload(t, "dup", "1.2.0", "")); got != 409 {
		t.Fatalf("同版本重复 = %d, want 409", got)
	}
	// 版本倒挂:低于现有最高版本 → VERSION_NOT_INCREASING。
	if got := post(skillUpload(t, "dup", "1.0.5", "")); got != 409 {
		t.Fatalf("版本倒挂 = %d, want 409", got)
	}

	// G1(审计 2026-08-25):跨用户重提必须被拒绝。先再次拒绝,再让 bob 重提。
	wR := httptest.NewRecorder()
	reqR := httptest.NewRequest("POST", "/api/server/admin/shared-skills/dup/1.0.0/reject", strings.NewReader(rejectBody("再拒")))
	reqR.Header.Set("Content-Type", "application/json")
	for k, v := range adminHdr {
		reqR.Header.Set(k, v)
	}
	r.ServeHTTP(wR, reqR)
	if wR.Code != 200 {
		t.Fatalf("reject2 = %d", wR.Code)
	}
	// 劫持前快照:断言 bob 的尝试对行「零改动」(此前用 Description=="" 表达,
	// 但 2026-09-01 起描述必然来自包内清单,空描述不再是有效判据)。
	before, _ := serverstore.GetSharedSkill(db, "dup", "1.0.0")
	wB := httptest.NewRecorder()
	reqB := httptest.NewRequest("POST", "/api/client/v2/shared-skills",
		strings.NewReader(skillUpload(t, "dup", "1.0.0", "bob 劫持")))
	reqB.Header.Set("Content-Type", "application/json")
	for k, v := range bobHdr {
		reqB.Header.Set(k, v)
	}
	r.ServeHTTP(wB, reqB)
	if wB.Code != http.StatusNotFound {
		t.Fatalf("bob cross-user resubmit = %d, want 404 (body %s)", wB.Code, wB.Body.String())
	}
	sB, _ := serverstore.GetSharedSkill(db, "dup", "1.0.0")
	if sB.Status != serverstore.SharedSkillRejected || sB.Author != before.Author ||
		sB.Description != before.Description || sB.Checksum != before.Checksum {
		t.Fatalf("bob attempt mutated the row: status=%s author=%s desc=%q checksum=%s",
			sB.Status, sB.Author, sB.Description, sB.Checksum)
	}
}

func TestVisibility(t *testing.T) {
	r, db, adminHdr, userHdr, bobHdr := setup(t)
	defer db.Close()

	post := func(name, version string) int {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/client/v2/shared-skills",
			strings.NewReader(skillUpload(t, name, version, "")))
		req.Header.Set("Content-Type", "application/json")
		for k, v := range userHdr {
			req.Header.Set(k, v)
		}
		r.ServeHTTP(w, req)
		return w.Code
	}
	if post("priv", "1.0.0") != 201 {
		t.Fatal("alice upload failed")
	}
	list := func(hdr map[string]string) string {
		wL := httptest.NewRecorder()
		reqL := httptest.NewRequest("GET", "/api/client/v2/shared-skills", nil)
		for k, v := range hdr {
			reqL.Header.Set(k, v)
		}
		r.ServeHTTP(wL, reqL)
		return wL.Body.String()
	}
	if strings.Contains(list(bobHdr), "priv") {
		t.Fatal("bob sees alice pending")
	}
	// Admin approve → 但授权制:bob 未授权仍不可见。
	wA := httptest.NewRecorder()
	reqA := httptest.NewRequest("POST", "/api/server/admin/shared-skills/priv/1.0.0/approve", nil)
	for k, v := range adminHdr {
		reqA.Header.Set(k, v)
	}
	r.ServeHTTP(wA, reqA)
	if wA.Code != 200 {
		t.Fatalf("approve = %d", wA.Code)
	}
	if strings.Contains(list(bobHdr), "priv") {
		t.Fatal("bob sees approved without grant")
	}
	// 管理员给 bob 授权(按 name)→ 可见。
	wG := httptest.NewRecorder()
	reqG := httptest.NewRequest("PUT", "/api/server/admin/shared-skills/priv/grant", strings.NewReader(`{"username":"bob"}`))
	reqG.Header.Set("Content-Type", "application/json")
	for k, v := range adminHdr {
		reqG.Header.Set(k, v)
	}
	r.ServeHTTP(wG, reqG)
	if wG.Code != 200 {
		t.Fatalf("grant = %d %s", wG.Code, wG.Body.String())
	}
	if !strings.Contains(list(bobHdr), "priv") {
		t.Fatal("bob does not see approved after grant")
	}
	// 作者 alice 始终可见自己的。
	if !strings.Contains(list(userHdr), "priv") {
		t.Fatal("alice does not see own")
	}
}

// TestReplaceGrantsUnknownGroup: 授权整组替换时,不存在/非法的部门名必须
// 返回 400(而不是 500)——修复 2026-08-28(prod 演示 @all 触发 500)。
func TestReplaceGrantsUnknownGroup(t *testing.T) {
	r, db, adminHdr, _, _ := setup(t)
	defer db.Close()

	put := func(body string) int {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("PUT", "/api/server/admin/shared-skills/any/grants", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		for k, v := range adminHdr {
			req.Header.Set(k, v)
		}
		r.ServeHTTP(w, req)
		return w.Code
	}
	if got := put(`{"groups":["不存在的部门"]}`); got != http.StatusBadRequest {
		t.Fatalf("unknown group = %d, want 400", got)
	}
	if got := put(`{"groups":["@all"]}`); got != http.StatusBadRequest {
		t.Fatalf("@all = %d, want 400", got)
	}
}

// TestDeleteClearsGrants: 硬删技能行后,其全部授权必须级联清理
// (旧授权不得复活重建的资源)——修复 2026-08-28(prod 演示删除后残留孤儿授权)。
func TestDeleteClearsGrants(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()

	// alice 上传 → admin approve → 授权全员 → 删除 → 授权表清空。
	post := func() {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/client/v2/shared-skills",
			strings.NewReader(skillUpload(t, "del-grant", "1.0.0", "")))
		req.Header.Set("Content-Type", "application/json")
		for k, v := range userHdr {
			req.Header.Set(k, v)
		}
		r.ServeHTTP(w, req)
		if w.Code != http.StatusCreated {
			t.Fatalf("upload = %d %s", w.Code, w.Body.String())
		}
	}
	post()
	wA := httptest.NewRecorder()
	reqA := httptest.NewRequest("POST", "/api/server/admin/shared-skills/del-grant/1.0.0/approve", nil)
	for k, v := range adminHdr {
		reqA.Header.Set(k, v)
	}
	r.ServeHTTP(wA, reqA)
	if wA.Code != 200 {
		t.Fatalf("approve = %d", wA.Code)
	}
	wG := httptest.NewRecorder()
	reqG := httptest.NewRequest("PUT", "/api/server/admin/shared-skills/del-grant/grants", strings.NewReader(`{"groups":["全员"]}`))
	reqG.Header.Set("Content-Type", "application/json")
	for k, v := range adminHdr {
		reqG.Header.Set(k, v)
	}
	r.ServeHTTP(wG, reqG)
	if wG.Code != 200 {
		t.Fatalf("grant = %d %s", wG.Code, wG.Body.String())
	}
	wD := httptest.NewRecorder()
	reqD := httptest.NewRequest("DELETE", "/api/server/admin/shared-skills/del-grant/1.0.0", nil)
	for k, v := range adminHdr {
		reqD.Header.Set(k, v)
	}
	r.ServeHTTP(wD, reqD)
	if wD.Code != 200 {
		t.Fatalf("delete = %d %s", wD.Code, wD.Body.String())
	}
	grants, err := serverstore.ListSharedResourceGrants(db, serverstore.SharedSkillGrantTable, "del-grant")
	if err != nil {
		t.Fatalf("list grants: %v", err)
	}
	if len(grants) != 0 {
		t.Fatalf("grants after delete = %+v, want empty", grants)
	}
}

// TestCrossSourceConflictUploadApprove 决策 2026-08-25:市场与组织合并为
// 「市场」后,同名技能跨源互斥——上传(员工)与 approve(管理员)对市场同名
// 技能返回 409 CONFLICT。
func TestCrossSourceConflictUploadApprove(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	// 市场预置同名技能。
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{Name: "codeql-audit", Version: "1.0.0", Enabled: 1, GitURL: "https://example.com/repo.git"}); err != nil {
		t.Fatalf("seed market skill: %v", err)
	}

	// 员工上传同名 -> 409 CONFLICT。
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/client/v2/shared-skills",
		strings.NewReader(skillUpload(t, "codeql-audit", "1.0.0", "x")))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range userHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("upload conflict = %d, want 409 (%s)", w.Code, w.Body.String())
	}

	// 员工上传非冲突技能 -> 201。
	w2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("POST", "/api/client/v2/shared-skills",
		strings.NewReader(skillUpload(t, "fresh-open", "1.0.0", "x")))
	req2.Header.Set("Content-Type", "application/json")
	for k, v := range userHdr {
		req2.Header.Set(k, v)
	}
	r.ServeHTTP(w2, req2)
	if w2.Code != http.StatusCreated {
		t.Fatalf("fresh upload = %d (%s)", w2.Code, w2.Body.String())
	}
	// admin 上架同名的市场技能会被双向互斥阻断(409,前面 serverstore 测试已
	// 覆盖);approve 前的冲突检测是深度防御——模拟竞态:绕过 DAO 直接 SQL
	// 插入市场同名行(等价于上架发生在共享技能上传之后)。
	if _, err := db.Exec(`INSERT INTO skills (name, version, description, author, git_url, git_ref, checksum, enabled)
		VALUES ('fresh-open', '1.0.0', '', 'boss', 'https://example.com/repo2.git', 'main', '', 1)`); err != nil {
		t.Fatalf("raw market seed: %v", err)
	}
	wA := httptest.NewRecorder()
	reqA := httptest.NewRequest("POST", "/api/server/admin/shared-skills/fresh-open/1.0.0/approve", nil)
	for k, v := range adminHdr {
		reqA.Header.Set(k, v)
	}
	r.ServeHTTP(wA, reqA)
	if wA.Code != http.StatusConflict {
		t.Fatalf("approve conflict = %d, want 409 (%s)", wA.Code, wA.Body.String())
	}
}

// TestSharedSkillArchiveInDB: 0040 — upload stores the archive in the DB row
// (no disk file), approve + download serves the DB bytes and bumps the
// download counter; disk cache stays absent.
func TestSharedSkillArchiveInDB(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()
	archive := makeSkillArchive(t, map[string]string{"SKILL.md": skillMd("db-arch", "1.0.0")})

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/client/v2/shared-skills",
		strings.NewReader(uploadBody("db-arch", "1.0.0", "审计", archive)))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range userHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("upload = %d %s", w.Code, w.Body.String())
	}
	// 归档已在 DB 行(上传即落库)。
	raw, err := serverstore.GetSharedSkillArchive(db, "db-arch", "1.0.0")
	if err != nil || !bytes.Equal(raw, archive) {
		t.Fatalf("db archive missing: err=%v len=%d", err, len(raw))
	}
	// 管理员通过。
	wA := httptest.NewRecorder()
	reqA := httptest.NewRequest("POST", "/api/server/admin/shared-skills/db-arch/1.0.0/approve", nil)
	for k, v := range adminHdr {
		reqA.Header.Set(k, v)
	}
	r.ServeHTTP(wA, reqA)
	if wA.Code != http.StatusOK {
		t.Fatalf("approve = %d %s", wA.Code, wA.Body.String())
	}

	// 员工下载(approved+作者):返回 DB 字节,计数 +1。
	wD := httptest.NewRecorder()
	reqD := httptest.NewRequest("GET", "/api/client/v2/shared-skills/db-arch/1.0.0/archive", nil)
	for k, v := range userHdr {
		reqD.Header.Set(k, v)
	}
	r.ServeHTTP(wD, reqD)
	if wD.Code != http.StatusOK {
		t.Fatalf("download = %d %s", wD.Code, wD.Body.String())
	}
	if !bytes.Equal(wD.Body.Bytes(), archive) {
		t.Fatalf("downloaded bytes differ")
	}
	if ct := wD.Header().Get("Content-Type"); ct != "application/zip" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if disp := wD.Header().Get("Content-Disposition"); !strings.Contains(disp, "db-arch-1.0.0.zip") {
		t.Fatalf("Content-Disposition = %q", disp)
	}
	s, _ := serverstore.GetSharedSkill(db, "db-arch", "1.0.0")
	if s.Downloads != 1 {
		t.Fatalf("downloads = %d, want 1", s.Downloads)
	}
	// 管理员列表不含归档 blob(列已裁剪)。
	all, _ := serverstore.ListSharedSkills(db, "")
	if len(all) != 1 || len(all[0].Archive) != 0 {
		t.Fatalf("admin list must exclude blob: %+v", all)
	}
}

// TestSharedSkillArchiveTarGzCompat: 旧 tar.gz 归档仍可上传(向后兼容),
// 下载按格式回 application/gzip + <name>-<version>.tar.gz 文件名。
func TestSharedSkillArchiveTarGzCompat(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()
	archive := makeSkillTarGz(t, map[string]string{"SKILL.md": skillMd("oldfmt", "1.0.0")})

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/client/v2/shared-skills",
		strings.NewReader(uploadBody("oldfmt", "1.0.0", "兼容", archive)))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range userHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("upload = %d %s", w.Code, w.Body.String())
	}
	wA := httptest.NewRecorder()
	reqA := httptest.NewRequest("POST", "/api/server/admin/shared-skills/oldfmt/1.0.0/approve", nil)
	for k, v := range adminHdr {
		reqA.Header.Set(k, v)
	}
	r.ServeHTTP(wA, reqA)
	if wA.Code != http.StatusOK {
		t.Fatalf("approve = %d %s", wA.Code, wA.Body.String())
	}
	wD := httptest.NewRecorder()
	reqD := httptest.NewRequest("GET", "/api/client/v2/shared-skills/oldfmt/1.0.0/archive", nil)
	for k, v := range userHdr {
		reqD.Header.Set(k, v)
	}
	r.ServeHTTP(wD, reqD)
	if wD.Code != http.StatusOK {
		t.Fatalf("download = %d %s", wD.Code, wD.Body.String())
	}
	if ct := wD.Header().Get("Content-Type"); ct != "application/gzip" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if disp := wD.Header().Get("Content-Disposition"); !strings.Contains(disp, "oldfmt-1.0.0.tar.gz") {
		t.Fatalf("Content-Disposition = %q", disp)
	}
}

// TestAdminSkillFileContent: 审核单文件内容端点——文本内联、路径规范化、
// 二进制标记、超大标记、不存在 404。
func TestAdminSkillFileContent(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()

	archive := makeSkillArchive(t, map[string]string{
		"SKILL.md":     skillMd("fpdemo", "1.0.0"),
		"scripts/x.sh": "#!/bin/sh\necho hi\n",
		"docs/说明.md":   "中文内容 ok",
		"bin/blob.bin": string([]byte{0x00, 0x01, 0xFF, 0xFE}),
		"bin/big.txt":  strings.Repeat("x", maxFilePreviewBytes+16),
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/client/v2/shared-skills",
		strings.NewReader(uploadBody("fpdemo", "1.0.0", "", archive)))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range userHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("upload = %d %s", w.Code, w.Body.String())
	}

	get := func(path string) (*httptest.ResponseRecorder, map[string]any) {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("GET",
			"/api/server/admin/shared-skills/fpdemo/1.0.0/file?path="+url.QueryEscape(path), nil)
		for k, v := range adminHdr {
			req.Header.Set(k, v)
		}
		r.ServeHTTP(w, req)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w, out
	}

	t.Run("text inline", func(t *testing.T) {
		w, out := get("scripts/x.sh")
		if w.Code != http.StatusOK {
			t.Fatalf("code = %d %s", w.Code, w.Body.String())
		}
		if out["content"] != "#!/bin/sh\necho hi\n" {
			t.Fatalf("content = %q", out["content"])
		}
		if out["binary"] != false || out["too_large"] != false {
			t.Fatalf("flags = %v %v", out["binary"], out["too_large"])
		}
	})
	t.Run("utf8 path ok", func(t *testing.T) {
		w, out := get("docs/说明.md")
		if w.Code != http.StatusOK || out["content"] != "中文内容 ok" {
			t.Fatalf("utf8 path = %d %v", w.Code, out)
		}
	})
	t.Run("binary flagged", func(t *testing.T) {
		w, out := get("bin/blob.bin")
		if w.Code != http.StatusOK || out["binary"] != true || out["content"] != "" {
			t.Fatalf("binary = %d %v", w.Code, out)
		}
	})
	t.Run("oversized flagged", func(t *testing.T) {
		w, out := get("bin/big.txt")
		if w.Code != http.StatusOK || out["too_large"] != true || out["content"] != "" {
			t.Fatalf("big = %d %v", w.Code, out)
		}
	})
	t.Run("missing 404", func(t *testing.T) {
		w, _ := get("nope.txt")
		if w.Code != http.StatusNotFound {
			t.Fatalf("missing = %d", w.Code)
		}
	})
	t.Run("path escape rejected", func(t *testing.T) {
		w, _ := get("../etc/passwd")
		if w.Code != http.StatusBadRequest {
			t.Fatalf("escape = %d", w.Code)
		}
	})
}

// TestUploadAuditDetailFormat: 审计明细格式是「服务端写入」与「审计页解析
// 预览入口」之间的契约(webadmin Audit.tsx 用 ^name@version 正则还原预览
// 端点)。改格式必须同步改前端,否则预览按钮会静默消失。
func TestUploadAuditDetailFormat(t *testing.T) {
	got := UploadAuditDetail("team-knowledge-wiki", "1.2.0", "团队知识库助手",
		"13a1853c2594416cb14a5aeb12c3d911deb45e3d6f4c71ed3e2aaa28a5502cf4")
	want := "team-knowledge-wiki@1.2.0 「团队知识库助手」 sha256:13a1853c"
	if got != want {
		t.Fatalf("detail = %q, want %q", got, want)
	}
	if !strings.HasPrefix(got, "team-knowledge-wiki@1.2.0") {
		t.Fatal("前缀必须是 name@version(审计页据此解析预览入口)")
	}
	// 无标题/无校验和时仍保持可解析前缀。
	if got := UploadAuditDetail("demo", "1.0.0", "", ""); got != "demo@1.0.0" {
		t.Fatalf("minimal detail = %q", got)
	}
}
