package knowledge

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// JSON-RPC 2.0 envelope for POST /api/mcp/knowledge/message.
type rpcContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type rpcResult struct {
	Content []rpcContent `json:"content"`
	IsError bool         `json:"isError"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  *rpcResult      `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// RegisterRoutes mounts /api/mcp/knowledge/message (Bearer token required).
func RegisterRoutes(r *gin.Engine, db *sql.DB) {
	g := r.Group("/api/mcp/knowledge")
	g.POST("/message", serverauth.BearerAuth(db), handleMessage(db))
}

// maxMCPBody caps the JSON-RPC request body (kb_search/read/list are tiny;
// kb_upload content is separately capped in IndexDocument).
const maxMCPBody = 4 << 20

func handleMessage(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxMCPBody)
		var req rpcRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"),
				Error: &rpcError{Code: -32700, Message: "parse error"}})
			return
		}
		id := req.ID
		if id == nil {
			id = json.RawMessage("null")
		}
		switch req.Method {
		case "tools/list":
			c.JSON(http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: id,
				Result: &rpcResult{Content: []rpcContent{{Type: "text", Text: toolsListJSON}}}})
		case "tools/call":
			c.JSON(http.StatusOK, handleToolCall(db, c, id, req.Params))
		default:
			c.JSON(http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: id,
				Error: &rpcError{Code: -32601, Message: "method not found"}})
		}
	}
}

func handleToolCall(db *sql.DB, c *gin.Context, id json.RawMessage, params json.RawMessage) rpcResponse {
	var p struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Name == "" {
		return rpcErrorResponse(id, -32602, "invalid params")
	}
	u := serverauth.CurrentUser(c)
	if u == nil {
		return rpcErrorResponse(id, -32602, "no authenticated user")
	}
	// 有效组(部门树继承:祖先链 + 主管子树),权限解析统一入口
	groups, err := serverstore.UserEffectiveGroups(db, u.ID)
	if err != nil {
		return textResponse(id, "failed to load user groups: "+err.Error(), true)
	}
	accessible, err := accessibleFolders(db, u.Username, groups, u.IsAdmin)
	if err != nil {
		return textResponse(id, "failed to load folder grants: "+err.Error(), true)
	}
	if !json.Valid(p.Arguments) {
		return rpcErrorResponse(id, -32602, "invalid arguments")
	}
	switch p.Name {
	case "kb_search":
		return toolKBSearch(db, id, p.Arguments, u.Username, groups, u.IsAdmin)
	case "kb_read":
		return toolKBRead(db, id, p.Arguments, accessible)
	case "kb_list":
		return toolKBList(db, id, p.Arguments, accessible)
	case "kb_upload":
		return toolKBUpload(db, id, p.Arguments, accessible, u.Username)
	default:
		return rpcErrorResponse(id, -32601, "method not found")
	}
}

func toolKBSearch(db *sql.DB, id json.RawMessage, args json.RawMessage, username string, groups []string, isAdmin bool) rpcResponse {
	var a struct {
		Query    string `json:"query"`
		Page     int    `json:"page"`
		PageSize int    `json:"page_size"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return rpcErrorResponse(id, -32602, "invalid arguments")
	}
	if a.Query == "" {
		return textResponse(id, "query is required", true)
	}
	var res []ChunkResult
	var total int64
	var err error
	if isAdmin {
		res, total, err = SearchChunksAll(db, a.Query, a.Page, a.PageSize)
	} else {
		res, total, err = SearchChunks(db, username, groups, a.Query, a.Page, a.PageSize)
	}
	if err != nil {
		return textResponse(id, "search failed: "+err.Error(), true)
	}
	if total == 0 {
		// migration window: docs without chunks (pre-0014, not yet
		// backfilled) fall back to doc-level search。
		// admin 用 SearchAll(管理员本应全量可见,不走个人授权过滤;审计2026-M6)
		if isAdmin {
			docRes, docTotal, derr := SearchAll(db, a.Query, a.Page, a.PageSize)
			if derr == nil && docTotal > 0 {
				return textResponse(id, fmt.Sprintf("total %d\n%s", docTotal, formatDocResults(docRes)), false)
			}
		} else {
			docRes, docTotal, derr := Search(db, username, groups, a.Query, a.Page, a.PageSize)
			if derr == nil && docTotal > 0 {
				return textResponse(id, fmt.Sprintf("total %d\n%s", docTotal, formatDocResults(docRes)), false)
			}
		}
	}
	return textResponse(id, fmt.Sprintf("total %d\n%s", total, formatChunkResults(res)), false)
}

func toolKBRead(db *sql.DB, id json.RawMessage, args json.RawMessage, accessible map[int64]bool) rpcResponse {
	var a struct {
		DocID    int64   `json:"doc_id"`
		ChunkIDs []int64 `json:"chunk_ids"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return rpcErrorResponse(id, -32602, "invalid arguments")
	}
	if a.DocID == 0 {
		return textResponse(id, "doc_id is required", true)
	}
	doc, err := serverstore.GetKBDocument(db, a.DocID)
	if err != nil || !accessible[doc.FolderID] {
		return textResponse(id, "document not found or not accessible", true)
	}
	// chunk_ids: passage-level read, returns only the requested chunks —
	// the LLM picks them from kb_search results instead of pulling the
	// whole document into context。上限 100(审计2026-L3):无界数组会击穿
	// SQLite 变量数上限(32766)且放大上下文。
	if len(a.ChunkIDs) > 100 {
		return textResponse(id, "chunk_ids 最多 100 个", true)
	}
	if len(a.ChunkIDs) > 0 {
		chunks, err := serverstore.GetChunksByIDs(db, a.ChunkIDs)
		if err != nil {
			return textResponse(id, "read failed: "+err.Error(), true)
		}
		if len(chunks) == 0 {
			return textResponse(id, "no such chunks", true)
		}
		var lines []string
		for _, c := range chunks {
			if c.DocID != a.DocID {
				return textResponse(id, fmt.Sprintf("chunk %d belongs to another document", c.ID), true)
			}
			head := "#" + c.TitlePath
			if head == "#" {
				head = "#" + doc.Title
			}
			lines = append(lines, fmt.Sprintf("--- %s\n%s", head, c.Content))
		}
		return textResponse(id, strings.Join(lines, "\n"), false)
	}
	return textResponse(id, fmt.Sprintf("#%d [folder %d] %s (%s):\n%s",
		doc.ID, doc.FolderID, doc.Title, doc.ContentType, doc.Content), false)
}

func toolKBList(db *sql.DB, id json.RawMessage, args json.RawMessage, accessible map[int64]bool) rpcResponse {
	var a struct {
		FolderID    int64 `json:"folder_id"`
		IncludeDocs bool  `json:"include_docs"`
	}
	_ = json.Unmarshal(args, &a)
	folders, err := serverstore.ListKBFolders(db)
	if err != nil {
		return textResponse(id, "failed to list folders: "+err.Error(), true)
	}
	var lines []string
	for _, f := range folders {
		if a.FolderID > 0 && f.ID != a.FolderID {
			continue
		}
		if !accessible[f.ID] {
			continue
		}
		// 父目录 id 仅当也在可访问集合内才展示(审计2026-L6:不泄露无权文件夹的存在)
		parent := ""
		if f.ParentID != 0 && accessible[f.ParentID] {
			parent = fmt.Sprintf(" (parent %d)", f.ParentID)
		}
		lines = append(lines, fmt.Sprintf("#%d %s%s", f.ID, f.Name, parent))
		// include_docs: enumerate documents in accessible folders so the LLM
		// can pick a document by title before searching (A3).
		if a.IncludeDocs {
			docs, _, derr := serverstore.ListKBDocumentsPaged(db, f.ID, 0, 50)
			if derr != nil {
				continue
			}
			for _, d := range docs {
				lines = append(lines, fmt.Sprintf("  doc #%d %s (%s)", d.ID, d.Title, d.Status))
			}
		}
	}
	if a.FolderID > 0 && !accessible[a.FolderID] {
		return textResponse(id, "folder not accessible", true)
	}
	return textResponse(id, strings.Join(lines, "\n"), false)
}

func toolKBUpload(db *sql.DB, id json.RawMessage, args json.RawMessage, accessible map[int64]bool, username string) rpcResponse {
	var a struct {
		Title    string `json:"title"`
		Content  string `json:"content"`
		FolderID int64  `json:"folder_id"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return rpcErrorResponse(id, -32602, "invalid arguments")
	}
	if a.Title == "" || a.Content == "" {
		return textResponse(id, "title and content are required", true)
	}
	// 标题上限(审计2026-L5):4MB 级 MCP 请求体里的巨型标题不得落库/进摘要
	if len([]rune(a.Title)) > 200 {
		return textResponse(id, "title too long (max 200 runes)", true)
	}
	// folder 0(根目录)不再隐式可写:与可读性一致,必须显式授权后才可
	// 上传(严格授权制);无授权返回拒绝
	if !accessible[a.FolderID] {
		return textResponse(id, fmt.Sprintf("no permission for folder %d", a.FolderID), true)
	}
	docID, err := IndexDocument(db, a.FolderID, a.Title, a.Content, "text", "mcp", username)
	if err != nil {
		return textResponse(id, "upload failed: "+err.Error(), true)
	}
	if err := serverstore.AuditLog(db, username, "kb_upload", fmt.Sprintf("folder=%d title=%s", a.FolderID, a.Title)); err != nil {
		return textResponse(id, "upload stored but audit failed: "+err.Error(), true)
	}
	return textResponse(id, fmt.Sprintf("uploaded document id=%d folder=%d", docID, a.FolderID), false)
}

func accessibleFolders(db *sql.DB, username string, groups []string, isAdmin bool) (map[int64]bool, error) {
	if isAdmin {
		ids, err := serverstore.ListKBFolders(db)
		if err != nil {
			return nil, err
		}
		m := map[int64]bool{0: true}
		for _, f := range ids {
			m[f.ID] = true
		}
		return m, nil
	}
	ids, err := serverstore.GetAccessibleFolderIDs(db, username, groups)
	if err != nil {
		return nil, err
	}
	m := make(map[int64]bool, len(ids))
	for _, id := range ids {
		m[id] = true
	}
	return m, nil
}

// formatDocResults renders doc-level hits (fallback path for un-chunked
// legacy documents).
func formatDocResults(res []SearchResult) string {
	lines := make([]string, 0, len(res))
	for _, r := range res {
		content := runeTruncate(r.Content, 400)
		lines = append(lines, fmt.Sprintf("#doc:%d [folder %d] %s score %.2f: %s",
			r.ID, r.FolderID, r.Title, r.Score, content))
	}
	return strings.Join(lines, "\n")
}

// runeTruncate 按 rune 截断(审计2026-L2:字节截断会切开多字节字符)
func runeTruncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// formatChunkResults renders passage-level hits compactly (content truncated
// for the LLM). Each line carries the doc and chunk ids so kb_read can do a
// targeted passage read.
func formatChunkResults(res []ChunkResult) string {
	lines := make([]string, 0, len(res))
	for _, r := range res {
		content := runeTruncate(r.Content, 400)
		path := r.TitlePath
		if path == "" {
			path = "-"
		}
		lines = append(lines, fmt.Sprintf("#doc:%d #chunk:%d [folder %d] %s (%s) score %.2f: %s",
			r.DocID, r.ChunkID, r.FolderID, r.Title, path, r.Score, content))
	}
	return strings.Join(lines, "\n")
}

func textResponse(id json.RawMessage, text string, isError bool) rpcResponse {
	return rpcResponse{JSONRPC: "2.0", ID: id,
		Result: &rpcResult{Content: []rpcContent{{Type: "text", Text: text}}, IsError: isError}}
}

func rpcErrorResponse(id json.RawMessage, code int, msg string) rpcResponse {
	return rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: msg}}
}

var toolsListJSON string

func init() {
	tools := []map[string]any{
		{
			"name":        "kb_search",
			"description": "Search passages in the knowledge base (filtered by the caller's folder permissions); returns doc/chunk ids, title paths and snippets",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"query":     map[string]any{"type": "string", "description": "search words"},
					"page":      map[string]any{"type": "integer", "description": "page number, 1-based"},
					"page_size": map[string]any{"type": "integer", "description": "page size"},
				},
				"required": []string{"query"},
			},
		},
		{
			"name":        "kb_read",
			"description": "Read a document by id; pass chunk_ids from kb_search to read only the relevant passages (recommended for long documents)",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"doc_id":    map[string]any{"type": "integer", "description": "document id"},
					"chunk_ids": map[string]any{"type": "array", "items": map[string]any{"type": "integer"}, "description": "chunk ids from kb_search results (optional)"},
				},
				"required": []string{"doc_id"},
			},
		},
		{
			"name":        "kb_list",
			"description": "List folders accessible to the caller (folder_id 0 lists all); include_docs=true also enumerates documents per folder",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"folder_id":    map[string]any{"type": "integer", "description": "folder id, 0 for all"},
					"include_docs": map[string]any{"type": "boolean", "description": "also list documents in each folder"},
				},
			},
		},
		{
			"name":        "kb_upload",
			"description": "Upload a text document into a folder the caller is authorized for (root requires explicit grant too)",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"title":     map[string]any{"type": "string", "description": "document title"},
					"content":   map[string]any{"type": "string", "description": "document text"},
					"folder_id": map[string]any{"type": "integer", "description": "target folder id, 0 for global root"},
				},
				"required": []string{"title", "content"},
			},
		},
	}
	b, err := json.Marshal(tools)
	if err != nil {
		panic(err)
	}
	toolsListJSON = string(b)
}
