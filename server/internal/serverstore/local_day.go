package serverstore

import "time"

// 本地自然日（`wasm_app_opens.day` / `wasm_app_opens_daily.day` / `opens.today` / 保留期
// 清理边界 / 看板趋势的日序）的**唯一边界实现**。
//
// ## 时区口径（唯一真源，不要在别处再算一遍）
//
// 日分桶按**服务端本地日**（Go 的 `time.Local`，由部署的 TZ 决定），而**不是** UTC 日、
// 也不是数据库会话的 TimeZone。为什么用 Go 而不是 SQL 的 `opened_at::date`：后者取的是
// PG 会话时区（本仓 `pg.go` 把会话固定为 `Asia/Shanghai`），而"应用服务器"与"数据库"
// 是两个容器（compose 里各自继承 TZ）—— 两边不一致时，同一天的明细会落进两个 day 值，
// 且**没有任何报错**。在 Go 侧算好边界再传给 SQL，时区口径就只有一个来源。
//
// ## 为什么"自然日的第一个瞬时"必须专门算（R20A-S-01，P1，不可逆）
//
// 朴素写法 `time.Date(y, m, d, 0, 0, 0, 0, time.Local)` 在**本地零点不存在的日子**
// （DST 缺口：`America/Santiago` 2026-09-06 本地 00:00 → 01:00，同族还有
// `America/Havana`、`Asia/Beirut` 等）会被 Go 归一化到**前一天 23:00**（本机实测：
// `2026-09-05 23:00 -04:00`，其"本地日期"标签是 **09-05**）。于是：
//
//	① 日阶梯上相邻两桶的**起点标签相同**（09-05 那一桶与 09-06 那一桶都写成 day='09-05'）
//	   ⇒ `INSERT … ON CONFLICT (app_id, day, dept_id) DO UPDATE` **后写覆盖前写**
//	   ⇒ 有一天的 PV/UV 被永久算少；
//	② `PurgeWasmAppOpens` 用同一个阶梯当 cutoff ⇒ 被覆盖那天的明细随后又被**硬 DELETE**
//	   ⇒ 少掉的计数在明细与日汇总里**都不存在**（不可逆，与 R19B-01 同族）。
//
// 因此本文件的语义是：
//
//	`LocalDay(t)` = "本地日期 == LocalDayString(t)" 的**第一个瞬时**（下确界）。
//
// 对普通日它就是本地零点；对缺口日它是时钟跳变那一刻（`2026-09-06T04:00Z` = 本地
// 01:00 -03:00）；对重叠日（本地零点出现两次）它是**第一次**零点。这样
// `[LocalDay(d), NextLocalDay(LocalDay(d)))` 恰好等于"本地日期为 d 的全部瞬时"，
// 相邻桶**无缝无重叠**：任何一行明细都属于且只属于一个桶，"整日一起算 / 整日一起删"
// 在 DST 日仍然成立。
//
// ⚠️ 推论（改调用点时最容易踩的一条）：**本地日的"下一天"必须用 `NextLocalDay`，
// 不能用 `day.AddDate(0, 0, 1)`** —— `AddDate` 加的是**墙钟**：从缺口日的边界
// （墙钟 01:00）加一天得到的是次日 01:00，会把次日的一小时算进今天。

// localDayLayout 是 day 键的存储形态（与 `wasm_app_opens_daily.day` 的 `date` 列一致）。
const localDayLayout = "2006-01-02"

// localDayKey 返回 t 的本地日期键（`YYYY-MM-DD`）。
func localDayKey(t time.Time) string { return t.In(time.Local).Format(localDayLayout) }

// LocalDay 返回 t 所在**本地自然日**的第一个瞬时（本地时区）。
//
// 语义与推导见文件头；对普通日 = 本地零点，对 DST 缺口日 = 时钟跳变那一刻，
// 对重叠日 = 第一次零点。恒有 `LocalDay(t) <= t` 且 `LocalDayString(LocalDay(t)) ==
// LocalDayString(t)`。
func LocalDay(t time.Time) time.Time {
	key := localDayKey(t)
	y, m, d := t.In(time.Local).Date()
	candidate := time.Date(y, m, d, 0, 0, 0, 0, time.Local)
	// 快路径（99.99% 的调用）：本地零点存在，且它前一小时已属于前一天
	//   · 缺口日：Go 把不存在的 00:00 归一化到**前一天 23:00** ⇒ candidate 的键不是 key；
	//   · 重叠日：Go 取的是**第一次**零点（本机实测 America/Santiago 2026-04-05），
	//     此时 candidate-1h 已属于前一天 ⇒ 两条判据都成立，直接返回。
	if localDayKey(candidate) == key && localDayKey(candidate.Add(-time.Hour)) != key {
		return candidate
	}
	// 慢路径（每个时区每年 1~2 天）：按"本地日期 == key"这个**唯一判据**二分求下确界。
	// 本地日期相对瞬时单调不减，所以谓词在 [lo, hi] 上是"先假后真"，二分收敛到下确界。
	// 48 小时的窗口足够：任何真实时区的单日长度 ∈ [22h, 26h]，`t-48h` 必然落在更早的日期。
	lo, hi := t.Add(-48*time.Hour), t
	for hi.Sub(lo) > time.Nanosecond {
		mid := lo.Add(hi.Sub(lo) / 2)
		if localDayKey(mid) == key {
			hi = mid
		} else {
			lo = mid
		}
	}
	return hi
}

// LocalDayString 返回本地自然日的 `YYYY-MM-DD`（与 day 列的存储形态一致）。
func LocalDayString(t time.Time) string { return localDayKey(t) }

// NextLocalDay 返回 **t 之后第一个"本地日期发生变化"的瞬时** —— 也就是
// `LocalDay(t)` 那一天的**结束边界**（半开区间的右端）。
//
// 为什么不写 `LocalDay(t).AddDate(0, 0, 1)`：见文件头 ⚠️（墙钟加一天 ≠ 下一个日界）。
func NextLocalDay(t time.Time) time.Time {
	key := localDayKey(t)
	// 本地日期相对瞬时单调不减，而任何真实时区的单日 ≤ 26h ⇒ t+48h 必然已是更晚的日期。
	lo, hi := t, t.Add(48*time.Hour)
	for hi.Sub(lo) > time.Nanosecond {
		mid := lo.Add(hi.Sub(lo) / 2)
		if localDayKey(mid) != key {
			hi = mid
		} else {
			lo = mid
		}
	}
	return hi
}

// AddLocalDays 返回 "t 所在本地日期 + days 天" 的那个本地日的第一个瞬时（days 可为负）。
//
// 日历算术先在**本地正午**上做：正午在真实时区里从不缺口/重叠（跳变幅度 ≤2h 且都在
// 夜里），所以 `AddDate(0,0,days)` 的结果日期就是想要的日历日 —— 再用 `LocalDay` 归一到
// 那个日子的真实边界。直接用 `t.AddDate(0,0,days)` 会在缺口日落到前一天 23:00
// （R20A-S-01 的同一条归一化陷阱），保留期边界因此会漂一天。
func AddLocalDays(t time.Time, days int) time.Time {
	y, m, d := t.In(time.Local).Date()
	noon := time.Date(y, m, d, 12, 0, 0, 0, time.Local).AddDate(0, 0, days)
	ny, nm, nd := noon.Date()
	return LocalDay(time.Date(ny, nm, nd, 12, 0, 0, 0, time.Local))
}
