package brand

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

func useTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	return db
}

func testRouter(db *sql.DB, dataDir string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterRoutes(r, db, dataDir)
	RegisterAdminRoutes(r, db, dataDir)
	return r
}

// 建 super_admin 会话(admin 端点鉴权用)。
func adminSession(t *testing.T, db *sql.DB) (string, string) {
	t.Helper()
	uid, err := serverstore.CreateUserWithPassword(db, "boss", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	u, err := serverstore.GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	u.Role = serverstore.RoleSuperAdmin
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}
	sess, csrf, err := serverauth.CreateAdminSession(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	return sess.ID, csrf
}

func TestBrandDisabledReturnsEmpty(t *testing.T) {
	db := useTestDB(t)
	r := testRouter(db, t.TempDir())
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/client/v2/brand", nil)
	r.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("status = %d", w.Code)
	}
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if out["enabled"] != false {
		t.Fatalf("disabled brand must return enabled=false, got %v", out)
	}
}

func TestBrandEnableAndLogoFlow(t *testing.T) {
	db := useTestDB(t)
	dataDir := t.TempDir()
	r := testRouter(db, dataDir)
	sess, csrf := adminSession(t, db)

	// 1. 启用品牌 + 文本字段
	reqBody := `{"enabled":true,"login":{"display_name":"Acme","tagline":"AI Gateway","welcome":"欢迎"},"client":{"display_name":"Acme AI","accent":"#4F46E5"},"title":"Acme"}`
	w := doReq(t, r, "PUT", "/api/server/admin/brand", reqBody, sess, csrf)
	if w.Code != 200 {
		t.Fatalf("put brand = %d body=%s", w.Code, w.Body.String())
	}
	// 2. 上传 logo(multipart)
	upload, ct := multipartBody(t, "login", "login.svg", `<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>`)
	w = doSend(t, r, "POST", "/api/server/admin/brand/logo", upload, ct, sess, csrf)
	if w.Code != 200 {
		t.Fatalf("upload logo = %d body=%s", w.Code, w.Body.String())
	}
	// 3. 公开 brand 返回 logo_url
	w = doReq(t, r, "GET", "/api/client/v2/brand", "", "", "")
	if w.Code != 200 {
		t.Fatalf("get brand = %d", w.Code)
	}
	var b map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &b)
	if b["login"].(map[string]any)["logo_url"] != "/api/client/v2/brand/logo/login" {
		t.Fatalf("login logo_url missing: %v", b)
	}
	// 4. 下载 logo
	w = doReq(t, r, "GET", "/api/client/v2/brand/logo/login", "", "", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "<svg") {
		t.Fatalf("logo download = %d body=%s", w.Code, w.Body.String())
	}
	if w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("missing nosniff")
	}
}

func TestUploadLogoSanitizeSVG(t *testing.T) {
	db := useTestDB(t)
	dataDir := t.TempDir()
	r := testRouter(db, dataDir)
	sess, csrf := adminSession(t, db)
	// 恶意 SVG: script + onload
	evil := `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle onload="x()" r="5"/></svg>`
	upload, ct := multipartBody(t, "client", "client.svg", evil)
	w := doSend(t, r, "POST", "/api/server/admin/brand/logo", upload, ct, sess, csrf)
	if w.Code != 200 {
		t.Fatalf("upload evil = %d body=%s", w.Code, w.Body.String())
	}
	w = doReq(t, r, "GET", "/api/client/v2/brand/logo/client", "", "", "")
	body := w.Body.String()
	if strings.Contains(body, "<script") || strings.Contains(body, "onload") {
		t.Fatalf("SVG not sanitized: %s", body)
	}
}

func TestUploadLogoRejectsBadExt(t *testing.T) {
	db := useTestDB(t)
	r := testRouter(db, t.TempDir())
	sess, csrf := adminSession(t, db)
	upload, ct := multipartBody(t, "login", "x.exe", "MZ")
	w := doSend(t, r, "POST", "/api/server/admin/brand/logo", upload, ct, sess, csrf)
	if w.Code != 400 {
		t.Fatalf("bad ext = %d, want 400", w.Code)
	}
}

// 全部白名单格式(SVG/PNG/WebP/ICO)上传→下载往返, MIME 正确。
func TestUploadLogoAllFormats(t *testing.T) {
	cases := []struct {
		ext  string
		ct   string
		body []byte
	}{
		{"svg", "image/svg+xml", []byte(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8" fill="#000"/></svg>`)},
		{"png", "image/png", []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde")},
		{"webp", "image/webp", []byte("RIFF\x00\x00\x00\x00WEBPVP8 ")},
		{"ico", "image/x-icon", []byte("\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00")},
	}
	db := useTestDB(t)
	dataDir := t.TempDir()
	r := testRouter(db, dataDir)
	sess, csrf := adminSession(t, db)
	// serveLogo 在 brand.enabled=false 时 404(防旧 logo 缓存), 先启用。
	doReq(t, r, "PUT", "/api/server/admin/brand", `{"enabled":true,"login":{},"client":{},"title":""}`, sess, csrf)
	for _, tc := range cases {
		upload, ct := multipartBody(t, "login", "login."+tc.ext, string(tc.body))
		w := doSend(t, r, "POST", "/api/server/admin/brand/logo", upload, ct, sess, csrf)
		if w.Code != 200 {
			t.Fatalf("upload %s = %d body=%s", tc.ext, w.Code, w.Body.String())
		}
		w = doReq(t, r, "GET", "/api/client/v2/brand/logo/login", "", "", "")
		if w.Code != 200 {
			t.Fatalf("download %s = %d", tc.ext, w.Code)
		}
		if got := w.Header().Get("Content-Type"); got != tc.ct {
			t.Fatalf("%s content-type = %q, want %q", tc.ext, got, tc.ct)
		}
		if !bytes.Equal(w.Body.Bytes(), tc.body) {
			t.Fatalf("%s body mismatch (sanitize only applies to svg)", tc.ext)
		}
	}
}

func TestBrandSnapshotRestore(t *testing.T) {
	db := useTestDB(t)
	r := testRouter(db, t.TempDir())
	sess, csrf := adminSession(t, db)
	// 第一版
	doReq(t, r, "PUT", "/api/server/admin/brand", `{"enabled":true,"login":{"display_name":"V1"},"client":{},"title":""}`, sess, csrf)
	// 第二版(触发快照存 V1)
	doReq(t, r, "PUT", "/api/server/admin/brand", `{"enabled":true,"login":{"display_name":"V2"},"client":{},"title":""}`, sess, csrf)
	// 列出快照
	w := doReq(t, r, "GET", "/api/server/admin/brand/snapshots", "", sess, csrf)
	var out struct {
		Snapshots []struct {
			ID   int64  `json:"id"`
			Data string `json:"data"`
		} `json:"snapshots"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if len(out.Snapshots) == 0 {
		t.Fatalf("no snapshots: %s", w.Body.String())
	}
	// 恢复到第一份快照
	sid := out.Snapshots[0].ID
	w = doReq(t, r, "POST", "/api/server/admin/brand/restore", fmt.Sprintf(`{"id":%d}`, sid), sess, csrf)
	if w.Code != 200 {
		t.Fatalf("restore = %d", w.Code)
	}
	// 验证当前 display_name 为 V1
	w = doReq(t, r, "GET", "/api/server/admin/brand", "", sess, csrf)
	var cur map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &cur)
	login := cur["login"].(map[string]any)
	if login["display_name"] != "V1" {
		t.Fatalf("restored name = %v, want V1", login["display_name"])
	}
}

func TestPortalConfig(t *testing.T) {
	db := useTestDB(t)
	r := testRouter(db, t.TempDir())
	sess, csrf := adminSession(t, db)
	doReq(t, r, "PUT", "/api/server/admin/portal", `{"enabled":true,"welcome":"企业首页","client_download_linux":"https://example.com/linux","client_download_mac":"https://example.com/mac","client_download_win":"https://example.com/win"}`, sess, csrf)
	w := doReq(t, r, "GET", "/api/client/v2/portal", "", "", "")
	var p map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	if p["welcome"] != "企业首页" ||
		p["client_download_linux"] != "https://example.com/linux" ||
		p["client_download_mac"] != "https://example.com/mac" ||
		p["client_download_win"] != "https://example.com/win" {
		t.Fatalf("portal = %v", p)
	}
}

// 旧单链接(client_download_url)保留读写兼容: 保存后可读回, 不丢配置。
func TestPortalLegacyDownloadURL(t *testing.T) {
	db := useTestDB(t)
	r := testRouter(db, t.TempDir())
	sess, csrf := adminSession(t, db)
	doReq(t, r, "PUT", "/api/server/admin/portal", `{"enabled":true,"welcome":"","client_download_url":"https://example.com/legacy"}`, sess, csrf)
	w := doReq(t, r, "GET", "/api/server/admin/portal", "", sess, csrf)
	var p map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &p)
	legacy, _ := p["client_download_url"].(string)
	if legacy != "https://example.com/legacy" {
		t.Fatalf("legacy client_download_url lost: %v", p)
	}
}

func TestLogoPathTraversal(t *testing.T) {
	db := useTestDB(t)
	// 直接写 settings 指向路径遍历文件名, logoPath 必须拒绝
	_ = serverstore.SetSetting(db, "brand.login.logo", "../evil.svg")
	_, err := logoPath(db, t.TempDir(), "login")
	if err == nil {
		t.Fatal("path traversal must be rejected")
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func doReq(t *testing.T, r http.Handler, method, path, body, sess, csrf string) *httptest.ResponseRecorder {
	t.Helper()
	return doSend(t, r, method, path, body, "application/json", sess, csrf)
}

func doSend(t *testing.T, r http.Handler, method, path, body, contentType, sess, csrf string) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, bytes.NewBufferString(body))
	}
	req.Header.Set("Content-Type", contentType)
	if sess != "" {
		req.Header.Set("Cookie", "picoaide_session="+sess)
	}
	if csrf != "" && method != "GET" {
		req.Header.Set("X-CSRF-Token", csrf)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func multipartBody(t *testing.T, name, filename, content string) (string, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("name", name)
	fw, _ := mw.CreateFormFile("file", filename)
	_, _ = fw.Write([]byte(content))
	_ = mw.Close()
	return buf.String(), mw.FormDataContentType()
}
