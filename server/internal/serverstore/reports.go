package serverstore

import (
	"database/sql"
	"time"
)

// ---------------------------------------------------------------------------
// 报表订阅(2026-09 P1):每月生成上月用量汇总推送 webhook 的订阅配置。
// ---------------------------------------------------------------------------

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
func UpdateReportSubscription(db *sql.DB, id int64, name, hookURL string, enabled bool) error {
	e := 0
	if enabled {
		e = 1
	}
	res, err := db.Exec(`UPDATE report_subscriptions SET name = ?, enabled = ?, hook_url = ?, updated_at = now() WHERE id = ?`,
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

// MarkReportRun 记录一次推送结果(成功=last_run_at;失败=last_error)。
func MarkReportRun(db *sql.DB, id int64, ok bool, errMsg string) error {
	if ok {
		_, err := db.Exec(`UPDATE report_subscriptions SET last_run_at = now(), last_error = '', updated_at = now() WHERE id = ?`, id)
		return err
	}
	_, err := db.Exec(`UPDATE report_subscriptions SET last_error = ?, updated_at = now() WHERE id = ?`, errMsg, id)
	return err
}
