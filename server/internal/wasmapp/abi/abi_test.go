package abi

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// ⚠️ TestFrameRoundTrip 是**唯一**能抓到 "WriteFrame 丢魔数" 这类 bug 的用例：
// 曾经 WriteFrame 用 `strconv.AppendInt(hdr[1:1], …)` 导致写完的帧首字节是长度数字，
// 而只测 EncodeFrame/ReadFrame 的用例全绿。任何改动帧编解码的提交都必须保住这条。
func TestFrameRoundTrip(t *testing.T) {
	for _, payload := range []string{
		`{"a":1}`,
		``,
		`{"jsonrpc":"2.0","id":1,"method":"log","params":{"level":"info","message":"你好"}}`,
		strings.Repeat("x", 4096),
	} {
		var buf bytes.Buffer
		if err := WriteFrame(&buf, []byte(payload)); err != nil {
			t.Fatalf("WriteFrame(%d bytes): %v", len(payload), err)
		}
		if buf.Len() == 0 || buf.Bytes()[0] != FrameMagic {
			t.Fatalf("WriteFrame 首字节=0x%02x，必须等于 FrameMagic 0x%02x（全帧=%q）",
				buf.Bytes()[0], FrameMagic, buf.String())
		}
		got, err := ReadFrame(bufio.NewReader(bytes.NewReader(buf.Bytes())))
		if err != nil {
			t.Fatalf("ReadFrame(WriteFrame 输出) 失败：%v（帧=%q）", err, buf.String())
		}
		if string(got) != payload {
			t.Fatalf("往返不一致：want %q got %q", payload, string(got))
		}
		// EncodeFrame 必须与 WriteFrame 逐字节一致（两份实现在不同调用点被使用）。
		if enc := EncodeFrame([]byte(payload)); !bytes.Equal(enc, buf.Bytes()) {
			t.Fatalf("EncodeFrame 与 WriteFrame 不一致：\n enc=%q\n wf =%q", enc, buf.String())
		}
	}
}

func TestParseFrameHeaderMatchesEncode(t *testing.T) {
	frame := EncodeFrame([]byte(`{"k":"v"}`))
	n, consumed, err := ParseFrameHeader(frame)
	if err != nil {
		t.Fatalf("ParseFrameHeader: %v", err)
	}
	if n != len(`{"k":"v"}`) {
		t.Fatalf("length=%d want %d", n, len(`{"k":"v"}`))
	}
	if got := string(frame[consumed:]); got != `{"k":"v"}` {
		t.Fatalf("payload=%q", got)
	}
}

// TestReadFrameRejectsOversize：§4.6 协议帧单行上限 1 MiB。
func TestReadFrameRejectsOversize(t *testing.T) {
	huge := append(append([]byte{FrameMagic}, []byte(itoa(limits.ProtocolLineMaxBytes+1))...), '\n')
	_, err := ReadFrame(bufio.NewReader(bytes.NewReader(huge)))
	if !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("err=%v want ErrFrameTooLarge", err)
	}
}

// TestReadFrameNotFrame：非 RS 起始 ⇒ ErrNotFrame（调用方按日志处理，§7.2）。
func TestReadFrameNotFrame(t *testing.T) {
	r := bufio.NewReader(strings.NewReader("plain log line\n"))
	_, err := ReadFrame(r)
	if !errors.Is(err, ErrNotFrame) {
		t.Fatalf("err=%v want ErrNotFrame", err)
	}
	// 未消费任何字节：调用方仍能读回整行日志。
	line, _ := r.ReadString('\n')
	if line != "plain log line\n" {
		t.Fatalf("ErrNotFrame 后应能读回原行，got %q", line)
	}
}

func TestReadFrameMalformedAndTruncated(t *testing.T) {
	cases := []struct {
		name string
		in   []byte
		want error
	}{
		{"空长度前缀", []byte{FrameMagic, '\n'}, ErrFrameMalformed},
		{"非十进制长度", []byte{FrameMagic, '1', 'x', '\n'}, ErrFrameMalformed},
		{"负载截断", append([]byte{FrameMagic, '5', '\n'}, []byte("ab")...), ErrFrameTruncated},
		{"长度前缀截断", []byte{FrameMagic, '1'}, ErrFrameTruncated},
	}
	for _, c := range cases {
		_, err := ReadFrame(bufio.NewReader(bytes.NewReader(c.in)))
		if !errors.Is(err, c.want) {
			t.Errorf("%s: err=%v want %v", c.name, err, c.want)
		}
	}
}

func TestReadFrameEOF(t *testing.T) {
	_, err := ReadFrame(bufio.NewReader(strings.NewReader("")))
	if err != io.EOF {
		t.Fatalf("空流应返回 io.EOF，got %v", err)
	}
}

// TestClassify：§7.2 两类帧共用同一格式，靠顶层字段判别。
func TestClassify(t *testing.T) {
	cases := []struct {
		in   string
		want FrameKind
	}{
		{`{"jsonrpc":"2.0","id":1,"method":"log"}`, FrameRPC},
		{`{"status":200,"headers":{},"body":"ok"}`, FrameResponse},
		{`{"status":200}`, FrameResponse},
		{`{"foo":1}`, FrameUnknown},
		{`not json`, FrameUnknown},
	}
	for _, c := range cases {
		if got := Classify([]byte(c.in)); got != c.want {
			t.Errorf("Classify(%s)=%d want %d", c.in, got, c.want)
		}
	}
}

// TestHostMethodsClosedList：§5.1 封闭清单 + §5.5「多一个即测试红」。
func TestHostMethodsClosedList(t *testing.T) {
	// ⚠️ W4：封闭清单从 9 项收敛为 **8 项**（`ai.chat` 随总纲 §21.3 删除）。
	want := []string{
		"db.define", "db.query", "db.exec",
		"tx_begin", "tx_commit", "tx_rollback",
		"log", "assets.read",
	}
	if len(HostMethods) != len(want) {
		t.Fatalf("HostMethods 有 %d 项，want %d（§5.1 封闭清单）", len(HostMethods), len(want))
	}
	for i := range want {
		if HostMethods[i] != want[i] {
			t.Fatalf("HostMethods[%d]=%q want %q", i, HostMethods[i], want[i])
		}
	}
	// 每个 ABI 方法都必须映射到 §5.1 的某个原语。
	prims := map[string]bool{}
	for _, p := range Primitives {
		prims[p] = true
	}
	for _, m := range HostMethods {
		if p := PrimitiveOf(m); !prims[p] {
			t.Errorf("方法 %s 映射到未知原语 %q（§5.1 没有它）", m, p)
		}
	}
	// 反向：每个原语都必须有对应方法。
	for _, p := range Primitives {
		found := false
		for _, m := range HostMethods {
			if PrimitiveOf(m) == p {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("原语 %s 没有任何 ABI 方法实现它", p)
		}
	}
}

// TestRequestEnvelopeJSONShape 钉死 §7.1 的帧字段名（跨语言契约：Go 宿主与 Go 参考实现共用）。
func TestRequestEnvelopeJSONShape(t *testing.T) {
	req := Request{
		ABI:     ABIVersion,
		AppID:   "expense-note",
		Version: "1.0.0",
		Auth:    AuthInfo{Mode: AuthModeLogin, Verified: true},
		User:    &User{ID: 10231, Username: "zhangwei", DisplayName: "张伟", Dept: "研发部", IsPublisher: false},
		Method:  "POST",
		Path:    "/api/save",
		Query:   map[string]string{},
		Headers: map[string]string{"content-type": "application/json"},
		Body:    `{"amount":100}`,
	}
	b, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"abi", "app_id", "version", "auth", "user", "method", "path", "query", "headers", "body"} {
		if _, ok := m[k]; !ok {
			t.Errorf("请求帧缺字段 %q（§7.1 是跨语言契约）", k)
		}
	}
	u := m["user"].(map[string]any)
	for _, k := range []string{"id", "username", "display_name", "dept", "is_publisher"} {
		if _, ok := u[k]; !ok {
			t.Errorf("user 缺字段 %q（§7.1 身份契约）", k)
		}
	}
	// §7.1 第 3 条：不得含任何名单、不得含平台角色。
	for _, forbidden := range []string{"role", "roles", "whitelist", "is_admin", "permissions", "groups"} {
		if _, ok := u[forbidden]; ok {
			t.Errorf("user 帧不得包含 %q（§7.1 第 3 条：只给本人信息）", forbidden)
		}
	}
	// 匿名必须是显式 null（不是缺字段、不是空对象）。
	anon := Request{ABI: ABIVersion, Auth: AuthInfo{Mode: AuthModePublic}, User: nil}
	ab, _ := json.Marshal(anon)
	if !bytes.Contains(ab, []byte(`"user":null`)) {
		t.Errorf("匿名帧必须是 \"user\":null，got %s", ab)
	}
}

func TestTrimLogLine(t *testing.T) {
	if got := TrimLogLine([]byte("hello\n")); got != "hello" {
		t.Fatalf("TrimLogLine=%q", got)
	}
	long := strings.Repeat("a", limits.LogMaxLineBytes+100)
	if got := TrimLogLine([]byte(long)); len(got) != limits.LogMaxLineBytes {
		t.Fatalf("超长日志必须被截断到 %d，got %d", limits.LogMaxLineBytes, len(got))
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}
