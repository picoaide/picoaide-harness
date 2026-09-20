package util

import (
	"fmt"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"
)

// 本文件的判据对应 2026-09-21 独立审计（temp/audit-w0-data/logbuf-respond）的两条缺陷：
//
//	A-P2-1：转义集合不完整 —— U+2028/U+2029/U+0085 与全部 Cf（双向覆盖/零宽）未转义，
//	        "一条记录 = 一行"的消费端（日志查看器、psql、导出脚本、JS 工具链）会把
//	        它们读成换行或按它们重排显示顺序（审计 A.1/A.3 实跑）。
//	A-P2-2：截断可以落在刚生成的转义序列中间，留下孤立 `\` / `\x` / `\xN`；
//	        下游做一次反转义的消费端会把孤立 `\` 与紧随其后的宿主换行拼成续行
//	        （审计 A.4-3 的 python unicode_escape 实测：2 行并 1 行）。
//
// 期望的转义形态与既有先例一致（server/internal/serverauth/ldap.go 的
// sanitizeLogLine，2026-09-17 独立验证 P3）：C0/DEL/C1 走 `\xNN`，Cf/Zl/Zp 走
// `\uNNNN`，\n/\r/\t 走惯用的两字符转义。

// newlineClass 报告 r 是否属于"行终止符"类：换行、回车、垂直制表、换页、
// U+0085 NEL、U+2028 LS、U+2029 PS（审计 A-P2-1 点名的三类 + 消费端会当换行
// 用的 C0）。
func newlineClass(r rune) bool {
	switch r {
	case '\n', '\r', '\v', '\f', 0x85, 0x2028, 0x2029:
		return true
	}
	return false
}

// formatClass 报告 r 是否属于会改变显示顺序/零宽的格式字符（Cf）或 Zl/Zp。
func formatClass(r rune) bool {
	return unicode.In(r, unicode.Cf, unicode.Zl, unicode.Zp)
}

// clip 把失败信息里的样本截到可读长度（用例里有 4 KiB 级输入，整串打印会把
// 真正的失败点挤出输出）。
func clip(s string) string {
	const max = 160
	if len(s) <= max {
		return s
	}
	for i := max; i > 0; i-- {
		if utf8.RuneStart(s[i]) {
			return s[:i] + "…"
		}
	}
	return ""
}

// assertNoRawSeparatorOrFormat 是判据的公共部分：输出里不得残留任何裸的行分隔
// 字符或格式字符（转义成可见序列 = 允许；删除 = 由调用方另外断言）。
func assertNoRawSeparatorOrFormat(t *testing.T, what, out string) {
	t.Helper()
	for _, r := range out {
		if newlineClass(r) {
			t.Fatalf("%s 残留裸行分隔字符 %U：%q", what, r, clip(out))
		}
		if formatClass(r) {
			t.Fatalf("%s 残留裸格式字符 %U（可改变显示顺序）：%q", what, r, clip(out))
		}
	}
	// Cc 全段（C0 + DEL + C1）：C1 里的 U+0085 是行分隔，其余 C1 也是控制字符。
	for _, r := range out {
		if unicode.In(r, unicode.Cc) {
			t.Fatalf("%s 残留裸控制字符 %U（Cc 段必须全部转义）：%q", what, r, clip(out))
		}
	}
}

// TestEscapeControlCoversWholeC1Range 逐一钉 C1 段（U+0080–U+009F）的**每一个**码点：
// 不是只补 U+0085 NEL 单点。C1 落在 `unicode.Cc`（C0 + DEL + C1）里，而它既不是
// `unicode.Cf` 也不是 Zl/Zp —— 只按后两类实现会**整段漏掉**（ldap 的旧本地实现逐码点
// 判 `r < 0x20 || r == 0x7f`，漏的正是这一段；审计 A-P2-1 点名的 NEL 只是其中一个）。
func TestEscapeControlCoversWholeC1Range(t *testing.T) {
	for r := rune(0x80); r <= 0x9f; r++ {
		in := "a" + string(r) + "b"
		out := EscapeControl(in)
		assertNoRawSeparatorOrFormat(t, fmt.Sprintf("C1 %U", r), out)
		want := fmt.Sprintf(`\x%02x`, r)
		if out != "a"+want+"b" {
			t.Fatalf("C1 码点 %U 应转义成 %q（转义而不是删除/改写）：%q", r, want, out)
		}
	}
	// U+0085 NEL 单点复述（审计点名的那一个；部分查看器与 JS 把它当换行）。
	if got := EscapeControl("a\u0085b"); got != `a\x85b` {
		t.Fatalf("NEL 应转义成 a\\x85b，got %q", got)
	}
}

// TestEscapeControlCoversLineSeparatorsAndFormatChars 是 A-P2-1 的表驱动判据：
// 逐一钉**审计点名的确切码点**（U+2028/U+2029/U+0085、U+202A–U+202E、
// U+2066–U+2069、U+200B/U+200E/U+200F），并顺带覆盖同类 Cf 与既有 C0/DEL 行为。
//
// 三件事同时断言（缺一条都会让"转义"退化成"删除"或"漏掉"）：
//  1. 输出里没有裸的行分隔/格式字符；
//  2. 内容不丢：控制字符**两侧**的 'a' 与 'b' 必须还在，且绝不能只剩 "ab"
//     （作者排障时要能看见"我的标题里有这么个字符"）；
//  3. 该码点被换成了**可见转义序列**（`\xNN` 或 `\uNNNN`），不是静默丢弃。
func TestEscapeControlCoversLineSeparatorsAndFormatChars(t *testing.T) {
	cases := []struct {
		name string
		r    rune
		want string // 期望出现的转义形态
	}{
		// ---- 审计点名的行/段分隔符 ----
		{"U+2028 LINE SEPARATOR", '\u2028', `\u2028`},
		{"U+2029 PARAGRAPH SEPARATOR", '\u2029', `\u2029`},
		{"U+0085 NEXT LINE (NEL)", '\u0085', `\x85`},
		// ---- 审计点名的双向覆盖/嵌入（U+202A–U+202E）----
		{"U+202A LRE", '\u202a', `\u202a`},
		{"U+202B RLE", '\u202b', `\u202b`},
		{"U+202C PDF", '\u202c', `\u202c`},
		{"U+202D LRO", '\u202d', `\u202d`},
		{"U+202E RLO", '\u202e', `\u202e`},
		// ---- 审计点名的双向隔离（U+2066–U+2069）----
		{"U+2066 LRI", '\u2066', `\u2066`},
		{"U+2067 RLI", '\u2067', `\u2067`},
		{"U+2068 FSI", '\u2068', `\u2068`},
		{"U+2069 PDI", '\u2069', `\u2069`},
		// ---- 审计点名的零宽/标记 ----
		{"U+200B ZERO WIDTH SPACE", '\u200b', `\u200b`},
		{"U+200E LRM", '\u200e', `\u200e`},
		{"U+200F RLM", '\u200f', `\u200f`},
		// ---- 同类 Cf（不在审计清单，但规则是"整个 Cf 类"，不能只补点名的几个）----
		{"U+200C ZWNJ", '\u200c', `\u200c`},
		{"U+200D ZWJ", '\u200d', `\u200d`},
		{"U+00AD SOFT HYPHEN", '\u00ad', `\u00ad`},
		{"U+FEFF ZERO WIDTH NO-BREAK SPACE", '\ufeff', `\ufeff`},
		// ---- 既有行为（回归钉）：C0/DEL/C1 与惯用转义 ----
		{"U+0000 NUL", 0x00, `\x00`},
		{"U+000B VT", 0x0b, `\x0b`},
		{"U+001B ESC", 0x1b, `\x1b`},
		{"U+007F DEL", 0x7f, `\x7f`},
		{"U+009F APC (C1)", 0x9f, `\x9f`},
		{"LF", '\n', `\n`},
		{"CR", '\r', `\r`},
		{"TAB", '\t', `\t`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := "a" + string(tc.r) + "b"
			out := EscapeControl(in)
			assertNoRawSeparatorOrFormat(t, "EscapeControl 的输出", out)
			if out == in {
				t.Fatalf("%U 未被转义（原样返回）：%q", tc.r, out)
			}
			// 内容不丢：两侧文本必须在；且不能是"删掉了控制字符"。
			if !strings.HasPrefix(out, "a") || !strings.HasSuffix(out, "b") {
				t.Fatalf("%U 两侧内容被改写（必须只转义控制字符本身）：%q", tc.r, out)
			}
			if out == "ab" {
				t.Fatalf("%U 被删除而不是转义（作者看不到「这里有东西」）：%q", tc.r, out)
			}
			if !strings.Contains(out, tc.want) {
				t.Fatalf("%U 的转义形态应为 %q，got %q", tc.r, tc.want, out)
			}
		})
	}
}

// TestEscapeControlPropertyNoRawNewlineAndValidUTF8 是 A-P2-1 的性质判据：
// 对一类"难看的输入"（文本 + 各种分隔符 + 多字节 rune + 必须截断的超长串 +
// 非法 UTF-8）同时断言两条硬性质：
//
//	① strings.Count(out, "\n") == 0 —— 输出里不出现真正的换行；
//	② utf8.ValidString(out)       —— 输出恒为合法 UTF-8（非法字节必须被规范化，
//	   否则 log.Printf 原样写盘、下游采集看到乱码 —— 审计 A-P3-5 与
//	   ldap.go 的 truncateUTF8 注释是同一口径）。
//
// 另外断言"没有任何裸的行分隔/格式字符残留"（比 ① 更强：U+2028 不是 '\n'，
// 但同样会被下一条消费链读成换行）。
func TestEscapeControlPropertyNoRawNewlineAndValidUTF8(t *testing.T) {
	const long = 4096
	corpus := []struct {
		name  string
		in    string
		limit int // <0 = 不截断（只测 EscapeControl）
	}{
		{"空串", "", -1},
		{"纯可打印", "普通日志 123 abc ~!@#", -1},
		{"LF/CRLF", "a\nb\r\nc", -1},
		{"全部分隔符混合", "x\ny\u2028z\u2029w\u0085v\r\v\f", -1},
		{"多字节 + 分隔符", "中文\u2028日本語\u2029😀\u0085abc", -1},
		{"bidi 重排（审计实测形状）", "ok\u202egnp.exe\u202c end", -1},
		{"零宽与标记", "a\u200bb\u200ec\u200fd\u200e\ufeff", -1},
		{"C0 与 DEL", "\x00\x01\x1b\x7f", -1},
		{"非法 UTF-8", "a\xff\xfeb", -1},
		{"非法 UTF-8 + 分隔符", "a\xff\nb\xfe\u2028c", -1},
		{"超长纯文本必须截断", strings.Repeat("啊", 2000), long},
		{"超长混合必须截断", strings.Repeat("x\u2028", long), long},
		{"超长分隔符（转义会膨胀 4 倍）", strings.Repeat("\n", long), long},
		{"超长 emoji 必须截断", strings.Repeat("😀", 1500), long},
	}
	for _, tc := range corpus {
		t.Run(tc.name, func(t *testing.T) {
			full := EscapeControl(tc.in)
			if got := strings.Count(full, "\n"); got != 0 {
				t.Fatalf("EscapeControl 输出含 %d 个真换行：%q", got, clip(full))
			}
			if !utf8.ValidString(full) {
				t.Fatalf("EscapeControl 输出不是合法 UTF-8（%d 字节）：%q", len(full), clip(full))
			}
			assertNoRawSeparatorOrFormat(t, "EscapeControl 的输出", full)

			if tc.limit < 0 {
				return
			}
			out := EscapeControlLimit(tc.in, tc.limit)
			if got := strings.Count(out, "\n"); got != 0 {
				t.Fatalf("EscapeControlLimit 输出含 %d 个真换行：%q", got, clip(out))
			}
			if !utf8.ValidString(out) {
				t.Fatalf("EscapeControlLimit 输出不是合法 UTF-8（%d 字节）：%q", len(out), clip(out))
			}
			assertNoRawSeparatorOrFormat(t, "EscapeControlLimit 的输出", out)
			if len(out) > tc.limit {
				t.Fatalf("条目长度上限被破：len=%d limit=%d", len(out), tc.limit)
			}
			// 截断只能"砍掉尾巴"：留下的必须是完整转义的**前缀**
			//（否则说明截断把一个转义序列改写成了别的东西）。
			if !strings.HasPrefix(full, out) {
				t.Fatalf("截断结果不是完整转义的前缀（转义/截断顺序被改）：\n full=%q\n out =%q", clip(full), clip(out))
			}
		})
	}
}

// isHexDigit 报告 b 是否为十六进制数字（partialEscapeSuffix 用）。
func isHexDigit(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'f') || (b >= 'A' && b <= 'F')
}

// partialEscapeSuffix 返回 out 结尾处**不完整**的转义序列（没有则返回空串）。
//
// 期望的完整形态是 `\n`/`\r`/`\t`/`\xNN`/`\uNNNN`；截断落进序列中间就会留下
// 孤立 `\`、`\x`、`\xN`、`\u`、`\uNNN`。审计 A.4-3 已实测：孤立 `\` 紧邻平台
// 追加的换行时，任何做一次反转义的消费端都会把下一行并进来（行续接）。
//
// 注意：本判据只对"输入里没有字面反斜杠"的语料成立（否则结尾的 `\x0` 可能是
// 作者真的写了这三个字符）；下面的用例刻意只用 A/多字节/控制字符构造输入。
func partialEscapeSuffix(out string) string {
	if strings.HasSuffix(out, `\`) {
		return `\`
	}
	if strings.HasSuffix(out, `\x`) || strings.HasSuffix(out, `\u`) {
		return out[len(out)-2:]
	}
	i := len(out)
	for i > 0 && isHexDigit(out[i-1]) {
		i--
	}
	digits := len(out) - i
	if digits == 0 || i < 2 || out[i-2] != '\\' {
		return ""
	}
	width := 0
	switch out[i-1] {
	case 'x':
		width = 2
	case 'u':
		width = 4
	default:
		return ""
	}
	if digits < width {
		return out[i-2:]
	}
	return ""
}

// TestEscapeControlLimitNeverEndsInsideEscape 是 A-P2-2 的参数化判据：
// 对每个输入枚举**跨过转义边界的每一个截断长度**（从 0 到完整转义长度 +4），
// 断言截断结果：
//
//	① 长度 ≤ limit；
//	② 合法 UTF-8（不切出半个多字节 rune）；
//	③ 不以不完整转义序列（`\` / `\x` / `\xN` / `\u` / `\uNNN`）结尾。
//
// 三种输入形态分别覆盖三类转义宽度：两字符（`\n`）、四字符（`\x01`/`\u2028`）
// 与多字节原样 rune（é/😀 —— 它们不该被切半个）。
func TestEscapeControlLimitNeverEndsInsideEscape(t *testing.T) {
	cases := []struct {
		name string
		in   string
	}{
		{"两字符转义 LF", "AAAAAAAAAAAAAAA\n"},
		{"四字符转义 C0", "AAAAAAAAAAAAAAA\x01"},
		{"四字符转义 NEL", "AAAAAAAAAAAAAAA\u0085"},
		{"四字符转义 LS", "AAAAAAAAAAAAAAA\u2028"},
		{"四字符转义 bidi", "AAAAAAAAAAAAAAA\u202e"},
		{"两字节 rune", "AAAAAAAAAAAAAAAé"},
		{"四字节 rune", "AAAAAAAAAAAAAAA😀"},
		{"混合", "AAAA\x01AAA\u2028BBB\nCCC😀é\u2066"},
		{"转义在开头", "\n\u2028\x01AAAAAAAAAAAAAAA"},
		{"纯控制字符", "\n\n\n\n\n\n\n\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			full := EscapeControl(tc.in)
			// +4 覆盖"刚好截在完整序列最后一个字节之后"与"再多几个字节"。
			for limit := 0; limit <= len(full)+4; limit++ {
				out := EscapeControlLimit(tc.in, limit)
				if len(out) > limit {
					t.Fatalf("limit=%d 时输出 %d 字节（上限被破）", limit, len(out))
				}
				if !utf8.ValidString(out) {
					t.Fatalf("limit=%d 时切出非法 UTF-8：%q", limit, clip(out))
				}
				if bad := partialEscapeSuffix(out); bad != "" {
					t.Fatalf("limit=%d 时输出以不完整转义序列 %q 结尾（下游反转义会吞掉下一行）：%q",
						limit, bad, clip(out))
				}
				if !strings.HasPrefix(full, out) {
					t.Fatalf("limit=%d 时结果不是完整转义的前缀：\n full=%q\n out =%q", limit, clip(full), clip(out))
				}
			}
		})
	}
}
