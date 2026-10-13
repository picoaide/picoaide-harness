//go:build !apps

package router

// 本文件是 `apps` 模块**关闭**时的接线（P1 第二片，2026-10-14）。
//
// 关闭态不是"传 nil handler"：`WasmAPI` 变成一个**空类型**，于是
// `registerWasm` 里那些 `d.Wasm.Validate` 之类的引用根本编不出来，WASM 路由
// 整片在编译期就不存在。gin 只断言 `len(handlers) > 0`，传 nil 会照常注册并在
// 请求期 panic→500（既不是 404，也躲开路由声明表的视线）—— 本形态从根上排除了它。
//
// 为什么还需要"提前 return"：`registerWasm` 保留与打开态**同名同签名**的空实现，
// 调用点（`Register`）因此不需要任何 build tag —— 一处装配代码在六种组合下都成立。

import "github.com/gin-gonic/gin"

// WasmAPI 在 apps 关闭时是空类型：`Deps.Wasm` 仍然存在（字段名是装配契约的一部分），
// 但它没有方法，任何试图把 handler 挂到 gin 上的代码都编不过。
type WasmAPI struct{}

// registerWasm 在 apps 关闭时是编译期 no-op（提前 return 的**编译期**形态）。
func registerWasm(_ *gin.Engine, _ Deps) {}

// publishWasmReservedAppIDs 在 apps 关闭时无事可做：注册表里没有 `:app_id` 路由，
// 也就不存在"静态段遮蔽参数段"这回事。
func publishWasmReservedAppIDs(_ *gin.Engine) {}
