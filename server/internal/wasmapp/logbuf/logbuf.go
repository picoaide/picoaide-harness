// Package logbuf 提供**每请求**的日志缓冲，实现 capapi.LogSink（§5.1 `log` 原语）。
//
// 为什么单独一个包：`events.Sink` 是**全局调用事件**的落库通道（另一件事），
// 而 `log` 的语义是"本次请求内最多 100 条、单条最多 4 KiB、超出丢弃并计数"，
// 生命周期与一次请求严格对齐。两者名字里都有 Dropped，但计数口径完全不同 ——
// 混用会让"应用日志被丢了多少条"这个回给作者的数字失真。
//
// 缓冲本身有界：条数上限来自 limits.LogMaxPerRequest，单条长度上限来自
// limits.LogMaxLineBytes，因此**不存在"应用狂打日志把宿主内存打爆"的路径**。
package logbuf

import (
	"fmt"
	"strings"
	"sync"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// Entry 是一条已接受的日志。
type Entry struct {
	Level   string `json:"level"`
	Message string `json:"message"`
}

// Buffer 是每请求日志缓冲（并发安全：宿主函数可能在不同 goroutine 被调）。
type Buffer struct {
	mu       sync.Mutex
	entries  []Entry
	dropped  int
	overflow bool
}

// New 创建一个空缓冲。
func New() *Buffer { return &Buffer{} }

// sanitizeLogField 把应用可控字段里的行分隔与控制字符转义成可见序列。
//
// 为什么在**入口**洗而不是在出口（flushAppLogs）洗：日志有两个出口
// （`appserver.flushAppLogs` 的平台日志、以及未来可能新增的诊断出口），出口各洗一遍
// 必然漏一处；入口只有这一个。判据 = "换行/回车不再改变行数"。
//
// 转义而不是删除：作者排障时需要看见"我的日志里有换行"这件事，静默删掉会让内容
// 悄悄变样（与日志本身"可溯源"的用途冲突）。
func sanitizeLogField(s string) string {
	if !strings.ContainsAny(s, "\r\n") && !hasOtherControl(s) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s) + 8)
	for _, r := range s {
		switch {
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20 || r == 0x7f:
			// 其余 C0 控制字符（含 ESC → 终端颜色/光标控制）：一律转义成 \xNN。
			b.WriteString(fmt.Sprintf(`\x%02x`, r))
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// hasOtherControl 报告字符串里是否含除 CR/LF/TAB 之外的控制字符（快速路径用）。
func hasOtherControl(s string) bool {
	for _, r := range s {
		if (r < 0x20 && r != '\n' && r != '\r' && r != '\t') || r == 0x7f {
			return true
		}
	}
	return false
}

// Log 实现 capapi.LogSink。
//
// 语义（§5.1）：
//   - 单条超 limits.LogMaxLineBytes ⇒ **截断**（不是拒收：日志被截断比整条丢掉
//     更有诊断价值，且错误码表里没有"日志过长"这一类）；
//   - 超过 limits.LogMaxPerRequest 条 ⇒ 丢弃并计数（**绝不返回错误**：
//     日志写不下不应该让业务请求失败）。
func (b *Buffer) Log(level, message string) {
	if b == nil {
		return
	}
	// 先清洗再截断（顺序不能反，2026-09-21 审计 F-6）：应用完全控制 level 与 message，
	// 而宿主出口是"一行一条"的文本日志（`wasm-app[<id>] <level>: <message>`）。
	// 消息里带 `\n` 就能凭空造出**额外的日志行**（例如伪造 `wasm-app[x] error: ...`，
	// 甚至伪造运维/宿主自己的日志格式），带 `\r` 则能覆盖同一行的前段内容。
	// 这里把 CR/LF 转义成可见的两字符序列：内容不丢、行结构不可伪造。
	level = sanitizeLogField(level)
	message = sanitizeLogField(message)
	if len(message) > limits.LogMaxLineBytes {
		message = message[:limits.LogMaxLineBytes]
	}
	if level == "" {
		level = "info"
	}
	if len(level) > 16 {
		level = level[:16]
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.entries) >= limits.LogMaxPerRequest {
		b.dropped++
		b.overflow = true
		return
	}
	b.entries = append(b.entries, Entry{Level: level, Message: message})
}

// Dropped 实现 capapi.LogSink：返回被丢弃的条数。
func (b *Buffer) Dropped() int {
	if b == nil {
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.dropped
}

// Len 返回已接受的条数。
func (b *Buffer) Len() int {
	if b == nil {
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.entries)
}

// Overflowed 表示是否发生过丢弃（侧边栏/诊断可用它提示"日志被截断"）。
func (b *Buffer) Overflowed() bool {
	if b == nil {
		return false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.overflow
}

// Snapshot 返回已接受日志的副本（供诊断/调用事件落库）。
func (b *Buffer) Snapshot() []Entry {
	if b == nil {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]Entry, len(b.entries))
	copy(out, b.entries)
	return out
}

// Text 把日志拼成一行一条的文本（stderr 尾巴/诊断落库用）。
func (b *Buffer) Text() string {
	if b == nil {
		return ""
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, e := range b.entries {
		n += len(e.Level) + len(e.Message) + 3
	}
	buf := make([]byte, 0, n)
	for _, e := range b.entries {
		buf = append(buf, e.Level...)
		buf = append(buf, ':', ' ')
		buf = append(buf, e.Message...)
		buf = append(buf, '\n')
	}
	return string(buf)
}

// Reset 清空缓冲（复用缓冲对象时调用；正常用法是每请求 New 一个）。
func (b *Buffer) Reset() {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.entries = b.entries[:0]
	b.dropped = 0
	b.overflow = false
}
