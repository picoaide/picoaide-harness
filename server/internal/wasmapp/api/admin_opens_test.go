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
//   - 把 attribution_available 恒 true ⇒ C4 的"暂无归因"用例红。

import (
	"context"
	"encoding/json"
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
	for _, want := range []string{`"apps":[]`, `"trend":[]`, `"top_apps":[]`} {
		if !strings.Contains(emptyRaw, want) {
			t.Fatalf("无数据时必须是 %s（空数组而不是 null）: %s", want, emptyRaw)
		}
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
		From   string            `json:"from"`
		To     string            `json:"to"`
		Days   int               `json:"days"`
		Top    int               `json:"top"`
		Capped bool              `json:"capped"`
		Trend  []json.RawMessage `json:"trend"`
		Apps   []struct {
			AppID   string `json:"app_id"`
			PV      int64  `json:"pv"`
			UV      int64  `json:"uv"`
			TodayPV int64  `json:"today_pv"`
			TodayUV int64  `json:"today_uv"`
		} `json:"apps"`
		TopApps []json.RawMessage `json:"top_apps"`
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
	if out.Apps[0].PV != 3 || out.Apps[0].UV != 2 {
		t.Fatalf("窗口 pv/uv = %d/%d, want 3/2（uv 必须跨天去重，不是逐日相加）",
			out.Apps[0].PV, out.Apps[0].UV)
	}
	// ③ 今日列：今天两次打开、两个人 ⇒ pv2/uv2。
	if out.Apps[0].TodayPV != 2 || out.Apps[0].TodayUV != 2 {
		t.Fatalf("今日 pv/uv = %d/%d, want 2/2", out.Apps[0].TodayPV, out.Apps[0].TodayUV)
	}
	if out.Days != 7 || out.Top != 5 || out.Capped {
		t.Fatalf("分页/窗口元数据不符: %+v", out)
	}
	if len(out.Trend) == 0 {
		t.Fatal("趋势不应为空（已汇总过两天）")
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
