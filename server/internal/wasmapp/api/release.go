package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/registry"
)

// 本文件是 §8 的"上下架 / 冻结 / 删除"三件事（R37）。
//
// 三者的语义边界（容易混，先写清）：
//   - **下架**（apps.enabled=0）：发布者自主的、可逆的"暂时不服务"；与审核开关无关。
//   - **冻结**（apps.frozen_at 非空）：R37 退役流程的第一步 —— 停止服务 + 进入
//     只读快照保留期（limits.RetirementSnapshotRetentionDays = 90 天）。
//   - **删除**（apps.deleted_at 非空）：软删（标识与版本号永久占位，§4.1 防抢占），
//     R37 的"真删"由后台任务执行（当前未实现，见交付说明的缺口清单）。
//
// 冻结是否同时下架？**是**（本实现的选择与理由）：
//  1. R37 把冻结定义为"停止服务"，而 `apps.enabled` 正是"是否服务"的那个列；
//     只写 frozen_at 会留下两个语义冲突的开关，任何只查 enabled 的读取路径
//     （模块 K 的应用子域最先会查它）都会继续服务一个被冻结的应用；
//  2. 反向不成立：**解冻不自动上架**。解冻只清 frozen_at，enabled 保持 0 ——
//     否则一次"解冻"会把发布者此前主动下架的应用静默恢复服务（fail-closed 方向）。

// setPublished 处理 POST .../wasm/:app_id/publish 与 .../unpublish（同一 handler）。
//
// 判定顺序：路径后缀 → 请求体 enabled → 缺省上架。路径后缀是**权威**（与 §8 的
// 端点表一致）；请求体只用于"挂载点不含后缀"的场景（例如测试自建路由树）。
func (h *Handlers) setPublished(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	u, aerr := h.currentUser(c)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	if appID == "" {
		writeErr(c, apperr.New(apperr.CodeMissingField, "缺少 app_id").WithDetail("field", "app_id"))
		return
	}
	target, berr := h.publishTarget(c)
	if berr != nil {
		writeErr(c, berr)
		return
	}
	app, _, oerr := h.ownedApp(c, appID, false)
	if oerr != nil {
		writeErr(c, oerr)
		return
	}
	if app.FrozenAt != nil {
		e := apperr.New(apperr.CodeAppFrozen, "应用已冻结，不能上下架").
			WithHint("冻结期间应用不服务；需要恢复请先解冻（POST .../freeze {\"frozen\":false}），再重新上架")
		writeErr(c, e)
		return
	}
	if app.Enabled == target {
		// 幂等：状态未变更时不写审计（与 appstore 的归属转移同口径，避免噪音条目）。
		c.JSON(http.StatusOK, gin.H{"app": gin.H{"app_id": appID, "enabled": target, "changed": false}})
		return
	}
	if err := serverstore.SetWasmAppEnabled(c.Request.Context(), h.opt.DB, appID, target); err != nil {
		writeErr(c, internalErr("上下架失败", err))
		return
	}
	h.auditApp(appID, u.Username, "wasm_app_publish_toggle",
		auditDetail(appID, app.Title, fmt.Sprintf("enabled %t → %t", app.Enabled, target)))
	c.JSON(http.StatusOK, gin.H{"app": gin.H{
		"app_id": appID, "enabled": target, "changed": true, "entry_url": h.appOrigin(c, appID),
	}})
}

// publishTarget 解析本次调用是"上架"还是"下架"。
func (h *Handlers) publishTarget(c *gin.Context) (bool, *apperr.Error) {
	path := strings.TrimSuffix(c.FullPath(), "/")
	switch {
	case strings.HasSuffix(path, "/unpublish"):
		return false, nil
	case strings.HasSuffix(path, "/publish"):
		return true, nil
	}
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if c.Request.ContentLength > 0 {
		b, berr := bindJSONLimited[struct {
			Enabled *bool `json:"enabled"`
		}](c, 4096, "set_published")
		if berr != nil {
			return false, berr
		}
		body.Enabled = b.Enabled
	}
	if body.Enabled == nil {
		// 缺省 = 上架：`POST .../publish` 是主用法，挂载点判定不出来时按它处理。
		return true, nil
	}
	return *body.Enabled, nil
}

// freeze 处理 POST .../wasm/:app_id/freeze（R37 第一步；body 可带 {"frozen":false} 解冻）。
func (h *Handlers) freeze(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	u, aerr := h.currentUser(c)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, _, oerr := h.ownedApp(c, appID, false)
	if oerr != nil {
		writeErr(c, oerr)
		return
	}
	frozen := true
	if c.Request.ContentLength > 0 {
		b, berr := bindJSONLimited[struct {
			Frozen *bool `json:"frozen"`
		}](c, 4096, "freeze")
		if berr != nil {
			writeErr(c, berr)
			return
		}
		if b.Frozen != nil {
			frozen = *b.Frozen
		}
	}
	ctx := c.Request.Context()
	if frozen {
		if app.FrozenAt != nil {
			c.JSON(http.StatusOK, gin.H{"app": gin.H{"app_id": appID, "frozen": true, "changed": false,
				"frozen_at": app.FrozenAt, "enabled": app.Enabled}})
			return
		}
		now := h.now().UTC()
		if err := serverstore.FreezeWasmApp(ctx, h.opt.DB, appID, now); err != nil {
			writeErr(c, internalErr("冻结失败", err))
			return
		}
		// 冻结 = 停止服务 ⇒ 同时下架（理由见文件头注释）。
		if app.Enabled {
			if err := serverstore.SetWasmAppEnabled(ctx, h.opt.DB, appID, false); err != nil {
				writeErr(c, internalErr("冻结时下架失败", err))
				return
			}
		}
		h.auditApp(appID, u.Username, "wasm_app_freeze",
			auditDetail(appID, app.Title, fmt.Sprintf("冻结（停止服务，快照保留 %d 天）", limits.RetirementSnapshotRetentionDays)))
		c.JSON(http.StatusOK, gin.H{"app": gin.H{"app_id": appID, "frozen": true, "changed": true,
			"frozen_at": now, "enabled": false}})
		return
	}
	// 解冻：只清 frozen_at，**不**自动上架（文件头注释第 2 条）。
	if app.FrozenAt == nil {
		c.JSON(http.StatusOK, gin.H{"app": gin.H{"app_id": appID, "frozen": false, "changed": false,
			"enabled": app.Enabled}})
		return
	}
	if err := serverstore.FreezeWasmApp(ctx, h.opt.DB, appID, time.Time{}); err != nil {
		writeErr(c, internalErr("解冻失败", err))
		return
	}
	h.auditApp(appID, u.Username, "wasm_app_freeze",
		auditDetail(appID, app.Title, "解冻（enabled 保持不变，需要重新上架才恢复服务）"))
	c.JSON(http.StatusOK, gin.H{"app": gin.H{"app_id": appID, "frozen": false, "changed": true,
		"enabled": app.Enabled, "note": "解冻不会自动上架：请显式调用 publish"}})
}

// deleteApp 处理 DELETE .../wasm/:app_id（R37：软删 + 审计；"真删"由后台任务负责）。
func (h *Handlers) deleteApp(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	u, aerr := h.currentUser(c)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, _, oerr := h.ownedApp(c, appID, false)
	if oerr != nil {
		writeErr(c, oerr)
		return
	}
	ctx := c.Request.Context()
	// R37 的时间线锚点：冻结时刻 + 保留期 = 可删时刻。删除时若从未冻结过，就在这里
	// 补一个冻结时刻（否则后台任务只能拿 deleted_at 兜底，两个口径会分叉）。
	if app.FrozenAt == nil {
		if err := serverstore.FreezeWasmApp(ctx, h.opt.DB, appID, h.now().UTC()); err != nil {
			writeErr(c, internalErr("删除前冻结失败", err))
			return
		}
	}
	if err := serverstore.SoftDeleteWasmApp(ctx, h.opt.DB, appID); err != nil {
		writeErr(c, internalErr("删除失败", err))
		return
	}
	h.auditApp(appID, u.Username, "wasm_app_delete",
		auditDetail(appID, app.Title, fmt.Sprintf("软删（标识与版本号永久占位；资源与库保留 %d 天待真删）",
			limits.RetirementSnapshotRetentionDays)))
	c.JSON(http.StatusOK, gin.H{"app": gin.H{
		"app_id": appID, "deleted": true, "frozen_at": app.FrozenAt, "deleted_at": h.now().UTC(),
	}, "retention_days": limits.RetirementSnapshotRetentionDays,
		"note": "R37 的\"真删\"由后台任务执行（当前未实现）：在此之前资源目录与应用库都会保留"})
}

// ---------------------------------------------------------------------------
// 管理平面权限判定（§8：仅发布者 + super_admin 兜底）
// ---------------------------------------------------------------------------

// ownedApp 载入应用并做**管理平面**的权限判定。
//
// 非发布者且非管理员一律 **404 NOT_FOUND**（与"不存在"同形、同文案）：管理动作不需要
// 让外人知道这个应用存在，也就不必区分"不存在"与"不是你的"（§8 身份语义）。
//
// allowDeleted=true 用于**只读**动作（导出/诊断/自省）：R37 的"冻结 → 90 天内可导出"
// 必须在删除之后仍然可用；写动作一律 allowDeleted=false。
func (h *Handlers) ownedApp(c *gin.Context, appID string, allowDeleted bool) (*serverstore.WasmApp, *serverstore.User, *apperr.Error) {
	u, aerr := h.currentUser(c)
	if aerr != nil {
		return nil, nil, aerr
	}
	if appID == "" {
		return nil, nil, apperr.New(apperr.CodeMissingField, "缺少 app_id").WithDetail("field", "app_id")
	}
	if verr := h.validateAppID(appID); verr != nil {
		return nil, nil, verr
	}
	app, err := serverstore.GetWasmApp(c.Request.Context(), h.opt.DB, appID)
	if err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			return nil, nil, notFoundApp(appID)
		}
		return nil, nil, internalErr("查询失败", err)
	}
	if app.Owner != u.Username && !isSuperAdmin(u) {
		return nil, nil, notFoundApp(appID)
	}
	if !allowDeleted && app.DeletedAt != nil {
		return nil, nil, apperr.New(apperr.CodeNotFound, "应用已退役（已删除）").
			WithDetail("app_id", appID).
			WithHint("已删除的应用不能再修改；如需恢复请联系平台管理员")
	}
	return app, u, nil
}

// notFoundApp 是管理平面统一的 404（不区分"不存在"与"不是你的"）。
func notFoundApp(appID string) *apperr.Error {
	return apperr.New(apperr.CodeNotFound, "应用不存在").
		WithDetail("app_id", appID).
		WithHint("只有发布者本人（或平台管理员）能管理该应用；应用标识一经发布不能改名")
}
