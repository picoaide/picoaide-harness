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
