package serverstore

import "errors"

var (
	ErrNotFound  = errors.New("not found")
	ErrDuplicate = errors.New("duplicate")
	// ErrConflict is returned when a resource name collides across the
	// marketplace skills and the shared-skill store (决策 2026-08-25:
	// 市场与组织合并为「市场」后，同名技能跨源互斥，上传/上架/approve 阻断)。
	ErrConflict = errors.New("conflict")
	// ErrTooManyPending is returned when an author is already at the
	// per-author pending submission cap (agent presets).
	ErrTooManyPending = errors.New("too many pending submissions")
	// ErrValidation is returned when a grant subject or resource name is
	// malformed (empty, path-ish, control chars).
	ErrValidation = errors.New("invalid value")
	// ErrLastAdmin is returned when a delete would leave zero admin accounts
	// (rolls back; see DeleteUser).
	ErrLastAdmin = errors.New("cannot delete the last admin")
	// ErrInsufficientBalance is returned when settling a usage cost would push
	// an activated account's balance below zero(审计 2026-09-12 P0-C:并发
	// 消费透支)。调用方必须回滚**整个事务**(usage 行与扣款同事务),不得
	// 静默跳过 —— 与「未开通账户」的"不扣不记"语义严格区分。
	ErrInsufficientBalance = errors.New("insufficient balance")
)

// ErrDepartmentInUse guards department deletion when members, children or
// grant references still exist.
var ErrDepartmentInUse = errors.New("department in use")
