package session

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// 本包的语义化错误。上层据此决定 HTTP 语义，绝不把内部错误原文透给浏览器。
var (
	// ErrSessionNotFound 表示 Cookie 无对应会话，或会话已过期/已吊销。
	ErrSessionNotFound = errors.New("session: 会话不存在或已失效")
	// ErrUserNotFound 表示认证通过但 users 表里没有这个账号（外部身份未建号）。
	ErrUserNotFound = errors.New("session: 账号不存在")
	// ErrUserDisabled 表示账号已禁用（status != 1）。
	ErrUserDisabled = errors.New("session: 账号已禁用")
	// ErrAuditorBlocked 表示审计账号不能登录应用平台（与客户端面同一判据：
	// serverauth/handler.go 的 `user.Role == RoleAuditor` 硬拦，审计员只可经
	// webadmin 只读工作台，不能持有员工面的任何凭证）。
	ErrAuditorBlocked = errors.New("session: 审计账号不可登录")
	// ErrAuthUnavailable 表示 Options.Auth 未注入（装配遗漏）。
	ErrAuthUnavailable = errors.New("session: 认证未配置")
)

// lastSeenRefresh 是 last_seen_at 的刷新节流窗口：主站交互/换票时最多每分钟写一次，
// 避免"一次页面导航 = 一次写"。这是内部节流参数（不是平台容量旋钮）。
const lastSeenRefresh = time.Minute

// hashSecret 返回 Cookie 明文的 SHA-256(hex)。
//
// 与 api_tokens.token_hash（serverstore.TokenHash）和 admin_sessions.secret_hash
// （serverauth.sessionSecretHash）完全同口径：库里只有哈希，读到库的人拿不到可用会话。
// 复用 serverstore.TokenHash 而不是自己再写一份。
func hashSecret(raw string) string { return serverstore.TokenHash(raw) }

// randomToken 返回 n 字节 crypto/rand 的 hex 表示（32 字节 ⇒ 64 字符）。
func randomToken(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// newSecret 是一次性凭据的唯一生成入口（员工会话 Cookie / 应用会话 Cookie / 换票 code）。
func newSecret() (string, error) { return randomToken(tokenBytes) }

// loginUser 是登录/会话解析需要的 users 行最小投影。
type loginUser struct {
	ID          int64
	Username    string
	DisplayName string
	Role        string
	Status      int
}

// loadLoginUser 解析登录身份：userIDHint > 0 时按 id 取，否则按用户名（大小写不敏感）。
//
// 为什么允许按用户名兜底：Options.Auth 注入的 serverauth.AuthenticatePassword 返回
// UserInfo（用户名/来源/组），**不含本地行 id**；本模块不重复实现 serverauth 的
// "认证 + 外部身份建号"链路，因此 userID 可由 main.go 直接给出（它若要建号，
// 就传建号后的 id），或留 0 由这里按用户名解析。
func (m *Manager) loadLoginUser(ctx context.Context, username string, userIDHint int64) (*loginUser, error) {
	if m.opt.DB == nil {
		return nil, errors.New("session: DB 未注入")
	}
	u := &loginUser{}
	var err error
	if userIDHint > 0 {
		err = m.opt.DB.QueryRowContext(ctx,
			`SELECT id, username, COALESCE(display_name, ''), role, status FROM users WHERE id = ?`,
			userIDHint).Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.Status)
	} else {
		err = m.opt.DB.QueryRowContext(ctx,
			`SELECT id, username, COALESCE(display_name, ''), role, status FROM users WHERE lower(username) = lower(?) ORDER BY id LIMIT 1`,
			username).Scan(&u.ID, &u.Username, &u.DisplayName, &u.Role, &u.Status)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUserNotFound
	}
	if err != nil {
		return nil, err
	}
	return u, nil
}

// checkUsable 判定账号是否可以持有员工面会话。
//
// 两条与客户端面完全一致的判据（不得分叉，否则同一账号在两个入口得到相反结论）：
//   - status != 1 ⇒ 禁用；
//   - role == auditor ⇒ 拒绝（审计员只可进 webadmin 只读工作台）。
func (u *loginUser) checkUsable() error {
	if u.Status != 1 {
		return ErrUserDisabled
	}
	if u.Role == serverstore.RoleAuditor {
		return ErrAuditorBlocked
	}
	return nil
}

// sweepExpiredEmployeeSessions 在登录时清理已过期与早已吊销的会话行。
//
// 与 serverauth.CreateAdminSession 的"登录时顺带扫表"同形：让表规模随活跃会话数
// 而非历史登录数增长。**只删过期/已吊销行**，绝不动活跃行。
func (m *Manager) sweepExpiredEmployeeSessions(ctx context.Context, now time.Time) {
	if m.opt.DB == nil {
		return
	}
	if _, err := m.opt.DB.ExecContext(ctx,
		`DELETE FROM employee_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
		now, now.Add(-limitsEmployeeSweepGrace)); err != nil {
		logError("pico-wasm-session: sweep employee sessions: %v", err)
	}
}

// limitsEmployeeSweepGrace 是"已吊销会话"在表里多留一会儿的宽限期（便于运维排查
// 刚发生的登出）；过期会话立即清。
const limitsEmployeeSweepGrace = 24 * time.Hour

// insertEmployeeSession 落一行员工会话并返回其 id。
func (m *Manager) insertEmployeeSession(ctx context.Context, userID int64, raw, userAgent, ip string, now, expires time.Time) (int64, error) {
	return serverstore.InsertID(m.opt.DB, `INSERT INTO employee_sessions
		(user_id, token_hash, created_at, expires_at, last_seen_at, user_agent, ip)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		userID, hashSecret(raw), now, expires, now, userAgent, ip)
}

// lookupEmployeeSession 按 Cookie 明文解析员工会话（不存在/过期/已吊销 ⇒ ErrSessionNotFound）。
//
// 三把闸都要过：token_hash 命中、revoked_at IS NULL、expires_at > now。
// 另外账号本身也要可用（禁用/审计员 ⇒ 会话立即失效，不必等管理端逐个删会话）。
func (m *Manager) lookupEmployeeSession(ctx context.Context, raw string, now time.Time) (*Employee, error) {
	if m.opt.DB == nil || raw == "" {
		return nil, ErrSessionNotFound
	}
	emp := &Employee{}
	var role string
	var status int
	err := m.opt.DB.QueryRowContext(ctx, `SELECT e.id, e.user_id, u.username,
			COALESCE(u.display_name, ''), u.role, u.status, e.expires_at,
			COALESCE((SELECT g.name FROM user_groups ug JOIN groups g ON g.id = ug.group_id
				WHERE ug.user_id = u.id ORDER BY g.name LIMIT 1), '')
		FROM employee_sessions e
		JOIN users u ON u.id = e.user_id
		WHERE e.token_hash = ? AND e.revoked_at IS NULL AND e.expires_at > ?`,
		hashSecret(raw), now).
		Scan(&emp.SessionID, &emp.ID, &emp.Username, &emp.DisplayName, &role, &status, &emp.ExpiresAt, &emp.Dept)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrSessionNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := (&loginUser{Role: role, Status: status}).checkUsable(); err != nil {
		return nil, ErrSessionNotFound
	}
	return emp, nil
}

// touchEmployeeSession 节流刷新 last_seen_at（最多每分钟一次）。
//
// 只在**主站交互**（CurrentEmployee）与换票时调用：应用子域的每次请求都写库会把
// 应用热路径变成写放大（§4.6 每应用并发恒为 1，请求路径应当只读）。
func (m *Manager) touchEmployeeSession(ctx context.Context, id int64, now time.Time) {
	if m.opt.DB == nil || id <= 0 {
		return
	}
	if _, err := m.opt.DB.ExecContext(ctx,
		`UPDATE employee_sessions SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?`,
		now, id, now.Add(-lastSeenRefresh)); err != nil {
		logError("pico-wasm-session: touch employee session: %v", err)
	}
}

// revokeEmployeeSession 吊销一个员工会话，并**在 SQL 层**级联失效其名下全部应用子域会话
// （§10.4 第 46 项：员工登出后旧应用令牌立即失效）。
//
// 两条路径都做，互为兜底：
//  1. 显式 `DELETE ... WHERE employee_session_id = ? RETURNING id`：即使 FK 级联
//     被误删（例如有人重建表时漏了 ON DELETE CASCADE），登出依然整批失效；
//  2. 表上的 FK ON DELETE CASCADE 覆盖"直接删 employee_sessions 行"的场景。
//
// 返回被吊销的应用会话 key 列表（= app_sessions.id 的十进制串，与 SessionKey 同值），
// 供 main.go 通知 aichat 丢掉内存里的在手令牌。
func (m *Manager) revokeEmployeeSession(ctx context.Context, id int64, now time.Time) ([]string, error) {
	if m.opt.DB == nil {
		return nil, errors.New("session: DB 未注入")
	}
	if _, err := m.opt.DB.ExecContext(ctx,
		`UPDATE employee_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`, now, id); err != nil {
		return nil, err
	}
	rows, err := m.opt.DB.QueryContext(ctx,
		`DELETE FROM app_sessions WHERE employee_session_id = ? RETURNING id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var keys []string
	for rows.Next() {
		var sid int64
		if err := rows.Scan(&sid); err != nil {
			return keys, err
		}
		keys = append(keys, appSessionKey(sid))
	}
	return keys, rows.Err()
}

// insertAppSession 落一行应用子域会话。
//
// **原子性要求**：换票在"签发（≤60 s 窗口）"与"兑换"之间，员工可能已经登出/
// 被禁用。这里把"员工会话仍有效"塞进 INSERT 的 WHERE EXISTS，一条语句完成
// 判定 + 写入：并发下的登出与兑换不会各自看到中间态（§10.4 第 46 项的窄窗口）。
// rowsAffected == 0 ⇒ 员工会话已失效，兑换失败。
func (m *Manager) insertAppSession(ctx context.Context, employeeSessionID, userID int64, appID, raw string, now, expires time.Time) error {
	if m.opt.DB == nil {
		return errors.New("session: DB 未注入")
	}
	res, err := m.opt.DB.ExecContext(ctx, `INSERT INTO app_sessions
		(employee_session_id, user_id, app_id, token_hash, created_at, expires_at)
		SELECT ?, ?, ?, ?, ?, ?
		WHERE EXISTS (SELECT 1 FROM employee_sessions
			WHERE id = ? AND revoked_at IS NULL AND expires_at > ?)`,
		employeeSessionID, userID, appID, hashSecret(raw), now, expires, employeeSessionID, now)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrSessionNotFound
	}
	return nil
}

// appIdentity 是应用子域一次请求解析出的完整身份。
type appIdentity struct {
	SessionID   int64
	UserID      int64
	Username    string
	DisplayName string
	Dept        string
	// IsPublisher 是"当前使用者是否为本应用发布者"（abi.User.IsPublisher / R27）。
	// ⚠️ 使用平面里它**不携带任何特权**（§4.7 第四轮定案：应用内所有人一律普通用户），
	// 只用于作者自检与"无权限页显示本人账号"（§15.1 第 10 条）。
	IsPublisher bool
	ExpiresAt   time.Time
}

// resolveAppSession 按应用子域 Cookie 明文 + 当前子域 appID 解析身份。
//
// 三层校验一次完成（§10.4 第 40/42/43 项）：
//  1. `s.app_id = ?`：**跨应用兑换/串用一律查不到** —— 令牌绑 (user, app)，
//     另一个子域拿同一个 Cookie 值也解析不出身份；
//  2. `e.revoked_at IS NULL AND e.expires_at > now`：员工登出 ⇒ 该应用会话立即失效
//     （不依赖级联删除是否执行成功，纵深）；
//  3. INNER JOIN employee_sessions：employee_session_id 为空的行直接查不到（fail-closed）。
func (m *Manager) resolveAppSession(ctx context.Context, raw, appID string, now time.Time) (*appIdentity, error) {
	if m.opt.DB == nil || raw == "" || appID == "" {
		return nil, ErrSessionNotFound
	}
	id := &appIdentity{}
	var owner string
	var status int
	var role string
	err := m.opt.DB.QueryRowContext(ctx, `SELECT s.id, s.user_id, u.username,
			COALESCE(u.display_name, ''), u.role, u.status, s.expires_at, COALESCE(a.owner, ''),
			COALESCE((SELECT g.name FROM user_groups ug JOIN groups g ON g.id = ug.group_id
				WHERE ug.user_id = u.id ORDER BY g.name LIMIT 1), '')
		FROM app_sessions s
		JOIN employee_sessions e ON e.id = s.employee_session_id
		JOIN users u ON u.id = s.user_id
		LEFT JOIN apps a ON a.kind = ? AND a.app_id = s.app_id
		WHERE s.token_hash = ? AND s.app_id = ? AND s.expires_at > ?
			AND e.revoked_at IS NULL AND e.expires_at > ?`,
		serverstore.AppKindWasmApp, hashSecret(raw), appID, now, now).
		Scan(&id.SessionID, &id.UserID, &id.Username, &id.DisplayName, &role, &status,
			&id.ExpiresAt, &owner, &id.Dept)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrSessionNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := (&loginUser{Role: role, Status: status}).checkUsable(); err != nil {
		return nil, ErrSessionNotFound
	}
	id.IsPublisher = owner != "" && owner == id.Username
	return id, nil
}

// appExists 判定换票目标应用是否存在（§4.7 第 3 条）。
//
// 直接用 serverstore.GetWasmAppByHost —— 它就是 §4.8「主机名反查」的那一个函数
// （kind=wasm_app + deleted_at IS NULL + 主机标签规范化），因此换票端点与
// 应用子域路由**同口径**：能换到票的应用，一定是 Host 反查能命中的那个；
// 反过来说，"子域 404 但换票成功"这种状态在结构上不可能出现。
//
// 显式不判 enabled：下架（apps.enabled=0）不是"不存在"，换票这一层不拦它 ——
// 拦它的是**路由**（appserver 对 enabled=false 返回 410 Gone + "数据仍保留"），
// 两处口径不重复。⚠️ 勘误（2026-09-18 独立审计）：这里只说明"为什么换票不看
// enabled"，**不**意味着下架应用还能打开（此前别处的措辞把人误导成后者）。
func (m *Manager) appExists(ctx context.Context, appID string) bool {
	if m.opt.DB == nil || appID == "" {
		return false
	}
	_, err := serverstore.GetWasmAppByHost(ctx, m.opt.DB, appID)
	return err == nil
}
