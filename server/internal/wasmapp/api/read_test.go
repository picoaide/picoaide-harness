package api

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/appdb"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// ===========================================================================
// §8 只读面：诊断 / 自省 / 应用中心目录
// ===========================================================================

// TestDiagnosticsReturnsFailuresAndHints 覆盖 §4.9 的诊断 API：失败记录 +
// 概览 + **可操作 hints**（第一消费者是 AI）。
func TestDiagnosticsReturnsFailuresAndHints(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "diag-tool", "1.0.0", testGuestModule(t), goodConfig())

	// 直接写调用事件表（它是运行时的观测面，由 runtime/edge 写入；本用例只验证
	// 读取路径把"失败 + hints"完整地交给调用方）。
	insert := `INSERT INTO wasm_call_events
		(app_id, user_id, outcome, reason_code, guest_exit_code, stderr_tail, cpu_ms, peak_memory_bytes, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`
	now := time.Now().UTC()
	for _, row := range []struct {
		outcome, reason string
		exit            int
		stderr          string
	}{
		{"ok", "", 0, ""},
		{"error", string(apperr.CodeRuntimeTrap), 1, "panic: boom"},
		{"killed", string(apperr.CodeRuntimeTimeout), 0, ""},
		{"error", string(apperr.CodeRuntimeTrap), 1, "panic: boom"},
	} {
		if _, err := e.db.Exec(insert, "diag-tool", e.ids["alice"], row.outcome, row.reason, row.exit, row.stderr, 12, 4096, now); err != nil {
			t.Fatalf("写调用事件失败: %v", err)
		}
	}

	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/diag-tool/diagnostics?minutes=60&limit=10", e.tokens["alice"], nil)
	var out struct {
		Diagnostics struct {
			AppID   string `json:"app_id"`
			Summary struct {
				Total   int64 `json:"total"`
				OK      int64 `json:"ok"`
				Failed  int64 `json:"failed"`
				Error   int64 `json:"error"`
				Killed  int64 `json:"killed"`
				Reasons []struct {
					ReasonCode string   `json:"reason_code"`
					Count      int64    `json:"count"`
					Hints      []string `json:"hints"`
				} `json:"reasons"`
			} `json:"summary"`
			Failures []struct {
				ReasonCode string `json:"reason_code"`
				StderrTail string `json:"stderr_tail"`
				Outcome    string `json:"outcome"`
			} `json:"failures"`
			Hints         []string `json:"hints"`
			WindowMinutes int      `json:"window_minutes"`
			RetentionDays int      `json:"retention_days"`
		} `json:"diagnostics"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	d := out.Diagnostics
	if d.AppID != "diag-tool" {
		t.Fatalf("app_id = %q", d.AppID)
	}
	if d.Summary.Total != 4 || d.Summary.OK != 1 || d.Summary.Error != 2 || d.Summary.Killed != 1 || d.Summary.Failed != 3 {
		t.Fatalf("概览计数不对: %+v", d.Summary)
	}
	if len(d.Summary.Reasons) != 2 || d.Summary.Reasons[0].ReasonCode != string(apperr.CodeRuntimeTrap) {
		t.Fatalf("失败码应按次数降序: %+v", d.Summary.Reasons)
	}
	if len(d.Summary.Reasons[0].Hints) == 0 {
		t.Fatal("每个失败码都应带 hints")
	}
	// failures 只含非 ok（3 条），且带 stderr 尾巴与 exit code。
	if len(d.Failures) != 3 {
		t.Fatalf("failures 应只有非 ok 记录: %d", len(d.Failures))
	}
	if d.Failures[0].StderrTail == "" {
		t.Fatal("失败记录必须带 stderr 尾巴（§4.9 原话）")
	}
	if len(d.Hints) == 0 {
		t.Fatal("顶层 hints 是给 AI 的下一步指引，不能为空")
	}
	if d.WindowMinutes != 60 || d.RetentionDays != limits.CallEventRetentionDays {
		t.Fatalf("窗口/保留期不对: %d %d", d.WindowMinutes, d.RetentionDays)
	}
	// 窗口超过保留期时收敛到保留期（不能查"比保留期更长"的假数据）。
	w = e.req(http.MethodGet, "/api/client/v2/apps/wasm/diag-tool/diagnostics?minutes=1000000", e.tokens["alice"], nil)
	e.decodeJSON(w, http.StatusOK, &out)
	if got := out.Diagnostics.WindowMinutes; got != limits.CallEventRetentionDays*24*60 {
		t.Fatalf("窗口上限应为保留期: %d", got)
	}
	// 他人不可看诊断。
	w = e.req(http.MethodGet, "/api/client/v2/apps/wasm/diag-tool/diagnostics", e.tokens["bob"], nil)
	e.decodeErr(w, http.StatusNotFound)
}

// TestSchemaReportsTablesAndUsage 覆盖 §8 自省：表结构 + 占用，且**仅发布者 +
// 每次调用写审计**。
func TestSchemaReportsTablesAndUsage(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "schema-tool", "1.0.0", testGuestModule(t), goodConfig())

	// 用 appdb（唯一建表入口）造一张真表并写两行。
	ctx := context.Background()
	d, err := appdb.Open(ctx, appdb.Options{DataRoot: e.dataRoot, AppID: "schema-tool"})
	if err != nil {
		t.Fatalf("打开应用库失败: %v", err)
	}
	if _, derr := d.Define(ctx, abi.DBDefineParams{
		Table: "notes",
		Columns: []abi.ColumnDef{
			{Name: "body", Type: "text"},
			{Name: "pinned", Type: "bool"},
		},
	}); derr != nil {
		t.Fatalf("建表失败: %v", derr)
	}
	for _, body := range []string{"hello", "world"} {
		if _, xerr := d.Exec(ctx, abi.SQLParams{SQL: "INSERT INTO notes (body, pinned) VALUES (?, ?)", Args: []any{body, 0}}); xerr != nil {
			t.Fatalf("写入失败: %v", xerr)
		}
	}
	_ = d.Close()

	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/schema-tool/schema", e.tokens["alice"], nil)
	var out struct {
		Schema struct {
			AppID        string   `json:"app_id"`
			DB           string   `json:"db"`
			SizeBytes    int64    `json:"size_bytes"`
			MaxBytes     int64    `json:"max_bytes"`
			MaxTables    int      `json:"max_tables"`
			MaxColumns   int      `json:"max_columns"`
			TableCount   int      `json:"table_count"`
			UsagePercent float64  `json:"usage_percent"`
			Reserved     []string `json:"reserved_columns"`
			Tables       []struct {
				Name    string `json:"name"`
				Rows    int64  `json:"rows"`
				Columns []struct {
					Name string `json:"name"`
					Type string `json:"type"`
					PK   bool   `json:"pk"`
				} `json:"columns"`
			} `json:"tables"`
		} `json:"schema"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	s := out.Schema
	if s.AppID != "schema-tool" || s.DB != "apps/schema-tool/app.db" {
		t.Fatalf("自省应报**逻辑路径**而不是宿主绝对路径: %+v", s)
	}
	if s.SizeBytes <= 0 || s.MaxBytes != int64(limits.AppDBMaxBytes) || s.MaxTables != limits.MaxTablesPerApp {
		t.Fatalf("占用/上限不对: %+v", s)
	}
	if s.TableCount != 1 || len(s.Tables) != 1 || s.Tables[0].Name != "notes" {
		t.Fatalf("表清单不对: %+v", s.Tables)
	}
	if s.Tables[0].Rows != 2 {
		t.Fatalf("行数 = %d, want 2", s.Tables[0].Rows)
	}
	names := map[string]string{}
	for _, c := range s.Tables[0].Columns {
		names[c.Name] = c.Type
	}
	if names["body"] != "TEXT" || names["pinned"] != "INTEGER" {
		t.Fatalf("列结构不对: %+v", names)
	}
	if _, ok := names[limits.ReservedRowIDColumn]; !ok {
		t.Fatalf("平台保留列 %s 应出现在结构里（db.define 自动追加）: %+v", limits.ReservedRowIDColumn, names)
	}
	// §8：「仅发布者 + 审计」⇒ 每次调用都留痕。
	if !contains(e.auditActions("schema-tool"), "wasm_app_schema_view") {
		t.Fatalf("自省必须写审计: %v", e.auditActions("schema-tool"))
	}
	// 他人不可自省。
	w = e.req(http.MethodGet, "/api/client/v2/apps/wasm/schema-tool/schema", e.tokens["bob"], nil)
	e.decodeErr(w, http.StatusNotFound)
}

// TestCatalogListsEveryAppWithAccessAndState 覆盖 R34 + 2026-09-18 变更后的目录口径：
// **不再按可见性/上架态过滤**（R38 作废）—— 列出全部未删除、有生效版本、未冻结的应用，
// 条目里给出 access 与 enabled，由使用者判断该不该点。
//
// 变异方式（任一都必须让本用例红）：
//   - 在 catalog 里恢复"只看 public/visible"之类的过滤 ⇒ whitelist 行消失；
//   - 把 enabled=false（已下架）的行跳过 ⇒ offline 行消失（用户原话：
//     "无论是否公开的，或者没权限的都应该展示出来"）；
//   - 把 access 字段删掉/改回 visible ⇒ 行字段断言红。
func TestCatalogListsEveryAppWithAccessAndState(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	mk := func(appID, access string, whitelist ...string) {
		cfg := goodConfig()
		cfg["access"] = access
		if len(whitelist) > 0 {
			cfg["whitelist"] = whitelist
		}
		e.publishOK(e.tokens["alice"], appID, "1.0.0", guest, cfg)
	}
	mk("listed-tool", "public")
	mk("offline-tool", "public")
	mk("frozen-tool", "public")
	mk("whitelist-tool", "whitelist", "alice")
	mk("login-tool", "login")
	if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/offline-tool/unpublish", e.tokens["alice"], nil); w.Code != http.StatusOK {
		t.Fatalf("下架失败: %s", w.Body.String())
	}
	if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/frozen-tool/freeze", e.tokens["alice"], nil); w.Code != http.StatusOK {
		t.Fatalf("冻结失败: %s", w.Body.String())
	}

	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/catalog", e.tokens["bob"], nil)
	var out struct {
		Apps []map[string]any `json:"apps"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	seen := map[string]map[string]any{}
	for _, a := range out.Apps {
		seen[a["app_id"].(string)] = a
	}
	// 三种访问模式都必须出现（"没权限的也应该展示出来"）。
	for appID, wantAccess := range map[string]string{
		"listed-tool":    "public",
		"whitelist-tool": "whitelist",
		"login-tool":     "login",
	} {
		row, ok := seen[appID]
		if !ok {
			t.Fatalf("%s 必须在目录里（目录不按访问级别过滤）: %v", appID, seen)
		}
		if row["access"] != wantAccess {
			t.Fatalf("%s 的 access = %v, want %q", appID, row["access"], wantAccess)
		}
		if _, ok := row["visible"]; ok {
			t.Fatalf("目录行不得再有 visible 字段（2026-09-18 收敛为 access）: %+v", row)
		}
		// P1-4：目录必须下发**当前版本**（`wasm_app_list` 的工具描述要求模型"先查
		// 当前版本，新版本号必须严格大于它"，没有这个字段模型只能猜）。
		if row["current_version"] != "1.0.0" {
			t.Fatalf("%s 的 current_version = %v, want 1.0.0（与 /wasm-apps 管理面同源）", appID, row["current_version"])
		}
	}
	// 下架的应用仍在目录里，但带 enabled=false（UI 据此标"已下架"）。
	if row, ok := seen["offline-tool"]; !ok {
		t.Fatalf("已下架的应用仍必须列出（可逆的发布者动作，数据还在；子域返回 410）: %v", seen)
	} else if row["enabled"] != false {
		t.Fatalf("已下架的应用必须带 enabled=false: %+v", row)
	}
	if row := seen["listed-tool"]; row["enabled"] != true {
		t.Fatalf("上架应用应带 enabled=true: %+v", row)
	}
	// 冻结 = 停止服务（R37）：列出来只会给出死链 ⇒ 不列。
	if _, ok := seen["frozen-tool"]; ok {
		t.Fatal("冻结的应用不得进目录（冻结即 404，列表会是死链）")
	}
	row := seen["listed-tool"]
	if row["title"] == "" || row["description"] == "" || row["responsible"] == "" {
		t.Fatalf("目录行必须有 名称/一句话说明/负责人: %+v", row)
	}
	if row["responsible"] != "张伟" {
		t.Fatalf("负责人取自 picoaide.app.json 的 owner: %v", row["responsible"])
	}
	if row["entry_url"] != "https://listed-tool.apps.example.com" {
		t.Fatalf("入口链接不对: %v", row["entry_url"])
	}
	// R36：目录**不显示额度/用量**。
	for _, banned := range []string{"quota", "usage", "cost", "balance", "tokens", "installed"} {
		if _, ok := row[banned]; ok {
			t.Fatalf("目录不得含 %q（R36）: %+v", banned, row)
		}
	}
	// ---- P1-3：`is_owner` 与"发布者专有字段"按调用者下发 ----
	//
	// bob 不是任何一行的发布者：不得拿到 whitelist / purpose（账号名单与内部用途
	// 不该摊给全体员工），is_owner 一律 false。
	for appID, row := range seen {
		if row["is_owner"] != false {
			t.Fatalf("非发布者看到的 %s 必须 is_owner=false: %+v", appID, row)
		}
		for _, authorOnly := range []string{"purpose", "whitelist"} {
			if _, ok := row[authorOnly]; ok {
				t.Fatalf("非发布者不得拿到 %s（账号名单/用途声明只给发布者；P1-3）: %+v", authorOnly, row)
			}
		}
	}
	// alice 是全部应用的发布者：必须拿到预填所需的三样东西（access 上面已断言）。
	wa := e.req(http.MethodGet, "/api/client/v2/apps/wasm/catalog", e.tokens["alice"], nil)
	var owned struct {
		Apps []map[string]any `json:"apps"`
	}
	e.decodeJSON(wa, http.StatusOK, &owned)
	byID := map[string]map[string]any{}
	for _, a := range owned.Apps {
		byID[a["app_id"].(string)] = a
	}
	own := byID["listed-tool"]
	if own == nil {
		t.Fatalf("发布者本人也必须能列出该应用: %v", byID)
	}
	if own["is_owner"] != true {
		t.Fatalf("发布者本人的行必须 is_owner=true（客户端据此给出「发新版」入口）: %+v", own)
	}
	if own["purpose"] != "演示：给团队共享一个小工具" {
		t.Fatalf("发布者必须拿到 purpose（发布表单预填基线）: %v", own["purpose"])
	}
	if _, ok := own["whitelist"]; !ok {
		t.Fatalf("发布者必须拿到 whitelist（发布是整体替换配置，名单拿不回来只能凭空重填）: %+v", own)
	}
	// 名单内容逐条对拍（whitelist-tool 配了 alice）。
	wl, ok := byID["whitelist-tool"]["whitelist"].([]any)
	if !ok || len(wl) != 1 || wl[0] != "alice" {
		t.Fatalf("发布者拿到的 whitelist 必须是配置里的那份: %+v", byID["whitelist-tool"]["whitelist"])
	}
}
