package serverstore

// S6-01（回归审计 v2.8.1→HEAD，2026-10-04，P1）的**反退化判据**。
//
// 缺陷形态（本仓登记过的第三种表现）：
//   - 一种是把判据写成随真实日历**变红**（2026-10-01 的 4069bddac6 修过 —— 至少看得见）；
//   - **这一种是随真实日历静默 skip**：判据在某些日期一条断言都不跑，而且是**绿**的
//     ⇒ 永远不会被发现，等于该判据在 1/3 的年份里不存在。
//
// 两处实例（本文件落地时已修）：
//
//	① audit_r8_retention_fix_test.go 的夹具 `mBad := bjMonth(10)` / `mOk := bjMonth(2)`：
//	   两者同年即 `t.Skipf` ⇒ 当前月 ∈ {1,2,11,12} 的整月（120 天/年）不跑。它守的是
//	   RebuildUsageLedger 的逐月隔离/年分区准备（漏掉 = 静默丢账）。
//	② audit_r5a_retention_test.go 的 `BeijingDay(time.Now()).AddDate(0, -6, 0)`：
//	   Go 的 AddDate 会归一化，"目标月没有该日"时溢出到下一个月（8/31−6 月 ⇒ 2/31 ⇒ 3/3）；
//	   窗口起点晚于夹具月即 `t.Skipf` ⇒ 每年 7 天（闰年 6 天，2026–2028 实测 20 天）。
//	   而且它复刻的正是生产早已用 `RetentionWindowStart`（beijing.go:97）修掉的写法
//	   ⇒ 夹具与生产**不同形**。
//
// 六条判据（缺一条就能被绕过；括号里是"只有它能咬住"的形态，逐条对应 2026-10-04
// 对抗验证报告的 S6-01 Gap-1..Gap-4）：
//
//	A. 能力级·值：两条夹具的日期派生各自收进唯一入口（`r8Fix3bFixtureMonths` /
//	   `r5aFixtureWindow`），对 2026–2028 的每一天驱动同一条代码路径，断言派生结果
//	   与日期无关、夹具前提（跨年且坏月在前、启动窗口覆盖夹具月）每天都成立。
//	   语料带牙齿断言：必须真的含旧形态会出错的日子（否则"每天跑一遍"是空转）。
//	D. 结构级·调用点绑定（Gap-1）：入口必须直接出现在目标用例函数体内、返回值被赋值收下、
//	   喂给 `monthKey/yearKey/dayKey/monthWindow` 的月值必须来自入口返回值，且**调用点
//	   自己不得再做日历派生**。（只有它咬得住"把旧派生搬回调用点、保留未被调用的入口"
//	   —— A 只驱动入口，B/C 看不到"没有 skip 的静默退化"。）
//	B. 结构级·夹具函数体：这两条夹具不得出现任何 `t.Skip*` —— 静默跳过不是"本环境咬不到"，
//	   而是判据自行关闭；夹具前提不成立必须 fail-loud（红）。（只有它咬得住夹具体里的
//	   无条件 skip —— E 的污点分析对没有守卫条件的 `t.Skip("flaky")` 无话可说。）
//	E. 结构级·夹具可达调用图（Gap-2，深度 ≤ 3 + 跨过程污点）：从夹具出发可达的任一函数里，
//	   不得出现"守卫条件由夹具月/当前日历派生 ⇒ skip"。（只有它咬得住把 `t.Skipf` 挪进
//	   一行 helper、历法值经形参转发 —— B 只看夹具函数体，C 只做函数内污点，两者都够不到。）
//	C. 结构级·全扫描面：不得出现"条件由当前日历取值派生 ⇒ skip"的形态（AST 污点分析，
//	   源 = `time.Now` 与 `bjToday/bjDay/bjMonth/BeijingNow`；`time.Since/Until` 是时长，不是日历）。
//	   允许保留的 skip
//	   必须逐条登记在 `calendarDerivedSkipRegistry` 里，登记键 = `文件|函数|条件源码`，
//	   另带期望调用点数（Gap-3：在已登记函数里新增一条同条件/异条件 skip 同样变红）；
//	   登记表双向对拍（漏登记红、死条目红、计数不符红）。
//	F. 结构级·扫描面登记（Gap-4）：扫描面 = `server/internal` + `server/cmd` 下所有含
//	   测试面文件的目录，逐目录登记（`calendarSkipScanDirRegistry`）并与"从根派生枚举"的
//	   结果双向对拍：树里有未登记的目录 ⇒ 红（新包静默落在面外）、登记的目录扫不到 ⇒ 红
//	   （目录被删/改名/被排除）。另带文件数/函数数/skip 调用点下限 —— 分析器自身失效时
//	   不能给出"零命中 ✅"。
//
// 变异验证（实跑对照见 temp/audit-v282/fixes/S6-01-gaps.md）：
//   - M8（旧派生回调用点 + 一行 helper 转发 skip，原缺陷整体复活）⇒ D/E 红（此前 A/B/C 全绿）；
//   - M5b（在已登记函数 `TestR11I4FreezeCommitHangIsBounded` 里加日历派生 skip）⇒ C 红；
//   - 从 `calendarSkipScanDirRegistry` 里去掉一个目录 / 物理删掉一个目录的测试面文件 ⇒ F 红。

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// A. 能力级：夹具的日期派生对 2026–2028 的每一天都必须成立
// ---------------------------------------------------------------------------

// fixtureCalendarCorpus 返回 2026-01-01..2028-12-31 每一天的**北京中午**瞬时
// （含闰年 2028；共 1096 天）。用绝对瞬时而不是裸日期值：`time.Now()` 在真实
// 运行里也是绝对瞬时，夹具的派生函数（BeijingDay/BeijingMonth）都按北京时区解释。
func fixtureCalendarCorpus() []time.Time {
	var out []time.Time
	for y := 2026; y <= 2028; y++ {
		for m := time.January; m <= time.December; m++ {
			last := time.Date(y, m+1, 0, 12, 0, 0, 0, time.UTC).Day()
			for d := 1; d <= last; d++ {
				out = append(out, time.Date(y, m, d, 12, 0, 0, 0, time.UTC).Add(-BeijingOffset))
			}
		}
	}
	return out
}

// TestFixtureCalendarSeamsCoverEveryCalendarDay 是判据 A。
//
// 两条夹具的"用哪个月"必须与**当前日期无关**（R8 固定年月；R5A 的窗口起点与夹具月
// 同源），而且夹具前提在每一天都成立 —— 这正是旧代码用 `t.Skipf` 掩盖掉的东西。
// oracle 用 `r13geMonthShift`（`audit_r13ge_calendar_test.go` 的**整数月份算术**，
// 不经过 `time.AddDate`），避免"同一条会溢出的表达式自己对自己"。
//
// 边界：A 的驱动对象是**派生入口**（helper）。"入口还在、调用点绕过它"由判据 D 罩，
// 两者必须成对存在（S6-01 Gap-1）。
func TestFixtureCalendarSeamsCoverEveryCalendarDay(t *testing.T) {
	corpus := fixtureCalendarCorpus()
	if len(corpus) < 1000 {
		t.Fatalf("语料只有 %d 天（下限 1000）—— 判据失效，不能静默通过", len(corpus))
	}

	pinnedBad := time.Date(2025, time.November, 1, 0, 0, 0, 0, time.UTC)
	pinnedOk := time.Date(2026, time.July, 1, 0, 0, 0, 0, time.UTC)

	var r8Drift, r8SameYear, r8Order, r5aMonthSplit, r5aValueSplit, r5aOracle int
	// 牙齿计数：语料里"旧形态真的会出错"的日子（没有这些日子，本判据就是空转）。
	legacyOverflow := map[int]int{}
	legacySameYear := 0

	for _, now := range corpus {
		bd := BeijingDay(now) // 北京日期值（Year/Month/Day 即北京口径）
		yr := bd.Year()

		// ---- R8-fix3b 夹具 ----
		mBad, mOk := r8Fix3bFixtureMonths(now)
		if !mBad.Equal(pinnedBad) || !mOk.Equal(pinnedOk) {
			r8Drift++
			if r8Drift <= 3 {
				t.Errorf("R8 夹具年月随日期漂移：now(北京)=%s 派生 (%s, %s)，want (%s, %s)",
					bd.Format(dateFmt), monthKey(mBad), monthKey(mOk), monthKey(pinnedBad), monthKey(pinnedOk))
			}
		}
		if mBad.Year() == mOk.Year() {
			r8SameYear++ // 旧代码正是在这一天 t.Skipf
		}
		if !mBad.Before(mOk) {
			r8Order++
		}

		// ---- R5A-10 夹具 ----
		fixtureMonth, windowFrom := r5aFixtureWindow(now)
		// 语义面（旧 skip 判的就是这个）：窗口起点所在月必须覆盖夹具月。
		if !BeijingMonth(windowFrom).Equal(BeijingMonth(fixtureMonth)) {
			r5aMonthSplit++
			if r5aMonthSplit <= 3 {
				t.Errorf("R5A 夹具的启动窗口与夹具月分叉：now(北京)=%s 窗口所在月=%s 夹具月=%s "+
					"（窗口没覆盖夹具月 ⇒ 旧代码会静默 skip 掉这一天的判据）",
					bd.Format(dateFmt), monthKey(windowFrom), monthKey(fixtureMonth))
			}
		}
		// 结构面（更强）：两者出自**同一个值**，不许只是"同月"。
		if !windowFrom.Equal(fixtureMonth) {
			r5aValueSplit++
			if r5aValueSplit <= 3 {
				t.Errorf("R5A 夹具的窗口与夹具月不是同一个值：now(北京)=%s 窗口=%s 夹具月=%s",
					bd.Format(dateFmt), windowFrom.Format(dateFmt), fixtureMonth.Format(dateFmt))
			}
		}
		if want := r13geMonthShift(yr, bd.Month(), -6); !BeijingMonth(windowFrom).Equal(want) {
			r5aOracle++
			if r5aOracle <= 3 {
				t.Errorf("R5A 启动窗口所在月 ≠ 独立 oracle（整数月份算术）：now(北京)=%s got=%s want=%s",
					bd.Format(dateFmt), monthKey(windowFrom), want.Format("200601"))
			}
		}

		// ---- 语料牙齿：旧 R5A 形态（BeijingDay+AddDate）在这天真的溢出吗 ----
		legacy := BeijingDay(now).AddDate(0, -6, 0)
		if !BeijingMonth(legacy).Equal(BeijingMonth(windowFrom)) {
			legacyOverflow[yr]++
		}
		// ---- 语料牙齿：旧 R8 形态（bjMonth(10)/bjMonth(2)）在这天同年吗 ----
		if BeijingMonth(now).AddDate(0, -10, 0).Year() == BeijingMonth(now).AddDate(0, -2, 0).Year() {
			legacySameYear++
		}
	}

	if r8Drift > 0 || r8SameYear > 0 || r8Order > 0 {
		t.Errorf("R8 夹具前提在语料里不成立：漂移=%d 同年=%d 顺序错=%d（三者都必须为 0）",
			r8Drift, r8SameYear, r8Order)
	}
	if r5aMonthSplit > 0 || r5aValueSplit > 0 || r5aOracle > 0 {
		t.Errorf("R5A 夹具前提在语料里不成立：窗口月≠夹具月=%d 窗口值≠夹具月=%d 偏离 oracle=%d（都必须为 0）",
			r5aMonthSplit, r5aValueSplit, r5aOracle)
	}

	// 牙齿下限：语料必须真的覆盖旧形态的触发日，否则"每天都跑一遍"是空转。
	totalLegacy := 0
	for _, n := range legacyOverflow {
		totalLegacy += n
	}
	if totalLegacy < 18 {
		t.Fatalf("语料只覆盖 %d 个「旧 BeijingDay+AddDate 形态溢出」的日子（下限 18）—— "+
			"判据失去牙齿，不能静默通过", totalLegacy)
	}
	if legacySameYear < 300 {
		t.Fatalf("语料只覆盖 %d 个「旧 R8 形态同年」的日子（下限 300）—— 判据失去牙齿，不能静默通过", legacySameYear)
	}
	for _, y := range []int{2026, 2027, 2028} {
		if legacyOverflow[y] < 5 {
			t.Fatalf("%d 年的溢出触发日只有 %d 天（下限 5）—— 语料按年缩水，判据失去牙齿", y, legacyOverflow[y])
		}
	}
	t.Logf("语料 %d 天：R8 派生恒定（旧形态同年 %d 天）；R5A 窗口==夹具月（旧形态溢出 %v，合计 %d 天）",
		len(corpus), legacySameYear, legacyOverflow, totalLegacy)
}

// ---------------------------------------------------------------------------
// D. 结构级：夹具的日期派生**必须在调用点被绑上**（S6-01 Gap-1）
// ---------------------------------------------------------------------------

// calendarFixtureBinding 把"必须每天真正执行"的夹具与它的日期派生入口绑在一起。
//
//	seam       = 唯一的日期派生入口（判据 A 驱动它）
//	minResults = 入口返回的月值个数（必须被赋值语句全部收下）
//	consumers  = "由夹具月派生年月/窗口"的函数；它们的**裸标识符实参**必须来自入口返回值
//	extraSinks = 额外的"月值汇点"（承接夹具月值、但在**退化形态下**可能不再收 pinned 名字的
//	             调用点，例如 R5A 的 `RebuildUsageLedger(db, windowFrom, now)`）——
//	             正常形态下它们本来就会被自动派生出来（见 monthSinkNames），列出来是为了
//	             在"pinned 集合为空"的变异形态下判据仍然咬得住
type calendarFixtureBinding struct {
	file       string
	fn         string
	seam       string
	minResults int
	consumers  []string
	extraSinks []string
}

var calendarFixtureBindings = []calendarFixtureBinding{
	{
		file: "audit_r8_retention_fix_test.go", fn: "TestR8Fix3bLedgerRebuildPreparesLaterMonths",
		seam: "r8Fix3bFixtureMonths", minResults: 2,
		consumers: []string{"monthKey", "yearKey", "dayKey"},
		extraSinks: []string{
			"r6DropMonthPartitions", "usageRowAt", "ensureUsagePartition", "r6LedgerStats",
			"BeijingDayInstant", "BeijingDayAt", "BeijingMonthInstant", "RebuildUsageLedger",
		},
	},
	{
		file: "audit_r5a_retention_test.go", fn: "TestRebuildLedgerDoesNotRegrowEmptyDetailPartition",
		seam: "r5aFixtureWindow", minResults: 2,
		consumers: []string{"monthKey", "monthWindow"},
		extraSinks: []string{
			"RebuildUsageLedger", "assertMonthEqualsMonthlyLedger", "relationExists",
			"BeijingMonthInstant", "BeijingDayInstant", "BeijingDayAt", "usageWindowCost",
		},
	},
}

// TestFixtureSeamsAreBoundAtCallSites 是判据 D（S6-01 Gap-1）。
//
// 判据 A 只驱动**派生入口**；只要有人把派生重新内联回调用点、同时保留那个**不再被
// 调用**的入口，A 就永远是绿的 —— 而"整条夹具的日期前提"此时已经脱离任何判据：
//
//	mBad, mOk := bjMonth(10), bjMonth(2)          // 旧派生回调用点
//	// 前提检查一并删掉 ⇒ 366 天/年全绿，而"跨年 + 双年分区"这条性质静默丢失
//
// D 用四条结构性断言把调用点钉死（全部是 AST 级，不是"文件里出现过函数名"）：
//
//	D1 入口被**直接调用**且恰好一次（`directCalleeName == seam`；`pkg.seam(...)` 不算）；
//	D2 返回值被赋值语句收下（≥ minResults 个左值名字）；
//	D3 调用点不得再自行做日历派生（`bjMonth/bjDay/bjToday/BeijingNow/time.Now` 出现在
//	   赋值右侧、该右侧**不含**入口调用、且派生结果**真的被当月值使用**）—— M1a/M1b 的咬合点；
//	D4 喂给 consumers（monthKey/yearKey/dayKey/monthWindow）的**裸标识符实参**必须 ∈ D2
//	   收下的名字 —— "返回值被用于派生年月"这句要求的可判定形式。
func TestFixtureSeamsAreBoundAtCallSites(t *testing.T) {
	fset := token.NewFileSet()
	for _, want := range calendarFixtureBindings {
		file := parseTestFile(t, fset, want.file)
		fn := findTestFunc(t, file, want.file, want.fn)
		timePkg := timePkgAlias(file)

		calls := directCallsTo(fn.Body, want.seam)
		if len(calls) != 1 {
			t.Errorf("%s 的 %s 必须**直接调用** %s 恰好 1 次（实得 %d 次）—— 判据 A 只驱动入口，"+
				"调用点绕过它（把旧派生搬回调用点 / 用 pkg.%s 转发）时整条夹具的日期前提就脱离了 "+
				"A 的咬合面（S6-01 Gap-1）", want.file, want.fn, want.seam, len(calls), want.seam)
			continue
		}
		pinnedList := boundNamesOf(fn.Body, calls[0])
		pinned := map[string]bool{}
		for _, n := range pinnedList {
			pinned[n] = true
		}
		if len(pinned) < want.minResults {
			t.Errorf("%s 的 %s：%s 的返回值必须被赋值收下（≥%d 个名字，实得 %d 个 %v）—— "+
				"丢弃返回值等于把派生结果与调用点解绑", want.file, want.fn, want.seam,
				want.minResults, len(pinned), pinnedList)
			continue
		}
		if bad := calendarDerivedLocalsOutsideSeam(fset, fn.Body, want.seam, timePkg,
			monthSinkNames(fn.Body, pinned, want.consumers, want.extraSinks)); len(bad) > 0 {
			t.Errorf("%s 的 %s 在调用点又自己做了一次日历派生：%s —— 旧形态 "+
				"`mBad, mOk := bjMonth(10), bjMonth(2)` / `BeijingDay(time.Now()).AddDate(0,-6,0)` "+
				"正是这么绕过判据 A 的；这种改动**可以完全不带 skip**（M1b：前提检查一并删掉 ⇒ "+
				"天天全绿而跨年/双年分区性质静默丢失）。日期派生只能经过 %s（S6-01 Gap-1）",
				want.file, want.fn, strings.Join(bad, ", "), want.seam)
		}
		if bad := consumerArgsOutsidePinned(fn.Body, want.consumers, pinned); len(bad) > 0 {
			t.Errorf("%s 的 %s：夹具年月必须来自 %s 的返回值，但这些调用点用的是别的值：%s "+
				"（S6-01 Gap-1：返回值必须真的被用来派生年月）",
				want.file, want.fn, want.seam, strings.Join(bad, ", "))
		}
	}
}

// ---------------------------------------------------------------------------
// B. 结构级：这两条夹具不得再出现任何 t.Skip*
// ---------------------------------------------------------------------------

// calendarFixturesWithoutSkip 与 calendarFixtureBindings 同源（file/fn 复用），
// 避免"两张表各自漂移"。
func calendarFixturesWithoutSkip() []struct{ file, fn string } {
	out := make([]struct{ file, fn string }, 0, len(calendarFixtureBindings))
	for _, b := range calendarFixtureBindings {
		out = append(out, struct{ file, fn string }{b.file, b.fn})
	}
	return out
}

// TestCalendarFixturesContainNoSkip 是判据 B：夹具里不得有 `t.Skip*` ——
// 跳过就是判据自行关闭，而"夹具前提不成立"必须是 fail-loud（红）。
//
// 边界：B 只看**夹具函数体**。skip 若经 helper 转发，由判据 E 罩。
func TestCalendarFixturesContainNoSkip(t *testing.T) {
	fset := token.NewFileSet()
	for _, want := range calendarFixturesWithoutSkip() {
		fn := parseTestFunc(t, fset, want.file, want.fn)
		var hits []string
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			if call, ok := n.(*ast.CallExpr); ok && isTestSkipCall(call) {
				hits = append(hits, fmt.Sprintf("%s:%d", want.file, fset.Position(call.Pos()).Line))
			}
			return true
		})
		if len(hits) > 0 {
			t.Errorf("%s 的 %s 又出现了 t.Skip（%s）—— 夹具前提不成立必须 fail-loud；"+
				"静默跳过等于这条判据在某些日期根本不存在", want.file, want.fn, strings.Join(hits, ", "))
		}
	}
}

// ---------------------------------------------------------------------------
// E. 结构级：夹具**可达调用图**里不得出现"夹具月/日历派生 ⇒ skip"（S6-01 Gap-2）
// ---------------------------------------------------------------------------

// s601CallGraphDepth 是"夹具可达调用图"的展开深度上限（夹具函数自身 = 第 0 层）。
// 跟两类调用：**裸标识符调用**（`helper(...)`）与**本包方法调用**（`x.method(...)`，
// 选择子名在本包有同名方法时跟进）。跨包调用（`pkg.F(...)`）不进入本包调用图，
// 见文件末的边界说明。
const s601CallGraphDepth = 3

// s601GraphFunc 是调用图里的一个函数。
type s601GraphFunc struct {
	name    string
	file    string
	line    int
	params  []string
	tainted []bool // 形参位置 → 被"夹具月/当前日历"污染（跨过程不动点求出的和）
	recv    string // 方法接收者名（函数为空串）
	// recvTainted = 接收者被污染（由调用点 `x.m(...)` 的 x 是否带污点决定）。
	// 为什么要跟方法：`holder := s601Holder{bjMonth(10), bjMonth(2)}; holder.skip(t)`
	// 这种"日历派生 + 方法转发"形态能同时躲开判据 D 的 monthish-use 与"只跟裸标识符
	// 调用"的 E —— 2026-10-04 的取证探针 X1/X2 实测六条判据全绿。
	recvTainted bool
	seed        map[string]bool // 仅夹具根：由派生入口返回值绑定的名字（= 夹具月本身）
	body        *ast.BlockStmt
	timePkg     string
	fset        *token.FileSet
}

// s601CallGraph 是本包（serverstore 目录）的函数级调用图。
//
// 图里包含**目录下全部 .go**（生产 + 测试面）：skip 只可能出现在导入 testing 的文件里，
// 但污染要沿传递链走，链上完全可能是生产 helper（例如 `ensureUsagePartition`）。
//
// 图里同时包含**函数字面量**（键是 `文件:行$func` 的合成名）与**函数值流**
// （局部绑定 / 形参转发 / 结构体字段），见 s601CallGraph.edgesFrom 的说明 ——
// 没有这一层时，"把 skip 装进函数值再转发"能整体绕过判据 E（对抗验证 final-B 的
// S6-M8b 实证：A/B/C/D 全绿而夹具在触发日照旧静默 SKIP）。
type s601CallGraph struct {
	funcs map[string]*s601GraphFunc
	dups  []string
	// bindings 是"函数 → 函数体里 `标识符 → 本包函数值` 的局部绑定表"（含复合字面量
	// 的字段名）。与 paramFuncs 不同，它只依赖 AST（不依赖调用点），所以可安全缓存。
	bindings map[string]map[string][]string
	// paramFuncs 是"函数 → 形参下标 → 调用点传进来的函数值（本包函数名 / 函数字面量
	// 的合成名）"，由 computeFuncValueArgs 的不动点求出（单调增长）。
	paramFuncs map[string]map[int][]string
	// callCache 缓存 callsFrom 的结果。**必须在 paramFuncs 收敛之后**才可填
	// （computeFuncValueArgs 只走 edgesFrom，不碰这个缓存）。
	callCache map[string][]s601CallSite
	// returns 是"函数 → 它 return 出来的函数值名字"的缓存（工厂形态，
	// 见 funcReturns；同样只依赖 AST ⇒ 可缓存）。
	returns map[string][]string
}

// TestFixtureReachableCallGraphHasNoMonthDerivedSkip 是判据 E（S6-01 Gap-2）。
//
// 判据 B 只看夹具函数体、判据 C 只做**函数内**污点 ⇒ 把 skip 挪进一行 helper 即隐形：
//
//	func s601SkipUnlessCrossYear(t *testing.T, mBad, mOk time.Time) {
//		if mBad.Year() == mOk.Year() { t.Skipf(...) }      // 守卫里的 mBad/mOk 是**形参**
//	}
//
// E 把判据 B 从"函数体"扩成"夹具可达的调用图"：以夹具为根展开 ≤3 层（裸标识符调用
// + 本包方法调用 `x.m(...)` + **函数值流**，见 edgesFrom），对每条调用边做
// **实参 → 形参**（方法还有**接收者**）的跨过程污点传播（单调不动点），然后检查链上
// 任一函数里是否存在"被污染条件守卫的 `t.Skip*`"。
//
// 函数值流这一层是 2026-10-04 补的牙（对抗验证 final-B §P3-2 / S6-M8b）：旧 E 只跟
// "裸标识符被调 + 本包方法"，于是
//
//	var fbbSkipper func(*testing.T, time.Time, time.Time) = fbbSkipUnlessCrossYear
//	fbbSkipper(t, bjMonth(10), bjMonth(2))     // 触发日：夹具照旧 --- SKIP，A/B/C/D 全绿
//
// 这条调用在图里表现为"被调名 fbbSkipper 不在本包函数表里 ⇒ 丢边"——helper 不可达、
// 它的 skip 从不被检查，而**原缺陷（夹具每年约 120 天静默不跑）原样复活**。
// 现在局部绑定 / 函数字面量 / 形参转发 / 结构体字段 / 本包工厂五类都进图。
//
// 污染源有两类（这是与判据 C 的关键差别）：
//   - 当前日历：`time.Now`、`bjToday/bjDay/bjMonth/BeijingNow`（`time.Since/Until` 是时长，不算）；
//   - **夹具月本身**：夹具根里由派生入口返回值绑定的名字（如 `mBad/mOk/windowFrom`）。
//     把夹具月当污染源是刻意的：**任何"由夹具月决定要不要跳过"的分支都是缺陷**
//     （夹具月是固定的，这种 skip 要么永远跳过、要么永远不跳，都不是"每天真跑"）。
//
// 环境能力类 skip（如 `NewTestDB` → `requireTestPG` 的"无 PG 就跳过"）的守卫与夹具月
// 无关，不在咬合面内 —— 这是设计，不是漏报。
func TestFixtureReachableCallGraphHasNoMonthDerivedSkip(t *testing.T) {
	graph := loadS601CallGraph(t)
	for _, want := range calendarFixtureBindings {
		root, ok := graph.funcs[want.fn]
		if !ok {
			t.Errorf("调用图里找不到夹具 %s（改名/移动必须同步本判据）", want.fn)
			continue
		}
		reach := graph.reachable(want.fn)
		if len(reach) < calendarSkipReachFuncFloor {
			t.Fatalf("夹具 %s 的可达调用图只有 %d 个函数（下限 %d）—— 分析器失效时"+
				"不能给出「零命中 ✅」", want.fn, len(reach), calendarSkipReachFuncFloor)
		}
		hits := graph.monthDerivedSkipHits(root, want.seam, reach)
		sort.Slice(hits, func(i, j int) bool {
			if hits[i].file != hits[j].file {
				return hits[i].file < hits[j].file
			}
			return hits[i].line < hits[j].line
		})
		for _, h := range hits {
			t.Errorf("夹具 %s 的可达调用图里有「夹具月/日历派生 ⇒ skip」：%s:%d %s（距夹具 %d 跳，条件=%s）—— "+
				"把 t.Skip* 挪进 helper、用形参转发派生值，正是为绕过判据 B/C 设计的形态；"+
				"夹具月只能用来构造数据，不许用来决定「要不要跑」（S6-01 Gap-2）",
				want.fn, h.file, h.line, h.fn, reach[h.fn], h.guard)
		}
		t.Logf("夹具 %s：可达调用图 %d 个函数（深度 ≤ %d），月派生 skip 命中 %d 处",
			want.fn, len(reach), s601CallGraphDepth, len(hits))
	}
}

// loadS601CallGraph 解析本包目录下的全部 .go（生产 + 测试面）建函数级调用图。
func loadS601CallGraph(t *testing.T) *s601CallGraph {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("读包目录: %v", err)
	}
	g := &s601CallGraph{
		funcs:      map[string]*s601GraphFunc{},
		bindings:   map[string]map[string][]string{},
		callCache:  map[string][]s601CallSite{},
		returns:    map[string][]string{},
		paramFuncs: map[string]map[int][]string{},
	}
	parsed := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") {
			continue
		}
		fset := token.NewFileSet()
		file, perr := parser.ParseFile(fset, e.Name(), nil, parser.ParseComments)
		if perr != nil {
			t.Fatalf("解析 %s: %v", e.Name(), perr)
		}
		parsed++
		timePkg := timePkgAlias(file)
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			info := &s601GraphFunc{
				name: fn.Name.Name, file: e.Name(), line: fset.Position(fn.Pos()).Line,
				params: s601ParamNames(fn.Type), body: fn.Body, timePkg: timePkg, fset: fset,
				recv: s601RecvName(fn),
			}
			info.tainted = make([]bool, len(info.params))
			if prev, dup := g.funcs[info.name]; dup {
				g.dups = append(g.dups, fmt.Sprintf("%s(%s:%d 与 %s:%d)",
					info.name, prev.file, prev.line, info.file, info.line))
				continue
			}
			g.funcs[info.name] = info
		}
		// 函数字面量也进图（S6-01 P3 的补牙）：它们此前完全不在图里，于是
		// `f := func(…){ … t.Skip… }; f(t, 月值)` 这种形态的 skip 体从不可达。
		// 合成名 = `文件:行$func`（行号唯一 ⇒ 名字稳定且不与其他节点冲突）。
		ast.Inspect(file, func(n ast.Node) bool {
			lit, ok := n.(*ast.FuncLit)
			if !ok {
				return true
			}
			name := s601FuncLitName(e.Name(), fset.Position(lit.Pos()).Line)
			if _, dup := g.funcs[name]; dup {
				return true
			}
			info := &s601GraphFunc{
				name: name, file: e.Name(), line: fset.Position(lit.Pos()).Line,
				params: s601ParamNames(lit.Type), body: lit.Body, timePkg: timePkg, fset: fset,
			}
			info.tainted = make([]bool, len(info.params))
			g.funcs[name] = info
			return true
		})
	}
	if parsed < 50 {
		t.Fatalf("包目录只解析出 %d 个 .go（下限 50）—— 调用图的分析面失效", parsed)
	}
	if len(g.dups) > 0 {
		t.Logf("调用图重名（取先见者，不影响本判据的根与链）：%s", strings.Join(g.dups, "; "))
	}
	// 函数值流（形参转发）必须在建图之后、用图之前求一次不动点。
	g.computeFuncValueArgs()
	return g
}

// reachable 返回从 root 出发、深度 ≤ s601CallGraphDepth 的可达函数（含 root，深度 0）。
func (g *s601CallGraph) reachable(root string) map[string]int {
	depth := map[string]int{}
	if _, ok := g.funcs[root]; !ok {
		return depth
	}
	depth[root] = 0
	queue := []string{root}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if depth[cur] >= s601CallGraphDepth {
			continue
		}
		for _, call := range g.callsFrom(cur) {
			name := call.callee
			if _, seen := depth[name]; seen {
				continue
			}
			if _, ok := g.funcs[name]; !ok {
				continue
			}
			depth[name] = depth[cur] + 1
			queue = append(queue, name)
		}
	}
	return depth
}

// monthDerivedSkipHits 在可达子图上求跨过程污点不动点，再收集命中。
//
// 单调不动点：形参污染的集合只增不减 ⇒ 迭代到不再变化即最小不动点（最多
// 迭代 len(reach)+1 轮；加硬上限防止实现出错时死循环）。
func (g *s601CallGraph) monthDerivedSkipHits(root *s601GraphFunc, seam string, reach map[string]int) []calendarSkipHit {
	// 夹具根的种子 = 派生入口返回值绑定的名字（= 夹具月）。
	root.seed = map[string]bool{}
	for _, call := range s601DirectCalls(root.body) {
		if directCalleeName(call) != seam {
			continue
		}
		for _, n := range boundNamesOf(root.body, call) {
			root.seed[n] = true
		}
	}

	limit := len(reach) + 2
	for iter := 0; iter < limit; iter++ {
		changed := false
		for name := range reach {
			fi := g.funcs[name]
			env := g.fullEnv(fi)
			for _, call := range g.callsFrom(name) {
				callee, ok := g.funcs[call.callee]
				if !ok {
					continue
				}
				if _, ok := reach[callee.name]; !ok {
					continue
				}
				// 方法调用 `x.m(...)`：接收者带污点 ⇒ 方法体内的接收者名也算污染
				// （这是"日历派生 + 方法转发"形态的收口点，见 s601GraphFunc.recvTainted）。
				if call.recv != "" && !callee.recvTainted && env[call.recv] {
					callee.recvTainted = true
					changed = true
				}
				for i, arg := range call.args {
					if i >= len(callee.tainted) || callee.tainted[i] {
						continue
					}
					if calendarExprTainted(arg, env, fi.timePkg) {
						callee.tainted[i] = true
						changed = true
					}
				}
			}
		}
		if !changed {
			break
		}
	}

	var hits []calendarSkipHit
	for name := range reach {
		fi := g.funcs[name]
		h, _ := calendarSkipSitesInBody(fi.fset, fi.body, g.baseEnv(fi), fi.timePkg, fi.file, fi.name)
		hits = append(hits, h...)
	}
	return hits
}

// baseEnv 求单个函数的"种子污染"：接收者 + 形参（由调用点传入）+ 夹具月种子。
// 赋值链传播由 calendarSkipSitesInBody 按**每个 skip 的位置**各做一次。
func (g *s601CallGraph) baseEnv(fi *s601GraphFunc) map[string]bool {
	env := map[string]bool{}
	if fi.recv != "" && fi.recvTainted {
		env[fi.recv] = true
	}
	for i, n := range fi.params {
		if n != "" && i < len(fi.tainted) && fi.tainted[i] {
			env[n] = true
		}
	}
	for n := range fi.seed {
		env[n] = true
	}
	return env
}

// fullEnv 求单个函数体内"全部被污染名字"（按整函数体传播，不看位置）。
// 只用于**调用点实参**的污点判断（跨过程不动点），因为那里没有"位置"可比。
func (g *s601CallGraph) fullEnv(fi *s601GraphFunc) map[string]bool {
	env := g.baseEnv(fi)
	calendarTaintAssignsBefore(fi.body, env, fi.timePkg, token.NoPos)
	return env
}

// s601ParamNames 展开形参名（未命名形参占一个位置但名字为空串）。
func s601ParamNames(ft *ast.FuncType) []string {
	var out []string
	if ft == nil || ft.Params == nil {
		return out
	}
	for _, f := range ft.Params.List {
		if len(f.Names) == 0 {
			out = append(out, "")
			continue
		}
		for _, nm := range f.Names {
			out = append(out, nm.Name)
		}
	}
	return out
}

// s601DirectCalls 返回 body 里全部"裸标识符被调"的调用点。
func s601DirectCalls(body *ast.BlockStmt) []*ast.CallExpr {
	var out []*ast.CallExpr
	ast.Inspect(body, func(n ast.Node) bool {
		if call, ok := n.(*ast.CallExpr); ok && directCalleeName(call) != "" {
			out = append(out, call)
		}
		return true
	})
	return out
}

// s601CallSite 是调用图里的一条边：被调名（裸标识符或方法名）+ 接收者变量名（方法才有）。
type s601CallSite struct {
	callee string
	recv   string // `x.m(...)` 的 x（裸标识符）；裸标识符调用为空串
	args   []ast.Expr
}

// callsFrom 返回某函数体里的**本包可解析**调用边：
//   - `f(...)`：被调名 = f；
//   - `x.m(...)`：被调名 = m，接收者 = x —— 只有当本包存在名为 m 的函数/方法时才成边
//     （名字解析是"按名跟进"的保守近似：本包同名方法只有一个时精确，重名时取先见者
//     并在 t.Logf 里登记）。
//
// 为什么必须跟方法：`holder := s601Holder{bjMonth(10), bjMonth(2)}; holder.skip(t)`
// 这种"日历派生 + 方法转发"能同时躲开判据 D（holder 不是"月值汇点的裸标识符实参"、
// 也不是 time-ish 方法接收者）与"只跟裸标识符调用"的 E —— 取证探针 X1/X2 实测六条全绿。
func (g *s601CallGraph) callsFrom(fnName string) []s601CallSite {
	if cached, ok := g.callCache[fnName]; ok {
		return cached
	}
	var out []s601CallSite
	for _, e := range g.edgesFrom(fnName) {
		if e.callee == "" {
			continue
		}
		out = append(out, s601CallSite{callee: e.callee, recv: e.recv, args: e.args})
	}
	g.callCache[fnName] = out
	return out
}

// s601Edge 是一条已解析的调用边（调用图的最小单位）。
type s601Edge struct {
	callee string // 已解析的本包函数名（含函数字面量的合成名）；"" ⇒ 解析不出（丢边）
	recv   string // `x.m(...)` 的接收者（裸标识符）；裸标识符调用为空
	args   []ast.Expr
}

// s601FuncLitName 是函数字面量的**合成节点名**（稳定、唯一、可读）。
func s601FuncLitName(file string, line int) string {
	return file + ":" + strconv.Itoa(line) + "$func"
}

// s601ParamIndex 返回 name 在形参表里的下标（未命名形参占位但名字为空串；找不到 -1）。
func s601ParamIndex(params []string, name string) int {
	if name == "" {
		return -1
	}
	for i, p := range params {
		if p == name {
			return i
		}
	}
	return -1
}

// edgesFrom 枚举某函数体里的**已解析**调用边（S6-01 P3 的收口点）。
//
// 解析顺序（与 s601FuncValueNames / funcValueOfExpr 同源）：
//
//	① 立即调用的函数字面量：`func(…){…}(…)` ⇒ 边指向字面量的合成节点；
//	② 裸标识符调用 `f(…)`：先问"f 在本函数里绑到哪些**函数值**"——
//	   局部绑定（`f := pkgFn` / `var f func(…)=pkgFn` / `f := func(…){}` / 复合字面量字段）
//	   与**形参转发**（调用点把函数值传进来，见 paramFuncs）；
//	③ 选择子调用 `x.m(…)`：m 是本包函数名 ⇒ 既有行为（跟方法 + 接收者污点）；
//	   m 不在函数表里但在本函数体里被绑成函数值（结构体字段）⇒ 同样跟进；
//	④ 其余（跨包 `pkg.F(…)`、**接收者非裸标识符**的接口方法 `x().m(…)` / `pkg.X.m(…)`、
//	   map 里取出的函数值…）不跟 —— 见文件末边界。
//	   （注意边界精度：**接收者是裸标识符**的接口方法 `v.m(…)` 会按方法名跟进 ⇒ **咬得住**；
//	    咬不住的只是"接收者本身是复合表达式"的形态 —— 核验方 V-P12 §P3-3 实测。）
func (g *s601CallGraph) edgesFrom(fnName string) []s601Edge {
	fi, ok := g.funcs[fnName]
	if !ok {
		return nil
	}
	var out []s601Edge
	ast.Inspect(fi.body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if lit, ok := call.Fun.(*ast.FuncLit); ok {
			out = append(out, s601Edge{
				callee: s601FuncLitName(fi.file, fi.fset.Position(lit.Pos()).Line),
				args:   call.Args,
			})
			return true
		}
		// 工厂的**立即调用**形态：`makeSkipper()(t, 月值)` / `holder.premise()(t, 月值)`。
		// call.Fun 本身是一个调用表达式 ⇒ 它不满足 Ident/Selector 两条分支，容易被整条
		// 丢掉（2026-10-04 的 S6-M8f 实证：漏了它 = 刚关掉的门换到隔壁；
		// 核验方 V-P5 §1④ 又实测**方法工厂**同样漏 —— 两处一起补）。
		if inner, ok := call.Fun.(*ast.CallExpr); ok {
			for _, fnName := range s601FactoryNames(inner.Fun, g) {
				for _, t := range g.funcReturns(fnName, 0) {
					out = append(out, s601Edge{callee: t, args: call.Args})
				}
				return true
			}
		}
		if name := directCalleeName(call); name != "" {
			// ② 函数值（局部绑定 / 函数字面量 / 形参转发）。
			//
			// 与"裸标识符直接调用"**取并集**而不是替换：旧行为（名字恰好是本包函数名）
			// 必须原样保留 —— 判据的覆盖面只许变宽，不许因为引入函数值解析而丢掉
			// 任何一条既有边（例如形参名与某个包级函数同名时，形参转发与"同名直接
			// 调用"两条边都可能是真的；宁可多跟一条边让人来登记）。
			if targets := g.funcValueOfExpr(fnName, call.Fun); len(targets) > 0 {
				added := false
				for _, t := range targets {
					if t == name {
						added = true
					}
					out = append(out, s601Edge{callee: t, args: call.Args})
				}
				if _, known := g.funcs[name]; known && !added {
					out = append(out, s601Edge{callee: name, args: call.Args})
				}
				return true
			}
			out = append(out, s601Edge{callee: name, args: call.Args})
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		recv, ok := sel.X.(*ast.Ident)
		if !ok {
			return true
		}
		if _, known := g.funcs[sel.Sel.Name]; !known {
			// ③ 结构体字段里的函数值：`h := holder{skip: pkgFn}; h.skip(t)`。
			// 按**字段名**跟（字段名 → 函数值 的绑定只可能来自本函数体里的复合字面量，
			// 所以这是保守的过近似：宁可多跟一条边让人来登记，也不漏）。
			for _, t := range g.funcValueBindings(fnName)[sel.Sel.Name] {
				out = append(out, s601Edge{callee: t, args: call.Args})
			}
			return true
		}
		out = append(out, s601Edge{callee: sel.Sel.Name, recv: recv.Name, args: call.Args})
		return true
	})
	return out
}

// funcValueOfExpr 返回表达式 e 在 caller 体内**取值为哪些本包函数值**（本包函数名或
// 函数字面量的合成名）。
//
// 两个来源，顺序即优先级：
//
//	① e 是 caller 的**形参名** ⇒ 由调用点传进来的函数值（paramFuncs，不动点里增长）；
//	② 其余 ⇒ 局部绑定表（funcValueBindings）。
func (g *s601CallGraph) funcValueOfExpr(caller string, e ast.Expr) []string {
	fi := g.funcs[caller]
	if fi == nil {
		return nil
	}
	if id, ok := e.(*ast.Ident); ok {
		if idx := s601ParamIndex(fi.params, id.Name); idx >= 0 {
			return g.paramFuncs[caller][idx]
		}
	}
	return g.funcValueNames(e, g.funcValueBindings(caller), fi)
}

// funcValueNames 把表达式解析成"函数值名字集合"（不含形参转发 —— 那一层由
// funcValueOfExpr 负责，避免两者互相递归）。
func (g *s601CallGraph) funcValueNames(e ast.Expr, binds map[string][]string, fi *s601GraphFunc) []string {
	switch v := e.(type) {
	case *ast.Ident:
		if t, ok := binds[v.Name]; ok && len(t) > 0 {
			return t
		}
		if _, known := g.funcs[v.Name]; known {
			return []string{v.Name}
		}
	case *ast.FuncLit:
		return []string{s601FuncLitName(fi.file, fi.fset.Position(v.Pos()).Line)}
	case *ast.CallExpr:
		// 同族补集：**返回函数值的本包函数/方法**（`f := makeSkipper(); f(t, 月值)`、
		// `f := holder.premise(); f(t, 月值)`）。工厂形态与"局部绑定"只差一次调用，
		// 漏掉它等于把刚关掉的门换到隔壁（核验方 V-P5 §1④ 实测方法工厂也被漏掉）。
		for _, fnName := range s601FactoryNames(v.Fun, g) {
			return g.funcReturns(fnName, 0)
		}
	}
	return nil
}

// s601FactoryNames 把"工厂被调点"解析成本包函数/方法名：裸标识符工厂 `makeSkipper()`
// 与方法工厂 `holder.premise()` 都认（判据 E 的面内解析，名字按本包函数表判定；
// 方法名重名时取先见者 —— 与 callsFrom 的方法解析同一口径，重名会在 t.Logf 里登记）。
func s601FactoryNames(fun ast.Expr, g *s601CallGraph) []string {
	switch f := fun.(type) {
	case *ast.Ident:
		if _, known := g.funcs[f.Name]; known {
			return []string{f.Name}
		}
	case *ast.SelectorExpr:
		if _, known := g.funcs[f.Sel.Name]; known {
			return []string{f.Sel.Name}
		}
	}
	return nil
}

// s601FuncValueDepth 是"返回函数值的本包函数"的展开深度上限（工厂套工厂是可能的，
// 但每多一层收益递减；超过即停 —— 见文件末的边界清单）。
const s601FuncValueDepth = 2

// funcReturns 求"函数 fn 的 return 语句里出现的函数值名字"（递归解析工厂，深度 ≤
// s601FuncValueDepth；结果缓存）。
//
// 不跨闭包边界：闭包体里的 return 属于闭包，不属于本函数（与
// calendarSkipSitesInBody 的"不跨函数边界"同一条纪律）。环用"先占位再填"打断
// （自递归工厂返回 nil —— 那是保守的少跟，不会造成假红）。
func (g *s601CallGraph) funcReturns(fnName string, depth int) []string {
	if depth > s601FuncValueDepth {
		return nil
	}
	if v, ok := g.returns[fnName]; ok {
		return v
	}
	g.returns[fnName] = nil // 环保护：递归中的函数先记空
	fi := g.funcs[fnName]
	if fi == nil {
		return nil
	}
	var out []string
	ast.Inspect(fi.body, func(n ast.Node) bool {
		switch v := n.(type) {
		case *ast.FuncLit:
			return false // 闭包里的 return 不属于本函数
		case *ast.ReturnStmt:
			for _, r := range v.Results {
				if call, ok := r.(*ast.CallExpr); ok {
					if id, ok := call.Fun.(*ast.Ident); ok {
						if _, known := g.funcs[id.Name]; known {
							for _, t := range g.funcReturns(id.Name, depth+1) {
								out = appendUniqueString(out, t)
							}
							continue
						}
					}
				}
				for _, t := range g.funcValueOfExpr(fnName, r) {
					out = appendUniqueString(out, t)
				}
			}
		}
		return true
	})
	sort.Strings(out)
	g.returns[fnName] = out
	return out
}

// appendUniqueString 追加去重（保持稳定：由调用方在末尾 sort）。
func appendUniqueString(list []string, s string) []string {
	if s == "" {
		return list
	}
	for _, have := range list {
		if have == s {
			return list
		}
	}
	return append(list, s)
}

// funcValueBindings 求某函数体内"标识符（含复合字面量字段名）→ 函数值名字集合"的
// 局部绑定表（`f := pkgFn` / `var f = func(…){}` / `h := holder{skip: pkgFn}` / 传递绑定）。
//
// 只依赖 AST（不看调用点）⇒ 可缓存；迭代到不动点是为了覆盖 `g := f; h := g` 这样的链
// （Go 的声明顺序本来就让链无环，多迭代几轮只是保守）。
func (g *s601CallGraph) funcValueBindings(fnName string) map[string][]string {
	if b, ok := g.bindings[fnName]; ok {
		return b
	}
	b := map[string][]string{}
	fi := g.funcs[fnName]
	if fi != nil {
		for iter := 0; iter < 8; iter++ {
			changed := false
			ast.Inspect(fi.body, func(n ast.Node) bool {
				switch v := n.(type) {
				case *ast.AssignStmt:
					for i, rhs := range v.Rhs {
						targets := g.funcValueNames(rhs, b, fi)
						if len(targets) == 0 {
							continue
						}
						var lhs ast.Expr
						switch {
						case len(v.Lhs) == 1:
							lhs = v.Lhs[0]
						case i < len(v.Lhs):
							lhs = v.Lhs[i]
						default:
							continue
						}
						if id, ok := lhs.(*ast.Ident); ok && id.Name != "_" {
							if s601AddBinding(b, id.Name, targets) {
								changed = true
							}
						}
					}
				case *ast.ValueSpec:
					for i, rhs := range v.Values {
						if i >= len(v.Names) {
							continue
						}
						if s601AddBinding(b, v.Names[i].Name, g.funcValueNames(rhs, b, fi)) {
							changed = true
						}
					}
				case *ast.CompositeLit:
					// 结构体字段里的函数值：`holder{skip: pkgFn}` ⇒ 字段名 `skip`
					// 成为"函数值名字"，供 `h.skip(...)` 的选择子分支使用。
					for _, elt := range v.Elts {
						kv, ok := elt.(*ast.KeyValueExpr)
						if !ok {
							continue
						}
						key, ok := kv.Key.(*ast.Ident)
						if !ok {
							continue
						}
						if s601AddBinding(b, key.Name, g.funcValueNames(kv.Value, b, fi)) {
							changed = true
						}
					}
				}
				return true
			})
			if !changed {
				break
			}
		}
	}
	g.bindings[fnName] = b
	return b
}

// s601AddBinding 把 targets 并进 binds[name]（去重、稳定排序）；有新增返回 true。
func s601AddBinding(binds map[string][]string, name string, targets []string) bool {
	if name == "" || len(targets) == 0 {
		return false
	}
	changed := false
	for _, t := range targets {
		if t == "" {
			continue
		}
		dup := false
		for _, have := range binds[name] {
			if have == t {
				dup = true
				break
			}
		}
		if !dup {
			binds[name] = append(binds[name], t)
			sort.Strings(binds[name])
			changed = true
		}
	}
	return changed
}

// computeFuncValueArgs 求"形参 → 调用点传进来的函数值"的不动点（单调增长，集合只增）。
//
// 为什么必须是不动点：`helper(t, fn)` 里 `fn` 本身可能就是**另一个** helper 的形参
// （链式转发）。每轮把新解出的函数值灌进 paramFuncs，直到不再变化。
//
// 复杂度上界：迭代次数以"集合大小不再变化"为准（典型 2–3 轮），另有 2N+4 的硬上限
// 防止实现出错时死循环（N = 图里的函数数）。
func (g *s601CallGraph) computeFuncValueArgs() {
	limit := 2*len(g.funcs) + 4
	for iter := 0; iter < limit; iter++ {
		changed := false
		for name := range g.funcs {
			for _, e := range g.edgesFrom(name) {
				if e.callee == "" {
					continue
				}
				for i, arg := range e.args {
					for _, fv := range g.funcValueOfExpr(name, arg) {
						if g.addParamFunc(e.callee, i, fv) {
							changed = true
						}
					}
				}
			}
		}
		if !changed {
			break
		}
	}
}

// addParamFunc 记下"函数 fn 的第 idx 个形参可能收到函数值 fv"；有新增返回 true。
func (g *s601CallGraph) addParamFunc(fn string, idx int, fv string) bool {
	if fv == "" || idx < 0 {
		return false
	}
	entry := g.paramFuncs[fn]
	if entry == nil {
		entry = map[int][]string{}
		g.paramFuncs[fn] = entry
	}
	for _, have := range entry[idx] {
		if have == fv {
			return false
		}
	}
	entry[idx] = append(entry[idx], fv)
	sort.Strings(entry[idx])
	return true
}

// s601RecvName 返回方法接收者名（函数返回空串）。
func s601RecvName(fn *ast.FuncDecl) string {
	if fn.Recv == nil || len(fn.Recv.List) == 0 || len(fn.Recv.List[0].Names) == 0 {
		return ""
	}
	return fn.Recv.List[0].Names[0].Name
}

// ---------------------------------------------------------------------------
// C. 结构级：扫描面里不得出现"日历派生 ⇒ skip"（豁免逐条登记，键含条件源码）
// ---------------------------------------------------------------------------

// calendarDerivedSkipRegistration 是一条被允许保留的"条件里含日期派生值"的 skip。
//
// 键 = `file|fn|cond`（cond 是**规范化空白后的条件源码**）：豁免只对**这一条条件**生效。
// 在同一个已登记函数里再塞一条不同条件的 skip ⇒ 新键未登记 ⇒ 红；
// 再塞一条**同条件**的 skip ⇒ sites 计数不符 ⇒ 红（S6-01 Gap-3）。
type calendarDerivedSkipRegistration struct {
	file  string // 文件名（不含目录）
	fn    string // 所在测试函数
	cond  string // 触发条件源码（规范化空白，逐字；不截断）
	sites int    // 该条件下**期望**的 t.Skip* 调用点数（≥1；多一个/少一个都红）
	why   string // 为什么它不是"由日历取值决定是否跳过"
}

// calendarDerivedSkipRegistry 是判据 C 的**豁免登记表**（双向对拍 + 计数对拍）。
//
// 只在一种情况下可以登记：skip 的真实判据是**环境能力/负载**（自校准），
// 日期派生值只是顺带出现在条件里（例如由夹具月拼出的关系名）。
// **"某个日期区间不跑"永远不构成登记理由** —— 那种形态必须修夹具本身。
var calendarDerivedSkipRegistry = []calendarDerivedSkipRegistration{
	{
		file:  "audit_r11_i4_bounds_test.go",
		fn:    "TestR11I4FreezeCommitHangIsBounded",
		cond:  "baseErr != nil || i4PartitionAttached(t, db, rel)",
		sites: 1,
		why: "自校准：真实判据是 baseErr（把冻结预算缩到 4s 后，一轮**不注入**的正常清理" +
			"在本机/当前负载下能否跑完）——由机器与负载决定，与日期无关。" +
			"条件里的 rel 是由夹具月拼出的**关系名**（只用于查关系是否还挂在 usage 下），" +
			"它是污点分析里「字符串由日期派生」的形态，不参与是否跳过的判断。",
	},
}

// calendarTaintSources 是"值来自**当前日历**"的直接源（函数内可见的形态）。
// 只列与"今天"有关的：`time.Date(固定年月)`、`time.LoadLocation`、`time.Local`
// 之类的形态**不算**（它们由 TZ/tzdata 环境决定，是允许的自校准 skip）。
var calendarTaintSources = map[string]bool{
	"bjToday": true, "bjDay": true, "bjMonth": true, "BeijingNow": true,
}

// calendarTaintTimeMethods 是 time 包上"读到**绝对当前时刻**"的方法。
//
// **只列 `Now`**：`time.Since/Until` 返回的是 `time.Duration`（一段时长），**不可能**
// 派生年月日 —— 用时长比较决定跳过属于"计时精度自校准"（本仓允许的自校准类）。
// 2026-10-04 S6-01 Gap-4 把扫描面从 4 个目录扩到整个服务端后实测：把 `Since/Until`
// 当源会多报 1 处（`internal/capabilities/typefilter_perf_test.go:129` 的
// `small <= 0 || large <= 0`，`small/large` 是 `time.Since` 量出的耗时）。
// 这与对抗验证报告 §2.2 对同一处的独立判定一致：不是日历派生。
var calendarTaintTimeMethods = map[string]bool{"Now": true}

// calendarScanRoots 是扫描面的**根**（相对本包目录）：`server/internal` 与 `server/cmd`。
// 覆盖面由 calendarSkipScanDirRegistry 逐目录登记 + 判据 F 双向对拍守住（S6-01 Gap-4）。
var calendarScanRoots = []string{"..", filepath.Join("..", "..", "cmd")}

// calendarSkipScanDirRegistry 是扫描面的**逐目录登记表**（判据 F 与派生枚举双向对拍）。
//
// 为什么不是"4 个常量目录"（S6-01 Gap-4）：覆盖面本身就是判据的一部分，写死在一行
// 字面量里时，"新包落在面外"与"目录被删导致面缩小"两种变化都没有任何提示。
// 新增任何含测试面文件的目录都必须在这里加一行 —— 代价是复核者会被强制看到覆盖面的变化。
var calendarSkipScanDirRegistry = []string{
	"../../cmd/picoaide-wasm-imports-gen",
	"../../cmd/server",
	"../agentshare",
	"../appstore",
	"../archiveutil",
	"../auditchain",
	"../auditretention",
	"../balance",
	"../bootstrap",
	"../capabilities",
	"../channel",
	"../clientrelease",
	"../connectors",
	"../llmgateway",
	"../llmgateway/channels",
	"../marketplace",
	"../portal",
	"../reports",
	"../router",
	"../serverauth",
	"../serverstore",
	"../sharedskills",
	"../skillmanifest",
	"../telemetry",
	"../tokenretention",
	"../updatecheck",
	"../usageretention",
	"../util",
	"../wasmapp/abi",
	"../wasmapp/api",
	"../wasmapp/appcfg",
	"../wasmapp/appdb",
	"../wasmapp/applimits",
	"../wasmapp/appproof",
	"../wasmapp/appseed",
	"../wasmapp/appserver",
	"../wasmapp/assets",
	"../wasmapp/cachetrust",
	"../wasmapp/compile",
	"../wasmapp/diag",
	"../wasmapp/edge",
	"../wasmapp/events",
	"../wasmapp/hostcap",
	"../wasmapp/limits",
	"../wasmapp/logbuf",
	"../wasmapp/memprofile",
	"../wasmapp/opens",
	"../wasmapp/queue",
	"../wasmapp/readyz",
	"../wasmapp/refapp",
	"../wasmapp/refapp/stdprobe",
	"../wasmapp/refapp/wasiprobe",
	"../wasmapp/registry",
	"../wasmapp/runtime",
	"../wasmapp/skillseed",
	"../wasmapp/upload",
	"../wasmapp/wasmmod",
}

// 扫描面下限（**回归网自身要有下限**：扫描面缩水或分析器失效必须 fail-loud，
// 而不是"零命中 ✅"）。数值取当前实测值向下留余量（实测值见判据 C/F 的 t.Logf）。
const (
	calendarSkipDirFloor       = 54   // 实测 57
	calendarSkipFileFloor      = 550  // 实测 579
	calendarSkipCallFloor      = 110  // 实测 117
	calendarSkipFuncFloor      = 4400 // 实测 4900 上下
	calendarSkipReachFuncFloor = 10   // 夹具可达调用图的下限（防分析面塌缩）
)

// TestCalendarDerivedSkipsAreRegistered 是判据 C（含双向登记对拍与调用点计数对拍）。
func TestCalendarDerivedSkipsAreRegistered(t *testing.T) {
	face := scanCalendarTestFace(t)
	hits, calls := scanCalendarFaceSkips(t, face)
	if calls < calendarSkipCallFloor {
		t.Fatalf("全扫描面只找到 %d 个 t.Skip* 调用点（下限 %d）—— 分析器自身失效时"+
			"必须红，不能给出「零命中」的假绿", calls, calendarSkipCallFloor)
	}

	registered := map[string]calendarDerivedSkipRegistration{}
	for _, reg := range calendarDerivedSkipRegistry {
		key := calendarSkipRegistryKey(reg.file, reg.fn, reg.cond)
		if _, dup := registered[key]; dup {
			t.Errorf("登记表里有重复条目 %s", key)
		}
		if strings.TrimSpace(reg.why) == "" {
			t.Errorf("登记条目 %s 没有理由 —— 豁免必须逐条说明", key)
		}
		if strings.TrimSpace(reg.cond) == "" {
			t.Errorf("登记条目 %s 没有条件源码 —— 豁免键必须含**条件**，"+
				"否则同一函数里新增的任何 skip 都会被一并豁免（S6-01 Gap-3）", key)
		}
		if reg.sites < 1 {
			t.Errorf("登记条目 %s 的 sites=%d —— 必须写明期望的 skip 调用点数（≥1）", key, reg.sites)
		}
		registered[key] = reg
	}

	seen := map[string]int{}
	for _, h := range hits {
		key := calendarSkipRegistryKey(h.file, h.fn, h.guardKey)
		seen[key]++
		if _, ok := registered[key]; !ok {
			t.Errorf("发现「条件由当前日历派生 ⇒ skip」的形态（%s:%d %s，条件=%s）："+
				"静默跳过等于判据在某些日期不存在 —— 请改夹具本身（日期派生收进唯一入口、"+
				"前提不成立时 fail-loud）；确实与日历取值无关的自校准才可登记进 "+
				"calendarDerivedSkipRegistry 并写明理由", h.file, h.line, h.fn, h.guard)
		}
	}
	for key, reg := range registered {
		got := seen[key]
		switch {
		case got == 0:
			t.Errorf("登记表条目 %s 在扫描面里已不存在（死条目：site 被删/改名/条件源码改动）—— "+
				"必须同步更新登记表，否则豁免会变成无人复核的洞", key)
		case got != reg.sites:
			t.Errorf("登记表条目 %s 期望 %d 个 t.Skip* 调用点，实得 %d 个 —— "+
				"在**已登记函数**里新增/删除 skip 分支同样必须重新复核豁免（S6-01 Gap-3：旧口径按 "+
				"file|fn 豁免，函数内任何新 skip 都自动免检）", key, reg.sites, got)
		}
	}
	t.Logf("扫描面 %d 个目录 / %d 个测试面文件 / %d 个 t.Skip* 调用点；日历派生命中 %d 处（登记 %d 条）",
		len(face.dirs), len(face.files), calls, len(hits), len(registered))
}

// calendarSkipRegistryKey 是豁免登记的唯一键构造点（判定、记账、对拍共用一个）。
func calendarSkipRegistryKey(file, fn, cond string) string {
	return file + "|" + fn + "|" + normalizeSource(cond)
}

// ---------------------------------------------------------------------------
// F. 结构级：扫描面逐目录登记（S6-01 Gap-4）
// ---------------------------------------------------------------------------

// TestCalendarSkipScanFaceIsRegistered 是判据 F：扫描面的**逐目录登记**与派生枚举
// 双向对拍 + 全局下限。
//
//	树里有、登记表里没有  ⇒ 红（新目录的日历派生 skip 静默落在面外）；
//	登记表里有、树里扫不到 ⇒ 红（目录被删/改名 ⇒ 覆盖面无声缩水）；
//	文件/函数/调用点低于下限 ⇒ 红（分析器失效时不能"零命中 ✅"）。
func TestCalendarSkipScanFaceIsRegistered(t *testing.T) {
	face := scanCalendarTestFace(t)

	if len(face.dirs) < calendarSkipDirFloor {
		t.Fatalf("扫描面只覆盖 %d 个目录（下限 %d）—— 目录被删/被排除都会让判据静默失效",
			len(face.dirs), calendarSkipDirFloor)
	}
	if len(face.files) < calendarSkipFileFloor {
		t.Fatalf("扫描面只有 %d 个测试面文件（下限 %d）—— 覆盖面缩水必须 fail-loud",
			len(face.files), calendarSkipFileFloor)
	}
	if face.funcs < calendarSkipFuncFloor {
		t.Fatalf("扫描面只解析到 %d 个函数（下限 %d）—— 分析器没真正走到树上，"+
			"不能给出「零命中」的假绿", face.funcs, calendarSkipFuncFloor)
	}

	derived := map[string]int{}
	for _, d := range face.dirs {
		derived[d]++
	}
	registered := map[string]bool{}
	for _, d := range calendarSkipScanDirRegistry {
		if registered[d] {
			t.Errorf("扫描面登记表里有重复目录 %s", d)
		}
		registered[d] = true
	}
	for _, d := range face.dirs {
		if !registered[d] {
			t.Errorf("目录 %s 里有测试面文件，但没登记进 calendarSkipScanDirRegistry —— "+
				"该目录里的「日历派生 ⇒ skip」不会被发现，必须显式加一行（登记即复核覆盖面，S6-01 Gap-4）", d)
		}
	}
	for _, d := range calendarSkipScanDirRegistry {
		if derived[d] == 0 {
			t.Errorf("登记目录 %s 扫不到任何测试面文件（被删/改名/被排除？）—— "+
				"覆盖面无声缩水必须红，豁免不能靠「这条已不再生效」来自证（S6-01 Gap-4）", d)
		}
	}
	t.Logf("扫描面逐目录登记 %d 条，全部对拍一致；%d 个测试面文件 / %d 个函数",
		len(registered), len(face.files), face.funcs)
}

// ---------------------------------------------------------------------------
// 扫描面与 AST 工具（判据 C/E/F 共用）
// ---------------------------------------------------------------------------

// calendarFace 是一次扫描的结果：逐目录计数 + 全部测试面文件。
type calendarFace struct {
	dirs  []string // 规范化（ToSlash(Clean)）的目录路径，升序
	files []calendarFaceFile
	funcs int
}

type calendarFaceFile struct {
	dir  string
	base string
	fset *token.FileSet
	file *ast.File
}

// scanCalendarTestFace 枚举扫描面：calendarScanRoots 下所有含**测试面文件**的目录。
//
// 测试面 = `*_test.go` ∪ **导入了 testing 的 .go**（测试辅助文件，如
// serverstore/dbtest.go 的 "no PG ⇒ skip"）：只看后缀会漏掉这一类，
// 而它们同样跑在 go test 里、同样能静默关掉判据。
func scanCalendarTestFace(t *testing.T) *calendarFace {
	t.Helper()
	for _, root := range calendarScanRoots {
		if _, err := os.Stat(root); err != nil {
			t.Fatalf("扫描面根缺失 %s: %v —— 缺项必须 fail-loud", root, err)
		}
	}
	face := &calendarFace{}
	perDir := map[string]int{}
	for _, root := range calendarScanRoots {
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				if d.Name() == "testdata" || d.Name() == "node_modules" {
					return fs.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") {
				return nil
			}
			fset := token.NewFileSet()
			file, perr := parser.ParseFile(fset, path, nil, parser.ParseComments)
			if perr != nil {
				return fmt.Errorf("解析 %s: %w", path, perr)
			}
			if !strings.HasSuffix(path, "_test.go") && !fileImportsTesting(file) {
				return nil
			}
			dir := filepath.ToSlash(filepath.Clean(filepath.Dir(path)))
			perDir[dir]++
			face.funcs += countFuncDecls(file)
			face.files = append(face.files, calendarFaceFile{
				dir: dir, base: filepath.Base(path), fset: fset, file: file,
			})
			return nil
		})
		if err != nil {
			t.Fatalf("扫描 %s: %v", root, err)
		}
	}
	for d := range perDir {
		face.dirs = append(face.dirs, d)
	}
	sort.Strings(face.dirs)
	sort.Slice(face.files, func(i, j int) bool {
		if face.files[i].dir != face.files[j].dir {
			return face.files[i].dir < face.files[j].dir
		}
		return face.files[i].base < face.files[j].base
	})
	return face
}

// scanCalendarFaceSkips 在扫描面上跑判据 C 的**函数内**污点分析。
func scanCalendarFaceSkips(t *testing.T, face *calendarFace) (hits []calendarSkipHit, calls int) {
	t.Helper()
	for _, f := range face.files {
		h, c := scanFileCalendarSkips(f.fset, f.file, f.base)
		hits = append(hits, h...)
		calls += c
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].file != hits[j].file {
			return hits[i].file < hits[j].file
		}
		return hits[i].line < hits[j].line
	})
	return hits, calls
}

func countFuncDecls(file *ast.File) int {
	n := 0
	for _, decl := range file.Decls {
		if fn, ok := decl.(*ast.FuncDecl); ok && fn.Body != nil {
			n++
		}
	}
	return n
}

// calendarSkipHit 是一次"日历派生条件 ⇒ skip"的命中。
type calendarSkipHit struct {
	file     string // 文件名（不含目录）
	fn       string // 所在函数
	line     int
	guard    string // 触发条件源码（截断，供人读）
	guardKey string // 触发条件源码（规范化、不截断）—— 登记表的对拍键
}

func scanFileCalendarSkips(fset *token.FileSet, file *ast.File, base string) (hits []calendarSkipHit, calls int) {
	timePkg := timePkgAlias(file)
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		h, c := calendarSkipSitesInBody(fset, fn.Body, nil, timePkg, base, fn.Name.Name)
		hits = append(hits, h...)
		calls += c
	}
	return hits, calls
}

// calendarSkipSitesInBody 返回 body 内全部 `t.Skip*` 调用点里"任一祖先条件被污染"的那些。
//
// 分析口径：被污染的名字 = 形参/种子（seedEnv，判据 E 用）与**在该 skip 调用点之前**
// 由 `time.Now` 或 `bjToday/bjDay/bjMonth/BeijingNow` 直接/间接（经赋值链）派生的局部
// 名字。**按程序位置取快照**（而不是"全函数收集一遍再检查每个守卫"）是必需的：
// 后者会把"先赋值后判条件"的精度换来一类假红 —— 实测 `cmd/server/opens_repair_test.go`
// 的 `loc, err := time.LoadLocation(...)` / `if err != nil { t.Skipf }` 会因为函数体
// **后面**的 `from, to, perr := parseOpensRepairRange(..., time.Now())` 把 `err` 染上
// 日历污点，从而把一处 tzdata 能力 skip 误报成日历派生 skip。
//
// 误报方向仍是"多报"（宁可让人来登记），漏报方向只到"跨函数间接派生"。
func calendarSkipSitesInBody(fset *token.FileSet, body *ast.BlockStmt, seedEnv map[string]bool,
	timePkg, base, fnName string) (hits []calendarSkipHit, calls int) {
	parents := map[ast.Node]ast.Node{}
	var stack []ast.Node
	ast.Inspect(body, func(n ast.Node) bool {
		if n == nil {
			stack = stack[:len(stack)-1]
			return true
		}
		if len(stack) > 0 {
			parents[n] = stack[len(stack)-1]
		}
		stack = append(stack, n)
		return true
	})
	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok || !isTestSkipCall(call) {
			return true
		}
		calls++
		env := map[string]bool{}
		for k, v := range seedEnv {
			env[k] = v
		}
		calendarTaintAssignsBefore(body, env, timePkg, call.Pos())
		for p := parents[call]; p != nil; p = parents[p] {
			switch p.(type) {
			case *ast.FuncDecl, *ast.FuncLit:
				return true // 不跨函数边界
			}
			var cond ast.Node
			switch v := p.(type) {
			case *ast.IfStmt:
				cond = v.Cond
			case *ast.ForStmt:
				cond = v.Cond
			case *ast.RangeStmt:
				cond = v.X
			case *ast.SwitchStmt:
				cond = v.Tag
			}
			if cond != nil && calendarCondTainted(cond, env, timePkg) {
				hits = append(hits, calendarSkipHit{
					file: base, fn: fnName, line: fset.Position(call.Pos()).Line,
					guard: renderExpr(fset, cond), guardKey: renderSource(fset, cond),
				})
				return true
			}
		}
		return true
	})
	return hits, calls
}

// ---------------------------------------------------------------------------
// 调用点绑定（判据 D）的工具
// ---------------------------------------------------------------------------

// directCalleeName 返回"裸标识符被调"的名字：`f(...)` ⇒ "f"；
// `x.f(...)` / `pkg.F(...)` ⇒ ""（不算直接调用）。
func directCalleeName(call *ast.CallExpr) string {
	if id, ok := call.Fun.(*ast.Ident); ok {
		return id.Name
	}
	return ""
}

// directCallsTo 返回 body 里对 name 的**直接**调用点。
func directCallsTo(body *ast.BlockStmt, name string) []*ast.CallExpr {
	var out []*ast.CallExpr
	ast.Inspect(body, func(n ast.Node) bool {
		if call, ok := n.(*ast.CallExpr); ok && directCalleeName(call) == name {
			out = append(out, call)
		}
		return true
	})
	return out
}

// astContainsDirectCall 判断表达式里是否出现了对 name 的直接调用。
func astContainsDirectCall(n ast.Node, name string) bool {
	found := false
	ast.Inspect(n, func(x ast.Node) bool {
		if found {
			return false
		}
		if call, ok := x.(*ast.CallExpr); ok && directCalleeName(call) == name {
			found = true
			return false
		}
		return true
	})
	return found
}

// boundNamesOf 返回"收下该调用点返回值"的赋值/短变量声明左侧名字。
func boundNamesOf(body *ast.BlockStmt, call *ast.CallExpr) []string {
	var out []string
	ast.Inspect(body, func(n ast.Node) bool {
		switch v := n.(type) {
		case *ast.AssignStmt:
			for _, rhs := range v.Rhs {
				if rhs != ast.Expr(call) {
					continue
				}
				for _, lhs := range v.Lhs {
					if id, ok := lhs.(*ast.Ident); ok {
						out = append(out, id.Name)
					}
				}
			}
		case *ast.ValueSpec:
			for _, val := range v.Values {
				if val != ast.Expr(call) {
					continue
				}
				for _, nm := range v.Names {
					out = append(out, nm.Name)
				}
			}
		}
		return true
	})
	return out
}

// s601TimeishMethods 是 time.Time 上"把值当年月日/时刻用"的方法 —— 判据 D 用它判断
// 一个日历派生值**是否真的被当月值使用**（精度要求，见 calendarDerivedLocalsOutsideSeam）。
var s601TimeishMethods = map[string]bool{
	"Year": true, "Month": true, "Day": true, "Weekday": true, "YearDay": true,
	"Before": true, "After": true, "Equal": true, "Compare": true, "AddDate": true,
	"Add": true, "Sub": true, "Format": true, "IsZero": true,
	"UTC": true, "In": true, "Local": true, "Location": true,
	"Unix": true, "UnixNano": true, "Truncate": true, "Round": true,
}

// monthSinkNames 从函数体**派生**"月值汇点"：任何直接调用（裸标识符被调）里出现了
// 裸标识符实参 ∈ pinned ⇒ 该调用点承接夹具月值。再并入 binding 声明的 consumers/extraSinks。
//
// 为什么从代码派生而不是写死清单：夹具怎么变，汇点就跟着变；写死的清单会在夹具重构时
// 静默失效（漏报方向）。`t.Fatalf("…", x)` 这类选择子调用天然不在面内（`directCalleeName`
// 只认裸标识符被调），所以"把派生值打进错误消息"不会被误判成月值用途。
func monthSinkNames(body *ast.BlockStmt, pinned map[string]bool, consumers, extra []string) map[string]bool {
	sinks := map[string]bool{}
	for _, c := range consumers {
		sinks[c] = true
	}
	for _, c := range extra {
		sinks[c] = true
	}
	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		name := directCalleeName(call)
		if name == "" {
			return true
		}
		for _, arg := range call.Args {
			if id, ok := arg.(*ast.Ident); ok && pinned[id.Name] {
				sinks[name] = true
			}
		}
		return true
	})
	return sinks
}

// monthishUseOf 判断 name 是否被当作月值使用（汇点调用的裸标识符实参，或 time-ish 方法接收者）。
func monthishUseOf(name string, body *ast.BlockStmt, sinks map[string]bool) bool {
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		if found {
			return false
		}
		switch v := n.(type) {
		case *ast.CallExpr:
			if id, ok := v.Fun.(*ast.Ident); ok && sinks[id.Name] {
				for _, a := range v.Args {
					if ai, ok := a.(*ast.Ident); ok && ai.Name == name {
						found = true
						return false
					}
				}
			}
		case *ast.SelectorExpr:
			if id, ok := v.X.(*ast.Ident); ok && id.Name == name && s601TimeishMethods[v.Sel.Name] {
				found = true
				return false
			}
		}
		return true
	})
	return found
}

// calendarDerivedLocalsOutsideSeam 返回函数体里"由当前日历派生、**没有**经过 seam 调用、
// 且**真的被当月值使用**"的局部名。三个条件缺一不可：
//
//   - 由日历派生：RHS 里出现日历源或已污染的名字；
//   - 不经过 seam：RHS 里含对 seam 的直接调用 ⇒ 视为干净源（夹具月的唯一合法来路）；
//   - 被当月值使用：见 monthishUseOf。
//
// 第三条是**精度**要求而不是放宽：`err := RebuildUsageLedger(db, windowFrom, time.Now())`
// 的 RHS 含 `time.Now()`，但 `err` 只是个错误值 —— 只看前两条的老口径会把它误报成
// "在调用点重新派生年月"（实测：真实夹具 `audit_r5a_retention_test.go` 就会假红）。
//
// 代价（如实登记）：日历派生值若**只**出现在错误消息里（`t.Fatalf("…%v", x)`）或赋值给
// 一个从不进入月值汇点的名字，本判据不报。那类形态不会重新引入 S6-01 的缺陷
// （缺陷的后果是"夹具前提静默失效"，必须经过月值）。
func calendarDerivedLocalsOutsideSeam(fset *token.FileSet, body *ast.BlockStmt, seam, timePkg string,
	sinks map[string]bool) []string {
	var out []string
	env := map[string]bool{}
	ast.Inspect(body, func(n ast.Node) bool {
		var lhs []ast.Expr
		var rhs []ast.Expr
		switch v := n.(type) {
		case *ast.AssignStmt:
			lhs, rhs = v.Lhs, v.Rhs
		case *ast.ValueSpec:
			for _, nm := range v.Names {
				lhs = append(lhs, nm)
			}
			rhs = v.Values
		default:
			return true
		}
		sanitized := false
		for _, r := range rhs {
			if astContainsDirectCall(r, seam) {
				sanitized = true
			}
		}
		for i, l := range lhs {
			id, ok := l.(*ast.Ident)
			if !ok || id.Name == "_" {
				continue
			}
			var tainted bool
			switch {
			case sanitized:
				tainted = false // 入口返回值是干净源
			case len(rhs) == len(lhs):
				tainted = calendarExprTainted(rhs[i], env, timePkg)
			default:
				for _, r := range rhs {
					if calendarExprTainted(r, env, timePkg) {
						tainted = true
					}
				}
			}
			if tainted {
				env[id.Name] = true
				if monthishUseOf(id.Name, body, sinks) {
					out = append(out, fmt.Sprintf("%s（%s）", id.Name, renderExpr(fset, id)))
				}
			} else {
				env[id.Name] = false
			}
		}
		return true
	})
	return dedupeStrings(out)
}

// consumerArgsOutsidePinned 返回 consumers 调用点里"裸标识符实参不来自入口返回值"的清单。
func consumerArgsOutsidePinned(body *ast.BlockStmt, consumers []string, pinned map[string]bool) []string {
	want := map[string]bool{}
	for _, c := range consumers {
		want[c] = true
	}
	var out []string
	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok || !want[directCalleeName(call)] {
			return true
		}
		for _, arg := range call.Args {
			id, ok := arg.(*ast.Ident)
			if !ok || id.Name == "_" {
				continue
			}
			if !pinned[id.Name] {
				out = append(out, fmt.Sprintf("%s(%s)", directCalleeName(call), id.Name))
			}
		}
		return true
	})
	return dedupeStrings(out)
}

func dedupeStrings(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

// ---------------------------------------------------------------------------
// 污点分析核心（判据 C/E 共用）
// ---------------------------------------------------------------------------

// calendarTaintAssignsBefore 在已有 env（可带形参/种子）上做赋值链传播，只处理
// **位置早于 before** 的赋值语句（before 为 `token.NoPos` 时处理全部）。
func calendarTaintAssignsBefore(body *ast.BlockStmt, env map[string]bool, timePkg string, before token.Pos) {
	ast.Inspect(body, func(n ast.Node) bool {
		if n == nil {
			return true
		}
		if before.IsValid() && n.Pos() >= before {
			return false // 该语句整体在阈值之后：不处理、也不深入
		}
		var lhs []ast.Expr
		var rhs []ast.Expr
		switch v := n.(type) {
		case *ast.AssignStmt:
			lhs, rhs = v.Lhs, v.Rhs
		case *ast.ValueSpec:
			for _, nm := range v.Names {
				lhs = append(lhs, nm)
			}
			rhs = v.Values
		default:
			return true
		}
		tainted := false
		for _, r := range rhs {
			if calendarExprTainted(r, env, timePkg) {
				tainted = true
			}
		}
		if !tainted {
			return true
		}
		for _, l := range lhs {
			if id, ok := l.(*ast.Ident); ok {
				env[id.Name] = true
			}
		}
		return true
	})
}

func calendarCondTainted(cond ast.Node, env map[string]bool, timePkg string) bool {
	found := false
	ast.Inspect(cond, func(n ast.Node) bool {
		if found {
			return false
		}
		switch v := n.(type) {
		case *ast.FuncLit:
			// 闭包体不是"这个值"的一部分（它在被调用时才求值）：`measure := func() { st := time.Now() }`
			// 不会让 `measure` 本身变成日历派生值。实测（S6-01 Gap-4 扩面后）不排除闭包会把
			// `internal/capabilities/typefilter_perf_test.go` 的计时闭包误染成污染源。
			return false
		case *ast.CallExpr:
			if calendarCalleeIsSource(v.Fun, timePkg) {
				found = true
			}
		case *ast.Ident:
			if env[v.Name] {
				found = true
			}
		}
		return !found
	})
	return found
}

func calendarExprTainted(e ast.Expr, env map[string]bool, timePkg string) bool {
	return calendarCondTainted(e, env, timePkg)
}

// calendarCalleeIsSource 判断调用点是不是"日历取值源"。
func calendarCalleeIsSource(fun ast.Expr, timePkg string) bool {
	switch f := fun.(type) {
	case *ast.Ident:
		return calendarTaintSources[f.Name]
	case *ast.SelectorExpr:
		if id, ok := f.X.(*ast.Ident); ok && timePkg != "" && id.Name == timePkg {
			return calendarTaintTimeMethods[f.Sel.Name]
		}
	}
	return false
}

// timePkgAlias 返回本文件里 time 包的本地名（未导入返回空串）。
func timePkgAlias(file *ast.File) string {
	for _, imp := range file.Imports {
		if imp.Path == nil || imp.Path.Value != `"time"` {
			continue
		}
		if imp.Name != nil {
			return imp.Name.Name
		}
		return "time"
	}
	return ""
}

func isTestSkipCall(call *ast.CallExpr) bool {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	switch sel.Sel.Name {
	case "Skip", "Skipf", "SkipNow":
		return true
	}
	return false
}

// fileImportsTesting 判断该文件是否导入了 testing（即"测试面文件"，即使没有
// `_test.go` 后缀 —— dbtest.go 这类测试辅助文件就是这种形态）。
func fileImportsTesting(file *ast.File) bool {
	for _, imp := range file.Imports {
		if imp.Path != nil && imp.Path.Value == `"testing"` {
			return true
		}
	}
	return false
}

func parseTestFile(t *testing.T, fset *token.FileSet, file string) *ast.File {
	t.Helper()
	parsed, err := parser.ParseFile(fset, file, nil, parser.ParseComments)
	if err != nil {
		t.Fatalf("解析 %s: %v", file, err)
	}
	return parsed
}

func findTestFunc(t *testing.T, parsed *ast.File, file, fn string) *ast.FuncDecl {
	t.Helper()
	for _, decl := range parsed.Decls {
		d, ok := decl.(*ast.FuncDecl)
		if ok && d.Name.Name == fn {
			return d
		}
	}
	t.Fatalf("%s 里找不到函数 %s（改名/删除必须同步本判据）", file, fn)
	return nil
}

func parseTestFunc(t *testing.T, fset *token.FileSet, file, fn string) *ast.FuncDecl {
	t.Helper()
	return findTestFunc(t, parseTestFile(t, fset, file), file, fn)
}

// renderSource 把 AST 节点渲染成**规范化空白后的源码文本**（不截断）——
// 登记键与命中键共用同一份渲染（`calendarSkipRegistryKey` 还会再归一化一次）。
func renderSource(fset *token.FileSet, e ast.Node) string {
	var b strings.Builder
	if err := printer.Fprint(&b, fset, e); err != nil {
		return "<unprintable>"
	}
	return normalizeSource(b.String())
}

// normalizeSource 规范化空白。
func normalizeSource(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

func renderExpr(fset *token.FileSet, e ast.Node) string {
	s := renderSource(fset, e)
	const max = 90
	if len(s) > max {
		s = s[:max] + "…"
	}
	return s
}

// ---------------------------------------------------------------------------
// 边界（如实登记，勿读作"全覆盖"）
// ---------------------------------------------------------------------------
//
//  1. **判据 D 的 D4 只看裸标识符实参**：`monthKey(mBad.AddDate(0,-2,0))` 这种复合
//     表达式不会被 D4 判红（若 mBad 来自入口，这种写法在语义上仍是"从夹具月派生"，
//     属未覆盖形态；若 mBad 来自 `bjMonth`，D3 会先判红）。
//  2. **判据 E 跟裸标识符调用 + 本包方法调用**（`x.m(...)`：按方法名解析，接收者带污点
//     时才把接收者名记为污染；2026-10-04 的取证探针 X1/X2 证明"日历派生值装进结构体、
//     经方法转发 skip"能同时躲开 D 的 monthish-use 与"只跟裸标识符调用"的旧 E，故补上）。
//     **函数值流也已进入面内**（2026-10-04 的 S6-M8b 实证：`var f = pkgFn; f(t, 月值)`
//     让旧 E 整条丢边 ⇒ 原缺陷每年 120 天静默复活，而 A/B/C/D 全绿）。收口五类：
//     局部绑定（含传递绑定）、函数字面量（绑定 / 立即调用 / 作实参转发）、形参转发
//     （`helper(t, pkgFn)` → helper 里 `fn(...)`）、结构体字段里的函数值、以及
//     **返回函数值的本包工厂**（`f := makeSkipper()` 与 `makeSkipper()(t,…)`，
//     深度 ≤2）。工厂的**方法**形态（`f := holder.premise()` / `holder.premise()(t,…)`）
//     由核验方 V-P5 §1④ 实测补上（第一版只解析 `CallExpr{Fun: *ast.Ident}` ⇒
//     方法工厂整体在面外，夹具逐字 SKIP 而判据全绿）。
//     **仍不进入面内**：跨包调用（`pkg.F(...)`）、**接收者非裸标识符**的接口方法
//     （`x().m(…)` / `pkg.X.m(…)` / `holder().m(…)`；接收者是**裸标识符**的 `v.m(…)`
//     按方法名解析 ⇒ 咬得住，核验方 V-P12 §P3-3 实测）、反射、map 里取出的函数值、
//     经**包级变量**中转的函数值、经通道/切片等容器中转的函数值、工厂套工厂超过 2 层；
//     深度上限 3 跳；本包同名方法（`Error`/`Exec`/`Query` 等）按名取先见者，重名会在
//     t.Logf 里登记。
//     这些残余要靠 go/types（类型信息）才能收口 —— 本判据的取舍是"把已经**实证**
//     可绕过的那一类关掉，并把关不掉的逐条写清楚"。
//     E 的污染源含"夹具月"（入口返回值绑定的名字），因此"由夹具月决定要不要跳过"的
//     任何形态都会红；而**环境能力类** skip（无 PG、无 tzdata、`-short`）的守卫与夹具月
//     无关，设计上不命中（反向对照：把函数值转发的目标换成环境守卫，判据必须保持绿）。
//  3. **判据 C 只做函数内污点传播**：经包内 helper 间接派生、且**不在夹具调用图里**
//     的 skip（例如 `expired := expiredMonthPartitions(t, db)` 里的日期）不在咬合面内。
//     本包该类形态只有 `usage_retention_isolation_test.go:122` 一处，已人工核对
//     （测试库分区窗口固定起点 ⇒ 计数随时间单调不减，不会随日历开始跳过）。
//     跨函数形态由判据 E 在"夹具可达"这一子图上覆盖。
//  4. **判据 C/F 的扫描面 = `server/internal` + `server/cmd` 下 `*_test.go` ∪ 导入
//     testing 的 `.go`**，不解析 build tag；被 build tag 排除的文件同样会被扫到
//     （只会多报）。生产文件（不导入 testing）不在面内 —— 它们不参与 go test 的
//     跳过语义。扫描面由判据 F 逐目录登记 + 下限守住。
//  5. 登记表 `calendarDerivedSkipRegistry` 是"允许的例外"：新增条目需要人写理由、
//     条件源码与调用点数（三向对拍会强制复核）。这是有意的设计（豁免必须显式、
//     可复核），也意味着**未来有人可以给自己登记豁免** —— 与全仓其它登记表同等风险。
