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
