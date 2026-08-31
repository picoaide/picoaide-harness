package llmgateway

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// concurrencyResponse 是 GET /api/server/admin/concurrency 响应。
type concurrencyResponse struct {
	// CheckedAt 采样时刻(UTC RFC3339)。
	CheckedAt string `json:"checked_at"`
	// Models 各模型并发状态(按 90 天峰值降序),仅含数据库或配置中的模型。
	Models []modelConcurrency `json:"models"`
}

type modelConcurrency struct {
	Model    string `json:"model"`              // 模型名(内部)
	Current  int64  `json:"current"`            // 当前 in-flight(实时快照)
	Peak90   int64  `json:"peak_90d"`           // 90 天历史峰值
	PeakDay  string `json:"peak_day,omitempty"` // 峰值所在日(UTC)
	Target   int64  `json:"target"`             // 目标并发(default_params.concurrency_target;0=未配置)
	Provider string `json:"provider,omitempty"` // 网关渠道(诊断)
}

// concurrencyTargetFromParams 从模型 default_params JSON 提取 concurrency_target。
func concurrencyTargetFromParams(params string) int64 {
	if params == "" {
		return 0
	}
	var p struct {
		ConcurrencyTarget int64 `json:"concurrency_target"`
	}
	if err := json.Unmarshal([]byte(params), &p); err != nil {
		return 0
	}
	if p.ConcurrencyTarget < 0 {
		return 0
	}
	return p.ConcurrencyTarget
}

// concurrencyStatus 组装当前并发快照 + 90 天历史峰值 + 模型目标。
// 数据来源:
//   - Current: 内存 meter(精确,实时;请求发起后 +1、结束 -1)
//   - Peak90: DB model_concurrency_stats(15s 采样,GREATEST 累计)
//   - Target: models.default_params 内 concurrency_target(管理员配置,
//     如 deepseek-v4-flash=2500 / deepseek-v4-pro=500)
func concurrencyStatus(c *gin.Context, db *sql.DB, meter *concurrencyMeter) {
	snap := map[string]int64{}
	if meter != nil {
		snap = meter.snapshot()
	}
	// 90 天历史峰值
	peaksByModel := map[string]int64{}
	modelInfo := map[string]struct {
		target   int64
		provider string
	}{}
	if db != nil {
		if peaks, err := serverstore.PeakConcurrencyByModel(db, time.Now().AddDate(0, 0, -90)); err == nil {
			peaksByModel = peaks
		}
		if models, err := serverstore.ListAdminModels(db); err == nil {
			for _, m := range models {
				modelInfo[m.Name] = struct {
					target   int64
					provider string
				}{concurrencyTargetFromParams(m.DefaultParams), m.ProviderName}
			}
		}
	}

	// 合并:所有出现过的模型(快照 / 峰值 / 配置)都展示;按 90 天峰值降序。
	type row struct {
		model string
		cur   int64
		peak  int64
		tgt   int64
		prov  string
	}
	seen := map[string]bool{}
	var rows []row
	for m, n := range snap {
		seen[m] = true
		info := modelInfo[m]
		rows = append(rows, row{m, n, peaksByModel[m], info.target, info.provider})
	}
	for m, p := range peaksByModel {
		if seen[m] {
			continue
		}
		info := modelInfo[m]
		seen[m] = true
		rows = append(rows, row{m, 0, p, info.target, info.provider})
	}
	for m, info := range modelInfo {
		if seen[m] {
			continue
		}
		rows = append(rows, row{m, 0, peaksByModel[m], info.target, info.provider})
	}
	// 排序:峰值降序,其次当前并发降序,最后模型名
	for i := 0; i < len(rows); i++ {
		for j := i + 1; j < len(rows); j++ {
			a, b := rows[i], rows[j]
			if b.peak > a.peak || (b.peak == a.peak && b.cur > a.cur) || (b.peak == a.peak && b.cur == a.cur && b.model < a.model) {
				rows[i], rows[j] = rows[j], rows[i]
			}
		}
	}

	out := concurrencyResponse{CheckedAt: time.Now().UTC().Format(time.RFC3339), Models: []modelConcurrency{}}
	for _, r := range rows {
		out.Models = append(out.Models, modelConcurrency{
			Model:    r.model,
			Current:  r.cur,
			Peak90:   r.peak,
			Target:   r.tgt,
			Provider: r.prov,
		})
	}
	c.JSON(http.StatusOK, out)
}
