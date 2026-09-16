package llmgateway

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// 客户端错误上报状态聚合(2026-09-16,GlitchTip 收集为空缺陷 R2)。
//
// GET /api/server/admin/gateway/error-reporting/clients 是 webadmin"错误上报"
// 页的数据源:把客户端上报的状态(0068,按用户一行)聚合成
//   五个状态计数 + total + last_report_at + items(最多 100 条,最近在前)。
//
// 空数据语义(必须守住):没有任何客户端上报过时,total=0、last_report_at 为空
// —— 管理端据此渲染"还没有任何客户端上报",**不得**渲染成"一切正常"
// (空数据 ≠ 全员 ready;把"没数据"显示成绿灯正是这次要修的缺陷)。
// ---------------------------------------------------------------------------

// errorReportingClientsLimit 列表上限(与 serverstore.ListErrorReportingStatuses
// 的收敛区间同口径:1..100)。
const errorReportingClientsLimit = 100

// errorReportingClients 聚合客户端错误上报状态。
// DB 错误一律 INTERNAL 信封(AGENTS.md §7.1),不透出 SQL 细节。
func errorReportingClients(c *gin.Context, db *sql.DB) {
	items, err := serverstore.ListErrorReportingStatuses(db, errorReportingClientsLimit)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	counts, err := serverstore.CountErrorReportingStatuses(db)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	type statusItem struct {
		Username  string `json:"username"`
		State     string `json:"state"`
		Reason    string `json:"reason"`
		DSNHost   string `json:"dsn_host"`
		Level     string `json:"level"`
		Release   string `json:"release"`
		UpdatedAt string `json:"updated_at"`
	}
	out := make([]statusItem, 0, len(items))
	lastReportAt := ""
	for i, it := range items {
		// items 按 updated_at DESC 排序 ⇒ 第一条即全表最新上报时刻(不额外
		// 查一次 MAX(updated_at))。
		if i == 0 {
			lastReportAt = it.UpdatedAt.UTC().Format(time.RFC3339)
		}
		out = append(out, statusItem{
			Username:  it.Username,
			State:     it.State,
			Reason:    it.Reason,
			DSNHost:   it.DSNHost,
			Level:     it.Level,
			Release:   it.Release,
			UpdatedAt: it.UpdatedAt.UTC().Format(time.RFC3339),
		})
	}
	// total = 全表行数(= 各状态计数之和),不是 len(items):items 上限 100,
	// total 必须反映真实规模。
	total := 0
	for _, n := range counts {
		total += n
	}
	c.JSON(http.StatusOK, gin.H{
		"ready":              counts[serverstore.ErrorReportingStateReady],
		"disabled":           counts[serverstore.ErrorReportingStateDisabled],
		"failed":             counts[serverstore.ErrorReportingStateFailed],
		"config_unavailable": counts[serverstore.ErrorReportingStateConfigUnavailable],
		"idle":               counts[serverstore.ErrorReportingStateIdle],
		"last_report_at":     lastReportAt,
		"total":              total,
		"items":              out,
	})
}
