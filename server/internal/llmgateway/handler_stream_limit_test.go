package llmgateway

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

// P2-8 回归:单行超过上限时必须中断该流,而不是把无换行超长行读进内存。
// 断言三件事:①客户端拿到明确的 SSE 错误事件;②回传字节数远小于上游行
// (没有把 24MiB 转发出去);③请求能返回(不会一直等上游把行写完)。
func TestServeStreamRejectsOversizedLine(t *testing.T) {
	const lineBytes = 24 << 20 // 24MiB 无换行行
	f := newFakeUpstream(t)
	f.streamResp = strings.Repeat("a", lineBytes) // 无 '\n',无 SSE 结构
	r, db, token := newGateway(t, f)

	start := time.Now()
	w := doPost(t, r, "/v1/chat/completions",
		`{"model":"deepseek-chat","messages":[],"stream":true}`, token, nil)
	elapsed := time.Since(start)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"上游响应单行过大"`) {
		t.Fatalf("missing oversized-line error event, body=%q", w.Body.String())
	}
	if n := w.Body.Len(); n > maxStreamLineBytes {
		t.Fatalf("client body = %d bytes, want bounded (< %d)", n, maxStreamLineBytes)
	}
	if elapsed > 10*time.Second {
		t.Fatalf("oversized line took %v, stream not terminated", elapsed)
	}
	// 单行超限中断 = 从未回填 token 的 pending 行必须清除(与 idle 超时同口径)。
	var rows int
	if err := db.QueryRow("SELECT COUNT(*) FROM usage").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("usage rows = %d, want 0 (pending row cleaned up on oversized line)", rows)
	}
}

// readLineBounded 直接单测:24MiB 无换行行只消费到 上限+bufio 缓冲 即返回,
// 不返回半行(避免调用方把超大内容写出去)。
func TestReadLineBoundedCapsSingleLine(t *testing.T) {
	const lineBytes = 24 << 20
	src := bytes.NewReader(bytes.Repeat([]byte("a"), lineBytes))
	br := bufio.NewReaderSize(src, 4096)

	prev := maxStreamLineBytes
	maxStreamLineBytes = 64 << 10
	defer func() { maxStreamLineBytes = prev }()

	line, err := readLineBounded(br, maxStreamLineBytes)
	if !errors.Is(err, errStreamLineTooLong) {
		t.Fatalf("err = %v, want errStreamLineTooLong", err)
	}
	if line != "" {
		t.Fatalf("returned partial line of %d bytes, want empty", len(line))
	}
	consumed := lineBytes - src.Len()
	if consumed > maxStreamLineBytes+4096*2 {
		t.Fatalf("consumed %d bytes, want ≤ %d (bounded buffering)", consumed, maxStreamLineBytes+4096*2)
	}
}

// 上限内的跨缓冲区长行必须完整读回(有界读不能截断合法 SSE 行)。
func TestReadLineBoundedKeepsLineUnderCap(t *testing.T) {
	payload := strings.Repeat("x", 300<<10) // 远大于 4096 缓冲,仍 < 1MiB
	br := bufio.NewReaderSize(strings.NewReader("data: "+payload+"\n"), 4096)
	line, err := readLineBounded(br, maxStreamLineBytes)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if line != "data: "+payload+"\n" {
		t.Fatalf("line truncated/corrupted: len=%d", len(line))
	}
}

// messages 路径(P2-8 同源)走 readLineWithIdle:超长行同样返回
// errStreamLineTooLong,不再无上限累积。
func TestReadLineWithIdleCapsSingleLine(t *testing.T) {
	prev := maxStreamLineBytes
	maxStreamLineBytes = 32 << 10
	defer func() { maxStreamLineBytes = prev }()

	for _, idle := range []time.Duration{0, time.Second} {
		br := bufio.NewReaderSize(strings.NewReader(strings.Repeat("b", 1<<20)), 4096)
		line, err := readLineWithIdle(br, idle)
		if !errors.Is(err, errStreamLineTooLong) {
			t.Fatalf("idle=%v err = %v, want errStreamLineTooLong", idle, err)
		}
		if line != "" {
			t.Fatalf("idle=%v returned partial line of %d bytes", idle, len(line))
		}
	}
}

// 上限内 EOF 结尾(无换行)的行语义保持不变:返回内容 + io.EOF。
func TestReadLineBoundedEOFWithoutNewline(t *testing.T) {
	br := bufio.NewReaderSize(strings.NewReader("data: x"), 4096)
	line, err := readLineBounded(br, maxStreamLineBytes)
	if line != "data: x" {
		t.Fatalf("line = %q", line)
	}
	if !errors.Is(err, io.EOF) {
		t.Fatalf("err = %v, want io.EOF", err)
	}
}
