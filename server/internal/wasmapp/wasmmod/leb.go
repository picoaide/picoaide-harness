package wasmmod

import (
	"errors"
	"unicode/utf8"
)

// 本文件只放 wasm 二进制格式的**最小读取原语**（LEB128 与名字）。
//
// 为什么不直接复用 wazero 的解析器（§4.2 validate 行原话）：
// "自解析段表（结构化错误，不把 wazero 裸错误当唯一出口）"——上传期校验的第一消费者是 AI（§8），
// 错误必须能指出"哪一段、哪个偏移、为什么"，而不是 wazero 内部的一行 panic 式文本。
// 因此本包**零第三方依赖**，只用标准库（也保证生成器自举时不引入额外构建面）。

var (
	// errLEBTruncated 表示 LEB128 在数据结束前没有终止字节。
	errLEBTruncated = errors.New("wasm: 长度前缀截断")
	// errLEBOverflow 表示 LEB128 超过 32 位（u32 最多 5 字节，第 5 字节只能有低 4 位）。
	errLEBOverflow = errors.New("wasm: 长度前缀溢出 32 位")
	// errTruncated 表示按声明长度取数据时越界。
	errTruncated = errors.New("wasm: 数据截断")
	// errBadUTF8 表示 wasm 名字字段不是合法 UTF-8（规范要求）。
	errBadUTF8 = errors.New("wasm: 名字不是合法 UTF-8")
)

// readU32 读取一个 LEB128 编码的无符号 32 位整数，返回 (值, 消耗字节数, 错误)。
func readU32(b []byte) (uint32, int, error) {
	var out uint32
	for i := 0; i < len(b); i++ {
		if i >= 5 {
			return 0, 0, errLEBOverflow
		}
		c := b[i]
		payload := uint32(c & 0x7f)
		if i == 4 && payload > 0x0f {
			return 0, 0, errLEBOverflow
		}
		out |= payload << (7 * uint(i))
		if c&0x80 == 0 {
			return out, i + 1, nil
		}
	}
	return 0, 0, errLEBTruncated
}

// readName 读取 wasm 的名字字段（u32 字节长度 + UTF-8 内容）。
func readName(b []byte) (string, int, error) {
	n, used, err := readU32(b)
	if err != nil {
		return "", 0, err
	}
	rest := b[used:]
	if uint64(n) > uint64(len(rest)) {
		return "", 0, errTruncated
	}
	if !utf8.Valid(rest[:n]) {
		return "", 0, errBadUTF8
	}
	return string(rest[:n]), used + int(n), nil
}
