// Command picoaide-app-compile 是 WASM 应用平台的**编译子进程**（R19/R31）。
//
// 它存在的唯一理由：它是整个平台里**唯一"读不可信字节且可能写宿主"的进程**（§15.1
// 第 14 条）。因此它被设计成：
//
//   - **独立进程**：编译崩溃/被 OOM 杀掉不会带走 server（父侧看到的是 exit code）；
//   - **父侧控制超时 + 自身 -timeout 兜底**：两层，任一层生效都能收场；
//   - **只读两个路径**：module_path 指向的文件（读）与 cache_dir 目录（写缓存）；
//   - **不继承宿主 env**：只拿 PATH/TMPDIR/TZ/LANG 白名单（§4.3「环境变量白名单」），
//     绝不继承 PG DSN / master key / PICOAI_*（详见 compile.CompileProcessEnv）；
//   - **OS 级隔离由父侧施加**：bwrap `--unshare-all` 等（§15.1 第 14 条 / R31）。
//     子进程不做隔离（一个进程无法给自己降权），也不假设自己已被隔离。
//
// 协议（父 ↔ 子，stdin/stdout 上**一行一个 JSON**）：
//
//	请求  {"op":"compile","module_path":"/abs/a.wasm","cache_dir":"/abs/dir"}
//	应答  {"ok":true,"imports":[…],"exports":[…],"custom_bytes":N,"compile_ms":N,"cached":bool}
//	失败  {"ok":false,"code":"COMPILE_TIMEOUT|COMPILE_OOM|SECTION_MALFORMED|…","message":"…","details":{…}}
//	探活  {"op":"ping"} → {"ok":true,"version":"picoaide-app-compile/1"}
//
// ⚠️ 不用 abi 的 RS 帧：那是"宿主 ↔ 应用"的协议（§7.1），与本协议混淆会让
// "编译进程的输出被当成应用输出"这类事故变得可能。两套协议在格式上就不同（这里没有魔数）。
//
// 用法（父侧 spawn 的两种形态）：
//
//	# 常驻（父侧默认；逐行请求/应答，空闲由父侧杀）
//	picoaide-app-compile -listen -timeout 60s
//
//	# 单次（手工排障；父侧不用这条路径，因为它要常驻复用进程内编译状态）
//	picoaide-app-compile -request '{"op":"compile","module_path":"/a.wasm","cache_dir":"/c"}'
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/compile"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/tetratelabs/wazero"
)

func main() {
	var (
		timeout = flag.Duration("timeout", limits.CompileTimeout, "单次编译的兜底超时（父侧另有超时；到点即判失败）")
		request = flag.String("request", "", "一行 JSON 请求（单次模式）；为空则从 stdin 逐行读")
		listen  = flag.Bool("listen", false, "常驻：从 stdin 逐行读请求、逐行写应答（父侧默认用这个）")
		cacheFn = flag.String("cache-dir", "", "本进程被允许写入的唯一目录（隔离启动器据此构造可写面；与请求里的 cache_dir 应一致）")
		maxAS   = flag.Int64("rlimit-as-bytes", defaultRLimitAS, "进程地址空间上限（RLIMIT_AS，字节；0=不设）。§4.3「编译进程超限被杀 ⇒ COMPILE_OOM」的进程内落地")
		maxCPU  = flag.Int64("rlimit-cpu-seconds", defaultRLimitCPU, "进程 CPU 时间上限（RLIMIT_CPU，秒；0=不设）")
		dumpLim = flag.Bool("print-limits", false, "打印本进程的 RLIMIT_AS/RLIMIT_CPU 后退出（门禁用：让'配额真的设上了'可被外部断言）")
	)
	flag.Parse()

	if *listen && *request != "" {
		fmt.Fprintln(os.Stderr, "picoaide-app-compile: -listen 与 -request 互斥")
		os.Exit(2)
	}

	// §4.3：编译进程必须有 CPU/内存配额（`WithMemoryLimitPages` 只管 wasm
	// **实例**内存，管不到编译期宿主内存）。这里用 rlimit 做进程内自保；
	// 部署面仍应叠加 cgroup 限额（rlimit 挡得住地址空间爆炸，挡不住"很多进程"）。
	applyResourceLimits(*maxAS, *maxCPU)

	if *dumpLim {
		// 门禁出口：把实际生效的 rlimit 打到 stdout，让"§4.3 的 CPU/内存配额"
		// 从声明变成可断言的事实（而不是只能读代码相信）。
		fmt.Printf(`{"ok":true,"rlimit_as":%d,"rlimit_cpu":%d}`+"\n", currentRLimit(rlimitAS), currentRLimit(rlimitCPU))
		return
	}

	srv := &server{timeout: *timeout, declaredCacheDir: *cacheFn}
	var err error
	if *request != "" {
		err = srv.handleLine([]byte(*request), os.Stdout)
	} else {
		err = srv.serve(os.Stdin, os.Stdout)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "picoaide-app-compile: %v\n", err)
		os.Exit(1)
	}
}

// 编译进程的资源上限默认值。
//
// 取值理由（§4.3「内存四笔账」）：32 MiB 模块 + 4 MiB 自定义段的编译峰值在数百 MB
// 量级（实测 2.2 MiB 模块的缓存条目 8 MB、编译 RSS 远小于它），2 GiB 是"足够宽、
// 又能挡住失控"的位置。CPU 上限与 §4.2 的 60 s 编译超时同量级（+50% 余量给宿主调度）。
const (
	defaultRLimitAS  = int64(2) << 30
	defaultRLimitCPU = int64(90)
)

// applyResourceLimits 设置进程级资源上限（best-effort：拿不到权限时只记 stderr，
// 不阻断编译——上限属于纵深，真正的主闸门是父侧超时 + 父侧 SIGKILL）。
func applyResourceLimits(asBytes, cpuSeconds int64) {
	setRLimit(rlimitAS, asBytes)
	setRLimit(rlimitCPU, cpuSeconds)
}

// server 是编译子进程的处理核心（无跨请求状态：每次编译都是一份新的 wazero Runtime）。
type server struct {
	timeout time.Duration
	// declaredCacheDir 是启动时被声明的可写目录（-cache-dir）。
	//
	// 它的用途是**自检**：如果请求里的 cache_dir 与它不一致，说明父侧的隔离放行面
	// 与实际写入位置不同——那会导致"写失败"或（更糟）"写到没被隔离约束的地方"。
	// 因此不一致时直接拒（fail-closed），而不是"尽力而为"。
	declaredCacheDir string
}

// serve 常驻循环：一行请求 → 一行应答。
func (s *server) serve(in io.Reader, out io.Writer) error {
	sc := bufio.NewScanner(in)
	// 请求很小（两个路径），但给足余量。
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		line := append([]byte(nil), sc.Bytes()...)
		if len(line) == 0 {
			continue
		}
		if err := s.handleLine(line, out); err != nil {
			return err
		}
	}
	return sc.Err()
}

// handleLine 处理一行请求并写出一行应答。
//
// 协议层错误（非法 JSON）一律当致命错误返回：协议错位之后继续读下去只会把应答
// 错配到别的请求上，比直接退出更危险（父侧看到子进程退出会重启并重试）。
func (s *server) handleLine(line []byte, out io.Writer) error {
	var req compile.Request
	if err := json.Unmarshal(line, &req); err != nil {
		return fmt.Errorf("请求不是合法 JSON: %w", err)
	}
	switch req.Op {
	case compile.OpPing:
		return writeLine(out, compile.Response{OK: true, Version: compile.ProcVersion})
	case compile.OpCompile:
		return writeLine(out, s.compile(req))
	default:
		// fail-closed：未知 op 一律拒（白名单语义，不给"未来加了 op 但忘了处理"留口子）。
		return writeLine(out, compile.Response{
			OK:      false,
			Code:    string(apperr.CodeForbidden),
			Message: fmt.Sprintf("不支持的操作 %q", req.Op),
			Details: map[string]any{"op": req.Op, "allowed": compile.OpCompile},
		})
	}
}

// compile 是子进程的全部工作：读字节 → 静态校验 → 真编译（写磁盘缓存）。
func (s *server) compile(req compile.Request) compile.Response {
	if req.ModulePath == "" || req.CacheDir == "" {
		return fail(apperr.CodeValidation, "module_path 与 cache_dir 都必须提供", nil)
	}
	if !filepath.IsAbs(req.ModulePath) || !filepath.IsAbs(req.CacheDir) {
		// 相对路径会依赖 cwd（隔离启动器把 cwd 设为 /），且让"只读这两个路径"的
		// 承诺变得依赖调用方——所以直接拒。
		return fail(apperr.CodeValidation, "module_path 与 cache_dir 必须是绝对路径", map[string]any{
			"module_path": req.ModulePath, "cache_dir": req.CacheDir,
		})
	}

	if s.declaredCacheDir != "" && filepath.Clean(req.CacheDir) != filepath.Clean(s.declaredCacheDir) {
		return fail(apperr.CodeValidation,
			"请求里的 cache_dir 与启动时声明的 -cache-dir 不一致（隔离放行面与写入位置必须相同）",
			map[string]any{"request_cache_dir": req.CacheDir, "declared_cache_dir": s.declaredCacheDir})
	}

	// 兜底超时（父侧到点会 SIGKILL 本进程；这里覆盖"父侧还没来得及杀"的窗口）。
	budget := s.timeout
	if budget <= 0 {
		budget = limits.CompileTimeout
	}
	deadline := time.Now().Add(budget)

	// 体积判定放在读取之前：不读超限文件（§4.3「内存四笔账」）。
	fi, err := os.Stat(req.ModulePath)
	if err != nil {
		return fail(apperr.CodeNotFound, "模块文件不可读", map[string]any{"error": err.Error()})
	}
	if fi.IsDir() {
		return fail(apperr.CodeValidation, "module_path 指向目录，不是文件", nil)
	}
	if fi.Size() > compile.MaxModuleBytes() {
		return fail(apperr.CodeWasmTooLarge,
			fmt.Sprintf("模块体积 %d 字节超过上限 %d 字节", fi.Size(), compile.MaxModuleBytes()),
			map[string]any{"size": fi.Size(), "max": compile.MaxModuleBytes()})
	}
	// 用 LimitReader 而不是直接 ReadFile：Stat 与 Read 之间有 TOCTOU 窗口
	//（文件被换大/换成 FIFO），不做二次限制就等于"上限只在 stat 那一刻成立"。
	f, err := os.Open(req.ModulePath)
	if err != nil {
		return fail(apperr.CodeNotFound, "模块文件打开失败", map[string]any{"error": err.Error()})
	}
	defer f.Close()
	bin, err := io.ReadAll(io.LimitReader(f, compile.MaxModuleBytes()+1))
	if err != nil {
		return fail(apperr.CodeNotFound, "模块文件读取失败", map[string]any{"error": err.Error()})
	}
	if int64(len(bin)) > compile.MaxModuleBytes() {
		return fail(apperr.CodeWasmTooLarge,
			fmt.Sprintf("模块体积超过上限 %d 字节（读取时判定）", compile.MaxModuleBytes()),
			map[string]any{"max": compile.MaxModuleBytes()})
	}

	// 1) 静态校验（wasmmod：自解析段表 + 导入面白名单，判据含符号与类型，§4.2）。
	// 与父侧预检**同一实现**，因此不存在"预检过了、子进程拒了"的不一致。
	rep, verr := compile.NewValidator().Validate(bin)
	if verr != nil {
		return failFromError(verr)
	}

	// 2) 真编译：必须用 NewCompilationCacheWithDir（§4.3 / §4.3.1）。
	cache, err := wazero.NewCompilationCacheWithDir(req.CacheDir)
	if err != nil {
		return fail(apperr.CodeInternal, "打开磁盘编译缓存失败", map[string]any{"error": err.Error()})
	}
	defer cache.Close(context.Background())

	cfg := compile.NewCompilerRuntimeConfig().WithCompilationCache(cache)
	rt := wazero.NewRuntimeWithConfig(context.Background(), cfg)
	defer rt.Close(context.Background())

	start := time.Now()
	cm, err := rt.CompileModule(context.Background(), bin)
	elapsed := time.Since(start)
	if err != nil {
		// 编译失败：**必须区分"模块有问题"与"环境有问题"**（§7.4 的失败归因）。
		//
		// 静态校验已经过了，所以失败只剩两类：
		//   ① 模块语义问题（我们没解析到的部分：类型/指令/索引/内存声明）⇒ 是作者的错；
		//   ② 环境问题（缓存目录不可写、磁盘满、内存不足）⇒ 是平台/部署的错，
		//      报成"你的 wasm 有问题"会把第一消费者（AI）引去改本来没问题的模块。
		// 判据用 errno 文本匹配（wazero 不导出类型化错误）：只匹配**明确的 IO 信号**，
		// 命中即归 INTERNAL；其余仍归模块问题（宁可偶尔少归一次，也不要把作者的
		// 编译错误说成平台故障）。
		if isEnvironmentFailure(err) {
			return fail(apperr.CodeInternal, "编译环境故障（缓存目录或资源不足）", map[string]any{
				"error":      err.Error(),
				"compile_ms": elapsed.Milliseconds(),
			})
		}
		return fail(apperr.CodeSectionMalformed, "编译失败", map[string]any{
			"error":      err.Error(),
			"compile_ms": elapsed.Milliseconds(),
		})
	}
	defer cm.Close(context.Background())

	// 超时兜底：编译已完成但已越过预算 ⇒ 不留"跑了 70 s 还算成功"的路径。
	if time.Now().After(deadline) {
		return fail(apperr.CodeCompileTimeout, "编译超出预算（子进程自身兜底超时）",
			map[string]any{"compile_ms": elapsed.Milliseconds(), "timeout_ms": budget.Milliseconds()})
	}

	return compile.Response{
		OK:             true,
		Imports:        rep.Imports,
		Exports:        rep.Exports,
		CustomBytes:    rep.CustomBytes,
		CompileMS:      elapsed.Milliseconds(),
		SectionNames:   rep.SectionNames,
		CustomSections: rep.CustomSections,
		// Cached 恒为 false：wazero 不暴露"是否命中缓存"，判据由父侧给出
		// （见 compile.Compiler 的 cacheEntryExists + 首编译的对比耗时）。
		Cached: false,
	}
}

// isEnvironmentFailure 判断编译错误是否来自环境（缓存目录/磁盘/内存）而不是模块。
//
// 只认这些**明确的**信号：命中即说明"不是你的 wasm 有问题"。刻意保守 —— 模块语义
// 错误里出现 permission denied 这类字样是不可能的，所以不会误伤。
func isEnvironmentFailure(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	for _, sig := range []string{
		"read-only file system",
		"permission denied",
		"no space left on device",
		"too many open files",
		"cannot allocate memory",
		"out of memory",
		"disk quota exceeded",
	} {
		if strings.Contains(msg, sig) {
			return true
		}
	}
	return false
}

// writeLine 写出一行 JSON 应答。
func writeLine(out io.Writer, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	_, err = out.Write(b)
	return err
}

// fail 构造失败应答。
func fail(code apperr.Code, msg string, details map[string]any) compile.Response {
	if details == nil {
		details = map[string]any{}
	}
	return compile.Response{OK: false, Code: string(code), Message: msg, Details: details}
}

// failFromError 把 *apperr.Error 转成失败应答。
//
// 注意 details 会原样回给父侧 —— 因此这里**只**透出平台自己构造的 details
// （路径、体积、符号名），不透出任何宿主机密（子进程本来也读不到）。
func failFromError(err error) compile.Response {
	if err == nil {
		return compile.Response{OK: true}
	}
	if ae, ok := apperr.As(err); ok {
		return compile.Response{
			OK:      false,
			Code:    string(ae.Code),
			Message: ae.Message,
			Details: ae.Details,
		}
	}
	return fail(apperr.CodeInternal, "内部错误", map[string]any{"error": err.Error()})
}
