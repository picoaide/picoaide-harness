package llmgateway

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
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

// 计费 kind = **端点标识**(P3,审计 r5 §1)。此前 /v1/completions 与
// /v1/responses 都记成 "chat",按端点对账时分不开;embedding/search 早已分开。
// 既有取值语义不变(历史行仍是 chat/embedding/search),只新增两个取值。
// 白名单与 pending 清理集合在 serverstore(UsageRequestKind /
// UsageKindPendingCleanup),由 TestBillingKindsRegisteredInServerstore 守卫。
const (
	billingKindChat        = "chat"        // /v1/chat/completions
	billingKindCompletions = "completions" // /v1/completions(FIM Beta)
	billingKindResponses   = "responses"   // /v1/responses
	billingKindSearch      = "search"      // /v1/messages(Anthropic 兼容 + web_search)
	billingKindEmbedding   = "embedding"   // /v1/embeddings
)

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
		touchSSEWriteDeadline(c)
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
		touchSSEWriteDeadline(c)
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
//
// 只被**流式**路径调用(chat 回填 / anthropic 回填 / settleStreamFallback),
// 所以走 AllowOverdraft 变体(审计 r7 srvbill-1):usage chunk 出现在流的末尾,
// 此刻正文早已交付,"余额不够就整笔回滚"对已交付的调用等于零落账零扣费。
// 欠款如实落账后由 BalanceBlocked 拦下后续请求。非流式插入结算
// (RecordUsage*)仍保持余额下限。
func updateUsageTokensSettled(db *sql.DB, id, promptTokens, completionTokens, cacheTokens int64, estimated bool) error {
	var err error
	for attempt := 1; attempt <= settlementBackfillAttempts; attempt++ {
		err = serverstore.UpdateUsageTokensCachedEstimatedOverdraft(db, id, promptTokens, completionTokens, cacheTokens, estimated)
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

// maxEstimatedCompletionTokens 是**估算**的业务上限(P2,审计 r5 §1 缺口 2:
// 「估算无上限、可被上游双向操纵」)。
//
// 依据:估算只在"上游没报 completion 侧"时启动,按**已交付字节**折算
// (4 字节/token),而上游响应体上限是 32 MiB ⇒ 无上限时单请求最多估出
// 8,388,608 token。实测:上游在响应里塞 1 MiB 填充(debug/回显/base64/工具
// 结果,都不是模型输出)就能把一次 "hi" 记成 262,174 token ≈ 2.10 元 ——
// 交付字节数成了计费放大器;32 MiB 上限外推 ≈ 67 元/请求。
//
// 取值 65536(64K)= 本平台支持的最大模型输出量级(deepseek-reasoner 的 64K
// 输出上限),折算 = 256 KiB 交付内容。理由:
//   - 真实值优先:上游只要报了任何**正**值 completion,估算完全不启动,上限
//     对正常链路零影响;上游报一个极小的正值(如 1)本来就会压制估算,这一点
//     没有变化(那是"少收"方向,属产品选择的边界,见"仍未修"清单);
//   - 少收方向:上游漏报 usage 时,宁可按物理上限少收,也不把不可信字节当账单;
//   - 定量:最坏多收 ≤ 65536 × 8 元/1M ≈ 0.53 元/请求(无上限时 67 元/请求),
//     且**只影响上游漏报 usage 的异常报文**,无法再被填充放大 5 个数量级。
const maxEstimatedCompletionTokens int64 = 65536

// estimateCompletionFallback 是字节估算的**唯一实现**(fallbackCompletionTokens
// 与 settleStreamFallback 共用),额外返回 estimated 标记:true = 这个 token 数
// 是服务端估算的,而不是上游上报值(0063 的 usage.estimated 列写它,事后对账
// 必须能区分 —— 审计 r5 §1 缺口 3)。
func estimateCompletionFallback(promptTokens, completionTokens, deliveredBytes int64) (tokens int64, estimated bool) {
	if completionTokens > 0 {
		// 上游上报的正值原样保留:不估算、不覆盖、不叠加上限。
		return completionTokens, false
	}
	estimatedTokens := estimateTokensFromBytes(deliveredBytes)
	if estimatedTokens <= 0 {
		// 正文交付过但不足 4 字节(例如内容只有 "hi"):至少记 1 个 token ——
		// 与 estimateEmbeddingPromptTokens 的输入侧下限同一取舍(非空不得零
		// 落账)。deliveredBytes <= 0(一个字节都没交付)时仍然返回 0。
		if deliveredBytes <= 0 {
			return 0, false
		}
		estimatedTokens = 1
	}
	if estimatedTokens > maxEstimatedCompletionTokens {
		estimatedTokens = maxEstimatedCompletionTokens
	}
	if promptTokens > 0 {
		if room := int64(math.MaxInt64) - promptTokens; estimatedTokens > room {
			if room <= 0 {
				return 0, false
			}
			estimatedTokens = room
		}
	}
	return estimatedTokens, true
}

// maxEstimatedPromptTokens 是**输入侧**估算的**兜底**上限(r7 r7f1-1,P1;
// rc3-5 起改为"模型窗口优先、这里兜底")。
//
// 旧值是 maxChatBody(16 MiB)/4 = 4,194,304 —— 它不是保护,而是"平台允许的
// 最大请求体全量计价":实测单请求最高可计 4.19~125.83 元(按输入价 1~30 元/1M),
// 而触发条件只是"上游/中转漏报 usage"。真正的 prompt 上界是**模型上下文窗口**:
// 超过窗口的请求会被上游 4xx 拒绝,而 4xx 路径**不落账**(上游没有交付)。所以
// 补估只可能出现在"上游接受了请求却没报 usage"的异常链路。
//
// rc3-5(第三轮复核 §2 P2):固定 131072 对**纯文本长上下文**最多少收 8×
// (4 MiB 文本 = 1,048,578 token 的真实口径被截到 131,072,按 30 元/1M 单请求
// 少收 27.53 元),而 512 KB 起的**合法**请求就会命中 —— 这不是攻击构造。
// 现在上限优先取**该模型配置的上下文窗口**(promptEstimateCapForModel →
// default_params 的 context_length 等键),只有配置缺失/不可用时才落这个 128K
// 兜底。兜底本身仍是**少收方向**的保守口径(宁可少收,不能按 16 MiB 请求体
// 全量计费)。
//
// 超限不静默:estimatePromptFallback 会记一条 warning(而不是悄悄按上限计费),
// 且按"连续期 + 窗口取值"去重(rc3-5 ②:此前每个命中请求一条,正常流量下会
// 持续刷日志),让"计量表坏了"在日志里可见但不淹没日志。
const maxEstimatedPromptTokens int64 = 131072 // 128K

// minPromptEstimateCap 是"配置的上下文窗口"可被采信的下限:低于这个值的配置
// (0/负数/明显荒谬的小值)不改变兜底口径 —— 上限越小越少收,取一个荒谬的小值
// 等于把输入侧计价关掉,不是我们想要的"按模型窗口"。
const minPromptEstimateCap int64 = 1024

// promptTokenCapFromDefaultParams 从模型 default_params 里取"上下文窗口"
// (rc3-5 ①)。context_length 是本仓渠道同步写入的规范键(见 sync.go 的
// ModelDefaultParamsCaps),其余键是第三方/历史配置的等价写法。
//
// 返回 ok=false 表示"配置里没有可用的窗口",调用方落 maxEstimatedPromptTokens。
func promptTokenCapFromDefaultParams(params string) (int64, bool) {
	if strings.TrimSpace(params) == "" {
		return 0, false
	}
	var p map[string]any
	if err := json.Unmarshal([]byte(params), &p); err != nil {
		return 0, false
	}
	for _, key := range []string{
		"context_length", "context_window", "max_context_tokens",
		"max_input", "max_input_tokens", "context",
	} {
		raw, ok := p[key]
		if !ok {
			continue
		}
		var n int64
		switch t := raw.(type) {
		case float64:
			n = int64(t)
		case string:
			parsed, perr := strconv.ParseInt(strings.TrimSpace(t), 10, 64)
			if perr != nil {
				continue
			}
			n = parsed
		default:
			continue
		}
		if n >= minPromptEstimateCap {
			return n, true
		}
	}
	return 0, false
}

// promptEstimateCapForModel 解析某个模型的输入侧补估上限(rc3-5 ①):
// 优先 default_params 的上下文窗口,取不到落 maxEstimatedPromptTokens。
// ModelDefaultParams 自带 30s 进程内缓存,热路径不新增 DB 往返。
func promptEstimateCapForModel(db *sql.DB, model string) int64 {
	if db == nil || model == "" {
		return maxEstimatedPromptTokens
	}
	params, err := serverstore.ModelDefaultParams(db, model)
	if err != nil {
		return maxEstimatedPromptTokens
	}
	if n, ok := promptTokenCapFromDefaultParams(params); ok {
		return n
	}
	return maxEstimatedPromptTokens
}

// visionImagePromptTokenCap 是**平台自己的视觉计费口径**:单张图片折算的
// prompt token 上限(384/图,与 completions_test.go 的
// TestVisionImageTokenBilling 同源)。补估只在"上游不报 usage"时启动,这时用
// 平台口径代替 base64 字节数 —— 否则 1.5 MiB 的内联图片会被算成 375K token
// (同一份输入上游如实上报只有 1200 token,×313 多收;r7f1-1)。
const visionImagePromptTokenCap int64 = 384

const (
	// dataURIBase64Marker 是内联 data URI 的载荷分隔符(**大小写不敏感**匹配:
	// `;base64,` / `;BASE64,` / `;Base64,` 都是同一个结构)。
	dataURIBase64Marker = ";base64,"
	// dataURIScheme 是 data URI 的 scheme 前缀(同样大小写不敏感)。
	dataURIScheme = "data:"
	// maxDataURIMimeBytes 是 `data:` 到 `;base64,` 之间(mime + 可选参数)的
	// 最大长度:超过它的匹配不算 data URI(防止把正文里两个无关片段粘起来)。
	maxDataURIMimeBytes = 128
	// minDataURIPayload 是 data URI 载荷被当作内联二进制剥离的最小长度。
	// 更短的载荷按 4 字节/token 算也一定 ≤ 384(1536 字节),无需特殊处理。
	minDataURIPayload = 64
	// minBareBase64Run 是**没有 data: 前缀**的裸 base64 连续段被当作内联
	// 二进制的最小长度(Anthropic 的 {"media_type":"image/png","data":"…"}
	// 这类嵌套形态)。取值刻意保守:正常文本/代码里几乎不可能出现 4096 个
	// 连续 base64 字符,避免把正文误判成二进制。
	minBareBase64Run = 4096
	// maxInlineBinarySegments 是单请求最多剥离的**段数**(rc3-1):每段折算
	// 上限 384 token,段数就是"剥离带来的最大优惠"的乘数。真实视觉请求远
	// 小于它;超过即**整体回落**到字节口径(宁可多收,也不让剥离器变成
	// 新的少收/CPU 放大器)。
	maxInlineBinarySegments = 64
	// maxInlineBinaryProbes 是单请求最多做多少次"载荷二进制性"探测(rc3-1):
	// 每次探测的代价与**该候选载荷**长度同阶(rc4-1 起要完整解码一次做容器
	// 结构校验,总代价仍与请求体同阶),但次数必须与请求体长度脱钩,否则
	// `;base64,` 洪水(stripper 的二次方 CPU 就是它引爆的)会把热路径拖住。
	// 超过即整体回落到字节口径。
	maxInlineBinaryProbes = 4096
	// maxStrippedBytesTotal 是单请求被剥离的载荷**总量**上限(rc3-1/rc3-2 兜底):
	// 即使判据被绕过,少收也被这个上限封住;超过即整体回落到字节口径。
	maxStrippedBytesTotal = 12 << 20
	// maxInlineBinaryPayloadBytes 是**单段**载荷被折算的字节上限(rc4-1 ①):
	// 12 MiB 的"总量"预算意味着单段也能全免费,这里再收紧一层 —— 超过即该段
	// 按文本计(其余段不受影响)。8 MiB base64 ≈ 6 MiB 原始媒体,覆盖现实中的
	// 内联图片(请求体上限本身只有 16 MiB,单段再大也装不下几张)。
	maxInlineBinaryPayloadBytes = 8 << 20
	// maxUnverifiedBinaryBytes 是"**只有魔数、没有容器结构佐证**"的载荷在单请求
	// 内可折算的字节总量上限(rc4-1 ①)。魔数是可以伪造的(真 PNG 签名 + 任意
	// 字节),所以这层证据只给收紧的预算:超过即整段按文本计。真正的媒体容器
	// (PNG chunk+CRC / JPEG 标记链 / GIF 块链 / RIFF-WebP / ISO-BMFF)走上面的
	// 常规预算,不受这条影响。
	maxUnverifiedBinaryBytes = 512 << 10
	// maxBinaryTextPrintablePercent 是"解码后是不是文本"的判据(rc4-1 ③):
	// 可打印字节占比 ≥ 该百分比一律按文本计(宁可多收)。真二进制(压缩/加密/
	// 伪随机)的可打印率只有 ~37%,不受影响;"魔数 + 大段文本尾巴"的拼接、
	// 以及落进 90–99.5% 灰带的均匀文本都在这里收敛。
	maxBinaryTextPrintablePercent = 90
	// maxInlineBinaryCarrierBytes 是载体键回看的最大窗口(rc3-2):data: 之前
	// 必须是 JSON 里装内联二进制的键(而不是任意正文)。
	maxInlineBinaryCarrierBytes = 64
)

// byteRange 是请求体里一段内联二进制的字节区间。
type byteRange struct{ start, end int }

// isBase64Byte 判定一个字节是否属于 base64 字母表(含 URL-safe 的 -/_ 与填充 =)。
func isBase64Byte(b byte) bool {
	return b >= 'A' && b <= 'Z' || b >= 'a' && b <= 'z' || b >= '0' && b <= '9' ||
		b == '+' || b == '/' || b == '=' || b == '-' || b == '_'
}

// foldEqualASCII 比较两个字节串是否相等(仅 ASCII 大小写不敏感)。
func foldEqualASCII(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		ca, cb := a[i], b[i]
		if 'A' <= ca && ca <= 'Z' {
			ca += 'a' - 'A'
		}
		if 'A' <= cb && cb <= 'Z' {
			cb += 'a' - 'A'
		}
		if ca != cb {
			return false
		}
	}
	return true
}

// indexDataURIMarkerFold 找 from 之后第一个 `;base64,`(**大小写不敏感**),
// 返回分隔符 ';' 的下标;-1 = 没有。先按单字节 ';' 扫描,不做 O(n·m) 的
// 子串回溯 —— 保证整体仍是单遍线性。
func indexDataURIMarkerFold(body []byte, from int) int {
	marker := []byte(dataURIBase64Marker)
	for p := from; p+len(marker) <= len(body); p++ {
		if body[p] != ';' {
			continue
		}
		if foldEqualASCII(body[p:p+len(marker)], marker) {
			return p
		}
	}
	return -1
}

// lastDataSchemeFold 在 window 里找**最后一个** `data:`(大小写不敏感),
// 返回下标;-1 = 没有。window 由调用方限制在 maxDataURIMimeBytes 内,
// 所以这里是 O(1)(rc3-1 的 P0 就是在这里扫了全史变二次方的)。
func lastDataSchemeFold(window []byte) int {
	scheme := []byte(dataURIScheme)
	for p := len(window) - len(scheme); p >= 0; p-- {
		if foldEqualASCII(window[p:p+len(scheme)], scheme) {
			return p
		}
	}
	return -1
}

// isInlineBinaryMime 判定 data URI 的 mime 是否是**已知的二进制模态**(rc3-2):
// 只有这些模态才按平台视觉/二进制口径折算。`text/plain`、`text/*`、空 mime
// 一律按文本计 —— 把 text/plain 当二进制是自相矛盾的(rc3-2 的少收面正是
// 从 `data:text/plain;base64,<真实文本>` 进来的)。
func isInlineBinaryMime(region []byte) bool {
	// region = `data:` 与 `;base64,` 之间的内容:mime + 可选参数。
	m := strings.ToLower(strings.TrimSpace(string(region)))
	if i := strings.IndexAny(m, ";,"); i >= 0 {
		m = strings.TrimSpace(m[:i])
	}
	switch {
	case strings.HasPrefix(m, "image/"), strings.HasPrefix(m, "audio/"),
		strings.HasPrefix(m, "video/"), strings.HasPrefix(m, "font/"):
		return true
	}
	switch m {
	case "application/pdf", "application/octet-stream", "application/zip",
		"application/gzip", "application/x-gzip", "application/x-zip-compressed",
		"application/x-protobuf", "application/wasm":
		return true
	}
	return false
}

// inlineBinaryCarrierKeys 是"值里装内联二进制"的已知 JSON 键(含结束引号):
// OpenAI Vision 的 image_url.url / Responses 的 image_url、Anthropic 的
// source.data、Gemini 的 inline_data.data、OpenAI 的 b64_json。
//
// rc3-2:判据从"正文里出现 data:…;base64,"收紧为"**必须挂在二进制载体键下**"
// —— 正文/文档/代码/日志里出现这串字样是合法的,不能因此把真实文本剥成 384。
var inlineBinaryCarrierKeys = [][]byte{
	[]byte(`"url":"`), []byte(`"url": "`),
	[]byte(`"image_url":"`), []byte(`"image_url": "`),
	[]byte(`"data":"`), []byte(`"data": "`),
	[]byte(`"b64_json":"`), []byte(`"b64_json": "`),
	[]byte(`"inline_data":"`), []byte(`"inline_data": "`),
}

// precededByInlineBinaryCarrier 判定 body[start:] 是否紧跟在已知的二进制载体
// 键后面(回看窗口为常数,与请求体长度无关)。
func precededByInlineBinaryCarrier(body []byte, start int) bool {
	lo := start - maxInlineBinaryCarrierBytes
	if lo < 0 {
		lo = 0
	}
	for _, prefix := range inlineBinaryCarrierKeys {
		if start >= len(prefix) && start-len(prefix) >= lo && bytes.Equal(body[start-len(prefix):start], prefix) {
			return true
		}
	}
	return false
}

// scanInlineBase64Payload 从 start 起扫一段 base64 载荷,返回载荷结束下标与
// "形态合法"标记(rc3-2:严格 base64 字符集 + 长度 + 结束边界)。
//
// 接受的形态:
//   - 标准/URL-safe base64 字母表;
//   - JSON 字符串里的折行:转义对 `\n`/`\r`/`\t`(两个字符)与行尾的真实
//     空白(仅作为**结束边界**,不进入载荷);
//   - 结尾的 '=' 填充。
//
// 结束边界必须是 JSON 结构里的定界符(引号/右括号/逗号)或正文末尾:撞到别的
// 字符说明这一段不是"一个完整的二进制值",按不合法处理(退回字节口径)。
func scanInlineBase64Payload(body []byte, start int) (int, bool) {
	k := start
	pad := 0
	for k < len(body) {
		b := body[k]
		if b == '\\' && k+1 < len(body) {
			// JSON 转义:折行的 base64(\n / \r / \t)算载荷内部,跳过两个字符。
			switch body[k+1] {
			case 'n', 'r', 't':
				k += 2
				continue
			}
		}
		switch {
		case b >= 'A' && b <= 'Z' || b >= 'a' && b <= 'z' || b >= '0' && b <= '9' || b == '+' || b == '/' || b == '-' || b == '_':
			if pad > 0 {
				return k, false // 填充之后又出现数据字符:不是合法 base64
			}
			k++
		case b == '=':
			pad++
			if pad > 2 {
				return k, false
			}
			k++
		default:
			// 结束边界:只接受 JSON 结构定界符或正文末尾。
			switch b {
			case '"', '\'', '}', ']', ')', ',', '\n', '\r', '\t', ' ':
				return k, true
			}
			return k, false
		}
	}
	return k, true // 正文末尾(报文被截断/裸 URI)
}

// normalizeBase64Probe 把载荷采样整理成可解码的标准 base64(去掉折行转义与
// 填充,URL-safe 还原成标准字母表)。
func normalizeBase64Probe(run []byte) []byte {
	out := make([]byte, 0, len(run))
	for i := 0; i < len(run); i++ {
		b := run[i]
		if b == '\\' && i+1 < len(run) {
			switch run[i+1] {
			case 'n', 'r', 't':
				i++
				continue
			}
		}
		switch b {
		case '=':
			continue
		case '-':
			out = append(out, '+')
		case '_':
			out = append(out, '/')
		case '\n', '\r', '\t', ' ':
			continue
		default:
			out = append(out, b)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// 内联二进制取证(rc4-1 ②③)
// ---------------------------------------------------------------------------
//
// rc3-2 的判据是"这段字符串 base64 解码后可打印率 < 95%",而**可打印率是租户
// 可控的文本属性**:把纯文本(长十六进制串、均匀字母数字串、重复字符)挂进任一
// 已知载体键,解码后的可打印率就落进"像二进制"的区间,整段被折成
// min(段长/4, 384) token(第四轮复核实测 480 KiB → 303× 少收、
// 12 MiB 单段 → 7787× / 94.36 元每请求)。
//
// 现在的判据换成租户**难以伪造**的取证,顺序 = 代价顺序:
//
//	① 魔数:解码前缀必须命中已知二进制容器(JPEG/PNG/GIF/WebP/PDF/MP4/…);
//	② 文本:整段解码后的可打印率 ≥ maxBinaryTextPrintablePercent ⇒ 文本;
//	③ 结构:按家族做容器结构校验(PNG chunk+CRC、JPEG 标记链、GIF 块链、
//	   RIFF-WebP、ISO-BMFF box 链),通过才走常规预算,否则只给收紧预算。
//
// 任何一步失败都退回**文本口径**(全额 4 字节/token)—— 宁可多收,也不让
// 租户可控的文本属性换来免费。

// binaryFamily 是已知二进制容器的家族(rc4-1 ②)。
type binaryFamily uint8

const (
	binaryFamilyUnknown binaryFamily = iota
	binaryFamilyPNG
	binaryFamilyJPEG
	binaryFamilyGIF
	binaryFamilyWebP
	binaryFamilyISOBMFF // mp4/mov/heic/avif(box 链)
	binaryFamilyEBML
	binaryFamilyOgg
	binaryFamilyFLAC
	binaryFamilyMP3
	binaryFamilyPDF
	binaryFamilyZIP
	binaryFamilyGZIP
	binaryFamilyWASM
	binaryFamilyFont
	binaryFamilyBMP
	binaryFamilyTIFF
	binaryFamilyICO
	binaryFamilyPSD
)

// classifyBinaryMagic 只看解码后的**前缀**,判定它命中哪一类已知容器。文本
// (代码/文档里粘贴的 base64)解出来的字节首部通常根本不在这张表里。前缀是
// 可以伪造的(真签名 + 任意字节),所以命中魔数只算"未验证"证据。
func classifyBinaryMagic(bin []byte) binaryFamily {
	has := func(prefix ...byte) bool {
		return len(bin) >= len(prefix) && bytes.Equal(bin[:len(prefix)], prefix)
	}
	str := func(prefix string) bool {
		return len(bin) >= len(prefix) && string(bin[:len(prefix)]) == prefix
	}
	switch {
	case has(0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'):
		return binaryFamilyPNG
	case has(0xFF, 0xD8, 0xFF):
		return binaryFamilyJPEG
	case str("GIF87a"), str("GIF89a"):
		return binaryFamilyGIF
	case len(bin) >= 12 && str("RIFF") && string(bin[8:12]) == "WEBP":
		return binaryFamilyWebP
	case len(bin) >= 12 && string(bin[4:8]) == "ftyp":
		return binaryFamilyISOBMFF
	case has(0x1A, 0x45, 0xDF, 0xA3):
		return binaryFamilyEBML
	case str("OggS"):
		return binaryFamilyOgg
	case str("fLaC"):
		return binaryFamilyFLAC
	case str("ID3"):
		return binaryFamilyMP3
	case len(bin) >= 2 && bin[0] == 0xFF && bin[1]&0xE0 == 0xE0:
		return binaryFamilyMP3 // MPEG 音频帧同步(11 位全 1)
	case str("%PDF-"):
		return binaryFamilyPDF
	case str("PK\x03\x04"), str("PK\x05\x06"):
		return binaryFamilyZIP
	case has(0x1F, 0x8B):
		return binaryFamilyGZIP
	case str("\x00asm"):
		return binaryFamilyWASM
	case str("wOFF"), str("wOF2"), str("OTTO"), str("ttcf"), str("true"),
		has(0x00, 0x01, 0x00, 0x00):
		return binaryFamilyFont
	case str("BM"):
		return binaryFamilyBMP
	case has('I', 'I', 0x2A, 0x00), has('M', 'M', 0x00, 0x2A):
		return binaryFamilyTIFF
	case has(0x00, 0x00, 0x01, 0x00):
		return binaryFamilyICO
	case str("8BPS"):
		return binaryFamilyPSD
	}
	return binaryFamilyUnknown
}

// paddingOnly 判定尾部是不是"无意义的填充"(≤64 字节的 NUL/空白):容器正常
// 收尾后允许少量填充,但绝不允许再接一大段数据(那正是"图片 + 文本尾巴"的拼接)。
func paddingOnly(b []byte) bool {
	if len(b) > 64 {
		return false
	}
	for _, c := range b {
		if c != 0x00 && c != '\n' && c != '\r' && c != '\t' && c != ' ' {
			return false
		}
	}
	return true
}

// isPNGContainer 校验 PNG 容器结构(签名 + 逐 chunk 长度/类型/CRC + IEND 收尾)。
// 真 PNG(任何编码器输出)一定通过;"魔数 + 伪随机字节"几乎不可能构造出合法
// 的 CRC 链(先撞 2^-32 再说)。
func isPNGContainer(bin []byte) bool {
	if len(bin) < 57 || !bytes.HasPrefix(bin, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}) {
		return false
	}
	off := 8
	sawIHDR := false
	for off+8 <= len(bin) {
		// 用 uint64 做边界运算:uint32 的 size 在 32 位平台上转 int 会变负,
		// 后面的切片就会 panic —— 这是对**攻击者可控字节**的解析。
		size := uint64(binary.BigEndian.Uint32(bin[off : off+4]))
		if uint64(off)+12+size > uint64(len(bin)) {
			return false
		}
		n := int(size)
		typ := bin[off+4 : off+8]
		for _, c := range typ {
			if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z') {
				return false
			}
		}
		if binary.BigEndian.Uint32(bin[off+8+n:off+12+n]) != crc32.ChecksumIEEE(bin[off+4:off+8+n]) {
			return false
		}
		if !sawIHDR {
			if string(typ) != "IHDR" || n != 13 {
				return false
			}
			w := binary.BigEndian.Uint32(bin[off+8 : off+12])
			h := binary.BigEndian.Uint32(bin[off+12 : off+16])
			if w == 0 || h == 0 || w > 1<<20 || h > 1<<20 {
				return false
			}
			sawIHDR = true
		}
		off += 12 + n
		if string(typ) == "IEND" {
			return sawIHDR && paddingOnly(bin[off:])
		}
	}
	return false
}

// isJPEGContainer 校验 JPEG 标记链:SOI → (长度前缀段)* → SOS → 熵编码数据 →
// EOI。熵编码数据里 0xFF 后面只可能是 0x00(填充)或 RSTn,其余就是下一个标记。
// EOI 之后允许 ≤1 KiB 附加数据(部分相机/编辑器会追加元数据),但**不允许**
// 再接一大段数据。
func isJPEGContainer(bin []byte) bool {
	if len(bin) < 4 || bin[0] != 0xFF || bin[1] != 0xD8 || bin[2] != 0xFF {
		return false
	}
	i := 2
	sawSOF := false
	segments := 0
	for i+1 < len(bin) {
		if bin[i] != 0xFF {
			return false
		}
		marker := bin[i+1]
		switch {
		case marker == 0xFF: // 填充字节
			i++
			continue
		case marker == 0xD8, marker == 0x01, marker >= 0xD0 && marker <= 0xD7:
			i += 2
			continue
		case marker == 0xD9: // EOI
			return sawSOF && len(bin)-(i+2) <= 1024
		}
		if i+4 > len(bin) {
			return false
		}
		size := int(binary.BigEndian.Uint16(bin[i+2 : i+4]))
		if size < 2 || i+2+size > len(bin) {
			return false
		}
		if marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
			sawSOF = true
		}
		segments++
		if segments > 4096 {
			return false
		}
		if marker == 0xDA { // SOS:后面是熵编码数据
			j := i + 2 + size
			for j+1 < len(bin) {
				if bin[j] == 0xFF && bin[j+1] != 0x00 && !(bin[j+1] >= 0xD0 && bin[j+1] <= 0xD7) {
					break
				}
				j++
			}
			i = j
			continue
		}
		i += 2 + size
	}
	return false
}

// skipGIFSubBlocks 跳过 GIF 的子块链(长度字节 + 数据,直到 0x00 结束符)。
func skipGIFSubBlocks(bin []byte, off int) int {
	for off < len(bin) {
		n := int(bin[off])
		off++
		if n == 0 {
			return off
		}
		off += n
		if off > len(bin) {
			return -1
		}
	}
	return -1
}

// isGIFContainer 校验 GIF 块链(头部 + 逻辑屏幕描述符 + 可选全局色表 + 图像/
// 扩展块 + 0x3B 收尾)。
func isGIFContainer(bin []byte) bool {
	if len(bin) < 14 {
		return false
	}
	if string(bin[:6]) != "GIF87a" && string(bin[:6]) != "GIF89a" {
		return false
	}
	if binary.LittleEndian.Uint16(bin[6:8]) == 0 || binary.LittleEndian.Uint16(bin[8:10]) == 0 {
		return false
	}
	off := 13
	if bin[10]&0x80 != 0 {
		off += 3 * (1 << ((bin[10] & 0x07) + 1))
	}
	for off < len(bin) {
		switch bin[off] {
		case 0x3B: // trailer
			return paddingOnly(bin[off+1:])
		case 0x2C: // image descriptor
			if off+10 > len(bin) {
				return false
			}
			packed := bin[off+9]
			off += 10
			if packed&0x80 != 0 {
				off += 3 * (1 << ((packed & 0x07) + 1))
			}
			if off >= len(bin) {
				return false
			}
			off++ // LZW minimum code size
			if off = skipGIFSubBlocks(bin, off); off < 0 {
				return false
			}
		case 0x21: // extension
			if off+2 > len(bin) {
				return false
			}
			off += 2
			if off = skipGIFSubBlocks(bin, off); off < 0 {
				return false
			}
		default:
			return false
		}
	}
	return false
}

// isWebPContainer 校验 RIFF/WEBP 容器:RIFF 大小与文件长度一致,chunk 链完整
// 覆盖到文件末尾(块数据按偶数长度对齐)。
func isWebPContainer(bin []byte) bool {
	if len(bin) < 20 || string(bin[:4]) != "RIFF" || string(bin[8:12]) != "WEBP" {
		return false
	}
	size := uint64(binary.LittleEndian.Uint32(bin[4:8]))
	if size+8 != uint64(len(bin)) && size+8 != uint64(len(bin))-1 {
		return false
	}
	off := 12
	chunks := 0
	for off+8 <= len(bin) {
		cs := uint64(binary.LittleEndian.Uint32(bin[off+4 : off+8]))
		if uint64(off)+8+cs > uint64(len(bin)) {
			return false
		}
		n := int(cs)
		off += 8 + n
		if cs%2 == 1 {
			off++
		}
		chunks++
		if chunks > 1024 {
			return false
		}
	}
	return chunks > 0 && off == len(bin)
}

// isISOBMFFContainer 校验 ISO-BMFF(MP4/MOV/HEIC/AVIF)的 box 链:每个 box 的
// 大小字段必须严格覆盖到文件末尾(size=0 表示直到文件末尾,size=1 表示 64 位
// 长度在 largesize 字段)。
func isISOBMFFContainer(bin []byte) bool {
	if len(bin) < 16 || string(bin[4:8]) != "ftyp" {
		return false
	}
	if bin[8] == 0 && bin[9] == 0 && bin[10] == 0 && bin[11] == 0 {
		return false // major_brand 为空
	}
	off := 0
	boxes := 0
	for off+8 <= len(bin) {
		size := int64(binary.BigEndian.Uint32(bin[off : off+4]))
		header := int64(8)
		switch size {
		case 0:
			size = int64(len(bin) - off)
		case 1:
			if off+16 > len(bin) {
				return false
			}
			size = int64(binary.BigEndian.Uint64(bin[off+8 : off+16]))
			header = 16
		}
		if size < header || int64(off)+size > int64(len(bin)) {
			return false
		}
		off += int(size)
		boxes++
		if boxes > 4096 {
			return false
		}
	}
	return boxes > 0 && off == len(bin)
}

// validBinaryContainer 做容器**结构**校验(rc4-1 ②):真媒体文件一定通过,
// "魔数 + 伪随机字节"必然失败。未实现校验的家族返回 false(⇒ 收紧预算)。
func validBinaryContainer(family binaryFamily, bin []byte) bool {
	switch family {
	case binaryFamilyPNG:
		return isPNGContainer(bin)
	case binaryFamilyJPEG:
		return isJPEGContainer(bin)
	case binaryFamilyGIF:
		return isGIFContainer(bin)
	case binaryFamilyWebP:
		return isWebPContainer(bin)
	case binaryFamilyISOBMFF:
		return isISOBMFFContainer(bin)
	}
	return false
}

// inlineBinaryVerdict 是候选载荷的取证结论(rc4-1)。
type inlineBinaryVerdict uint8

const (
	inlineBinaryText      inlineBinaryVerdict = iota // 按文本计:全额 4 字节/token
	inlineBinaryContainer                            // 已知容器 + 结构校验通过 ⇒ 常规预算
	inlineBinaryMagicOnly                            // 只有魔数 ⇒ 收紧预算(maxUnverifiedBinaryBytes)
)

// decodeInlineBase64Payload 把候选载荷(base64 文本,允许 JSON 折行转义与
// URL-safe 字母表)解码成字节;不是合法 base64 一律返回 nil(⇒ 按文本计)。
//
// 注意用 RawStdEncoding:normalizeBase64Probe 已经把 '=' 填充去掉,按 4 的
// 倍数**截断**会丢掉最后 1–2 个字节 —— 对结构校验(PNG 的 IEND/CRC)是致命的
// (载荷长度 %3 == 1 的真图片会因此被判成"只有魔数")。
func decodeInlineBase64Payload(payload []byte) []byte {
	clean := normalizeBase64Probe(payload)
	if len(clean) < 4 {
		return nil
	}
	if len(clean)%4 == 1 { // 长度 %4 == 1 不是合法的 base64 尾块,丢掉这 1 个字符
		clean = clean[:len(clean)-1]
	}
	out := make([]byte, base64.RawStdEncoding.DecodedLen(len(clean)))
	n, err := base64.RawStdEncoding.Decode(out, clean)
	if err != nil {
		return nil // 不是合法 base64 ⇒ 不是二进制载荷
	}
	return out[:n]
}

// inspectInlineBinaryPayload 是"这段载荷是不是真二进制"的**唯一判据**(rc4-1):
// 魔数(常数代价)→ 解码一次算可打印率(③)→ 按家族做容器结构校验(②)。
func inspectInlineBinaryPayload(payload []byte) inlineBinaryVerdict {
	bin := decodeInlineBase64Payload(payload)
	if len(bin) == 0 {
		return inlineBinaryText
	}
	family := classifyBinaryMagic(bin)
	if family == binaryFamilyUnknown {
		return inlineBinaryText
	}
	if textLikeDecoded(bin) {
		return inlineBinaryText
	}
	if validBinaryContainer(family, bin) {
		return inlineBinaryContainer
	}
	return inlineBinaryMagicOnly
}

// textLikeDecoded 判定解码后的载荷是不是"文本"(rc4-1 ③):可打印字节占比
// ≥ maxBinaryTextPrintablePercent。真二进制(压缩/加密/伪随机)只有 ~37%,
// 不受影响;"魔数 + 大段文本尾巴"的拼接与 90–99.5% 的灰带都在这里收敛。
func textLikeDecoded(bin []byte) bool {
	printable := 0
	for _, b := range bin {
		if (b >= 0x20 && b < 0x7f) || b == '\n' || b == '\r' || b == '\t' {
			printable++
		}
	}
	return printable*100 >= len(bin)*maxBinaryTextPrintablePercent
}

// foldWithinBudget 是折算的**预算闸门**(rc4-1 ①):
//   - 单段载荷 ≤ maxInlineBinaryPayloadBytes;
//   - "只有魔数、结构未验证"的载荷,单请求累计 ≤ maxUnverifiedBinaryBytes。
//
// 超出一律返回 false(该段按文本计),绝不截断折算。
func foldWithinBudget(verdict inlineBinaryVerdict, payloadBytes int, unverified *int) bool {
	if payloadBytes > maxInlineBinaryPayloadBytes {
		return false
	}
	if verdict == inlineBinaryContainer {
		return true
	}
	if *unverified+payloadBytes > maxUnverifiedBinaryBytes {
		return false
	}
	*unverified += payloadBytes
	return true
}

// stripInlineBinaryPayloads 把请求体里"字节重、token 轻"的内联二进制从字节
// 估算里剥离,返回剩余**文本**字节数与内联二进制折算出的 token 数(r7f1-1):
//
//	A. `data:<mime>;base64,<payload>`(OpenAI Vision 的 image_url.data、各类
//	   内联 data URI):payload 是 base64 文本,按 4 字节/token 折算会把
//	   1.5 MiB 图片算成 37.5 万 token;
//	B. 没有 `data:` 前缀的裸 base64 连续段(≥ minBareBase64Run 字符,例如
//	   Anthropic 的 {"media_type":"image/png","data":"<base64>"})。
//
// 每段折算 min(段长/4, visionImagePromptTokenCap):**永远不会超过**原来的
// 字节口径,所以只会把"多收"改小,不会引入新的多收;同时保住"输入侧不再
// 免费"(srvbill-2)。其余文本(JSON 骨架/提示词/工具结果)仍按 4 字节/token。
//
// rc3(第三轮复核):判据必须**与危害同构**。危害是"真实文本被当成二进制而
// 免费",所以判据是"这段载荷真的能解码成二进制"+"它挂在二进制载体键下"
// (precededByInlineBinaryCarrier)+ "mime 是二进制模态"(isInlineBinaryMime);
// 并且剥离总量/段数/探测次数都有上限,越界即**整体回落**到字节口径。
//
// rc4-1(第四轮复核 P1):"解码后可打印率"本身是租户可控的文本属性,不能单独
// 当判据 —— 载体键下的长十六进制串/字母数字串同样落在"像二进制"的区间。
// 现在的取证是 inspectInlineBinaryPayload(魔数 + 容器结构 + 整段可打印率),
// 并给"只有魔数"的载荷单请求 maxUnverifiedBinaryBytes 的收紧预算。
func stripInlineBinaryPayloads(body []byte) (textBytes, blobTokens int64) {
	ranges := inlineBinaryRanges(body)
	stripped := int64(0)
	for _, r := range ranges {
		n := int64(r.end - r.start)
		stripped += n
		if t := estimateTokensFromBytes(n); t < visionImagePromptTokenCap {
			blobTokens += t
		} else {
			blobTokens += visionImagePromptTokenCap
		}
	}
	textBytes = int64(len(body)) - stripped
	if textBytes < 0 {
		textBytes = 0
	}
	return textBytes, blobTokens
}

// inlineBinaryRanges 找出请求体里所有内联二进制的字节区间(互不重叠)。
//
// **单遍线性**(rc3-1):每个候选起点只做常数回看(≤128 字节找 data:、
// ≤64 字节找载体键),载荷取证每段只解码一次(总代价与请求体同阶),指针只
// 前进不回退;探测次数/段数/剥离总量都有上限,越界直接返回 nil(整体回落
// 字节口径)。旧实现每次命中 `;base64,` 都 `bytes.LastIndex(body[:marker],
// "data:")` 全史回扫 —— 1 MiB 的 `;base64,` 洪水要烧 112 秒 CPU(计量路径
// 拒绝服务)。
func inlineBinaryRanges(body []byte) []byteRange {
	var out []byteRange
	stripped := 0
	probes := 0
	// unverified 累计"只有魔数、没有容器结构佐证"的载荷字节数(rc4-1 ①):
	// 这类载荷的魔数是可以伪造的,所以只给收紧预算,超过的部分按文本计。
	unverified := 0
	overlaps := func(start, end int) bool {
		for _, r := range out { // out ≤ maxInlineBinarySegments 项,常数代价
			if start < r.end && end > r.start {
				return true
			}
		}
		return false
	}
	budgetOK := func(n int) bool {
		if len(out) >= maxInlineBinarySegments || stripped+n > maxStrippedBytesTotal {
			return false // 越界:整体回落字节口径
		}
		return true
	}
	// A: data:<mime>;base64,<payload>
	for i := 0; i < len(body); {
		marker := indexDataURIMarkerFold(body, i)
		if marker < 0 {
			break
		}
		payloadStart := marker + len(dataURIBase64Marker)
		lo := marker - maxDataURIMimeBytes
		if lo < 0 {
			lo = 0
		}
		// 有界回看(rc3-1 的 P0 修复点):只在这 128 字节里找 `data:`。
		if rel := lastDataSchemeFold(body[lo:marker]); rel >= 0 {
			dataStart := lo + rel
			if isInlineBinaryMime(body[dataStart+len(dataURIScheme):marker]) &&
				precededByInlineBinaryCarrier(body, dataStart) {
				probes++
				if probes > maxInlineBinaryProbes {
					return nil
				}
				end, formOK := scanInlineBase64Payload(body, payloadStart)
				if formOK && end-payloadStart >= minDataURIPayload && !overlaps(payloadStart, end) {
					payloadBytes := end - payloadStart
					verdict := inspectInlineBinaryPayload(body[payloadStart:end])
					if verdict != inlineBinaryText && foldWithinBudget(verdict, payloadBytes, &unverified) {
						if !budgetOK(payloadBytes) {
							return nil
						}
						out = append(out, byteRange{payloadStart, end})
						stripped += payloadBytes
					}
				}
				i = end // 无论是否采纳都跳过载荷:指针单调前进 ⇒ 线性
				continue
			}
		}
		i = payloadStart
	}
	// B: 裸 base64 连续段 —— 只认**已知的二进制载体键**后面的值,并且要求
	// 该段具备 base64 编码二进制的最低特征(有大小写+数字的混合字符集),再
	// 走与 A 分支同一套取证(魔数 + 容器结构 + 整段可打印率)。没有这几道闸,
	// 一段 400KB 的重复字符/长标识符/粘贴的 base64 文本会被误判成内联二进制而
	// 少收 3 个数量级(回归用例 TestR7bPromptEstimateStaysWithinRealPromptScale、
	// TestR7cTextDressedAsBinaryIsStillBilledAsText、TestRC4* 就是用它钉住的)。
	for i := 0; i < len(body); {
		if !isBase64Byte(body[i]) {
			i++
			continue
		}
		j := i
		for j < len(body) && isBase64Byte(body[j]) {
			j++
		}
		if j-i >= minBareBase64Run && !overlaps(i, j) &&
			looksLikeBase64Payload(body[i:j]) && precededByBase64Key(body, i) {
			probes++
			if probes > maxInlineBinaryProbes {
				return nil
			}
			verdict := inspectInlineBinaryPayload(body[i:j])
			if verdict != inlineBinaryText && foldWithinBudget(verdict, j-i, &unverified) {
				if !budgetOK(j - i) {
					return nil
				}
				out = append(out, byteRange{i, j})
				stripped += j - i
			}
		}
		i = j
	}
	return out
}

// base64ValueKeyPrefixes 是"值里装内联二进制"的已知 JSON 键(含结束引号):
// Anthropic 的 source.data、Gemini 的 inline_data.data、OpenAI 的 b64_json。
// 与 inlineBinaryCarrierKeys 同源,只是**不含** `"url":"`(裸 base64 段不会
// 出现在 url 值里,url 值一定是 data: URI,走 A 分支)。
var base64ValueKeyPrefixes = [][]byte{
	[]byte(`"data":"`),
	[]byte(`"b64_json":"`),
	[]byte(`"data": "`),
	[]byte(`"b64_json": "`),
	[]byte(`"inline_data":"`),
	[]byte(`"inline_data": "`),
}

// precededByBase64Key 判定 body[start:] 这段 base64 值是否紧跟在已知的二进制
// 载体键后面(值本身以引号开始,所以前缀以 `":"` 结尾)。
func precededByBase64Key(body []byte, start int) bool {
	for _, prefix := range base64ValueKeyPrefixes {
		if start >= len(prefix) && bytes.Equal(body[start-len(prefix):start], prefix) {
			return true
		}
	}
	return false
}

// looksLikeBase64Payload 用最低成本的熵判据区分"base64 载荷"与"纯文本长串"
// (重复字符、DNA 序列、无大小写混合的长标识符):4096 字符以上的 base64 编码
// 二进制几乎必然同时出现大写、小写与数字。宁可漏判(退回 4 字节/token 的
// 保守口径),也不把正常正文误判成二进制而少收。
func looksLikeBase64Payload(run []byte) bool {
	var upper, lower, digit bool
	for _, b := range run {
		switch {
		case b >= 'A' && b <= 'Z':
			upper = true
		case b >= 'a' && b <= 'z':
			lower = true
		case b >= '0' && b <= '9':
			digit = true
		}
		if upper && lower && digit {
			return true
		}
	}
	return false
}

// estimatePromptTokensFromBody 是"请求体 → prompt token"折算的**唯一实现**:
// 文本 4 字节/token + 内联二进制按平台口径封顶。返回 (token, 文本字节)。
func estimatePromptTokensFromBody(body []byte) (tokens, textBytes int64) {
	textBytes, blobTokens := stripInlineBinaryPayloads(body)
	return estimateTokensFromBytes(textBytes) + blobTokens, textBytes
}

// estimatePromptFallback 是输入侧兜底估算的**唯一实现**(P1,审计 r7 srvbill-2):
// 整条流**一个可用 usage 都没有收到**时,按已提交的请求体估算 prompt tokens。
//
// 为什么必须补:客户端此前可以用 stream_options.include_usage=false 让上游整条流
// 不报 usage,而兜底只估 completion ⇒ prompt 侧恒记 0(输入侧完全免费),completion
// 侧又被 maxEstimatedCompletionTokens 截顶。现在计量开关由服务端持有
// (applyStreamUsageRequest 无条件写 true),但上游/中转仍可能整条流不报 —— 这时
// 输入侧按请求体补估,不再记 0。
//
// 真实值优先:promptTokens > 0 或上游上报过**可用**的输入侧计量(promptSeen)
// 时原样带出,绝不估算覆盖。
//
// promptSeen 的语义是"收到过**可用**的输入侧计量(>0)"而不是"收到过任何 usage
// 行"(r7 r7f1-4,P3):一条 `data: {"usage":{}}`(parseUsage 返回 ok=true、pt=0)
// 就能把旧判据 usageSeen 置真 ⇒ 输入侧补估整体失效、prompt 回到 0(少收)。
//
// 内联二进制(图片 data URI 等)按平台视觉口径封顶(r7 r7f1-1,P1):旧实现
// 按请求体字节 ÷4,同一份输入上游如实上报 1200 token、补估却是 375045(×313),
// 费用 0.0028 → 0.750362 元 —— 方向是多收,用户被多扣。剥离器的判据在 rc3
// 收紧为"真的是二进制载荷",rc4-1 再收紧为"魔数 + 容器结构 + 整段可打印率"
// (见 stripInlineBinaryPayloads / inspectInlineBinaryPayload);文本部分
// **全额**参与 4 字节/token 估算,不会被折算成 384。
//
// tokenCap(rc3-5):该模型的输入侧上限(上下文窗口;见 promptEstimateCapForModel)。
// 非正值 = 用 maxEstimatedPromptTokens 兜底。命中上限时按**连续期 + 窗口取值**
// 去重告警(不是每个命中请求一条)。
func estimatePromptFallback(promptTokens int64, promptSeen bool, requestBody []byte, tokenCap int64) (tokens int64, estimated bool) {
	if promptTokens > 0 || promptSeen {
		promptEstimationClampMonitor.observeWithinCap()
		return promptTokens, false
	}
	if tokenCap <= 0 {
		tokenCap = maxEstimatedPromptTokens
	}
	n, textBytes := estimatePromptTokensFromBody(requestBody)
	if n <= 0 {
		return 0, false
	}
	if n > tokenCap {
		// 不静默按上限计费:留下可诊断的 warning(上游/中转计量通道异常),
		// 但同一连续期 + 同一窗口只记一条(rc3-5 ②)。
		promptEstimationClampMonitor.observeClamp(tokenCap, n, int64(len(requestBody)), textBytes)
		n = tokenCap
	} else {
		promptEstimationClampMonitor.observeWithinCap()
	}
	return n, true
}

// ---------------------------------------------------------------------------
// "补估命中上限"的可观测性(rc3-5 ②)
// ---------------------------------------------------------------------------
//
// 补估命中模型窗口上限 = 上游/中转的计量通道异常(漏报 usage)且请求确实很长。
// 这条 warning 必须留下,但**不能每请求一条**:按默认限流 60 req/min/用户 ×
// N 用户,长上下文流量会把日志刷满。纪律与 estimationFallbackMonitor 同源:
// 同一**连续期**只报一次;窗口取值(context window)变化时视为新一轮(不同模型
// 的窗口是不同的诊断结论);拿到可用 usage 或未命中上限的结算会把连续期清零。
type promptClampMonitor struct {
	mu      sync.Mutex
	lastCap int64
	warned  bool
}

var promptEstimationClampMonitor = &promptClampMonitor{}

// observeClamp 记录一次"补估命中上限"。
func (m *promptClampMonitor) observeClamp(cap, tokens, bodyBytes, textBytes int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.warned && m.lastCap == cap {
		return
	}
	m.lastCap = cap
	m.warned = true
	log.Printf("gateway: prompt estimate clamped to %d tokens (uncapped estimate %d, request body %d bytes, text %d bytes after stripping inline binary); "+
		"上游没有给出可用 usage —— 计量通道可能异常", cap, tokens, bodyBytes, textBytes)
}

// observeWithinCap 记录一次"没有命中上限"(或拿到了可用 usage):连续期清零。
func (m *promptClampMonitor) observeWithinCap() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.warned = false
	m.lastCap = 0
}

// reset 清空状态(测试用:避免用例之间通过全局观测器互相影响)。
func (m *promptClampMonitor) reset() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.warned = false
	m.lastCap = 0
}

// ---------------------------------------------------------------------------
// "上游不报 usage"的可观测性(r7 r7f1-1 ③)
// ---------------------------------------------------------------------------
//
// 补估只在**上游没有给出可用 usage**时启动。单次漏报可能是偶发(流中断),
// **连续命中**说明上游/中转的计量通道坏了(改协议、丢 usage chunk),而管理端
// 在旧实现里只能看到一条 usage.estimated 行 —— 看不出"计量表坏了"。这里按
// 连续命中计数,达到阈值记一条 warning(每轮连续期只记一次,不刷日志)。
const estimationFallbackWarnStreak = 20

type estimationFallbackMonitor struct {
	mu          sync.Mutex
	consecutive int64
	total       int64
	warned      bool
}

var promptEstimationMonitor = &estimationFallbackMonitor{}

// observeMissingUsage 记录一次"上游没有给出任何可用 usage"的结算。
func (m *estimationFallbackMonitor) observeMissingUsage() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.consecutive++
	m.total++
	if !m.warned && m.consecutive >= estimationFallbackWarnStreak {
		m.warned = true
		log.Printf("gateway: %d consecutive stream settlements had NO usable upstream usage; falling back to local token estimation "+
			"(上游/中转计量通道可能异常:usage chunk 缺失或全为 0)", m.consecutive)
	}
}

// observeReportedUsage 记录一次拿到可用 usage 的结算(连续计数归零)。
func (m *estimationFallbackMonitor) observeReportedUsage() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.consecutive = 0
	m.warned = false
}

// snapshot 返回 (累计"无可用 usage"次数, 当前连续次数),供排障与测试读取。
func (m *estimationFallbackMonitor) snapshot() (total, consecutive int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.total, m.consecutive
}

// streamSettlement 是一次流式收尾结算的输入(r7 r7f1-2,P2)。
//
// 两个"交付量"口径必须分开:
//   - deliveredBody:上游转发过的**原始 SSE 字节**(含帧、[DONE]、error 事件),
//     只用于日志/诊断,**不是**计费基数;
//   - contentBytes/contentChunks:**正文内容**字节与增量 chunk 数(真正的模型
//     产出)—— 补估闸门与 completion 估算的唯一基数。
//
// 旧实现把 deliveredBody 一并当闸门,于是上游 200 起流后只回一条 error 事件
// (过载/内容过滤,客户端 0 正文字节)也被按整个请求体扣费 0.200062 元。
//
// promptSeen/completionSeen 是**按侧独立**记忆的"上游给出过可用计量(>0)"
// (r7 r7f1-4,P3):一条零值 usage 行不足以关掉输入侧补估。
type streamSettlement struct {
	usageID     int64
	requestBody []byte
	// promptTokenCap 是该模型的输入侧补估上限(rc3-5:上下文窗口;0 = 128K 兜底)。
	promptTokenCap int64
	// deliveredBody 只为日志保留(诊断"转发了多少、正文多少")。
	deliveredBody int64
	// contentBytes 是正文内容字节(completion 估算基数);
	// contentChunks 是正文/工具调用增量 chunk 数(补估闸门)。
	contentBytes  int64
	contentChunks int64

	promptTokens     int64
	completionTokens int64
	cacheTokens      int64
	promptSeen       bool
	completionSeen   bool
}

// settleStreamFallback 是流式收尾兜底结算的**唯一实现**(G12,审计 2026-09-13)。
//
// 上游没有回报 usage、或只回报了输入侧(例如 Anthropic 流在 message_start
// 之后就断了;N1,审计 r3 第四轮:调用方的前置条件曾把「pt>0 且 ct==0」排除,
// 于是 completion 永不估算)时,按**已经交付的正文内容字节**估算 completion
// tokens 并回填 —— 与 chat 流式 2026-08 起就有的口径完全同源(同一个
// fallbackCompletionTokens,不是第二份实现)。真实值优先:只补 completion
// 缺失的那一半(ct<=0 才填),不会把上游报的用量改大或改小;输入侧
// (prompt/cache)原样带出,**绝不被估算覆盖**。
//
// requestBody/promptSeen(审计 r7 srvbill-2 + r7f1-4):整条流没有**可用**的
// 输入侧计量时,prompt 侧同样补估(见 estimatePromptFallback);上游给出过
// 可用的输入侧计量就保持上游口径(绝不估算覆盖)。注意判据是"按侧独立"的:
// 一条零值 usage 行、或只报了 completion_tokens 的流,都不足以关掉输入侧补估。
//
// 返回 settled=false 且 err==nil 表示这次流没有任何可计费内容(pending 行已删除)。
// 返回 err != nil 时调用方必须 fail-closed(abortSettlementFailureStream)。
func settleStreamFallback(db *sql.DB, in streamSettlement) (bool, error) {
	// 输入侧补估的前提是**这条流确实产生了可计费的工作**,判据有两条(任一成立):
	//
	//   ① 正文真的交付过(r7 r7f1-2):解析到过正文/工具调用增量。上游协议错误
	//      (单行过大)/空流/只回一条 error 事件时,客户端一个正文字节都没拿到 ——
	//      既不能计费,也不能把 pending 行留成账单(下面按全 0 删除)。判据是
	//      "解析到过正文",不是"转发过任意一行"(data: [DONE]/event:/error 事件
	//      都不算)。
	//   ② **上游自己报了输出侧用量**(completion/cache > 0):这是"请求确实被
	//      执行、模型确实产出了 token"的直接证据。此时即使正文没能解析出来
	//      (上游流形态不在识别面内),输入侧也不该白送 —— 只报 output_tokens
	//      而不报 input_tokens 是上游的常见残缺报文。
	//
	// 两者都不成立(纯 error-only / [DONE]-only / 空流,且上游一个用量都没报)
	// 时不计费,由下面按全 0 删除 pending 行。
	billableWorkSeen := in.contentChunks > 0 || in.contentBytes > 0 ||
		in.completionTokens > 0 || in.cacheTokens > 0
	var promptEstimated bool
	if billableWorkSeen {
		in.promptTokens, promptEstimated = estimatePromptFallback(in.promptTokens, in.promptSeen, in.requestBody, in.promptTokenCap)
	}
	// completion 估算的基数同样只认**正文内容字节**:SSE 帧、usage 行、[DONE]
	// 都不是模型产出(r7 r7f1-2 的"估算放大器"面)。
	completionTokens, completionEstimated := estimateCompletionFallback(in.promptTokens, in.completionTokens, in.contentBytes)
	estimated := promptEstimated || completionEstimated
	if in.promptTokens <= 0 && completionTokens <= 0 && in.cacheTokens <= 0 {
		// 正文一个字节都没交付(连接失败/空流/error-only):删除 pending 行,不留痕迹。
		return false, serverstore.DeleteUsage(db, in.usageID)
	}
	// 可观测性(r7 r7f1-1 ③):连续多笔结算都拿不到可用 usage ⇒ 记 warning。
	if !in.promptSeen && !in.completionSeen {
		promptEstimationMonitor.observeMissingUsage()
	} else {
		promptEstimationMonitor.observeReportedUsage()
	}
	if err := updateUsageTokensSettled(db, in.usageID, in.promptTokens, completionTokens, in.cacheTokens, estimated); err != nil {
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
	// 应用维度归因（0076/§21.4）：pending 行是**整条流的计量锚点**，归因也钉在它上面
	// —— 覆盖全部四条流式入口（chat/completions/responses/messages），一处接线。
	a.bindUsageAppID(c, usageID)
	return usageID, true
}
