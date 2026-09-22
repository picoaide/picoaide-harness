package llmgateway

// 管理端「网关文件台账」判据（审计 2026-09-22 R7 / 修复泳道 L3）。
//
// 覆盖面（每条判据都必须能被变异打红，变异表见 audit/lane3/REPORT.md）：
//  1. 权限点：四个端点各挂 gateway:read / gateway:write —— 无会话 401（证明路由
//     真的挂上了，不是 404），**有管理会话但无该权限**（auditor）403，不是 404/200；
//  2. `user=` 只按**用户名**解、`user_id=` 才按数字 ID（数字用户名不得被当 ID，
//     purge 更不得删错人）；
//  3. `state` 白名单：未知取值必须 400，绝不静默忽略（静默 = 过滤条件消失）；
//  4. purge 范围护栏：无条件 400、删有效文件不指名员工 400、单次 ≤500 条；
//  5. 分页边界：size=0/1/200/201/9999、page=0/1/2/99999/极大值、
//     sort 白名单外值、order 非 asc —— offset 必须与**生效的** size 同源；
//  6. 审计：delete 1 条 / purge 每次 1 条，detail 含范围与计数、不含上游密钥。

import (
	"database/sql"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// gwfEnv 是「网关文件台账」用例的公共夹具：真路由树（生产镜像）+ 真库 + 假上游。
type gwfEnv struct {
	r   http.Handler
	db  *sql.DB
	hdr map[string]string // super_admin（adminTestSetup 的 boss）
	up  *fakeFilesUpstream
}

func gwfSetup(t *testing.T) *gwfEnv {
	t.Helper()
	resetBodyParseGate(t)
	r, db, hdr := adminTestSetup(t)
	up := newFakeFilesUpstream(t)
	// 删除/清理要真的往上游发 DELETE ⇒ 必须有一个 deepseek 系的可用上游。
	if _, err := db.Exec(
		`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES (?, ?, ?, '["deepseek-chat"]')`,
		"deepseek-official", up.srv.URL, upstreamKey,
	); err != nil {
		t.Fatal(err)
	}
	InvalidateUpstreams()
	t.Cleanup(InvalidateUpstreams)
	return &gwfEnv{r: r, db: db, hdr: hdr, up: up}
}

// user 建一个员工/管理员行并返回 id。
func (e *gwfEnv) user(t *testing.T, name, role string) int64 {
	t.Helper()
	id, err := serverstore.CreateUser(e.db, &serverstore.User{
		Username: name, DisplayName: name, Source: "local", Status: 1, Role: role,
	})
	if err != nil {
		t.Fatalf("create user %s: %v", name, err)
	}
	return id
}

// session 直接建管理会话（不走登录，避免限流与口令依赖），返回请求头。
func (e *gwfEnv) session(t *testing.T, name, role string) map[string]string {
	t.Helper()
	uid := e.user(t, name, role)
	sess, csrf, err := serverauth.CreateAdminSession(e.db, uid)
	if err != nil {
		t.Fatalf("create admin session %s: %v", name, err)
	}
	return map[string]string{"Cookie": "picoaide_session=" + sess.ID, "X-CSRF-Token": csrf}
}

func (e *gwfEnv) seed(t *testing.T, id string, uid int64, exp *time.Time, size int64) {
	t.Helper()
	if err := serverstore.RecordGatewayFileSize(e.db, id, uid, exp, size); err != nil {
		t.Fatalf("seed %s: %v", id, err)
	}
}

// seedMany 播种 n 条（file_id 用零填充编号，保证 ORDER BY file_id 的兜底序确定）。
func (e *gwfEnv) seedMany(t *testing.T, prefix string, uid int64, n int, exp *time.Time) {
	t.Helper()
	for i := 0; i < n; i++ {
		e.seed(t, fmt.Sprintf("%s-%04d", prefix, i), uid, exp, int64(i+1))
	}
}

// get 打一次列表面板请求，返回 (状态码, 行, 顶层响应)。
func (e *gwfEnv) get(t *testing.T, query string, hdr map[string]string) (int, []any, map[string]any) {
	t.Helper()
	w, out := adminReq(t, e.r, "GET", "/api/server/admin/gateway/files"+query, "", hdr)
	rows, _ := out["rows"].([]any)
	return w.Code, rows, out
}

// ids 抽出行里的 file_id 序列。
func gwfIDs(rows []any) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		m, _ := r.(map[string]any)
		id, _ := m["file_id"].(string)
		out = append(out, id)
	}
	return out
}

// gwfAudit 取某个 action 的全部 detail（按 id 升序）。
func gwfAudit(t *testing.T, db *sql.DB, action string) []string {
	t.Helper()
	rows, err := db.Query(`SELECT detail FROM audit_logs WHERE action = ? ORDER BY id ASC`, action)
	if err != nil {
		t.Fatalf("read audit %s: %v", action, err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			t.Fatal(err)
		}
		out = append(out, d)
	}
	return out
}

// ---------------------------------------------------------------------------
// ① 权限点
// ---------------------------------------------------------------------------

// TestAdminGatewayFilesPermissionPoints：四个端点的权限申报必须真的生效。
//
// 三种会话逐个过：
//   - 无会话 ⇒ 401 AUTH_REQUIRED（**不是 404**：404 说明路由没挂上，
//     权限测试会因为"路径不存在"而假绿）；
//   - auditor（有管理会话、无 gateway:read/write）⇒ 403 FORBIDDEN
//     （**不是 404/200**：这是 fall-open 的正面判据）；
//   - super_admin ⇒ 不是 401/403（反向对照，证明 403 来自权限而不是路径写错）。
func TestAdminGatewayFilesPermissionPoints(t *testing.T) {
	e := gwfSetup(t)
	uid := e.user(t, "gwf-owner", serverstore.RoleUser)
	future := time.Now().Add(time.Hour)
	e.seed(t, "file-perm-1", uid, &future, 10)

	auditor := e.session(t, "gwf-auditor", serverstore.RoleAuditor)

	cases := []struct {
		method, path, body string
	}{
		{"GET", "/api/server/admin/gateway/files", ""},
		{"GET", "/api/server/admin/gateway/files/summary", ""},
		{"DELETE", "/api/server/admin/gateway/files/file-perm-1", ""},
		{"POST", "/api/server/admin/gateway/files/purge", `{"state":"expired"}`},
	}
	for _, c := range cases {
		key := c.method + " " + c.path
		// 无会话 ⇒ 401（路由已挂 + AdminAuth 生效）。
		w, _ := adminReq(t, e.r, c.method, c.path, c.body, nil)
		if w.Code == http.StatusNotFound {
			t.Fatalf("%s: 路由未挂上（404）", key)
		}
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%s 无会话 = %d, want 401 (%s)", key, w.Code, w.Body.String())
		}
		// auditor ⇒ 403（既不是 404 也不是 200）。
		w, out := adminReq(t, e.r, c.method, c.path, c.body, auditor)
		if w.Code != http.StatusForbidden {
			t.Fatalf("%s auditor = %d, want 403 (%s)", key, w.Code, w.Body.String())
		}
		if code, _ := out["error"].(map[string]any); code["code"] != "FORBIDDEN" {
			t.Fatalf("%s auditor envelope = %v, want FORBIDDEN", key, out)
		}
		// super_admin ⇒ 不是 401/403（反向对照）。
		w, _ = adminReq(t, e.r, c.method, c.path, c.body, e.hdr)
		if w.Code == http.StatusUnauthorized || w.Code == http.StatusForbidden {
			t.Fatalf("%s super_admin = %d, want 非 401/403 (%s)", key, w.Code, w.Body.String())
		}
	}
	// auditor 的会话确有其事：它能读审计（audit:read），说明 403 来自权限点而不是会话无效。
	if w, _ := adminReq(t, e.r, "GET", "/api/server/admin/audit", "", auditor); w.Code != http.StatusOK {
		t.Fatalf("auditor 读审计 = %d（会话应有效，403 必须来自 gateway 权限点）", w.Code)
	}
}

// ---------------------------------------------------------------------------
// ② user= / user_id= 口径
// ---------------------------------------------------------------------------

// TestAdminGatewayFilesUserFilterIsUsernameOnly：`user=` 一律按用户名解。
//
// 判别性构造：造一个**用户名恰等于另一个员工数字 ID** 的账号 —— 旧实现"先按 ID 解"
// 会把 `user=<数字>` 过滤到那个 ID 的员工身上（看错人 / purge 删错人）。
func TestAdminGatewayFilesUserFilterIsUsernameOnly(t *testing.T) {
	e := gwfSetup(t)
	victim := e.user(t, "gwf-victim", serverstore.RoleUser) // 它的数字 ID 就是诱饵
	numeric := e.user(t, strconv.FormatInt(victim, 10), serverstore.RoleUser)

	future := time.Now().Add(time.Hour)
	e.seed(t, "file-victim-1", victim, &future, 11)
	e.seed(t, "file-victim-2", victim, &future, 12)
	e.seed(t, "file-numeric-1", numeric, &future, 21)

	// 用户名（数字形状）⇒ 只看到数字用户名那个账号的 1 条。
	code, rows, out := e.get(t, "?user="+strconv.FormatInt(victim, 10), e.hdr)
	if code != http.StatusOK {
		t.Fatalf("user=<数字用户名> = %d", code)
	}
	if n, _ := out["total"].(float64); int(n) != 1 || len(rows) != 1 {
		t.Fatalf("user=<数字用户名> total=%v rows=%v, want 1/1（旧实现会解析成 ID=%d 的另一个员工）",
			out["total"], gwfIDs(rows), victim)
	}
	if ids := gwfIDs(rows); ids[0] != "file-numeric-1" {
		t.Fatalf("user=<数字用户名> 命中 %v, want [file-numeric-1]", ids)
	}
	// user_id= 才按数字 ID。
	_, rows, out = e.get(t, "?user_id="+strconv.FormatInt(victim, 10), e.hdr)
	if n, _ := out["total"].(float64); int(n) != 2 {
		t.Fatalf("user_id=%d total=%v, want 2", victim, out["total"])
	}
	// 不存在的数字用户名 ⇒ 空集（绝不退化成"不过滤"）。
	_, rows, out = e.get(t, "?user=999999999", e.hdr)
	if n, _ := out["total"].(float64); int(n) != 0 || len(rows) != 0 {
		t.Fatalf("未知用户 total=%v rows=%d, want 0/0（退化成全量会让管理员以为过滤生效）", out["total"], len(rows))
	}
	// user_id 非法 ⇒ 空集（fail-closed）。
	_, _, out = e.get(t, "?user_id=abc", e.hdr)
	if n, _ := out["total"].(float64); int(n) != 0 {
		t.Fatalf("user_id=abc total=%v, want 0", out["total"])
	}

	// purge：`user=<数字用户名>` 必须删**该用户名**的文件，绝不能落到 ID 相同的员工头上。
	//
	// 只给 `user` 不给 state ⇒ 语义是"清这个人的全部文件"（含仍有效的；这是
	// "删有效文件必须指名员工"的允许路径），所以命中数是该账号的全部文件。
	expired := time.Now().Add(-time.Minute)
	e.seed(t, "file-victim-exp", victim, &expired, 0)
	e.seed(t, "file-numeric-exp", numeric, &expired, 0)
	w, out := adminReq(t, e.r, "POST", "/api/server/admin/gateway/files/purge",
		`{"user":"`+strconv.FormatInt(victim, 10)+`"}`, e.hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("purge by numeric-looking username = %d %s", w.Code, w.Body.String())
	}
	if n, _ := out["deleted"].(float64); int(n) != 2 {
		t.Fatalf("purge deleted=%v, want 2（数字用户名本人的全部文件）", out["deleted"])
	}
	var victimLeft, numericLeft int
	if err := e.db.QueryRow(`SELECT count(*) FROM gateway_files WHERE user_id = ?`, victim).Scan(&victimLeft); err != nil {
		t.Fatal(err)
	}
	if err := e.db.QueryRow(`SELECT count(*) FROM gateway_files WHERE user_id = ?`, numeric).Scan(&numericLeft); err != nil {
		t.Fatal(err)
	}
	if victimLeft != 3 {
		t.Fatalf("按数字用户名 purge 动了 ID=%d 的员工（剩 %d，want 3）—— 删错人", victim, victimLeft)
	}
	if numericLeft != 0 {
		t.Fatalf("按数字用户名 purge 没删到本人（剩 %d，want 0）", numericLeft)
	}
	// 未知用户名的 purge ⇒ 400（绝不静默退化）。
	if w, _ := adminReq(t, e.r, "POST", "/api/server/admin/gateway/files/purge",
		`{"user":"nobody-at-all"}`, e.hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("purge by unknown user = %d, want 400", w.Code)
	}
}

// ---------------------------------------------------------------------------
// ③④ purge 范围护栏
// ---------------------------------------------------------------------------

// TestAdminGatewayFilesPurgeGuards：空条件、未知 state、删有效文件不指名员工、
// 非法 user_id、单次上限。
func TestAdminGatewayFilesPurgeGuards(t *testing.T) {
	e := gwfSetup(t)
	uid := e.user(t, "gwf-guard-owner", serverstore.RoleUser)
	active := time.Now().Add(time.Hour)
	expired := time.Now().Add(-time.Minute)
	e.seed(t, "file-guard-active", uid, &active, 0)
	e.seed(t, "file-guard-expired", uid, &expired, 0)

	// 无条件 ⇒ 400（防"一个空 body 清全公司台账"）。
	for _, body := range []string{`{}`, `{"limit":100}`, `{"expired_only":false}`} {
		if w, _ := adminReq(t, e.r, "POST", "/api/server/admin/gateway/files/purge", body, e.hdr); w.Code != http.StatusBadRequest {
			t.Fatalf("无条件 purge %s = %d, want 400", body, w.Code)
		}
	}
	// 未知 state ⇒ 400（静默忽略等于过滤条件消失、范围扩大）。
	for _, body := range []string{`{"state":"bogus"}`, `{"state":"bogus","user":"gwf-guard-owner"}`,
		`{"state":"ACTIVE","user":"gwf-guard-owner"}`, `{"state":"none","user":"gwf-guard-owner"}`} {
		w, out := adminReq(t, e.r, "POST", "/api/server/admin/gateway/files/purge", body, e.hdr)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("未知 state %s = %d, want 400 (%s)", body, w.Code, w.Body.String())
		}
		if body == `{"state":"bogus","user":"gwf-guard-owner"}` {
			if msg, _ := out["error"].(map[string]any); !strings.Contains(fmt.Sprint(msg["message"]), "state") {
				t.Fatalf("未知 state 的错误文案应点名 state: %v", out)
			}
		}
	}
	// 删**有效**文件必须指名员工（全组织范围只允许清已过期）。
	if w, _ := adminReq(t, e.r, "POST", "/api/server/admin/gateway/files/purge", `{"state":"active"}`, e.hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("state=active 无 user = %d, want 400", w.Code)
	}
	// 非法 user_id（0 / 负数）不得被静默忽略（忽略 = 范围从"某个人"扩到"全组织"）。
	// 列表侧同口径：`?user_id=0` 落空集（fail-closed，见上一条用例）。
	for _, body := range []string{
		`{"state":"active","user_id":0}`,
		`{"state":"expired","user_id":0}`,
		`{"state":"expired","user_id":-1}`,
		`{"user_id":0}`,
	} {
		w, out := adminReq(t, e.r, "POST", "/api/server/admin/gateway/files/purge", body, e.hdr)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("purge %s = %d, want 400（user_id 必须正整数，不能忽略成全组织范围）", body, w.Code)
		}
		if msg, _ := out["error"].(map[string]any); !strings.Contains(fmt.Sprint(msg["message"]), "user_id") {
			t.Fatalf("purge %s 的错误文案应点名 user_id: %v", body, out)
		}
	}
	// 被拒的请求一个都没删。
	var left int
	if err := e.db.QueryRow(`SELECT count(*) FROM gateway_files`).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 2 {
		t.Fatalf("被拒的 purge 删了行（剩 %d，want 2）", left)
	}

	// 单次上限 500：520 条过期行分两次才清完。
	owner := e.user(t, "gwf-bulk-owner", serverstore.RoleUser)
	e.seedMany(t, "file-bulk", owner, 520, &expired)
	w, out := adminReq(t, e.r, "POST", "/api/server/admin/gateway/files/purge",
		`{"user":"gwf-bulk-owner","state":"expired","limit":9999}`, e.hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("bulk purge = %d %s", w.Code, w.Body.String())
	}
	if n, _ := out["matched"].(float64); int(n) != 500 {
		t.Fatalf("limit=9999 matched=%v, want 500（单次上限）", out["matched"])
	}
	if n, _ := out["deleted"].(float64); int(n) != 500 {
		t.Fatalf("limit=9999 deleted=%v, want 500", out["deleted"])
	}
	if err := e.db.QueryRow(`SELECT count(*) FROM gateway_files WHERE user_id = ?`, owner).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 20 {
		t.Fatalf("首轮应剩 20 条，实得 %d", left)
	}
	// 显式小 limit 生效。
	if _, out = adminReq(t, e.r, "POST", "/api/server/admin/gateway/files/purge",
		`{"user":"gwf-bulk-owner","state":"expired","limit":7}`, e.hdr); int(out["matched"].(float64)) != 7 {
		t.Fatalf("limit=7 matched=%v, want 7", out["matched"])
	}
}

// ---------------------------------------------------------------------------
// ⑤ 分页 / 排序边界
// ---------------------------------------------------------------------------

// TestAdminGatewayFilesPaginationBoundaries：page/size 的边界与"offset 与生效 size
// 同源"。size 缺省/非法时生效的是 DAO 的缺省 50 —— offset 必须按 50 算，否则
// `?page=N`（不带 size）永远返回第一页。
func TestAdminGatewayFilesPaginationBoundaries(t *testing.T) {
	e := gwfSetup(t)
	uid := e.user(t, "gwf-page-owner", serverstore.RoleUser)
	future := time.Now().Add(time.Hour)
	e.seedMany(t, "file-page", uid, 250, &future)

	// 参考序列：两页 200 拼出的完整顺序（created_at, file_id）。
	_, p1, _ := e.get(t, "?size=200&page=1", e.hdr)
	_, p2, _ := e.get(t, "?size=200&page=2", e.hdr)
	if len(p1) != 200 || len(p2) != 50 {
		t.Fatalf("参考页大小 = %d/%d, want 200/50", len(p1), len(p2))
	}
	all := append(gwfIDs(p1), gwfIDs(p2)...)

	// size 边界。
	for _, tc := range []struct {
		query string
		want  int
	}{
		{"?size=1", 1},
		{"?size=200", 200},
		{"?size=201", 200},  // 夹到 200
		{"?size=9999", 200}, // 夹到 200
		{"?size=0", 50},     // 生效缺省 50
		{"", 50},            // 缺省 50
		{"?size=abc", 50},   // 非法 ⇒ 缺省
		{"?size=-3", 50},    // 负数 ⇒ 缺省
	} {
		code, rows, _ := e.get(t, tc.query, e.hdr)
		if code != http.StatusOK {
			t.Fatalf("GET %s = %d", tc.query, code)
		}
		if len(rows) != tc.want {
			t.Fatalf("GET %s rows=%d, want %d", tc.query, len(rows), tc.want)
		}
	}

	// page 边界：第 N 页的第一条必须真的等于参考序列的第 N 条。
	for _, page := range []int{1, 2, 3, 100, 250} {
		_, rows, _ := e.get(t, fmt.Sprintf("?size=1&page=%d", page), e.hdr)
		if len(rows) != 1 {
			t.Fatalf("size=1&page=%d rows=%d, want 1", page, len(rows))
		}
		if got := gwfIDs(rows)[0]; got != all[page-1] {
			t.Fatalf("size=1&page=%d 首行=%s, want %s", page, got, all[page-1])
		}
	}
	// page=0 / 负数 / 非法 ⇒ 第 1 页。
	for _, q := range []string{"?size=1&page=0", "?size=1&page=-4", "?size=1&page=xx"} {
		_, rows, _ := e.get(t, q, e.hdr)
		if got := gwfIDs(rows)[0]; got != all[0] {
			t.Fatalf("%s 首行=%s, want %s（应回落第 1 页）", q, got, all[0])
		}
	}
	// 越界页 ⇒ 空集（不是回到第 1 页）。
	for _, q := range []string{"?size=200&page=99999", "?size=50&page=99999", "?page=99999"} {
		_, rows, out := e.get(t, q, e.hdr)
		if len(rows) != 0 {
			t.Fatalf("%s rows=%d, want 0（越界页不得回到第 1 页）", q, len(rows))
		}
		if n, _ := out["total"].(float64); int(n) != 250 {
			t.Fatalf("%s total=%v, want 250（total 恒为过滤后总数）", q, out["total"])
		}
	}
	// 关键判据：不带 size 的 page 必须按**生效的** 50 算 offset。
	// 旧实现 `q.Offset=(page-1)*q.Limit` 在 size 缺省时算出 0 ⇒ page 被静默忽略。
	_, rows, _ := e.get(t, "?page=3", e.hdr)
	if len(rows) != 50 {
		t.Fatalf("page=3（无 size）rows=%d, want 50", len(rows))
	}
	if got := gwfIDs(rows)[0]; got != all[100] {
		t.Fatalf("page=3（无 size）首行=%s, want %s（offset 必须与生效 size=50 同源）", got, all[100])
	}
	// 极大页号不得因 (page-1)*size 溢出成负 offset 而回落到第 1 页。
	_, rows, _ = e.get(t, "?size=200&page=9223372036854775807", e.hdr)
	if len(rows) != 0 {
		t.Fatalf("page=MaxInt64 rows=%d, want 0（溢出成负 offset 会静默返回第一页）", len(rows))
	}

	// sort 白名单外值 ⇒ 回落 created_at（默认降序）。
	_, base, _ := e.get(t, "", e.hdr)
	for _, q := range []string{"?sort=bogus", "?sort=created_at%3BDROP%20TABLE%20gateway_files", "?sort=", "?sort=size_bytes%20DESC"} {
		_, rows, _ := e.get(t, q, e.hdr)
		if got, want := gwfIDs(rows), gwfIDs(base); len(got) != len(want) || got[0] != want[0] {
			t.Fatalf("%s 首行=%v, want %v（白名单外 sort 必须回落 created_at）", q, got[:1], want[:1])
		}
	}
	// order 只有 asc 生效，其余一律 desc（all[0] 是最新、all[249] 是最早）。
	_, asc, _ := e.get(t, "?order=asc", e.hdr)
	if got := gwfIDs(asc)[0]; got != all[249] {
		t.Fatalf("order=asc 首行=%s, want %s（升序 = 最早在前）", got, all[249])
	}
	_, desc, _ := e.get(t, "", e.hdr)
	if got := gwfIDs(desc)[0]; got != all[0] {
		t.Fatalf("缺省 order 首行=%s, want %s（默认 desc）", got, all[0])
	}
	for _, q := range []string{"?order=ASC", "?order=desc", "?order=up"} {
		_, rows, _ := e.get(t, q, e.hdr)
		if got := gwfIDs(rows)[0]; got != all[0] {
			t.Fatalf("%s 首行=%s, want %s（非 asc 一律 desc）", q, got, all[0])
		}
	}
	// sort 白名单内取值必须真的换列：size_bytes 升序首行是最小 size 的那条。
	_, bySize, _ := e.get(t, "?sort=size_bytes&order=asc&size=1", e.hdr)
	if got := gwfIDs(bySize)[0]; got != "file-page-0000" {
		t.Fatalf("sort=size_bytes&order=asc 首行=%s, want file-page-0000", got)
	}
}

// ---------------------------------------------------------------------------
// ⑥ 审计
// ---------------------------------------------------------------------------

// TestAdminGatewayFilesPageHonouredWithoutSize：**页码必须在 size 缺省时也生效**
// （回归 N4）。
//
// 缺陷形态：`adminFileQuery` 只在 `size > 0` 时才设 `q.Limit`，而 offset 又按
// `q.Limit` 算 ⇒ size 缺省时 offset 恒为 0，`?page=N` 永远返回第一页（翻页按钮像是
// 坏的）。这里用 60 行做最小判别：缺省 50 一页，第 2 页只能是剩下的 10 行。
func TestAdminGatewayFilesPageHonouredWithoutSize(t *testing.T) {
	e := gwfSetup(t)
	uid := e.user(t, "gwf-page2-owner", serverstore.RoleUser)
	future := time.Now().Add(time.Hour)
	e.seedMany(t, "file-pg", uid, 60, &future)

	// 参考顺序（缺省 desc，created_at + file_id 兜底）。
	_, full, _ := e.get(t, "?size=200", e.hdr)
	if len(full) != 60 {
		t.Fatalf("前置条件：应有 60 行，实得 %d", len(full))
	}
	all := gwfIDs(full)

	// 第 1 页 = 前 50 行；第 2 页 = 后 10 行（不带 size）。
	_, p1, _ := e.get(t, "?page=1", e.hdr)
	if len(p1) != 50 || gwfIDs(p1)[0] != all[0] {
		t.Fatalf("page=1 rows=%d 首行=%v, want 50/[%s]", len(p1), gwfIDs(p1)[:1], all[0])
	}
	_, p2, _ := e.get(t, "?page=2", e.hdr)
	if len(p2) != 10 {
		t.Fatalf("page=2（不带 size）rows=%d, want 10 —— 页码被忽略时这里会是 50（第一页）", len(p2))
	}
	if got, want := gwfIDs(p2), all[50:60]; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("page=2（不带 size）= %v, want %v", got, want)
	}
	// 第 3 页越界 ⇒ 空集（不是回到第一页）。
	if _, p3, _ := e.get(t, "?page=3", e.hdr); len(p3) != 0 {
		t.Fatalf("page=3（不带 size）rows=%d, want 0", len(p3))
	}
	// 显式 size 的组合：size=20&page=3 ⇒ 第 41~60 行。
	_, p320, _ := e.get(t, "?size=20&page=3", e.hdr)
	if got, want := gwfIDs(p320), all[40:60]; fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("size=20&page=3 = %v, want %v（第 41~60 行）", got, want)
	}
}

// TestAdminGatewayFilesListStateWhitelist：列表侧 `state` 与 purge 侧同一口径 ——
// 未知取值必须 400，不能静默忽略（静默忽略 = 过滤条件消失：管理员看着"已过期"的
// 筛选结果，实际拿到的是全量台账）。合法取值只有 active/expired/all（空 = all）。
func TestAdminGatewayFilesListStateWhitelist(t *testing.T) {
	e := gwfSetup(t)
	uid := e.user(t, "gwf-state-owner", serverstore.RoleUser)
	active := time.Now().Add(time.Hour)
	expired := time.Now().Add(-time.Minute)
	e.seed(t, "file-state-active", uid, &active, 0)
	e.seed(t, "file-state-expired", uid, &expired, 0)

	for _, q := range []string{"?state=weird", "?state=none", "?state=ACTIVE", "?state=all2"} {
		w, out := adminReq(t, e.r, "GET", "/api/server/admin/gateway/files"+q, "", e.hdr)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("GET files%s = %d, want 400 (%s)", q, w.Code, w.Body.String())
		}
		if code, _ := out["error"].(map[string]any); code["code"] != "VALIDATION" {
			t.Fatalf("GET files%s envelope = %v, want VALIDATION", q, out)
		}
	}
	// 合法取值照常生效，且语义不变。
	for _, tc := range []struct {
		query string
		want  int
	}{
		{"", 2},
		{"?state=all", 2},
		{"?state=expired", 1},
		{"?state=active", 1},
	} {
		code, rows, out := e.get(t, tc.query, e.hdr)
		if code != http.StatusOK {
			t.Fatalf("GET files%s = %d", tc.query, code)
		}
		if len(rows) != tc.want {
			t.Fatalf("GET files%s rows=%d, want %d", tc.query, len(rows), tc.want)
		}
		if n, _ := out["total"].(float64); int(n) != tc.want {
			t.Fatalf("GET files%s total=%v, want %d", tc.query, out["total"], tc.want)
		}
	}
	// 未知 state 的请求一个字段都没被误用：全量仍是 2 行。
	var left int
	if err := e.db.QueryRow(`SELECT count(*) FROM gateway_files`).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 2 {
		t.Fatalf("被拒的列表请求改动了数据（left=%d）", left)
	}
}

// TestAdminGatewayFilesAuditTrail：delete 每次 1 条、purge 每次 1 条（不多不少），
// detail 含范围与计数、且不含上游密钥等敏感内容。
func TestAdminGatewayFilesAuditTrail(t *testing.T) {
	e := gwfSetup(t)
	alice := e.user(t, "gwf-audit-alice", serverstore.RoleUser)
	bob := e.user(t, "gwf-audit-bob", serverstore.RoleUser)
	future := time.Now().Add(time.Hour)
	expired := time.Now().Add(-time.Minute)
	e.seed(t, "file-audit-a1", alice, &future, 100)
	e.seed(t, "file-audit-a2", alice, &expired, 200)
	e.seed(t, "file-audit-b1", bob, &expired, 300)

	// 单删两次 ⇒ 恰好 2 条 gateway_file_delete，detail 各自只含自己的 file_id。
	for _, id := range []string{"file-audit-a1", "file-audit-b1"} {
		if w, _ := adminReq(t, e.r, "DELETE", "/api/server/admin/gateway/files/"+id, "", e.hdr); w.Code != http.StatusOK {
			t.Fatalf("delete %s = %d", id, w.Code)
		}
	}
	del := gwfAudit(t, e.db, "gateway_file_delete")
	if len(del) != 2 {
		t.Fatalf("gateway_file_delete 审计行 = %d, want 2 (%v)", len(del), del)
	}
	for i, want := range []string{"file-audit-a1", "file-audit-b1"} {
		if !strings.Contains(del[i], want) {
			t.Fatalf("delete 审计 detail=%q 未含 file_id=%s", del[i], want)
		}
	}
	// 被拒的删除（形状非法 ⇒ 404）不得留审计。
	if w, _ := adminReq(t, e.r, "DELETE", "/api/server/admin/gateway/files/..%2fetc", "", e.hdr); w.Code == http.StatusOK {
		t.Fatalf("非法 file_id 应被拒，实得 200")
	}
	if n := len(gwfAudit(t, e.db, "gateway_file_delete")); n != 2 {
		t.Fatalf("被拒的删除留了审计行: %d, want 2", n)
	}

	// purge 两次（每次恰好命中 1 条）⇒ 恰好 2 条，detail 含范围与计数。
	carol := e.user(t, "gwf-audit-carol", serverstore.RoleUser)
	for i := 0; i < 2; i++ {
		e.seed(t, fmt.Sprintf("file-audit-exp-%d", i), carol, &expired, 0)
		w, out := adminReq(t, e.r, "POST", "/api/server/admin/gateway/files/purge",
			`{"user":"gwf-audit-carol","state":"expired"}`, e.hdr)
		if w.Code != http.StatusOK {
			t.Fatalf("purge #%d = %d", i, w.Code)
		}
		// 审计 detail 的计数必须与响应逐项一致（不是各写各的）。
		if n, _ := out["deleted"].(float64); int(n) != 1 {
			t.Fatalf("purge #%d deleted=%v, want 1", i, out["deleted"])
		}
	}
	purge := gwfAudit(t, e.db, "gateway_file_purge")
	if len(purge) != 2 {
		t.Fatalf("gateway_file_purge 审计行 = %d, want 2 (%v)", len(purge), purge)
	}
	for _, d := range purge {
		for _, want := range []string{"user=gwf-audit-carol", "state=expired", "删除 1", "失败 0", "命中 1"} {
			if !strings.Contains(d, want) {
				t.Fatalf("purge 审计 detail=%q 缺少 %q", d, want)
			}
		}
	}
	// 被拒的 purge（无条件）不得留审计。
	if w, _ := adminReq(t, e.r, "POST", "/api/server/admin/gateway/files/purge", `{}`, e.hdr); w.Code != http.StatusBadRequest {
		t.Fatal("无条件 purge 应 400")
	}
	if n := len(gwfAudit(t, e.db, "gateway_file_purge")); n != 2 {
		t.Fatalf("被拒的 purge 留了审计行: %d, want 2", n)
	}

	// 敏感内容：审计 detail 只允许"范围 + 计数"，不得带上游密钥 / DSN / 请求体。
	for _, d := range append(append([]string{}, del...), purge...) {
		for _, secret := range []string{upstreamKey, e.up.srv.URL, "Bearer "} {
			if strings.Contains(d, secret) {
				t.Fatalf("审计 detail 泄漏敏感内容 %q: %s", secret, d)
			}
		}
	}
}

// TestAdminGatewayFilesPurgeAuditScopeIsEffective：审计 detail 里的范围必须是
// **生效后**的范围。`state` 与 `expired_only` 是同一件事的两种写法，组合出现时
// 逐块追加会写出 "state=active state=expired" 这种自相矛盾的明细（事后无法据
// 审计判断管理员到底清了什么）。
func TestAdminGatewayFilesPurgeAuditScopeIsEffective(t *testing.T) {
	e := gwfSetup(t)
	uid := e.user(t, "gwf-scope-owner", serverstore.RoleUser)
	active := time.Now().Add(time.Hour)
	expired := time.Now().Add(-time.Minute)
	e.seed(t, "file-scope-active", uid, &active, 0)
	e.seed(t, "file-scope-expired", uid, &expired, 0)

	// state=active 与 expired_only=true 同时给：生效的是"已过期"（expired_only 优先），
	// 审计只能写 effective 的那一个。
	w, out := adminReq(t, e.r, "POST", "/api/server/admin/gateway/files/purge",
		`{"user":"gwf-scope-owner","state":"active","expired_only":true}`, e.hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("purge = %d %s", w.Code, w.Body.String())
	}
	if n, _ := out["matched"].(float64); int(n) != 1 || int(out["deleted"].(float64)) != 1 {
		t.Fatalf("matched/deleted = %v/%v, want 1/1（expired_only 优先）", out["matched"], out["deleted"])
	}
	// 仍在有效期的文件必须留下（范围收敛在"已过期"）。
	var left int
	if err := e.db.QueryRow(`SELECT count(*) FROM gateway_files WHERE user_id = ?`, uid).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 1 {
		t.Fatalf("有效文件被过期范围的 purge 删掉了（left=%d, want 1）", left)
	}
	rows := gwfAudit(t, e.db, "gateway_file_purge")
	if len(rows) != 1 {
		t.Fatalf("审计行 = %d, want 1 (%v)", len(rows), rows)
	}
	d := rows[0]
	if !strings.Contains(d, "state=expired") {
		t.Fatalf("审计 detail=%q 未写明生效范围 state=expired", d)
	}
	if strings.Contains(d, "state=active") {
		t.Fatalf("审计 detail=%q 写了自相矛盾的范围（state=active 未生效）", d)
	}
}

// TestAdminGatewayFilesDeleteUpstreamFailureLeavesRow：上游删除失败必须 502、
// **不删台账行**、不写审计（重试才有意义：行还在 ⇒ 管理员能再点一次）。
func TestAdminGatewayFilesDeleteUpstreamFailureLeavesRow(t *testing.T) {
	e := gwfSetup(t)
	uid := e.user(t, "gwf-fail-owner", serverstore.RoleUser)
	future := time.Now().Add(time.Hour)
	e.seed(t, "file-fail-1", uid, &future, 5)
	e.up.respond = func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusInternalServerError)
			fmt.Fprint(w, `{"error":{"message":"boom"}}`)
			return
		}
		fmt.Fprint(w, `{"id":"file-fail-1","object":"file","deleted":true}`)
	}
	w, _ := adminReq(t, e.r, "DELETE", "/api/server/admin/gateway/files/file-fail-1", "", e.hdr)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("上游失败应 502，实得 %d (%s)", w.Code, w.Body.String())
	}
	var left int
	if err := e.db.QueryRow(`SELECT count(*) FROM gateway_files WHERE file_id = ?`, "file-fail-1").Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 1 {
		t.Fatalf("上游删除失败却删了台账行（left=%d）", left)
	}
	if n := len(gwfAudit(t, e.db, "gateway_file_delete")); n != 0 {
		t.Fatalf("失败路径不得写 gateway_file_delete 审计: %d", n)
	}

	// purge 的部分成功语义：一条失败、一条成功 ⇒ failed=1/deleted=1，失败行保留。
	e.seed(t, "file-fail-2", uid, &future, 6)
	e.up.respond = func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/file-fail-1") {
			w.WriteHeader(http.StatusBadGateway)
			fmt.Fprint(w, `{"error":{"message":"boom"}}`)
			return
		}
		fmt.Fprint(w, `{"id":"x","object":"file","deleted":true}`)
	}
	w, out := adminReq(t, e.r, "POST", "/api/server/admin/gateway/files/purge",
		`{"user":"gwf-fail-owner","state":"active"}`, e.hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("部分成功的 purge = %d %s", w.Code, w.Body.String())
	}
	if n, _ := out["deleted"].(float64); int(n) != 1 {
		t.Fatalf("deleted=%v, want 1", out["deleted"])
	}
	if n, _ := out["failed"].(float64); int(n) != 1 {
		t.Fatalf("failed=%v, want 1", out["failed"])
	}
	if err := e.db.QueryRow(`SELECT count(*) FROM gateway_files WHERE user_id = ?`, uid).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 1 {
		t.Fatalf("部分成功语义：失败行必须保留（left=%d, want 1）", left)
	}
	// 部分成功的审计仍然只有 1 条，且计数如实。
	last := gwfAudit(t, e.db, "gateway_file_purge")
	if len(last) != 1 || !strings.Contains(last[0], "删除 1 失败 1 命中 2") {
		t.Fatalf("部分成功审计 detail=%v, want 含「删除 1 失败 1 命中 2」", last)
	}
}
