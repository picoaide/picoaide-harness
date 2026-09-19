// Command wasm-app-headers-gen 生成**跨端请求头白名单**的机器可读产物。
//
// 用法：
//
//	go generate ./internal/wasmapp/api        # 写文件（正常路径）
//	go run ./cmd/wasm-app-headers-gen -check  # 比对模式（CI/门禁用；不一致即非零退出）
//
// 产物与消费方：
//
//	server/internal/wasmapp/api/wasm-app-headers.json  ← 客户端（L2）对拍用
//
// 为什么产物必须**入库**（而不是运行时生成）：客户端与平台是两个仓库内的两个包，
// 对拍只能拿一份**静态快照**（客户端测试读它、断言"我转发的集合 == 它"）。
// 而"快照会不会过期"由本生成器的 -check 模式 + `headerspec_gen_test.go` 守住：
// 改了真源不重跑生成器 ⇒ 测试红。
//
// 为什么生成器住在 cmd/（而不是 api 包内）：`api` 包是服务端二进制的一部分，
// 往里塞一个写文件的 main 会污染生产依赖；`cmd/` 是仓库既有惯例
// （cmd/picoaide-limits-gen / picoaide-wasm-imports-gen 同款）。
package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/picoaide/picoaide/internal/wasmapp/api"
)

// modulePath 用于确认"向上找到的确实是本仓的 server/"。
const modulePath = "github.com/picoaide/picoaide"

// headersJSONRelPath 是生成物相对**模块根**（server/）的路径。
//
// 放在 api 包目录内（而不是 server/ 根）：它与 headerspec.go 是同一份契约的两种形态，
// 放在一起能让"改了真源却忘了生成物"在 code review 里一眼可见。
const headersJSONRelPath = "internal/wasmapp/api/wasm-app-headers.json"

func main() {
	check := flag.Bool("check", false, "比对模式：不写文件，生成结果与磁盘内容不一致时以非零退出")
	root := flag.String("root", "", "模块根（含 go.mod 的 server/ 目录）；缺省自动向上查找")
	flag.Parse()

	if err := run(*check, *root); err != nil {
		fmt.Fprintf(os.Stderr, "wasm-app-headers-gen: %v\n", err)
		os.Exit(1)
	}
}

func run(check bool, rootFlag string) error {
	moduleRoot, err := resolveModuleRoot(rootFlag)
	if err != nil {
		return err
	}
	path := filepath.Join(moduleRoot, filepath.FromSlash(headersJSONRelPath))
	want := api.RenderHeadersJSON()

	if check {
		got, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("读取 %s: %w", headersJSONRelPath, err)
		}
		if !bytes.Equal(got, want) {
			return fmt.Errorf("%s 与真源不一致（改了 headerspec.go 就要重跑 `go generate ./internal/wasmapp/api`）", headersJSONRelPath)
		}
		fmt.Printf("wasm-app-headers.json 与真源一致（%d 字节）\n", len(want))
		return nil
	}
	if err := os.WriteFile(path, want, 0o644); err != nil {
		return fmt.Errorf("写入 %s: %w", headersJSONRelPath, err)
	}
	fmt.Printf("已写入 %s（%d 字节）\n", headersJSONRelPath, len(want))
	return nil
}

// resolveModuleRoot 从工作目录向上找到本仓 server/ 的模块根。
func resolveModuleRoot(rootFlag string) (string, error) {
	if rootFlag != "" {
		return rootFlag, nil
	}
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		body, err := os.ReadFile(filepath.Join(dir, "go.mod"))
		if err == nil {
			for _, line := range bytes.Split(body, []byte("\n")) {
				if string(bytes.TrimSpace(line)) == "module "+modulePath {
					return dir, nil
				}
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("向上找不到 %s 的模块根（请用 -root 指定 server/ 目录）", modulePath)
		}
		dir = parent
	}
}
