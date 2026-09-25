package main

// `--opens-rollup-repair-plan` 的判据（R20A-S-02，审计 2026-09-25）。
//
// 三条：
//
//	① **时区来自部署 TZ 的唯一真源**（DST 形态下也要对）——硬编码 Asia/Shanghai 必红；
//	② **窗口右端开区间 + 按本地日解释**（`TO` 省略 = 今天）；
//	③ **输出里带执行纪律**（先离线副本、先备份、覆盖方向取较大值）——这些纪律是
//	   R19B-01 回滚过的坑，少一条就可能被照着 SQL 抄跑成"累加/无条件覆盖"。

import (
	"strings"
	"testing"
	"time"
)

// TestPrintOpensRollupRepairPlanUsesDeploymentZone 是主判据（TZ = 智利，覆盖 DST 缺口形态）。
func TestPrintOpensRollupRepairPlanUsesDeploymentZone(t *testing.T) {
	loc, err := time.LoadLocation("America/Santiago")
	if err != nil {
		t.Skipf("本机没有 America/Santiago 时区数据: %v", err)
	}
	prev := time.Local
	time.Local = loc
	t.Cleanup(func() { time.Local = prev })

	from, to, perr := parseOpensRepairRange("2026-06-01,2026-09-01", time.Now())
	if perr != nil {
		t.Fatalf("解析窗口: %v", perr)
	}
	if got := from.Format("2006-01-02"); got != "2026-06-01" {
		t.Fatalf("FROM 落在 %s, want 2026-06-01（本地日）", got)
	}
	var out strings.Builder
	if err := printOpensRollupRepairPlan(&out, from, to); err != nil {
		t.Fatalf("打印计划: %v", err)
	}
	text := out.String()
	if !strings.Contains(text, "America/Santiago") {
		t.Fatalf("输出里没有部署时区：\n%s", text)
	}
	if strings.Contains(text, "Asia/Shanghai") {
		t.Fatalf("输出里出现硬编码时区 Asia/Shanghai（R20A-S-02 的现场）：\n%s", text)
	}
	for _, needle := range []string{
		"AT TIME ZONE 'America/Santiago'",
		"repair_opens_daily",
		"d.pv < r.pv",      // 覆盖方向：取较大值
		"先在**备份恢复出的副本**上跑", // 执行纪律
		"上线前必须先备份线上库",
	} {
		if !strings.Contains(text, needle) {
			t.Fatalf("输出缺少 %q：\n%s", needle, text)
		}
	}
	// 窗口右端开区间：本地日 2026-08-31 是最后一天，09-01 只是边界。
	if !strings.Contains(text, "2026-06-01 .. 2026-09-01（右端开区间）") {
		t.Fatalf("窗口说明不对：\n%s", text)
	}
}

// TestParseOpensRepairRangeForms 是窗口解析判据（含 fail-closed 面）。
func TestParseOpensRepairRangeForms(t *testing.T) {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Skipf("本机没有 Asia/Shanghai 时区数据: %v", err)
	}
	prev := time.Local
	time.Local = loc
	t.Cleanup(func() { time.Local = prev })
	now := time.Date(2026, 9, 25, 15, 30, 0, 0, loc)

	from, to, err := parseOpensRepairRange("2026-06-01", now)
	if err != nil {
		t.Fatalf("省略 TO: %v", err)
	}
	if got := to.Format("2006-01-02"); got != "2026-09-25" {
		t.Fatalf("省略 TO 时右端 = %s, want 今天（2026-09-25）", got)
	}
	if got := from.Format("2006-01-02"); got != "2026-06-01" {
		t.Fatalf("FROM = %s", got)
	}

	for _, bad := range []string{"", "2026-06-01,2026-06-01", "2026-06-02,2026-06-01",
		"2026/06/01", "2026-06-01,2026-09-01,extra", "not-a-date"} {
		if _, _, err := parseOpensRepairRange(bad, now); err == nil {
			t.Fatalf("非法窗口 %q 必须报错（fail-closed）", bad)
		}
	}
}
