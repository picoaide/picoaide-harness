package applimits_test

import (
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/memprofile"
)

// 本文件是「平台限制项」模型的门禁：默认值等于编译期常量、档位折算、范围校验、
// 四笔账与重启判定。变异验证（交付时实跑过，勿删）：
//   - 把 Validate 的 AppRunning 上界判断去掉 ⇒ TestValidateRejectsInconsistent 必红；
//   - 把 NeedsRestart 恒返回 nil ⇒ TestNeedsRestart 必红；
//   - 把 Budget 的实例池改成常量 ⇒ TestBudgetFollowsLimits 必红；
//   - 去掉 FromProfile 的 clampCrossField ⇒ TestFromProfileStaysSelfConsistent 必红
//     （small 档会给出 app_running=4 > max_instances=3 这种自身非法的组合）；
//   - 把 AppDBReaders 的取值区间去掉 ⇒ TestAppDBReadersRange 必红。

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
	// app_db_readers 改动不要求重启（语义=下一个新建的句柄，与 appdb_cache_kib 同档）。
	next := applimits.Defaults()
	next.AppDBReaders = 8
	if got := applimits.NeedsRestart(applimits.Defaults(), next); len(got) != 0 {
		t.Fatalf("app_db_readers 改动不该要重启，得到 %v", got)
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

// TestBudgetFollowsLimits：四笔账随限制项变化（不是常量）。
func TestBudgetFollowsLimits(t *testing.T) {
	const available = 992 << 20
	small := applimits.Defaults()
	small.MaxInstances = 3
	small.InstanceMemoryMB = 64
	small.ModuleCacheMB = 64
	b := small.Budget(available)
	if want := int64(630 << 20); b.Total != want {
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
	// 读不到可用内存 ⇒ 只算不判（部署文档兜底）。
	if b3 := big.Budget(0); !b3.OK {
		t.Fatal("可用内存读不到时不得判定失败")
	}
}

// TestNeedsRestart：只有单实例内存上限需要重启。
func TestNeedsRestart(t *testing.T) {
	cur := applimits.Defaults()
	next := cur
	next.MaxInstances = cur.MaxInstances + 1
	next.ModuleCacheMB = cur.ModuleCacheMB + 16
	if got := applimits.NeedsRestart(cur, next); len(got) != 0 {
		t.Fatalf("并发/缓存类改动应即时生效，得到 %v", got)
	}
	next.InstanceMemoryMB = cur.InstanceMemoryMB + 32
	got := applimits.NeedsRestart(cur, next)
	if len(got) != 1 || got[0] != "instance_memory_mb" {
		t.Fatalf("单实例内存上限应标注需重启，得到 %v", got)
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
