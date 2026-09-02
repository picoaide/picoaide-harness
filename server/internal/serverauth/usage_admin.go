package serverauth

import (
	"net/http"
	"sort"
	"strconv"
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
// 缺省窗口 = 近 useDefaultWindowDays 天(与 usage() 原逻辑一致)。
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
		to = time.Now()
		from = to.AddDate(0, 0, -usageDefaultWindowDays+1)
	} else if from.IsZero() {
		from = to.AddDate(0, 0, -usageDefaultWindowDays+1)
	} else if to.IsZero() {
		to = from.AddDate(0, 0, usageDefaultWindowDays-1)
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

	now := time.Now()
	monthFrom := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	monthRows, err := serverstore.UsageAggregateWithLedger(a.DB, monthFrom, now, "day")
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "统计失败")
		return
	}
	todayFrom := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	todayRows, err := serverstore.UsageAggregateWithLedger(a.DB, todayFrom, now, "day")
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
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))
	if page < 1 {
		page = 1
	}
	if size < 1 {
		size = 20
	}
	if size > 100 {
		size = 100
	}
	rows, total, err := serverstore.ListUsageRequests(a.DB, from, toEx,
		c.Query("username"), c.Query("model"), kind, page, size)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"rows": rows, "total": total, "page": page, "size": size, "kind": kind})
}
