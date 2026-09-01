package agentshare

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// makeArchive builds a zip with the given entries (path -> content).
// A "SYMLINK" content marks a symlink entry (zip mode bits, fs.FileMode 位).
func makeArchive(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range entries {
		hdr := &zip.FileHeader{Name: name, Method: zip.Deflate}
		if content == "SYMLINK" {
			hdr.SetMode(fs.ModeSymlink | 0o777)
		}
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			t.Fatal(err)
		}
		if content != "SYMLINK" {
			if _, err := w.Write([]byte(content)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// makeTarGz builds a legacy gzipped-tar archive (still accepted).
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
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
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
	cacheDir := t.TempDir() + "/cache"
	RegisterRoutes(r, db, cacheDir)
	RegisterAdminRoutes(r, db, cacheDir)

	// Admin login (session + CSRF).
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

// presetMeta 生成符合发布契约的 preset.yml(2026-09-01:智能体对齐技能标准,
// 展示名/版本/描述/作者/分类必须写在包内)。name 按上游约定是展示名。
func presetMeta(display, version string) string {
	return "name: " + display + "\nversion: " + version +
		"\ndescription: 用于集成测试的智能体预设,描述需满足最短长度要求。\nauthor: tester\ncategory: 测试\n"
}

func uploadBody(name, desc, displayName string, archive []byte) string {
	body, _ := json.Marshal(map[string]string{
		"name": name, "description": desc, "display_name": displayName, "archive": base64.StdEncoding.EncodeToString(archive),
	})
	return string(body)
}

func rejectBody(reason string) string {
	body, _ := json.Marshal(map[string]string{"reason": reason})
	return string(body)
}

func TestUploadAndApproveFlow(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()

	// alice uploads; row is pending.
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/client/v2/agent-presets", strings.NewReader(uploadBody("ppt-gen", "生成PPT", "PPT 生成", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "preset.yml": presetMeta("PPT 生成", "1.0.0")}))))
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
	if p.DisplayName != "PPT 生成" {
		t.Fatalf("display_name = %q, want 透传", p.DisplayName)
	}

	// Admin preview lists the composition + files.
	wP := httptest.NewRecorder()
	reqP := httptest.NewRequest("GET", "/api/server/admin/agent-presets/ppt-gen/preview", nil)
	for k, v := range adminHdr {
		reqP.Header.Set(k, v)
	}
	r.ServeHTTP(wP, reqP)
	if wP.Code != 200 {
		t.Fatalf("preview = %d %s", wP.Code, wP.Body.String())
	}
	if !strings.Contains(wP.Body.String(), "agent.cordis.yml") || !strings.Contains(wP.Body.String(), "dsh-persona") {
		t.Fatalf("preview body = %s", wP.Body.String())
	}

	// Employee download while pending → 404 (not approved).
	reqA := httptest.NewRequest("GET", "/api/client/v2/agent-presets/ppt-gen/archive", nil)
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
	reqL := httptest.NewRequest("GET", "/api/server/admin/agent-presets?status=pending", nil)
	for k, v := range adminHdr {
		reqL.Header.Set(k, v)
	}
	r.ServeHTTP(wL, reqL)
	if wL.Code != 200 || !strings.Contains(wL.Body.String(), "ppt-gen") {
		t.Fatalf("admin list = %d %s", wL.Code, wL.Body.String())
	}

	wApp := httptest.NewRecorder()
	reqApp := httptest.NewRequest("POST", "/api/server/admin/agent-presets/ppt-gen/approve", nil)
	for k, v := range adminHdr {
		reqApp.Header.Set(k, v)
	}
	r.ServeHTTP(wApp, reqApp)
	if wApp.Code != 200 {
		t.Fatalf("approve = %d %s", wApp.Code, wApp.Body.String())
	}

	// Employee download now succeeds with integrity headers.
	reqA2 := httptest.NewRequest("GET", "/api/client/v2/agent-presets/ppt-gen/archive", nil)
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
	r, db, adminHdr, userHdr, bobHdr := setup(t)
	defer db.Close()

	post := func(body string) int {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/client/v2/agent-presets", strings.NewReader(body))
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
		{"bad id uppercase", uploadBody("My-Preset", "", "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "preset.yml": presetMeta("测试预设", "1.0.0")})), 400},
		{"bad id traversal", uploadBody("../x", "", "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "preset.yml": presetMeta("测试预设", "1.0.0")})), 400},
		{"no archive", `{"name":"abc","description":"x","archive":""}`, 400},
		{"bad base64", `{"name":"abc","archive":"@@@"}`, 400},
		{"empty archive", uploadBody("abc", "", "", []byte{}), 400},
		{"no composition", uploadBody("abc", "", "", makeArchive(t, map[string]string{"README.md": "hi"})), 422},
		{"symlink", uploadBody("abc", "", "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "preset.yml": presetMeta("测试预设", "1.0.0"), "evil": "SYMLINK"})), 422},
		{"traversal entry", uploadBody("abc", "", "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "../evil": "x"})), 422},
	}
	for _, c := range cases {
		if got := post(c.body); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}

	// Oversized archive (> MaxArchiveBytes): incompressible random bytes so
	// the gzip stream cannot shrink below the limit.
	big := makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "big.bin": string(randomBytes(17 << 20))})
	if got := post(uploadBody("big", "", "", big)); got != 422 {
		t.Errorf("oversized: got %d, want 422", got)
	}

	// Duplicate name: upload once, then again → 409 (pending).
	if got := post(uploadBody("dup", "", "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "preset.yml": presetMeta("测试预设", "1.0.0")}))); got != 201 {
		t.Fatalf("first dup upload = %d", got)
	}
	if got := post(uploadBody("dup", "", "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "preset.yml": presetMeta("测试预设", "1.0.0")}))); got != 409 {
		t.Fatalf("second dup upload = %d, want 409", got)
	}

	// Reject without a reason is refused (admin must explain the refusal).
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/server/admin/agent-presets/dup/reject", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range adminHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatalf("reject without reason = %d, want 400", w.Code)
	}

	// Reject then resubmit is allowed; row resets to pending.
	w2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("POST", "/api/server/admin/agent-presets/dup/reject", strings.NewReader(rejectBody("缺少 skills/ 目录")))
	req2.Header.Set("Content-Type", "application/json")
	for k, v := range adminHdr {
		req2.Header.Set(k, v)
	}
	r.ServeHTTP(w2, req2)
	if w2.Code != 200 {
		t.Fatalf("reject = %d", w2.Code)
	}
	// Rejection reason is stored and visible to the author.
	pRow, _ := serverstore.GetAgentPreset(db, "dup")
	if pRow.Reason != "缺少 skills/ 目录" {
		t.Fatalf("reject reason = %q", pRow.Reason)
	}
	// 2026-09-01:智能体对齐「版本即不可变快照」——被拒的版本号同样永久占位,
	// 同版本重提必须 409,作者只能升版本号重新提交(与技能一致)。
	if got := post(uploadBody("dup", "新描述", "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "preset.yml": presetMeta("测试预设", "1.0.0")}))); got != 409 {
		t.Fatalf("被拒后同版本重提 = %d, want 409(版本不可复用)", got)
	}
	if got := post(uploadBody("dup", "新描述", "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "preset.yml": presetMeta("测试预设", "1.1.0") + "changelog: 修正内容。\n"}))); got != 201 {
		t.Fatalf("升版本号重提 = %d, want 201", got)
	}
	if pRow, _ = serverstore.GetAgentPreset(db, "dup"); pRow.Reason != "" {
		t.Fatalf("新版本不应携带旧拒绝理由: %q", pRow.Reason)
	}
	// 2026-09-01「包内即真相」:描述取自包内 preset.yml,请求体的 description
	// 不再被信任(此前手填值会与包内容脱节)。
	p, _ := serverstore.GetAgentPreset(db, "dup")
	if p.Status != serverstore.AgentPresetPending || !strings.Contains(p.Description, "用于集成测试的智能体预设") {
		t.Fatalf("新版本行 status=%s desc=%q", p.Status, p.Description)
	}

	// G1(审计 2026-08-25):跨用户重提必须被拒绝——A 的 rejected 行只能由
	// A 本人重提;B(bob)凭已知 name+version 不得覆盖并重置为 pending。
	wR := httptest.NewRecorder()
	reqR := httptest.NewRequest("POST", "/api/server/admin/agent-presets/dup/reject", strings.NewReader(rejectBody("再拒一次")))
	reqR.Header.Set("Content-Type", "application/json")
	for k, v := range adminHdr {
		reqR.Header.Set(k, v)
	}
	r.ServeHTTP(wR, reqR)
	if wR.Code != 200 {
		t.Fatalf("reject2 = %d", wR.Code)
	}
	// bob 重提 → 404(与不存在同响应,不泄露存在性)。
	{
		wB := httptest.NewRecorder()
		reqB := httptest.NewRequest("POST", "/api/client/v2/agent-presets", strings.NewReader(uploadBody("dup", "bob 劫持", "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "preset.yml": presetMeta("测试预设", "1.0.0")}))))
		reqB.Header.Set("Content-Type", "application/json")
		for k, v := range bobHdr {
			reqB.Header.Set(k, v)
		}
		r.ServeHTTP(wB, reqB)
		if wB.Code != http.StatusNotFound {
			t.Fatalf("bob cross-user resubmit = %d, want 404 (body %s)", wB.Code, wB.Body.String())
		}
		// 行仍为 rejected 且内容未被覆盖(描述来自包内 preset.yml)。
		pB, _ := serverstore.GetAgentPresetByVersion(db, "dup", "1.0.0")
		if pB.Status != serverstore.AgentPresetRejected || pB.Author != "alice" {
			t.Fatalf("bob 的尝试改动了行: status=%s author=%s", pB.Status, pB.Author)
		}
	}
	// alice 本人重提仍可 → 201(回归护栏:合法路径不被误伤)。
	{
		wA2 := httptest.NewRecorder()
		reqA2 := httptest.NewRequest("POST", "/api/client/v2/agent-presets", strings.NewReader(uploadBody("dup", "alice 重提", "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "preset.yml": presetMeta("测试预设", "1.2.0") + "changelog: alice 重提。\n"}))))
		reqA2.Header.Set("Content-Type", "application/json")
		for k, v := range userHdr {
			reqA2.Header.Set(k, v)
		}
		r.ServeHTTP(wA2, reqA2)
		if wA2.Code != http.StatusCreated {
			t.Fatalf("alice legit resubmit = %d, want 201", wA2.Code)
		}
	}

	// Multi-version: the same name may carry several versions independently.
	bodyV2, _ := json.Marshal(map[string]string{
		"name": "dup", "description": "v2", "version": "2.0.0",
		"archive": base64.StdEncoding.EncodeToString(makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "preset.yml": presetMeta("测试预设", "2.0.0") + "changelog: 第二个大版本。\n"})),
	})
	if got := post(string(bodyV2)); got != 201 {
		t.Fatalf("v2 upload = %d, want 201", got)
	}
	v2, err := serverstore.GetAgentPresetByVersion(db, "dup", "2.0.0")
	if err != nil || v2.Status != serverstore.AgentPresetPending {
		t.Fatalf("v2 row = %+v err=%v", v2, err)
	}
	// 版本之间互相独立:v1 早先被拒,不因 v2 的上传而改变
	// (新语义下被拒版本不可复用,只能升版本号,所以它会一直停在 rejected)。
	v1, _ := serverstore.GetAgentPresetByVersion(db, "dup", "1.0.0")
	if v1.Status != serverstore.AgentPresetRejected {
		t.Fatalf("v1 被 v2 上传影响了: status=%s", v1.Status)
	}
}

func TestPendingCap(t *testing.T) {
	r, db, _, userHdr, _ := setup(t)
	defer db.Close()

	post := func(name string) int {
		w := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/api/client/v2/agent-presets", strings.NewReader(uploadBody(name, "", "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "preset.yml": presetMeta("测试预设", "1.0.0")}))))
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
	req := httptest.NewRequest("POST", "/api/client/v2/agent-presets", strings.NewReader(uploadBody("shared-1", "", "", makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "preset.yml": presetMeta("测试预设", "1.0.0")}))))
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
		reqL := httptest.NewRequest("GET", "/api/client/v2/agent-presets", nil)
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
	reqA := httptest.NewRequest("POST", "/api/server/admin/agent-presets/shared-1/reject", strings.NewReader(rejectBody("缺少 skills/ 目录")))
	reqA.Header.Set("Content-Type", "application/json")
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
	reqD := httptest.NewRequest("DELETE", "/api/server/admin/agent-presets/shared-1", nil)
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

// TestPresetArchiveInDB: 上传归档直存 DB(0041),磁盘缓存无文件;preview 与
// DOWNLOAD 读 DB;download 成功计数 +1。
func TestPresetArchiveInDB(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()
	archive := makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "preset.yml": presetMeta("DB 直存", "1.0.0")})

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/client/v2/agent-presets", strings.NewReader(uploadBody("db-preset", "DB直存", "DB Preset", archive)))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range userHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("upload = %d %s", w.Code, w.Body.String())
	}
	// 归档已在 DB 行。
	raw, err := serverstore.GetAgentPresetArchive(db, "db-preset", "1.0.0")
	if err != nil || !bytes.Equal(raw, archive) {
		t.Fatalf("db archive missing: err=%v len=%d", err, len(raw))
	}
	// 管理员通过。
	wA := httptest.NewRecorder()
	reqA := httptest.NewRequest("POST", "/api/server/admin/agent-presets/db-preset/approve", nil)
	for k, v := range adminHdr {
		reqA.Header.Set(k, v)
	}
	r.ServeHTTP(wA, reqA)
	if wA.Code != http.StatusOK {
		t.Fatalf("approve = %d %s", wA.Code, wA.Body.String())
	}
	// 员工下载(作者)= DB 字节 + 计数。
	wD := httptest.NewRecorder()
	reqD := httptest.NewRequest("GET", "/api/client/v2/agent-presets/db-preset/archive", nil)
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
	if disp := wD.Header().Get("Content-Disposition"); !strings.Contains(disp, "db-preset-1.0.0.zip") {
		t.Fatalf("Content-Disposition = %q", disp)
	}
	p, _ := serverstore.GetAgentPresetByVersion(db, "db-preset", "1.0.0")
	if p.Downloads != 1 {
		t.Fatalf("downloads = %d, want 1", p.Downloads)
	}
	// 管理员列表不含 blob。
	all, _ := serverstore.ListAgentPresets(db, "")
	if len(all) != 1 || len(all[0].Archive) != 0 {
		t.Fatalf("admin list must exclude blob: %+v", all)
	}
}

// TestPresetArchiveTarGzCompat: 旧 tar.gz 归档仍可上传(向后兼容),
// 下载按格式回 application/gzip + <name>-<version>.tar.gz 文件名。
func TestPresetArchiveTarGzCompat(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()
	archive := makeTarGz(t, map[string]string{"agent.cordis.yml": testComposition, "preset.yml": presetMeta("测试预设", "1.0.0")})

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/client/v2/agent-presets",
		strings.NewReader(uploadBody("old-preset", "兼容", "旧格式", archive)))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range userHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("upload = %d %s", w.Code, w.Body.String())
	}
	wA := httptest.NewRecorder()
	reqA := httptest.NewRequest("POST", "/api/server/admin/agent-presets/old-preset/approve", nil)
	for k, v := range adminHdr {
		reqA.Header.Set(k, v)
	}
	r.ServeHTTP(wA, reqA)
	if wA.Code != http.StatusOK {
		t.Fatalf("approve = %d %s", wA.Code, wA.Body.String())
	}
	wD := httptest.NewRecorder()
	reqD := httptest.NewRequest("GET", "/api/client/v2/agent-presets/old-preset/archive", nil)
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
	if disp := wD.Header().Get("Content-Disposition"); !strings.Contains(disp, "old-preset-1.0.0.tar.gz") {
		t.Fatalf("Content-Disposition = %q", disp)
	}
}

// TestPresetFileContent: 审核单文件内容端点——文本内联、二进制标记、
// 超大标记、不存在 404、路径穿越拒绝。与 skill 侧共享契约。
func TestPresetFileContent(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()
	archive := makeArchive(t, map[string]string{
		"agent.cordis.yml":     testComposition,
		"preset.yml":           presetMeta("FP Demo", "1.0.0"),
		"skills/demo/SKILL.md": "# demo\n",
		"bin/blob.bin":         string([]byte{0x00, 0x01, 0xFF, 0xFE}),
		"bin/big.txt":          strings.Repeat("x", maxFilePreviewBytes+16),
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/client/v2/agent-presets",
		strings.NewReader(uploadBody("fp-demo", "demo", "FP Demo", archive)))
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
			"/api/server/admin/agent-presets/fp-demo/1.0.0/file?path="+url.QueryEscape(path), nil)
		for k, v := range adminHdr {
			req.Header.Set(k, v)
		}
		r.ServeHTTP(w, req)
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w, out
	}

	t.Run("text inline", func(t *testing.T) {
		w, out := get("skills/demo/SKILL.md")
		if w.Code != http.StatusOK || out["content"] != "# demo\n" {
			t.Fatalf("text = %d %v", w.Code, out)
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
