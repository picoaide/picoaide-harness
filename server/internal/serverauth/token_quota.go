package serverauth

// 员工自助签发令牌的**配额**（R15C-R-01 ③，审计 2026-09-25，P1）。
//
// 缺陷形态：客户端登录（`POST /api/client/v2/auth/login`）与 OIDC 回调每次成功都
// `IssueToken` ⇒ 插一条 90 天有效令牌，**不去重、不轮换旧的、不按用户限额**；而
// 失败预算在成功时被 `loginSucceeded` 清空 ⇒ 成功登录不消耗任何预算。实测单账号
// 32 线程 30 s 拿到 279 次成功登录（9.0 次/秒，上限是本地 argon2 校验闸而非限流），
// 折算 **77.6 万行/天 / ≈99 MiB/天响应体增长**。行数没有上界 ⇒ 任何持证员工都能
// 单方面把管理端列表（修复前无分页）放大成全站 OOM。
//
// 修法：给"自助签发"加**按用户 + 滑动时间窗**的配额。判定与记账复用本包既有的
// `loginLimiter`（`allow()` = 判定即记账，同一临界区 —— 并发突发不会穿透，这正是
// 审计 2026-09-23 E-01 在登录桶上定下的语义）。**成功签发票据消耗配额**（与失败
// 预算相反：那一条是"成功即清空"，因为失败预算防的是爆破；本条防的是行数累积，
// 所以只有签发本身消耗预算，且窗口滑出前不恢复）。
//
// 为什么按 userID 而不是用户名：登录名可以有多来源（LDAP/OIDC 同名），但行挂在
// `api_tokens.user_id` 上 —— 配额必须与被保护资源同键。
//
// 边界（诚实登记）：
//   - 只覆盖**员工自助**两条路径（本地登录 / OIDC 回调）。管理员为集成方签发
//     （管理端令牌面）与测试直接调 `IssueToken` 不经此闸；
//   - 阈值是编译期常量，未做 env 旋钮（本仓对非法 env 一律要求 fail-loud，新增
//     旋钮要连带一套校验与文档；先按"够用且不误伤"取值，需要可配时另立一条）；
//   - 超限返回 429 `RATE_LIMITED`（与既有登录限流同一码），窗口滑出后自动恢复，
//     不需要运维介入。

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// tokenIssueMaxPerWindow 是**单用户在窗口内可签发的令牌数**。
//
// 取值 20/10min（≈ 1 次/30 s 的持续速率）：
//   - 真实客户端只在首次登录/登出/换密/令牌失效时登录，几台设备也远达不到；
//   - 对照实测的攻击面 9.0 次/秒，配额把它压到 **1/270**；90 天窗口内单账号最多
//     约 26 万行（修复前无上界），且这已是"持续打满配额 90 天"的极端值；
//   - 与本仓既有的 `PICOAI_GATEWAY_MAX_INFLIGHT_PER_USER`（缺省 32）同属"每用户
//     一条硬顶"的形态，语义直白、可解释。
const (
	tokenIssueMaxPerWindow = 20
	tokenIssueWindow       = 10 * time.Minute
)

// errTokenIssueQuota 表示配额已满（调用方映射 429 RATE_LIMITED，与"密码错误"
// 严格区分 —— 否则用户会看到误导性的"登录失败"）。
var errTokenIssueQuota = errors.New("token issue quota exceeded")

// tokenIssueLimiterMaxEntries 是桶表容量（与登录桶同口径：攻击者用海量账号填表
// 也不能让内存无界增长）。
const tokenIssueLimiterMaxEntries = 10000

var (
	sharedTokenIssueLimiterOnce sync.Once
	sharedTokenIssueLimiter     *loginLimiter
)

// sharedTokenIssueQuotaLimiter 返回进程级共享的签发配额桶（包级单例：生产单实例
// 里所有 API 句柄共享同一份配额；测试的临时库按 dbLimiterScope 隔离）。
func sharedTokenIssueQuotaLimiter() *loginLimiter {
	sharedTokenIssueLimiterOnce.Do(func() {
		sharedTokenIssueLimiter = &loginLimiter{
			attempts:      map[string][]time.Time{},
			maxEntries:    tokenIssueLimiterMaxEntries,
			maxAttempts:   tokenIssueMaxPerWindow,
			window:        tokenIssueWindow,
			lastSweep:     time.Now(),
			maxAttemptsFn: func() int { return tokenIssueMaxPerWindow },
		}
	})
	return sharedTokenIssueLimiter
}

// tokenIssueBudgetKey 是配额的桶键构造点（唯一实现）。
//
// 判定/记账出自同一个键 —— 本仓有过"三处各自拼键、漏改一处 ⇒ 判定键 ≠ 记账键 ⇒
// 限流静默失效"的教训（见 ratelimit.go 的 loginIPBudgetKey 注释），所以这里不
// 允许调用方自己拼字符串。
func tokenIssueBudgetKey(db *sql.DB, userID int64) string {
	return dbLimiterScope(db) + "tokissue:" + strconv.FormatInt(userID, 10)
}

// tokenIssueAllowed 判定并**同时记账**一次自助签发（allow = 判定即记账）。
func (a *API) tokenIssueAllowed(userID int64) bool {
	return sharedTokenIssueQuotaLimiter().allow(tokenIssueBudgetKey(a.DB, userID))
}

// resetTokenIssueQuotaForTest 清空进程级签发配额桶（**仅测试**：包级单例跨用例
// 存活，与 resetSharedLimitersForTest 同口径 —— 只清内容、不替换实例，因为已构造
// 的 API 句柄持有旧指针）。由本包的测试入口调用。
func resetTokenIssueQuotaForTest() {
	l := sharedTokenIssueQuotaLimiter()
	l.mu.Lock()
	l.attempts = map[string][]time.Time{}
	l.lastSweep = time.Time{}
	l.mu.Unlock()
}

// issueTokenForLogin 是**员工自助登录**路径唯一的签发入口：先过配额，再签发。
//
// 返回 errTokenIssueQuota 时调用方必须回 429 RATE_LIMITED（不要混进 500）。
func (a *API) issueTokenForLogin(c *gin.Context, user *serverstore.User) (string, error) {
	if !a.tokenIssueAllowed(user.ID) {
		// 可检索留痕（与登录失败留痕同面）：谁被配额挡住必须能从日志/审计看出。
		_ = serverstore.AuditLog(a.DB, user.Username, "token_issue_quota_exceeded",
			"user_id="+strconv.FormatInt(user.ID, 10)+" ip="+c.ClientIP())
		return "", errTokenIssueQuota
	}
	return IssueToken(a.DB, user.ID)
}

// writeTokenIssueError 把签发错误映射到既有错误信封（429 与 500 分开）。
func writeTokenIssueError(c *gin.Context, err error) {
	if errors.Is(err, errTokenIssueQuota) {
		writeError(c, http.StatusTooManyRequests, "RATE_LIMITED",
			"令牌签发过于频繁,请稍后再试")
		return
	}
	writeError(c, http.StatusInternalServerError, "INTERNAL", "令牌签发失败")
}
