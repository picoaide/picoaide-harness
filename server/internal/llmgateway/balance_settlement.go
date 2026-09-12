package llmgateway

import (
	"errors"
	"fmt"
	"net/http"

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
