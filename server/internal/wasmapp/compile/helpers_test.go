package compile

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// 本文件是编译模块测试的**共享夹具构建器**。
//
// 纪律（本模块的验收要求）：子进程测试必须**真起进程**（go build 现场产出二进制到
// t.TempDir()），不许 mock 掉。因此这里提供两个"真构建"：
//
//	buildCompileChild  真编译 cmd/picoaide-app-compile → 临时目录
//	writeGuestModule   真用 GOOS=wasip1 GOARCH=wasm 编译一个 Go guest → .wasm
//
// 变异方式（各测试文件顶部另注）：把 ChildBinary 指回本进程自身（冒充子进程）会让
// 所有"真起进程"的用例红；把最小模块夹具的魔数改坏会让静态校验用例红。

var (
	serverRootOnce sync.Once
	serverRootDir  string
	serverRootErr  error
)

// serverRoot 返回 server/ 目录（cmd/ 与 internal/ 的父目录）。
//
// 用 `go list -m -f {{.Dir}}` 而不是猜相对层级（测试的工作目录是包目录，
// 但 -run 与 IDE 可能不同；模块根是编译器自己算出来的，最可靠）。
func serverRoot(t *testing.T) string {
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

var (
	childOnce sync.Once
	childPath string
	childErr  error
	childDir  string
)

// buildCompileChildOnce 编译一次子进程并在整包测试间复用（构建约 1–3 s，
// 每个用例都重建会让测试时间被构建主导）。
func buildCompileChildOnce(t *testing.T) string {
	t.Helper()
	childOnce.Do(func() {
		childDir, childErr = os.MkdirTemp("", "picoaide-compile-child-")
		if childErr != nil {
			return
		}
		out := filepath.Join(childDir, "picoaide-app-compile")
		cmd := exec.Command("go", "build", "-o", out, "./cmd/picoaide-app-compile")
		cmd.Dir = serverRoot(t)
		cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
		if b, err := cmd.CombinedOutput(); err != nil {
			childErr = &buildError{msg: string(b), err: err}
			return
		}
		childPath = out
	})
	if childErr != nil {
		t.Fatalf("构建编译子进程失败: %v", childErr)
	}
	return childPath
}

type buildError struct {
	msg string
	err error
}

func (e *buildError) Error() string { return e.err.Error() + "\n" + e.msg }

// packageDir 返回本测试文件所在目录（`go test` 的工作目录就是它，但显式求值更稳：
// `go test -C` / IDE 跑法下 cwd 未必是包目录）。
func packageDir(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位测试文件路径")
	}
	return filepath.Dir(file)
}

// compileHelperChild 构建 testdata/compilechild（模拟子进程的故障行为）。
func compileHelperChild(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	out := filepath.Join(dir, "compilechild")
	// packageDir/../../.. = server/（cmd/ 与 internal/ 的父目录=模块根）。
	cmd := exec.Command("go", "build", "-o", out, "./testdata/compilechild")
	// ⚠️ 段要用**绝对路径**：`testdata/` 是 Go 工具链的特殊目录（构建时被忽略），
	// 因此从模块根 `go build ./testdata/compilechild` 会报 "directory not found"。
	// 绝对路径绕过这个规则，同时也能被 `go list` 正常解析（包里面没有 testdata 引用）。
	cmd.Dir = packageDir(t)
	cmd.Args = []string{"go", "build", "-o", out, filepath.Join(packageDir(t), "testdata", "compilechild")}
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("构建测试用假子进程失败: %v\n%s", err, b)
	}
	return out
}

// writeGuestModule 用真实工具链编译一个 Go guest（GOOS=wasip1 GOARCH=wasm）。
//
// 为什么测试里要真编译 guest：静态校验用的是自己写的段解析器，只用手编码的
// 最小夹具测它，会漏掉"真实工具链产出的段布局"（例如 Go 会产出 datacount /
// 多个自定义段 / 17 条 WASI 导入）。这个用例是唯一能证明"解析器能吃真实产物"的判据。
//
// 返回 .wasm 字节与路径；编译失败（无工具链/无缓存）时 t.Skip。
func writeGuestModule(t *testing.T, dir string) (path string, data []byte) {
	t.Helper()
	progDir := filepath.Join(dir, "guest")
	if err := os.MkdirAll(progDir, 0o755); err != nil {
		t.Fatal(err)
	}
	src := `package main

import (
	"io"
	"os"
)

func main() {
	// 读一行 stdin 再写一行 stdout：真实产物里会同时出现 fd_read 与 fd_write
	//（设计 §4.2 明确要求导入面含 fd_read，这是 ABI 读请求帧的依赖）。
	// 测试只编译、不执行，所以不依赖任何宿主环境。
	buf := make([]byte, 64)
	n, _ := os.Stdin.Read(buf)
	buf = buf[:n]
	_, _ = io.Copy(os.Stdout, bytesReader(buf))
}

// bytesReader 用最简单的方式避开 bytes 包（保持 guest 源码零依赖）。
func bytesReader(b []byte) io.Reader { return &sliceReader{b: b} }

type sliceReader struct{ b []byte }

func (r *sliceReader) Read(p []byte) (int, error) {
	if len(r.b) == 0 {
		return 0, io.EOF
	}
	n := copy(p, r.b)
	r.b = r.b[n:]
	return n, nil
}
`
	if err := os.WriteFile(filepath.Join(progDir, "main.go"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(progDir, "go.mod"), []byte("module guest\n\ngo 1.26\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(progDir, "app.wasm")
	cmd := exec.Command("go", "build", "-o", out, ".")
	cmd.Dir = progDir
	cmd.Env = append(os.Environ(), "GOOS=wasip1", "GOARCH=wasm", "CGO_ENABLED=0")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("无法用本机工具链产出 wasip1 模块（跳过真实产物用例）: %v\n%s", err, b)
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	return out, data
}

// writeModule 把夹具字节写进临时文件并返回路径。
func writeModule(t *testing.T, dir, name string, b []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// newTestCompiler 构造一个指向真实子进程二进制、隔离关闭、超时可控的编译器。
func newTestCompiler(t *testing.T, child string, mut func(*Options)) *Compiler {
	t.Helper()
	opt := Options{
		DataRoot:    t.TempDir(),
		Isolation:   IsolationOff, // 测试环境不装 bwrap 也要能跑；隔离行为另有专门用例
		ChildBinary: child,
		Timeout:     30 * time.Second, // 真实 guest 编译留足余量
		Logger:      testLogger{t},
	}
	if mut != nil {
		mut(&opt)
	}
	c, err := New(opt)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// testLogger 把编译侧的日志转给 testing.T（让"大声记日志"可断言）。
type testLogger struct{ t *testing.T }

func (l testLogger) Printf(format string, args ...any) { l.t.Logf(format, args...) }

// recordingLogger 记录日志行，供隔离模式用例断言"必须大声"。
type recordingLogger struct {
	mu    sync.Mutex
	lines []string
}

func (l *recordingLogger) Printf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func (l *recordingLogger) joined() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.lines, "\n")
}
