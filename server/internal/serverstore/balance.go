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
// 员工余额(0061)+ 余额账本(0062)。
//
// 设计文档:docs/planning/2026-09-11-balance-quota-consolidation.md
//
// 语义:
//   - users.balance_money 是**账户余额**(元,存量):管理员可手动调整,
//     月度任务逐人发放(add 累加 / cover 清零后重发),消费按 usage.cost 扣减。
//   - users.balance_activated_at 是**开通时点**(0062):首次入账时置位。
//     未开通用户既不扣余额也不被余额闸门拦截 —— 存量部署开启闸门不会误拦
//     全员,闸门关闭期间的历史消费也不会凭空产生欠款。
//   - 已开通用户的消费**始终**扣减余额(闸门开关只决定"拦不拦",不决定
//     "记不记");扣减与 usage 落账同事务,保证「记了账一定扣了钱」。
//   - balance_ledger 是追加型流水,不变量 I1:
//     users.balance_money == SUM(balance_ledger.amount)。
//   - balance_grant_items(user_id, month) 是**逐人·月**发放幂等锚:新入职/
//     漏发/重新启用的员工会被下一次 tick 自动补齐。
//
// 精度(三层同源):
//   - 存储/账本:微元 1e-6(单次调用费用常为几厘钱,按分取整会系统性抹零);
//   - 判定与对外展示:分位四舍五入(QuantizeMoney),两者用同一个值。
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
	BalanceModeCover = "cover" // 余额清零后重置为月度额度(会抹掉手工充值,流水可见)
)

// 账本条目类型。
const (
	LedgerKindGrant   = "grant"   // 月度发放入账
	LedgerKindReset   = "reset"   // 覆盖模式清零(负数差额)
	LedgerKindAdjust  = "adjust"  // 管理员手工增减/设为
	LedgerKindConsume = "consume" // 消费扣减
	LedgerKindRefund  = "refund"  // 费用向下修正的回补
)

// moneyEpsilonBalance 金额比较容差(浮点累加/分位处理)。
const moneyEpsilonBalance = 0.0001

// moneyMicroScale 账本/存储精度(微元)。
const moneyMicroScale = 1e6

// BalanceSettings 月度余额发放配置。
type BalanceSettings struct {
	// Enabled: 余额是否为网关硬闸门(余额 <= 0 → 429)。默认 false,
	// 避免存量部署升级后(余额全为 0)全员被立刻拦截。
	// 注意:Enabled 只决定"拦不拦",不决定"发不发/记不记"。
	Enabled bool `json:"enabled"`
	// MonthlyAmount: 每人每月发放额度(元)。<= 0 = 不自动发放。
	MonthlyAmount float64 `json:"monthly_amount"`
	// MonthlyMode: add(累加) | cover(清零后重发)。
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

// ---------------------------------------------------------------------------
// 精度
// ---------------------------------------------------------------------------

// parseMoney 解析金额字符串(拒绝 NaN/Inf)。
func parseMoney(v string) (float64, error) {
	f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, ErrValidation
	}
	return roundMoney(f), nil
}

// roundMoney 金额取整到分(对外展示、发放额度、手工调整的输入口径)。
func roundMoney(v float64) float64 { return math.Round(v*100) / 100 }

// QuantizeMoney 是**对外输出/闸门判定**的金额口径:分位四舍五入。
// 所有返回给客户端与管理端的 balance_money 都必须经它,保证
// 「展示值 == 判定值 == 客户端告警阈值」三处同源。
func QuantizeMoney(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Round(v*100) / 100
}

// roundMicro 账本精度(微元,1e-6):单次调用费用常为几厘钱,按分取整会把
// <0.005 元的小额费用系统性抹零。
func roundMicro(v float64) float64 { return math.Round(v*moneyMicroScale) / moneyMicroScale }

func formatMoney(v float64) string {
	return strconv.FormatFloat(roundMoney(v), 'f', -1, 64)
}

// ---------------------------------------------------------------------------
// 账本(唯一写入口)
// ---------------------------------------------------------------------------

// BalanceLedgerEntry 一条余额流水。
type BalanceLedgerEntry struct {
	ID           int64     `json:"id"`
	UserID       int64     `json:"user_id"`
	Kind         string    `json:"kind"`
	Amount       float64   `json:"amount"`
	BalanceAfter float64   `json:"balance_after"`
	Reason       string    `json:"reason"`
	Actor        string    `json:"actor"`
	UsageID      *int64    `json:"usage_id"`
	Month        string    `json:"month"`
	CreatedAt    time.Time `json:"created_at"`
}

// insertLedgerTx 追加一条流水(调用方保证同事务内已更新余额)。
func insertLedgerTx(tx *sql.Tx, userID int64, kind string, amount, balanceAfter float64, reason, actor string, usageID *int64, month string) error {
	_, err := tx.Exec(`INSERT INTO balance_ledger
(user_id, kind, amount, balance_after, reason, actor, usage_id, month)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		userID, kind, roundMicro(amount), roundMicro(balanceAfter), reason, actor, usageID, month)
	return err
}

// settleUsageCostTx 把某条 usage 行的**计费金额**收敛到 targetCost:
// 与 usage 落账同事务调用,delta = -(targetCost - 已计费金额),因此
//   - 首次计费:已计费 0 → 扣 targetCost(consume);
//   - 流式回填:按差额补扣(consume);
//   - 重复回填/费用下调:差额为 0 或为正 → 不重复扣 / 记为 refund 回补。
//
// 未开通余额账户的用户不扣减(也不写流水)——见文件头开通语义。
// 调用方必须先锁住 usage 行(SELECT ... FOR UPDATE),本函数按 usage_id
// 汇总流水计算已计费金额,并发下不会重复扣款。
func settleUsageCostTx(tx *sql.Tx, usageID, userID int64, targetCost float64) error {
	var charged float64
	if err := tx.QueryRow(`SELECT COALESCE(-SUM(amount),0) FROM balance_ledger WHERE usage_id = ?`, usageID).Scan(&charged); err != nil {
		return err
	}
	delta := roundMicro(-(roundMicro(targetCost) - roundMicro(charged)))
	if delta == 0 {
		return nil
	}
	var after float64
	err := tx.QueryRow(`UPDATE users SET balance_money = balance_money + ?, updated_at = `+NowExpr()+`
WHERE id = ? AND balance_activated_at IS NOT NULL RETURNING balance_money`, delta, userID).Scan(&after)
	if errors.Is(err, sql.ErrNoRows) {
		return nil // 未开通余额账户:不扣不记
	}
	if err != nil {
		return err
	}
	kind := LedgerKindConsume
	if delta > 0 {
		kind = LedgerKindRefund
	}
	id := usageID
	return insertLedgerTx(tx, userID, kind, delta, after, "", "system", &id, "")
}

// adjustBalanceTx 手工增减余额(带符号 delta,调用方负责审计)。
// 入账即开通(首次入账置位 balance_activated_at)。
func adjustBalanceTx(tx *sql.Tx, userID int64, delta float64, reason, actor string) (float64, error) {
	delta = roundMicro(delta)
	if delta == 0 {
		// 金额未变(如"设为"当前值):不动余额、不置开通位、不写流水。
		var cur float64
		if err := tx.QueryRow(`SELECT balance_money FROM users WHERE id = ?`, userID).Scan(&cur); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return 0, ErrNotFound
			}
			return 0, err
		}
		return cur, nil
	}
	var after float64
	err := tx.QueryRow(`UPDATE users SET balance_money = balance_money + ?,
balance_activated_at = COALESCE(balance_activated_at, `+NowExpr()+`), updated_at = `+NowExpr()+`
WHERE id = ? RETURNING balance_money`, delta, userID).Scan(&after)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	if err := insertLedgerTx(tx, userID, LedgerKindAdjust, delta, after, reason, actor, nil, ""); err != nil {
		return 0, err
	}
	return after, nil
}

// ---------------------------------------------------------------------------
// 管理员操作
// ---------------------------------------------------------------------------

// AdjustUserBalance 在余额上原子增减 delta(正=加,负=扣),并记一条 adjust 流水。
// delta 自动钳制:不允许余额被扣成负数(最多扣到 0,修「残值扣不动」死角)。
func AdjustUserBalance(db *sql.DB, userID int64, delta float64, reason, actor string) (float64, error) {
	delta = roundMoney(delta)
	if math.IsNaN(delta) || math.IsInf(delta, 0) {
		return 0, ErrValidation
	}
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
	if delta < 0 {
		// 防误输的保护:扣减额不得超过**展示口径**的余额(分位四舍五入)。
		if -delta > QuantizeMoney(old)+moneyEpsilonBalance {
			return 0, ErrValidation
		}
		// 恰好把展示余额扣完(含分位残值)时直接清零,不留下扣不动的零头。
		if -delta >= old {
			delta = -roundMicro(old)
		}
	}
	next, err := adjustBalanceTx(tx, userID, delta, reason, actor)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return next, nil
}

// SetUserBalance 把余额直接设为 amount(>= 0),并记一条 adjust 流水(差额)。
// amount = 0 是合法操作(清零),不再被拒绝。
func SetUserBalance(db *sql.DB, userID int64, amount float64, reason, actor string) (float64, error) {
	amount = roundMoney(amount)
	if amount < 0 || math.IsNaN(amount) || math.IsInf(amount, 0) {
		return 0, ErrValidation
	}
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
	delta := roundMicro(amount - old)
	next, err := adjustBalanceTx(tx, userID, delta, reason, actor)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return next, nil
}

// BalanceLedgerPage 返回某用户的流水分页(最新在前)。
func BalanceLedgerPage(db *sql.DB, userID int64, kind string, page, size int) ([]BalanceLedgerEntry, int64, error) {
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 200 {
		size = 20
	}
	where := "user_id = ?"
	args := []any{userID}
	if kind != "" {
		where += " AND kind = ?"
		args = append(args, kind)
	}
	var total int64
	if err := db.QueryRow(`SELECT COUNT(*) FROM balance_ledger WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	args = append(args, size, (page-1)*size)
	rows, err := db.Query(`SELECT id, user_id, kind, amount, balance_after, reason, actor, usage_id, month, created_at
FROM balance_ledger WHERE `+where+` ORDER BY id DESC LIMIT ? OFFSET ?`, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []BalanceLedgerEntry{}
	for rows.Next() {
		var e BalanceLedgerEntry
		var usageID sql.NullInt64
		var created any
		if err := rows.Scan(&e.ID, &e.UserID, &e.Kind, &e.Amount, &e.BalanceAfter, &e.Reason, &e.Actor, &usageID, &e.Month, &created); err != nil {
			return nil, 0, err
		}
		if usageID.Valid {
			v := usageID.Int64
			e.UsageID = &v
		}
		e.CreatedAt = parseSQLTime(created)
		out = append(out, e)
	}
	return out, total, rows.Err()
}

// BalanceLedgerSum 返回某用户流水合计(对账用:应等于 users.balance_money)。
func BalanceLedgerSum(db *sql.DB, userID int64) (float64, error) {
	var sum float64
	err := db.QueryRow(`SELECT COALESCE(SUM(amount),0) FROM balance_ledger WHERE user_id = ?`, userID).Scan(&sum)
	return sum, err
}

// ---------------------------------------------------------------------------
// 月度发放(逐人·月锚)
// ---------------------------------------------------------------------------

// GrantRun 一次发放执行结果。
type GrantRun struct {
	Month   string  `json:"month"`
	Mode    string  `json:"mode"`
	Amount  float64 `json:"amount"`
	Granted int64   `json:"granted"` // 本次实际入账人数
	Skipped int64   `json:"skipped"` // 本月已有锚而跳过的人数
	Actor   string  `json:"actor"`
}

// GrantRunEmpty 供无候选/未配置时返回(便于 handler 统一响应形状)。
func GrantRunEmpty(mode string, amount float64, now time.Time) *GrantRun {
	return &GrantRun{Month: monthKey(BeijingMonth(now)), Mode: normalizeGrantMode(mode), Amount: roundMoney(amount)}
}

func normalizeGrantMode(mode string) string {
	if mode == BalanceModeCover {
		return BalanceModeCover
	}
	return BalanceModeAdd
}

// grantBatchSize 每次入账的用户批大小(限制单事务持锁时间)。
const grantBatchSize = 500

// GrantMonthlyBalance 执行一次按月发放:为「本月尚无发放锚」的启用普通员工
// 逐人入账。幂等锚 = balance_grant_items(user_id, month),跨实例/重启/重入/
// 补发都只入账一次;onlyUserID > 0 时只处理该用户(新建/启用用户即时发放)。
//
// 与 0061 的差异(设计文档 §5.5):
//   - 不再是"一条全体 UPDATE + 单月锚",而是逐人锚 → 新员工/漏发自动补齐;
//   - cover 模式把"清零"记成 reset 流水,抹掉了多少在账本里可见;
//   - 与 balance.enabled 解耦:是否发放只由 monthly_amount 决定。
func GrantMonthlyBalance(db *sql.DB, mode string, amount float64, actor string, now time.Time, onlyUserID int64) (*GrantRun, error) {
	if amount <= 0 {
		return nil, ErrValidation
	}
	mode = normalizeGrantMode(mode)
	amount = roundMoney(amount)
	month := monthKey(BeijingMonth(now))
	run := &GrantRun{Month: month, Mode: mode, Amount: amount, Actor: actor}

	tx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	// 候选范围:启用中的普通员工(管理员网关豁免、审计员不可用客户端)。
	candWhere := `status = 1 AND role = ?`
	candArgs := []any{RoleUser}
	if onlyUserID > 0 {
		candWhere += ` AND id = ?`
		candArgs = append(candArgs, onlyUserID)
	}
	// 跳过人数:本月已有锚(先统计,再抢锚)。
	if err := tx.QueryRow(`SELECT COUNT(*) FROM users u WHERE `+candWhere+`
  AND EXISTS (SELECT 1 FROM balance_grant_items i WHERE i.user_id = u.id AND i.month = ?)`,
		append(append([]any{}, candArgs...), month)...).Scan(&run.Skipped); err != nil {
		return nil, err
	}
	// 抢锚:0 行 = 该用户本月已发放。
	claimArgs := append([]any{month, amount, mode, actor}, candArgs...)
	rows, err := tx.Query(`INSERT INTO balance_grant_items (user_id, month, amount, mode, actor)
SELECT id, ?, ?, ?, ? FROM users WHERE `+candWhere+`
ON CONFLICT (user_id, month) DO NOTHING RETURNING user_id`, claimArgs...)
	if err != nil {
		return nil, err
	}
	var claimed []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		claimed = append(claimed, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	run.Granted = int64(len(claimed))

	for start := 0; start < len(claimed); start += grantBatchSize {
		end := start + grantBatchSize
		if end > len(claimed) {
			end = len(claimed)
		}
		if err := grantBatchTx(tx, claimed[start:end], mode, amount, actor, month); err != nil {
			return nil, err
		}
	}

	// 批次台账(affected = 本月累计已发放人数,幂等重算)。
	if _, err := tx.Exec(`INSERT INTO balance_grants (month, mode, amount, actor, affected)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (month) DO UPDATE SET affected = excluded.affected, mode = excluded.mode, amount = excluded.amount, actor = excluded.actor`,
		month, mode, amount, actor, run.Granted+run.Skipped); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return run, nil
}

// grantBatchTx 给一批用户入账(行锁 + 批量更新 + 批量流水)。
func grantBatchTx(tx *sql.Tx, ids []int64, mode string, amount float64, actor, month string) error {
	arg := pgInt64Array(ids)
	reason := "月度发放"
	if mode == BalanceModeCover {
		reason = "月度发放(覆盖重置)"
	}
	if mode == BalanceModeCover {
		// 覆盖模式:先取旧余额,写 reset 流水(-旧余额),再置为新额度。
		rows, err := tx.Query(`SELECT id, balance_money FROM users WHERE id = ANY(?::bigint[]) FOR UPDATE`, arg)
		if err != nil {
			return err
		}
		var oldIDs []int64
		var oldAmounts []float64
		oldByID := map[int64]float64{}
		for rows.Next() {
			var id int64
			var bal float64
			if err := rows.Scan(&id, &bal); err != nil {
				rows.Close()
				return err
			}
			oldByID[id] = bal
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, id := range ids {
			if old := roundMicro(oldByID[id]); old != 0 {
				oldIDs = append(oldIDs, id)
				oldAmounts = append(oldAmounts, -old)
			}
		}
		if _, err := tx.Exec(`UPDATE users SET balance_money = ?,
balance_activated_at = COALESCE(balance_activated_at, `+NowExpr()+`), updated_at = `+NowExpr()+`
WHERE id = ANY(?::bigint[])`, amount, arg); err != nil {
			return err
		}
		if len(oldIDs) > 0 {
			if _, err := tx.Exec(`INSERT INTO balance_ledger (user_id, kind, amount, balance_after, reason, actor, month)
SELECT u, ?, a, 0, ?, ?, ? FROM unnest(?::bigint[], ?::double precision[]) AS t(u, a)`,
				LedgerKindReset, reason, actor, month, pgInt64Array(oldIDs), pgFloat64Array(oldAmounts)); err != nil {
				return err
			}
		}
		// grant 流水(余额即 amount,balance_after = amount)。
		amounts := make([]float64, len(ids))
		for i := range amounts {
			amounts[i] = amount
		}
		_, err = tx.Exec(`INSERT INTO balance_ledger (user_id, kind, amount, balance_after, reason, actor, month)
SELECT u, ?, a, ?, ?, ?, ? FROM unnest(?::bigint[], ?::double precision[]) AS t(u, a)`,
			LedgerKindGrant, amount, reason, actor, month, arg, pgFloat64Array(amounts))
		return err
	}

	// add 模式:一条批量更新 + 一条批量流水(RETURNING 给出逐人 balance_after)。
	rows, err := tx.Query(`UPDATE users SET balance_money = balance_money + ?,
balance_activated_at = COALESCE(balance_activated_at, `+NowExpr()+`), updated_at = `+NowExpr()+`
WHERE id = ANY(?::bigint[]) RETURNING id, balance_money`, amount, arg)
	if err != nil {
		return err
	}
	var afterIDs []int64
	var afterAmounts []float64
	for rows.Next() {
		var id int64
		var bal float64
		if err := rows.Scan(&id, &bal); err != nil {
			rows.Close()
			return err
		}
		afterIDs = append(afterIDs, id)
		afterAmounts = append(afterAmounts, bal)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(afterIDs) == 0 {
		return nil
	}
	grants := make([]float64, len(afterIDs))
	for i := range grants {
		grants[i] = amount
	}
	_, err = tx.Exec(`INSERT INTO balance_ledger (user_id, kind, amount, balance_after, reason, actor, month)
SELECT u, ?, a, b, ?, ?, ? FROM unnest(?::bigint[], ?::double precision[], ?::double precision[]) AS t(u, a, b)`,
		LedgerKindGrant, reason, actor, month, pgInt64Array(afterIDs), pgFloat64Array(grants), pgFloat64Array(afterAmounts))
	return err
}

// GrantStatus 当月发放状态(管理端展示)。
type GrantStatus struct {
	Month     string        `json:"month"`
	Eligible  int64         `json:"eligible"`  // 符合条件的启用普通员工
	Granted   int64         `json:"granted"`   // 本月已发放人数
	Pending   int64         `json:"pending"`   // 本月未发放人数
	Activated int64         `json:"activated"` // 已开通余额账户的人数
	LastGrant *BalanceGrant `json:"last_grant"`
}

// GetGrantStatus 统计当月发放覆盖情况。
func GetGrantStatus(db *sql.DB, now time.Time) (*GrantStatus, error) {
	month := monthKey(BeijingMonth(now))
	out := &GrantStatus{Month: month}
	if err := db.QueryRow(`SELECT COUNT(*),
  COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM balance_grant_items i WHERE i.user_id = u.id AND i.month = ?)),
  COUNT(*) FILTER (WHERE u.balance_activated_at IS NOT NULL)
FROM users u WHERE u.status = 1 AND u.role = ?`, month, RoleUser).
		Scan(&out.Eligible, &out.Granted, &out.Activated); err != nil {
		return nil, err
	}
	out.Pending = out.Eligible - out.Granted
	g, err := LastBalanceGrant(db)
	if err != nil {
		return nil, err
	}
	out.LastGrant = g
	return out, nil
}

// EnsureUserMonthlyGrant 给单个用户补发当月额度(新建/启用/登录时调用)。
// 未配置额度(=0)时静默跳过。返回 nil 表示无需发放或已发放。
func EnsureUserMonthlyGrant(db *sql.DB, userID int64, now time.Time) (*GrantRun, error) {
	s, err := GetBalanceSettings(db)
	if err != nil {
		return nil, err
	}
	if s.MonthlyAmount <= 0 {
		return nil, nil
	}
	run, err := GrantMonthlyBalance(db, s.MonthlyMode, s.MonthlyAmount, "system", now, userID)
	if err != nil {
		if errors.Is(err, ErrValidation) {
			return nil, nil
		}
		return nil, err
	}
	if run.Granted == 0 {
		return nil, nil
	}
	return run, nil
}

// ---------------------------------------------------------------------------
// 发放批次台账(0061 表,0062 起作为批次汇总)
// ---------------------------------------------------------------------------

// BalanceGrant 一条月度发放批次记录。
type BalanceGrant struct {
	Month     string    `json:"month"`
	Mode      string    `json:"mode"`
	Amount    float64   `json:"amount"`
	Affected  int64     `json:"affected"`
	Actor     string    `json:"actor"`
	CreatedAt time.Time `json:"created_at"`
}

// LastBalanceGrant 返回最近一次发放批次(无记录时 nil)。
func LastBalanceGrant(db *sql.DB) (*BalanceGrant, error) {
	return queryBalanceGrant(db, `SELECT month, mode, amount, affected, actor, created_at
FROM balance_grants ORDER BY month DESC LIMIT 1`)
}

// GetBalanceGrant 返回指定北京月的发放批次(nil = 未发放)。
func GetBalanceGrant(db *sql.DB, month string) (*BalanceGrant, error) {
	return queryBalanceGrant(db, `SELECT month, mode, amount, affected, actor, created_at
FROM balance_grants WHERE month = ?`, month)
}

func queryBalanceGrant(db *sql.DB, q string, args ...any) (*BalanceGrant, error) {
	var g BalanceGrant
	var created any
	err := db.QueryRow(q, args...).Scan(&g.Month, &g.Mode, &g.Amount, &g.Affected, &g.Actor, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	g.CreatedAt = parseSQLTime(created)
	return &g, nil
}

// ---------------------------------------------------------------------------
// 闸门与总览
// ---------------------------------------------------------------------------

// BalanceBillingEnabled 报告当前是否处于"余额闸门"状态。
//
// 语义(2026-09-11 重构后):闸门只决定**拦不拦**。消费扣减对已开通用户
// 始终发生(见 settleUsageCostTx),否则余额不是账、无法对账。
func BalanceBillingEnabled(db *sql.DB) bool {
	s, err := GetBalanceSettings(db)
	return err == nil && s.Enabled
}

// BalanceBlocked 报告该用户是否应被余额闸门拦截:
// 已开通 且 分位口径下的余额 <= 0。未开通(从未入账)不拦。
func BalanceBlocked(db *sql.DB, user *User) (bool, string) {
	s, err := GetBalanceSettings(db)
	if err != nil {
		return true, "余额校验暂不可用,请稍后再试" // fail-closed
	}
	if !s.Enabled {
		return false, ""
	}
	if user.BalanceActivatedAt.IsZero() {
		return false, "" // 未开通余额账户:闸门不适用
	}
	if QuantizeMoney(user.BalanceMoney) <= 0 {
		return true, "账户余额不足,请联系管理员充值"
	}
	return false, ""
}

// BalanceSummary 管理端余额总览。
type BalanceSummary struct {
	Settings   BalanceSettings `json:"settings"`
	LastGrant  *BalanceGrant   `json:"last_grant"`
	MonthGrant *BalanceGrant   `json:"month_grant"`
	Status     GrantStatus     `json:"status"`
	Users      int64           `json:"users"`
	Total      float64         `json:"total_balance"`
}

// GetBalanceSummary 读取配置 + 发放状态 + 全员余额合计(输出 quantize 到分)。
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
	if st, err := GetGrantStatus(db, now); err == nil {
		out.Status = *st
	} else {
		return nil, err
	}
	if err := db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(balance_money),0) FROM users
WHERE status = 1 AND role = ?`, RoleUser).Scan(&out.Users, &out.Total); err != nil {
		return nil, err
	}
	out.Total = QuantizeMoney(out.Total)
	return out, nil
}
