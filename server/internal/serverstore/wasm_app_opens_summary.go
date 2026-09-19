package serverstore

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// WASM 应用**打开概览**与**AI 用量**的数据访问层（W5 C2/C4）。
//
// 与 wasm_app_opens.go 的分工：
//   - 那里是 open 端点的写路径 + 单应用按日/按部门查询（F16 C3）；
//   - 这里是**看板**要的跨应用聚合（列表列的今日/窗口 PV+UV、趋势、TOP N）
//     与 `usage.app_id` 的应用维度 AI 用量。
//
// 时间口径与 §5.1b 第 3 条冻结一致：`day` / `today` 都是**服务端本地日**
// （`LocalDay` / `LocalDayString`），聚合窗口 [from, to] 按本地自然日（含两端）。

// WasmAppOpenSummaryRow 是"一个应用在窗口内"的打开汇总。
type WasmAppOpenSummaryRow struct {
	AppID string `json:"app_id"`
	// PV 是窗口内的打开次数（每次打开 +1，不去重）。
	PV int64 `json:"pv"`
	// UV 是**窗口内按 user_id 去重**的人数（不是逐日 UV 相加 —— 相加会把
	// "同一个人天天来"算成 N 个人，正是 W5 C2 明确禁止的口径）。
	UV int64 `json:"uv"`
	// TodayPV / TodayUV 是**今天**（本地日）的对应值，给列表列用。
	TodayPV int64 `json:"today_pv"`
	TodayUV int64 `json:"today_uv"`
}

// WasmOpenTrendPoint 是趋势曲线上的一个点（按本地自然日）。
type WasmOpenTrendPoint struct {
	Day string `json:"day"`
	PV  int64  `json:"pv"`
	// UV 是**当天**按 user_id 去重的人数（曲线上的一天；窗口级去重在 summary 里给）。
	UV int64 `json:"uv"`
}

// SummarizeWasmAppOpens 汇总窗口内的打开数据（W5 C2 的 `trend` / `apps` / `top_apps` 数据源）。
//
// 为什么 PV/UV 读**明细**而不是日汇总：窗口 UV 需要按 user_id 跨天去重，而日汇总表
// 只有"每天每部门"的计数 —— 跨天去重不可能从它算出来（相加会重复计数）。
// 明细保留 `WasmAppOpensRetentionDays`（90 天），因此窗口上限就是它；超过时
// **收敛到 90 天**并把 `capped=true` 如实回报（不静默给一个偏小的数）。
//
// now 只用于"今天"那一列（本地日）。
func SummarizeWasmAppOpens(ctx context.Context, db *sql.DB, from, to time.Time, now time.Time) (apps []WasmAppOpenSummaryRow, trend []WasmOpenTrendPoint, capped bool, err error) {
	start := LocalDay(from)
	end := LocalDay(to)
	if end.Before(start) {
		start, end = end, start
	}
	// 窗口上限：明细只保留 90 天。capped=true 让调用方（与前端）知道"你要的窗口
	// 比数据活得更久"，而不是以为"那么久以前没人用"。
	if maxStart := LocalDay(now).AddDate(0, 0, -(WasmAppOpensRetentionDays - 1)); start.Before(maxStart) {
		start, capped = maxStart, true
	}
	startAt, endAt := start.UTC(), end.AddDate(0, 0, 1).UTC()
	todayAt := LocalDay(now).UTC()
	todayEnd := LocalDay(now).AddDate(0, 0, 1).UTC()

	apps = []WasmAppOpenSummaryRow{}
	rows, qerr := db.QueryContext(ctx, `
		SELECT app_id,
		       count(*) AS pv,
		       count(DISTINCT user_id) AS uv,
		       count(*) FILTER (WHERE opened_at >= $3 AND opened_at < $4) AS today_pv,
		       count(DISTINCT user_id) FILTER (WHERE opened_at >= $3 AND opened_at < $4) AS today_uv
		  FROM wasm_app_opens
		 WHERE opened_at >= $1 AND opened_at < $2
		 GROUP BY app_id
		 ORDER BY pv DESC, app_id`, startAt, endAt, todayAt, todayEnd)
	if qerr != nil {
		return nil, nil, capped, fmt.Errorf("汇总应用打开: %w", qerr)
	}
	defer rows.Close()
	for rows.Next() {
		var r WasmAppOpenSummaryRow
		if serr := rows.Scan(&r.AppID, &r.PV, &r.UV, &r.TodayPV, &r.TodayUV); serr != nil {
			return nil, nil, capped, serr
		}
		apps = append(apps, r)
	}
	if rerr := rows.Err(); rerr != nil {
		return nil, nil, capped, rerr
	}

	// 趋势按**日汇总**读（长期保留；明细过期后曲线仍在），与 apps 的窗口口径不同源
	// 是有意的：趋势是"历史形状"，不该因为明细过期而断档。
	trend = []WasmOpenTrendPoint{}
	trows, terr := db.QueryContext(ctx, `
		SELECT day::text, SUM(pv), SUM(uv) FROM wasm_app_opens_daily
		 WHERE day >= $1 AND day <= $2
		 GROUP BY 1 ORDER BY 1`,
		LocalDayString(start), LocalDayString(end))
	if terr != nil {
		return nil, nil, capped, fmt.Errorf("汇总应用打开趋势: %w", terr)
	}
	defer trows.Close()
	for trows.Next() {
		var p WasmOpenTrendPoint
		if serr := trows.Scan(&p.Day, &p.PV, &p.UV); serr != nil {
			return nil, nil, capped, serr
		}
		trend = append(trend, p)
	}
	if rerr := trows.Err(); rerr != nil {
		return nil, nil, capped, rerr
	}
	return apps, trend, capped, nil
}

// WasmAppAIUsageDay 是应用维度 AI 用量的一天。
type WasmAppAIUsageDay struct {
	Day string `json:"day"`
	// Requests 是 usage 行数（一次 LLM 调用一行）。
	Requests int64 `json:"requests"`
	// PromptTokens / CompletionTokens / CachePromptTokens 是 token 数。
	PromptTokens      int64 `json:"prompt_tokens"`
	CompletionTokens  int64 `json:"completion_tokens"`
	CachePromptTokens int64 `json:"cache_prompt_tokens"`
	// Cost 是费用（元，与 usage.cost 同口径）。
	Cost float64 `json:"cost"`
}

// WasmAppAIUsage 是 `GET …/:app_id/ai-usage` 的响应。
type WasmAppAIUsage struct {
	AppID string              `json:"app_id"`
	From  string              `json:"from"`
	To    string              `json:"to"`
	Days  []WasmAppAIUsageDay `json:"days"`
	Total WasmAppAIUsageDay   `json:"total"`
	// AttributionAvailable=false 表示**平台在这个窗口里还没有任何带应用归因的
	// usage 行**（`X-Pico-App-Id` 尚未被客户端发送，见 §21.4 的落地顺序）。
	//
	// 为什么必须把它与"零调用"分开（W5 C4 的判据）：两者在数字上都是 0，
	// 但含义完全相反 —— 前者是"统计还没上线"，后者是"这个应用确实没调过模型"。
	// 让前端把前者渲染成 0 就是在编数据。
	AttributionAvailable bool `json:"attribution_available"`
}

// QueryWasmAppAIUsage 读应用维度的 AI 用量（0076 的 `usage.app_id`）。
//
// 只读**汇总数字**：usage 是分区大表，按应用聚合必须走 `idx_usage_app_time`
// 的部分索引（`app_id <> ”`），窗口由调用方收窄。
func QueryWasmAppAIUsage(ctx context.Context, db *sql.DB, appID string, from, to time.Time) (*WasmAppAIUsage, error) {
	id := strings.ToLower(strings.TrimSpace(appID))
	if id == "" {
		return nil, fmt.Errorf("serverstore: 缺少 app_id")
	}
	out := &WasmAppAIUsage{
		AppID: id,
		From:  LocalDayString(from),
		To:    LocalDayString(to),
		Days:  []WasmAppAIUsageDay{},
	}
	startAt := LocalDay(from).UTC()
	endAt := LocalDay(to).AddDate(0, 0, 1).UTC()

	// 归因是否已启用：只要窗口里存在**任何**非空 app_id 行，就说明客户端已经在带
	// 归因头（此时本应用为 0 = 真的没调用）。
	if err := db.QueryRowContext(ctx,
		`SELECT EXISTS (SELECT 1 FROM usage WHERE app_id <> '' AND created_at >= $1 AND created_at < $2)`,
		startAt, endAt).Scan(&out.AttributionAvailable); err != nil {
		return nil, fmt.Errorf("查归因可用性: %w", err)
	}

	rows, err := db.QueryContext(ctx, `
		SELECT (created_at AT TIME ZONE $4)::date::text AS day,
		       count(*), COALESCE(SUM(prompt_tokens),0), COALESCE(SUM(completion_tokens),0),
		       COALESCE(SUM(cache_prompt_tokens),0), COALESCE(SUM(cost),0)
		  FROM usage
		 WHERE app_id = $1 AND created_at >= $2 AND created_at < $3
		 GROUP BY 1 ORDER BY 1`,
		id, startAt, endAt, localZoneName())
	if err != nil {
		return nil, fmt.Errorf("查应用 AI 用量: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var d WasmAppAIUsageDay
		if serr := rows.Scan(&d.Day, &d.Requests, &d.PromptTokens, &d.CompletionTokens,
			&d.CachePromptTokens, &d.Cost); serr != nil {
			return nil, serr
		}
		out.Days = append(out.Days, d)
		out.Total.Requests += d.Requests
		out.Total.PromptTokens += d.PromptTokens
		out.Total.CompletionTokens += d.CompletionTokens
		out.Total.CachePromptTokens += d.CachePromptTokens
		out.Total.Cost += d.Cost
	}
	if rerr := rows.Err(); rerr != nil {
		return nil, rerr
	}
	return out, nil
}

// localZoneName 返回服务端本地时区的**IANA 名**（给 SQL 的 `AT TIME ZONE` 用）。
//
// 与 LocalDay 的分工：LocalDay 在 Go 侧算日边界（明细/汇总的写入口径），这里只是
// 让 **usage 的分组**也按同一个本地日显示 —— usage.created_at 是分区键，按它
// 分组必须带时区，否则会按 PG 会话时区分桶（与应用侧口径不同源）。
// 取不到名字（TZ 是 POSIX 形态/固定偏移）时回落 'UTC' 并在数据上如实体现（不猜）。
func localZoneName() string {
	name := time.Local.String()
	if name == "" || name == "Local" {
		return "UTC"
	}
	return name
}
