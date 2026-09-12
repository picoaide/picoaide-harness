package llmgateway

import (
	"database/sql"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// 余额结算失败的统一出口(FIX-05,审计 2026-09-12,P1)。
//
// 背景(上一轮 P0-C 引入的回归):settleUsageCostTx 给扣减加了余额下限,
// 「已开通但余额不足」时返回 serverstore.ErrInsufficientBalance 并让**整个
// 事务回滚**(usage 行与扣款同事务)。但调用方只 `log.Printf` 一行就继续把
// 上游响应交付给客户端,于是缺陷从"记了账没扣钱"变成了"**没记账也没扣钱**":
//
//	闸门(quotaBlocked)只看"分位余额 > 0",余额 1.00 的账户过闸;
//	上游被真调用一次(上游侧真计费);
//	结算 cost(如 8.00 元)> 余额 → ErrInsufficientBalance → 事务回滚;
//	调用方 log 后继续 → 客户端拿到 200 + 完整响应体;
//	usage 0 行、余额不变 ⇒ 同一请求可无限重复,永远免费。
//
// 用户拍板的口径:「失败即拒绝 + 不再静默」——四个调用点一律把
// ErrInsufficientBalance 升级成显式失败,不再保留 log 后继续:
//
//   - 非流式:响应体还没交付 → 429 BALANCE_EXHAUSTED(与闸门同一个错误码,
//     客户端按码分流,不需要新分支);
//   - 流式:SSE 头与部分内容可能已经写出,**不能**改状态码 → 写一条 error
//     事件后终止,不再继续泵上游内容。
//
// 非余额类错误(连接中断、分区不存在……)仍然只 log:它们不是"钱不够",
// 升级成 429 会误导客户端去充值,且响应可能已经交付。

// balanceExhaustedCode 与闸门(handler.go / messages.go / embedding.go 的
// 前置拦截)使用同一个稳定错误码。
const balanceExhaustedCode = "BALANCE_EXHAUSTED"

// balanceSettlementMessage 是结算期拦截的对外文案。与闸门文案略有区别:
// 这里上游**已经被调用过一次**,必须让用户知道本次没有交付结果。
const balanceSettlementMessage = "余额不足,本次调用未完成:请联系管理员充值"

// isBalanceSettlementFailure 判定「这个错误是余额下限拒绝的」。
// 只认 serverstore.ErrInsufficientBalance 这一个哨兵:其它错误即使发生在
// 结算路径上也不能伪装成余额问题。
func isBalanceSettlementFailure(err error) bool {
	return err != nil && errors.Is(err, serverstore.ErrInsufficientBalance)
}

// rejectBalanceSettlement 是**非流式**路径的统一出口:响应体尚未交付,
// 用 429 拒绝并且不再写任何上游内容。调用方必须立即 return。
func rejectBalanceSettlement(c *gin.Context) {
	serverauth.WriteError(c, http.StatusTooManyRequests, balanceExhaustedCode, balanceSettlementMessage)
}

// abortBalanceSettlementStream 是**流式**路径的统一出口:SSE 头已经发出,
// 状态码不可能再改,唯一合法的表达是写一条 error 事件并让调用方终止泵送。
// 事件形状与两个流式 handler 里既有的错误事件(UPSTREAM / 空闲超时)一致。
func abortBalanceSettlementStream(c *gin.Context, fl http.Flusher) {
	fmt.Fprintf(c.Writer, "data: %s\n\n",
		`{"error":{"code":"`+balanceExhaustedCode+`","message":"`+balanceSettlementMessage+`"}}`)
	if fl != nil {
		fl.Flush()
	}
}

// ---------------------------------------------------------------------------
// G5b(审计 2026-09-13):结算期**非余额类**错误同样不得静默交付
// ---------------------------------------------------------------------------
//
// 上一轮 FIX-05 只认一个哨兵(isBalanceSettlementFailure):ErrInsufficientBalance
// 升级成显式失败,其它结算错误(如真实 PG 上的编码/约束错误、死锁、连接抖动)
// 仍然只 `log.Printf` 一行就继续把上游响应 200 交付 —— 而那次结算的事务已经
// 回滚,所以同样是"上游真被调用、账上零落账零扣费",同一请求可无限重复。
// 洞的判据不是"错误可不可怕",而是**这次调用的钱有没有落地**:没落地就不能交付。
//
// 分类与出口(唯一实现,四个交付路径共用):
//
//	1. ErrInsufficientBalance(钱不够)→ 429 BALANCE_EXHAUSTED。确定的业务
//	   结论,重试无意义,也不该误导客户端"重试就会成功"。
//	2. 其它任何错误 → 503 METERING_FAILED(fail-closed,不交付上游内容)。
//	   流式:写一条 SSE error 事件并终止泵送。
//
// 为什么 fail-closed 不会因为 DB 抖动拖垮全站:
//   - 认证(BearerAuth)与余额闸门(BalanceBlocked)用的是同一个连接池;PG 整体
//     不可用时请求在**进网关之前**就已经失败,这里的拒绝不新增失效面;
//   - 幂等的**回填**结算(updateUsageTokensSettled)带有限次重试,短抖动不会
//     升级成用户可见失败;
//   - 拒绝是**每请求**的:不持全局锁、不改共享状态、不熔断后续请求,抖动窗口
//     之外立即恢复;
//   - 非流式的**插入**结算刻意不重试(插入不幂等:COMMIT 结果未知时重试会写出
//     第二行已计费 usage = 重复扣款),宁可拒绝一次,也不重复扣用户的钱。

const (
	// meteringFailedCode 是结算期非余额类失败的稳定错误码。
	meteringFailedCode = "METERING_FAILED"
	// meteringFailedMessage 是对外文案:上游已被调用过一次,必须让用户知道
	// 本次没有交付结果(可重试)。
	meteringFailedMessage = "计量结算失败,本次调用未完成:请稍后重试"
)

// rejectSettlementFailure 是**非流式**路径的统一出口。调用方必须立即 return。
func rejectSettlementFailure(c *gin.Context, err error, where string) {
	if isBalanceSettlementFailure(err) {
		log.Printf("gateway: insufficient balance, rejecting %s before delivery: %v", where, err)
		rejectBalanceSettlement(c)
		return
	}
	log.Printf("gateway: settlement failed (%s), refusing to deliver upstream body: %v", where, err)
	serverauth.WriteError(c, http.StatusServiceUnavailable, meteringFailedCode, meteringFailedMessage)
}

// abortSettlementFailureStream 是**流式**路径的统一出口:SSE 头已发出,写一条
// error 事件并让调用方终止泵送(与既有 UPSTREAM/空闲超时事件同形状)。
func abortSettlementFailureStream(c *gin.Context, fl http.Flusher, err error, where string) {
	if isBalanceSettlementFailure(err) {
		log.Printf("gateway: insufficient balance, aborting stream (%s): %v", where, err)
		abortBalanceSettlementStream(c, fl)
		return
	}
	log.Printf("gateway: settlement failed (%s), aborting stream: %v", where, err)
	fmt.Fprintf(c.Writer, "data: %s\n\n",
		`{"error":{"code":"`+meteringFailedCode+`","message":"`+meteringFailedMessage+`"}}`)
	if fl != nil {
		fl.Flush()
	}
}

// settlementBackfillAttempts 是幂等回填结算的重试次数(含首次)。
const settlementBackfillAttempts = 3

// settlementBackfillBackoff 是重试间隔基数(第 n 次重试前等 n×基数)。
const settlementBackfillBackoff = 40 * time.Millisecond

// updateUsageTokensSettled 回填 usage 并结算。回填结算在本设计里是**幂等**的
// (settleUsageCostTx 按 usage_id 的流水汇总把该行收敛到目标金额:重复执行差额
// 为 0,不会重复扣款),所以瞬时错误(死锁/连接抖动)可以安全地有限重试 ——
// 避免 DB 抖动把正常的流式请求误判成失败。余额不足不重试(重试没有意义)。
func updateUsageTokensSettled(db *sql.DB, id, promptTokens, completionTokens, cacheTokens int64) error {
	var err error
	for attempt := 1; attempt <= settlementBackfillAttempts; attempt++ {
		err = serverstore.UpdateUsageTokensCached(db, id, promptTokens, completionTokens, cacheTokens)
		if err == nil {
			return nil
		}
		if isBalanceSettlementFailure(err) {
			return err
		}
		if attempt < settlementBackfillAttempts {
			log.Printf("gateway: backfill settlement attempt %d/%d failed, retrying: %v",
				attempt, settlementBackfillAttempts, err)
			time.Sleep(settlementBackfillBackoff * time.Duration(attempt))
		}
	}
	return err
}

// estimatedBytesPerToken 是"按字节估算 token"的换算口径:约 4 字节/token,
// 保守下限(与 2026-08 起的流式兜底口径一致)。
const estimatedBytesPerToken = 4

// estimateTokensFromBytes 是字节→token 估算的**唯一实现**
// (chat/responses/completions 流式、非流式响应体、anthropic messages、
// embedding 输入侧全部共用同一口径,不再有第二份换算)。
func estimateTokensFromBytes(n int64) int64 {
	if n <= 0 {
		return 0
	}
	return n / estimatedBytesPerToken
}

// estimateEmbeddingPromptTokens 是 embedding 路径的输入侧估算(唯一实现):
// 与 estimateTokensFromBytes 同一口径,但**向上取整到至少 1** —— embedding
// 没有 completion 侧可估算,输入非空却落一条 0 token 的零费用行等于零落账。
func estimateEmbeddingPromptTokens(texts []string) int64 {
	var bytes int64
	for _, t := range texts {
		bytes += int64(len(t))
	}
	if bytes <= 0 {
		return 0
	}
	if n := estimateTokensFromBytes(bytes); n > 0 {
		return n
	}
	return 1
}

// fallbackCompletionTokens 是"补 completion 缺失那一半"的**唯一实现**:
// 上游没有给出可用的 completion 侧(字段缺失、显式 0、负数)时,按**已交付
// 字节**估算(同一个 estimateTokensFromBytes);已经上报的**正值原样保留**
// —— 估算永远不会叠加到真实值上、也永远不会覆盖 prompt 侧(输入 token 无法
// 由响应字节推知,宁可少收也不凭空多扣)。
//
// 饱和保护(G5a 同源):估算不得让 prompt+completion 越过 MaxInt64 ——
// 落库列是 BIGINT,求和回绕/越界会让聚合与对账查询报错。
func fallbackCompletionTokens(promptTokens, completionTokens, deliveredBytes int64) int64 {
	if completionTokens > 0 {
		return completionTokens
	}
	estimated := estimateTokensFromBytes(deliveredBytes)
	if estimated <= 0 {
		return 0
	}
	if promptTokens > 0 {
		if room := int64(math.MaxInt64) - promptTokens; estimated > room {
			if room <= 0 {
				return 0
			}
			estimated = room
		}
	}
	return estimated
}

// settleStreamFallback 是流式收尾兜底结算的**唯一实现**(G12,审计 2026-09-13)。
//
// 上游没有回报 usage、或只回报了输入侧(例如 Anthropic 流在 message_start
// 之后就断了;N1,审计 r3 第四轮:调用方的前置条件曾把「pt>0 且 ct==0」排除,
// 于是 completion 永不估算)时,按**已经转发出去的字节数**估算 completion
// tokens 并回填 —— 与 chat 流式 2026-08 起就有的口径完全同源(同一个
// fallbackCompletionTokens,不是第二份实现)。真实值优先:只补 completion
// 缺失的那一半(ct<=0 才填),不会把上游报的用量改大或改小;输入侧
// (prompt/cache)原样带出,**绝不被估算覆盖**。
//
// 返回 settled=false 且 err==nil 表示这次流没有任何可计费内容(pending 行已删除)。
// 返回 err != nil 时调用方必须 fail-closed(abortSettlementFailureStream)。
func settleStreamFallback(db *sql.DB, usageID, forwardedBytes, promptTokens, completionTokens, cacheTokens int64) (bool, error) {
	completionTokens = fallbackCompletionTokens(promptTokens, completionTokens, forwardedBytes)
	if promptTokens <= 0 && completionTokens <= 0 && cacheTokens <= 0 {
		// 一个字节都没转发(连接失败/空流):删除 pending 行,不留痕迹。
		return false, serverstore.DeleteUsage(db, usageID)
	}
	if err := updateUsageTokensSettled(db, usageID, promptTokens, completionTokens, cacheTokens); err != nil {
		return false, err
	}
	return true, nil
}

// beginStreamUsage 为流式请求插入 pending usage 行(整条流的计量锚点)。
// 写不进去就**在调用上游之前**拒绝:沿用 usageID=0 一路跑下去,整条流没有任何
// 计量痕迹,等于免费交付(与 G5b 同一族,审计 r3 反向核查发现)。
func (a *API) beginStreamUsage(c *gin.Context, userID int64, model, kind string) (int64, bool) {
	usageID, err := serverstore.RecordUsageKind(a.DB, userID, model, 0, 0, kind)
	if err != nil {
		log.Printf("gateway: record pending usage (%s) failed, refusing stream before upstream: user=%d model=%s: %v",
			kind, userID, safeModelForLog(model), err)
		rejectSettlementFailure(c, err, "pending "+kind)
		return 0, false
	}
	return usageID, true
}
