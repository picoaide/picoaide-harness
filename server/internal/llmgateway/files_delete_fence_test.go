package llmgateway

// R18C-02（审计 2026-09-25，P1，第三方数据损坏）：迁移 0081 引入的 `gateway_files.reap_gen`
// 世代号（fencing token）修前**只有回收器在用**。管理端「按 id 删除」/「批量清理」与
// 用户侧 `DELETE /files/:id` 三条路径都是：
//
//	读台账（存在/归属）→ 上游 DELETE（**外部副作用**）→ 无条件删台账行
//
// 而 `RecordGatewayFileSize` 明确允许**过期行转手**给第二个上传者（上游按内容去重会把
// 同一个 file_id 发给第二个上传者）并 +1 世代 ⇒ 窗口内转手时，被删掉的是**新归属人**
// 的上游对象与台账行（管理端还会回 200 deleted=1）。
//
// 修后三条路径都走回收器那套认领协议：**先认领（世代 +1 + 回收标记）→ 复检删除权 →
// 上游 DELETE → 按世代收尾**；拿不到认领就放弃删除并如实回报（409 FILE_BUSY），
// 绝不静默删行。本文件把"转手窗口内的删除必须放弃""拿不到删除权不得碰上游"
// 与"正常的删除/收敛照旧"三个面都钉住。

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// s18AdminFileProvider 种一个 Files 面可用的 provider（判据见 files.go 的 fileUpstream：
// base_url 或 name 含 "deepseek"）。
func s18AdminFileProvider(t *testing.T, db *sql.DB, baseURL string) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, protocol)
		VALUES ('deepseek-s18-files', ?, 'sk-s18', '[]', 'openai')`, baseURL); err != nil {
		t.Fatalf("insert file provider: %v", err)
	}
	InvalidateUpstreams()
}

// s18UserID 取用户名对应的 id。
func s18UserID(t *testing.T, db *sql.DB, name string) int64 {
	t.Helper()
	u, err := serverstore.GetUserByUsername(db, name)
	if err != nil || u == nil {
		t.Fatalf("get user %s: %v", name, err)
	}
	return u.ID
}

// s18Row 读台账行（存在性 / 归属 / 世代 / 是否被认领）。
func s18Row(t *testing.T, db *sql.DB, fileID string) (exists bool, owner, gen int64, claimed bool) {
	t.Helper()
	err := db.QueryRow(`SELECT user_id, reap_gen, reaping_at IS NOT NULL FROM gateway_files WHERE file_id = ?`, fileID).
		Scan(&owner, &gen, &claimed)
	if errors.Is(err, sql.ErrNoRows) {
		return false, 0, 0, false
	}
	if err != nil {
		t.Fatalf("read gateway_files: %v", err)
	}
	return true, owner, gen, claimed
}

// TestS18AdminDeleteRefusesHandoverDuringUpstreamDelete 钉 R18C-02 的主形态：
// 管理端删除的上游调用期间，同一 file_id 被第二个上传者重新登记（过期行转手）——
// 修后登记路径必须被活跃认领拒绝（ErrGatewayFileReapClaimed），新归属人拿不到这一行，
// 也就不会出现"对象与台账行一起消失"。
func TestS18AdminDeleteRefusesHandoverDuringUpstreamDelete(t *testing.T) {
	const fileID = "file-api-s18-01"

	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	ownerID := s18UserID(t, db, "boss")
	if _, err := serverstore.CreateUser(db, &serverstore.User{Username: "s18-new-owner", Source: "local", Status: 1}); err != nil {
		t.Fatal(err)
	}
	newOwnerID := s18UserID(t, db, "s18-new-owner")

	var handoverErr error
	var deletes int
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method == http.MethodDelete {
			deletes++
			// 上游在收到 DELETE 的同一刻执行"第二个上传者拿到同一个 id"的转手
			// （上游按内容去重时的真实窗口）。
			future := time.Now().Add(7 * 24 * time.Hour)
			handoverErr = serverstore.RecordGatewayFile(db, fileID, newOwnerID, &future)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"` + fileID + `","object":"file","deleted":true}`))
	}))
	defer up.Close()
	s18AdminFileProvider(t, db, up.URL)

	// 台账里先有一行已过期的归属（原主 = boss；管理端列表里显示为"已过期"）。
	past := time.Now().Add(-time.Hour)
	if err := serverstore.RecordGatewayFile(db, fileID, ownerID, &past); err != nil {
		t.Fatal(err)
	}

	w, out := adminReq(t, r, http.MethodDelete, "/api/server/admin/gateway/files/"+fileID, "", hdr)
	if deletes != 1 {
		t.Fatalf("上游 DELETE 次数 = %d, want 1", deletes)
	}
	if !errors.Is(handoverErr, serverstore.ErrGatewayFileReapClaimed) {
		t.Fatalf("转手错误 = %v, want ErrGatewayFileReapClaimed —— 认领在租约内时登记路径必须拒绝转手"+
			"（修前 = nil：转手成功，随后上游对象与新归属人的台账行一起被删）", handoverErr)
	}
	if w.Code != http.StatusOK {
		t.Fatalf("管理端删除 = %d %s, want 200（认领全程在手 ⇒ 这次删除是合法的那一份）", w.Code, w.Body.String())
	}
	if deleted, _ := out["deleted"].(float64); deleted != 1 {
		t.Fatalf("deleted = %v, want 1", out["deleted"])
	}
	// 关键不变量：**没有**"新归属人的行"被留下（转手被拒 ⇒ 从未产生新归属人）。
	exists, _, _, _ := s18Row(t, db, fileID)
	if exists {
		t.Fatal("被删对象的台账行仍在（旧主的那一行应当随对象一起收敛）")
	}
	for _, name := range []string{"boss", "s18-new-owner"} {
		var id int64
		if err := db.QueryRow(`SELECT id FROM users WHERE username = ?`, name).Scan(&id); err != nil {
			t.Fatal(err)
		}
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM gateway_files WHERE user_id = ?`, id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("用户 %s 名下仍有 %d 行台账（期望 0）", name, n)
		}
	}
}

// TestS18AdminDeleteRefusesWhenClaimHeld 钉"拿不到删除权就放弃"：
// 该行正被另一个删除者/回收器认领（标记在租约内）时，管理端必须 409 且
// **一次上游调用都不发**、行原样保留 —— 绝不静默删行。
func TestS18AdminDeleteRefusesWhenClaimHeld(t *testing.T) {
	const fileID = "file-api-s18-02"

	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	ownerID := s18UserID(t, db, "boss")

	deletes := 0
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method == http.MethodDelete {
			deletes++
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"` + fileID + `","object":"file","deleted":true}`))
	}))
	defer up.Close()
	s18AdminFileProvider(t, db, up.URL)

	past := time.Now().Add(-time.Hour)
	if err := serverstore.RecordGatewayFile(db, fileID, ownerID, &past); err != nil {
		t.Fatal(err)
	}
	// 另一个删除者（这里是回收器的认领入口）已经持有删除权。
	_, claimed, err := serverstore.ClaimExpiredGatewayFile(db, fileID)
	if err != nil || !claimed {
		t.Fatalf("前置认领失败: claimed=%v err=%v", claimed, err)
	}

	w, out := adminReq(t, r, http.MethodDelete, "/api/server/admin/gateway/files/"+fileID, "", hdr)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d %s, want 409（删除权被持有 ⇒ 放弃删除）", w.Code, w.Body.String())
	}
	if code := errCodeOf(t, w); code != "FILE_BUSY" {
		t.Fatalf("error.code = %q, want FILE_BUSY", code)
	}
	if deletes != 0 {
		t.Fatalf("上游 DELETE 次数 = %d, want 0 —— 拿不到删除权时**绝不能碰上游对象**", deletes)
	}
	if deleted, ok := out["deleted"]; ok && deleted != float64(0) {
		t.Fatalf("响应谎报了删除数: %v", out)
	}
	exists, owner, _, claimedNow := s18Row(t, db, fileID)
	if !exists || owner != ownerID || !claimedNow {
		t.Fatalf("台账行被改动: exists=%v owner=%d claimed=%v（行与另一个删除者的标记都必须原样保留）",
			exists, owner, claimedNow)
	}
}

// TestS18AdminPurgeSkipsFencedRows 钉批量清理：认领被别人持有的那些行必须**跳过**
// （skipped 计数如实回报），其余行照常删除。
//
// 夹具用 `state=active`（清理仍然有效的文件，必须指名员工）：过期行的候选列表本来就会
// 排除"标记在租约内"的行（`gatewayFileWhere` 的既有口径），所以要用有效行才能确定性地
// 走到循环里的"拿不到删除权 ⇒ 跳过"那一支。
func TestS18AdminPurgeSkipsFencedRows(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	ownerID := s18UserID(t, db, "boss")

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"object":"file","deleted":true}`))
	}))
	defer up.Close()
	s18AdminFileProvider(t, db, up.URL)

	active := time.Now().Add(7 * 24 * time.Hour)
	for _, id := range []string{"file-api-s18-purge-free", "file-api-s18-purge-claimed"} {
		if err := serverstore.RecordGatewayFile(db, id, ownerID, &active); err != nil {
			t.Fatal(err)
		}
	}
	// 另一个删除者（管理端/回收器）已经持有其中一行的删除权。
	if _, claimed, err := serverstore.ClaimGatewayFileForDeletion(db, "file-api-s18-purge-claimed"); err != nil || !claimed {
		t.Fatalf("前置认领失败: claimed=%v err=%v", claimed, err)
	}

	w, out := adminReq(t, r, http.MethodPost, "/api/server/admin/gateway/files/purge",
		`{"state":"active","user":"boss"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("purge = %d %s", w.Code, w.Body.String())
	}
	if got := out["deleted"]; got != float64(1) {
		t.Fatalf("deleted = %v, want 1（只有未被认领的那一行可删）", got)
	}
	if got := out["skipped"]; got != float64(1) {
		t.Fatalf("skipped = %v, want 1（被认领的行必须如实计入跳过，而不是静默删掉）", got)
	}
	if exists, _, _, _ := s18Row(t, db, "file-api-s18-purge-free"); exists {
		t.Fatal("未被认领的有效行应当被清理")
	}
	if exists, _, _, claimedNow := s18Row(t, db, "file-api-s18-purge-claimed"); !exists || !claimedNow {
		t.Fatalf("被认领的行被动过: exists=%v claimed=%v", exists, claimedNow)
	}
}

// TestS18UserDeleteRefusesWhenClaimHeld 钉用户侧删除同形：行被别的删除者认领时
// 409 FILE_BUSY、上游 DELETE 0 次、行保留（修前会直接把上游对象删掉再删行）。
func TestS18UserDeleteRefusesWhenClaimHeld(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-s18-user-files")

	const fileID = "file-api-s18-user-busy"
	future := time.Now().Add(7 * 24 * time.Hour)
	if err := serverstore.RecordGatewayFile(gw.db, fileID, gw.uidA, &future); err != nil {
		t.Fatal(err)
	}
	// 另一个删除者持有删除权（管理端/回收器都可能）。
	if _, claimed, err := serverstore.ClaimGatewayFileForDeletion(gw.db, fileID); err != nil || !claimed {
		t.Fatalf("前置认领失败: claimed=%v err=%v", claimed, err)
	}

	w := doFilesReq(t, gw.r, http.MethodDelete, "/v1/files/"+fileID, nil, gw.tokenA, "")
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d %s, want 409", w.Code, w.Body.String())
	}
	if got := up.deletes.Load(); got != 0 {
		t.Fatalf("上游 DELETE 次数 = %d, want 0", got)
	}
	if exists, owner, _, _ := s18Row(t, gw.db, fileID); !exists || owner != gw.uidA {
		t.Fatalf("台账行被动过: exists=%v owner=%d", exists, owner)
	}
}

// TestS18UserDeleteStillConvergesItsOwnRow 钉"别过度修复"：正常路径（没有人持有删除权）
// 逐字照旧 —— 上游 DELETE 一次、行收敛、上游响应原样回给客户端。
func TestS18UserDeleteStillConvergesItsOwnRow(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-s18-user-ok")

	const fileID = "file-api-s18-user-ok"
	future := time.Now().Add(7 * 24 * time.Hour)
	if err := serverstore.RecordGatewayFile(gw.db, fileID, gw.uidA, &future); err != nil {
		t.Fatal(err)
	}

	w := doFilesReq(t, gw.r, http.MethodDelete, "/v1/files/"+fileID, nil, gw.tokenA, "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d %s, want 200", w.Code, w.Body.String())
	}
	if got := up.deletes.Load(); got != 1 {
		t.Fatalf("上游 DELETE 次数 = %d, want 1", got)
	}
	if exists, _, _, _ := s18Row(t, gw.db, fileID); exists {
		t.Fatal("成功删除后台账行必须收敛")
	}
}

// TestS18RetrieveConvergeIsGenerationScoped 钉 `GET /files/:id` 的悬垂行收敛：
// 上游 404 ⇒ 收敛台账，但**必须带世代谓词** —— 窗口内该行被重新登记（世代 +1）时
// 放弃删行（修前按 file_id 无条件删，删掉的是新一代的行）。
func TestS18RetrieveConvergeIsGenerationScoped(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-s18-retrieve")

	const fileID = "file-api-s18-retrieve"
	active := time.Now().Add(7 * 24 * time.Hour)
	if err := serverstore.RecordGatewayFile(gw.db, fileID, gw.uidA, &active); err != nil {
		t.Fatal(err)
	}
	// 上游 GET 返回 404（对象已不在），**并在同一窗口里**该行被重新登记（续期 ⇒ 世代 +1）。
	up.respond = func(w http.ResponseWriter, req *http.Request) {
		if req.Method == http.MethodGet {
			later := time.Now().Add(30 * 24 * time.Hour)
			if err := serverstore.RecordGatewayFile(gw.db, fileID, gw.uidA, &later); err != nil {
				t.Errorf("窗口内续期失败: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"message":"not found"}}`))
			return
		}
		w.WriteHeader(http.StatusOK)
	}

	w := doFilesReq(t, gw.r, http.MethodGet, "/v1/files/"+fileID, nil, gw.tokenA, "")
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d %s, want 404（上游响应原样透传）", w.Code, w.Body.String())
	}
	exists, owner, gen, _ := s18Row(t, gw.db, fileID)
	if !exists || owner != gw.uidA {
		t.Fatalf("世代已变的行被删掉了: exists=%v owner=%d（修前按 file_id 无条件删 ⇒ 新登记的归属丢失）", exists, owner)
	}
	if gen < 1 {
		t.Fatalf("前置不成立：续期应推进世代，实得 gen=%d", gen)
	}
}

// TestS18RetrieveConvergeStillDropsStaleRow 对照：窗口内没有任何写入时，
// 上游 404 仍然照旧收敛悬垂行（防止"加固"退化成"永不收敛"）。
func TestS18RetrieveConvergeStillDropsStaleRow(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-s18-retrieve-clean")

	const fileID = "file-api-s18-retrieve-clean"
	active := time.Now().Add(7 * 24 * time.Hour)
	if err := serverstore.RecordGatewayFile(gw.db, fileID, gw.uidA, &active); err != nil {
		t.Fatal(err)
	}
	up.respond = func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"message":"not found"}}`))
	}

	if w := doFilesReq(t, gw.r, http.MethodGet, "/v1/files/"+fileID, nil, gw.tokenA, ""); w.Code != http.StatusNotFound {
		t.Fatalf("status = %d %s, want 404", w.Code, w.Body.String())
	}
	if exists, _, _, _ := s18Row(t, gw.db, fileID); exists {
		t.Fatal("上游 404 且行未被改动时，悬垂行必须被收敛（否则该 id 永远占着归属）")
	}
}

// TestS18AdminDeleteStillDeletesUntouchedRow 对照：普通管理端删除（没有任何并发写）
// 逐字照旧 —— 上游 DELETE 一次、行收敛、回 200 deleted=1、审计留痕。
func TestS18AdminDeleteStillDeletesUntouchedRow(t *testing.T) {
	const fileID = "file-api-s18-plain"

	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	ownerID := s18UserID(t, db, "boss")

	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"` + fileID + `","object":"file","deleted":true}`))
	}))
	defer up.Close()
	s18AdminFileProvider(t, db, up.URL)

	past := time.Now().Add(-time.Hour)
	if err := serverstore.RecordGatewayFile(db, fileID, ownerID, &past); err != nil {
		t.Fatal(err)
	}

	w, out := adminReq(t, r, http.MethodDelete, "/api/server/admin/gateway/files/"+fileID, "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d %s, want 200", w.Code, w.Body.String())
	}
	if got := out["deleted"]; got != float64(1) {
		t.Fatalf("deleted = %v, want 1", got)
	}
	if exists, _, _, _ := s18Row(t, db, fileID); exists {
		t.Fatal("台账行必须收敛")
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE action = 'gateway_file_delete'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("审计行数 = %d, want 1", n)
	}
	// 未知 id 仍然 404 且不打上游。
	w2, _ := adminReq(t, r, http.MethodDelete, "/api/server/admin/gateway/files/file-api-s18-missing", "", hdr)
	if w2.Code != http.StatusNotFound {
		t.Fatalf("未知 id status = %d, want 404", w2.Code)
	}
	_ = fmt.Sprint()
}
