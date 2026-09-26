package api

// W5 服务端补齐（台账 §O 的 R2-L6-1/2/3）的判据。
//
// 三条端点各一组：
//
//	C1 列表筛选 `?access=`  —— login 必须含历史 public + 响应回显 access；
//	C2 `opens/summary`      —— 三个数组恒在 + uv 按窗口去重；
//	C4 `:app_id/ai-usage`   —— 归因可用性与"零调用"可区分。
//
// 变异验证：
//   - 把 matchAppAccess 的历史 public 归一化删掉 ⇒ C1 的 login 用例红；
//   - 把响应里的 "access" 回显删掉 ⇒ C1 的回显用例红；
//   - 把 summary 的 apps/trend/top_apps 任一置 nil（JSON 里变 null）⇒ C2 的"数组恒在"用例红；
//   - 把 summary 的 UV 改成逐日相加 ⇒ C2 的去重用例红；
//   - 把 totals.uv 改成"各应用 window_uv 相加" ⇒ C2 的 totals 用例红
//     （TestAdminOpensSummaryTotalsUVNotSumOfApps：同一个人开两个应用时 1 ≠ 2）；
//   - 把 attribution_available 恒 true ⇒ C4 的"暂无归因"用例红；
//   - 把 AI 用量的 days= 忽略掉（只用缺省近 7 天）⇒ 窗口用例红。
//
// ⚠️ 响应形状（键名）是**跨端契约**（设计 §5.1c），由 webadmin 的
// `opens-contract-parity.spec.ts` 读本包的 `gin.H{}` 与 serverstore 的 json tag
// 与前端 interface 逐键对拍；本文件只负责**行为与语义**（去重、窗口、标题、恒在）。

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func TestAdminListAccessFilterIncludesLegacyPublic(t *testing.T) {
	e := newTestEnv(t)
	seedApp(t, e, "login-app", "登录应用", "alice", true)
	seedApp(t, e, "white-app", "白名单应用", "alice", true)
	seedApp(t, e, "legacy-public", "历史公开应用", "alice", true)
	// 历史 public：config_json 里就是 public（0074 之前发布的存量行）。
	if _, err := e.db.Exec(`UPDATE apps SET config_json = '{"access":"public"}' WHERE kind='wasm_app' AND app_id='legacy-public'`); err != nil {
		t.Fatalf("造历史 public 行: %v", err)
	}
	if _, err := e.db.Exec(`UPDATE apps SET config_json = '{"access":"whitelist"}' WHERE kind='wasm_app' AND app_id='white-app'`); err != nil {
		t.Fatalf("造白名单行: %v", err)
	}

	type listOut struct {
		Apps []struct {
			AppID  string `json:"app_id"`
			Access string `json:"access"`
		} `json:"apps"`
		Access string `json:"access"`
		Total  int    `json:"total"`
	}
	fetch := func(query string) listOut {
		t.Helper()
		w := e.req(http.MethodGet, "/api/server/admin/wasm-apps"+query, e.tokens["boss"], nil)
		var out listOut
		e.decodeJSON(w, http.StatusOK, &out)
		return out
	}

	// ① `access=login` **必须包含历史 public 行**（I6 的读侧口径）。
	got := fetch("?access=login")
	ids := map[string]bool{}
	for _, a := range got.Apps {
		ids[a.AppID] = true
	}
	if !ids["login-app"] || !ids["legacy-public"] {
		t.Fatalf("access=login 必须同时命中 login 与历史 public 行，得到 %v", ids)
	}
	if ids["white-app"] {
		t.Fatalf("access=login 不该命中 whitelist 行: %v", ids)
	}
	// ② 响应回显 access（前端据此判断服务端是否支持该筛选）。
	if got.Access != "login" {
		t.Fatalf(`响应 access = %q, want "login"（不回显会让前端退化成"本页过滤"）`, got.Access)
	}
	// ③ whitelist 只命中白名单行；非法取值 400。
	if got := fetch("?access=whitelist"); len(got.Apps) != 1 || got.Apps[0].AppID != "white-app" {
		t.Fatalf("access=whitelist 应只命中 white-app，得到 %+v", got.Apps)
	}
	e.decodeErr(e.req(http.MethodGet, "/api/server/admin/wasm-apps?access=bogus", e.tokens["boss"], nil),
		http.StatusBadRequest)
}

func TestAdminOpensSummaryShapeAndWindowUV(t *testing.T) {
	e := newTestEnv(t)
	seedOpenApp(t, e, "notes", "1.0.0", "备忘工具", true)

	// 先断言**空数据**的形状：三个数组必须是 `[]` 而不是 `null`。
	// 这一步是"数组恒在"判据的本体 —— 只在有数据时断言的话，nil 与空数组在 JSON 里
	// 无法区分（实测踩过：只测有数据的场景时，把两处 `!= nil` 兜底全删掉仍然绿）。
	emptyRec := e.req(http.MethodGet, "/api/server/admin/wasm-apps/opens/summary", e.tokens["boss"], nil)
	emptyRaw := emptyRec.Body.String()
	for _, want := range []string{`"apps":[]`, `"trend":[]`, `"top_apps":[]`, `"today":{`, `"totals":{`} {
		if !strings.Contains(emptyRaw, want) {
			t.Fatalf("无数据时必须是 %s（空数组/零值而不是 null 或省略）: %s", want, emptyRaw)
		}
	}
	// 保留期是 §5.1c A 的契约字段（前端据此标注"多久以前的明细已经不在"）。
	if !strings.Contains(emptyRaw, `"detail_retention_days":90`) {
		t.Fatalf("响应必须带 detail_retention_days=90: %s", emptyRaw)
	}

	now := e.h.now().UTC()

	// 同一个人连续两天各打开一次 + 另一个人今天打开一次。
	// 窗口 UV 必须是 2（按 user_id 去重），逐日相加会得到 3 —— 那正是 C2 禁止的口径。
	must := func(userID int64, at time.Time) {
		t.Helper()
		if err := serverstore.RecordWasmAppOpen(context.Background(), e.db, serverstore.WasmAppOpen{
			AppID: "notes", UserID: userID, At: at}); err != nil {
			t.Fatalf("写明细: %v", err)
		}
	}
	must(1, now.AddDate(0, 0, -1))
	must(1, now)
	must(2, now)
	if _, err := serverstore.AggregateWasmAppOpens(context.Background(), e.db, now.AddDate(0, 0, -1), now); err != nil {
		t.Fatalf("汇总: %v", err)
	}

	w := e.req(http.MethodGet, "/api/server/admin/wasm-apps/opens/summary?days=7&top=5", e.tokens["boss"], nil)
	var out struct {
		From                string `json:"from"`
		To                  string `json:"to"`
		Days                int    `json:"days"`
		Top                 int    `json:"top"`
		Capped              bool   `json:"capped"`
		DetailRetentionDays int    `json:"detail_retention_days"`
		Today               struct {
			Day string `json:"day"`
			PV  int64  `json:"pv"`
			UV  int64  `json:"uv"`
		} `json:"today"`
		Totals struct {
			PV int64 `json:"pv"`
			UV int64 `json:"uv"`
		} `json:"totals"`
		Trend []json.RawMessage `json:"trend"`
		Apps  []struct {
			AppID    string `json:"app_id"`
			Title    string `json:"title"`
			WindowPV int64  `json:"window_pv"`
			WindowUV int64  `json:"window_uv"`
			TodayPV  int64  `json:"today_pv"`
			TodayUV  int64  `json:"today_uv"`
		} `json:"apps"`
		TopApps []struct {
			AppID string `json:"app_id"`
			Title string `json:"title"`
			PV    int64  `json:"pv"`
			UV    int64  `json:"uv"`
		} `json:"top_apps"`
	}
	e.decodeJSON(w, http.StatusOK, &out)

	// ① 三个数组**恒在**（空数组而不是 null；这里断言"非 null"用 RawMessage 判）。
	raw := w.Body.String()
	for _, key := range []string{`"trend"`, `"apps"`, `"top_apps"`} {
		if !strings.Contains(raw, key) {
			t.Fatalf("响应必须有 %s 字段（三数组恒在，不得省略）: %s", key, raw)
		}
		if strings.Contains(raw, key+":null") {
			t.Fatalf("%s 不得为 null（空就空数组）: %s", key, raw)
		}
	}
	if len(out.Apps) != 1 {
		t.Fatalf("apps 应有 1 行，得到 %+v", out.Apps)
	}
	// ② UV 按**窗口**去重（3 次打开、2 个人 ⇒ uv=2，不是 3）。
	//    键名是 `window_pv`/`window_uv`（§5.1c A：曾经这里发 pv/uv、前端读 window_*，
	//    真实环境恒显示 —，即 R2-L6-1）。
	if out.Apps[0].WindowPV != 3 || out.Apps[0].WindowUV != 2 {
		t.Fatalf("窗口 window_pv/window_uv = %d/%d, want 3/2（uv 必须跨天去重，不是逐日相加）",
			out.Apps[0].WindowPV, out.Apps[0].WindowUV)
	}
	// ③ 今日列：今天两次打开、两个人 ⇒ pv2/uv2。
	if out.Apps[0].TodayPV != 2 || out.Apps[0].TodayUV != 2 {
		t.Fatalf("今日 pv/uv = %d/%d, want 2/2", out.Apps[0].TodayPV, out.Apps[0].TodayUV)
	}
	// ④ `title` 来自应用登记表（§5.1c A：查不到就缺省，不得编造）。
	if out.Apps[0].Title != "备忘工具" {
		t.Fatalf("apps[].title = %q, want 备忘工具（来自 apps 登记表）", out.Apps[0].Title)
	}
	// ⑤ `today` / `totals`：读明细表的一次聚合（不是各行相加）。
	if out.Today.Day == "" || out.Today.PV != 2 || out.Today.UV != 2 {
		t.Fatalf("today = %+v, want day 非空 + pv2/uv2", out.Today)
	}
	if out.Totals.PV != 3 || out.Totals.UV != 2 {
		t.Fatalf("totals = %+v, want pv3/uv2", out.Totals)
	}
	if out.DetailRetentionDays != serverstore.WasmAppOpensRetentionDays {
		t.Fatalf("detail_retention_days = %d, want %d", out.DetailRetentionDays, serverstore.WasmAppOpensRetentionDays)
	}
	if out.Days != 7 || out.Top != 5 || out.Capped {
		t.Fatalf("分页/窗口元数据不符: %+v", out)
	}
	if len(out.Trend) == 0 {
		t.Fatal("趋势不应为空（已汇总过两天）")
	}
	// ⑥ top_apps：§5.1c A 的行形状 `{app_id,title,pv,uv}`，按窗口 PV 降序截断。
	if len(out.TopApps) != 1 {
		t.Fatalf("top_apps 应有 1 行，得到 %+v", out.TopApps)
	}
	if out.TopApps[0].AppID != "notes" || out.TopApps[0].Title != "备忘工具" ||
		out.TopApps[0].PV != 3 || out.TopApps[0].UV != 2 {
		t.Fatalf("top_apps[0] = %+v, want {notes 备忘工具 3 2}", out.TopApps[0])
	}
}

// TestAdminOpensSummaryTotalsUVNotSumOfApps 钉住 §5.1c A 的**UV 禁令**：
// `totals.uv` 必须是"不带 GROUP BY app_id 的一次聚合"，而**不是**各应用 uv 相加 ——
// 同一个人打开两个应用时前者是 1、后者是 2（人数 vs 次数）。
//
// 变异验证：把 handler 里的 `sum.Totals` 换成"遍历 apps 累加 window_uv" ⇒ 本用例红。
func TestAdminOpensSummaryTotalsUVNotSumOfApps(t *testing.T) {
	e := newTestEnv(t)
	seedOpenApp(t, e, "notes", "1.0.0", "备忘工具", true)
	seedOpenApp(t, e, "board", "1.0.0", "看板", true)
	now := e.h.now().UTC()

	// **同一个人**今天打开了两个应用。
	for _, appID := range []string{"notes", "board"} {
		if err := serverstore.RecordWasmAppOpen(context.Background(), e.db, serverstore.WasmAppOpen{
			AppID: appID, UserID: 1, At: now}); err != nil {
			t.Fatalf("写明细(%s): %v", appID, err)
		}
	}
	w := e.req(http.MethodGet, "/api/server/admin/wasm-apps/opens/summary?days=7&top=10", e.tokens["boss"], nil)
	var out struct {
		Today struct {
			PV int64 `json:"pv"`
			UV int64 `json:"uv"`
		} `json:"today"`
		Totals struct {
			PV int64 `json:"pv"`
			UV int64 `json:"uv"`
		} `json:"totals"`
		Apps []struct {
			AppID    string `json:"app_id"`
			WindowUV int64  `json:"window_uv"`
		} `json:"apps"`
	}
	e.decodeJSON(w, http.StatusOK, &out)

	var sumAppsUV int64
	for _, a := range out.Apps {
		sumAppsUV += a.WindowUV
	}
	if len(out.Apps) != 2 || sumAppsUV != 2 {
		t.Fatalf("前置：两个应用各 1 个窗口 UV（合计 2），得到 %+v", out.Apps)
	}
	if out.Totals.UV != 1 {
		t.Fatalf("totals.uv = %d, want 1 —— 同一个人开两个应用只算 1 个人；把各应用 uv 相加会得到 2（§5.1c A 明令禁止）",
			out.Totals.UV)
	}
	if out.Totals.PV != 2 || out.Today.PV != 2 || out.Today.UV != 1 {
		t.Fatalf("totals/today = %+v / %+v, want pv2 + uv1", out.Totals, out.Today)
	}
}

func TestAdminAppAIUsageDistinguishesMissingAttribution(t *testing.T) {
	e := newTestEnv(t)
	seedApp(t, e, "notes", "备忘工具", "alice", true)
	now := e.h.now().UTC()
	uid := e.ids["alice"]

	// ① 平台尚无任何带归因的行 ⇒ attribution_available=false（前端显示"暂无归因数据"）。
	w := e.req(http.MethodGet, "/api/server/admin/wasm-apps/notes/ai-usage", e.tokens["boss"], nil)
	var out serverstore.WasmAppAIUsage
	e.decodeJSON(w, http.StatusOK, &out)
	if out.AttributionAvailable {
		t.Fatal(`窗口内没有任何带 app_id 的 usage 行时必须 attribution_available=false（不得把"统计未上线"渲染成 0）`)
	}
	if out.Days == nil || len(out.Days) != 0 {
		t.Fatalf("days 必须是空数组而不是 null/缺省: %+v", out.Days)
	}

	// ② 有归因流量（另一个应用）后：attribution_available=true，而本应用仍为零
	//    —— 这时零才是"确实没调用过"。
	id, err := serverstore.RecordUsageKind(e.db, uid, "demo-model", 100, 50, "chat")
	if err != nil {
		t.Fatalf("落 usage: %v", err)
	}
	if err := serverstore.SetUsageAppID(e.db, id, "other"); err != nil {
		t.Fatalf("归因: %v", err)
	}
	w = e.req(http.MethodGet, "/api/server/admin/wasm-apps/notes/ai-usage", e.tokens["boss"], nil)
	e.decodeJSON(w, http.StatusOK, &out)
	if !out.AttributionAvailable {
		t.Fatal("已有归因流量时 attribution_available 必须为 true")
	}
	if out.Total.Requests != 0 || out.Total.Cost != 0 {
		t.Fatalf("本应用没有调用 ⇒ 全零，得到 %+v", out.Total)
	}

	// ③ 本应用自己的调用落进窗口。
	id2, err := serverstore.RecordUsageKind(e.db, uid, "demo-model", 10, 5, "chat")
	if err != nil {
		t.Fatalf("落 usage: %v", err)
	}
	if err := serverstore.SetUsageAppID(e.db, id2, "notes"); err != nil {
		t.Fatalf("归因: %v", err)
	}
	w = e.req(http.MethodGet, "/api/server/admin/wasm-apps/notes/ai-usage", e.tokens["boss"], nil)
	e.decodeJSON(w, http.StatusOK, &out)
	if out.Total.Requests != 1 || out.Total.PromptTokens != 10 || out.Total.CompletionTokens != 5 {
		t.Fatalf("应用维度用量不符: %+v", out.Total)
	}
	if len(out.Days) != 1 {
		t.Fatalf("按日明细应有 1 行: %+v", out.Days)
	}
	_ = now
}

// TestAdminAppAIUsageDaysWindow 钉住契约 §5.1c B 文档化的 `?days=` 形态：
// 文档里写着 `?days=|from=&to=`，实现静默忽略 days 会让调用方以为窗口变了、
// 数字其实没变（与 R2-L6-3 的"静默窗口"同类）。
//
// 变异验证：把 handler 里 days 分支删掉（只用缺省近 7 天）⇒ 本用例红。
func TestAdminAppAIUsageDaysWindow(t *testing.T) {
	e := newTestEnv(t)
	seedApp(t, e, "notes", "备忘工具", "alice", true)
	now := e.h.now()

	// ① days=30 ⇒ 近 30 天（含今天）。
	w := e.req(http.MethodGet, "/api/server/admin/wasm-apps/notes/ai-usage?days=30", e.tokens["boss"], nil)
	var out serverstore.WasmAppAIUsage
	e.decodeJSON(w, http.StatusOK, &out)
	if want := serverstore.LocalDayString(now.AddDate(0, 0, -29)); out.From != want {
		t.Fatalf("days=30 ⇒ from=%s（近 30 天含今天），得到 %s", want, out.From)
	}
	if want := serverstore.LocalDayString(now); out.To != want {
		t.Fatalf("to 缺省 = 今天 %s，得到 %s", want, out.To)
	}

	// ② 显式 from/to 优先于 days（拿到回显窗口再请求的场景不能被 days 覆盖）。
	//
	// ⚠️ 这一条**单独不构成** D-01 的判据：它断言的是"回显 == 请求值"，只有在负 UTC
	// 偏移的部署时区下才咬得住（CI/本机缺省 UTC ⇒ 旧实现恒绿，D-03 登记的就是这条假绿）。
	// 与进程 TZ 无关的判据是下面两条：
	// `TestParseDayParamIsDeploymentLocalCalendarDay`（切 3 个时区断言同一日键）与
	// `TestAdminAppOpensExplicitWindowIsLocalDayUnderNegativeOffset`（端点级 + 强制负偏移）。
	explicit := "from=2026-01-05&to=2026-01-09"
	w = e.req(http.MethodGet, "/api/server/admin/wasm-apps/notes/ai-usage?"+explicit+"&days=30", e.tokens["boss"], nil)
	e.decodeJSON(w, http.StatusOK, &out)
	if out.From != "2026-01-05" || out.To != "2026-01-09" {
		t.Fatalf("显式区间优先: from/to = %s/%s, want 2026-01-05/2026-01-09", out.From, out.To)
	}

	// ③ 不传 days / from ⇒ 仍是近 7 天（缺省不变）。
	w = e.req(http.MethodGet, "/api/server/admin/wasm-apps/notes/ai-usage", e.tokens["boss"], nil)
	e.decodeJSON(w, http.StatusOK, &out)
	if want := serverstore.LocalDayString(now.AddDate(0, 0, -6)); out.From != want {
		t.Fatalf("缺省仍是近 7 天（from=%s），得到 %s", want, out.From)
	}
}

// ---------------------------------------------------------------------------
// R21-D-01 / D-03：`from=`/`to=` 的**日历日口径**，以及判据自身的"与进程 TZ 无关"。
//
// 缺陷形态（D-01）：`parseDayParam` 用 `time.Parse("2006-01-02", raw)` 解析 —— 那产出
// **UTC 零点**，再喂给按本地日归一的 `dayStart` ⇒ 负 UTC 偏移的部署（America/Atlantic
// 一族）上 `2026-09-20` 的日键变成 `09-19`，整个窗口左移一天，"今天"被挤出窗口，而同
// 一响应里的 `today{}` 仍是真今天（看板自相矛盾）。
//
// 判据为什么必须自己切时区（D-03）：唯一的旧判据是
// `TestAdminAppAIUsageDaysWindow` ② 的"回显 == 请求值"，它只在负偏移时区下才红；
// 而 CI 与 `server/Makefile` 全仓**不设 TZ**（缺省 UTC）⇒ 旧实现恒绿，门禁上永远
// 杀不死这条 mutant。下面两条用例把时区**显式**拿进用例里，因此在任何进程环境下
// 都给出同一个结论。
//
// ⚠️ 它们临时改写进程级 `time.Local`（口径就是"部署 TZ"）。本包必须保持**不并行**
// （当前零处 `t.Parallel()`）—— 与 `serverstore/local_day_test.go` 的同名纪律一致。
// ---------------------------------------------------------------------------

// withLocalZone 把进程时区切到 loc 并在用例结束时还原。
func withLocalZone(t *testing.T, loc *time.Location) {
	t.Helper()
	prev := time.Local
	time.Local = loc
	t.Cleanup(func() { time.Local = prev })
}

// mustLoadLocation 取一个时区（tzdata 缺失时跳过 —— 判据在无数据的环境里没有意义）。
func mustLoadLocation(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Skipf("本机没有时区数据 %s: %v", name, err)
	}
	return loc
}

// TestParseDayParamIsDeploymentLocalCalendarDay 钉住 D-01 的**根**：`YYYY-MM-DD` 是
// "调用方眼里的日历日"，解析结果必须是**部署本地日**的那一日边界 —— 同一个输入在每个
// 时区都得到同一个日键（这就是"与进程 TZ 无关"的可判定形态）。
//
// 表里三类日子都要有，缺一类就会漏掉一种错法：
//   - 普通日（2026-01-05 / 2026-09-20）：`time.Parse` 的 UTC 日错法在这里暴露；
//   - DST **缺口日**（America/Santiago 2026-09-06，本地 00:00 不存在）：裸的
//     `time.ParseInLocation(…, time.Local)` 会归一化到前一天 23:00 ⇒ 日键 09-05；
//   - DST **重叠日**（America/Santiago 2026-04-05，本地 00:00 出现两次）：取第一次零点是
//     冻结口径，不能被"更稳一点"的实现改成第二次。
//
// 变异验证（两种回退都跑过，见报告）：
//   - 退回 `time.Parse("2006-01-02", raw)` ⇒ America/Santiago 组红（2026-09-20 → 09-19）；
//   - 退回裸 `time.ParseInLocation("2006-01-02", raw, time.Local)` ⇒ 缺口日组红（09-06 → 09-05）。
func TestParseDayParamIsDeploymentLocalCalendarDay(t *testing.T) {
	cases := []struct {
		tz   string
		days []string
	}{
		{"UTC", []string{"2026-01-05", "2026-09-20"}},
		{"Asia/Shanghai", []string{"2026-01-05", "2026-09-20"}},
		{"America/Santiago", []string{"2026-01-05", "2026-04-05", "2026-09-06", "2026-09-20"}},
	}
	seen := map[string]string{} // 输入日 → 它在所有时区里的日键（必须唯一）
	for _, tc := range cases {
		withLocalZone(t, mustLoadLocation(t, tc.tz))
		for _, day := range tc.days {
			got, aerr := parseDayParam(day, time.Time{})
			if aerr != nil {
				t.Fatalf("%s: parseDayParam(%q) 报错: %+v", tc.tz, day, aerr)
			}
			key := serverstore.LocalDayString(got)
			if key != day {
				t.Fatalf("%s: parseDayParam(%q) 的日键 = %s —— 入参是调用方的日历日，"+
					"必须是本地时区里的同一日（`time.Parse` 的 UTC 日、裸 ParseInLocation 的"+
					"缺口日归一化都会差一天）", tc.tz, day, key)
			}
			if !got.Equal(serverstore.LocalDay(got)) {
				t.Fatalf("%s: parseDayParam(%q) = %s 不在该本地日的边界上（必须 == LocalDay(自己)）",
					tc.tz, day, got.Format(time.RFC3339))
			}
			if prev, ok := seen[day]; ok && prev != key {
				t.Fatalf("同一输入 %q 在不同时区得到不同日键: %s vs %s", day, prev, key)
			}
			seen[day] = key
		}
	}

	// 缺省分支（空串）仍取 def 所在本地日；形态不对仍是 VALIDATION。
	withLocalZone(t, mustLoadLocation(t, "America/Santiago"))
	def := time.Date(2026, 9, 20, 21, 30, 0, 0, time.UTC) // 本地 = 2026-09-20 18:30 -03:00
	got, aerr := parseDayParam("", def)
	if aerr != nil || serverstore.LocalDayString(got) != "2026-09-20" {
		t.Fatalf(`缺省分支：parseDayParam("", def) = %v / %+v, want 日键 2026-09-20`, got, aerr)
	}
	if _, aerr := parseDayParam("2026-1-5", def); aerr == nil {
		t.Fatal("形态不对（2026-1-5）必须报 VALIDATION（形状唯一才比得动）")
	}
}

// TestAdminAppOpensExplicitWindowIsLocalDayUnderNegativeOffset 是 D-01 的**端点级**判据，
// 且在**任何**进程 TZ 下都咬得住（时区由用例自己切）。
//
// 强度不来自"回显 == 请求值"（那只是字符串），而来自**窗口边界真的决定了返回哪些天**：
// 库里预置 2026-01-04..2026-01-10 每一天的日汇总行，请求 from=2026-01-05&to=2026-01-09
// ⇒ 返回的 day 集合必须**恰好**是 01-05..01-09（多一天少一天都红）。
// 旧实现（UTC 解析 + 本地日归一）在 America/Santiago 下把窗口算成 01-04..01-08 ⇒ 集合不等。
//
// 变异验证：`parseDayParam` 退回 `time.Parse` ⇒ 本用例红（实测）。
func TestAdminAppOpensExplicitWindowIsLocalDayUnderNegativeOffset(t *testing.T) {
	e := newTestEnv(t)
	seedOpenApp(t, e, "notes", "1.0.0", "备忘工具", true)

	loc := mustLoadLocation(t, "America/Santiago")
	withLocalZone(t, loc)

	// 明细：01-04..01-10 每个本地日的本地 12:00 各一次打开（比窗口宽 3 天，两侧都有诱饵）。
	for d := 4; d <= 10; d++ {
		at := time.Date(2026, 1, d, 12, 0, 0, 0, loc)
		if err := serverstore.RecordWasmAppOpen(context.Background(), e.db, serverstore.WasmAppOpen{
			AppID: "notes", UserID: 1, At: at}); err != nil {
			t.Fatalf("写明细(2026-01-%02d): %v", d, err)
		}
	}
	if _, err := serverstore.AggregateWasmAppOpens(context.Background(), e.db,
		serverstore.LocalDay(time.Date(2026, 1, 4, 12, 0, 0, 0, loc)),
		serverstore.LocalDay(time.Date(2026, 1, 10, 12, 0, 0, 0, loc))); err != nil {
		t.Fatalf("汇总: %v", err)
	}

	w := e.req(http.MethodGet,
		"/api/server/admin/wasm-apps/notes/opens?from=2026-01-05&to=2026-01-09", e.tokens["boss"], nil)
	var out serverstore.WasmOpenSeries
	e.decodeJSON(w, http.StatusOK, &out)

	if out.From != "2026-01-05" || out.To != "2026-01-09" {
		t.Fatalf("回显窗口 = %s~%s, want 2026-01-05~2026-01-09（入参是本地日历日）", out.From, out.To)
	}
	var got []string
	for _, p := range out.Points {
		got = append(got, p.Day)
	}
	want := "2026-01-05,2026-01-06,2026-01-07,2026-01-08,2026-01-09"
	if strings.Join(got, ",") != want {
		t.Fatalf("窗口内的日集合 = [%s], want [%s] —— 窗口边界差一天就会多/少一天"+
			"（UTC 解析在负偏移时区下正是这样左移一天）", strings.Join(got, ","), want)
	}
	if out.TotalPV != 5 {
		t.Fatalf("窗口合计 PV = %d, want 5（每天一次；两侧的 01-04/01-10 必须被排除）", out.TotalPV)
	}
}

// TestAdminOpensSummaryTrendUVNotSumOfApps 复现并钉住 P1-1（2026-09-20 本机全功能
// 实测）：`GET /opens/summary` 的 `trend[].uv` 曾经是
// `SELECT day, SUM(pv), SUM(uv) FROM wasm_app_opens_daily GROUP BY day` —— 把日汇总里
// **各应用的 uv 相加**。现场形态：同一天 `today.uv=2` / `totals.uv=2`，而
// `trend[0].uv=3`（同一块看板上两个 UV 自相矛盾）。§5.1c A 的 UV 禁令
// （"禁止把各应用的 uv 相加"）对趋势点的"当天人数"同样适用。
//
// 判据强度：断言 **trend[0].uv == totals.uv**（同日窗口）且**严格小于**各应用
// window_uv 之和 —— 后者是旧实现的取值（3），前者是真实去重（2）。
// 变异验证：把 serverstore 的 trend UV 聚合改回 `SUM(uv)` ⇒ 本用例红。
func TestAdminOpensSummaryTrendUVNotSumOfApps(t *testing.T) {
	e := newTestEnv(t)
	seedOpenApp(t, e, "notes", "1.0.0", "备忘工具", true)
	seedOpenApp(t, e, "board", "1.0.0", "看板", true)
	now := e.h.now().UTC()

	// **同一个人**今天打开了两个应用（另有第二个人只开了一个）。
	for _, appID := range []string{"notes", "board"} {
		if err := serverstore.RecordWasmAppOpen(context.Background(), e.db, serverstore.WasmAppOpen{
			AppID: appID, UserID: 1, At: now}); err != nil {
			t.Fatalf("写明细(%s): %v", appID, err)
		}
	}
	if err := serverstore.RecordWasmAppOpen(context.Background(), e.db, serverstore.WasmAppOpen{
		AppID: "notes", UserID: 2, At: now}); err != nil {
		t.Fatalf("写明细(notes/user2): %v", err)
	}
	// 日汇总（趋势的 PV 与日期集合读它）走真实写入路径。
	if _, err := serverstore.AggregateWasmAppOpens(context.Background(), e.db, now, now); err != nil {
		t.Fatalf("汇总: %v", err)
	}

	w := e.req(http.MethodGet, "/api/server/admin/wasm-apps/opens/summary?days=7&top=10", e.tokens["boss"], nil)
	var out struct {
		Today struct {
			Day string `json:"day"`
			PV  int64  `json:"pv"`
			UV  int64  `json:"uv"`
		} `json:"today"`
		Totals struct {
			PV int64 `json:"pv"`
			UV int64 `json:"uv"`
		} `json:"totals"`
		Trend []struct {
			Day string `json:"day"`
			PV  int64  `json:"pv"`
			UV  int64  `json:"uv"`
		} `json:"trend"`
		Apps []struct {
			AppID    string `json:"app_id"`
			WindowUV int64  `json:"window_uv"`
		} `json:"apps"`
	}
	e.decodeJSON(w, http.StatusOK, &out)

	var sumAppsUV int64
	for _, a := range out.Apps {
		sumAppsUV += a.WindowUV
	}
	if len(out.Apps) != 2 || sumAppsUV != 3 {
		t.Fatalf("前置：两个应用窗口 UV 合计应为 3，得到 %+v", out.Apps)
	}
	if len(out.Trend) != 1 {
		t.Fatalf("同日窗口的趋势应恰有 1 个点，得到 %+v", out.Trend)
	}
	if out.Trend[0].UV != 2 {
		t.Fatalf("trend[0].uv = %d, want 2（当天真实去重人数）；各应用 uv 相加会得到 %d —— "+
			"§5.1c A 的 UV 禁令对趋势点同样适用（P1-1）", out.Trend[0].UV, sumAppsUV)
	}
	if out.Trend[0].UV != out.Totals.UV {
		t.Fatalf("同日窗口下 trend[0].uv(%d) 必须等于 totals.uv(%d)：同一块看板两个 UV 不得自相矛盾",
			out.Trend[0].UV, out.Totals.UV)
	}
	if out.Today.UV != 2 {
		t.Fatalf("today.uv = %d, want 2", out.Today.UV)
	}
	// PV 与 UV 同源（窗口内有明细 ⇒ 都取明细的 count(*)）：本次 3 次打开。
	if out.Trend[0].PV != 3 {
		t.Fatalf("trend[0].pv = %d, want 3（PV 取明细，与 UV 同源）", out.Trend[0].PV)
	}
	// AUD-1 的**端点级**不变量（与 serverstore 的库级判据同一条）：
	//  ① 曲线每个点 uv <= pv；
	//  ② 今天那一点与 today{} 逐值一致（日汇总 tick 落后时旧实现会在这一条上翻车）。
	for _, p := range out.Trend {
		if p.UV > p.PV {
			t.Fatalf("不变量破裂：trend[%s] uv=%d > pv=%d（同一天必须同源）", p.Day, p.UV, p.PV)
		}
		if p.Day == out.Today.Day && (p.PV != out.Today.PV || p.UV != out.Today.UV) {
			t.Fatalf("trend[%s]={pv:%d uv:%d} 与 today={pv:%d uv:%d} 不一致（AUD-1）",
				p.Day, p.PV, p.UV, out.Today.PV, out.Today.UV)
		}
	}
}

// TestAdminOpensSummaryCappedWindowReportsHonestly 是 AUD-4（2026-09-20 独立对抗审计）
// 的判据：`capped=true` 必须在**生产端点**可达。
//
// 缺陷现场：`days` 先被钳到 90，而 `from=now-(days-1)` 恰好等于库内 maxStart ⇒
// `SummarizeWasmAppOpens` 的 `start.Before(maxStart)` 恒假 ⇒ `capped` **恒 false**；
// `days=365` 静默变成 90（回显的也是被钳后的 90），调用方拿不到"你要 365 天、实际只给
// 90 天"的信号。设计 §5.1c A 的这条语义**只存在于库函数**（库级 120 天窗口能构造出 true）。
//
// 判据（两个方向都要，防止"恒 true"也能过）：
//   - `days=7` ⇒ `capped=false` 且窗口就是 7 天；
//   - `days=90`（恰等于保留期）⇒ `capped=false`；
//   - `days=91` / `days=365` ⇒ `capped=true`，`days` 回显**生效值** 90，
//     `from/to` 是保留期内那 90 天（窗口如实，不是把请求值原样回显）。
//
// 变异验证：把 handler 里的 `sum.Capped || requestedDays > days` 改回 `sum.Capped`
// ⇒ 后两个子用例红（capped 恒 false）。
func TestAdminOpensSummaryCappedWindowReportsHonestly(t *testing.T) {
	e := newTestEnv(t)
	seedOpenApp(t, e, "notes", "1.0.0", "备忘工具", true)
	now := e.h.now().UTC()
	retention := serverstore.WasmAppOpensRetentionDays

	type summaryOut struct {
		From                string `json:"from"`
		To                  string `json:"to"`
		Days                int    `json:"days"`
		Top                 int    `json:"top"`
		Capped              bool   `json:"capped"`
		DetailRetentionDays int    `json:"detail_retention_days"`
	}
	fetch := func(days int) summaryOut {
		t.Helper()
		w := e.req(http.MethodGet,
			fmt.Sprintf("/api/server/admin/wasm-apps/opens/summary?days=%d", days), e.tokens["boss"], nil)
		var out summaryOut
		e.decodeJSON(w, http.StatusOK, &out)
		return out
	}

	for _, tc := range []struct {
		days     int
		wantCap  bool
		wantDays int
	}{
		{7, false, 7},
		{retention, false, retention},
		{retention + 1, true, retention},
		{365, true, retention},
	} {
		got := fetch(tc.days)
		if got.Capped != tc.wantCap {
			t.Fatalf("days=%d ⇒ capped=%v, want %v（请求窗口长于保留期 %d 天必须如实回报）",
				tc.days, got.Capped, tc.wantCap, retention)
		}
		if got.Days != tc.wantDays {
			t.Fatalf("days=%d ⇒ 回显 days=%d, want %d（回显的是生效窗口 = 被钳到多少）",
				tc.days, got.Days, tc.wantDays)
		}
		// 窗口如实：from/to 必须是**生效窗口**（今天往前 tc.wantDays-1 天 到 今天）。
		if wantFrom, wantTo := serverstore.LocalDayString(now.AddDate(0, 0, -(tc.wantDays-1))),
			serverstore.LocalDayString(now); got.From != wantFrom || got.To != wantTo {
			t.Fatalf("days=%d ⇒ 窗口 %s~%s, want %s~%s", tc.days, got.From, got.To, wantFrom, wantTo)
		}
		if got.DetailRetentionDays != retention {
			t.Fatalf("detail_retention_days = %d, want %d（调用方据此理解为什么被钳）",
				got.DetailRetentionDays, retention)
		}
	}
}
