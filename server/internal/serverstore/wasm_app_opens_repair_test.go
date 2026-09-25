package serverstore

import (
	"strings"
	"testing"
	"time"
)

// R20A-S-02（审计 2026-09-25，P2，「S-01 族」）的判据：
// opens 日汇总的**离线修复计划**必须与线上分桶口径**同源**，不得硬编码时区。
//
// 现场：第十九轮报告里的修复 SQL 写死 `AT TIME ZONE 'Asia/Shanghai'`。部署 TZ 就是
// Asia/Shanghai 时恰好等价，换成别的时区照抄就会写出 day 键错位的汇总行 —— 而这条
// 路径的产物是"长期保留、明细已删"的汇总，写错不可逆。
//
// 三条判据（每条都能被单独变异点红）：
//
//	① **时区来自唯一真源**：SQL 里的 `AT TIME ZONE '<zone>'` 必须等于
//	   `resolveLocalZoneName()`（= 与 `LocalDay` 同源的那个名字），且**不等于**硬编码值；
//	② **窗口边界是本地日边界**：DST 缺口日的窗口起点 = 该日第一个存在的瞬时
//	   （不是 `AddDate` 得到的墙钟偏移值）；
//	③ **解不出时区名 ⇒ fail-closed**（报错而不是回落 UTC 写错 day 键）。
func TestOpensDailyRebuildPlanUsesDeploymentZone(t *testing.T) {
	loc := mustLoad(t, "America/Santiago")
	withLocal(t, loc)

	// 窗口取"智利春令缺口日"那一周（09-05 .. 09-08），起点/终点都由日边界归一。
	from := time.Date(2026, 9, 5, 13, 0, 0, 0, loc)
	to := time.Date(2026, 9, 8, 3, 0, 0, 0, loc)
	plan, err := BuildOpensDailyRebuildPlan(from, to)
	if err != nil {
		t.Fatalf("生成修复计划: %v", err)
	}
	// ① 时区 = 唯一真源（解出来的那个名字），不是硬编码的 Asia/Shanghai。
	if plan.Zone != "America/Santiago" {
		t.Fatalf("计划的时区 = %q, want America/Santiago（必须来自部署 TZ）", plan.Zone)
	}
	if !strings.Contains(plan.RebuildSQL, "AT TIME ZONE 'America/Santiago'") {
		t.Fatalf("修复 SQL 没有用部署时区分日：\n%s", plan.RebuildSQL)
	}
	for _, banned := range []string{"Asia/Shanghai", "UTC'"} {
		if strings.Contains(plan.RebuildSQL, banned) {
			t.Fatalf("修复 SQL 里出现了硬编码时区 %q（这正是 R20A-S-02 的现场）：\n%s", banned, plan.RebuildSQL)
		}
	}
	// ② 窗口边界 = 本地日边界：起点是 09-05 的日边界、终点是 09-08 的日边界（开区间）。
	if got := LocalDayString(plan.From); got != "2026-09-05" {
		t.Fatalf("窗口起点落在 %s, want 2026-09-05", got)
	}
	if got := LocalDayString(plan.To); got != "2026-09-08" {
		t.Fatalf("窗口终点落在 %s, want 2026-09-08（右端开区间）", got)
	}
	if h, m, s := plan.From.In(loc).Clock(); h != 0 || m != 0 || s != 0 {
		t.Fatalf("窗口起点不是本地零点：%02d:%02d:%02d", h, m, s)
	}
	// 缺口日必须落在这个窗口里，且它的日边界是"该日第一个存在的瞬时"（本地 01:00）。
	gap := LocalDay(time.Date(2026, 9, 6, 12, 0, 0, 0, loc))
	if gap.Before(plan.From) || !gap.Before(plan.To) {
		t.Fatalf("缺口日 %s 不在窗口内（判据没覆盖 DST 形态）", LocalDayString(gap))
	}
	if plan.From.Equal(gap) {
		t.Fatalf("窗口起点恰好等于缺口日 —— 用例应覆盖缺口日**之前**的日边界")
	}
	// ③ SQL 内联的是 Go 算好的瞬时字面量（不再是 `AT TIME ZONE` 比较窗口），
	//    并且与 plan.From/To 逐字一致（可复核、可复跑）。
	if !strings.Contains(plan.RebuildSQL, instantLiteral(plan.From)) ||
		!strings.Contains(plan.RebuildSQL, instantLiteral(plan.To)) {
		t.Fatalf("修复 SQL 的 WHERE 窗口与计划里的日边界不一致：\n%s", plan.RebuildSQL)
	}
	// 覆盖方向必须"取较大值"（累加会翻倍、无条件覆盖会丢新值）。
	if !strings.Contains(plan.ApplySQL, "d.pv < r.pv") {
		t.Fatalf("上线的覆盖方向不对（必须只覆盖更大值）：\n%s", plan.ApplySQL)
	}
	if len(plan.Notes) == 0 {
		t.Fatalf("计划必须带执行纪律（备份/审计/覆盖方向）")
	}
}

// TestOpensDailyRebuildPlanRefusesWhenZoneUnresolvable：解不出 IANA 名 ⇒ 报错（fail-closed）。
//
// 为什么这条重要：读面（`localZoneName`）在解不出时回落 UTC 并 warn —— 那只是分组显示；
// 写面若也回落 UTC，就会在"本地日 ≠ UTC 日"的部署上写出错位的 day 键（不可逆）。
func TestOpensDailyRebuildPlanRefusesWhenZoneUnresolvable(t *testing.T) {
	prev := time.Local
	// 构造一个"名字不是 IANA 名、也不是 zoneinfo 路径"的 Location：
	// time.FixedZone 的名字就是任意字符串，`zoneNameForSQL` 必然拒绝。
	time.Local = time.FixedZone("CST-8", 8*3600)
	t.Cleanup(func() { time.Local = prev })

	if _, err := BuildOpensDailyRebuildPlan(time.Now().Add(-24*time.Hour), time.Now()); err == nil {
		t.Fatalf("时区名解不出时必须报错（fail-closed），实得 nil")
	} else if !strings.Contains(err.Error(), "IANA") {
		t.Fatalf("报错文案必须点明 IANA 名这条出路，实得：%v", err)
	}
}

// TestSafeZoneLiteralRejectsInjection 是"时区名进 SQL 文本"的最后一道闸门。
func TestSafeZoneLiteralRejectsInjection(t *testing.T) {
	cases := []struct {
		in string
		ok bool
	}{
		{"America/Santiago", true},
		{"Asia/Shanghai", true},
		{"UTC", true},
		{"Etc/GMT+8", true},
		{"America/Argentina/Buenos_Aires", true},
		{"", false},
		{"/etc/passwd", false},
		{"../../etc/passwd", false},
		{"UTC'; DROP TABLE usage; --", false},
		{"UTC\"", false},
		{strings.Repeat("A", 65), false},
	}
	for _, c := range cases {
		if got := safeZoneLiteral(c.in); got != c.ok {
			t.Fatalf("safeZoneLiteral(%q) = %v, want %v", c.in, got, c.ok)
		}
	}
}
