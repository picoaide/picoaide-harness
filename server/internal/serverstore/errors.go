package serverstore

import "errors"

var (
	// ErrIdentityConflict 表示该用户名已绑定到**另一个 IdP 主体**(审计
	// 2026-09-13 P2-9):属于身份冲突,调用方应拒绝登录(401),不得静默复用该行。
	ErrIdentityConflict = errors.New("username is bound to another identity provider subject")
	ErrNotFound         = errors.New("not found")
	ErrDuplicate        = errors.New("duplicate")
	// ErrConflict is returned when a resource name collides across the
	// marketplace skills and the shared-skill store (决策 2026-08-25:
	// 市场与组织合并为「市场」后，同名技能跨源互斥，上传/上架/approve 阻断)。
	ErrConflict = errors.New("conflict")
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
	// ErrUnsupportedFilter is returned when an aggregate filter cannot be
	// honoured by the data source it would have to read(审计 2026-09-12
	// FIX-11:usage_daily 日账没有 kind 列,窗口跨保留边界时无法按
	// chat|embedding|search 过滤)。**必须显式失败**而不是退化成不过滤 ——
	// 后者会让统计徽标给出偏大的数字,与明细表口径不一致(静默错数)。
	ErrUnsupportedFilter = errors.New("unsupported filter")
	// ErrMFAAlreadyEnabled 表示目标用户**已开启** MFA,而调用方试图登记一份
	// 新的 TOTP 配置(审计 2026-09-25 R15C-02,P1):第二因子只能由
	// disableMyMFA(主密码 + 当前动态码双验)先移除,再重新登记 —— 不允许任何
	// 路径用更弱的凭据把它**替换**掉。见 SetUserMFA 的写入侧守卫。
	ErrMFAAlreadyEnabled = errors.New("mfa already enabled")
)

// ErrDepartmentInUse guards department deletion when members, children or
// grant references still exist.
var ErrDepartmentInUse = errors.New("department in use")
