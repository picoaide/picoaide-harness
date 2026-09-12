package reports

import (
	"context"
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// Handlers 报表订阅管理面 handler 集合(路由由 internal/router 集中声明)。
type Handlers struct {
	List     gin.HandlerFunc // GET /report-subscriptions
	Create   gin.HandlerFunc // POST /report-subscriptions
	Update   gin.HandlerFunc // PUT /report-subscriptions/:id
	Delete   gin.HandlerFunc // DELETE /report-subscriptions/:id
	TestPush gin.HandlerFunc // POST /report-subscriptions/:id/test(生成上月报表并推送)
	// NowFn 报表周期基准(测试注入)。
	NowFn func() time.Time
}

// NewHandlers 构造订阅管理 handlers。
func NewHandlers(db *sql.DB) *Handlers {
	return &Handlers{
		List:     func(c *gin.Context) { list(c, db) },
		Create:   func(c *gin.Context) { create(c, db) },
		Update:   func(c *gin.Context) { update(c, db) },
		Delete:   func(c *gin.Context) { remove(c, db) },
		TestPush: func(c *gin.Context) { testPush(c, db) },
		NowFn:    time.Now,
	}
}

type subReq struct {
	Name    string `json:"name"`
	HookURL string `json:"hook_url"`
	Enabled *bool  `json:"enabled"`
}

// validate 校验并**返回归一化后的值**(审计 2026-09-12 P1-5)。
//
// 旧实现 trim 后只用于校验、落库仍写 req.HookURL 原文:提交
// `" https://x "` 会 201/200 成功,但 PushWebhook 用同一份原文
// http.NewRequest ⇒ `parse " https://… ": first path segment in URL cannot
// contain colon` ⇒ 订阅永久发不出去(且失败也写 last_run_at,当月不再重试)。
// 现在校验与落库共用同一个归一化值。
func (r *subReq) validate() (name, hookURL, msg string) {
	name = strings.TrimSpace(r.Name)
	hookURL = strings.TrimSpace(r.HookURL)
	if name == "" {
		return "", "", "订阅名称必填"
	}
	if !strings.HasPrefix(hookURL, "http://") && !strings.HasPrefix(hookURL, "https://") {
		return "", "", "hook_url 必须是 http(s) URL"
	}
	// P2-19: SSRF——拒绝回环/私网/链路本地目标(解析结果逐 IP 校验)。
	if err := validateHookURL(hookURL); err != nil {
		return "", "", "hook_url 不合法: " + err.Error()
	}
	return name, hookURL, ""
}

// auditDetail 审计 detail 只写订阅标识(name/id),不写 hook_url。
// 审计 2026-09-12 P1-4:hook_url 是凭据本体,而 audit_logs 默认保留 180 天
// 且经 /api/server/admin/audit(audit:read,auditor 也持有)下发——
// 原样落 URL 等于给只读角色开了一条绕过列表脱敏的读回信道。
func auditDetail(name string, id int64) string {
	return name + " (id=" + strconv.FormatInt(id, 10) + ")"
}

func list(c *gin.Context, db *sql.DB) {
	subs, err := serverstore.ListReportSubscriptions(db)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	// hook_url 由 ReportSubscription.MarshalJSON 统一脱敏(见 serverstore/reports.go)。
	c.JSON(http.StatusOK, gin.H{"subscriptions": subs})
}

func create(c *gin.Context, db *sql.DB) {
	var req subReq
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return
	}
	name, hookURL, msg := req.validate()
	if msg != "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", msg)
		return
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	id, err := serverstore.CreateReportSubscription(db, name, hookURL, enabled)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
		return
	}
	_ = serverstore.AuditLog(db, actorName(c), "report_subscription_create", auditDetail(name, id))
	c.JSON(http.StatusCreated, gin.H{"id": id})
}

func update(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	var req subReq
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return
	}
	// hook_url 留空(或回传哨兵 "***")= 保持现值:列表已不再回显明文,
	// 管理端编辑弹窗也不预填(与 /auth 配置的密钥同一约定)。
	name, hookURL, msg := req.validateUpdate()
	if msg != "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", msg)
		return
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	if err := serverstore.UpdateReportSubscription(db, id, name, hookURL, enabled); err != nil {
		if err == serverstore.ErrNotFound {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "订阅不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
		return
	}
	_ = serverstore.AuditLog(db, actorName(c), "report_subscription_update", auditDetail(name, id))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// validateUpdate 是更新路径的校验:name 必填;hook_url 可空(= 保持现值),
// 非空时必须通过与新建同一套校验(且返回归一化值)。
func (r *subReq) validateUpdate() (name, hookURL, msg string) {
	name = strings.TrimSpace(r.Name)
	if name == "" {
		return "", "", "订阅名称必填"
	}
	raw := strings.TrimSpace(r.HookURL)
	if raw == "" || raw == serverstore.MaskedHookURL {
		return name, "", ""
	}
	r.HookURL = raw
	return r.validate()
}

func remove(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	if err := serverstore.DeleteReportSubscription(db, id); err != nil {
		if err == serverstore.ErrNotFound {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "订阅不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
		return
	}
	_ = serverstore.AuditLog(db, actorName(c), "report_subscription_delete", strconv.FormatInt(id, 10))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// testPush 生成上月报表并推送到该订阅地址(不落 last_run_at,便于反复测试)。
func testPush(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	subs, err := serverstore.ListReportSubscriptions(db)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	var target *serverstore.ReportSubscription
	for i := range subs {
		if subs[i].ID == id {
			target = &subs[i]
			break
		}
	}
	if target == nil {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "订阅不存在")
		return
	}
	body, err := GenerateMonthlyReport(db, time.Now())
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "报表生成失败: "+err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), PushTimeout)
	defer cancel()
	if err := PushWebhook(ctx, target.HookURL, body); err != nil {
		serverauth.WriteError(c, http.StatusBadGateway, "UPSTREAM", "推送失败: "+err.Error())
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "period": body.Period})
}

// actorName 管理会话用户名(AdminAuth 已注入;防御性兜底)。
func actorName(c *gin.Context) string {
	if u := serverauth.AdminUser(c); u != nil {
		return u.Username
	}
	return ""
}
