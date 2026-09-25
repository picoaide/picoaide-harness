package serverstore

// R18C-04（审计 2026-09-25，P2，计费口径反转）：峰谷窗口 `weekdays` 的三态被合并成两态 ——
// "键缺省（老数据）"与"显式空数组 / 全非法值"在效果上不可区分，且都等于**每天**。
//
// 计费后果（真金白银）：高峰 = 标准价、空闲 = 标准价 × offpeak_discount(<1)。于是
// "显式声明不选任何星期"（管理员把 7 个星期全部取消勾选，或任何客户端直接 PUT
// `weekdays:[]` / `[0,8]`）会被静默反转成**每天都是高峰** ⇒ 空闲折扣整体丢失。
//
// 修后：写入侧 `ValidatePeakWindows`（+ 管理端 PUT）对"显式空数组 / 全非法"**400 响亮拒绝**；
// 读取侧按字面语义解析 —— 显式空/全非法 ⇒ 该档**不匹配任何天**，不再反转成"每天"。

import (
	"strings"
	"testing"
	"time"
)

// s18Sat 2026-09-26 是星期六（北京时间 10:00）。
func s18Sat() time.Time { return time.Date(2026, 9, 26, 2, 0, 0, 0, time.UTC) }

// s18Mon 2026-09-21 是星期一（北京时间 10:00）。
func s18Mon() time.Time { return time.Date(2026, 9, 21, 2, 0, 0, 0, time.UTC) }

func TestPeakWeekdaysTriStateIsNotCollapsed(t *testing.T) {
	const discount = 0.5
	sat := s18Sat()
	if got := beijingWeekday(sat); got != 6 {
		t.Fatalf("夹具时间不是周六：beijingWeekday=%d", got)
	}

	// ① 键缺省（老数据）= 每天 ⇒ 周六同一时段也是高峰（系数 1）。
	legacy := ParsePeakWindows(`[{"start":"09:00","end":"12:00"}]`)
	if len(legacy) != 1 || !legacy[0].WeekdaysAll {
		t.Fatalf("键缺省必须解析成 WeekdaysAll=true（每天），实得 %+v", legacy)
	}
	if f := offpeakFactor(sat, discount, legacy); f != 1 {
		t.Fatalf("键缺省（老数据 = 每天）周六系数 = %v, want 1", f)
	}

	// ② 显式空数组：字面语义 = 一天都不选 ⇒ **该档不生效**，空闲折扣照旧（系数 0.5）。
	empty := ParsePeakWindows(`[{"start":"09:00","end":"12:00","weekdays":[]}]`)
	if len(empty) != 1 || empty[0].WeekdaysAll || len(empty[0].Weekdays) != 0 {
		t.Fatalf("显式空数组的解析形状变了：%+v", empty)
	}
	if f := offpeakFactor(sat, discount, empty); f != discount {
		t.Fatalf("显式空数组周六系数 = %v, want %v —— 修前被反转成 1（每天都是高峰,折扣整体丢失）",
			f, discount)
	}

	// ③ 全非法值：与显式空数组同样按"该档不生效"处置（不再被静默放大成"每天"）。
	bad := ParsePeakWindows(`[{"start":"09:00","end":"12:00","weekdays":[0,8]}]`)
	if len(bad) != 1 || bad[0].WeekdaysAll || len(bad[0].Weekdays) != 0 {
		t.Fatalf("全非法 weekdays 的解析形状变了：%+v", bad)
	}
	if f := offpeakFactor(sat, discount, bad); f != discount {
		t.Fatalf("全非法 weekdays 周六系数 = %v, want %v（修前 = 1）", f, discount)
	}

	// ④ 显式合法列表：只在这些天生效 —— 周六空闲（0.5）、周一高峰（1）。
	weekdayOnly := ParsePeakWindows(`[{"start":"09:00","end":"12:00","weekdays":[1,2,3,4,5]}]`)
	if f := offpeakFactor(sat, discount, weekdayOnly); f != discount {
		t.Fatalf("周一至周五配置的周六系数 = %v, want %v", f, discount)
	}
	if f := offpeakFactor(s18Mon(), discount, weekdayOnly); f != 1 {
		t.Fatalf("周一系数 = %v, want 1（显式列表里的星期必须仍然算高峰）", f)
	}

	// ⑤ 部分非法：保留合法项（只剩周一），不再整份丢弃。
	partial := ParsePeakWindows(`[{"start":"09:00","end":"12:00","weekdays":[1,8]}]`)
	if len(partial) != 1 || len(partial[0].Weekdays) != 1 || partial[0].Weekdays[0] != 1 {
		t.Fatalf("部分非法的解析形状变了：%+v", partial)
	}
	if f := offpeakFactor(s18Mon(), discount, partial); f != 1 {
		t.Fatalf("部分非法（保留周一）的周一系数 = %v, want 1", f)
	}

	// ⑥ `weekdays: null` 视同缺省（每天）。
	nulled := ParsePeakWindows(`[{"start":"09:00","end":"12:00","weekdays":null}]`)
	if len(nulled) != 1 || !nulled[0].WeekdaysAll {
		t.Fatalf("weekdays:null 必须视同缺省（每天），实得 %+v", nulled)
	}
}

// TestValidatePeakWindowsRejectsEmptyAndInvalidWeekdays 钉写入侧的响亮失败：
// 显式空数组与全非法（以及部分非法、坏时间、坏 JSON）一律拒绝；合法的三种形态放行。
func TestValidatePeakWindowsRejectsEmptyAndInvalidWeekdays(t *testing.T) {
	legal := []string{
		``, // 清空峰谷配置（与历史行为逐字一致）
		`[]`,
		`[{"start":"09:00","end":"12:00"}]`,
		`[{"start":"09:00","end":"12:00","weekdays":[1,2,3,4,5]}]`,
		`[{"start":"09:00","end":"12:00","weekdays":null}]`,
	}
	for _, v := range legal {
		if msg := ValidatePeakWindows(v); msg != "" {
			t.Fatalf("ValidatePeakWindows(%q) = %q, want 合法", v, msg)
		}
	}
	illegal := []string{
		`[{"start":"09:00","end":"12:00","weekdays":[]}]`,    // 显式空数组（R18C-04 的主形态）
		`[{"start":"09:00","end":"12:00","weekdays":[0,8]}]`, // 全非法
		`[{"start":"09:00","end":"12:00","weekdays":[1,8]}]`, // 部分非法
		`[{"start":"09:00","end":"12:00","weekdays":"周一"}]`,
		`[{"start":"12:00","end":"09:00"}]`,
		`[{"start":"22:00","end":"06:00"}]`, // 跨午夜
		`[{"start":"9:00","end":"12:00"}]`,
		`not-json`,
		`{"start":"09:00","end":"12:00"}`,
	}
	for _, v := range illegal {
		msg := ValidatePeakWindows(v)
		if msg == "" {
			t.Fatalf("ValidatePeakWindows(%q) = 合法, want 拒绝（这类取值会静默反转计费口径）", v)
		}
		if !strings.Contains(msg, "peak_windows") {
			t.Fatalf("拒绝文案必须点名字段：%q", msg)
		}
	}
	// 空数组的文案要给出修法（删除该行 / 至少选一个 / 清空配置）。
	msg := ValidatePeakWindows(`[{"start":"09:00","end":"12:00","weekdays":[]}]`)
	if !strings.Contains(msg, "weekdays") {
		t.Fatalf("空数组的拒绝文案没有点名 weekdays：%q", msg)
	}
}
