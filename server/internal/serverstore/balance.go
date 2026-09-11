package serverstore

import (
	"database/sql"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// 员工余额(0061)。
//
// 语义:
//   - users.balance_money 是**存量余额**(元)。管理员可手动调整;
//     月度定时任务按配置对所有普通员工发放(add 累加 / cover 重置)。
//   - 余额始终随消费扣减(usage.cost 落账的同时原子扣减,同事务);
//     balance.enabled=1 时余额 <= 0 会在网关被 429 硬拦截。
//   - balance_grants.month(北京月 YYYYMM)是发放幂等锚:跨实例/重启/重入
//     都只发放一次;管理员手动发放同样占用当月锚点。
// ---------------------------------------------------------------------------

// 设置键(settings kv)。默认:闸门关闭、月度额度 0、累加模式。
const (
	BalanceEnabledSetting = "balance.enabled"
	BalanceMonthlyAmount  = "balance.monthly_amount"
	BalanceMonthlyMode    = "balance.monthly_mode"
)

// 发放模式。
const (
	BalanceModeAdd   = "add"   // 当前余额 + 月度额度
	BalanceModeCover = "cover" // 余额重置为月度额度
)

// moneyEpsilonBalance 金额比较容差(浮点累加/分位处理)。
const moneyEpsilonBalance = 0.0001

// BalanceSettings 月度余额发放配置。
type BalanceSettings struct {
	// Enabled: 余额是否为网关硬闸门(余额 <= 0 → 429)。默认 false,
	// 避免存量部署升级后(余额全为 0)全员被立刻拦截。
	Enabled bool `json:"enabled"`
	// MonthlyAmount: 每人每月发放额度(元)。<= 0 = 不自动发放。
	MonthlyAmount float64 `json:"monthly_amount"`
	// MonthlyMode: add(累加) | cover(覆盖为固定额度)。
	MonthlyMode string `json:"monthly_mode"`
}

// GetBalanceSettings 读取配置;缺省/非法值回落安全默认。
func GetBalanceSettings(db *sql.DB) (BalanceSettings, error) {
	s := BalanceSettings{Enabled: false, MonthlyAmount: 0, MonthlyMode: BalanceModeAdd}
	v, ok, err := GetSetting(db, BalanceEnabledSetting)
	if err != nil {
		return s, err
	}
	if ok {
		s.Enabled = strings.TrimSpace(v) == "true" || strings.TrimSpace(v) == "1"
	}
	if v, ok, err = GetSetting(db, BalanceMonthlyAmount); err != nil {
		return s, err
	} else if ok {
		if f, perr := parseMoney(v); perr == nil && f >= 0 {
			s.MonthlyAmount = f
		}
	}
	if v, ok, err = GetSetting(db, BalanceMonthlyMode); err != nil {
		return s, err
	} else if ok {
		if v = strings.TrimSpace(v); v == BalanceModeCover {
			s.MonthlyMode = BalanceModeCover
		} else {
			s.MonthlyMode = BalanceModeAdd
		}
	}
	return s, nil
}

// SaveBalanceSettings 持久化三键(逐键 upsert;单键失败返回错误由调用方回滚语义处理)。
func SaveBalanceSettings(db *sql.DB, s BalanceSettings) error {
	if s.MonthlyAmount < 0 {
		return ErrValidation
	}
	mode := BalanceModeAdd
	if s.MonthlyMode == BalanceModeCover {
		mode = BalanceModeCover
	}
	if err := SetSetting(db, BalanceEnabledSetting, strconv.FormatBool(s.Enabled)); err != nil {
		return err
	}
	if err := SetSetting(db, BalanceMonthlyAmount, formatMoney(s.MonthlyAmount)); err != nil {
		return err
	}
	return SetSetting(db, BalanceMonthlyMode, mode)
}

// parseMoney 解析金额字符串(拒绝 NaN/Inf)。
func parseMoney(v string) (float64, error) {
	f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, ErrValidation
	}
	return roundMoney(f), nil
}

func roundMoney(v float64) float64 { return math.Round(v*100) / 100 }

func formatMoney(v float64) string {
	return strconv.FormatFloat(roundMoney(v), 'f', -1, 64)
}

// BalanceGrant 一条月度发放记录。
type BalanceGrant struct {
	Month     string    `json:"month"`
	Mode      string    `json:"mode"`
	Amount    float64   `json:"amount"`
	Affected  int64     `json:"affected"`
	Actor     string    `json:"actor"`
	CreatedAt time.Time `json:"created_at"`
}

// LastBalanceGrant 返回最近一次发放(无记录时 nil)。
func LastBalanceGrant(db *sql.DB) (*BalanceGrant, error) {
	var g BalanceGrant
	var created any
	err := db.QueryRow(`SELECT month, mode, amount, affected, actor, created_at
FROM balance_grants ORDER BY month DESC LIMIT 1`).Scan(&g.Month, &g.Mode, &g.Amount, &g.Affected, &g.Actor, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	g.CreatedAt = parseSQLTime(created)
	return &g, nil
}

// GetBalanceGrant 返回指定北京月的发放记录(nil = 未发放)。
func GetBalanceGrant(db *sql.DB, month string) (*BalanceGrant, error) {
	var g BalanceGrant
	var created any
	err := db.QueryRow(`SELECT month, mode, amount, affected, actor, created_at
FROM balance_grants WHERE month = ?`, month).Scan(&g.Month, &g.Mode, &g.Amount, &g.Affected, &g.Actor, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	g.CreatedAt = parseSQLTime(created)
	return &g, nil
}

// GrantMonthlyBalance 执行一次全员发放(按北京月幂等)。
//
// 幂等实现:先 INSERT balance_grants(month) ON CONFLICT DO NOTHING 抢锚,
// 抢到的事务独占发放;未抢到则返回已发放记录(granted=false)。
// @param amount 单人额度(元,必须 > 0)
// @param mode add|cover
// @param actor 触发者(定时任务传空串)
// @param now 用于确定北京月(测试可注入)
func GrantMonthlyBalance(db *sql.DB, mode string, amount float64, actor string, now time.Time) (*BalanceGrant, bool, error) {
	if amount <= 0 {
		return nil, false, ErrValidation
	}
	if mode != BalanceModeCover {
		mode = BalanceModeAdd
	}
	amount = roundMoney(amount)
	month := monthKey(BeijingMonth(now))

	tx, err := db.Begin()
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()

	// 抢当月锚点:0 行 = 本月已发放(并发/重启/手动)。
	res, err := tx.Exec(`INSERT INTO balance_grants (month, mode, amount, actor)
VALUES (?, ?, ?, ?) ON CONFLICT (month) DO NOTHING`, month, mode, amount, actor)
	if err != nil {
		return nil, false, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		tx.Rollback()
		g, gerr := GetBalanceGrant(db, month)
		if gerr != nil {
			return nil, false, gerr
		}
		return g, false, nil
	}

	// 发放范围:启用中的普通员工(管理员网关豁免、审计员不可用客户端)。
	var affected int64
	if mode == BalanceModeCover {
		res, err = tx.Exec(`UPDATE users SET balance_money = ?, updated_at = `+NowExpr()+`
WHERE status = 1 AND role = ?`, amount, RoleUser)
	} else {
		res, err = tx.Exec(`UPDATE users SET balance_money = balance_money + ?, updated_at = `+NowExpr()+`
WHERE status = 1 AND role = ?`, amount, RoleUser)
	}
	if err != nil {
		return nil, false, err
	}
	affected, _ = res.RowsAffected()
	if _, err := tx.Exec(`UPDATE balance_grants SET affected = ? WHERE month = ?`, affected, month); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(); err != nil {
		return nil, false, err
	}
	return &BalanceGrant{Month: month, Mode: mode, Amount: amount, Affected: affected, Actor: actor, CreatedAt: time.Now()}, true, nil
}

// AdjustUserBalance 在余额上原子增减 delta(正=加,负=扣);调用方负责审计。
// 规则:调整后不得为负(扣多了返回 ErrValidation,最多扣到 0);允许两位小数。
func AdjustUserBalance(db *sql.DB, userID int64, delta float64) (float64, error) {
	delta = roundMoney(delta)
	if math.IsNaN(delta) || math.IsInf(delta, 0) {
		return 0, ErrValidation
	}
	return updateUserBalance(db, userID, func(old float64) (float64, error) {
		newBalance := roundMoney(old + delta)
		if newBalance < -moneyEpsilonBalance {
			return 0, ErrValidation
		}
		if newBalance < 0 {
			newBalance = 0
		}
		return newBalance, nil
	})
}

// SetUserBalance 直接把余额设为 amount(>= 0;覆盖语义,调用方负责审计)。
func SetUserBalance(db *sql.DB, userID int64, amount float64) (float64, error) {
	amount = roundMoney(amount)
	if amount < 0 || math.IsNaN(amount) || math.IsInf(amount, 0) {
		return 0, ErrValidation
	}
	return updateUserBalance(db, userID, func(float64) (float64, error) { return amount, nil })
}

// updateUserBalance 事务内 SELECT ... FOR UPDATE + 计算 + 更新,防并发丢失更新。
func updateUserBalance(db *sql.DB, userID int64, apply func(old float64) (float64, error)) (float64, error) {
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var old float64
	if err := tx.QueryRow(`SELECT balance_money FROM users WHERE id = ? FOR UPDATE`, userID).Scan(&old); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, ErrNotFound
		}
		return 0, err
	}
	next, err := apply(old)
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`UPDATE users SET balance_money = ?, updated_at = `+NowExpr()+` WHERE id = ?`, next, userID); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return next, nil
}

// BalanceBillingEnabled 报告当前是否处于"消费扣余额"状态(仅闸门开启时)。
//
// 复核修正(2026-09-11 高视角):未启用期间余额是纯充值池,不随消费变动。
// 否则默认关闭数周后管理员首次启用闸门,全员余额已被历史消费扣成负数,
// 会在一瞬间被全部拦截(必须先用覆盖模式发钱),是一个隐蔽的运营事故。
func BalanceBillingEnabled(db *sql.DB) bool {
	s, err := GetBalanceSettings(db)
	return err == nil && s.Enabled
}

// deductBalance 扣减余额(允许透支为负;仅网关计费路径调用)。
// 接受 tx 以便与 usage 写入同事务,保证「记了账一定扣了钱」。
func deductBalance(tx *sql.Tx, userID int64, amount float64) error {
	if amount <= 0 {
		return nil
	}
	// 不能按分(roundMoney)取整:单次调用费用常为几厘钱,按分取整会把
	// <0.005 元的小额费用系统性抹零。保留微元精度(1e-6),展示层再格式化。
	amount = math.Round(amount*1e6) / 1e6
	_, err := tx.Exec(`UPDATE users SET balance_money = balance_money - ? WHERE id = ?`, amount, userID)
	return err
}

// BalanceSummary 管理端余额总览。
type BalanceSummary struct {
	Settings   BalanceSettings `json:"settings"`
	LastGrant  *BalanceGrant   `json:"last_grant"`
	MonthGrant *BalanceGrant   `json:"month_grant"`
	Users      int64           `json:"users"`
	Total      float64         `json:"total_balance"`
}

// GetBalanceSummary 读取配置 + 最近发放 + 全员余额合计。
func GetBalanceSummary(db *sql.DB, now time.Time) (*BalanceSummary, error) {
	settings, err := GetBalanceSettings(db)
	if err != nil {
		return nil, err
	}
	out := &BalanceSummary{Settings: settings}
	if out.LastGrant, err = LastBalanceGrant(db); err != nil {
		return nil, err
	}
	if out.MonthGrant, err = GetBalanceGrant(db, monthKey(BeijingMonth(now))); err != nil {
		return nil, err
	}
	if err := db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(balance_money),0) FROM users
WHERE status = 1 AND role = ?`, RoleUser).Scan(&out.Users, &out.Total); err != nil {
		return nil, err
	}
	out.Total = roundMoney(out.Total)
	return out, nil
}
