//go:build !wasip1

package main

// probeSockets 在非 wasm 平台上是空实现：`//go:wasmimport` 只在 wasm 构建里合法。
func probeSockets() {}
