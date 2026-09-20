//go:build perfprobe

package appserver

// 量化探针（**不进常规门禁**）：200 KiB 静态资源的固定成本，无缓存 vs 命中缓存。
//
// 复跑：
//
//	cd server && PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/picoaide_test?sslmode=disable \
//	  bash ../temp/wasm-heavy.sh 900 go test -tags perfprobe ./internal/wasmapp/appserver/ \
//	  -run TestPerfProbe_StaticFixedCost -count=1 -v
//
// 两条被测量的路径（**同一进程、同一台机器**，因此可比）：
//
//	"无缓存" = set.Read(app.js) + sha256(200 KiB) + appcfg.Parse(配置)
//	         —— 这正是旧 serveStatic 每请求都要付的重复成本。
//	"改后"  = ServeApp 的完整请求（含 3 次 PG 查询 + 准入 + 缓存命中 + 写头/写体）：
//	         ① 预热后的 If-None-Match 复验（应 304，且不碰资源集、不算哈希）
//	         ② 预热后的普通 200（元数据命中 ⇒ 不重算 ETag；正文来自内存资源集）
//
// 2026-09-20 口径变化（决策文档 docs/decisions/2026-09-20-wasm-assets-in-memory.md）：
// 随包资源不再落盘，`set.Read` 从"读盘 + Lstat 逐段校验"变成内存 map 查找 ——
// 探针里保留这一段只是为了与 sha256 / 配置解析一起构成"无缓存"基线；
// 真正的节省项是 **sha256（元数据缓存）** 与 **304 路径完全不碰资源集**。

import (
	"crypto/sha256"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
	"github.com/picoaide/picoaide/internal/wasmapp/assets"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// moduleSetForTest 取模块缓存里该版本的内存资源集（探针用；取不到即 Fatal）。
func moduleSetForTest(t *testing.T, e *env, rel *serverstore.WasmRelease) *assets.Set {
	t.Helper()
	key := moduleKey{AppID: rel.AppID, Version: rel.Version, ReleaseID: rel.ID}
	e.srv.modules.mu.Lock()
	defer e.srv.modules.mu.Unlock()
	entry, ok := e.srv.modules.items[key]
	if !ok || entry.set == nil {
		t.Fatalf("模块缓存里应有该版本的内存资源集: key=%+v", key)
	}
	return entry.set
}

// TestPerfProbe_StaticFixedCost 打印"无缓存基线"与"命中缓存后"的每请求成本（µs）。
func TestPerfProbe_StaticFixedCost(t *testing.T) {
	if testing.Short() {
		t.Skip("-short")
	}
	// 客户端专属模型下不再有匿名限流（限流器随 W4 删除），直接装配缺省环境。
	e := newEnv(t)
	appID := e.appID("perf")
	body := "<html><head><title>demo</title></head><body>" + strings.Repeat("x", 200*1024) + "</body></html>"
	// 资源名避开入口文档："/" 与 "/index.html" 在客户端模型下一律交给 wasm，
	// 静态路径只对非入口资源成立（这正是本探针要测的那条路）。
	spec := appSpec{appID: appID, config: loginConfig(), assets: map[string]string{"app.js": body}}
	rel := e.publishApp(spec)

	// 预热一次完整请求：把资源集与元数据缓存都建起来。
	if rec := e.get(appID, "/app.js"); rec.Code != http.StatusOK {
		t.Fatalf("预热失败: %d", rec.Code)
	}
	set := moduleSetForTest(t, e, rel)

	// ===== 无缓存基线：每请求 set.Read + sha256(200 KiB) + 配置解析 =====
	const iters = 500
	var readT, hashT, cfgT, baseTotal time.Duration
	for i := 0; i < iters; i++ {
		start := time.Now()
		_, page, aerr := set.Read("app.js")
		if aerr != nil {
			t.Fatalf("set.Read(app.js): %v", aerr)
		}
		t1 := time.Now()
		_ = sha256.Sum256(page)
		t2 := time.Now()
		_, cfgData, aerr := set.Read(limits.AppConfigFileName)
		if aerr != nil {
			t.Fatalf("set.Read(配置): %v", aerr)
		}
		if _, perr := appcfg.Parse(cfgData); perr != nil {
			t.Fatalf("解析配置: %v", perr)
		}
		t3 := time.Now()
		readT += t1.Sub(start)
		hashT += t2.Sub(t1)
		cfgT += t3.Sub(t2)
		baseTotal += t3.Sub(start)
	}
	per := func(d time.Duration) float64 { return float64(d.Microseconds()) / iters }

	// ===== 改后（组件级，不含 PG）：元数据命中下的每一段 =====
	// 仍然是"取配置 + 取资源 + 判 ETag"，只是配置与元数据都从 (app_id, release_id)
	// 级缓存来 ⇒ 不再重算 sha256。
	var newTotal time.Duration
	for i := 0; i < iters; i++ {
		start := time.Now()
		rq := e.srv.openReleaseContent(appID, rel, set)
		if _, cerr := rq.Config(); cerr != nil {
			t.Fatalf("配置（应命中缓存）: %v", cerr)
		}
		a, data, aerr := rq.Asset("app.js")
		if aerr != nil {
			t.Fatalf("资源（应命中元数据缓存）: %v", aerr)
		}
		if a.ETag == "" || len(data) != len(body) {
			t.Fatalf("缓存命中的元数据/字节不对: etag=%q len(data)=%d", a.ETag, len(data))
		}
		newTotal += time.Since(start)
	}

	// ===== 改后 ①：预热后的 304 复验（If-None-Match 命中）=====
	first := e.get(appID, "/app.js")
	if first.Code != http.StatusOK {
		t.Fatalf("预热失败: %d", first.Code)
	}
	etag := first.Header().Get("ETag")
	warm := e.srv.releases.stats()

	const reqIters = 2000
	start := time.Now()
	for i := 0; i < reqIters; i++ {
		rec := e.getWithETag(appID, "/app.js", etag)
		if rec.Code != http.StatusNotModified {
			t.Fatalf("第 %d 次复验应 304，得到 %d", i, rec.Code)
		}
	}
	revalidate := time.Since(start) / reqIters

	// ===== 改后 ②：预热后的普通 200（元数据命中；正文来自内存资源集）=====
	start = time.Now()
	for i := 0; i < reqIters; i++ {
		rec := e.get(appID, "/app.js")
		if rec.Code != http.StatusOK || rec.Body.Len() != len(body) {
			t.Fatalf("第 %d 次 200 请求异常: %d len=%d", i, rec.Code, rec.Body.Len())
		}
	}
	serve200 := time.Since(start) / reqIters

	after := e.srv.releases.stats()
	if after.SourceReads != warm.SourceReads {
		t.Fatalf("预热后不得再回源派生元数据：SourceReads %d → %d", warm.SourceReads, after.SourceReads)
	}

	t.Logf("=== 200 KiB 静态资源固定成本（iters=%d/%d，同机同进程）===", iters, reqIters)
	t.Logf("无缓存基线（旧 serveStatic 每请求都付的重复成本；现在 set.Read 是内存查找）:")
	t.Logf("    set.Read(app.js)        %8.1f us", per(readT))
	t.Logf("    sha256(200 KiB)         %8.1f us", per(hashT))
	t.Logf("    应用配置 读取+解析        %8.1f us", per(cfgT))
	t.Logf("    --------- 合计           %8.1f us", per(baseTotal))
	t.Logf("改后（同样每一段，元数据/配置全部命中缓存）:")
	t.Logf("    配置 + 资源元数据 + 字节   %8.1f us   （无缓存基线的 %.1fx）",
		per(newTotal), per(baseTotal)/per(newTotal))
	t.Logf("端到端 ServeApp（**含 3 次 PG 查询 + 准入 + 写头/写体**，这部分与缓存无关）:")
	t.Logf("    If-None-Match 复验 304   %8.1f us", float64(revalidate.Microseconds()))
	t.Logf("    普通 200（元数据命中）    %8.1f us", float64(serve200.Microseconds()))
	t.Logf("    （SourceReads 增量=%d，即两条路径都没有重新派生元数据）", after.SourceReads-warm.SourceReads)
}
