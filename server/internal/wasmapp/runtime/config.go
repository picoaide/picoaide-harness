// Package runtime 是 WASM 应用平台的**执行侧**（模块 C）：wazero 沙箱宿主。
//
// 职责边界（严格）：
//   - 本包只做「起实例、跑帧协议、计时、把失败映射成平台错误码、出计量」；
//   - **宿主能力的具体逻辑不在这里**（db / ai / assets / log 由 internal/wasmapp/hostcap
//     实现），本包只定义 HostFuncs 接口并调度；
//   - 编译与磁盘编译缓存的生产者也不在这里（internal/wasmapp/compile）。
//
// 设计基线：docs/planning/2026-09-17-wasm-app-platform.md
// 本文注释里的 §x.y 均指该文档。红线 3/4/5/6 的落地点就是这个包：
//
//	§4.3    运行时必须显式配置项（每一项的默认值都是危险值）
//	§4.3.1  编译缓存：唯一构造函数与信任边界
//	§4.4    宿主能力调用（预算 + 返回后强制复检 + recover 边界）
//	§4.6    请求与队列（上限数值一律 import limits）
//	§7      应用契约（帧协议 / 计时规则 / 失败语义）
//	§10.2   沙箱逃逸用例 14/15/21/22/23
//	§10.3   资源耗尽用例 24–29、35
package runtime

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"reflect"
	"runtime/debug"
	"strings"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/cachetrust"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/tetratelabs/wazero"
)

// ===== §4.3.1 编译缓存 =====

// NewRuntimeConfig 是编译进程与执行进程**共用**的唯一构造函数（§4.3.1-a）。
//
// 两侧必须逐字段相同：wazero 的磁盘编译缓存键 =
// sha256(moduleID ‖ magic ‖ CPU features)，而
// moduleID = AssignModuleID(binary, listeners, ensureTermination)
// （wazero runtime.go 的 CompileModule、internal/wasm/module.go 的 AssignModuleID、
// internal/engine/wazevo/engine_cache.go 的 fileCacheKey）。**唯一**由本函数决定的
// 进键字段就是 AssignModuleID 的第三个参数 `ensureTermination`，也就是
// `WithCloseOnContextDone`；引擎种类与 CoreFeatures 会改变编译产物（因此也进键）。
//
// 编译侧的对等函数是 compile.NewCompilerRuntimeConfig()（该包刻意不 import 本包，
// 两侧一致性由 consistency_test.go 的源码/指纹对拍保证）。
func NewRuntimeConfig() wazero.RuntimeConfig {
	return wazero.NewRuntimeConfig().
		// §4.3 / §15.1 第 1 条：不开则 context 超时**完全不生效**（实测）。
		// 该标志进缓存键 ⇒ 两侧不一致时磁盘缓存永不命中，且失败形态是静默的。
		WithCloseOnContextDone(true).
		// §4.3（R22）：64 MiB/实例。
		// ⚠️ 该标志**不进缓存键**（实测：只改内存上限仍命中同一键）⇒ 它在执行侧设置、
		// 编译侧不设也不影响命中；这里放进来只是为了让两侧"逐字段可比"（少一类
		// "为什么这个字段不一样" 的排查成本）。
		WithMemoryLimitPages(limits.InstanceMemoryPages)
}

// CompileCacheDir 返回数据根下的编译缓存目录（§4.3：<data_root>/_compile-cache/<分代>；
// 目录名部分由 limits 唯一真源给出，**分代名由 cacheNamespace() 决定**）。
//
// 分代名 = wazero 的真实版本（拿不到时才回落到 limits.CompileCacheRevision）。
// ⚠️ 事实更正（审计 P1-3，2026-09-18）：早先的实现写死 limits.CompileCacheRevision，
// 理由是"GetWazeroVersion() 在依赖方返回 dev"——**那只对 `go test` 二进制成立**。
// `go build` 出来的 main 二进制（服务端进程 / cmd/picoaide-app-compile 都是）里
// debug.ReadBuildInfo().Deps 有 wazero，返回的是真实版本（实测 v1.12.0）⇒ 升级 wazero 后
// 旧目录本来就不会被命中，不需要任何人记得去改一个手写常量。手写常量只留给"版本不可知"的构建。
//
// 编译侧必须算出**同一个目录**（§4.3.1-a）：compile.CompileCacheDir() 是同一算法的第二份
// 实现（该包刻意不 import 本包），两侧由 runtime 的交叉断言用例
// （TestCompileCacheDirMatchesCompileSide）与生产装配点 appserver.Options 校验共同钉住。
func CompileCacheDir(dataRoot string) string {
	return filepath.Join(dataRoot, limits.CompileCacheDirName, cacheNamespace())
}

// cacheNamespace 返回编译缓存的分代命名空间。
func cacheNamespace() string { return cacheNamespaceFor(wazeroVersion()) }

// cacheNamespaceFor 是分代规则的**纯函数**形态（可测试）：
// 拿得到 wazero 真实版本就用它（wazero 自己也按版本分片，升级即整代失效）；
// 拿不到（test 二进制里是 "" / "dev" / "(devel)"）才回落到手写常量 limits.CompileCacheRevision。
func cacheNamespaceFor(v string) string {
	v = strings.TrimSpace(v)
	if v != "" && v != "dev" && v != "(devel)" {
		return v
	}
	return limits.CompileCacheRevision
}

// wazeroVersion 返回**wazero 自己用于目录分片的那个版本字符串**。
//
// ⚠️ 为什么这里自己解析 build info，而不是调 `version.GetWazeroVersion()`：
// 那个函数在 `github.com/tetratelabs/wazero/internal/version` —— Go 禁止跨模块 import
// 别人的 internal 包。本函数是它的**逐行镜像**（wazero v1.12.0 `internal/version/version.go`）：
//
//	① 在 info.Deps 里找 Path 含 "github.com/tetratelabs/wazero" 的依赖，取其 Version；
//	② 找不到时（wazero 自己作为 main module，例如它的 CLI）取 info.Main.Version；
//	③ 仍为空 / "(devel)" ⇒ "dev"。
//
// 判据（审计 P1-3，2026-09-18）：**只有 `go test` 二进制拿不到版本**（实测 Deps 里没有
// wazero、Main.Version=(devel)）；`go build` 出来的 main 二进制（服务端进程与
// cmd/picoaide-app-compile 子进程）Deps 里有 wazero ⇒ 返回 v1.12.0 ⇒ wazero 自己就会按
// `wazero-v1.12.0-<os>-<arch>` 分片，升级 wazero 后旧条目本来就不会被命中。
//
// 编译侧有一份同样的镜像（compile.wazeroVersion，该包刻意不 import 本包）：
// 两侧必须返回同一个值，由交叉断言用例 TestCompileCacheDirMatchesCompileSide 钉住。
func wazeroVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "dev"
	}
	ret := ""
	for _, dep := range info.Deps {
		if strings.Contains(dep.Path, "github.com/tetratelabs/wazero") {
			ret = dep.Version
		}
	}
	if ret == "" || ret == "(devel)" {
		ret = info.Main.Version
	}
	if ret == "" || ret == "(devel)" {
		return "dev"
	}
	return ret
}

// NewCompilationCache 构造 wazero 的磁盘编译缓存（§4.3 / §10.3 第 35 项）。
//
// 为什么用 wazero 自带的实现而**不自建 LRU**（§4.3 原话）：CompilationCache 的接口
// 注释明写 "for decoupling, not third-party implementations"，且编译产物跨不了进程
// （内存缓存只在本进程有效），磁盘缓存才是"发布期编译暖到执行进程"的唯一载体。
//
// 目录权限 0700：缓存条目会被执行进程 mmap 成机器码执行 ⇒ 目录本身是信任边界
// （§4.3.1-d / §12 认账项）。这里只保证**目录权限**；"谁来写"由部署面保证
// （属主 = 编译进程，执行进程只读）。
//
// ⚠️ 回收的**唯一实现**在编译侧（compile.ReclaimCache）：执行进程只读缓存，本包不再提供
// 第二份回收实现（runtime.PruneCompilationCache 已删除，审计 P2-3：它与 compile 侧重复且
// 生产路径零调用点）。这里保留的 CacheUsage 只是**只读度量**（条目数/字节数）。
func NewCompilationCache(dataRoot string) (wazero.CompilationCache, error) {
	if strings.TrimSpace(dataRoot) == "" {
		return nil, errors.New("runtime: dataRoot 必填（编译缓存目录 = <dataRoot>/" +
			limits.CompileCacheDirName + "/<分代>）")
	}
	dir := CompileCacheDir(dataRoot)
	// 与编译侧同一个实现（cachetrust）：先确认是真实目录，再 MkdirAll + 显式 Chmod，
	// 最后形状校验。
	//
	// 执行侧**不允许拒绝启动**（2026-09-21 独立审计 P1-①）：`Ensure` 的错误此前会一路
	// 冒泡到 cmd/server 的 `log.Fatalf`，也就是"缓存目录不可用 ⇒ 整个服务端退出"——
	// 而缓存是**性能优化**，不是执行前提（没有它 wazero 只是每进程重编译一次）。
	// 更糟的是踩中它的部署形态很常见：只读挂载、`--user` 非属主、k8s `runAsUser`
	// 下 Chmod 必然失败 ⇒ 服务端起不来，而它本该只是"慢一点"。
	// 现在的语义：拿不到可用缓存 ⇒ **降级为 nil（wazero 用进程内缓存）并大声告警**；
	// 违规（形状不可信）同样只告警。真正不可用的目录在下面会被 wazero 自己再拒一次。
	report, cerr := cachetrust.Ensure(dir, os.FileMode(limits.DataDirMode))
	if cerr != nil {
		log.Printf("runtime: ⚠️ 编译缓存目录不可用，降级为进程内缓存（不影响功能，只影响首次编译耗时）：%v", cerr)
		return nil, nil
	}
	if !report.Trusted() {
		for _, v := range report.Violations {
			log.Printf("runtime: ⚠️ 编译缓存目录不可信：%s（%s）", v.Path, v.Reason)
		}
	}
	// wazero 会在其下再建 wazero-v<ver>-<arch>-<os>/ 版本分片目录（cache.go 的
	// ensuresFileCache），并给该分片目录 0700。
	cache, err := wazero.NewCompilationCacheWithDir(dir)
	if err != nil {
		return nil, fmt.Errorf("runtime: 打开编译缓存失败: %w", err)
	}
	return cache, nil
}

// RuntimeConfigFingerprint 返回 RuntimeConfig 的**进键字段**指纹，用于
// "编译侧与执行侧一致"的断言（§4.3.1-a）。
//
// 只序列化进缓存键的字段：
//   - WithCloseOnContextDone（⇒ AssignModuleID 的 ensureTermination 字节）；
//   - CoreFeatures（改变编译产物）；
//   - engine 种类（compiler / interpreter / auto）。
//
// **刻意不包含** memoryLimitPages 等不进键字段：把它们纳入会让
// "只差一个不进键的标志"被误报成两侧不一致（§4.3.1-a 明确允许
// WithMemoryLimitPages 不同）；反过来，这个指纹也不是"全字段相等"的证明
// ——全字段对拍由编译侧的 compile.CompilerRuntimeConfigFingerprint() 承担。
//
// 实现说明：wazero 的 RuntimeConfig 接口没有 getter，具体类型 runtimeConfig 的字段
// 全部非导出，因此只能用反射读（值类型分支取值，不走 Interface()）。
func RuntimeConfigFingerprint(cfg wazero.RuntimeConfig) string {
	v := reflect.ValueOf(cfg)
	if !v.IsValid() {
		return "wazero.RuntimeConfig(<nil>)"
	}
	for v.Kind() == reflect.Pointer || v.Kind() == reflect.Interface {
		if v.IsNil() {
			return "wazero.RuntimeConfig(<nil>)"
		}
		v = v.Elem()
	}
	if v.Kind() != reflect.Struct {
		return fmt.Sprintf("wazero.RuntimeConfig(%s)", v.Type())
	}
	return fmt.Sprintf("engine=%s;coreFeatures=0x%x;closeOnContextDone=%t",
		engineKindName(fieldInt(v, "engineKind")),
		fieldUint(v, "enabledFeatures"),
		fieldBool(v, "ensureTermination"),
	)
}

// engineKindName 把 wazero 的 engineKind 渲染成稳定名字。
// 常量顺序见 wazero config.go：auto = -1, compiler = 0, interpreter = 1。
func engineKindName(k int64) string {
	switch k {
	case -1:
		return "auto"
	case 0:
		return "compiler"
	case 1:
		return "interpreter"
	default:
		return fmt.Sprintf("unknown(%d)", k)
	}
}

func fieldBool(v reflect.Value, name string) bool {
	f := v.FieldByName(name)
	if !f.IsValid() || f.Kind() != reflect.Bool {
		return false
	}
	return f.Bool()
}

func fieldInt(v reflect.Value, name string) int64 {
	f := v.FieldByName(name)
	if !f.IsValid() {
		return 0
	}
	switch f.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return f.Int()
	default:
		return 0
	}
}

func fieldUint(v reflect.Value, name string) uint64 {
	f := v.FieldByName(name)
	if !f.IsValid() {
		return 0
	}
	switch f.Kind() {
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return f.Uint()
	default:
		return 0
	}
}

// ===== 编译缓存度量（§10.3 第 35 项）=====

// CacheUsage 统计缓存目录的条目数与字节数（**只读度量**）。
//
// 条目数 = 目录下的**文件**数（wazero 的一条缓存条目就是一个文件，名字是
// sha256(moduleID‖magic‖cpuFeatures) 的十六进制；写入过程中的 *.tmp 也算占用，
// 因此一并计入 —— 宁可多算，不可少算）。
//
// ⚠️ 回收不在这里：**回收的唯一实现是编译侧的 compile.ReclaimCache**（§4.3.1-d 的分工：
// 子进程只写缓存，删除只能由父侧做）。本包原有的 PruneCompilationCache 已删除
// （审计 P2-3：它与 compile 侧重复实现，且在生产路径**零调用点**）。
func CacheUsage(dir string) (bytes int64, entries int, err error) {
	files, err := cacheFiles(dir)
	if err != nil {
		return 0, 0, err
	}
	for _, f := range files {
		bytes += f.size
	}
	return bytes, len(files), nil
}

type cacheFile struct {
	path    string
	size    int64
	modTime time.Time
}

// cacheFiles 列出缓存目录下的全部文件（不含目录本身）。
func cacheFiles(dir string) ([]cacheFile, error) {
	if _, err := os.Stat(dir); err != nil {
		return nil, err
	}
	var out []cacheFile
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		out = append(out, cacheFile{path: path, size: info.Size(), modTime: info.ModTime()})
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ===== 便捷：模块摘要（诊断/审计用；不参与缓存键）=====

// ModuleDigest 返回模块字节的 sha256（十六进制），供诊断与发布链路标记"跑的是哪份字节"。
//
// ⚠️ 它与 wazero 的缓存键**不是一回事**：缓存键 = sha256(moduleID‖magic‖CPU features)，
// 其中 moduleID 又是 sha256(binary‖listeners‖ensureTermination)。本函数只用于人读的关联。
func ModuleDigest(bin []byte) string {
	sum := sha256.Sum256(bin)
	return hex.EncodeToString(sum[:])
}
