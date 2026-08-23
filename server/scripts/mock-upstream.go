// mock-upstream is a standalone fake OpenAI-compatible upstream server for
// environments without a real LLM key. It listens on :8081 and returns fixed
// JSON (non-stream) and SSE (stream) /chat/completions responses.
//
// Usage: go run scripts/mock-upstream.go [addr]   (default :8081)
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type chatReq struct {
	Model    string `json:"model"`
	Stream   bool   `json:"stream"`
	Messages []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"messages"`
}

func main() {
	addr := flag.String("addr", ":8081", "listen address")
	flag.Parse()

	http.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		var req chatReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":{"message":"bad request"}}`, 400)
			return
		}
		last := ""
		lastRole := ""
		for _, m := range req.Messages {
			last = m.Content
			lastRole = m.Role
		}

		// 脚本化工具调用(E2E 用):最后一条是用户消息且含 TOOLCALL:<name> → 回工具调用;
		// 工具结果回传轮(lastRole=tool/assistant)回正常文本。支持 file_write/file_delete/command_exec。
		var scriptedTool *map[string]any
		if lastRole == "user" {
			switch {
			case strings.Contains(last, "TOOLCALL:file_write"):
				scriptedTool = &map[string]any{
					"name":      "file_write",
					"arguments": `{"path":"test.txt","content":"hello e2e ` + strconv.FormatInt(time.Now().UnixMilli(), 10) + `"}`,
				}
			case strings.Contains(last, "TOOLCALL:file_delete"):
				scriptedTool = &map[string]any{
					"name":      "file_delete",
					"arguments": `{"path":"delete-me.txt"}`,
				}
			case strings.Contains(last, "TOOLCALL:command_exec"):
				scriptedTool = &map[string]any{
					"name":      "command_exec",
					"arguments": `{"command":"echo e2e-cmd-ok"}`,
				}
			case strings.Contains(last, "TOOLCALL:kb_search"):
				// 知识库检索:引擎调用真实 kb_search 工具(本地 dev-env 有 seed 数据)
				scriptedTool = &map[string]any{
					"name":      "kb_search",
					"arguments": `{"query":"报销"}`,
				}
			}
		}
		content := fmt.Sprintf("mock upstream echo: %q (model=%s)", last, req.Model)

		// CACHEHIT:<n> 标记:请求内容含 "CACHEHIT:100" 时,usage 报告 100 个
		// 缓存命中输入 token(prompt_cache_hit_tokens)——用于验证缓存计费。
		cacheHit := 0
		if idx := strings.Index(last, "CACHEHIT:"); idx >= 0 {
			rest := strings.TrimSpace(last[idx+len("CACHEHIT:"):])
			num := ""
			for _, c := range rest {
				if c >= '0' && c <= '9' {
					num += string(c)
				} else {
					break
				}
			}
			if n, err := strconv.Atoi(num); err == nil && n > 0 {
				cacheHit = n
			}
		}

		if req.Stream {
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			w.WriteHeader(200)
			flusher, _ := w.(http.Flusher)
			if scriptedTool != nil {
				chunk := map[string]any{
					"id": "mock-1", "object": "chat.completion.chunk", "model": req.Model,
					"choices": []map[string]any{{
						"index": 0,
						"delta": map[string]any{
							"tool_calls": []map[string]any{{
								"index": 0,
								"id":    "call-mock-1",
								"type":  "function",
								"function": map[string]string{
									"name":      (*scriptedTool)["name"].(string),
									"arguments": (*scriptedTool)["arguments"].(string),
								},
							}},
						},
					}},
				}
				b, _ := json.Marshal(chunk)
				fmt.Fprintf(w, "data: %s\n\n", b)
				if flusher != nil {
					flusher.Flush()
				}
				fmt.Fprint(w, "data: [DONE]\n\n")
				return
			}
			for _, ch := range content {
				chunk := map[string]any{
					"id": "mock-1", "object": "chat.completion.chunk", "model": req.Model,
					"choices": []map[string]any{{"index": 0, "delta": map[string]string{"content": string(ch)}}},
				}
				b, _ := json.Marshal(chunk)
				fmt.Fprintf(w, "data: %s\n\n", b)
				if flusher != nil {
					flusher.Flush()
				}
				time.Sleep(5 * time.Millisecond)
			}
			usage := map[string]any{
				"id": "mock-1", "object": "chat.completion.chunk", "model": req.Model,
				"choices": []any{},
				"usage": map[string]int{
					"prompt_tokens": 11 + cacheHit, "completion_tokens": len(content),
					"total_tokens": 11 + cacheHit + len(content),
					// DeepSeek 兼容:缓存命中输入 token 数
					"prompt_cache_hit_tokens": cacheHit,
				},
			}
			b, _ := json.Marshal(usage)
			fmt.Fprintf(w, "data: %s\n\n", b)
			fmt.Fprint(w, "data: [DONE]\n\n")
			return
		}

		resp := map[string]any{
			"id": "mock-1", "object": "chat.completion", "model": req.Model, "created": time.Now().Unix(),
			"choices": []map[string]any{{
				"index":         0,
				"message":       map[string]string{"role": "assistant", "content": content},
				"finish_reason": "stop",
			}},
			"usage": map[string]int{
				"prompt_tokens": 11 + cacheHit, "completion_tokens": len(content),
				"total_tokens": 11 + cacheHit + len(content),
				// DeepSeek 兼容:缓存命中输入 token 数
				"prompt_cache_hit_tokens": cacheHit,
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})

	// /v1/embeddings: deterministic hash-based vectors so the knowledge
	// base hybrid search can be verified offline (bge-m3 等模型名均可)
	http.HandleFunc("/v1/embeddings", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Model string          `json:"model"`
			Input json.RawMessage `json:"input"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":{"message":"bad request"}}`, 400)
			return
		}
		var texts []string
		var single string
		if json.Unmarshal(req.Input, &single) == nil {
			texts = []string{single}
		} else {
			json.Unmarshal(req.Input, &texts)
		}
		const dims = 32
		data := make([]map[string]any, 0, len(texts))
		for i, t := range texts {
			vec := make([]float64, dims)
			s := 0.0
			for j, ru := range []rune(t) {
				s = s*1.31 + float64(ru)
				vec[j%dims] += float64(ru)
			}
			for j := range vec {
				vec[j] = math.Mod(vec[j]*math.Sin(s+float64(j)), 1.0)
			}
			data = append(data, map[string]any{
				"object": "embedding", "index": i,
				"embedding": vec,
			})
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"object": "list", "model": req.Model, "data": data,
			"usage": map[string]int{"prompt_tokens": 1, "total_tokens": 1},
		})
	})

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "mock-upstream alive")
	})
	log.Printf("mock-upstream listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, nil))
}
