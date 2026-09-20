// Command sockprobe 是**只用于生成导入白名单**的第四个探测程序（2026-09-21 审计 P0-6）。
//
// 为什么需要它：白名单此前由 refapp + wasiprobe + stdprobe 三份 Go 程序生成，而 Go 的
// wasip1 运行时只声明 `sock_accept` / `sock_shutdown`（`syscall/net_wasip1.go:17,21`）
// —— **TinyGo 的运行时还会声明 `sock_recv` / `sock_send`**（它的 `net/url` 会把
// 网络栈带进产物）。于是同一份"只用标准库"的应用代码，用 TinyGo 编译就被
// `IMPORT_NOT_ALLOWED` 拒、用 Go 编译就能过 —— 而内存实测（temp/wasm-lite-probe）
// 显示 TinyGo 产物常驻内存只有 Go 的 1/4，是平台"轻量化"的主要路径。
//
// 安全论证（为什么放行这两条不产生新能力）：`sock_recv`/`sock_send` 都需要一个
// **已连接**的 socket fd，而 preview1 里没有任何办法造出它 ——
//   - 没有 `sock_open`/`sock_bind`/`sock_listen`/`sock_connect`（造 fd 的四条一概不在白名单）；
//   - `sock_accept` 需要一个已监听的 fd，实测 `sock_accept(0..10)` 全 EBADF(8)；
//   - 运行时零 preopen ⇒ 也拿不到 socket 型 preopen。
//
// 也就是说：这两条是"能力为空的符号"，放行的只是"能写出调用"，不是"能连出去"。
// 门禁 `TestWhitelistAllowsOnlyFdFreeSockSymbols` 仍逐字钉住**精确集合**
// （允许 sock_accept/sock_recv/sock_send/sock_shutdown；禁止造 fd 的四条）。
//
// 生成方式与其他探测程序一致：只被 `picoaide-wasm-imports-gen` **编译**、从不运行。
// 为了本机原生 `go build ./...` 与 `go vet` 也能过，wasm 专用的导入声明放在
// `sock_wasip1.go`（只有 wasip1 构建才参与编译），其他平台用 `sock_other.go` 的空实现。
package main

import (
	"fmt"
	"os"
)

// guarded 是不可达守卫：条件永假（正常进程的 argv 不可能有上百万个），但编译器无法
// 静态证明，所以分支内的调用不会被死代码消除 ⇒ 两条 WASI 导入留在产物里，真跑不执行。
//
// 与 stdprobe.guarded 同一手法（那边覆盖的是 stdlib 调用，这里覆盖的是直接声明的
// wasmimport）——两者都靠"引用即保留"的链接器行为。
func guarded() bool { return len(os.Args) > 1<<20 }

func main() {
	if guarded() {
		probeSockets()
	}
	// 让产物不是"只有一个空 main"：真跑时也能确认程序活着（生成器只编译、不运行）。
	fmt.Fprintln(os.Stderr, "sockprobe: 本程序只用于生成导入白名单，不参与平台运行")
}
