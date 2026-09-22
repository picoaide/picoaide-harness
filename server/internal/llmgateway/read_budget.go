package llmgateway

import (
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
)

// ---------------------------------------------------------------------------
// /v1 各入口的请求体读预算与读失败分类（2026-09-22）
// ---------------------------------------------------------------------------
//
// 现场（2026-09-22，某客户端）：一轮对话连续 4 次以
// `请求体格式错误 / INVALID_REQUEST / 400` 结束，客户端侧每次耗时 65.9–73.4s，
// 服务端 gin 日志同一时刻四条 `400 | 1m0s | POST /v1/chat/completions`。
//
// 根因：全局 `http.Server.ReadTimeout`（= limits.ServerReadTimeout，60s）是
// slowloris 防护，但 Go 的 ReadTimeout **覆盖整个请求体**。一条长会话的请求体
// 很大（现场：prompt ≈65.5 万 token ⇒ 约 3MiB，含 347 个工具 schema 与内联图片），
// 客户端上行一时低于 ~47KB/s 就会在读满之前被切断；切断后 `io.ReadAll` 返回
// `i/o timeout`，而旧实现把它和"真的格式错误"合并写成 400「请求体格式错误」。
// 客户端 SDK（llm-deepseek 的 httpErrorCode）把 400 一律映射为 INVALID_REQUEST，
// 而重试策略只认 EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT ⇒ 一次即终局，
// 用户只能手动重发，且错误文案把人/模型引向"格式问题"这个错误方向。
//
// 这里按**路由**放宽，而不是改全局常量：limits.ServerReadTimeout 参与
// `ClientUploadTimeout(90s) > ServerReadTimeout >= CompileTimeout` 的序关系断言
// （internal/wasmapp/limits/limits_gen_test.go），改它会让那条断言说谎，也会把
// 所有端点的慢体窗口一起放宽。写侧已有同口径先例（sse_deadline.go 的
// SetWriteDeadline 续期、clientrelease.go 的下载写截止时间）。
//
// 业务上限由**体积上限**承担（maxChatBody 等，64MiB）；读预算只负责
// "别把慢链路判成坏请求"。
const gatewayBodyReadBudget = time.Hour

// bodyReadBudget 是测试可注入的读预算（缺省 = gatewayBodyReadBudget）。
var bodyReadBudget = gatewayBodyReadBudget

// gatewayWriteBudget 是**读完请求体之后**重新给响应写截止时间的窗口。
//
// 为什么必须续：Go 的 `http.Server.WriteTimeout`（cmd/server/main.go 的 5 分钟）是在
// **读完请求头那一刻**定死的绝对写截止时间（net/http/server.go 的 writeDeadline 设置），
// 与"有没有在写"无关。读预算放宽到 1h 之后，一次"上传 6 分钟 + 生成 2 分钟"的请求在写
// 响应时早已超过写截止时间 ⇒ 客户端拿到 EOF/连接被断，而服务端把它当成功；chat 路径此时
// 上游已调用并计费，客户端把 EOF 归成 TRANSPORT（可重试）⇒ 可能重复计费。
// 写侧已有同样先例：sse_deadline.go 每次 flush 前续期、clientrelease.go 下载续期。
//
// 取值须覆盖非流式上游等待窗口（nonStreamBodyTimeout = 10 分钟）+ 结算时间。
const gatewayWriteBudget = 15 * time.Minute

// writeBudget 是测试可注入的写预算（缺省 = gatewayWriteBudget）。
var writeBudget = gatewayWriteBudget

// extendBodyReadDeadline 把本次请求的读截止时间推到 now+budget。
//
// Go 的 server 对**每个新请求**都会按 ReadTimeout 重设读截止时间，所以这里的
// 放宽不会被复用连接上的下一个请求继承；慢头攻击仍由 ReadHeaderTimeout(10s) 与
// MaxHeaderBytes(16KiB) 拦住。底层不支持（ResponseController 返回
// ErrNotSupported）时保持原语义，不新增失败面。
//
// 护栏：注入值 <= 0（测试误配/将来做成可配）时**不延长**，退回全局 ReadTimeout，
// 而不是把截止时间设到过去（那会让全站请求瞬间判成读超时）。
func extendBodyReadDeadline(c *gin.Context) {
	if c == nil || bodyReadBudget <= 0 {
		return
	}
	_ = http.NewResponseController(c.Writer).SetReadDeadline(time.Now().Add(bodyReadBudget))
}

// renewWriteDeadline 读完请求体后把写截止时间推到 now+writeBudget（见
// gatewayWriteBudget 的说明）。底层不支持时保持原语义。
func renewWriteDeadline(c *gin.Context) {
	if c == nil || writeBudget <= 0 {
		return
	}
	_ = http.NewResponseController(c.Writer).SetWriteDeadline(time.Now().Add(writeBudget))
}

// bodyReadTimeout 判断错误是否来自读截止时间到点（客户端上传过慢/中途断流）。
// 真实 server 与 httptest 上都是 *net.OpError（i/o timeout）；一并认
// os.ErrDeadlineExceeded，避免换实现后判据失效。
func bodyReadTimeout(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, os.ErrDeadlineExceeded) {
		return true
	}
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// readRequestBody 是 /v1 各入口读取请求体的**唯一**实现：先放宽读预算，再按
// limit 读取，并把失败分成三类可判定形态。
//
// 返回 (raw, true) 表示读取成功；返回 (nil, false) 时响应已经写好，调用方直接
// return。三类失败：
//   - 超过体积上限 → 413 VALIDATION「请求体过大」（MaxBytesError，可判定）；
//   - 读截止时间到点 → 503 SERVER「读取请求体超时」（**可重试**：客户端重试策略
//     认 SERVER；旧实现报 400，被归类 INVALID_REQUEST 且不重试）；
//   - 其它读失败（客户端中途断开等）→ 400 VALIDATION「请求体读取失败」。
//
// 判据护栏：read_budget_test.go 的 TestReadRequestBodyClassifiesFailures
// （三类各一例）与 TestEveryGatewayBodyReadUsesHelper（源码扫描：除本文件外
// 不得再有 io.ReadAll(c.Request.Body)）。
func readRequestBody(c *gin.Context, limit int64) (clientBody, bool) {
	extendBodyReadDeadline(c)
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
	started := time.Now()
	raw, err := io.ReadAll(c.Request.Body)
	if err == nil {
		// 读完请求体：把写截止时间从"请求头时刻 + WriteTimeout"往后推，否则
		// "上传久 + 生成久"的请求会在写响应时超时（客户端 EOF、服务端当成功）。
		renewWriteDeadline(c)
		return raw, true
	}
	var maxErr *http.MaxBytesError
	switch {
	case errors.As(err, &maxErr):
		log.Printf("gateway: request body over limit: %s %s limit=%d err=%v",
			c.Request.Method, c.Request.URL.Path, limit, err)
		serverauth.WriteError(c, http.StatusRequestEntityTooLarge, "VALIDATION", "请求体过大")
	case bodyReadTimeout(err):
		log.Printf("gateway: read request body timed out after %v: %s %s bytes=%d budget=%v err=%v",
			time.Since(started).Truncate(time.Millisecond), c.Request.Method, c.Request.URL.Path,
			len(raw), bodyReadBudget, err)
		serverauth.WriteError(c, http.StatusServiceUnavailable, "SERVER", "读取请求体超时（客户端上传过慢），请稍后重试")
	default:
		log.Printf("gateway: read request body failed after %v: %s %s bytes=%d err=%v",
			time.Since(started).Truncate(time.Millisecond), c.Request.Method, c.Request.URL.Path, len(raw), err)
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体读取失败")
	}
	return nil, false
}
