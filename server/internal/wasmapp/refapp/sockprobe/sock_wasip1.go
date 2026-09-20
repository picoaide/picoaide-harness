//go:build wasip1

package main

import "unsafe"

// 两条符号的签名取自 **canonical WASI preview1 ABI**（与 wazero 的宿主实现逐字对齐：
// `imports/wasi_snapshot_preview1/sock.go` 的 sockRecv 是 6×i32→i32、sockSend 是 5×i32→i32）。
//
// ⚠️ 签名必须与 TinyGo 运行时实际发出的**一致**：平台的白名单校验比对"符号 + 类型"
// （`IMPORT_SIGNATURE_MISMATCH`），签名写错等于白名单里有名字却仍然拒真产物。
// 这里用 uintptr 表示指针参数（wasm32 上映射为 i32），与 Go 对 wasmimport 的参数映射一致。
//
//go:wasmimport wasi_snapshot_preview1 sock_recv
//go:noescape
func sockRecv(fd int32, riData uintptr, riDataLen uint32, riFlags uint32, roDataLen uintptr, roFlags uintptr) int32

//go:wasmimport wasi_snapshot_preview1 sock_send
//go:noescape
func sockSend(fd int32, siData uintptr, siDataLen uint32, siFlags uint32, soDataLen uintptr) int32

// probeSockets 只在不可达分支里被调用（见 main.guarded）：目的是让两条导入进产物。
//
// 真跑时的行为无关紧要（永远不会跑到）：即使跑到，fd=0 也只会拿到 EBADF。
func probeSockets() {
	var roDataLen, roFlags int32
	_ = sockRecv(0, 0, 0, 0, uintptr(unsafe.Pointer(&roDataLen)), uintptr(unsafe.Pointer(&roFlags)))
	var soDataLen int32
	_ = sockSend(0, 0, 0, 0, uintptr(unsafe.Pointer(&soDataLen)))
}
