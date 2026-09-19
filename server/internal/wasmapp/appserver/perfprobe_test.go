//go:build perfprobe

package appserver

// 量化探针（**不进常规门禁**）：200 KiB 静态资源的固定成本，改前 vs 改后。
//
// 复跑：
//
//	cd server && PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/picoaide_test?sslmode=disable \
//	  bash ../temp/wasm-heavy.sh 900 go test -tags perfprobe ./internal/wasmapp/appserver/ \
//	  -run TestPerfProbe_StaticFixedCost -count=1 -v
//
// 两条被测量的路径（**同一进程、同一台机器**，因此可比）：
//
//	"改前" = assets.Open + loadAppConfig（读盘+解析）+ store.Read(200 KiB) + sha256(200 KiB)
//	         —— 这正是旧 serveStatic 每请求做的事（先整份读盘、算哈希、再判 If-None-Match）。
//	"改后" = ServeApp 的完整请求（含 3 次 PG 查询 + 准入 + 缓存命中 + 写头/写体）：
//	         ① 预热后的 If-None-Match 复验（应 304，且不读盘、不算哈希）
//	         ② 预热后的普通 200（应从缓存取字节，同样不读盘）
//
// 改前的"整条请求"还包含 PG 三段查询（审计实测 0.919 ms），这里不重复测它 ——
// 报告里的对比同时在"组件固定成本"这一层做（那是静态路径真正的可变部分）。

import (
	"crypto/sha256"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
	"github.com/picoaide/picoaide/internal/wasmapp/assets"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// TestPerfProbe_StaticFixedCost 打印改前/改后的每请求成本（µs）。
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

	dir := releaseDirOf(t, e, spec, rel.ID)
	pagePath := filepath.Join(dir, "app.js")

	// ===== 改前：旧 serveStatic 的固定成本（读盘 + 解析 + 读资源 + 算哈希）=====
	const iters = 500
	var openT, cfgT, readT, hashT, oldTotal time.Duration
	for i := 0; i < iters; i++ {
		start := time.Now()
		store, aerr := assets.Open(e.root, appID, fmt.Sprintf("%d", rel.ID))
		if aerr != nil {
			t.Fatalf("assets.Open: %v", aerr)
		}
		t1 := time.Now()
		_, cfgData, aerr := store.Read(limits.AppConfigFileName)
		if aerr != nil {
			t.Fatalf("读配置: %v", aerr)
		}
		if _, perr := appcfg.Parse(cfgData); perr != nil {
			t.Fatalf("解析配置: %v", perr)
		}
		t2 := time.Now()
		_, page, aerr := store.Read("app.js")
		if aerr != nil {
			t.Fatalf("读资源: %v", aerr)
		}
		t3 := time.Now()
		sum := sha256.Sum256(page)
		_ = sum
		t4 := time.Now()
		openT += t1.Sub(start)
		cfgT += t2.Sub(t1)
		readT += t3.Sub(t2)
		hashT += t4.Sub(t3)
		oldTotal += t4.Sub(start)
	}
	per := func(d time.Duration) float64 { return float64(d.Microseconds()) / iters }

	// ===== 改后（组件级，不含 PG）：同样的每一段在**缓存命中**下的成本 =====
	// 与"改前"逐段对拍：仍然是"每请求打开资源目录（平台状态断言）+ 取配置 + 取资源 + 判 ETag"，
	// 只是配置与资源都从 (app_id, release_id) 级缓存来。
	var newOpen, newTotal time.Duration
	for i := 0; i < iters; i++ {
		start := time.Now()
		store, aerr := assets.Open(e.root, appID, fmt.Sprintf("%d", rel.ID))
		if aerr != nil {
			t.Fatalf("assets.Open: %v", aerr)
		}
		t1 := time.Now()
		rq := e.srv.openReleaseContent(appID, rel, store)
		if _, cerr := rq.Config(); cerr != nil {
			t.Fatalf("配置（应命中缓存）: %v", cerr)
		}
		a, aerr := rq.Asset("app.js")
		if aerr != nil {
			t.Fatalf("资源（应命中缓存）: %v", aerr)
		}
		if !etagMatches(`"`+strings.Repeat("0", 32)+`"`, a.ETag) && a.ETag == "" {
			t.Fatal("缓存里的 ETag 不能为空（304 判据靠它）")
		}
		newOpen += t1.Sub(start)
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

	// ===== 改后 ②：预热后的普通 200（正文从缓存取）=====
	start = time.Now()
	for i := 0; i < reqIters; i++ {
		rec := e.get(appID, "/app.js")
		if rec.Code != http.StatusOK || rec.Body.Len() != len(body) {
			t.Fatalf("第 %d 次 200 请求异常: %d len=%d", i, rec.Code, rec.Body.Len())
		}
	}
	serve200 := time.Since(start) / reqIters

	after := e.srv.releases.stats()
	if after.DiskReads != warm.DiskReads {
		t.Fatalf("预热后不得再读盘：DiskReads %d → %d", warm.DiskReads, after.DiskReads)
	}

	t.Logf("=== 200 KiB 静态资源固定成本（iters=%d/%d，同机同进程）===", iters, reqIters)
	t.Logf("改前（旧 serveStatic 的每一段，逐请求都付）:")
	t.Logf("    assets.Open            %8.1f us", per(openT))
	t.Logf("    应用配置 读盘+解析       %8.1f us", per(cfgT))
	t.Logf("    资源读盘 (200 KiB)      %8.1f us", per(readT))
	t.Logf("    sha256(200 KiB)        %8.1f us", per(hashT))
	t.Logf("    --------- 合计          %8.1f us", per(oldTotal))
	t.Logf("改后（同样每一段，缓存命中）:")
	t.Logf("    assets.Open            %8.1f us", per(newOpen))
	t.Logf("    应用配置 + 资源（缓存）   %8.1f us", per(newTotal)-per(newOpen))
	t.Logf("    --------- 合计          %8.1f us   （改前 %.1f us ⇒ %.1fx）",
		per(newTotal), per(oldTotal), per(oldTotal)/per(newTotal))
	t.Logf("端到端 ServeApp（**含 3 次 PG 查询 + 准入 + 写头/写体**，这部分与本次修复无关）:")
	t.Logf("    If-None-Match 复验 304  %8.1f us", float64(revalidate.Microseconds()))
	t.Logf("    普通 200（缓存字节）     %8.1f us", float64(serve200.Microseconds()))
	t.Logf("    （二次 DiskReads=%d，即两条路径都不读盘）", after.DiskReads-warm.DiskReads)

	_ = pagePath
	_ = os.Getpid
}
