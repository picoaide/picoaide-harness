package appserver

// 本文件是 R1-rt-2 / R1-rt-3（静态资源热路径零重复派生）的**行为级护栏**。
//
// 现场（审计 runtime-perf.md R1-rt-2/3，HEAD 7da0ba47dd，当时资源在宿主盘上）：
//
//   - R1-rt-2：`serveStatic` 先整份读盘（store.Read）→ 算 sha256 → **之后**才判
//     `If-None-Match` ⇒ 304 复验一分钱不省（实测 200 KiB 资源 665 µs/请求），
//     而浏览器每 5 分钟缓存窗口之后每个资源都要复验一次。
//   - R1-rt-3：请求热路径零缓存 ⇒ 每个静态子资源都要重付"读盘 + SHA-256 + 配置读盘解析"。
//
// 2026-09-20 口径变化（决策文档 docs/decisions/2026-09-20-wasm-assets-in-memory.md）：
// 随包资源不再落盘，运行期从**内存资源集**（`assets.Set`）直出。于是：
//
//   - `DiskReads` → `SourceReads`：没有磁盘可读了，但"304 复验不得回源"这条断言必须留下
//     —— 观测点从"删掉盘上文件后仍 304"改成"回源派生次数不增长"，并保留一条行为级佐证
//     （把资源集换成另一份内容后，304 仍必须返回缓存里的 ETag，见下）；
//   - 本缓存只留**元数据**（content-type / ETag / Size）与解析后的配置：字节的真源就是
//     资源集，再缓存一份等于同一份内容在内存里存两遍（还要凭空多维护一套字节预算）。
//
// # 变异验证（把实现改回去时哪条会红，2026-09-20 复核）
//
//	(a) 让 304 路径**重新派生元数据**（不再走 `CachedAsset`：缓存被绕过、或实现改回
//	    "先回源算哈希、再判 If-None-Match"）⇒ TestStatic_NotModifiedDoesNotTouchSource 红
//	    （资源集已被换成另一份内容：回源会算出新 ETag → 200；SourceReads 也会涨）。
//	    ⚠️ 实测边界：单纯在 304 判定之前多调一次 `rc.Asset(logical)` **不会红** ——
//	    它命中元数据缓存、不重算 ETag（temp/rc-mut/RESULTS.md 的 overlay D）。被守住的
//	    回归形态是"元数据缓存被绕过/重算 sha256"，不是"多一次 map 查找"。
//	(b) 让 `releaseCache.asset()` 永远未命中（每个请求都重算 ETag）⇒
//	    TestStatic_NotModifiedDoesNotTouchSource / TestStatic_CacheHitSkipsDerivation /
//	    TestReleaseCache_ConfigIsCachedPerRelease 的 SourceReads 断言红（overlay A 实测：
//	    前两条红）；
//	(c) 去掉换版本时的失效（dropOtherReleasesLocked 变 no-op）⇒
//	    TestStatic_NewVersionIsVisibleImmediately 仍绿（键含 release_id，正确性不依赖它），
//	    但 TestReleaseCache_VersionChangeDropsOldRelease 红（旧版本条目滞留）；
//	(d) 去掉 EvictApp 里的 releases.evictApp ⇒ TestStatic_EvictAppInvalidatesCache 红
//	    （逐出后 SourceReads 不再 +1）；
//	(e) 去掉 evictLocked 的条目淘汰 ⇒ TestReleaseCache_IsBounded 红；
//	(f) 让 putConfig 缓存失败 ⇒ TestReleaseCache_ConfigFailureIsNotCached 红；
//	(g) 把"随包资源抽取到 <data_root>/apps/<app_id>/assets/"加回发布/运行期链路 ⇒
//	    TestStatic_NoAssetDirectoryOnDisk 红（本次改造的交付判据）；
//	(h) 把 `assets.read`（或配置读取）改回读宿主盘上的抽取目录 ⇒
//	    TestStatic_AssetsReadUsesMemorySet 红（静态直出与应用读资源必须是同一份内存资源集）。
//
// # 被删掉的判据与为什么删（**不静默删除**）
//
//   - `TestStatic_NotModifiedDoesNotTouchDisk` → 改成 `TestStatic_NotModifiedDoesNotTouchSource`：
//     没有磁盘可删了，判据改为"换掉资源集内容后仍返回缓存 ETag + SourceReads 不变"。
//   - `TestStatic_CachedBytesSurviveFileRemoval` → 换成 `TestStatic_CacheHitSkipsDerivation`：
//     字节不再由本缓存持有（"删掉盘上文件后仍 200"这条判据没有对象了），等价判据是
//     "命中缓存时不再重算 ETag"（字节照旧从内存资源集取）。
//   - `TestReleaseCache_IsBounded` 的**字节预算**分支（含"单条超预算一半只缓存元数据"）、
//     `TestReleaseCache_SingleReleaseOverBudgetFallsBackToMetadata`、
//     `TestReleaseCache_BudgetCoversSingleReleaseWorstCase`：字节维度随内存资源集取消 ——
//     资源字节计入模块缓存的 `module_cache_mb`（modules.go 的 insertSet 把 `set.Bytes()`
//     记进条目 size），本缓存再维护一套字节预算就是同一笔账记两遍。条目数上限 + 空闲 TTL
//     仍由 `TestReleaseCache_IsBounded` / `TestReleaseCache_IdleSweepFreesEntries` 守住。
//   - `TestReleaseCache_ConfigReadFailureIsNotCached` / `TestReleaseCache_ConfigCacheRevalidatesAfterTTL`：
//     配置现在来自**随版本不可变的库内 `config_json`**（随资源集注入），"暖缓存下磁盘上的
//     配置被删掉/改坏"这条路径不存在了（配置没有独立的生命周期）⇒ `cfgAt` + TTL 复验机制
//     连同这两条判据一起删。"失败不缓存"这一半以 `TestReleaseCache_ConfigFailureIsNotCached`
//     保留（判据改成"资源集里没有配置时，每次请求都重新查"）。
//   - `TestReleaseCache_BudgetCoversSingleReleaseWorstCase` 绑定的两个常量（单 release 资源
//     总量 vs 资源缓存字节预算）现在毫无关系；资源集自身的 `SectionTotalMaxBytes` 上限由
//     assets 包的测试守卫。

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

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/assets"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/queue"
)

// getWithETag 发一个带 If-None-Match 的客户端 GET（默认注入身份）。
func (e *env) getWithETag(appID, path, etag string) *httptest.ResponseRecorder {
	e.t.Helper()
	req := clientRequestFor(e.t, appID, http.MethodGet, path, "", "")
	req.Header.Set("If-None-Match", etag)
	return e.clientDo(req, appID, e.ownerUser)
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

// replaceSetForTest 把模块缓存里该版本的**内存资源集**换成另一份内容。
//
// 用途只有一个：让"源与缓存不一致"成为可观测状态，从而证明 304 路径没有回源。
// 资源集在 `(app_id, release_id)` 下不可变，所以产品里不可能出现这种状态 —— 这正是它
// 作为判据的价值：一旦实现还在 304 路径上回源，就会读到这份"不该被读到"的内容、算出
// 一个 != `If-None-Match` 的 ETag ⇒ 返回 200，用例立刻红。这与旧判据"把磁盘上的文件
// 删掉"是同一手法（制造"源已经不是缓存记的那份"的状态，看实现有没有碰源）。
func replaceSetForTest(t *testing.T, e *env, rel *serverstore.WasmRelease, files map[string]string) {
	t.Helper()
	if rel == nil {
		t.Fatal("replaceSetForTest 需要版本行")
	}
	sections := make(map[string][]byte, len(files))
	for name, content := range files {
		sections[name] = []byte(content)
	}
	set, aerr := assets.Build(rel.AppID, fmt.Sprintf("%d", rel.ID), sections, nil)
	if aerr != nil {
		t.Fatalf("构造替换用的资源集: %v", aerr)
	}
	key := moduleKey{AppID: rel.AppID, Version: rel.Version, ReleaseID: rel.ID}
	e.srv.modules.mu.Lock()
	defer e.srv.modules.mu.Unlock()
	entry, ok := e.srv.modules.items[key]
	if !ok || entry.set == nil {
		t.Fatalf("模块缓存里应已有该版本（资源就绪）的条目: key=%+v", key)
	}
	entry.set = set
}

// TestStatic_NotModifiedDoesNotTouchSource 是 R1-rt-2 的核心判据：
// 缓存预热后，`If-None-Match` 命中必须**不碰资源集、不重算哈希**。
//
// 判据怎么做到"行为级"而不是"读代码"：预热之后**把资源集换成另一份内容**。
// 只要实现还去回源派生 ETag，就一定会算出新的 ETag（≠ If-None-Match）⇒ 返回 200；
// 反过来，仍然 304 且回同一个 ETag 就证明它只用了缓存里的元数据。另有 SourceReads 计数佐证。
//
// （旧版本这条用例叫 TestStatic_NotModifiedDoesNotTouchDisk，判据是"删掉磁盘上的资源
// 文件"；内存模型下没有盘上副本可删，换成"换掉资源集内容"。）
func TestStatic_NotModifiedDoesNotTouchSource(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("rt304")
	// 资源名刻意避开入口文档（"/" 与 "/index.html" 在客户端专属模型下**一律**交给
	// wasm：平台没有匿名面 ⇒ 静态入口文档路径不可达，见 TestStatic_LoginRequiredEntryGoesToWasm）。
	spec := appSpec{appID: appID, config: loginConfig(), assets: map[string]string{
		"app.js": strings.Repeat("x", 200*1024),
	}}
	rel := e.publishApp(spec)

	// 预热：第一次 GET 走冷路径（回源 + 算哈希 + 回填缓存）。
	first := e.get(appID, "/app.js")
	if first.Code != http.StatusOK {
		t.Fatalf("首次 GET 应 200，得到 %d body=%.200s", first.Code, first.Body.String())
	}
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("静态资源必须有 ETag")
	}
	warm := e.srv.releases.stats()
	if warm.SourceReads == 0 {
		t.Fatal("冷路径必须真的回源派生过元数据（否则下面的断言没有意义）")
	}
	if warm.Entries == 0 {
		t.Fatal("首次访问必须回填 (app_id, release_id) 级缓存（R1-rt-3）")
	}

	// 制造"源已经不是缓存记的那份"：把资源集换成另一份内容。
	// （app_id 每个用例唯一 ⇒ 不会影响别的用例。）
	replaceSetForTest(t, e, rel, map[string]string{"app.js": "console.log('changed')"})

	rec := e.getWithETag(appID, "/app.js", etag)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("缓存命中时 If-None-Match 必须直接 304（不回源）：得到 %d body=%.200s"+
			"（若这里拿到 200 且 ETag 变了，说明 304 路径去回源派生 ETag 了）", rec.Code, rec.Body.String())
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
	if after.SourceReads != warm.SourceReads {
		t.Fatalf("304 复验不得回源派生（SourceReads %d → %d）", warm.SourceReads, after.SourceReads)
	}
}

// TestStatic_CacheHitSkipsDerivation 守住 R1-rt-3 的另一半：热路径不得重复派生元数据。
//
// 字节照旧从内存资源集取（那是 map 查找，本来就便宜），省掉的是 sha256 —— 缓存命中时
// 既不能重算 ETag，也不能改变 ETag/内容。
//
// （旧版本这条用例叫 TestStatic_CachedBytesSurviveFileRemoval，判据是"删掉盘上文件后
// 仍 200"；字节不再由本缓存持有，那条判据没有对象了。）
func TestStatic_CacheHitSkipsDerivation(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("rthash")
	const body = "body{color:red}/* 小资源，同样要证明 200 命中不再重算 ETag */"
	e.publishApp(appSpec{appID: appID, config: loginConfig(), assets: map[string]string{
		"static/app.css": body,
	}})

	first := e.get(appID, "/static/app.css")
	if first.Code != http.StatusOK || first.Body.String() != body {
		t.Fatalf("首次 GET 应 200 且内容一致，得到 %d %q", first.Code, first.Body.String())
	}
	warm := e.srv.releases.stats()
	if warm.SourceReads == 0 {
		t.Fatal("冷路径必须回源派生过一次（否则下面的断言没有意义）")
	}

	second := e.get(appID, "/static/app.css")
	if second.Code != http.StatusOK {
		t.Fatalf("缓存命中应仍然 200：得到 %d body=%.200s", second.Code, second.Body.String())
	}
	if second.Body.String() != body {
		t.Fatalf("缓存命中应返回同一份字节：%q", second.Body.String())
	}
	if second.Header().Get("ETag") != first.Header().Get("ETag") {
		t.Fatalf("同一份内容必须给出同一个 ETag：%q vs %q",
			first.Header().Get("ETag"), second.Header().Get("ETag"))
	}
	if got := e.srv.releases.stats().SourceReads; got != warm.SourceReads {
		t.Fatalf("缓存命中不得重算 ETag（SourceReads %d → %d）：字节仍从内存资源集取，省掉的是 sha256",
			warm.SourceReads, got)
	}
}

// TestStatic_NewVersionIsVisibleImmediately 守住 R1-rt-3 的"换版本必须立刻看到新资源"。
//
// 缓存键含 release_id ⇒ 新版本天然不命中；这条用例不依赖"实现是否显式清理旧条目"，
// 它守的是**用户可见的语义**：发布新版本之后第一个请求就是新内容（不能因为缓存拿到旧字节）。
func TestStatic_NewVersionIsVisibleImmediately(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("rtver")
	e.publishApp(appSpec{appID: appID, version: "1.0.0", config: loginConfig(), assets: map[string]string{
		"app.js": "console.log('v1')",
	}})
	v1 := e.get(appID, "/app.js")
	if v1.Code != http.StatusOK || v1.Body.String() != "console.log('v1')" {
		t.Fatalf("v1 资源不对: %d %q", v1.Code, v1.Body.String())
	}
	etagV1 := v1.Header().Get("ETag")

	e.publishApp(appSpec{appID: appID, version: "2.0.0", config: loginConfig(), assets: map[string]string{
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
// 判据（行为级）：缓存预热之后第二次请求**不回源派生**（SourceReads 不变 = 缓存真的生效）；
// EvictApp 之后的下一次请求**必须回源派生**（SourceReads +1 = 失效真的发生），
// 且内容仍然正确（资源集会被重新加载）。
//
// （旧版本靠"直接改磁盘上的内容"来区分"缓存生效/失效"；字节来源现在是不可变的库内
// 制品，改不了，改用回源派生次数这个可观测量。）
func TestStatic_EvictAppInvalidatesCache(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("rtevict")
	e.publishApp(appSpec{appID: appID, config: loginConfig(), assets: map[string]string{
		"app.js": "old",
	}})

	if rec := e.get(appID, "/app.js"); rec.Code != http.StatusOK || rec.Body.String() != "old" {
		t.Fatalf("预热请求不对: %d %q", rec.Code, rec.Body.String())
	}
	if n := e.srv.releases.entriesForTest(appID); n == 0 {
		t.Fatal("预热后该应用应有缓存条目")
	}
	warm := e.srv.releases.stats()

	// 缓存生效的证据：第二次请求不再回源派生元数据。
	if rec := e.get(appID, "/app.js"); rec.Code != http.StatusOK || rec.Body.String() != "old" {
		t.Fatalf("二次请求失败: %d %q", rec.Code, rec.Body.String())
	}
	if got := e.srv.releases.stats().SourceReads; got != warm.SourceReads {
		t.Fatalf("缓存命中不得回源派生：SourceReads %d → %d", warm.SourceReads, got)
	}

	// 处置事件：下架/冻结/删除都经这一个钩子。
	if mods, _ := e.srv.EvictApp(appID); mods < 0 {
		t.Fatalf("EvictApp 返回值异常: %d", mods)
	}
	if n := e.srv.releases.entriesForTest(appID); n != 0 {
		t.Fatalf("EvictApp 之后不得再有该应用的缓存条目，仍有 %d 个", n)
	}
	after := e.get(appID, "/app.js")
	if after.Code != http.StatusOK || after.Body.String() != "old" {
		t.Fatalf("逐出之后请求仍须正确（资源集会重新加载）：%d %q", after.Code, after.Body.String())
	}
	if got := e.srv.releases.stats().SourceReads; got != warm.SourceReads+1 {
		t.Fatalf("逐出之后必须重新回源派生元数据：SourceReads %d → %d（期望 %d）",
			warm.SourceReads, got, warm.SourceReads+1)
	}
}

// TestReleaseCache_VersionChangeDropsOldRelease 守住"换版本时旧 release 的条目不滞留"。
//
// 正确性不依赖它（键含 release_id），它守的是**及时释放**：同一应用出现新的 release 时，
// 旧 release 的条目必须被丢掉。
func TestReleaseCache_VersionChangeDropsOldRelease(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("rtdrop")
	e.publishApp(appSpec{appID: appID, version: "1.0.0", config: loginConfig(), assets: map[string]string{
		"app.js": "v1",
	}})
	if rec := e.get(appID, "/app.js"); rec.Code != http.StatusOK {
		t.Fatalf("v1 预热失败: %d", rec.Code)
	}
	if got := e.srv.releases.stats().Entries; got != 1 {
		t.Fatalf("v1 预热后应有 1 个缓存条目，得到 %d", got)
	}

	e.publishApp(appSpec{appID: appID, version: "2.0.0", config: loginConfig(), assets: map[string]string{
		"app.js": "v2",
	}})
	if rec := e.get(appID, "/app.js"); rec.Body.String() != "v2" {
		t.Fatalf("v2 内容不对: %q", rec.Body.String())
	}
	if got := e.srv.releases.stats().Entries; got != 1 {
		t.Fatalf("换版本后旧 release 的条目必须被丢掉（只留当前版本），得到 %d 个", got)
	}
}

// TestReleaseCache_IsBounded 是"缓存必须有界"的判据：条目数被上限约束 + LRU 真的淘汰。
//
// 字节维度已随内存资源集取消（见文件头"被删掉的判据"）：本缓存只存元数据，资源字节
// 计入模块缓存的 `module_cache_mb`。所以这里刻意放"大"条目也只是元数据（`Size` 只是
// 回给调用方写 Content-Length 的数字，不参与任何预算判定）。
func TestReleaseCache_IsBounded(t *testing.T) {
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	c := newReleaseCache(4, func() time.Time { return now })
	blob := bytes.Repeat([]byte("a"), 8<<10)

	for i := 0; i < 64; i++ {
		k := releaseKey{AppID: fmt.Sprintf("app-%d", i), ReleaseID: int64(i)}
		for j := 0; j < 4; j++ {
			c.putAsset(k, fmt.Sprintf("f%d", j), assetEntry{
				ContentType: "application/octet-stream", ETag: `"e"`, Size: len(blob),
			})
		}
		if st := c.stats(); st.Entries > 4 {
			t.Fatalf("条目数必须 ≤ maxEntries(4)，得到 %d", st.Entries)
		}
	}
	if st := c.stats(); st.Evictions == 0 {
		t.Fatal("超过上限必须真的发生淘汰")
	}
	// 最近写入的那一条必须还在（LRU 留下的是热的那一端），且元数据可查。
	if _, ok := c.asset(releaseKey{AppID: "app-63", ReleaseID: 63}, "f3"); !ok {
		t.Fatal("LRU 必须留下最近使用的条目（否则缓存永不命中）")
	}

	// 单条"巨大"资源与普通资源在元数据口径下等价：没有字节预算 ⇒ 不存在
	// "单条超预算一半只缓存元数据"这条降级分支（旧判据随字节维度一起删除）。
	big := newReleaseCache(8, func() time.Time { return now })
	big.putAsset(releaseKey{AppID: "huge", ReleaseID: 1}, "big.bin", assetEntry{
		ContentType: "application/octet-stream", ETag: `"h"`, Size: 1 << 30,
	})
	got, ok := big.asset(releaseKey{AppID: "huge", ReleaseID: 1}, "big.bin")
	if !ok {
		t.Fatal("元数据必须仍然可查（304 复验靠它）")
	}
	if got.Size != 1<<30 {
		t.Fatalf("Size 必须如实回给调用方（写 Content-Length 用），得到 %d", got.Size)
	}
}

// TestReleaseCache_IdleSweepFreesEntries 守住"时间维度"那一半的有界性。
func TestReleaseCache_IdleSweepFreesEntries(t *testing.T) {
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	clock := now
	c := newReleaseCache(8, func() time.Time { return clock })
	k := releaseKey{AppID: "a", ReleaseID: 1}
	c.putAsset(k, "f", assetEntry{ContentType: "text/plain", ETag: `"e"`, Size: 1})
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
// 值语义（assetEntry 拷贝）就是为这条服务的；字节由只读的资源集提供。
//
// 复跑（-race 下才有检出能力）：
//
//	PG_DSN_TEST=… bash ../temp/wasm-heavy.sh 900 go test ./internal/wasmapp/appserver/ \
//	  -count=1 -race -run TestReleaseCache_ConcurrentRequestsAreSafe
func TestReleaseCache_ConcurrentRequestsAreSafe(t *testing.T) {
	const workers = 16
	// 并发用例不再需要"放宽匿名限流"的 mutate（匿名面与限流器随 W4 一起删除），
	// 但要放宽**队列的单用户同应用并发**（§4.6 默认 1）：本用例要压的是缓存的并发
	// 正确性，16 个 worker 注入同一个员工时会被队列按设计串行化。
	e := newEnv(t, func(o *Options) {
		o.Scheduler = queue.New(queue.Options{
			PerUserPerAppRunning: workers, PerUserPerAppQueued: workers, PerUserGlobalRunning: workers,
		})
	})
	appID := e.appID("rtconc")
	e.publishApp(appSpec{appID: appID, config: loginConfig(), assets: map[string]string{
		"page.html": "shell",
		"app.js":    "console.log(1)",
		"style.css": "body{}",
	}})
	first := e.get(appID, "/app.js")
	if first.Code != http.StatusOK {
		t.Fatalf("预热失败: %d", first.Code)
	}
	etag := first.Header().Get("ETag")

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

	// 缓存仍然自洽（计数非负），且请求照常可用。
	st := e.srv.releases.stats()
	if st.Entries < 0 || st.AssetHits < 0 || st.AssetMisses < 0 || st.SourceReads < 0 || st.Evictions < 0 {
		t.Fatalf("缓存计数不得为负: %+v", st)
	}
	if rec := e.get(appID, "/app.js"); rec.Code != http.StatusOK || rec.Body.String() != "console.log(1)" {
		t.Fatalf("并发压测后请求仍须正确: %d %q", rec.Code, rec.Body.String())
	}
}

// TestReleaseCache_ConfigIsCachedPerRelease 守住"解析后的 appcfg"这一半：
// 配置只从资源集解析一次（同 release 内复用），换 release 重新解析。
func TestReleaseCache_ConfigIsCachedPerRelease(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("rtcfg")
	spec := appSpec{appID: appID, config: loginConfig(), assets: map[string]string{"app.js": "x"}}
	rel := e.publishApp(spec)

	if rec := e.get(appID, "/app.js"); rec.Code != http.StatusOK {
		t.Fatalf("预热失败: %d", rec.Code)
	}
	misses := e.srv.releases.stats().CfgMisses
	if misses != 1 {
		t.Fatalf("配置只应解析一次（首次），得到 %d 次未命中", misses)
	}
	if rec := e.get(appID, "/app.js"); rec.Code != http.StatusOK {
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

// TestReleaseCache_ConfigFailureIsNotCached 守住"失败不进缓存"这一半（R2-CA-1 的残留）。
//
// 口径变化（2026-09-20）：配置不再来自宿主盘上可被删掉/改坏的文件，而是随版本不可变的
// 库内 `config_json`（随资源集注入）—— 所以"暖缓存下被外部改坏"这条路径消失了，
// 对应的 TTL 复验与用例一起删除。但"不缓存失败"仍然有意义：一个版本可能**根本没有配置**
// （`config_json` 为空 ⇒ 资源集里没有 `picoaide.app.json`），它随新版本/资源集重建可以改变；
// 把失败记进缓存会让这次故障被固化（之后每个请求都命中那份失败记录）。
//
// 判据：两次请求都必须 500（fail-loud，绝不按匿名放行），且 CfgMisses 每次都 +1。
// 变异：让 putConfig 也缓存 err ⇒ 第二次不再解析、CfgMisses 停在 1 ⇒ 本用例红。
func TestReleaseCache_ConfigFailureIsNotCached(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("rtcfgfail")
	e.publishApp(appSpec{appID: appID, skipConfig: true, assets: map[string]string{"app.js": "x"}})

	first := e.get(appID, "/app.js")
	if first.Code != http.StatusInternalServerError {
		t.Fatalf("没有配置必须 500（平台故障，绝不按匿名放行），得到 %d body=%.200s",
			first.Code, first.Body.String())
	}
	second := e.get(appID, "/app.js")
	if second.Code != http.StatusInternalServerError {
		t.Fatalf("第二次仍应 500（失败不得被缓存）：得到 %d body=%.200s", second.Code, second.Body.String())
	}
	st := e.srv.releases.stats()
	if st.CfgMisses != 2 {
		t.Fatalf("读失败不得进缓存：CfgMisses=%d，期望每次请求都未命中（2）", st.CfgMisses)
	}
	if st.CfgHits != 0 {
		t.Fatalf("读失败不得被当成命中：CfgHits=%d", st.CfgHits)
	}
}

// TestReleaseContent_NilSetIsPlatformFault 钉死"资源集未加载"的错误语义：
// `CachedAsset` 只查缓存（不回源、不报错），`Asset`/`Config` 则必须 fail-loud
// 报 `INTERNAL`（而不是 panic 或按"资源不存在"处理 —— 后者会让静态路径静默交给 wasm）。
func TestReleaseContent_NilSetIsPlatformFault(t *testing.T) {
	e := newEnv(t)
	rel := &serverstore.WasmRelease{AppID: "no-set", ID: 7, Version: "1.0.0"}
	rc := e.srv.openReleaseContent(rel.AppID, rel, nil)
	if rc == nil {
		t.Fatal("openReleaseContent 不应返回 nil（rel 非空）")
	}
	if _, ok := rc.CachedAsset("app.js"); ok {
		t.Fatal("资源集未加载时 CachedAsset 必须返回 ok=false（只查缓存，绝不回源）")
	}
	if _, _, aerr := rc.Asset("app.js"); aerr == nil || aerr.Code != apperr.CodeInternal {
		t.Fatalf("资源集未加载时 Asset 必须报 INTERNAL，得到 %v", aerr)
	}
	if _, cerr := rc.Config(); cerr == nil || cerr.Code != apperr.CodeInternal {
		t.Fatalf("资源集未加载时 Config 必须报 INTERNAL，得到 %v", cerr)
	}
	if rc := e.srv.openReleaseContent(rel.AppID, nil, nil); rc != nil {
		t.Fatal("rel 为 nil 时 openReleaseContent 必须返回 nil")
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
	spec := appSpec{appID: appID, config: loginConfig(), assets: map[string]string{
		"index.html": "<html><body>hi</body></html>",
		"app.js":     "console.log(1)",
		"style.css":  "body{color:red}",
	}}
	e.publishApp(spec)

	// 允许的差异白名单：304 不带消息体 ⇒ 不带 Content-Length（RFC 9110 §15.4.5）。
	allowed304Only := map[string]bool{"Content-Length": true}

	// 入口文档（"/"、"/index.html"）不在列表里：客户端专属模型下它们一律交给 wasm
	// （平台没有匿名面 ⇒ 静态入口文档路径不可达），因此没有"静态 304"可对拍。
	for _, p := range []string{"/app.js", "/style.css"} {
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
	headReq := clientRequestFor(t, appID, http.MethodHead, "/app.js", "", "")
	recHead := e.clientDo(headReq, appID, e.ownerUser)
	recGet := e.get(appID, "/app.js")
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

// TestStatic_AssetsReadUsesMemorySet 守住"三条路径读的是同一份内存资源集"这条不变量
// （2026-09-20 内存直出改造的核心）：宿主静态直出与应用自己的 `assets.read` 必须看到
// **同一份**字节，而应用读到的配置必须与宿主判准入用的是**同一份**（库内 config_json）。
//
// 判据（行为级，guest 真的发起宿主调用 —— echoapp 的 `/asset-probe` 分支）：
//   - 静态面 `GET /static/app.css` 拿到资源字节；
//   - 应用面 `GET /asset-probe?path=static/app.css` 拿到同一份字节与 content-type/大小；
//   - `/asset-probe?path=picoaide.app.json` 拿到配置原文（保留资源永不直出，但应用读得到）；
//   - 不存在的路径必须原样回 `NOT_FOUND`（不是 500、也不是"空成功"）。
func TestStatic_AssetsReadUsesMemorySet(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("assetread")
	cfg := loginConfig()
	const css = "body{color:red}"
	e.publishApp(appSpec{appID: appID, config: cfg, assets: map[string]string{
		"static/app.css": css,
	}})

	if rec := e.get(appID, "/static/app.css"); rec.Code != http.StatusOK || rec.Body.String() != css {
		t.Fatalf("静态直出失败: %d %q", rec.Code, rec.Body.String())
	}

	readAsset := func(logical string) (int, map[string]any) {
		t.Helper()
		rec := e.get(appID, "/asset-probe?path="+logical)
		return rec.Code, decodeJSON(t, rec.Body)
	}
	assertResult := func(t *testing.T, body map[string]any) map[string]any {
		t.Helper()
		if body["error"] != nil {
			t.Fatalf("assets.read(%v) 不应失败: %v", body["path"], body)
		}
		res, _ := body["result"].(map[string]any)
		if res == nil {
			t.Fatalf("assets.read 结果不是对象: %v", body)
		}
		return res
	}

	_, body := readAsset("static/app.css")
	res := assertResult(t, body)
	if got := res["text"]; got != css {
		t.Fatalf("assets.read 必须拿到与静态直出同一份字节，得到 %v", got)
	}
	if got := res["encoding"]; got != "text" {
		t.Fatalf("文本资源必须回 text 编码，得到 %v", got)
	}
	if got := res["content_type"]; got != "text/css" {
		t.Fatalf("content-type 应由同一份资源集推导，得到 %v", got)
	}
	if got := res["size"]; got != float64(len(css)) {
		t.Fatalf("size 应为 %d，得到 %v", len(css), got)
	}

	// 保留资源：`picoaide.app.json` 宿主**永不直出**（见 static.go 的 isReservedAsset）
	// —— 请求会交给 wasm，因此判据是"响应体里没有配置内容"（而不是状态码：
	// 应用自己可以对这个路径回任何东西）。但应用用 assets.read 读得到，
	// 且读到的就是宿主判准入用的那份库内 config_json。
	if rec := e.get(appID, "/picoaide.app.json"); strings.Contains(rec.Body.String(), "data_sensitivity") {
		t.Fatalf("保留资源不得由宿主直出（响应体里出现了配置内容）：%d %q", rec.Code, rec.Body.String())
	}
	_, body = readAsset("picoaide.app.json")
	res = assertResult(t, body)
	if got := res["text"]; got != cfg {
		t.Fatalf("应用读到的配置必须与宿主判准入用的同一份（库内 config_json）：%v", got)
	}

	// 不存在 ⇒ 原样透传 NOT_FOUND（不是 500 平台故障、也不是空成功）。
	code, body := readAsset("missing.txt")
	if code != http.StatusInternalServerError {
		t.Fatalf("assets.read 失败时 guest 侧应看到 500 分支，得到 %d", code)
	}
	rpcErr, _ := body["error"].(map[string]any)
	if rpcErr == nil || rpcErr["code"] != "NOT_FOUND" {
		t.Fatalf("不存在的资源必须回 NOT_FOUND，得到 %v", body)
	}
}

// TestStatic_EvictAppReportsFreedBytes 守住 R2-CA-2 在新模型下的落点：
// EvictApp 的**记账字节**必须包含随包资源那一笔，日志不得把一次真实释放写成"记账 0 KiB"。
//
// 口径变化（2026-09-20）：资源字节不再由 releaseCache 持有 ⇒ 它记在**模块缓存**条目上
// （modules.go 的 insertSet 把 `set.Bytes()` 记进 size）。因此本用例断言的是
// "EvictApp 的记账覆盖这份资源集"，而不再是"releaseCache 的字节"。
//
// 变异：把资源集字节从模块缓存的记账里去掉（或让 EvictApp 只回条目数）⇒ bytes=0、
// 日志写"记账 0 KiB" ⇒ 本用例红。
func TestStatic_EvictAppReportsFreedBytes(t *testing.T) {
	var lines []string
	e := newEnv(t, func(o *Options) {
		o.Logger = func(format string, args ...any) {
			lines = append(lines, sprintf(format, args...))
		}
	})
	appID := e.appID("rtacc")
	big := strings.Repeat("M", 2<<20)
	e.publishApp(appSpec{appID: appID, config: loginConfig(), assets: map[string]string{"big.js": big}})
	if rec := e.get(appID, "/big.js"); rec.Code != http.StatusOK {
		t.Fatalf("预热失败: %d", rec.Code)
	}
	if _, cached := e.srv.modules.size(); cached < int64(len(big)) {
		t.Fatalf("预热后模块缓存应记着这份资源集：bytes=%d want≥%d", cached, len(big))
	}

	_, bytes := e.srv.EvictApp(appID)
	if bytes < int64(len(big)) {
		t.Fatalf("EvictApp 记账字节必须包含资源集那一笔：bytes=%d want≥%d（R2-CA-2）", bytes, len(big))
	}
	if _, after := e.srv.modules.size(); after != 0 {
		t.Fatalf("逐出后模块缓存必须归零，得到 %d", after)
	}
	if n := e.srv.releases.entriesForTest(appID); n != 0 {
		t.Fatalf("逐出后资源元数据缓存必须清空，仍有 %d 个条目", n)
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

// TestStatic_NoAssetDirectoryOnDisk 是本次改造（随包资源改内存直出）的**交付判据**：
// 宿主盘上不得再出现 `<data_root>/apps/<app_id>/assets/` 这个按版本抽取的资源目录。
//
// 判据怎么做到行为级：跑一轮"发布 + 静态直出"（发布链路与运行期读资源两条路都走到），
// 然后 `Stat` 那个历史目录 —— 只要有人把"抽段落盘"加回发布链路，或让运行期为了读资源
// 去建/写这个目录，用例立刻红。`assets.read`（应用的读资源出口）与静态直出共用**同一个**
// 内存资源集（hostenv 的适配器只是把 `*assets.Set` 转成 capapi.Assets），所以不存在
// "静态不落盘、assets.read 落盘"的可能：判据是"盘上没有那个目录"，与走哪条出口无关。
//
// 变异验证：把资源抽取（`assets.Write` 那一套）加回 publishApp 之外的任何产品路径，
// 或让 loadReleaseAssets 改成落盘再读 ⇒ 本用例红。
func TestStatic_NoAssetDirectoryOnDisk(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("nodisk")
	e.publishApp(appSpec{
		appID: appID, config: loginConfig(), assetsDir: "custom-dir-1",
		assets: map[string]string{
			"static/app.css": "body{}",
			"index.html":     "<html>shell</html>",
		},
	})
	if rec := e.get(appID, "/static/app.css"); rec.Code != http.StatusOK || rec.Body.String() != "body{}" {
		t.Fatalf("静态直出失败: %d %q", rec.Code, rec.Body.String())
	}
	// 读资源的两条出口都跑一轮：静态直出（宿主）与 `assets.read`（guest 真发一次宿主调用）。
	// 两者共用**同一个**内存资源集（hostenv 的适配器只是把 `*assets.Set` 转成 capapi.Assets），
	// 因此不存在"静态不落盘、assets.read 落盘"的可能。
	if rec := e.get(appID, "/asset-probe?path=static/app.css"); rec.Code != http.StatusOK {
		t.Fatalf("assets.read 探针失败: %d %q", rec.Code, rec.Body.String())
	}
	legacy := filepath.Join(e.root, limits.AppsDirName, appID, legacyAssetsDirName)
	if _, err := os.Stat(legacy); err == nil {
		t.Fatalf("宿主盘上不得出现随包资源目录（本次改造的交付判据）：%s 存在", legacy)
	} else if !os.IsNotExist(err) {
		t.Fatalf("Stat(%s): %v", legacy, err)
	}
}
