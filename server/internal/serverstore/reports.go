package serverstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// 报表订阅(2026-09 P1):每月生成上月用量汇总推送 webhook 的订阅配置。
// ---------------------------------------------------------------------------

// MaskedHookURL 是 webhook 地址对外(管理端列表/任何 JSON 响应)的占位值。
//
// 审计 2026-09-12 P1-4:hook_url 是**凭据本体**——钉钉/企微/飞书机器人地址
// 自带 `key=…`/`access_token=…`,谁拿到谁就能往企业群里发任意内容;它此前
// 对只读 auditor 明文可读(挂在 usage:read 上),现在既收紧了权限点
// (report:read,不进 AuditorPermissions),也在序列化层去掉明文。
// 与 serverauth.MaskSecret 同值同语义("***" = 服务端保持现值):
// 管理端把该值原样回传时,UpdateReportSubscription 视为「不修改」。
const MaskedHookURL = "***"

// ReportSubscription 一条订阅配置。
type ReportSubscription struct {
	ID        int64      `json:"id"`
	Name      string     `json:"name"`
	Enabled   bool       `json:"enabled"`
	HookURL   string     `json:"hook_url"`
	LastRunAt *time.Time `json:"last_run_at,omitempty"`
	LastError string     `json:"last_error"`
	// PendingPeriod 是"最早未成功投递的那一期"（北京月，`YYYY-MM`；空 = 没有欠投）。
	// R19A-S1-07（审计 2026-09-25，P2）：失败跨过月界时，投递必须仍在补**这一期**，
	// 而不是静默跳到最新一期（迁移 0082）。
	PendingPeriod string `json:"pending_period,omitempty"`
	// FailStreak 是连续失败次数（成功后清零）；用于指数退避（R19A-S1-06 ①）。
	FailStreak int `json:"fail_streak,omitempty"`
	// NextAttemptAt 是"最早何时可以再试"（退避窗口；NULL = 立即可试）。
	NextAttemptAt *time.Time `json:"next_attempt_at,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// MarshalJSON 脱敏序列化:hook_url 一律以 MaskedHookURL 输出。
//
// 这是**唯一**的对外形状(结构体字段本身必须保留明文供 PushWebhook/调度器
// 使用,所以不能在 DAO 里抹掉),放在这里保证任何将来的 JSON 出口也默认安全。
func (r ReportSubscription) MarshalJSON() ([]byte, error) {
	// 别名类型去掉方法集(否则递归调用本方法);字段 tag 保留。
	type plain ReportSubscription
	return json.Marshal(struct {
		plain
		HookURL string `json:"hook_url"`
	}{plain(r), MaskHookURL(r.HookURL)})
}

// MaskHookURL 把明文 hook_url 折成对外占位值(空值保持空,便于前端区分
// 「未配置」与「已配置但不回显明文」)。
func MaskHookURL(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	return MaskedHookURL
}

// reportSubscriptionColumns 是订阅行的列集（列表与单条共用，避免两份 SELECT 漂移）。
const reportSubscriptionColumns = `id, name, enabled, hook_url, last_run_at, last_error,
	pending_period, fail_streak, next_attempt_at, created_at, updated_at`

// scanReportSubscription 是订阅行的**唯一**扫描实现。
func scanReportSubscription(scan func(dest ...any) error) (ReportSubscription, error) {
	var r ReportSubscription
	var last, next sql.NullTime
	if err := scan(&r.ID, &r.Name, &r.Enabled, &r.HookURL, &last, &r.LastError,
		&r.PendingPeriod, &r.FailStreak, &next, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return ReportSubscription{}, err
	}
	if last.Valid {
		r.LastRunAt = &last.Time
	}
	if next.Valid {
		r.NextAttemptAt = &next.Time
	}
	return r, nil
}

// reportSubscriptionReader 是 GetReportSubscriptionOn 需要的读面（`*sql.DB` 与
// `*sql.Conn` 都满足）。
//
// 为什么必须是 **ctx** 形态、而且必须能落在 `*sql.Conn` 上：月报投递要在**认领连接**
// 上做"锁内新读"（见 internal/reports 的 DispatchAll，R20A-S-04）。换成 `*sql.DB`
// 就是"持着一条连接再向池里要第二条" —— 池上限可被配成 1（PICOAI_DB_MAX_OPEN_CONNS），
// 那时构成 hold-and-wait 且不可恢复（R14-K）。
type reportSubscriptionReader interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// GetReportSubscriptionOn 按 id 读一条订阅，在**调用方给定的读面**上执行。
//
// 存在性判定与 GetAppOn 同形：查不到 ⇒ `ErrNotFound`（调用方据此区分"这一轮没数据"
// 与"读失败"，后者才计失败）。传 `*sql.Conn` 时读到的就是该会话当前已提交的状态 ——
// 这正是"锁内新读"要的语义。
func GetReportSubscriptionOn(ctx context.Context, q reportSubscriptionReader, id int64) (ReportSubscription, error) {
	row := q.QueryRowContext(ctx, `SELECT `+reportSubscriptionColumns+`
		FROM report_subscriptions WHERE id = $1`, id)
	sub, err := scanReportSubscription(row.Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return ReportSubscription{}, ErrNotFound
	}
	return sub, err
}

// GetReportSubscription 按 id 读一条订阅（连接池版本；锁内新读请用 GetReportSubscriptionOn）。
func GetReportSubscription(db *sql.DB, id int64) (ReportSubscription, error) {
	return GetReportSubscriptionOn(context.Background(), db, id)
}

// ListReportSubscriptions 全量列表(按 id)。
func ListReportSubscriptions(db *sql.DB) ([]ReportSubscription, error) {
	rows, err := db.Query(`SELECT ` + reportSubscriptionColumns + ` FROM report_subscriptions ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReportSubscription{}
	for rows.Next() {
		r, serr := scanReportSubscription(rows.Scan)
		if serr != nil {
			return nil, serr
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// CreateReportSubscription 新建订阅。
func CreateReportSubscription(db *sql.DB, name, hookURL string, enabled bool) (int64, error) {
	e := 0
	if enabled {
		e = 1
	}
	return InsertID(db, `INSERT INTO report_subscriptions (name, enabled, hook_url) VALUES (?, ?, ?)`,
		name, e, hookURL)
}

// UpdateReportSubscription 更新订阅(name/enabled/hook_url)。
//
// hookURL 为空(或等于 MaskedHookURL)时保持现值——列表/编辑弹窗不再回显明文,
// 管理端「留空 = 不修改」;非空即视为新地址写入。两种情形都清空 last_error:
// 配置变过一次,旧失败原因就不再代表当前配置。
//
// R21C-03（审计 2026-09-26,P2）:**地址真的变了**时同时归零退避
// (`fail_streak` / `next_attempt_at`)。修前只清 `last_error`,于是
//
//   - 管理端看到「最近错误 = —、订阅启用」以为一切正常,而 `next_attempt_at`
//     还停在旧地址失败时算出的 24 小时窗口里 ⇒ 改好地址后最长要干等 24 小时
//     才有下一次投递(`reportRetryDelay(streak≥2) = 24h`),与 delivery_policy.go
//     承诺的「管理员修好 webhook 后最多等 1 小时就补投」相反(真 PG 探针实测:
//     修好后 1 分钟 due=false、5 小时 due=false);
//   - 连续失败次数是**旧地址**的观测史,新地址上它没有意义。
//
// 两个边界:
//   - **不**清 `pending_period`:欠投是"哪一期没投出去"的**事实**,与地址改没改
//     无关;清掉它就把跨月补投的游标抹掉了(R21C-01 的形态)。
//   - 「留空 = 不修改」不触发归零:地址没变就没有重置点,否则每次改个名字都会把
//     永久坏地址的退避重置回 1 小时,投递频率被管理端操作放大。
func UpdateReportSubscription(db *sql.DB, id int64, name, hookURL string, enabled bool) error {
	e := 0
	if enabled {
		e = 1
	}
	if hookURL == MaskedHookURL {
		hookURL = ""
	}
	// Postgres 的 SET 表达式全部读**旧行** ⇒ 表达式里的 hook_url 就是变更前的地址,
	// 可以直接拿它跟新地址比对(不需要先 SELECT 一次,也就没有读-改-写的竞态窗口)。
	res, err := db.Exec(`UPDATE report_subscriptions
		SET name = ?, enabled = ?,
		    hook_url = COALESCE(NULLIF(?, ''), hook_url),
		    last_error = '',
		    fail_streak = CASE WHEN ? <> '' AND hook_url IS DISTINCT FROM ? THEN 0 ELSE fail_streak END,
		    next_attempt_at = CASE WHEN ? <> '' AND hook_url IS DISTINCT FROM ? THEN NULL ELSE next_attempt_at END,
		    updated_at = now()
		WHERE id = ?`,
		name, e, hookURL, hookURL, hookURL, hookURL, hookURL, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteReportSubscription 删除订阅。
func DeleteReportSubscription(db *sql.DB, id int64) error {
	res, err := db.Exec(`DELETE FROM report_subscriptions WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// MarkReportRun 记录一次推送结果：**成功**才推进 `last_run_at` 并清空 last_error；
// **失败**只写 last_error（`last_run_at` 保持"上一次成功"的时刻）。
//
// R18C-03（审计 2026-09-25，P2）修正了旧实现：失败同样写 `last_run_at = now()`，
// 于是 `ShouldRunMonthly` 在本北京月内恒为 false ⇒ 月内零重试；而下一次真正运行在
// **下月**，那一轮生成的是"刚结束的那个月" ⇒ **失败的那一期永不投递**，与 webadmin
// 的两句承诺（"上月未推送则次月 1 日后自动补发"/"失败会在下月补跑时重试"）相反。
//
// 改后语义：
//   - `last_run_at` = **最近一次成功**投递的时刻（列表页"上次推送"列因此是真话）；
//   - 失败后该订阅在本北京月内**仍然待补跑**（`ShouldRunMonthly` 为 true），调度器
//     每小时那一轮会重新生成同一期（`GenerateMonthlyReport(now)` 取的仍是"上月"）
//     并重投，直到成功；
//   - 同月内成功一次即不再重复投递（`last_run_at` 落进本月 ⇒ ShouldRunMonthly false）。
//
// R19A-S1-06/S1-07（审计 2026-09-25，P2，**已闭合**）：上面那条"跨月丢期"的残留由
// 迁移 0082 的三列闭合 —— 投递路径改用 `MarkReportAttempt`（带期号 + 退避时刻）：
//   - 失败把 `pending_period` 钉在**最早未投递的那一期**（此后不覆盖），跨月仍投它；
//   - 失败累加 `fail_streak` 并写 `next_attempt_at`（指数退避，见 internal/reports），
//     永久坏的 webhook 不再每天被重试 24 次；
//   - 成功推进 `last_run_at`、清 `last_error`、**推进** pending 游标（R21C-01：
//     投出的正是游标那一期时，游标改为"下一期"或清空，见 `MarkReportDeliveredOn`）、
//     归零退避。
//
// 本函数保留为**不带期号**的兼容入口（既有调用点/测试），语义与修前逐字一致。
//
// 审计 2026-09-12 P1-4:errMsg 经 SanitizeReportError 去掉目标地址,
// 不再原样存 err.Error() 全文——net/http 的错误串会回显目标 URL
// (`Post "https://qyapi.weixin.qq.com/...?key=SECRET": dial tcp ...`),
// 而该字段会随列表响应下发,等于把刚脱敏的凭据又从错误列泄漏出去。
func MarkReportRun(db *sql.DB, id int64, ok bool, errMsg string) error {
	// period 传空：成功时按"清空 pending"处置（兼容入口无从知道期号），失败时不写
	// pending_period（只累加退避计数）—— 既有测试断言的 last_run_at / last_error
	// 语义逐字不变。
	return MarkReportAttempt(db, id, "", ok, errMsg, nil)
}

// MarkReportAttempt 记录一次投递**尝试**（迁移 0082；R19A-S1-06/S1-07，审计
// 2026-09-25，P2）。period 是本次尝试投递的期号（北京月 `YYYY-MM`，空 = 未知）。
//
// 成功：
//   - `last_run_at = now()`、`last_error = ”`、`fail_streak = 0`、`next_attempt_at = NULL`；
//   - `pending_period` 在"它正是这一期"时**清空**（兼容语义：本入口只知道"这一期投出去了"，
//     不知道后面还有没有欠投期 —— 带游标推进的成功落账请用 MarkReportDeliveredOn）。
//     period 为空（兼容入口）时同样清空。
//
// 失败：
//   - `last_error = SanitizeReportError(errMsg)`、`fail_streak = fail_streak + 1`、
//     `next_attempt_at = nextAttemptAt`（退避窗口，nil = 立即可再试）；
//   - `last_run_at` **不动**（R18C-03 的语义：它记的是最后一次**成功**）；
//   - `pending_period` **第一次失败时写入、之后不覆盖** ⇒ 跨月也一直补那一期。
func MarkReportAttempt(db *sql.DB, id int64, period string, ok bool, errMsg string, nextAttemptAt *time.Time) error {
	return MarkReportAttemptOn(context.Background(), db, id, period, ok, errMsg, nextAttemptAt)
}

// reportAttemptExecer 是 MarkReportAttemptOn 需要的执行面（*sql.DB 与 *sql.Conn 都满足）。
type reportAttemptExecer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// MarkReportAttemptOn 与 MarkReportAttempt 同语义，但在**调用方给定的执行体**上执行。
//
// 为什么需要它（R14-K hold-and-wait 守则）：投递路径必须"先取认领连接（PG advisory
// lock 是**会话级**锁，加解锁要在同一条连接上）、再落账" —— 若落账再回池里要第二条
// 连接，就构成 hold-and-wait（池上限 = 并发数时两边互等、池不可恢复）。因此调用方
// 已持有连接时，必须在同一条连接上把记账做完。
func MarkReportAttemptOn(ctx context.Context, ex reportAttemptExecer, id int64, period string, ok bool, errMsg string, nextAttemptAt *time.Time) error {
	if ex == nil {
		return nil
	}
	if ok {
		// nextPending 传空 = 兼容语义（投出这一期就不再欠投）。
		return MarkReportDeliveredOn(ctx, ex, id, period, "")
	}
	var next any
	if nextAttemptAt != nil {
		next = nextAttemptAt.UTC()
	}
	_, err := ex.ExecContext(ctx, `UPDATE report_subscriptions
		SET last_error = ?, fail_streak = fail_streak + 1, next_attempt_at = ?,
		    pending_period = CASE WHEN pending_period = '' THEN ? ELSE pending_period END,
		    updated_at = now()
		WHERE id = ?`, SanitizeReportError(errMsg), next, period, id)
	return err
}

// MarkReportDeliveredOn 记录一次**成功**投递，并把"最早未投递期号"从 period
// 推进到 nextPending（空 = 这一期之后不再欠投）—— R21C-01（审计 2026-09-26，**P1**）。
//
// 为什么成功落账要区分"清空"与"推进"（缺陷形态）：`pending_period` 此前是**单槽**
// 且"投出即清空 + `last_run_at = now()`"。webhook 连续失败跨过 N 个月界时，被挡住的
// 中间各期既不进列也不留痕；补投成功那一次把 `last_run_at` 推到**当月**，于是
// `ShouldRunMonthly` 在本月为 false ⇒ 中间各期**永久不投**且无恢复路径
// （真 PG 端到端实测：delivered=[2026-06 2026-10]、never=[2026-07/08/09]）。
//
// 修后：`pending_period` 是**游标**（"最早未投递的那一期"），投出 P 之后由调用方
// 决定它变成什么（`nextPending`）—— P 之后还有已到期的期号就推进到 P+1，
// 投到"当前应投期"才清空。每个 tick 补一期、按序补齐，不跳期也不重投。
//
// 为什么"下一期是什么"由调用方算：月期号的词汇表（`CurrentPeriod`）属于
// internal/reports（delivery_policy.go 的注释写明它是唯一实现），serverstore 只存
// 字符串、不做月期间算术 —— 否则同一口径会有第二份实现。
func MarkReportDeliveredOn(ctx context.Context, ex reportAttemptExecer, id int64, period, nextPending string) error {
	if ex == nil {
		return nil
	}
	_, err := ex.ExecContext(ctx, `UPDATE report_subscriptions
		SET last_run_at = now(), last_error = '', fail_streak = 0, next_attempt_at = NULL,
		    pending_period = CASE WHEN ? = '' OR pending_period = ? THEN ? ELSE pending_period END,
		    updated_at = now()
		WHERE id = ?`, period, period, nextPending, id)
	return err
}

// SanitizeReportError 把 webhook 推送错误串折成**不含目标地址**的文本。
//
// 只对"带 URL 的错误"动手:net/http / net/url 的错误串会把目标 URL(webhook
// 地址自带 `key=…`)原样回显,而这份文本会写进 last_error 并随订阅列表响应
// 下发 —— 那是绕过 hook_url 脱敏的读回信道,必须去掉。不含 `://` 的短消息
// (如 `webhook 502`)本身没有敏感信息,原样保留,以维持既有的可观测性与
// 既有测试契约。
func SanitizeReportError(errMsg string) string {
	msg := strings.TrimSpace(errMsg)
	if !strings.Contains(msg, "://") {
		if len(msg) > 200 { // 防御:超长错误串不撑爆列
			return msg[:200]
		}
		return msg
	}
	switch {
	case strings.Contains(msg, "hook_url 不合法"):
		return "目标地址被拒(内网/回环/无法解析)"
	case strings.Contains(msg, "webhook status"):
		return "webhook 返回非 2xx"
	case strings.Contains(msg, "no such host"):
		return "目标主机无法解析"
	case strings.Contains(msg, "connection refused"):
		return "目标拒绝连接"
	case strings.Contains(msg, "context deadline exceeded"), strings.Contains(msg, "timeout"):
		return "推送超时"
	case strings.Contains(msg, "tls"), strings.Contains(msg, "certificate"):
		return "TLS 握手失败"
	case strings.Contains(msg, "first path segment in URL cannot contain colon"),
		strings.Contains(msg, "invalid URL"),
		strings.Contains(msg, "missing protocol scheme"):
		return "目标地址格式无法解析"
	default:
		return "推送失败"
	}
}
