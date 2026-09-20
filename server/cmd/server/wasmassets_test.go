package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/appseed"
	"github.com/picoaide/picoaide/internal/wasmapp/appserver"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是**"随包资源内存直出"的端到端判据**（2026-09-20 定案）。
//
// 它复现并锁死那个真实事故：演示应用（走 appseed 播种、不走发布链路）的
// `index.html` / `static/*` 曾经从未落盘 ⇒ 入口页 `assets.read("index.html")` 返回
// NOT_FOUND ⇒ 500。修复方向是"资源不再落盘，运行期从 wasm 自定义段构造内存资源集"，
// 因此本用例**故意一个资源文件都不写到磁盘上**，然后要求：
//
//  1. 入口 `/` 由 wasm 读**内存里的** index.html 应答（200 + 页面逐字节一致）；
//  2. `/static/app.css` 由宿主**直出**（200 + text/css + 逐字节一致），且**不编译模块**
//     （静态直出不该为一次字节读取付冷编译）；
//  3. 整个数据根下**不存在** `apps/<app_id>/assets/` 目录（负向断言，本次改造的交付判据）；
//  4. 历史遗留的资源目录会被启动清理删掉，**删掉之后服务照常**（回滚/升级路径的正确性）。
//
// 变异验证（实跑过）：
//   - 把 `assets.Build` 里的自定义段解析去掉（资源集为空）⇒ 第 1 条红（500 NOT_FOUND）；
//   - 把静态直出改成"先编译再交给 wasm"⇒ 第 2 条红（CachedModuleCount != 0）；
//   - 把 appseed 的写盘加回来 ⇒ 第 3 条红。

func TestAssetsAreServedFromMemoryWithoutAnyExtraction(t *testing.T) {
	db := requireRealDB(t)
	ensureCompileChildNextToTestBinary(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dataRoot := t.TempDir()
	p := setupWasmPlatform(ctx, db, dataRoot)
	if p == nil {
		t.Fatal("setupWasmPlatform 返回 nil")
	}
	defer p.Close()

	const appID = "demo-inmemory"
	dir := t.TempDir()
	writeFileOrFail(t, filepath.Join(dir, "showcase.wasm"), packedShowcaseModule(t))
	manifest, err := json.Marshal(map[string]any{"demos": []map[string]any{{
		"app_id": appID, "wasm": "showcase.wasm", "title": "内存直出演示",
		"description": "资源不落盘", "access": "login",
		"purpose": "端到端验证随包资源从内存直出", "data_sensitivity": "公开",
	}}})
	if err != nil {
		t.Fatalf("清单序列化: %v", err)
	}
	writeFileOrFail(t, filepath.Join(dir, appseed.ManifestFileName), manifest)

	seeder, err := appseed.New(appseed.Options{DB: db, DataRoot: dataRoot, Dir: dir, Owner: "admin"})
	if err != nil {
		t.Fatalf("appseed.New: %v", err)
	}
	if seeder == nil {
		t.Fatal("有清单时必须返回播种器")
	}
	res, err := seeder.Seed(ctx)
	if err != nil {
		t.Fatalf("播种: %v", err)
	}
	if len(res.Seeded) != 1 {
		t.Fatalf("应播种 1 条，得到 %+v", res)
	}

	// ---- ⓪ 播种之后，数据根里**不得**出现按版本抽取的资源目录（本次改造的交付判据）----
	assetsDir := filepath.Join(dataRoot, limits.AppsDirName, appID, "assets")
	if _, err := os.Stat(assetsDir); !os.IsNotExist(err) {
		t.Fatalf("播种后数据根下不得出现资源目录 %s（stat err=%v）", assetsDir, err)
	}

	// 再造一个"历史遗留"的资源目录（模拟从旧版本升上来的数据根）：它既不能被当成真源，
	// 也要能被启动清理删掉。
	legacy := filepath.Join(assetsDir, "1")
	if err := os.MkdirAll(legacy, 0o755); err != nil {
		t.Fatalf("造历史资源目录: %v", err)
	}
	writeFileOrFail(t, filepath.Join(legacy, limits.AppConfigFileName), []byte(`{"access":"public"}`))
	writeFileOrFail(t, filepath.Join(legacy, "index.html"), []byte("STALE-FROM-DISK"))

	user := &serverstore.User{ID: 1, Username: "alice"}
	get := func(path string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "http://"+appID+path, nil)
		req.URL.Scheme, req.URL.Host, req.Host = appserver.ClientScheme, appID, appID
		rec := httptest.NewRecorder()
		p.AppServer.ServeClientRequest(rec, req, appID, user, "0123456789abcdef0123456789abcdef")
		return rec
	}

	// ---- ① 静态资源由宿主直出，且**不触发编译**（先做这一条：此时还没人编译过）----
	rec := get("/static/app.css")
	if rec.Code != 200 {
		t.Fatalf("/static/app.css = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/css" {
		t.Fatalf("/static/app.css content-type = %q, want text/css", ct)
	}
	if rec.Body.String() != demoWebFile(t, "app.css") {
		t.Fatal("/static/app.css 正文与包内文件不一致")
	}
	if got := p.AppServer.CachedCompiledModuleCount(); got != 0 {
		t.Fatalf("静态直出不得编译模块，已编译条目 = %d（非 0 说明走了\"先编译再交给 wasm\"）", got)
	}
	if got := p.AppServer.CachedModuleCount(); got != 1 {
		t.Fatalf("静态直出应建立\"资源就绪\"条目（1 条，只含资源集），得到 %d", got)
	}

	// ---- ② 入口页由 wasm 读**内存里的** index.html 应答（这一条才会编译）----
	wantHTML := demoWebFile(t, "index.html")
	rec = get("/")
	if rec.Code != 200 {
		t.Fatalf("入口 / = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != wantHTML {
		t.Fatalf("入口页正文不是包内 index.html（%d 字节 vs %d 字节，前 80 字：%q）",
			rec.Body.Len(), len(wantHTML), truncate(rec.Body.String(), 80))
	}
	if strings.Contains(rec.Body.String(), "STALE-FROM-DISK") {
		t.Fatal("入口页读到了磁盘上那份历史资源 —— 真源必须是内存资源集")
	}
	if got := p.AppServer.CachedCompiledModuleCount(); got != 1 {
		t.Fatalf("入口请求之后应编译出 1 个模块，得到 %d", got)
	}
	if got := p.AppServer.CachedModuleCount(); got != 1 {
		t.Fatalf("编译不得新建条目（必须补齐同一条的资源集），条目数 = %d", got)
	}
	// 只有应用自己用 assets.read 读得到的保留资源：宿主永不直出。
	if rec := get("/" + limits.AppConfigFileName); rec.Code == 200 && strings.Contains(rec.Body.String(), "whitelist") {
		t.Fatal("保留资源 picoaide.app.json 不得被宿主直出")
	}

	// 服务过程**不得**产生任何新的资源目录（历史那个是我们自己造的，只等清理）。
	if _, err := os.Stat(filepath.Join(assetsDir, "2")); !os.IsNotExist(err) {
		t.Fatalf("运行期不得再产生按版本抽取的目录（%s/2 存在）", assetsDir)
	}

	// ---- ④ 历史目录被清理后服务照常（升级/回滚路径的正确性）----
	if dirs, _ := appserver.CleanupLegacyAssetDirs(dataRoot, t.Logf); dirs != 1 {
		t.Fatalf("历史资源目录应被清理 1 个，得到 %d", dirs)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("历史资源目录应被删除，stat err=%v", err)
	}
	if rec := get("/"); rec.Code != 200 || !strings.Contains(rec.Body.String(), "<html") {
		t.Fatalf("清理历史目录后入口仍须可用：%d %q", rec.Code, truncate(rec.Body.String(), 80))
	}
	if rec := get("/static/app.js"); rec.Code != 200 || rec.Body.String() != demoWebFile(t, "app.js") {
		t.Fatalf("清理历史目录后静态资源仍须可用：%d（%d 字节）", rec.Code, rec.Body.Len())
	}
}

// packedShowcaseModule 现场编译演示应用 showcase 并把 web/ 三件套**作为自定义段**附加。
//
// 刻意不用 Node 版的 pack-assets.mjs：测试环境只保证有 Go 工具链；自定义段的二进制
// 形态很简单（id=0 + uleb(负载长) + uleb(段名长) + 段名 + 内容），照着拼即可 ——
// 平台侧解析用的是**产品自己的** wasmmod.Parse，所以这里不需要"另一套解析器"。
func packedShowcaseModule(t *testing.T) []byte {
	t.Helper()
	packedShowcaseOnce.Do(func() {
		rootOut, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}").Output()
		if err != nil {
			packedShowcaseErr = err
			return
		}
		root := strings.TrimSpace(string(rootOut))
		out, err := os.MkdirTemp("", "picoaide-cmdserver-showcase-")
		if err != nil {
			packedShowcaseErr = err
			return
		}
		wasmPath := filepath.Join(out, "showcase.wasm")
		cmd := exec.Command("go", "build", "-o", wasmPath, "./demoapps/showcase")
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GOOS=wasip1", "GOARCH=wasm", "CGO_ENABLED=0")
		if b, berr := cmd.CombinedOutput(); berr != nil {
			packedShowcaseErr = fmt.Errorf("构建 showcase 失败: %v\n%s", berr, b)
			return
		}
		module, err := os.ReadFile(wasmPath)
		if err != nil {
			packedShowcaseErr = err
			return
		}
		for _, pair := range [][2]string{
			{"index.html", "index.html"},
			{"app.css", "static/app.css"},
			{"app.js", "static/app.js"},
		} {
			content, rerr := os.ReadFile(filepath.Join(root, "demoapps", "showcase", "web", pair[0]))
			if rerr != nil {
				packedShowcaseErr = rerr
				return
			}
			module = appendCustomSection(module, pair[1], content)
		}
		packedShowcaseBytes = module
	})
	if packedShowcaseErr != nil {
		t.Fatalf("%v", packedShowcaseErr)
	}
	return packedShowcaseBytes
}

var (
	packedShowcaseOnce  sync.Once
	packedShowcaseBytes []byte
	packedShowcaseErr   error
)

// appendCustomSection 追加一个自定义段（段名 = 包内逻辑路径）。
func appendCustomSection(module []byte, name string, data []byte) []byte {
	payload := append(uleb(uint32(len(name))), name...)
	payload = append(payload, data...)
	out := append(module, 0x00)
	out = append(out, uleb(uint32(len(payload)))...)
	return append(out, payload...)
}

// uleb 是 LEB128 无符号编码（wasm 的长度前缀格式）。
func uleb(v uint32) []byte {
	var out []byte
	for {
		b := byte(v & 0x7f)
		v >>= 7
		if v != 0 {
			b |= 0x80
		}
		out = append(out, b)
		if v == 0 {
			return out
		}
	}
}

// demoWebFile 读演示应用 web/ 目录里的文件（与打进自定义段的那份逐字节同源）。
func demoWebFile(t *testing.T, name string) string {
	t.Helper()
	rootOut, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}").Output()
	if err != nil {
		t.Fatalf("定位模块根: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(strings.TrimSpace(string(rootOut)),
		"demoapps", "showcase", "web", name))
	if err != nil {
		t.Fatalf("读 demoapps/showcase/web/%s: %v", name, err)
	}
	return string(raw)
}

func writeFileOrFail(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatalf("写 %s: %v", path, err)
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
