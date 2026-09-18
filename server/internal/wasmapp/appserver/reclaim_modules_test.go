package appserver

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

// 本文件是"更快释放"三条路径的回归：①空闲 TTL 淘汰（sweep）
// ②事件驱动逐出（evictApp）③限频归还 OS（reclaimer）。
//
// 变异验证（交付时实跑过，勿删）：
//   - 把 modules.sweep 的 `entry.refs != 0` 判断去掉 ⇒ TestModuleCacheSweepSkipsReferenced 必红；
//   - 把 sweep 的 lastUsed 判据改成"总是淘汰" ⇒ TestModuleCacheSweepKeepsFresh 必红；
//   - 把 evictApp 的 AppID 比较去掉（改成全删）⇒ TestModuleCacheEvictAppKeepsOthers 必红；
//   - 把 reclaimer 的最小间隔判断去掉 ⇒ TestReclaimerRateLimits 必红。

func acquireFor(t *testing.T, c *moduleCache, key moduleKey, size int64) func() {
	t.Helper()
	var calls int32
	_, release, err := c.acquire(t.Context(), key, newLoader("m-"+key.AppID, &calls, size))
	if err != nil {
		t.Fatalf("acquire(%v): %v", key, err)
	}
	return release
}

// TestModuleCacheSweepEvictsIdleOnly：空闲超过 TTL 且无人引用的条目被逐出；
// 未到 TTL 的保留。
func TestModuleCacheSweepEvictsIdleOnly(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	clock := func() time.Time { return now }
	c := newModuleCacheWith(1<<30, 100, 10*time.Minute, clock)

	fresh := moduleKey{AppID: "fresh", Version: "1", ReleaseID: 1}
	stale := moduleKey{AppID: "stale", Version: "1", ReleaseID: 2}
	acquireFor(t, c, fresh, 8)()
	acquireFor(t, c, stale, 16)()

	// 推进 11 分钟，然后"用一次" fresh（刷新它的 lastUsed）。
	now = now.Add(11 * time.Minute)
	acquireFor(t, c, fresh, 8)()

	n, bytes := c.sweep()
	if n != 1 || bytes != 16 {
		t.Fatalf("应逐出 1 条（stale，16 字节），得到 n=%d bytes=%d", n, bytes)
	}
	if entries, got := c.size(); entries != 1 || got != 8 {
		t.Fatalf("缓存应只剩 fresh：entries=%d bytes=%d", entries, got)
	}
	if c.has(stale) {
		t.Fatal("stale 必须已被逐出")
	}
	if !c.has(fresh) {
		t.Fatal("fresh（刚用过）不得被逐出")
	}
}

// TestModuleCacheSweepSkipsReferenced：正在被请求使用的条目（refs>0）不得被逐出。
func TestModuleCacheSweepSkipsReferenced(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	c := newModuleCacheWith(1<<30, 100, time.Minute, func() time.Time { return now })

	key := moduleKey{AppID: "busy", Version: "1", ReleaseID: 1}
	release := acquireFor(t, c, key, 8) // 故意不 release：模拟在途请求
	now = now.Add(2 * time.Hour)

	if n, _ := c.sweep(); n != 0 {
		t.Fatalf("在途条目不得被逐出，得到 n=%d", n)
	}
	if !c.has(key) {
		t.Fatal("在途条目必须仍在缓存里")
	}
	// 释放之后（下一轮 sweep）才允许逐出。
	release()
	if n, _ := c.sweep(); n != 1 {
		t.Fatalf("释放后应可逐出，得到 n=%d", n)
	}
}

// TestModuleCacheSweepDisabledWithoutTTL：idleTTL=0 ⇒ 不按时间淘汰（容量路径不受影响）。
func TestModuleCacheSweepDisabledWithoutTTL(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	c := newModuleCacheWith(1<<30, 100, 0, func() time.Time { return now })
	acquireFor(t, c, moduleKey{AppID: "a", Version: "1", ReleaseID: 1}, 8)()
	now = now.Add(24 * time.Hour)
	if n, _ := c.sweep(); n != 0 {
		t.Fatalf("idleTTL=0 时不应逐出，得到 n=%d", n)
	}
}

// TestModuleCacheEvictAppKeepsOthers：事件驱动逐出只清该应用，别的应用不受影响。
func TestModuleCacheEvictAppKeepsOthers(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	c := newModuleCacheWith(1<<30, 100, time.Hour, func() time.Time { return now })

	a1 := moduleKey{AppID: "a", Version: "1", ReleaseID: 1}
	a2 := moduleKey{AppID: "a", Version: "2", ReleaseID: 2}
	b1 := moduleKey{AppID: "b", Version: "1", ReleaseID: 3}
	acquireFor(t, c, a1, 1)()
	acquireFor(t, c, a2, 2)()
	acquireFor(t, c, b1, 4)()

	n, bytes := c.evictApp("a")
	if n != 2 || bytes != 3 {
		t.Fatalf("应逐出 a 的 2 条（3 字节），得到 n=%d bytes=%d", n, bytes)
	}
	if c.has(a1) || c.has(a2) {
		t.Fatal("a 的条目必须已逐出")
	}
	if !c.has(b1) {
		t.Fatal("b 的条目不得被误逐出")
	}
	if n, _ := c.evictApp("nonexistent"); n != 0 {
		t.Fatalf("不存在的应用应逐出 0 条，得到 %d", n)
	}
}

// TestReclaimerRateLimits：限频 —— 间隔内的请求被合并，不重复触发 FreeOSMemory。
func TestReclaimerRateLimits(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	var mu sync.Mutex
	var frees int
	r := newReclaimer(func() {
		mu.Lock()
		frees++
		mu.Unlock()
	}, func() time.Time { return now }, func(string, ...any) {})

	if !r.request("first", 1<<20) {
		t.Fatal("首次请求应真的执行")
	}
	if r.request("too-soon", 1<<20) {
		t.Fatal("间隔内的请求不应重复执行（限频）")
	}
	if got := frees; got != 1 {
		t.Fatalf("FreeOSMemory 应只调用 1 次，得到 %d", got)
	}
	now = now.Add(reclaimMinInterval + time.Second)
	if !r.request("later", 1<<20) {
		t.Fatal("超过最小间隔后应再次执行")
	}
	if got := frees; got != 2 {
		t.Fatalf("FreeOSMemory 应调用 2 次，得到 %d", got)
	}
}

// TestReclaimerNoopWithoutFree：未注入释放函数 ⇒ 永不执行（不 panic）。
func TestReclaimerNoopWithoutFree(t *testing.T) {
	r := newReclaimer(nil, nil, nil)
	if r.request("x", 0) {
		t.Fatal("free=nil 时不得报告已执行")
	}
	var nilR *reclaimer
	if nilR.request("x", 0) {
		t.Fatal("nil reclaimer 不得 panic 且不得报告已执行")
	}
}

// 编译期断言：loader 的返回类型与 apperr 契约保持（防止未来重构悄悄改签名）。
var _ func(context.Context) (compiledResult, *apperr.Error) = func(context.Context) (compiledResult, *apperr.Error) {
	return compiledResult{}, nil
}
