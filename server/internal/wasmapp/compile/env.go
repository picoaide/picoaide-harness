package compile

import (
	"path/filepath"
	"strconv"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是**编译子进程环境变量的白名单**（§4.3「参数 / 环境变量」+ R31 的 env 纪律）。
//
// 威胁：编译子进程处理的是攻击者的字节。如果它继承了宿主 env，那么一次成功的
// 代码执行（或仅仅是一次"读取自身环境并写进编译产物/日志"的路径）就能拿到
// PG DSN（直连平台数据库）、master key（解密全部凭据）与所有 PICOAI_* 配置。
// 子进程**不需要**这些：它只读一个模块文件、写一个缓存目录。
//
// 因此这里刻意用**白名单**而不是黑名单（黑名单永远会漏掉下一个新增的密钥变量），
// 并且白名单只有四项：PATH / TMPDIR / TZ / LANG。
//
// ⚠️ 如实注明（审计 P2-12 实测）：走 bwrap 隔离时子进程**实际能看到 5 个变量** ——
// bwrap 的 `--chdir /` 会自己注入 `PWD=/`（实测：父侧刻意传 `PWD=/some/host/dir`，
// 子进程读到的仍是 `/`）。它不是继承来的，值固定为 `/`，不含任何宿主信息；
// 探针 testdata 里把它钉成"若出现则值必须是 /"。
//   - PATH：子进程自身不 exec 别的程序（bwrap 由父侧 exec），但 Go 运行时/诊断
//     路径可能用得到，且它是"无害且常见"的；
//   - TMPDIR：wazero/go 可能需要临时目录；
//   - TZ / LANG：让日志时间与文案可读（纯表现层，不含机密）。

// compileEnvAllowlist 是**唯一**允许进入编译子进程的环境变量名（大写比较）。
var compileEnvAllowlist = []string{"PATH", "TMPDIR", "TZ", "LANG"}

// CompileProcessEnv 从父环境里筛出允许传给编译子进程的变量。
//
// 语义细节（都是刻意的）：
//   - **未设置的允许项不会被补**：子进程自己会用它的默认值；
//   - **空值的允许项会被传**：显式空值（如 `TZ=`）与"未设置"语义不同，传空值是保真；
//   - 白名单**外**的一切（含 PG_DSN / PICOAI_* / MASTER_KEY / 任何 *_KEY / *_DSN）
//     一律丢弃，不做任何"看起来无害就放行"的判断；
//   - 传入 nil 表示"没有父环境"，返回 nil（不是空切片：让 exec 见到"无环境"而不是
//     "空环境"这两种语义之一由平台定，父侧总是显式传 os.Environ()）。
//
// 变异方式（env_test.go 顶部同样标注）：把白名单换成 `return parent`、
// 或改成"前缀黑名单"，`TestCompileProcessEnvDropsSecrets` 必红。
func CompileProcessEnv(parent []string) []string {
	if parent == nil {
		return nil
	}
	allowed := make(map[string]bool, len(compileEnvAllowlist))
	for _, k := range compileEnvAllowlist {
		allowed[k] = true
	}
	out := make([]string, 0, len(compileEnvAllowlist))
	for _, kv := range parent {
		eq := strings.IndexByte(kv, '=')
		if eq <= 0 {
			// 形如 "FOO"（无 =）或 "=x" 的畸形项：直接丢（畸形项常来自手工调试，
			// 不值得为它放宽规则）。
			continue
		}
		if !allowed[strings.ToUpper(kv[:eq])] {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// CompileProcessEnvKeys 返回 CompileProcessEnv 的**结果键名**（测试与诊断用）。
func CompileProcessEnvKeys(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		if eq := strings.IndexByte(kv, '='); eq > 0 {
			out = append(out, kv[:eq])
		}
	}
	return out
}

// CompileChildEnv 在**白名单结果**之上追加平台自己算出来的部署级参数（R1-rt-7b）。
//
// 只追加一项：CompilerMemoryPagesEnvVar = 生效的单实例线性内存页数。它让"发布期编译"
// 与"执行期实例化"用同一个上限（否则控制台调小 ⇒ 发布放行、首个请求 500；调大 ⇒
// 声明大内存的应用被误拒）。
//
// ⚠️ 安全边界（不许放松）：**父环境里的同名变量不会被透传**（它不在 compileEnvAllowlist）。
// 这里的值永远由平台算出来 —— `parent` 只提供 PATH/TMPDIR/TZ/LANG 四项。测试注入
// `PICOAI_COMPILE_MEMORY_PAGES=999` 的父环境时，子进程读到的仍是实参 memoryPages。
//
// memoryPages=0 ⇒ 编译期默认（limits.InstanceMemoryPages）：调用方没解析出生效值时的
// 回落，与 runtime.New 的 MemoryPages=0 分支同语义。
func CompileChildEnv(parent []string, memoryPages uint32) []string {
	if memoryPages == 0 || memoryPages > maxCompilerMemoryPages {
		memoryPages = limits.InstanceMemoryPages
	}
	env := CompileProcessEnv(parent)
	// os/exec 的 dedupEnv 保留**最后**一条同键项，因此这里 append 一定是生效值
	// （即便父环境里混进了同名项，它也已经被白名单滤掉了）。
	return append(env, CompilerMemoryPagesEnvVar+"="+strconv.FormatUint(uint64(memoryPages), 10))
}

// isolationPlan 是"如何启动编译子进程"的最终决策（与具体后端解耦）。
//
// 为什么要有这一层而不是直接返回 []string：隔离方案有两种形态——
//   - **包装型**（bwrap）：argv 前插入包装器，原 argv 作为参数；
//   - **定位型**（landlock/无隔离）：argv 不变，只做检测与日志。
//
// 把它们统一成"给一个 argv → 返回可 exec 的 argv + 工作目录"，
// 上层的 startChild 就不需要知道任何平台细节。
type isolationPlan struct {
	// backend 是后端标识（bwrap / landlock-detect / none）。
	backend string
	// available 表示隔离**实际生效**（不是"二进制存在"）。
	available bool
	// dir 是要设置的 cwd（bwrap 下是 /：既避免相对路径，也让"宿主的 cwd"不泄漏）。
	dir string
	// wrapArgv 在包装型后端下把 argv 包成隔离内的 argv。
	//
	// 目标目录由**调用方显式传入**（isolationTargets），不从 argv 里反解：
	// 反解依赖"argv 里恰好带着某个 flag"，而常驻子进程的 argv 是
	// `-listen -timeout …`（CACHE DIR 在**请求**里，不在 argv 里）——
	// 反解在那种形态下必然失败，且失败得很晚（真起进程时才炸）。
	// 这是端到端用例抓出来的真实缺陷（形状测试测不到），改动见 isolate_linux.go。
	wrapArgv func(argv []string, tgt isolationTargets) ([]string, error)
	// notes 是启动日志/诊断里要写清的事实。
	notes string
}

// describe 返回可读描述（启动日志与 /readyz）。
func (p *isolationPlan) describe() string {
	if p == nil {
		return "none(未初始化)"
	}
	state := "不可用"
	if p.available {
		state = "已启用"
	}
	s := "后端=" + p.backend + " " + state
	if p.notes != "" {
		s += "：" + p.notes
	}
	return s
}

// isolationTargets 是隔离启动器需要知道的**文件系统面**。
//
// 只有两项，且都是绝对路径：
//
//	CacheDir   唯一的**宿主**可写面（§4.3.1-d：编译进程只写缓存目录）
//	           ⚠️ 沙箱内另有私有 `/tmp` tmpfs 可写（`--tmpfs /tmp`）：写进去的字节
//	           随命名空间释放，**宿主看不到**（审计 P2-11：旧措辞"唯一可写面"不准确）
//	ReadOnlyDirs 额外需要**只读**放行的目录（通常为空：`--ro-bind / /` 已经让
//	             整个文件系统只读可见，模块在哪都能读到）
type isolationTargets struct {
	CacheDir     string
	ReadOnlyDirs []string
	// Env 是**已经过白名单过滤**的子进程环境（CompileProcessEnv 的结果）。
	//
	// 由调用方传入而不是在隔离层读 os.Environ()：两条启动路径（直接 exec 与
	// bwrap 包装）必须用同一份来源，否则 Options.Env 注入时会出现"隔离关了一套、
	// 隔离开另一套"的保真差异（测试注入假父环境时就踩得上）。
	Env []string
}

// wrap 把子进程 argv 包进隔离（不隔离时原样返回）。
func (p *isolationPlan) wrap(bin string, args []string, tgt isolationTargets) ([]string, string, error) {
	argv := append([]string{bin}, args...)
	if p != nil && p.available && p.wrapArgv != nil {
		wrapped, err := p.wrapArgv(argv, tgt)
		if err != nil {
			return nil, "", err
		}
		return wrapped, p.dir, nil
	}
	dir := ""
	if p != nil {
		dir = p.dir
	}
	return argv, dir, nil
}

// dirOf 返回路径的目录（空路径返回空）。
func dirOf(p string) string {
	if p == "" {
		return ""
	}
	return filepath.Dir(p)
}

// dirCovered 判断 dir 是否已被 dirs 里的某一项覆盖（相等或在其下）。
//
// 用于"声明了 ReadableDirs 就不必为每个模块目录重启"这条优化：判据必须是**前缀且
// 在路径分隔符处断开**，否则 `/data/apps-other` 会被 `/data/apps` 误判成已覆盖。
func dirCovered(dirs []string, dir string) bool {
	if dir == "" {
		return true
	}
	for _, d := range dirs {
		if d == "" {
			continue
		}
		if dir == d {
			return true
		}
		if strings.HasPrefix(dir, strings.TrimSuffix(d, string(filepath.Separator))+string(filepath.Separator)) {
			return true
		}
	}
	return false
}
