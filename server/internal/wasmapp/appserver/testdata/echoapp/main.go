// Command echoapp 是 appserver 测试用的**最小可跑应用**：把宿主帧回显成 JSON 响应体。
//
// 它的用途是把"宿主到底给了应用什么"变成可断言的事实：
//   - 身份：`has_user` / `username` / `auth_mode` / `auth_verified`（§7.1 身份契约）；
//   - 请求：method / path / query / headers / body（头白名单与 CR/LF 净化的判据）；
//   - 响应：响应头里塞满"宿主必须剥掉"的东西（Set-Cookie / CSP / 非白名单头），
//     用来钉死 §4.8 的"宿主独占安全头"。
//
// 帧协议按 §7.1/§7.2 自实现（应用只拿到 skill 样板，不会拿到平台内部包）。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"time"
)

const frameMagic = 0x1e

// stdin 是**唯一**的 stdin 读取器（§7.1：长度前缀 + 一次读满；预读会吞掉后续帧）。
var stdin = bufio.NewReader(os.Stdin)

type request struct {
	ABI     string `json:"abi"`
	AppID   string `json:"app_id"`
	Version string `json:"version"`
	Auth    struct {
		Mode     string `json:"mode"`
		Verified bool   `json:"verified"`
	} `json:"auth"`
	// 用指针：nil 表示帧里就是 `"user": null`（匿名），与"空对象"是两件事。
	User *struct {
		ID       int64  `json:"id"`
		Username string `json:"username"`
	} `json:"user"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Query   map[string]string `json:"query"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

func main() {
	payload, err := readFrame(stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "echoapp: read request frame: %v\n", err)
		os.Exit(3)
	}
	var req request
	if err := json.Unmarshal(payload, &req); err != nil {
		fmt.Fprintf(os.Stderr, "echoapp: bad request json: %v\n", err)
		os.Exit(3)
	}

	// /slow?ms=N：让应用"占着执行槽"一段时间，用来验证排队/队列满（§4.6）。
	if req.Path == "/slow" {
		ms, _ := strconv.Atoi(req.Query["ms"])
		if ms <= 0 {
			ms = 500
		}
		time.Sleep(time.Duration(ms) * time.Millisecond)
	}

	username := ""
	if req.User != nil {
		username = req.User.Username
	}
	body, err := json.Marshal(map[string]any{
		"abi":           req.ABI,
		"app_id":        req.AppID,
		"version":       req.Version,
		"method":        req.Method,
		"path":          req.Path,
		"query":         req.Query,
		"headers":       req.Headers,
		"body":          req.Body,
		"auth_mode":     req.Auth.Mode,
		"auth_verified": req.Auth.Verified,
		"has_user":      req.User != nil,
		"username":      username,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "echoapp: marshal: %v\n", err)
		os.Exit(3)
	}

	// 响应头里故意塞满"宿主必须剥掉/覆盖"的东西：
	//   - Set-Cookie / Content-Security-Policy / Referrer-Policy：宿主独占（§4.8）；
	//   - X-Secret-Leak：不在白名单里 ⇒ 一律剥掉；
	//   - Cache-Control：动态响应由宿主决定（no-store），应用写的无效；
	//   - Content-Disposition：只允许 inline，attachment 必须被剥掉。
	writeResponse(200, map[string]string{
		"Content-Type":            "application/json; charset=utf-8",
		"Set-Cookie":              "stolen=1; Path=/",
		"Content-Security-Policy": "default-src * 'unsafe-eval'",
		"Referrer-Policy":         "unsafe-url",
		"X-Secret-Leak":           "1",
		"Cache-Control":           "public, max-age=3600",
		"Content-Disposition":     `attachment; filename="evil.bin"`,
	}, string(body))
}

// readFrame 读一个完整帧（§7.1）。
func readFrame(in *bufio.Reader) ([]byte, error) {
	first, err := in.ReadByte()
	if err != nil {
		return nil, err
	}
	if first != frameMagic {
		return nil, fmt.Errorf("首字节 0x%02x 不是帧魔数 0x%02x", first, frameMagic)
	}
	var digits []byte
	for {
		b, err := in.ReadByte()
		if err != nil {
			return nil, err
		}
		if b == '\n' {
			break
		}
		if b < '0' || b > '9' {
			return nil, fmt.Errorf("长度前缀非法: %q", b)
		}
		digits = append(digits, b)
	}
	n, err := strconv.Atoi(string(digits))
	if err != nil {
		return nil, err
	}
	payload := make([]byte, n)
	if n > 0 {
		if _, err := readFull(in, payload); err != nil {
			return nil, err
		}
	}
	return payload, nil
}

// readFull 一次读满（不得用会预读的流式解码器，§7.1）。
func readFull(in *bufio.Reader, buf []byte) (int, error) {
	total := 0
	for total < len(buf) {
		n, err := in.Read(buf[total:])
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

// writeResponse 写最终响应信封帧（§7.2）。
func writeResponse(status int, headers map[string]string, body string) {
	env := struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
		Body    string            `json:"body"`
	}{Status: status, Headers: headers, Body: body}
	payload, err := json.Marshal(env)
	if err != nil {
		fmt.Fprintf(os.Stderr, "echoapp: marshal response: %v\n", err)
		os.Exit(3)
	}
	if err := writeFrame(payload); err != nil {
		fmt.Fprintf(os.Stderr, "echoapp: write response frame: %v\n", err)
		os.Exit(3)
	}
}

// writeFrame 写一个帧并立刻 Flush（不 Flush 就是死锁：宿主正等着读）。
func writeFrame(payload []byte) error {
	out := bufio.NewWriter(os.Stdout)
	if _, err := out.Write([]byte{frameMagic}); err != nil {
		return err
	}
	if _, err := out.WriteString(strconv.Itoa(len(payload))); err != nil {
		return err
	}
	if err := out.WriteByte('\n'); err != nil {
		return err
	}
	if _, err := out.Write(payload); err != nil {
		return err
	}
	return out.Flush()
}
