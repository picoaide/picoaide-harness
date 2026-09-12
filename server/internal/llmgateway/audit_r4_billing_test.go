package llmgateway

// 审计 r3 第四轮计费回归(N1 / N2 / N3 + 「顺手核对」的四种 usage 形态)。
//
// 全部用例都是**真机**:真 PG(serverstore.NewTestDB → 临时库 + 全量迁移)+
// 真 gin 路由(RegisterRoutes,与生产同一张路由表)+ 真上游(httptest 假上游)+
// 真 socket(doPost 走 httptest.Server,不是 NewRecorder)。
//
// 三条被钉住的口径:
//   - N1:流式只要**任一侧没有可用用量**(缺失 / 0)就走 settleStreamFallback,
//     由函数内部只补 completion 缺失的那一半 —— 已上报的 pt/cache 原样带出,
//     绝不被估算覆盖;
//   - N2:非流式**任何**交付都要有一行可对账的账(缺 usage / null / 空对象 /
//     只有 total_tokens / 未知字段名),估算与流式同源(已交付字节/4);
//   - N3:OpenAI chat 的 prompt_tokens_details.cached_tokens 与 Responses 的
//     input_tokens_details.cached_tokens 走**同一份**实现,缓存命中按缓存价;
//   - 反"凭空多扣":估算只补缺失/为 0 的一侧,永不叠加到已上报的正值上,
//     total_tokens 不会被拆成两侧,负值不会被翻转,一次交付只落一行。

import (
	"database/sql"
	"math"
	"net/http"
	"strings"
	"testing"
)

// r4Row 是一行 usage 的逐侧明细。
type r4Row struct {
	Kind       string
	Prompt     int64
	Cache      int64
	Completion int64
	Cost       float64
}

func r4Rows(t *testing.T, db *sql.DB, uid int64) []r4Row {
	t.Helper()
	rs, err := db.Query(`SELECT kind, prompt_tokens, cache_prompt_tokens, completion_tokens, cost
		FROM usage WHERE user_id = ? ORDER BY id`, uid)
	if err != nil {
		t.Fatal(err)
	}
	defer rs.Close()
	var out []r4Row
	for rs.Next() {
		var r r4Row
		if err := rs.Scan(&r.Kind, &r.Prompt, &r.Cache, &r.Completion, &r.Cost); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

// r4Estimate 是测试侧独立复算的字节估算(与实现同口径:已交付字节/4)。
// 刻意在测试里重算一遍,而不是引用实现常量 —— 实现若改了口径,这里必须红。
func r4Estimate(deliveredBytes int) int64 {
	if deliveredBytes <= 0 {
		return 0
	}
	return int64(deliveredBytes) / 4
}

// ---------------------------------------------------------------------------
// N1:流式「只回报一侧」必须走兜底(chat + Anthropic;只报 pt / 只报 ct)
// ---------------------------------------------------------------------------

func TestR4ChatStreamInputOnlyUsageEstimatesCompletion(t *testing.T) {
	content := strings.Repeat("B", 8000)
	stream := "data: {\"choices\":[{\"delta\":{\"content\":\"" + content + "\"}}]}\n\n" +
		"data: {\"usage\":{\"prompt_tokens\":10}}\n\n" +
		"data: [DONE]\n\n"
	u := newAuditR3Upstream(t)
	u.setStream(stream)
	// 定价:输入 2 元/1M、输出 8 元/1M、缓存 0.2 元/1M
	r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)

	w := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[],"stream":true}`, token, nil)
	rows := r4Rows(t, db, uid)
	s := auditR3Snapshot(t, db, uid)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), content) {
		t.Fatalf("流内容未交付: status=%d body=%s", w.Code, bodyHead(w))
	}
	if len(rows) != 1 {
		t.Fatalf("usage 行数 = %d, want 1", len(rows))
	}
	got := rows[0]
	t.Logf("N1 chat 只报 pt: prompt=%d cache=%d completion=%d cost=%.6f balance=%.6f",
		got.Prompt, got.Cache, got.Completion, got.Cost, s.balance)
	if got.Prompt != 10 {
		t.Fatalf("已上报的 prompt_tokens 被改写: %d, want 10(估算不得覆盖已上报的 pt)", got.Prompt)
	}
	if got.Completion <= 0 {
		t.Fatalf("只回报输入侧时 completion 未估算: completion=%d(8000 字节内容分文不计)", got.Completion)
	}
	// 金额必须精确 = 输入侧照收(已上报的 10) + 输出侧估算(缺的一侧)。
	wantCost := 10*2/1e6 + float64(got.Completion)*8/1e6
	if diff := got.Cost - wantCost; diff > 1e-9 || diff < -1e-9 {
		t.Fatalf("cost = %.9f, want %.9f(输入侧照收 + 输出侧估算)", got.Cost, wantCost)
	}
	if s.kinds[ledgerKindConsume] < 1 {
		t.Fatalf("应有 consume 流水, got %v", s.kinds)
	}
	// 允许出现多条 consume 流水(usage 行先按已上报值结算、收尾估算再补差额 ——
	// 崩溃/断连时已上报的部分已经落账),但**净额**必须恰好等于本次费用。
	if math.Abs(s.balance-(100-got.Cost)) > 1e-9 {
		t.Fatalf("净扣费 != cost: balance=%.9f cost=%.9f ledger=%v", s.balance, got.Cost, s.kinds)
	}
	checkLedgerInvariant(t, s, "N1 chat 只报 pt")
}

func TestR4ChatStreamCompletionOnlyUsageKeepsReportedValue(t *testing.T) {
	u := newAuditR3Upstream(t)
	u.setStream("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n" +
		"data: {\"usage\":{\"completion_tokens\":500}}\n\n" +
		"data: [DONE]\n\n")
	r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)

	w := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[],"stream":true}`, token, nil)
	rows := r4Rows(t, db, uid)
	s := auditR3Snapshot(t, db, uid)
	if w.Code != http.StatusOK || len(rows) != 1 {
		t.Fatalf("status=%d rows=%d body=%s", w.Code, len(rows), bodyHead(w))
	}
	got := rows[0]
	t.Logf("N1 chat 只报 ct: prompt=%d completion=%d cost=%.6f", got.Prompt, got.Completion, got.Cost)
	if got.Completion != 500 {
		t.Fatalf("已上报的 completion_tokens 被估算改写: %d, want 500", got.Completion)
	}
	if got.Prompt != 0 {
		t.Fatalf("prompt 侧没有被上报,必须保持 0(响应字节推不出输入): %d", got.Prompt)
	}
	if want := 500 * 8 / 1e6; got.Cost != want {
		t.Fatalf("cost=%.9f, want %.9f(只按已上报的 completion 计一次)", got.Cost, want)
	}
	checkLedgerInvariant(t, s, "N1 chat 只报 ct")
}

func TestR4AnthropicStreamInputOnlyUsageEstimatesCompletion(t *testing.T) {
	content := strings.Repeat("C", 8000)
	u := newAuditR3Upstream(t)
	u.setStream("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"cache_read_input_tokens\":0}}}\n\n" +
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"" + content + "\"}}\n\n")
	r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)

	w := doPost(t, r, "/v1/messages", `{"model":"r3-model","messages":[],"stream":true}`, token, nil)
	rows := r4Rows(t, db, uid)
	s := auditR3Snapshot(t, db, uid)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), content) {
		t.Fatalf("流内容未交付: status=%d body=%s", w.Code, bodyHead(w))
	}
	if len(rows) != 1 {
		t.Fatalf("usage 行数 = %d, want 1", len(rows))
	}
	got := rows[0]
	t.Logf("N1 anthropic 只报 pt: kind=%s prompt=%d cache=%d completion=%d cost=%.6f",
		got.Kind, got.Prompt, got.Cache, got.Completion, got.Cost)
	if got.Prompt != 10 {
		t.Fatalf("已上报的 input_tokens 被改写: %d, want 10", got.Prompt)
	}
	if got.Completion <= 0 {
		t.Fatalf("message_start 之后断流时 completion 未估算: completion=%d", got.Completion)
	}
	if got.Cost <= 10*2/1e6 {
		t.Fatalf("费用只有输入侧: cost=%.6f", got.Cost)
	}
	checkLedgerInvariant(t, s, "N1 anthropic 只报 pt")
}

func TestR4AnthropicStreamCompletionOnlyUsageKeepsReportedValue(t *testing.T) {
	u := newAuditR3Upstream(t)
	u.setStream("event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":700}}\n\n" +
		"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)

	w := doPost(t, r, "/v1/messages", `{"model":"r3-model","messages":[],"stream":true}`, token, nil)
	rows := r4Rows(t, db, uid)
	s := auditR3Snapshot(t, db, uid)
	if w.Code != http.StatusOK || len(rows) != 1 {
		t.Fatalf("status=%d rows=%d body=%s", w.Code, len(rows), bodyHead(w))
	}
	got := rows[0]
	t.Logf("N1 anthropic 只报 ct: prompt=%d completion=%d cost=%.6f", got.Prompt, got.Completion, got.Cost)
	if got.Completion != 700 {
		t.Fatalf("已上报的 output_tokens 被估算改写: %d, want 700", got.Completion)
	}
	if want := 700 * 8 / 1e6; got.Cost != want {
		t.Fatalf("cost=%.9f, want %.9f", got.Cost, want)
	}
	checkLedgerInvariant(t, s, "N1 anthropic 只报 ct")
}

// ---------------------------------------------------------------------------
// N2:非流式缺 usage 的确定性估算兜底(chat / responses / messages / embeddings)
// ---------------------------------------------------------------------------

func TestR4NonStreamMissingUsageStillBilled(t *testing.T) {
	cases := []struct {
		name  string
		usage string // 上游 usage 片段(或完全不含 usage 的形态)
	}{
		{"no-usage", `"note":"no usage field at all"`},
		{"null-usage", `"usage":null`},
		{"empty-object", `"usage":{}`},
		{"total-only", `"usage":{"total_tokens":12345}`},
		{"unknown-fields", `"usage":{"input_token_count":999,"output_token_count":999}`},
	}
	for _, tc := range cases {
		t.Run("responses_"+tc.name, func(t *testing.T) {
			body := `{"id":"x","object":"response","output":[{"content":[{"text":"R4_PAID_CONTENT"}]}],` + tc.usage + `}`
			u := newAuditR3Upstream(t)
			u.setNon(body)
			r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)

			w := doPost(t, r, "/v1/responses", `{"model":"r3-model","input":"hi"}`, token, nil)
			rows := r4Rows(t, db, uid)
			s := auditR3Snapshot(t, db, uid)
			if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "R4_PAID_CONTENT") {
				t.Fatalf("内容未交付: status=%d body=%s", w.Code, bodyHead(w))
			}
			if len(rows) != 1 {
				t.Fatalf("usage 行数 = %d, want 1(交付必须有账)", len(rows))
			}
			got := rows[0]
			want := r4Estimate(len(body))
			t.Logf("N2 %s: prompt=%d completion=%d cost=%.6f wantCompletion=%d balance=%.6f",
				tc.name, got.Prompt, got.Completion, got.Cost, want, s.balance)
			if got.Prompt != 0 {
				t.Fatalf("prompt 侧不该被估算(响应字节推不出输入): %d", got.Prompt)
			}
			if got.Completion != want {
				t.Fatalf("估算 completion = %d, want %d(已交付 %d 字节 / 4,确定性)", got.Completion, want, len(body))
			}
			if wantCost := float64(want) * 8 / 1e6; got.Cost != wantCost {
				t.Fatalf("cost = %.9f, want %.9f", got.Cost, wantCost)
			}
			if s.kinds[ledgerKindConsume] != 1 {
				t.Fatalf("应有 1 笔 consume 流水, got %v", s.kinds)
			}
			checkLedgerInvariant(t, s, "N2 "+tc.name)
		})
	}

	t.Run("chat_no_usage", func(t *testing.T) {
		body := `{"id":"x","object":"chat.completion","choices":[{"message":{"content":"R4_PAID_CONTENT"}}]}`
		u := newAuditR3Upstream(t)
		u.setNon(body)
		r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)
		w := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[]}`, token, nil)
		rows := r4Rows(t, db, uid)
		s := auditR3Snapshot(t, db, uid)
		if w.Code != http.StatusOK || len(rows) != 1 {
			t.Fatalf("status=%d rows=%d body=%s", w.Code, len(rows), bodyHead(w))
		}
		if rows[0].Completion != r4Estimate(len(body)) || rows[0].Cost <= 0 {
			t.Fatalf("chat 缺 usage 未计费: completion=%d cost=%.6f", rows[0].Completion, rows[0].Cost)
		}
		checkLedgerInvariant(t, s, "N2 chat 缺 usage")
	})

	t.Run("messages_no_usage", func(t *testing.T) {
		body := `{"id":"m","type":"message","content":[{"type":"text","text":"R4_PAID_CONTENT"}]}`
		u := newAuditR3Upstream(t)
		u.setNon(body)
		r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)
		w := doPost(t, r, "/v1/messages", `{"model":"r3-model","messages":[]}`, token, nil)
		rows := r4Rows(t, db, uid)
		s := auditR3Snapshot(t, db, uid)
		if w.Code != http.StatusOK || len(rows) != 1 {
			t.Fatalf("status=%d rows=%d body=%s", w.Code, len(rows), bodyHead(w))
		}
		if rows[0].Kind != "search" {
			t.Fatalf("kind = %q, want search", rows[0].Kind)
		}
		if rows[0].Completion != r4Estimate(len(body)) || rows[0].Cost <= 0 {
			t.Fatalf("anthropic 非流式缺 usage 未计费: completion=%d cost=%.6f", rows[0].Completion, rows[0].Cost)
		}
		checkLedgerInvariant(t, s, "N2 messages 缺 usage")
	})

	t.Run("determinism_two_identical_requests", func(t *testing.T) {
		body := `{"id":"x","object":"response","output":[],"usage":{"total_tokens":12345}}`
		u := newAuditR3Upstream(t)
		u.setNon(body)
		r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)
		for i := 0; i < 2; i++ {
			if w := doPost(t, r, "/v1/responses", `{"model":"r3-model","input":"hi"}`, token, nil); w.Code != http.StatusOK {
				t.Fatalf("第 %d 次 status=%d body=%s", i+1, w.Code, bodyHead(w))
			}
		}
		rows := r4Rows(t, db, uid)
		if len(rows) != 2 {
			t.Fatalf("usage 行数 = %d, want 2(每次交付一行,不合并也不重复)", len(rows))
		}
		if rows[0].Prompt != rows[1].Prompt || rows[0].Completion != rows[1].Completion || rows[0].Cost != rows[1].Cost {
			t.Fatalf("同一上游报文两次交付的估算不一致(非确定性): %+v vs %+v", rows[0], rows[1])
		}
		s := auditR3Snapshot(t, db, uid)
		if s.kinds[ledgerKindConsume] != 2 {
			t.Fatalf("应有 2 笔 consume 流水, got %v", s.kinds)
		}
		checkLedgerInvariant(t, s, "N2 确定性")
	})

	t.Run("upstream_4xx_not_estimated", func(t *testing.T) {
		// 4xx 上游错误体不是交付内容:不得因为"缺 usage"就凭空估算出费用。
		for _, tc := range []struct{ name, path, req string }{
			{"chat", "/v1/chat/completions", `{"model":"r3-model","messages":[]}`},
			{"responses", "/v1/responses", `{"model":"r3-model","input":"hi"}`},
			{"messages", "/v1/messages", `{"model":"r3-model","messages":[]}`},
		} {
			u := newAuditR3Upstream(t)
			u.setNon(`{"error":{"message":"bad request","content":"R4_ERR_BODY"}}`)
			u.mu.Lock()
			u.statusCode = http.StatusBadRequest
			u.mu.Unlock()
			r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)
			w := doPost(t, r, tc.path, tc.req, token, nil)
			s := auditR3Snapshot(t, db, uid)
			t.Logf("N2 4xx %s: status=%d usage_rows=%d balance=%.6f", tc.name, w.Code, s.usageRows, s.balance)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("%s status = %d, want 400", tc.name, w.Code)
			}
			if s.usageRows != 0 || s.balance != 100 {
				t.Fatalf("%s 4xx 不得计费: rows=%d balance=%.6f", tc.name, s.usageRows, s.balance)
			}
			checkLedgerInvariant(t, s, "N2 4xx "+tc.name)
		}
	})
}

func TestR4EmbeddingsWithoutUsageStillBilled(t *testing.T) {
	t.Run("no_usage", func(t *testing.T) {
		u := newAuditR3Upstream(t)
		u.set(&u.embed, `{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.5,0.25]}],"model":"r3-model"}`)
		r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)
		w := doPost(t, r, "/v1/embeddings", `{"model":"r3-model","input":["hello world"]}`, token, nil)
		rows := r4Rows(t, db, uid)
		s := auditR3Snapshot(t, db, uid)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "0.5") {
			t.Fatalf("向量未交付: status=%d body=%s", w.Code, bodyHead(w))
		}
		if len(rows) != 1 {
			t.Fatalf("usage 行数 = %d, want 1", len(rows))
		}
		got := rows[0]
		t.Logf("N2 embeddings 缺 usage: kind=%s prompt=%d completion=%d cost=%.6f", got.Kind, got.Prompt, got.Completion, got.Cost)
		// 输入 "hello world" = 11 字节 → 11/4 = 2 token(同一份字节估算口径)
		if got.Kind != "embedding" || got.Prompt != 2 || got.Completion != 0 {
			t.Fatalf("embedding 估算口径不符: %+v", got)
		}
		if want := 2 * 2 / 1e6; got.Cost != want {
			t.Fatalf("cost = %.9f, want %.9f", got.Cost, want)
		}
		checkLedgerInvariant(t, s, "N2 embeddings")
	})

	t.Run("prompt_tokens_only_reported", func(t *testing.T) {
		// 上游只报 prompt_tokens(没有 total_tokens)时,embedding 的用量就是它,
		// 不得因为 total 缺失而退化成估算(少收)。
		u := newAuditR3Upstream(t)
		u.set(&u.embed, `{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.5,0.25]}],"model":"r3-model","usage":{"prompt_tokens":1234}}`)
		r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)
		w := doPost(t, r, "/v1/embeddings", `{"model":"r3-model","input":["hello world"]}`, token, nil)
		rows := r4Rows(t, db, uid)
		if w.Code != http.StatusOK || len(rows) != 1 {
			t.Fatalf("status=%d rows=%d", w.Code, len(rows))
		}
		if rows[0].Prompt != 1234 {
			t.Fatalf("prompt_tokens = %d, want 1234(上游已上报,不得退化成字节估算)", rows[0].Prompt)
		}
	})
}

// ---------------------------------------------------------------------------
// N3:OpenAI prompt_tokens_details.cached_tokens（与 Responses 明细同源）
// ---------------------------------------------------------------------------

func TestR4OpenAICachedDetailsSharedImplementation(t *testing.T) {
	const (
		cacheDetails = `"prompt_tokens_details":{"cached_tokens":900}`
		respDetails  = `"input_tokens_details":{"cached_tokens":900}`
	)
	// 定价 2/8/0.2:1000 输入中 900 命中 → 100×2 + 900×0.2 + 500×8 = 0.004380
	// 未识别缓存(全价)= 1000×2 + 500×8 = 0.006000
	cases := []struct {
		name      string
		usage     string
		wantCache int64
		wantCost  float64
	}{
		{"openai_chat_details", `"prompt_tokens":1000,"completion_tokens":500,` + cacheDetails, 900, 0.004380},
		{"responses_details", `"input_tokens":1000,"output_tokens":500,` + respDetails, 900, 0.004380},
		{"no_details_full_price", `"prompt_tokens":1000,"completion_tokens":500`, 0, 0.006000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			u := newAuditR3Upstream(t)
			u.setNon(`{"id":"x","object":"chat.completion","choices":[{"message":{"content":"hi"}}],"usage":{` + tc.usage + `}}`)
			r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)
			w := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[]}`, token, nil)
			rows := r4Rows(t, db, uid)
			s := auditR3Snapshot(t, db, uid)
			if w.Code != http.StatusOK || len(rows) != 1 {
				t.Fatalf("status=%d rows=%d body=%s", w.Code, len(rows), bodyHead(w))
			}
			got := rows[0]
			t.Logf("N3 %s: cache=%d prompt=%d completion=%d cost=%.6f balance=%.6f",
				tc.name, got.Cache, got.Prompt, got.Completion, got.Cost, s.balance)
			if got.Cache != tc.wantCache {
				t.Fatalf("cache = %d, want %d", got.Cache, tc.wantCache)
			}
			if diff := got.Cost - tc.wantCost; diff > 1e-9 || diff < -1e-9 {
				t.Fatalf("cost = %.6f, want %.6f", got.Cost, tc.wantCost)
			}
			checkLedgerInvariant(t, s, "N3 "+tc.name)
		})
	}

	t.Run("stream_usage_line", func(t *testing.T) {
		u := newAuditR3Upstream(t)
		u.setStream("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n" +
			"data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":1000,\"completion_tokens\":500," + cacheDetails + "}}\n\n" +
			"data: [DONE]\n\n")
		r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)
		w := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[],"stream":true}`, token, nil)
		rows := r4Rows(t, db, uid)
		s := auditR3Snapshot(t, db, uid)
		if w.Code != http.StatusOK || len(rows) != 1 {
			t.Fatalf("status=%d rows=%d body=%s", w.Code, len(rows), bodyHead(w))
		}
		got := rows[0]
		t.Logf("N3 流式明细: cache=%d cost=%.6f", got.Cache, got.Cost)
		if got.Cache != 900 {
			t.Fatalf("流式 usage 行的缓存明细未识别: cache=%d, want 900", got.Cache)
		}
		if diff := got.Cost - 0.004380; diff > 1e-9 || diff < -1e-9 {
			t.Fatalf("cost = %.6f, want 0.004380", got.Cost)
		}
		checkLedgerInvariant(t, s, "N3 流式明细")
	})
}

// ---------------------------------------------------------------------------
// 顺手核对:total_tokens 单字段 / 两套字段名显式 0 / 负数 / usage:null
// 的语义 —— 只允许"已上报的正值"与"缺失侧的估算"二选一,绝不叠加。
// ---------------------------------------------------------------------------

func TestR4UsageShapesNoDoubleCharge(t *testing.T) {
	cases := []struct {
		name       string
		usage      string
		wantPrompt int64
		// wantCompletion >= 0 时按该值断言;否则按已交付字节/4 估算。
		wantCompletion int64
	}{
		{"total_tokens_only", `"usage":{"total_tokens":12345}`, 0, -1},
		{"both_sets_explicit_zero", `"usage":{"prompt_tokens":0,"completion_tokens":0,"input_tokens":0,"output_tokens":0}`, 0, -1},
		{"negative_values", `"usage":{"prompt_tokens":-1000000,"completion_tokens":-1000000}`, 0, -1},
		{"usage_null", `"usage":null`, 0, -1},
		{"chat_set_positive_wins", `"usage":{"prompt_tokens":7,"completion_tokens":9,"input_tokens":900000,"output_tokens":900000}`, 7, 9},
		{"positive_completion_never_estimated", `"usage":{"prompt_tokens":1000,"completion_tokens":1}`, 1000, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := `{"id":"x","object":"chat.completion","choices":[{"message":{"content":"R4_CONTENT"}}],` + tc.usage + `}`
			u := newAuditR3Upstream(t)
			u.setNon(body)
			r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)
			w := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[]}`, token, nil)
			rows := r4Rows(t, db, uid)
			s := auditR3Snapshot(t, db, uid)
			if w.Code != http.StatusOK || len(rows) != 1 {
				t.Fatalf("status=%d rows=%d body=%s(一次交付只允许一行)", w.Code, len(rows), bodyHead(w))
			}
			got := rows[0]
			wantCompletion := tc.wantCompletion
			if wantCompletion < 0 {
				wantCompletion = r4Estimate(len(body))
			}
			t.Logf("形态 %s: prompt=%d completion=%d cost=%.9f (want %d/%d) balance=%.6f",
				tc.name, got.Prompt, got.Completion, got.Cost, tc.wantPrompt, wantCompletion, s.balance)
			if got.Prompt != tc.wantPrompt {
				t.Fatalf("prompt = %d, want %d(total_tokens/另一套字段名不得被拆成输入侧)", got.Prompt, tc.wantPrompt)
			}
			if got.Completion != wantCompletion {
				t.Fatalf("completion = %d, want %d", got.Completion, wantCompletion)
			}
			// 金额必须精确等于「已采信的上报值 + 缺失侧的估算」,叠加/双计都会超。
			wantCost := float64(tc.wantPrompt)*2/1e6 + float64(wantCompletion)*8/1e6
			if diff := got.Cost - wantCost; diff > 1e-9 || diff < -1e-9 {
				t.Fatalf("cost = %.9f, want %.9f(疑似重复计费或凭空多扣)", got.Cost, wantCost)
			}
			if got.Cost < 0 {
				t.Fatalf("负费用: %.9f", got.Cost)
			}
			checkLedgerInvariant(t, s, "形态 "+tc.name)
		})
	}
}

// ---------------------------------------------------------------------------
// 反向核查:负 token 不得翻转成天价费用(与 handler_test 的余额口径互补)
// ---------------------------------------------------------------------------

func TestR4NegativeUsageCannotInflateCharge(t *testing.T) {
	// 输入 -1e6 会让"求和后 clamp"的实现翻转成巨额正数;逐项归零后该侧等于
	// 未上报 ⇒ 只允许按已交付字节估算(有上限)。
	body := `{"id":"x","object":"chat.completion","choices":[{"message":{"content":"R4_CONTENT"}}],"usage":{"prompt_tokens":-1000000,"completion_tokens":-1}}`
	u := newAuditR3Upstream(t)
	u.setNon(body)
	r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)
	w := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[]}`, token, nil)
	rows := r4Rows(t, db, uid)
	s := auditR3Snapshot(t, db, uid)
	if w.Code != http.StatusOK || len(rows) != 1 {
		t.Fatalf("status=%d rows=%d", w.Code, len(rows))
	}
	got := rows[0]
	max := float64(r4Estimate(len(body))) * 8 / 1e6
	t.Logf("负 token: prompt=%d completion=%d cost=%.9f 上限=%.9f balance=%.6f", got.Prompt, got.Completion, got.Cost, max, s.balance)
	if got.Prompt != 0 || got.Completion != r4Estimate(len(body)) {
		t.Fatalf("负值必须归零后按缺失侧估算: %+v", got)
	}
	if got.Cost > max+1e-9 || got.Cost < 0 {
		t.Fatalf("负 token 产生超上限费用: cost=%.9f max=%.9f", got.Cost, max)
	}
	if s.balance > 100 {
		t.Fatalf("负 token 让余额凭空增加: %.6f", s.balance)
	}
	checkLedgerInvariant(t, s, "负 token")
}

// ledgerKindConsume 是账本消费流水的 kind 字面量(不引用实现常量:
// 本文件在修复前的树上也必须能编译并以断言失败的方式变红)。
const ledgerKindConsume = "consume"
