package api

// 生成物：`wasm-app-headers.json`（客户端 L2 对拍用）。
//
// 生成命令（唯一入口）：
//
//	go generate ./internal/wasmapp/api
//
// 它执行 cmd/wasm-app-headers-gen：把 HeadersSpec()（单一真源 = headerspec.go）
// 渲染成同目录下的 wasm-app-headers.json。**改了 headerspec.go 必须重跑它** ——
// 忘了重跑的后果由 headerspec_gen_test.go 的逐字节比对挡住（红）。
//
//go:generate go run ../../../cmd/wasm-app-headers-gen
