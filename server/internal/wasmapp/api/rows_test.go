package api

import (
	"context"
	"net/http"
	"os"
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
