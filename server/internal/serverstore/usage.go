package serverstore

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// pgTimeFmt 是**北京墙钟**("2006-01-02 15:04:05")格式:仅用于测试夹具把
// 北京墙钟字面量转成绝对瞬时(见 *_test.go 的 setCreatedAt)。生产查询一律用
// beijing.go 的 BeijingDay/pgInstantArg —— 裸墙钟字符串会被 PG 按会话时区
// 解释(2026-09-10 时区缺陷),不得再进入 SQL 参数。
const pgTimeFmt = "2006-01-02 15:04:05"

// MonthlyQuotaSetting is the settings key for the default per-user monthly
// traffic quota in tokens (absent / "0" = unlimited).
const MonthlyQuotaSetting = "usage.monthly_quota"

// MonthlyMoneyQuotaSetting is the settings key for the default per-user
// monthly traffic quota in yuan (absent / "0" = unlimited).
const MonthlyMoneyQuotaSetting = "usage.monthly_quota_money"

// PeakWindowsSetting 高峰时段配置(settings 键,JSON 字符串):
//
//	[{"start":"09:00","end":"12:00","weekdays":[1,2,3,4,5]},
//	 {"start":"14:00","end":"18:00","weekdays":[1,2,3,4,5]}]
//
// 语义:时段按北京时间(UTC+8,无 DST)判定,半开区间 [start, end);
// weekdays 为适用星期(1=周一…7=周日,省略 = 每天)。
// 高峰窗口内费用按标准价,窗口外(空闲时段)按模型 offpeak_discount 打折。
// 空串 / 缺省 / 非法 = 无峰谷价(全天标准价)。
// DeepSeek 官方当前政策(2026-08 起):高峰 = 北京时间**周一至周五**
// 09:00-12:00、14:00-18:00(其余 = 空闲,含周末),空闲价 = 高峰价 × 50%。
const PeakWindowsSetting = "usage.peak_windows"

// PeakWindow 一个高峰时段(北京时间 "HH:MM",半开 [start,end))。
// Weekdays: 适用星期(1=周一…7=周日);空/缺省 = 每天。
type PeakWindow struct {
	Start    string `json:"start"`
	End      string `json:"end"`
	Weekdays []int  `json:"weekdays,omitempty"`
	// 内部解析后的分钟数(自午夜 0 点起)
	StartMin int `json:"-"`
	EndMin   int `json:"-"`
}

// parseHHMM 解析 "HH:MM" → 自午夜分钟数;非法返回 ok=false。
// 审计 2026-08-25:原实现 h/m 为无符号 byte(恒 >=0),h<0/m<0 是死条件,
// hok/mok 实际是第二位数,命名误导。改为显式字符校验。
func parseHHMM(s string) (int, bool) {
	if len(s) != 5 || s[2] != ':' {
		return 0, false
	}
	d0, d1 := s[0], s[1]
	d3, d4 := s[3], s[4]
	if d0 < '0' || d0 > '9' || d1 < '0' || d1 > '9' ||
		d3 < '0' || d3 > '9' || d4 < '0' || d4 > '9' {
		return 0, false
	}
	hh := int(d0-'0')*10 + int(d1-'0')
	mm := int(d3-'0')*10 + int(d4-'0')
	if hh > 23 || mm > 59 {
		return 0, false
	}
	return hh*60 + mm, true
}

// ParsePeakWindows 解析 settings 值;非法或空 → nil(无峰谷价)。
func ParsePeakWindows(v string) []PeakWindow {
	if v == "" {
		return nil
	}
	var raw []struct {
		Start    string `json:"start"`
		End      string `json:"end"`
		Weekdays []int  `json:"weekdays"`
	}
	if err := json.Unmarshal([]byte(v), &raw); err != nil {
		return nil
	}
	out := []PeakWindow{}
	for _, r := range raw {
		sm, sok := parseHHMM(r.Start)
		em, eok := parseHHMM(r.End)
		if !sok || !eok || sm >= em {
			return nil // 整体非法即视为未配置,避免部分生效导致计费口径混乱
		}
		w := PeakWindow{Start: r.Start, End: r.End, StartMin: sm, EndMin: em}
		// weekdays 校验:仅保留 1-7 的整数,去重;空/非法 = 每天(兼容旧数据)。
		if len(r.Weekdays) > 0 {
			seen := map[int]bool{}
			for _, d := range r.Weekdays {
				if d >= 1 && d <= 7 && !seen[d] {
					w.Weekdays = append(w.Weekdays, d)
					seen[d] = true
				}
			}
		}
		out = append(out, w)
	}
	return out
}

// loadPeakWindows 从 settings 读高峰窗口(每次记录时调用,单行查询开销可忽略)。
func loadPeakWindows(db *sql.DB) []PeakWindow {
	v, ok, err := GetSetting(db, PeakWindowsSetting)
	if err != nil || !ok {
		return nil
	}
	return ParsePeakWindows(v)
}

// beijingMinutes 返回 now 的北京时间分钟数(UTC+8,无 DST,不依赖 tzdata)。
func beijingMinutes(now time.Time) int {
	bj := now.UTC().Add(8 * time.Hour)
	return bj.Hour()*60 + bj.Minute()
}

// beijingWeekday 返回 now 的北京时间星期编号(1=周一…7=周日)。
// Go time.Weekday 为 Sunday=0..Saturday=6,映射为 1..7。
func beijingWeekday(now time.Time) int {
	return (int(now.UTC().Add(8*time.Hour).Weekday())+6)%7 + 1
}

// inPeakWindow 判断 now(任意时区)是否处于任一高峰窗口(按北京时间)。
// 窗口的 weekdays 为空(缺省)或包含当前北京星期时匹配;否则不匹配(如周末空闲)。
func inPeakWindow(now time.Time, windows []PeakWindow) bool {
	mins := beijingMinutes(now)
	wd := beijingWeekday(now)
	for _, w := range windows {
		if mins >= w.StartMin && mins < w.EndMin && (len(w.Weekdays) == 0 || containsDay(w.Weekdays, wd)) {
			return true
		}
	}
	return false
}

func containsDay(days []int, d int) bool {
	for _, x := range days {
		if x == d {
			return true
		}
	}
	return false
}

// offpeakFactor 返回时刻 now 的费用系数:配置了高峰窗口且 now 不在窗口内
// (空闲时段)且 0<discount<1 → discount;否则 1(无峰谷价 / 高峰时段)。
func offpeakFactor(now time.Time, discount float64, windows []PeakWindow) float64 {
	if !(discount > 0 && discount < 1) || len(windows) == 0 {
		return 1
	}
	if inPeakWindow(now, windows) {
		return 1
	}
	return discount
}

// costOfAt computes the yuan cost for a usage row at time now from model
// pricing (yuan per 1M tokens), applying the off-peak discount in non-peak
// windows (0023). Unpriced models (0,0) yield 0 cost.
// 缓存计费(0029/0030):cacheTokens(命中的输入 token)按 cacheInputPer1M 计费
// (未配置则回退输入价),其余输入按 inputPer1M,输出按 outputPer1M。
// promptTokens 是**含缓存部分的总输入**;P1-9:不再把 cacheTokens 钳到
// promptTokens(该钳制会把 Anthropic 的 cache_read 压到 input_tokens,少收
// 约 99.9%),改为相加口径 + 只对 miss 做非负防御。
func costOfAt(now time.Time, promptTokens, completionTokens, cacheTokens int64, inputPer1M, outputPer1M, cacheInputPer1M, offpeak float64, windows []PeakWindow) float64 {
	if cacheTokens < 0 {
		cacheTokens = 0
	}
	cachePrice := cacheInputPer1M
	if cachePrice <= 0 {
		cachePrice = inputPer1M // 未配置缓存价:命中按输入价计
	}
	missTokens := promptTokens - cacheTokens
	if missTokens < 0 {
		missTokens = 0 // 防御:异常输入不产生负费用
	}
	base := float64(missTokens)/1e6*inputPer1M +
		float64(cacheTokens)/1e6*cachePrice +
		float64(completionTokens)/1e6*outputPer1M
	return base * offpeakFactor(now, offpeak, windows)
}

// RecordUsage inserts a chat usage row and returns its id.
func RecordUsage(db *sql.DB, userID int64, model string, promptTokens, completionTokens int64) (int64, error) {
	return RecordUsageKind(db, userID, model, promptTokens, completionTokens, "chat")
}

// RecordUsageKind inserts a usage row with an explicit kind (chat | embedding).
// embedding 行的 0-token(上游省略 usage)是真实请求计数,不得被
// CleanupPendingUsage 当作流中断残留清除(审计2026-M16)。
// cost 在记录时按模型定价折算并落库(0022/0023):后续改价/删模型不重写历史,
// 金额配额与统计均读 SUM(cost),口径一致。低谷窗口按记录时刻判定。
func RecordUsageKind(db *sql.DB, userID int64, model string, promptTokens, completionTokens int64, kind string) (int64, error) {
	return recordUsageKindAt(db, userID, model, promptTokens, completionTokens, kind, time.Now())
}

// RecordUsageKindCached 与 RecordUsageKind 相同,额外携带缓存命中输入 token
// 数(DeepSeek 缓存计费,0029/0030):命中部分按 cache_input_price_per_1m 计费。
func RecordUsageKindCached(db *sql.DB, userID int64, model string, promptTokens, completionTokens, cacheTokens int64, kind string) (int64, error) {
	return recordUsageKindAtCached(db, userID, model, promptTokens, completionTokens, cacheTokens, kind, time.Now())
}

// recordUsageKindAt 是 RecordUsageKind 的时间注入版本(测试固定时刻)。
func recordUsageKindAt(db *sql.DB, userID int64, model string, promptTokens, completionTokens int64, kind string, now time.Time) (int64, error) {
	return recordUsageKindAtCached(db, userID, model, promptTokens, completionTokens, 0, kind, now)
}

// recordUsageKindAtCached 带缓存命中数的记录(时间注入)。
func recordUsageKindAtCached(db *sql.DB, userID int64, model string, promptTokens, completionTokens, cacheTokens int64, kind string, now time.Time) (int64, error) {
	in, out, off := ModelPrices(db, model)
	cacheIn := ModelCachePrice(db, model)
	cost := costOfAt(now, promptTokens, completionTokens, cacheTokens, in, out, cacheIn, off, loadPeakWindows(db))
	// 分区写路径:确保 now 所属月份分区存在(幂等 CREATE TABLE IF NOT EXISTS)。
	if err := ensureUsagePartition(db, now); err != nil {
		return 0, fmt.Errorf("ensure usage partition: %w", err)
	}
	// created_at 显式 = now(请求时刻):与 cost 计费时点同源,回填时使用该
	// 时刻折价(审计修复 2026-P M4:跨高峰/空闲边界的流式请求按发起时点计价)。
	//
	// 0061: usage 落账与余额扣减在同一事务 —— 「记了账一定扣了钱」,
	// 崩溃/并发下不会出现费用已入账而余额未扣(或反之)的半提交。
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var id int64
	if err := tx.QueryRow(`INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, cache_prompt_tokens, kind, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
		userID, model, promptTokens, completionTokens, cacheTokens, kind, cost, now).Scan(&id); err != nil {
		return 0, err
	}
	if err := deductBalance(tx, userID, cost); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return id, nil
}

// UpdateUsageTokens backfills token counts on an existing usage row (pending
// row) and recomputes cost from the row's model pricing (0022/0023).
func UpdateUsageTokens(db *sql.DB, id, promptTokens, completionTokens int64) error {
	return updateUsageTokensAt(db, id, promptTokens, completionTokens, time.Now())
}

// UpdateUsageTokensCached 带缓存命中数的回填版本(0030)。
func UpdateUsageTokensCached(db *sql.DB, id, promptTokens, completionTokens, cacheTokens int64) error {
	return updateUsageTokensAtCached(db, id, promptTokens, completionTokens, cacheTokens, time.Now())
}

// updateUsageTokensAt 是 UpdateUsageTokens 的时间注入版本(测试固定时刻)。
func updateUsageTokensAt(db *sql.DB, id, promptTokens, completionTokens int64, now time.Time) error {
	return updateUsageTokensAtCached(db, id, promptTokens, completionTokens, 0, now)
}

// updateUsageTokensAtCached 带缓存命中数的回填(时间注入)。
// 审计修复 2026-P (M4): 计费时刻取该行 created_at(pending 行 = 请求发起
// 时刻插入),而非回填时刻 time.Now()——跨高峰/空闲边界的流式请求不再因
// 流结束时点计价,与「低谷窗口按记录时刻判定」的设计一致。
func updateUsageTokensAtCached(db *sql.DB, id, promptTokens, completionTokens, cacheTokens int64, now time.Time) error {
	var userID int64
	var model string
	var oldCost float64
	var createdAt any
	if err := db.QueryRow("SELECT user_id, model, cost, created_at FROM usage WHERE id = ?", id).Scan(&userID, &model, &oldCost, &createdAt); err != nil {
		return err
	}
	// created_at(SQLite localtime 字符串 / PG TIMESTAMPTZ)解析回本地时刻;
	// 解析失败(异常数据)回退到调用方传入 now(保持可用)。
	billAt := now
	if t := parseSQLTime(createdAt); !t.IsZero() {
		billAt = t
	}
	in, out, off := ModelPrices(db, model)
	cacheIn := ModelCachePrice(db, model)
	cost := costOfAt(billAt, promptTokens, completionTokens, cacheTokens, in, out, cacheIn, off, loadPeakWindows(db))
	// 0061: 回填与余额扣减同事务,只扣差额(pending 行旧 cost 通常为 0;
	// 重复回填/修正时不会重复扣款)。
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("UPDATE usage SET prompt_tokens = ?, completion_tokens = ?, cache_prompt_tokens = ?, cost = ? WHERE id = ?",
		promptTokens, completionTokens, cacheTokens, cost, id); err != nil {
		return err
	}
	if err := deductBalance(tx, userID, cost-oldCost); err != nil {
		return err
	}
	return tx.Commit()
}

// DeleteUsage removes a usage row. Used to drop pending rows that can never
// be backfilled (C-9: failed/aborted streams).
func DeleteUsage(db *sql.DB, id int64) error {
	_, err := db.Exec("DELETE FROM usage WHERE id = ?", id)
	return err
}

// CleanupPendingUsage deletes zero-token chat/search rows older than cutoff
// (stale pending rows left by interrupted streaming requests). Run at server
// startup. 0043: search(kind='search') 的流式残留行同样清理。
// cutoff 是绝对瞬时,按会话时区无关的瞬时字面量比较(裸墙钟字符串会被按
// PG 会话时区解释 → 进程 TZ 与会话时区不同时差 8 小时)。
func CleanupPendingUsage(db *sql.DB, cutoff time.Time) error {
	_, err := db.Exec(`DELETE FROM usage WHERE kind IN ('chat','search') AND prompt_tokens = 0 AND completion_tokens = 0 AND created_at < ?::timestamptz`,
		pgInstantArg(cutoff))
	return err
}

// UserMonthlyUsage returns the user's total tokens used in the current
// calendar month. Zero-token pending rows contribute nothing, so interrupted
// streams never inflate the counter.
// 月窗口 = **北京月**(BeijingMonthInstant),与进程 TZ/PG 会话时区无关:
// 旧实现按服务器本地月界,UTC 容器的"本月"会比北京晚 8 小时重置。
func UserMonthlyUsage(db *sql.DB, userID int64) (int64, error) {
	var total int64
	err := db.QueryRow(`SELECT COALESCE(SUM(prompt_tokens),0) + COALESCE(SUM(completion_tokens),0)
		FROM usage WHERE user_id = ? AND created_at >= ?::timestamptz`,
		userID, pgInstantArg(BeijingMonthInstant(time.Now()))).Scan(&total)
	return total, err
}

// UserMonthlyUsageBatch returns a map of user_id → tokens used this calendar
// month for a bounded set of users (one query, no N+1).
// P2-7:成员集合以数组参数传入(= ANY),避免上万成员拼 IN(?,?,…) 撞 PG
// 65535 参数上限(触发后配额校验 fail-closed → 全员 429)。
func UserMonthlyUsageBatch(db *sql.DB, userIDs []int64) (map[int64]int64, error) {
	out := map[int64]int64{}
	if len(userIDs) == 0 {
		return out, nil
	}
	rows, err := db.Query(`SELECT user_id, COALESCE(SUM(prompt_tokens),0) + COALESCE(SUM(completion_tokens),0) AS t
		FROM usage WHERE created_at >= ?::timestamptz AND user_id = ANY(?::bigint[]) GROUP BY user_id`,
		pgInstantArg(BeijingMonthInstant(time.Now())), pgInt64Array(userIDs))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var uid, t int64
		if err := rows.Scan(&uid, &t); err != nil {
			return nil, err
		}
		out[uid] = t
	}
	return out, rows.Err()
}

// EffectiveQuota returns a user's monthly traffic quota in tokens: a per-user
// override wins, otherwise the global default (settings usage.monthly_quota).
// 0 = unlimited. Admins are always unlimited.
func EffectiveQuota(db *sql.DB, user *User) (int64, error) {
	if user.IsAdmin {
		return 0, nil
	}
	if user.QuotaTokens != nil {
		return *user.QuotaTokens, nil
	}
	v, ok, err := GetSetting(db, MonthlyQuotaSetting)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < 0 {
		return 0, nil
	}
	return int64(n), nil
}

// UserMonthlyCost returns the user's total cost (yuan) in the current
// calendar month (SUM of denormalized usage.cost, 0022). 月窗口同
// UserMonthlyUsage(北京月界,与环境时区无关)。
func UserMonthlyCost(db *sql.DB, userID int64) (float64, error) {
	var total float64
	err := db.QueryRow(`SELECT COALESCE(SUM(cost),0) FROM usage WHERE user_id = ? AND created_at >= ?::timestamptz`,
		userID, pgInstantArg(BeijingMonthInstant(time.Now()))).Scan(&total)
	return total, err
}

// MonthUsageByUser 用户在当月的 token 与金额用量。
type MonthUsageByUser struct {
	Tokens int64
	Cost   float64
}

// MonthUsageByUsers 一次查询返回一批用户当月的 tokens+cost 用量
// (按 user_id 分组;无用量用户不在结果中)。供配额校验合并使用:
// 服务端每请求的 quotaBlocked 需要 用户用量 + 部门成员用量,
// 以前是 3 次独立 SUM 查询,这里一次 GROUP BY 搞定。
func MonthUsageByUsers(db *sql.DB, userIDs []int64) (map[int64]MonthUsageByUser, error) {
	out := map[int64]MonthUsageByUser{}
	if len(userIDs) == 0 {
		return out, nil
	}
	// P2-7:数组参数,见 UserMonthlyUsageBatch 注释。
	rows, err := db.Query(`SELECT user_id,
		COALESCE(SUM(prompt_tokens),0) + COALESCE(SUM(completion_tokens),0) AS t,
		COALESCE(SUM(cost),0) AS c
		FROM usage WHERE created_at >= ?::timestamptz AND user_id = ANY(?::bigint[]) GROUP BY user_id`,
		pgInstantArg(BeijingMonthInstant(time.Now())), pgInt64Array(userIDs))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var uid int64
		var m MonthUsageByUser
		if err := rows.Scan(&uid, &m.Tokens, &m.Cost); err != nil {
			return nil, err
		}
		out[uid] = m
	}
	return out, rows.Err()
}

// UserMonthlyCostBatch returns a map of user_id → cost (yuan) this calendar
// month for a bounded set of users (one query, no N+1).
func UserMonthlyCostBatch(db *sql.DB, userIDs []int64) (map[int64]float64, error) {
	out := map[int64]float64{}
	if len(userIDs) == 0 {
		return out, nil
	}
	// P2-7:数组参数,见 UserMonthlyUsageBatch 注释。
	rows, err := db.Query(`SELECT user_id, COALESCE(SUM(cost),0) AS c
		FROM usage WHERE created_at >= ?::timestamptz AND user_id = ANY(?::bigint[]) GROUP BY user_id`,
		pgInstantArg(BeijingMonthInstant(time.Now())), pgInt64Array(userIDs))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var uid int64
		var c float64
		if err := rows.Scan(&uid, &c); err != nil {
			return nil, err
		}
		out[uid] = c
	}
	return out, rows.Err()
}

// EffectiveMoneyQuota returns a user's monthly traffic quota in yuan: a
// per-user override wins, otherwise the global default (settings
// usage.monthly_quota_money). 0 = unlimited. Admins are always unlimited.
func EffectiveMoneyQuota(db *sql.DB, user *User) (float64, error) {
	if user.IsAdmin {
		return 0, nil
	}
	if user.QuotaMoney != nil {
		return *user.QuotaMoney, nil
	}
	v, ok, err := GetSetting(db, MonthlyMoneyQuotaSetting)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, nil
	}
	n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	if err != nil || n < 0 {
		return 0, nil
	}
	return n, nil
}

// UsageAggregateRow is one aggregated usage row.
type UsageAggregateRow struct {
	Label            string `json:"label"`
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
	Requests         int64  `json:"requests"`
	// kind 拆分(审计2026-E2):embedding 行 prompt_tokens>0 且 completion_tokens=0,
	// 单独统计便于前端区分 chat/embedding 用量;chat = Requests - EmbedRequests。
	EmbedRequests int64 `json:"embed_requests"`
	EmbedTokens   int64 `json:"embed_tokens"`
	// CacheTokens 缓存命中的输入 token(0030,DeepSeek 缓存计费)。
	CacheTokens int64 `json:"cache_tokens"`
	// Cost 该桶费用合计(元,0022):SUM(usage.cost),未定价模型贡献 0。
	Cost float64 `json:"cost"`
}

// UsageAggregateOption 为 UsageAggregate 的可选过滤条件。
type UsageAggregateOption func(*UsageAggregateQuery)

// UsageAggregateQuery 收集聚合过滤条件。
type UsageAggregateQuery struct {
	Username string // 仅统计该用户名(用于用户钻取)
	Dept     string // 仅统计该部门树内成员(2026-09 用量中心,与预算同口径)
	Model    string // 仅统计指定模型(G9: 日志页统计徽标与明细同口径)
	Kind     string // 仅统计指定类型 chat|embedding|search(G9)
}

// WithUsername 只聚合指定用户名(JOIN users),用于用户详情钻取。
func WithUsername(username string) UsageAggregateOption {
	return func(q *UsageAggregateQuery) { q.Username = username }
}

// WithModel 只聚合指定模型的用量。
func WithModel(model string) UsageAggregateOption {
	return func(q *UsageAggregateQuery) { q.Model = model }
}

// WithKind 只聚合指定类型(chat|embedding|search)的用量。
func WithKind(kind string) UsageAggregateOption {
	return func(q *UsageAggregateQuery) { q.Kind = kind }
}

// WithDept 只聚合指定部门(含其子树)的成员用量——与部门预算 enforcement
// 同口径(成员归属祖先链全部计入)。部门不存在 = 空结果。
func WithDept(dept string) UsageAggregateOption {
	return func(q *UsageAggregateQuery) { q.Dept = dept }
}

// zeroFiller 生成完整的时间桶序列(缺桶填 0),避免折线跨缺日直连。
type zeroFiller func(from, to time.Time) []string

func dayFill(from, to time.Time) []string {
	out := []string{}
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		out = append(out, d.Format("2006-01-02"))
	}
	return out
}

func weekFill(from, to time.Time) []string {
	out := []string{}
	for d := from; !d.After(to); d = d.AddDate(0, 0, 7) {
		out = append(out, weekMonday(d))
	}
	return out
}

// weekMonday 返回该日期所在周的周一日期(YYYY-MM-DD)。SQL 侧用
// date(created_at,'weekday 0','-6 days') 得到同一周一,两者严格对齐,
// 免疫 ISO/%W 的跨年边界差异(审计2026-E2)。
func weekMonday(d time.Time) string {
	wd := int(d.Weekday()) // 0=Sunday..6=Saturday
	// 周一前推 wd-1 天;Sunday(wd=0)前推 6 天
	back := (wd + 6) % 7
	return d.AddDate(0, 0, -back).Format("2006-01-02")
}

func monthFill(from, to time.Time) []string {
	out := []string{}
	// 先归一到月初再 +1 月:避免 from=9/30 时 AddDate(0,1,0)→10/30 越过
	// to=10/15 导致 10 月桶被跳过(审计2026-E3 P1-2)
	cur := time.Date(from.Year(), from.Month(), 1, 0, 0, 0, 0, from.Location())
	end := time.Date(to.Year(), to.Month(), 1, 0, 0, 0, 0, to.Location())
	for cur.Before(end) || cur.Equal(end) {
		out = append(out, cur.Format("2006-01"))
		cur = cur.AddDate(0, 1, 0)
	}
	return out
}

// UsageAggregate aggregates usage by day | week | month | model | user | kind
// between from/to (zero time means unbounded).时间分组在给定 from/to 时按日/
// 周/月补零(缺桶填 0);按 user 分组时标签用用户名(JOIN users),查无行时
// 回退用户 ID。kind 为拆分字段而非分组维度,见 UsageAggregateRow 注释。
func UsageAggregate(db *sql.DB, from, to time.Time, group string, opts ...UsageAggregateOption) ([]UsageAggregateRow, error) {
	var q UsageAggregateQuery
	for _, o := range opts {
		o(&q)
	}
	// from/to 先归一到北京日期值:允许调用方传瞬时(如 time.Now()),避免
	// "本机日期"混进窗口(见 beijing.go)。
	from, to = normalizeDayRange(from, to)
	var selectExpr, groupExpr string
	join := ""
	fill := zeroFiller(nil)
	// username 过滤用相关子查询:避免与 group=user 的 LEFT JOIN users 双 JOIN
	// 同别名冲突(审计2026-E3 P1-1)
	var usernameFilter string
	if q.Username != "" {
		usernameFilter = " AND usage.user_id = (SELECT id FROM users WHERE username = ?)"
	}
	// 部门过滤:子树成员集合(2026-09 用量中心,与预算 enforcement 同口径)
	var deptFilter string
	var deptGroupIDs []int64
	if q.Dept != "" {
		sub, err := deptSubtreeIDs(db, q.Dept)
		if err != nil {
			if err == ErrNotFound {
				return []UsageAggregateRow{}, nil // 部门不存在 = 空结果
			}
			return nil, err
		}
		if len(sub) == 0 {
			return []UsageAggregateRow{}, nil
		}
		// P2-7:子树 group id 以数组参数传入(= ANY),避免上万成员拼
		// IN(?,?,…) 撞 PG 65535 参数上限(否则部门视图直接 500)。
		deptFilter = " AND usage.user_id IN (SELECT user_id FROM user_groups WHERE group_id = ANY(?::bigint[]))"
		deptGroupIDs = sub
	}
	switch group {
	case "day":
		selectExpr, groupExpr = DateDayExpr("usage.created_at"), DateDayExpr("usage.created_at")
		fill = dayFill
	case "week":
		// 按周一日期分桶:date(created_at,'weekday 0','-6 days') 与
		// weekMonday 严格对齐,免疫 ISO/%W 跨年差异(审计2026-E2)
		selectExpr, groupExpr = DateWeekExpr("usage.created_at"), DateWeekExpr("usage.created_at")
		fill = weekFill
	case "month":
		selectExpr, groupExpr = DateMonthExpr("usage.created_at"), DateMonthExpr("usage.created_at")
		fill = monthFill
	case "model":
		selectExpr, groupExpr = "usage.model", "usage.model"
	default:
		join = " LEFT JOIN users u ON u.id = usage.user_id"
		selectExpr, groupExpr = "COALESCE(u.username, CAST(usage.user_id AS TEXT))", "u.username, usage.user_id"
	}
	qstr := `SELECT ` + selectExpr + ` AS label,
		SUM(usage.prompt_tokens) AS pt, SUM(usage.completion_tokens) AS ct, COUNT(*) AS req,
		SUM(CASE WHEN usage.kind = 'embedding' THEN 1 ELSE 0 END) AS ereq,
		SUM(CASE WHEN usage.kind = 'embedding' THEN usage.prompt_tokens ELSE 0 END) AS etok,
		SUM(usage.cache_prompt_tokens) AS ctk,
		SUM(usage.cost) AS cost
		FROM usage` + join + ` WHERE 1=1`
	var args []any
	if !from.IsZero() {
		// 瞬时比较(2026-09-10 时区缺陷修复):北京日边界的绝对瞬时(显式 UTC
		// 偏移)作为参数,PG 任何会话时区下语义一致;此前用 ?::date,会话时区
		// 为 UTC 时整窗口偏 8 小时(北京 00:00-08:00 的用量查不到)。
		// 仍只写在分区键 created_at 一侧,不加 AT TIME ZONE 包裹 → 分区裁剪不受影响。
		qstr += " AND usage.created_at >= ?::timestamptz"
		args = append(args, dayStartArg(from))
	}
	if !to.IsZero() {
		// 截止日含当天 → 右边界 = 次日北京 00:00(半开区间)
		qstr += " AND usage.created_at < ?::timestamptz"
		args = append(args, dayEndArgInclusive(to))
	}
	if q.Username != "" {
		qstr += usernameFilter
		args = append(args, q.Username)
	}
	if q.Model != "" {
		qstr += " AND usage.model = ?"
		args = append(args, q.Model)
	}
	if q.Kind != "" {
		qstr += " AND usage.kind = ?"
		args = append(args, q.Kind)
	}
	if q.Dept != "" {
		qstr += deptFilter
		args = append(args, pgInt64Array(deptGroupIDs))
	}
	qstr += " GROUP BY " + groupExpr + " ORDER BY label"
	rows, err := db.Query(qstr, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UsageAggregateRow{}
	for rows.Next() {
		var r UsageAggregateRow
		if err := rows.Scan(&r.Label, &r.PromptTokens, &r.CompletionTokens, &r.Requests, &r.EmbedRequests, &r.EmbedTokens, &r.CacheTokens, &r.Cost); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// 时间分组补零:缺失桶填 0(修复 D1:折线不跨缺日直连)
	if fill != nil && !from.IsZero() && !to.IsZero() {
		byLabel := map[string]UsageAggregateRow{}
		for _, r := range out {
			byLabel[r.Label] = r
		}
		filled := []UsageAggregateRow{}
		for _, bucket := range fill(from, to) {
			if r, ok := byLabel[bucket]; ok {
				filled = append(filled, r)
			} else {
				filled = append(filled, UsageAggregateRow{Label: bucket})
			}
		}
		out = filled
	}
	return out, nil
}

// UserDayUsageCost 返回指定日(按北京时间日界,day 所在的北京日历日)
// 的 tokens 与费用(SUM(cost))。P2-5:此前用服务器本地时区取日界——UTC 容器
// 与北京差 8 小时,「今日/昨日」会整体错位;统一走 BeijingDay(唯一真源,
// 见 beijing.go),不再依赖进程 TZ。边界用绝对瞬时参数(显式 UTC 偏移),
// 也不再依赖 PG 会话时区(2026-09-10 时区缺陷修复)。
func UserDayUsageCost(db *sql.DB, userID int64, day time.Time) (usage int64, cost float64, err error) {
	err = db.QueryRow(`SELECT COALESCE(SUM(prompt_tokens),0) + COALESCE(SUM(completion_tokens),0),
		COALESCE(SUM(cost),0)
		FROM usage WHERE user_id = ? AND created_at >= ?::timestamptz AND created_at < ?::timestamptz`,
		userID, dayStartArg(day), dayEndArgInclusive(day)).Scan(&usage, &cost)
	return usage, cost, err
}

// UserTotalUsageCost 返回用户全历史 tokens 与费用(SUM(cost),无日期过滤)。
func UserTotalUsageCost(db *sql.DB, userID int64) (usage int64, cost float64, err error) {
	err = db.QueryRow(`SELECT COALESCE(SUM(prompt_tokens),0) + COALESCE(SUM(completion_tokens),0),
		COALESCE(SUM(cost),0)
		FROM usage WHERE user_id = ?`, userID).Scan(&usage, &cost)
	return usage, cost, err
}

// UsageSummary 员工用量概览(客户端余额/统计展示的数据源)。
type UsageSummary struct {
	MonthlyUsage   int64   `json:"monthly_usage"`   // 本月 tokens
	MonthlyCost    float64 `json:"monthly_cost"`    // 本月费用(元)
	TodayUsage     int64   `json:"today_usage"`     // 今日 tokens
	TodayCost      float64 `json:"today_cost"`      // 今日费用(元)
	YesterdayUsage int64   `json:"yesterday_usage"` // 昨日 tokens
	YesterdayCost  float64 `json:"yesterday_cost"`  // 昨日费用(元)
	TotalUsage     int64   `json:"total_usage"`     // 历史总 tokens
	TotalCost      float64 `json:"total_cost"`      // 历史总费用(元)
}

// UserUsageSummary 一次取齐员工用量概览(月度/今日/昨日/总计)。
// 月度复用 UserMonthlyUsage/UserMonthlyCost(与配额判定同一口径);
// 今日/昨日/总计各一条聚合 SQL,量级为 O(user 行数,走 idx_usage_user_time)。
func UserUsageSummary(db *sql.DB, userID int64) (*UsageSummary, error) {
	now := time.Now()
	s := &UsageSummary{}
	var err error
	if s.MonthlyUsage, err = UserMonthlyUsage(db, userID); err != nil {
		return nil, err
	}
	if s.MonthlyCost, err = UserMonthlyCost(db, userID); err != nil {
		return nil, err
	}
	if s.TodayUsage, s.TodayCost, err = UserDayUsageCost(db, userID, now); err != nil {
		return nil, err
	}
	if s.YesterdayUsage, s.YesterdayCost, err = UserDayUsageCost(db, userID, now.AddDate(0, 0, -1)); err != nil {
		return nil, err
	}
	if s.TotalUsage, s.TotalCost, err = UserTotalUsageCost(db, userID); err != nil {
		return nil, err
	}
	return s, nil
}
