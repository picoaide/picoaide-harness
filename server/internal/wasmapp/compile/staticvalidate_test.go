package compile

import (
	"context"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/compile/testdata/wasmtest"
	"github.com/picoaide/picoaide/internal/wasmapp/wasmmod"
)

// 本文件覆盖**静态校验**（compile 侧对 wasmmod 的接线）。
//
// 2026-09-18 切换说明：compile 的静态校验已从"本包的最小解析器"切换为 wasmmod
// （模块 A 的权威实现，导入白名单由参考实现构建期生成）。因此本文件的断言口径
// 也随之改变 —— 尤其是错误码：
//
//	导出面不达标      : 之前是本包自造的 SECTION_MALFORMED → 现在 **VALIDATE_FAILED**
//	                    （§7.4 表里"应用契约不满足"的码，wasmmod 的判据）
//	自定义段超限      : 之前 SECTION_OVERSIZE → 现在 **SECTION_OVERRIDE_OVERSIZE**
//	                    （§7.4 失败语义表的用名；§4.2 表格写作 SECTION_OVERSIZE，
//	                     设计文档内部不一致，wasmmod 按 §7.4 实现并在其注释里认账）
//	未知导入符号      : 之前**放行**（最小解析器的白名单表为空）→ 现在 **IMPORT_NOT_ALLOWED**
//	                    （这是切换带来的最实质的能力提升：sock_open / path_open 之类
//	                     的 WASI 调用不再能溜进编译）
//
// 变异方式（每个用例对应一条可去掉的判据）：
//   - 去掉魔数/版本校验 ⇒ TestValidateRejectsBadHeader 红；
//   - 去掉段边界检查   ⇒ TestValidateRejectsTruncatedSection 红；
//   - 去掉层字段判定   ⇒ TestValidateRejectsComponentModel 红；
//   - 去掉导入白名单   ⇒ TestValidateRejectsUnknownImportSymbol 红；
//   - 去掉签名比对     ⇒ TestValidateRejectsImportSignatureMismatch 红；
//   - 去掉导出面校验   ⇒ TestValidateRejectsMissingStart 红。

func mustCode(t *testing.T, err error, want apperr.Code) *apperr.Error {
	t.Helper()
	if err == nil {
		t.Fatalf("期望错误 %s，实际成功", want)
	}
	e, ok := apperr.As(err)
	if !ok {
		t.Fatalf("期望 *apperr.Error，实际 %T: %v", err, err)
	}
	if e.Code != want {
		t.Fatalf("期望错误码 %s，实际 %s（message=%q details=%v）", want, e.Code, e.Message, e.Details)
	}
	return e
}

func TestValidateAcceptsMinimalModule(t *testing.T) {
	rep, err := NewValidator().Validate(wasmtest.Base())
	if err != nil {
		t.Fatalf("最小模块应通过静态校验: %v", err)
	}
	if len(rep.Imports) != 2 {
		t.Fatalf("期望 2 条导入，实际 %d（%+v）", len(rep.Imports), rep.Imports)
	}
	for _, im := range rep.Imports {
		if im.Module != "wasi_snapshot_preview1" {
			t.Errorf("导入模块名不符: %+v", im)
		}
		if im.Kind != "func" || im.Signature == "" {
			t.Errorf("导入应带 kind=func 与签名: %+v", im)
		}
	}
	// 签名规范化格式 = wasmmod 的跨版本契约（§8 的 details.expected 用的就是它）。
	if got := rep.Imports[0].Signature; got != "i32i32i32i32_i32" {
		t.Errorf("签名规范化格式不符：%q（期望 i32i32i32i32_i32）", got)
	}
	var haveStart, haveMem bool
	for _, e := range rep.Exports {
		switch e.Name {
		case "_start":
			haveStart = true
			if e.Kind != "func" {
				t.Errorf("_start 的种类应为 func：%+v", e)
			}
		case "memory":
			haveMem = true
			if e.Kind != "memory" {
				t.Errorf("memory 的种类应为 memory：%+v", e)
			}
		}
	}
	if !haveStart || !haveMem {
		t.Fatalf("导出面应含 _start 与 memory：%+v", rep.Exports)
	}
	if len(rep.SectionNames) == 0 {
		t.Error("应记录段名（诊断用）")
	}
}

// TestValidateUsesGeneratedWhitelistAndCoversFdRead 是**切换的验收**：
// 白名单是生成产物，必须含 ABI 读 stdin 依赖的 fd_read，且拒绝不在名单里的 WASI 符号。
func TestValidateUsesGeneratedWhitelistAndCoversFdRead(t *testing.T) {
	// 生成产物里必须有 fd_read（§4.2：ABI 读请求帧的硬依赖）。
	var haveFDRead bool
	for _, spec := range wasmmod.ImportWhitelist {
		if spec.Name == "fd_read" {
			haveFDRead = true
			if spec.Module != "wasi_snapshot_preview1" {
				t.Errorf("fd_read 的模块名不符：%+v", spec)
			}
		}
	}
	if !haveFDRead {
		t.Fatal("生成白名单里缺少 fd_read —— ABI 读 stdin 会被自己的校验器拒掉")
	}
	// 真实 Go 产物（含 fd_read）必须通过。
	if _, data := writeGuestModule(t, t.TempDir()); len(data) > 0 {
		rep, err := NewValidator().Validate(data)
		if err != nil {
			t.Fatalf("真实 Go wasip1 模块应通过：%v", err)
		}
		var found bool
		for _, im := range rep.Imports {
			if im.Name == "fd_read" {
				found = true
			}
		}
		if !found {
			t.Error("真实 Go 产物的导入面应含 fd_read")
		}
	}
}

func TestValidateRejectsBadHeader(t *testing.T) {
	_, err := NewValidator().Validate(wasmtest.CorruptMagic())
	mustCode(t, err, apperr.CodeSectionMalformed)

	_, err = NewValidator().Validate(wasmtest.Garbage(64))
	mustCode(t, err, apperr.CodeSectionMalformed)

	_, err = NewValidator().Validate([]byte{0x00, 0x61, 0x73})
	mustCode(t, err, apperr.CodeSectionMalformed)
}

func TestValidateRejectsTruncatedSection(t *testing.T) {
	_, err := NewValidator().Validate(wasmtest.TruncatedSection())
	mustCode(t, err, apperr.CodeSectionMalformed)
}

func TestValidateRejectsComponentModel(t *testing.T) {
	e := mustCode(t, mustErr(NewValidator().Validate(wasmtest.ComponentModel())), apperr.CodeComponentModelUnsupport)
	// 错误必须给可操作出路（第一消费者是 AI）。
	if len(e.Hints) == 0 {
		t.Error("组件模型被拒时必须带 hints（否则作者只知道'不支持'却不知道怎么办）")
	}
	if got, ok := e.Details["layer"]; !ok || got == nil {
		t.Errorf("details 应带 layer：%+v", e.Details)
	}
}

func TestValidateRejectsForeignImportModule(t *testing.T) {
	_, err := NewValidator().Validate(wasmtest.WithEnvImport())
	e := mustCode(t, err, apperr.CodeImportNotAllowed)
	if got, _ := e.Details["module"]; got != "env" {
		t.Errorf("details 应带被拒的模块名：%+v", e.Details)
	}
}

// TestValidateRejectsUnknownImportSymbol 锁住**切换带来的能力**：
// 最小解析器时代，白名单表为空 ⇒ 未知符号一律放行（sock_open 也能过）。
// 现在必须被 IMPORT_NOT_ALLOWED 拒。
func TestValidateRejectsUnknownImportSymbol(t *testing.T) {
	mod := wasmtest.WithImport("wasi_snapshot_preview1", "sock_open", wasmtest.Params(wasmtest.I32, wasmtest.I32), wasmtest.Params(wasmtest.I32))
	_, err := NewValidator().Validate(mod)
	e := mustCode(t, err, apperr.CodeImportNotAllowed)
	if got, _ := e.Details["symbol"]; got != "wasi_snapshot_preview1.sock_open" {
		t.Errorf("details 应点名符号：%+v", e.Details)
	}
}

func TestValidateRejectsImportedMemory(t *testing.T) {
	// 导入面只允许函数：导入 memory 会绕过平台的实例内存账（§4.3 内存四笔账）。
	_, err := NewValidator().Validate(wasmtest.WithImportedMemory())
	mustCode(t, err, apperr.CodeImportNotAllowed)
}

func TestValidateRejectsMissingStart(t *testing.T) {
	// 切换后：导出面不达标 → VALIDATE_FAILED（§7.4 的"应用契约不满足"），
	// 不再是 SECTION_MALFORMED（段表本身没问题）。
	e := mustCode(t, mustErr(NewValidator().Validate(wasmtest.WithoutStart())), apperr.CodeValidateFailed)
	if got, _ := e.Details["missing"]; got == nil {
		t.Errorf("details 应给出缺失的导出名：%+v", e.Details)
	}
	if len(e.Hints) == 0 {
		t.Error("导出面被拒应带 hints")
	}
}

func TestValidateRejectsOversizeModule(t *testing.T) {
	huge := make([]byte, MaxModuleBytes()+1)
	copy(huge, []byte{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00})
	_, err := NewValidator().Validate(huge)
	mustCode(t, err, apperr.CodeWasmTooLarge)
}

func TestValidateRejectsOversizeCustomSections(t *testing.T) {
	// §7.4 用名是 SECTION_OVERRIDE_OVERSIZE（§4.2 表格写作 SECTION_OVERSIZE，文档内部
	// 不一致；错误码唯一真源是 §7.4，wasmmod 的注释里有认账）。
	mod := wasmtest.BigCustom(int(SectionTotalMaxBytes()) + 1024)
	_, err := NewValidator().Validate(mod)
	e := mustCode(t, err, apperr.CodeSectionOverrideOversize)
	if got, _ := e.Details["custom_bytes"]; got == nil {
		t.Errorf("details 应给出实际自定义段字节数：%+v", e.Details)
	}
}

// TestValidateImportSignatureMismatch 锁住"符号在名单内但类型不符必须被拒"（§4.2）。
func TestValidateImportSignatureMismatch(t *testing.T) {
	// 夹具：fd_write 被声明为 (i32,i32)->i32（真实签名是 4 参数）。
	_, err := NewValidator().Validate(wasmtest.WithBadImportSignature())
	e := mustCode(t, err, apperr.CodeImportSignatureMismatch)
	if got, _ := e.Details["symbol"]; got != "wasi_snapshot_preview1.fd_write" {
		t.Errorf("details 应点名符号：%+v", e.Details)
	}
	// §8 的示例形状：expected/actual 都是"种类:签名"。
	for _, k := range []string{"expected", "actual"} {
		if _, ok := e.Details[k]; !ok {
			t.Errorf("details 缺少 %q（§8 的错误示例要求给出期望与实际）：%+v", k, e.Details)
		}
	}
	if got, _ := e.Details["actual"]; !strings.Contains(got.(string), "i32i32_i32") {
		t.Errorf("actual 应是错误签名：%+v", e.Details)
	}
}

func TestValidateWasmAndExtractCustomSections(t *testing.T) {
	// ValidateWasm 走的是同一条 wasmmod 路径（这里再包一层 Compiler 出口）。
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)

	if _, err := c.ValidateWasm(wasmtest.Base()); err != nil {
		t.Fatalf("ValidateWasm 应接受最小模块：%v", err)
	}
	_, err := c.ValidateWasm(wasmtest.WithEnvImport())
	if err == nil || err.Code != apperr.CodeImportNotAllowed {
		t.Fatalf("ValidateWasm 应拒绝 env 导入：%v", err)
	}

	mod := wasmtest.BigCustom(128)
	sections, serr := c.ExtractCustomSections(mod)
	if serr != nil {
		t.Fatalf("ExtractCustomSections: %v", serr)
	}
	if len(sections["assets"]) != 128 {
		t.Fatalf("assets 段抽取长度不符：%d", len(sections["assets"]))
	}
	// 抽取结果是**复制**：改它不该影响原模块（wasmmod 的契约）。
	sections["assets"][0] = 0xFF
	again, _ := c.ExtractCustomSections(mod)
	if again["assets"][0] == 0xFF {
		t.Error("ExtractCustomSections 应返回复制内容（改返回值不得影响源字节）")
	}
}

// TestStaticValidatorHookIsUsed 证明可注入点真的接了（否则"注入假校验器"只是摆设）。
func TestStaticValidatorHookIsUsed(t *testing.T) {
	orig := StaticValidatorHook
	defer func() { StaticValidatorHook = orig }()
	StaticValidatorHook = rejectingValidator{}

	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)
	_, err := c.ValidateWasm(wasmtest.Base())
	if err == nil {
		t.Fatal("注入的校验器应生效")
	}
	if err.Code != apperr.CodeDBDenied {
		t.Fatalf("应透传注入校验器的错误码，实际 %s", err.Code)
	}
}

// rejectingValidator 是一个恒拒的假校验器（验证注入点与错误透传）。
type rejectingValidator struct{}

func (rejectingValidator) Validate([]byte) (*Report, error) {
	return nil, apperr.New(apperr.CodeDBDenied, "injected rejection")
}

// mustErr 把 (result, error) 里的 error 取出来（让 mustCode 的调用更短）。
func mustErr[T any](_ T, err error) error { return err }

// TestDataCountSectionOrderContract 是 P0-4 的**发布链路判据**（预检 + 真编译子进程）。
//
// 修复前的死局（D 路 2026-09-21 用真服务端实测）：
//   - DataCount 放规范位置（Element 之后、Code 之前）⇒ 预检报 SECTION_MALFORMED；
//   - 改成段 id 升序（Code/Data 之后）⇒ 预检放行、**真编译器**回 `invalid section order`。
//
// 两条路都堵死 ⇒ 任何带 DataCount 的产物（TinyGo 默认、启用 bulk-memory 的
// LLVM/Rust/Zig 配置）100% 发不出去。
//
// 本用例三条断言缺一不可：
//
//	① 规范位置过预检（wasmmod 的段序判据与 wazero 同判）；
//	② 规范位置能**真编译**（子进程走 wazero —— 只断言 ① 会重演"预检放行、编译报错"）；
//	③ 错位摆放被**预检**拒（不能把错误留到编译期，否则失败形态是"用户等 30 秒拿一个
//	   看不懂的编译错误"，而不是一条带 hints 的 422）。
func TestDataCountSectionOrderContract(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)

	if _, err := c.ValidateWasm(wasmtest.WithDataCount()); err != nil {
		t.Fatalf("① 规范位置的 DataCount 必须过预检：%v", err)
	}

	dir := t.TempDir()
	mod := writeModule(t, dir, "datacount.wasm", wasmtest.WithDataCount())
	if _, err := c.Compile(context.Background(), mod); err != nil {
		t.Fatalf("② 带 DataCount（规范位置）的模块必须能真编译：%v", err)
	}

	_, err := c.ValidateWasm(wasmtest.WithDataCountMisordered())
	if err == nil {
		t.Fatal("③ DataCount 摆在 Code 之后必须被预检拒绝（否则会漏到编译期）")
	}
	if err.Code != apperr.CodeSectionMalformed {
		t.Fatalf("③ 错位 DataCount 的错误码应为 %s，实际 %s: %v", apperr.CodeSectionMalformed, err.Code, err)
	}
}
