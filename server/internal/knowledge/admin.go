package knowledge

import (
	"database/sql"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// RegisterAdminRoutes mounts /api/admin/kb/* behind AdminAuth. uploadsDir
// stores raw uploads awaiting async extraction (<dir>/<doc id>).
func RegisterAdminRoutes(r *gin.Engine, db *sql.DB, uploadsDir string) {
	os.MkdirAll(uploadsDir, 0700)
	// startup housekeeping: orphaned kb-* temp files (审计 6-K4) and audit
	// logs past the retention window (审计 6-K6)
	CleanupUploadTempFiles(uploadsDir)
	_ = serverstore.PurgeOldAuditLogs(db, time.Now().Add(-auditLogRetention))
	g := r.Group("/api/admin/kb", serverauth.AdminAuth(db))
	g.POST("/upload", func(c *gin.Context) { uploadDoc(c, db, uploadsDir) })
	g.POST("/import-zip", func(c *gin.Context) { importZip(c, db, uploadsDir) })
	g.GET("/import-status", func(c *gin.Context) { importStatus(c, db) })
	g.POST("/folders", func(c *gin.Context) { createFolder(c, db) })
	g.DELETE("/folders/:id", func(c *gin.Context) { deleteFolder(c, db) })
	g.GET("/folders", func(c *gin.Context) { listFolders(c, db) })
	g.GET("/documents", func(c *gin.Context) { listDocuments(c, db) })
	g.DELETE("/documents/:id", func(c *gin.Context) { deleteDoc(c, db, uploadsDir) })
	g.PUT("/documents/:id", func(c *gin.Context) { updateDoc(c, db, uploadsDir) })
	g.GET("/documents/:id", func(c *gin.Context) { getDoc(c, db) })
	g.POST("/documents/:id/retry", func(c *gin.Context) { retryDoc(c, db) })
	g.PUT("/folders/:id/grant", func(c *gin.Context) { grantFolder(c, db) })
	g.PUT("/folders/:id/grants", func(c *gin.Context) { replaceFolderGrants(c, db) })
	g.DELETE("/folders/:id/grant", func(c *gin.Context) { revokeGrant(c, db) })
	g.GET("/folders/:id/grants", func(c *gin.Context) { listGrants(c, db) })
	g.GET("/search", func(c *gin.Context) { search(c, db) })
	g.GET("/audit", func(c *gin.Context) { listAudit(c, db) })
	g.GET("/embedding-model", func(c *gin.Context) { getEmbeddingModel(c, db) })
	g.PUT("/embedding-model", func(c *gin.Context) { setEmbeddingModel(c, db) })
	g.POST("/embedding-reindex", func(c *gin.Context) { reindexEmbeddings(c, db) })
}

// getEmbeddingModel returns the configured embedding model ("" = disabled).
func getEmbeddingModel(c *gin.Context, db *sql.DB) {
	v, ok, err := GetEmbeddingModel(db)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if !ok {
		v = ""
	}
	c.JSON(http.StatusOK, gin.H{"model": v})
}

// setEmbeddingModel stores the embedding model name; chunks already
// indexed keep old vectors until a reindex (dims mismatch is skipped by
// the vector scan automatically). The model must exist in the gateway
// model list (when any model is known) so a typo surfaces immediately
// instead of silently idling the embedding loop (审计 M6).
func setEmbeddingModel(c *gin.Context, db *sql.DB) {
	var req struct {
		Model string `json:"model"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求格式错误")
		return
	}
	req.Model = strings.TrimSpace(req.Model)
	if req.Model != "" {
		var known int
		if err := db.QueryRow("SELECT COUNT(*) FROM models").Scan(&known); err != nil {
			known = 0
		}
		if known > 0 {
			var n int
			if err := db.QueryRow("SELECT COUNT(*) FROM models WHERE name = ?", req.Model).Scan(&n); err != nil || n == 0 {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "模型不在网关模型列表中: "+req.Model)
				return
			}
		}
	}
	if err := serverstore.SetSetting(db, EmbeddingModelSetting, req.Model); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "kb_embedding_model", req.Model)
	c.JSON(http.StatusOK, gin.H{"ok": true, "model": req.Model})
}

// reindexEmbeddings clears all chunk vectors; the background embedding
// loop rebuilds them (model change / corrupted index recovery). Refuses
// when no model is configured — clearing would orphan every vector (审计 L8).
func reindexEmbeddings(c *gin.Context, db *sql.DB) {
	model, ok, err := GetEmbeddingModel(db)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if !ok || model == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "未配置向量模型,无需重建")
		return
	}
	if err := serverstore.ClearChunkEmbeddings(db); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "重建失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "kb_embedding_reindex", "")
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func adminUsername(c *gin.Context) string {
	u := serverauth.AdminUser(c)
	if u == nil {
		return "admin"
	}
	return u.Username
}

// auditLogRetention bounds the kb audit log size (审计 6-K6).
const auditLogRetention = 90 * 24 * time.Hour

// CleanupUploadTempFiles removes orphaned kb-* temp files left by crashes
// mid-save (审计 6-K4). Numeric files are live raw uploads keyed by doc id
// and are kept.
func CleanupUploadTempFiles(uploadsDir string) {
	entries, err := os.ReadDir(uploadsDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "kb-") {
			os.Remove(filepath.Join(uploadsDir, e.Name()))
		}
	}
}

type kbUploadReq struct {
	Title       string `json:"title"`
	Content     string `json:"content"`
	FolderID    int64  `json:"folder_id"`
	ContentType string `json:"content_type"`
}

// uploadDoc uploads a single file (multipart) or JSON text (sync path).

func uploadDoc(c *gin.Context, db *sql.DB, uploadsDir string) {
	title := ""
	folderID := int64(0)
	var contentType string
	var err error

	if strings.HasPrefix(c.ContentType(), "multipart/form-data") {
		// M7: cap the request body before gin buffers the multipart — the
		// per-file limit must protect bandwidth/disk, not just reject late.
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxUploadBytes+64<<10)
		// file upload: txt/md/docx/pdf saved to disk, extraction runs in the
		// async queue; the response is 202 with status=pending
		var fh *multipart.FileHeader
		if fh, err = c.FormFile("file"); err != nil {
			if errors.As(err, new(*http.MaxBytesError)) {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "文件超过 16MB 上限")
				return
			}
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "缺少 file 文件字段")
			return
		}
		title = c.PostForm("title")
		if title == "" {
			title = fh.Filename
		}
		// 审计 6-K5: folder_id 必须可解析且存在(0/缺省 = 全局根目录)
		folderIDStr := c.PostForm("folder_id")
		if folderIDStr == "" {
			folderIDStr = "0"
		}
		folderID, err = strconv.ParseInt(folderIDStr, 10, 64)
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
		if contentType, err = classifyFile(fh.Filename); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", err.Error())
			return
		}
		tmp, size, err := saveUpload(fh, uploadsDir)
		if err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", err.Error())
			return
		}
		id, err := serverstore.CreatePendingKBDocument(db, folderID, title, contentType, size, "upload", adminUsername(c))
		if err != nil {
			os.Remove(tmp)
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "上传失败")
			return
		}
		if err := os.Rename(tmp, filepath.Join(uploadsDir, strconv.FormatInt(id, 10))); err != nil {
			os.Remove(tmp)
			serverstore.DeleteKBDocument(db, id)
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "上传失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), "kb_upload", "doc#"+strconv.FormatInt(id, 10)+" "+title)
		c.JSON(http.StatusAccepted, gin.H{"doc": gin.H{"id": id, "title": title, "status": "pending"}})
		return
	}

	var req kbUploadReq
	if err := c.ShouldBindJSON(&req); err != nil || req.Title == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "标题必填")
		return
	}
	title, content, contentType := req.Title, req.Content, req.ContentType
	if contentType == "" {
		contentType = "text"
	}
	folderID = req.FolderID
	if folderID < 0 {
		folderID = 0
	}
	// 与 multipart 路径同口径:folder_id 必须存在(0=根目录),防孤儿文档
	if folderID != 0 {
		var n int
		if err := db.QueryRow("SELECT COUNT(*) FROM kb_folders WHERE id = ?", folderID).Scan(&n); err != nil || n == 0 {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "folder_id 不存在")
			return
		}
	}
	id, err := IndexDocument(db, folderID, title, content, contentType, "admin", adminUsername(c))
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "上传失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "kb_upload", "doc#"+strconv.FormatInt(id, 10)+" "+title)
	c.JSON(http.StatusOK, gin.H{"doc": gin.H{"id": id, "title": title, "status": "ready"}})
}

func retryDoc(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	doc, err := serverstore.GetKBDocument(db, id)
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "文档不存在")
		return
	} else if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if doc.Status == "ready" {
		// the raw file is removed on success, so a retry could only break it
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "文档已就绪,无需重试")
		return
	}
	if err := serverstore.RetryKBDocument(db, id); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "重试失败")
		return
	}
	// 与其余变更端点一致:重排(可能改变文档内容)必须审计(审计2026-L17)
	_ = serverstore.AuditLog(db, adminUsername(c), "kb_retry", "doc#"+strconv.FormatInt(id, 10))
	c.JSON(http.StatusOK, gin.H{"ok": true, "doc": gin.H{"id": id, "status": "pending"}})
}

func createFolder(c *gin.Context, db *sql.DB) {
	var req struct {
		Name     string `json:"name"`
		ParentID int64  `json:"parent_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Name == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "名称必填")
		return
	}
	id, err := serverstore.CreateKBFolder(db, req.Name, req.ParentID)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"folder": gin.H{"id": id, "name": req.Name}})
}

func listFolders(c *gin.Context, db *sql.DB) {
	folders, err := serverstore.ListKBFolders(db)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	out := make([]gin.H, 0, len(folders))
	for _, f := range folders {
		out = append(out, gin.H{"id": f.ID, "name": f.Name, "parent_id": f.ParentID})
	}
	c.JSON(http.StatusOK, gin.H{"folders": out})
}

func listDocuments(c *gin.Context, db *sql.DB) {
	folderID, _ := strconv.ParseInt(c.DefaultQuery("folder_id", "0"), 10, 64)
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 200 {
		size = 20
	}
	var docs []serverstore.KBDocument
	var total int64
	var err error
	if folderID == -1 {
		// M4: "全部文档" 视图 — list across every folder
		docs, total, err = serverstore.ListAllKBDocumentsPaged(db, (page-1)*size, size)
	} else {
		docs, total, err = serverstore.ListKBDocumentsPaged(db, folderID, (page-1)*size, size)
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	out := make([]gin.H, 0, len(docs))
	for _, d := range docs {
		out = append(out, gin.H{"id": d.ID, "folder_id": d.FolderID, "title": d.Title,
			"content_type": d.ContentType, "size": d.Size, "created_by": d.CreatedBy,
			"status": d.Status, "error": d.Error})
	}
	c.JSON(http.StatusOK, gin.H{"documents": out, "total": total})
}

func listAudit(c *gin.Context, db *sql.DB) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "50"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 200 {
		size = 50
	}
	// M8: optional action/username filters
	logs, total, err := serverstore.ListAuditLogsPagedFiltered(db, (page-1)*size, size,
		c.Query("action"), c.Query("username"))
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	out := make([]gin.H, 0, len(logs))
	for _, l := range logs {
		out = append(out, gin.H{"id": l.ID, "username": l.Username, "action": l.Action,
			"detail": l.Detail, "created_at": l.CreatedAt.Format(time.RFC3339)})
	}
	c.JSON(http.StatusOK, gin.H{"logs": out, "total": total})
}

func deleteDoc(c *gin.Context, db *sql.DB, uploadsDir string) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	doc, err := serverstore.GetKBDocument(db, id)
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "文档不存在")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if err := serverstore.DeleteKBDocument(db, id); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
		return
	}
	os.Remove(filepath.Join(uploadsDir, strconv.FormatInt(id, 10))) // raw file, if still awaiting/kept
	_ = serverstore.AuditLog(db, adminUsername(c), "kb_delete", "doc#"+strconv.FormatInt(id, 10)+" "+doc.Title)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// folderExists reports whether a kb folder row exists (grant endpoints'
// 404 guard, 审计 M9).
func folderExists(db *sql.DB, id int64) bool {
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM kb_folders WHERE id = ?", id).Scan(&n); err != nil {
		return false
	}
	return n > 0
}

func grantFolder(c *gin.Context, db *sql.DB) {
	folderID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	// 校验 folder 存在(防孤儿授权落库)
	if !folderExists(db, folderID) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "文件夹不存在")
		return
	}
	var req struct {
		Username string `json:"username"`
		Group    string `json:"group"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || (req.Username == "" && req.Group == "") {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "username 或 group 必填")
		return
	}
	if req.Username != "" {
		// 拼错的用户名不应静默落库:用户必须存在
		if _, err := serverstore.GetUserByUsername(db, req.Username); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "用户不存在: "+req.Username)
			return
		}
		if err := serverstore.GrantFolderUser(db, folderID, req.Username); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "授权失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), "kb_grant", fmt.Sprintf("folder#%d user:%s", folderID, req.Username))
	} else {
		// 拼错的部门名不得静默建幽灵部门:组必须已存在
		if _, err := serverstore.GroupByName(db, req.Group); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "部门不存在: "+req.Group)
			return
		}
		if err := serverstore.GrantFolderGroup(db, folderID, req.Group); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "授权失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), "kb_grant", fmt.Sprintf("folder#%d group:%s", folderID, req.Group))
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func getDoc(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	doc, err := serverstore.GetKBDocument(db, id)
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "文档不存在")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"doc": gin.H{"id": doc.ID, "folder_id": doc.FolderID, "title": doc.Title,
		"content": doc.Content, "content_type": doc.ContentType, "status": doc.Status, "error": doc.Error}})
}

type kbUpdateReq struct {
	Title   string `json:"title"`
	Content string `json:"content"`
}

func updateDoc(c *gin.Context, db *sql.DB, uploadsDir string) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	var req kbUpdateReq
	if err := c.ShouldBindJSON(&req); err != nil || req.Title == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "标题必填")
		return
	}
	doc, err := serverstore.GetKBDocument(db, id)
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "文档不存在")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	// H3: pending/processing rows are owned by the async extraction queue —
	// editing them would be silently overwritten when the worker lands.
	if doc.Status == "pending" || doc.Status == "processing" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "文档处理中,暂不可编辑")
		return
	}
	if len(req.Content) > maxKBContent {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", fmt.Sprintf("文档内容超过上限 %d 字节", maxKBContent))
		return
	}
	if doc.Status == "error" {
		// H3: editing an error document adopts it — the edit takes over, the
		// row becomes ready and the stale raw file is removed so a later retry
		// can never clobber the edited content.
		if err := serverstore.AdoptKBDocumentEdit(db, id, req.Title, req.Content, doc.ContentType, ChunkText(req.Content)); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
			return
		}
		os.Remove(filepath.Join(uploadsDir, strconv.FormatInt(id, 10)))
	} else {
		if err := UpdateDocument(db, id, req.Title, req.Content); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
			return
		}
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "kb_update", "doc#"+strconv.FormatInt(id, 10)+" "+req.Title)
	c.JSON(http.StatusOK, gin.H{"ok": true, "doc": gin.H{"id": id, "title": req.Title}})
}

func listGrants(c *gin.Context, db *sql.DB) {
	folderID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	// M9: 与 grant/replace 一致,不存在的文件夹 → 404(防孤儿/防误判)
	if !folderExists(db, folderID) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "文件夹不存在")
		return
	}
	users, groups, err := serverstore.ListKBFolderGrants(db, folderID)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if users == nil {
		users = []string{}
	}
	if groups == nil {
		groups = []string{}
	}
	c.JSON(http.StatusOK, gin.H{"users": users, "groups": groups})
}

func revokeGrant(c *gin.Context, db *sql.DB) {
	folderID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	// M9: 与 grant/replace 一致,不存在的文件夹 → 404
	if !folderExists(db, folderID) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "文件夹不存在")
		return
	}
	var req struct {
		Username string `json:"username"`
		Group    string `json:"group"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || (req.Username == "" && req.Group == "") {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "username 或 group 必填")
		return
	}
	if req.Username != "" {
		if err := serverstore.RevokeFolderUser(db, folderID, req.Username); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "撤销失败")
			return
		}
	} else {
		if err := serverstore.RevokeFolderGroup(db, folderID, req.Group); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "撤销失败")
			return
		}
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "kb_revoke", "folder#"+strconv.FormatInt(folderID, 10)+" "+req.Username+req.Group)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func search(c *gin.Context, db *sql.DB) {
	q := strings.TrimSpace(c.Query("q"))
	if q == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "q 必填")
		return
	}
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 20
	}
	// hit-test: passage-level results exactly as the LLM would see them,
	// content truncated to the snippet (full text lives in the doc API).
	// M2: optional folder_id narrows the search to one folder.
	folderID, _ := strconv.ParseInt(c.DefaultQuery("folder_id", "0"), 10, 64)
	var results []ChunkResult
	var total int64
	var err error
	if folderID > 0 {
		results, total, err = SearchChunksInFolder(db, folderID, q, page, size)
	} else {
		results, total, err = SearchChunksAll(db, q, page, size)
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "搜索失败")
		return
	}
	out := make([]gin.H, 0, len(results))
	for _, r := range results {
		content := r.Content
		if len(content) > 400 {
			content = content[:400] + "…"
		}
		out = append(out, gin.H{"chunk_id": r.ChunkID, "doc_id": r.DocID, "folder_id": r.FolderID,
			"title": r.Title, "title_path": r.TitlePath, "content": content, "score": r.Score})
	}
	c.JSON(http.StatusOK, gin.H{"results": out, "total": total, "mode": SearchMode(db)})
}

// replaceFolderGrants 整组替换文件夹的全部部门授权(原子;用户授权保留)。
func replaceFolderGrants(c *gin.Context, db *sql.DB) {
	folderID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	if !folderExists(db, folderID) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "文件夹不存在")
		return
	}
	var req struct {
		Groups []string `json:"groups"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	if err := serverstore.ReplaceFolderGroupGrants(db, folderID, req.Groups); err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "存在不认识的部门名称")
			return
		}
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "授权对象不合法")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "kb_grants_replace", "folder#"+strconv.FormatInt(folderID, 10)+" "+strings.Join(req.Groups, ","))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// deleteFolder removes an empty folder (no documents, no grants).
func deleteFolder(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	// 守卫 + 删除同事务(TOCTOU);子文件夹也算"非空"——删除父目录会把子文件夹
	// 悬挂为孤儿(审计2026-H2)
	tx, err := db.Begin()
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	defer tx.Rollback()
	var docCount, grantCount, childCount int64
	if err := tx.QueryRow("SELECT COUNT(*) FROM kb_documents WHERE folder_id = ?", id).Scan(&docCount); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if err := tx.QueryRow(`SELECT (SELECT COUNT(*) FROM kb_folder_users WHERE folder_id = ?) + (SELECT COUNT(*) FROM kb_folder_groups WHERE folder_id = ?)`, id, id).Scan(&grantCount); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if err := tx.QueryRow("SELECT COUNT(*) FROM kb_folders WHERE parent_id = ?", id).Scan(&childCount); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if docCount > 0 || grantCount > 0 || childCount > 0 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "文件夹非空(有文档、子文件夹或授权),请先清空")
		return
	}
	res, err := tx.Exec("DELETE FROM kb_folders WHERE id = ?", id)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "文件夹不存在")
		return
	}
	if err := tx.Commit(); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "kb_folder_delete", "folder#"+strconv.FormatInt(id, 10))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
