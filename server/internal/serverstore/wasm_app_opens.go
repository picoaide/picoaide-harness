package serverstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// WASM 应用**打开计数**（F16，0075）的数据访问层。
//
// 设计：docs/planning/2026-09-19-wasm-client-only-design.md §5.1b / §8.9。
// 三张口径必须与迁移 0075 的注释逐字一致（那里是表结构的权威）：
//
//	① 明细 `wasm_app_opens`：一行 = 一次打开（PV 式，不去重），保留 90 天；
//	② 汇总 `wasm_app_opens_daily`：`(app_id, day, dept_id)` 一行，pv/uv，长期保留；
//	③ 部门 = 打开时刻用户的**主部门**（无部门 = 明细 NULL / 汇总 0）。

// WasmAppOpen 是一次打开的写入载荷。
type WasmAppOpen struct {
	AppID string
	// UserID 必填（平台上不存在匿名打开：契约 §8.9「一律登录」）。
	UserID int64
	// DeptID 是打开时刻用户的**主部门**；nil = 无部门（明细记 NULL）。
	DeptID *int64
	// ClientVersion 是客户端自报的**已缓存版本**（open 请求的 current_version）。
	ClientVersion string
	// At 是打开时刻（零值 = now()）。
	At time.Time
}

// wasmClientVersionMaxLen 是 client_version 列的写入长度上限。
//
// 它是客户端自报值（不参与任何判定），但**必须有界**：无界字符串会进明细表并把
// "按版本统计"的报表刷爆。256 已远超任何版本号长度（limits.VersionPattern 的
// 上限是个位数级别）。
const wasmClientVersionMaxLen = 256

// RecordWasmAppOpen 写入一次打开（明细表）。
//
// 返回值只用于诊断（调用方按 §8.9 best-effort 处理：失败只 warn，不影响打开）。
func RecordWasmAppOpen(ctx context.Context, db *sql.DB, rec WasmAppOpen) error {
	appID := strings.ToLower(strings.TrimSpace(rec.AppID))
	if appID == "" || rec.UserID <= 0 {
		return errors.New("serverstore: 打开计数缺少 app_id/user_id")
	}
	at := rec.At
	if at.IsZero() {
		at = time.Now()
	}
	// 分区/保留清理都不依赖这一刻，但显式写 opened_at 让"补记"（离线重放）成为可能，
	// 也让用例能构造确定的历史数据。
	_, err := db.ExecContext(ctx, `INSERT INTO wasm_app_opens (app_id, user_id, dept_id, opened_at, client_version)
		VALUES (?, ?, ?, ?, ?)`,
		appID, rec.UserID, nullableInt64(rec.DeptID), at.UTC(), clipBytes(rec.ClientVersion, wasmClientVersionMaxLen))
	if err != nil {
		return fmt.Errorf("记录应用打开: %w", err)
	}
	return nil
}

// PrimaryDeptID 返回用户的**主部门** id（无部门返回 nil）。
//
// "主部门"的口径与身份投影（appserver.clientFrameUser / session.resolveAppSession）**同源**：
// 按组名排序取第一个。为什么不复用那条 SQL 而另写一条：那条查询把展示名与部门拼在
// 一次往返里（应用请求路径上的热查询），而这里只需要部门 id，且**必须拿到 id**
// （展示路径拿的是名字）—— 两条查询的投影不同，合并只会让热路径多读一列。
//
// 失败返回 nil（计数是 best-effort：拿不到部门就记"无部门"，绝不因此丢掉整次计数）。
func PrimaryDeptID(ctx context.Context, db *sql.DB, userID int64) *int64 {
	var id int64
	err := db.QueryRowContext(ctx, `SELECT g.id FROM user_groups ug JOIN groups g ON g.id = ug.group_id
		WHERE ug.user_id = $1 ORDER BY g.name LIMIT 1`, userID).Scan(&id)
	if err != nil {
		return nil
	}
	return &id
}

// WasmOpenPoint 是日汇总里的一个数据点。
type WasmOpenPoint struct {
	AppID string `json:"app_id"`
	Day   string `json:"day"` // YYYY-MM-DD
	// DeptID = 0 表示"无部门"（与迁移 0075 的哨兵一致）。
	DeptID int64 `json:"dept_id"`
	PV     int64 `json:"pv"`
	UV     int64 `json:"uv"`
}

// LocalDay 返回 t 所在**本地自然日**的零点（本地时区）。
//
// 时区口径（§5.1b 第 3 条 / §8.9，**写死在这里，不要在别处再算一遍**）：
// `wasm_app_opens_daily.day` 与 open 响应里的 `opens.today` 都按**服务端本地日**
// （Go 的 `time.Local`，由部署的 TZ 决定）分桶，而**不是** UTC 日、也不是数据库会话
// 的 TimeZone。为什么用 Go 而不是 SQL 的 `opened_at::date`：后者取的是 PG 会话时区，
// 而"应用服务器"与"数据库"是两个容器（compose 里各自继承 TZ）—— 两边不一致时，
// 同一天的明细会落进两个 day 值，且**没有任何报错**。在 Go 侧算好边界再传给 SQL，
// 时区口径就只有一个来源。
func LocalDay(t time.Time) time.Time {
	y, m, d := t.In(time.Local).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.Local)
}

// LocalDayString 返回本地自然日的 `YYYY-MM-DD`（与 day 列的存储形态一致）。
func LocalDayString(t time.Time) string {
	return t.In(time.Local).Format("2006-01-02")
}

// AggregateWasmAppOpens 把明细**重算**进日汇总（幂等：同一区间重复跑结果相同）。
//
// 三条不变量（R2I-8 点名的"0075 只有 DDL 没有维护者"，这里就是维护者）：
//
//	① **先汇总后清理**：调用方必须先 Aggregate 再 Purge（见 opens.Scheduler）——
//	   先删后汇会让 UV 永久丢失（明细是 UV 的唯一来源）；
//	② 重算是**全量覆盖**（DO UPDATE），不是累加：明细里同一 (app,day,dept) 的
//	   pv/uv 是最终事实，累加会在重复执行时翻倍；
//	③ 部门按**打开时刻**的 dept_id 分桶（明细里已经固定），因此"当天换部门"的
//	   用户会出现在两个部门行里，各算一次 UV —— 这是冻结口径（§8.9）。
//
// 入参 fromDay/toDay 是**任意时刻**：函数按本地自然日把它们归一到日边界，
// 逐日聚合（区间通常只有 2–3 天；清理路径的区间可能更长，但一次性）。
// 逐日而不是一条 `GROUP BY (opened_at AT TIME ZONE …)`：日边界由 LocalDay 给出，
// 时区口径只有一个来源（见 LocalDay 的注释）。
func AggregateWasmAppOpens(ctx context.Context, db *sql.DB, fromDay, toDay time.Time) (int64, error) {
	start, end := LocalDay(fromDay), LocalDay(toDay)
	if end.Before(start) {
		return 0, nil
	}
	var total int64
	for day := start; !day.After(end); day = day.AddDate(0, 0, 1) {
		next := day.AddDate(0, 0, 1)
		res, err := db.ExecContext(ctx, `
			INSERT INTO wasm_app_opens_daily (app_id, day, dept_id, pv, uv, updated_at)
			SELECT app_id,
			       $3::date AS day,
			       COALESCE(dept_id, 0) AS dept_id,
			       count(*) AS pv,
			       count(DISTINCT user_id) AS uv,
			       now()
			  FROM wasm_app_opens
			 WHERE opened_at >= $1 AND opened_at < $2
			 GROUP BY 1, 3
			ON CONFLICT (app_id, day, dept_id) DO UPDATE
			   SET pv = EXCLUDED.pv, uv = EXCLUDED.uv, updated_at = now()`,
			day.UTC(), next.UTC(), LocalDayString(day))
		if err != nil {
			return total, fmt.Errorf("汇总应用打开（day=%s）: %w", LocalDayString(day), err)
		}
		n, _ := res.RowsAffected()
		total += n
	}
	return total, nil
}

// WasmAppOpenToday 返回某应用**今天**（本地日）的 PV/UV，口径与 open 端点回给客户端的
// `opens.today` 完全一致（一次查询、同一张明细表）。
//
// 为什么读**明细**而不是日汇总（§5.1b 第 3/5 条）：
//   - 汇总由定时器每 5 分钟刷一次，**本次调用不在里面** —— 而契约要求
//     "本次调用计数在内"，读汇总会稳定地少 1；
//   - 明细保留 90 天，"今天"的行永远在（不依赖汇总是否跑过）。
//
// 读失败 ⇒ 返回错误，调用方按契约把 `opens` 省略（**不得**回 0 冒充"今天没人打开"）。
func WasmAppOpenToday(ctx context.Context, db *sql.DB, appID string, now time.Time) (pv, uv int64, err error) {
	day := LocalDay(now)
	next := day.AddDate(0, 0, 1)
	err = db.QueryRowContext(ctx, `SELECT count(*), count(DISTINCT user_id) FROM wasm_app_opens
		WHERE app_id = $1 AND opened_at >= $2 AND opened_at < $3`,
		strings.ToLower(strings.TrimSpace(appID)), day.UTC(), next.UTC()).Scan(&pv, &uv)
	if err != nil {
		return 0, 0, fmt.Errorf("查今日打开计数: %w", err)
	}
	return pv, uv, nil
}

// PurgeWasmAppOpens 删除早于 before 的明细行（保留期清理）。
//
// ⚠️ 调用方必须先 AggregateWasmAppOpens（先汇总后清理，见上）。
// 返回删除行数（诊断用）。
func PurgeWasmAppOpens(ctx context.Context, db *sql.DB, before time.Time) (int64, error) {
	res, err := db.ExecContext(ctx, `DELETE FROM wasm_app_opens WHERE opened_at < $1`, before.UTC())
	if err != nil {
		return 0, fmt.Errorf("清理应用打开明细: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// OldestWasmAppOpen 返回明细表里**最早**的一次打开时刻（无行时 ok=false）。
//
// 为什么维护作业需要它：清理之前必须先把"即将被删掉的那一段"汇总完（先汇总后清理）。
// 而"最早一行"就是那一段的起点 —— 用固定窗口（如"保留期前后各一天"）会漏掉
// 停机堆下来的更早数据（实测踩过：100 天前的明细直接消失，日汇总永远是 0）。
func OldestWasmAppOpen(ctx context.Context, db *sql.DB) (time.Time, bool, error) {
	var at sql.NullTime
	if err := db.QueryRowContext(ctx, `SELECT min(opened_at) FROM wasm_app_opens`).Scan(&at); err != nil {
		return time.Time{}, false, fmt.Errorf("查最早打开时刻: %w", err)
	}
	if !at.Valid {
		return time.Time{}, false, nil
	}
	return at.Time.UTC(), true, nil
}

// WasmOpenQuery 是管理端查询的参数（capability:read）。
type WasmOpenQuery struct {
	AppID string
	From  time.Time
	To    time.Time
	// Granularity = "day"（默认）或 "dept"。
	Granularity string
}

// WasmOpenSeries 是管理端出口的响应形状（契约 §8.9 管理端出口③）。
type WasmOpenSeries struct {
	AppID       string          `json:"app_id"`
	From        string          `json:"from"`
	To          string          `json:"to"`
	Granularity string          `json:"granularity"`
	Points      []WasmOpenPoint `json:"points"`
	// TotalPV / TotalUV 是**区间合计**。
	//
	// ⚠️ TotalUV 的语义：按 `(day, dept)` 去重后的**加总**，不等于"区间内去重人数"
	// （跨天/跨部门会重复计数）。区间级去重人数需要回明细表算，而明细只保留 90 天
	// ⇒ 长区间做不到。把口径写进字段名与注释，而不是给一个会随时间变化的数字。
	TotalPV int64 `json:"total_pv"`
	TotalUV int64 `json:"total_uv"`
	// DetailRetentionDays 让调用方知道"区间超过 90 天时明细已不可用"（口径透明）。
	DetailRetentionDays int `json:"detail_retention_days"`
}

// QueryWasmAppOpens 读日汇总（管理端出口）。
//
// 只读汇总表：① 它是长期保留的那一份；② 明细有 90 天窗口，读它会得到一个
// "越久远越少"的序列（看起来像使用量断崖，实际是保留期）——那是最坏的误导。
func QueryWasmAppOpens(ctx context.Context, db *sql.DB, q WasmOpenQuery) (*WasmOpenSeries, error) {
	appID := strings.ToLower(strings.TrimSpace(q.AppID))
	if appID == "" {
		return nil, errors.New("serverstore: 缺少 app_id")
	}
	gran := strings.ToLower(strings.TrimSpace(q.Granularity))
	if gran == "" {
		gran = "day"
	}
	if gran != "day" && gran != "dept" {
		return nil, fmt.Errorf("serverstore: granularity 只支持 day|dept")
	}
	// from/to 按**本地自然日**（与 day 列的写入口径同源，见 LocalDay 的注释）。
	out := &WasmOpenSeries{
		AppID:               appID,
		From:                LocalDayString(q.From),
		To:                  LocalDayString(q.To),
		Granularity:         gran,
		Points:              []WasmOpenPoint{},
		DetailRetentionDays: WasmAppOpensRetentionDays,
	}
	sqlText := `SELECT day::text, dept_id, SUM(pv), SUM(uv) FROM wasm_app_opens_daily
		WHERE app_id = $1 AND day >= $2 AND day <= $3
		GROUP BY 1, 2 ORDER BY 1, 2`
	if gran == "dept" {
		// 按部门聚合：把整段区间的日行按部门合并（趋势看 day、归属看 dept）。
		sqlText = `SELECT '' AS day, dept_id, SUM(pv), SUM(uv) FROM wasm_app_opens_daily
			WHERE app_id = $1 AND day >= $2 AND day <= $3
			GROUP BY 2 ORDER BY 2`
	}
	rows, err := db.QueryContext(ctx, sqlText, appID, out.From, out.To)
	if err != nil {
		return nil, fmt.Errorf("查询应用打开: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var p WasmOpenPoint
		if err := rows.Scan(&p.Day, &p.DeptID, &p.PV, &p.UV); err != nil {
			return nil, err
		}
		p.AppID = appID
		out.Points = append(out.Points, p)
		out.TotalPV += p.PV
		out.TotalUV += p.UV
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// WasmAppOpensRetentionDays 是明细保留天数（迁移 0075 的清理作业按它执行）。
//
// 与 limits 里的平台数值分开：它不是"编译期上限"而是**本能力的保留策略**，
// 且迁移注释、清理作业、管理端响应三处必须同值（这里就是那份唯一真源）。
const WasmAppOpensRetentionDays = 90

// nullableInt64 把 *int64 转成驱动可写的值（nil ⇒ NULL）。
func nullableInt64(v *int64) any {
	if v == nil {
		return nil
	}
	return *v
}

// clipBytes 按**字节**截断（列是 TEXT，但长度口径按字节算，避免多字节字符把行长放大）。
func clipBytes(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	// 截断点回退到 UTF-8 边界，避免写入半个字符（PG 会因非法编码整单失败）。
	cut := max
	for cut > 0 && (s[cut]&0xC0) == 0x80 {
		cut--
	}
	return s[:cut]
}

// usageAppIDMaxLen 是 usage.app_id（0076）的写入长度上限。
//
// 取值 = app_id 的域名标签上限（registry.MaxAppIDLen / limits.MaxAppIDLen = 63）：
// 归因标签就是 app_id 本身，多给一个字节都会让"网关认了、平台不认"的形态存在。
const usageAppIDMaxLen = 63

// usageAppIDRe 是 usage.app_id 允许的字符集。
//
// ⚠️ 它**刻意不是**新的规则真源：app_id 的权威规则在 `wasmapp/registry.CheckAppIDShape`
// （= `limits.AppIDPattern` = `^[a-z0-9]+(?:-[a-z0-9]+)*$` + `MaxAppIDLen`）。这里抄的
// 是**同一条正则 + 同一套长度边界**（RE2 不支持环视，所以不能写成"任意字符 + 前瞻"），
// 存在的唯一理由是依赖方向 —— LLM 网关（核心计费面）不该为了一个归因标签而依赖
// wasm 应用平台包。
//
// 收窄关系由 usage_app_id_test.go 对拍钉住：本函数放行的任何值都必须是 registry 认的
// 合法 app_id 形状（反过来不要求：保留字/纯数字在归因场景无意义）。
// 长度按 min 2 / max 63（与 registry 的 MaxAppIDLen 同源，逐字写在这里供对拍）。
var usageAppIDRe = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

// usageAppIDMinLen / usageAppIDMaxLen 与 registry 的长度边界一致（见上）。
const usageAppIDMinLen = 2

// SanitizeUsageAppID 规范化 `X-Pico-App-Id`（0076 的归因标签）。
//
// 返回空串 = **无归因**（header 缺失/非法），此时 usage.app_id 记空串 ——
// 详见迁移 0076 的注释：归因是 best-effort，绝不影响计费。
func SanitizeUsageAppID(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	if len(s) < usageAppIDMinLen || len(s) > usageAppIDMaxLen || !usageAppIDRe.MatchString(s) {
		return ""
	}
	return s
}

// SetUsageAppID 把**应用维度归因**绑到一行 usage 上（post-hoc，与 SetUsageProvider 同款）。
//
// 为什么用 UPDATE 而不是把 app_id 塞进 INSERT：usage 的写入路径有 4 条（chat /
// anthropic messages / responses / embedding，外加流式的 pending 行），而它们全部
// 已经拿到了行 id；在这些路径上各加一个参数会把计费 SQL 的列集改动 4 次（每次都是
// 一次真实的回归风险），而 UPDATE 只碰一个**不参与计费**的列。
//
// 空标签 ⇒ 直接返回（不写库）：把"没有归因"表示成缺省空串，而不是写一个空 UPDATE。
func SetUsageAppID(db *sql.DB, id int64, appID string) error {
	if id <= 0 {
		return nil
	}
	label := SanitizeUsageAppID(appID)
	if label == "" {
		return nil
	}
	_, err := db.Exec(`UPDATE usage SET app_id = ? WHERE id = ?`, label, id)
	return err
}
