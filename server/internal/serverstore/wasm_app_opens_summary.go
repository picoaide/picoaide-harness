package serverstore

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"path/filepath"
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

// WasmAppOpenSummaryRow 是"一个应用在窗口内"的打开汇总（`opens/summary` 的 `apps[]` 行）。
//
// 键名是**冻结契约**（设计 §5.1c A）：`window_pv`/`window_uv`（不是 `pv`/`uv`）+ `title`。
// 曾经服务端发 `pv`/`uv`、webadmin 读 `window_pv`/`window_uv` ⇒ 真实环境里列表
// 「近 N 日 PV/UV」两列恒显示 `—`（R2-L6-1，P1）。webadmin 的
// `opens-contract-parity.spec.ts` 读本文件的 json tag 与前端 interface **逐键对拍**，
// 任何一侧改名都会立刻变红。
type WasmAppOpenSummaryRow struct {
	AppID string `json:"app_id"`
	// Title 来自应用登记表（`apps`）。登记行不存在或标题为空时是**空串** ——
	// 调用方按缺省渲染（前端回落显示 app_id），**不得编造**（§5.1c A）。
	Title string `json:"title"`
	// TodayPV / TodayUV 是**今天**（本地日）的对应值，给列表列用。
	TodayPV int64 `json:"today_pv"`
	TodayUV int64 `json:"today_uv"`
	// WindowPV 是窗口内的打开次数（每次打开 +1，不去重）。
	WindowPV int64 `json:"window_pv"`
	// WindowUV 是**窗口内按 user_id 去重**的人数（不是逐日 UV 相加 —— 相加会把
	// "同一个人天天来"算成 N 个人，正是 W5 C2 明确禁止的口径）。
	WindowUV int64 `json:"window_uv"`
}

// WasmAppOpenTopRow 是看板 TOP N 的一行（契约 §5.1c A：`{app_id,title,pv,uv}`）。
//
// 为什么**不复用** WasmAppOpenSummaryRow：契约给 `apps[]` 的窗口列起名
// `window_pv`/`window_uv`，给 `top_apps[]` 起名 `pv`/`uv`。复用会让其中一侧多带
// 对方的名字，而跨端对拍用例断言的是**集合相等**（多一个键也算漂移）。
type WasmAppOpenTopRow struct {
	AppID string `json:"app_id"`
	Title string `json:"title"`
	PV    int64  `json:"pv"`
	UV    int64  `json:"uv"`
}

// WasmAppOpenSummaryToday 是 `today` 块（契约 §5.1c A：`{day,pv,uv}`）。
//
// 读**明细表**（与 §5.1b 的 `opens.today` 同源），保证"本次调用计数在内"。
type WasmAppOpenSummaryToday struct {
	Day string `json:"day"`
	PV  int64  `json:"pv"`
	UV  int64  `json:"uv"`
}

// WasmAppOpenSummaryTotals 是 `totals` 块（窗口合计）。
//
// ⚠️ 契约 §5.1c A 的硬约束：它必须是**不带 `GROUP BY app_id` 的一次聚合** ——
// 把各应用的 `uv` 相加会把"同一个人开了两个应用"重复计数（UV 是人数，不是次数）。
type WasmAppOpenSummaryTotals struct {
	PV int64 `json:"pv"`
	UV int64 `json:"uv"`
}

// WasmOpenTrendPoint 是趋势曲线上的一个点（按本地自然日）。
type WasmOpenTrendPoint struct {
	Day string `json:"day"`
	// PV 是**当天打开次数**（每次打开 +1，不去重）。
	//
	// 读源**与同一天的 UV 同源**（AUD-1，2026-09-20）：明细覆盖到的天取明细的
	// `count(*)`；只有明细已不在的天（早于 90 天保留期）才回落日汇总的 `SUM(pv)`
	// （长期保留，曲线不断档）。见 SummarizeWasmAppOpens 的 ③。
	PV int64 `json:"pv"`
	// UV 是**当天**按 user_id 去重的人数（曲线上的一天；窗口级去重在 summary 里给）。
	//
	// ⚠️ 它是**跨应用去重后**的人数（`count(DISTINCT user_id)`），**不是**日汇总里
	// 各应用 uv 之和：同一人当天开两个应用只算 1（P1-1，§5.1c A 的 UV 禁令同样适用
	// 于趋势点 —— "UV 一律真实去重"）。
	//
	// UV 与 PV 出自**同一次明细聚合**（或同一天明细已不在时 UV 如实给 0）⇒ 每个点
	// 恒有 `uv <= pv`（人数不超过次数）。这条不变量由
	// TestSummarizeWasmAppOpensTrendSameSourcePerDay 钉住。
	UV int64 `json:"uv"`
}

// WasmAppOpensSummary 是看板概览的数据面（契约 §5.1c A 的 `apps`/`today`/`totals`/`trend`）。
type WasmAppOpensSummary struct {
	Apps   []WasmAppOpenSummaryRow
	Trend  []WasmOpenTrendPoint
	Today  WasmAppOpenSummaryToday
	Totals WasmAppOpenSummaryTotals
	Capped bool
}

// SummarizeWasmAppOpens 汇总窗口内的打开数据（W5 C2 的 `trend` / `apps` / `top_apps` 数据源）。
//
// 读源口径（§5.1c A，**双读源是有意的**）：
//   - `apps[]`（含每应用的今日/窗口 PV+UV）、`today`、`totals` 读**明细表**
//     `wasm_app_opens`：窗口 UV 需要按 user_id 跨天去重，日汇总表只有"每天每部门"
//     的计数，跨天去重不可能从它算出来（相加会重复计数）；
//   - `trend[]` **同一天同源**（AUD-1，2026-09-20）：明细覆盖到的天，PV 与 UV 都取自
//     **同一次明细聚合**（`count(*)` / `count(DISTINCT user_id)`）；只有明细已不在的
//     天（早于 90 天保留期）PV 才回落日汇总 `wasm_app_opens_daily`（长期保留）并把
//     UV 如实给 0 —— 见 ③ 的完整理由。
//
// `totals` 是**一次不带 `GROUP BY app_id` 的聚合**（不是把各行相加）：后者会把
// "同一个人开两个应用"算成 2 个人。
//
// 明细保留 `WasmAppOpensRetentionDays`（90 天），因此窗口上限就是它；超过时
// **收敛到 90 天**并把 `capped=true` 如实回报（不静默给一个偏小的数）。
//
// now 用于"今天"那一列与 `today.day`（本地日）。
func SummarizeWasmAppOpens(ctx context.Context, db *sql.DB, from, to time.Time, now time.Time) (*WasmAppOpensSummary, error) {
	start := LocalDay(from)
	end := LocalDay(to)
	if end.Before(start) {
		start, end = end, start
	}
	// 窗口上限：明细只保留 90 天。capped=true 让调用方（与前端）知道"你要的窗口
	// 比数据活得更久"，而不是以为"那么久以前没人用"。
	capped := false
	if maxStart := LocalDay(now).AddDate(0, 0, -(WasmAppOpensRetentionDays - 1)); start.Before(maxStart) {
		start, capped = maxStart, true
	}
	startAt, endAt := start.UTC(), end.AddDate(0, 0, 1).UTC()
	todayAt := LocalDay(now).UTC()
	todayEnd := LocalDay(now).AddDate(0, 0, 1).UTC()

	out := &WasmAppOpensSummary{
		Apps:   []WasmAppOpenSummaryRow{},
		Trend:  []WasmOpenTrendPoint{},
		Capped: capped,
		Today:  WasmAppOpenSummaryToday{Day: LocalDayString(now)},
	}

	// ① 每个应用的窗口/今日计数（**明细表**）+ 应用标题（左连登记表；查不到就是空串）。
	//
	// 为什么要连 `apps`：`title` 是契约字段（§5.1c A），而明细表只有 app_id。
	// `apps` 的主键是 (kind, app_id) ⇒ 这是一对一左连，不会让聚合行翻倍；
	// 软删（deleted_at 非空）的登记行**照样取标题** —— 历史打开记录仍要显示得懂。
	rows, qerr := db.QueryContext(ctx, `
		SELECT o.app_id, COALESCE(a.title, '') AS title,
		       count(*) AS pv,
		       count(DISTINCT o.user_id) AS uv,
		       count(*) FILTER (WHERE o.opened_at >= $3 AND o.opened_at < $4) AS today_pv,
		       count(DISTINCT o.user_id) FILTER (WHERE o.opened_at >= $3 AND o.opened_at < $4) AS today_uv
		  FROM wasm_app_opens o
		  LEFT JOIN apps a ON a.kind = $5 AND a.app_id = o.app_id
		 WHERE o.opened_at >= $1 AND o.opened_at < $2
		 GROUP BY o.app_id, a.title
		 ORDER BY pv DESC, o.app_id`, startAt, endAt, todayAt, todayEnd, AppKindWasmApp)
	if qerr != nil {
		return nil, fmt.Errorf("汇总应用打开: %w", qerr)
	}
	defer rows.Close()
	for rows.Next() {
		var r WasmAppOpenSummaryRow
		if serr := rows.Scan(&r.AppID, &r.Title, &r.WindowPV, &r.WindowUV, &r.TodayPV, &r.TodayUV); serr != nil {
			return nil, serr
		}
		out.Apps = append(out.Apps, r)
	}
	if rerr := rows.Err(); rerr != nil {
		return nil, rerr
	}

	// ② `today` / `totals`：**同一次聚合**（都读明细表，都不带 `GROUP BY app_id`）。
	//
	// `today` 与 `apps[].today_*` 用同一个窗口条件（`to` 通常就是 now）⇒ 两块数字
	// 永远同源一致；`totals.uv` / `today.uv` 是真正的人数去重（不是各行相加）。
	var totPV, totUV, todayPV, todayUV int64
	if qerr := db.QueryRowContext(ctx, `
		SELECT count(*), count(DISTINCT user_id),
		       count(*) FILTER (WHERE opened_at >= $3 AND opened_at < $4),
		       count(DISTINCT user_id) FILTER (WHERE opened_at >= $3 AND opened_at < $4)
		  FROM wasm_app_opens
		 WHERE opened_at >= $1 AND opened_at < $2`, startAt, endAt, todayAt, todayEnd).
		Scan(&totPV, &totUV, &todayPV, &todayUV); qerr != nil {
		return nil, fmt.Errorf("汇总窗口合计: %w", qerr)
	}
	out.Totals = WasmAppOpenSummaryTotals{PV: totPV, UV: totUV}
	out.Today.PV, out.Today.UV = todayPV, todayUV

	// ③ 趋势：**同一天同源**（AUD-1，2026-09-20 独立对抗审计）。
	//
	// 规则（每条都有判据，见 wasm_app_opens_summary_test.go）：
	//   - 明细覆盖到的天（本次明细聚合里有这一天的行）⇒ PV 与 UV **都取明细**：同一次
	//     `GROUP BY 日` 里的 `count(*)` 与 `count(DISTINCT user_id)` ⇒ 逐日恒有
	//     `uv <= pv`（人数不超过次数，语义上不可能反过来），且今天这一点与 `today{}`
	//     逐值一致（不管日汇总 tick 有没有跑过）；
	//   - 明细已不在的天（早于 90 天保留期，或历史上被保留期清理过的天）⇒ PV 回落
	//     **日汇总**（长期保留，曲线不断档），UV 如实给 0（当天人数已不可知，不编）。
	//
	// 为什么不能"PV 一律读日汇总 + UV 读明细"（**这正是 P1-1 修复自身引入的回归**）：
	// 日汇总由 `opens.Scheduler` 每 5 分钟 tick 一次（`AggregateWasmAppOpens(now-2d, now)`）
	// ⇒ **今天那一行是上一轮 tick 的快照**，而 UV 读的是实时明细。于是 tick 之后发生的
	// 任何打开只进 UV 不进 PV，同一份响应里出现 `uv > pv`（活体实测
	// `trend=[{day:2026-09-20 pv:26 uv:27}]` 而同页 `today={pv:52 uv:27}`）；首个 tick
	// 之前更是"`today` 有数、曲线没有今天"（日期集合曾经只以日汇总为准）。
	//
	// 日边界仍然**只有一个来源**（`LocalDay`，见 LocalDay 与迁移 0075 的时区口径）：
	// 逐日边界在 Go 侧算好，作为 `width_bucket` 的阈值数组一次传给 SQL —— 既不写
	// `opened_at::date`（取 PG 会话时区），也不写 `AT TIME ZONE`（要先解析出 PG 认识的
	// 时区名，解不出名字时会静默按 UTC 分日）。`width_bucket(ts, 升序阈值数组)` 对阈值
	// 做二分查找，` - 1` 就是 Go 侧那个下标，因此 DST 造成的 23/25 小时日也精确。
	//
	// 趋势的**日期集合** = 明细覆盖到的天 ∪ 日汇总里有行的天（顺序仍按 `dayKeys`
	// 升序，不引入第二份日序实现）：既不因为"明细过期"断档，也不因为"今天还没 tick"
	// 漏掉今天。没有数据的天不出现（稀疏序列是有意保留的既有形状，见审计观察项 1）。
	dayKeys := make([]string, 0, 32)
	dayStarts := make([]int64, 0, 32)
	for day := start; !day.After(end); day = day.AddDate(0, 0, 1) {
		dayKeys = append(dayKeys, LocalDayString(day))
		dayStarts = append(dayStarts, day.Unix())
	}
	// 明细聚合：PV 与 UV 出自**同一次** GROUP BY（同源是这条修复的核心）。
	type trendDayAgg struct{ PV, UV int64 }
	detailByDay := make(map[string]trendDayAgg, len(dayKeys))
	if len(dayStarts) > 0 {
		urows, uerr := db.QueryContext(ctx, `
			SELECT width_bucket(floor(extract(epoch FROM opened_at))::bigint, ?::bigint[]) - 1 AS day_idx,
			       count(*) AS pv,
			       count(DISTINCT user_id) AS uv
			  FROM wasm_app_opens
			 WHERE opened_at >= ? AND opened_at < ?
			 GROUP BY 1`, pgInt64Array(dayStarts), startAt, endAt)
		if uerr != nil {
			return nil, fmt.Errorf("汇总应用打开趋势明细: %w", uerr)
		}
		defer urows.Close()
		for urows.Next() {
			var idx, pv, uv int64
			if serr := urows.Scan(&idx, &pv, &uv); serr != nil {
				return nil, serr
			}
			// 越界是不可能的（阈值覆盖整个 WHERE 窗口），所以这里 fail-loud 而不是
			// 静默丢弃：真出现越界就是分桶口径坏了，给一个少一天 UV 的曲线才是误导。
			if idx < 0 || int(idx) >= len(dayKeys) {
				return nil, fmt.Errorf("汇总应用打开趋势明细: 日下标 %d 越界（窗口内 %d 天，"+
					"阈值数组与 WHERE 窗口不同源）", idx, len(dayKeys))
			}
			detailByDay[dayKeys[idx]] = trendDayAgg{PV: pv, UV: uv}
		}
		if rerr := urows.Err(); rerr != nil {
			return nil, rerr
		}
	}

	// 日汇总 PV：只服务"明细已不在的天"，也是趋势日期集合的另一半来源。
	summaryPV := make(map[string]int64, len(dayKeys))
	trows, terr := db.QueryContext(ctx, `
		SELECT day::text, SUM(pv) FROM wasm_app_opens_daily
		 WHERE day >= $1 AND day <= $2
		 GROUP BY 1 ORDER BY 1`,
		LocalDayString(start), LocalDayString(end))
	if terr != nil {
		return nil, fmt.Errorf("汇总应用打开趋势: %w", terr)
	}
	defer trows.Close()
	for trows.Next() {
		var day string
		var pv int64
		if serr := trows.Scan(&day, &pv); serr != nil {
			return nil, serr
		}
		summaryPV[day] = pv
	}
	if rerr := trows.Err(); rerr != nil {
		return nil, rerr
	}

	for _, day := range dayKeys {
		if agg, ok := detailByDay[day]; ok {
			// 该日有明细 ⇒ PV/UV 同源（uv <= pv 恒成立）。
			out.Trend = append(out.Trend, WasmOpenTrendPoint{Day: day, PV: agg.PV, UV: agg.UV})
			continue
		}
		if pv, ok := summaryPV[day]; ok {
			// 该日明细已不在 ⇒ PV 仍真实（日汇总长期保留），UV 如实给 0 而不是编一个。
			out.Trend = append(out.Trend, WasmOpenTrendPoint{Day: day, PV: pv, UV: 0})
		}
	}
	return out, nil
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

// localZoneName 返回服务端本地时区的**PG 时区名**（给 SQL 的 `AT TIME ZONE` 用）。
//
// 与 LocalDay 的分工：LocalDay 在 Go 侧算日边界（明细/汇总的写入口径），这里只是
// 让 **usage 的分组**也按同一个本地日显示 —— usage.created_at 是分区键，按它
// 分组必须带时区，否则会按 PG 会话时区分桶（与应用侧口径不同源）。
//
// ⚠️ `time.Local.String()` **不保证**是 PG 认识的名字（R2-L1-3，2026-09-20）：
//
//	TZ=Asia/Shanghai                       → "Asia/Shanghai"（IANA 名，直接用）
//	TZ=:/usr/share/zoneinfo/Asia/Shanghai  → Go 的 initLocal 把**路径本身**当名字
//	                                         ⇒ PG 报 `time zone "…" not recognized` ⇒ 500
//	未设 TZ（名字是 "Local"）              → 只有 /etc/localtime 的符号链接能反解出名字
//	TZ=CST-8 / TZ=Not/AZone（POSIX/非法）  → Go 自己回落 UTC（名字就是 "UTC"，一致）
//
// ⇒ 只把**经 `time.LoadLocation` 认过的 IANA 名**交给 PG；解不出就回落 "UTC" 并 warn
// （回落与 Go 侧一致：POSIX/非法 TZ 时 Go 的 `time.Local` 本身就是 UTC）。绝不把
// 路径、POSIX 串或任意字符串当"时区名"递给 PG —— 那会让 C4 端点 500（C1/C2 正常，
// 因为它们走纯 Go 的 LocalDay）。
func localZoneName() string {
	name := time.Local.String()
	if zone, ok := zoneNameForSQL(name); ok {
		return zone
	}
	// "Local" = 未设 TZ：Go 从 /etc/localtime 拿到了**真实偏移**但把名字置成 "Local"。
	// 能从符号链接反解出 IANA 名就用它 —— 否则 SQL 按 UTC 分日而 Go 侧 LocalDay 用
	// 真实偏移，同一份数据会出现两套"本地日"（两处口径必须同源）。
	if name == "" || name == "Local" {
		if zone, ok := zoneNameFromLocaltime("/etc/localtime"); ok {
			return zone
		}
	}
	log.Printf("wasm_app_opens: 本地时区名 %q 不能作为 PG 时区（AT TIME ZONE 只认 IANA 名）"+
		"⇒ 按日分组回落 UTC；要按本地日分组请把 TZ 设为 IANA 名（如 Asia/Shanghai）", name)
	return "UTC"
}

// zoneNameForSQL 把 `time.Local.String()` 的形态规范成 PG 认识的时区名。
//
// 只有两种形态能过：① IANA 名（`time.LoadLocation` 认）；② zoneinfo 下的**路径**
// （TZ 写成 `:/usr/share/zoneinfo/Asia/Shanghai` 时 Go 会原样把路径当名字）—— 后者
// 剥掉根前缀后仍要经 `time.LoadLocation` 复核，避免把 `..` 或任意路径拼成"名字"。
func zoneNameForSQL(name string) (string, bool) {
	candidate := strings.TrimSpace(name)
	// "Local" 必须在 LoadLocation 之前挡掉：`time.LoadLocation("Local")` 会成功返回
	// `time.Local`（名字仍是 "Local"），而 "Local" 不是 PG 认识的时区名。
	if candidate == "" || candidate == "Local" {
		return "", false
	}
	if _, err := time.LoadLocation(candidate); err == nil {
		return candidate, true
	}
	return zoneNameFromZoneinfoPath(candidate)
}

// zoneinfoRoots 是 zoneinfo 的候选根（与 `time` 包的 platformZoneSources 同口径；
// 最后一条是 macOS 的布局，Linux 服务器上不存在也不影响）。
var zoneinfoRoots = []string{
	"/usr/share/zoneinfo/",
	"/usr/share/lib/zoneinfo/",
	"/usr/lib/zoneinfo/",
	"/usr/local/share/zoneinfo/",
	"/var/db/timezone/zoneinfo/",
}

// zoneNameFromZoneinfoPath 从 zoneinfo 下的**绝对路径**反解 IANA 名（解不出返回 false）。
func zoneNameFromZoneinfoPath(path string) (string, bool) {
	if !filepath.IsAbs(path) {
		return "", false
	}
	clean := filepath.Clean(path)
	for _, root := range zoneinfoRoots {
		rel, err := filepath.Rel(filepath.Clean(root), clean)
		if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			continue
		}
		zone := filepath.ToSlash(rel)
		if _, err := time.LoadLocation(zone); err == nil {
			return zone, true
		}
	}
	return "", false
}

// zoneNameFromLocaltime 从 localtime（通常是指向 zoneinfo 的符号链接）反解 IANA 名。
// 纯函数（path 由调用方给），因此"未设 TZ"这条路径可以在不依赖宿主环境的前提下被测试。
func zoneNameFromLocaltime(path string) (string, bool) {
	target, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", false
	}
	return zoneNameFromZoneinfoPath(target)
}
