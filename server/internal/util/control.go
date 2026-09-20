package util

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// EscapeControl 把不可信文本里的行分隔与控制/格式字符转义成可见序列。
//
// 为什么需要它（唯一实现，2026-09-21 审计 P2-6/P3-1 与其后续 A-P2-1）：服务端有两条
// "一条记录 = 一行"的追加型文本面——应用日志（`wasm-app[<id>] <level>: <message>`）
// 与审计明细（`audit_logs.detail`）。两处的**内容都含应用作者可控的字符串**
// （日志 level/message、审计里拼进去的应用 title / app_id），作者只要在标题里放一个
// `\n`，消费端（`psql`、日志查看器、导出脚本）就会把它读成**两条记录**，凭空伪造一行
// （例如伪造宿主自己的日志行，或伪造一条"管理员操作"的审计）。`\r` 同理可以覆盖同
// 一行的前段内容。
//
// 转义而不是删除：作者排障时需要看见"我的标题里有换行"这件事，静默删掉会让内容
// 悄悄变样（与日志/审计本身"可溯源"的用途冲突）。
//
// 被判为"必须转义"的类别（判据 = 输出里不再有任何裸的行分隔/格式字符，且输出恒为
// 合法 UTF-8）：
//   - 行分隔：`\n` `\r`（惯用两字符转义）、U+0085 NEL、U+2028 LS、U+2029 PS，
//     以及 C0 里的 VT/FF（部分查看器同样当换行）；
//   - 其余 C0 控制字符（含 ESC —— 它能在终端里改颜色、移光标，让日志看起来像别的
//     东西）与 DEL 0x7f，走 `\xNN`；
//   - C1 控制字符 U+0080–U+009F（含 U+0085），同样 `\xNN`；
//   - Unicode `Cf` 格式字符：双向覆盖/嵌入 U+202A–U+202E、双向隔离 U+2066–U+2069、
//     零宽 U+200B–U+200F、BOM U+FEFF 等。它们不产生换行，但会**改变显示顺序**——
//     审计实测 `ok\u202egnp.exe\u202c end` 在编辑器里读成 `ok exe.png end`，
//     管理员看到的日志内容会与真实内容不符。走 `\uNNNN`。
//
// 这套类别与转义形态**不是新发明的第三套策略**：`internal/serverauth/ldap.go` 的
// sanitizeLogLine（2026-09-17 独立验证 P3）早就是同一个口径（控制字符 `\xNN`、
// Cf/Zl/Zp `\uNNNN`），本函数沿用它的形态，并补齐了它没有的 C1（含 NEL）这一档。
//
// 已知残留（不要在此之上再加第三份副本）：ldap.go 里那份**私有副本尚未**改为调用
// 本函数（该文件不在本次改动范围内），它与本函数的唯一差异是"C1 不转义"；把两者
// 合一需要在 ldap.go 里改一行，属后续清理项。
//
// 判据 = "输入里的换行不再增加输出行数"（`strings.Count(out, "\n") == 0`）且
// `utf8.ValidString(out)`。
func EscapeControl(s string) string { return EscapeControlLimit(s, -1) }

// EscapeControlLimit 是 EscapeControl 的**有界**版本：结果不超过 maxBytes 字节
// （maxBytes < 0 表示不限制，= 0 返回空串）。
//
// 顺序与不变量（2026-09-21 审计 A-P2-2）：**先转义，再按转义边界截断**，两者在
// 同一次扫描里完成（绝不对转义后的串做事后切字节）：
//   - 逐 rune 转义 ⇒ 截断永远不会切出半个多字节字符（`é`/`😀`/中文都不会）；
//   - 转义序列作为**原子单位**写入 ⇒ 放不下就整体不放，输出永远不会以孤立
//     `\`、`\x`、`\xN`、`\u`、`\uNNN`（半个转义）结尾。否则下游任何做一次反转义
//     的消费端都会把紧随其后的宿主换行当成续行符，从而吞掉/改写**下一行宿主日志**
//     （审计 A.4-3 的 python unicode_escape 实测：2 行并 1 行）。
//   - 代价是"截断点会向前退到上一个完整单位"，所以结果可能比 maxBytes 短几个字节
//     （例如 14×'A' + 0x01 在 16 字节预算下只留 14 个 'A'）。上限是硬顶、不反向
//     放大（转义最多把 1 字节放大成 4 字符，若先截断后转义就会 4× 破顶）。
//
// 另外：非法 UTF-8 输入走慢路径时，坏字节由 `for range` 规范化为 U+FFFD ⇒
// 输出恒为合法 UTF-8（`log.Printf` 会把非法字节原样写盘，下游采集看到乱码；
// 与 ldap.go truncateUTF8 的注释同一口径）。
func EscapeControlLimit(s string, maxBytes int) string {
	if maxBytes == 0 {
		return ""
	}
	// 快速路径：绝大多数调用点（尤其审计）的字符串是完全干净的，这里避免为每次
	// 调用分配一次 Builder。注意"干净"还要求合法 UTF-8 —— 非法字节必须走慢路径
	// 规范化，否则输出可能是非法字节序列。
	if (maxBytes < 0 || len(s) <= maxBytes) && !needsEscape(s) {
		return s
	}
	hint := len(s) + 8
	if maxBytes >= 0 && hint > maxBytes+8 {
		hint = maxBytes + 8
	}
	var b strings.Builder
	b.Grow(hint)
	writeEscaped(&b, s, maxBytes)
	return b.String()
}

// isEscapedRune 报告 r 是否必须以转义形式写出（`\n`/`\r`/`\t` 也有惯用转义，
// 由 writeEscaped 先行处理）。
func isEscapedRune(r rune) bool {
	// Cc = C0（0x00–0x1f）+ DEL(0x7f) + C1（0x80–0x9f，含 U+0085 NEL ——
	// 部分查看器与 JS 把它当换行）。
	if unicode.In(r, unicode.Cc) {
		return true
	}
	// Cf/Zl/Zp：Zl/Zp 就是 U+2028/U+2029；Cf 是双向覆盖/隔离与零宽格式字符，
	// 会改变日志的显示顺序（见 EscapeControl 的注释）。
	return unicode.In(r, unicode.Cf, unicode.Zl, unicode.Zp)
}

// needsEscape 报告 s 是否需要走转义慢路径（快速路径的判据）。
func needsEscape(s string) bool {
	if !utf8.ValidString(s) {
		return true
	}
	for _, r := range s {
		if isEscapedRune(r) {
			return true
		}
	}
	return false
}

// writeEscaped 把 s 转义后写进 b；maxBytes < 0 表示不限制长度。
//
// 截断只发生在**单位边界**上：一个 rune（原样分支）或一个完整转义序列（其余分支）。
func writeEscaped(b *strings.Builder, s string, maxBytes int) {
	for _, r := range s {
		var esc string
		switch {
		case r == '\n':
			esc = `\n`
		case r == '\r':
			esc = `\r`
		case r == '\t':
			esc = `\t`
		case unicode.In(r, unicode.Cc):
			esc = fmt.Sprintf(`\x%02x`, r)
		case unicode.In(r, unicode.Cf, unicode.Zl, unicode.Zp):
			esc = fmt.Sprintf(`\u%04x`, r)
		default:
			// 唯一会写出多字节序列的分支，且以 rune 为单位：不会切出半个字符。
			if maxBytes >= 0 && b.Len()+utf8.RuneLen(r) > maxBytes {
				return
			}
			b.WriteRune(r)
			continue
		}
		// 转义序列是原子单位：放不下就整体不放（绝不写半个转义）。
		if maxBytes >= 0 && b.Len()+len(esc) > maxBytes {
			return
		}
		b.WriteString(esc)
	}
}
