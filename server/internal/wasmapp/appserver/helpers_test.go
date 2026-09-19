package appserver

// ---- 变异验证（把闸门改回危险实现时，哪些用例必红）----
//
// ⚠️ 2026-09-19 W4：旧子域路径（换票 / 应用会话 Cookie / 匿名限流 / 主机名门控）
// 已整条删除，下面只列**客户端专属模型下仍然存在**的判据；身份注入 / 无 Cookie /
// Origin 自源那一组在 client_test.go 的文件头（不要在两边各写一份）。
//
//   - 把"读不到应用配置"改成按匿名继续（吞掉 loadAppConfig 的错误）
//     ⇒ TestServe_ConfigMissingIs500 / TestServe_ConfigInvalidIs500 红；
//   - 让历史 access=public 在读取侧按"允许匿名"处理
//     ⇒ TestClientRequest_LegacyPublicConfigReadsAsLogin 红；
//   - 去掉跨应用写防护（管线步骤⑤）⇒ TestClientRequest_CrossOriginWriteRejected /
//     TestClientRequest_MissingOriginOnWriteIs403 / TestCheckClientOrigin 红；
//   - 去掉请求体上限（步骤⑥）⇒ TestServe_BodyTooLargeIs413JSON 红；
//   - 把静态资源的 ETag 键去掉 version ⇒ TestStatic_VersionIsolation / TestAssetETagIncludesAppVersionAndPath 红；
//   - 让 `/api/*` 也能命中静态资源 ⇒ TestStatic_APIReservedForWasm 红；
//   - 让要求登录应用的入口文档走静态 ⇒ TestStatic_LoginRequiredEntryGoesToWasm 红；
//   - 去掉响应体上限检查（writeAppResponse 里那条）⇒ TestWriteAppResponse_OverrunIs500 红；
//   - 把 KillReason != nil 也当成功写回 ⇒ TestServe_NoResponseIs502 / TestServe_TimeoutIs504 红；
//   - 去掉响应头白名单（不调 StripAppControlledHeaders）⇒ TestServe_ResponseHeadersAreHostOwned 红；
//   - 去掉模块缓存的引用计数/Skip（淘汰在跑的条目）⇒ TestModuleCache_* 红；
//   - 把句柄池改成"每请求 Open/Close"（丢掉按应用持有）⇒ TestAppDBPool_ReusesHandleForSameApp 红；
//   - 去掉句柄池的跨应用键（按 DataRoot 复用一份）⇒ TestAppDBPool_DoesNotShareAcrossApps 红；
//   - 去掉空闲淘汰 ⇒ TestAppDBPool_IdleEvictionReopensFreshHandle 红；
//   - 去掉容量上限的 LRU 淘汰 ⇒ TestAppDBPool_CapEvictsLeastRecentlyUsed 红；
//   - 去掉污染探测 / 被杀请求回收（release 恒不回收）⇒ TestAppDBPool_PoisonedHandleIsRecycled、
//     TestAppDBConn_PoisonMarkersFromRealErrors 红；
//   - 把 logbuf 换成自建 sink（丢掉 §5.1 的统一限额实现）⇒ TestServe_AppLogsGoToPlatformLog 红；
//   - 把 `defer s.flushAppLogs` 挪回"获取句柄之后"（旧顺序：刷盘发生在持执行槽/句柄期间）
//     ⇒ TestServe_AppLogFlushHoldsNoSlotOrHandle 红（R1-rt-6）；
//   - 把 serveStatic 改回"先整份读盘 + 算 sha256，再判 If-None-Match"（绕过缓存）
//     ⇒ TestStatic_NotModifiedDoesNotTouchDisk / TestStatic_CachedBytesSurviveFileRemoval 红（R1-rt-2/3）；
//   - 让 releaseContent.Config() 每次读盘解析 ⇒ TestReleaseCache_ConfigIsCachedPerRelease 红；
//   - 让 dropOtherReleasesLocked 变 no-op ⇒ TestReleaseCache_VersionChangeDropsOldRelease 红；
//   - 去掉 EvictApp 里的 releases.evictApp ⇒ TestStatic_EvictAppInvalidatesCache 红；
//   - 去掉 releaseCache.evictLocked 的容量淘汰 ⇒ TestReleaseCache_IsBounded 红（有界性）；
//   - **让平台自己比对白名单**（R24 / A3：只注入身份与模式，名单由应用判）
//     ⇒ TestServe_WhitelistOutsiderStillReachesWasm 红（2026-09-18 独立审计补的回归网：
//     这条性质在该用例之前没有任何用例咬住）。
//
// ⚠️ 改用例名时同步改这份指南（独立审计 2026-09-18 P2-4：曾有 5 个名字失效，
// 指南看起来还在、其实指向空气）。对拍命令：
//   for n in <本文件里出现的 Test 名>; do grep -rq "func $n(" . || echo "缺失: $n"; done

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/assets"
	"github.com/picoaide/picoaide/internal/wasmapp/events"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 测试用的账号夹具（本仓公开，禁止真实域名：AGENTS.md 的域名纪律 —— W4 删除
// 子域路径后测试里不再有任何域名常量，客户端请求的 host 就是 app_id）。
const (
	testPassword = "Test-Password-2026"
	testOwner    = "alice"
)

// ===== guest 现场编译（GOOS=wasip1 GOARCH=wasm）=====
//
// 三个测试应用都真编译（不入库二进制）。用**包级共享的 DataRoot**：编译缓存
// （<DataRoot>/_compile-cache）与 wazero 的磁盘缓存因此跨用例复用，第二次起
// 编译模块只付"读缓存 + 反序列化"的代价（否则每个用例都要 1–2 s 冷编译）。
// 应用数据（apps/<app_id>/…）仍然按用例隔离 —— 每个用例用带随机后缀的 app_id。
// envSeq 给每个用例环境一个进程内唯一的 app_id 后缀。
var envSeq atomic.Int64

var (
	testRootOnce sync.Once
	testRoot     string
	testRootErr  error

	appBinMu  sync.Mutex
	appBinDir string
	appBins   = map[string][]byte{}
)

// TestMain 负责清理共享 DataRoot 与 guest 编译产物目录。
func TestMain(m *testing.M) {
	code := m.Run()
	if testRoot != "" {
		_ = os.RemoveAll(testRoot)
	}
	if appBinDir != "" {
		_ = os.RemoveAll(appBinDir)
	}
	os.Exit(code)
}

// sharedDataRoot 返回包级共享的 DataRoot。
func sharedDataRoot(t *testing.T) string {
	t.Helper()
	testRootOnce.Do(func() {
		testRoot, testRootErr = os.MkdirTemp("", "wasmapp-appserver-")
	})
	if testRootErr != nil {
		t.Fatalf("创建共享数据根失败: %v", testRootErr)
	}
	return testRoot
}

// appBinary 返回 testdata/<name> 编译出的 wasip1 模块字节（每进程只编译一次）。
func appBinary(t *testing.T, name string) []byte {
	t.Helper()
	appBinMu.Lock()
	defer appBinMu.Unlock()
	if bin, ok := appBins[name]; ok {
		return bin
	}
	if appBinDir == "" {
		dir, err := os.MkdirTemp("", "wasmapp-appserver-apps-")
		if err != nil {
			t.Fatalf("创建 guest 编译目录失败: %v", err)
		}
		appBinDir = dir
	}
	goTool, err := exec.LookPath("go")
	if err != nil {
		// 不 skip：本包的用例全部依赖现场编译 wasm，"跳过"会让门禁变成空转。
		t.Fatalf("找不到 go 工具链（本包用例需要现场编译 wasip1 应用）: %v", err)
	}
	out := filepath.Join(appBinDir, name+".wasm")
	// testdata 是**独立模块**（module picoaide.test/apps）：站在应用作者的位置，
	// 不 import 平台内部包，自实现帧协议。
	cmd := exec.Command(goTool, "build", "-o", out, "./"+name)
	cmd.Dir = filepath.Join("testdata")
	cmd.Env = append(os.Environ(), "GOOS=wasip1", "GOARCH=wasm", "CGO_ENABLED=0")
	if buildOut, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("编译测试应用 %s 失败: %v\n%s", name, err, buildOut)
	}
	bin, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("读取测试应用产物失败: %v", err)
	}
	if len(bin) == 0 {
		t.Fatalf("测试应用 %s 产物为空", name)
	}
	appBins[name] = bin
	return bin
}

// withCustomSection 在 wasm 字节末尾追加一个自定义段（id=0）。
//
// 用途：让"同一份应用字节"在 wazero 的**磁盘编译缓存**里必然未命中（缓存键含模块字节），
// 从而在用例里稳定地触发"冷编译"路径，而不必另建数据根。
// 追加自定义段是合法的 wasm 编码（段表里额外的 section id 0 被允许），不影响执行。
func withCustomSection(t *testing.T, app, name string, payload []byte) []byte {
	t.Helper()
	base := appBinary(t, app)
	body := make([]byte, 0, len(name)+len(payload)+8)
	body = append(body, byte(len(name)))
	body = append(body, name...)
	body = append(body, payload...)
	out := append([]byte{}, base...)
	out = append(out, 0) // section id 0 = custom
	// LEB128 长度前缀。
	n := len(body)
	for {
		b := byte(n & 0x7f)
		n >>= 7
		if n != 0 {
			b |= 0x80
		}
		out = append(out, b)
		if n == 0 {
			break
		}
	}
	return append(out, body...)
}

// ===== 用例环境 =====

// lockedBuffer 收集平台日志（断言"配置读不到必须大声记日志"与静音噪音）。
type lockedBuffer struct {
	mu  sync.Mutex
	buf []byte
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf = append(b.buf, p...)
	return len(p), nil
}

func (b *lockedBuffer) Printf(format string, args ...any) {
	_, _ = b.Write([]byte(strings.TrimRight(sprintf(format, args...), "\n") + "\n"))
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.buf)
}

// env 是一次测试的完整环境：真 PG + 注入的客户端身份 + 真编译出来的 wasm。
type env struct {
	t    *testing.T
	db   *sql.DB
	root string
	srv  *Server
	logs *lockedBuffer
	ev   *events.Sink
	// suffix 让同一共享 DataRoot 下的不同用例用不同 app_id（文件系统隔离）。
	suffix string
	// ownerUser 是默认注入的已登录身份（发布者 alice，见 get/post）。
	// 装配期一次性取好：请求可能来自多个 goroutine（并发用例），懒加载会撞 -race；
	// 另外它必须在用例有机会关库（TestServe_DatabaseUnreachableDoesNotPanic）之前就绪。
	ownerUser *serverstore.User

	// clockMu/clock 是注入的时钟（句柄池的空闲淘汰用它推进，避免用真实 sleep 等 10 分钟）。
	clockMu sync.Mutex
	clock   time.Time
}

// now 返回注入的时钟。
func (e *env) now() time.Time {
	e.clockMu.Lock()
	defer e.clockMu.Unlock()
	return e.clock
}

// advance 推进注入的时钟。
func (e *env) advance(d time.Duration) {
	e.clockMu.Lock()
	defer e.clockMu.Unlock()
	e.clock = e.clock.Add(d)
}

// newEnv 装配一个用例环境；mutate 可覆盖 Options（用于注入小上限的调度器/时钟等）。
func newEnv(t *testing.T, mutate ...func(*Options)) *env {
	t.Helper()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	e := &env{
		t:    t,
		db:   db,
		root: sharedDataRoot(t),
		logs: &lockedBuffer{},
		// 进程内自增序号：app_id 唯一 ⇒ 共享 DataRoot 下 apps/<app_id>/ 不会串号
		//（用时间戳取模会以极小概率碰撞，碰撞的表现是"两个用例共用资源目录"）。
		suffix: strconv.FormatInt(envSeq.Add(1), 36),
		clock:  time.Date(2026, 9, 17, 10, 0, 0, 0, time.UTC),
	}

	ev := events.NewSink(db, events.Options{FlushInterval: 10 * time.Millisecond})
	ev.Start(context.Background())
	t.Cleanup(func() { _ = ev.Close() })
	e.ev = ev

	opt := Options{
		DB:       db,
		DataRoot: e.root,
		Events:   ev,
		Logger:   e.logs.Printf,
		Now:      e.now,
	}
	for _, fn := range mutate {
		fn(&opt)
	}
	srv, err := New(opt)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	e.srv = srv
	t.Cleanup(func() { _ = srv.Close() })
	// 默认注入身份（发布者 alice）在这里备好：请求可能并发发起，且有的用例会关库。
	e.ownerUser = e.clientUser(testOwner)
	return e
}

// appID 返回本用例独有的 app_id（共享 DataRoot 下避免文件系统串号）。
func (e *env) appID(base string) string { return base + "-" + e.suffix }

// ===== 应用/版本/资源夹具 =====

// appSpec 描述一个应用 + 一个版本（默认 approved）。
type appSpec struct {
	appID   string
	version string
	owner   string
	enabled *bool
	frozen  bool
	// status 空 = approved（生效）。非 approved 的版本不会成为"生效版本"。
	status string
	// config 是 picoaide.app.json 的内容；空 = 默认 login（客户端专属模型的唯一
	// 常规模式：未注入身份即 401）。
	config string
	// configOverride 为 true 时 config 为空表示"不写配置文件"（测平台故障分支）。
	skipConfig bool
	// assets 是抽取目录里的额外资源（逻辑路径 → 内容）。
	assets map[string]string
	// wasm 空 = echoapp。
	wasm []byte
	// assetsDir 非空 = 把资源写进这个目录名并写回 assets_dir 列（测发布期约定）。
	assetsDir string
}

// publicConfig 是**历史 schema** 的 access="public" 配置。
//
// ⚠️ 2026-09-19 起它只用于一条判据：client_test.go 的
// TestClientRequest_LegacyPublicConfigReadsAsLogin（读取侧即 login，没有匿名面）。
// 其余用例一律用 loginConfig()/loginRequiredConfig() —— 不要在这里再造存量配置。
func publicConfig() string {
	return `{"access":"public","whitelist":[],` +
		`"purpose":"appserver 测试","data_sensitivity":"internal","owner":"alice"}`
}

// loginConfig 是 access=login 的配置（默认模式："登录后全员可用"：
// 客户端模型下未注入身份 ⇒ 401，注入身份后不看名单）。
func loginConfig() string {
	return `{"access":"login","whitelist":[],` +
		`"purpose":"appserver 测试","data_sensitivity":"internal","owner":"alice"}`
}

// loginRequiredConfig 是 access=whitelist 的配置（要求登录 + 名单准入；
// §4.2：此时 whitelist 必须非空）。
func loginRequiredConfig(whitelist ...string) string {
	if len(whitelist) == 0 {
		whitelist = []string{"alice"}
	}
	quoted := make([]string, 0, len(whitelist))
	for _, w := range whitelist {
		quoted = append(quoted, `"`+w+`"`)
	}
	return `{"access":"whitelist","whitelist":[` + strings.Join(quoted, ",") + `],` +
		`"purpose":"appserver 测试","data_sensitivity":"internal","owner":"alice"}`
}

// legacyPublicConfig / legacyWhitelistConfig 是**旧 schema**（已发布版本的随包资产就是
// 这个形态）。保留它们是为了守住兼容 shim：老应用升级平台后必须照常运行。
func legacyPublicConfig() string {
	return `{"visible":false,"login_required":false,"whitelist":[],` +
		`"purpose":"旧 schema","data_sensitivity":"internal","owner":"alice"}`
}

func legacyWhitelistConfig(whitelist ...string) string {
	if len(whitelist) == 0 {
		whitelist = []string{"alice"}
	}
	quoted := make([]string, 0, len(whitelist))
	for _, w := range whitelist {
		quoted = append(quoted, `"`+w+`"`)
	}
	return `{"visible":true,"login_required":true,"whitelist":[` + strings.Join(quoted, ",") + `],` +
		`"purpose":"旧 schema","data_sensitivity":"internal","owner":"alice"}`
}

// publishApp 建应用 + 版本 + 抽取好的资源目录，返回**重新读回**的版本行。
func (e *env) publishApp(spec appSpec) *serverstore.WasmRelease {
	e.t.Helper()
	if spec.appID == "" {
		e.t.Fatal("appSpec.appID 必填")
	}
	if spec.version == "" {
		spec.version = "1.0.0"
	}
	if spec.owner == "" {
		spec.owner = testOwner
	}
	enabled := true
	if spec.enabled != nil {
		enabled = *spec.enabled
	}
	ctx := context.Background()
	if err := serverstore.UpsertWasmApp(ctx, e.db, serverstore.WasmApp{
		AppID: spec.appID, Title: spec.appID, Owner: spec.owner,
		Channel: serverstore.AppChannelWasm, Enabled: enabled,
	}); err != nil {
		e.t.Fatalf("UpsertWasmApp(%s): %v", spec.appID, err)
	}
	if !enabled {
		if err := serverstore.SetWasmAppEnabled(ctx, e.db, spec.appID, false); err != nil {
			e.t.Fatalf("SetWasmAppEnabled: %v", err)
		}
	}
	if spec.frozen {
		if err := serverstore.FreezeWasmApp(ctx, e.db, spec.appID, time.Now()); err != nil {
			e.t.Fatalf("FreezeWasmApp: %v", err)
		}
	}
	cfg := spec.config
	if cfg == "" && !spec.skipConfig {
		// 默认 login：客户端专属模型下不存在"匿名可用"的常规应用
		//（历史 public 只在读取侧兼容，见 publicConfig 的注释）。
		cfg = loginConfig()
	}
	wasm := spec.wasm
	if len(wasm) == 0 {
		wasm = appBinary(e.t, "echoapp")
	}
	status := spec.status
	if status == "" {
		status = serverstore.ReleaseStatusApproved
	}
	id, err := serverstore.CreateWasmRelease(ctx, e.db, serverstore.WasmRelease{
		AppID: spec.appID, Version: spec.version, Title: spec.appID,
		Changelog: "测试版本", Publisher: spec.owner, Status: status,
		Wasm: wasm, ConfigJSON: cfg,
	})
	if err != nil {
		e.t.Fatalf("CreateWasmRelease(%s@%s): %v", spec.appID, spec.version, err)
	}
	if err := serverstore.SetWasmAppCurrentRelease(ctx, e.db, spec.appID, id); err != nil {
		e.t.Fatalf("SetWasmAppCurrentRelease: %v", err)
	}

	dirName := strconv.FormatInt(id, 10)
	if spec.assetsDir != "" {
		dirName = spec.assetsDir
		if _, err := e.db.ExecContext(ctx,
			`UPDATE app_releases SET assets_dir = $1 WHERE id = $2`, dirName, id); err != nil {
			e.t.Fatalf("写回 assets_dir: %v", err)
		}
	}
	dir := filepath.Join(e.root, limits.AppsDirName, spec.appID, assets.AssetsDirName, dirName)
	if err := os.MkdirAll(dir, limits.DataDirMode); err != nil {
		e.t.Fatalf("建资源目录: %v", err)
	}
	// picoaide.app.json 与其它资源写进同一份抽取目录（应用用 assets.read 读同一份）。
	files := map[string]string{}
	for k, v := range spec.assets {
		files[k] = v
	}
	if !spec.skipConfig {
		files[limits.AppConfigFileName] = cfg
	}
	for name, content := range files {
		full := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0o700); err != nil {
			e.t.Fatalf("建资源子目录: %v", err)
		}
		if err := os.WriteFile(full, []byte(content), 0o600); err != nil {
			e.t.Fatalf("写资源 %s: %v", name, err)
		}
	}

	rel, err := serverstore.GetWasmRelease(ctx, e.db, spec.appID, spec.version)
	if err != nil {
		e.t.Fatalf("GetWasmRelease: %v", err)
	}
	return rel
}

// ===== 请求入口：客户端专属模型 =====
//
// 唯一入口是 (*Server).ServeClientRequest（client.go）：请求形状由协议 handler
// 合成（`URL.Scheme = <渠道 app scheme>`、Host = app_id），身份由调用方**注入**。
// 用例只允许经下面这三个 helper 发请求（形状本身由 client_test.go 的
// clientRequestFor 定义）。

// clientDo 走生产入口 ServeClientRequest；user 为 nil = "客户端没带登录态"。
//
// 自定义头 / 条件请求 / 无限请求体这类用例先按 clientRequestFor 造请求再调它。
func (e *env) clientDo(req *http.Request, appID string, user *serverstore.User) *httptest.ResponseRecorder {
	e.t.Helper()
	rec := httptest.NewRecorder()
	e.srv.ServeClientRequest(rec, req, appID, user, testSessionKey)
	return rec
}

// get 发一个客户端 GET，**默认注入已登录的发布者身份**（e.ownerUser）。
//
// 需要"无身份"的用例请显式用 e.doClient(appID, nil, …)：那是 401 判据的入口，
// 不要靠"少传一个参数"来表达。
func (e *env) get(appID, path string) *httptest.ResponseRecorder {
	e.t.Helper()
	return e.doClient(appID, e.ownerUser, http.MethodGet, path, "", "")
}

// post 发一个客户端 POST（协议 handler 合成的自身源 Origin：非幂等请求必须带它）。
func (e *env) post(appID, path, contentType, body string) *httptest.ResponseRecorder {
	e.t.Helper()
	req := clientRequestFor(e.t, appID, http.MethodPost, path, clientOriginOf(appID), body)
	req.Header.Set("Content-Type", contentType)
	return e.clientDo(req, appID, e.ownerUser)
}

// newUser 建一个真账号并返回其 id（已存在则返回既有 id：用例里"先建号、再取行"
// 会两次调用它，重复建号不该是失败）。客户端模型下它只负责建账号 ——
// 请求身份由 client_test.go 的 clientUser/e.doClient 注入，没有登录这一步。
func (e *env) newUser(username string) int64 {
	e.t.Helper()
	id, err := serverstore.CreateUserWithPassword(e.db, username, testPassword)
	if err != nil {
		var existing int64
		if qerr := e.db.QueryRow(`SELECT id FROM users WHERE lower(username) = lower($1)`, username).
			Scan(&existing); qerr == nil {
			return existing
		}
		e.t.Fatalf("CreateUserWithPassword(%s): %v", username, err)
	}
	return id
}

// ===== 断言辅助 =====

// decodeJSON 解析响应体（失败即 Fatal）。
func decodeJSON(t *testing.T, body io.Reader) map[string]any {
	t.Helper()
	raw, err := io.ReadAll(body)
	if err != nil {
		t.Fatalf("读响应体: %v", err)
	}
	return decodeJSONBytes(t, raw)
}

// errorCodeOf 从错误信封里取 code。
func errorCodeOf(t *testing.T, body io.Reader) string {
	t.Helper()
	env := decodeJSON(t, body)
	errObj, ok := env["error"].(map[string]any)
	if !ok {
		t.Fatalf("响应不是错误信封: %v", env)
	}
	code, _ := errObj["code"].(string)
	return code
}

// sprintf 是 fmt.Sprintf 的薄封装（只为了让日志收集器的 Printf 少一层 import 噪音）。
func sprintf(format string, args ...any) string { return fmt.Sprintf(format, args...) }

// decodeJSONBytes 解析 JSON 对象。
func decodeJSONBytes(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("响应不是 JSON 对象: %v; body=%s", err, string(raw))
	}
	return out
}

// waitForEvents 轮询等待落库的调用事件条数达到 n（events 是异步批量落库）。
// 预算说明（为什么是 30s 而不是 3s）：调用事件由 events.Sink 的**批量**
// 落库循环写出，缺省 flush 周期 2s；而 under 高负载（例如 20 个包并行跑、
// 4 核被抢满）一次临时库 INSERT 就可能超过 2s，于是"3s 预算"会在正确实现上
// 偶发失败。这里的等待是**确定性条件**（轮询到条件成立即返回），
// 放大预算只是给慢路径留余量，不会掩盖产品缺陷：
//   - 若事件真的丢失，轮询会一直不成立，30s 后返回真实条数 ⇒ 断言仍然红；
//   - 用固定 sleep 才会既假红又掩盖问题，这里没有用。
func (e *env) waitForEvents(appID string, n int) int {
	e.t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		var count int
		if err := e.db.QueryRow(
			`SELECT COUNT(*) FROM wasm_call_events WHERE app_id = $1`, appID).Scan(&count); err != nil {
			e.t.Fatalf("查调用事件: %v", err)
		}
		if count >= n || time.Now().After(deadline) {
			return count
		}
		time.Sleep(20 * time.Millisecond)
	}
}
