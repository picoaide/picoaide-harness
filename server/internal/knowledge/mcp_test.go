package knowledge

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

func mcpSetup(t *testing.T) (*gin.Engine, *sql.DB, string, int64) {
	t.Helper()
	db, err := serverstore.Open(filepath.Join(t.TempDir(), "mcp.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if err := serverstore.ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	uid, err := serverstore.CreateUserWithPassword(db, "alice", "pw")
	if err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterRoutes(r, db)
	return r, db, token, uid
}

type rpcReply struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  *rpcResult      `json:"result"`
	Error   *rpcError       `json:"error"`
}

func postMessage(t *testing.T, r *gin.Engine, token, body string) *rpcReply {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/mcp/knowledge/message", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", w.Code, w.Body.String())
	}
	var reply rpcReply
	if err := json.Unmarshal(w.Body.Bytes(), &reply); err != nil {
		t.Fatalf("unmarshal: %v (%s)", err, w.Body.String())
	}
	return &reply
}

func callTool(t *testing.T, r *gin.Engine, token, name, arguments string) *rpcReply {
	t.Helper()
	body := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"` + name + `","arguments":` + arguments + `}}`
	return postMessage(t, r, token, body)
}

func TestMCPToolsList(t *testing.T) {
	r, db, token, _ := mcpSetup(t)
	seedDocs(t, db)

	reply := postMessage(t, r, token, `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	if reply.Error != nil {
		t.Fatalf("tools/list error: %+v", reply.Error)
	}
	if reply.Result == nil || reply.Result.IsError || len(reply.Result.Content) == 0 {
		t.Fatalf("tools/list result: %+v", reply.Result)
	}
	text := reply.Result.Content[0].Text
	for _, want := range []string{"kb_search", "kb_read", "kb_list", "kb_upload"} {
		if !strings.Contains(text, want) {
			t.Errorf("tools/list missing %s", want)
		}
	}
}

func TestMCPKBSearch(t *testing.T) {
	r, db, token, _ := mcpSetup(t)
	seedDocs(t, db)

	reply := callTool(t, r, token, "kb_search", `{"query":"知识"}`)
	if reply.Result == nil || reply.Result.IsError {
		t.Fatalf("kb_search error: %+v", reply)
	}
	text := reply.Result.Content[0].Text
	if !strings.Contains(text, "知识库使用手册") {
		t.Errorf("kb_search missing doc: %s", text)
	}
	if strings.Contains(text, "机密") {
		t.Errorf("kb_search leaked unauthorized doc: %s", text)
	}

	// empty query -> isError
	reply = callTool(t, r, token, "kb_search", `{"query":""}`)
	if reply.Result == nil || !reply.Result.IsError {
		t.Fatalf("empty query should be isError: %+v", reply.Result)
	}
}

func TestMCPKBRead(t *testing.T) {
	r, db, token, _ := mcpSetup(t)
	_, bobFolder := seedDocs(t, db)
	bobDoc, err := serverstore.CreateKBDocument(db, bobFolder, "bob 私有", "bob 内容", "text", 0, "upload", "bob")
	if err != nil {
		t.Fatal(err)
	}

	reply := callTool(t, r, token, "kb_read", `{"doc_id":`+itoa(bobDoc)+`}`)
	if reply.Result == nil || !reply.Result.IsError {
		t.Fatalf("kb_read unauthorized should be isError: %+v", reply.Result)
	}

	// authorized doc in alice's folder
	aliceFolder, _ := seedDocs(t, db)
	aliceDoc, _ := serverstore.CreateKBDocument(db, aliceFolder, "alice 文档", "alice 内容", "text", 0, "upload", "alice")
	reply = callTool(t, r, token, "kb_read", `{"doc_id":`+itoa(aliceDoc)+`}`)
	if reply.Result == nil || reply.Result.IsError {
		t.Fatalf("kb_read authorized should succeed: %+v", reply.Result)
	}
	if !strings.Contains(reply.Result.Content[0].Text, "alice 文档") {
		t.Errorf("kb_read text: %s", reply.Result.Content[0].Text)
	}
}

func TestMCPKBReadChunkIDs(t *testing.T) {
	r, db, token, _ := mcpSetup(t)
	aliceFolder, err := serverstore.CreateKBFolder(db, "alice-docs", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantFolderUser(db, aliceFolder, "alice"); err != nil {
		t.Fatal(err)
	}
	docID, err := IndexDocument(db, aliceFolder, "长文档", strings.Repeat("第一章节内容。", 100)+"\n"+strings.Repeat("第二章节内容。", 100), "text", "upload", "alice")
	if err != nil {
		t.Fatal(err)
	}
	chunks, err := serverstore.ListChunksByDoc(db, docID)
	if err != nil || len(chunks) < 2 {
		t.Fatalf("want >= 2 chunks: %d %v", len(chunks), err)
	}
	// targeted read: chunk 1 only — no chapter-2 content may leak in
	reply := callTool(t, r, token, "kb_read", fmt.Sprintf(`{"doc_id":%d,"chunk_ids":[%d]}`, docID, chunks[0].ID))
	if reply.Result == nil || reply.Result.IsError {
		t.Fatalf("kb_read chunk_ids: %+v", reply)
	}
	text := reply.Result.Content[0].Text
	if !strings.Contains(text, chunks[0].Content[:20]) {
		t.Fatalf("kb_read chunk_ids missing target chunk: %s", text)
	}
	if strings.Contains(text, "第二章节内容") {
		t.Fatalf("kb_read chunk_ids leaked chunk 2: %s", text)
	}
	// chunk from another doc -> isError
	other, err := IndexDocument(db, aliceFolder, "另一篇", "其他内容", "text", "upload", "alice")
	if err != nil {
		t.Fatal(err)
	}
	_ = other
	otherChunks, err := serverstore.ListChunksByDoc(db, other)
	if err != nil || len(otherChunks) == 0 {
		t.Fatalf("other doc chunks: %v", err)
	}
	reply = callTool(t, r, token, "kb_read", fmt.Sprintf(`{"doc_id":%d,"chunk_ids":[%d]}`, docID, otherChunks[0].ID))
	if reply.Result == nil || !reply.Result.IsError {
		t.Fatalf("cross-doc chunk read should be isError: %+v", reply)
	}
}

func TestMCPKBList(t *testing.T) {
	r, db, token, _ := mcpSetup(t)
	aliceFolder, _ := seedDocs(t, db)

	reply := callTool(t, r, token, "kb_list", `{"folder_id":0}`)
	if reply.Result == nil || reply.Result.IsError {
		t.Fatalf("kb_list: %+v", reply.Result)
	}
	text := reply.Result.Content[0].Text
	if !strings.Contains(text, "alice-docs") || strings.Contains(text, "bob-docs") {
		t.Errorf("kb_list leaked/missed folders: %s", text)
	}

	reply = callTool(t, r, token, "kb_list", `{"folder_id":`+itoa(aliceFolder)+`}`)
	if reply.Result == nil || reply.Result.IsError {
		t.Fatalf("kb_list own folder: %+v", reply.Result)
	}
}

func TestMCPKBUpload(t *testing.T) {
	r, db, token, _ := mcpSetup(t)
	aliceFolder, bobFolder := seedDocs(t, db)

	// unauthorized folder -> isError
	reply := callTool(t, r, token, "kb_upload", `{"title":"x","content":"y","folder_id":`+itoa(bobFolder)+`}`)
	if reply.Result == nil || !reply.Result.IsError {
		t.Fatalf("kb_upload unauthorized should be isError: %+v", reply.Result)
	}

	// folder 0 is no longer implicitly writable (strict default)
	reply = callTool(t, r, token, "kb_upload", `{"title":"x","content":"y","folder_id":0}`)
	if reply.Result == nil || !reply.Result.IsError {
		t.Fatalf("kb_upload to global root should be isError: %+v", reply.Result)
	}

	// an authorized folder (alice granted in seedDocs) allows upload
	reply = callTool(t, r, token, "kb_upload", `{"title":"新知识文档","content":"这是新知识文档的内容","folder_id":`+itoa(aliceFolder)+`}`)
	if reply.Result == nil || reply.Result.IsError {
		t.Fatalf("kb_upload to granted folder: %+v", reply.Result)
	}

	// upload lands in search results
	reply = callTool(t, r, token, "kb_search", `{"query":"新知识"}`)
	if reply.Result == nil || reply.Result.IsError || !strings.Contains(reply.Result.Content[0].Text, "新知识文档") {
		t.Fatalf("uploaded doc not searchable: %+v", reply.Result)
	}

	// audit log written
	logs, err := serverstore.ListAuditLogs(db, 10)
	if err != nil || len(logs) == 0 || logs[0].Action != "kb_upload" || logs[0].Username != "alice" {
		t.Fatalf("audit logs: %+v %v", logs, err)
	}
}

func TestMCPGroupAccess(t *testing.T) {
	r, db, token, uid := mcpSetup(t)
	if err := serverstore.SyncUserGroups(db, uid, []string{"devs"}); err != nil {
		t.Fatal(err)
	}
	fid, err := serverstore.CreateKBFolder(db, "team-docs", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantFolderGroup(db, fid, "devs"); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateKBDocument(db, fid, "团队文档", "团队内部知识", "text", 0, "upload", "bob"); err != nil {
		t.Fatal(err)
	}

	reply := callTool(t, r, token, "kb_search", `{"query":"团队"}`)
	if reply.Result == nil || reply.Result.IsError || !strings.Contains(reply.Result.Content[0].Text, "团队文档") {
		t.Fatalf("group-granted doc not searchable: %+v", reply.Result)
	}
}

func TestMCPBadRequests(t *testing.T) {
	r, _, token, _ := mcpSetup(t)

	// malformed JSON -> -32700
	reply := postMessage(t, r, token, `{not json`)
	if reply.Error == nil || reply.Error.Code != -32700 {
		t.Fatalf("malformed JSON: %+v", reply)
	}

	// unknown method -> -32601
	reply = postMessage(t, r, token, `{"jsonrpc":"2.0","id":1,"method":"bogus"}`)
	if reply.Error == nil || reply.Error.Code != -32601 {
		t.Fatalf("unknown method: %+v", reply)
	}

	// unknown tool -> -32601
	reply = callTool(t, r, token, "kb_hack", `{}`)
	if reply.Error == nil || reply.Error.Code != -32601 {
		t.Fatalf("unknown tool: %+v", reply)
	}

	// auth required -> HTTP 401
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/mcp/knowledge/message", strings.NewReader(`{}`))
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("no token status = %d, want 401", w.Code)
	}
}

func itoa(v int64) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// admin 用户经 MCP 工具必须全量可见(不依赖授权表,与 marketplace 语义一致)
func TestMCPKBAdminSeesAll(t *testing.T) {
	r, db, token, _ := mcpSetup(t)
	// admin 提升 boss
	u, _ := serverstore.GetUserByUsername(db, "alice")
	u.IsAdmin = true
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}
	folder, err := serverstore.CreateKBFolder(db, "研发部", 0)
	if err != nil {
		t.Fatal(err)
	}
	// 无任何授权:admin 也能搜到 folder 0 与授权外的文件夹
	if _, err := IndexDocument(db, 0, "根文档", "报销政策说明内容", "text", "upload", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := IndexDocument(db, folder, "研发文档", "差旅管理制度内容", "text", "upload", "admin"); err != nil {
		t.Fatal(err)
	}
	reply := callTool(t, r, token, "kb_search", `{"query":"报销"}`)
	if reply.Result == nil || reply.Result.IsError {
		t.Fatalf("admin kb_search: %+v", reply)
	}
	text := reply.Result.Content[0].Text
	if !strings.Contains(text, "total 1") {
		t.Fatalf("admin search = %q, want the root doc", text)
	}
	reply = callTool(t, r, token, "kb_search", `{"query":"差旅管理"}`)
	if !strings.Contains(reply.Result.Content[0].Text, "研发文档") {
		t.Fatalf("admin must see unauthorized folder: %q", reply.Result.Content[0].Text)
	}
}
