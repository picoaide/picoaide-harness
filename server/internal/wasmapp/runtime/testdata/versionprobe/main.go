// Command versionprobe 是**门禁探针**（FIX-34 / 审计 P1-3）：把它当**生产形态**跑一遍，
// 证明"缓存分代用的是 wazero 真实版本，而不是手写回落常量"。
//
// 为什么必须是 `go build` 出来的 main 二进制：`version.GetWazeroVersion()`（wazero 内部实现）
// 靠 `debug.ReadBuildInfo().Deps` 找自己的版本，而**只有 `go test` 二进制的 Deps 里没有
// wazero**（实测 Main.Version=(devel)）⇒ 分代才会回落到 limits.CompileCacheRevision。
// 生产进程（服务端 / cmd/picoaide-app-compile）都是 main 二进制 ⇒ 拿得到真版本
// ⇒ 升级 wazero 后旧代目录本来就不会被命中，不需要任何人记得改常量。
//
// 用法（由 runtime 包的 TestCompileCacheNamespaceInProductionBinary 调用）：
//
//	go build -o <tmp>/versionprobe ./internal/wasmapp/runtime/testdata/versionprobe && <tmp>/versionprobe
//
// 输出三行（键=值），由测试解析：
//
//	wazero_in_deps=true|false
//	runtime_dir=<runtime.CompileCacheDir("/data/probe-root")>
//	compile_dir=<compile.CompileCacheDir("/data/probe-root")>
package main

import (
	"fmt"
	"runtime/debug"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/compile"
	wasmruntime "github.com/picoaide/picoaide/internal/wasmapp/runtime"
)

func main() {
	inDeps := false
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if strings.Contains(dep.Path, "github.com/tetratelabs/wazero") {
				inDeps = true
				break
			}
		}
	}
	const dataRoot = "/data/probe-root"
	fmt.Printf("wazero_in_deps=%t\n", inDeps)
	fmt.Printf("runtime_dir=%s\n", wasmruntime.CompileCacheDir(dataRoot))
	fmt.Printf("compile_dir=%s\n", compile.CompileCacheDir(dataRoot))
}
