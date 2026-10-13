//go:build !apps

package main

// 本文件是 `apps` **未编入**本变体时的同名声明表（见 routes_source_wasm_gated_test.go）。
//
// 为空是**正确**的：关闭 apps 时 `/api/client/v2/apps/wasm/*` 与
// `/api/server/admin/wasm-apps/*` 两片路由在编译期就不存在（router 侧的 no-op），
// 没有任何路由会被 `d.Wasm == nil` 门控。判据会反向断言这张表确实为空 ——
// 免得"把表清空"变成让守卫变绿的手法。

// wasmGatedRoutes：apps 未编入 ⇒ 一条都没有。
var wasmGatedRoutes = []string{}
