package logbuf

import (
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

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
