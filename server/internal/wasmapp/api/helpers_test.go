package api

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/appproof"
	"github.com/picoaide/picoaide/internal/wasmapp/compile"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是本包测试的**共享夹具**。
//
// 纪律（模块验收要求）：
//   - 编译链路上的测试必须**真起进程、真编译**：编译子进程现场 `go build`，
//     被测 wasm 现场 `GOOS=wasip1 GOARCH=wasm go build`（不入库任何二进制）；
//   - 全部端点挂在**生产路径**上（/api/client/v2/apps/wasm/... 与
//     /api/server/admin/wasm-apps/...）—— 测试树与生产树前缀不一致会测不出
//     路径不匹配（本仓 2026-08-30 的既有教训）；
//   - 无 PG 时 `serverstore.NewTestDB` 会 Skip（`go test ./...` 在没有数据库的
//     环境必须仍然通过）。
//
// 变异方式（把闸门改回危险值，本包哪条用例会红）：
//   - 把 `defer Compiler.ReleaseUpload` 从 publish/validate 里删掉 ⇒
//     连续两次失败后的第三次提交会拿到 COMPILE_BUSY/429（TestUploadSlotReleasedOnFailure 红）；
//   - 把上传闸门（AllowUpload）整段注释掉 ⇒ TestUploadRateGate429IsPointed 红；
//   - 把资源落盘（staging + rename）加回发布链路 ⇒
//     TestPublishHappyPath / TestPublishAssetRejectedLeavesNothing / upload complete 的
//     assertNoAssetsDir 负向断言红（<data_root>/apps/<app_id>/assets/ 会出现）；
//   - 把发布期的 assets.ValidateLogicalPath / 上限校验（checkPublishAssets）删掉 ⇒
//     TestPublishAssetRejectedLeavesNothing 与 TestPublishAssetLimitsRejectBeforeCommit 红；
//   - 把 owner 检查（checkOwner）注释掉 ⇒ TestOtherEmployeeCannotPublish 红；
//   - 把 `defer h.opt.Compiler.ReleaseUpload` 与 review 开关的 pending 分支改回
//     approved ⇒ TestReviewSwitchKeepsCurrentRelease 红。

var (
	serverRootOnce sync.Once
	serverRootDir  string
	serverRootErr  error

	childOnce sync.Once
	childPath string
	childErr  error
	childDir  string

	guestOnce sync.Once
	guestWasm []byte
	guestErr  error
)

// testServerRoot 返回 server/ 模块根（cmd/ 与 internal/ 的父目录）。
func testServerRoot(t *testing.T) string {
	t.Helper()
	serverRootOnce.Do(func() {
		out, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}").Output()
		if err != nil {
			serverRootErr = err
			return
		}
		serverRootDir = strings.TrimSpace(string(out))
	})
	if serverRootErr != nil {
		t.Fatalf("定位模块根失败（需要 go 工具链）: %v", serverRootErr)
	}
	return serverRootDir
}

// testCompileChild 现场构建编译子进程（整包复用一次；每次构建约 1–3 s）。
func testCompileChild(t *testing.T) string {
	t.Helper()
	childOnce.Do(func() {
		childDir, childErr = os.MkdirTemp("", "picoaide-api-compile-child-")
		if childErr != nil {
			return
		}
		out := filepath.Join(childDir, compile.ChildBinaryName)
		cmd := exec.Command("go", "build", "-o", out, "./cmd/picoaide-app-compile")
		cmd.Dir = testServerRoot(t)
		cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
		if b, err := cmd.CombinedOutput(); err != nil {
			childErr = fmt.Errorf("构建编译子进程失败: %v\n%s", err, b)
			return
		}
		childPath = out
	})
	if childErr != nil {
		t.Fatalf("%v", childErr)
	}
	return childPath
}

// testGuestModule 现场编译参考实现（refapp）为 wasip1 模块（整包复用一次）。
//
// 用 refapp 而不是"最小的空模块"：干跑要求 guest **能读请求帧、能写出合法响应帧**，
// 而 refapp 正是"读帧 + 调全部宿主函数 + 写帧"的样板（§4.2/§11 第 1 项）。
func testGuestModule(t *testing.T) []byte {
	t.Helper()
	guestOnce.Do(func() {
		dir, err := os.MkdirTemp("", "picoaide-api-guest-")
		if err != nil {
			guestErr = err
			return
		}
		out := filepath.Join(dir, "guest.wasm")
		cmd := exec.Command("go", "build", "-o", out, "./internal/wasmapp/refapp")
		cmd.Dir = testServerRoot(t)
		cmd.Env = append(os.Environ(), "GOOS=wasip1", "GOARCH=wasm", "CGO_ENABLED=0")
		if b, err := cmd.CombinedOutput(); err != nil {
			guestErr = fmt.Errorf("构建 wasip1 夹具失败（需要本机 Go 工具链支持 wasip1）: %v\n%s", err, b)
			return
		}
		guestWasm, guestErr = os.ReadFile(out)
	})
	if guestErr != nil {
		t.Fatalf("%v", guestErr)
	}
	return guestWasm
}

// withCustomSections 在模块末尾追加若干自定义段（**真** wasm 段，可被解析器读出）。
//
// 段格式：id(0x00) + ULEB(len) + [ULEB(len(name)) + name + data]。
// 追加在文件末尾对 core module 是合法的（自定义段可出现在任意段之间）。
func withCustomSections(t *testing.T, base []byte, sections map[string][]byte) []byte {
	t.Helper()
	out := append([]byte{}, base...)
	for name, data := range sections {
		out = withRepeatedCustomSection(t, out, name, data)
	}
	return out
}

// withRepeatedCustomSection 在同一模块上追加**同名**自定义段若干次。
//
// 自定义段（id=0x00）按规范可以重复出现，而解析层只认第一个、其余静默丢弃 ——
// 这正是发布期 `ASSET_EXISTS`（重名闸门）要拦的形态，所以夹具必须能造出"真"重名段。
func withRepeatedCustomSection(t *testing.T, base []byte, name string, blobs ...[]byte) []byte {
	t.Helper()
	out := append([]byte{}, base...)
	for _, data := range blobs {
		payload := append(uleb(len(name)), []byte(name)...)
		payload = append(payload, data...)
		out = append(out, 0x00)
		out = append(out, uleb(len(payload))...)
		out = append(out, payload...)
	}
	return out
}

func uleb(v int) []byte {
	var out []byte
	for {
		b := byte(v & 0x7f)
		v >>= 7
		if v != 0 {
			out = append(out, b|0x80)
			continue
		}
		out = append(out, b)
		return out
	}
}

// testEnv 是一套完整的测试装配（真 PG + 真编译器 + 生产路径路由树）。
// openRecorder 是 open 计数出口的测试替身（F16：断言"调用一次 = 一次打开"）。
//
// 与生产的差别只有一点：它**不写库**，把每次调用记下来供用例对拍。生产装配是
// `serverstore.RecordWasmAppOpen`（见 cmd/server/wasmapp.go 的 Opens 闭包）。
type openRecorder struct {
	mu    sync.Mutex
	calls []openCall
	// fail 为真时让计数失败，用于断言"计数失败不影响打开"（§8.9 / §5.1b 第 2 条）。
	fail bool
	// db 非 nil 时按**生产口径**落明细（`serverstore.RecordWasmAppOpen`）——
	// 这样"计数 +1"与"opens.today 与明细一致"能同时被真实数据验证，而不是只看替身
	// 记了几次调用。
	db *sql.DB
}

type openCall struct {
	appID         string
	userID        int64
	clientVersion string
}

func (r *openRecorder) record(ctx context.Context, appID string, userID int64, clientVersion string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.fail {
		return errors.New("计数存储故障（用例注入）")
	}
	r.calls = append(r.calls, openCall{appID: appID, userID: userID, clientVersion: clientVersion})
	if r.db == nil {
		return nil
	}
	// 生产同款写路径（含"主部门"口径）。失败只回错误，由 api 层按 best-effort 处理。
	return serverstore.RecordWasmAppOpen(ctx, r.db, serverstore.WasmAppOpen{
		AppID:         appID,
		UserID:        userID,
		DeptID:        serverstore.PrimaryDeptID(ctx, r.db, userID),
		ClientVersion: clientVersion,
	})
}

func (r *openRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls)
}

func (r *openRecorder) last() (openCall, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.calls) == 0 {
		return openCall{}, false
	}
	return r.calls[len(r.calls)-1], true
}

type testEnv struct {
	t        *testing.T
	r        *gin.Engine
	db       *sql.DB
	compiler *compile.Compiler
	dataRoot string
	h        *Handlers
	// proof 是装配进 handler 的持有性证明服务（签发/校验都走真实现）。
	proof *appproof.Service
	// opens 是 open 计数的记录器（断言每次打开 +1）。
	opens *openRecorder
	// installPriv / installID 是用例侧的"安装密钥"（Ed25519 私钥只活在用例里）。
	installPriv ed25519.PrivateKey
	installID   string
	// proofRoot 是持有性证明的数据根（密钥环 + 安装注册表）。
	// 需要"换一个时钟再验同一份 proof"的用例必须复用**同一个**它，否则会加载到另一
	// 套密钥环（症状：过期用例拿到 proof_mismatch 而不是 proof_expired）。
	proofRoot string
	// tokens: alice（普通员工）、bob（普通员工）、boss（super_admin）
	tokens map[string]string
	ids    map[string]int64
	users  map[string]*serverstore.User
}

// sharedCacheRoot 是本包全部用例共享的**编译缓存根**。
//
// 为什么共享：被测夹具是 3.6 MiB 的 Go wasip1 模块，冷编译一次要 3–11 s；
// 每个用例各建一份缓存会让整包测试被编译主导（且把"编译缓存"这条链路的
// 效果从测试里抹掉）。应用**数据**目录仍然每用例独立（t.TempDir），
// 所以用例之间不会互相看到对方的资源文件。
//
// 注意：`go test` 产物与独立构建的二进制的 wazero 版本字符串不同
// （源码 internal/version 走 debug.ReadBuildInfo，测试二进制的 Deps 为空
// ⇒ "dev"），因此测试里执行侧的缓存分片是 wazero-dev-*，与编译子进程的
// wazero-v1.12.0-* 不同分片 —— 即**测试里不存在"发布期编译暖执行进程"**。
// 生产构建两侧同为 v1.12.0（已实测），共享分片成立。
var (
	cacheRootOnce sync.Once
	cacheRootDir  string
)

func sharedCacheRoot(t *testing.T) string {
	t.Helper()
	cacheRootOnce.Do(func() {
		dir, err := os.MkdirTemp("", "picoaide-api-compile-cache-")
		if err != nil {
			t.Fatalf("创建共享缓存目录失败: %v", err)
		}
		cacheRootDir = dir
	})
	return cacheRootDir
}

// newTestEnv 装配测试环境。mutators 可以在构造 Options 后覆盖字段
// （例如注入 ArtifactUsed 以确定性地测配额闸门）。
func newTestEnv(t *testing.T, mutators ...func(*Options)) *testEnv {
	t.Helper()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	dataRoot := t.TempDir()
	cacheRoot := sharedCacheRoot(t)

	comp, err := compile.New(compile.Options{
		DataRoot:    cacheRoot,
		ChildBinary: testCompileChild(t),
		// 编译进程的 OS 级隔离由 compile 包自己的端到端用例负责（bwrap 在
		// 沙箱/CI 里不总是可用）；本包测的是**发布链路**，因此显式关闭隔离，
		// 让用例的成败只取决于被测代码。
		Isolation: compile.IsolationOff,
		Logger:    testLogger{t},
	})
	if err != nil {
		t.Fatalf("构造编译器失败: %v", err)
	}
	t.Cleanup(func() { _ = comp.Close() })

	// 持有性证明（契约 §20/§23.1）：与生产同样**必装** —— nil 会让 request/open
	// 一律 401（fail-closed），那是装配事故而不是"没配也能测"。
	//
	// ⚠️ proof 的数据根是**独立临时目录**（不是 dataRoot，也不是它的子目录）：
	// 本夹具让 `dataRoot` 同时扮演"部署数据根"与"应用数据根"（生产里是同一个挂载
	// 点），而分区上传的用例断言"这个根下只有平台自己写的东西"（upload_test.go 的
	// 穿越判据 —— 它 walk 到的是 dataRoot 本身，不是 `apps/`）。签名密钥在生产里
	// 落在 `<dataDir>/app-proof.key`（见 appproof.KeyFileName），位置本身不是被测
	// 语义；放进独立目录既不污染那条不变量，也不改变任何装载路径。
	proofRoot := t.TempDir()
	proof, perr := appproof.New(appproof.Options{DataRoot: proofRoot})
	if perr != nil {
		t.Fatalf("构造 app-proof 失败: %v", perr)
	}
	opens := &openRecorder{db: db}

	opt := Options{
		DB:               db,
		DataRoot:         dataRoot,
		CompileCacheRoot: cacheRoot,
		Compiler:         comp,
		Now:              func() time.Time { return time.Now().UTC() },
		Proof:            proof,
		Opens:            opens.record,
	}
	for _, m := range mutators {
		m(&opt)
	}
	h := NewHandlers(opt)

	installPub, installPriv, kerr := ed25519.GenerateKey(rand.Reader)
	if kerr != nil {
		t.Fatalf("生成安装密钥失败: %v", kerr)
	}
	_ = installPub
	env := &testEnv{t: t, db: db, compiler: comp, dataRoot: dataRoot, h: h, proof: proof, opens: opens,
		installPriv: installPriv, installID: "install-api-0001", proofRoot: proofRoot,
		tokens: map[string]string{}, ids: map[string]int64{}, users: map[string]*serverstore.User{}}
	for _, name := range []string{"alice", "bob"} {
		id, cerr := serverstore.CreateUser(db, &serverstore.User{Username: name, Source: "local", Status: 1, Role: serverstore.RoleUser})
		if cerr != nil {
			t.Fatalf("建用户 %s 失败: %v", name, cerr)
		}
		tok, terr := serverauth.IssueToken(db, id)
		if terr != nil {
			t.Fatalf("签发令牌失败: %v", terr)
		}
		u, _ := serverstore.GetUserByUsername(db, name)
		env.ids[name], env.tokens[name], env.users[name] = id, tok, u
	}
	bossID, berr := serverstore.CreateUser(db, &serverstore.User{Username: "boss", Source: "local", Status: 1, Role: serverstore.RoleSuperAdmin})
	if berr != nil {
		t.Fatalf("建管理员失败: %v", berr)
	}
	bossTok, terr := serverauth.IssueToken(db, bossID)
	if terr != nil {
		t.Fatalf("签发管理员令牌失败: %v", terr)
	}
	boss, _ := serverstore.GetUserByUsername(db, "boss")
	env.ids["boss"], env.tokens["boss"], env.users["boss"] = bossID, bossTok, boss

	gin.SetMode(gin.TestMode)
	r := gin.New()
	env.mount(r)
	env.r = r
	return env
}

// mount 按**生产路径**挂载全部端点（与交付说明里的挂载清单逐条对应）。
func (e *testEnv) mount(r *gin.Engine) {
	cli := r.Group("/api/client/v2/apps/wasm", serverauth.BearerAuth(e.db))
	cli.POST("/validate", e.h.Validate)
	cli.GET("/catalog", e.h.Catalog)
	cli.POST("/:app_id/releases", e.h.Publish)
	cli.POST("/:app_id/publish", e.h.SetPublished)
	cli.POST("/:app_id/unpublish", e.h.SetPublished)
	cli.POST("/:app_id/freeze", e.h.Freeze)
	cli.GET("/:app_id/export", e.h.Export)
	cli.DELETE("/:app_id", e.h.Delete)
	cli.GET("/:app_id/diagnostics", e.h.Diagnostics)
	cli.GET("/:app_id/schema", e.h.Schema)
	// 标识唯一性预查（2026-09-20）：与 internal/router 的申报逐条一致。
	cli.GET("/:app_id/availability", e.h.Availability)
	// 发布者本人的版本历史 + 审核结论（R1-pm-3）：与 internal/router 的申报逐条一致。
	cli.GET("/:app_id/releases", e.h.MyReleases)
	// 客户端专属访问模型的三个端点（契约 §5.1/§5.1b/§20.1）：
	// 与 internal/router 的申报逐条一致 —— 测试树与生产树前缀/形状不一致就测不出漂移。
	cli.POST("/:app_id/request", e.h.ClientRequest)
	cli.POST("/proof", e.h.AppProofIssue)
	cli.POST("/:app_id/open", e.h.OpenApp)

	// 管理面：权限由 router 申报（AdminAuth + RequirePermission），测试里用
	// middleware 直接注入"已登录管理员"（上下文键 "admin_user" 是 serverauth
	// 内部的既有契约，见 serverauth/admin.go 的 currentAdmin）。
	adm := r.Group("/api/server/admin/wasm-apps", func(c *gin.Context) {
		if u := e.adminFromHeader(c); u != nil {
			c.Set("admin_user", u)
		}
		c.Next()
	})
	adm.GET("", e.h.AdminList)
	adm.PUT("/review", e.h.AdminReview)
	adm.POST("/:app_id/unpublish", e.h.AdminUnpublish)
	adm.POST("/:app_id/publish", e.h.AdminPublish)
	adm.PUT("/:app_id/owner", e.h.AdminTransferOwner)
	adm.POST("/:app_id/freeze", e.h.AdminFreeze)
	// 审核队列（P0-1）：与 internal/router 的申报逐条一致。
	adm.GET("/:app_id/releases", e.h.AdminReleases)
	adm.POST("/:app_id/releases/:version/approve", e.h.AdminApproveRelease)
	adm.POST("/:app_id/releases/:version/reject", e.h.AdminRejectRelease)
	// 管理面诊断与运行时水位（P1-9/P2-4）：同样与 internal/router 逐条一致 ——
	// 管理面出口必须挂在**生产路径**上，否则测不出路由/路径漂移。
	adm.GET("/:app_id/diagnostics", e.h.AdminDiagnostics)
	adm.GET("/runtime", e.h.AdminRuntime)
	adm.GET("/:app_id/opens", e.h.AdminAppOpens)
	adm.GET("/opens/summary", e.h.AdminOpensSummary)
	adm.GET("/:app_id/ai-usage", e.h.AdminAppAIUsage)
	// 平台限制项（GET/PUT /limits）：与 internal/router 的申报逐条一致（静态段，
	// 不参与 /:app_id 通配）。P2-1 的信封判据必须走**生产路径**，否则测不出路由漂移。
	adm.GET("/limits", e.h.AdminLimitsGet)
	adm.PUT("/limits", e.h.AdminLimitsPut)

	// appstore 的归属转移端点（§11 第 17 项授权放开 kind 白名单）：挂同一个路径，
	// 用同一条用例证明 wasm_app 不再返回 400。
	ap := appstore.NewHandlers(e.db)
	r.PUT("/api/server/admin/apps/:kind/:app_id/owner", func(c *gin.Context) {
		if u := e.adminFromHeader(c); u != nil {
			c.Set("admin_user", u)
		}
		c.Next()
	}, ap.TransferOwner)
}

// installRequest 造一份**合法**的安装签名请求（nonce 每次新，时间戳取当前）。
//
// 待签消息 = appproof.InstallMessage（生产同款）：serverURL 取 httptest 的缺省 Host
// `http://example.com` —— 与请求侧一致，否则 proof 的 serverURL 绑定会不符。
func (e *testEnv) installRequest(appID string) appproof.InstallRequest {
	e.t.Helper()
	nonceBuf := make([]byte, 12)
	if _, err := rand.Read(nonceBuf); err != nil {
		e.t.Fatalf("生成 nonce: %v", err)
	}
	ts := time.Now().UTC().Unix()
	nonce := appID + "-" + hex.EncodeToString(nonceBuf)
	pub := e.installPriv.Public().(ed25519.PublicKey)
	return appproof.InstallRequest{
		InstallID: e.installID,
		PublicKey: base64.StdEncoding.EncodeToString(pub),
		Nonce:     nonce,
		TS:        ts,
		Signature: base64.StdEncoding.EncodeToString(
			ed25519.Sign(e.installPriv, appproof.InstallMessage(e.installID, nonce, ts, "http://example.com"))),
	}
}

// adminFromHeader 决定管理面的身份：缺省是 boss（super_admin），
// `X-Test-Admin: none` 表示"无管理会话"（用于断言 401 路径）。
func (e *testEnv) adminFromHeader(c *gin.Context) *serverstore.User {
	name := strings.TrimSpace(c.GetHeader("X-Test-Admin"))
	if name == "" {
		name = "boss"
	}
	if strings.EqualFold(name, "none") {
		return nil
	}
	return e.users[name]
}

// req 发一个请求（token 为空表示不带 Authorization）。
func (e *testEnv) req(method, path, token string, body any) *httptest.ResponseRecorder {
	e.t.Helper()
	var reader *bytes.Reader
	switch b := body.(type) {
	case nil:
		reader = bytes.NewReader(nil)
	case string:
		reader = bytes.NewReader([]byte(b))
	case []byte:
		reader = bytes.NewReader(b)
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			e.t.Fatalf("序列化请求体失败: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	e.r.ServeHTTP(w, req)
	return w
}

// payload 构造一次发布/预检请求体。
func (e *testEnv) payload(appID, version string, wasm []byte, cfg map[string]any) map[string]any {
	return map[string]any{
		"app_id":      appID,
		"version":     version,
		"title":       "示例应用 " + appID,
		"changelog":   "首版",
		"wasm_base64": b64(wasm),
		"config":      cfg,
	}
}

// goodConfig 是能通过校验的应用配置（access=public 允许匿名）。
func goodConfig() map[string]any {
	return map[string]any{
		"access":           "login",
		"whitelist":        []string{},
		"purpose":          "演示：给团队共享一个小工具",
		"data_sensitivity": "internal",
		"owner":            "张伟",
	}
}

// errBody 解析 §8 的错误信封。
type errBody struct {
	Error struct {
		Code    string         `json:"code"`
		Message string         `json:"message"`
		Details map[string]any `json:"details"`
		Hints   []string       `json:"hints"`
	} `json:"error"`
}

// decodeErr 断言响应是错误信封并返回它（顺带断言 status 与 code）。
func (e *testEnv) decodeErr(w *httptest.ResponseRecorder, wantStatus int) errBody {
	e.t.Helper()
	var eb errBody
	if err := json.Unmarshal(w.Body.Bytes(), &eb); err != nil {
		e.t.Fatalf("响应不是 JSON 错误信封: %v; body=%s", err, w.Body.String())
	}
	if w.Code != wantStatus {
		e.t.Fatalf("status = %d, want %d; body=%s", w.Code, wantStatus, w.Body.String())
	}
	if eb.Error.Code == "" || eb.Error.Message == "" {
		e.t.Fatalf("错误信封缺 code/message: %s", w.Body.String())
	}
	return eb
}

// decodeJSON 解析成功响应。
func (e *testEnv) decodeJSON(w *httptest.ResponseRecorder, wantStatus int, dst any) {
	e.t.Helper()
	if w.Code != wantStatus {
		e.t.Fatalf("status = %d, want %d; body=%s", w.Code, wantStatus, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), dst); err != nil {
		e.t.Fatalf("响应不是 JSON: %v; body=%s", err, w.Body.String())
	}
}

// publishOK 发布一个版本并断言 201，返回 release 段。
func (e *testEnv) publishOK(token, appID, version string, wasm []byte, cfg map[string]any) map[string]any {
	e.t.Helper()
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/"+appID+"/releases", token, e.payload(appID, version, wasm, cfg))
	if w.Code != http.StatusCreated {
		e.t.Fatalf("发布 %s v%s 失败: %d %s", appID, version, w.Code, w.Body.String())
	}
	var out struct {
		Release map[string]any `json:"release"`
		App     map[string]any `json:"app"`
	}
	e.decodeJSON(w, http.StatusCreated, &out)
	return out.Release
}

// auditActions 返回某个应用的审计动作序列（按写入顺序）。
func (e *testEnv) auditActions(appID string) []string {
	e.t.Helper()
	logs, err := serverstore.ListAuditLogsByApp(e.db, appID, 500)
	if err != nil {
		e.t.Fatalf("读审计失败: %v", err)
	}
	out := make([]string, 0, len(logs))
	for _, l := range logs {
		out = append(out, l.Action)
	}
	return out
}

// countAudit 统计全表审计条数（validate 不进审计的判据）。
func (e *testEnv) countAudit() int {
	e.t.Helper()
	var n int
	if err := e.db.QueryRow(`SELECT COUNT(*) FROM audit_logs`).Scan(&n); err != nil {
		e.t.Fatalf("统计审计失败: %v", err)
	}
	return n
}

// countReleases 统计某应用的版本行数（含软删）。
func (e *testEnv) countReleases(appID string) int {
	e.t.Helper()
	var n int
	if err := e.db.QueryRow(`SELECT COUNT(*) FROM app_releases WHERE kind = $1 AND app_id = $2`,
		serverstore.AppKindWasmApp, appID).Scan(&n); err != nil {
		e.t.Fatalf("统计版本失败: %v", err)
	}
	return n
}

// b64 是标准 base64（与端点约定一致：A-Za-z0-9+/ 且带 padding）。
func b64(raw []byte) string { return base64.StdEncoding.EncodeToString(raw) }

// assertNoAssetsDir 是"随包资源不落盘"的**负向判据**（2026-09-20 定案，决策文档
// docs/decisions/2026-09-20-wasm-assets-in-memory.md）：`<data_root>/apps/<app_id>/`
// 下不得出现 `assets/` 目录，也不得留下任何 `staging-*` 残骸。
//
// 为什么断言得这么死：发布链路的"零磁盘副作用"是本次改造的核心承诺 —— 一旦有人把
// 抽段落盘（staging 目录 / 按 release_id 的目录）加回发布链路，这条立刻变红。
// 目录不存在是**正常**形态（发布本身不建任何应用目录）。
func assertNoAssetsDir(t *testing.T, dataRoot, appID string) {
	t.Helper()
	appDir := filepath.Join(dataRoot, limits.AppsDirName, appID)
	// ① 精确判据：assets/ 不得存在。
	if _, err := os.Lstat(filepath.Join(appDir, "assets")); err == nil {
		t.Fatalf("<data_root>/apps/%s/assets 不得存在（随包资源已改为内存直出，不再抽取落盘）", appID)
	} else if !os.IsNotExist(err) {
		t.Fatalf("探测 assets 目录失败: %v", err)
	}
	// ② 更强的判据：应用目录里不能有任何以 staging- 开头的残骸（旧的原子改名形态）。
	entries, derr := os.ReadDir(appDir)
	if derr != nil {
		if os.IsNotExist(derr) {
			return // 应用目录都没建 = 最干净的形态
		}
		t.Fatalf("读应用目录失败: %v", derr)
	}
	for _, en := range entries {
		if strings.HasPrefix(en.Name(), "staging-") {
			t.Fatalf("<data_root>/apps/%s 下不得残留 staging 目录: %s", appID, en.Name())
		}
	}
}

// testLogger 把编译器的告警收进测试日志（隔离关闭的告警是**预期**的）。
type testLogger struct{ t *testing.T }

func (l testLogger) Printf(format string, args ...any) { l.t.Logf(format, args...) }
