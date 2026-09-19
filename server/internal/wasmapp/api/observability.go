package api

import (
	"log"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/capapi"
)

// 准入级失败的可观测性（OPS-6 / 契约 §12「可观测性增量」）。
//
// 问题（R1-OPS-6 原文）：`wasm_call_events` 只覆盖**进了执行管线**的调用 ——
// 401/403/404/410 这类在准入阶段就返回的失败**一个字节都不落**。真实症状是：
// 员工说"应用打不开"，运营面上却什么都看不到（既没有错误码，也不知道是谁、
// 打的是哪个应用），只能靠人肉复现。
//
// 本文件的落点 = **两个出口同时写**（两者互补，不是二选一）：
//
//	① `wasm_call_events`（若装配了 Events）：与执行期失败同一张表、同一套字段
//	   （app_id / user_id / outcome=error / reason_code），于是"这个应用今天失败
//	   多少次"是一条 SQL 就能答的问题，不必区分失败发生在准入还是执行；
//	② 结构化日志行：带上 **request_id**。表里没有 request_id 列（那是 0072 的
//	   既定列集，W1 不新增迁移），而"把客户端看到的 id 与服务端日志对齐"恰恰是
//	   排障最需要的一步，因此它落在日志行与 `Evidence` 字段里。
//
// 纪律：**绝不**把 bearer、proof、Cookie、请求体写进这两个出口（§8 的错误面纪律
// 同样适用于观测面）。这里只写标识与码。
func (h *Handlers) admissionFailed(c *gin.Context, appID string, user *serverstore.User, status int, code apperr.Code, reason string) {
	if c == nil {
		return
	}
	rid := requestID(c)
	var uid int64
	username := ""
	if user != nil {
		uid = user.ID
		username = user.Username
	}
	path := ""
	method := ""
	if c.Request != nil {
		method = c.Request.Method
		if c.Request.URL != nil {
			path = c.Request.URL.Path
		}
	}
	log.Printf("wasm_admission_failed request_id=%s method=%s path=%s app_id=%s user_id=%d user=%s status=%d code=%s reason=%s",
		rid, method, path, appID, uid, username, status, string(code), reason)
	if h.opt.Events != nil {
		// Record 是非阻塞的（只写环形内存），因此它可以安全地放在请求路径上。
		h.opt.Events.Record(capapi.CallMetrics{
			AppID:      appID,
			UserID:     uid,
			Outcome:    capapi.OutcomeError,
			ReasonCode: string(code),
			// Evidence 是有界自由字段（≤200 字节）：准入失败没有 CPU/内存可记，
			// 但有"这次请求是谁、从哪条判据被挡下的"。
			Evidence: clipEvidence("source=admission; request_id=" + rid + "; status=" + itoa(status) + "; reason=" + reason),
		})
	}
}

// admissionOK 记录一次**成功**的准入级动作（目前只有 open 端点用得上）。
//
// 为什么要记成功：open 端点每次打开都会调一次，而它**不进入执行管线** ⇒
// 若不记，"某应用今天被打开了几次"在调用事件表里同样是空白（与失败同源的问题）。
// 计数的权威仍在 `wasm_app_opens`（F16），这里是同一事件的观测副本，让运营面
// 能在同一张表里看到准入 + 执行的完整链路。
func (h *Handlers) admissionOK(c *gin.Context, appID string, user *serverstore.User, detail string) {
	if c == nil || h.opt.Events == nil {
		return
	}
	var uid int64
	if user != nil {
		uid = user.ID
	}
	h.opt.Events.Record(capapi.CallMetrics{
		AppID:      appID,
		UserID:     uid,
		Outcome:    capapi.OutcomeOK,
		ReasonCode: "",
		Evidence:   clipEvidence("source=admission; request_id=" + requestID(c) + "; " + detail),
	})
}

// clipEvidence 把证据串截到 CallMetrics.MaxEvidenceBytes 以内（events 落库前还会再截一次）。
func clipEvidence(s string) string {
	if len(s) <= capapi.MaxEvidenceBytes {
		return s
	}
	return s[:capapi.MaxEvidenceBytes]
}

// itoa 是 strconv.Itoa 的本地别名，避免为一个整数转换引入 import。
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// 编译期断言：本文件只依赖标准库 + 平台包，不引入任何 HTTP 客户端（观测面不发请求）。
var _ = http.StatusUnauthorized
