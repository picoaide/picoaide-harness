package telemetry

import "strings"

// ---------------------------------------------------------------------------
// 上报文本的控制字符清洗(SG-1,审计 2026-09-17,r2 server-gateway P3)。
//
// 本包的两个上报端点都直接写 PostgreSQL,而 PG 的 TEXT/VARCHAR 拒绝 0x00
// (`invalid byte sequence for encoding "UTF8": 0x00`)。JSON 里 `\u0000` 是完全
// 合法的转义,Go 解码后就是字符串里的一个 0x00 字节 —— 于是任何一个上游
// 序列化 bug / 老客户端 / 第三方调用方,只要在 reason/release(或 skill-call
// 的 name)里带一个 NUL,就会让**整条 upsert 报错**,handler 回 500:
//
//   - 与 errorreporting.go 文件头自述的契约相反(单字段不合法只清洗该字段,
//     整条状态仍然记录);
//   - 更糟的是用户**上一行仍然存活**(upsert 没执行),管理端「客户端上报状态」
//     页继续显示上一次的 ready —— 正是本功能要消灭的「后台显示正常、实际坏掉」。
//
// 所以凡是来自客户端上报的字符串,在长度截断之前先过这里:剥掉控制字符
// (C0 含 NUL、DEL、C1),只保留 \n 与 \t(多行 reason 是排障常态,换行/制表
// 在 PG 里合法且可读)。无效 UTF-8 不需要处理:Go 的 encoding/json 在解码时
// 已把非法字节替换成 U+FFFD。
// ---------------------------------------------------------------------------

// stripControlChars 移除 s 里的控制字符(保留换行与制表)。
// 无控制字符时原样返回(不额外分配),这是绝大多数上报的路径。
func stripControlChars(s string) string {
	if !strings.ContainsFunc(s, isStrippedControlRune) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if isStrippedControlRune(r) {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// isStrippedControlRune 判定会被剥掉的控制字符:C0(U+0000-U+001F)、DEL
// (U+007F)与 C1(U+0080-U+009F)。\n(U+000A)与 \t(U+0009)是例外(见上)。
func isStrippedControlRune(r rune) bool {
	if r == '\n' || r == '\t' {
		return false
	}
	return r < 0x20 || r == 0x7f || (r >= 0x80 && r <= 0x9f)
}
