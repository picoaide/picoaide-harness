package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/memprofile"
	"github.com/picoaide/picoaide/internal/wasmapp/registry"
)

// 本文件是 §8 的**管理面**（R23"最小运维面"）：应用列表 / 下架 / 转移归属 / 冻结
// / 审核开关。
//
// 三条边界（R23 说"最小"，不是"再来一套后台"）：
//   - 只做"处置"动作，不做内容审批流（R17 的开关只是一个布尔，审批本身没有人类队列：
//     §12 认账"无人类运营后台"，因此开启审核后新版本停在 pending，由管理员按需处置）；
//   - 权限点复用既有粗粒度点（capability:read / capability:write），不造实例级权限点（§13）；
//   - 归属转移与冻结都**写审计**，动作名与客户端面同一套（同一个动作只有一个名字）。

// ===========================================================================
// 列表的筛选与分页（P1-7，2026-09-19）
// ===========================================================================
//
// 审计现场：`AdminList` 默认 limit=200 且在 Go 层 `break` —— 第 201 个应用
// **静默消失**（响应里既没有 total 也没有 truncated，页面根本看不出被截断），
// 前端也不带任何筛选参数，于是"应用多了以后有的应用在管理端查不到，且没有任何
// 提示"。现在三件事一起给：
//   - `limit`/`offset` 显式回显，`total`/`truncated` 与当前页同发；
//   - `q` 在**分页之前**过滤（否则"第 201 个应用"永远搜不到）；
//   - `status` 复用既有 include_deleted/owner 的口径做状态筛选。
//
// 注意 `q`/`status` 都在**已取回的列表**上过滤：`serverstore.ListWasmApps` 目前
// 不接受 limit/offset/关键字（那是 DAO 的签名，属别的包），所以 SQL 下推记为
// "待接线"（清单见 docs/planning/2026-09-19-webadmin-wasm-ops-frontend.md §2）。**行为契约不受影响**
// （total/truncated/可检索性都对），代价是大表时仍整表读进内存 —— 与改动前
// 一致，没有变得更差。
const (
	// adminListDefaultLimit 保持 200：不带 limit 的老调用方行为不变（向后兼容）。
	adminListDefaultLimit = 200
	// adminListMaxLimit 是单页上限：管理面是"人在看"的列表，页再大没有意义，
	// 也不允许一次 limit=1e9 把整表拉成 JSON。
	adminListMaxLimit = 1000
)

// 列表状态筛选的取值（`""`/`all` = 不筛）。
const (
	appFilterPending     = "pending"
	appFilterPublished   = "published"
	appFilterUnpublished = "unpublished"
	appFilterFrozen      = "frozen"
	appFilterDeleted     = "deleted"
)

// AdminList 列出 wasm 应用 + 当前的审核开关状态。
//
// 查询串：q（app_id/标题/负责人的大小写不敏感子串）、status（见上）、
// limit/offset、include_deleted、owner。
func (h *Handlers) adminList(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	status := strings.ToLower(strings.TrimSpace(c.Query("status")))
	switch status {
	case "", "all", appFilterPending, appFilterPublished, appFilterUnpublished,
		appFilterFrozen, appFilterDeleted:
	default:
		writeErr(c, apperr.New(apperr.CodeValidation, "status 取值不合法").
			WithDetail("field", "status").
			WithDetail("allowed", []string{"all", appFilterPending, appFilterPublished,
				appFilterUnpublished, appFilterFrozen, appFilterDeleted}).
			WithHint("待审批队列用 status=pending；不筛用 status=all（缺省）"))
		return
	}
	// 访问级别筛选（W5 C1 / R2-L6-1）：`?access=login|whitelist`。
	//
	// ⚠️ `access=login` **必须包含历史 `public` 行**（I6 的读侧口径：public 在读取侧
	// 即 login）。只匹配字面 `login` 会让"存量 public 行"在按 login 筛选时凭空消失
	// —— 而那正是管理员要去处理的那批行。
	accessFilter := strings.ToLower(strings.TrimSpace(c.Query("access")))
	switch accessFilter {
	case "", "all", string(appcfg.AccessLogin), string(appcfg.AccessWhitelist):
	default:
		writeErr(c, apperr.New(apperr.CodeValidation, "access 取值不合法").
			WithDetail("field", "access").
			WithDetail("allowed", []string{"all", string(appcfg.AccessLogin), string(appcfg.AccessWhitelist)}).
			WithHint("access=login 会**连同历史 public 行**一起返回（读侧把 public 当 login）"))
		return
	}
	if accessFilter == "all" {
		accessFilter = ""
	}

	// status=deleted 与 include_deleted 是同义的两条入口：显式要求看已删除的行
	// 时就别再让调用方记得同时传 include_deleted（否则"筛了却什么都没有"）。
	includeDeleted := c.Query("include_deleted") == "1" ||
		strings.EqualFold(c.Query("include_deleted"), "true") ||
		status == appFilterDeleted
	filter := serverstore.WasmAppFilter{IncludeDeleted: includeDeleted}
	if owner := strings.TrimSpace(c.Query("owner")); owner != "" {
		filter.Owner = owner
	}
	limit := atoiDefault(c.Query("limit"), adminListDefaultLimit)
	if limit <= 0 {
		limit = adminListDefaultLimit
	}
	if limit > adminListMaxLimit {
		limit = adminListMaxLimit
	}
	offset := atoiDefault(c.Query("offset"), 0)
	if offset < 0 {
		offset = 0
	}
	q := strings.ToLower(strings.TrimSpace(c.Query("q")))

	apps, err := serverstore.ListWasmApps(c.Request.Context(), h.opt.DB, filter)
	if err != nil {
		writeErr(c, internalErr("查询失败", err))
		return
	}
	// 待审积压（P0-1）：审核开关一旦打开，新版本就停在 pending 而**没有任何提示**
	// 是这次审计的 P0（"全组织无法上线且没有审批出口"）。这里把积压量随列表一起
	// 下发：管理员打开页面就能看到"有几个版本在等我审批"，不需要先点进某个应用。
	// 一次查询取全量待审行（待审是小集合），不按应用发 N 次查询。
	pending, perr := serverstore.PendingWasmReleases(c.Request.Context(), h.opt.DB)
	if perr != nil {
		writeErr(c, internalErr("查询待审版本失败", perr))
		return
	}
	// 全组织待审总数：**与分页无关**（不是"当前这一页有几条待审"）。审核开关是
	// 组织级开关，它的后果（"全组织的新版本都卡住了"）必须在开关旁边就看得见。
	pendingTotal := 0
	for _, versions := range pending {
		pendingTotal += len(versions)
	}

	// 过滤 → total → 分页。顺序不能反：先分页再过滤会让"命中项恰好不在本页"
	// 变成"搜不到"（正是 P1-7 的现场）。
	matched := make([]*serverstore.WasmApp, 0, len(apps))
	for i := range apps {
		a := &apps[i]
		if !matchAppQuery(a, q) {
			continue
		}
		if !matchAppStatus(a, status, len(pending[a.AppID])) {
			continue
		}
		if accessFilter != "" && !matchAppAccess(a, accessFilter) {
			continue
		}
		matched = append(matched, a)
	}
	total := len(matched)
	page := matched
	if offset >= len(page) {
		page = nil
	} else {
		page = page[offset:]
	}
	if len(page) > limit {
		page = page[:limit]
	}
	truncated := offset+len(page) < total

	// 当前版本号：apps 行上只有 current_release_id，批量取一次（管理面列表要显示
	// 「当前版本」，没有它这一页只能显示一个内部 id）。取不到不算错 —— 版本行可能
	// 已被保留策略回收，列表里显示空串即可。
	ids := make([]int64, 0, len(page))
	for _, a := range page {
		if a.CurrentReleaseID > 0 {
			ids = append(ids, a.CurrentReleaseID)
		}
	}
	versions, verr := serverstore.WasmAppCurrentVersions(c.Request.Context(), h.opt.DB, ids)
	if verr != nil {
		writeErr(c, internalErr("查询版本失败", verr))
		return
	}
	out := make([]gin.H, 0, len(page))
	for _, a := range page {
		// 空切片而不是 nil：前端可以直接 `.length`/`map`，不必再判 null
		//（JSON 里 nil slice 会变成 null，这是两端最容易踩的一处）。
		appPending := pending[a.AppID]
		if appPending == nil {
			appPending = []string{}
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
			// 待审版本号列表 + 计数（同一个数，前端拿哪个都行）。
			"pending_releases": appPending,
			"pending_count":    len(appPending),
			"frozen_at":        a.FrozenAt,
			"deleted_at":       a.DeletedAt,
			"created_at":       a.CreatedAt,
			"updated_at":       a.UpdatedAt,
		})
	}
	// 审核开关随列表一起下发：webadmin 的应用页要能直接渲染它（R17），
	// 而不是再开一个只读端点。
	c.JSON(http.StatusOK, gin.H{
		"apps":            out,
		"review_required": h.reviewRequired(),
		"setting_key":     SettingReviewRequired,
		"pending_count":   pendingTotal,
		// 分页元数据（P1-7）：前端据此显示"共 N 条 / 当前显示 M 条"并翻页，
		// 管理员不再面对一个"看起来完整、其实被截断"的列表。
		"total":     total,
		"truncated": truncated,
		"limit":     limit,
		"offset":    offset,
		"q":         q,
		"status":    status,
		// `access` 回显（W5 C1 的契约）：前端据它判断"服务端是否支持该筛选"。
		// **不回显**会让前端退化成本页过滤（并明说"共 N 条是未筛选全集"）——
		// 那是个安全但难用的降级分支，别让它误判。
		"access": accessFilter,
	})
}

// matchAppAccess 判定一行是否命中访问级别筛选（W5 C1）。
//
// 归一化口径与 appcfg 的读侧一致：历史 `public` 行按 `login` 参与匹配（I6），
// 因此 `access=login` 会同时返回字面 login 与历史 public 的行 —— 这正是管理员
// 要清理/复核的那批。
func matchAppAccess(a *serverstore.WasmApp, want string) bool {
	// 历史取值的判定**只用 appcfg 的判定函数**（`IsLegacyPublicAccess`）：服务端
	// 只有归属模块知道"历史公开档位长什么样"，调用点读起来是意图（这是不是历史档位）
	// 而不是字面量比较；同时业务代码里不出现历史字面量（零残留扫描的 A 桶必须为 0）。
	if appcfg.IsLegacyPublicAccess(string(appcfg.AccessOfConfigJSON(a.ConfigJSON))) {
		return want == string(appcfg.AccessLogin)
	}
	return string(appcfg.AccessOfConfigJSON(a.ConfigJSON)) == want
}

// matchAppQuery 判定一行是否命中搜索词（app_id / 标题 / 负责人）。
//
// 大小写不敏感的子串匹配：管理端搜索是"我记得名字里有个 share"的用法，
// 不是精确匹配；q 由调用方先 ToLower。
func matchAppQuery(a *serverstore.WasmApp, q string) bool {
	if q == "" {
		return true
	}
	return strings.Contains(strings.ToLower(a.AppID), q) ||
		strings.Contains(strings.ToLower(a.Title), q) ||
		strings.Contains(strings.ToLower(a.Owner), q)
}

// matchAppStatus 判定一行是否属于某个状态筛选。
//
// 语义与前端徽章**同一口径**（冻结优先于上下架、已删除优先于一切）：
// 两处各自解释一次会让"筛 pending 出来的行不带待审徽章"这类矛盾出现。
func matchAppStatus(a *serverstore.WasmApp, status string, pendingCount int) bool {
	switch status {
	case appFilterPending:
		return pendingCount > 0
	case appFilterPublished:
		return a.DeletedAt == nil && a.FrozenAt == nil && a.Enabled
	case appFilterUnpublished:
		return a.DeletedAt == nil && a.FrozenAt == nil && !a.Enabled
	case appFilterFrozen:
		return a.FrozenAt != nil
	case appFilterDeleted:
		return a.DeletedAt != nil
	default: // "" / "all"
		return true
	}
}

// ===========================================================================
// 审核队列（P0-1，2026-09-19）：开关打开后必须有人类出口
// ===========================================================================
//
// 审计现场：publish.go 在 reviewRequired() 为真时把新版本落库为 pending，
// webadmin 的开关文案承诺"开启:新版本需审核"，但管理面**没有任何审批端点** ——
// 于是开启开关 = 全组织再也发不出新版本，且没有任何界面提示"谁在等审批"。
//
// 闭环由三件事组成（都在本文件）：
//  1. adminList 下发 pending_count / pending_releases（积压可见）；
//  2. AdminReleases 给出待审清单（谁、什么时候、多大、当前生效版本是哪个）；
//  3. AdminApproveRelease / AdminRejectRelease 给出处置出口，状态写入复用
//     serverstore.SetReleaseStatusForReview（审核专用：approved 与"归档非空"在
//     同一条条件 UPDATE 里判定，rejected 与"释放归档"也在同一条 —— 不另写状态机）。

// maxReviewReasonLen 是拒绝理由的长度上限（字符数）。
//
// 理由会**原样进审计链**（哈希链是追加型的，写进去就改不掉），因此必须在入口
// 收敛：太长的自由文本既撑爆审计详情，也可能被用来塞进整份文件内容。
const maxReviewReasonLen = 200

// auditText 把管理员输入的自由文本压成**单行**审计片段（换行/制表折成空格）。
//
// 审计详情是「一行一条、可 grep」的稳定形态（见 auditDetail）；把原始多行文本直接
// 拼进去会让一条审计在页面上变成十几行、"谁改了什么"再也读不出来。
func auditText(s string, max int) string {
	s = strings.TrimSpace(s)
	s = strings.NewReplacer("\r\n", " ", "\n", " ", "\r", " ", "\t", " ").Replace(s)
	s = strings.Join(strings.Fields(s), " ")
	if max > 0 && len([]rune(s)) > max {
		s = string([]rune(s)[:max]) + "…"
	}
	return s
}

// AdminReleases 列出某应用的版本（默认只看待审），供管理端审批队列渲染。
//
// 查询串：status=pending|approved|rejected|all（缺省 pending）。
// 返回的每行**不含制品字节**（store 走清单投影）—— 审批只需要状态与体积。
// 每行带 `reason`（审核结论，R1-uxw-4）：审批面要能回看自己写过的拒绝理由
// （status=rejected 时正是"最近被拒的版本 + 理由"），发布者侧的同源出口是
// 员工面的 GET …/apps/wasm/:app_id/releases（MyReleases）。
func (h *Handlers) adminReleases(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, aerr := h.adminApp(c, appID)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	status := strings.ToLower(strings.TrimSpace(c.Query("status")))
	if status == "" {
		status = serverstore.ReleaseStatusPending
	}
	switch status {
	case serverstore.ReleaseStatusPending, serverstore.ReleaseStatusApproved,
		serverstore.ReleaseStatusRejected, "all":
	default:
		writeErr(c, apperr.New(apperr.CodeValidation, "status 取值不合法").
			WithDetail("field", "status").
			WithDetail("allowed", []string{serverstore.ReleaseStatusPending,
				serverstore.ReleaseStatusApproved, serverstore.ReleaseStatusRejected, "all"}).
			WithHint("待审队列用 status=pending（缺省）；要看全部版本用 status=all"))
		return
	}
	ctx := c.Request.Context()
	rels, err := serverstore.ListWasmReleases(ctx, h.opt.DB, appID, false)
	if err != nil {
		writeErr(c, internalErr("查询版本失败", err))
		return
	}
	// 当前生效版本：审核时最关键的对照信息（"通过这个版本会替换掉哪个版本"）。
	current := ""
	if app.CurrentReleaseID > 0 {
		if versions, verr := serverstore.WasmAppCurrentVersions(ctx, h.opt.DB, []int64{app.CurrentReleaseID}); verr == nil {
			current = versions[app.CurrentReleaseID]
		}
	}
	out := make([]gin.H, 0, len(rels))
	// pendingTotal 是**该应用真实的待审版本数**，与本次 status 筛选无关。
	//
	// 为什么不能用 len(out)：`status=all|approved` 时 out 是"筛选后的行数"，
	// 把它当 pending_count 会让管理端/第三方/AI 消费者读到"待审 6 个"而实际只有 1 个
	// （独立验证 2026-09-19 实测并点名）。字段名即语义，必须始终是待审数。
	pendingTotal := 0
	for _, r := range rels {
		if r.Status == serverstore.ReleaseStatusPending {
			pendingTotal++
		}
		if status != "all" && r.Status != status {
			continue
		}
		out = append(out, gin.H{
			"id":        r.ID,
			"version":   r.Version,
			"status":    r.Status,
			"title":     r.Title,
			"publisher": r.Publisher,
			"size":      r.Size,
			"checksum":  r.Checksum,
			"changelog": r.Changelog,
			// 描述与标题同源（都来自 apps 的显示面投影 = 生效版本的 app_releases 行）：
			// 审核通过会把这两列一起公开给全组织（admin.go 的 syncAppProjection），
			// 所以审批人必须在批准**之前**看到它们（审计第三轮 B 区：此前只下发 title，
			// 而卡片连 title 都没渲染 ⇒ 对"改名/换描述"是盲批）。
			"description": r.Description,
			"created_at":  r.CreatedAt,
			// 审核结论（被拒理由）。R1-uxw-4：管理员写下的理由此前只落在审计详情里 ——
			// 审批面自己都回看不了"我上次为什么拒的"，发布者更无从得知。
			// pending/approved 行恒为空串（数据库侧保证），前端只在 rejected 行渲染它。
			"reason": r.Reason,
			// 这一行是不是线上正在跑的版本（前端据此禁用"拒绝"按钮）。
			"current": r.Version == current && current != "",
		})
	}
	c.JSON(http.StatusOK, gin.H{
		"app_id":          appID,
		"status":          status,
		"current_version": current,
		"releases":        out,
		"pending_count":   pendingTotal,
		// matched_count 才是"本次筛选命中的行数"（与 pending_count 区分开）。
		"matched_count":   len(out),
		"review_required": h.reviewRequired(),
		"setting_key":     SettingReviewRequired,
	})
}

// AdminApproveRelease 通过一个待审版本（审核出口）。
func (h *Handlers) adminApproveRelease(c *gin.Context) {
	h.reviewRelease(c, true)
}

// AdminRejectRelease 拒绝一个待审版本（可选 body {"reason":"..."}，写进审计详情）。
func (h *Handlers) adminRejectRelease(c *gin.Context) {
	h.reviewRelease(c, false)
}

// reviewRelease 是 approve/reject 的共用实现（两条路径的差异只有目标状态与理由）。
func (h *Handlers) reviewRelease(c *gin.Context, approve bool) {
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
	version := strings.TrimSpace(c.Param("version"))
	if version == "" {
		writeErr(c, apperr.New(apperr.CodeMissingField, "缺少版本号").
			WithDetail("field", "version").
			WithHint("路径形如 /wasm-apps/<app_id>/releases/<version>/approve"))
		return
	}
	ctx := c.Request.Context()

	// 理由只在 reject 路径上收（approve 不接受 body：审批通过不需要解释，
	// 也不该给"通过时顺手写一段话进审计"的口子）。
	//
	// **reject 必须带非空理由**（P2-5，2026-09-20 本机实测）：旧实现 `POST …/reject '{}'`
	// ⇒ `200 {"status":"rejected","reason":""}`，作者在客户端只看到"被拒绝了"，
	// 拿不到任何可执行反馈 —— 而拒绝理由是这条通道**唯一**的反馈载体（同时进审计、
	// 管理端"最近被拒"清单、作者侧 `GET …/releases` 的 `reason`）。
	// 因此"没写理由"是**请求不合法**（400），不是"理由为空"。
	reason := ""
	if !approve {
		var req struct {
			Reason *string `json:"reason"`
		}
		// ContentLength == 0 = 明确没有请求体：不走 bindAdminJSON（它的"请求体为空"
		// 文案对调用方没有指向性），直接落到下面统一那条"必须给出理由"。
		// 负数（chunked，长度未知）仍要解析 —— 不能因为长度未知就把 body 丢掉。
		if c.Request.ContentLength != 0 {
			if berr := bindAdminJSON(c, &req); berr != nil {
				writeErr(c, berr)
				return
			}
		}
		if req.Reason != nil {
			// auditText 会 trim + 折成单行 + 压缩空白 ⇒ `"   "`、`"\n"` 这类
			// "看着有理由"的输入在这里就变成空串，被下面那条闸门拦住。
			reason = auditText(*req.Reason, 0)
		}
		if reason == "" {
			writeErr(c, apperr.New(apperr.CodeValidation, "拒绝必须给出理由").
				WithDetail("field", "reason").
				WithDetail("max_length", maxReviewReasonLen).
				WithHint(`理由会写进审计、管理端"最近被拒"清单与作者客户端（作者据此改后再发），`+
					`因此不能为空或只有空白；例：{"reason":"用途描述过简，请补充数据流向与存放位置"}`))
			return
		}
		if len([]rune(reason)) > maxReviewReasonLen {
			writeErr(c, apperr.New(apperr.CodeValidation,
				fmt.Sprintf("拒绝理由过长（上限 %d 字）", maxReviewReasonLen)).
				WithDetail("field", "reason").
				WithDetail("max_length", maxReviewReasonLen))
			return
		}
	}

	// 预检只为"友好的幂等响应"与"别把线上版本拒掉"这两件事；并发下的真正不变量
	// 由 SetReleaseStatusForReview 的条件 UPDATE 保证（N-4 的设计，本包不复制它）。
	meta, merr := serverstore.GetWasmReleaseMeta(ctx, h.opt.DB, appID, version)
	switch {
	case errors.Is(merr, serverstore.ErrNotFound):
		writeErr(c, apperr.New(apperr.CodeNotFound, "版本不存在").
			WithDetail("app_id", appID).WithDetail("version", version))
		return
	case merr != nil:
		writeErr(c, internalErr("查询版本失败", merr))
		return
	}
	if meta.DeletedAt != nil {
		writeErr(c, apperr.New(apperr.CodeNotFound, "版本已删除（不可审批）").
			WithDetail("app_id", appID).WithDetail("version", version).
			WithHint("软删的版本号永久占位、内容不再可用（§4.1）；请让作者发布新版本"))
		return
	}
	// 已终态的重复调用：**状态不再写，但投影必须重算一次**（自愈）。
	//
	// 为什么不能"终态就早退"（审计第三轮 B 区 CONFIRMED，2026-09-19）：本端点的三步
	// 写入是顺序、非事务的 ——
	//
	//	① SetReleaseStatusForReview（状态落库，不可回滚）
	//	② 投影重算（SetWasmAppCurrentRelease / SetWasmAppConfig / SetWasmAppDisplay）
	//
	// ②任一步失败时端点回 500「审核结果已落库，但…失败（请重试一次）」。而重试时版本
	// 行已经是终态 —— 老实现命中下面的早退分支直接 200 `changed=false`，**一次都不再
	// 跑投影**，于是目录标题/描述/生效版本永久停在旧值（首版待审则永远顶着 app_id
	// 占位）。旧的早退注释还写着"重复调用本端点幂等（会再走一次投影同步）"，与实现相反。
	//
	// 现在的口径：终态 ⇒ 不重复写状态、不重复写审计（幂等无副作用），但**无条件重跑
	// 一次投影同步**（syncAppProjection 是幂等且最小写入的：值没变就不写）。因此
	// "重试一次"这句错误提示是真的可重试，而"重复 approve"也不会变成重复副作用。
	if (approve && meta.Status == serverstore.ReleaseStatusApproved) ||
		(!approve && meta.Status == serverstore.ReleaseStatusRejected) {
		current := h.currentVersionOf(ctx, appID, app)
		latestVersion, perr := h.syncAppProjection(ctx, appID, app)
		if perr != nil {
			writeErr(c, perr)
			return
		}
		if latestVersion != "" {
			current = latestVersion
		}
		c.JSON(http.StatusOK, gin.H{
			"app_id": appID, "version": version,
			"status": meta.Status, "changed": false,
			"current_version": current,
		})
		return
	}
	if !approve && meta.Status == serverstore.ReleaseStatusApproved {
		// 已通过审核的版本**不可**被"拒绝"：拒绝与释放归档是同一条 UPDATE（N-4），
		// 所以拒绝一个 approved 版本会**永久销毁**它的字节 —— 对当前生效版本是
		// "应用当场没有可交付版本"，对历史版本是"不可恢复地丢掉一个可回滚点"。
		// 要停服务用 unpublish / freeze；要换内容请发布新版本（版本号本就永久占位）。
		e := apperr.New(apperr.CodeValidation, "该版本已通过审核，不能审核拒绝").
			WithDetail("app_id", appID).WithDetail("version", version).
			WithDetail("status", meta.Status).
			WithHint("审核拒绝只针对待审版本，且会释放该版本的归档字节（不可恢复）；" +
				"要停止服务请用下架（unpublish）或冻结（freeze）")
		e.HTTP = http.StatusConflict
		writeErr(c, e)
		return
	}

	target := serverstore.ReleaseStatusRejected
	if approve {
		target = serverstore.ReleaseStatusApproved
	}
	if err := serverstore.SetReleaseStatusForReview(h.opt.DB, serverstore.AppKindWasmApp, appID, version, target, reason); err != nil {
		switch {
		case errors.Is(err, serverstore.ErrNotFound):
			writeErr(c, apperr.New(apperr.CodeNotFound, "版本不存在").
				WithDetail("app_id", appID).WithDetail("version", version))
		case errors.Is(err, serverstore.ErrReleaseArchiveCleared):
			// 与 agentshare/sharedskills 同码同语义：拒绝即释放归档，之后不能再通过。
			// 409（不是 400）：这不是"参数写错"，而是"该版本已不可通过"——并发下
			// 两个管理员一个通过一个拒绝时，后来者必然撞到这条（N-4 的设计）。
			e := apperr.New(apperr.CodeValidation,
				"该版本归档已在拒绝时清理，无法再通过审核（拒绝即释放存储）").
				WithDetail("app_id", appID).WithDetail("version", version).
				WithHint("请让应用发布者上传新版本（版本号永久占位，不能复用）")
			e.HTTP = http.StatusConflict
			writeErr(c, e)
		case errors.Is(err, serverstore.ErrReleaseApprovedNotRejectable):
			// 并发下两个管理员一个通过、一个拒绝：后来者撞到 DAO 的原子前置条件
			//（rejected 分支的 `AND status <> 'approved'`）。与 sharedskills/agentshare
			// 同码同语义：409 而非 500——这不是"服务出错"，而是"该版本已不可拒绝"。
			// 归档字节未被销毁（守卫在 UPDATE 之前生效），撤回请走下架流程。
			e := apperr.New(apperr.CodeValidation,
				"该版本已通过审核，不能再拒绝；要停止服务请用下架（unpublish）或冻结（freeze）").
				WithDetail("app_id", appID).WithDetail("version", version).
				WithHint("归档字节未被销毁；撤回请走下架流程")
			e.HTTP = http.StatusConflict
			writeErr(c, e)
		default:
			writeErr(c, internalErr("审核写入失败", err))
		}
		return
	}

	// 审核落定之后把 apps 行的**投影**重算为"最新 approved 版本"（R1-pm-9 + R2-1）。
	// 实现与理由见 syncAppProjection（approve/reject 两条路径共用同一段，因为它们
	// 要的是同一个答案；上面的终态分支也调它 —— 那是"请重试一次"能真正修好的关键）。
	current := h.currentVersionOf(ctx, appID, app)
	if latestVersion, perr := h.syncAppProjection(ctx, appID, app); perr != nil {
		writeErr(c, perr)
		return
	} else if latestVersion != "" {
		current = latestVersion
	}

	// 审计明细里的标题取**投影落定之后**的行状态：syncAppProjection 刚刚可能把 app_id
	// 占位（首版待审）或脏投影换成了生效版本的真值 —— 用审批前读到的旧快照会把一次
	// 成功的首审记成「首版待审，暂无生效标题」，那同样是留错证据（auditTitleOf 的判据
	// 就是 current_release_id）。复读失败不阻断审核：审计是尽力而为的旁路。
	if refreshed, rerr := serverstore.GetWasmApp(ctx, h.opt.DB, appID); rerr == nil {
		app = refreshed
	}

	// 审计：动作名沿用既有风格（wasm_app_* 前缀、一条动作一个名字）；明细里
	// **只有版本号与理由**，绝不含制品内容/校验和之外的任何应用内容（§8 的审计
	// 面是运维可读的，不是内容仓库）。
	if approve {
		h.auditApp(appID, admin.Username, "wasm_app_release_approve",
			auditDetail(appID, auditTitleOf(app), fmt.Sprintf("v%s 审核通过（管理员审批；当前生效 v%s）", version, current)))
	} else {
		detail := fmt.Sprintf("v%s 审核拒绝", version)
		if reason != "" {
			detail += "：" + reason
		}
		h.auditApp(appID, admin.Username, "wasm_app_release_reject",
			auditDetail(appID, auditTitleOf(app), detail))
	}
	c.JSON(http.StatusOK, gin.H{
		"app_id":          appID,
		"version":         version,
		"status":          target,
		"changed":         true,
		"current_version": current,
		"reason":          reason,
	})
}

// syncAppProjection 把 apps 行的**投影列**重算为"最新 approved 版本"，返回生效版本号。
//
// 投影列 = current_release_id 与 config_json/purpose/data_sensitivity 以及
// title/description（R1-pm-9 + R2-1）：它们是同一份版本的投影，必须一起回到同一版。
//
// 两条调用路径要的是同一个答案：
//   - **approve**：新版本成为生效版本 ⇒ 投影切到它（目录徽标/标题/描述/生效版本随
//     审批生效 —— 待审期间 E1 刻意不写 title/description，所以这里是它们唯一的
//     生效入口，漏掉就等于"批准了却永远看不到新标题"）；
//   - **reject** ：被拒版本从未生效 ⇒ 投影**恢复**成仍在生效的那一版 ——
//     否则待审版本带来的 access/负责人/用途会永久留在目录上（审核期间展示一个
//     没被任何人批准的访问级别，正是这条缺陷的下游后果），标题/描述同理
//     （这条路同时把老实现留下的"脏标题"投影治好）。
//
// 取最新 approved 而不是本次版本：审批一个**更旧**的待审版本时（例如 v2 待审、
// v3 已通过），生效版本仍然是更新的那个 approved 版本 —— 与线上交付
// （max(id) approved）同口径。
//
// 没有任何 approved 版本（首版待审被拒）时不动投影：没有可投影的基线，
// 而"把一行从未生效的配置留着"与"把它清空"对目录都没有影响（目录只列有生效
// 版本的应用，见 read.go 的目录条件）。
//
// **幂等且最小写入**（审计第三轮 B 区 CONFIRMED 的修复点）：每一步都先比较现值，
// 值没变就不写。这有两个后果，缺一不可：
//   - "已终态但投影不一致"的重复调用能**自愈**（重试一次真的会把投影补齐）；
//   - "再调一次"不产生任何写入（updated_at 不跳），即幂等无副作用。
//
// 失败语义：状态已经落库（approved/rejected）、但投影没更新 —— 这不是"审核失败"，
// 而是平台侧写入故障。端点如实回 500「请重试一次」；重试会再次走到这里。
func (h *Handlers) syncAppProjection(ctx context.Context, appID string, app *serverstore.WasmApp) (string, *apperr.Error) {
	latest, lerr := serverstore.LatestApprovedWasmReleaseMeta(ctx, h.opt.DB, appID)
	switch {
	case errors.Is(lerr, serverstore.ErrNotFound):
		// 没有已通过版本：保持现状（"当前生效版本"= 空或回收后的残留）。
		return "", nil
	case lerr != nil:
		return "", internalErr("审核结果已落库，但应用投影更新失败（请重试一次）", lerr)
	}
	if latest.ID != app.CurrentReleaseID {
		if serr := serverstore.SetWasmAppCurrentRelease(ctx, h.opt.DB, appID, latest.ID); serr != nil {
			return "", internalErr("审核结果已落库，但应用投影更新失败（请重试一次）", serr)
		}
	}
	// 配置列与 config_json 同源同版：purpose/data_sensitivity 从该版本的
	// config_json 现解（解析失败回落空串，与 AccessOfConfigJSON 同向）。
	// 空 config_json 的历史行不写 —— 不能拿"没有配置"去清掉现有投影。
	if strings.TrimSpace(latest.ConfigJSON) != "" {
		purpose, sensitivity := appcfg.DeclarationsOfConfigJSON(latest.ConfigJSON)
		if app.ConfigJSON != latest.ConfigJSON || app.Purpose != purpose || app.DataSensitivity != sensitivity {
			if serr := serverstore.SetWasmAppConfig(ctx, h.opt.DB, appID,
				latest.ConfigJSON, purpose, sensitivity); serr != nil {
				return "", internalErr("审核结果已落库，但配置投影更新失败（请重试一次）", serr)
			}
		}
	}
	// 显示面两列（title/description）也取**该版本行自己的值**（R2-1）：
	// 这两个字段是版本的属性（publish 时与 config 一起写进 app_releases），
	// 与 purpose 不同源时也要以版本行为准 —— 目录门面必须与生效版本逐字一致。
	// 首版待审用的 app_id 占位必须在这一刻被真值替掉（值相同则不必写）。
	if app.Title != latest.Title || app.Description != latest.Description {
		if serr := serverstore.SetWasmAppDisplay(ctx, h.opt.DB, appID, latest.Title, latest.Description); serr != nil {
			return "", internalErr("审核结果已落库，但显示面投影更新失败（请重试一次）", serr)
		}
	}
	return latest.Version, nil
}

// currentVersionOf 返回该应用**当前生效版本**的版本号（投影读不到时回落空串）。
//
// 与 adminList 同一口径（apps.current_release_id → app_releases.version）；
// 读不到不是错误（版本行可能已被保留策略回收），只是这一列显示空。
func (h *Handlers) currentVersionOf(ctx context.Context, appID string, app *serverstore.WasmApp) string {
	if app == nil || app.CurrentReleaseID <= 0 {
		return ""
	}
	versions, err := serverstore.WasmAppCurrentVersions(ctx, h.opt.DB, []int64{app.CurrentReleaseID})
	if err != nil {
		return ""
	}
	return versions[app.CurrentReleaseID]
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
		auditDetail(appID, auditTitleOf(app), "enabled true → false（管理员下架）"))
	// 下架即释放进程内驻留（编译模块 + 库句柄）——与发布者路径（api/release.go 的
	// setPublished）同一钩子。此前只有发布者路径调用它（P1-8）：管理端处置完，
	// 进程内还留着该应用的模块与库句柄，直到空闲 TTL 到点才回收 —— 而文档与装配
	// 注释都声称"下架/冻结/删除"都在内（"实现对了、没人调用"的典型形态）。
	h.evictApp(appID)
	c.JSON(http.StatusOK, gin.H{"app": gin.H{"app_id": appID, "enabled": false, "changed": true}})
}

// ⚠️ 应用基域配置面已随 W4 整体删除（总纲 §8.4）：`SettingAppsBaseDomain`
// （settings 键 `wasm.apps_base_domain`）、控制台视图 `baseDomainView`、
// `AdminBaseDomainGet`（GET /domain）与 `AdminBaseDomainPut`（PUT /domain）
// 全部不再存在 —— 应用只在桌面客户端内以 `<渠道 app scheme>://<app_id>` 打开，
// 平台上不再有"应用对外主机名"这个配置项。
//
// 历史设置在库里保留但**不再被读取**（读取方 baseDomainHolder 随同一波次删除）；
// 迁移 0074 只改写 `access`，不动该设置行。

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
	// 冻结优先（P2-6）：冻结应用在**交付面一律 404**，所以"上架成功"是一个
	// 不一致的响应 —— 管理员看到 changed:true、列表变「上架」，员工打开却是 404。
	// 员工面的上下架（release.go 的 setPublished）早就有这条闸门，管理面漏了。
	//
	// 状态码复用 apperr 的既有映射（CodeAppFrozen → 403）而不是为管理面另造 409：
	// 同一个条件在两端口必须同一个状态码，否则排障手册要写两套。
	if app.FrozenAt != nil {
		writeErr(c, apperr.New(apperr.CodeAppFrozen, "应用已冻结，不能上架").
			WithDetail("app_id", appID).
			WithDetail("frozen_at", app.FrozenAt).
			WithHint("冻结 = 停止服务（交付面一律 404），与 enabled 无关；先解冻（POST /wasm-apps/<app_id>/freeze，body {\"frozen\":false}）再上架"))
		return
	}
	if err := serverstore.SetWasmAppEnabled(c.Request.Context(), h.opt.DB, appID, true); err != nil {
		writeErr(c, internalErr("上架失败", err))
		return
	}
	h.auditApp(appID, admin.Username, "wasm_app_publish_toggle",
		auditDetail(appID, auditTitleOf(app), "enabled false → true（管理员上架）"))
	c.JSON(http.StatusOK, gin.H{"app": gin.H{"app_id": appID, "enabled": true, "changed": true}})
}

// SettingWasmLimits 是平台限制项（并发/内存）的设置键（与 cmd/server 的持有者同名同义）。
const SettingWasmLimits = "wasm.limits"

// limitsView 组装控制台要的完整视图（GET 与 PUT 返回同一形状）。
//
// 视图里同时给出：当前值、来源、默认值、档位预设、取值区间、四笔账预览与
// "哪些改动要重启"。**预算判定用服务端读到的可用内存**（客户端算不了），
// 因此前端只需要把 ok=false 的红色提示渲染出来即可，不必自己复刻公式。
//
// limitsSourceOf 读限制项来源（nil 闭包 = 装配未接线 ⇒ "default"）。
//
// 唯一实现：视图与审计都要读它，两处各写一遍判空就会出现"视图说 profile、审计说 default"。
func limitsSourceOf(fn func() string) string {
	if fn == nil {
		return "default"
	}
	return fn()
}

// limitsView 是本文件的组装入口（上面的注释描述它给出的字段）。
func (h *Handlers) limitsView() gin.H {
	cur := applimits.Defaults()
	if h.opt.Limits != nil {
		cur = h.opt.Limits()
	}
	source := limitsSourceOf(h.opt.LimitsSource)
	var available int64
	if h.opt.MemoryAvailable != nil {
		available = h.opt.MemoryAvailable()
	}
	var pending []string
	if h.opt.LimitsRestart != nil {
		pending = h.opt.LimitsRestart()
	}
	if pending == nil {
		pending = []string{}
	}
	// 部署档位名（memprofile.Name）：**即使当前值来自控制台设置也要下发** ——
	// "控制台值 vs 档位值"是排查"我改了设置到底生效没有"的第一对照
	//（P0-2 的现场就是两者长期不一致而无人可见）。
	profile := ""
	if h.opt.LimitsProfile != nil {
		profile = h.opt.LimitsProfile()
	}
	// 四笔账的来源标签：如实反映当前数值来自"控制台设置 / 哪个部署档位 / 默认"。
	// 旧实现把 Profile 硬写成 "settings"（P0-2），与旁边的 source 字段直接矛盾。
	budgetSource := "limits/" + source
	if source != "setting" && profile != "" {
		budgetSource = "limits/profile:" + profile
	}
	return gin.H{
		"limits":   cur,
		"source":   source,
		"profile":  profile,
		"defaults": applimits.Defaults(),
		"presets": gin.H{
			"default": applimits.Defaults(),
			"small":   applimits.FromProfile(memprofile.Small()),
			"large":   applimits.FromProfile(memprofile.Large()),
		},
		"ranges": applimits.Ranges(),
		// 预算的来源标签与启动自检（wasmLimitsHolder.Plan）同一形态：两处口径一致，
		// 管理员才能把控制台的账与启动日志的账对上。
		"budget":       cur.BudgetFor(available, budgetSource),
		"source_label": limitsSourceLabel(source, profile),
		// 水位比例与预算判定同一真源（前端编辑期预览要复刻这个公式）。
		"guard_percent": limits.MemoryPeakGuardPercent,
		// 哪些字段属于"改了要重启"（前端据此在保存后弹提示）。
		"restart_fields":  []string{"instance_memory_mb"},
		"restart_pending": pending,
		"setting_key":     SettingWasmLimits,
	}
}

// limitsSourceLabel 把 source(+档位名) 折成控制台可直接显示的一句话。
//
// 服务端给这句话（而不是让前端自己拼）：档位名与来源语义都住在服务端，
// 前端各自拼一次就会出现两套口径（本仓已有过这类分叉）。
func limitsSourceLabel(source, profile string) string {
	switch source {
	case "setting":
		return "控制台保存（" + SettingWasmLimits + "）"
	case "profile":
		if profile != "" {
			return "部署档位 " + profile + "（" + memprofile.EnvMemoryProfile + "）"
		}
		return "部署档位（" + memprofile.EnvMemoryProfile + "）"
	default:
		if profile != "" {
			return "编译期默认（档位 " + profile + "）"
		}
		return "编译期默认"
	}
}

// AdminLimitsGet 读当前平台限制项 + 四笔账预览。
func (h *Handlers) adminLimitsGet(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	c.JSON(http.StatusOK, h.limitsView())
}

// limitsEnvelopeKey 是 `PUT /wasm-apps/limits` 顶层信封的**唯一**合法键。
const limitsEnvelopeKey = "limits"

// validateLimitsEnvelope 校验限制项保存请求的**顶层信封**（P2-1，2026-09-20 本机实测）。
//
// 规则两条，都是 400 fail-loud：
//   - 出现 `limits` 以外的顶层键 ⇒ 拒（`field` = 排序后的第一个未知键）；
//   - 没有 `limits` 键 ⇒ 拒（**不是**"当成清空设置"）。
//
// 为什么必须这么严（现场）：旧实现 `struct{ Limits *json.RawMessage }` 在**扁平** body
// （把 11 个字段直接放顶层）下 `Limits` 为 nil ⇒ `raw=""` ⇒ LimitsApply 按"清空设置"
// 处理 ⇒ **静默回落到部署档位**，响应还是 200 且不写审计 —— 管理员以为保存成功了，
// 而调好的限制项已经被重置。"发错形状"绝不能有副作用：回落档位是**显式动作**
// （`{"limits":null}`），不是误用的默认分支。
//
// 为什么不用 `DisallowUnknownFields`：`bindJSONLimited` 是全局共用的，它的注释写明
// "请求体的新增字段必须向后兼容（老客户端 + 新服务端）"。这里的严格性只针对本端点
// 自己的信封，所以先取原始键集合、再逐键判定 —— 也只有键集合能同时发现上面两类误用。
//
// `field` / `allowed` / `hint` 三件套与其余管理端 400 同口径（调用方据此直接改请求，
// 不必靠猜）。未知键**排序**后取第一个：map 迭代无序，不排序会让同一份请求在不同
// 进程里报出不同的 `field`，用例与日志都没法比对。
//
// ⚠️ **已知并接受的边界：顶层重复键按 JSON 的 last-wins 语义**（2026-09-20 审计观察项）。
// `{"limits":<合法对象>,"limits":null}` 经 `map[string]json.RawMessage` 解码后只剩后一个
// ⇒ 执行"清空设置"。**为什么不拒**：①这是所有主流 JSON 解析器的一致语义（RFC 8259
// 允许重复名、只要求"行为可预测"，Go 的规则明确且稳定），拒它需要在 `bindJSONLimited`
// 之外再做一遍 token 级扫描（自己处理体积上限/空体/尾随内容/错误信封），
// 用一份新实现换掉一段已被大量用例覆盖的公共解析路径，风险大于收益；
// ②清空**不是一个危险动作**，且现在已经完全可观测：`{"limits":null}` 会真删设置行、
// 响应回显 `source` 从 `setting` 变成 `profile`/`default`，并写一条 `wasm_limits_change`
// 审计（明细含「来源 setting → profile」）——调用方一眼能看出自己触发了清空，重新保存
// 即可恢复；③真正需要防的"静默回落到部署档位"（扁平 body 误用）已由上面的键集合
// 校验挡住（那条路径**零副作用**）。判据：`TestAdminLimitsPutDuplicateTopLevelKeyIsLastWinsAndObservable`。
func validateLimitsEnvelope(envelope map[string]json.RawMessage) *apperr.Error {
	unknown := make([]string, 0, len(envelope))
	for k := range envelope {
		if k != limitsEnvelopeKey {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return apperr.New(apperr.CodeValidation,
			fmt.Sprintf("请求体含未知顶层字段：%s", unknown[0])).
			WithDetail("field", unknown[0]).
			WithDetail("allowed", []string{limitsEnvelopeKey}).
			WithHint(`限制项必须整体包在 limits 键里：{"limits":{…完整字段…}}（字段名以 GET /limits 为准）。` +
				`扁平放在顶层会被拒 —— 否则"发错形状"会被当成"清空设置"而静默回落部署档位`)
	}
	if _, ok := envelope[limitsEnvelopeKey]; !ok {
		return apperr.New(apperr.CodeValidation, "请求体缺少 limits 键").
			WithDetail("field", limitsEnvelopeKey).
			WithDetail("allowed", []string{limitsEnvelopeKey}).
			WithHint(`正确形态：{"limits":{…完整字段…}}（字段名以 GET /limits 为准）；` +
				`要清空设置、真正回落到部署档位（删除库里的 wasm.limits 行，source 随之变回 profile/default）` +
				`请**显式**传 {"limits":null}`)
	}
	return nil
}

// AdminLimitsPut 保存平台限制项（`{"limits":null}` ⇒ **真删设置行**、回到部署档位/默认）。
//
// 校验/四笔账/落库（写行或**删行**）/下发全部在注入的 LimitsApply 里完成（那些知识住在
// 装配侧）；本函数只负责：解析 body → 校验顶层信封 → 调它 → 写审计 → 回读视图
// （含 restart_pending）。
//
// 审计条件（AUD-2，2026-09-20）：**值变化或来源变化都要留痕**。旧实现只比 `next != old`，
// 于是"存的值恰好等于档位值、但控制台行被清掉"这次运维动作（来源 setting → profile）
// 不留任何审计 —— 而它恰恰是"我到底还有没有一条钉死的设置"这个问题的答案。
func (h *Handlers) adminLimitsPut(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	admin := serverauth.AdminUser(c)
	if admin == nil {
		writeErr(c, apperr.New(apperr.CodeAuthRequired, "未登录"))
		return
	}
	if h.opt.LimitsApply == nil {
		writeErr(c, apperr.New(apperr.CodeInternal, "平台限制项不可配置（装配未注入）").
			WithHint("服务端未提供限制项保存钩子：请升级服务端或检查部署装配"))
		return
	}
	// 顶层信封先落成**键集合**再判定：扁平 body / 多键 body 在这里就被拦住，绝不进
	// LimitsApply（否则"清空设置"这条分支会被误用形态命中）。
	var envelope map[string]json.RawMessage
	if berr := bindAdminJSON(c, &envelope); berr != nil {
		writeErr(c, berr)
		return
	}
	if aerr := validateLimitsEnvelope(envelope); aerr != nil {
		writeErr(c, aerr)
		return
	}
	raw := ""
	if limits, ok := envelope[limitsEnvelopeKey]; ok && string(limits) != "null" {
		raw = string(limits)
	}
	old := h.opt.Limits()
	oldSource := limitsSourceOf(h.opt.LimitsSource)
	restart, aerr := h.opt.LimitsApply(raw)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	next := h.opt.Limits()
	newSource := limitsSourceOf(h.opt.LimitsSource)
	if next != old || newSource != oldSource {
		detail := fmt.Sprintf("平台限制项 %s → %s", old.Encode(), next.Encode())
		if newSource != oldSource {
			detail += fmt.Sprintf("（来源 %s → %s）", oldSource, newSource)
		}
		if len(restart) > 0 {
			detail += fmt.Sprintf("（需重启生效：%v）", restart)
		}
		h.auditOrg(admin.Username, "wasm_limits_change", detail)
	}
	view := h.limitsView()
	view["restart_pending"] = restart
	c.JSON(http.StatusOK, view)
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
		appstore.TransferOwnerAuditDetail(serverstore.AppKindWasmApp, appID, auditTitleOf(app), app.Owner, owner))
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
			auditDetail(appID, auditTitleOf(app), "冻结（管理员处置；停止服务 + 进入只读快照保留期）"))
		// 冻结 = 停止服务（appserver 对冻结应用直接 404）⇒ 进程内驻留没有留着的理由。
		// 与发布者下架路径共用同一钩子（P1-8：管理端此前不逐出）。
		h.evictApp(appID)
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
		auditDetail(appID, auditTitleOf(app), "解冻（enabled 保持不变）"))
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
	return h.loadAdminApp(c, appID, false)
}

// loadAdminApp 载入应用；allowDeleted = true 时**允许已退役**的行通过。
//
// 为什么诊断面要放行已退役：R37 的保留期内，管理员排障的第一现场恰恰是
// "这个已经退役的应用为什么一直报错"；与员工面 diagnostics 的
// `ownedApp(c, appID, true)` 同一口径（同一个只读动作，两侧看得到的东西必须一样）。
func (h *Handlers) loadAdminApp(c *gin.Context, appID string, allowDeleted bool) (*serverstore.WasmApp, *apperr.Error) {
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
	if app.DeletedAt != nil && !allowDeleted {
		return nil, apperr.New(apperr.CodeNotFound, "应用已退役（已删除）").
			WithDetail("app_id", appID).
			WithHint("已删除的应用不能再处置；R37 的\"真删\"由后台任务执行")
	}
	return app, nil
}

// ===========================================================================
// 管理面诊断（P1-9）：管理员排障不再需要借发布者的令牌
// ===========================================================================
//
// 审计现场：平台有完整的诊断能力（diag 包 + wasm_call_events 表），但唯一出口
// `/api/client/v2/apps/wasm/:app_id/diagnostics` 在**员工 Bearer 面**且鉴权是
// "发布者本人" —— 管理会话调不到，页面上也没有入口。管理员排障只有两条路：
// 找发布者，或用员工令牌手搓 curl。
//
// 这里只加**管理面出口**（capability:read），不碰员工面的鉴权语义：发布者面
// 继续是"只有作者能看自己的应用"，管理面是"管理员能看全部"。两份出口共用
// read.go 的 diagnosticsPayload，因此同一个应用在两侧给出**同一份**失败码/
// 计数/hints（两处各拼一次必然漂移）。

// AdminDiagnostics 是管理面诊断（只读）：近期失败码/计数/hints/保留期。
func (h *Handlers) adminDiagnostics(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, aerr := h.loadAdminApp(c, appID, true)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	body, derr := h.diagnosticsPayload(c, appID, app)
	if derr != nil {
		writeErr(c, derr)
		return
	}
	// 管理面比员工面多给一行"这个应用归谁"：管理员拿到失败码之后的下一个动作
	// 通常是"找负责人"，让他再去别的页面查一次归属没有意义。
	body["owner"] = app.Owner
	c.JSON(http.StatusOK, gin.H{"diagnostics": body})
}

// ===========================================================================
// 平台级运行时水位（P1-9 / P2-4 的只读出口）
// ===========================================================================
//
// 平台里有一批"零出口"的水位（模块缓存、应用库句柄），只有包内方法或没人
// 调用的导出方法。这里给管理面一个**只读**入口，让管理员不查库、不看日志也能
// 回答"现在的内存/队列/缓存水位如何"。
//
// 只暴露**已经注入到本包**的访问器（Compiler / Events / Ready）：其余几项是
// appserver 的私有方法（moduleCache / appDBPool）。**如实列出"缺哪个、接哪里"**
// （unavailable 段），而不是静默省略 —— 管理员必须能区分"这个数是 0"和
// "这个数没有出口"。（原文另列的两项 —— `anonlimit.Limiter.Stats` 与
// `aichat.Client.RevokeFailures` —— 已随 W4 删除，条目同步移除。）

// runtimeUnavailable 返回当前**没有出口**的水位清单（名称/原因/接线位置）。
//
// 这是数据面诚实性的一部分：新增可注入访问器后必须同步删掉对应条目，
// 否则页面会把"已经接好了"一直显示成"还没接"。
func runtimeUnavailable() []gin.H {
	return []gin.H{
		{
			"name":   "module_cache",
			"reason": "进程内编译模块缓存（条目/字节）住在 appserver 的私有 moduleCache 上，没有导出访问器",
			"wiring": "appserver.Server 增加 ModuleCacheStats() (entries int, bytes int64)，再经 api.Options 注入",
		},
		{
			"name":   "appdb_handles",
			"reason": "应用库句柄数住在 appserver 的私有 appDBPool 上（pool.size()），没有导出访问器",
			"wiring": "appserver.Server 增加 AppDBPoolStats() (handles int, max int)，再经 api.Options 注入",
		},
	}
}

// AdminRuntime 是平台级运行时水位（只读）：编译/执行/事件/磁盘 + 缺口清单。
func (h *Handlers) adminRuntime(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	view := gin.H{
		"captured_at": h.now().UTC(),
		"unavailable": runtimeUnavailable(),
	}
	// 编译面（Compiler 是构造 Handlers 时注入的强依赖之一）。
	if h.opt.Compiler != nil {
		st := h.opt.Compiler.Stats()
		view["compile"] = gin.H{
			"queue_depth":       st.QueueDepth,
			"queue_capacity":    st.QueueCapacity,
			"compiling":         st.Compiling,
			"child_running":     st.ChildRunning,
			"cache_bytes":       st.CacheBytes,
			"cache_entries":     st.CacheEntries,
			"cache_max_bytes":   st.CacheMaxBytes,
			"cache_max_entries": st.CacheMaxEntries,
			"compiles":          st.Compiles,
			"failures":          st.Failures,
			"timeouts":          st.Timeouts,
			"last_compile_ms":   st.LastCompileMS,
		}
	}
	// 调用事件 sink 的丢/失败计数：诊断面自己"有没有在丢数据"是排障的前提。
	if h.opt.Events != nil {
		view["events"] = gin.H{
			"written": h.opt.Events.Written(),
			"dropped": h.opt.Events.Dropped(),
			"failed":  h.opt.Events.Failed(),
		}
	}
	// readyz 快照：执行槽与磁盘余量（与 /readyz 探针同一份采集，不另写一份判据）。
	if h.opt.Ready != nil {
		s := h.opt.Ready.Snapshot()
		view["exec"] = gin.H{"running": s.ExecRunning, "waiting": s.ExecWaiting}
		view["disk"] = gin.H{"free_bytes": s.DiskFreeByte}
		view["ready"] = s.OK
		reasons := s.Reasons
		if reasons == nil {
			reasons = []string{}
		}
		view["ready_reasons"] = reasons
	}
	c.JSON(http.StatusOK, gin.H{"runtime": view})
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
