package runtime

import (
	"context"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/compile/testdata/wasmtest"
)

// 本文件是 P0-4 的**运行时侧判据**：DataCount 段必须能过平台自己的 wazero 编译。
//
// 为什么这条判据必须存在（2026-09-21 审计，D 路用真服务端实测）：
//   - 平台预检曾只接受"段 id 纯升序"，而 wazero **只接受 DataCount 的规范位置**
//     （Element 之后、Code 之前，见 wazero@v1.12.0 internal/wasm/binary/decoder.go:190-204）；
//   - 于是带 DataCount 的产物（TinyGo 默认、启用 bulk-memory 的 LLVM/Rust/Zig 配置）
//     无论怎么摆都被一端拒 ⇒ **100% 发不出去**，且没有可利用的绕法。
//
// 这条用例钉的是"运行时真的能编译它"——只断言预检返回 nil 是不够的（那正是修复前
// 自我感觉良好的状态：预检放行、真编译报 `invalid section order`）。
//
// 变异验证：把 wasmmod 的 DataCount 特例删掉 ⇒ 本用例仍会通过（运行时直接编译不过
// 预检）；把 wazero 换成"接受任意顺序"的假实现 ⇒ 用例失去意义。因此与之配套的
// 静态侧用例（compile/staticvalidate_test.go 与 wasmmod/wasmmod_test.go）必须同时在位：
// 一条管"预检接受规范位置"，一条管"运行时真能编译"，两条缺一不可。
func TestCompileAcceptsDataCountInCanonicalPosition(t *testing.T) {
	rt, err := New(context.Background(), Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = rt.Close(context.Background()) })

	mod, cerr := rt.CompileModule(context.Background(), wasmtest.WithDataCount())
	if cerr != nil {
		t.Fatalf("带 DataCount（规范位置）的模块必须能编译，实际失败：%v", cerr)
	}
	if mod == nil {
		t.Fatal("编译返回 nil 模块")
	}
	if err := mod.Close(context.Background()); err != nil {
		t.Fatalf("关闭编译模块失败: %v", err)
	}
}

// TestCompileRejectsDataCountAfterCode 证明"错位摆放"确实过不了运行时 ——
// 也就是修复前的"纯 id 升序"姿势为什么不是出路。它同时是上面那条用例的**反向对照**：
// 没有它，"编译成功"可能只是因为 wazero 对顺序根本不敏感。
func TestCompileRejectsDataCountAfterCode(t *testing.T) {
	rt, err := New(context.Background(), Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = rt.Close(context.Background()) })

	if _, cerr := rt.CompileModule(context.Background(), wasmtest.WithDataCountMisordered()); cerr == nil {
		t.Fatal("DataCount 摆在 Code 之后必须被运行时拒绝（否则这条判据失去意义）")
	}
}
