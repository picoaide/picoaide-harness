package runtime

import (
	"errors"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是审计 R1-rt-7 第二半的护栏：**错误文案里的单实例内存上限必须是生效值**。
//
// 现场：runtime/errors.go 的三处文案硬写 64 MiB（`limits.InstanceMemoryPages`），
// 而控制台把 instance_memory_mb 改成 128 MiB 后，应用作者会被"上限 64 MiB"误导 ——
// 他按 64 MiB 去优化，真实上限却是 128 MiB（反之亦然）。文案与生效值必须同源。
//
// 变异验证（实测：改回缺陷实现时哪条必红）：把三处 `effectivePages(f.memoryPages)` /
// `effectivePages(memoryPages)` 改回 `limits.InstanceMemoryPages` ⇒ 本文件的三条断言必红。

// TestClassifyGuestErrorMemoryTextUsesEffectiveLimit：guest 侧内存错误（错误串命中
// memoryErrorPatterns，例如 Go 运行时 "fatal error: out of memory"）。
func TestClassifyGuestErrorMemoryTextUsesEffectiveLimit(t *testing.T) {
	const pages128 = uint32(2048) // 128 MiB / 64 KiB
	got := classifyGuestError(errors.New("runtime: out of memory"), failureContext{memoryPages: pages128})
	if got.Code != apperr.CodeRuntimeMemory {
		t.Fatalf("应映射成 RUNTIME_MEMORY，得到 %s：%s", got.Code, got.Message)
	}
	if !strings.Contains(got.Message, "128 MiB") {
		t.Fatalf("文案必须写生效上限 128 MiB，得到 %q", got.Message)
	}
	hints := strings.Join(got.Hints, " | ")
	if !strings.Contains(hints, "128 MiB") {
		t.Fatalf("提示也必须写生效上限 128 MiB（排障第一现场），得到 %q", hints)
	}
	if strings.Contains(got.Message+hints, "64 MiB") {
		t.Fatalf("不得残留编译期默认值（64 MiB）：%s / %s", got.Message, hints)
	}

	// 未指定生效值（0）⇒ 回落编译期默认，文案仍须是**真的**（= limits 的 64 MiB）。
	def := classifyGuestError(errors.New("out of memory"), failureContext{})
	if !strings.Contains(def.Message, "64 MiB") {
		t.Fatalf("未指定时文案应写编译期默认 64 MiB，得到 %q", def.Message)
	}
	if want := int(limits.InstanceMemoryPages) * limits.WasmPageSize >> 20; want != 64 {
		t.Fatalf("测试前提失效：编译期默认不再是 64 MiB（%d MiB）", want)
	}
}

// TestClassifyInstantiateErrorTextUsesEffectiveLimit：实例化期"线性内存声明超过平台上限"。
func TestClassifyInstantiateErrorTextUsesEffectiveLimit(t *testing.T) {
	const pages128 = uint32(2048)
	got := classifyInstantiateError(errors.New("section memory: min 4096 pages (256 Mi) over limit of 2048 pages (128 Mi)"), pages128)
	if got.Code != apperr.CodeRuntimeMemory {
		t.Fatalf("应映射成 RUNTIME_MEMORY，得到 %s：%s", got.Code, got.Message)
	}
	if !strings.Contains(got.Message, "128 MiB") {
		t.Fatalf("文案必须写生效上限 128 MiB，得到 %q", got.Message)
	}
	if strings.Contains(strings.Join(got.Hints, " | "), "64 MiB") {
		t.Fatalf("提示不得残留 64 MiB：%q", got.Hints)
	}
	// 签名不匹配这条与内存无关，不受 pages 影响（防止改错分支）。
	other := classifyInstantiateError(errors.New("signature mismatch: fd_write"), pages128)
	if other.Code != apperr.CodeImportSignatureMismatch {
		t.Fatalf("签名不匹配必须仍走 IMPORT_SIGNATURE_MISMATCH，得到 %s", other.Code)
	}
}

// TestRuntimeErrorTextFollowsConfiguredPages 是**装配级**判据：真的用 128 MiB 建运行时，
// 再看它给出的错误文案 —— 防止"只改了函数参数、装配处没把 r.memoryPages 传下去"。
func TestRuntimeErrorTextFollowsConfiguredPages(t *testing.T) {
	rt, err := New(t.Context(), Options{MemoryPages: 2048})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = rt.Close(t.Context()) }()
	if rt.memoryPages != 2048 {
		t.Fatalf("运行时页数 = %d，期望 2048", rt.memoryPages)
	}
	// 直接走 classify 的输入来源：Serve 里构造 failureContext 时用的就是 r.memoryPages。
	f := failureContext{memoryPages: rt.memoryPages}
	e := classifyGuestError(errors.New("cannot allocate memory"), f)
	if !strings.Contains(e.Message, "128 MiB") {
		t.Fatalf("128 MiB 运行时的错误文案必须写 128 MiB，得到 %q", e.Message)
	}
}
