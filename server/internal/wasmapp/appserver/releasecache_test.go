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

// ===== 第二轮对抗式审计（性能缓存区域 R2-CA-1/2/3/5）的行为级护栏 =====

// TestReleaseCache_ConfigReadFailureIsNotCached 是 R2-CA-1 的核心判据：
// **一次瞬时读失败不得把应用固化成持续 500**。
//
// 判据怎么做到行为级：把配置文件删掉（模拟 EIO/误删/挂载抖动这一类的"可就地修好"的
// 平台故障）→ 期望 500（fail-loud：读不到配置绝不当匿名）；然后把文件**逐字节恢复**
// → 下一个请求必须自己恢复 200，**不许**要求先 EvictApp/重启。
//
// 旧实现把失败也写进缓存（"平台故障要么被修好=换版本，要么一直存在"），于是恢复文件
// 之后每一个请求都命中那份失败记录，永远 500；且命中会刷新 lastUsed ⇒ 空闲淘汰也
// 永不触发（"越多请求越修不好"）。变异：让 putConfig 重新缓存 err ⇒ 本用例红。
func TestReleaseCache_ConfigReadFailureIsNotCached(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("rtcfgfail")
	spec := appSpec{appID: appID, config: publicConfig(), assets: map[string]string{"index.html": "x"}}
	rel := e.publishApp(spec)
	cfgPath := filepath.Join(releaseDirOf(t, e, spec, rel.ID), limits.AppConfigFileName)
	orig, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("读配置夹具失败: %v", err)
	}

	if err := os.Remove(cfgPath); err != nil {
		t.Fatalf("删除配置失败: %v", err)
	}
	broken := e.get(appID, "/index.html")
	if broken.Code != http.StatusInternalServerError {
		t.Fatalf("配置读不到必须 500（平台故障，绝不按匿名放行），得到 %d body=%.200s", broken.Code, broken.Body.String())
	}
	// 恢复成与原来**逐字节相同**的内容：平台故障已经修好。
	if err := os.WriteFile(cfgPath, orig, 0o600); err != nil {
		t.Fatalf("恢复配置失败: %v", err)
	}
	for i := 0; i < 3; i++ {
		rec := e.get(appID, "/index.html")
		if rec.Code != http.StatusOK {
			t.Fatalf("配置已恢复（第 %d 次请求）应自愈为 200，得到 %d body=%.200s（不得要求 EvictApp/重启）",
				i+1, rec.Code, rec.Body.String())
		}
	}
	// 反向对照：读失败期间**每次**都要真的重读盘（不缓存失败），否则自愈无从谈起。
	if st := e.srv.releases.stats(); st.CfgMisses < 2 {
		t.Fatalf("读失败不得进缓存：CfgMisses=%d，期望每次请求都未命中（≥2）", st.CfgMisses)
	}
}

// TestReleaseCache_ConfigCacheRevalidatesAfterTTL 是 R2-CA-1 的"镜像面"判据：
// 暖缓存下的**删除**也必须在一个窗口内被察觉 —— 配置进缓存不代表它可以被无限期信任。
//
// 判据：预热（成功进缓存）→ 删掉磁盘上的配置 → 推进时钟超过 ConfigRevalidateTTL →
// 请求必须变成 500（fail-loud 恢复）；把文件恢复 → 再推进一个窗口 → 请求回到 200。
//
// 变异：去掉 config() 里的 TTL 判断（无限期信任缓存）⇒ 删除后仍然 200 ⇒ 本用例红。
func TestReleaseCache_ConfigCacheRevalidatesAfterTTL(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("rtcfgttl")
	spec := appSpec{appID: appID, config: publicConfig(), assets: map[string]string{"index.html": "x"}}
	rel := e.publishApp(spec)
	cfgPath := filepath.Join(releaseDirOf(t, e, spec, rel.ID), limits.AppConfigFileName)
	orig, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("读配置夹具失败: %v", err)
	}
	if rec := e.get(appID, "/index.html"); rec.Code != http.StatusOK {
		t.Fatalf("预热失败: %d", rec.Code)
	}
	warm := e.srv.releases.stats()

	// 窗口内：仍然命中缓存（不读盘）——否则"缓存配置"这件事就没有发生。
	e.advance(ConfigRevalidateTTL / 2)
	if rec := e.get(appID, "/index.html"); rec.Code != http.StatusOK {
		t.Fatalf("窗口内应命中缓存并 200，得到 %d", rec.Code)
	}
	if st := e.srv.releases.stats(); st.CfgMisses != warm.CfgMisses {
		t.Fatalf("窗口内不得重新解析配置：CfgMisses %d → %d", warm.CfgMisses, st.CfgMisses)
	}

	// 跨窗口 + 磁盘上配置消失 ⇒ 必须被察觉（fail-loud）。
	if err := os.Remove(cfgPath); err != nil {
		t.Fatalf("删除配置失败: %v", err)
	}
	e.advance(ConfigRevalidateTTL + time.Second)
	if rec := e.get(appID, "/index.html"); rec.Code != http.StatusInternalServerError {
		t.Fatalf("配置在窗口后被删除必须变成 500，得到 %d body=%.200s", rec.Code, rec.Body.String())
	}

	// 修好后同样在一个窗口内恢复。
	if err := os.WriteFile(cfgPath, orig, 0o600); err != nil {
		t.Fatalf("恢复配置失败: %v", err)
	}
	if rec := e.get(appID, "/index.html"); rec.Code != http.StatusOK {
		t.Fatalf("配置恢复后应立刻 200（失败不缓存），得到 %d", rec.Code)
	}
}

// TestStatic_NotModifiedHeadersMatch200Exactly 把"304 与 200 的头逐字段一致"从
// **半护栏**补成真护栏（R2-CA-3）。
//
// 旧断言只查 ETag/Cache-Control/CSP 两个子串/X-Content-Type-Options/Referrer-Policy/
// X-Frame-Options：实测把"缓存命中 304"那条路径的 `Content-Type` 抹掉，整包用例
// （appserver+readyz）仍全绿。这里改成对**整个 header 集合**做对拍：200 与 304 的每个
// 键、每个值都必须相同（唯一允许的差异是 304 按 RFC 9110 不得有 Content-Length）；
// 另附 HEAD 与 GET 的对拍（HEAD 不得有 body，但头必须与 GET 相同）。
//
// 变异：只把缓存命中 304 路径的 Content-Type 删掉 ⇒ 本用例红。
func TestStatic_NotModifiedHeadersMatch200Exactly(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("rthdr")
	spec := appSpec{appID: appID, config: publicConfig(), assets: map[string]string{
		"index.html": "<html><body>hi</body></html>",
		"app.js":     "console.log(1)",
		"style.css":  "body{color:red}",
	}}
	e.publishApp(spec)

	// 允许的差异白名单：304 不带消息体 ⇒ 不带 Content-Length（RFC 9110 §15.4.5）。
	allowed304Only := map[string]bool{"Content-Length": true}

	for _, p := range []string{"/index.html", "/", "/app.js", "/style.css"} {
		first := e.get(appID, p)
		if first.Code != http.StatusOK {
			t.Fatalf("%s 首次 GET 应 200，得到 %d", p, first.Code)
		}
		rec := e.getWithETag(appID, p, first.Header().Get("ETag"))
		if rec.Code != http.StatusNotModified {
			t.Fatalf("%s 条件 GET 应 304，得到 %d", p, rec.Code)
		}
		h200, h304 := first.Header(), rec.Header()
		// ① 200 的每个键都必须在 304 上逐值出现（Content-Length 除外）。
		for k, vs := range h200 {
			if allowed304Only[k] {
				continue
			}
			got := h304.Values(k)
			if len(got) != len(vs) {
				t.Fatalf("%s 的 304 缺少头 %s：200=%v 304=%v", p, k, vs, got)
			}
			for i := range vs {
				if got[i] != vs[i] {
					t.Fatalf("%s 的 304 头 %s 不一致：200=%q 304=%q", p, k, vs[i], got[i])
				}
			}
		}
		// ② 304 不得**多出**任何 200 没有的键（除白名单），否则同一份实现在两条路径上漂移。
		for k := range h304 {
			if allowed304Only[k] {
				continue
			}
			if _, ok := h200[k]; !ok {
				t.Fatalf("%s 的 304 多出头 %s=%v（200 没有）", p, k, h304.Values(k))
			}
		}
	}

	// HEAD 与 GET 的头必须一致（HEAD 只是不要 body）。
	headReq := httptest.NewRequest(http.MethodHead, appURL(appID, "/index.html"), nil)
	recHead := e.serve(headReq)
	recGet := e.get(appID, "/index.html")
	if recHead.Code != http.StatusOK || recHead.Body.Len() != 0 {
		t.Fatalf("HEAD 应 200 且无 body，得到 %d bodylen=%d", recHead.Code, recHead.Body.Len())
	}
	for k, vs := range recGet.Header() {
		got := recHead.Header().Values(k)
		if len(got) != len(vs) {
			t.Fatalf("HEAD 缺少头 %s：GET=%v HEAD=%v", k, vs, got)
		}
		for i := range vs {
			if got[i] != vs[i] {
				t.Fatalf("HEAD 头 %s 与 GET 不一致：GET=%q HEAD=%q", k, vs[i], got[i])
			}
		}
	}
}

// TestStatic_EvictAppReportsFreedBytes 守住 R2-CA-2：EvictApp 的返回值与日志里的
// "记账字节"必须包含资源缓存那一笔。
//
// 判据（行为级）：预热一份 2 MiB 资源（缓存真的持有它）→ EvictApp 返回的 bytes 必须
// ≥ 2 MiB，且平台日志里的记账数字不为 0；逐出后缓存字节归零。
//
// 变异：把 releases 那一笔从 bytes 里去掉（只留条目数）⇒ bytes=0、日志写"记账 0 KiB"⇒ 本用例红。
func TestStatic_EvictAppReportsFreedBytes(t *testing.T) {
	var lines []string
	e := newEnv(t, func(o *Options) {
		o.Logger = func(format string, args ...any) {
			lines = append(lines, sprintf(format, args...))
		}
	})
	appID := e.appID("rtacc")
	big := strings.Repeat("M", 2<<20)
	spec := appSpec{appID: appID, config: publicConfig(), assets: map[string]string{"big.js": big}}
	e.publishApp(spec)
	if rec := e.get(appID, "/big.js"); rec.Code != http.StatusOK {
		t.Fatalf("预热失败: %d", rec.Code)
	}
	if st := e.srv.releases.stats(); st.Bytes < int64(len(big)) {
		t.Fatalf("预热后缓存应持有该资源：Bytes=%d want≥%d", st.Bytes, len(big))
	}

	_, bytes := e.srv.EvictApp(appID)
	if bytes < int64(len(big)) {
		t.Fatalf("EvictApp 记账字节必须包含资源缓存：bytes=%d want≥%d（R2-CA-2）", bytes, len(big))
	}
	if st := e.srv.releases.stats(); st.Bytes != 0 {
		t.Fatalf("逐出后资源缓存字节必须归零，得到 %d", st.Bytes)
	}
	var logged bool
	for _, l := range lines {
		if strings.Contains(l, "事件驱动逐出") {
			logged = true
			if strings.Contains(l, "记账 0 KiB") {
				t.Fatalf("日志把 2 MiB 的释放记成 0 KiB：%s", l)
			}
		}
	}
	if !logged {
		t.Fatalf("EvictApp 必须有逐出日志，实际日志=%v", lines)
	}
}

// TestReleaseCache_SingleReleaseOverBudgetFallsBackToMetadata 守住 R2-CA-5 的**结构性上界**：
// 当"单个 release 的资源总量"超过缓存字节上限时（现实中由自定义段总量上限挡住，本用例
// 刻意违反它以证明**本包自己**仍然有界），唯一那条不逐出的条目必须退化成"只缓存元数据"。
//
// 变异：去掉 enforceByteBoundLocked ⇒ stats().Bytes 越过 maxBytes ⇒ 本用例红。
func TestReleaseCache_SingleReleaseOverBudgetFallsBackToMetadata(t *testing.T) {
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	const maxBytes = int64(64 << 10)
	c := newReleaseCache(maxBytes, 8, func() time.Time { return now })
	k := releaseKey{AppID: "big", ReleaseID: 1}
	blob := bytes.Repeat([]byte("a"), 32<<10) // 每资源 32 KiB，4 个 ⇒ 128 KiB > 64 KiB

	for i := 0; i < 4; i++ {
		c.putAsset(k, fmt.Sprintf("f%d", i), assetEntry{
			ContentType: "application/octet-stream", ETag: fmt.Sprintf(`"e%d"`, i),
			Size: len(blob), Data: blob, BytesCached: true,
		})
		if st := c.stats(); st.Bytes > maxBytes {
			t.Fatalf("单条自身超预算时必须退化为元数据：Bytes=%d > maxBytes=%d（硬上界不得依赖跨模块假设）",
				st.Bytes, maxBytes)
		}
	}
	// 元数据必须还在：304 复验只靠 ETag，正文回源读盘。
	got, ok := c.asset(k, "f0")
	if !ok || got.ETag == "" {
		t.Fatalf("退化后元数据必须仍在（304 复验靠 ETag）：ok=%v entry=%+v", ok, got)
	}
	if got.BytesCached {
		t.Fatalf("超预算的条目不得继续持有字节：%+v", got)
	}
	// 结构性上界：**任何时刻**字节总量都不得超过 maxBytes（旧实现允许"唯一那条"无界超额）。
	if st := c.stats(); st.Bytes > maxBytes {
		t.Fatalf("退化后缓存字节仍越过 maxBytes：%d > %d", st.Bytes, maxBytes)
	}
}

// TestReleaseCache_BudgetCoversSingleReleaseWorstCase 把两条**跨模块**常量绑在一起
// （R2-CA-5 的另一半）：文档承诺的硬上界含"单个 release 的资源总量 ≤ SectionTotalMaxBytes"
// 这一项，而那个上限由 wasmmod 的段总量校验保证。此前 appserver 侧没有任何断言把两者绑住
// —— 调大段总量上限（或让资源改走别的抽取通道）会静默把本缓存的硬上界推高。
//
// 判据：最坏情况（一个 release 的全部资源 = 段总量上限）必须仍然放得进缓存字节预算；
// 若将来有人把它调过头，本用例红并要求回到 readyz 的记账边界重新算账。
func TestReleaseCache_BudgetCoversSingleReleaseWorstCase(t *testing.T) {
	if int64(limits.SectionTotalMaxBytes) > limits.ReleaseCacheMaxBytes {
		t.Fatalf("单个 release 的资源总量上限（SectionTotalMaxBytes=%d，由 wasmmod 段总量校验保证）"+
			"超过了资源缓存字节预算（ReleaseCacheMaxBytes=%d）：文件头承诺的硬上界不再成立，"+
			"必须同步调整这两者（并回到 readyz 的记账边界重算）",
			limits.SectionTotalMaxBytes, limits.ReleaseCacheMaxBytes)
	}
	// 反过来也钉住"本地防线"的口径：单条资源的本地防线阈值（maxBytes/2）必须不小于单文件
	// 上限，否则那道防线会在**单文件合法**的情况下触发（把正常资源降级成元数据）。
	if h := int64(limits.ReleaseCacheMaxBytes / 2); int64(limits.SectionTotalMaxBytes) > h {
		t.Fatalf("单文件上限 %d 超过本地防线阈值 %d：合法单文件会被降级成元数据（口径漂移）",
			limits.SectionTotalMaxBytes, h)
	}
}
