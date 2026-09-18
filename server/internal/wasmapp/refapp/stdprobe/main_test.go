package main

import (
	"strings"
	"testing"
)

// 本文件保证探测程序"真的是代码"而不是被优化掉的死路径 ——
// 如果 stdprobe 退化成空壳，白名单会**静默变窄**（又回到"用了模板渲染就被拒"的 P0 缺陷），
// 而那种退化在"能编译"这一点上看不出来。
//
// 变异验证（§5.5）：
//   - 把 guarded() 改成 return true            → 进程会以 exit 3 直接死掉（os.Exit 探测真的执行）；
//   - 删掉 renderPage 的 Execute 调用（或让它返回空串） → TestStdpobeTemplateRenderIsReal 红；
//   - 删掉 ReadAt/WriteAt 段                    → TestStdpobeRunsNatively 红；
//   - 删掉任何一组 std 面探测                    → 同上（probeStdSurface 会返回错误）。
//
// 导入面本身由 wasmmod 的门禁覆盖（imports_gen_test.go 的并集比对 +
// imports_coverage_test.go 的独立覆盖性门禁），这里守住"本机真的执行成功"。

func TestGuardedReturnsFalse(t *testing.T) {
	// guarded() 是"不可达守卫"：必须永假，否则 os.Exit / os.Stdin.Read 的探测会真的执行。
	if guarded() {
		t.Fatalf("guarded() 必须为假（它只是为了让链接器保留调用，见包注释）")
	}
}

func TestStdpobeRunsNatively(t *testing.T) {
	dir := t.TempDir()

	page, text, err := renderPage("native", []string{"a", "b", "c"})
	if err != nil {
		t.Fatalf("renderPage: %v", err)
	}
	if !strings.Contains(page, "<h1>native</h1>") || !strings.Contains(page, "<li>a</li>") {
		t.Fatalf("html/template 渲染结果不对（Execute 退化了？）: %q", page)
	}
	if !strings.Contains(text, "n=3") {
		t.Fatalf("text/template 渲染结果不对（Execute 退化了？）: %q", text)
	}

	if err := probeReadAtWriteAt(dir); err != nil {
		t.Fatalf("ReadAt/WriteAt 探测失败: %v", err)
	}
	if err := probeStdSurface(dir); err != nil {
		t.Fatalf("std 面探测失败: %v", err)
	}
	// guarded() 为假 ⇒ 什么都不做（真跑时不会 exit / 阻塞）。
	if err := probeGuarded(); err != nil {
		t.Fatalf("probeGuarded 在守卫为假时不应做任何事: %v", err)
	}
}

// TestStdpobeTemplateRenderIsReal 是上一条的**反向对照**：模板渲染必须真的把数据渲染进去。
// 少了它，"Execute 被删掉但函数还在（返回空串）"的退化只会被弱断言放过。
func TestStdpobeTemplateRenderIsReal(t *testing.T) {
	one, _, err := renderPage("u1", nil)
	if err != nil {
		t.Fatalf("renderPage: %v", err)
	}
	many, _, err := renderPage("u1", []string{"x"})
	if err != nil {
		t.Fatalf("renderPage: %v", err)
	}
	if one == many {
		t.Fatalf("列表为空与非空的渲染结果不该相同（模板逻辑没生效）: %q", one)
	}
	if !strings.Contains(one, "u1") || !strings.Contains(many, "x") {
		t.Fatalf("渲染结果里应含传入的数据: one=%q many=%q", one, many)
	}
}
