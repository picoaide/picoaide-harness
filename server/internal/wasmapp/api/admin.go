package api

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/registry"
	"github.com/picoaide/picoaide/internal/wasmapp/session"
)

// 本文件是 §8 的**管理面**（R23"最小运维面"）：应用列表 / 下架 / 转移归属 / 冻结
// / 审核开关。
//
// 三条边界（R23 说"最小"，不是"再来一套后台"）：
//   - 只做"处置"动作，不做内容审批流（R17 的开关只是一个布尔，审批本身没有人类队列：
//     §12 认账"无人类运营后台"，因此开启审核后新版本停在 pending，由管理员按需处置）；
//   - 权限点复用既有粗粒度点（capability:read / capability:write），不造实例级权限点（§13）；
//   - 归属转移与冻结都**写审计**，动作名与客户端面同一套（同一个动作只有一个名字）。

// AdminList 列出 wasm 应用 + 当前的审核开关状态。
func (h *Handlers) adminList(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	includeDeleted := c.Query("include_deleted") == "1" || strings.EqualFold(c.Query("include_deleted"), "true")
	filter := serverstore.WasmAppFilter{IncludeDeleted: includeDeleted}
	if owner := strings.TrimSpace(c.Query("owner")); owner != "" {
		filter.Owner = owner
	}
	limit := atoiDefault(c.Query("limit"), 200)
	apps, err := serverstore.ListWasmApps(c.Request.Context(), h.opt.DB, filter)
	if err != nil {
		writeErr(c, internalErr("查询失败", err))
		return
	}
	// 当前版本号：apps 行上只有 current_release_id，批量取一次（管理面列表要显示
	// 「当前版本」，没有它这一页只能显示一个内部 id）。取不到不算错 —— 版本行可能
	// 已被保留策略回收，列表里显示空串即可。
	ids := make([]int64, 0, len(apps))
	for _, a := range apps {
		if a.CurrentReleaseID > 0 {
			ids = append(ids, a.CurrentReleaseID)
		}
	}
	versions, verr := serverstore.WasmAppCurrentVersions(c.Request.Context(), h.opt.DB, ids)
	if verr != nil {
		writeErr(c, internalErr("查询版本失败", verr))
		return
	}
	out := make([]gin.H, 0, len(apps))
	for _, a := range apps {
		if limit > 0 && len(out) >= limit {
			break
		}
		out = append(out, gin.H{
			"current_version": versions[a.CurrentReleaseID],
			"app_id":          a.AppID,
			"title":           a.Title,
			"description":     a.Description,
			"owner":           a.Owner,
			"enabled":         a.Enabled,
			// access 从 config_json 现解（0071 起没有 visible 投影列）：
			// 管理面要能一眼看出访问级别，解析失败回落 login。
			"access":             string(appcfg.AccessOfConfigJSON(a.ConfigJSON)),
			"purpose":            a.Purpose,
			"data_sensitivity":   a.DataSensitivity,
			"current_release_id": a.CurrentReleaseID,
			"frozen_at":          a.FrozenAt,
			"deleted_at":         a.DeletedAt,
			"created_at":         a.CreatedAt,
			"updated_at":         a.UpdatedAt,
		})
	}
	// 审核开关随列表一起下发：webadmin 的应用页要能直接渲染它（R17），
	// 而不是再开一个只读端点。
	c.JSON(http.StatusOK, gin.H{
		"apps":            out,
		"review_required": h.reviewRequired(),
		"setting_key":     SettingReviewRequired,
	})
}

// AdminUnpublish 管理员下架（R23：管理员可处置任意应用）。
func (h *Handlers) adminUnpublish(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	admin := serverauth.AdminUser(c)
	if admin == nil {
		writeErr(c, apperr.New(apperr.CodeAuthRequired, "未登录"))
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, aerr := h.adminApp(c, appID)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	if !app.Enabled {
		c.JSON(http.StatusOK, gin.H{"app": gin.H{"app_id": appID, "enabled": false, "changed": false}})
		return
	}
	if err := serverstore.SetWasmAppEnabled(c.Request.Context(), h.opt.DB, appID, false); err != nil {
		writeErr(c, internalErr("下架失败", err))
		return
	}
	h.auditApp(appID, admin.Username, "wasm_app_publish_toggle",
		auditDetail(appID, app.Title, "enabled true → false（管理员下架）"))
	c.JSON(http.StatusOK, gin.H{"app": gin.H{"app_id": appID, "enabled": false, "changed": true}})
}

// SettingAppsBaseDomain 是应用基域的设置键（管理端可改；未设置时回落环境变量）。
//
// 为什么要有它（2026-09-18 用户要求）：「应用名 + 泛域名 = 应用访问地址」这件事必须
// 能在管理端配置 —— 原来只有部署期环境变量，改一次要重部署。落库之后由装配侧注入的
// ApplyBaseDomain 负责校验/生效，本包只做"读写 + 审计"。
const SettingAppsBaseDomain = "wasm.apps_base_domain"

// baseDomainView 是控制台要的完整视图（GET 与 PUT 返回同一形状）。
func (h *Handlers) baseDomainView() gin.H {
	value := ""
	if h.opt.BaseDomain != nil {
		value = h.opt.BaseDomain()
	}
	source := "none"
	if h.opt.BaseDomainSource != nil {
		source = h.opt.BaseDomainSource()
	}
	scheme, host := session.ParseBaseDomain(value)
	view := gin.H{
		"base_domain": value,
		"source":      source,
		"enabled":     host != "",
		"setting_key": SettingAppsBaseDomain,
		// 控制台直接把它渲染成示例：把 `<app_id>` 换成真实应用名就是访问地址。
		"url_pattern": "",
	}
	if host != "" {
		view["url_pattern"] = scheme + "://<app_id>." + host
	}
	return view
}

// AdminBaseDomainGet 读当前应用基域配置（控制台渲染 + 保存后回读）。
func (h *Handlers) adminBaseDomainGet(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	c.JSON(http.StatusOK, h.baseDomainView())
}

// AdminBaseDomainPut 保存应用基域（空串 = 关闭应用子域）。
//
// 校验/自检/落库/生效全部在注入的 ApplyBaseDomain 里完成（那些知识住在装配侧：
// 启用子域要过 R35 可信代理与内存四笔账两条 fail-closed）。本函数只负责：
// 解析 body → 调它 → 写审计 → 回读视图。**失败一定原样回错误信封**（含 hints），
// 控制台据此提示"还差什么条件"，而不是给一句"保存失败"。
func (h *Handlers) adminBaseDomainPut(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	admin := serverauth.AdminUser(c)
	if admin == nil {
		writeErr(c, apperr.New(apperr.CodeAuthRequired, "未登录"))
		return
	}
	if h.opt.ApplyBaseDomain == nil {
		writeErr(c, apperr.New(apperr.CodeInternal, "应用基域不可配置（装配未注入）").
			WithHint("服务端未提供基域保存钩子：请升级服务端或检查部署装配"))
		return
	}
	var req struct {
		BaseDomain *string `json:"base_domain"`
	}
	if berr := bindAdminJSON(c, &req); berr != nil {
		writeErr(c, berr)
		return
	}
	if req.BaseDomain == nil {
		writeErr(c, apperr.New(apperr.CodeValidation, "缺少 base_domain").
			WithDetail("field", "base_domain").
			WithHint("body 形如 {\"base_domain\":\"apps.example.com\"}；传空串表示关闭应用子域"))
		return
	}
	old := ""
	if h.opt.BaseDomain != nil {
		old = h.opt.BaseDomain()
	}
	next := strings.TrimSpace(*req.BaseDomain)
	if err := h.opt.ApplyBaseDomain(next); err != nil {
		writeErr(c, err)
		return
	}
	if next != old {
		h.auditOrg(admin.Username, "wasm_apps_base_domain_change",
			fmt.Sprintf("应用基域 %q → %q（员工自建应用的访问域名）", old, next))
	}
	c.JSON(http.StatusOK, h.baseDomainView())
}

// AdminPublish 管理员上架（R23：管理员可处置任意应用）。
//
// 与 AdminUnpublish **严格对称**：同一权限点（capability:write）、同一审计动作名
// （wasm_app_publish_toggle，只靠明细里的方向区分）、同样的幂等语义
// （已是上架状态 ⇒ changed:false，不写审计）。
//
// 为什么管理面必须有上架：下架是管理员的处置动作，处置完要能恢复；只给下架
// 等于让管理员把应用"关掉就再也打不开"（客户端面的上架只有发布者能调）。
func (h *Handlers) adminPublish(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	admin := serverauth.AdminUser(c)
	if admin == nil {
		writeErr(c, apperr.New(apperr.CodeAuthRequired, "未登录"))
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, aerr := h.adminApp(c, appID)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	if app.Enabled {
		c.JSON(http.StatusOK, gin.H{"app": gin.H{"app_id": appID, "enabled": true, "changed": false}})
		return
	}
	if err := serverstore.SetWasmAppEnabled(c.Request.Context(), h.opt.DB, appID, true); err != nil {
		writeErr(c, internalErr("上架失败", err))
		return
	}
	h.auditApp(appID, admin.Username, "wasm_app_publish_toggle",
		auditDetail(appID, app.Title, "enabled false → true（管理员上架）"))
	c.JSON(http.StatusOK, gin.H{"app": gin.H{"app_id": appID, "enabled": true, "changed": true}})
}

// AdminTransferOwner 转移归属（§11 第 17 项：离职/接管）。
//
// 归属只约束"谁能续传新版本"；转移后旧归属者的发布请求即 404，新归属者获得续传权。
// 审计明细复用 appstore.TransferOwnerAuditDetail —— 同一个动作在审计页里必须长得一样。
func (h *Handlers) adminTransferOwner(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	admin := serverauth.AdminUser(c)
	if admin == nil {
		writeErr(c, apperr.New(apperr.CodeAuthRequired, "未登录"))
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, aerr := h.adminApp(c, appID)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	var req struct {
		Owner string `json:"owner"`
	}
	if berr := bindAdminJSON(c, &req); berr != nil {
		writeErr(c, berr)
		return
	}
	owner := strings.TrimSpace(req.Owner)
	if owner == "" {
		writeErr(c, apperr.New(apperr.CodeValidation, "owner 不能为空").
			WithDetail("field", "owner").
			WithHint("不支持清空归属（防误操作置为无主）：请指定新的负责人账号"))
		return
	}
	if _, err := serverstore.GetUserByUsername(h.opt.DB, owner); err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			writeErr(c, apperr.New(apperr.CodeValidation, "目标用户不存在").
				WithDetail("field", "owner").
				WithDetail("username", owner))
			return
		}
		writeErr(c, internalErr("查询失败", err))
		return
	}
	if app.Owner == owner {
		// 幂等：归属未变更时不写审计（与 transferOwner 同口径，避免噪音条目）。
		c.JSON(http.StatusOK, gin.H{"app": gin.H{"app_id": appID, "owner": owner, "changed": false}})
		return
	}
	if err := serverstore.TransferWasmAppOwner(c.Request.Context(), h.opt.DB, appID, owner); err != nil {
		writeErr(c, internalErr("转移归属失败", err))
		return
	}
	h.auditApp(appID, admin.Username, "app_owner_transfer",
		appstore.TransferOwnerAuditDetail(serverstore.AppKindWasmApp, appID, app.Title, app.Owner, owner))
	c.JSON(http.StatusOK, gin.H{"app": gin.H{"app_id": appID, "owner": owner, "changed": true}})
}

// AdminFreeze 管理员冻结/解冻（R37）。
func (h *Handlers) adminFreeze(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	admin := serverauth.AdminUser(c)
	if admin == nil {
		writeErr(c, apperr.New(apperr.CodeAuthRequired, "未登录"))
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, aerr := h.adminApp(c, appID)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	// body 可选（缺省 = 冻结）：只认显式的 {"frozen":false} 表示解冻。
	req := struct {
		Frozen *bool `json:"frozen"`
	}{}
	if c.Request.ContentLength > 0 {
		if berr := bindAdminJSON(c, &req); berr != nil {
			writeErr(c, berr)
			return
		}
	}
	frozen := true
	if req.Frozen != nil {
		frozen = *req.Frozen
	}
	ctx := c.Request.Context()
	if frozen {
		if app.FrozenAt != nil {
			c.JSON(http.StatusOK, gin.H{"app": gin.H{"app_id": appID, "frozen": true, "changed": false, "frozen_at": app.FrozenAt}})
			return
		}
		now := h.now().UTC()
		if err := serverstore.FreezeWasmApp(ctx, h.opt.DB, appID, now); err != nil {
			writeErr(c, internalErr("冻结失败", err))
			return
		}
		if app.Enabled {
			if err := serverstore.SetWasmAppEnabled(ctx, h.opt.DB, appID, false); err != nil {
				writeErr(c, internalErr("冻结时下架失败", err))
				return
			}
		}
		h.auditApp(appID, admin.Username, "wasm_app_freeze",
			auditDetail(appID, app.Title, "冻结（管理员处置；停止服务 + 进入只读快照保留期）"))
		c.JSON(http.StatusOK, gin.H{"app": gin.H{"app_id": appID, "frozen": true, "changed": true, "frozen_at": now, "enabled": false}})
		return
	}
	if app.FrozenAt == nil {
		c.JSON(http.StatusOK, gin.H{"app": gin.H{"app_id": appID, "frozen": false, "changed": false, "enabled": app.Enabled}})
		return
	}
	if err := serverstore.FreezeWasmApp(ctx, h.opt.DB, appID, time.Time{}); err != nil {
		writeErr(c, internalErr("解冻失败", err))
		return
	}
	h.auditApp(appID, admin.Username, "wasm_app_freeze",
		auditDetail(appID, app.Title, "解冻（enabled 保持不变）"))
	c.JSON(http.StatusOK, gin.H{"app": gin.H{"app_id": appID, "frozen": false, "changed": true, "enabled": app.Enabled}})
}

// AdminReview 读写审核开关（R17）。
//
// 只有这一个端点在管理面写 settings：开关变更**必须**写审计（§8 原话），
// 而"谁在什么时候把全组织的发布策略从免审改成必审"是必须答得出的问题。
func (h *Handlers) adminReview(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	admin := serverauth.AdminUser(c)
	if admin == nil {
		writeErr(c, apperr.New(apperr.CodeAuthRequired, "未登录"))
		return
	}
	var req struct {
		Required *bool `json:"required"`
	}
	if berr := bindAdminJSON(c, &req); berr != nil {
		writeErr(c, berr)
		return
	}
	if req.Required == nil {
		writeErr(c, apperr.New(apperr.CodeValidation, "缺少 required").
			WithDetail("field", "required").
			WithHint("body 形如 {\"required\":true}：开启后新版本进待审队列、线上仍旧版本"))
		return
	}
	old := h.reviewRequired()
	if old == *req.Required {
		c.JSON(http.StatusOK, gin.H{"review_required": old, "changed": false, "setting_key": SettingReviewRequired})
		return
	}
	if err := serverstore.SetSetting(h.opt.DB, SettingReviewRequired, strconv.FormatBool(*req.Required)); err != nil {
		writeErr(c, internalErr("保存失败", err))
		return
	}
	// 组织级动作（没有 app 维度）⇒ 走 Audit 钩子 / AuditLog。
	h.auditOrg(admin.Username, "wasm_review_switch",
		fmt.Sprintf("发布审核开关 wasm.review_required %t → %t", old, *req.Required))
	c.JSON(http.StatusOK, gin.H{"review_required": *req.Required, "changed": true, "setting_key": SettingReviewRequired})
}

// adminApp 载入应用（管理面无归属限制：管理员可处置任何应用），已删除的不可处置。
func (h *Handlers) adminApp(c *gin.Context, appID string) (*serverstore.WasmApp, *apperr.Error) {
	if appID == "" {
		return nil, apperr.New(apperr.CodeMissingField, "缺少 app_id").WithDetail("field", "app_id")
	}
	if verr := h.validateAppID(appID); verr != nil {
		return nil, verr
	}
	app, err := serverstore.GetWasmApp(c.Request.Context(), h.opt.DB, appID)
	if err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			return nil, apperr.New(apperr.CodeNotFound, "应用不存在").WithDetail("app_id", appID)
		}
		return nil, internalErr("查询失败", err)
	}
	if app.DeletedAt != nil {
		return nil, apperr.New(apperr.CodeNotFound, "应用已退役（已删除）").
			WithDetail("app_id", appID).
			WithHint("已删除的应用不能再处置；R37 的\"真删\"由后台任务执行")
	}
	return app, nil
}

// bindAdminJSON 解析管理面的小 JSON 体（管理面请求体都很小，上限 4 KiB 足够 ——
// 与客户端面的 48 MiB 上传体形成对比：管理面没有任何大体积载荷）。
func bindAdminJSON[T any](c *gin.Context, dst *T) *apperr.Error {
	v, berr := bindJSONLimited[T](c, 4096, "admin")
	if berr != nil {
		return berr
	}
	*dst = v
	return nil
}
