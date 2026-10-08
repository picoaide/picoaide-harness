package applimits_test

import (
	"bytes"
	"fmt"
	"log"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/appdb"
	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/memprofile"
	"github.com/picoaide/picoaide/internal/wasmapp/readyz"
)

// 本文件是「平台限制项」模型的门禁：默认值等于编译期常量、档位折算、范围校验、
// 四笔账。变异验证（交付时实跑过，勿删）：
//   - 把 Validate 的 AppRunning 上界判断去掉 ⇒ TestValidateRejectsInconsistent 必红；
//   - 把 Budget 的实例池改成常量 ⇒ TestBudgetFollowsLimits 必红；
//   - 去掉 FromProfile 的 clampCrossField ⇒ TestFromProfileStaysSelfConsistent 必红
//     （small 档会给出 app_running=4 > max_instances=3 这种自身非法的组合）；
//   - 把 AppDBReaders 的取值区间去掉 ⇒ TestAppDBReadersRange 必红。
//
// "哪些改动要重启"的判据**不在这里**：它按"运行时生效值 vs 目标值"判定，唯一落点是
// appserver.ApplyLimits（见 limits_apply.go），回归在 appserver 的
// TestApplyLimitsDoesNotAskForRestartWhenAssemblyAlreadyUsedTheValue。

// TestDefaultsMatchCompileTimeConstants：默认值必须与 limits 逐值一致
// （"不配置任何东西"的部署行为不变）。
func TestDefaultsMatchCompileTimeConstants(t *testing.T) {
	d := applimits.Defaults()
	if d.MaxInstances != limits.GlobalInstances {
		t.Fatalf("max_instances=%d，limits.GlobalInstances=%d", d.MaxInstances, limits.GlobalInstances)
	}
	if d.AppRunning != limits.AppRuntimeConcurrency {
		t.Fatalf("app_running=%d，limits.AppRuntimeConcurrency=%d", d.AppRunning, limits.AppRuntimeConcurrency)
	}
	if d.AppQueue != limits.AppQueueDepth {
		t.Fatalf("app_queue=%d，limits.AppQueueDepth=%d", d.AppQueue, limits.AppQueueDepth)
	}
	if want := limits.InstanceMemoryPages * limits.WasmPageSize >> 20; d.InstanceMemoryMB != want {
		t.Fatalf("instance_memory_mb=%d，期望 %d", d.InstanceMemoryMB, want)
	}
	if want := int(limits.ModuleCacheMaxBytes >> 20); d.ModuleCacheMB != want {
		t.Fatalf("module_cache_mb=%d，期望 %d", d.ModuleCacheMB, want)
	}
	if d.InstanceMemoryPages() != limits.InstanceMemoryPages {
		t.Fatalf("页数换算不一致：%d vs %d", d.InstanceMemoryPages(), limits.InstanceMemoryPages)
	}
	// 只读连接数：默认必须等于 limits.AppDBReaders（=4），且不得越上限。
	if d.AppDBReaders != limits.AppDBReaders {
		t.Fatalf("app_db_readers=%d，limits.AppDBReaders=%d", d.AppDBReaders, limits.AppDBReaders)
	}
	if d.AppDBReaders < 1 || d.AppDBReaders > limits.AppDBReadersMax {
		t.Fatalf("app_db_readers=%d 落在 [1,%d] 之外", d.AppDBReaders, limits.AppDBReadersMax)
	}
}

// TestFromProfile：档位折算（small 档的并发/实例/缓存进限制项）。
func TestFromProfile(t *testing.T) {
	l := applimits.FromProfile(memprofile.Small())
	if l.MaxInstances != 3 {
		t.Fatalf("small 档并发应为 3，得到 %d", l.MaxInstances)
	}
	if l.InstanceMemoryMB != 64 {
		t.Fatalf("small 档单实例上限应为 64 MiB，得到 %d", l.InstanceMemoryMB)
	}
	if l.ModuleCacheMB != 64 {
		t.Fatalf("small 档模块缓存应为 64 MiB，得到 %d", l.ModuleCacheMB)
	}
	// small 档在 992 MiB 机器上必须通过四笔账（与启动自检同一判据）。
	if b := l.Budget(992 << 20); !b.OK {
		t.Fatalf("small 档应通过 992 MiB 水位：total=%dMiB limit=%dMiB", b.Total>>20, b.Limit>>20)
	}
}

// TestParseRejectsUnknownAndOutOfRange：未知字段与超范围都必须拒（fail-loud）。
func TestParseRejectsUnknownAndOutOfRange(t *testing.T) {
	if _, err := applimits.Parse(`{"max_instance":3}`); err == nil {
		t.Fatal("未知字段必须被拒（避免'改了没生效'的静默失败）")
	}
	if _, err := applimits.Parse(`{"max_instances":0}`); err == nil {
		t.Fatal("0 并发必须被拒")
	}
	if _, err := applimits.Parse(`{"instance_memory_mb":4}`); err == nil {
		t.Fatal("低于下限的实例内存必须被拒（Zig 初始内存 16.4 MiB）")
	}
	if _, err := applimits.Parse(`not json`); err == nil {
		t.Fatal("非法 JSON 必须被拒")
	}
	// 空串 = 回到默认（不是错误）。
	d, err := applimits.Parse("")
	if err != nil || d.MaxInstances != limits.GlobalInstances {
		t.Fatalf("空串应回落默认：%v %+v", err, d)
	}
	// 片段提交：必须点名**缺失字段**，而不是报成另一个字段超范围
	// （否则"只改了 instance_memory_mb"会收到"并发必须在 1–256"这种指错方向的错误）。
	fragErr, ferr := applimits.Parse(`{"instance_memory_mb":64}`)
	if ferr == nil {
		t.Fatal("片段提交必须被拒")
	}
	_ = fragErr
	if !strings.Contains(ferr.JSON(), `"missing":true`) || !strings.Contains(ferr.JSON(), "max_instances") {
		t.Fatalf("片段提交应点名缺失字段：%s", ferr.JSON())
	}

	// 往返：Encode → Parse 等值。
	l := applimits.FromProfile(memprofile.Small())
	back, err := applimits.Parse(l.Encode())
	if err != nil || back != l {
		t.Fatalf("编码往返不等值：%v %+v vs %+v", err, back, l)
	}
}

// TestValidateRejectsInconsistent：字段之间的序关系（单应用并发 ≤ 全局并发等）。
func TestValidateRejectsInconsistent(t *testing.T) {
	l := applimits.Defaults()
	l.MaxInstances = 4
	l.AppRunning = 8 // > 全局并发
	if err := l.Validate(); err == nil {
		t.Fatal("单应用并发大于全局并发必须被拒")
	}
	l = applimits.Defaults()
	l.UserPerAppRunning = 99
	if err := l.Validate(); err == nil {
		t.Fatal("单用户单应用并发大于单应用并发必须被拒")
	}
	l = applimits.Defaults()
	l.UserPerAppQueued = l.AppQueue + 1
	if err := l.Validate(); err == nil {
		t.Fatal("单用户排队上限大于应用队列必须被拒")
	}
}

// TestFromProfileStaysSelfConsistent：档位折算出来的限制项必须**自身合法**，
// 并且能被控制台原样保存回去（Encode → Parse 往返成功）。
//
// 为什么需要它（2026-09-19）：small 档把全局并发压到 3，而 app_running 的默认值是
// limits.AppRuntimeConcurrency（4）——不钳位就会得到 app_running(4) > max_instances(3)
// 这种非法组合：控制台 GET 出来的对象**永远保存不回去**（Validate 报"单应用并发必须在
// 1 与全局并发之间"），而 GET 到 PUT 正是控制台表单的实际动作。
func TestFromProfileStaysSelfConsistent(t *testing.T) {
	for _, p := range []memprofile.Profile{memprofile.Default(), memprofile.Small(), memprofile.Large()} {
		l := applimits.FromProfile(p)
		if err := l.Validate(); err != nil {
			t.Fatalf("档位 %s 折算出的限制项自身非法：%v（%s）", p.Name, err, l.Encode())
		}
		if l.AppRunning > l.MaxInstances {
			t.Fatalf("档位 %s：app_running=%d > max_instances=%d（必须钳位）", p.Name, l.AppRunning, l.MaxInstances)
		}
		if l.UserGlobalRunning > l.MaxInstances {
			t.Fatalf("档位 %s：user_global_running=%d > max_instances=%d（必须钳位）",
				p.Name, l.UserGlobalRunning, l.MaxInstances)
		}
		if l.UserPerAppRunning > l.AppRunning {
			t.Fatalf("档位 %s：user_per_app_running=%d > app_running=%d", p.Name, l.UserPerAppRunning, l.AppRunning)
		}
		// 控制台的实际动作：GET 出来的 limits 原样 PUT 回去必须成功。
		back, err := applimits.Parse(l.Encode())
		if err != nil {
			t.Fatalf("档位 %s：折算值无法原样保存（GET→PUT 会失败）：%v", p.Name, err)
		}
		if back != l {
			t.Fatalf("档位 %s：编码往返不等值：%+v vs %+v", p.Name, back, l)
		}
	}
	// small 档的具体钳位结果（4 → 3）：档位没有被"向上放大"，只是被压到全局并发之内。
	if l := applimits.FromProfile(memprofile.Small()); l.AppRunning != 3 {
		t.Fatalf("small 档 app_running 应被钳到 3（全局并发），得到 %d", l.AppRunning)
	}
}

// TestAppDBReadersRange：只读连接数的取值区间（1..limits.AppDBReadersMax）必须真闸住，
// 且**不要求重启**（语义是"下一个应用库句柄生效"，与 appdb_cache_kib 同档）。
func TestAppDBReadersRange(t *testing.T) {
	r, ok := applimits.Ranges()["app_db_readers"]
	if !ok {
		t.Fatal("app_db_readers 必须在 Ranges() 里（否则控制台表单拿不到边界）")
	}
	if r.Min != 1 || r.Max != limits.AppDBReadersMax {
		t.Fatalf("app_db_readers 区间 = [%d,%d]，want [1,%d]", r.Min, r.Max, limits.AppDBReadersMax)
	}
	if r.Restart {
		t.Fatal("app_db_readers 不该标注需重启：它只影响下一个新建的句柄（与 appdb_cache_kib 同档）")
	}
	for _, bad := range []int{0, -1, limits.AppDBReadersMax + 1} {
		l := applimits.Defaults()
		l.AppDBReaders = bad
		if err := l.Validate(); err == nil {
			t.Fatalf("app_db_readers=%d 必须被拒", bad)
		} else if field, _ := err.Details["field"].(string); field != "app_db_readers" {
			t.Fatalf("app_db_readers=%d 被报成字段 %q（指错方向）", bad, field)
		}
	}
	// 边界值本身必须被接受（少一个都说明区间写错了）。
	good := applimits.Defaults()
	for _, n := range []int{1, limits.AppDBReaders, limits.AppDBReadersMax} {
		good.AppDBReaders = n
		if err := good.Validate(); err != nil {
			t.Fatalf("app_db_readers=%d 应被接受：%v", n, err)
		}
	}
}

// TestBudgetIgnoresAppRunning：四笔账与**每应用并发无关**（决策文档
// docs/decisions/2026-09-19-wasm-app-concurrency-default.md 的口径：
// "调大 app_running 不增加内存上界"）。
//
// 机制：实例池那笔账的乘数是 max_instances（全局并发），不是 app_running；
// app_running 被 Validate 约束为 ≤ max_instances ⇒ 改它动不了任何一笔账。
// 变异：把 BudgetFor 的 Instances 换成 AppRunning ⇒ 本用例必红。
func TestBudgetIgnoresAppRunning(t *testing.T) {
	base := applimits.Defaults()
	base.MaxInstances = 8
	base.AppRunning = 1
	b1 := base.Budget(8 << 30)
	base.AppRunning = 8
	b2 := base.Budget(8 << 30)
	if b1.Total != b2.Total || b1.Instances != b2.Instances {
		t.Fatalf("app_running 改变了四笔账：%d vs %d（实例池 %d vs %d）—— "+
			"实例池的乘数必须是 max_instances", b1.Total, b2.Total, b1.Instances, b2.Instances)
	}
}

// TestParseStoredIsForwardCompatible：**读取**已落库的设置必须前向兼容
// （缺字段补默认、未知字段忽略），否则升级会把管理员保存过的整份设置判为非法。
//
// 现场形态（本次要防的）：v2.7.6-beta.4 的 `settings.wasm.limits` 里没有
// `app_db_readers`（那时还不是字段）—— 用严格 Parse 去读，得到"限制项缺少字段"，
// 启动日志一条"已保存的平台限制项不合法，已回落到部署档位"，随后并发/内存全部
// 变回档位值：管理员看到的是"我的设置没了"。
//
// 变异：把 ParseStored 的实现换成 Parse ⇒ 本用例第一个断言必红。
func TestParseStoredIsForwardCompatible(t *testing.T) {
	// 旧版本（没有 app_db_readers）落库的完整对象：已知字段必须逐字保留。
	const oldSetting = `{"max_instances":8,"app_running":2,"app_queue":16,` +
		`"user_global_running":2,"user_per_app_running":1,"user_per_app_queued":2,` +
		`"instance_memory_mb":64,"module_cache_mb":64,"module_cache_idle_min":10,` +
		`"appdb_idle_min":3,"appdb_cache_kib":512}`
	l, err := applimits.ParseStored(oldSetting)
	if err != nil {
		t.Fatalf("旧版本落库的设置必须仍能读出（前向兼容）：%v", err)
	}
	if l.MaxInstances != 8 || l.AppRunning != 2 || l.AppQueue != 16 || l.AppDBCacheKiB != 512 {
		t.Fatalf("已知字段必须逐字保留，得到 %s", l.Encode())
	}
	if l.AppDBReaders != limits.AppDBReaders {
		t.Fatalf("缺失的新字段应补默认 %d，得到 %d", limits.AppDBReaders, l.AppDBReaders)
	}
	// 严格 Parse 仍然拒绝它（控制台 PUT 的"必须提交完整对象"纪律不变）。
	if _, perr := applimits.Parse(oldSetting); perr == nil {
		t.Fatal("严格 Parse 必须仍拒绝缺字段的提交（PUT 纪律不能放宽）")
	}

	// 回滚场景：设置里有老二进制不认识的字段 ⇒ 忽略它，已知字段仍生效。
	const withUnknown = `{"max_instances":8,"app_running":2,"app_queue":16,` +
		`"user_global_running":2,"user_per_app_running":1,"user_per_app_queued":2,` +
		`"instance_memory_mb":64,"module_cache_mb":64,"module_cache_idle_min":10,` +
		`"appdb_idle_min":3,"appdb_cache_kib":512,"app_db_readers":8,"future_knob":123}`
	l2, err := applimits.ParseStored(withUnknown)
	if err != nil {
		t.Fatalf("含未知字段的设置必须仍能读出（回滚场景）：%v", err)
	}
	if l2.MaxInstances != 8 || l2.AppDBReaders != 8 {
		t.Fatalf("已知字段（含新字段）必须保留、未知字段忽略，得到 %s", l2.Encode())
	}

	// 校验不打折：补齐后的整份值仍要过 Validate。
	if _, err := applimits.ParseStored(`{"max_instances":0}`); err == nil {
		t.Fatal("补齐后仍非法的设置必须被拒")
	}
	if _, err := applimits.ParseStored(`not json`); err == nil {
		t.Fatal("非法 JSON 必须被拒")
	}
	// 空串 = 默认（与 Parse 同语义）。
	if d, err := applimits.ParseStored(""); err != nil || d != applimits.Defaults() {
		t.Fatalf("空串应回落默认：%v %+v", err, d)
	}
}

// ===== FW-1（2026-10-04）：存储读取路径不得因**新加的校验**丢掉整份已保存设置 =====

// oldLibraryWith 造一份"旧版本控制台保存过"的对象：六个时间预算按**当时**的默认值
// （host_call = sql = 5 s，见 limits 的历史值）落库，其余字段用当前默认。
func oldLibraryWith(mut func(*applimits.Limits)) applimits.Limits {
	l := applimits.Defaults()
	l.HostCallBudgetSeconds = 5
	l.SQLStatementBudgetSeconds = 5
	if mut != nil {
		mut(&l)
	}
	return l
}

// TestParseStoredLegalizesOldLibraryCombos 是 FW-1 的核心判据（"旧库形态"）。
//
// 现场形态：本轮给 SQL 预算加了"必须**严格小于**宿主调用预算"（S4-02），而在此之前两个
// 默认值都是 5 s ⇒ 任何在那条规则之前点过「保存」的部署，库里存的都是 `host_call=5 / sql=5`
// （webadmin 的 PUT 是整份覆盖）。读取路径若照旧"只 Validate"，5>=5 命中新分支 ⇒ 整份设置
// 被判非法 ⇒ 上层（newWasmLimitsHolder）回落到部署档位：管理员保存过的
// max_instances / module_cache_mb / instance_memory_mb / 全部时间预算一次性失效，
// 而且回落方向不可控（管理员为小内存机调小的并发会被档位放大）。
//
// 选定口径：**只收紧内层** —— host_call 保持管理员存的值 5 s 不动，sql 钳到
// host_call−1 = 4 s（同时满足"严格小于外层"与"严格大于 busy timeout 3 s"）。
// 为什么不把 host_call 抬到新默认 10 s：那是**放宽**一条执行期闸门（宿主调用 5 s → 10 s），
// 而"钳位只往下、从不放大外层"是本包已经写死的方向（见 clampCrossField 的注释与
// TestBudgetFieldsAreClampedNotWidened）；sql 5→4 是唯一既保住管理员存值、又不放大任何
// 闸门的方向。
func TestParseStoredLegalizesOldLibraryCombos(t *testing.T) {
	// ① 最典型的旧库形态：原样保存（两个默认值相等）。
	old := oldLibraryWith(nil)
	l, err := applimits.ParseStored(old.Encode())
	if err != nil {
		t.Fatalf("旧库形态（sql=5, host_call=5）必须仍能读出，否则整份设置回落档位：%v（%s）", err, err.JSON())
	}
	want := old
	want.SQLStatementBudgetSeconds = 4
	if l != want {
		t.Fatalf("合法化结果不符：\n got %s\nwant %s", l.Encode(), want.Encode())
	}
	// "整份设置不被丢弃"的含义：除被钳的那一项外，管理员存的值逐字保留。
	if l.MaxInstances != old.MaxInstances || l.InstanceMemoryMB != old.InstanceMemoryMB ||
		l.ModuleCacheMB != old.ModuleCacheMB || l.HostCallBudgetSeconds != old.HostCallBudgetSeconds {
		t.Fatalf("除被钳的 sql 外，其余字段必须逐字保留：%s", l.Encode())
	}
	// 结果必须自身合法，且**控制台 GET→PUT 的往返**必须成立（否则管理员连别的字段都改不动，
	// 因为表单提交的是整份对象）。
	if verr := l.Validate(); verr != nil {
		t.Fatalf("合法化结果必须自身合法：%v（%s）", verr, verr.JSON())
	}
	if back, perr := applimits.Parse(l.Encode()); perr != nil || back != l {
		t.Fatalf("合法化结果必须能被控制台原样保存回去（GET→PUT）：%v", perr)
	}

	// ② 另一个"新规则"形态：`sql` 必须严格大于 SQLite 的 busy timeout（3 s）——
	//    这条规则之前它的范围校验只有 1–300 ⇒ sql ∈ {1,2,3} 是能存进库的。
	for _, storedSQL := range []int{1, 2, 3} {
		raw := oldLibraryWith(func(l *applimits.Limits) { l.SQLStatementBudgetSeconds = storedSQL }).Encode()
		got, aerr := applimits.ParseStored(raw)
		if aerr != nil {
			t.Fatalf("旧库形态（sql=%d）必须仍能读出：%v", storedSQL, aerr)
		}
		if floor := 4; got.SQLStatementBudgetSeconds != floor {
			t.Fatalf("sql=%d 应抬到下限 %d（busy timeout 3 s 之上），得到 %d",
				storedSQL, floor, got.SQLStatementBudgetSeconds)
		}
		if got.HostCallBudgetSeconds != 5 {
			t.Fatalf("sql=%d：不得为了合法化而改动外层 host_call，得到 %d", storedSQL, got.HostCallBudgetSeconds)
		}
		if verr := got.Validate(); verr != nil {
			t.Fatalf("sql=%d 合法化后必须合法：%v", storedSQL, verr.Message)
		}
	}

	// ③ 边界（如实登记）：host_call ≤ busy timeout+1(=4) 时，"sql > 3"与"sql < host_call"
	//    没有整数解 —— 唯一出路是把**外层**闸门放大，而那是本包明确拒绝的方向。
	//    这种组合只能靠管理员刻意填出（默认值不会产生），因此仍判非法；
	//    上层会回落到档位并打出那条 warning —— 不是静默。
	//
	//    字段归属（2026-10-08 变更）：拒绝**点名 host_call_budget_seconds**，不再点名 sql。
	//    原因：这一组值里 host_call=4 本身就已经越出可行区间（它必须严格大于单条 SQL 的
	//    可行下限 4 ⇒ 至少 5），范围判据先于序关系分支命中，点名的正是"必须先改的那一格"。
	//    旧形态点名 sql 只是因为序关系分支排在范围判据之后 —— 管理员照着"sql 不对"去调
	//    sql，而 sql 怎么调都没有解。**判据的实质未变**：仍判非法、仍不靠放大外层闸门合法化。
	bad := oldLibraryWith(func(l *applimits.Limits) {
		l.HostCallBudgetSeconds = 4
		l.SQLStatementBudgetSeconds = 3
	})
	if _, aerr := applimits.ParseStored(bad.Encode()); aerr == nil {
		t.Fatal("无合法解的旧组合（sql=3 / host_call=4）必须仍被判非法：合法化不得靠放大外层闸门")
	} else if got := fmt.Sprint(aerr.Details["field"]); got != "host_call_budget_seconds" {
		t.Fatalf("拒绝理由必须点名 host_call_budget_seconds（这一格才是先要改的），得到 %q（%s）", got, aerr.Message)
	}
}

// TestConsolePutStaysStrictOnOldLibraryCombos：**写入路径不许跟着放宽**（FW-1 的另一半）。
//
// 读取路径为了不丢配置会把 5/5 合法化成 4/5，但控制台 PUT 走的是 Parse ——
// 同一份 JSON 必须被**拒**，且点名 sql_statement_budget_seconds。否则"新写入的非法组合仍被
// 挡住"这条承诺就没了：管理员可以再存一次 5/5，之后每次升级都靠读取路径的钳位兜着，
// 而库里那条非法组合永远不会被纠正。
//
// 变异验证：把 Parse 改成也走 legalizeStored ⇒ 本用例前两个断言必红。
func TestConsolePutStaysStrictOnOldLibraryCombos(t *testing.T) {
	old := oldLibraryWith(nil) // host_call=5, sql=5
	_, err := applimits.Parse(old.Encode())
	if err == nil {
		t.Fatal("控制台 PUT 必须仍拒绝 sql == host_call（写入路径不得合法化）")
	}
	if got := fmt.Sprint(err.Details["field"]); got != "sql_statement_budget_seconds" {
		t.Fatalf("拒绝理由必须点名 sql_statement_budget_seconds，得到 %q（%s）", got, err.Message)
	}
	// 同一个"新规则"的另一半：sql 不大于 busy timeout 也必须被写入路径拒。
	low := oldLibraryWith(func(l *applimits.Limits) { l.SQLStatementBudgetSeconds = 3 })
	if _, err := applimits.Parse(low.Encode()); err == nil {
		t.Fatal("控制台 PUT 必须仍拒绝 sql ≤ busy timeout(3 s)")
	}
	// 正控（有路可走）：只把 sql 调到 host_call−1，同一份对象必须能存 ——
	// 证明拒的是那条序关系，不是"凡是旧对象一律拒"这种让管理员无路可走的更粗行为。
	ok := oldLibraryWith(func(l *applimits.Limits) { l.SQLStatementBudgetSeconds = 4 })
	if _, err := applimits.Parse(ok.Encode()); err != nil {
		t.Fatalf("把 sql 调到 4（host_call−1）之后必须能保存：%v", err)
	}
}

// TestParseStoredLogsLegalization：合法化必须留痕（钳位可接受，**静默**不可接受）。
//
// 为什么这条是判据而不是"日志锦上添花"：合法化之后，控制台显示的值（生效值）与
// settings 表里存的值不再相同；没有这一行，运维只能看到"我设的 5 s 怎么变成 4 s 了"
// 而无处可查。判据同时钉住字段名与原值→生效值（可检索），并带**负控** ——
// 无需合法化时不得打这条日志（否则留痕退化成噪音，真出事时没人看）。
func TestParseStoredLogsLegalization(t *testing.T) {
	out := captureStdLog(t, func() {
		if _, err := applimits.ParseStored(oldLibraryWith(nil).Encode()); err != nil {
			t.Fatalf("旧库形态必须能读出：%v", err)
		}
	})
	if !strings.Contains(out, "合法化") || !strings.Contains(out, "sql_statement_budget_seconds 5→4") {
		t.Fatalf("必须留下可检索的合法化日志（含字段与原值→生效值），实得：%q", out)
	}
	quiet := captureStdLog(t, func() {
		if _, err := applimits.ParseStored(applimits.Defaults().Encode()); err != nil {
			t.Fatalf("默认值必须能读出：%v", err)
		}
	})
	if strings.Contains(quiet, "合法化") {
		t.Fatalf("无需合法化时不得打这条日志（否则留痕变成噪音）：%q", quiet)
	}
}

// captureStdLog 抓取标准 logger 在 fn 期间写出的内容（fn 返回或 t.Fatal 退出都会还原）。
//
// 本文件的用例都不并行（没有 t.Parallel），所以临时替换标准 logger 的输出是安全的；
// 每个包在独立进程里跑，也不会波及其它包。
func captureStdLog(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prev)
	fn()
	return buf.String()
}

// TestBudgetFollowsLimits：四笔账随限制项变化（不是常量）。
func TestBudgetFollowsLimits(t *testing.T) {
	const available = 992 << 20
	small := applimits.Defaults()
	small.MaxInstances = 3
	small.InstanceMemoryMB = 64
	small.ModuleCacheMB = 64
	b := small.Budget(available)
	// 192（实例池）+256（编译峰值）+118（上传峰值）+64（模块缓存）+15（页缓存：
	// 3 句柄 × (1+4) 条连接 × 1 MiB）= 645 MiB。
	if want := int64(645 << 20); b.Total != want {
		t.Fatalf("small 组合 total=%dMiB，期望 %dMiB", b.Total>>20, want>>20)
	}
	if !b.OK {
		t.Fatalf("small 组合应通过：limit=%dMiB", b.Limit>>20)
	}
	big := small
	big.MaxInstances = 32
	if b2 := big.Budget(available); b2.OK {
		t.Fatalf("32 并发不该通过 992 MiB 机器：total=%dMiB limit=%dMiB", b2.Total>>20, b2.Limit>>20)
	}
	// 读不到可用内存 ⇒ 只算不判（部署文档兜底）；**0 与"未知"必须区分**（R1-rt-1）。
	if b3 := big.Budget(readyz.MemoryUnknown); !b3.OK || b3.Known {
		t.Fatalf("可用内存读不到时应只算不判且 Known=false：%+v", b3)
	}
	if b4 := big.Budget(0); b4.OK || !b4.Known {
		t.Fatal("可用内存为 0 必须判定失败（0 ≠ 未知）")
	}
}

// TestBudgetIncludesAppDBPageCache 是 R1-rt-8 的核心判据：SQLite 页缓存必须进账。
//
// 现场：BudgetFor 只算 5 项里的 4 项（实例池/编译峰值/上传峰值/模块缓存），
// 而控制台允许 appdb_cache_kib=65536 + app_db_readers=16 + max_instances=256 ⇒
// (1+16) × 64 MiB × 256 ≈ 272 GiB 的理论常驻，保存判据却仍然 ok:true。
//
// 变异：把 BudgetFor 里的 AppDBPageCachePerHandleBytes 去掉（或让
// AppDBPageCachePerHandleBytes 恒返回 0）⇒ 本用例两个断言必红。
func TestBudgetIncludesAppDBPageCache(t *testing.T) {
	// ① 默认档的账面必须含页缓存这一笔，且等于 (1+readers) × cache_kib × instances。
	def := applimits.Defaults()
	b := def.Budget(8 << 30)
	wantPerHandle := int64(1+def.AppDBReaders) * int64(def.AppDBCacheKiB) << 10
	if want := int64(def.MaxInstances) * wantPerHandle; b.AppDBCache != want {
		t.Fatalf("页缓存这笔 = %d MiB，期望 %d MiB（%d 句柄 × %d MiB）",
			b.AppDBCache>>20, want>>20, def.MaxInstances, wantPerHandle>>20)
	}
	if b.Total != b.Instances+b.CompilePeak+b.UploadPeak+b.CacheResident+b.AppDBCache {
		t.Fatalf("总账必须含页缓存这笔：%+v", b)
	}
	if b.AppDBCache == 0 {
		t.Fatal("页缓存这笔不得为 0（0 等于没算）")
	}

	// ② 极大组合：64 MiB 页缓存 × 17 条连接 × 256 句柄 ≈ 272 GiB ⇒ 保存必须被拒。
	huge := def
	huge.MaxInstances = applimits.MaxInstances
	huge.AppDBCacheKiB = applimits.MaxAppDBCacheKiB
	huge.AppDBReaders = limits.AppDBReadersMax
	if err := huge.Validate(); err != nil {
		t.Fatalf("这组值本身必须是合法的（否则测的就不是保存判据）：%v", err)
	}
	const physical = 32 << 30 // 32 GiB 物理内存：任何真实机器上这组配置都该被拒
	if hb := huge.Budget(physical); hb.OK {
		t.Fatalf("272 GiB 级页缓存组合在 32 GiB 机器上必须判失败：total=%dGiB limit=%dGiB",
			hb.Total>>30, hb.Limit>>30)
	}
	// ③ "四笔账放行、加上页缓存才被拒"的对照 —— 证明这笔真的进了判定，而不是被 Total 漏掉。
	//    8 句柄 × 17 条连接 × 64 MiB = 8704 MiB 页缓存；实例内存保持默认 64 MiB。
	small := def
	small.MaxInstances = 8
	small.AppDBCacheKiB = applimits.MaxAppDBCacheKiB
	small.AppDBReaders = limits.AppDBReadersMax
	const avail = 12 << 30 // 水位 = 12 GiB × 70% = 8.4 GiB
	sb := small.Budget(avail)
	fourAccounts := sb.Instances + sb.CompilePeak + sb.UploadPeak + sb.CacheResident
	if fourAccounts > sb.Limit {
		t.Fatalf("前置：不含页缓存的四笔账 %d MiB 已超水位 %d MiB，本用例断言不到页缓存那一笔",
			fourAccounts>>20, sb.Limit>>20)
	}
	if sb.OK {
		t.Fatalf("四笔账 %d MiB 放行、加上页缓存 %d MiB 后必须被拒：total=%d MiB limit=%d MiB",
			fourAccounts>>20, sb.AppDBCache>>20, sb.Total>>20, sb.Limit>>20)
	}
	if sb.Total != fourAccounts+sb.AppDBCache {
		t.Fatalf("Total 必须等于四笔账 + 页缓存：%+v", sb)
	}
}

// TestDefaultAppDBCacheKiBMatchesAppDB：页缓存的"每条连接默认值"是三处共用的一个数
// （appdb 的 PRAGMA 默认、applimits.Defaults、readyz 的兜底估算），必须同值。
//
// 变异：把任一处改成别的数字（例如 applimits 的 defaultAppDBCacheKiB 改成 2048）⇒ 本用例必红。
func TestDefaultAppDBCacheKiBMatchesAppDB(t *testing.T) {
	if got, want := applimits.Defaults().AppDBCacheKiB, appdb.ConnCacheKiB(); got != want {
		t.Fatalf("applimits 默认页缓存 %d KiB ≠ appdb 生效默认 %d KiB（两处漂移会让账面与实际不符）", got, want)
	}
	wantPerHandle := int64(1+limits.AppDBReaders) * int64(appdb.ConnCacheKiB()) << 10
	if got := readyz.DefaultAppDBPageCachePerHandleBytes; got != wantPerHandle {
		t.Fatalf("readyz 的每句柄页缓存兜底 = %d，期望 %d（口径必须与 appdb+limits 一致）", got, wantPerHandle)
	}
}

// TestRangesCoverEveryField：区间表必须覆盖全部字段（新增字段忘了配区间会被抓住）。
func TestRangesCoverEveryField(t *testing.T) {
	ranges := applimits.Ranges()
	for _, f := range applimits.FieldNames() {
		r, ok := ranges[f]
		if !ok {
			t.Fatalf("字段 %s 缺少取值区间（前端表单会拿不到边界）", f)
		}
		if r.Min > r.Max || r.Unit == "" {
			t.Fatalf("字段 %s 的区间不合法：%+v", f, r)
		}
	}
	if len(ranges) != len(applimits.FieldNames()) {
		t.Fatalf("区间表有冗余项：range=%d field=%d", len(ranges), len(applimits.FieldNames()))
	}
	// 字段名同时是 JSON 契约：Encode 后每个字段名都应出现（防止 tags 漂移）。
	enc := applimits.Defaults().Encode()
	for _, f := range applimits.FieldNames() {
		if !strings.Contains(enc, `"`+f+`"`) {
			t.Fatalf("JSON 里缺少字段 %s：%s", f, enc)
		}
	}
}

// ===== 时间预算（2026-10-01：从编译期常量收进控制台）=====

// TestBudgetDefaultsMatchCompileTimeConstants 钉住"不配置任何东西"的部署行为与
// limits 包逐值一致（尤其是现场要求的两个放宽：guest 30 s / 干跑与它同值）。
func TestBudgetDefaultsMatchCompileTimeConstants(t *testing.T) {
	d := applimits.Defaults()
	if d.GuestBudget() != limits.GuestBudget {
		t.Errorf("guest_budget_seconds 默认值 = %s，limits.GuestBudget = %s", d.GuestBudget(), limits.GuestBudget)
	}
	if d.GuestBudget() != 30*time.Second {
		t.Errorf("guest 预算默认值必须是 30 s（2026-10-01 现场要求：PDF 类应用单请求要重新编码整份文档），实得 %s", d.GuestBudget())
	}
	if d.DryRunBudget() != d.GuestBudget() {
		t.Errorf("干跑预算默认值（%s）必须等于 guest 预算（%s）：预检不得比真实执行更严",
			d.DryRunBudget(), d.GuestBudget())
	}
	if d.HostCallBudget() != limits.HostCallBudgetDefault {
		t.Errorf("host_call_budget_seconds 默认值 = %s，limits 常量 = %s", d.HostCallBudget(), limits.HostCallBudgetDefault)
	}
	if d.WallClock() != limits.RequestWallClock {
		t.Errorf("request_wall_clock_seconds 默认值 = %s，limits 常量 = %s", d.WallClock(), limits.RequestWallClock)
	}
	if d.SQLStatementBudget() != limits.SQLStatementBudget {
		t.Errorf("sql_statement_budget_seconds 默认值 = %s，limits 常量 = %s", d.SQLStatementBudget(), limits.SQLStatementBudget)
	}
	if d.CompileTimeout() != limits.CompileTimeout {
		t.Errorf("compile_timeout_seconds 默认值 = %s，limits 常量 = %s", d.CompileTimeout(), limits.CompileTimeout)
	}
}

// TestBudgetValidateRejectsBrokenOrdering 是本次新增的**保存期序关系**判据。
//
// 为什么必须在保存路径上再判一遍：这五条序关系过去只写在 limits 包的编译期测试里
// （limits_gen_test.go 的 TestCriticalValuesAndOrdering）。数值一旦可由控制台改，
// 编译期断言就管不到线上组合 —— 控制台可以把 guest 调到 120 s 而墙钟留在 60 s，
// 于是每个慢应用都被墙钟先拒，界面上却一切正常。
//
// 变异方式（实测每条都能红）：把 Validate 里对应的 case 删掉 ⇒ 该子用例必红。
func TestBudgetValidateRejectsBrokenOrdering(t *testing.T) {
	cases := []struct {
		name  string
		mut   func(*applimits.Limits)
		field string
	}{
		{"墙钟不大于 guest", func(l *applimits.Limits) { l.RequestWallClockSeconds = l.GuestBudgetSeconds }, "request_wall_clock_seconds"},
		{"墙钟小于 guest", func(l *applimits.Limits) { l.RequestWallClockSeconds = l.GuestBudgetSeconds - 1 }, "request_wall_clock_seconds"},
		{"干跑大于 guest", func(l *applimits.Limits) { l.DryRunBudgetSeconds = l.GuestBudgetSeconds + 1 }, "dry_run_budget_seconds"},
		{"宿主调用大于 guest", func(l *applimits.Limits) { l.HostCallBudgetSeconds = l.GuestBudgetSeconds + 1 }, "host_call_budget_seconds"},
		{"单条 SQL 大于墙钟", func(l *applimits.Limits) { l.SQLStatementBudgetSeconds = l.RequestWallClockSeconds + 1 }, "sql_statement_budget_seconds"},
		// S4-02：内层（单条 SQL）必须**严格小于**外层（宿主调用）。两条都列：
		// 相等是最容易发生的形态（两个默认值曾经都是 5 s），大于则是"内层更长"。
		{"单条 SQL 等于宿主调用", func(l *applimits.Limits) {
			l.SQLStatementBudgetSeconds = l.HostCallBudgetSeconds
		}, "sql_statement_budget_seconds"},
		{"单条 SQL 大于宿主调用", func(l *applimits.Limits) {
			l.SQLStatementBudgetSeconds = l.HostCallBudgetSeconds - 1
			l.HostCallBudgetSeconds = l.SQLStatementBudgetSeconds - 1
		}, "sql_statement_budget_seconds"},
		{"宿主调用小于等于单条 SQL（只动外层）", func(l *applimits.Limits) {
			// 反向改法：管理员只把宿主调用调小（SQL 保持默认 5 s）—— 同样必须被拒，
			// 否则外层先到点、应用拿到 HOST_CALL_OVER_BUDGET 而不是 DB_DENIED。
			l.HostCallBudgetSeconds = l.SQLStatementBudgetSeconds
		}, "sql_statement_budget_seconds"},
		// 注：`编译超时 > ReadTimeout` 与 `单条 SQL ≤ busy timeout` 这两条**不在这里**了 ——
		// 自 2026-10-08 起它们由范围判据收口（上下界就是这两条规则推出来的），
		// 用例搬到了 TestBudgetValidateRejectsOutOfRange（字段归属不变）。
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			l := applimits.Defaults()
			c.mut(&l)
			err := l.Validate()
			if err == nil {
				t.Fatalf("这一组必须被拒（否则界面上一切正常、线上被另一条闸门先拒）")
			}
			if got := fmt.Sprint(err.Details["field"]); got != c.field {
				t.Fatalf("拒绝理由必须点名出错的字段：want %s，got %s（%s）", c.field, got, err.Message)
			}
		})
	}

	// 正控：默认值必须通过（否则上表全绿也可能只是"Validate 恒拒"）。
	//
	// 再加一条**具体关系**的正控：默认组合必须满足内层严格小于外层（S4-02）。
	// 只有"默认值合法"这一句时，把两个默认值都改回 5 s 也是绿的 —— 而那正是本次
	// 要修的形态（相等 ⇒ 父 ctx 先到点、错误码指错方向）。
	d := applimits.Defaults()
	if d.SQLStatementBudgetSeconds >= d.HostCallBudgetSeconds {
		t.Fatalf("默认组合必须满足 sql(%d s) < host_call(%d s)：内层不小于外层时语句超时永远被外层遮住",
			d.SQLStatementBudgetSeconds, d.HostCallBudgetSeconds)
	}
	if d.HostCallBudgetSeconds > d.GuestBudgetSeconds {
		t.Fatalf("默认 host_call(%d s) 不得大于 guest(%d s)", d.HostCallBudgetSeconds, d.GuestBudgetSeconds)
	}
	if err := d.Validate(); err != nil {
		t.Fatalf("默认值必须合法：%v", err.Message)
	}
}

// TestBudgetValidateRejectsOutOfRange 钉住六项的取值区间。
//
// 2026-10-08 起这里判的是**有效区间**（`Ranges()` 下发到控制台表单的那一份，
// 由 applimits.effectiveBudgetBounds 从序关系推出），不再是"基础区间 + 后面的序关系分支"：
// 现场形态是控制台把编译超时那一格写成 1–300，而服务端一律拒收 > 60 ——
// 管理员照着提示填 90，点保存只得到一句拒绝，页面上看不出"这一格根本填不到那么大"。
// 因此上下界两端、以及"为什么不能再往那边调"的解释都在这一批用例里判。
func TestBudgetValidateRejectsOutOfRange(t *testing.T) {
	busy := int(limits.AppDBBusyTimeout / time.Second)
	readTimeout := int(limits.ServerReadTimeout / time.Second)
	cases := []struct {
		name  string
		mut   func(*applimits.Limits)
		field string
	}{
		{"guest 低于下限", func(l *applimits.Limits) { l.GuestBudgetSeconds = 0 }, "guest_budget_seconds"},
		// guest 的可行下限不是 1 s：宿主调用不得超过 guest，而宿主调用必须严格大于
		// 单条 SQL 硬超时（> busy）⇒ guest 至少 busy+2。
		{"guest 低于可行下限（宿主调用/SQL 序关系推出来的）", func(l *applimits.Limits) {
			l.GuestBudgetSeconds = busy + 1
		}, "guest_budget_seconds"},
		{"guest 超过独立上限", func(l *applimits.Limits) {
			l.GuestBudgetSeconds = applimits.MaxGuestBudgetSeconds + 1
			l.RequestWallClockSeconds = l.GuestBudgetSeconds + 1
		}, "guest_budget_seconds"},
		{"干跑低于下限", func(l *applimits.Limits) { l.DryRunBudgetSeconds = 0 }, "dry_run_budget_seconds"},
		// 干跑的可行上限 = guest 的独立上限（干跑不得大于 guest，而 guest 最大 120）。
		{"干跑超过可行上限（guest 的独立上限）", func(l *applimits.Limits) {
			l.DryRunBudgetSeconds = applimits.MaxGuestBudgetSeconds + 1
		}, "dry_run_budget_seconds"},
		{"宿主调用低于可行下限（必须严格大于单条 SQL）", func(l *applimits.Limits) {
			l.HostCallBudgetSeconds = busy + 1
		}, "host_call_budget_seconds"},
		{"宿主调用超过可行上限（guest 的独立上限）", func(l *applimits.Limits) {
			l.HostCallBudgetSeconds = applimits.MaxGuestBudgetSeconds + 1
		}, "host_call_budget_seconds"},
		{"墙钟低于可行下限（必须严格大于 guest）", func(l *applimits.Limits) {
			l.RequestWallClockSeconds = busy + 2
		}, "request_wall_clock_seconds"},
		{"墙钟超过通用上限", func(l *applimits.Limits) { l.RequestWallClockSeconds = applimits.MaxBudgetSeconds + 1 }, "request_wall_clock_seconds"},
		// 自 2026-10-08 起这两条由范围判据收口（原先住在序关系分支里，现在结构上不可达，
		// 解释与出路写进了范围判据的 hints）。字段归属不变，所以断言照旧。
		{"单条 SQL 不大于 busy timeout", func(l *applimits.Limits) {
			l.SQLStatementBudgetSeconds = busy
		}, "sql_statement_budget_seconds"},
		{"单条 SQL 超过可行上限（宿主调用可行上限 − 1）", func(l *applimits.Limits) {
			l.SQLStatementBudgetSeconds = applimits.MaxGuestBudgetSeconds
		}, "sql_statement_budget_seconds"},
		{"编译超时大于 ReadTimeout", func(l *applimits.Limits) {
			l.CompileTimeoutSeconds = readTimeout + 1
		}, "compile_timeout_seconds"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			l := applimits.Defaults()
			c.mut(&l)
			err := l.Validate()
			if err == nil {
				t.Fatal("必须被拒")
			}
			if got := fmt.Sprint(err.Details["field"]); got != c.field {
				t.Fatalf("want %s, got %s（%s）", c.field, got, err.Message)
			}
			// 越界原因与出路必须写在信封里（旧形态只有一句"不得超过 ReadTimeout"，
			// 控制台把它当作"客户端没解析"的哑保存 —— 现场就是这么来的）。
			if len(err.Hints) == 0 {
				t.Fatalf("越界拒绝必须给可操作 hint（%s）", err.Message)
			}
		})
	}

	// 编译超时那条的 hint 必须点名 ReadTimeout 与"怎么才能更长"（管理员唯一的下一步）。
	l := applimits.Defaults()
	l.CompileTimeoutSeconds = readTimeout + 1
	err := l.Validate()
	if err == nil {
		t.Fatal("编译超时 > ReadTimeout 必须被拒")
	}
	all := err.Message + " " + strings.Join(err.Hints, " ")
	for _, want := range []string{"ReadTimeout", fmt.Sprintf("%d–%d", applimits.MinBudgetSeconds, readTimeout)} {
		if !strings.Contains(all, want) {
			t.Fatalf("编译超时的拒绝文案必须含 %q（当前 message=%q hints=%v）", want, err.Message, err.Hints)
		}
	}
}

// budgetWitnessCandidates 是构造见证时给"其余字段"取的候选值。
//
// 集合必须包含每个字段区间的两端（含 ±1）：例如 sql 的上界 119 需要 host_call=120
// （正是 host_call 的上界），候选集里没有它就会构造不出见证，把"可达性"误判成缺陷。
func budgetWitnessCandidates() map[string][]int {
	out := map[string][]int{}
	for _, f := range applimits.FieldNames() {
		r, ok := applimits.Ranges()[f]
		if !ok {
			continue
		}
		out[f] = []int{r.Min, r.Min + 1, r.Max - 1, r.Max}
	}
	d := applimits.Defaults()
	for _, f := range applimits.FieldNames() {
		out[f] = append(out[f], valueOf(d, f))
	}
	return out
}

// valueOf 按字段名读 Limits 里的值（测试内的小反射替身：字段集由 FieldNames 唯一给出）。
func valueOf(l applimits.Limits, field string) int {
	switch field {
	case "max_instances":
		return l.MaxInstances
	case "app_running":
		return l.AppRunning
	case "app_queue":
		return l.AppQueue
	case "user_global_running":
		return l.UserGlobalRunning
	case "user_per_app_running":
		return l.UserPerAppRunning
	case "user_per_app_queued":
		return l.UserPerAppQueued
	case "instance_memory_mb":
		return l.InstanceMemoryMB
	case "module_cache_mb":
		return l.ModuleCacheMB
	case "module_cache_idle_min":
		return l.ModuleCacheIdleMin
	case "appdb_idle_min":
		return l.AppDBIdleMin
	case "appdb_cache_kib":
		return l.AppDBCacheKiB
	case "app_db_readers":
		return l.AppDBReaders
	case "guest_budget_seconds":
		return l.GuestBudgetSeconds
	case "dry_run_budget_seconds":
		return l.DryRunBudgetSeconds
	case "host_call_budget_seconds":
		return l.HostCallBudgetSeconds
	case "request_wall_clock_seconds":
		return l.RequestWallClockSeconds
	case "sql_statement_budget_seconds":
		return l.SQLStatementBudgetSeconds
	case "compile_timeout_seconds":
		return l.CompileTimeoutSeconds
	}
	return 0
}

// setValueOf 按字段名写 Limits（同 valueOf 的字段集）。
func setValueOf(l *applimits.Limits, field string, v int) {
	switch field {
	case "max_instances":
		l.MaxInstances = v
	case "app_running":
		l.AppRunning = v
	case "app_queue":
		l.AppQueue = v
	case "user_global_running":
		l.UserGlobalRunning = v
	case "user_per_app_running":
		l.UserPerAppRunning = v
	case "user_per_app_queued":
		l.UserPerAppQueued = v
	case "instance_memory_mb":
		l.InstanceMemoryMB = v
	case "module_cache_mb":
		l.ModuleCacheMB = v
	case "module_cache_idle_min":
		l.ModuleCacheIdleMin = v
	case "appdb_idle_min":
		l.AppDBIdleMin = v
	case "appdb_cache_kib":
		l.AppDBCacheKiB = v
	case "app_db_readers":
		l.AppDBReaders = v
	case "guest_budget_seconds":
		l.GuestBudgetSeconds = v
	case "dry_run_budget_seconds":
		l.DryRunBudgetSeconds = v
	case "host_call_budget_seconds":
		l.HostCallBudgetSeconds = v
	case "request_wall_clock_seconds":
		l.RequestWallClockSeconds = v
	case "sql_statement_budget_seconds":
		l.SQLStatementBudgetSeconds = v
	case "compile_timeout_seconds":
		l.CompileTimeoutSeconds = v
	}
}

// findValidCombination 在"其余字段取候选值"的格点上找一个过 Validate 的组合。
//
// 找到了 ⇒ 返回该组合（见证）；找不到 ⇒ 返回 false。**找不到不构成"不存在"的证明**
// （候选集是有限的格点），所以它只用来证伪两件事：
//   - 区间端点不可达（本该存在见证却找不到 ⇒ 表单把合法值挡住了）；
//   - 区间外的值仍有合法组合（找到了 ⇒ 表单的区间比真实可行域窄，同一类缺陷的另一半）。
//
// 六项时间预算的可行域就是由这批序关系定义的，格点覆盖了每条界的端点，因此这两条
// 方向的判定在本例里是充分的（推导本身保证"界只收紧到规则允许的极限"）。
func findValidCombination(field string, v int) (applimits.Limits, bool) {
	cands := budgetWitnessCandidates()
	// 只枚举余下五个时间预算字段 + 一个"其余取默认"的基线：并发/内存那几项与预算
	// 序关系无关，取值不影响判定（默认值本身就合法）。
	free := make([]string, 0, len(budgetFieldNames))
	for _, f := range budgetFieldNames {
		if f != field {
			free = append(free, f)
		}
	}
	base := applimits.Defaults()
	values := make([]int, len(free))
	var walk func(i int) (applimits.Limits, bool)
	walk = func(i int) (applimits.Limits, bool) {
		if i == len(free) {
			l := base
			setValueOf(&l, field, v)
			for j, f := range free {
				setValueOf(&l, f, values[j])
			}
			if l.Validate() == nil {
				return l, true
			}
			return applimits.Limits{}, false
		}
		for _, c := range cands[free[i]] {
			values[i] = c
			if got, ok := walk(i + 1); ok {
				return got, true
			}
		}
		return applimits.Limits{}, false
	}
	return walk(0)
}

// TestBudgetRangesAreReachable 是控制台区间的**"不许少"**方向：
// 区间里的**每一个**整数都必须存在一个过 Validate 的组合。
//
// 为什么是"每一个"而不是"端点"：本次的缺陷形态（2026-10-08 现场）正是
// **区间比真实可行域宽** —— 编译超时那一格声明 1–300，而 61–300 一个都存不进去。
// 只探两端点是抓不到它的（max=300 被探到了……能抓到；但"61 到 299 里有一段填不进"
// 这类形态端点探针会漏），所以这里逐值构造见证；反过来，**区间收得过紧**由
// TestBudgetRangesAreSound 判（那个方向是"区间外的值竟然能存"）。
//
// 两条一起 = 声明区间恰好等于可行域在该字段上的投影。
func TestBudgetRangesAreReachable(t *testing.T) {
	for _, f := range budgetFieldNames {
		r := applimits.Ranges()[f]
		// 逐值见证：值域由 limits 常量封顶（≤300），全量扫描的成本远低于一次编译。
		for v := r.Min; v <= r.Max; v++ {
			if _, ok := findValidCombination(f, v); !ok {
				t.Fatalf("%s=%d 取不到任何合法组合：控制台把它渲染成可填的一格（%d–%d），"+
					"而服务端必然拒收 —— 管理员照着提示填，点保存只会得到一句拒绝",
					f, v, r.Min, r.Max)
			}
		}
	}
}

// TestBudgetRangesAreSound 是同一对判据的**"不许多"**方向：区间**外**的每一个值
// （两侧各扫到基础区间的边界）都不允许存在任何合法组合 —— 否则表单会把一个能存的值挡住。
//
// 现场形态的另一半：编译超时那一格若只声明 1–60 而服务端接受 90，管理员就再也填不进
// 90（而 90 是合法的）。变异验证：把 compile_timeout_seconds 的上界改成 30 ⇒ 本用例必红。
func TestBudgetRangesAreSound(t *testing.T) {
	for _, f := range budgetFieldNames {
		r := applimits.Ranges()[f]
		for _, outside := range []struct {
			name string
			from int
			to   int
		}{
			{"下限之下", applimits.MinBudgetSeconds, r.Min - 1},
			{"上限之上", r.Max + 1, applimits.MaxBudgetSeconds + 1},
		} {
			for v := outside.from; v <= outside.to; v++ {
				if combination, ok := findValidCombination(f, v); ok {
					t.Fatalf("%s=%d（%s）竟然有一个合法组合（%s）：声明区间 %d–%d 比可行域窄，"+
						"表单会把一个能存的值挡住", f, v, outside.name, combination.Encode(), r.Min, r.Max)
				}
			}
		}
	}
}

// budgetFieldNames 是六个时间预算字段（顺序 = 表单顺序）。只在这里列一次：
// 两条区间判据与 findValidCombination 都用它。
var budgetFieldNames = []string{
	"guest_budget_seconds", "dry_run_budget_seconds", "host_call_budget_seconds",
	"request_wall_clock_seconds", "sql_statement_budget_seconds", "compile_timeout_seconds",
}

// TestBudgetRoundTripsThroughParse 钉住"控制台改过的预算能存能读"：
// 这是跨语言契约（webadmin 表单 ↔ 落库 JSON ↔ 运行期取值），任何一环丢字段
// 都会表现为"保存成功但没生效"。
func TestBudgetRoundTripsThroughParse(t *testing.T) {
	l := applimits.Defaults()
	l.GuestBudgetSeconds = 45
	l.DryRunBudgetSeconds = 45
	l.RequestWallClockSeconds = 90
	l.SQLStatementBudgetSeconds = 10
	// host_call 必须严格大于 sql（S4-02）⇒ 这条夹具用 12 而不是 8：8 < 10 会被
	// Parse 直接拒（本用例断言的是"能存能读"，不是"非法组合也能存"）。
	l.HostCallBudgetSeconds = 12
	l.CompileTimeoutSeconds = 50
	raw := l.Encode()
	back, err := applimits.Parse(raw)
	if err != nil {
		t.Fatalf("Parse: %v", err.Message)
	}
	if back != l {
		t.Fatalf("往返后不一致：\n got %+v\nwant %+v", back, l)
	}
	if back.GuestBudget() != 45*time.Second || back.WallClock() != 90*time.Second {
		t.Fatalf("往返后生效值不对：guest=%s wall=%s", back.GuestBudget(), back.WallClock())
	}
}

// TestBudgetFieldsAreClampedNotWidened：clampCrossField 只向下取小，绝不放宽。
//
// 它是"内部折算结果合法化"的入口（ParseStored 补默认值/档位折算都会经过），
// 如果在这里把用户设的 guest 放大，就会绕过 Validate 的上限。
func TestBudgetFieldsAreClampedNotWidened(t *testing.T) {
	l := applimits.Limits{
		MaxInstances: 3, AppRunning: 3, AppQueue: 32,
		UserGlobalRunning: 3, UserPerAppRunning: 1, UserPerAppQueued: 4,
		InstanceMemoryMB: 64, ModuleCacheMB: 64, ModuleCacheIdleMin: 10,
		AppDBIdleMin: 3, AppDBCacheKiB: 1024, AppDBReaders: 4,
		GuestBudgetSeconds: 30, DryRunBudgetSeconds: 90, HostCallBudgetSeconds: 60,
		RequestWallClockSeconds: 20, SQLStatementBudgetSeconds: 300, CompileTimeoutSeconds: 300,
	}
	got := l.ClampForTest()
	if got.DryRunBudgetSeconds > got.GuestBudgetSeconds {
		t.Errorf("干跑(%d) 不得大于 guest(%d)", got.DryRunBudgetSeconds, got.GuestBudgetSeconds)
	}
	if got.HostCallBudgetSeconds > got.GuestBudgetSeconds {
		t.Errorf("宿主调用(%d) 不得大于 guest(%d)", got.HostCallBudgetSeconds, got.GuestBudgetSeconds)
	}
	if got.RequestWallClockSeconds <= got.GuestBudgetSeconds {
		t.Errorf("墙钟(%d) 必须严格大于 guest(%d)", got.RequestWallClockSeconds, got.GuestBudgetSeconds)
	}
	if got.SQLStatementBudgetSeconds > got.RequestWallClockSeconds {
		t.Errorf("单条 SQL(%d) 不得大于墙钟(%d)", got.SQLStatementBudgetSeconds, got.RequestWallClockSeconds)
	}
	// S4-02：内层严格小于外层，且**只向下钳内层**（不放宽宿主调用预算）。
	if got.SQLStatementBudgetSeconds >= got.HostCallBudgetSeconds {
		t.Errorf("单条 SQL(%d) 必须严格小于宿主调用(%d)：相等时父 ctx 先到点，应用拿不到 DB_DENIED",
			got.SQLStatementBudgetSeconds, got.HostCallBudgetSeconds)
	}
	if got.HostCallBudgetSeconds != 30 {
		// 60 → 30 是**既有**那条"宿主调用不得大于 guest"钳出来的（不是新规则放大的）：
		// 新规则只允许向下收内层，不得为了满足序关系把外层抬上去。
		t.Errorf("宿主调用预算被改动了（%d）：钳位只允许向下收内层，不得放宽外层", got.HostCallBudgetSeconds)
	}
	if got.CompileTimeoutSeconds > int(limits.ServerReadTimeout/time.Second) {
		t.Errorf("编译超时(%d) 不得超过 ReadTimeout(%d s)", got.CompileTimeoutSeconds, int(limits.ServerReadTimeout/time.Second))
	}
	// 放宽方向绝不允许：用户的 guest=30 不能被改大。
	if got.GuestBudgetSeconds != 30 {
		t.Errorf("guest 被改动了：%d", got.GuestBudgetSeconds)
	}
	if err := got.Validate(); err != nil {
		t.Fatalf("钳位后的结果必须合法：%v", err.Message)
	}
}
