package serverstore

import (
	"fmt"
	"strings"
	"time"
)

// opens 日汇总的**离线修复计划**（R19B-01 的历史坏行；R20A-S-02，审计 2026-09-25）。
//
// ## 为什么要有一份"随包"的计划
//
// R19B-01（保留期边界未对齐本地日）在修复前会持续破坏 `wasm_app_opens_daily`：边界那
// 一天被"剩下的半天"重算覆盖，而明细随后被硬删 ⇒ 那一天在明细与日汇总里都不存在。
// 代码修复只能止血（不再产生新坏行），**补历史**必须在离线副本上重算再覆盖上线。
//
// 而第十九轮报告里给出的那段修复 SQL 把时区**硬编码**成 `AT TIME ZONE 'Asia/Shanghai'` ——
// 与线上分桶口径（Go 的 `time.Local`，由部署 TZ 决定，见 `local_day.go` 的文件头）
// 只是"部署缺省相同时恰好等价"。运维把 TZ 改成别的时区后照抄那段 SQL，会写出
// **day 键与线上不一致**的汇总行（比不修更糟：数字看着补上了，日期却错位）。
//
// 因此这里把计划变成一个**可评审、可测试、时区来自唯一真源**的产物：
//
//	zone  ← {@link resolveLocalZoneName}（与 LocalDay 同一个来源；解不出 ⇒ 报错，不回落）
//	窗口  ← {@link LocalDay} / {@link NextLocalDay}（Go 侧算好的日边界，直接内联成字面量）
//	day 键 ← `(opened_at AT TIME ZONE <zone>)::date`（与 `LocalDayString` 同为"日历日标签"）
//
// ## 三条纪律（写进计划本身，执行前必须先读）
//
//  1. **方向是"取较大值覆盖"**（`d.pv < r.pv`）：线上汇总在修复后仍会被正常维护，
//     累加会翻倍，无条件覆盖会把修复后新算的更准的值盖回旧值；
//  2. **只覆盖"备份里仍有明细"的那些天**：备份时点之前就已过期的天，其明细在备份里
//     也不存在（修不了，如实留空）；
//  3. **先备份线上库 + 审计留痕**：本计划只**生成 SQL**，不执行任何写（调用方自己
//     决定在哪台机器上跑）。
type OpensDailyRebuildPlan struct {
	// Zone 是 `AT TIME ZONE` 用的时区名（部署 TZ 的唯一真源解出来的 IANA 名）。
	Zone string
	// From / To 是重建窗口的半开区间 [From, To)（Go 侧算好的本地日边界）。
	From time.Time
	To   time.Time
	// RebuildSQL 在**离线副本**上执行：把窗口内的明细按整日重算进 repair_opens_daily。
	RebuildSQL string
	// ApplySQL 在**上线库**上执行：只把"明显偏小"的天覆盖回正确值。
	ApplySQL string
	// Notes 是执行顺序与前提（照抄进变更单即可）。
	Notes []string
}

// repairTable 是离线副本里的中转表名（固定值，便于审计脚本核对）。
const repairTable = "repair_opens_daily"

// BuildOpensDailyRebuildPlan 生成"从明细重建 opens 日汇总"的离线修复计划。
//
// 只生成、不执行：返回的 `RebuildSQL` 用于离线副本，`ApplySQL` 用于上线库。
// `from`/`to` 是**任意时刻**，函数按本地自然日归一（含 DST 缺口日 —— 边界走
// `LocalDay`/`NextLocalDay`，不是 `AddDate`）。窗口右端**开区间**：`to` 所在那一天
// 不计入（要覆盖到某天就传它的下一天）。
//
// 时区解不出 IANA 名 ⇒ 返回错误（fail-closed：宁可让运维先修 TZ，也不要写出错位的
// day 键）。SQL 文本里只出现**已校验过**的时区名与 Go 格式化出来的日期/瞬时字面量。
func BuildOpensDailyRebuildPlan(from, to time.Time) (OpensDailyRebuildPlan, error) {
	zone, err := resolveLocalZoneName()
	if err != nil {
		return OpensDailyRebuildPlan{}, fmt.Errorf("生成 opens 日汇总修复计划: %w（修复口径必须与线上分桶同源："+
			"day 键来自 Go 的 time.Local，所以 TZ 必须是 PG 也认识的 IANA 名）", err)
	}
	start, end := LocalDay(from), LocalDay(to)
	if !end.After(start) {
		return OpensDailyRebuildPlan{}, fmt.Errorf("生成 opens 日汇总修复计划: 空窗口（from=%s to=%s）",
			LocalDayString(from), LocalDayString(to))
	}
	// 时区名进 SQL 文本前再挡一道：只允许 IANA 名的字符集（`zoneNameForSQL` 已用
	// time.LoadLocation 复核过语义，这里是防注入的最后一道）。
	if !safeZoneLiteral(zone) {
		return OpensDailyRebuildPlan{}, fmt.Errorf("生成 opens 日汇总修复计划: 时区名 %q 含非法字符", zone)
	}
	startDay, endDay := LocalDayString(start), LocalDayString(end)
	rebuild := fmt.Sprintf(`-- ① 离线副本：把窗口内的明细按**整日**重算（不动线上任何表）
CREATE TABLE IF NOT EXISTS %[1]s (
    app_id text NOT NULL, day date NOT NULL, dept_id bigint NOT NULL,
    pv bigint NOT NULL, uv bigint NOT NULL, PRIMARY KEY (app_id, day, dept_id));
DELETE FROM %[1]s WHERE day >= DATE '%[3]s' AND day < DATE '%[4]s';
INSERT INTO %[1]s (app_id, day, dept_id, pv, uv)
SELECT app_id,
       (opened_at AT TIME ZONE '%[2]s')::date AS day,
       COALESCE(dept_id, 0) AS dept_id,
       count(*) AS pv,
       count(DISTINCT user_id) AS uv
  FROM wasm_app_opens
 WHERE opened_at >= TIMESTAMPTZ '%[5]s' AND opened_at < TIMESTAMPTZ '%[6]s'
 GROUP BY 1, 2, 3;`,
		repairTable, zone, startDay, endDay, instantLiteral(start), instantLiteral(end))
	apply := fmt.Sprintf(`-- ② 上线库：只覆盖"明显偏小"的天（方向 = 取较大值；累加会翻倍）
UPDATE wasm_app_opens_daily d
   SET pv = r.pv, uv = r.uv, updated_at = now()
  FROM %[1]s r
 WHERE d.app_id = r.app_id AND d.day = r.day AND d.dept_id = r.dept_id
   AND d.pv < r.pv;`, repairTable)
	return OpensDailyRebuildPlan{
		Zone: zone, From: start, To: end,
		RebuildSQL: rebuild, ApplySQL: apply,
		Notes: []string{
			"窗口 = [" + start.Format(time.RFC3339) + ", " + end.Format(time.RFC3339) + ")（本地日边界；" +
				"DST 缺口日取该日第一个存在的瞬时），day 键 = opened_at AT TIME ZONE '" + zone + "'（与线上 LocalDayString 同源）",
			"先在**备份恢复出的副本**上跑 RebuildSQL（" + repairTable + " 只存在于副本）",
			"上线前必须先备份线上库，并记录覆盖天数与影响行数（审计动作 wasm_opens_rollup_repair）",
			"ApplySQL 只覆盖 pv 变大的天：线上汇总在修复后仍会被正常维护，覆盖方向反了会丢新值",
			"只覆盖「备份里仍有明细」的天：备份时点之前就已过期的天无法重算（明细是 UV 的唯一来源）",
		},
	}, nil
}

// instantLiteral 把瞬时格式化成 SQL 里可读且无歧义的 TIMESTAMPTZ 字面量（UTC，RFC3339）。
func instantLiteral(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// safeZoneLiteral 校验时区名只含 IANA 名允许的字符（防注入；语义已由 zoneNameForSQL 复核）。
func safeZoneLiteral(zone string) bool {
	if zone == "" || len(zone) > 64 {
		return false
	}
	if strings.Contains(zone, "..") || strings.HasPrefix(zone, "/") {
		return false
	}
	for _, r := range zone {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		case r == '/' || r == '_' || r == '-' || r == '+':
		default:
			return false
		}
	}
	return true
}
