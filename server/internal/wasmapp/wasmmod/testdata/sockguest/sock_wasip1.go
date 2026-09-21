//go:build wasip1

package main

import "unsafe"

// 签名 = canonical WASI preview1 ABI（与 wazero 宿主实现逐字对齐：sock_recv 6×i32→i32、
// sock_send 5×i32→i32），也就是 TinyGo 运行时实际发出的形状。
//
//go:wasmimport wasi_snapshot_preview1 sock_recv
//go:noescape
func sockRecv(fd int32, riData uintptr, riDataLen uint32, riFlags uint32, roDataLen uintptr, roFlags uintptr) int32

//go:wasmimport wasi_snapshot_preview1 sock_send
//go:noescape
func sockSend(fd int32, siData uintptr, siDataLen uint32, siFlags uint32, soDataLen uintptr) int32

func probeSockets() {
	var roDataLen, roFlags int32
	_ = sockRecv(0, 0, 0, 0, uintptr(unsafe.Pointer(&roDataLen)), uintptr(unsafe.Pointer(&roFlags)))
	var soDataLen int32
	_ = sockSend(0, 0, 0, 0, uintptr(unsafe.Pointer(&soDataLen)))
}
