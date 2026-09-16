package serverstore

import (
	"database/sql"
	"fmt"
	"time"
)

// ---------------------------------------------------------------------------
// 客户端错误上报状态(迁移 0068)。
//
// 客户端(enterprise error-reporting 插件)在会话建立后计算一份上报状态并
// POST /api/client/v2/telemetry/error-reporting;本处按用户 upsert **一行**
// (user_id 主键),语义是"该员工最新一次上报的状态",不做历史留存 ——
// 管理端上报状态页据此聚合,用于发现"后台配了 DSN 但客户端从没报上来"。
//
// 字段边界与遥测语义:客户端输入不可信,超长一律**截断**而不是报错(这是
// 诊断数据,不能因为一个超长 reason 就丢掉整条状态)。白名单(哪些 state/
// level 允许落库)由 telemetry handler 判定,DAO 只负责长度防御。
// ---------------------------------------------------------------------------

// 状态取值(与客户端 packages/host/enterprise/src/error-reporting.ts 同一套;
// telemetry handler 按此白名单过滤,管理端按这五个键渲染计数)。
const (
	ErrorReportingStateIdle              = "idle"
	ErrorReportingStateDisabled          = "disabled"
	ErrorReportingStateReady             = "ready"
	ErrorReportingStateFailed            = "failed"
	ErrorReportingStateConfigUnavailable = "config_unavailable"
)

// 字段上限(防御性截断)。reason 按 rune 计(中文原因是常态,按字节截会切出
// 半个字);dsn_host 是 ASCII 主机名,253 = RFC 1035 主机名总长上限。
const (
	ErrorReportingMaxReasonRunes = 200
	ErrorReportingMaxDSNHostLen  = 253
	ErrorReportingMaxReleaseLen  = 64
	ErrorReportingMaxStateLen    = 32
	ErrorReportingMaxLevelLen    = 16
)

// 列表上限(管理端聚合页):与 telemetry 上报、admin 聚合接口同一口径。
const (
	ErrorReportingListDefaultLimit = 100
	ErrorReportingListMaxLimit     = 100
)

// ClientErrorReportingStatus 是一个用户的最新错误上报状态(JOIN users 带用户名)。
type ClientErrorReportingStatus struct {
	UserID    int64
	Username  string
	State     string
	Reason    string
	DSNHost   string
	Level     string
	Release   string
	UpdatedAt time.Time
}

// TruncateRunes 按 rune(而非字节)截断字符串:多字节字符(中文原因常见)
// 不会被切成半个字,也不会产生非法 UTF-8(PG 会直接拒绝非法 UTF-8 参数)。
func TruncateRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	if len(s) <= max { // 字节数不超过上限 ⇒ rune 数必然不超,免去逐字符扫描
		return s
	}
	n := 0
	for i := range s {
		if n == max {
			return s[:i]
		}
		n++
	}
	return s
}

// UpsertErrorReportingStatus 写入/覆盖某用户的最新上报状态(按 user_id 幂等,
// updated_at 取数据库 now())。字段一律防御性截断 —— 客户端输入不可信,且
// 这是遥测数据:长度问题不得让整条上报失败。
func UpsertErrorReportingStatus(db *sql.DB, userID int64, state, reason, dsnHost, level, release string) error {
	if userID <= 0 {
		return fmt.Errorf("upsert error reporting status: invalid user id %d", userID)
	}
	_, err := db.Exec(`
INSERT INTO client_error_reporting_status (user_id, state, reason, dsn_host, level, release, updated_at)
VALUES (?, ?, ?, ?, ?, ?, now())
ON CONFLICT (user_id) DO UPDATE SET
  state      = excluded.state,
  reason     = excluded.reason,
  dsn_host   = excluded.dsn_host,
  level      = excluded.level,
  release    = excluded.release,
  updated_at = now()`,
		userID,
		TruncateRunes(state, ErrorReportingMaxStateLen),
		TruncateRunes(reason, ErrorReportingMaxReasonRunes),
		TruncateRunes(dsnHost, ErrorReportingMaxDSNHostLen),
		TruncateRunes(level, ErrorReportingMaxLevelLen),
		TruncateRunes(release, ErrorReportingMaxReleaseLen),
	)
	if err != nil {
		return fmt.Errorf("upsert error reporting status: %w", err)
	}
	return nil
}

// ListErrorReportingStatuses 返回最近上报的用户状态(updated_at 倒序;同刻按
// user_id 倒序兜底,保证顺序确定)。limit 收敛到 1..100,<=0 视为缺省 100。
//
// JOIN users 取用户名:后台排障必须先看到"是谁的客户端在报什么"。用 LEFT
// JOIN 而非 INNER JOIN —— 诊断视图宁可显示一个空用户名,也不能因为用户行
// 缺失(未来若改为软删除)而整行消失,让"有客户端上报过"这个事实看不见。
func ListErrorReportingStatuses(db *sql.DB, limit int) ([]ClientErrorReportingStatus, error) {
	if limit <= 0 {
		limit = ErrorReportingListDefaultLimit
	}
	if limit > ErrorReportingListMaxLimit {
		limit = ErrorReportingListMaxLimit
	}
	rows, err := db.Query(`
SELECT s.user_id, COALESCE(u.username, ''), s.state, s.reason, s.dsn_host, s.level, s.release, s.updated_at
FROM client_error_reporting_status s
LEFT JOIN users u ON u.id = s.user_id
ORDER BY s.updated_at DESC, s.user_id DESC
LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("list error reporting statuses: %w", err)
	}
	defer rows.Close()
	out := []ClientErrorReportingStatus{}
	for rows.Next() {
		var r ClientErrorReportingStatus
		if err := rows.Scan(&r.UserID, &r.Username, &r.State, &r.Reason, &r.DSNHost, &r.Level, &r.Release, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// CountErrorReportingStatuses 按 state 汇总(管理端聚合页的五个状态计数)。
// 只返回表里实际出现的 state;调用方负责补齐缺省 0(白名单外的历史脏值也
// 会被如实计入,便于发现异常写入)。
func CountErrorReportingStatuses(db *sql.DB) (map[string]int, error) {
	rows, err := db.Query(`SELECT state, COUNT(*) FROM client_error_reporting_status GROUP BY state`)
	if err != nil {
		return nil, fmt.Errorf("count error reporting statuses: %w", err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var state string
		var n int
		if err := rows.Scan(&state, &n); err != nil {
			return nil, err
		}
		out[state] = n
	}
	return out, rows.Err()
}
