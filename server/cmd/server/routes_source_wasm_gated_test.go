//go:build apps

package main

// 本文件是 `d.Wasm == nil` 时整片消失的路由声明表（P1 第二片，2026-10-14 起按模块分文件）。
//
// 为什么按模块分文件：`apps` 未编入本变体时**没有 wasm 路由可被门控** —— Wasm 字段是
// 空类型、恒为 nil，置零当然不会让任何路由消失。把声明表留在这里（而不是删掉或改成
// 恒真）让判据在两种变体下都自证：编入时逐条对拍，未编入时断言表为空且树上确无 wasm 路由。

// wasmGatedRoutes：d.Wasm == nil 时整片消失（internal/router/registerWasm 的首行）。
var wasmGatedRoutes = []string{
	// 客户端面 /api/client/v2/apps/wasm（BearerAuth）
	"POST /api/client/v2/apps/wasm/validate",
	"POST /api/client/v2/apps/wasm/:app_id/releases",
	"POST /api/client/v2/apps/wasm/:app_id/publish",
	"POST /api/client/v2/apps/wasm/:app_id/unpublish",
	"POST /api/client/v2/apps/wasm/:app_id/freeze",
	"GET /api/client/v2/apps/wasm/:app_id/export",
	"DELETE /api/client/v2/apps/wasm/:app_id",
	"GET /api/client/v2/apps/wasm/:app_id/diagnostics",
	"GET /api/client/v2/apps/wasm/:app_id/schema",
	// 作者数据面（2026-09-21）：只读浏览自己应用库里的行。
	"GET /api/client/v2/apps/wasm/:app_id/rows",
	// 客户端专属访问模型（2026-09-19）：请求入口、打开校验、持有性证明（W1 新增，
	// 与 `:app_id/opens` 管理端出口一起在本轮补齐登记 —— 条件注册的漏登记形态是
	// "路由整片消失而没人发现"，这正是本表存在的理由）。
	"POST /api/client/v2/apps/wasm/:app_id/request",
	"POST /api/client/v2/apps/wasm/:app_id/open",
	"POST /api/client/v2/apps/wasm/proof",
	// R1-pm-3：发布者本人的版本历史 + 审核结论（含被拒理由）。条件注册
	// （d.Wasm == nil 时整片消失）⇒ 新增就必须登记，否则本表反向断言红。
	"GET /api/client/v2/apps/wasm/:app_id/releases",
	"GET /api/client/v2/apps/wasm/catalog",
	// 标识唯一性预查（2026-09-20）：发布表单填 app_id 时异步问它、提交前再问一次。
	// 与上面几条同理 —— 条件注册（d.Wasm == nil 时整片消失），新增就必须登记。
	"GET /api/client/v2/apps/wasm/:app_id/availability",
	// 分片上传（§4.2）
	"POST /api/client/v2/apps/wasm/uploads",
	"PUT /api/client/v2/apps/wasm/uploads/:upload_id/chunks/:index",
	"GET /api/client/v2/apps/wasm/uploads/:upload_id",
	"POST /api/client/v2/apps/wasm/uploads/:upload_id/complete",
	"DELETE /api/client/v2/apps/wasm/uploads/:upload_id",
	// 管理面 /api/server/admin/wasm-apps（AdminRoute + RBAC 申报）
	"GET /api/server/admin/wasm-apps",
	"POST /api/server/admin/wasm-apps/:app_id/unpublish",
	"POST /api/server/admin/wasm-apps/:app_id/publish",
	"PUT /api/server/admin/wasm-apps/:app_id/owner",
	"POST /api/server/admin/wasm-apps/:app_id/freeze",
	"PUT /api/server/admin/wasm-apps/review",
	"GET /api/server/admin/wasm-apps/limits",
	"PUT /api/server/admin/wasm-apps/limits",
	// 2026-09-19 审核闭环 + 运行诊断（router.go 已随本轮提交进仓 ⇒ 按约定登记）。
	// 与本站的历史注释对照：这 5 条曾只存在于并发会话工作树、未提交，那时把它们
	// 写进本表会让"干净提交态"报"声明表里的路由并未消失"；现在它们已在提交面内，
	// 不登记则反向报"消失却没登记"。
	"GET /api/server/admin/wasm-apps/:app_id/releases",
	"POST /api/server/admin/wasm-apps/:app_id/releases/:version/approve",
	"POST /api/server/admin/wasm-apps/:app_id/releases/:version/reject",
	"GET /api/server/admin/wasm-apps/:app_id/diagnostics",
	"GET /api/server/admin/wasm-apps/runtime",
	"GET /api/server/admin/wasm-apps/:app_id/opens",
	// 客户端专属改造 W5：打开看板概览（静态段 `opens/summary`，与上一条 `:app_id/opens`
	// 同层但更具体）与按应用的 AI 用量。两条与上一批同类 —— 都是 `d.Wasm != nil` 才注册，
	// 且都**后于**本表上一轮重算落地，属同一种漏登记（守卫按实跑 diff 反向断言）。
	"GET /api/server/admin/wasm-apps/opens/summary",
	"GET /api/server/admin/wasm-apps/:app_id/ai-usage",
	// 管理面的只读数据面（2026-09-21）：表结构 + 行浏览（与员工面同实现，只差鉴权）。
	"GET /api/server/admin/wasm-apps/:app_id/schema",
	"GET /api/server/admin/wasm-apps/:app_id/rows",
}
