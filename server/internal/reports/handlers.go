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

func (r *subReq) validate() (string, string) {
	name := strings.TrimSpace(r.Name)
	url := strings.TrimSpace(r.HookURL)
	if name == "" {
		return "", "订阅名称必填"
	}
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		return "", "hook_url 必须是 http(s) URL"
	}
	return name, ""
}

func list(c *gin.Context, db *sql.DB) {
	subs, err := serverstore.ListReportSubscriptions(db)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"subscriptions": subs})
}

func create(c *gin.Context, db *sql.DB) {
	var req subReq
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return
	}
	name, msg := req.validate()
	if msg != "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", msg)
		return
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	id, err := serverstore.CreateReportSubscription(db, name, req.HookURL, enabled)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
		return
	}
	_ = serverstore.AuditLog(db, actorName(c), "report_subscription_create", name+" "+req.HookURL)
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
	name, msg := req.validate()
	if msg != "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", msg)
		return
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	if err := serverstore.UpdateReportSubscription(db, id, name, req.HookURL, enabled); err != nil {
		if err == serverstore.ErrNotFound {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "订阅不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
		return
	}
	_ = serverstore.AuditLog(db, actorName(c), "report_subscription_update", name+" "+req.HookURL)
	c.JSON(http.StatusOK, gin.H{"ok": true})
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
