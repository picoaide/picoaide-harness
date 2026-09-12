package serverauth

import (
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// 用量中心(2026-09 重构, 设计 docs/decisions/2026-09-02-usage-center-redesign.md):
// 管理面新增 总览(overview)/请求明细(requests) 两个端点;usage 聚合扩展
// group=dept|provider 与 dept 过滤。全部经 router.Register 集中声明
// (PermUsageRead)。
// ---------------------------------------------------------------------------

const (
	// usageDefaultWindowDays 定义于 admin.go(用量聚合缺省窗口)。
	// usageRequestsMaxWindowDays 请求明细最长查询窗口(天)。
	usageRequestsMaxWindowDays = 90
)

// usageDateRange 解析并校验 from/to(YYYY-MM-DD),失败时已写响应,返回 ok=false。
// 缺省窗口 = 近 usageDefaultWindowDays 天(与 usage() 原逻辑一致)。
// 返回值是**北京日期值**(from/to 均归一到北京日,见 serverstore.BeijingDay):
// 旧实现用 time.Now()/now.Location() 取"本机日期",UTC 容器下(北京 00:00-08:00)
// 「今天」会指向前一天 → 聚合查空(2026-09-10 CI 实测)。
func usageDateRange(c *gin.Context) (from, to time.Time, ok bool) {
	fromRaw := c.DefaultQuery("from", "")
	toRaw := c.DefaultQuery("to", "")
	var err error
	if fromRaw != "" {
		if from, err = time.Parse("2006-01-02", fromRaw); err != nil {
			writeError(c, http.StatusBadRequest, "VALIDATION", "from 日期格式错误(YYYY-MM-DD)")
			return from, to, false
		}
	}
	if toRaw != "" {
		if to, err = time.Parse("2006-01-02", toRaw); err != nil {
			writeError(c, http.StatusBadRequest, "VALIDATION", "to 日期格式错误(YYYY-MM-DD)")
			return from, to, false
		}
	}
	if !from.IsZero() && !to.IsZero() && from.After(to) {
		writeError(c, http.StatusBadRequest, "VALIDATION", "起始日期不能晚于结束日期")
		return from, to, false
	}
	if from.IsZero() && to.IsZero() {
		to = serverstore.BeijingNow()
		from = to.AddDate(0, 0, -usageDefaultWindowDays+1)
	} else if from.IsZero() {
		from = serverstore.BeijingDay(to).AddDate(0, 0, -usageDefaultWindowDays+1)
	} else if to.IsZero() {
		to = serverstore.BeijingDay(from).AddDate(0, 0, usageDefaultWindowDays-1)
	}
	return from, to, true
}

// usageOverview 总览页一次聚合(2026-09 用量中心):
// 区间趋势(day)+ 区间 TOP 模型(≤10)+ 本月/今日汇总 + 区间汇总。
// 请求数/平均成本由区间汇总推导。
func (a *AdminAPI) usageOverview(c *gin.Context) {
	from, to, ok := usageDateRange(c)
	if !ok {
		return
	}
	rangeRows, err := serverstore.UsageAggregateWithLedger(a.DB, from, to, "day")
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "统计失败")
		return
	}
	modelRows, err := serverstore.UsageAggregateWithLedger(a.DB, from, to, "model")
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "统计失败")
		return
	}
	top := make([]serverstore.UsageAggregateRow, 0, len(modelRows))
	top = append(top, modelRows...)
	sort.Slice(top, func(i, j int) bool { return top[i].Cost > top[j].Cost })
	if len(top) > 10 {
		top = top[:10]
	}

	// 本月/今日窗口走北京日/月口径(唯一真源);旧实现用 now.Location()
	// 取"本机日期",UTC 容器下会与北京日相差 8 小时。
	now := serverstore.BeijingNow()
	monthFrom := serverstore.BeijingMonth(now)
	monthRows, err := serverstore.UsageAggregateWithLedger(a.DB, monthFrom, now, "day")
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "统计失败")
		return
	}
	todayRows, err := serverstore.UsageAggregateWithLedger(a.DB, now, now, "day")
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "统计失败")
		return
	}
	sum := func(rows []serverstore.UsageAggregateRow) gin.H {
		var cost, tokens float64
		var requests int64
		for _, r := range rows {
			cost += r.Cost
			tokens += float64(r.PromptTokens + r.CompletionTokens)
			requests += r.Requests
		}
		return gin.H{"cost": cost, "tokens": tokens, "requests": requests}
	}
	c.JSON(http.StatusOK, gin.H{
		"range":      sum(rangeRows),
		"month":      sum(monthRows),
		"today":      sum(todayRows),
		"trend":      rangeRows,
		"top_models": top,
	})
}

// usageRequests 请求级明细分页(2026-09 用量中心 ⑤ 请求日志页)。
// 参数:page,size(默认20,≤100),from,to(默认近7天;窗口>90 天拒绝),
// username,model,kind(chat|embedding|search)。to 按当天全天包含(闭区间日界)。
func (a *AdminAPI) usageRequests(c *gin.Context) {
	from, to, ok := usageDateRange(c)
	if !ok {
		return
	}
	// to 为日期(00:00)→ 扩展为次日 00:00,使截止日当天包含(与聚合口径一致)
	toEx := to.AddDate(0, 0, 1)
	if from.AddDate(0, 0, usageRequestsMaxWindowDays).Before(toEx) {
		writeError(c, http.StatusBadRequest, "VALIDATION", "查询窗口最长 90 天")
		return
	}
	kind := c.Query("kind")
	if kind != "" && !serverstore.UsageRequestKind[kind] {
		writeError(c, http.StatusBadRequest, "VALIDATION", "kind 必须是 chat|embedding|search")
		return
	}
	// 审计 2026-09-12:改用 paginate(与其它管理面分页端点同口径)。
	// 注意 serverstore.ListUsageRequests 的契约是 offset = (page-1)*size,
	// 这里传钳制后的 page/size(该 DAO 内部自行算 offset)。
	page, size, _ := paginate(c, 20, 100)
	rows, total, err := serverstore.ListUsageRequests(a.DB, from, toEx,
		c.Query("username"), c.Query("model"), kind, page, size)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"rows": rows, "total": total, "page": page, "size": size, "kind": kind})
}
