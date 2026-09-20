package logbuf

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// ---- 2026-09-21 审计（temp/audit-w0-data/logbuf-respond）A-P2-1 / A-P2-2 的判据 ----
//
// A-P2-1：U+2028/U+2029/U+0085 与 Cf（双向覆盖/零宽）没被转义 ⇒
//         "一条记录 = 一行"的消费端（日志查看器、psql、导出脚本、JS 工具链）
//         会把它们读成换行或按它们重排显示顺序。
// A-P2-2：截断落在转义序列中间 ⇒ 输出以孤立 `\` / `\x` / `\xN` 结尾，
//         下游做一次反转义的消费端会把紧随其后的宿主换行拼成续行
//         （审计 A.4-3 实测：2 行并 1 行）。

// isHexDigit 报告 b 是否为十六进制数字（partialEscapeSuffix 用）。
func isHexDigit(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'f') || (b >= 'A' && b <= 'F')
}

// partialEscapeSuffix 返回 out 结尾处**不完整**的转义序列（没有则返回空串）。
//
// 与 internal/util 的 control_test.go 里同名函数是**刻意重复**的：logbuf 与 util
// 是两个包，本次改动的文件范围只允许这两个测试文件，无法共享测试辅助代码。
// 判据语义：完整形态是 `\n`/`\r`/`\t`/`\xNN`/`\uNNNN`；截断落进序列中间会留下
// 孤立 `\`、`\x`、`\xN`、`\u`、`\uNNN` —— 孤立 `\` 紧邻平台换行时会被反转义的
// 消费端当成续行符。
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

// recordSeparator 报告 r 是否会被某个"一条记录 = 一行"的消费端当成换行
// （LF/CR/VT/FF/U+0085 NEL/U+2028 LS/U+2029 PS）。
// isRawSeparatorOrFormat 覆盖上面这些加 Cf（会改变显示顺序）。
func isRawSeparatorOrFormat(r rune) bool {
	switch r {
	case '\n', '\r', '\v', '\f', 0x85, 0x2028, 0x2029, 0x7f:
		return true
	}
	return unicode.In(r, unicode.Cf, unicode.Zl, unicode.Zp)
}

// renderPlatformLog 复刻平台出口 `appserver.flushAppLogs`
// （hostenv.go 的 `s.logf("wasm-app[%s] %s: %s", …)`，一条一行）。
//
// 为什么在测试里复刻而不是直接调用出口：appserver 依赖 logbuf，logbuf 反向
// import 会成环。为防复刻漂移，TestPlatformLogFormatParity 会读回 hostenv.go
// 断言格式串一字未变 —— 否则下面那条"一行一条"的判据钉的就不是真实出口。
func renderPlatformLog(appID string, b *Buffer) string {
	var sb strings.Builder
	for _, e := range b.Snapshot() {
		fmt.Fprintf(&sb, "wasm-app[%s] %s: %s\n", appID, e.Level, e.Message)
	}
	return sb.String()
}

// TestPlatformLogFormatParity 钉住"复刻的格式串 == 真实出口的格式串"。
func TestPlatformLogFormatParity(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "appserver", "hostenv.go"))
	if err != nil {
		t.Fatalf("读不到平台日志出口（若移动了文件，请同步本文件的 renderPlatformLog）：%v", err)
	}
	want := `s.logf("wasm-app[%s] %s: %s", appID, entry.Level, entry.Message)`
	if !strings.Contains(string(src), want) {
		t.Fatalf("hostenv.go 的平台日志格式串已变（找不到 %s）——renderPlatformLog 必须同步", want)
	}
}

// TestLogPlatformRenderedLogOneLinePerEntry 是 A-P2-1 的**生产形态**判据：
// 应用日志（level 与 message 都是 guest 完全可控）经平台出口渲染后，
// 一条记录必须恰好占一行 —— 对 LF、CR、VT、FF、U+0085、U+2028、U+2029
// **每一个**行终止符口径都成立。
//
// 判据写法：把渲染结果里的"任何被消费端当作换行的字符"全数出来。合法形态只有
// 每条记录末尾那一个 `\n`；只要 U+2028/29/85 之类漏进行内，总数就会 > 条数。
func TestLogPlatformRenderedLogOneLinePerEntry(t *testing.T) {
	const appID = "logsep-1"
	msgs := []string{
		"a\u2028b",                  // LINE SEPARATOR
		"a\u2029b",                  // PARAGRAPH SEPARATOR
		"a\u0085b",                  // NEXT LINE (NEL)
		"ok\u202egnp.exe\u202c end", // bidi 重排（审计实测形状）
		"a\u200bb\u200ec\u200fd",    // 零宽
		"x\u2066iso\u2069\ufeff",    // 双向隔离 + BOM
		"明文换行\nwasm-app[victim] error: 伪造行", // LF 回归
		"回车\r覆盖\r\n两行",
		"制表\t与 ESC \x1b[31m",
		"混合 x\ny\r\nz\u2028w\u2029v\u0085u",
	}
	b := New()
	for _, m := range msgs {
		b.Log("info", m)
	}
	// level 同样是应用可控字段：它也能塞进记录分隔符。
	b.Log("wa\u2028rn", "级别里也能塞")
	entries := b.Snapshot()
	if len(entries) != len(msgs)+1 {
		t.Fatalf("条数 = %d，期望 %d", len(entries), len(msgs)+1)
	}

	log := renderPlatformLog(appID, b)
	if got := countRecordSeparators(log); got != len(entries) {
		t.Fatalf("平台日志里出现 %d 个记录分隔符，期望 %d（一条记录一行）：%q",
			got, len(entries), clipForLog(log))
	}
	lines := strings.Split(strings.TrimSuffix(log, "\n"), "\n")
	if len(lines) != len(entries) {
		t.Fatalf("按 \\n 切出 %d 行，期望 %d：%q", len(lines), len(entries), clipForLog(log))
	}
	for i, line := range lines {
		if !strings.HasPrefix(line, "wasm-app["+appID+"] ") {
			t.Fatalf("第 %d 行不是平台日志行（行结构被破坏）：%q", i, clipForLog(line))
		}
		for _, r := range line {
			if isRawSeparatorOrFormat(r) {
				t.Fatalf("第 %d 行里残留裸分隔/格式字符 %U（应用可借此伪造行或重排显示）：%q",
					i, r, clipForLog(line))
			}
		}
	}
	// 正对照：普通日志必须逐字不变（转义不许改写正常内容）。
	b2 := New()
	b2.Log("info", "普通日志 123 abc")
	if got := renderPlatformLog(appID, b2); got != "wasm-app[logsep-1] info: 普通日志 123 abc\n" {
		t.Fatalf("普通日志被改写了：%q", got)
	}
}

// countRecordSeparators 数出所有"消费端会当换行"的字符。
func countRecordSeparators(s string) int {
	n := 0
	for _, r := range s {
		switch r {
		case '\n', '\r', '\v', '\f', 0x85, 0x2028, 0x2029:
			n++
		}
	}
	return n
}

// clipForLog 把失败信息里的样本截到可读长度（用例里有 4 KiB 级输入）。
func clipForLog(s string) string {
	const max = 200
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

// TestLogTruncationNeverSplitsEscapeSequence 是 A-P2-2 的参数化判据：
// 应用可以让 level/message 的长度**正好跨过转义边界**（审计实测：14 个 A + 0x01
// 转义后 18 字节，截到 16 就得到 `AAAAAAAAAAAAAA\x`；4095 个 A + LF 截到 4096
// 就得到以孤立 `\` 结尾的 message）。这里枚举跨边界的每一个长度，断言三条：
//
//	① 长度不超上限；② 合法 UTF-8（不切半个多字节 rune）；
//	③ 不以不完整转义序列（`\` / `\x` / `\xN` / `\u` / `\uNNN`）结尾。
func TestLogTruncationNeverSplitsEscapeSequence(t *testing.T) {
	// 尾巴的顺序是刻意的：先放"今天已经被转义"的形状（`\n`/`\r`/`\t`/`\x01`/多字节
	// rune），这样 A-P2-2（截断切半个转义/rune）会先于 A-P2-1（转义集合不全）报错，
	// 两条缺陷各自有独立的红灯信息；新补的 U+0085/U+2028/Cf 排在后面。
	tails := []string{"\n", "\r", "\t", "\x01", "é", "😀", "\u0085", "\u2028", "\u2029", "\u202e"}
	// level 上限 16：n = 0..20 足以让每种尾巴的转义都跨过边界。
	for n := 0; n <= 20; n++ {
		for _, tail := range tails {
			b := New()
			b.Log(strings.Repeat("A", n)+tail, "m")
			got := b.Snapshot()[0].Level
			assertNoPartialEscape(t, fmt.Sprintf("level=%d×A+%q", n, tail), got, 16)
		}
	}
	// message 上限 limits.LogMaxLineBytes：在边界两侧各取几个长度。
	for _, delta := range []int{-4, -3, -2, -1, 0, 1, 2} {
		for _, tail := range tails {
			b := New()
			b.Log("info", strings.Repeat("A", limits.LogMaxLineBytes+delta)+tail)
			got := b.Snapshot()[0].Message
			assertNoPartialEscape(t, fmt.Sprintf("message=%d×A+%q", limits.LogMaxLineBytes+delta, tail), got, limits.LogMaxLineBytes)
		}
	}
	// 转义**膨胀**到超过上限的形状（4096 个 LF 转义后 8192 字节）：
	// 必须在预算内截断，且截断点仍落在转义边界上。
	b := New()
	b.Log("info", strings.Repeat("\n", limits.LogMaxLineBytes))
	assertNoPartialEscape(t, "message=4096×LF", b.Snapshot()[0].Message, limits.LogMaxLineBytes)

	// 正对照：干净的长文本仍然填满上限（截断不该被上面的约束缩短成空串）。
	b2 := New()
	b2.Log("info", strings.Repeat("x", limits.LogMaxLineBytes+500))
	if got := len(b2.Snapshot()[0].Message); got != limits.LogMaxLineBytes {
		t.Fatalf("干净长文本应填满 %d 字节，got %d", limits.LogMaxLineBytes, got)
	}
}

// assertNoPartialEscape 是上面的公共断言体。
//
// 这里**只**钉"截断"这一件事（长度上限 / 合法 UTF-8 / 不完整转义序列）；
// "输出里不得残留裸分隔符"由 TestLogPlatformRenderedLogOneLinePerEntry（生产形态）
// 与 internal/util 的码点表判据负责 —— 两类判据分开，红灯信息才不会互相掩盖
// （A-P2-2 的截断缺陷在旧实现里会被"U+0085 未转义"先挡住）。
func assertNoPartialEscape(t *testing.T, what, got string, max int) {
	t.Helper()
	if len(got) > max {
		t.Fatalf("%s：输出 %d 字节超过上限 %d", what, len(got), max)
	}
	if !utf8.ValidString(got) {
		t.Fatalf("%s：切出非法 UTF-8：%q", what, clipForLog(got))
	}
	if bad := partialEscapeSuffix(got); bad != "" {
		t.Fatalf("%s：输出以不完整转义序列 %q 结尾（下游反转义会吞掉下一行）：%q",
			what, bad, clipForLog(got))
	}
}

// 变异验证：
//   - Log 去掉条数上限 ⇒ TestLogPerRequestCap 必红（内存会无界增长）；
//   - Log 去掉单条截断 ⇒ TestLogTruncatesSingleLine 必红；
//   - Dropped 恒返回 0 ⇒ TestDroppedCounted 必红。

func TestLogPerRequestCap(t *testing.T) {
	b := New()
	for i := 0; i < limits.LogMaxPerRequest+50; i++ {
		b.Log("info", "m")
	}
	if got := b.Len(); got != limits.LogMaxPerRequest {
		t.Fatalf("接受条数=%d want %d（§5.1 每请求上限）", got, limits.LogMaxPerRequest)
	}
	if got := b.Dropped(); got != 50 {
		t.Fatalf("丢弃计数=%d want 50", got)
	}
	if !b.Overflowed() {
		t.Fatal("发生丢弃后 Overflowed 必须为真")
	}
	// 上限是硬顶：内存不会随应用输出无界增长。
	if cap(b.entries) > limits.LogMaxPerRequest*2 {
		t.Fatalf("缓冲容量 %d 超出预期（应被上限约束）", cap(b.entries))
	}
}

func TestLogTruncatesSingleLine(t *testing.T) {
	b := New()
	long := strings.Repeat("x", limits.LogMaxLineBytes+500)
	b.Log("info", long)
	snap := b.Snapshot()
	if len(snap) != 1 {
		t.Fatalf("应接受 1 条，got %d", len(snap))
	}
	if len(snap[0].Message) != limits.LogMaxLineBytes {
		t.Fatalf("单条应被截断到 %d，got %d", limits.LogMaxLineBytes, len(snap[0].Message))
	}
	// 截断不是丢弃：不计入 Dropped（否则回给作者的数字会失真）。
	if b.Dropped() != 0 {
		t.Fatalf("截断不应计入丢弃，got %d", b.Dropped())
	}
}

func TestDroppedCounted(t *testing.T) {
	b := New()
	for i := 0; i < limits.LogMaxPerRequest; i++ {
		b.Log("info", "m")
	}
	if b.Dropped() != 0 {
		t.Fatal("未超限时不应有丢弃")
	}
	b.Log("info", "m")
	if b.Dropped() != 1 {
		t.Fatalf("Dropped=%d want 1", b.Dropped())
	}
}

func TestDefaultLevelAndLevelTruncation(t *testing.T) {
	b := New()
	b.Log("", "m")
	b.Log(strings.Repeat("L", 64), "m")
	s := b.Snapshot()
	if s[0].Level != "info" {
		t.Fatalf("空 level 应回落 info，got %q", s[0].Level)
	}
	if len(s[1].Level) != 16 {
		t.Fatalf("level 应被截断到 16，got %d", len(s[1].Level))
	}
}

func TestTextAndReset(t *testing.T) {
	b := New()
	b.Log("warn", "磁盘快满了")
	b.Log("error", "写入失败")
	txt := b.Text()
	if !strings.Contains(txt, "warn: 磁盘快满了") || !strings.Contains(txt, "error: 写入失败") {
		t.Fatalf("Text=%q", txt)
	}
	b.Reset()
	if b.Len() != 0 || b.Dropped() != 0 || b.Overflowed() {
		t.Fatal("Reset 后应回到空状态")
	}
}

func TestNilBufferSafe(t *testing.T) {
	var b *Buffer
	// 宿主在极端路径上可能传 nil sink；不得 panic（§4.4 兜底精神）。
	b.Log("info", "m")
	if b.Dropped() != 0 || b.Len() != 0 || b.Overflowed() || b.Snapshot() != nil || b.Text() != "" {
		t.Fatal("nil 缓冲必须安全空实现")
	}
	b.Reset()
}

// TestLogSanitizesLineBreaks 是审计 F-6 的判据：应用可控字段不得伪造日志行。
//
// 现场：`flushAppLogs` 的格式是 `wasm-app[<id>] <level>: <message>`（一行一条），
// 而 level 与 message 都直接来自 guest。修复前 `log("info", "ok\nwasm-app[x] error: 伪造")`
// 会在平台日志里造出**第二条看起来完全合法的行**（可用来伪造运维告警、栽赃其它应用，
// 或让 grep/告警规则误触发）。
//
// 判据不是"把换行删掉"（那会静默改内容），而是**转义成可见序列**：
//   - 行数不变（Text() 的 '\n' 个数 == 条数 - 1）；
//   - 内容仍可读（含 `\n` 两个字面字符，作者能看出"我的日志里有换行"）；
//   - 其余 C0 控制字符（ESC 等）同样被转义，不留终端控制序列。
//
// 变异验证：删掉 Log 里的 sanitizeLogField 调用 ⇒ 本用例第一步即红。
func TestLogSanitizesLineBreaks(t *testing.T) {
	b := New()
	b.Log("info", "ok\nwasm-app[victim] error: 伪造的行")
	b.Log("wa\nrn", "带回车的行\r覆盖")
	b.Log("info", "转义 \x1b[31m红色\x1b[0m 与制表\t符")

	entries := b.Snapshot()
	if len(entries) != 3 {
		t.Fatalf("条数 = %d，期望 3", len(entries))
	}
	for i, e := range entries {
		if strings.ContainsAny(e.Message, "\r\n") {
			t.Fatalf("第 %d 条的 message 含裸行分隔符：%q", i, e.Message)
		}
		if strings.ContainsAny(e.Level, "\r\n") {
			t.Fatalf("第 %d 条的 level 含裸行分隔符：%q", i, e.Level)
		}
	}
	if !strings.Contains(entries[0].Message, `\n`) {
		t.Fatalf("换行应被转义成可见的 \\n 而不是删除：%q", entries[0].Message)
	}
	if !strings.Contains(entries[1].Message, `\r`) {
		t.Fatalf("回车应被转义成可见的 \\r：%q", entries[1].Message)
	}
	if !strings.Contains(entries[1].Level, `\n`) {
		t.Fatalf("level 同样是应用可控字段，必须一起洗：%q", entries[1].Level)
	}
	if !strings.Contains(entries[2].Message, `\x1b`) {
		t.Fatalf("ESC 应被转义（否则可在终端注入颜色/光标控制）：%q", entries[2].Message)
	}

	// Text() 是"一行一条"的出口：转义之后，行分隔数必须**恰好等于条数**
	//（每条以 \n 结尾，所以是 N 而不是 N-1）—— 多一个就说明某条的换行没被洗掉。
	text := b.Text()
	if got := strings.Count(text, "\n"); got != len(entries) {
		t.Fatalf("Text() 的行分隔数 = %d，期望 %d（每条一行）：%q", got, len(entries), text)
	}
	if !strings.Contains(entries[2].Message, `\t`) {
		t.Fatalf("制表符应被转义成可见的 \\t（防止日志对齐造假）：%q", entries[2].Message)
	}

	// 正对照：不含特殊字符的日志必须逐字不变（转义不许改写正常内容）。
	b2 := New()
	b2.Log("info", "普通日志 123 abc 中文")
	if got := b2.Snapshot()[0].Message; got != "普通日志 123 abc 中文" {
		t.Fatalf("普通日志被改写了：%q", got)
	}
}
