package applimits_test

import (
	"strings"
	"testing"

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
