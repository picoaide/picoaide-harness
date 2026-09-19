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
// 响应形状（**冻结**，W5 C2 的判据）：
//
//	{"from":"…","to":"…","days":7,"top":10,"capped":false,
//	 "trend":[{day,pv,uv}…],"apps":[{app_id,pv,uv,today_pv,today_uv}…],"top_apps":[…]}
//
// 三个数组**恒在**（空就空数组，绝不 null/省略 —— 与契约 §5.1 同款纪律：前端对
// null 与空数组的处理不同，省略会让"没有数据"与"字段改名了"不可区分）。
//
// `uv` 是**窗口内按 user_id 去重**（不是逐日相加）：同一个人天天来只算 1。
// `days` 缺省 7、`top` 缺省 10（与 L6 已实现的前端取值一致）。
func (h *Handlers) adminOpensSummary(c *gin.Context) {
	now := h.now()
	days := atoiDefault(c.Query("days"), opensSummaryDefaultDays)
	if days <= 0 {
		days = opensSummaryDefaultDays
	}
	if days > serverstore.WasmAppOpensRetentionDays {
		// 超过明细保留期就没有"窗口去重 UV"可算了 ⇒ 收敛并如实回报 capped。
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

	apps, trend, capped, err := serverstore.SummarizeWasmAppOpens(c.Request.Context(), h.opt.DB, from, now, now)
	if err != nil {
		writeErr(c, apperr.New(apperr.CodeInternal, "查询打开概览失败").
			WithHint("这是平台侧故障（数据库不可达）；请稍后重试"))
		return
	}
	if apps == nil {
		apps = []serverstore.WasmAppOpenSummaryRow{}
	}
	if trend == nil {
		trend = []serverstore.WasmOpenTrendPoint{}
	}
	topApps := apps
	if len(topApps) > top {
		topApps = topApps[:top]
	}
	c.JSON(http.StatusOK, gin.H{
		"from": serverstore.LocalDayString(from),
		"to":   serverstore.LocalDayString(now),
		"days": days,
		"top":  top,
		// capped=true：请求的窗口比明细保留期还长，UV 只能按保留期算（如实说，
		// 不静默给一个偏小的数字）。
		"capped":   capped,
		"trend":    trend,
		"apps":     apps,
		"top_apps": topApps,
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
// 数据源 = §21.4 的 `usage.app_id` 维度（网关在 4 条计费路径上写 `X-Pico-App-Id`）。
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
