package llmgateway

// SSE 出口的写截止时间续期(2026-09-21)。
//
// 问题:`http.Server.WriteTimeout`(cmd/server/main.go 的 5 分钟)是**从读到请求头那一刻
// 算起**的绝对写截止时间,与"有没有在写"无关 —— 活跃的 SSE 流同样会在恰好 5 分钟处被掐断。
// 实测(探针,HTTP/1.1 与 HTTP/2 都会断):
//
//	客户端:unexpected EOF / stream error: INTERNAL_ERROR
//	服务端:write tcp …: i/o timeout
//
// 流式对话只要**单次生成**活跃超过 5 分钟就必然丢答案(上游 idle 看门狗 90s 只杀空闲流,
// 对"一直在出数据"的流没有任何总时长上限)⇒ 必须在每次向客户端 flush 前续期。
//
// 为什么不是调大全局 WriteTimeout:那是把所有响应(含慢体/慢写面)一起放宽,slowloris
// 防护会退化;这里只续**流式出口自己**的这一次响应。

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// sseWriteRefreshKey 是本次请求上次续期时间的 context 键(见 touchSSEWriteDeadline)。
const sseWriteRefreshKey = "picoaide.llmgateway.sseWriteRefreshedAt"

// sseWriteWindow 是每次续期把写截止时间推到的时长。
//
// 判据(有界,不取消超时):
//   - 必须**大于上游 idle 看门狗**(streamIdleTimeout,缺省 90s):只要上游还在出数据,
//     两次 flush 的间隔就 ≤ idle 窗口 ⇒ 续期总发生在旧截止时间之前;
//   - 下限 60s:idle 窗口在测试里会被调小(如 300ms),没有下限的话窗口会跟着缩到
//     比 flush 间隔还短,反而制造新的截断;
//   - 流真的空闲时由 idle 看门狗主动终止(缺省 90s),所以放宽写截止时间不会挂死连接。
func sseWriteWindow() time.Duration {
	w := 2 * streamIdleTimeout
	if w < time.Minute {
		w = time.Minute
	}
	return w
}

// touchSSEWriteDeadline 在向客户端 flush 一块 SSE 数据前续写截止时间。
//
// 节流:距上次续期不足窗口的 1/3 就直接返回 —— SetWriteDeadline 在 HTTP/2 下要经
// server loop(每 chunk 一次没必要),而 1/3 的节流仍保证旧截止时间至少还剩 2/3 窗口
// (缺省 120s)时才可能被跳过,不会出现"续期比 flush 间隔还晚"。
// 底层不支持(SetWriteDeadline 返回 ErrNotSupported)时保持原语义,不新增失败面。
func touchSSEWriteDeadline(c *gin.Context) {
	if c == nil {
		return
	}
	now := time.Now()
	window := sseWriteWindow()
	if last, ok := c.Get(sseWriteRefreshKey); ok {
		if t, ok := last.(time.Time); ok && now.Sub(t) < window/3 {
			return
		}
	}
	_ = http.NewResponseController(c.Writer).SetWriteDeadline(now.Add(window))
	c.Set(sseWriteRefreshKey, now)
}
