// Command compilechild 是编译模块测试用的**故障注入子进程**。
//
// 它实现与 cmd/picoaide-app-compile 相同的父子协议（单行 JSON），但行为可控：
//
//	-sleep 2s     收到 compile 请求后先睡 2 s（模拟"编译太慢"⇒ 父侧超时杀进程）
//	-crash       收到 compile 请求后直接 os.Exit(9)（模拟 OOM 被杀）
//	-garbage     收到 compile 请求后输出一行非 JSON（模拟协议被破坏）
//	-badexit     收到 ping 后立刻退出 3（模拟"子进程二进制是别的东西/启动即崩"）
//
// 为什么不 mock 掉 exec 而是真起一个进程：本模块的验收要求是"子进程测试要真起进程"，
// 而超时/被杀/协议破坏这三类行为只有真的跨进程边界才成立（进程组、SIGKILL、
// 管道 EOF、退出码都不可 mock）。
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"
)

type request struct {
	Op         string `json:"op"`
	ModulePath string `json:"module_path"`
	CacheDir   string `json:"cache_dir"`
}

type response struct {
	OK          bool   `json:"ok"`
	Version     string `json:"version,omitempty"`
	Code        string `json:"code,omitempty"`
	Message     string `json:"message,omitempty"`
	CompileMS   int64  `json:"compile_ms,omitempty"`
	CustomBytes int64  `json:"custom_bytes,omitempty"`
	Imports     []any  `json:"imports,omitempty"`
	Exports     []any  `json:"exports,omitempty"`
}

func main() {
	var (
		sleep   = flag.Duration("sleep", 0, "编译请求的模拟耗时")
		crash   = flag.Bool("crash", false, "收到编译请求即退出 9")
		garbage = flag.Bool("garbage", false, "输出一行非 JSON")
		badexit = flag.Bool("badexit", false, "收到 ping 即退出 3")
	)
	// 兼容父侧传的 -listen / -timeout / -cache-dir（本程序忽略它们）。
	// ⚠️ 必须声明：Go 的 flag 包对**未定义**的参数直接报错退出，父侧一旦新增启动参数，
	// 这个假子进程就会在自检阶段死掉，让"故障注入"用例变成"启动失败"用例（踩过）。
	_ = flag.Bool("listen", false, "忽略")
	_ = flag.Duration("timeout", 0, "忽略")
	_ = flag.String("cache-dir", "", "忽略")
	_ = flag.String("marker", "", "忽略（残留检测用唯一标记）")
	flag.Parse()

	sc := bufio.NewScanner(os.Stdin)
	enc := json.NewEncoder(os.Stdout)
	for sc.Scan() {
		var req request
		if err := json.Unmarshal(sc.Bytes(), &req); err != nil {
			fmt.Fprintln(os.Stderr, "bad request")
			os.Exit(2)
		}
		switch req.Op {
		case "ping":
			if *badexit {
				os.Exit(3)
			}
			_ = enc.Encode(response{OK: true, Version: "picoaide-app-compile/1"})
		case "compile":
			if *crash {
				os.Exit(9)
			}
			if *garbage {
				fmt.Fprintln(os.Stdout, "this is not json")
				continue
			}
			if *sleep > 0 {
				time.Sleep(*sleep)
			}
			_ = enc.Encode(response{OK: true, CompileMS: 1, CustomBytes: 0})
		default:
			_ = enc.Encode(response{OK: false, Code: "INTERNAL", Message: "unsupported op"})
		}
	}
}
