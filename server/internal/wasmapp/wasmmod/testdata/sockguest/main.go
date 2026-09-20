// Command sockguest 是**导入面覆盖性门禁**用的最小程序（2026-09-21 审计 P0-6），
// **不进白名单生成的来源清单** —— 与 testdata/stdrender 同一用意，刻意保持独立：
//
//	来源程序（refapp / wasiprobe / stdprobe / sockprobe）决定白名单**生成**成什么；
//	本程序是一份**独立的判据**，决定"白名单够不够用"。
//
// 它固定表达"TinyGo 用户写的一份纯标准库代码"在导入面上的形状：TinyGo 运行时的
// `net/url` 路径会带出 `sock_recv` / `sock_send`（Go 运行时不会）。缺这两条时：
// 同一份只用标准库的 Go 源码，用 TinyGo 编译就 `IMPORT_NOT_ALLOWED`、用 Go 编译却能过 ——
// 而内存实测 TinyGo 产物常驻只有 Go 的约 1/4，是平台"轻量化"的主要路径。
//
// 两条符号的能力论证：它们都需要一个**已连接**的 socket 描述符，而 preview1 里
// 没有 sock_open/bind/listen/connect（平台白名单也拒这四条），运行时又零 preopen
// ⇒ 描述符根本造不出来 ⇒ 放行"能写出调用"不等于"能连出去"。
//
// 构建：GOOS=wasip1 GOARCH=wasm go build ./internal/wasmapp/wasmmod/testdata/sockguest
// （由 wasmmod 的覆盖性门禁现场编译；本机原生跑也安全：只打印一行 stderr。）
package main

import (
	"fmt"
	"os"
)

// guarded 是不可达守卫（与 sockprobe 同手法）：条件永假但编译器证不出来，
// 所以分支内的调用进产物（导入被保留下），真跑时不会执行。
func guarded() bool { return len(os.Args) > 1<<20 }

func main() {
	if guarded() {
		probeSockets()
	}
	fmt.Fprintln(os.Stderr, "sockguest: 只用于导入面门禁，不参与平台运行")
}
