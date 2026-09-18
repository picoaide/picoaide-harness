package runtime

// 手写 wasm 夹具（不依赖任何语言工具链）
// ====================================
//
// 为什么需要手写模块：Go/Rust 产物**做不出**确定性的 trap / 栈溢出（Go 的递归先吃光
// 线性内存 → Go 运行时 OOM → proc_exit(2)，见 TestServe_InfiniteRecursionHostSurvives
// 的实测注释）。要断言 §7.4 的 `RUNTIME_TRAP` 与"wasm 层栈溢出"，就得自己造字节。
//
// 二进制格式（WebAssembly core 1.0）：
//
//	魔数 "\0asm" + 版本 0x01 00 00 00 + 若干 section
//	section := id(1B) + size(uleb128) + content
//
// 本文件构造的模块形状（最小可运行 command 模块）：
//
//	1  type      : [ (func) ]                       // 0x60 0x00 0x00 = 无参无返回
//	3  function  : [ type=0 ]                       // 1 个定义函数，占函数索引 0
//	5  memory    : [ {min: N} ]                     // flags=0x00（只给 min）
//	7  export    : [ "_start" → func 0, "memory" → mem 0 ]
//	10 code      : [ body{ locals=0, <指令…>, 0x0b end } ]
//
// **为什么 `_start` 必须是 (func)→()**：WASI command 模块的 `_start` 由宿主按
// "无参无返回"调用，wazero 在**编译期**就按类型校验导出面 —— 只要函数体在栈上留了
// 一个值（例如 `call $self` 而不 drop 它的 i32 返回值），就会直接报
//
//	invalid function[0] export "_start": too many results
//	have (i32)  want ()
//
// （第一次写自递归夹具时正是这么红的：递归函数返回 i32，`_start` 体里必须 `drop`。）
//
// 另一个"合法但反直觉"的点：这些模块**一个导入都没有**。WASI 宿主模块是在 Runtime
// 上注册的，模块不 import 也能正常实例化 —— 所以夹具可以完全脱离 wasi 面去测 trap。
//
// 指令字节（用到的全部）：
//
//	0x00 unreachable        0x03 0x40 loop(blocktype=void)
//	0x0b end                0x0c 0x00 br 0（跳回 loop 头 = 死循环）
//	0x10 0x00 call 0        0x1a drop
//	0x41 <sleb> i32.const

// rawModule 构造一个只有 `_start` + `memory` 的最小模块；body 是 `_start` 的函数体
// （不含局部分声明与结尾的 `end`）。
func rawModule(body []byte, minPages uint32) []byte {
	var b []byte
	b = append(b, 0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00)
	b = append(b, wasmSection(1, []byte{0x01, 0x60, 0x00, 0x00})...)                // type: (func)
	b = append(b, wasmSection(3, []byte{0x01, 0x00})...)                            // function: 1 × type0
	b = append(b, wasmSection(5, append([]byte{0x01, 0x00}, uleb(minPages)...))...) // memory
	exp := []byte{0x02, 0x06}
	exp = append(exp, "_start"...)
	exp = append(exp, 0x00, 0x00, 0x06)
	exp = append(exp, "memory"...)
	exp = append(exp, 0x02, 0x00)
	b = append(b, wasmSection(7, exp)...)
	full := append([]byte{0x00}, body...) // 0 个局部变量
	code := []byte{0x01}
	code = append(code, uleb(uint32(len(full)))...)
	code = append(code, full...)
	return append(b, wasmSection(10, code)...)
}

// rawRecursiveModule 构造 `_start` 自递归的模块（wasm 层栈溢出）。
//
// 函数类型是 (func)→()，而被调函数返回 i32 ⇒ 必须 drop 掉返回值（见文件头注释）。
func rawRecursiveModule() []byte {
	// i32.const 0 ; call 0 ; drop ; end
	return rawModule([]byte{0x41, 0x00, 0x10, 0x00, 0x1a, 0x0b}, 1)
}

// rawUnreachableModule 构造 `unreachable` 模块（RUNTIME_TRAP 的确定性判据）。
func rawUnreachableModule() []byte { return rawModule([]byte{0x00, 0x0b}, 1) }

// rawInfiniteLoopModule 构造 `loop br 0 end` 的死循环模块（纯 wasm，不经 Go 运行时）。
func rawInfiniteLoopModule() []byte {
	return rawModule([]byte{0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b}, 1)
}

// rawDeclaredMemoryModule 声明初始内存超出上限的模块（编译期就该被拒）。
func rawDeclaredMemoryModule(pages uint32) []byte { return rawModule([]byte{0x0b}, pages) }

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
