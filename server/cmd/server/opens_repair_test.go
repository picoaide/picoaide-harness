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

	"github.com/picoaide/picoaide/internal/serverstore"
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

// TestParseRepairDayUsesLocalDayOnDSTGap 是 R21F-02（审计 2026-09-26，P2）的判据。
//
// 缺陷形态：`parseRepairDay` 曾是 `time.ParseInLocation("2006-01-02", text, time.Local)`
// + `serverstore.LocalDay(...)`。在 **DST 缺口日**（本地零点不存在，如
// `America/Santiago` 2026-09-06）Go 会把 `00:00` 归一化到**前一天 23:00**
// ⇒ `LocalDay` 得到的是**前一天**的日界。因为 `TO` 是**右端开区间**，点名缺口日时：
//
//	"2026-09-05,2026-09-06" ⇒ 两端都落到 09-05 的日界 ⇒ 报"窗口为空"（本该是一天）；
//	"2026-09-06,2026-09-07" ⇒ 窗口变成 [09-05, 09-07)（多算一天，而运维要的是两天）。
//
// 判据四条（缺一条都测不到"日界与线上日汇总同源"）：
//
//	① 缺口日解析结果 == 该本地日的**第一个瞬时**（时钟跳变那一刻，04:00Z）；
//	② `LocalDayString` 键 == 请求的日历日（与 `wasm_app_opens_daily.day` 同一算法）；
//	③ 窗口两端都取自该口径（缺口日当 FROM / 当 TO 都要对，含右端开区间语义）；
//	④ 打印出的两段 SQL 的日界字面量与①②③同源（R20A-S-02 的时区口径不许被这次改动碰坏）。
func TestParseRepairDayUsesLocalDayOnDSTGap(t *testing.T) {
	loc, err := time.LoadLocation("America/Santiago")
	if err != nil {
		t.Skipf("本机没有 America/Santiago 时区数据: %v", err)
	}
	prev := time.Local
	time.Local = loc
	t.Cleanup(func() { time.Local = prev })

	// 自校准（本仓纪律：判据依赖 tzdata 时先证明自己在这个环境里咬得到，
	// 打不中只跳过、不假红）：本机 tzdata 的 2026-09-06 真的没有本地零点吗？
	naive := time.Date(2026, 9, 6, 0, 0, 0, 0, loc)
	if serverstore.LocalDayString(naive) == "2026-09-06" {
		t.Skipf("本机 tzdata 的 Santiago 2026-09-06 没有零点缺口（朴素写法已是 00:00），判据在本环境咬不到")
	}

	// ① 缺口日 = 该日第一个存在的瞬时 = 本地 01:00 -03:00 = 2026-09-06T04:00:00Z。
	//    旧实现给的是 2026-09-05T04:00:00Z（本地日 09-05 的日界）。
	got, perr := parseRepairDay("2026-09-06")
	if perr != nil {
		t.Fatalf("解析缺口日: %v", perr)
	}
	wantGap := time.Date(2026, 9, 6, 4, 0, 0, 0, time.UTC)
	if !got.Equal(wantGap) {
		t.Fatalf("缺口日 2026-09-06 的日界 = %s (UTC %s), want %s —— "+
			"缺口日的边界必须是该本地日的第一个瞬时（ParseInLocation 会把不存在的 00:00 归一化到前一天 23:00）",
			got.Format(time.RFC3339), got.UTC().Format(time.RFC3339), wantGap.Format(time.RFC3339))
	}
	// ② 键必须等于请求的日历日（这就是线上 day 键的算法：LocalDayString）。
	if key := serverstore.LocalDayString(got); key != "2026-09-06" {
		t.Fatalf("缺口日日界的键 = %s, want 2026-09-06（窗口端点必须与线上日汇总同源）", key)
	}
	// ③a 缺口日当 FROM：窗口左端就是它，且能构成非空窗口（旧实现在这里报"窗口为空"）。
	from, to, rerr := parseOpensRepairRange("2026-09-06,2026-09-07", time.Now())
	if rerr != nil {
		t.Fatalf("缺口日当 FROM 的窗口必须成立（旧实现在此报窗口为空）: %v", rerr)
	}
	if !from.Equal(wantGap) {
		t.Fatalf("FROM = %s, want %s（缺口日日界）", from.Format(time.RFC3339), wantGap.Format(time.RFC3339))
	}
	// ③b 次日的日界（已过夜）：本地 00:00 -03:00 = 03:00Z。
	wantNext := time.Date(2026, 9, 7, 3, 0, 0, 0, time.UTC)
	if !to.Equal(wantNext) {
		t.Fatalf("TO = %s, want %s（次日本地零点）", to.Format(time.RFC3339), wantNext.Format(time.RFC3339))
	}
	// ③c 窗口 [09-06 日界, 09-07 日界) 恰好覆盖缺口日这一天 = 23h（不是 24h）。
	if d := to.Sub(from); d != 23*time.Hour {
		t.Fatalf("窗口长度 = %v, want 23h（缺口日只有 23 小时；多了/少了都说明端点不是日界）", d)
	}
	// ③d 缺口日当 TO（右端开区间）：09-05..09-06 必须恰好是 09-05 一整天。
	f2, t2, rerr2 := parseOpensRepairRange("2026-09-05,2026-09-06", time.Now())
	if rerr2 != nil {
		t.Fatalf("09-05..09-06 窗口必须成立（右端开区间 = 只覆盖 09-05 一天）: %v", rerr2)
	}
	if want := time.Date(2026, 9, 5, 4, 0, 0, 0, time.UTC); !f2.Equal(want) {
		t.Fatalf("FROM = %s, want %s", f2.Format(time.RFC3339), want.Format(time.RFC3339))
	}
	if !t2.Equal(wantGap) {
		t.Fatalf("TO = %s, want %s（缺口日日界；右端开区间）", t2.Format(time.RFC3339), wantGap.Format(time.RFC3339))
	}

	// ④ 打印出去的两段 SQL 的日界必须与上面同源（R20A-S-02 的修复点：day 键与窗口
	//    都来自部署 TZ 的唯一真源，硬编码/本地墙钟都会在这里露出）。
	var out strings.Builder
	if err := printOpensRollupRepairPlan(&out, from, to); err != nil {
		t.Fatalf("打印计划: %v", err)
	}
	text := out.String()
	for _, needle := range []string{
		"AT TIME ZONE 'America/Santiago'",
		"DATE '2026-09-06' AND day < DATE '2026-09-07'", // 日汇总 day 键的窗口（整日语义）
		"TIMESTAMPTZ '2026-09-06T04:00:00Z'",            // 明细窗口左端 = 缺口日日界
		"TIMESTAMPTZ '2026-09-07T03:00:00Z'",            // 明细窗口右端 = 次日本地零点
		"2026-09-06 .. 2026-09-07（右端开区间）",               // 人可读窗口说明
	} {
		if !strings.Contains(text, needle) {
			t.Fatalf("修复计划的输出缺少 %q（日界必须与 LocalDay 同源）：\n%s", needle, text)
		}
	}
}
