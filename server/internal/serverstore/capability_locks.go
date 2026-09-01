package serverstore

import (
	"database/sql"
	"errors"
	"strings"
	"time"
)

// CapabilityLock 是一条「仅管理员可发布」的锁定记录(迁移 0050)。
//
// 决策 2026-09-01 D4:管理员把某个技能/智能体标记为锁定后,员工发布该名字
// 一律被明确拒绝并回显 Reason。锁定与授权(可见性)、上下架、质量标记正交,
// 且允许对尚不存在的名字预先锁定(占名),防止员工抢占官方命名。
type CapabilityLock struct {
	Kind      string
	Name      string
	Reason    string
	LockedBy  string
	CreatedAt time.Time
}

// CapabilityKindSkill/Agent 是 capability_locks.kind 的合法取值。
const (
	CapabilityKindSkill = "skill"
	CapabilityKindAgent = "agent"
)

// ValidCapabilityKind reports whether kind is a supported lock target.
func ValidCapabilityKind(kind string) bool {
	return kind == CapabilityKindSkill || kind == CapabilityKindAgent
}

// LockCapability marks one capability name as admin-only publishable
// (idempotent upsert: 重复锁定只更新理由与操作人)。
func LockCapability(db *sql.DB, kind, name, reason, by string) error {
	if !ValidCapabilityKind(kind) {
		return errors.New("invalid capability kind")
	}
	_, err := db.Exec(`INSERT INTO capability_locks (kind, name, reason, locked_by)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(kind, name) DO UPDATE SET reason = excluded.reason, locked_by = excluded.locked_by`,
		kind, strings.TrimSpace(name), strings.TrimSpace(reason), by)
	return err
}

// UnlockCapability removes a lock; ErrNotFound when the name was not locked.
func UnlockCapability(db *sql.DB, kind, name string) error {
	res, err := db.Exec(`DELETE FROM capability_locks WHERE kind = ? AND name = ?`, kind, name)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// GetCapabilityLock returns the lock for one name, or ErrNotFound.
func GetCapabilityLock(db *sql.DB, kind, name string) (*CapabilityLock, error) {
	var l CapabilityLock
	var created any
	err := db.QueryRow(`SELECT kind, name, reason, locked_by, created_at FROM capability_locks
		WHERE kind = ? AND name = ?`, kind, name).Scan(&l.Kind, &l.Name, &l.Reason, &l.LockedBy, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	l.CreatedAt = parseSQLTime(created)
	return &l, nil
}

// ListCapabilityLocks returns every lock (admin view), name-ordered.
func ListCapabilityLocks(db *sql.DB) ([]CapabilityLock, error) {
	rows, err := db.Query(`SELECT kind, name, reason, locked_by, created_at FROM capability_locks ORDER BY kind, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CapabilityLock{}
	for rows.Next() {
		var l CapabilityLock
		var created any
		if err := rows.Scan(&l.Kind, &l.Name, &l.Reason, &l.LockedBy, &created); err != nil {
			return nil, err
		}
		l.CreatedAt = parseSQLTime(created)
		out = append(out, l)
	}
	return out, rows.Err()
}
