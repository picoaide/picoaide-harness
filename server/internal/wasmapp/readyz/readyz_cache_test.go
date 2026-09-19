package readyz

// 本文件是 R1-rt-4 的行为级护栏：`/readyz` 的**秒级快照缓存**与**内存档位输出**。
//
// 现场（审计 runtime-perf.md R1-rt-4 / R1-rt-10，HEAD 7da0ba47dd）：
//
//   - `/readyz` 未认证、零缓存、每请求做真活：编译缓存目录**全量递归 walk**
//     （≤ limits.CompileCacheMaxEntries 条）+ statfs + db.Ping，实测 4096 条目
//     14.2 ms/次（本机复测 9.7 ms）。监控每 1–5 s 打一次 ⇒ 每秒几千次 Lstat +
//     每秒一次 DB 往返，任意人都能放大。
//   - `readyz.Options.MemAvailable` 当时是**死选项**；`/readyz` 响应体里没有内存
//     来源，也没有"当前哪一档 / 理论峰值"（正是 P0-2 要防的分叉）。
//
// 修法：`Handler()` 走 `snapshotCached()`（TTL = limits.ReadyzSnapshotTTL，唯一真源，
// 单飞），并在 `Options.MemoryPlan` 注入后输出 mem_profile / mem_budget_*。
//
// # 变异验证（2026-09-19 实跑）
//
//	(a) 把 Handler 改回 `c.Snapshot()`（不走缓存）⇒ TestHandlerServesCachedSnapshot 红
//	    （provider 调用次数 1 → 3）；
//	(b) 把 TTL 判断改成永真（`ttl > 0` 去掉）⇒ 同一个用例的"过期后再采集"断言红；
//	(c) 去掉 MemoryPlan 分支 ⇒ TestSnapshotCarriesMemoryProfile 红。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// countingOpts 是"每个字段都可观测"的探针配置：每次真活都会让计数 +1。
type countingRecorder struct {
	snapshots atomic.Int64
	pings     atomic.Int64
	mems      atomic.Int64
}

func countingOpts(rec *countingRecorder) Options {
	return Options{
		DataRoot: "/tmp",
		DiskFree: func(string) (int64, error) { return MinDiskFreeBytes, nil },
		Compiler: func() CompilerStatsSnapshot {
			rec.snapshots.Add(1)
			return CompilerStatsSnapshot{}
		},
		MemAvailable: func() MemoryAvailability {
			rec.mems.Add(1)
			return MemoryAvailability{Bytes: 8 << 30, Source: MemorySourceHost}
		},
		Ping: func() error {
			rec.pings.Add(1)
			return nil
		},
	}
}

// TestHandlerServesCachedSnapshot 是 R1-rt-4 的核心判据：
// TTL 窗口内多次 HTTP 请求**只做一次真活**；TTL 过期后重新采集。
func TestHandlerServesCachedSnapshot(t *testing.T) {
	var rec countingRecorder
	now := time.Unix(1_700_000_000, 0)
	o := countingOpts(&rec)
	o.Now = func() time.Time { return now }
	c := New(o)
	h := c.Handler()

	call := func() Snapshot {
		t.Helper()
		rr := httptest.NewRecorder()
		h(rr, httptest.NewRequest(http.MethodGet, "/readyz", nil))
		if rr.Code != http.StatusOK {
			t.Fatalf("/readyz 应 200，得到 %d body=%s", rr.Code, rr.Body.String())
		}
		var s Snapshot
		if err := json.Unmarshal(rr.Body.Bytes(), &s); err != nil {
			t.Fatalf("响应不是合法 JSON: %v", err)
		}
		return s
	}

	first := call()
	if rec.snapshots.Load() != 1 || rec.mems.Load() != 1 || rec.pings.Load() != 1 {
		t.Fatalf("首次请求应恰好做一次真活：compiler=%d mem=%d ping=%d",
			rec.snapshots.Load(), rec.mems.Load(), rec.pings.Load())
	}
	if first.SnapshotCached {
		t.Fatal("首次请求不可能是缓存命中")
	}

	// TTL 窗口内：三次请求都命中同一份快照，真活次数不变。
	for i := 0; i < 3; i++ {
		now = now.Add(limits.ReadyzSnapshotTTL / 4)
		s := call()
		if !s.SnapshotCached {
			t.Fatalf("TTL 内第 %d 次请求应报告缓存命中", i+1)
		}
		if s.CheckedAt != first.CheckedAt {
			t.Fatalf("缓存命中必须复用同一份读数（checked_at 应相同）：%q vs %q", s.CheckedAt, first.CheckedAt)
		}
	}
	if rec.snapshots.Load() != 1 {
		t.Fatalf("TTL 窗口内不得重复采集：compiler 调用了 %d 次", rec.snapshots.Load())
	}

	// 越过 TTL：重新采集。
	now = now.Add(limits.ReadyzSnapshotTTL)
	s := call()
	if s.SnapshotCached {
		t.Fatal("TTL 过期后必须重新采集（不得报告缓存命中）")
	}
	if rec.snapshots.Load() != 2 || rec.mems.Load() != 2 || rec.pings.Load() != 2 {
		t.Fatalf("TTL 过期后应恰好再采集一次：compiler=%d mem=%d ping=%d",
			rec.snapshots.Load(), rec.mems.Load(), rec.pings.Load())
	}
}

// TestSnapshotIsNeverCached 守住"发布闸门/控制台预览要的是此刻"：
// `Snapshot()`（AllowPublish 与内存账预览走它）**不做缓存**。
//
// 变异：把 Snapshot 改成走 snapshotCached ⇒ 本用例红（第二次调用不再做真活），
// 那会让"磁盘刚满"在 TTL 窗口内被发布闸门放行。
func TestSnapshotIsNeverCached(t *testing.T) {
	var rec countingRecorder
	o := countingOpts(&rec)
	now := time.Unix(1_700_000_000, 0)
	o.Now = func() time.Time { return now }
	c := New(o)
	c.Snapshot()
	c.Snapshot()
	if rec.snapshots.Load() != 2 || rec.pings.Load() != 2 {
		t.Fatalf("Snapshot() 必须每次做真活：compiler=%d ping=%d", rec.snapshots.Load(), rec.pings.Load())
	}
	if s := c.Snapshot(); s.SnapshotCached {
		t.Fatal("Snapshot() 不得把自己标成缓存命中")
	}
}

// TestSnapshotCarriesMemoryProfile 是 R1-rt-10 的判据：`/readyz` 必须回答
// "当前哪一档、理论峰值多少、按可用内存判定结果如何"，且与启动自检同一份输入。
func TestSnapshotCarriesMemoryProfile(t *testing.T) {
	var rec countingRecorder
	o := countingOpts(&rec)
	plan := MemoryPlan{
		Profile:             "small",
		Instances:           3,
		InstanceMemoryBytes: 64 << 20,
		ModuleCacheBytes:    64 << 20,
	}
	o.MemoryPlan = func() MemoryPlan { return plan }
	s := New(o).Snapshot()

	if s.MemProfile != "small" {
		t.Fatalf("档位名必须出现在 /readyz 上，得到 %q", s.MemProfile)
	}
	want := ComputeMemoryBudgetFor(8<<30, plan)
	if s.MemBudgetByte != want.Total {
		t.Fatalf("理论峰值必须与 ComputeMemoryBudgetFor 同源：%d vs %d", s.MemBudgetByte, want.Total)
	}
	if s.MemBudgetLimitByte != want.Limit {
		t.Fatalf("允许水位必须与 ComputeMemoryBudgetFor 同源：%d vs %d", s.MemBudgetLimitByte, want.Limit)
	}
	if !s.MemBudgetKnown || !s.MemBudgetOK {
		t.Fatalf("8 GiB + small 档应判定通过且 known=true：%+v", s)
	}
	if s.MemSource != string(MemorySourceHost) || s.MemAvailableByte != 8<<30 {
		t.Fatalf("内存来源/数值必须输出：source=%q bytes=%d", s.MemSource, s.MemAvailableByte)
	}

	// 读不到可用内存 ⇒ known=false（"没有判定"而不是"判定通过"），且档位仍然可见。
	o2 := countingOpts(&rec)
	o2.MemoryPlan = func() MemoryPlan { return plan }
	o2.MemAvailable = func() MemoryAvailability {
		return MemoryAvailability{Source: MemorySourceNone, Detail: "读不到"}
	}
	s2 := New(o2).Snapshot()
	if s2.MemBudgetKnown {
		t.Fatal("读不到可用内存时 known 必须为 false（不许把'未知'表达成'通过'）")
	}
	if s2.MemProfile != "small" || s2.MemBudgetByte == 0 {
		t.Fatalf("即使读不到内存，档位与理论峰值也要如实输出：%+v", s2)
	}

	// 未注入档位提供者 ⇒ 档位字段保持空/零（不伪造默认档）。
	s3 := New(countingOpts(&rec)).Snapshot()
	if s3.MemProfile != "" || s3.MemBudgetByte != 0 {
		t.Fatalf("未注入 MemoryPlan 时不得伪造档位：%+v", s3)
	}
}
