package knowledge

import (
	"archive/zip"
	"database/sql"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

const (
	maxZipBytes        = 64 << 20          // whole-zip cap
	maxZipFiles        = 200               // per-zip entry cap (zip bomb / batch sanity)
	maxZipUncompressed = uint64(512 << 20) // total uncompressed cap across entries
)

// importZip accepts a zip of txt/md/docx/pdf files, enqueues each entry as a
// pending upload and lets the async queue extract them (batch import for
// thousands of documents). Entry names are sanitized to basenames (no path
// traversal); unsupported files are skipped with a reason.
func importZip(c *gin.Context, db *sql.DB, uploadsDir string) {
	fh, err := c.FormFile("file")
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "缺少 file 文件字段")
		return
	}
	folderID, err := strconv.ParseInt(c.DefaultPostForm("folder_id", "0"), 10, 64)
	if err != nil || folderID < 0 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "folder_id 无效")
		return
	}
	if folderID != 0 {
		var n int
		if err := db.QueryRow("SELECT COUNT(*) FROM kb_folders WHERE id = ?", folderID).Scan(&n); err != nil || n == 0 {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "folder_id 不存在")
			return
		}
	}
	src, err := fh.Open()
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "读取 zip 失败")
		return
	}
	defer src.Close()
	if fh.Size > maxZipBytes {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "zip 超过 64MB 上限")
		return
	}
	zr, err := zip.NewReader(src, fh.Size)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "不是有效的 zip 文件")
		return
	}
	if len(zr.File) > maxZipFiles {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "zip 内文件超过 "+strconv.Itoa(maxZipFiles)+" 个上限")
		return
	}

	username := adminUsername(c)
	accepted := 0
	var totalSize uint64
	skipped := make([]gin.H, 0, 4)
	for _, e := range zr.File {
		if e.FileInfo().IsDir() {
			continue
		}
		if totalSize+e.UncompressedSize64 > maxZipUncompressed {
			skipped = append(skipped, gin.H{"name": e.Name, "reason": "解压总量超过 512MB 上限"})
			continue
		}
		totalSize += e.UncompressedSize64
		title := filepath.Base(filepath.Clean(e.Name)) // no traversal, no dirs
		if title == "." || title == "/" || strings.HasPrefix(title, ".") {
			continue
		}
		contentType, cerr := classifyFile(title)
		if cerr != nil {
			skipped = append(skipped, gin.H{"name": e.Name, "reason": cerr.Error()})
			continue
		}
		if e.UncompressedSize64 > maxUploadBytes {
			skipped = append(skipped, gin.H{"name": e.Name, "reason": "超过 16MB 上限"})
			continue
		}
		rc, err := e.Open()
		if err != nil {
			skipped = append(skipped, gin.H{"name": e.Name, "reason": "读取失败"})
			continue
		}
		tmp, size, err := saveReader(rc, uploadsDir)
		rc.Close()
		if err != nil {
			skipped = append(skipped, gin.H{"name": e.Name, "reason": err.Error()})
			continue
		}
		id, err := serverstore.CreatePendingKBDocument(db, folderID, title, contentType, size, "import", username)
		if err != nil {
			os.Remove(tmp)
			continue
		}
		if err := os.Rename(tmp, filepath.Join(uploadsDir, strconv.FormatInt(id, 10))); err != nil {
			os.Remove(tmp)
			serverstore.DeleteKBDocument(db, id)
			continue
		}
		accepted++
	}
	_ = serverstore.AuditLog(db, username, "kb_import", "zip files="+strconv.Itoa(accepted)+" folder="+strconv.FormatInt(folderID, 10))
	c.JSON(http.StatusOK, gin.H{"accepted": accepted, "skipped": skipped})
}

// importStatus reports the ingestion dashboard for a folder (0 = all):
// counts by status plus the newest error rows.
func importStatus(c *gin.Context, db *sql.DB) {
	folderID, _ := strconv.ParseInt(c.DefaultQuery("folder_id", "0"), 10, 64)
	if folderID < 0 {
		folderID = 0
	}
	counts, errs, err := serverstore.CountKBDocumentsByStatus(db, folderID, 20)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	status := gin.H{}
	for _, s := range []string{"pending", "ready", "error"} {
		status[s] = counts[s] // int64, 0 when absent
	}
	total := status["pending"].(int64) + status["ready"].(int64) + status["error"].(int64)
	status["total"] = total
	missing, err := serverstore.CountChunksMissingEmbeddings(db)
	if err != nil {
		missing = -1
	}
	status["embed_missing"] = missing
	errorsOut := make([]gin.H, 0, len(errs))
	for _, d := range errs {
		errorsOut = append(errorsOut, gin.H{"id": d.ID, "title": d.Title, "error": d.Error})
	}
	c.JSON(http.StatusOK, gin.H{"status": status, "errors": errorsOut})
}

// saveReader streams r into a temp file in dir (kb-* prefix), enforcing
// maxUploadBytes; returns the temp path and byte count.
func saveReader(r io.Reader, dir string) (path string, size int64, err error) {
	dst, err := os.CreateTemp(dir, "kb-*")
	if err != nil {
		return "", 0, errors.New("保存文件失败")
	}
	defer func() {
		if err != nil {
			dst.Close()
			os.Remove(dst.Name())
		}
	}()
	n, err := io.Copy(dst, io.LimitReader(r, maxUploadBytes+1))
	if err != nil {
		return "", 0, errors.New("读取文件失败")
	}
	if n > maxUploadBytes {
		return "", 0, errors.New("文件超过 16MB 上限")
	}
	if err := dst.Close(); err != nil {
		return "", 0, errors.New("保存文件失败")
	}
	return dst.Name(), n, nil
}

// saveUpload is the multipart variant of saveReader (uploadDoc).
func saveUpload(fh *multipart.FileHeader, dir string) (path string, size int64, err error) {
	src, err := fh.Open()
	if err != nil {
		return "", 0, errors.New("读取文件失败")
	}
	defer src.Close()
	return saveReader(src, dir)
}
