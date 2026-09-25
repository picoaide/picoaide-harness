package llmgateway

import (
	"log"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// 应用维度归因（迁移 0076 / 契约 §21.4 / §21.7⑤）。
//
// 背景：应用内的 AI 调用走**员工自己的** LLM 链路（密钥在服务端、计费进使用者账户），
// 因此 usage 行天然只带 user_id。客户端在出站请求上带**会话 id**（上游
// `llm-deepseek` 的 `x-deepseek-harness-session-id`，值就是该轮的会话 id），而应用 AI
// 的隐藏会话 id 带 `app:` 前缀 ⇒ 网关按前缀派生 `app_id` 并记进 `usage.app_id` ——
// 于是"这个应用吃掉多少 AI 成本"可以一条 SQL 答出来。
//
// ## 这个标签的信任等级（R14-K · D-04：口径必须与代码判据逐字一致）
//
// ⚠️ **标签的值完全来自客户端请求头，它不是服务端可验证的事实**。初版设计的
// `X-Pico-App-Id` 在客户端发不出来（§21.7⑤：出站头唯一构造点没有 header 通道），
// 于是改成读隐藏会话 id 的 `app:` 前缀 —— 但**前缀同样由客户端构造**：任何持员工
// Bearer 的调用方都能发 `x-deepseek-harness-session-id: app:<任意 app_id>#…`。
//
// 服务端**校验**两件事（`SetUsageAppIDVerified`，同一个已钉事务里）：
//
//	① **形状**：`app_session_id.go` 的权威规则（小写、长度、字符集）——不合形状 ⇒ 无归因；
//	② **存在性**：`apps` 里必须有一行 `kind='wasm_app' AND app_id=<label> AND deleted_at IS NULL`
//	   ——2026-09-23 之前**没有**这一条，实测能把用量记到 `brand-new-not-in-db`
//	   这种平台上根本不存在的应用上（管理端如实统计，`attribution_available=true`）。
//
// 服务端**不校验**（也没有能力校验，不要读成"已校验"）：
//
//	③ **调用方与该应用的关系**：员工使用他人的应用是正常业务，所以"必须是 owner"
//	   是错的判据；而"该会话确属该应用"今天没有服务端凭据链路可查（隐藏会话是
//	   客户端本地概念，网关看到的只有一个请求头）⇒ 把用量记到**另一个真实存在**的
//	   应用上仍然可能。
//
// 结论（webadmin 面板文案与本节由 `opens-contract-parity.spec.ts` 同族对拍）：
// 应用维度成本是**参考口径**，可被任何员工污染，**不得**用于对账、计费或授权判定。
// 唯一可信的账是 `usage.user_id` 那一侧（它来自鉴权中间件，不来自请求头）。
//
// 三条纪律（与迁移 0076 的注释逐条对应）：
//
//	① **best-effort**：头缺失/不是应用会话/非法/应用不存在 ⇒ 记空串，绝不影响计费
//	   （`SetUsageAppIDVerified` 内部对空标签直接返回，连 UPDATE 都不发）；
//	② **不参与计费**：cost / 余额 / 账本三者的计算完全不读这一列 —— 它只是标签，
//	   改它永远不该改变任何金额（否则"伪造一个头就能改价"）；
//	③ **不扫全表**：归因写成 post-hoc 的单行 UPDATE（与既有的 `SetUsageProvider`
//	   同一手法），不把 app_id 塞进 4 条计费 INSERT 的参数列表 —— 计费 SQL 的列集
//	   每改一次都是一次真实的回归风险，而这是它唯一不参与的列。
//
// ⚠️ 为什么归因写在"记账之后"而不是"请求开头"：usage 行的 id 只有 insert 之后才有。
// 流式请求的 pending 行（`beginStreamUsage`）与一次性结算行都拿到了 id，两处都绑。
// 代价是"插行与 UPDATE 之间进程崩溃"会丢一次归因（可接受：归因是统计口径，
// 而扣费与落账在同一事务里，不受影响）。

// appIDFromRequest 读本次请求的**应用会话链路**并派生应用标识（无归因 ⇒ 空串）。
//
// 只认会话 id 的 `app:` 前缀（见 `app_session_id.go` 的长注释）：自报头
// `X-Pico-App-Id` 被显式忽略并记一条日志 —— "归因静默消失"在运营面上与"没人用"长得
// 一样，所以忽略这件事必须留下痕迹。
//
// ⚠️ 这里只做**形状**判定（授权/存在性在 bindUsageAppID 里，同一个已钉事务内）。
// 返回值是"客户端声称的应用"，不是"已证实的事实"。
func appIDFromRequest(c *gin.Context) string {
	if c == nil {
		return ""
	}
	if sessionID := c.GetHeader(appSessionIDHeaderName()); sessionID != "" {
		return AppIDFromSessionID(sessionID)
	}
	if selfDeclared := c.GetHeader(legacyAppIDHeader); selfDeclared != "" {
		log.Printf("gateway: 忽略没有会话链路的应用归因头 %s（应用维度归因只认会话 id 的 %q 前缀）",
			legacyAppIDHeader, appSessionID.Prefix)
	}
	return ""
}

// bindUsageAppID 把本次请求声明的应用标识绑到一行 usage 上（best-effort）。
//
// 失败**不**返回错误、也**不**改变响应：归因是统计口径，它的问题不该让一次正常的
// LLM 调用失败（与 §8.9「计数失败不影响打开」同一条纪律）。失败会记一条日志，
// 因为"归因静默消失"在运营面上与"没人用"长得一样。
//
// 三种结局都留痕（R14-K · D-04）：
//
//	标签为空（非应用会话/形状非法）      ⇒ 静默返回（这是绝大多数请求的常态）；
//	标签不指向真实应用（伪造/应用已删）  ⇒ **记一条 warn**（旧实现会照写，把不存在的
//	                                     应用写进成本统计）；
//	写库失败                            ⇒ 记一条 warn（既有行为）。
func (a *API) bindUsageAppID(c *gin.Context, usageID int64) {
	if a == nil || usageID <= 0 {
		return
	}
	appID := appIDFromRequest(c)
	if appID == "" {
		return
	}
	written, err := serverstore.SetUsageAppIDVerified(a.DB, usageID, appID)
	if err != nil {
		log.Printf("gateway: 应用维度归因失败（不影响计费）usage_id=%d app_id=%s: %v", usageID, appID, err)
		return
	}
	if !written {
		log.Printf("gateway: 丢弃应用维度归因（不影响计费）：app_id=%q 不是本平台上存在且未删除的 wasm 应用 usage_id=%d",
			appID, usageID)
	}
}
