package serverstore

import (
	"database/sql"
	"encoding/json"
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
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
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

// ListReportSubscriptions 全量列表(按 id)。
func ListReportSubscriptions(db *sql.DB) ([]ReportSubscription, error) {
	rows, err := db.Query(`SELECT id, name, enabled, hook_url, last_run_at, last_error, created_at, updated_at
		FROM report_subscriptions ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReportSubscription{}
	for rows.Next() {
		var r ReportSubscription
		var last sql.NullTime
		if err := rows.Scan(&r.ID, &r.Name, &r.Enabled, &r.HookURL, &last, &r.LastError, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		if last.Valid {
			r.LastRunAt = &last.Time
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
func UpdateReportSubscription(db *sql.DB, id int64, name, hookURL string, enabled bool) error {
	e := 0
	if enabled {
		e = 1
	}
	if hookURL == MaskedHookURL {
		hookURL = ""
	}
	res, err := db.Exec(`UPDATE report_subscriptions
		SET name = ?, enabled = ?, hook_url = COALESCE(NULLIF(?, ''), hook_url), last_error = '', updated_at = now()
		WHERE id = ?`,
		name, e, hookURL, id)
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

// MarkReportRun 记录一次推送结果(成功=last_run_at + 清空 last_error)。
// P2-4:失败同样写 last_run_at——ShouldRunMonthly 只看 last_run_at 的月份,
// 失败只写 last_error 会让调度器每小时重算整月报表并重发(设计语义:
// 同一月份只跑一次,失败下月再试,见 reports.ShouldRunMonthly 注释)。
//
// 审计 2026-09-12 P1-4:errMsg 经 SanitizeReportError 去掉目标地址,
// 不再原样存 err.Error() 全文——net/http 的错误串会回显目标 URL
// (`Post "https://qyapi.weixin.qq.com/...?key=SECRET": dial tcp ...`),
// 而该字段会随列表响应下发,等于把刚脱敏的凭据又从错误列泄漏出去。
func MarkReportRun(db *sql.DB, id int64, ok bool, errMsg string) error {
	if ok {
		_, err := db.Exec(`UPDATE report_subscriptions SET last_run_at = now(), last_error = '', updated_at = now() WHERE id = ?`, id)
		return err
	}
	_, err := db.Exec(`UPDATE report_subscriptions SET last_run_at = now(), last_error = ?, updated_at = now() WHERE id = ?`,
		SanitizeReportError(errMsg), id)
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
