package api

// 本文件是**作者声明敏感列**（`picoaide.app.json` 的 `sensitive_columns`，§5.9 第 8 点
// 后半）在**脱敏面**（`GET …/rows`）的行为判据。
//
// 判据（每条都能被单独打坏）：
//  1. **启发式漏判的列，声明后必须被遮住** —— 用 `remark`（现成的"不得误判"清单里的
//     正常列名，见 rows_test.go 的 mustNotMask）当"启发式明确不遮"的样本；
//  2. 启发式**照旧生效**（声明是并集，不是替换）；
//  3. `masked_columns` 必须**如实列出**被遮住的声明列（它此前只反映启发式）；
//  4. 声明了但**不在结果集**里的列：静默无副作用（不进 masked_columns、不报错）；
//  5. `unmask=1` 仍是唯一看原值的通道（声明不是"更强的锁"，也不改变脱敏审计语义）。
//
// 变异验证（实跑）：
//   - 把 respondRows 里的 `|| appcfg.DeclaredSensitiveColumn(...)` 去掉
//     （或把 declaredSet 恒置 nil）⇒ 本文件第 1/3 条红；
//   - 把 masked 的收集条件改成只看 isSensitiveColumn ⇒ 第 3 条红。

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/appdb"
)

// declaredSensitiveCfg 是 goodConfig 的副本 + 作者声明（不改动共享夹具）。
func declaredSensitiveCfg(cols ...string) map[string]any {
	cfg := goodConfig()
	cfg["sensitive_columns"] = cols
	return cfg
}

// declaredSensitiveFixture 建一张 profiles 表：remark 是**启发式不管**的正常列，
// api_token 是启发式必遮的列（用来证明并集而不是替换）。
func declaredSensitiveFixture(t *testing.T, e *testEnv, appID string) {
	t.Helper()
	ctx := context.Background()
	d, err := appdb.Open(ctx, appdb.Options{DataRoot: e.dataRoot, AppID: appID})
	if err != nil {
		t.Fatalf("打开应用库失败: %v", err)
	}
	defer d.Close()
	if _, derr := d.Define(ctx, abi.DBDefineParams{
		Table: "profiles",
		Columns: []abi.ColumnDef{
			{Name: "title", Type: "text"},
			{Name: "remark", Type: "text"},
			{Name: "api_token", Type: "text"},
		},
	}); derr != nil {
		t.Fatalf("建表失败: %v", derr)
	}
	if _, xerr := d.Exec(ctx, abi.SQLParams{
		SQL:  "INSERT INTO profiles (title, remark, api_token) VALUES (?, ?, ?)",
		Args: []any{"工位 A", "员工宿舍 3 号楼 512", "secret-token-1"},
	}); xerr != nil {
		t.Fatalf("写入失败: %v", xerr)
	}
}

// TestRowsDeclaredSensitiveColumnsAreMasked 是第 1~3 条判据。
func TestRowsDeclaredSensitiveColumnsAreMasked(t *testing.T) {
	e := newTestEnv(t)
	// 声明两列：remark（表里有、启发式不遮）与 ghost_column（表里没有）。
	e.publishOK(e.tokens["alice"], "profiles-app", "1.0.0", testGuestModule(t),
		declaredSensitiveCfg("remark", "Ghost_Column"))
	declaredSensitiveFixture(t, e, "profiles-app")

	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/profiles-app/rows?table=profiles", e.tokens["alice"], nil)
	var out rowsBody
	e.decodeJSON(w, http.StatusOK, &out)
	r := out.Rows

	idx := map[string]int{}
	for i, c := range r.Columns {
		idx[c.Name] = i
	}
	remarkAt, ok := idx["remark"]
	if !ok {
		t.Fatalf("夹具缺少 remark 列：%+v", r.Columns)
	}
	if !r.Columns[remarkAt].Sensitive {
		t.Fatalf("声明的列 remark 必须被标成 sensitive（启发式不管它，声明是唯一通道）：%+v", r.Columns)
	}
	// 第 3 条：masked_columns 必须如实列出被遮住的声明列（此处恰有两列：声明的 remark
	// 与启发式命中的 api_token）。
	if len(r.MaskedColumns) != 2 || !contains(r.MaskedColumns, "remark") || !contains(r.MaskedColumns, "api_token") {
		t.Fatalf("masked_columns = %v，期望恰好 [remark api_token] —— "+
			"声明的列被真的遮住时必须出现在这里（客户端/AI 据此解释 ***）", r.MaskedColumns)
	}
	// 第 4 条：声明了但结果集里没有的列，静默（不进 masked_columns）。
	if contains(r.MaskedColumns, "Ghost_Column") || contains(r.MaskedColumns, "ghost_column") {
		t.Fatalf("不在结果集里的声明列不得出现在 masked_columns 里：%v", r.MaskedColumns)
	}
	// 值真的被遮住（不是只标了个 flag）。
	for _, row := range r.Rows {
		if row[remarkAt] != "***" {
			t.Fatalf("声明的列必须输出 ***，实际 %v", row[remarkAt])
		}
		if got, _ := row[idx["title"]].(string); got != "工位 A" {
			t.Fatalf("未声明的正常列必须原样可读（声明不得扩大误伤）：%v", row[idx["title"]])
		}
	}
	// 第 2 条：启发式照旧（api_token 未声明也必须被遮）。
	if !contains(r.MaskedColumns, "api_token") {
		t.Fatalf("声明是**并集**：启发式命中的 api_token 仍必须被遮：%v", r.MaskedColumns)
	}
}

// TestRowsDeclaredColumnsStillUnmaskable 是第 5 条判据。
func TestRowsDeclaredColumnsStillUnmaskable(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "profiles-app", "1.0.0", testGuestModule(t),
		declaredSensitiveCfg("remark"))
	declaredSensitiveFixture(t, e, "profiles-app")

	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/profiles-app/rows?table=profiles&unmask=1", e.tokens["alice"], nil)
	var out rowsBody
	e.decodeJSON(w, http.StatusOK, &out)
	if !out.Rows.Unmasked {
		t.Fatal("unmask=1 时响应必须标记 unmasked")
	}
	if len(out.Rows.MaskedColumns) != 0 {
		t.Fatalf("显式看原值时 masked_columns 必须为空（含声明列）：%v", out.Rows.MaskedColumns)
	}
	found := false
	for _, row := range out.Rows.Rows {
		for _, v := range row {
			if s, ok := v.(string); ok && strings.HasPrefix(s, "员工宿舍") {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("unmask=1 必须返回声明列的原值（声明不是「更强的锁」）")
	}
	if !contains(e.auditActions("profiles-app"), "wasm_app_rows_view_unmasked") {
		t.Fatalf("显式看原值必须单独记审计：%v", e.auditActions("profiles-app"))
	}
}

// TestRowsWithoutDeclarationKeepsHeuristicOnly 是对照组：没有声明时 remark 必须**明文**。
//
// 为什么必须有这条：否则"声明生效"可能只是"脱敏把什么都遮了"的副作用
// （对照组把"声明是必要的"这件事钉住）。
func TestRowsWithoutDeclarationKeepsHeuristicOnly(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "profiles-app", "1.0.0", testGuestModule(t), goodConfig())
	declaredSensitiveFixture(t, e, "profiles-app")

	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/profiles-app/rows?table=profiles", e.tokens["alice"], nil)
	var out rowsBody
	e.decodeJSON(w, http.StatusOK, &out)
	if contains(out.Rows.MaskedColumns, "remark") {
		t.Fatalf("没有声明时 remark 不该被遮（否则对照组失效）：%v", out.Rows.MaskedColumns)
	}
	for _, row := range out.Rows.Rows {
		for _, v := range row {
			if s, ok := v.(string); ok && strings.HasPrefix(s, "员工宿舍") {
				return // 明文可见
			}
		}
	}
	t.Fatal("没有声明时 remark 应原样可读")
}
