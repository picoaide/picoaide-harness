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
//   - 把 Budget 的实例池改成常量 ⇒ TestBudgetFollowsLimits 必红。

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
