package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

// 本文件覆盖 P1-7（列表静默截断 200 条）、P1-9/P2-4（管理面诊断与运行时水位出口）
// 与 P2-6（冻结应用不能被"上架成功"）。
//
// 变异方式（把实现改回旧行为，本文件哪条用例会红）：
//   - 把 adminList 的 total/truncated 去掉（或恢复 Go 层 `break` 而不带分页元数据）
//     ⇒ TestAdminListPaginationSearchAndTotal 红；
//   - 把 `q` 过滤挪到分页之后（先切片再过滤）⇒ 同一条用例的"第 201 个可检索"红；
//   - 把状态筛选改回不解析 status ⇒ 同一条用例的 status 断言与非法取值断言红；
//   - 把 adminPublish 的冻结闸门删掉 ⇒ TestAdminPublishRejectsFrozenApp 红；
//   - 把 AdminDiagnostics 的 handler 换回"仅发布者可见"（ownedApp）⇒
//     TestAdminDiagnosticsWithoutPublisherToken 红（管理员没有归属却读不到）；
//   - 把 AdminRuntime 的 unavailable 段删掉（静默省略）⇒
//     TestAdminRuntimeExposesWatermarksAndGaps 红。

// seedApp 直接落一行应用（不经发布链路）。
//
// 为什么不用 publishOK：分页/搜索/状态筛选都发生在 apps 表上，与制品无关；
// 造 200+ 个应用如果每个都写一份 3.6 MiB 的制品，用例会被 IO 主导
// （而"第 201 个应用"恰恰是本条审计的现场，行数不能缩水）。
func seedApp(t *testing.T, e *testEnv, appID, title, owner string, enabled bool) {
	t.Helper()
	err := serverstore.UpsertWasmApp(context.Background(), e.db, serverstore.WasmApp{
		AppID:      appID,
		Title:      title,
		Owner:      owner,
		Enabled:    enabled,
		ConfigJSON: `{"access":"login"}`,
	})
	if err != nil {
		t.Fatalf("落库应用 %s 失败: %v", appID, err)
	}
}

// listOut 是列表响应的**契约投影**（只解出本文件断言用到的字段）。
type listOut struct {
	Apps []struct {
		AppID           string   `json:"app_id"`
		Enabled         bool     `json:"enabled"`
		PendingCount    int      `json:"pending_count"`
		PendingReleases []string `json:"pending_releases"`
	} `json:"apps"`
	Total        int    `json:"total"`
	Truncated    bool   `json:"truncated"`
	Limit        int    `json:"limit"`
	Offset       int    `json:"offset"`
	PendingCount int    `json:"pending_count"`
	Status       string `json:"status"`
	Q            string `json:"q"`
}

func TestAdminListPaginationSearchAndTotal(t *testing.T) {
	e := newTestEnv(t)
	// 205 行 > 默认 limit=200：改回"静默截断"（既无 total 也无 truncated）必红。
	const bulk = 205
	for i := 0; i < bulk; i++ {
		seedApp(t, e, fmt.Sprintf("bulk-%03d", i), fmt.Sprintf("批量应用 %03d", i), "alice", true)
	}
	// 第 201+ 行故意排在最末（ORDER BY app_id 下必然落在默认页之外），
	// 并带一个唯一标题与唯一负责人：它是"分页之外的应用还能不能被找到"的判据。
	seedApp(t, e, "zz-last", "唯一可检索应用 zeta", "carol", false)
	const wantTotal = bulk + 1

	// ① 默认请求（不带任何参数）：必须如实报告"被截断了"，而不是看起来完整。
	w := e.req(http.MethodGet, "/api/server/admin/wasm-apps", "", nil)
	var page1 listOut
	e.decodeJSON(w, http.StatusOK, &page1)
	if page1.Total != wantTotal {
		t.Fatalf("total = %d, want %d（总数必须与分页无关）", page1.Total, wantTotal)
	}
	if len(page1.Apps) != adminListDefaultLimit || !page1.Truncated {
		t.Fatalf("默认页 = %d 行/truncated=%v, want %d 行且 truncated=true",
			len(page1.Apps), page1.Truncated, adminListDefaultLimit)
	}
	if page1.Limit != adminListDefaultLimit || page1.Offset != 0 {
		t.Fatalf("分页元数据未回显: limit=%d offset=%d", page1.Limit, page1.Offset)
	}

	// ② 翻到第二页：剩下的 6 行 + truncated=false（offset 真的下推到了 SQL/切片）。
	w = e.req(http.MethodGet, "/api/server/admin/wasm-apps?offset=200", "", nil)
	var page2 listOut
	e.decodeJSON(w, http.StatusOK, &page2)
	if len(page2.Apps) != wantTotal-200 || page2.Truncated {
		t.Fatalf("第二页 = %d 行/truncated=%v, want %d 行且 truncated=false",
			len(page2.Apps), page2.Truncated, wantTotal-200)
	}
	if page2.Offset != 200 || page2.Total != wantTotal {
		t.Fatalf("第二页元数据不对: %+v", page2)
	}

	// ③ 搜索**必须能捞到分页之外的行**（P1-7 的核心判据：第 201 个应用可被检索）。
	w = e.req(http.MethodGet, "/api/server/admin/wasm-apps?q=zeta", "", nil)
	var byTitle listOut
	e.decodeJSON(w, http.StatusOK, &byTitle)
	if byTitle.Total != 1 || len(byTitle.Apps) != 1 || byTitle.Apps[0].AppID != "zz-last" {
		t.Fatalf("按标题搜索没捞到分页外的行: %+v", byTitle)
	}
	if byTitle.Truncated || byTitle.Q != "zeta" {
		t.Fatalf("搜索结果不应被标记为截断,且要回显 q: %+v", byTitle)
	}
	// 负责人同样可搜（大小写不敏感）。
	w = e.req(http.MethodGet, "/api/server/admin/wasm-apps?q=CAROL", "", nil)
	var byOwner listOut
	e.decodeJSON(w, http.StatusOK, &byOwner)
	if byOwner.Total != 1 || byOwner.Apps[0].AppID != "zz-last" {
		t.Fatalf("按负责人搜索(大小写不敏感)不对: %+v", byOwner)
	}

	// ④ 状态筛选：unpublished 只有那一行；frozen 一行都没有。
	w = e.req(http.MethodGet, "/api/server/admin/wasm-apps?status=unpublished", "", nil)
	var off listOut
	e.decodeJSON(w, http.StatusOK, &off)
	if off.Total != 1 || len(off.Apps) != 1 || off.Apps[0].AppID != "zz-last" {
		t.Fatalf("status=unpublished 过滤不对: %+v", off)
	}
	w = e.req(http.MethodGet, "/api/server/admin/wasm-apps?status=frozen", "", nil)
	var frozen listOut
	e.decodeJSON(w, http.StatusOK, &frozen)
	if frozen.Total != 0 || len(frozen.Apps) != 0 {
		t.Fatalf("status=frozen 应为空: %+v", frozen)
	}
	// published 覆盖全部启用的行。
	w = e.req(http.MethodGet, "/api/server/admin/wasm-apps?status=published&limit=1", "", nil)
	var pub listOut
	e.decodeJSON(w, http.StatusOK, &pub)
	if pub.Total != bulk || !pub.Truncated || len(pub.Apps) != 1 {
		t.Fatalf("status=published + limit=1 不对: %+v", pub)
	}

	// ⑤ 非法状态取值必须**明确拒绝**（静默忽略会让管理员以为筛过了）。
	w = e.req(http.MethodGet, "/api/server/admin/wasm-apps?status=bogus", "", nil)
	eb := e.decodeErr(w, http.StatusBadRequest)
	if eb.Error.Code != string(apperr.CodeValidation) {
		t.Fatalf("非法 status 的 code = %s, want VALIDATION", eb.Error.Code)
	}
	if eb.Error.Details["field"] != "status" {
		t.Fatalf("非法 status 必须点名 field=status: %+v", eb.Error.Details)
	}
	if len(eb.Error.Hints) == 0 {
		t.Fatalf("非法 status 必须给 hints（第一消费者是 AI/管理员）: %s", w.Body.String())
	}
}

// TestAdminListPendingFieldsStayOnEveryRow 守住审核徽章的数据面：
// 每行都带 pending_releases/pending_count（空切片不是 null），顶层是**全组织**积压。
func TestAdminListPendingFieldsStayOnEveryRow(t *testing.T) {
	e := newTestEnv(t)
	seedApp(t, e, "no-pending", "没有待审", "alice", true)
	// 打开审核开关后发布 ⇒ 新版本停在 pending。
	w := e.req(http.MethodPut, "/api/server/admin/wasm-apps/review", "", map[string]any{"required": true})
	e.decodeJSON(w, http.StatusOK, &map[string]any{})
	e.publishOK(e.tokens["alice"], "has-pending", "1.0.0", testGuestModule(t), goodConfig())

	w = e.req(http.MethodGet, "/api/server/admin/wasm-apps", "", nil)
	var out listOut
	e.decodeJSON(w, http.StatusOK, &out)
	if out.PendingCount != 1 {
		t.Fatalf("顶层 pending_count = %d, want 1（全组织积压）", out.PendingCount)
	}
	byID := map[string]struct {
		count    int
		releases []string
	}{}
	for _, a := range out.Apps {
		byID[a.AppID] = struct {
			count    int
			releases []string
		}{a.PendingCount, a.PendingReleases}
	}
	if got := byID["has-pending"]; got.count != 1 || len(got.releases) != 1 || got.releases[0] != "1.0.0" {
		t.Fatalf("待审行的 pending_* 不对: %+v", got)
	}
	// 空切片（不是 null）：前端可以直接 .length / map，不必再判 null。
	if got := byID["no-pending"]; got.count != 0 || got.releases == nil {
		t.Fatalf("无待审行的 pending_releases 必须是空数组: %+v", got)
	}
}

// TestAdminPublishRejectsFrozenApp 是 P2-6 的服务端判据：
// 冻结优先（交付面一律 404），所以"上架成功"必须是错误而不是 200。
func TestAdminPublishRejectsFrozenApp(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "frozen-tool", "1.0.0", testGuestModule(t), goodConfig())

	// 管理面冻结（服务端会把 enabled 一并置 false）。
	w := e.req(http.MethodPost, "/api/server/admin/wasm-apps/frozen-tool/freeze", "", map[string]any{"frozen": true})
	e.decodeJSON(w, http.StatusOK, &map[string]any{})

	w = e.req(http.MethodPost, "/api/server/admin/wasm-apps/frozen-tool/publish", "", nil)
	eb := e.decodeErr(w, http.StatusForbidden)
	if eb.Error.Code != string(apperr.CodeAppFrozen) {
		t.Fatalf("冻结应用上架的 code = %s, want %s", eb.Error.Code, apperr.CodeAppFrozen)
	}
	if !strings.Contains(strings.Join(eb.Error.Hints, " "), "解冻") {
		t.Fatalf("冻结应用上架的 hint 必须说清出路（先解冻）: %s", w.Body.String())
	}
	// 半状态是更坏的形态：报错但 enabled 已经变了。必须仍是 false。
	app, err := serverstore.GetWasmApp(context.Background(), e.db, "frozen-tool")
	if err != nil {
		t.Fatalf("回读应用失败: %v", err)
	}
	if app.Enabled {
		t.Fatal("冻结应用的上架被拒后 enabled 仍被改写为 true（拒绝必须是原子的）")
	}

	// 解冻之后上架照常可用（闸门只拦冻结期间）。
	w = e.req(http.MethodPost, "/api/server/admin/wasm-apps/frozen-tool/freeze", "", map[string]any{"frozen": false})
	e.decodeJSON(w, http.StatusOK, &map[string]any{})
	w = e.req(http.MethodPost, "/api/server/admin/wasm-apps/frozen-tool/publish", "", nil)
	var ok struct {
		App struct {
			Enabled bool `json:"enabled"`
			Changed bool `json:"changed"`
		} `json:"app"`
	}
	e.decodeJSON(w, http.StatusOK, &ok)
	if !ok.App.Enabled || !ok.App.Changed {
		t.Fatalf("解冻后上架应成功: %+v", ok)
	}
}

// insertFailedCall 造一条失败调用事件（诊断数据面）。
func insertFailedCall(t *testing.T, e *testEnv, appID, reasonCode string, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		_, err := e.db.ExecContext(context.Background(), `INSERT INTO wasm_call_events
			(app_id, user_id, outcome, reason_code, cpu_ms, peak_memory_bytes, host_call_count,
			 host_call_ms, queue_wait_ms, response_bytes, db_rows, db_bytes, guest_exit_code,
			 stderr_tail, created_at)
			VALUES ($1, 0, 'error', $2, 12, 1024, 0, 0, 3, 0, 0, 0, 1, 'boom', now())`,
			appID, reasonCode)
		if err != nil {
			t.Fatalf("写入调用事件失败: %v", err)
		}
	}
}

// TestAdminDiagnosticsWithoutPublisherToken 是 P1-9 的判据：
// 管理会话（不是发布者令牌、也不要求是归属人）能读到诊断；且与员工面同一份口径。
func TestAdminDiagnosticsWithoutPublisherToken(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "diag-tool", "1.0.0", testGuestModule(t), goodConfig())
	insertFailedCall(t, e, "diag-tool", string(apperr.CodeRuntimeTimeout), 3)

	type diagOut struct {
		Diagnostics struct {
			AppID         string   `json:"app_id"`
			AppEnabled    bool     `json:"app_enabled"`
			Owner         string   `json:"owner"`
			WindowMinutes int      `json:"window_minutes"`
			RetentionDays int      `json:"retention_days"`
			Hints         []string `json:"hints"`
			Summary       struct {
				Failed  int64 `json:"failed"`
				Reasons []struct {
					ReasonCode string   `json:"reason_code"`
					Count      int64    `json:"count"`
					Hints      []string `json:"hints"`
				} `json:"reasons"`
			} `json:"summary"`
			Failures []struct {
				ReasonCode string `json:"reason_code"`
			} `json:"failures"`
		} `json:"diagnostics"`
	}
	// 缺省管理员是 boss（super_admin），与 alice 无关。
	w := e.req(http.MethodGet, "/api/server/admin/wasm-apps/diag-tool/diagnostics", "", nil)
	var out diagOut
	e.decodeJSON(w, http.StatusOK, &out)
	d := out.Diagnostics
	if d.AppID != "diag-tool" || d.Owner != "alice" {
		t.Fatalf("诊断响应的应用信息不对: %+v", d)
	}
	if d.Summary.Failed != 3 || len(d.Summary.Reasons) != 1 ||
		d.Summary.Reasons[0].ReasonCode != string(apperr.CodeRuntimeTimeout) ||
		d.Summary.Reasons[0].Count != 3 {
		t.Fatalf("失败码计数不对: %+v", d.Summary)
	}
	if len(d.Failures) != 3 {
		t.Fatalf("时间线应有 3 条失败: %d", len(d.Failures))
	}
	if len(d.Summary.Reasons[0].Hints) == 0 || len(d.Hints) == 0 {
		t.Fatal("诊断必须带可操作 hints（第一消费者是排障的人/AI）")
	}
	if d.RetentionDays <= 0 || d.WindowMinutes <= 0 {
		t.Fatalf("保留期/窗口必须下发: %+v", d)
	}

	// 保留期内已退役的应用仍可排障（与员工面 ownedApp(...,true) 同口径）。
	if err := serverstore.SoftDeleteWasmApp(context.Background(), e.db, "diag-tool"); err != nil {
		t.Fatalf("软删失败: %v", err)
	}
	w = e.req(http.MethodGet, "/api/server/admin/wasm-apps/diag-tool/diagnostics", "", nil)
	var after diagOut
	e.decodeJSON(w, http.StatusOK, &after)
	if after.Diagnostics.Summary.Failed != 3 {
		t.Fatalf("已退役应用的诊断不该被拒: %+v", after.Diagnostics)
	}
	// 但**处置**动作仍然拒绝已退役的行（诊断只读放行，写面不放行）。
	w = e.req(http.MethodPost, "/api/server/admin/wasm-apps/diag-tool/freeze", "", map[string]any{"frozen": true})
	e.decodeErr(w, http.StatusNotFound)
}

// TestAdminRuntimeExposesWatermarksAndGaps 是 P2-4 的判据：
// 有出口的水位如实给数，"还没接线"的水位**如实列出**（而不是静默省略成 0）。
func TestAdminRuntimeExposesWatermarksAndGaps(t *testing.T) {
	e := newTestEnv(t)
	w := e.req(http.MethodGet, "/api/server/admin/wasm-apps/runtime", "", nil)

	type runtimeOut struct {
		Runtime struct {
			CapturedAt string `json:"captured_at"`
			Compile    struct {
				QueueCapacity  int   `json:"queue_capacity"`
				CacheMaxBytes  int64 `json:"cache_max_bytes"`
				CacheEntries   int   `json:"cache_entries"`
				Compiles       int64 `json:"compiles"`
				Timeouts       int64 `json:"timeouts"`
				LastCompileMS  int64 `json:"last_compile_ms"`
				QueueDepth     int   `json:"queue_depth"`
				CacheMaxEntrie int   `json:"cache_max_entries"`
			} `json:"compile"`
			Events struct {
				Written int64 `json:"written"`
				Dropped int64 `json:"dropped"`
				Failed  int64 `json:"failed"`
			} `json:"events"`
			Unavailable []struct {
				Name   string `json:"name"`
				Reason string `json:"reason"`
				Wiring string `json:"wiring"`
			} `json:"unavailable"`
		} `json:"runtime"`
	}
	var out runtimeOut
	e.decodeJSON(w, http.StatusOK, &out)
	rt := out.Runtime

	// 编译面来自注入的 Compiler（真值，不是占位）：上限必须是正数。
	if rt.Compile.QueueCapacity <= 0 || rt.Compile.CacheMaxBytes <= 0 || rt.Compile.CacheMaxEntrie <= 0 {
		t.Fatalf("编译水位上限必须是真值: %+v", rt.Compile)
	}
	if rt.CapturedAt == "" {
		t.Fatal("运行时水位必须带采集时间（否则页面无法说明这个数有多新）")
	}

	// 缺口清单：每一个都必须说明"缺什么 + 接哪里"，否则页面只能显示一个空值。
	names := map[string]bool{}
	for _, u := range rt.Unavailable {
		if u.Name == "" || u.Reason == "" || u.Wiring == "" {
			t.Fatalf("unavailable 条目必须带 name/reason/wiring: %+v", u)
		}
		names[u.Name] = true
	}
	for _, want := range []string{"module_cache", "appdb_handles", "anon_limit", "ai_revoke_failures"} {
		if !names[want] {
			t.Fatalf("缺口水位 %s 必须如实出现在 unavailable 里（静默省略会被读成 0）", want)
		}
	}
}
