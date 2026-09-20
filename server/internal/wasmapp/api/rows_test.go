package api

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/appdb"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件覆盖**作者数据面**（`GET …/wasm/:app_id/rows`，2026-09-21 新增）。
//
// 安全论证与产品口径见 rows.go 头部；这里钉的是**可被打破的行为判据**：
//   - 仅发布者（他人 404 与"应用不存在"同形）；
//   - 默认脱敏 + 显式 unmask 走另一条审计动作；
//   - 分页参数收敛、单值截断、`_row_id` 不出现；
//   - 库文件不存在时**不建库**（只读端点没有写副作用）；
//   - 管理面同形可用。
//
// 变异验证（实跑过）：
//   - 去掉 respondRows 里的脱敏分支 ⇒ TestRowsMasksSensitiveColumnsByDefault 红；
//   - 去掉 `unmask` 的审计分叉 ⇒ 同用例的审计断言红；
//   - 去掉 clampInt ⇒ TestRowsClampsPaging 红；
//   - 去掉 os.Stat 预检（直接 Open）⇒ TestRowsMissingDBDoesNotCreateFile 红；
//   - 把 ownedApp 换成"任何登录用户可读" ⇒ TestRowsOthersGetNotFoundSameShape 红。

// rowsFixture 造一个应用库：一张 notes 表（含一个敏感列）+ 3 行数据。
func rowsFixture(t *testing.T, e *testEnv, appID string) {
	t.Helper()
	ctx := context.Background()
	d, err := appdb.Open(ctx, appdb.Options{DataRoot: e.dataRoot, AppID: appID})
	if err != nil {
		t.Fatalf("打开应用库失败: %v", err)
	}
	defer d.Close()
	if _, derr := d.Define(ctx, abi.DBDefineParams{
		Table: "notes",
		Columns: []abi.ColumnDef{
			{Name: "title", Type: "text"},
			{Name: "api_token", Type: "text"},
			{Name: "views", Type: "int"},
		},
	}); derr != nil {
		t.Fatalf("建表失败: %v", derr)
	}
	for i, title := range []string{"hello", "world", "third"} {
		if _, xerr := d.Exec(ctx, abi.SQLParams{
			SQL:  "INSERT INTO notes (title, api_token, views) VALUES (?, ?, ?)",
			Args: []any{title, "secret-token-" + title, i},
		}); xerr != nil {
			t.Fatalf("写入失败: %v", xerr)
		}
	}
}

type rowsBody struct {
	Rows struct {
		AppID   string `json:"app_id"`
		Table   string `json:"table"`
		Columns []struct {
			Name      string `json:"name"`
			Type      string `json:"type"`
			Sensitive bool   `json:"sensitive"`
		} `json:"columns"`
		Rows            [][]any  `json:"rows"`
		Limit           int      `json:"limit"`
		Offset          int      `json:"offset"`
		Returned        int      `json:"returned"`
		TotalRows       int64    `json:"total_rows"`
		HasMore         bool     `json:"has_more"`
		Truncated       bool     `json:"truncated"`
		TruncatedValues int      `json:"truncated_values"`
		Unmasked        bool     `json:"unmasked"`
		MaskedColumns   []string `json:"masked_columns"`
		ValueMaxBytes   int      `json:"value_max_bytes"`
	} `json:"rows"`
}

func TestRowsReturnsDataWithMaskingByDefault(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "notes-app", "1.0.0", testGuestModule(t), goodConfig())
	rowsFixture(t, e, "notes-app")

	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/notes-app/rows?table=notes", e.tokens["alice"], nil)
	var out rowsBody
	e.decodeJSON(w, http.StatusOK, &out)
	r := out.Rows
	if r.AppID != "notes-app" || r.Table != "notes" {
		t.Fatalf("回显不对: %+v", r)
	}
	if r.TotalRows != 3 || r.Returned != 3 || r.HasMore {
		t.Fatalf("分页元数据不对: total=%d returned=%d has_more=%v", r.TotalRows, r.Returned, r.HasMore)
	}
	if r.Unmasked {
		t.Fatal("缺省不得是未脱敏")
	}
	// 列结构：`_row_id` 是平台保留列，作者看到的就是应用能看到的列 ⇒ 必须不出现。
	names := map[string]bool{}
	for _, c := range r.Columns {
		names[c.Name] = true
	}
	if names[limits.ReservedRowIDColumn] {
		t.Fatalf("保留列 %s 不得出现在作者数据面: %+v", limits.ReservedRowIDColumn, r.Columns)
	}
	if !names["title"] || !names["api_token"] {
		t.Fatalf("列结构缺项: %+v", r.Columns)
	}
	// 敏感列被脱敏，非敏感列原样。
	if len(r.MaskedColumns) != 1 || r.MaskedColumns[0] != "api_token" {
		t.Fatalf("masked_columns = %v，期望 [api_token]", r.MaskedColumns)
	}
	idxToken := -1
	for i, c := range r.Columns {
		if c.Name == "api_token" {
			idxToken = i
			if !c.Sensitive {
				t.Fatal("api_token 应被标成 sensitive")
			}
		}
	}
	for _, row := range r.Rows {
		if row[idxToken] != "***" {
			t.Fatalf("敏感列必须脱敏，实际 %v", row[idxToken])
		}
	}
	// 审计：动作是 wasm_app_rows_view，且**不含行内容**。
	acts := e.auditActions("notes-app")
	if !contains(acts, "wasm_app_rows_view") {
		t.Fatalf("必须写审计 wasm_app_rows_view: %v", acts)
	}
	for _, detail := range e.auditDetails("notes-app", "wasm_app_rows_view") {
		if strings.Contains(detail, "secret-token") || strings.Contains(detail, "hello") {
			t.Fatalf("审计明细不得包含行内容（PII 不得进审计表）: %q", detail)
		}
	}
	if contains(acts, "wasm_app_rows_view_unmasked") {
		t.Fatal("未请求原值时不应出现 unmasked 审计动作")
	}
}

func TestRowsUnmaskIsExplicitAndSeparatelyAudited(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "notes-app", "1.0.0", testGuestModule(t), goodConfig())
	rowsFixture(t, e, "notes-app")

	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/notes-app/rows?table=notes&unmask=1", e.tokens["alice"], nil)
	var out rowsBody
	e.decodeJSON(w, http.StatusOK, &out)
	if !out.Rows.Unmasked {
		t.Fatal("unmask=1 时响应应标记 unmasked")
	}
	if len(out.Rows.MaskedColumns) != 0 {
		t.Fatalf("未脱敏时 masked_columns 应为空: %v", out.Rows.MaskedColumns)
	}
	found := false
	for _, row := range out.Rows.Rows {
		for _, v := range row {
			if s, ok := v.(string); ok && strings.HasPrefix(s, "secret-token-") {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("unmask=1 必须返回原值")
	}
	if !contains(e.auditActions("notes-app"), "wasm_app_rows_view_unmasked") {
		t.Fatalf("显式看原值必须单独记审计: %v", e.auditActions("notes-app"))
	}
}

func TestRowsOthersGetNotFoundSameShape(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "notes-app", "1.0.0", testGuestModule(t), goodConfig())
	rowsFixture(t, e, "notes-app")

	// bob 不是发布者：必须是 404，且与"应用不存在"**同形**（不泄露存在性）。
	other := e.decodeErr(e.req(http.MethodGet, "/api/client/v2/apps/wasm/notes-app/rows?table=notes", e.tokens["bob"], nil), http.StatusNotFound)
	missing := e.decodeErr(e.req(http.MethodGet, "/api/client/v2/apps/wasm/no-such-app/rows?table=notes", e.tokens["bob"], nil), http.StatusNotFound)
	if other.Error.Code != missing.Error.Code || other.Error.Message != missing.Error.Message {
		t.Fatalf("非发布者与不存在必须同形：%+v vs %+v", other.Error, missing.Error)
	}
}

func TestRowsValidatesTableAndPaging(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "notes-app", "1.0.0", testGuestModule(t), goodConfig())
	rowsFixture(t, e, "notes-app")

	// 缺 table / 非法表名 ⇒ 400 VALIDATION（不落到 500，也不猜一张表）。
	for _, path := range []string{
		"/api/client/v2/apps/wasm/notes-app/rows",
		"/api/client/v2/apps/wasm/notes-app/rows?table=Notes",    // 大写
		"/api/client/v2/apps/wasm/notes-app/rows?table=notes%3B", // 分号
		"/api/client/v2/apps/wasm/notes-app/rows?table=" + strings.Repeat("a", 40),
	} {
		body := e.decodeErr(e.req(http.MethodGet, path, e.tokens["alice"], nil), http.StatusBadRequest)
		if body.Error.Code != "VALIDATION" {
			t.Fatalf("%s 应回 VALIDATION，实际 %s", path, body.Error.Code)
		}
	}

	// 表不存在 ⇒ 404 且给出 available_tables（作者/AI 能据此改对）。
	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/notes-app/rows?table=missing", e.tokens["alice"], nil)
	body := e.decodeErr(w, http.StatusNotFound)
	if body.Error.Details["table"] != "missing" {
		t.Fatalf("details.table = %v", body.Error.Details)
	}

	// 分页参数收敛：limit 超上限截到 200、offset 超上限截到 100 万；负数归零。
	w = e.req(http.MethodGet, "/api/client/v2/apps/wasm/notes-app/rows?table=notes&limit=9999&offset=-5", e.tokens["alice"], nil)
	var out rowsBody
	e.decodeJSON(w, http.StatusOK, &out)
	if out.Rows.Limit != 200 || out.Rows.Offset != 0 {
		t.Fatalf("分页参数应收敛：limit=%d offset=%d", out.Rows.Limit, out.Rows.Offset)
	}
	// limit=2 时 has_more=true（3 行数据）。
	w = e.req(http.MethodGet, "/api/client/v2/apps/wasm/notes-app/rows?table=notes&limit=2", e.tokens["alice"], nil)
	var page rowsBody
	e.decodeJSON(w, http.StatusOK, &page)
	if page.Rows.Returned != 2 || !page.Rows.HasMore || page.Rows.TotalRows != 3 {
		t.Fatalf("翻页元数据不对: %+v", page.Rows)
	}
}

func TestRowsTruncatesLongValues(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "big-app", "1.0.0", testGuestModule(t), goodConfig())
	ctx := context.Background()
	d, err := appdb.Open(ctx, appdb.Options{DataRoot: e.dataRoot, AppID: "big-app"})
	if err != nil {
		t.Fatalf("打开应用库失败: %v", err)
	}
	if _, derr := d.Define(ctx, abi.DBDefineParams{
		Table:   "blobs",
		Columns: []abi.ColumnDef{{Name: "body", Type: "text"}},
	}); derr != nil {
		t.Fatalf("建表失败: %v", derr)
	}
	long := strings.Repeat("x", rowsMaxValueBytes+100)
	if _, xerr := d.Exec(ctx, abi.SQLParams{SQL: "INSERT INTO blobs (body) VALUES (?)", Args: []any{long}}); xerr != nil {
		t.Fatalf("写入失败: %v", xerr)
	}
	_ = d.Close()

	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/big-app/rows?table=blobs", e.tokens["alice"], nil)
	var out rowsBody
	e.decodeJSON(w, http.StatusOK, &out)
	if out.Rows.TruncatedValues != 1 {
		t.Fatalf("应报告 1 个被截断的值，实际 %d", out.Rows.TruncatedValues)
	}
	if got := len(out.Rows.Rows[0][0].(string)); got != rowsMaxValueBytes {
		t.Fatalf("截断后长度 = %d，期望 %d", got, rowsMaxValueBytes)
	}
}

// TestRowsMissingDBDoesNotCreateFile 是"只读端点没有写副作用"的判据。
//
// 修复前若直接 `appdb.Open`（rwc 模式），SQLite 会把**不存在的库建出来** ——
// 作者点一次"数据"就会在数据根里留下一个空库，而"这个应用还没被用过"这个事实
// 也随之消失。判据 = 请求后文件仍不存在。
func TestRowsMissingDBDoesNotCreateFile(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "fresh-app", "1.0.0", testGuestModule(t), goodConfig())

	path, perr := appdb.Path(e.dataRoot, "fresh-app")
	if perr != nil {
		t.Fatalf("Path: %v", perr)
	}
	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/fresh-app/rows?table=notes", e.tokens["alice"], nil)
	e.decodeErr(w, http.StatusNotFound)
	if _, err := os.Stat(path); err == nil {
		t.Fatalf("只读端点不得创建库文件：%s 已存在", path)
	}
	// 目录也不能被建出来（2026-09-21 审计 P2-1：旧实现的 helper 会 MkdirAll）。
	if _, err := os.Stat(filepath.Dir(path)); err == nil {
		t.Fatalf("只读端点不得创建应用数据目录：%s 已存在", filepath.Dir(path))
	}
}

// TestSchemaMissingDBCreatesNothing 是 P2-1 的另一半：`/schema` 与 `/rows` 必须同语义。
//
// 修复前：`/schema` 的 helper 首句是 `appdb.Open`（MkdirAll + rwc 建库）⇒ 一次"看表结构"
// 就把库建出来了；`/rows` 只是恰好被自己的 stat 预检挡住。现在两者共用
// `appDBReadOnly`（`appdb.SafePath` + `mode=ro`），写副作用在结构上不可能。
//
// 判据三条一起：HTTP 200（"还没写过数据"是状态而不是错误）+ `initialized=false`
// + **库文件与目录都不存在**。
func TestSchemaMissingDBCreatesNothing(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "fresh-app", "1.0.0", testGuestModule(t), goodConfig())

	path, perr := appdb.Path(e.dataRoot, "fresh-app")
	if perr != nil {
		t.Fatalf("Path: %v", perr)
	}
	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/fresh-app/schema", e.tokens["alice"], nil)
	var out struct {
		Schema struct {
			Initialized bool  `json:"initialized"`
			TableCount  int   `json:"table_count"`
			SizeBytes   int64 `json:"size_bytes"`
		} `json:"schema"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if out.Schema.Initialized || out.Schema.TableCount != 0 || out.Schema.SizeBytes != 0 {
		t.Fatalf("空库的自省应是 initialized=false / 0 表 / 0 字节：%+v", out.Schema)
	}
	if _, err := os.Stat(path); err == nil {
		t.Fatalf("自省不得创建库文件：%s 已存在", path)
	}
	if _, err := os.Stat(filepath.Dir(path)); err == nil {
		t.Fatalf("自省不得创建应用数据目录：%s 已存在", filepath.Dir(path))
	}
}

// TestDataSurfaceRejectsSymlinkedAppDir 覆盖 P2-4 的纵深防御：应用目录被替换成
// 指向**别的应用库**的符号链接时，两个只读端点都必须 fail-closed（而不是读到别人的数据）。
//
// 可达性很低（要宿主数据根的写权限），但判据很便宜：一次 Lstat。与 assets 侧
// "逐段拒符号链接"同口径。
func TestDataSurfaceRejectsSymlinkedAppDir(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "app-a", "1.0.0", testGuestModule(t), goodConfig())
	e.publishOK(e.tokens["alice"], "app-b", "1.0.0", testGuestModule(t), goodConfig())
	// 让 app-b 有真数据，再把 app-a 的目录换成指向 app-b 的符号链接。
	rowsFixture(t, e, "app-b")
	pathA, perr := appdb.Path(e.dataRoot, "app-a")
	if perr != nil {
		t.Fatalf("Path: %v", perr)
	}
	dirA := filepath.Dir(pathA)
	if err := os.RemoveAll(dirA); err != nil {
		t.Fatal(err)
	}
	dirB := filepath.Dir(mustPath(t, e, "app-b"))
	if err := os.Symlink(dirB, dirA); err != nil {
		t.Skipf("本机不支持符号链接: %v", err)
	}

	for _, req := range []string{
		"/api/client/v2/apps/wasm/app-a/schema",
		"/api/client/v2/apps/wasm/app-a/rows?table=notes",
	} {
		w := e.req(http.MethodGet, req, e.tokens["alice"], nil)
		// fail-closed：既不是 200（读到别人的数据），也不是 404（把配置问题说成"应用不存在"）。
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("%s 必须 fail-closed（500），实际 %d：%s", req, w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "secret-token") {
			t.Fatalf("%s 泄漏了别的应用的数据：%s", req, w.Body.String())
		}
	}
}

// mustPath 是 appdb.Path 的测试便捷包装。
func mustPath(t *testing.T, e *testEnv, appID string) string {
	t.Helper()
	path, perr := appdb.Path(e.dataRoot, appID)
	if perr != nil {
		t.Fatalf("Path(%s): %v", appID, perr)
	}
	return path
}

func TestAdminRowsAndSchemaAvailable(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "notes-app", "1.0.0", testGuestModule(t), goodConfig())
	rowsFixture(t, e, "notes-app")

	w := e.req(http.MethodGet, "/api/server/admin/wasm-apps/notes-app/rows?table=notes", "", nil)
	var out rowsBody
	e.decodeJSON(w, http.StatusOK, &out)
	if out.Rows.TotalRows != 3 {
		t.Fatalf("管理面行浏览应可用: %+v", out.Rows)
	}
	if !contains(e.auditActions("notes-app"), "wasm_app_rows_view") {
		t.Fatal("管理面读取同样要写审计")
	}

	w = e.req(http.MethodGet, "/api/server/admin/wasm-apps/notes-app/schema", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("管理面自省应可用，得到 %d：%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"notes"`) {
		t.Fatalf("管理面自省应包含表清单：%s", w.Body.String())
	}
}

// TestSchemaAuditHappensAfterSuccessfulRead 钉住"审计行 = 真的发生过一次成功读取"。
//
// 背景（2026-09-21 独立审计 P3-⑧）：三个自省面的审计时机此前不一致 ——
// `rows` 读成功才写，`schema`/`adminSchema` 在 `inspectAppDB` **之前**就写。
// 后者让"库损坏 / 连接失败"这类失败也留下一条"查看了表结构"，审计对账会看到
// 根本没发生的读取。
//
// 为什么用源码断言：`inspectAppDB` 对"库不存在"是**成功**返回（`initialized=false`），
// 所以用"缺库"构造不出失败路径；要构造真失败需要造一个损坏的库文件，属于
// "为了测试而制造环境病态"。这里断言的是**语句顺序**这个更直接、也更难绕过的判据：
// 在同一个函数体里，`inspectAppDB` 必须出现在 `auditApp` 之前。
//
// 变异验证：把任一处的两行顺序换回来 ⇒ 本用例红。
func TestSchemaAuditHappensAfterSuccessfulRead(t *testing.T) {
	cases := []struct {
		file string
		fn   string
	}{
		{"read.go", "func (h *Handlers) schema(c *gin.Context) {"},
		{"rows.go", "func (h *Handlers) adminSchema(c *gin.Context) {"},
	}
	for _, tc := range cases {
		t.Run(tc.fn, func(t *testing.T) {
			raw, err := os.ReadFile(tc.file)
			if err != nil {
				t.Fatalf("读 %s: %v", tc.file, err)
			}
			body := string(raw)
			start := strings.Index(body, tc.fn)
			if start < 0 {
				t.Fatalf("%s 里找不到 %q（函数改名后本判据会静默失效）", tc.file, tc.fn)
			}
			// 只取函数体开头一段（到下一个顶层 `}` 之前足够覆盖这个顺序）。
			seg := body[start:]
			if end := strings.Index(seg, "\n}\n"); end > 0 {
				seg = seg[:end]
			}
			readAt := strings.Index(seg, "inspectAppDB(")
			auditAt := strings.Index(seg, `"wasm_app_schema_view"`)
			if readAt < 0 || auditAt < 0 {
				t.Fatalf("%s 的 %s 里应同时含 inspectAppDB 与 wasm_app_schema_view 审计（读取 %d / 审计 %d）",
					tc.file, tc.fn, readAt, auditAt)
			}
			if auditAt < readAt {
				t.Fatalf("%s 的 %s 在读取之前就写审计（审计时机必须与 rows 一致：读成功才记账）", tc.file, tc.fn)
			}
		})
	}
}

// TestSensitiveColumnHeuristicCoversBusinessVocabulary 是默认脱敏启发式的**覆盖面判据**。
//
// 背景（2026-09-21 三轮独立审计 P2-③）：实测 29 个常见业务列名里 **22 个漏判** ——
// 姓名/地址/生日/薪资/银行账号/IP，以及**全部拼音写法**（`shoujihao`/`xingming`/
// `shenfenzheng`/`dizhi`…）。漏判的后果不是"作者看不到数据"，而是"**使用者的 PII 进
// 模型上下文**"：AI 工具面默认开着、没有 `unmask` 参数，它拿到的就是这份默认视图 ——
// 所以启发式的覆盖面**就是**"AI 只看脱敏数据"这句承诺的实际强度。
//
// 判据两条，缺一不可：
//  1. **必须命中**的清单（业务库里指认到人的列）逐个断言敏感；
//  2. **不得误判**的清单（按子串/词根会误伤的高频正常列）逐个断言不敏感 ——
//     只加不查误判的用例会把启发式推向"什么都遮"，那等于把排障面关掉。
//
// 变异验证：删掉 sensitiveColumnTokens 里的 "realname"/"salary"/"dizhi" 任一项 ⇒ ①红；
// 把 "name" 加进 sensitiveColumnTokens（而不是 Names 整名表）⇒ ②红（hostname/filename 被误判）。
func TestSensitiveColumnHeuristicCoversBusinessVocabulary(t *testing.T) {
	mustMask := []string{
		// 身份
		"password", "pwd", "api_token", "secret_key", "id_card", "idcard", "passport",
		"real_name", "realname", "full_name", "fullname", "user_name", "username",
		"first_name", "last_name", "nickname", "surname",
		// 联系方式与位置
		"phone", "mobile", "tel", "email", "address", "addr", "postcode", "zipcode",
		// 人口属性
		"birthday", "birthdate", "dob",
		// 财务
		"salary", "wage", "bank_account", "account_no", "iban",
		// 网络身份
		"ip_addr", "ip_address", "mac_addr", "imei",
		// 中文业务库常见拼音列名（此前 100% 漏判）
		"shoujihao", "xingming", "shenfenzheng", "dizhi", "shengri", "yinhangzhanghao", "mima",
		// 整名匹配类
		"wechat", "contact",
	}
	for _, col := range mustMask {
		if !isSensitiveColumn(col) {
			t.Errorf("列名 %q 必须按默认策略脱敏（漏判 = 使用者 PII 进模型上下文；"+
				"确属正常业务列请把它加进本用例的不得误判清单并说明理由）", col)
		}
	}

	mustNotMask := []string{
		// 与 "name" 同形但不指认到人的高频列（误判的代价 = 排障时看不到有用数据）
		"hostname", "filename", "file_name", "table_name", "app_name", "display_name",
		"nick_name_label", // 注意：nickname 已由 token 覆盖，这条是「标签」语义
		"content", "gender", "note", "remark", "title", "status", "enabled",
		"created_at", "updated_at", "count", "total", "amount", "price", "score",
	}
	for _, col := range mustNotMask {
		if isSensitiveColumn(col) {
			t.Errorf("列名 %q 不应按默认策略脱敏（误判会让作者在排障时看不到有用数据）", col)
		}
	}
}
