package api

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/edge"
)

// openApp 是 `POST /api/client/v2/apps/wasm/:app_id/open`（契约 §5.1b / §8.9，F16）。
//
// 为什么需要这个端点（而不是让客户端直接请求应用首页）：
//   - **版本闸门**：客户端缓存键含 version，而 version 的唯一权威是服务端。每次
//     "打开"动作（新建窗口或聚焦已有窗口）调一次，客户端据此决定清不清缓存
//     （`changed=true` ⇒ 清掉该应用在当前 session-scope 下的**全部**版本缓存）；
//   - **运营计数**：本次调用即记一次打开（PV 式，不去重），UV 由聚合查询承担。
//
// 三条冻结语义（逐条都在代码里）：
//
//	① **每次调用 +1**：计数写在 open 端点，不写在应用请求路径上（否则"一次打开"
//	   会变成"每请求一次"，PV 失去意义）；
//	② **计数 best-effort**：计数异常只 warn，不改响应、不阻塞打开（§8.9）；
//	③ **成功响应带 `X-PicoAide-App-Version`**：客户端的缓存键来源（R1-DAT-12 /
//	   R2I-21），与 `request` 端点的版本头同源同值。
//
// 闸门强度（§5.1b，客户端侧负责执行）：新建窗口 = **硬闸门**（本端点失败 ⇒
// 本地错误页 + 重试，不用旧缓存）；聚焦已有窗口 = **软闸门**（保留内容 + 横幅 + 重试）。
func (h *Handlers) openApp(c *gin.Context) {
	user, aerr := h.currentUser(c)
	if aerr != nil {
		h.admissionFailed(c, "", nil, aerr.Status(), aerr.Code, "open: 身份不可用")
		writeErr(c, aerr)
		return
	}
	appID := strings.ToLower(strings.TrimSpace(c.Param("app_id")))
	if aerr := h.validateAppID(appID); aerr != nil {
		h.admissionFailed(c, appID, user, aerr.Status(), aerr.Code, "open: app_id 非法")
		writeErr(c, aerr)
		return
	}
	// 顺序（契约 §20.1）：BearerAuth（中间件）→ app-proof → 应用反查。
	// proof 在应用反查之前：它绑 app_id 且是"谁是调用方"的判据，先挡下来再谈
	// "这个应用在不在"——否则未持证明的探测也能枚举应用是否存在。
	// open 每次都要计数（状态变更）⇒ 恒按非幂等消费 jti。
	if !h.requireProof(c, appID, user, false) {
		return
	}

	var body struct {
		// CurrentVersion 是**客户端缓存的版本**（可空：首次打开/缓存已清）。
		CurrentVersion string `json:"current_version"`
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxOpenRequestBytes)
	dec := json.NewDecoder(c.Request.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		h.admissionFailed(c, appID, user, http.StatusBadRequest, apperr.CodeValidation, "open: 请求体非法")
		writeErr(c, apperr.New(apperr.CodeValidation, "打开请求不是合法 JSON").
			WithDetail("reason", "decode_failed").
			WithHint(`形如 {"current_version":"1.2.3"}（首次打开传空串）`))
		return
	}
	current := strings.TrimSpace(body.CurrentVersion)

	// ===== 应用准入（与管线同一套判据，错误分层见文件头）=====
	app, err := serverstore.GetWasmAppByHost(c.Request.Context(), h.opt.DB, appID)
	switch {
	case errors.Is(err, serverstore.ErrNotFound):
		h.admissionFailed(c, appID, user, http.StatusNotFound, apperr.CodeNotFound, "open: app_not_found")
		writeErr(c, apperr.New(apperr.CodeNotFound, "应用不存在").
			WithDetail("reason", "app_not_found").
			WithHint("该应用未在本平台登记；请回到应用中心刷新目录"))
		return
	case err != nil:
		writeErr(c, apperr.New(apperr.CodeInternal, "平台暂时不可用").
			WithHint("这是平台侧故障（数据库不可达）；请稍后重试"))
		return
	}
	if app == nil || app.DeletedAt != nil || app.FrozenAt != nil {
		// **两档，不是三档**（R2-L1-2 主控裁定 (b)，2026-09-20）：
		//
		//	· 冻结 ⇒ `app_frozen`（文案独立：只读快照、数据仍在）；
		//	· 软删 ⇒ `app_not_found`，与"从未登记"**同档同 reason**。
		//
		// 为什么软删不单独一档（而不是"漏了"）：
		//  ① 契约 §7.7② 给"已删除"的用户可见文案本来就是「应用不存在」，与"从未登记"
		//     逐字相同 —— 只有冻结档的文案与下一步动作不同；
		//  ② `serverstore.GetWasmAppByHost` 的 WHERE 带 `deleted_at IS NULL` ⇒ 软删行
		//     在 DAO 层就返回 ErrNotFound，上面那个分支已经按 app_not_found 出口；
		//  ③ 要"真区分"就得新开一条"含软删"的 DAO 查询路径 ⇒ 多一个存在性判据，
		//     而文案契约并不要求区分（多出来的信息只对枚举者有用）。
		// ⇒ 旧代码里 `reason = "app_deleted"` 那一支**永不可达**（只有 DAO 返回带
		// DeletedAt 的行才可能命中），留着它就是"语义已死却能被当成活契约"的依据 ——
		// 已删。下面的 `nil` / `DeletedAt` 判定保留为**纵深防御**（"退役即停止路由"
		// 是安全语义），但它们与未登记共用同一份 reason/文案，不构成第三个取值。
		reason, message, hint := "app_not_found", "应用不存在", "该应用未在本平台登记或已退役；请回到应用中心刷新目录"
		if app != nil && app.FrozenAt != nil {
			reason = "app_frozen"
			message = "应用已被管理员停用（冻结）"
			hint = "冻结是只读快照：数据仍然保留，但不能继续使用；如需恢复请联系平台管理员"
		}
		h.admissionFailed(c, appID, user, http.StatusNotFound, apperr.CodeNotFound, "open: "+reason)
		writeErr(c, apperr.New(apperr.CodeNotFound, message).
			WithDetail("reason", reason).
			WithHint(hint))
		return
	}
	if !app.Enabled {
		// 410 而不是 404：这是**有意**的下架（与管线的 writeGone 同口径），
		// 客户端要能把"这个应用被下架了"与"这个应用不存在"分开显示。
		h.admissionFailed(c, appID, user, http.StatusGone, apperr.CodeNotFound, "open: 应用已下架")
		writeErr(c, apperr.New(apperr.CodeNotFound, "应用已下架").
			WithStatus(http.StatusGone).
			WithHint("应用数据仍然保留；如需恢复使用，请联系应用发布者或平台管理员"))
		return
	}

	rel, rerr := serverstore.LatestApprovedWasmReleaseMeta(c.Request.Context(), h.opt.DB, appID)
	switch {
	case errors.Is(rerr, serverstore.ErrNotFound):
		h.admissionFailed(c, appID, user, http.StatusNotFound, apperr.CodeNotFound, "open: 无可用版本")
		writeErr(c, apperr.New(apperr.CodeNotFound, "应用还没有可用版本").
			WithHint("该应用已登记，但还没有审核通过的版本；请应用发布者发布一个版本"))
		return
	case rerr != nil:
		writeErr(c, apperr.New(apperr.CodeInternal, "平台暂时不可用").
			WithHint("这是平台侧故障（数据库不可达）；请稍后重试"))
		return
	}

	// ===== 计数（best-effort，§8.9 / §5.1b）=====
	// 放在响应之前：调用方拿到的响应不依赖它，但"这次打开"必须先记账再返回，
	// 否则客户端可能在计数落库前就跳走了（响应与计数没有原子性要求，次序只是为了
	// 让"返回了 200 却没计数"的窗口尽量小）。
	// 计数失败**绝不**冒泡：运营数据缺失是可接受的，员工打不开应用不可接受。
	counted := false
	switch {
	case h.opt.Opens == nil:
		log.Printf("api: 打开计数未装配（open 端点仍正常返回）app=%s", appID)
	default:
		if cerr := h.opt.Opens(c.Request.Context(), appID, user.ID, current); cerr != nil {
			log.Printf("api: 打开计数写入失败（不影响本次打开）app=%s user=%d: %v", appID, user.ID, cerr)
		} else {
			counted = true
		}
	}

	// `opens.today` 是"今日已被打开 N 次"（§19 Q11 / F16 ③ / §5.1b 第 1 条）：
	// 与版本校验**同一次请求**回给客户端，不新增往返、不新增端点。
	//
	// 缺省语义（§5.1b 第 2 条，**冻结**）：计数失败、或读不到今日计数 ⇒ `opens`
	// **整体省略**（缺省或 null），仍返回 200 并正常打开。**不得**回 `{"pv":0,"uv":0}`
	// 冒充"今天没人打开" —— 那会让客户端把"统计不可用"显示成一个确定的数字。
	// 客户端在缺省时**不渲染**该行（L3 侧判据）。
	var opens *openToday
	if counted {
		if pv, uv, oerr := serverstore.WasmAppOpenToday(c.Request.Context(), h.opt.DB, appID, h.now()); oerr != nil {
			log.Printf("api: 读今日打开计数失败（opens 行省略）app=%s: %v", appID, oerr)
		} else {
			opens = &openToday{Today: openCounts{PV: pv, UV: uv}}
		}
	}

	// 版本头：客户端的缓存键来源（与 `request` 端点同源同值，见 edge.AppVersionHeader）。
	c.Header(edge.AppVersionHeader, rel.Version)
	h.admissionOK(c, appID, user, "action=open; version="+rel.Version)
	// `changed` 是**唯一**权威（§5.1b：cache 字段已删除）：服务端版本 ≠ 客户端缓存
	// 的版本即 changed=true（空 current_version ⇒ 必然 true）。
	c.JSON(http.StatusOK, openResponse{
		Version:   rel.Version,
		ReleaseID: rel.ID,
		Title:     openTitle(app.Title, rel.Title),
		Changed:   rel.Version != current,
		Opens:     opens,
	})
}

// openResponse 是 open 端点的成功响应（§5.1b 冻结）。
//
// `Opens` 用**指针 + omitempty**：契约明写"计数失败或查不到时该行缺省或为 null，
// 不得回 0 冒充今天没人打开"。用指针是唯一能同时表达"没有这个值"与"值是 0"的形态
// （`int64` 的零值会让两者不可区分 —— 正是契约要禁止的那件事）。
type openResponse struct {
	Version   string     `json:"version"`
	ReleaseID int64      `json:"release_id"`
	Title     string     `json:"title"`
	Changed   bool       `json:"changed"`
	Opens     *openToday `json:"opens,omitempty"`
}

// openToday 是"今日打开情况"（§5.1b 第 1 条的 `opens.today`）。
type openToday struct {
	Today openCounts `json:"today"`
}

// openCounts 是 PV/UV 两个计数（PV 不去重、UV 按 user_id 去重，口径见 §8.9）。
type openCounts struct {
	PV int64 `json:"pv"`
	UV int64 `json:"uv"`
}

// maxOpenRequestBytes 是 open 请求体的上限（只有 current_version 一个字段）。
//
// 与信封（≤1 MiB×4/3+64 KiB）刻意分开：open 是"每次打开一次"的轻请求，
// 4 KiB 足够（版本号长度由 limits.AppVersionMaxLen 约束），而给它一个 1 MiB 的
// 上限纯属把未认证面变成内存放大器。
const maxOpenRequestBytes = 4 << 10

// openTitle 选择 open 响应里的 title。
//
// 单一权威 = **应用级标题**（apps.title）：应用中心的卡片显示的就是它，窗口标题
// （§7.2：`<应用名> · <产品名>`）也必须与之一致 —— 否则同一个应用在两个界面里
// 有两个名字。release.title 只在应用行为空的历史行上兜底（0069 之前手工写入的行）。
func openTitle(appTitle, releaseTitle string) string {
	if t := strings.TrimSpace(appTitle); t != "" {
		return t
	}
	return strings.TrimSpace(releaseTitle)
}
