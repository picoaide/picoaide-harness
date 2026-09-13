package llmgateway

// 审计 r7 **第三轮**对抗复核(报告 RECHECK3-F1-billing-partitions §2)。
// 第二轮的修复各自只覆盖了"报告点名的那一条形态",第三轮复核用**等价写法**
// 逐条穿透:
//
//	rc3-1(P0,计量路径拒绝服务):inlineBinaryRanges 的 A 分支每次命中
//	  `;base64,` 都 `bytes.LastIndex(body[:marker], "data:")` 全史回扫 ——
//	  标记数量 ∝ 请求体长度 ⇒ O(n²)。单请求 1 MiB(131072 个标记)在**请求
//	  goroutine 内**烧 112.6 秒 CPU(占 STREAM_IDLE_TIMEOUT 90s 的 125%),
//	  16 MiB 上限下外推 ≈ 4.6 小时。请求体在认证前读入,补估发生在交付后但
//	  仍在请求 goroutine(占 concurrency meter、占连接)。
//	rc3-2(P1,少收):同一循环的 A 分支只要求"`data:` 在标记前 128 字节内、
//	  载荷 ≥64 字节",不校验载体键、不校验 mime、不校验这段是不是 URI ——
//	  而请求体全部是租户可控文本。把 460 KB 真实文本放在
//	  `data:text/plain;base64,` 之后,补估从 120019 token 掉到 408(少收 291×,
//	  0.239 元/请求);Anthropic 的 {"data":"…"} 同理(300.8×)。
//	  **镜像方向**:R1 修的"多收 313×"被这一轮自己打开成"少收 291×"。
//	rc3-3(P1,零落账):r7f1-2 把闸门从 forwardedBytes 换成"正文内容字节",
//	  但识别器只认**标准单行形态**:数组 content、字符串 delta、
//	  response.completed 全文、非 SSE 整包 JSON、SSE 多 data 行 —— 这些流
//	  客户端真的收到了正文,却被判成"0 正文字节" ⇒ usage 行被删、整条流免费
//	  (0.2 元/请求,且事后对账看不到这笔调用)。
//	rc3-5(P2,少收 + 刷日志):131072 上限作用在**纯文本**字节÷4 上,512 KB
//	  起的合法长上下文最多少收 8×(4 MiB 请求体 1,048,578 token → 131,072,
//	  按 30 元/1M 少收 27.53 元);命中上限的 warning 每请求一条,无节流。
//	rc3-6(P3,少收):只报 cache 的 usage 行被当成"输入侧有可用计量" ⇒
//	  400 KB 请求落 pt=0(本应 100019)。OpenAI 的 prompt_tokens 是必填字段,
//	  只报 cache 属残缺报文;Anthropic 相反(input_tokens 不含 cache,语义完整)。
//
// 本文件钉住的不变量(**与危害同构**,不是"复述实现公式"):
//
//	I7  内联二进制扫描必须**线性**:1 MiB / 16 MiB 的病态请求体在秒级预算内
//	    完成,且**永不**把剥离器变成 CPU 放大器(超预算即整体回落字节口径)。
//	I8  折算只能把"多收"改小,不能把真实文本变免费:文本部分**全额**按
//	    4 字节/token 计;只有"真的能解码成二进制 + 挂在二进制载体键下 +
//	    二进制 mime"的载荷才按平台视觉口径(≤384/图)折算。
//	I9  正文**真的交付**过的流必须留下计费痕迹(usage 行 + 费用 + 扣款),
//	    形态与实现无关;0 正文字节的失败流仍然零落账(r7f1-2 不退化)。
//	I10 命中上限的告警必须可见且**不刷日志**;上限优先跟随模型上下文窗口。

import (
	"bytes"
	"encoding/base64"
	"io"
	"log"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// r7cUpstream 按给定 SSE 事件序列回放(每条已含 \n\n)。与复核探针同形态:
// 不做任何 usage 注入,由用例自己决定这条流报什么。
func r7cUpstream(t *testing.T, events []string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl, _ := w.(http.Flusher)
		for _, e := range events {
			_, _ = io.WriteString(w, e)
			if fl != nil {
				fl.Flush()
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// ---------------------------------------------------------------------------
// 夹具:真实二进制载荷(不是 base64 字母表里的文本)
// ---------------------------------------------------------------------------

// r7cBinaryBytes 造一段**真的二进制**载荷,用来区分"内联图片"与"伪装成
// base64 的文本"。
//
// rc4-1 起判据是"魔数 + 容器结构 + 整段可打印率"(见 balance_settlement.go 的
// inspectInlineBinaryPayload),所以这里造的是**结构合法**的 PNG(签名 + IHDR +
// IDAT + IEND,CRC 链正确;IDAT 是确定性高熵字节,不追求像素可解码)。
// 只贴一个 PNG 魔数、后面接伪随机字节的夹具在 rc4-1 里属于"只有魔数"的
// 收紧预算(≤ maxUnverifiedBinaryBytes),不再代表"真图片"。
func r7cBinaryBytes(n int) []byte {
	return rc4PNGBytes(n)
}

// r7cDataURI 造一个标准 data URI(payload 为标准 base64)。
func r7cDataURI(mime string, payload []byte) string {
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(payload)
}

// r7cWrapEscaped 把 base64 串按 width 切成多段,用 JSON 转义 `\n`(两个字符)
// 连接 —— 折行 data URI 在 JSON 字符串里的真实形态。
func r7cWrapEscaped(b64 string, width int) (out string, removedExtra int) {
	var sb strings.Builder
	n := 0
	for i := 0; i < len(b64); i += width {
		end := i + width
		if end > len(b64) {
			end = len(b64)
		}
		if i > 0 {
			sb.WriteString(`\n`)
			n += 2
		}
		sb.WriteString(b64[i:end])
	}
	return sb.String(), n
}

// r7cFeedEvents 把完整 SSE 事件串(每条以空行收尾)按行喂给 tracker,并返回
// (正文字节, 是否交付)。事件之间的空行是 SSE 的事件边界,必须按行喂入 ——
// 否则两条事件会被拼成一个 JSON。
func r7cFeedEvents(events []string) (int64, bool) {
	var tracker streamContentTracker
	var total int64
	delivered := false
	for _, ev := range events {
		for _, line := range strings.Split(ev, "\n") {
			if n, ok := tracker.observe(line); ok {
				total += n
				delivered = true
			}
		}
	}
	if n, ok := tracker.flush(); ok {
		total += n
		delivered = true
	}
	return total, delivered
}

// r7cTextPayload 是"落在 base64 字母表里的真实文本"(文档/代码/日志/粘贴的
// base64 常量),长度约 n 字节。
func r7cTextPayload(n int) string {
	const chunk = "QWxhZGRpbjpvcGVuc2VzYW1l" // 解码后是 "Adding:opensame"(纯文本)
	return strings.Repeat(chunk, n/len(chunk)+1)[:n]
}

// ---------------------------------------------------------------------------
// I7:rc3-1 —— 扫描线性 + 有界(性能型缺陷必须用测量钉住)
// ---------------------------------------------------------------------------

// TestR7cInlineBinaryScanIsLinearAndBounded:标记洪水(`;base64,` 重复)与
// 合格段洪水都必须在**常数预算**内完成。修复前:1 MiB 洪水 112.6 秒(二次方,
// 4× 数据 = 16× 时间);16 MiB 外推 ≈ 4.6 小时。这里同时钉住"超预算即整体
// 回落字节口径"(宁可多收,不可烧 CPU)。
func TestR7cInlineBinaryScanIsLinearAndBounded(t *testing.T) {
	buildFlood := func(bytes int) []byte {
		return []byte(`{"messages":[{"role":"user","content":"` +
			strings.Repeat(";base64,", bytes/len(";base64,")) + `"}]}`)
	}
	for _, mb := range []int{1, 16} {
		body := buildFlood(mb << 20)
		budget := 2 * time.Second
		if mb >= 16 {
			budget = 10 * time.Second // 修复前 ≈ 4.6 小时
		}
		start := time.Now()
		textBytes, blobTokens := stripInlineBinaryPayloads(body)
		elapsed := time.Since(start)
		t.Logf("%2d MiB 标记洪水 body=%d 字节 → %v(预算 %v)", mb, len(body), elapsed, budget)
		if elapsed > budget {
			t.Fatalf("内联二进制扫描在 %d MiB 标记洪水上耗时 %v > 预算 %v(二次方 CPU 回归:计量路径可被单请求打满)",
				mb, elapsed, budget)
		}
		// 纯标记流没有任何合法 data URI ⇒ 全量按文本计(不得被剥离成免费)。
		if textBytes != int64(len(body)) || blobTokens != 0 {
			t.Fatalf("%d MiB 标记洪水被误判成内联二进制: textBytes=%d blob=%d(应全量按文本计)",
				mb, textBytes, blobTokens)
		}
	}

	// 合格段洪水(16000 段):旧实现的 overlaps() 对每次命中线性扫 out(二次方)。
	var sb strings.Builder
	sb.WriteString(`{"c":[`)
	for i := 0; i < 16000; i++ {
		sb.WriteString(`{"url":"data:a/b;base64,`)
		sb.WriteString(strings.Repeat("QUJD", 20))
		sb.WriteString(`"},`)
	}
	sb.WriteString(`]}`)
	body := []byte(sb.String())
	start := time.Now()
	textBytes, _ := stripInlineBinaryPayloads(body)
	elapsed := time.Since(start)
	t.Logf("16000 个合格段 body=%d 字节 → %v", len(body), elapsed)
	if elapsed > 2*time.Second {
		t.Fatalf("合格段洪水扫描耗时 %v > 2s(段级二次方回归)", elapsed)
	}
	if textBytes != int64(len(body)) {
		t.Fatalf("超过段数上限后没有整体回落到字节口径: textBytes=%d body=%d", textBytes, len(body))
	}
}

// TestR7cMarkerFloodRequestStaysFastE2E:端到端 —— 一条 512 KiB 的标记洪水
// 请求(上游不报 usage ⇒ 走补估)的单请求墙钟。修复前 262 KB 就要 7.69 秒、
// 512 KB ≈ 28.7 秒、1 MiB ≈ 112.6 秒。
func TestR7cMarkerFloodRequestStaysFastE2E(t *testing.T) {
	const n = 512 << 10
	body := `{"model":"r3-model","messages":[{"role":"user","content":"` +
		strings.Repeat(";base64,", n/len(";base64,")) + `"}],"stream":true}`
	u := newR7bUpstream(t)
	u.silent = true // 上游不报 usage ⇒ 交付后同步走补估(修复前就是在这里烧 CPU)
	u.chunks, u.chunkText = 1, "ok"
	r, db, uid, token := newAuditR3GatewayAt(t, u.srv.URL, 100, 2, 8, 0)

	start := time.Now()
	w := doPost(t, r, "/v1/chat/completions", body, token, nil)
	elapsed := time.Since(start)
	rows := r5UsageRows(t, db, uid)
	t.Logf("请求体=%d 字节 标记=%d 个 → 单请求墙钟 %v(status=%d rows=%d)",
		len(body), n/len(";base64,"), elapsed, w.Code, len(rows))
	if w.Code != http.StatusOK || len(rows) != 1 {
		t.Fatalf("status=%d rows=%d body=%s", w.Code, len(rows), bodyHead(w))
	}
	if elapsed > 5*time.Second {
		t.Fatalf("单请求墙钟 %v > 5s(占 STREAM_IDLE_TIMEOUT 90s 的 %.0f%%):补估仍在请求 goroutine 里烧 CPU",
			elapsed, float64(elapsed)/float64(90*time.Second)*100)
	}
	// 输入侧仍必须按文本计费(不得因为"标记洪水"被当成二进制而免费);命中
	// 上下文窗口上限时按上限计(这是有意的少收取舍,不是"被剥离成 0")。
	want := int64(len(body)) / 4
	if want > maxEstimatedPromptTokens {
		want = maxEstimatedPromptTokens
	}
	if rows[0].Prompt != want {
		t.Fatalf("标记洪水的输入侧口径异常: pt=%d, want %d", rows[0].Prompt, want)
	}
}

// ---------------------------------------------------------------------------
// I8:rc3-2 —— 真实文本不得被"伪装成二进制"剥成免费
// ---------------------------------------------------------------------------

// TestR7cTextDressedAsBinaryIsStillBilledAsText:把真实文本放进各种"看起来
// 像内联二进制"的位置,**一个字节都不该被剥离**。修复前:仅
// `data:text/plain;base64,` 前缀就把 460 KB 文本剥成 384 token(少收 291×);
// Anthropic 的 {"data":"…"} 同样。判据必须是"真的能解码成二进制 + 挂在二进制
// 载体键下 + 二进制 mime",而不是"正文里出现了这串字样"。
func TestR7cTextDressedAsBinaryIsStillBilledAsText(t *testing.T) {
	text := r7cTextPayload(460_000)
	cases := []struct{ name, body string }{
		{"纯文本(基线)", `{"messages":[{"role":"user","content":"` + text + `"}]}`},
		{"data:text/plain;base64, 前缀", `{"messages":[{"role":"user","content":"data:text/plain;base64,` + text + `"}]}`},
		{"二进制 mime + content 载体", `{"messages":[{"role":"user","content":"data:image/png;base64,` + text + `"}]}`},
		{"二进制 mime + 二进制载体键(载荷是文本)", `{"image_url":{"url":"data:image/png;base64,` + text + `"}}`},
		{"大写 DATA: + 文本载荷", `{"image_url":{"url":"DATA:IMAGE/PNG;BASE64,` + text + `"}}`},
		{"裸 base64 载体键 + 文本", `{"source":{"type":"base64","media_type":"image/png","data":"` + text + `"}}`},
		{"代码里的 base64 常量", `{"messages":[{"role":"user","content":"const k = \"` + text + `\""}]}`},
		{"4096 位十六进制串", `{"messages":[{"role":"user","content":"` + strings.Repeat("deadbeef", 4096) + `"}]}`},
		{"重复字符长串", `{"messages":[{"role":"user","content":"` + strings.Repeat("P", 400_000) + `"}]}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			textBytes, blobTokens := stripInlineBinaryPayloads([]byte(c.body))
			tokens := estimateTokensFromBytes(textBytes) + blobTokens
			raw := int64(len(c.body)) / 4
			t.Logf("body=%7d text=%7d tokens=%7d(raw=%d)", len(c.body), textBytes, tokens, raw)
			if textBytes != int64(len(c.body)) {
				t.Fatalf("真实文本被剥离了 %d 字节(应一个字节都不剥): textBytes=%d body=%d",
					int64(len(c.body))-textBytes, textBytes, len(c.body))
			}
			if tokens != raw {
				t.Fatalf("文本口径不等于 4 字节/token: tokens=%d, want %d", tokens, raw)
			}
		})
	}
}

// TestR7cDataURIUnderbillIsClosedE2E:端到端复现 rc3-2 的少收面(真 PG + 真
// 网关 + 上游整条流不报 usage):460 KB 文本加不加 `data:…;base64,` 前缀,
// 落账的 prompt 必须**同量级**(修复前 408 vs 120019,少收 291×/0.239 元)。
func TestR7cDataURIUnderbillIsClosedE2E(t *testing.T) {
	text := r7cTextPayload(460_000)
	base := `{"model":"r3-model","messages":[{"role":"user","content":"`
	cases := []struct{ name, body string }{
		{"纯文本", base + text + `"}],"stream":true}`},
		{"data:text/plain;base64, 前缀", base + "data:text/plain;base64," + text + `"}],"stream":true}`},
		{"image/png 前缀 + 文本载荷", base + "data:image/png;base64," + text + `"}],"stream":true}`},
	}
	got := make([]int64, 0, len(cases))
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			u := newR7bUpstream(t)
			u.silent = true
			u.chunks, u.chunkText = 1, "答"
			r, db, uid, token := newAuditR3GatewayAt(t, u.srv.URL, 100, 2, 8, 0)
			w := doPost(t, r, "/v1/chat/completions", c.body, token, nil)
			rows := r5UsageRows(t, db, uid)
			if w.Code != http.StatusOK || len(rows) != 1 {
				t.Fatalf("status=%d rows=%d body=%s", w.Code, len(rows), bodyHead(w))
			}
			want := int64(len(c.body)) / 4
			t.Logf("body=%7d → pt=%d ct=%d cost=%.6f estimated=%v(want pt=%d)",
				len(c.body), rows[0].Prompt, rows[0].Completion, rows[0].Cost, rows[0].Estimated, want)
			// 前缀只增加 ≤32 字节 ⇒ 允许 8 token 的偏差;核心是"不许掉到 384"。
			if rows[0].Prompt < want-8 || rows[0].Prompt > want+8 {
				t.Fatalf("输入侧补估被 data: 字样压低: pt=%d, want ≈%d(真实文本口径)", rows[0].Prompt, want)
			}
			if !rows[0].Estimated {
				t.Fatalf("补估行必须打 estimated 标记: %+v", rows[0])
			}
			got = append(got, rows[0].Prompt)
		})
	}
	for i := 1; i < len(got); i++ {
		if diff := math.Abs(float64(got[i] - got[0])); diff > 8 {
			t.Fatalf("同一段文本换一种写法落账差 %.0f token(第 %d 例 %d vs 基线 %d):判据被形态穿透", diff, i, got[i], got[0])
		}
	}
}

// TestR7cGenuineInlineBinaryIsFoldedNotBilledByBytes:r7f1-1 的**目标形态**
// 不得退化 —— 真的内联图片必须按平台视觉口径(≤384/图)折算,而不是按
// base64 长度计费(1.5 MiB 图 = 375K token、×313 费用)。同时钉住 rc3-2 的
// 另一个方向:**文本部分仍全额计费**(折算不能把整条请求变免费),大小写混写、
// 折行、URL-safe base64 都要折算正确。
func TestR7cGenuineInlineBinaryIsFoldedNotBilledByBytes(t *testing.T) {
	payload := r7cBinaryBytes(1 << 20) // 1 MiB 真二进制
	b64 := base64.StdEncoding.EncodeToString(payload)
	wrapped, escapeExtra := r7cWrapEscaped(b64, 76)
	urlSafe := base64.RawURLEncoding.EncodeToString(payload)

	cases := []struct {
		name string
		body string
		// removed 是测试侧独立复算的"被剥离字节数"。
		removed int
		images  int
	}{
		{"标准 data URI", `{"image_url":{"url":"` + r7cDataURI("image/png", payload) + `"}}`, len(b64), 1},
		{"大写 DATA:/BASE64,", `{"image_url":{"url":"DATA:IMAGE/PNG;BASE64,` + b64 + `"}}`, len(b64), 1},
		{"折行 base64(JSON \\n 转义)", `{"image_url":{"url":"data:image/png;base64,` + wrapped + `"}}`, len(b64) + escapeExtra, 1},
		{"URL-safe base64", `{"image_url":{"url":"data:image/png;base64,` + urlSafe + `"}}`, len(urlSafe), 1},
		{"application/pdf", `{"file":{"data":"` + r7cDataURI("application/pdf", payload) + `"}}`, len(b64), 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			textBytes, blobTokens := stripInlineBinaryPayloads([]byte(c.body))
			tokens := estimateTokensFromBytes(textBytes) + blobTokens
			wantText := int64(len(c.body) - c.removed)
			raw := int64(len(c.body)) / 4
			t.Logf("body=%7d text=%7d(期望 %d) tokens=%7d blob=%d raw=%d",
				len(c.body), textBytes, wantText, tokens, blobTokens, raw)
			if textBytes != wantText {
				t.Fatalf("载荷之外的文本没有全额保留: textBytes=%d, want %d", textBytes, wantText)
			}
			// 折算后必须仍然**明显小于**裸字节口径(否则 r7f1-1 的多收面回来了)。
			if tokens >= raw/2 {
				t.Fatalf("内联图片仍按字节计费: tokens=%d ≥ raw/2=%d(1 MiB 图应折算成几百 token)", tokens, raw/2)
			}
			// 但也不能变成免费:至少按平台视觉口径付 384/图,且文本部分全额计。
			if blobTokens != r7bVisionImageTokenCap*int64(c.images) {
				t.Fatalf("图片折算口径异常: blob=%d, want %d", blobTokens, r7bVisionImageTokenCap*int64(c.images))
			}
			if minTokens := wantText/4 + r7bVisionImageTokenCap; tokens < minTokens {
				t.Fatalf("文本部分被折算吞掉: tokens=%d < %d(文本 %d 字节 + 384/图)", tokens, minTokens, wantText)
			}
		})
	}

	// 多图 + 嵌在长文本中间:每图 384,文本部分全额计。
	t.Run("多图嵌在长文本中", func(t *testing.T) {
		var sb strings.Builder
		sb.WriteString(`{"messages":[{"role":"user","content":[{"type":"text","text":"`)
		sb.WriteString(strings.Repeat("X", 200_000)) // 200 KB 真实提示词
		sb.WriteString(`"}`)
		const images = 10
		imgB64 := base64.StdEncoding.EncodeToString(r7cBinaryBytes(2300))
		for i := 0; i < images; i++ {
			sb.WriteString(`,{"type":"image_url","image_url":{"url":"data:image/png;base64,`)
			sb.WriteString(imgB64)
			sb.WriteString(`"}}`)
		}
		sb.WriteString(`]}]}`)
		body := sb.String()
		textBytes, blobTokens := stripInlineBinaryPayloads([]byte(body))
		tokens := estimateTokensFromBytes(textBytes) + blobTokens
		t.Logf("body=%d text=%d blob=%d tokens=%d", len(body), textBytes, blobTokens, tokens)
		if blobTokens != r7bVisionImageTokenCap*images {
			t.Fatalf("多图折算没有逐段累加: blob=%d, want %d", blobTokens, r7bVisionImageTokenCap*images)
		}
		if wantText := int64(len(body) - images*len(imgB64)); textBytes != wantText {
			t.Fatalf("文本部分没有全额计费: textBytes=%d, want %d", textBytes, wantText)
		}
		if tokens < int64(200_000)/4 {
			t.Fatalf("200 KB 文本被图片折算吞掉: tokens=%d", tokens)
		}
	})
}

// ---------------------------------------------------------------------------
// I9:rc3-3 —— 正文形态矩阵(交付过就必须计费)
// ---------------------------------------------------------------------------

// TestR7cStreamContentShapeMatrix:四协议 × 正文形态的**契约表**。正向形态
// (客户端真的收到正文)必须 delivered=true;负向形态(0 正文字节的失败流)
// 必须 false —— r7f1-2 与 rc3-3 是同一根轴的两端,不允许只满足一端。
func TestR7cStreamContentShapeMatrix(t *testing.T) {
	cases := []struct {
		name      string
		events    []string
		delivered bool
		wantBytes int64 // >0 = 至少这么多字节;0 = 不校验
	}{
		// ---- 正向:客户端真的收到了正文 ----
		{"chat content 字符串", []string{`data: {"choices":[{"delta":{"content":"你好"}}]}` + "\n\n"}, true, 6},
		{"chat reasoning_content", []string{`data: {"choices":[{"delta":{"reasoning_content":"想"}}]}` + "\n\n"}, true, 3},
		{"chat content 数组(多模态增量)", []string{`data: {"choices":[{"delta":{"content":[{"type":"text","text":"你好"}]}}]}` + "\n\n"}, true, 6},
		{"chat content 数组(output_text part)", []string{`data: {"choices":[{"delta":{"content":[{"type":"output_text","text":"hi"}]}}]}` + "\n\n"}, true, 2},
		{"chat choice.delta 为字符串", []string{`data: {"choices":[{"delta":"你好"}]}` + "\n\n"}, true, 6},
		{"chat tool_calls.arguments", []string{`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"a\":"}}]}}]}` + "\n\n"}, true, 5},
		{"chat function_call.arguments", []string{`data: {"choices":[{"delta":{"function_call":{"arguments":"{\"a\":"}}}]}` + "\n\n"}, true, 5},
		{"completions text", []string{`data: {"choices":[{"text":"你好"}]}` + "\n\n"}, true, 6},
		{"responses output_text.delta", []string{`data: {"type":"response.output_text.delta","delta":"你好"}` + "\n\n"}, true, 6},
		{"responses function_call_arguments.delta", []string{`data: {"type":"response.function_call_arguments.delta","delta":"{\"a\":"}` + "\n\n"}, true, 5},
		{"responses completed(只有全文,中转合并了增量)", []string{`data: {"type":"response.completed","response":{"output":[{"content":[{"type":"output_text","text":"你好"}]}]}}` + "\n\n"}, true, 6},
		{"responses output_text.done(全文)", []string{`data: {"type":"response.output_text.done","text":"你好"}` + "\n\n"}, true, 6},
		{"anthropic text_delta", []string{`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}` + "\n\n"}, true, 6},
		{"anthropic thinking_delta", []string{`data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"想"}}` + "\n\n"}, true, 3},
		{"anthropic input_json_delta", []string{`data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"a\":"}}` + "\n\n"}, true, 5},
		{"嵌套 delta", []string{`data: {"choices":[{"delta":{"delta":{"content":"你好"}}}]}` + "\n\n"}, true, 6},
		{"非 SSE:上游忽略 stream、整包 JSON", []string{`{"id":"x","choices":[{"message":{"content":"你好世界"}}],"usage":{"prompt_tokens":9,"completion_tokens":2}}` + "\n\n"}, true, 12},
		{"SSE 多 data 行拼一个 JSON", []string{"data: {\"choices\":[{\"delta\":\n", "data: {\"content\":\"你好世界\"}}]}\n\n"}, true, 12},
		{"SSE 多 data 行(截断的 JSON:保守按已交付)", []string{"data: {\"choices\":[{\"delta\":\n", "data: {\"content\":\"你好世界\"}}]\n\n"}, true, 1},
		{"event: + data: 两行(Anthropic)", []string{"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"你好\"}}\n\n"}, true, 6},
		{"末行没有空行收尾(上游直接断开)", []string{`data: {"choices":[{"delta":{"content":"你好"}}]}` + "\n\n"}, true, 6},
		{"未知正文形态(非元数据字段)", []string{`data: {"choices":[{"delta":{"upstream_new_field":"some content"}}]}` + "\n\n"}, true, 0},

		// ---- 负向:0 正文字节(不得计费) ----
		{"[DONE]", []string{"data: [DONE]\n"}, false, 0},
		{"空 delta", []string{`data: {"choices":[{"delta":{}}]}` + "\n\n"}, false, 0},
		{"finish_reason only", []string{`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}` + "\n\n"}, false, 0},
		{"只有 role 的首 chunk", []string{`data: {"choices":[{"delta":{"role":"assistant"}}]}` + "\n\n"}, false, 0},
		{"content 为 null", []string{`data: {"choices":[{"delta":{"content":null}}]}` + "\n\n"}, false, 0},
		{"content 为空串", []string{`data: {"choices":[{"delta":{"content":""}}]}` + "\n\n"}, false, 0},
		{"content 为空数组", []string{`data: {"choices":[{"delta":{"content":[]}}]}` + "\n\n"}, false, 0},
		{"纯 usage 行", []string{`data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2}}` + "\n\n"}, false, 0},
		{"上游 error 事件", []string{`data: {"error":{"message":"overloaded","type":"server_error"}}` + "\n\n"}, false, 0},
		{"error + [DONE]", []string{`data: {"error":{"message":"overloaded"}}` + "\n", "data: [DONE]\n"}, false, 0},
		{"注释/心跳", []string{": keep-alive\n\n"}, false, 0},
		{"event: 行单独", []string{"event: content_block_delta\n\n"}, false, 0},
		{"anthropic message_start(只有 usage)", []string{"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":5}}}\n"}, false, 0},
		{"anthropic message_delta(stop_reason)", []string{"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n"}, false, 0},
		{"anthropic content_block_start(空 text)", []string{"data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n"}, false, 0},
		{"responses created", []string{`data: {"type":"response.created","response":{"id":"x"}}` + "\n\n"}, false, 0},
		{"responses in_progress(空 delta)", []string{`data: {"type":"response.in_progress","response":{"id":"x"}}` + "\n\n"}, false, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			total, delivered := r7cFeedEvents(c.events)
			t.Logf("events=%q → bytes=%d delivered=%v", c.events, total, delivered)
			if delivered != c.delivered {
				t.Fatalf("正文形态判据错误: delivered=%v, want %v(bytes=%d)", delivered, c.delivered, total)
			}
			if c.wantBytes > 0 && total < c.wantBytes {
				t.Fatalf("正文字节被少算: bytes=%d, want ≥%d", total, c.wantBytes)
			}
		})
	}
}

// TestR7cDeliveredContentShapesAreSettledE2E:rc3-3 的端到端复现 —— 五种
// "客户端真的收到了正文"的流形态,每一种都必须留下 usage 行 + 费用 + 扣款
// (修复前 usage 行 = 0、cost = 0、余额不动:整条流免费且事后对账看不到)。
// 同时保留负向对照:0 正文字节的失败流仍然零落账(r7f1-2 不退化)。
func TestR7cDeliveredContentShapesAreSettledE2E(t *testing.T) {
	bigText := strings.Repeat("P", 400_000) // 400KB 请求体 ≈ 100019 估算 token
	chatBody := `{"model":"r3-model","messages":[{"role":"user","content":"` + bigText + `"}],"stream":true}`
	responsesBody := `{"model":"r3-model","input":"` + bigText + `","stream":true}`
	cases := []struct {
		name   string
		path   string
		body   string
		events []string
	}{
		{"A 标准 delta.content", "/v1/chat/completions", chatBody,
			[]string{`data: {"choices":[{"delta":{"content":"你好世界"}}]}` + "\n\n"}},
		{"B delta.content 数组", "/v1/chat/completions", chatBody,
			[]string{`data: {"choices":[{"delta":{"content":[{"type":"text","text":"你好世界"}]}}]}` + "\n\n"}},
		{"C 只有 response.completed", "/v1/responses", responsesBody,
			[]string{`data: {"type":"response.completed","response":{"output":[{"content":[{"type":"output_text","text":"你好世界"}]}]}}` + "\n\n"}},
		{"D 上游忽略 stream、回整包 JSON", "/v1/chat/completions", chatBody,
			[]string{`{"id":"x","choices":[{"message":{"content":"你好世界"}}]}` + "\n"}},
		{"E SSE 多 data 行拼 JSON", "/v1/chat/completions", chatBody,
			[]string{"data: {\"choices\":[{\"delta\":\n", "data: {\"content\":\"你好世界\"}}]}\n\n"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := r7cUpstream(t, c.events)
			r, db, uid, tok := newAuditR3GatewayAt(t, srv.URL, 100, 2, 8, 0)
			w := doPost(t, r, c.path, c.body, tok, nil)
			rows := r5UsageRows(t, db, uid)
			s := auditR3Snapshot(t, db, uid)
			t.Logf("status=%d 客户端收到=%d 字节 rows=%d cost=%.6f 余额=%.6f",
				w.Code, w.Body.Len(), len(rows), s.cost, s.balance)
			if w.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", w.Code, bodyHead(w))
			}
			if !strings.Contains(w.Body.String(), "你好世界") {
				t.Fatalf("夹具失效:客户端没有收到正文: %s", bodyHead(w))
			}
			if len(rows) != 1 {
				t.Fatalf("正文已交付的流没有留下计费痕迹: usage 行=%d(整条流免费)", len(rows))
			}
			if rows[0].Prompt <= 0 || rows[0].Cost <= 0 {
				t.Fatalf("正文已交付的流零落账: %+v", rows[0])
			}
			if math.Abs(s.balance-100) < 1e-9 {
				t.Fatalf("正文已交付的流没有扣款: 余额=%.6f", s.balance)
			}
			checkLedgerInvariant(t, s, "rc3-3 "+c.name)
		})
	}

	// D 形态 + 上游如实上报 usage:必须采信**真值**,而不是把整包 JSON 当
	// "没有 usage" 去按字节估算(prompt 侧方向是多收)。
	t.Run("D 形态带 usage 时采信真值", func(t *testing.T) {
		srv := r7cUpstream(t, []string{`{"id":"x","choices":[{"message":{"content":"你好世界"}}],"usage":{"prompt_tokens":9999,"completion_tokens":88}}` + "\n"})
		r, db, uid, tok := newAuditR3GatewayAt(t, srv.URL, 100, 2, 8, 0)
		w := doPost(t, r, "/v1/chat/completions", chatBody, tok, nil)
		rows := r5UsageRows(t, db, uid)
		if w.Code != http.StatusOK || len(rows) != 1 {
			t.Fatalf("status=%d rows=%d body=%s", w.Code, len(rows), bodyHead(w))
		}
		got := rows[0]
		t.Logf("整包 JSON + usage: pt=%d ct=%d cost=%.6f estimated=%v", got.Prompt, got.Completion, got.Cost, got.Estimated)
		if got.Prompt != 9999 || got.Completion != 88 {
			t.Fatalf("整包 JSON 里如实上报的 usage 被丢弃(把真值换成字节估算=多收): pt=%d ct=%d, want 9999/88", got.Prompt, got.Completion)
		}
		if got.Estimated {
			t.Fatalf("上游如实上报 usage 的行不得打 estimated 标记: %+v", got)
		}
	})

	// 负向对照:0 正文字节的失败流(r7f1-2 的契约)不得因为放宽判据而回归。
	t.Run("负向:error-only 仍零落账", func(t *testing.T) {
		srv := r7cUpstream(t, []string{`data: {"error":{"message":"overloaded"}}` + "\n\n"})
		r, db, uid, tok := newAuditR3GatewayAt(t, srv.URL, 100, 2, 8, 0)
		w := doPost(t, r, "/v1/chat/completions", chatBody, tok, nil)
		rows := r5UsageRows(t, db, uid)
		s := auditR3Snapshot(t, db, uid)
		t.Logf("status=%d rows=%d cost=%.6f 余额=%.6f", w.Code, len(rows), s.cost, s.balance)
		for _, r0 := range rows {
			if r0.Prompt > 0 || r0.Completion > 0 || r0.Cost > 0 {
				t.Fatalf("0 正文字节的失败流被计费: %+v", r0)
			}
		}
		if math.Abs(s.balance-100) > 1e-9 {
			t.Fatalf("0 正文字节的失败流扣了钱: 余额=%.6f", s.balance)
		}
	})
}

// ---------------------------------------------------------------------------
// I10:rc3-5 —— 上限跟随模型窗口 + 告警节流
// ---------------------------------------------------------------------------

// TestR7cPromptCapFollowsModelContextWindow:配置了 1M 上下文窗口的模型,补估
// 上限必须跟随窗口(4 MiB 纯文本 ≈ 1,048,578 token 不得被截到 131,072 ——
// 那是 8× 少收 / 单请求 27.53 元);没有配置/配置不可用时才落 128K 兜底。
func TestR7cPromptCapFollowsModelContextWindow(t *testing.T) {
	bigText := strings.Repeat("The quick brown fox jumps over the lazy dog. ", (4<<20)/45)
	body := `{"model":"r3-model","messages":[{"role":"user","content":"` + bigText + `"}],"stream":true}`
	rawTokens := int64(len(body)) / 4

	run := func(t *testing.T, defaultParams string) int64 {
		t.Helper()
		u := newR7bUpstream(t)
		u.silent, u.chunks, u.chunkText = true, 1, "ok"
		r, db, uid, token := newAuditR3GatewayAt(t, u.srv.URL, 1000, 2, 8, 0)
		if defaultParams != "" {
			// 直接写 default_params(夹具建表时不带参数),并失效进程内缓存。
			if _, err := db.Exec(`UPDATE models SET default_params = ? WHERE name = 'r3-model'`, defaultParams); err != nil {
				t.Fatal(err)
			}
			serverstore.InvalidateModelConfig()
		}
		promptEstimationClampMonitor.reset()
		w := doPost(t, r, "/v1/chat/completions", body, token, nil)
		rows := r5UsageRows(t, db, uid)
		if w.Code != http.StatusOK || len(rows) != 1 {
			t.Fatalf("status=%d rows=%d body=%s", w.Code, len(rows), bodyHead(w))
		}
		t.Logf("default_params=%q: 请求体 %d 字节(raw %d token)→ pt=%d cost=%.4f",
			defaultParams, len(body), rawTokens, rows[0].Prompt, rows[0].Cost)
		return rows[0].Prompt
	}

	fallback := run(t, "")
	if fallback != maxEstimatedPromptTokens {
		t.Fatalf("没有模型窗口配置时应落 128K 兜底: pt=%d, want %d", fallback, maxEstimatedPromptTokens)
	}
	withWindow := run(t, `{"context_length":1048576,"max_output":65536}`)
	if withWindow <= maxEstimatedPromptTokens {
		t.Fatalf("上限没有跟随模型上下文窗口(仍按 128K 截断): pt=%d, want > %d", withWindow, maxEstimatedPromptTokens)
	}
	if want := int64(1048576); withWindow != want {
		t.Fatalf("上限与模型窗口不一致: pt=%d, want %d(4 MiB 文本 ≈ %d token 被窗口封顶)", withWindow, want, rawTokens)
	}
	// 关键方向:少收比例被压回来了(旧口径 8×)。
	if ratio := float64(rawTokens) / float64(withWindow); ratio > 1.5 {
		t.Fatalf("1M 窗口模型的长上下文仍少收 %.2f×: raw=%d pt=%d", ratio, rawTokens, withWindow)
	}
}

// TestR7cPromptCapParsingCoversEquivalentSpellings:上下文窗口的**取值**要经得起
// 等价写法(不同键名/字符串数字/带小数),同时不能被垃圾配置或荒谬小值带偏
// (上限越小越少收,采信 0/负数等于把输入侧计价关掉)。
func TestR7cPromptCapParsingCoversEquivalentSpellings(t *testing.T) {
	cases := []struct {
		params string
		want   int64
		ok     bool
	}{
		{`{"context_length":1048576}`, 1048576, true},
		{`{"context_window":200000}`, 200000, true},
		{`{"max_context_tokens":262144}`, 262144, true},
		{`{"max_input":131072}`, 131072, true},
		{`{"max_input_tokens":32768}`, 32768, true},
		{`{"context":65536}`, 65536, true},
		{`{"context_length":1048576.0}`, 1048576, true},
		{`{"context_length":"524288"}`, 524288, true},
		{`{"max_output":65536,"context_length":1048576}`, 1048576, true},
		{`{"context_length":0}`, 0, false},
		{`{"context_length":-5}`, 0, false},
		{`{"context_length":16}`, 0, false}, // 荒谬小值:不采信(否则输入侧近乎免费)
		{`{"context_length":"abc"}`, 0, false},
		{`{"max_output":65536}`, 0, false},
		{``, 0, false},
		{`not-json`, 0, false},
	}
	for _, c := range cases {
		got, ok := promptTokenCapFromDefaultParams(c.params)
		if ok != c.ok || (ok && got != c.want) {
			t.Fatalf("promptTokenCapFromDefaultParams(%q) = (%d,%v), want (%d,%v)", c.params, got, ok, c.want, c.ok)
		}
	}
	// 取不到 ⇒ 兜底 128K(不是 0、也不是不封顶)。
	if got := promptEstimateCapForModel(nil, "m"); got != maxEstimatedPromptTokens {
		t.Fatalf("无 DB/无模型时没有落兜底: %d", got)
	}
}

// TestR7cPromptCapWarningIsThrottled:命中上限的告警必须**可见但不刷日志**
// (修复前每个命中请求一条;5 次请求 = 5 行,正常流量下线性增长)。
// 连续期结束(未命中上限的结算)后,新一轮仍要能告警。
func TestR7cPromptCapWarningIsThrottled(t *testing.T) {
	promptEstimationClampMonitor.reset()
	big := []byte(`{"messages":[{"role":"user","content":"` + strings.Repeat("P", 700<<10) + `"}]}`)

	var logs bytes.Buffer
	prevOut := log.Writer()
	log.SetOutput(&logs)
	defer log.SetOutput(prevOut)

	const n = 5
	for i := 0; i < n; i++ {
		toks, est := estimatePromptFallback(0, false, big, 0)
		if !est || toks != maxEstimatedPromptTokens {
			t.Fatalf("第 %d 次没有走「补估 + 命中上限」: toks=%d est=%v", i+1, toks, est)
		}
	}
	lines := strings.Split(strings.TrimRight(logs.String(), "\n"), "\n")
	t.Logf("%d 次命中上限 → %d 行告警", n, len(lines))
	if len(lines) != 1 {
		t.Fatalf("命中上限的告警没有节流: %d 次请求产生 %d 行日志(应只在连续期首条告警):\n%s", n, len(lines), logs.String())
	}
	if !strings.Contains(lines[0], "clamped") {
		t.Fatalf("告警文案不含 clamped,运维/测试都无法检索: %q", lines[0])
	}

	// 连续期结束(一次未命中上限的补估)→ 下一轮重新告警。
	logs.Reset()
	small := []byte(`{"messages":[{"role":"user","content":"hi"}]}`)
	if _, est := estimatePromptFallback(0, false, small, 0); !est {
		t.Fatalf("短请求应走补估")
	}
	if _, est := estimatePromptFallback(0, false, big, 0); !est {
		t.Fatalf("长请求应走补估")
	}
	if got := strings.Count(logs.String(), "clamped"); got != 1 {
		t.Fatalf("新一轮连续期没有重新告警(或重复告警): %d 行\n%s", got, logs.String())
	}
	// 不同窗口取值是不同诊断结论:窗口变化必须重新告警(这里用比 128K 更小的
	// 窗口,保证该请求确实命中上限)。
	logs.Reset()
	if _, est := estimatePromptFallback(0, false, big, 100_000); !est {
		t.Fatalf("长请求应走补估")
	}
	if got := strings.Count(logs.String(), "clamped"); got != 1 {
		t.Fatalf("窗口取值变化后没有重新告警: %d 行\n%s", got, logs.String())
	}
}

// ---------------------------------------------------------------------------
// rc3-6:只报 cache 的 usage 行不得关掉 OpenAI 路径的输入侧补估
// ---------------------------------------------------------------------------

// TestR7bCacheOnlyUsageLineStillEstimatesPrompt:上游只回
// `{"usage":{"prompt_cache_hit_tokens":500}}`(不带 prompt_tokens)时,
// OpenAI 路径必须**继续补估输入侧**(prompt_tokens 是必填字段,只报 cache 属
// 残缺报文;修复前 pt=0/cost=0.001008,本应 ≈0.2 元)。Anthropic 路径相反:
// 那里 input_tokens 不含 cache,"只报 cache_read"就是完整的输入侧口径,
// 必须原样采信(不许被估算覆盖)。
func TestR7bCacheOnlyUsageLineStillEstimatesPrompt(t *testing.T) {
	bigText := strings.Repeat("P", 400_000)
	content := `data: {"choices":[{"delta":{"content":"答"}}]}` + "\n\n"

	t.Run("chat 只报 cache", func(t *testing.T) {
		body := `{"model":"r3-model","messages":[{"role":"user","content":"` + bigText + `"}],"stream":true}`
		srv := r7cUpstream(t, []string{content, `data: {"usage":{"prompt_cache_hit_tokens":500}}` + "\n\n"})
		r, db, uid, tok := newAuditR3GatewayAt(t, srv.URL, 100, 2, 8, 8)
		w := doPost(t, r, "/v1/chat/completions", body, tok, nil)
		rows := r5UsageRows(t, db, uid)
		if w.Code != http.StatusOK || len(rows) != 1 {
			t.Fatalf("status=%d rows=%d body=%s", w.Code, len(rows), bodyHead(w))
		}
		got := rows[0]
		want := int64(len(body)) / 4
		t.Logf("只报 cache 的 chat 流: pt=%d ct=%d cache=%d cost=%.6f estimated=%v(want pt=%d)",
			got.Prompt, got.Completion, got.Cache, got.Cost, got.Estimated, want)
		if got.Prompt != want {
			t.Fatalf("只报 cache 的残缺报文关掉了输入侧补估: pt=%d, want %d(400KB 请求体的 4 字节/token 口径)", got.Prompt, want)
		}
		if got.Cache != 500 {
			t.Fatalf("上游上报的缓存命中数被丢弃: cache=%d, want 500", got.Cache)
		}
		if !got.Estimated {
			t.Fatalf("补估行必须打 estimated 标记: %+v", got)
		}
		// 费用口径:命中部分按缓存价、其余按输入价,不得因为补估而重复计价。
		wantCost := (float64(want-500)*2 + 500*8 + float64(got.Completion)*8) / 1e6
		if math.Abs(got.Cost-wantCost) > 1e-9 {
			t.Fatalf("费用口径异常: cost=%.9f, want %.9f(输入 %d-500 按 2 元/1M + 500 按缓存价 8 元/1M)", got.Cost, wantCost, want)
		}
	})

	t.Run("responses 只报 cache 明细", func(t *testing.T) {
		body := `{"model":"r3-model","input":"` + bigText + `","stream":true}`
		srv := r7cUpstream(t, []string{
			`data: {"type":"response.output_text.delta","delta":"答"}` + "\n\n",
			`data: {"type":"response.completed","response":{"usage":{"input_tokens_details":{"cached_tokens":500}}}}` + "\n\n",
		})
		r, db, uid, tok := newAuditR3GatewayAt(t, srv.URL, 100, 2, 8, 0)
		w := doPost(t, r, "/v1/responses", body, tok, nil)
		rows := r5UsageRows(t, db, uid)
		if w.Code != http.StatusOK || len(rows) != 1 {
			t.Fatalf("status=%d rows=%d body=%s", w.Code, len(rows), bodyHead(w))
		}
		got := rows[0]
		want := int64(len(body)) / 4
		t.Logf("只报 cache 明细的 responses 流: pt=%d cache=%d cost=%.6f(want pt=%d)", got.Prompt, got.Cache, got.Cost, want)
		if got.Prompt != want {
			t.Fatalf("只报缓存明细的残缺报文关掉了输入侧补估: pt=%d, want %d", got.Prompt, want)
		}
		if got.Cache != 500 {
			t.Fatalf("缓存明细被丢弃: cache=%d, want 500", got.Cache)
		}
	})

	t.Run("anthropic 只报 cache_read 仍是完整输入侧口径", func(t *testing.T) {
		body := `{"model":"r3-model","messages":[{"role":"user","content":"` + bigText + `"}],"max_tokens":16,"stream":true}`
		events := []string{
			"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":0,\"cache_read_input_tokens\":5000}}}\n\n",
			"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"答\"}}\n\n",
		}
		srv := r7cUpstream(t, events)
		r, db, uid, tok := newAuditR3GatewayAt(t, srv.URL, 100, 2, 8, 0)
		w := doPost(t, r, "/v1/messages", body, tok, nil)
		rows := r5UsageRows(t, db, uid)
		if w.Code != http.StatusOK || len(rows) != 1 {
			t.Fatalf("status=%d rows=%d body=%s", w.Code, len(rows), bodyHead(w))
		}
		got := rows[0]
		t.Logf("只报 cache_read 的 anthropic 流: pt=%d cache=%d cost=%.6f", got.Prompt, got.Cache, got.Cost)
		if got.Prompt != 5000 {
			t.Fatalf("Anthropic 的 cache_read 是完整输入侧口径(input 不含 cache),必须原样采信: pt=%d, want 5000", got.Prompt)
		}
	})
}

// TestR7cAggregateEventDoesNotDoubleCountIncremental:同一段文本先以增量交付、
// 再以收尾聚合事件(response.completed / output_text.done)重复出现时,正文
// 字节**只算一次** —— 否则 completion 估算会把同一段输出计两遍(多收)。
func TestR7cAggregateEventDoesNotDoubleCountIncremental(t *testing.T) {
	full := "你好世界" // 12 字节
	cases := []struct {
		name   string
		events []string
		want   int64
	}{
		{"增量 + completed 全文", []string{
			`data: {"type":"response.output_text.delta","delta":"你好世界"}` + "\n\n",
			`data: {"type":"response.completed","response":{"output":[{"content":[{"type":"output_text","text":"你好世界"}]}]}}` + "\n\n",
		}, int64(len(full))},
		{"增量 + output_text.done 全文", []string{
			`data: {"type":"response.output_text.delta","delta":"你好世界"}` + "\n\n",
			`data: {"type":"response.output_text.done","text":"你好世界"}` + "\n\n",
		}, int64(len(full))},
		{"只有 completed 全文(中转合并了增量)", []string{
			`data: {"type":"response.completed","response":{"output":[{"content":[{"type":"output_text","text":"你好世界"}]}]}}` + "\n\n",
		}, int64(len(full))},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			total, _ := r7cFeedEvents(c.events)
			t.Logf("events=%d → bytes=%d(期望 %d)", len(c.events), total, c.want)
			if total != c.want {
				t.Fatalf("聚合事件把同一段文本算了两次(completion 估算会多收): bytes=%d, want %d", total, c.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 自查:换等价写法打本轮新加的闸门(第三轮教训 —— 只堵报告点名的那一条形态
// 等于没修)。全部来自"把真实文本伪装成二进制"的同类变形,以及段数/探测预算
// 的边界。判据是"文本部分仍全额计费",而不是"某一条特判还在"。
// ---------------------------------------------------------------------------

func TestR7cStripGatesSurviveEquivalentDisguises(t *testing.T) {
	text := r7cTextPayload(460_000) // 全在 base64 字母表内的真实文本
	bin300k := base64.StdEncoding.EncodeToString(r7cBinaryBytes(300_000))
	short := base64.StdEncoding.EncodeToString(r7cBinaryBytes(40)) // < minDataURIPayload

	// 文本侧的等价伪装:一个字节都不许被剥离。
	textCases := []struct{ name, body string }{
		{"'=' 填充噪声混入文本", `{"image_url":{"url":"data:image/png;base64,` + text[:100] + "==" + text[100:] + `"}}`},
		{"svg+xml(文本型图片)载荷是文本", `{"image_url":{"url":"data:image/svg+xml;base64,` + text + `"}}`},
		{"二进制垫头 + 20 万文本(Base64 拼接)", `{"image_url":{"url":"data:image/png;base64,` +
			base64.StdEncoding.EncodeToString(append(append([]byte{}, r7cBinaryBytes(300)...), []byte(text[:200_000])...)) + `"}}`},
		{"载体键与 data: 相隔 1KB", `{"url":"` + strings.Repeat("x", 1000) + `"data:image/png;base64,` + bin300k + `"}`},
		{"mime 区域超过 128 字节", `{"url":"data:image/png;` + strings.Repeat("a", 200) + `base64,` + bin300k + `"}`},
		{"未登记的 mime", `{"url":"data:application/x-custom;base64,` + bin300k + `"}`},
		{"大写载体键(JSON 键大小写敏感)", `{"URL":"DATA:IMAGE/PNG;BASE64,` + bin300k + `"}`},
	}
	for _, c := range textCases {
		t.Run(c.name, func(t *testing.T) {
			textBytes, blobTokens := stripInlineBinaryPayloads([]byte(c.body))
			t.Logf("body=%d text=%d blob=%d", len(c.body), textBytes, blobTokens)
			if textBytes != int64(len(c.body)) || blobTokens != 0 {
				t.Fatalf("真实文本被折算: textBytes=%d blob=%d, body=%d(应全额按文本计)",
					textBytes, blobTokens, len(c.body))
			}
		})
	}

	// 段数上限:超过 maxInlineBinarySegments 段即**整体回落**字节口径
	// (这是"剥离总量可控"的兜底,不是逐段截断)。
	imgs := func(n int) string {
		var sb strings.Builder
		sb.WriteString(`{"c":[`)
		for i := 0; i < n; i++ {
			sb.WriteString(`{"url":"data:image/png;base64,`)
			sb.WriteString(base64.StdEncoding.EncodeToString(r7cBinaryBytes(2000)))
			sb.WriteString(`"},`)
		}
		sb.WriteString(`]}`)
		return sb.String()
	}
	for _, c := range []struct {
		images     int
		wantBlob   int64
		wantFolded bool
	}{
		{10, 3840, true},
		{int(maxInlineBinarySegments), 384 * int64(maxInlineBinarySegments), true},
		{int(maxInlineBinarySegments) + 1, 0, false},
	} {
		body := imgs(c.images)
		textBytes, blobTokens := stripInlineBinaryPayloads([]byte(body))
		t.Logf("%d 张真图: body=%d text=%d blob=%d", c.images, len(body), textBytes, blobTokens)
		if blobTokens != c.wantBlob {
			t.Fatalf("%d 张图的折算口径异常: blob=%d, want %d(超过段数上限应整体回落字节口径)",
				c.images, blobTokens, c.wantBlob)
		}
		if c.wantFolded && textBytes >= int64(len(body)) {
			t.Fatalf("%d 张真图没有折算(text=%d body=%d)", c.images, textBytes, len(body))
		}
	}

	// 短载荷(<64 字节)不值得折算,也不该被折算 —— 无论如何都按文本计。
	t.Run("短二进制载荷(<64 字节)", func(t *testing.T) {
		body := `{"image_url":{"url":"data:image/png;base64,` + short + `"}}`
		textBytes, blobTokens := stripInlineBinaryPayloads([]byte(body))
		if textBytes != int64(len(body)) || blobTokens != 0 {
			t.Fatalf("短载荷被折算: text=%d blob=%d body=%d", textBytes, blobTokens, len(body))
		}
	})

	// 混合形态:一张真图 + 一段文本载荷 ⇒ 只有真图折算,文本载荷全额计费。
	t.Run("真图与文本载荷混合", func(t *testing.T) {
		body := `{"c":[{"url":"data:image/png;base64,` + bin300k + `"},{"url":"data:image/png;base64,` + text + `"}]}`
		textBytes, blobTokens := stripInlineBinaryPayloads([]byte(body))
		if blobTokens != r7bVisionImageTokenCap {
			t.Fatalf("真图未折算: blob=%d, want %d", blobTokens, r7bVisionImageTokenCap)
		}
		if want := int64(len(body) - len(bin300k)); textBytes != want {
			t.Fatalf("文本载荷没有全额计费: textBytes=%d, want %d", textBytes, want)
		}
	})
}
