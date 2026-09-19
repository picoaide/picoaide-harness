package appserver

// 本文件是 R1-rt-2 / R1-rt-3（静态资源热路径零缓存）的**行为级护栏**。
//
// 现场（审计 runtime-perf.md R1-rt-2/3，HEAD 7da0ba47dd）：
//
//   - R1-rt-2：`serveStatic` 先整份读盘（store.Read）→ 算 sha256 → **之后**才判
//     `If-None-Match` ⇒ 304 复验一分钱不省（实测 200 KiB 资源 665 µs/请求），
//     而浏览器每 5 分钟缓存窗口之后每个资源都要复验一次。
//   - R1-rt-3：请求热路径零缓存 ⇒ 每个静态子资源都要重付"读盘 + SHA-256 + 配置读盘解析"。
//
// 修法：`(app_id, release_id)` 级缓存（releasecache.go）+ **先判 304、再决定要不要正文**。
//
// # 变异验证（把实现改回去时哪条会红，2026-09-19 实跑）
//
//	(a) 把 serveStatic 改回"先 rc.Asset(logical)（读盘）再判 If-None-Match"
//	    ⇒ TestStatic_NotModifiedDoesNotTouchDisk 红（磁盘上的文件已被删除，
//	      读盘会失败 → 落到 wasm，不再 304）；
//	(b) 让 Asset() 不走缓存（每次 store.Read）⇒ TestStatic_CachedBytesSurviveFileRemoval
//	    与 TestStatic_NotModifiedDoesNotTouchDisk 的 DiskReads 断言红；
//	(c) 去掉换版本时的失效（dropOtherReleasesLocked 变成 no-op）⇒
//	    TestStatic_NewVersionIsVisibleImmediately 仍绿（键含 release_id，正确性不依赖它），
//	    但 TestReleaseCache_VersionChangeDropsOldRelease 红（旧版本字节滞留）；
//	(d) 去掉 EvictApp 里的 releases.evictApp ⇒ TestStatic_EvictAppInvalidatesCache 红；
//	(e) 去掉 evictLocked 的容量淘汰 ⇒ TestReleaseCache_IsBounded 红。

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/anonlimit"
	"github.com/picoaide/picoaide/internal/wasmapp/assets"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// getWithETag 发一个带 If-None-Match 的应用子域 GET。
func (e *env) getWithETag(appID, path, etag string) *httptest.ResponseRecorder {
	e.t.Helper()
	req := httptest.NewRequest(http.MethodGet, appURL(appID, path), nil)
	req.Header.Set("If-None-Match", etag)
	return e.serve(req)
}

// entriesForTest 数某应用的缓存条目（护栏用的只读视图）。
func (c *releaseCache) entriesForTest(appID string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for k := range c.entries {
		if k.AppID == appID {
			n++
		}
	}
	return n
}

// releaseDirOf 返回某次 publishApp 写下的资源目录（与 helpers_test 的约定一致）。
func releaseDirOf(t *testing.T, e *env, spec appSpec, relID int64) string {
	t.Helper()
	dirName := fmt.Sprintf("%d", relID)
	if spec.assetsDir != "" {
		dirName = spec.assetsDir
	}
	return filepath.Join(e.root, limits.AppsDirName, spec.appID, assets.AssetsDirName, dirName)
}

// TestStatic_NotModifiedDoesNotTouchDisk 是 R1-rt-2 的核心判据：
// 缓存预热后，`If-None-Match` 命中必须**不读盘、不算哈希**。
//
// 判据怎么做到"行为级"而不是"读代码"：预热之后**把磁盘上的资源文件删掉**。
// 只要实现还去读那份文件，就一定读不到（assets.Read 返回 NOT_FOUND）⇒ 请求会落到
// wasm，拿不到 304；反过来，仍然 304 就证明它没有碰磁盘。另有 DiskReads 计数佐证。
func TestStatic_NotModifiedDoesNotTouchDisk(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("rt304")
	spec := appSpec{appID: appID, config: publicConfig(), assets: map[string]string{
		"index.html": strings.Repeat("x", 200*1024),
	}}
	rel := e.publishApp(spec)

	// 预热：第一次 GET 走冷路径（读盘 + 算哈希 + 回填缓存）。
	first := e.get(appID, "/index.html")
	if first.Code != http.StatusOK {
		t.Fatalf("首次 GET 应 200，得到 %d body=%.200s", first.Code, first.Body.String())
	}
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("静态资源必须有 ETag")
	}
	warm := e.srv.releases.stats()
	if warm.DiskReads == 0 {
		t.Fatal("冷路径必须真的读过盘（否则下面的断言没有意义）")
	}
	if warm.Entries == 0 {
		t.Fatal("首次访问必须回填 (app_id, release_id) 级缓存（R1-rt-3）")
	}

	// 把磁盘上的资源文件删掉：此后任何"读盘"都不可能成功。
	// （app_id 每个用例唯一 ⇒ 不会影响别的用例；数据根由 TestMain 统一清理。）
	gone := filepath.Join(releaseDirOf(t, e, spec, rel.ID), "index.html")
	if err := os.Remove(gone); err != nil {
		t.Fatalf("删除资源文件失败: %v", err)
	}

	rec := e.getWithETag(appID, "/index.html", etag)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("缓存命中时 If-None-Match 必须直接 304（不读盘）：得到 %d body=%.200s", rec.Code, rec.Body.String())
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("304 不得带 body，得到 %q", rec.Body.String())
	}
	if got := rec.Header().Get("ETag"); got != etag {
		t.Fatalf("304 必须回同一个 ETag：want %q got %q", etag, got)
	}
	// 头必须与 200 那条路径**逐字段一致**（304 与 200 共用 writeStaticHeaders）。
	if cc, cc200 := rec.Header().Get("Cache-Control"), first.Header().Get("Cache-Control"); cc != cc200 {
		t.Fatalf("304 的 Cache-Control 必须与 200 一致：%q vs %q", cc, cc200)
	}
	assertHostSecurityHeaders(t, rec, false)

	after := e.srv.releases.stats()
	if after.DiskReads != warm.DiskReads {
		t.Fatalf("304 复验不得读盘：DiskReads %d → %d", warm.DiskReads, after.DiskReads)
	}
}

// TestStatic_CachedBytesSurviveFileRemoval 守住 R1-rt-3 的"资源字节"这一半：
// 缓存命中时连正文都不必回源 —— 文件删掉之后再取同一条（非条件请求）仍然 200 且字节一致。
//
// 变异：让 Asset() 每次都 store.Read（不查缓存）⇒ 本用例红（文件已删除）。
func TestStatic_CachedBytesSurviveFileRemoval(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("rtbytes")
	const body = "body{color:red}/* 200KiB 资源以外的小资源，正文短但同样要进缓存 */"
	spec := appSpec{appID: appID, config: publicConfig(), assets: map[string]string{
		"static/app.css": body,
	}}
	rel := e.publishApp(spec)

	first := e.get(appID, "/static/app.css")
	if first.Code != http.StatusOK || first.Body.String() != body {
		t.Fatalf("首次 GET 应 200 且内容一致，得到 %d %q", first.Code, first.Body.String())
	}
	if err := os.Remove(filepath.Join(releaseDirOf(t, e, spec, rel.ID), "static/app.css")); err != nil {
		t.Fatalf("删除资源文件失败: %v", err)
	}
	warm := e.srv.releases.stats()

	second := e.get(appID, "/static/app.css")
	if second.Code != http.StatusOK {
		t.Fatalf("缓存命中应仍然 200（字节在缓存里）：得到 %d body=%.200s", second.Code, second.Body.String())
	}
	if second.Body.String() != body {
		t.Fatalf("缓存命中应返回同一份字节：%q", second.Body.String())
	}
	if second.Header().Get("ETag") != first.Header().Get("ETag") {
		t.Fatalf("同一份内容必须给出同一个 ETag：%q vs %q",
			first.Header().Get("ETag"), second.Header().Get("ETag"))
	}
	if got := e.srv.releases.stats().DiskReads; got != warm.DiskReads {
		t.Fatalf("缓存命中不得读盘：DiskReads %d → %d", warm.DiskReads, got)
	}
}

// TestStatic_NewVersionIsVisibleImmediately 守住 R1-rt-3 的"换版本必须立刻看到新资源"。
//
// 缓存键含 release_id ⇒ 新版本天然不命中；这条用例不依赖"实现是否显式清理旧条目"，
// 它守的是**用户可见的语义**：发布新版本之后第一个请求就是新内容（不能因为缓存拿到旧字节）。
func TestStatic_NewVersionIsVisibleImmediately(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("rtver")
	e.publishApp(appSpec{appID: appID, version: "1.0.0", config: publicConfig(), assets: map[string]string{
		"app.js": "console.log('v1')",
	}})
	v1 := e.get(appID, "/app.js")
	if v1.Code != http.StatusOK || v1.Body.String() != "console.log('v1')" {
		t.Fatalf("v1 资源不对: %d %q", v1.Code, v1.Body.String())
	}
	etagV1 := v1.Header().Get("ETag")

	e.publishApp(appSpec{appID: appID, version: "2.0.0", config: publicConfig(), assets: map[string]string{
		"app.js": "console.log('v2')",
	}})
	v2 := e.get(appID, "/app.js")
	if v2.Code != http.StatusOK || v2.Body.String() != "console.log('v2')" {
		t.Fatalf("换版本后必须立刻看到新资源，得到 %d %q", v2.Code, v2.Body.String())
	}
	if etagV2 := v2.Header().Get("ETag"); etagV2 == etagV1 {
		t.Fatal("换版本必须换 ETag（缓存键含 version，摘要也含内容）")
	}
	// 旧 ETag 不得在新版本上命中 304。
	if rec := e.getWithETag(appID, "/app.js", etagV1); rec.Code != http.StatusOK {
		t.Fatalf("旧版本的 ETag 不得在新版本上 304，得到 %d", rec.Code)
	}
}

// TestStatic_EvictAppInvalidatesCache 守住"下架/冻结/删除/逐出必须失效"这一条
// （EvictApp 是 api 侧四条处置路径共用的钩子）。
//
// 判据（行为级）：缓存预热之后**直接改磁盘上的内容**（违反"资源不可变"的契约，
// 但正好让"缓存是否失效"变成可观测的）——
//   - 未 EvictApp：仍然返回旧内容（证明缓存真的生效）；
//   - EvictApp 之后：立刻返回新内容（证明失效真的发生）。
func TestStatic_EvictAppInvalidatesCache(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("rtevict")
	spec := appSpec{appID: appID, config: publicConfig(), assets: map[string]string{
		"index.html": "old",
	}}
	rel := e.publishApp(spec)

	if rec := e.get(appID, "/index.html"); rec.Code != http.StatusOK || rec.Body.String() != "old" {
		t.Fatalf("预热请求不对: %d %q", rec.Code, rec.Body.String())
	}
	if n := e.srv.releases.entriesForTest(appID); n == 0 {
		t.Fatal("预热后该应用应有缓存条目")
	}

	// 重新填一份缓存（EvictApp 已经把它清空了），再改盘验证"缓存确实生效"。
	if rec := e.get(appID, "/index.html"); rec.Code != http.StatusOK {
		t.Fatalf("二次预热失败: %d", rec.Code)
	}
	target := filepath.Join(releaseDirOf(t, e, spec, rel.ID), "index.html")
	if err := os.WriteFile(target, []byte("new"), 0o600); err != nil {
		t.Fatalf("改写资源失败: %v", err)
	}
	if rec := e.get(appID, "/index.html"); rec.Body.String() != "old" {
		t.Fatalf("缓存应命中旧字节（这就是缓存生效的证据），得到 %q", rec.Body.String())
	}

	// 处置事件：下架/冻结/删除都经这一个钩子。
	if mods, _ := e.srv.EvictApp(appID); mods < 0 {
		t.Fatalf("EvictApp 返回值异常: %d", mods)
	}
	if n := e.srv.releases.entriesForTest(appID); n != 0 {
		t.Fatalf("EvictApp 之后不得再有该应用的缓存条目，仍有 %d 个", n)
	}
	if rec := e.get(appID, "/index.html"); rec.Body.String() != "new" {
		t.Fatalf("逐出之后必须重新读盘拿到新内容，得到 %q", rec.Body.String())
	}
}

// TestReleaseCache_VersionChangeDropsOldRelease 守住"换版本时旧 release 的字节不滞留"。
//
// 正确性不依赖它（键含 release_id），它守的是**有界性/及时释放**：同一应用出现新的
// release 时，旧 release 的条目必须被丢掉。
func TestReleaseCache_VersionChangeDropsOldRelease(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("rtdrop")
	e.publishApp(appSpec{appID: appID, version: "1.0.0", config: publicConfig(), assets: map[string]string{
		"index.html": "v1",
	}})
	if rec := e.get(appID, "/index.html"); rec.Code != http.StatusOK {
		t.Fatalf("v1 预热失败: %d", rec.Code)
	}
	if got := e.srv.releases.stats().Entries; got != 1 {
		t.Fatalf("v1 预热后应有 1 个缓存条目，得到 %d", got)
	}

	e.publishApp(appSpec{appID: appID, version: "2.0.0", config: publicConfig(), assets: map[string]string{
		"index.html": "v2",
	}})
	if rec := e.get(appID, "/index.html"); rec.Body.String() != "v2" {
		t.Fatalf("v2 内容不对: %q", rec.Body.String())
	}
	if got := e.srv.releases.stats().Entries; got != 1 {
		t.Fatalf("换版本后旧 release 的条目必须被丢掉（只留当前版本），得到 %d 个", got)
	}
}

// TestReleaseCache_IsBounded 是"缓存必须有界"的判据：
// ①字节总量被上限约束（允许一份超额，见 releaseCache 的头注释）；
// ②条目数被上限约束；③单条超大资源只缓存元数据（不缓存字节）。
func TestReleaseCache_IsBounded(t *testing.T) {
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	c := newReleaseCache(64<<10, 4, func() time.Time { return now })
	blob := bytes.Repeat([]byte("a"), 8<<10)

	for i := 0; i < 64; i++ {
		k := releaseKey{AppID: fmt.Sprintf("app-%d", i), ReleaseID: int64(i)}
		for j := 0; j < 4; j++ {
			c.putAsset(k, fmt.Sprintf("f%d", j), assetEntry{
				ContentType: "application/octet-stream", ETag: `"e"`, Size: len(blob), Data: blob, BytesCached: true,
			})
		}
		st := c.stats()
		if st.Entries > 4 {
			t.Fatalf("条目数必须 ≤ maxEntries(4)，得到 %d", st.Entries)
		}
		// 硬上界 = maxBytes + 单个 release 的资源总量（这里一个 release = 32 KiB）。
		if st.Bytes > int64(64<<10)+(32<<10) {
			t.Fatalf("字节总量越过硬上界：%d > %d", st.Bytes, int64(64<<10)+(32<<10))
		}
	}
	if st := c.stats(); st.Evictions == 0 {
		t.Fatal("超过上限必须真的发生淘汰")
	}

	// 单条超预算一半 ⇒ 只留元数据。
	big := newReleaseCache(1<<20, 8, func() time.Time { return now })
	huge := bytes.Repeat([]byte("b"), (1<<20)/2+1)
	big.putAsset(releaseKey{AppID: "a", ReleaseID: 1}, "huge.bin", assetEntry{
		ContentType: "application/octet-stream", ETag: `"h"`, Size: len(huge), Data: huge, BytesCached: true,
	})
	got, ok := big.asset(releaseKey{AppID: "a", ReleaseID: 1}, "huge.bin")
	if !ok {
		t.Fatal("元数据必须仍然可查（304 复验靠它）")
	}
	if got.BytesCached {
		t.Fatalf("单条超过预算一半时不得缓存字节：BytesCached=%v", got.BytesCached)
	}
	if st := big.stats(); st.Bytes != 0 {
		t.Fatalf("只缓存元数据时字节总量应为 0，得到 %d", st.Bytes)
	}
}

// TestReleaseCache_IdleSweepFreesEntries 守住"时间维度"那一半的有界性。
func TestReleaseCache_IdleSweepFreesEntries(t *testing.T) {
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	clock := now
	c := newReleaseCache(1<<20, 8, func() time.Time { return clock })
	k := releaseKey{AppID: "a", ReleaseID: 1}
	c.putAsset(k, "f", assetEntry{ContentType: "text/plain", ETag: `"e"`, Size: 1, Data: []byte("x"), BytesCached: true})
	if n, _ := c.sweepIdle(time.Minute); n != 0 {
		t.Fatalf("未空闲不得回收，得到 %d", n)
	}
	clock = clock.Add(2 * time.Minute)
	if n, _ := c.sweepIdle(time.Minute); n != 1 {
		t.Fatalf("空闲超时后必须回收，得到 %d", n)
	}
	if c.stats().Entries != 0 {
		t.Fatal("回收后不得留条目")
	}
}

// TestReleaseCache_ConcurrentRequestsAreSafe 守住并发正确性：
//
// 缓存是**跨请求共享**的进程内状态（每请求一个 releaseContent 视图，缓存本体共享），
// 因此必须证明"并发读写 + 并发逐出/空闲回收"下没有数据竞争、没有错内容。
// 值语义（assetEntry 拷贝 + 不可变的 Data 切片）就是为这条服务的。
//
// 复跑（-race 下才有检出能力）：
//
//	PG_DSN_TEST=… bash ../temp/wasm-heavy.sh 900 go test ./internal/wasmapp/appserver/ \
//	  -count=1 -race -run TestReleaseCache_ConcurrentRequestsAreSafe
func TestReleaseCache_ConcurrentRequestsAreSafe(t *testing.T) {
	e := newEnv(t, func(o *Options) {
		// 32 个并发请求会被每 IP 匿名限流挡住 ⇒ 放宽（限流不是本用例的被测语义）。
		o.Limiter = anonlimit.New(anonlimit.Options{
			GlobalRatePerMin: 1 << 30, GlobalBurst: 1 << 30,
			PerIPRatePerMin: 1 << 30, PerIPBurst: 1 << 30, MaxIPBuckets: 1024, Now: time.Now,
		})
	})
	appID := e.appID("rtconc")
	e.publishApp(appSpec{appID: appID, config: publicConfig(), assets: map[string]string{
		"index.html": "shell",
		"app.js":     "console.log(1)",
		"style.css":  "body{}",
	}})
	first := e.get(appID, "/app.js")
	if first.Code != http.StatusOK {
		t.Fatalf("预热失败: %d", first.Code)
	}
	etag := first.Header().Get("ETag")

	const workers = 16
	const rounds = 8
	var wg sync.WaitGroup
	errs := make(chan string, workers*rounds)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < rounds; i++ {
				switch (w + i) % 3 {
				case 0:
					rec := e.get(appID, "/app.js")
					if rec.Code != http.StatusOK || rec.Body.String() != "console.log(1)" {
						errs <- fmt.Sprintf("200 路径内容不对: %d %q", rec.Code, rec.Body.String())
					}
				case 1:
					rec := e.getWithETag(appID, "/app.js", etag)
					if rec.Code != http.StatusNotModified {
						errs <- fmt.Sprintf("304 路径状态不对: %d", rec.Code)
					}
				default:
					rec := e.get(appID, "/style.css")
					if rec.Code != http.StatusOK || rec.Body.String() != "body{}" {
						errs <- fmt.Sprintf("另一个资源内容不对: %d %q", rec.Code, rec.Body.String())
					}
				}
			}
		}(w)
	}
	// 同时制造逐出与空闲回收（它们会摘掉正在被读的条目）——
	// 这正是"值语义 + 持锁临界区"要顶住的东西。
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < rounds; i++ {
			e.srv.EvictApp(appID)
			e.advance(2 * limits.ModuleCacheIdleTTL)
			e.srv.sweepOnce()
		}
	}()
	wg.Wait()
	close(errs)
	for msg := range errs {
		t.Fatal(msg)
	}

	// 缓存仍然自洽（有界、计数非负），且请求照常可用。
	st := e.srv.releases.stats()
	if st.Bytes < 0 || st.Entries < 0 {
		t.Fatalf("缓存计数不得为负: %+v", st)
	}
	if rec := e.get(appID, "/app.js"); rec.Code != http.StatusOK || rec.Body.String() != "console.log(1)" {
		t.Fatalf("并发压测后请求仍须正确: %d %q", rec.Code, rec.Body.String())
	}
}

// TestReleaseCache_ConfigIsCachedPerRelease 守住"解析后的 appcfg"这一半：
// 配置只读盘一次（同 release 内复用），换 release 重新读。
func TestReleaseCache_ConfigIsCachedPerRelease(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("rtcfg")
	spec := appSpec{appID: appID, config: publicConfig(), assets: map[string]string{"index.html": "x"}}
	rel := e.publishApp(spec)

	if rec := e.get(appID, "/index.html"); rec.Code != http.StatusOK {
		t.Fatalf("预热失败: %d", rec.Code)
	}
	misses := e.srv.releases.stats().CfgMisses
	if misses != 1 {
		t.Fatalf("配置只应读盘解析一次（首次），得到 %d 次未命中", misses)
	}
	if rec := e.get(appID, "/index.html"); rec.Code != http.StatusOK {
		t.Fatalf("第二次请求失败: %d", rec.Code)
	}
	st := e.srv.releases.stats()
	if st.CfgMisses != misses {
		t.Fatalf("第二次请求不得再解析配置：CfgMisses %d → %d", misses, st.CfgMisses)
	}
	if st.CfgHits != 1 {
		t.Fatalf("第二次请求应命中配置缓存，得到 CfgHits=%d", st.CfgHits)
	}
	_ = rel
}
