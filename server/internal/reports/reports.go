// Package reports 月度用量报表:生成上月汇总(费用/请求/模型 TOP/用户 TOP/部门汇总),
// 按订阅推送到企业 webhook,并在每月(或停机补跑)自动触发。2026-09 P1。
package reports

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ReportBody 月度报表 JSON 结构(推送/测试共用)。
type ReportBody struct {
	Type        string                          `json:"type"` // monthly_usage_report
	Period      string                          `json:"period"`
	GeneratedAt string                          `json:"generated_at"`
	Total       ReportTotal                     `json:"total"`
	TopModels   []serverstore.UsageAggregateRow `json:"top_models"`
	TopUsers    []serverstore.UsageAggregateRow `json:"top_users"`
	Departments []serverstore.UsageAggregateRow `json:"departments"`
}

// ReportTotal 总计口径(tokens 为 chat 输入+输出,不含 embedding)。
type ReportTotal struct {
	Cost     float64 `json:"cost"`
	Requests int64   `json:"requests"`
	Tokens   int64   `json:"tokens"`
}

const (
	// TypeMonthly 报表类型标识。
	TypeMonthly = "monthly_usage_report"
	// PushTimeout 推送超时。
	PushTimeout = 10 * time.Second
)

// pushClient 推送 HTTP 客户端(测试可替换)。
var pushClient = &http.Client{Timeout: PushTimeout}

// GenerateMonthlyReport 生成上一个月(month 为任意时刻,取其上月)的用量汇总。
// 口径与用量中心一致:费用=按模型定价折算(含 embedding),部门=当前归属树内合计。
func GenerateMonthlyReport(db *sql.DB, month time.Time) (*ReportBody, error) {
	start := time.Date(month.Year(), month.Month(), 1, 0, 0, 0, 0, month.Location())
	prev := start.AddDate(0, -1, 0)
	from := prev
	// 聚合层 to 语义为"截止日含当天"(内部 +1 天);报表需要严格的上月闭区间:
	// to = 本月 1 日前一天。
	to := start.AddDate(0, 0, -1)

	trend, err := serverstore.UsageAggregateWithLedger(db, from, to, "day")
	if err != nil {
		return nil, fmt.Errorf("aggregate trend: %w", err)
	}
	models, err := serverstore.UsageAggregateWithLedger(db, from, to, "model")
	if err != nil {
		return nil, fmt.Errorf("aggregate models: %w", err)
	}
	users, err := serverstore.UsageAggregateWithLedger(db, from, to, "user")
	if err != nil {
		return nil, fmt.Errorf("aggregate users: %w", err)
	}
	depts, err := serverstore.UsageAggregateWithLedger(db, from, to, "dept")
	if err != nil {
		return nil, fmt.Errorf("aggregate depts: %w", err)
	}

	body := &ReportBody{
		Type:        TypeMonthly,
		Period:      prev.Format("2006-01"),
		GeneratedAt: time.Now().Format(time.RFC3339),
		TopModels:   topByCost(models, 10),
		TopUsers:    topByCost(users, 10),
		Departments: topByCost(depts, 20),
	}
	for _, r := range trend {
		body.Total.Cost += r.Cost
		body.Total.Requests += r.Requests
		body.Total.Tokens += r.PromptTokens + r.CompletionTokens - r.EmbedTokens
	}
	return body, nil
}

// topByCost 费用降序取前 n。
func topByCost(rows []serverstore.UsageAggregateRow, n int) []serverstore.UsageAggregateRow {
	sorted := append([]serverstore.UsageAggregateRow{}, rows...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Cost > sorted[j].Cost })
	if len(sorted) > n {
		sorted = sorted[:n]
	}
	return sorted
}

// PushWebhook 推送报表到订阅地址(非 2xx = 错误)。
func PushWebhook(ctx context.Context, hookURL string, body *ReportBody) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, hookURL, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := pushClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("webhook status %d", resp.StatusCode)
	}
	return nil
}

// DispatchAll 生成报表并推送给全部启用的订阅;返回 成功/失败 计数。
func DispatchAll(ctx context.Context, db *sql.DB, month time.Time) (ok, failed int, err error) {
	body, err := GenerateMonthlyReport(db, month)
	if err != nil {
		return 0, 0, err
	}
	list, err := serverstore.ListReportSubscriptions(db)
	if err != nil {
		return 0, 0, err
	}
	for _, sub := range list {
		if !sub.Enabled {
			continue
		}
		if err := PushWebhook(ctx, sub.HookURL, body); err != nil {
			failed++
			_ = serverstore.MarkReportRun(db, sub.ID, false, err.Error())
			continue
		}
		ok++
		_ = serverstore.MarkReportRun(db, sub.ID, true, "")
	}
	return ok, failed, nil
}

// ShouldRunMonthly 判断是否应补跑上月报表:
// lastRunAt 为空,或 lastRunAt 所在月份早于 now 所在月份(停机跨月/新部署补跑)。
// 幂等:同一月份只会跑一次(成功或失败都记 last_run_at/last_error;失败下月再试)。
func ShouldRunMonthly(now time.Time, lastRunAt *time.Time) bool {
	if lastRunAt == nil {
		return true
	}
	return lastRunAt.Year() < now.Year() || (lastRunAt.Year() == now.Year() && lastRunAt.Month() < now.Month())
}
