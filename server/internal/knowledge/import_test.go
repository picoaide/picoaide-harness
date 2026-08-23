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
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// buildZip creates an in-memory zip with the given files (name → content).
func buildZip(t *testing.T, files map[string]string) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
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
	return &buf
}

func postZip(t *testing.T, r http.Handler, hdr map[string]string, path, zipName string, zipData *bytes.Buffer) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, err := mw.CreateFormFile("file", zipName)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(zipData.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", path, &body)
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

func drainQueue(db *sql.DB, uploadsDir string, max int) {
	for i := 0; i < max; i++ {
		if !processNextPending(db, uploadsDir) {
			return
		}
	}
}

func TestImportZipBatch(t *testing.T) {
	r, db, hdr, uploadsDir := kbAdminSetup(t)
	defer db.Close()
	zipData := buildZip(t, map[string]string{
		"手册.md":         "知识库使用手册内容",
		"说明.txt":        "报销政策说明",
		"../穿越.txt":     "路径穿越内容", // basename sanitized
		"sub/内层.txt":    "嵌套目录内容",
		"program.exe":   "不支持的文件",
		"notes/大纲.docx": "",
	})
	w, out := postZip(t, r, hdr, "/api/admin/kb/import-zip", "batch.zip", zipData)
	if w.Code != http.StatusOK {
		t.Fatalf("import-zip: %d %s", w.Code, w.Body.String())
	}
	accepted := int(out["accepted"].(float64))
	if accepted != 5 {
		t.Fatalf("accepted = %d, want 5", accepted)
	}
	if skipped := out["skipped"].([]any); len(skipped) != 1 {
		t.Fatalf("skipped = %v, want 1", skipped)
	}
	// queue drains → all accepted docs ready and searchable
	drainQueue(db, uploadsDir, 10)
	w, out = kbReq(t, r, "GET", "/api/admin/kb/search?q=报销政策", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("search: %d", w.Code)
	}
	total := int64(out["total"].(float64))
	if total != 1 {
		t.Fatalf("search total = %d, want 1", total)
	}
}

func TestImportZipRejectsTooManyFiles(t *testing.T) {
	r, db, hdr, _ := kbAdminSetup(t)
	defer db.Close()
	files := map[string]string{}
	for i := 0; i < maxZipFiles+1; i++ {
		files[fmt.Sprintf("f%d.txt", i)] = "x"
	}
	zipData := buildZip(t, files)
	w, _ := postZip(t, r, hdr, "/api/admin/kb/import-zip", "big.zip", zipData)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestImportZipEmptyZip(t *testing.T) {
	r, db, hdr, _ := kbAdminSetup(t)
	defer db.Close()
	zipData := buildZip(t, map[string]string{})
	w, out := postZip(t, r, hdr, "/api/admin/kb/import-zip", "empty.zip", zipData)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d %s", w.Code, w.Body.String())
	}
	if accepted := int(out["accepted"].(float64)); accepted != 0 {
		t.Fatalf("accepted = %d, want 0", accepted)
	}
}

func TestImportStatus(t *testing.T) {
	r, db, hdr, uploadsDir := kbAdminSetup(t)
	defer db.Close()
	zipData := buildZip(t, map[string]string{"a.txt": "甲文档内容", "b.md": "乙文档内容"})
	postZip(t, r, hdr, "/api/admin/kb/import-zip", "two.zip", zipData)

	w, out := kbReq(t, r, "GET", "/api/admin/kb/import-status", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("import-status: %d", w.Code)
	}
	status := out["status"].(map[string]any)
	if int64(status["pending"].(float64)) != 2 {
		t.Fatalf("pending = %v, want 2", status["pending"])
	}

	drainQueue(db, uploadsDir, 5)
	w, out = kbReq(t, r, "GET", "/api/admin/kb/import-status", "", hdr)
	status = out["status"].(map[string]any)
	if int64(status["ready"].(float64)) != 2 || int64(status["pending"].(float64)) != 0 {
		t.Fatalf("after drain: %v", status)
	}
}

// H1: import-status must enumerate the processing state and count it in the
// total, so the front-end poll condition (pending==0) can never freeze while
// a worker is mid-extraction.
func TestImportStatusIncludesProcessing(t *testing.T) {
	r, db, hdr, _ := kbAdminSetup(t)
	defer db.Close()
	zipData := buildZip(t, map[string]string{"a.txt": "甲文档内容", "b.md": "乙文档内容"})
	postZip(t, r, hdr, "/api/admin/kb/import-zip", "two.zip", zipData)
	// claim one row (pending → processing), simulating a busy worker
	if _, err := serverstore.ClaimPendingKBDocument(db); err != nil {
		t.Fatal(err)
	}
	w, out := kbReq(t, r, "GET", "/api/admin/kb/import-status", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("import-status: %d %s", w.Code, w.Body.String())
	}
	status := out["status"].(map[string]any)
	if int64(status["processing"].(float64)) != 1 {
		t.Fatalf("processing = %v, want 1", status["processing"])
	}
	if int64(status["pending"].(float64)) != 1 {
		t.Fatalf("pending = %v, want 1", status["pending"])
	}
	if int64(status["total"].(float64)) != 2 {
		t.Fatalf("total = %v, want 2 (must include processing)", status["total"])
	}
}

func TestImportStatusErrors(t *testing.T) {
	r, db, hdr, uploadsDir := kbAdminSetup(t)
	defer db.Close()
	// fake docx will fail extraction
	zipData := buildZip(t, map[string]string{"bad.docx": "not a real docx"})
	postZip(t, r, hdr, "/api/admin/kb/import-zip", "bad.zip", zipData)
	drainQueue(db, uploadsDir, 3)
	_, out := kbReq(t, r, "GET", "/api/admin/kb/import-status", "", hdr)
	status := out["status"].(map[string]any)
	if int64(status["error"].(float64)) != 1 {
		t.Fatalf("error = %v, want 1", status["error"])
	}
	errors := out["errors"].([]any)
	if len(errors) != 1 {
		t.Fatalf("errors = %v, want 1 row", errors)
	}
	if errMsg := errors[0].(map[string]any)["error"].(string); errMsg == "" {
		t.Fatal("error detail empty")
	}
	if !strings.Contains(errors[0].(map[string]any)["title"].(string), "bad.docx") {
		t.Fatalf("error title: %v", errors[0])
	}
}
