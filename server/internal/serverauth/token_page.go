package serverauth

// 管理端「用户令牌列表」的分页版本（R15C-R-01 ②，审计 2026-09-25，P1）。
//
// 缺陷形态：`GET /api/server/admin/users/:id/tokens` 的 SQL 没有 LIMIT，handler
// 又把整份结果一次性 `c.JSON` 出去 ⇒ 响应体与进程堆都随**总行数**线性增长。
// 真 PG 实测：1,001,883 行 → 单请求 137,148,812 B（130.8 MiB）/ 2.29 s，进程在飞堆
// 11 MB → 667 MB；3 并发同一请求 → 1,585.9 MB。行数没有上界（任何持证员工每次登录
// 插一行、成功登录清空失败预算 ⇒ 不限次），所以这是一个**普通员工可单方面触发**的
// 全站 OOM 面。
//
// 修法（本文件）：
//   - limit/offset 分页（本仓既有分页风格 = `?page=&size=`），走
//     `serverstore.ListTokensByUserPage`（ORDER BY id DESC LIMIT/OFFSET）；
//   - **显式上限校验**：`size` 缺省 50、最大 200，越界或非数字一律 **400**
//     （不静默钳制 —— 静默钳制会让调用方以为拿到了自己要的页大小）；
//   - 响应带 `total` / `has_more`，让"还有更多"这件事在契约里可见（旧形态既无分页
//     也无总数，前端只能把整表塞进 state）。
//
// 边界（诚实登记）：webadmin 的令牌对话框仍只请求第一页（`server/webadmin/**` 属另一
// 条泳道，本泳道不改）；它现在拿到的是"最近 50 条 + total"，而不是全量。

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// listUserTokensPaged 是分页后的令牌列表 handler。
//
// 与旧实现（`AdminAPI.listUserTokens`）字段逐个对齐（tokens[] 的形状不变），只多出
// page/size/total/has_more 四个元数据字段 ⇒ 既有前端无需改动即可继续渲染。
func (a *AdminAPI) listUserTokensPaged(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "非法用户 ID")
		return
	}
	page, size, ok := parseTokenPageQuery(c)
	if !ok {
		return // parseTokenPageQuery 已写 400 信封
	}
	if _, err := serverstore.GetUserByID(a.DB, id); errors.Is(err, serverstore.ErrNotFound) {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "用户不存在")
		return
	} else if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	tokens, total, err := serverstore.ListTokensByUserPage(a.DB, id, size, (page-1)*size)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	out := make([]tokenJSON, 0, len(tokens))
	for _, tk := range tokens {
		lastUsed := ""
		if !tk.LastUsedAt.IsZero() {
			lastUsed = tk.LastUsedAt.Format(time.RFC3339)
		}
		out = append(out, tokenJSON{
			ID: tk.ID, Name: tk.Name, CreatedAt: tk.CreatedAt,
			ExpiresAt: tk.ExpiresAt.Format(time.RFC3339), LastUsedAt: lastUsed, Revoked: tk.Revoked,
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"tokens":   out,
		"page":     page,
		"size":     size,
		"total":    total,
		"has_more": int64((page-1)*size+len(out)) < total,
	})
}

// parseTokenPageQuery 解析并**校验** `?page=&size=`（缺省 page=1 / size=50）。
//
// 校验口径（R15C-R-01 ②："缺省页大小与最大值都要有，超出即 400"）：
//   - 缺省 = 合法（page 1 / size TokenListDefaultPageSize）；
//   - 非数字、<1、size>TokenListMaxPageSize、page>maxPage ⇒ 400 VALIDATION。
//
// 与 `paginate()`（列表页既有实现，静默钳制）的差别是有意的：本端点此前**没有**
// 分页参数，任何越界取值都只可能是调用方写错或试图要一个超大页 —— 后者恰恰是本条
// 审计的放大面，必须显式拒绝而不是"贴心地"给它钳到一个值上。
//
// 返回 ok=false 时响应已写。
func parseTokenPageQuery(c *gin.Context) (page, size int, ok bool) {
	page, size = 1, serverstore.TokenListDefaultPageSize
	if raw := c.Query("page"); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 1 || v > maxPage {
			writeError(c, http.StatusBadRequest, "VALIDATION",
				"page 必须是 1.."+strconv.Itoa(maxPage)+" 的整数")
			return 0, 0, false
		}
		page = v
	}
	if raw := c.Query("size"); raw != "" {
		v, err := strconv.Atoi(raw)
		if err != nil || v < 1 || v > serverstore.TokenListMaxPageSize {
			writeError(c, http.StatusBadRequest, "VALIDATION",
				"size 必须是 1.."+strconv.Itoa(serverstore.TokenListMaxPageSize)+" 的整数")
			return 0, 0, false
		}
		size = v
	}
	return page, size, true
}
