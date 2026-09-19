package llmgateway

import (
	"log"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// 应用维度归因（迁移 0076 / 契约 §21.4）。
//
// 背景：应用内的 AI 调用走**员工自己的** LLM 链路（密钥在服务端、计费进使用者账户），
// 因此 usage 行天然只带 user_id。客户端在出站请求上带 `X-Pico-App-Id`，网关把它记进
// `usage.app_id` —— 于是"这个应用吃掉多少 AI 成本"可以一条 SQL 答出来。
//
// 三条纪律（与迁移 0076 的注释逐条对应）：
//
//	① **best-effort**：头缺失/非法 ⇒ 记空串，绝不影响计费（`SetUsageAppID` 内部
//	   对空标签直接返回，连 UPDATE 都不发）；
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

// appIDHeader 是应用标识的**出站**头名（客户端 → 平台）。
//
// 与 `X-Pico-App-Proof`（持有性证明）刻意分成两个头：一个是"是谁在调用"的密码学
// 证明，一个是"为哪个应用记账"的**自报标签**。合并会让"标签缺失"看起来像"证明失败"。
const appIDHeader = "X-Pico-App-Id"

// appIDFromRequest 读并规范化本次请求声明应用标识（缺失/非法 ⇒ 空串 = 无归因）。
//
// 只从**头**读，不从请求体/查询串读：归因标签必须与认证发生在同一层
// （同一份凭证的语义），而请求体/查询串是应用可控的更深一层输入。
func appIDFromRequest(c *gin.Context) string {
	if c == nil {
		return ""
	}
	return serverstore.SanitizeUsageAppID(c.GetHeader(appIDHeader))
}

// bindUsageAppID 把本次请求声明的应用标识绑到一行 usage 上（best-effort）。
//
// 失败**不**返回错误、也**不**改变响应：归因是统计口径，它的问题不该让一次正常的
// LLM 调用失败（与 §8.9「计数失败不影响打开」同一条纪律）。失败会记一条日志，
// 因为"归因静默消失"在运营面上与"没人用"长得一样。
func (a *API) bindUsageAppID(c *gin.Context, usageID int64) {
	if a == nil || usageID <= 0 {
		return
	}
	appID := appIDFromRequest(c)
	if appID == "" {
		return
	}
	if err := serverstore.SetUsageAppID(a.DB, usageID, appID); err != nil {
		log.Printf("gateway: 应用维度归因失败（不影响计费）usage_id=%d app_id=%s: %v", usageID, appID, err)
	}
}
