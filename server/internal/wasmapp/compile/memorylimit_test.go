package compile

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是 **R1-rt-7b** 的护栏：编译子进程必须按**生效的** instance_memory_mb 跑（双向）。
//
// 缺陷现场（两条都在真机上实测过）：
//
//	调小（16 MiB）：发布期编译按硬编码的 64 MiB 放行 ⇒ 首个请求在 16 MiB 下跑不起来
//	               （HTTP 500，还被报成"平台故障"，把作者指向错误方向）；
//	调大（128 MiB）：模块声明 100 MiB 初始内存 ⇒ 被子进程按 64 MiB 误拒（SECTION_MALFORMED），
//	               连错误文案里的数字都是过期的 64 MiB ⇒ 应用**永远发不出去**。
//
// 为什么用**手写 wasm** 而不是 Go guest 做判据：判据是"wazero 按生效页数校验模块**声明**的
// 线性内存"，需要一个**确定**的声明值。Go/Rust 产物的声明随工具链版本漂移（Go 的常驻堆
// 还另算），拿它当判据会变成"测工具链"。257 页 = Zig 工具链默认初始内存（16.06 MiB，
// 见 applimits 的 MinInstanceMemoryMB 注释），1600 页 = 100 MiB。
//
// 变异验证（实测：改回缺陷实现时哪条必红）：
//   - 把 `WithMemoryLimitPages(memoryPages)` 改回 `WithMemoryLimitPages(limits.InstanceMemoryPages)`
//     （或让 CompileChildEnv 不注入）⇒ 上调方向的"128 MiB 必须能编译"与下调方向的
//     "16 MiB 必须拒"两条同时红；
//   - 把 CompileChildEnv 的 append 去掉 ⇒ 同上红（子进程只认编译期默认）。

// declaredMemoryModule 构造一个只声明线性内存上限的最小模块（导出面满足
// limits.RequiredExports：_start + memory），min = minPages 页、无 max。
//
// 形状与 runtime 包的 rawModule 同源（那边是执行侧的手写夹具）：手写而非依赖语言工具链，
// 是为了让"声明了多少页"成为测试自己写死的数。
func declaredMemoryModule(minPages uint32) []byte {
	var b []byte
	b = append(b, 0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00)
	b = append(b, wasmSection(1, []byte{0x01, 0x60, 0x00, 0x00})...)                // type: (func)
	b = append(b, wasmSection(3, []byte{0x01, 0x00})...)                            // function: 1 × type0
	b = append(b, wasmSection(5, append([]byte{0x01, 0x00}, uleb(minPages)...))...) // memory: min
	exp := []byte{0x02, 0x06}
	exp = append(exp, "_start"...)
	exp = append(exp, 0x00, 0x00, 0x06)
	exp = append(exp, "memory"...)
	exp = append(exp, 0x02, 0x00)
	b = append(b, wasmSection(7, exp)...)
	full := append([]byte{0x00}, 0x0b) // 0 个局部变量 + end
	code := []byte{0x01}
	code = append(code, uleb(uint32(len(full)))...)
	code = append(code, full...)
	return append(b, wasmSection(10, code)...)
}

func wasmSection(id byte, content []byte) []byte {
	out := []byte{id}
	out = append(out, uleb(uint32(len(content)))...)
	return append(out, content...)
}

func uleb(v uint32) []byte {
	var out []byte
	for {
		c := byte(v & 0x7f)
		v >>= 7
		if v != 0 {
			c |= 0x80
		}
		out = append(out, c)
		if v == 0 {
			return out
		}
	}
}

// compileErrorText 汇总一条编译失败的**作者可见面**（message + details + hints）。
//
// ③"错误文案里的数字必须与生效值一致"必须对整个可见面断言：只钉 message 会漏掉
// details["error"]（wazero 的原文就在那里），只钉 details 会漏掉提示。
func compileErrorText(err error) string {
	e, ok := apperr.As(err)
	if !ok {
		if err == nil {
			return ""
		}
		return err.Error()
	}
	var sb strings.Builder
	sb.WriteString(e.Message)
	for k, v := range e.Details {
		fmt.Fprintf(&sb, " | %s=%v", k, v)
	}
	for _, h := range e.Hints {
		sb.WriteString(" | " + h)
	}
	return sb.String()
}

// TestCompileChildEffectiveMemoryPagesUpDirection：**调大**方向（128 MiB > 档位 64 MiB）。
//
// 判据：声明 100 MiB 的模块在生效上限 128 MiB 下必须编译通过 —— 这正是"发布期误拒"的现场；
// 反向对照（同一模块在上限 64 MiB 下必须被拒）证明本用例真的在测上限，而不是"模块恰好合法"。
func TestCompileChildEffectiveMemoryPagesUpDirection(t *testing.T) {
	child := buildCompileChildOnce(t)
	// 100 MiB：大于 64 MiB（编译期默认/档位），小于 128 MiB（生效值）。
	mod := writeModule(t, t.TempDir(), "declared-100mib.wasm", declaredMemoryModule(1600))
	ctx := context.Background()

	const pages128 = uint32(2048) // 128 MiB / 64 KiB
	c128 := newTestCompiler(t, child, func(o *Options) { o.MemoryPages = pages128 })
	if _, err := c128.Compile(ctx, mod); err != nil {
		t.Fatalf("instance_memory_mb=128 MiB 时，声明 100 MiB 的模块必须能编译"+
			"（否则应用永远发不出去，R1-rt-7b 的上调方向）：%s", compileErrorText(err))
	}

	// 反向对照：同一模块在上限 64 MiB（= 改回硬编码时的取值）下必须被拒。
	c64 := newTestCompiler(t, child, func(o *Options) { o.MemoryPages = limits.InstanceMemoryPages })
	_, err := c64.Compile(ctx, mod)
	if err == nil {
		t.Fatal("上限 64 MiB 下声明 100 MiB 的模块必须被拒 —— 本用例的判据失效（模块声明没生效？）")
	}
	if text := compileErrorText(err); !strings.Contains(text, "64 Mi") {
		t.Fatalf("64 MiB 上限下的错误文案应写 64 Mi，得到 %s", text)
	}
}

// TestCompileChildEffectiveMemoryPagesDownDirection：**调小**方向（16 MiB < 档位 64 MiB）。
//
// 判据：声明 257 页（Zig 默认初始内存 16.06 MiB）的模块在生效上限 16 MiB 下必须在**发布期**
// 就被拒（而不是"发布放行、首个请求 500"）；同一模块在 64 MiB 下必须通过。
//
// ③ 文案同源：拒绝文案里的数字必须是生效的 16 MiB，且不得残留过期的 64 MiB。
func TestCompileChildEffectiveMemoryPagesDownDirection(t *testing.T) {
	child := buildCompileChildOnce(t)
	const zigDefaultPages = 257 // 16.06 MiB：Zig 工具链的默认初始内存
	mod := writeModule(t, t.TempDir(), "declared-16mib.wasm", declaredMemoryModule(zigDefaultPages))
	ctx := context.Background()

	c16 := newTestCompiler(t, child, func(o *Options) { o.MemoryPages = 256 }) // 16 MiB
	_, err := c16.Compile(ctx, mod)
	if err == nil {
		t.Fatalf("instance_memory_mb=16 MiB 时，声明 %d 页（16.06 MiB）的模块必须在发布期被拒"+
			"（否则发布放行、首个请求 500，R1-rt-7b 的下调方向）", zigDefaultPages)
	}
	text := compileErrorText(err)
	if !strings.Contains(text, "16 Mi") {
		t.Fatalf("拒绝文案必须写**生效**上限 16 MiB，得到 %s", text)
	}
	if strings.Contains(text, "64 Mi") {
		t.Fatalf("拒绝文案不得残留编译期默认 64 MiB（③ 文案与生效值同源），得到 %s", text)
	}

	// 反向对照：同一模块在上限 64 MiB 下必须能编译（证明被拒的原因就是生效上限）。
	c64 := newTestCompiler(t, child, func(o *Options) { o.MemoryPages = limits.InstanceMemoryPages })
	if _, err := c64.Compile(ctx, mod); err != nil {
		t.Fatalf("同一模块在上限 64 MiB 下必须能编译（说明下调方向的拒绝来自生效上限）：%s", compileErrorText(err))
	}
}

// TestCompileChildEnvCarriesEffectiveMemoryPages：子进程环境里必须带生效页数，且父环境的
// **同名冒充值**不得生效（env 白名单是安全边界，不能因为要传这个参数就开个口子）。
func TestCompileChildEnvCarriesEffectiveMemoryPages(t *testing.T) {
	const spoof = "PICOAI_COMPILE_MEMORY_PAGES=9999"
	parent := []string{"PATH=/usr/bin", spoof, "PG_DSN=postgres://secret"}

	env := CompileChildEnv(parent, 2048)
	if got := envValue(env, CompilerMemoryPagesEnvVar); got != "2048" {
		t.Fatalf("子进程环境里 %s=%q，期望 %q（生效值必须由父侧注入）",
			CompilerMemoryPagesEnvVar, got, "2048")
	}
	if n := countKey(env, CompilerMemoryPagesEnvVar); n != 1 {
		t.Fatalf("%s 应恰好出现 1 次（父环境冒充值必须被白名单滤掉 + 平台值注入），实际 %d 次：%v",
			CompilerMemoryPagesEnvVar, n, env)
	}
	if strings.Contains(strings.Join(env, "\n"), "secret") {
		t.Fatalf("白名单不得因为新增注入而放松（PG_DSN 泄进子进程）：%v", env)
	}

	// 未注入（0）⇒ 编译期默认：调用方没解析出生效值时的回落语义。
	if got := envValue(CompileChildEnv(nil, 0), CompilerMemoryPagesEnvVar); got == "" {
		t.Fatal("页数 0 也必须显式写默认值（子进程只有一条读取路径，不靠「未设置」分支）")
	}
}

// TestCompilerMemoryPagesFromProcess：子进程侧的读取判据（env → 页数）。
//
// 缺失/非法都必须回落编译期默认（fallback 而不是 panic：wazero 对 >65536 直接 panic）。
func TestCompilerMemoryPagesFromProcess(t *testing.T) {
	cases := []struct {
		raw  string
		want uint32
	}{
		{"", limits.InstanceMemoryPages},           // 未设置（go test / 手工 -request）
		{"2048", 2048},                             // 生效值
		{" 256 ", 256},                             // 容忍空白
		{"0", limits.InstanceMemoryPages},          // 0 非法
		{"abc", limits.InstanceMemoryPages},        // 非数字
		{"65537", limits.InstanceMemoryPages},      // 超过 wazero 硬上限（否则 WithMemoryLimitPages panic）
		{"4294967296", limits.InstanceMemoryPages}, // 溢出 uint32
	}
	for _, tc := range cases {
		t.Setenv(CompilerMemoryPagesEnvVar, tc.raw)
		if got := compilerMemoryPagesFromProcess(); got != tc.want {
			t.Errorf("%s=%q ⇒ %d，期望 %d", CompilerMemoryPagesEnvVar, tc.raw, got, tc.want)
		}
	}
}

// TestNewCompilerDefaultsToCompileTimePages：未注入（最小装配/单测）时回落编译期默认，
// 与 runtime.New 的 MemoryPages=0 分支同语义。
func TestNewCompilerDefaultsToCompileTimePages(t *testing.T) {
	c := newTestCompiler(t, buildCompileChildOnce(t), nil)
	if c.opt.MemoryPages != limits.InstanceMemoryPages {
		t.Fatalf("未注入时的生效页数 = %d，期望编译期默认 %d", c.opt.MemoryPages, limits.InstanceMemoryPages)
	}
}

func envValue(env []string, key string) string {
	for _, kv := range env {
		if eq := strings.IndexByte(kv, '='); eq > 0 && kv[:eq] == key {
			return kv[eq+1:]
		}
	}
	return ""
}

func countKey(env []string, key string) int {
	n := 0
	for _, kv := range env {
		if eq := strings.IndexByte(kv, '='); eq > 0 && kv[:eq] == key {
			n++
		}
	}
	return n
}
