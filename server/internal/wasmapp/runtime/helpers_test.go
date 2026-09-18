package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/tetratelabs/wazero"
)

// ===== guest 现场编译 =====
//
// 测试用的 wasm 一律**现场编译**（GOOS=wasip1 GOARCH=wasm），不入库任何二进制
// （testdata/guests 下只有 .go 源码）。
//
// 为什么用一个包级临时目录而不是每个测试各自的 t.TempDir()：Go 的 wasip1 产物
// 3 MiB 左右，一次 go build 约 1–2 s；二十多个用例各编译一次会让整个包跑成分钟级。
// 这里"每次 go test 编译一次、共享给同一进程内的所有用例"，结束后统一清理。

var (
	guestDirOnce sync.Once
	guestDir     string
	guestErr     error

	guestBinMu sync.Mutex
	guestBins  = map[string][]byte{}
)

func TestMain(m *testing.M) {
	code := m.Run()
	if guestDir != "" {
		_ = os.RemoveAll(guestDir)
	}
	os.Exit(code)
}

// guestBinary 返回 testdata/guests/<pkg> 编译出的 wasip1 模块字节。
func guestBinary(t *testing.T, pkg string) []byte {
	t.Helper()
	guestBinMu.Lock()
	defer guestBinMu.Unlock()
	if bin, ok := guestBins[pkg]; ok {
		return bin
	}
	guestDirOnce.Do(func() {
		guestDir, guestErr = os.MkdirTemp("", "wasmapp-runtime-guests-")
	})
	if guestErr != nil {
		t.Fatalf("创建 guest 编译目录失败: %v", guestErr)
	}
	goTool, err := exec.LookPath("go")
	if err != nil {
		// 不 skip：本包的用例全部依赖现场编译 wasm，"跳过"会让门禁变成空转。
		t.Fatalf("找不到 go 工具链（本包用例需要现场编译 wasip1 guest）: %v", err)
	}
	out := filepath.Join(guestDir, pkg+".wasm")
	cmd := exec.Command(goTool, "build", "-o", out, "./"+pkg)
	cmd.Dir = filepath.Join("testdata", "guests")
	cmd.Env = append(os.Environ(), "GOOS=wasip1", "GOARCH=wasm", "CGO_ENABLED=0")
	if buildOut, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("编译 guest %s 失败: %v\n%s", pkg, err, buildOut)
	}
	bin, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("读取 guest 产物失败: %v", err)
	}
	if len(bin) == 0 {
		t.Fatalf("guest %s 产物为空", pkg)
	}
	guestBins[pkg] = bin
	return bin
}

// ===== 共享测试运行时 =====

var (
	testRTOnce sync.Once
	testRT     *Runtime
	testRTErr  error
	testRTLog  *lockedBuffer
)

// lockedBuffer 收集宿主日志（断言 panic 被记录、且不外泄到应用可见面）。
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

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.buf)
}

// sharedRuntime 返回包级共享的执行侧 Runtime（Serve 本身是并发安全的，
// 每个请求都会新建实例，共享 Runtime 正是生产形态）。
func sharedRuntime(t *testing.T) *Runtime {
	t.Helper()
	testRTOnce.Do(func() {
		testRTLog = &lockedBuffer{}
		testRT, testRTErr = New(context.Background(), Options{Logger: log.New(testRTLog, "", 0)})
	})
	if testRTErr != nil {
		t.Fatalf("装配 Runtime 失败: %v", testRTErr)
	}
	return testRT
}

// appModule 返回 app guest 编译后的模块（包级共享：编译 3.4 MiB 的 Go 产物约 1–2 s）。
var (
	appModOnce sync.Once
	appMod     wazero.CompiledModule
	appModErr  error
)

func appModule(t *testing.T) wazero.CompiledModule {
	t.Helper()
	rt := sharedRuntime(t)
	appModOnce.Do(func() {
		appMod, appModErr = rt.CompileModule(context.Background(), guestBinary(t, "app"))
	})
	if appModErr != nil {
		t.Fatalf("编译 app guest 失败: %v", appModErr)
	}
	return appMod
}

// ===== 请求构造 =====

func testRequest(path string, h HostFuncs) Request {
	return Request{
		Envelope: abi.Request{
			ABI:     abi.ABIVersion,
			AppID:   "test-app",
			Version: "1.0.0",
			Auth:    abi.AuthInfo{Mode: abi.AuthModeLogin, Verified: true},
			User:    &abi.User{ID: 10231, Username: "zhangwei", DisplayName: "张伟", Dept: "研发部"},
			Method:  "POST",
			Path:    path,
			Query:   map[string]string{},
			Headers: map[string]string{"content-type": "application/json"},
			Body:    `{"hello":"world"}`,
		},
		Budgets: InstanceLimits{GuestBudget: 3 * time.Second},
		Funcs:   h,
	}
}

// serveApp 跑一次 app guest（默认预算 3 s）。
func serveApp(t *testing.T, path string, h HostFuncs) *Result {
	t.Helper()
	res, err := sharedRuntime(t).Serve(context.Background(), appModule(t), testRequest(path, h))
	if err != nil {
		t.Fatalf("Serve 返回装配错误: %v", err)
	}
	if res == nil {
		t.Fatal("Serve 返回 nil 结果")
	}
	return res
}

// ===== 假宿主能力面 =====

// fakeHost 是 HostFuncs 的测试实现：记录调用、可注入阻塞/panic/错误。
//
// 关键用例：blockFor 的阻塞**故意不理会 ctx**（§10.3 第 26 项实测：宿主不传 ctx 时
// 预算完全失效且返回 err=nil）⇒ runtime 必须靠自己的预算硬闸 + 返回后复检兜住。
type fakeHost struct {
	mu       sync.Mutex
	calls    []string
	blockFor map[string]time.Duration
	panicOn  map[string]bool
	errOn    map[string]*apperr.Error
}

func newFakeHost() *fakeHost {
	return &fakeHost{blockFor: map[string]time.Duration{}, panicOn: map[string]bool{}, errOn: map[string]*apperr.Error{}}
}

func (h *fakeHost) Dispatch(_ context.Context, method string, params json.RawMessage) (any, *apperr.Error) {
	h.mu.Lock()
	h.calls = append(h.calls, method)
	h.mu.Unlock()

	if d := h.blockFor[method]; d > 0 {
		time.Sleep(d) // 故意不看 ctx：模拟"宿主函数忘了传 ctx"
	}
	if h.panicOn[method] {
		panic("fake host panic with internal detail: pg-dsn-should-not-leak")
	}
	if e := h.errOn[method]; e != nil {
		return nil, e
	}
	switch method {
	case abi.MethodLog:
		return abi.LogResult{Accepted: 1}, nil
	case abi.MethodDBQuery:
		return abi.QueryResult{Columns: []string{"n"}, Rows: [][]any{{int64(1)}}}, nil
	case abi.MethodPing:
		return map[string]any{"pong": true}, nil
	default:
		return map[string]any{"method": method, "params": string(params)}, nil
	}
}

func (h *fakeHost) callList() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]string, len(h.calls))
	copy(out, h.calls)
	return out
}

// ===== 结果断言助手 =====

// requireKill 断言请求失败且错误码符合预期，并返回错误。
func requireKill(t *testing.T, res *Result, code apperr.Code) *apperr.Error {
	t.Helper()
	if res.KillReason == nil {
		t.Fatalf("期望失败 %s，但请求成功了（response=%+v metrics=%+v）", code, res.Response, res.Metrics)
	}
	if res.KillReason.Code != code {
		t.Fatalf("期望错误码 %s，实际 %s（%s）", code, res.KillReason.Code, res.KillReason.Message)
	}
	if res.Metrics.ReasonCode != string(code) {
		t.Fatalf("Metrics.ReasonCode 期望 %s，实际 %q", code, res.Metrics.ReasonCode)
	}
	if res.Metrics.Outcome == "" {
		t.Fatal("Metrics.Outcome 未填充")
	}
	// 失败时 HTTP 语义必须来自 §7.4 表。
	if res.KillReason.Status() == 200 {
		t.Fatalf("失败码 %s 映射出了 200", code)
	}
	return res.KillReason
}

// requireOK 断言请求成功并返回响应信封。
func requireOK(t *testing.T, res *Result) abi.Response {
	t.Helper()
	if res.KillReason != nil {
		t.Fatalf("期望成功，实际失败 %s: %s（exit=%d stderr=%q）",
			res.KillReason.Code, res.KillReason.Message, res.Metrics.GuestExitCode, res.Metrics.StderrTail)
	}
	return res.Response
}

// bodyJSON 把响应体解析成 map（响应体是应用自造的 JSON）。
func bodyJSON(t *testing.T, resp abi.Response) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(resp.Body), &m); err != nil {
		t.Fatalf("响应体不是 JSON: %v (body=%q)", err, resp.Body)
	}
	return m
}

// 手写 wasm 夹具在 wasmbin_test.go（含格式说明与"为什么这个形状合法"）。

// serveRaw 把一个手写模块编译后用最小请求跑一遍。
func serveRaw(t *testing.T, bin []byte, lim InstanceLimits) *Result {
	t.Helper()
	rt := sharedRuntime(t)
	cm, err := rt.CompileModule(context.Background(), bin)
	if err != nil {
		t.Fatalf("编译手写模块失败: %v", err)
	}
	req := testRequest("/raw", newFakeHost())
	req.Budgets = lim
	return serveCompiled(t, rt, cm, req)
}

// serveCompiled 跑一次已编译模块（允许指定 Runtime，用于不同内存上限的用例）。
func serveCompiled(t *testing.T, rt *Runtime, cm wazero.CompiledModule, req Request) *Result {
	t.Helper()
	res, err := rt.Serve(context.Background(), cm, req)
	if err != nil {
		t.Fatalf("Serve 返回装配错误: %v", err)
	}
	return res
}

// ===== 原始 guest 运行（§10.2 的配置类判据）=====

// runGuestCaptured 用执行侧的 ModuleConfig 直接实例化一个 guest 并捕获它的 stdout/stderr。
//
// 用途：§10.2 第 21/22/23 项与零 preopen 的判据需要**看到 guest 实际读到的东西**，
// 而帧协议路径只回响应体、看不到 stdout 原始内容。
func runGuestCaptured(ctx context.Context, rt *Runtime, bin []byte, lim InstanceLimits, guestStdin io.Reader) (stdout, stderr string, err error) {
	cm, cerr := rt.CompileModule(ctx, bin)
	if cerr != nil {
		return "", "", cerr
	}
	stdoutBuf := &lockedBuffer{}
	stderrBuf := &lockedBuffer{}
	mc := newModuleConfig("probe", guestStdin, stdoutBuf, stderrBuf)
	mod, ierr := rt.rt.InstantiateModule(ctx, cm, mc)
	if ierr != nil {
		return stdoutBuf.String(), stderrBuf.String(), ierr
	}
	defer func() { _ = mod.Close(context.Background()) }()
	gctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	clock := newGuestClock(cancel, lim.EffectiveGuestBudget())
	defer clock.stop()
	fn := mod.ExportedFunction("_start")
	if fn == nil {
		return stdoutBuf.String(), stderrBuf.String(), fmt.Errorf("guest 没有 _start")
	}
	_, callErr := fn.Call(gctx)
	return stdoutBuf.String(), stderrBuf.String(), callErr
}

// fieldOf 从 "key=value" 形式的探针输出里取一行。
func fieldOf(t *testing.T, out, key string) string {
	t.Helper()
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, key+"=") {
			return strings.TrimPrefix(line, key+"=")
		}
	}
	t.Fatalf("探针输出里没有 %s=（输出：%s）", key, out)
	return ""
}

// firstField 取一行输出的第一个空白分隔字段（探针把附加说明放在后面）。
func firstField(s string) string {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}

// intOf 解析十进制整数。
func intOf(t *testing.T, s string) int64 {
	t.Helper()
	v, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		t.Fatalf("不是整数: %q (%v)", s, err)
	}
	return v
}
