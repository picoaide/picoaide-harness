package main

// `--opens-rollup-repair-plan` 的两种操作模式实现（R20A-S-02，审计 2026-09-25）。
//
// 为什么这个出口在**服务端二进制**上而不是只在文档里：历史坏行（R19B-01，保留期边界
// 未对齐本地日）必须离线重算再覆盖上线，而"离线重算"的分日口径必须与线上**同源**——
// 线上 day 键来自 Go 的 `time.Local`（由部署 TZ 决定，见 serverstore 的 local_day.go）。
// 第十九轮报告里的修复 SQL 把时区硬编码成 `AT TIME ZONE 'Asia/Shanghai'`：部署 TZ 恰好
// 相同时等价，换成别的时区照抄就会写出 **day 键错位** 的汇总行（汇总长期保留、明细已删，
// 写错不可逆）。
//
// 这个模式**纯计算**：不连库、不起 HTTP、不执行任何写 —— 只把 SQL 打到 stdout，由运维
// 拿到离线副本与线上库上分别执行（纪律写在输出的 Notes 里）。

import (
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// parseOpensRepairRange 解析 `--opens-rollup-repair-plan` 的窗口写法。
//
// 形态：`FROM[,TO]`，两个 `YYYY-MM-DD`（按**部署本地日**解释，与 day 键同源）。
// TO 省略 = 今天（右端开区间 ⇒ 覆盖"今天之前"的天）。窗口必须非空。
func parseOpensRepairRange(spec string, now time.Time) (time.Time, time.Time, error) {
	parts := strings.Split(strings.TrimSpace(spec), ",")
	if len(parts) > 2 {
		return time.Time{}, time.Time{}, fmt.Errorf("窗口写法应为 FROM[,TO]（YYYY-MM-DD，TO 右端开区间），实得 %q", spec)
	}
	from, err := parseRepairDay(parts[0])
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("FROM: %w", err)
	}
	to := serverstore.LocalDay(now)
	if len(parts) == 2 && strings.TrimSpace(parts[1]) != "" {
		to, err = parseRepairDay(parts[1])
		if err != nil {
			return time.Time{}, time.Time{}, fmt.Errorf("TO: %w", err)
		}
	}
	if !to.After(from) {
		return time.Time{}, time.Time{}, fmt.Errorf("窗口为空：FROM=%s 不早于 TO=%s（TO 是右端开区间）",
			serverstore.LocalDayString(from), serverstore.LocalDayString(to))
	}
	return from, to, nil
}

// parseRepairDay 按**部署本地日**解析 `YYYY-MM-DD`。
//
// 唯一实现是 `serverstore.ParseLocalDay`（与 `LocalDay`/`LocalDayString` 同一口径）：
//
//   - `time.Parse` 按 UTC 解释墙钟 ⇒ 负偏移部署上日键差一天；
//   - `time.ParseInLocation(…, time.Local)` 在 **DST 缺口日**上同样差一天：本地零点
//     不存在时 Go 会把 `time.Date(y,m,d,0,0,0,0,time.Local)` 归一化到**前一天
//     23:00**（`America/Santiago` 2026-09-06 实测 → 本地日 09-05）。`TO` 是**右端
//     开区间**（见 :28/:46），所以缺口日被点名为 `FROM`/`TO` 时整段修复窗口偏一天
//     —— 而这段窗口决定哪些历史坏行的日汇总被重算（R21F-02，审计 2026-09-26）。
//
// 本函数只保留"空值"这一条本域文案；其余一律原样透出 `ParseLocalDay` 的错误
// （它区分"形态不对"与"本部署时区整日被跳过"，后者是有价值的诊断，不能压成通用文案）。
func parseRepairDay(raw string) (time.Time, error) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return time.Time{}, errors.New("缺少日期（YYYY-MM-DD）")
	}
	day, err := serverstore.ParseLocalDay(text)
	if err != nil {
		return time.Time{}, fmt.Errorf("日期 %q 无法按部署本地日解析: %w", raw, err)
	}
	return day, nil
}

// printOpensRollupRepairPlan 把修复计划打到 w（人可读的头 + 两段 SQL）。
func printOpensRollupRepairPlan(w io.Writer, from, to time.Time) error {
	plan, err := serverstore.BuildOpensDailyRebuildPlan(from, to)
	if err != nil {
		return err
	}
	var b strings.Builder
	b.WriteString("opens 日汇总离线修复计划（R20A-S-02；本模式不连库、不执行任何写）\n")
	fmt.Fprintf(&b, "时区（AT TIME ZONE）：%s（来自部署 TZ 的唯一真源；与线上 LocalDay 同源）\n", plan.Zone)
	fmt.Fprintf(&b, "窗口：[%s, %s)  本地日 %s .. %s（右端开区间）\n\n",
		plan.From.Format(time.RFC3339), plan.To.Format(time.RFC3339),
		serverstore.LocalDayString(plan.From), serverstore.LocalDayString(plan.To))
	b.WriteString("执行纪律（顺序不可换）：\n")
	for i, note := range plan.Notes {
		fmt.Fprintf(&b, "  %d. %s\n", i+1, note)
	}
	b.WriteString("\n")
	b.WriteString(plan.RebuildSQL)
	b.WriteString("\n\n")
	b.WriteString(plan.ApplySQL)
	b.WriteString("\n")
	_, werr := io.WriteString(w, b.String())
	return werr
}
