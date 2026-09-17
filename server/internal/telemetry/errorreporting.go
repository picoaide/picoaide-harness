package telemetry

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// 客户端错误上报状态遥测(2026-09-16,GlitchTip 收集为空缺陷 R1)。
//
// 背景:客户端按 bootstrap 下发的 `web.error_reporting_dsn` 初始化 Sentry
// 兼容上报,失败时**静默降级**(见 packages/host/enterprise/src/error-reporting.ts)
// —— 服务端把 DSN 发出去之后,对"客户端到底有没有在报"一无所知(现场事故:
// GlitchTip 项目始终为空,后台没有任何信号可查)。客户端因此计算一份状态
// {state, reason, dsnHost, level, release} 并上报到这里,按用户落一行(0068),
// 管理端聚合展示。
//
// 非致命语义(与 reportSkillCall 一致,这是遥测不是业务写入):
//   - 未知 state:静默忽略 —— 200 {"ok":true} 但**不落库**。客户端版本可能
//     比服务端新,不能因为一个不认识的状态值把上报变成错误;未知取值也不
//     进入管理端聚合页(计数按键白名单渲染)。
//   - 单字段不合法(level 不在白名单 / dsn_host 不是裸主机名 / 超长):
//     丢弃或截断该字段,整条状态仍然记录 —— 排障时"客户端报了 failed"比
//     "某个字段格式不对所以什么都没留下"有用得多。
//   - 只有「请求体不是 JSON」(客户端实现有问题,与 skill-call 同响 400)
//     与「限流」会返回 4xx。
// ---------------------------------------------------------------------------

// 字段上限(与 serverstore 的截断口径同源;reason 按 rune 截断——中文原因常见)。
const (
	errorReportingMaxReasonRunes = serverstore.ErrorReportingMaxReasonRunes
	errorReportingMaxDSNHostLen  = serverstore.ErrorReportingMaxDSNHostLen
	errorReportingMaxReleaseLen  = serverstore.ErrorReportingMaxReleaseLen
)

// errorReportingStates 是允许落库的状态白名单(与客户端 state 取值同一套,
// 常量在 serverstore 侧定义,客户端 TS 侧同名)。
var errorReportingStates = map[string]bool{
	serverstore.ErrorReportingStateIdle:              true,
	serverstore.ErrorReportingStateDisabled:          true,
	serverstore.ErrorReportingStateReady:             true,
	serverstore.ErrorReportingStateFailed:            true,
	serverstore.ErrorReportingStateConfigUnavailable: true,
}

// errorReportingLevels 是允许落库的最低上报等级(Sentry 等级;空串 = 客户端
// 未指定,合法)。
var errorReportingLevels = map[string]bool{
	"": true, "debug": true, "info": true, "warning": true, "error": true,
}

// 限流:每用户 10 次/分钟。状态变化是低频事件(正常一次登录 1-2 次),10 次
// 留出重连/重试余量;与 skill-call 的双桶分开,互不挤占预算。
// 可用环境变量下调(测试/压测);0 = 不限。
var (
	errorReportingPerUserPerMin = envInt("PICOAI_TELEMETRY_ERROR_REPORTING_MAX_PER_MIN", 10)
	errorReportingLimiter       = newCallLimiter(time.Minute)
)

// reportErrorReporting 记录客户端错误上报链路的当前状态(按用户 upsert,0068)。
//
// 请求体:{"state":"ready|disabled|failed|config_unavailable|idle","reason":"...",
// "dsn_host":"...","level":"...","release":"..."};除 state 外全部可选,
// 任意字段不合法都只影响该字段(见文件头非致命语义)。
func reportErrorReporting(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			State   string `json:"state"`
			Reason  string `json:"reason"`
			DSNHost string `json:"dsn_host"`
			Level   string `json:"level"`
			Release string `json:"release"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		// SG-1(审计 2026-09-17;r3v 复核补 state):state 也必须**先剥控制字符
		// 再查白名单**。只 TrimSpace + 查白名单时 `failed\u0000` 不在白名单里,
		// 于是走「未知状态静默忽略」分支:回 200 {ok:true} 但**一个字都不落库**,
		// 该用户上一行(如上一次的 ready)继续在后台显示 —— 正是 SG-1 要消灭的
		// "后台显示正常、客户端已经坏掉",而且触发它的正是 SG-1 自己清洗的那类
		// 字符。清洗后仍按白名单判定:真正不认识的状态值才走静默忽略。
		state := stripControlChars(strings.TrimSpace(req.State))
		if !errorReportingStates[state] {
			// 未知状态静默忽略(不落库、不消耗上报预算),与 reportSkillCall
			// 对"平台上不存在的技能"的静默成功同语义。
			c.JSON(http.StatusOK, gin.H{"ok": true})
			return
		}
		// dsn_host 只接受裸主机名(可选端口):整条 DSN 含公钥,绝不落库。
		dsnHost := strings.TrimSpace(req.DSNHost)
		if !validDSNHost(dsnHost) {
			dsnHost = ""
		}
		level := strings.TrimSpace(req.Level)
		if !errorReportingLevels[level] {
			level = ""
		}
		// SG-1(审计 2026-09-17):先剥控制字符再截断 —— 一个 `\u0000` 会让
		// PostgreSQL 拒绝整个参数(UPDATE/INSERT 失败 ⇒ 500 + 整行不落库,
		// 用户上一行旧状态继续在后台显示正常)。清洗而不是报错,与文件头
		// 「单字段不合法只清洗该字段」的契约一致。
		reason := serverstore.TruncateRunes(stripControlChars(strings.TrimSpace(req.Reason)), errorReportingMaxReasonRunes)
		release := serverstore.TruncateRunes(stripControlChars(strings.TrimSpace(req.Release)), errorReportingMaxReleaseLen)

		// 限流放在校验之后:非法/未知请求不消耗上报预算(与 skill-call 一致)。
		if u := serverauth.CurrentUser(c); u != nil {
			if !errorReportingLimiter.allow("u:"+strconv.FormatInt(u.ID, 10), errorReportingPerUserPerMin) {
				serverauth.WriteError(c, http.StatusTooManyRequests, "RATE_LIMITED", "上报过于频繁,请稍后再试")
				return
			}
			if err := serverstore.UpsertErrorReportingStatus(db, u.ID, state, reason, dsnHost, level, release); err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "记录失败")
				return
			}
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// validDSNHost 判定上报的 dsn_host 是否是**裸主机名**(可带数字端口)。
//
// 字符集只允许 [A-Za-z0-9.-]:带 scheme(`://`)、路径(`/`)、userinfo(`@`)
// 的值一律判非法 —— 客户端报的应是"事件发往哪台机器",不是含公钥的 DSN。
// 端口是刻意允许的:客户端取的是 URL.host(含端口),而自建 GlitchTip 默认
// 就跑在 8000 端口,把 `:8000` 判非法会让最常见的现场配置在后台看起来
// "没有主机",丢掉这条最关键的排障信息。IP 字面量(含 IPv6 方括号)不在
// 允许范围内:本字段用于展示与人工核对,不参与任何网络请求。
func validDSNHost(host string) bool {
	if host == "" || len(host) > errorReportingMaxDSNHostLen {
		return false
	}
	name, port, hasPort := strings.Cut(host, ":")
	if hasPort {
		if port == "" || len(port) > 5 || !allDigits(port) {
			return false
		}
		if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
			return false
		}
	}
	if name == "" {
		return false
	}
	for i := 0; i < len(name); i++ {
		ch := name[i]
		ok := ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' ||
			ch >= '0' && ch <= '9' || ch == '.' || ch == '-'
		if !ok {
			return false
		}
	}
	// 首尾不得是 '.' / '-'(非法标签边界,顺带挡掉 "." / ".." 这类占位值)。
	return !strings.HasPrefix(name, ".") && !strings.HasSuffix(name, ".") &&
		!strings.HasPrefix(name, "-") && !strings.HasSuffix(name, "-")
}

// allDigits 判定纯 ASCII 数字串(端口)。
func allDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}
