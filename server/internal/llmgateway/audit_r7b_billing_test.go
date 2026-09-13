package llmgateway

// 审计 r7 **第二轮**对抗复核(报告 RECHECK-F1-server-billing §4):第一轮计费
// 修复自己引入的三条回归 —— 两条"多收"(用户被多扣)+ 一条"少收"残留。
//
//	r7f1-1(P1,多收):输入侧补估把**原始请求体字节 ÷ 4** 当 prompt token。
//	  这个换算对纯文本大致成立,但请求体里可以有"字节重、token 轻"的内容:
//	  OpenAI Vision 的 `data:image/png;base64,…`(网关原样转发)。实测同一份
//	  输入:上游如实上报 1200 token;上游不报 usage 时补估 375045 token(×313),
//	  费用 0.0028 → 0.750362 元(×268)。上限 maxEstimatedPromptTokens 也不是
//	  保护 —— 它等于"平台允许的最大请求体全量计价"(单请求最高 4.19~125.83 元)。
//	  平台自己的视觉口径是 **≤384 token/图**(completions_test.go 的
//	  TestVisionImageTokenBilling),两者直接冲突。
//	r7f1-2(P2,失败流计费):补估闸门是 forwardedBytes > 0,而它对**每一行**都
//	  加,含 `data: [DONE]`、`event:`、注释行与 error 事件。于是上游 200 起流后
//	  只回一条 error 事件(过载/内容过滤)时,客户端 0 正文字节,却按整个请求体
//	  扣费 0.200062 元 —— 与修复自己的契约("一个字节都没交付 ⇒ 不能计费")
//	  直接矛盾。
//	r7f1-4(P3,少收):usageSeen 的判据是"收到过任何 usage 行",而一条
//	  `data: {"usage":{}}`(parseUsage 返回 ok=true、pt=ct=0)就能把它置真 ⇒
//	  新增的输入侧补估整体失效,prompt 回到 0。
//
// 本文件钉住的不变量:
//
//	I4  补估的 prompt 必须与**文本量级**相称:含 1 张 data URI 图片的请求,
//	    prompt ≤ 文本部分字节/4 + 384×图片数,而不是请求体字节/4。
//	I5  **正文一个字节都没交付**的流(空流 / 纯 error 事件)不得计费。
//	I6  completion 估算的基数是**正文内容字节**,不是整个 SSE 报文(帧字节、
//	    usage 行、[DONE] 都不是模型产出)。

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// ---------------------------------------------------------------------------
// 可编排的上游:按路径复刻四种流式协议的正文形态
// ---------------------------------------------------------------------------

// r7bUpstream 是"上游行为可编排"的最小 SSE 上游:
//   - 正文 chunk 的报文形态按**请求路径**分派(chat / completions / responses /
//     messages),这样同一份用例可以逐端点验证"正文内容字节"的口径;
//   - streamMode 决定这条流交付什么(non-content 形态是 r7f1-2 的触发条件)。
type r7bUpstream struct {
	srv *httptest.Server
	mu  sync.Mutex
	// calls / lastBody 是观测面。
	calls    int
	lastBody string

	chunks     int
	chunkText  string
	streamMode string // content | done_only | error_only | zero_usage
	silent     bool   // 整条流不报**可用** usage(上游/中转漏报)
	usagePT    int64
	usageCT    int64
}

const (
	r7bModeContent   = "content"    // 正常正文 chunk
	r7bModeDoneOnly  = "done_only"  // 只有 data: [DONE],正文 0 字节
	r7bModeErrorOnly = "error_only" // 只有一条上游 error 事件 + data: [DONE]
	r7bModeZeroUsage = "zero_usage" // 先一条 {"usage":{}},再正文
)

func newR7bUpstream(t *testing.T) *r7bUpstream {
	t.Helper()
	u := &r7bUpstream{
		chunks:     3,
		chunkText:  "R7BCONTENT",
		streamMode: r7bModeContent,
		usagePT:    1200,
		usageCT:    50,
	}
	u.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		u.mu.Lock()
		u.calls++
		u.lastBody = string(raw)
		chunks, chunkText, mode, silent, pt, ct := u.chunks, u.chunkText, u.streamMode, u.silent, u.usagePT, u.usageCT
		u.mu.Unlock()

		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		stream, _ := body["stream"].(bool)
		if !stream {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"id":"r7b","choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":%d,"completion_tokens":%d}}`, pt, ct)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl := w.(http.Flusher)
		isAnthropic := strings.Contains(r.URL.Path, "/messages")
		isResponses := strings.Contains(r.URL.Path, "/responses")
		isFIM := strings.HasSuffix(r.URL.Path, "/completions") && !strings.Contains(r.URL.Path, "/chat/")

		writeContent := func(i int) {
			text := fmt.Sprintf("%s-%02d", chunkText, i)
			switch {
			case isAnthropic:
				fmt.Fprintf(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":%q}}\n\n", text)
			case isResponses:
				fmt.Fprintf(w, "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"i\",\"delta\":%q}\n\n", text)
			case isFIM:
				fmt.Fprintf(w, "data: {\"choices\":[{\"text\":%q}]}\n\n", text)
			default:
				fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":%q}}]}\n\n", text)
			}
			fl.Flush()
		}

		if mode == r7bModeErrorOnly {
			fmt.Fprint(w, "data: {\"error\":{\"message\":\"upstream overloaded\",\"type\":\"server_error\"}}\n\n")
			fl.Flush()
		}
		if mode == r7bModeZeroUsage {
			fmt.Fprint(w, "data: {\"usage\":{}}\n\n")
			fl.Flush()
		}
		if mode == r7bModeContent || mode == r7bModeZeroUsage {
			for i := 0; i < chunks; i++ {
				writeContent(i)
			}
		}
		if !silent && mode != r7bModeErrorOnly {
			if isAnthropic {
				fmt.Fprintf(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":%d,\"output_tokens\":0}}}\n\n", pt)
				fmt.Fprintf(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":%d}}\n\n", ct)
			} else {
				fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":%d,\"completion_tokens\":%d}}\n\n", pt, ct)
			}
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		fl.Flush()
	}))
	t.Cleanup(u.srv.Close)
	return u
}

// deliveredContentBytes 是夹具**真的**写出去的正文文本字节数(不含 SSE 帧、
// usage 行、[DONE]):测试用它独立复算,而不是引用实现公式。
func (u *r7bUpstream) deliveredContentBytes() int64 {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.streamMode != r7bModeContent && u.streamMode != r7bModeZeroUsage {
		return 0
	}
	var n int64
	for i := 0; i < u.chunks; i++ {
		n += int64(len(fmt.Sprintf("%s-%02d", u.chunkText, i)))
	}
	return n
}

func (u *r7bUpstream) callCount() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.calls
}

// r7bVisionImageTokenCap 是**平台自己的视觉计费口径**(单图 prompt token 上限),
// 与 completions_test.go 的 TestVisionImageTokenBilling 同源。刻意在测试里写死
// 字面量而不是引用实现常量:这样本文件在修复前的树上也能编译、并以断言失败的
// 方式变红,而不是编译错误 —— 红/绿都必须是真实运行结果。
const r7bVisionImageTokenCap int64 = 384

// r7bStreamEndpoints 覆盖三种协议形态的实现路径:chat / legacy completions /
// responses 共用 serveStream,anthropic messages 走 serveAnthropicStream。
var r7bStreamEndpoints = []struct {
	name string
	path string
	body string
}{
	{"chat", "/v1/chat/completions", `{"model":"r3-model","messages":[{"role":"user","content":"hi"}],"stream":true}`},
	{"completions", "/v1/completions", `{"model":"r3-model","prompt":"hi","stream":true}`},
	{"responses", "/v1/responses", `{"model":"r3-model","input":"hi","stream":true}`},
	{"messages", "/v1/messages", `{"model":"r3-model","messages":[{"role":"user","content":"hi"}],"max_tokens":16,"stream":true}`},
}

// r7bBigBody 造一个"文本量很大"的合法请求体(按端点各自的字段形态),用来
// 放大"按请求体字节计费"与"按正文内容计费"的差异(400KB ≈ 100K 裸字节 token)。
func r7bBigBody(name, text string) string {
	switch name {
	case "completions":
		return `{"model":"r3-model","prompt":"` + text + `","stream":true}`
	case "responses":
		return `{"model":"r3-model","input":"` + text + `","stream":true}`
	case "messages":
		return `{"model":"r3-model","messages":[{"role":"user","content":"` + text + `"}],"max_tokens":16,"stream":true}`
	default: // chat
		return `{"model":"r3-model","messages":[{"role":"user","content":"` + text + `"}],"stream":true}`
	}
}

// ---------------------------------------------------------------------------
// r7f1-1:I4 —— 内联 base64 图片不得按请求体字节计成天价 prompt
// ---------------------------------------------------------------------------

// TestR7bPromptEstimateDoesNotBillBase64ImageAsTokens:同一份含 1.5 MiB base64
// 图片的输入,上游如实上报 1200 token;上游不报 usage 时补估必须**量级相当**
// (文本部分 + 单图 384 上限),而不是请求体字节/4(实测 375045 token、×268 费用)。
func TestR7bPromptEstimateDoesNotBillBase64ImageAsTokens(t *testing.T) {
	// rc4-1:夹具换成**真图片字节**(结构合法 PNG,见 audit_rc4_billing_test.go)。
	// 旧夹具 strings.Repeat("A", 1_500_000) 是一段 base64 字母表内的**纯文本**,
	// 解码后是 1.1 MiB 的 0x00,根本不是图片 —— rc4-1 起这类载荷必须按文本计费
	// (TestRC4CarrierKeyAlphabetTextIsBilledAsText 钉住),不能再用它证明"图片折算"。
	img := base64.StdEncoding.EncodeToString(rc4PNGBytes(1_125_000)) // ≈1.5 MiB base64
	dataURI := "data:image/png;base64," + img
	reqBody := `{"model":"r3-model","messages":[{"role":"user","content":[{"type":"text","text":"what is this?"},` +
		`{"type":"image_url","image_url":{"url":"` + dataURI + `"}}]}],"stream":true}`
	// 测试侧独立复算文本部分:请求体去掉 base64 载荷(保留 data URI 前缀等骨架)。
	textBytes := int64(len(reqBody) - len(img))
	t.Logf("请求体字节=%d(其中 base64 图片载荷 %d 字节)", len(reqBody), len(img))

	// A:上游如实上报(pt=1200)—— 真值路径。
	uA := newR7bUpstream(t)
	uA.chunks, uA.chunkText = 1, "ok"
	rA, dbA, uidA, tokA := newAuditR3GatewayAt(t, uA.srv.URL, 1000, 2, 8, 0)
	if w := doPost(t, rA, "/v1/chat/completions", reqBody, tokA, nil); w.Code != http.StatusOK {
		t.Fatalf("A 组 status=%d body=%s", w.Code, bodyHead(w))
	}
	rowsA := r5UsageRows(t, dbA, uidA)
	if len(rowsA) != 1 {
		t.Fatalf("A 组 usage 行数 = %d, want 1", len(rowsA))
	}

	// B:同一请求体,上游整条流不报 usage ⇒ 走字节补估。
	uB := newR7bUpstream(t)
	uB.chunks, uB.chunkText, uB.silent = 1, "ok", true
	rB, dbB, uidB, tokB := newAuditR3GatewayAt(t, uB.srv.URL, 1000, 2, 8, 0)
	if w := doPost(t, rB, "/v1/chat/completions", reqBody, tokB, nil); w.Code != http.StatusOK {
		t.Fatalf("B 组 status=%d body=%s", w.Code, bodyHead(w))
	}
	rowsB := r5UsageRows(t, dbB, uidB)
	if len(rowsB) != 1 {
		t.Fatalf("B 组 usage 行数 = %d, want 1", len(rowsB))
	}
	a, b := rowsA[0], rowsB[0]
	t.Logf("A(上行如实上报): pt=%d ct=%d cost=%.6f estimated=%v", a.Prompt, a.Completion, a.Cost, a.Estimated)
	t.Logf("B(上游不报 usage): pt=%d ct=%d cost=%.6f estimated=%v", b.Prompt, b.Completion, b.Cost, b.Estimated)

	if !b.Estimated {
		t.Fatalf("漏报 usage 的流必须打 estimated 标记: %+v", b)
	}
	// I4:量级断言(不是复述实现公式)—— 文本部分按 4 字节/token,图片按平台
	// 视觉口径 ≤384/图;任何按 base64 长度折算的实现都会越过这个上界。
	if maxPrompt := textBytes/4 + r7bVisionImageTokenCap; b.Prompt > maxPrompt {
		t.Fatalf("补估把 base64 图片按字节算成了 token: pt=%d, want ≤ %d(文本 %d 字节 + 384×1 图);请求体 %d 字节 ÷4 = %d",
			b.Prompt, maxPrompt, textBytes, len(reqBody), len(reqBody)/4)
	}
	if b.Prompt < r7bVisionImageTokenCap {
		t.Fatalf("图片请求的输入侧仍被算成免费: pt=%d, want ≥ %d(平台视觉口径)", b.Prompt, r7bVisionImageTokenCap)
	}
	if ratio := b.Cost / a.Cost; ratio > 4 {
		t.Fatalf("同一份输入的补估费用是真值的 %.1f 倍(cost %.6f vs %.6f):量级失控", ratio, b.Cost, a.Cost)
	}
}

// TestR7bPromptEstimateStaysWithinRealPromptScale:纯文本请求体也不能"按平台
// 最大请求体全量计价"。2 MiB 文本(≈524288 token)> 真实 prompt 量级,补估必须
// 收敛到上下文窗口量级并**显式告警**,而不是静默按上限计费。
func TestR7bPromptEstimateStaysWithinRealPromptScale(t *testing.T) {
	u := newR7bUpstream(t)
	u.silent = true
	u.chunks, u.chunkText = 2, "ok"
	r, db, uid, token := newAuditR3GatewayAt(t, u.srv.URL, 1000, 2, 8, 0)

	// 命中上限的告警按"连续期 + 窗口取值"去重(rc3-5),是进程级状态:先清零,
	// 否则本用例会受同包其它用例(或 -shuffle)影响而看不到首次告警。
	promptEstimationClampMonitor.reset()

	var logs bytes.Buffer
	prevOut := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(prevOut)

	rawText := strings.Repeat("P", 2<<20)
	reqBody := `{"model":"r3-model","messages":[{"role":"user","content":"` + rawText + `"}],"stream":true}`
	w := doPost(t, r, "/v1/chat/completions", reqBody, token, nil)
	rows := r5UsageRows(t, db, uid)
	if w.Code != http.StatusOK || len(rows) != 1 {
		t.Fatalf("status=%d rows=%d body=%s", w.Code, len(rows), bodyHead(w))
	}
	got := rows[0]
	rawEstimate := int64(len(reqBody)) / 4
	t.Logf("请求体 %d 字节(裸字节口径 %d token)→ 落账 pt=%d cost=%.6f", len(reqBody), rawEstimate, got.Prompt, got.Cost)

	if got.Prompt <= 0 {
		t.Fatalf("文本请求的输入侧被算成免费: pt=%d", got.Prompt)
	}
	if got.Prompt >= rawEstimate {
		t.Fatalf("补估仍按平台最大请求体全量计价: pt=%d ≥ %d", got.Prompt, rawEstimate)
	}
	// 量级:必须收敛到"主流模型上下文窗口"的量级(≤256K 这一数量级的硬上界),
	// 而不是 4.19M(平台最大请求体 ÷4)。
	if got.Prompt > 262144 {
		t.Fatalf("补估上限过大,仍可单请求计出天价: pt=%d", got.Prompt)
	}
	if !strings.Contains(logs.String(), "clamped") {
		t.Fatalf("命中上限被静默按上限计费(管理端/日志看不到计量表异常):\n%s", logs.String())
	}
}

// ---------------------------------------------------------------------------
// r7f1-2:I5 + I6 —— 只有**正文内容**才算交付
// ---------------------------------------------------------------------------

// TestR7bNonContentStreamIsNotBilled:上游 200 起流后只回 data: [DONE] 或一条
// error 事件(过载/内容过滤),客户端 0 正文字节 ⇒ 不得留下任何计费。
// 三个流式端点(chat/completions/responses)+ messages 全部覆盖。
func TestR7bNonContentStreamIsNotBilled(t *testing.T) {
	for _, mode := range []string{r7bModeDoneOnly, r7bModeErrorOnly} {
		for _, ep := range r7bStreamEndpoints {
			t.Run(mode+"_"+ep.name, func(t *testing.T) {
				u := newR7bUpstream(t)
				u.streamMode, u.silent = mode, true // 正文与可用 usage 都没有
				r, db, uid, token := newAuditR3GatewayAt(t, u.srv.URL, 100, 2, 8, 0)

				prompt := strings.Repeat("P", 400_000) // 400KB 请求体 ≈ 100K 裸字节 token
				reqBody := r7bBigBody(ep.name, prompt)
				w := doPost(t, r, ep.path, reqBody, token, nil)
				s := auditR3Snapshot(t, db, uid)
				rows := r5UsageRows(t, db, uid)
				t.Logf("%s/%s: status=%d 客户端收到=%q rows=%d cost=%.6f 余额=%.6f",
					mode, ep.name, w.Code, bodyHead(w), len(rows), s.cost, s.balance)

				if strings.Contains(w.Body.String(), prompt) {
					t.Fatalf("夹具失效:非正文流竟然回显了请求内容")
				}
				for _, r0 := range rows {
					if r0.Prompt > 0 || r0.Completion > 0 || r0.Cost > 0 {
						t.Fatalf("0 正文字节的失败流被计费: pt=%d ct=%d cost=%.6f(应删除 pending 行/零落账)",
							r0.Prompt, r0.Completion, r0.Cost)
					}
				}
				if math.Abs(s.balance-100) > 1e-9 {
					t.Fatalf("0 正文字节的失败流扣了钱: 余额=%.6f", s.balance)
				}
				checkLedgerInvariant(t, s, "r7f1-2 "+mode+"/"+ep.name)
			})
		}
	}
}

// TestR7bCompletionEstimateUsesContentBytesNotWholeStreamFrame:正文交付后
// completion 估算的基数是**正文内容字节**,不是整个 SSE 报文(帧、usage 行、
// [DONE] 都不是模型产出);输入侧补估必须仍然启动(第一轮 srvbill-2 不得退化)。
func TestR7bCompletionEstimateUsesContentBytesNotWholeStreamFrame(t *testing.T) {
	for _, ep := range r7bStreamEndpoints {
		t.Run(ep.name, func(t *testing.T) {
			u := newR7bUpstream(t)
			u.silent = true
			u.chunks, u.chunkText = 4, "R7BBODY"
			r, db, uid, token := newAuditR3GatewayAt(t, u.srv.URL, 100, 2, 8, 0)

			w := doPost(t, r, ep.path, ep.body, token, nil)
			rows := r5UsageRows(t, db, uid)
			if w.Code != http.StatusOK || len(rows) != 1 {
				t.Fatalf("status=%d rows=%d body=%s", w.Code, len(rows), bodyHead(w))
			}
			got := rows[0]
			contentBytes := u.deliveredContentBytes()
			t.Logf("%s: 正文 %d 字节 / 响应体 %d 字节 → pt=%d ct=%d cost=%.6f",
				ep.name, contentBytes, len(w.Body.String()), got.Prompt, got.Completion, got.Cost)
			if contentBytes <= 0 {
				t.Fatalf("夹具没有交付正文")
			}
			if !strings.Contains(w.Body.String(), "R7BBODY-03") {
				t.Fatalf("正文未完整交付: %s", bodyHead(w))
			}
			// 输入侧补估(第一轮 srvbill-2):请求体纯文本 ⇒ 4 字节/token。
			if wantPT := int64(len(ep.body)) / 4; got.Prompt != wantPT {
				t.Fatalf("整条流无可用 usage 时输入侧未按请求体文本补估: pt=%d, want %d", got.Prompt, wantPT)
			}
			// 输出侧:基数 = 正文内容字节(不是整个响应体字节)。
			if wantCT := contentBytes / 4; got.Completion != wantCT {
				t.Fatalf("completion 估算基数不是正文内容字节: ct=%d, want %d(正文 %d 字节;整个响应体 %d 字节 ÷4 = %d)",
					got.Completion, wantCT, contentBytes, len(w.Body.String()), len(w.Body.String())/4)
			}
			if !got.Estimated {
				t.Fatalf("估算出来的行必须打 estimated 标记: %+v", got)
			}
			if want := (float64(got.Prompt)*2 + float64(got.Completion)*8) / 1e6; math.Abs(got.Cost-want) > 1e-9 {
				t.Fatalf("cost = %.9f, want %.9f(输入 2 元/1M + 输出 8 元/1M)", got.Cost, want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// r7f1-1 ③:可观测性 —— "上游不报 usage ⇒ 走补估"必须被看见
// ---------------------------------------------------------------------------

// TestR7bMissingUsageFallbackIsObservableAndWarns:补估不再是无声的。观测器必须
//
//	① 被结算路径真的喂到(而不是只有计数器却没人调);
//	② 连续命中达到阈值时记一条 warning(计量表坏了 = 上游/中转改协议、丢 usage);
//	③ 同一轮连续期只记一次(不刷日志),拿到可用 usage 后连续计数归零。
func TestR7bMissingUsageFallbackIsObservableAndWarns(t *testing.T) {
	// ① 真实结算把"没有可用 usage"喂给观测器。
	beforeTotal, _ := promptEstimationMonitor.snapshot()
	u := newR7bUpstream(t)
	u.silent = true
	r, _, _, token := newAuditR3GatewayAt(t, u.srv.URL, 100, 2, 8, 0)
	doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[{"role":"user","content":"hi"}],"stream":true}`, token, nil)
	afterTotal, afterConsecutive := promptEstimationMonitor.snapshot()
	if afterTotal <= beforeTotal {
		t.Fatalf("结算路径没有把「上游没给可用 usage」记进观测器(total %d → %d):补估仍无声", beforeTotal, afterTotal)
	}
	if afterConsecutive <= 0 {
		t.Fatalf("连续命中计数没有累加: %d", afterConsecutive)
	}

	// ②/③ 阈值与告警纪律(独立观测器,不污染全局计数)。
	m := &estimationFallbackMonitor{}
	var logs bytes.Buffer
	prevOut := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(prevOut)
	for i := int64(0); i < estimationFallbackWarnStreak-1; i++ {
		m.observeMissingUsage()
	}
	if strings.Contains(logs.String(), "NO usable upstream usage") {
		t.Fatalf("未达连续阈值就告警(单次漏报是偶发,不该刷日志):\n%s", logs.String())
	}
	m.observeMissingUsage()
	if !strings.Contains(logs.String(), "NO usable upstream usage") {
		t.Fatalf("连续 %d 次结算都没有可用 usage 却不告警(管理端看不到计量表坏了)", estimationFallbackWarnStreak)
	}
	logs.Reset()
	m.observeMissingUsage()
	if strings.Contains(logs.String(), "NO usable upstream usage") {
		t.Fatalf("同一轮连续期重复告警(刷日志):\n%s", logs.String())
	}
	m.observeReportedUsage()
	if _, c := m.snapshot(); c != 0 {
		t.Fatalf("拿到可用 usage 后连续计数未归零: %d", c)
	}
	logs.Reset()
	for i := int64(0); i < estimationFallbackWarnStreak; i++ {
		m.observeMissingUsage()
	}
	if !strings.Contains(logs.String(), "NO usable upstream usage") {
		t.Fatalf("连续计数归零后新一轮连续期不再告警")
	}
}

// ---------------------------------------------------------------------------
// r7f1-4:一条零值 usage 行不得关掉输入侧补估(少收残留)
// ---------------------------------------------------------------------------

// TestR7bZeroValueUsageLineDoesNotDisablePromptEstimate:上游先回一条
// `data: {"usage":{}}`(parseUsage 返回 ok=true、pt=ct=0),此后再不报任何可用
// usage。输入侧补估必须照常启动(prompt > 0),而不是被这条零值行击穿。
func TestR7bZeroValueUsageLineDoesNotDisablePromptEstimate(t *testing.T) {
	u := newR7bUpstream(t)
	u.streamMode, u.silent = r7bModeZeroUsage, true
	r, db, uid, token := newAuditR3GatewayAt(t, u.srv.URL, 100, 2, 8, 0)

	prompt := strings.Repeat("P", 400_000) // 400KB 请求体 ≈ 100019 估算 token
	reqBody := `{"model":"r3-model","messages":[{"role":"user","content":"` + prompt + `"}],"stream":true}`
	w := doPost(t, r, "/v1/chat/completions", reqBody, token, nil)
	rows := r5UsageRows(t, db, uid)
	if w.Code != http.StatusOK || len(rows) != 1 {
		t.Fatalf("status=%d rows=%d body=%s", w.Code, len(rows), bodyHead(w))
	}
	got := rows[0]
	t.Logf("零值 usage 行 + 无可用 usage: pt=%d ct=%d cost=%.6f estimated=%v", got.Prompt, got.Completion, got.Cost, got.Estimated)
	if got.Prompt != int64(len(reqBody))/4 {
		t.Fatalf("一条 {\"usage\":{}} 让输入侧补估失效: pt=%d, want %d(零值 usage 不等于可用计量)",
			got.Prompt, len(reqBody)/4)
	}
	if !got.Estimated {
		t.Fatalf("估算出来的行必须打 estimated 标记: %+v", got)
	}
}
