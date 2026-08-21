package knowledge

import (
	"archive/zip"
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"sync/atomic"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// counter derives unique source IPs for admin login requests (rate limiter).
var counter atomic.Int64

func kbAdminSetup(t *testing.T) (http.Handler, *sql.DB, map[string]string, string) {
	t.Helper()
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/kb.db", t.TempDir()))
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
	uploadsDir := filepath.Join(t.TempDir(), "uploads")
	RegisterAdminRoutes(r, db, uploadsDir)

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/login", strings.NewReader(`{"username":"boss","password":"pw123456"}`))
	req.Header.Set("Content-Type", "application/json")
	// per-setup source IP keeps the login rate limiter from tripping when
	// many tests log in as boss within the same window
	req.RemoteAddr = fmt.Sprintf("10.9.9.%d:1234", counter.Add(1))
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
	return r, db, hdr, uploadsDir
}

func kbReq(t *testing.T, r http.Handler, method, path, body string, hdr map[string]string) (*httptest.ResponseRecorder, map[string]any) {
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

func TestAdminKB(t *testing.T) {
	r, db, hdr, _ := kbAdminSetup(t)
	defer db.Close()

	// folder
	w, out := kbReq(t, r, "POST", "/api/admin/kb/folders", `{"name":"产品文档"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create folder: %d %s", w.Code, w.Body.String())
	}
	folderID := int64(out["folder"].(map[string]any)["id"].(float64))
	// grant user alice
	if _, err := serverstore.CreateUserWithPassword(db, "alice", "pw"); err != nil {
		t.Fatal(err)
	}
	if w, _ := kbReq(t, r, "PUT", fmt.Sprintf("/api/admin/kb/folders/%d/grant", folderID),
		`{"username":"alice"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("grant: %d", w.Code)
	}
	accessible, err := serverstore.GetAccessibleFolderIDs(db, "alice", nil)
	if err != nil || len(accessible) != 1 || accessible[0] != folderID { // only the granted folder (strict default)
		t.Fatalf("accessible = %v %v", accessible, err)
	}
	// upload doc
	w, out = kbReq(t, r, "POST", "/api/admin/kb/upload",
		fmt.Sprintf(`{"title":"知识库使用手册","content":"本手册介绍知识库的用法","folder_id":%d}`, folderID), hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("upload: %d %s", w.Code, w.Body.String())
	}
	docID := int64(out["doc"].(map[string]any)["id"].(float64))
	// search preview finds it (admin search uses empty username → global)
	w, out = kbReq(t, r, "GET", "/api/admin/kb/search?q=知识", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("search: %d", w.Code)
	}
	results := out["results"].([]any)
	if len(results) == 0 {
		t.Fatal("search found nothing")
	}
	// delete doc
	w, _ = kbReq(t, r, "DELETE", fmt.Sprintf("/api/admin/kb/documents/%d", docID), "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("delete: %d", w.Code)
	}
	// audit log written (grant/upload/delete all audited)
	logs, err := serverstore.ListAuditLogs(db, 10)
	if err != nil || len(logs) != 3 {
		t.Fatalf("audit logs = %v %v", logs, err)
	}
	for _, want := range []string{"kb_grant", "kb_upload", "kb_delete"} {
		found := false
		for _, l := range logs {
			if l.Action == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("audit missing %s: %v", want, logs)
		}
	}
	// non-admin → 401 on login, and direct kb call without session → 401
	if w, _ := kbReq(t, r, "GET", "/api/admin/kb/folders", "", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("no session: %d", w.Code)
	}
}

// kbMultipart posts a multipart upload to /api/admin/kb/upload.
func kbMultipart(t *testing.T, r http.Handler, fields map[string]string, fileName string, data []byte, hdr map[string]string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			t.Fatal(err)
		}
	}
	fw, err := mw.CreateFormFile("file", fileName)
	if err != nil {
		t.Fatal(err)
	}
	fw.Write(data)
	mw.Close()
	req := httptest.NewRequest("POST", "/api/admin/kb/upload", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

// minimalDocx builds a docx archive containing one word/document.xml.
func minimalDocx(t *testing.T, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	f, err := zw.Create("word/document.xml")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestAdminKBRevokeGrant(t *testing.T) {
	r, db, hdr, _ := kbAdminSetup(t)
	defer db.Close()

	w, out := kbReq(t, r, "POST", "/api/admin/kb/folders", `{"name":"产品文档"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create folder: %d", w.Code)
	}
	folderID := int64(out["folder"].(map[string]any)["id"].(float64))
	if _, err := serverstore.CreateUserWithPassword(db, "alice", "pw"); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateDepartment(db, "devs", 0, 0, ""); err != nil {
		t.Fatal(err)
	}
	if w, _ := kbReq(t, r, "PUT", fmt.Sprintf("/api/admin/kb/folders/%d/grant", folderID), `{"username":"alice"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("grant: %d", w.Code)
	}
	if w, _ := kbReq(t, r, "PUT", fmt.Sprintf("/api/admin/kb/folders/%d/grant", folderID), `{"group":"devs"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("grant group: %d", w.Code)
	}
	// list grants
	w, out = kbReq(t, r, "GET", fmt.Sprintf("/api/admin/kb/folders/%d/grants", folderID), "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("list grants: %d %s", w.Code, w.Body.String())
	}
	users := out["users"].([]any)
	groups := out["groups"].([]any)
	if len(users) != 1 || users[0] != "alice" || len(groups) != 1 || groups[0] != "devs" {
		t.Fatalf("grants = %v %v", users, groups)
	}
	// revoke user grant → permission check drops the folder immediately
	if w, _ := kbReq(t, r, "DELETE", fmt.Sprintf("/api/admin/kb/folders/%d/grant", folderID), `{"username":"alice"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("revoke: %d", w.Code)
	}
	accessible, err := serverstore.GetAccessibleFolderIDs(db, "alice", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range accessible {
		if id == folderID {
			t.Fatal("alice still has access after revoke")
		}
	}
	// revoke again (idempotent) and missing body validation
	if w, _ := kbReq(t, r, "DELETE", fmt.Sprintf("/api/admin/kb/folders/%d/grant", folderID), `{"username":"alice"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("revoke twice: %d", w.Code)
	}
	if w, _ := kbReq(t, r, "DELETE", fmt.Sprintf("/api/admin/kb/folders/%d/grant", folderID), `{}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("revoke empty body: %d", w.Code)
	}
	// revoke group grant
	if w, _ := kbReq(t, r, "DELETE", fmt.Sprintf("/api/admin/kb/folders/%d/grant", folderID), `{"group":"devs"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("revoke group: %d", w.Code)
	}
	w, out = kbReq(t, r, "GET", fmt.Sprintf("/api/admin/kb/folders/%d/grants", folderID), "", hdr)
	if len(out["users"].([]any)) != 0 || len(out["groups"].([]any)) != 0 {
		t.Fatalf("grants after revoke = %v", out)
	}
}

func TestAdminKBDocUpdate(t *testing.T) {
	r, db, hdr, _ := kbAdminSetup(t)
	defer db.Close()

	w, out := kbReq(t, r, "POST", "/api/admin/kb/upload",
		`{"title":"变更日志","content":"旧版本功能描述","content_type":"text","folder_id":0}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("upload: %d %s", w.Code, w.Body.String())
	}
	docID := int64(out["doc"].(map[string]any)["id"].(float64))

	// fetch single doc for editing
	w, out = kbReq(t, r, "GET", fmt.Sprintf("/api/admin/kb/documents/%d", docID), "", hdr)
	if w.Code != http.StatusOK || out["doc"].(map[string]any)["content"] != "旧版本功能描述" {
		t.Fatalf("get doc: %d %s", w.Code, w.Body.String())
	}
	// update title + content
	if w, _ := kbReq(t, r, "PUT", fmt.Sprintf("/api/admin/kb/documents/%d", docID),
		`{"title":"更新日志","content":"全新特性描述"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("update: %d %s", w.Code, w.Body.String())
	}
	// new content searchable, old content gone, title updated
	if w, out = kbReq(t, r, "GET", "/api/admin/kb/search?q=全新特性", "", hdr); w.Code != http.StatusOK || len(out["results"].([]any)) != 1 {
		t.Fatalf("search new content: %d %s", w.Code, w.Body.String())
	}
	if w, out = kbReq(t, r, "GET", "/api/admin/kb/search?q=旧版本功能", "", hdr); w.Code != http.StatusOK || len(out["results"].([]any)) != 0 {
		t.Fatalf("search old content: %d %s", w.Code, w.Body.String())
	}
	w, out = kbReq(t, r, "GET", "/api/admin/kb/search?q=更新日志", "", hdr)
	if w.Code != http.StatusOK || len(out["results"].([]any)) != 1 || out["results"].([]any)[0].(map[string]any)["title"] != "更新日志" {
		t.Fatalf("search title: %d %s", w.Code, w.Body.String())
	}
	// audit log entry written for the update
	logs, err := serverstore.ListAuditLogs(db, 10)
	if err != nil || len(logs) != 2 {
		t.Fatalf("audit logs = %v %v", logs, err)
	}
	// validation: empty title, nonexistent id, oversized content
	if w, _ := kbReq(t, r, "PUT", fmt.Sprintf("/api/admin/kb/documents/%d", docID), `{"title":"","content":"x"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("empty title: %d", w.Code)
	}
	if w, _ := kbReq(t, r, "PUT", "/api/admin/kb/documents/99999", `{"title":"t","content":"x"}`, hdr); w.Code != http.StatusNotFound {
		t.Fatalf("nonexistent: %d", w.Code)
	}
	big := strings.Repeat("字", (1<<20)+1)
	if w, _ := kbReq(t, r, "PUT", fmt.Sprintf("/api/admin/kb/documents/%d", docID), `{"title":"t","content":"`+big+`"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("oversized: %d", w.Code)
	}
}

func TestAdminKBUploadMultipartTxt(t *testing.T) {
	r, db, hdr, uploadsDir := kbAdminSetup(t)
	defer db.Close()

	content := "第一条需求是支持多文件上传"
	w, out := kbMultipart(t, r, map[string]string{"title": "需求文档", "folder_id": "0"}, "需求.txt", []byte(content), hdr)
	if w.Code != http.StatusAccepted {
		t.Fatalf("txt upload: %d %s", w.Code, w.Body.String())
	}
	docID := int64(out["doc"].(map[string]any)["id"].(float64))
	if out["doc"].(map[string]any)["status"] != "pending" {
		t.Fatalf("upload status = %v", out)
	}
	// not searchable until the async queue processes it
	if w, out = kbReq(t, r, "GET", "/api/admin/kb/search?q=多文件上传", "", hdr); w.Code != http.StatusOK || len(out["results"].([]any)) != 0 {
		t.Fatalf("search before process: %d %s", w.Code, w.Body.String())
	}
	for processNextPending(db, uploadsDir) {
	}
	doc, err := serverstore.GetKBDocument(db, docID)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Status != "ready" || doc.Content != content || doc.Size != int64(len(content)) {
		t.Fatalf("doc = %+v", doc)
	}
	// title missing → defaults to filename
	w, out = kbMultipart(t, r, map[string]string{"folder_id": "0"}, "默认标题.txt", []byte("备用内容"), hdr)
	if w.Code != http.StatusAccepted || out["doc"].(map[string]any)["title"] != "默认标题.txt" {
		t.Fatalf("default title: %d %s", w.Code, w.Body.String())
	}
	for processNextPending(db, uploadsDir) {
	}
	// extractable via admin search (LIKE fallback)
	if w, out = kbReq(t, r, "GET", "/api/admin/kb/search?q=多文件上传", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("search: %d", w.Code)
	}
	if len(out["results"].([]any)) == 0 {
		t.Fatal("search found nothing")
	}
	// oversize file rejected synchronously (no pending row)
	big := make([]byte, maxUploadBytes+1)
	if w, _ := kbMultipart(t, r, map[string]string{"title": "太大"}, "大.txt", big, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("oversize: %d %s", w.Code, w.Body.String())
	}
	// 审计 6-K5: folder_id must parse and exist
	if w, _ := kbMultipart(t, r, map[string]string{"title": "坏目录", "folder_id": "99999"}, "x.txt", []byte("x"), hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("unknown folder_id: %d %s", w.Code, w.Body.String())
	}
	if w, _ := kbMultipart(t, r, map[string]string{"title": "坏目录", "folder_id": "abc"}, "x.txt", []byte("x"), hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("non-numeric folder_id: %d %s", w.Code, w.Body.String())
	}
}

func TestAdminKBUploadMultipartDocx(t *testing.T) {
	r, db, hdr, uploadsDir := kbAdminSetup(t)
	defer db.Close()

	docx := minimalDocx(t, `<?xml version="1.0"?><w:document><w:body>
		<w:p><w:r><w:t>Docx 第一段内容</w:t></w:r></w:p>
		<w:p><w:r><w:t>A &amp; B 第二段</w:t></w:r></w:p>
	</w:body></w:document>`)
	w, out := kbMultipart(t, r, map[string]string{"title": "产品说明", "folder_id": "0"}, "说明.docx", docx, hdr)
	if w.Code != http.StatusAccepted {
		t.Fatalf("docx upload: %d %s", w.Code, w.Body.String())
	}
	docID := int64(out["doc"].(map[string]any)["id"].(float64))
	for processNextPending(db, uploadsDir) {
	}
	doc, err := serverstore.GetKBDocument(db, docID)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Status != "ready" || !strings.Contains(doc.Content, "Docx 第一段内容") || !strings.Contains(doc.Content, "A & B 第二段") {
		t.Fatalf("extracted = %+v", doc)
	}
	if doc.ContentType != "docx" {
		t.Fatalf("content type = %q", doc.ContentType)
	}
	// broken zip → accepted, then error status with message, excluded from search
	w, out = kbMultipart(t, r, map[string]string{"title": "坏文件"}, "坏.docx", []byte("not a zip"), hdr)
	if w.Code != http.StatusAccepted {
		t.Fatalf("bad docx: %d %s", w.Code, w.Body.String())
	}
	badID := int64(out["doc"].(map[string]any)["id"].(float64))
	for processNextPending(db, uploadsDir) {
	}
	doc, err = serverstore.GetKBDocument(db, badID)
	if err != nil || doc.Status != "error" || !strings.Contains(doc.Error, "docx") {
		t.Fatalf("bad docx status = %+v %v", doc, err)
	}
	if w, out = kbReq(t, r, "GET", "/api/admin/kb/search?q=坏文件", "", hdr); w.Code != http.StatusOK || len(out["results"].([]any)) != 0 {
		t.Fatalf("search failed doc: %d %s", w.Code, w.Body.String())
	}
	// retry re-queues and fails again (raw file kept for future OCR)
	if w, _ := kbReq(t, r, "POST", fmt.Sprintf("/api/admin/kb/documents/%d/retry", badID), "", hdr); w.Code != http.StatusOK {
		t.Fatalf("retry: %d", w.Code)
	}
	doc, _ = serverstore.GetKBDocument(db, badID)
	if doc.Status != "pending" || doc.Error != "" {
		t.Fatalf("after retry = %+v", doc)
	}
	for processNextPending(db, uploadsDir) {
	}
	doc, _ = serverstore.GetKBDocument(db, badID)
	if doc.Status != "error" {
		t.Fatalf("after retry+process = %+v", doc)
	}
	if w, _ := kbReq(t, r, "POST", "/api/admin/kb/documents/99999/retry", "", hdr); w.Code != http.StatusNotFound {
		t.Fatalf("retry missing: %d", w.Code)
	}
	// retrying a ready doc is rejected (its raw file is already gone)
	if w, _ := kbReq(t, r, "POST", fmt.Sprintf("/api/admin/kb/documents/%d/retry", docID), "", hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("retry ready: %d", w.Code)
	}
	// deleting a pending upload also removes its raw file
	w, out = kbMultipart(t, r, map[string]string{"title": "待删"}, "删.txt", []byte("x"), hdr)
	delID := int64(out["doc"].(map[string]any)["id"].(float64))
	rawPath := filepath.Join(uploadsDir, fmt.Sprintf("%d", delID))
	if _, err := os.Stat(rawPath); err != nil {
		t.Fatalf("raw file missing after upload: %v", err)
	}
	if w, _ := kbReq(t, r, "DELETE", fmt.Sprintf("/api/admin/kb/documents/%d", delID), "", hdr); w.Code != http.StatusOK {
		t.Fatalf("delete: %d", w.Code)
	}
	if _, err := os.Stat(rawPath); !os.IsNotExist(err) {
		t.Fatalf("raw file still present after delete: %v", err)
	}
}

func TestAdminKBUploadMultipartPDFErrors(t *testing.T) {
	r, db, hdr, uploadsDir := kbAdminSetup(t)
	// a garbage pdf is accepted, then marked error with a message (not a 500;
	// OCR is a later round)
	w, out := kbMultipart(t, r, map[string]string{"title": "假pdf"}, "假.pdf", []byte("%PDF-1.4\ngarbage"), hdr)
	if w.Code != http.StatusAccepted {
		t.Fatalf("bad pdf upload: %d %s", w.Code, w.Body.String())
	}
	docID := int64(out["doc"].(map[string]any)["id"].(float64))
	for processNextPending(db, uploadsDir) {
	}
	doc, err := serverstore.GetKBDocument(db, docID)
	if err != nil || doc.Status != "error" || !strings.Contains(doc.Error, "pdf") {
		t.Fatalf("bad pdf status = %+v %v", doc, err)
	}
	// unsupported extension rejected synchronously
	if w, _ := kbMultipart(t, r, map[string]string{"title": "病毒"}, "evil.exe", []byte("MZ"), hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("bad ext: %d", w.Code)
	}
}

// 审计 6-W2: the admin search preview honors page/size and reports total.
func TestAdminKBSearchPaged(t *testing.T) {
	r, db, hdr, _ := kbAdminSetup(t)
	defer db.Close()
	for i := 0; i < 25; i++ {
		if w, _ := kbReq(t, r, "POST", "/api/admin/kb/upload",
			fmt.Sprintf(`{"title":"搜索文档%d","content":"搜索目标内容","folder_id":0}`, i), hdr); w.Code != http.StatusOK {
			t.Fatalf("upload %d: %d", i, w.Code)
		}
	}
	w, out := kbReq(t, r, "GET", "/api/admin/kb/search?q=搜索目标&page=2&size=10", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("search: %d %s", w.Code, w.Body.String())
	}
	if total := out["total"].(float64); total != 25 {
		t.Fatalf("total = %v, want 25", total)
	}
	if results := out["results"].([]any); len(results) != 10 {
		t.Fatalf("page2 len = %d, want 10", len(results))
	}
	w, out = kbReq(t, r, "GET", "/api/admin/kb/search?q=搜索目标&page=3&size=10", "", hdr)
	if w.Code != http.StatusOK || len(out["results"].([]any)) != 5 {
		t.Fatalf("page3 = %d %s", w.Code, w.Body.String())
	}
}

func TestAdminKBPagedDocsAndAudit(t *testing.T) {
	r, db, hdr, _ := kbAdminSetup(t)
	defer db.Close()
	for i := 0; i < 5; i++ {
		if w, _ := kbReq(t, r, "POST", "/api/admin/kb/upload",
			fmt.Sprintf(`{"title":"文档%d","content":"内容%d","folder_id":0}`, i, i), hdr); w.Code != http.StatusOK {
			t.Fatalf("upload %d: %d", i, w.Code)
		}
	}
	// paginated documents: page 2 size 2 → 2 docs, total 5
	w, out := kbReq(t, r, "GET", "/api/admin/kb/documents?folder_id=0&page=2&size=2", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("docs: %d", w.Code)
	}
	if total := out["total"].(float64); total != 5 {
		t.Fatalf("total = %v", total)
	}
	if docs := out["documents"].([]any); len(docs) != 2 || docs[0].(map[string]any)["title"] != "文档2" {
		t.Fatalf("docs = %v", docs)
	}
	// audit endpoint lists uploads newest first, paged
	w, out = kbReq(t, r, "GET", "/api/admin/kb/audit?page=1&size=3", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("audit: %d", w.Code)
	}
	if total := out["total"].(float64); total != 5 {
		t.Fatalf("audit total = %v", total)
	}
	logs := out["logs"].([]any)
	if len(logs) != 3 || logs[0].(map[string]any)["action"] != "kb_upload" {
		t.Fatalf("logs = %v", logs)
	}
}

// 文件夹删除:空文件夹可删;有文档/授权 → 拒绝
func TestAdminDeleteFolder(t *testing.T) {
	r, db, hdr, _ := kbAdminSetup(t)
	defer db.Close()
	w, out := kbReq(t, r, "POST", "/api/admin/kb/folders", `{"name":"空文件夹"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create: %d", w.Code)
	}
	fid := int64(out["folder"].(map[string]any)["id"].(float64))
	// 空 → 可删
	if w, _ := kbReq(t, r, "DELETE", fmt.Sprintf("/api/admin/kb/folders/%d", fid), "", hdr); w.Code != http.StatusOK {
		t.Fatalf("delete empty: %d %s", w.Code, w.Body.String())
	}
	// 有文档 → 拒绝
	w, out = kbReq(t, r, "POST", "/api/admin/kb/folders", `{"name":"有文档"}`, hdr)
	fid2 := int64(out["folder"].(map[string]any)["id"].(float64))
	if _, err := IndexDocument(db, fid2, "x", "y", "text", "upload", "admin"); err != nil {
		t.Fatal(err)
	}
	if w, _ := kbReq(t, r, "DELETE", fmt.Sprintf("/api/admin/kb/folders/%d", fid2), "", hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("delete with docs = %d, want 400", w.Code)
	}
	// 有授权 → 拒绝
	w, out = kbReq(t, r, "POST", "/api/admin/kb/folders", `{"name":"有授权"}`, hdr)
	fid3 := int64(out["folder"].(map[string]any)["id"].(float64))
	if _, err := serverstore.CreateDepartment(db, "研发部", 0, 0, ""); err != nil {
		t.Fatal(err)
	}
	if w, _ := kbReq(t, r, "PUT", fmt.Sprintf("/api/admin/kb/folders/%d/grant", fid3), `{"group":"研发部"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("grant: %d", w.Code)
	}
	if w, _ := kbReq(t, r, "DELETE", fmt.Sprintf("/api/admin/kb/folders/%d", fid3), "", hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("delete with grants = %d, want 400", w.Code)
	}
	// 有子文件夹 → 拒绝(删除父目录不得把子文件夹悬挂为孤儿)
	w, out = kbReq(t, r, "POST", "/api/admin/kb/folders", `{"name":"父目录"}`, hdr)
	parentID := int64(out["folder"].(map[string]any)["id"].(float64))
	if w, _ := kbReq(t, r, "POST", "/api/admin/kb/folders", fmt.Sprintf(`{"name":"子目录","parent_id":%d}`, parentID), hdr); w.Code != http.StatusOK {
		t.Fatalf("create child: %d", w.Code)
	}
	if w, _ := kbReq(t, r, "DELETE", fmt.Sprintf("/api/admin/kb/folders/%d", parentID), "", hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("delete with children = %d, want 400", w.Code)
	}
	// JSON 上传不存在的 folder_id → 400(与 multipart 同口径)
	if w, _ := kbReq(t, r, "POST", "/api/admin/kb/upload", `{"title":"x","content":"y","folder_id":99999}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("json upload unknown folder_id = %d, want 400", w.Code)
	}
	// 不存在 → 404
	if w, _ := kbReq(t, r, "DELETE", "/api/admin/kb/folders/99999", "", hdr); w.Code != http.StatusNotFound {
		t.Fatalf("delete missing = %d, want 404", w.Code)
	}
}

// H3: editing a pending/processing document must be rejected — the async
// worker would later overwrite the edit with the raw file extraction.
func TestUpdateDocRejectsPending(t *testing.T) {
	r, db, hdr, _ := kbAdminSetup(t)
	defer db.Close()
	id, err := serverstore.CreatePendingKBDocument(db, 0, "处理中", "text", 5, "upload", "admin")
	if err != nil || id == 0 {
		t.Fatal(err)
	}
	w, out := kbReq(t, r, "PUT", fmt.Sprintf("/api/admin/kb/documents/%d", id),
		`{"title":"改标题","content":"改内容"}`, hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("edit pending = %d %s, want 400", w.Code, w.Body.String())
	}
	if code := out["error"].(map[string]any)["code"]; code != "VALIDATION" {
		t.Fatalf("error code = %v, want VALIDATION", code)
	}
}

// H3: editing an error document adopts it — the edit takes over, the row
// becomes ready, and the raw file is removed so a later retry can never
// clobber the edited content.
func TestUpdateDocAdoptsError(t *testing.T) {
	r, db, hdr, uploadsDir := kbAdminSetup(t)
	defer db.Close()
	id, err := serverstore.CreatePendingKBDocument(db, 0, "坏文档", "text", 5, "upload", "admin")
	if err != nil || id == 0 {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE kb_documents SET status='error', error='提取失败' WHERE id=?", id); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(uploadsDir, fmt.Sprint(id)), []byte("原始内容"), 0644); err != nil {
		t.Fatal(err)
	}
	w, _ := kbReq(t, r, "PUT", fmt.Sprintf("/api/admin/kb/documents/%d", id),
		`{"title":"修复后标题","content":"修复后内容"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("edit error doc = %d %s, want 200", w.Code, w.Body.String())
	}
	doc, err := serverstore.GetKBDocument(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if doc.Status != "ready" || doc.Error != "" || doc.Content != "修复后内容" || doc.Title != "修复后标题" {
		t.Fatalf("doc after adopt = %+v", doc)
	}
	if _, err := os.Stat(filepath.Join(uploadsDir, fmt.Sprint(id))); !os.IsNotExist(err) {
		t.Fatalf("raw file must be removed after edit adopts the doc")
	}
	// a retry after the edit is a no-op (already ready) — the edit survives
	if w, _ := kbReq(t, r, "POST", fmt.Sprintf("/api/admin/kb/documents/%d/retry", id), "", hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("retry after adopt = %d, want 400 (already ready)", w.Code)
	}
}

// M2: search supports an optional folder_id filter (0/-1/absent = all).
func TestAdminKBSearchFolderFilter(t *testing.T) {
	r, db, hdr, _ := kbAdminSetup(t)
	defer db.Close()
	w, out := kbReq(t, r, "POST", "/api/admin/kb/folders", `{"name":"A部"}`, hdr)
	fa := int64(out["folder"].(map[string]any)["id"].(float64))
	w, out = kbReq(t, r, "POST", "/api/admin/kb/folders", `{"name":"B部"}`, hdr)
	fb := int64(out["folder"].(map[string]any)["id"].(float64))
	if w.Code != http.StatusOK {
		t.Fatalf("create folder: %d", w.Code)
	}
	if _, out = kbReq(t, r, "POST", "/api/admin/kb/upload",
		fmt.Sprintf(`{"title":"共同主题A","content":"项目进展 汇报","content_type":"text","folder_id":%d}`, fa), hdr); w.Code != http.StatusOK {
		t.Fatalf("upload A: %d %s", w.Code, out)
	}
	if _, out = kbReq(t, r, "POST", "/api/admin/kb/upload",
		fmt.Sprintf(`{"title":"共同主题B","content":"项目进展 汇报","content_type":"text","folder_id":%d}`, fb), hdr); w.Code != http.StatusOK {
		t.Fatalf("upload B: %d %s", w.Code, out)
	}
	// unfiltered → 2
	w, out = kbReq(t, r, "GET", "/api/admin/kb/search?q=项目进展", "", hdr)
	if w.Code != http.StatusOK || int64(out["total"].(float64)) != 2 {
		t.Fatalf("unfiltered total = %v (%d), want 2", out["total"], w.Code)
	}
	// filtered by fa → 1
	w, out = kbReq(t, r, "GET", fmt.Sprintf("/api/admin/kb/search?q=项目进展&folder_id=%d", fa), "", hdr)
	if w.Code != http.StatusOK || int64(out["total"].(float64)) != 1 {
		t.Fatalf("filtered total = %v (%d), want 1", out["total"], w.Code)
	}
	if r0 := out["results"].([]any)[0].(map[string]any); int64(r0["folder_id"].(float64)) != fa {
		t.Fatalf("result folder = %v, want %d", r0["folder_id"], fa)
	}
}

// M4: folder_id=-1 lists documents across every folder.
func TestAdminKBListAllDocuments(t *testing.T) {
	r, db, hdr, _ := kbAdminSetup(t)
	defer db.Close()
	_, out := kbReq(t, r, "POST", "/api/admin/kb/folders", `{"name":"A部"}`, hdr)
	fa := int64(out["folder"].(map[string]any)["id"].(float64))
	_, out = kbReq(t, r, "POST", "/api/admin/kb/folders", `{"name":"B部"}`, hdr)
	fb := int64(out["folder"].(map[string]any)["id"].(float64))
	kbReq(t, r, "POST", "/api/admin/kb/upload", fmt.Sprintf(`{"title":"a文档","content":"x","content_type":"text","folder_id":%d}`, fa), hdr)
	kbReq(t, r, "POST", "/api/admin/kb/upload", fmt.Sprintf(`{"title":"b文档","content":"y","content_type":"text","folder_id":%d}`, fb), hdr)
	w, out := kbReq(t, r, "GET", fmt.Sprintf("/api/admin/kb/documents?folder_id=%d&page=1&size=20", fa), "", hdr)
	if int64(out["total"].(float64)) != 1 {
		t.Fatalf("folder A total = %v, want 1", out["total"])
	}
	w, out = kbReq(t, r, "GET", "/api/admin/kb/documents?folder_id=-1&page=1&size=20", "", hdr)
	if w.Code != http.StatusOK || int64(out["total"].(float64)) != 2 {
		t.Fatalf("all total = %v (%d), want 2", out["total"], w.Code)
	}
}

// M6: embedding model must exist in the gateway models list (when any
// model is known); empty model clears the config (pure lexical).
func TestSetEmbeddingModelValidates(t *testing.T) {
	r, db, hdr, _ := kbAdminSetup(t)
	defer db.Close()
	// models table empty → cannot validate, allow
	if w, _ := kbReq(t, r, "PUT", "/api/admin/kb/embedding-model", `{"model":"bge-m3"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("set with empty models table = %d, want 200", w.Code)
	}
	if _, err := db.Exec("INSERT INTO gateway_providers (name, base_url, api_key_enc) VALUES ('p1', 'http://x', 'enc')"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO models (name, provider_id) VALUES ('bge-m3', 1)"); err != nil {
		t.Fatal(err)
	}
	if w, _ := kbReq(t, r, "PUT", "/api/admin/kb/embedding-model", `{"model":"bge-m3"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("set existing model = %d, want 200", w.Code)
	}
	if w, out := kbReq(t, r, "PUT", "/api/admin/kb/embedding-model", `{"model":"不存在的模型"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("set unknown model = %d %s, want 400", w.Code, w.Body.String())
	} else if code := out["error"].(map[string]any)["code"]; code != "VALIDATION" {
		t.Fatalf("code = %v, want VALIDATION", code)
	}
	// clearing is always allowed
	if w, _ := kbReq(t, r, "PUT", "/api/admin/kb/embedding-model", `{"model":""}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("clear model = %d, want 200", w.Code)
	}
}

// M9: revoke/list grants on a missing folder → 404 (consistent with grant).
func TestGrantEndpointsMissingFolder(t *testing.T) {
	r, db, hdr, _ := kbAdminSetup(t)
	defer db.Close()
	if w, _ := kbReq(t, r, "DELETE", "/api/admin/kb/folders/99999/grant", `{"group":"研发"}`, hdr); w.Code != http.StatusNotFound {
		t.Fatalf("revoke missing folder = %d, want 404", w.Code)
	}
	if w, _ := kbReq(t, r, "GET", "/api/admin/kb/folders/99999/grants", "", hdr); w.Code != http.StatusNotFound {
		t.Fatalf("list grants missing folder = %d, want 404", w.Code)
	}
}

// M8: audit list supports action filtering.
func TestAuditFilter(t *testing.T) {
	r, db, hdr, _ := kbAdminSetup(t)
	defer db.Close()
	kbReq(t, r, "POST", "/api/admin/kb/upload", `{"title":"t","content":"x","content_type":"text","folder_id":0}`, hdr)
	w, out := kbReq(t, r, "GET", "/api/admin/kb/audit?action=kb_upload", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("audit filtered: %d", w.Code)
	}
	if int64(out["total"].(float64)) != 1 {
		t.Fatalf("filtered total = %v, want 1", out["total"])
	}
	w, out = kbReq(t, r, "GET", "/api/admin/kb/audit?action=kb_delete", "", hdr)
	if int64(out["total"].(float64)) != 0 {
		t.Fatalf("delete-filtered total = %v, want 0", out["total"])
	}
}
