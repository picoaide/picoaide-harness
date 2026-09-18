// Command dbapp 是 appserver 测试用的**宿主能力探针应用**：把 db.* / log 的调用结果
// 回显成 JSON，用来验证应用库句柄池（§4.5）与日志链路（§5.1）。
//
// 帧协议按 §7.1/§7.2 自实现（与 echoapp 同一纪律：站在应用作者的位置）。
// 路径即动作，参数走 query：
//
//	/define?table=t            db.define 一张表（id int, v text）
//	/seed?n=30                 往 t 里插 n 行（每行一次 db.exec）
//	/q?sql=SELECT%201          db.query（返回行数/首行）
//	/exec?sql=...              db.exec
//	/log?msg=xx&level=info     log 宿主调用（验证 logbuf 与宿主日志出口）
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
)

const frameMagic = 0x1e

var stdin = bufio.NewReader(os.Stdin)

type request struct {
	Path  string            `json:"path"`
	Query map[string]string `json:"query"`
	User  *struct {
		Username string `json:"username"`
	} `json:"user"`
}

type rpcResponse struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func main() {
	payload, err := readFrame(stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "dbapp: read frame: %v\n", err)
		os.Exit(3)
	}
	var req request
	if err := json.Unmarshal(payload, &req); err != nil {
		fmt.Fprintf(os.Stderr, "dbapp: bad request json: %v\n", err)
		os.Exit(3)
	}

	// /api 前缀是应用的保留 API 命名空间（宿主不会把它当静态资源，见 static.go 规则 2）；
	// 这里把它剥掉，于是 /q 与 /api/q 等价 —— 测试里用 /api/* 时能拿到 JSON 错误信封。
	action := strings.TrimPrefix(req.Path, "/api")

	out := map[string]any{"path": req.Path}
	switch action {
	case "/define":
		table := orDefault(req.Query["table"], "t")
		res, code, msg := call("db.define", map[string]any{
			"table": table,
			"columns": []map[string]any{
				{"name": "id", "type": "int"},
				{"name": "v", "type": "text"},
			},
		})
		record(out, res, code, msg)
	case "/seed":
		n, _ := strconv.Atoi(req.Query["n"])
		if n <= 0 {
			n = 10
		}
		failed := 0
		lastCode, lastMsg := "", ""
		for i := 0; i < n; i++ {
			_, code, msg := call("db.exec", map[string]any{
				"sql":  "INSERT INTO t (id, v) VALUES (?, ?)",
				"args": []any{i + 1, "row-" + strconv.Itoa(i+1)},
			})
			if code != "" {
				failed++
				lastCode, lastMsg = code, msg
			}
		}
		out["inserted"] = n - failed
		out["failed"] = failed
		if lastCode != "" {
			out["code"] = lastCode
			out["message"] = lastMsg
		}
	case "/q":
		res, code, msg := call("db.query", map[string]any{
			"sql": orDefault(req.Query["sql"], "SELECT 1"), "args": []any{},
		})
		record(out, res, code, msg)
		// rows 只回条数与首行，避免把大结果塞进响应体。
		if len(res) > 0 {
			var parsed struct {
				Columns []string `json:"columns"`
				Rows    [][]any  `json:"rows"`
			}
			if err := json.Unmarshal(res, &parsed); err == nil {
				out["columns"] = parsed.Columns
				out["row_count"] = len(parsed.Rows)
				if len(parsed.Rows) > 0 {
					out["first_row"] = parsed.Rows[0]
				}
			}
		}
	case "/exec":
		res, code, msg := call("db.exec", map[string]any{
			"sql": orDefault(req.Query["sql"], "SELECT 1"), "args": []any{},
		})
		record(out, res, code, msg)
	case "/log":
		res, code, msg := call("log", map[string]any{
			"level":   orDefault(req.Query["level"], "info"),
			"message": orDefault(req.Query["msg"], "dbapp log"),
		})
		record(out, res, code, msg)
	default:
		out["error"] = "unknown path"
	}

	body, err := json.Marshal(out)
	if err != nil {
		fmt.Fprintf(os.Stderr, "dbapp: marshal: %v\n", err)
		os.Exit(3)
	}
	writeResponse(200, map[string]string{"Content-Type": "application/json; charset=utf-8"}, string(body))
}

// record 把一次宿主调用的结果写进响应体（ok/code/message）。
func record(out map[string]any, res json.RawMessage, code, msg string) {
	out["code"] = code
	out["message"] = msg
	out["ok"] = code == ""
	if len(res) > 0 {
		out["result"] = json.RawMessage(res)
	}
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

// ===== 帧协议（§7.1/§7.2）=====

var rpcSeq int64

// call 发起一次宿主调用（写 JSON-RPC 请求帧 → 读响应帧）。
func call(method string, params any) (json.RawMessage, string, string) {
	rpcSeq++
	id, _ := json.Marshal(rpcSeq)
	rawParams, err := json.Marshal(params)
	if err != nil {
		return nil, "PROTOCOL", err.Error()
	}
	reqPayload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": json.RawMessage(id), "method": method, "params": json.RawMessage(rawParams),
	})
	if err != nil {
		return nil, "PROTOCOL", err.Error()
	}
	if err := writeFrame(reqPayload); err != nil {
		return nil, "PROTOCOL", err.Error()
	}
	respPayload, err := readFrame(stdin)
	if err != nil {
		return nil, "PROTOCOL", err.Error()
	}
	var resp rpcResponse
	if err := json.Unmarshal(respPayload, &resp); err != nil {
		return nil, "PROTOCOL", err.Error()
	}
	if resp.Error != nil {
		return nil, resp.Error.Code, resp.Error.Message
	}
	return resp.Result, "", ""
}

func readFrame(in *bufio.Reader) ([]byte, error) {
	first, err := in.ReadByte()
	if err != nil {
		return nil, err
	}
	if first != frameMagic {
		return nil, fmt.Errorf("首字节 0x%02x 不是帧魔数", first)
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
			return nil, fmt.Errorf("长度前缀非法")
		}
		digits = append(digits, b)
	}
	n, err := strconv.Atoi(string(digits))
	if err != nil {
		return nil, err
	}
	buf := make([]byte, n)
	total := 0
	for total < n {
		read, err := in.Read(buf[total:])
		total += read
		if err != nil {
			return nil, err
		}
	}
	return buf, nil
}

func writeResponse(status int, headers map[string]string, body string) {
	env := struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
		Body    string            `json:"body"`
	}{Status: status, Headers: headers, Body: body}
	payload, err := json.Marshal(env)
	if err != nil {
		os.Exit(3)
	}
	if err := writeFrame(payload); err != nil {
		fmt.Fprintf(os.Stderr, "dbapp: write response: %v\n", err)
		os.Exit(3)
	}
}

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
