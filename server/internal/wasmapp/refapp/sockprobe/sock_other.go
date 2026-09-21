//go:build !wasip1

package main

// probeSockets 在非 wasm 平台上是空实现：`//go:wasmimport` 指令只在 wasm 构建里合法，
// 因此声明必须被构建约束挡住，否则本机 `go build ./...` / `go vet ./...` 会直接失败。
// 这个空实现保证本包在任何平台都是"可编译但不做任何事"的普通包。
func probeSockets() {}
