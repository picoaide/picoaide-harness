package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

// adminAppOpens 是 `GET /api/server/admin/wasm-apps/:app_id/opens`
// （契约 §8.9 管理端出口④，capability:read）。
//
// 查询参数：`from` / `to`（YYYY-MM-DD，缺省 = 近 7 天）、`granularity=day|dept`（缺省 day）。
//
// 只读**日汇总表**（长期保留的那一份），理由见 serverstore.QueryWasmAppOpens 的注释：
// 读明细会在 90 天边界上给出"使用量断崖"的假象。
//
// 数据来源与 `open` 端点写入的明细同源（汇总由 opens.Scheduler 先汇总后清理），
// 响应里的 `detail_retention_days` 让调用方知道"多久以前的明细已经不在"。
func (h *Handlers) adminAppOpens(c *gin.Context) {
	appID := strings.ToLower(strings.TrimSpace(c.Param("app_id")))
	if aerr := h.validateAppID(appID); aerr != nil {
		writeErr(c, aerr)
		return
	}
	now := h.now()
	from, aerr := parseDayParam(c.Query("from"), now.AddDate(0, 0, -6))
	if aerr != nil {
		writeErr(c, aerr.WithDetail("field", "from"))
		return
	}
	to, aerr := parseDayParam(c.Query("to"), now)
	if aerr != nil {
		writeErr(c, aerr.WithDetail("field", "to"))
		return
	}
	if to.Before(from) {
		writeErr(c, apperr.New(apperr.CodeValidation, "to 不能早于 from").
			WithDetail("from", from.Format("2006-01-02")).
			WithDetail("to", to.Format("2006-01-02")))
		return
	}
	gran := strings.ToLower(strings.TrimSpace(c.DefaultQuery("granularity", "day")))
	if gran != "day" && gran != "dept" {
		writeErr(c, apperr.New(apperr.CodeValidation, "granularity 只支持 day|dept").
			WithDetail("granularity", gran))
		return
	}
	series, err := serverstore.QueryWasmAppOpens(c.Request.Context(), h.opt.DB, serverstore.WasmOpenQuery{
		AppID:       appID,
		From:        from,
		To:          to,
		Granularity: gran,
	})
	if err != nil {
		writeErr(c, apperr.New(apperr.CodeInternal, "查询应用打开数据失败").
			WithHint("这是平台侧故障（数据库不可达）；请稍后重试"))
		return
	}
	c.JSON(http.StatusOK, series)
}

// parseDayParam 解析 YYYY-MM-DD（空 = 取缺省值）。
//
// 为什么**严格**只认这一种格式：看板与导出会把它当区间边界用，容忍
// `2006-1-2`/`06-01-02` 这类变体意味着"同一天有两种字符串表示"，而排障时要靠
// 肉眼比对 URL 与日志 —— 形状唯一才比得动。
func parseDayParam(raw string, def time.Time) (time.Time, *apperr.Error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return dayStart(def), nil
	}
	t, err := time.Parse("2006-01-02", raw)
	if err != nil {
		return time.Time{}, apperr.New(apperr.CodeValidation, "日期格式应为 YYYY-MM-DD").
			WithDetail("value", clip(raw)).
			WithHint("例：from=2026-09-01&to=2026-09-19")
	}
	return dayStart(t), nil
}

// dayStart 把时刻归一到**本地自然日**的零点（契约 §5.1b 第 3 条冻结口径）。
//
// ⚠️ 必须是本地日（`serverstore.LocalDay`），不是 UTC 日：`day` 列与 `opens.today`
// 都按服务端本地日分桶，而"今天"在 UTC 与本地之间可能差一天（实测形态：CST 01:11
// 的一次调用在 UTC 还是前一天 17:11 —— 用 UTC 归一会把刚发生的调用排除在窗口外，
// 看板显示的 `to` 比数据晚一天，而**没有任何报错**）。
//
// 唯一实现（两个管理端出口共用），不要在别处再算一遍日边界。
func dayStart(t time.Time) time.Time { return serverstore.LocalDay(t) }

// adminOpensSummary 是 `GET /api/server/admin/wasm-apps/opens/summary?days=&top=`（W5 C2）。
//
// 为什么把"列表列 + 看板"合成一个端点：两者要的是同一份数据（每个应用的窗口 PV/UV
// 与趋势），分成两个端点只会让页面打开时发两次几乎相同的重查询。
//
// 响应形状（**冻结 = 设计 §5.1c A**，跨端对拍用例逐键断言）：
//
//	{"from":"…","to":"…","days":7,"top":10,"capped":false,"detail_retention_days":90,
//	 "today":{day,pv,uv},"totals":{pv,uv},"trend":[{day,pv,uv}…],
//	 "apps":[{app_id,title,today_pv,today_uv,window_pv,window_uv}…],
//	 "top_apps":[{app_id,title,pv,uv}…]}
//
// 三个数组与 `today`/`totals` **恒在**（空就空数组/零值，绝不 null/省略 —— 与契约
// §5.1 同款纪律：前端对 null 与空数组的处理不同，省略会让"没有数据"与"字段改名了"
// 不可区分）。
//
// `uv` 是**窗口内按 user_id 去重**（不是逐日相加）：同一个人天天来只算 1；
// `totals.uv` 更必须是**不带 `GROUP BY app_id` 的一次聚合**（各应用 uv 相加会把
// "同一个人开了两个应用"重复计数，§5.1c A 明令禁止）。
// `days` 缺省 7、`top` 缺省 10（与 L6 已实现的前端取值一致）。
//
// `days` 与 `capped` 的关系（AUD-4，2026-09-20）：`days` 回显的是**生效窗口**（请求值
// 超过明细保留期 90 天时收敛后的值），`capped=true` 表示"你请求的窗口比明细保留期还长"
// —— 两者合起来才让调用方看得出"我要了 365 天、实际给了 90 天"，见 handler 里
// requestedDays 的注释。
func (h *Handlers) adminOpensSummary(c *gin.Context) {
	now := h.now()
	days := atoiDefault(c.Query("days"), opensSummaryDefaultDays)
	if days <= 0 {
		days = opensSummaryDefaultDays
	}
	// `days` 的**请求值**与**生效值**分开记（AUD-4，2026-09-20 独立对抗审计）。
	//
	// 现场：请求 days=365 时这里静默收敛到 90，而响应里的 `capped` 来自
	// `SummarizeWasmAppOpens` —— 库函数判的是"`from` 早于明细保留期"，可 `from` 在
	// 上面**已经被钳过**（from = now-(90-1)，恰好等于库内 maxStart）⇒ `capped` 恒 false，
	// 设计 §5.1c A 要求的"窗口长于保留期时如实回报"在**生产端点不可达**（只有库级判据
	// 能构造出 true）。调用方拿到的是"days=90 / capped=false"，与它请求的 365 天无从对照。
	//
	// 修法：端点自己知道"请求窗口是否长于保留期"，`capped` 取**两者或**（库级的
	// 早于保留期判定继续保留：它也覆盖"显式 from 早于保留期"的调用形态）。
	// `days` 仍回显**生效窗口**（= 被钳到多少），`detail_retention_days` 给出钳制上界，
	// 前端已按 `capped=true` 渲染"已收敛到保留期"的说明。
	requestedDays := days
	if days > serverstore.WasmAppOpensRetentionDays {
		days = serverstore.WasmAppOpensRetentionDays
	}
	top := atoiDefault(c.Query("top"), opensSummaryDefaultTop)
	if top <= 0 {
		top = opensSummaryDefaultTop
	}
	if top > opensSummaryMaxTop {
		top = opensSummaryMaxTop
	}
	from := now.AddDate(0, 0, -(days - 1))

	sum, err := serverstore.SummarizeWasmAppOpens(c.Request.Context(), h.opt.DB, from, now, now)
	if err != nil {
		writeErr(c, apperr.New(apperr.CodeInternal, "查询打开概览失败").
			WithHint("这是平台侧故障（数据库不可达）；请稍后重试"))
		return
	}
	if sum.Apps == nil {
		sum.Apps = []serverstore.WasmAppOpenSummaryRow{}
	}
	if sum.Trend == nil {
		sum.Trend = []serverstore.WasmOpenTrendPoint{}
	}
	// TOP N 从**已按窗口 PV 降序**的 apps 里取前 top 行（服务端已排好序；
	// 前端另有兜底排序与截断）。行形状按 §5.1c A：`{app_id,title,pv,uv}`。
	// 容量按**实际行数**取、上界用**平台常量**。2026-09-21（CodeQL #99
	// `go/uncontrolled-allocation-size`）：原来写的是 `capHint := top`（`top` 是请求参数），
	// 即使上面已经把它钳到 opensSummaryMaxTop=100，静态分析也看不到"已钳"这条事实 ——
	// 请求值一旦参与分配尺寸就会被判"依赖用户输入"。改成只由数据侧（`len(sum.Apps)`）
	// 与常量上界派生：容量与数据相关、且不多预留超过平台上限的空间（≤100 行）。
	capHint := len(sum.Apps)
	if capHint > opensSummaryMaxTop {
		capHint = opensSummaryMaxTop
	}
	topApps := make([]serverstore.WasmAppOpenTopRow, 0, capHint)
	for _, a := range sum.Apps {
		if len(topApps) >= top {
			break
		}
		topApps = append(topApps, serverstore.WasmAppOpenTopRow{
			AppID: a.AppID, Title: a.Title, PV: a.WindowPV, UV: a.WindowUV,
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"from": serverstore.LocalDayString(from),
		"to":   serverstore.LocalDayString(now),
		// `days` 是**生效窗口**（被钳到多少）：requestedDays 超过明细保留期时这里回显
		// 收敛后的值，配合 `capped=true` 与 `detail_retention_days` 让调用方看清
		// "我要了 N 天、实际给了 M 天"（AUD-4）。
		"days": days,
		"top":  top,
		// capped=true：请求的窗口比明细保留期还长（或显式 from 早于保留期），UV 只能按
		// 保留期算（如实说，不静默给一个偏小的数字）。
		//
		// ⚠️ 库函数的 Capped 只覆盖"from 早于保留期"那一种形态（显式 from 调用方）；
		// 本端点把 from 钳过之后再问库函数 ⇒ 必须在此处补上"请求值 > 生效值"这一半，
		// 否则设计 §5.1c A 的 capped=true 在生产端点**不可达**（AUD-4 的现场）。
		"capped": sum.Capped || requestedDays > days,
		// 明细保留期（§5.1c A）：前端据此标注"多久以前的明细已经不在"，
		// 并在 capped 时说明窗口为什么被收敛。
		"detail_retention_days": serverstore.WasmAppOpensRetentionDays,
		"today":                 sum.Today,
		"totals":                sum.Totals,
		"trend":                 sum.Trend,
		"apps":                  sum.Apps,
		"top_apps":              topApps,
	})
}

// 看板缺省值（与 L6 前端一致；改这里要同步前端）。
const (
	opensSummaryDefaultDays = 7
	opensSummaryDefaultTop  = 10
	opensSummaryMaxTop      = 100
)

// adminAppAIUsage 是 `GET /api/server/admin/wasm-apps/:app_id/ai-usage`（W5 C4）。
//
// 数据源 = §21.4 的 `usage.app_id` 维度（网关在 4 条计费路径上按**会话 id 的 `app:` 前缀**
// 派生：`internal/llmgateway/app_session_id.go`，出站头由上游按 `options.sessionId` 带上）。
// `attribution_available=false` 表示窗口内**平台还没有任何带归因的 usage 行** ⇒
// 前端显示"暂无归因数据"；为 true 而本应用全零才是"确实没调用过模型"（两者都是 0，
// 但含义相反，不得合并渲染）。
func (h *Handlers) adminAppAIUsage(c *gin.Context) {
	appID := strings.ToLower(strings.TrimSpace(c.Param("app_id")))
	if aerr := h.validateAppID(appID); aerr != nil {
		writeErr(c, aerr)
		return
	}
	now := h.now()
	// `days=` 是契约 §5.1c B 文档化的窗口形态（`?days=|from=&to=`）：只在**没有显式
	// `from`** 时生效 —— 显式区间永远优先（调用方拿着回显的 from/to 再请求时不能被
	// 一个残留的 days 覆盖）。缺省仍是近 7 天。
	//
	// 为什么要支持它：一个"文档里有、实现里被静默忽略"的参数，与 R2-L6-3 的
	// "静默窗口"是同一类缺陷（调用方以为窗口变了，数字其实没变）。
	defFrom := now.AddDate(0, 0, -6)
	if strings.TrimSpace(c.Query("from")) == "" {
		if days := atoiDefault(c.Query("days"), 0); days > 0 {
			defFrom = now.AddDate(0, 0, -(days - 1))
		}
	}
	from, aerr := parseDayParam(c.Query("from"), defFrom)
	if aerr != nil {
		writeErr(c, aerr.WithDetail("field", "from"))
		return
	}
	to, aerr := parseDayParam(c.Query("to"), now)
	if aerr != nil {
		writeErr(c, aerr.WithDetail("field", "to"))
		return
	}
	if to.Before(from) {
		writeErr(c, apperr.New(apperr.CodeValidation, "to 不能早于 from"))
		return
	}
	usage, err := serverstore.QueryWasmAppAIUsage(c.Request.Context(), h.opt.DB, appID, from, to)
	if err != nil {
		writeErr(c, apperr.New(apperr.CodeInternal, "查询应用 AI 用量失败").
			WithHint("这是平台侧故障（数据库不可达）；请稍后重试"))
		return
	}
	if usage.Days == nil {
		usage.Days = []serverstore.WasmAppAIUsageDay{}
	}
	c.JSON(http.StatusOK, usage)
}
