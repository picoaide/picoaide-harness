package serverstore

import "time"

// ---------------------------------------------------------------------------
// 「北京日/月」口径唯一真源(2026-09-10 修复时区依赖缺陷)。
//
// 产品里所有「日窗口 / 月窗口」都必须经本文件计算,不得再出现第二套口径
// (用户日用量、概览、聚合 from/to、保留期 cutoff、请求明细、月度配额窗口…)。
// 三条硬约束:
//
//  1. 不依赖**进程 TZ**(TZ 环境变量 / 容器时区):CI(UTC 容器)与 compose
//     (TZ=Asia/Shanghai)必须得到同一结果 —— 一律固定 +8h,绝不用 time.Local;
//  2. 不依赖 **PG 会话时区**:与 created_at(timestamptz)的范围比较一律用
//     「绝对瞬时」参数(带显式 +00:00 偏移的字符串),而不是裸日期/裸墙钟
//     字符串 —— `?::date` 与 '2026-09-01 00:00:00' 都按**会话时区**解析,
//     PG 为 UTC 与 Asia/Shanghai 时"日窗口"相差 8 小时(2026-09-10 CI 实测:
//     北京 00:03 的 tag 流水线全量用量聚合返回空);
//  3. 不依赖 tzdata:Asia/Shanghai 自 1991 年起恒为 UTC+8(无 DST),固定偏移
//     与 `AT TIME ZONE 'Asia/Shanghai'` 等价,但不需要时区数据库。
//
// 两种时间表示(全仓沿用,转换见下):
//   - 「北京日期值」= Location 为 UTC、年月日分量是**北京**日历日的 time.Time
//     (BeijingDay/BeijingMonth 的产物,time.Parse("2006-01-02") 亦同)。它是
//     from/to/day 参数与补零桶标签的表示约定,不是真实时刻。
//   - 「绝对瞬时」= 真实时刻(created_at、写库夹具、查询边界参数)。
//
// 二者互转:
//
//	北京日期值 --BeijingDayInstant--> 绝对瞬时(该北京日 00:00)
//	绝对瞬时   --BeijingDay---------> 北京日期值(所在北京日)
//
// 注意:分区裁剪要求范围谓词直接写在分区键 created_at 上(禁止
// `created_at AT TIME ZONE …` 包裹),所以瞬时参数走 `?::timestamptz` 而不是
// 对列做转换 —— 见 dialect.go 的说明。
// ---------------------------------------------------------------------------

const (
	// BeijingOffset 是产品口径的固定偏移(UTC+8)。
	BeijingOffset = 8 * time.Hour

	// pgInstantFmt 是**会话时区无关**的瞬时字面量格式:显式 +00:00 偏移,PG
	// 在任何 TimeZone 下都解析为同一瞬时。
	pgInstantFmt = "2006-01-02 15:04:05+00:00"

	// dateFmt 是日期字面量格式(与 DATE 列/::date 参数配合,无时区语义)。
	dateFmt = "2006-01-02"
)

// BeijingDay 返回 t 所在北京日历日 00:00 的北京日期值(见文件头约定)。
func BeijingDay(t time.Time) time.Time {
	bj := t.UTC().Add(BeijingOffset)
	return time.Date(bj.Year(), bj.Month(), bj.Day(), 0, 0, 0, 0, time.UTC)
}

// BeijingMonth 返回 t 所在北京日历月 1 日 00:00 的北京日期值。
func BeijingMonth(t time.Time) time.Time {
	d := BeijingDay(t)
	return time.Date(d.Year(), d.Month(), 1, 0, 0, 0, 0, time.UTC)
}

// BeijingDayInstant 返回北京日期值 d 当天 00:00 的**绝对瞬时**。
func BeijingDayInstant(d time.Time) time.Time {
	return BeijingDay(d).Add(-BeijingOffset)
}

// BeijingMonthInstant 返回北京日期值 d 所在月 1 日 00:00 的绝对瞬时。
func BeijingMonthInstant(d time.Time) time.Time {
	return BeijingMonth(d).Add(-BeijingOffset)
}

// BeijingNow 返回当前时刻的北京日期值(等价北京时区的"今天")。
func BeijingNow() time.Time { return BeijingDay(time.Now()) }

// RetentionWindowStart 返回"保留窗口起点"的**唯一实现**（R13-GE · R13A-02）：
// 从 now 起回溯 months 个**北京月**的月初。
//
// 为什么必须先归一到月初再 AddDate（这条是缺陷本体）：
// Go 的 `time.Time.AddDate` 与 `time.Date` 一样会**归一化**（官方文档原文
// "AddDate normalizes its result in the same way that Date does"）。于是
// `BeijingDay(2026-08-31).AddDate(0, -6, 0)` = 2026-02-31 → 归一化成
// **2026-03-03**；下游 `dayKey()` 把起点截到月初 ⇒ 整个 **2026-02 月**从窗口里
// 消失，而它此刻仍在保留期内（cutoff = 2026-02，回收只删 < cutoff 的月）。
// 后果：进程恰好在"目标月没有该日"的那几天（3/5/7/10/12 月 31 日 + 8 月
// 29/30/31 日，≈10 天/年）启动时，保留期内**最早一个月**的日账/月账洞不会被
// 本轮或后续任何清理轮修补 —— 一旦明细后来被回收，报表静默少计那个月。
//
// 同族三处（usage_ledger.go 的补账窗口、usage_retention_status.go 的到期推导、
// usage.go 的 monthFill）早已先归一到月初；这一处是唯一漏掉的（"同族只收口了一条"
// 的又一实例）。判据见 audit_r13ge_calendar_test.go 的 21 个 (年,月,日,N) 组合。
func RetentionWindowStart(now time.Time, months int) time.Time {
	if months < 0 {
		months = 0
	}
	// 先归一到月初 ⇒ AddDate 的目标月**一定存在该日**（1 日），不会溢出。
	return BeijingMonth(now).AddDate(0, -months, 0)
}

// BeijingDayAt 返回北京日期值 d 当天 hour:00 的绝对瞬时(夹具/边界构造用)。
func BeijingDayAt(d time.Time, hour int) time.Time {
	return BeijingDayInstant(d).Add(time.Duration(hour) * time.Hour)
}

// pgInstantArg 把绝对瞬时渲染成会话时区无关的 SQL 参数(显式 UTC 偏移)。
func pgInstantArg(t time.Time) string { return t.UTC().Format(pgInstantFmt) }

// dayStartArg 返回 t 所在北京日 00:00 的瞬时参数(半开区间左边界)。
func dayStartArg(t time.Time) string { return pgInstantArg(BeijingDayInstant(t)) }

// dayEndArgInclusive 返回"截止日含当天"的半开区间右边界瞬时参数
// (北京日 to 的次日 00:00)。
func dayEndArgInclusive(to time.Time) string {
	return pgInstantArg(BeijingDayInstant(to.AddDate(0, 0, 1)))
}

// normalizeDayRange 把调用方的 from/to 归一到北京日期值(允许传入瞬时,
// 如 time.Now()):所有日/月窗口入口统一先归一,避免"本机日期"混入。
func normalizeDayRange(from, to time.Time) (time.Time, time.Time) {
	if !from.IsZero() {
		from = BeijingDay(from)
	}
	if !to.IsZero() {
		to = BeijingDay(to)
	}
	return from, to
}
