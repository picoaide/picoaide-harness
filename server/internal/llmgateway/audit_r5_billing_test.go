package llmgateway

import (
	"database/sql"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// R5(2026-09-13 第五轮独立对抗式复核 §1):计费兜底(第四轮 N1/N2/N3)的三个缺口
// 与一个标签缺陷。全部走真 PG + 真 gin 路由 + 真 socket 上游。
//
//	缺口 1(P2):非流式 4xx 的错误体里带 usage → 照扣(`delivered || uok`),
//	             同一个上游 400:stream=true 零扣费、stream=false 扣全额。
//	缺口 2(P2):「估算」无业务上限、可被上游**双向**操纵(1 MiB 填充 → 26 万
//	             token ≈ 2.10 元;显式 completion_tokens:1 → 1 MiB 只收 1 token),
//	             且估算值与上游上报值在库里**不可区分**(无 estimated 列)。
//	缺口 3(P2):prompt_tokens:0 + input_tokens:5000 → prompt 记 0(输入侧免费)。
//	标签(P3)  :/v1/completions 与 /v1/responses 的计费行 kind 硬编码 "chat"。

// r5UsageRow 是 usage 表一行的完整计量视图(含 0063 的 estimated 标记)。
type r5UsageRow struct {
	Kind       string
	Prompt     int64
	Completion int64
	Cache      int64
	Cost       float64
	Estimated  bool
}

// r5UsageRows 读出该用户的全部 usage 行(含 estimated)。
func r5UsageRows(t *testing.T, db *sql.DB, uid int64) []r5UsageRow {
	t.Helper()
	rs, err := db.Query(`SELECT kind, prompt_tokens, completion_tokens, cache_prompt_tokens, cost, estimated
		FROM usage WHERE user_id = ? ORDER BY id`, uid)
	if err != nil {
		t.Fatal(err)
	}
	defer rs.Close()
	var out []r5UsageRow
	for rs.Next() {
		var r r5UsageRow
		if err := rs.Scan(&r.Kind, &r.Prompt, &r.Completion, &r.Cache, &r.Cost, &r.Estimated); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

// ---------------------------------------------------------------------------
// 缺口 1:非流式 4xx + 错误体带 usage ⇒ 一律不落账、不扣费
// ---------------------------------------------------------------------------

// TestR5NonStream4xxWithUsageBodyIsNotBilled:复核报告 §1-B4 的最小复现。
// 修复前:usage 1 行、completion=262144? 不 —— 1 行 prompt=999999、
// cost=1.999998、余额 98.000002(同一个上游 400 在流式下零扣费)。
func TestR5NonStream4xxWithUsageBodyIsNotBilled(t *testing.T) {
	cases := []struct {
		name string
		path string
		body string
	}{
		{"chat 非流式", "/v1/chat/completions", `{"model":"r3-model","messages":[]}`},
		{"messages(anthropic)非流式", "/v1/messages", `{"model":"r3-model","messages":[]}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			u := newAuditR3Upstream(t)
			u.statusCode = 400
			u.setNon(`{"error":{"message":"bad request"},"usage":{"prompt_tokens":999999,"completion_tokens":0}}`)
			r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)

			w := doPost(t, r, c.path, c.body, token, nil)
			rows := r5UsageRows(t, db, uid)
			s := auditR3Snapshot(t, db, uid)
			t.Logf("[%s] 上游 400 + usage 体: status=%d usage 行数=%d balance=%.6f", c.name, w.Code, len(rows), s.balance)
			if w.Code != 400 {
				t.Fatalf("上游 400 必须原样透传, got %d", w.Code)
			}
			if len(rows) != 0 {
				t.Fatalf("4xx(未交付)竟然落账 %d 行: %+v", len(rows), rows)
			}
			if s.balance != 100 {
				t.Fatalf("4xx 竟然扣费: balance=%.9f(期望 100)", s.balance)
			}
			if s.usageRows != 0 {
				t.Fatalf("账本快照显示 %d 行 usage", s.usageRows)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// 缺口 2:估算的业务上限 + 估算标记
// ---------------------------------------------------------------------------

// TestR5EstimateIsCappedAgainstPadding:1 MiB 填充(debug/回显字段,不是模型输出)
// 不得把 completion 估到 26 万 token。修复前:completion=262174、cost≈2.0974。
func TestR5EstimateIsCappedAgainstPadding(t *testing.T) {
	pad := strings.Repeat("B", 1<<20) // 1 MiB
	u := newAuditR3Upstream(t)
	u.setNon(`{"id":"p","choices":[{"message":{"content":"hi"}}],"debug":{"blob":"` + pad + `"},"usage":{"prompt_tokens":10,"completion_tokens":0}}`)
	r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)

	w := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[]}`, token, nil)
	rows := r5UsageRows(t, db, uid)
	s := auditR3Snapshot(t, db, uid)
	if w.Code != 200 || len(rows) != 1 {
		t.Fatalf("status=%d rows=%d", w.Code, len(rows))
	}
	got := rows[0]
	t.Logf("[B1] 交付 %d 字节 → prompt=%d completion=%d cost=%.6f estimated=%v balance=%.6f",
		len(w.Body.String()), got.Prompt, got.Completion, got.Cost, got.Estimated, s.balance)
	if got.Completion > maxEstimatedCompletionTokens {
		t.Fatalf("估算越过业务上限: completion=%d > %d", got.Completion, maxEstimatedCompletionTokens)
	}
	if got.Completion != maxEstimatedCompletionTokens {
		t.Fatalf("1 MiB 填充的估算必须被**截到上限**(否则说明上限没生效): completion=%d, want %d",
			got.Completion, maxEstimatedCompletionTokens)
	}
	// 最坏多收:上限 × 输出价(8 元/1M)≈ 0.53 元;无上限时同样报文是 2.10 元(32 MiB 上限外推 67 元)。
	maxCost := float64(maxEstimatedCompletionTokens)*8/1e6 + 10*2/1e6
	if got.Cost > maxCost+1e-9 {
		t.Fatalf("cost=%.9f 超过上限推导的最坏金额 %.9f", got.Cost, maxCost)
	}
	if !got.Estimated {
		t.Fatal("估算出来的行没有 estimated 标记")
	}
}

// TestR5EstimateCapBoundaryLinear:小于上限的填充仍按字节线性估算(上限只切异常形态,
// 不放宽也不改变正常口径)。
func TestR5EstimateCapBoundaryLinear(t *testing.T) {
	cases := []struct {
		pad  int
		want int64
	}{
		{1 << 10, -1},                           // 1 KiB → 按 /4 线性(远小于上限)
		{64 << 10, -1},                          // 64 KiB → 线性
		{1 << 20, maxEstimatedCompletionTokens}, // 1 MiB → 截到上限
	}
	for _, c := range cases {
		pad := strings.Repeat("B", c.pad)
		body := `{"id":"p","choices":[{"message":{"content":"hi"}}],"debug":{"blob":"` + pad + `"},"usage":{"completion_tokens":0}}`
		u := newAuditR3Upstream(t)
		u.setNon(body)
		r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)
		doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[]}`, token, nil)
		rows := r5UsageRows(t, db, uid)
		if len(rows) != 1 {
			t.Fatalf("pad=%d rows=%d", c.pad, len(rows))
		}
		want := c.want
		if want < 0 {
			want = r4Estimate(len(body))
		}
		t.Logf("pad=%7d 字节 → completion=%d(want %d)", c.pad, rows[0].Completion, want)
		if rows[0].Completion != want {
			t.Fatalf("pad=%d: completion=%d, want %d", c.pad, rows[0].Completion, want)
		}
	}
}

// TestR5EstimatedFlagSeparatesEstimateFromReport(P2,报告 §1-B8):usage 表必须有
// 可区分「估算」与「上游上报」的标记,且两种来源都要如实写入。
func TestR5EstimatedFlagSeparatesEstimateFromReport(t *testing.T) {
	// ① 表结构:0063 的 estimated 列存在。
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	var col string
	if err := db.QueryRow(`SELECT column_name FROM information_schema.columns
		WHERE table_name='usage' AND column_name='estimated'`).Scan(&col); err != nil {
		t.Fatalf("usage.estimated 列不存在(0063 未应用): %v", err)
	}
	var nullable string
	var dflt sql.NullString
	if err := db.QueryRow(`SELECT is_nullable, column_default FROM information_schema.columns
		WHERE table_name='usage' AND column_name='estimated'`).Scan(&nullable, &dflt); err != nil {
		t.Fatal(err)
	}
	if nullable != "NO" || !dflt.Valid || !strings.Contains(dflt.String, "false") {
		t.Fatalf("estimated 列形态不符: nullable=%s default=%v(期望 NOT NULL DEFAULT false)", nullable, dflt)
	}
	// 分区子表也要有该列(ALTER 在父表上递归生效)。
	var parts int
	if err := db.QueryRow(`SELECT count(*) FROM pg_class c JOIN pg_inherits i ON i.inhrelid=c.oid
		JOIN pg_class p ON p.oid=i.inhparent WHERE p.relname='usage'
		AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='estimated')`).Scan(&parts); err != nil {
		t.Fatal(err)
	}
	if parts != 0 {
		t.Fatalf("%d 个 usage 分区缺少 estimated 列(ALTER 未递归)", parts)
	}

	// ② 上游上报 → estimated=false;上游漏报(靠估算)→ estimated=true。
	u := newAuditR3Upstream(t)
	u.setNon(`{"id":"p","choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":11,"completion_tokens":7}}`)
	r, gwDB, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)
	doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[]}`, token, nil)
	reported := r5UsageRows(t, gwDB, uid)
	if len(reported) != 1 || reported[0].Estimated {
		t.Fatalf("上游上报的用量被标记成估算: %+v", reported)
	}

	u2 := newAuditR3Upstream(t)
	u2.setNon(`{"id":"p","choices":[{"message":{"content":"hi"}}]}`) // 完全没有 usage
	r2, db2, uid2, token2 := newAuditR3Gateway(t, u2, 100, 2, 8, 0.2)
	doPost(t, r2, "/v1/chat/completions", `{"model":"r3-model","messages":[]}`, token2, nil)
	estimated := r5UsageRows(t, db2, uid2)
	if len(estimated) != 1 || !estimated[0].Estimated {
		t.Fatalf("上游漏报用量时没有 estimated 标记(事后无法对账): %+v", estimated)
	}

	// ③ 流式兜底估算同样打标(settleStreamFallback)。
	u3 := newAuditR3Upstream(t)
	u3.setStream("data: {\"choices\":[{\"delta\":{\"content\":\"" + strings.Repeat("S", 400) + "\"}}]}\n\ndata: [DONE]\n\n")
	r3, db3, uid3, token3 := newAuditR3Gateway(t, u3, 100, 2, 8, 0.2)
	doPost(t, r3, "/v1/chat/completions", `{"model":"r3-model","messages":[],"stream":true}`, token3, nil)
	streamRows := r5UsageRows(t, db3, uid3)
	if len(streamRows) != 1 || !streamRows[0].Estimated {
		t.Fatalf("流式兜底估算没有 estimated 标记: %+v", streamRows)
	}
	if streamRows[0].Completion <= 0 {
		t.Fatalf("流式漏报 usage 未估算: %+v", streamRows[0])
	}

	// ④ embedding 输入侧估算同样打标。
	u4 := newAuditR3Upstream(t)
	u4.set(&u4.embed, `{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.5]}],"model":"r3-model"}`)
	r4gw, db4, uid4, token4 := newAuditR3Gateway(t, u4, 100, 2, 8, 0.2)
	doPost(t, r4gw, "/v1/embeddings", `{"model":"r3-model","input":["hello world"]}`, token4, nil)
	embedRows := r5UsageRows(t, db4, uid4)
	if len(embedRows) != 1 || !embedRows[0].Estimated {
		t.Fatalf("embedding 估算没有 estimated 标记: %+v", embedRows)
	}
}

// ---------------------------------------------------------------------------
// 缺口 3:prompt_tokens 为 0 时回落到另一套字段名(输入侧不再免费)
// ---------------------------------------------------------------------------

func TestR5ZeroPrimaryTokenFallsBackToAlternateFieldName(t *testing.T) {
	cases := []struct {
		name       string
		usage      string
		wantPrompt int64
	}{
		{"prompt_tokens=0 + input_tokens=5000(输入侧曾整段免费)", `{"prompt_tokens":0,"input_tokens":5000,"completion_tokens":7}`, 5000},
		{"prompt_tokens=5000 + input_tokens=0(chat 优先,语义不变)", `{"prompt_tokens":5000,"input_tokens":0,"completion_tokens":7}`, 5000},
		{"只有 input_tokens=5000(Responses 形态)", `{"input_tokens":5000,"output_tokens":7}`, 5000},
		{"两套都给正值(chat 优先)", `{"prompt_tokens":7,"input_tokens":900000,"completion_tokens":9}`, 7},
		{"两套都是 0", `{"prompt_tokens":0,"input_tokens":0,"completion_tokens":7}`, 0},
		{"compl=0 + output=9(输出侧同样回落)", `{"prompt_tokens":100,"completion_tokens":0,"output_tokens":9}`, 100},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			u := newAuditR3Upstream(t)
			u.setNon(`{"id":"p","choices":[{"message":{"content":"ok"}}],"usage":` + c.usage + `}`)
			r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)
			doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[]}`, token, nil)
			rows := r5UsageRows(t, db, uid)
			if len(rows) != 1 {
				t.Fatalf("rows=%d", len(rows))
			}
			t.Logf("%s → prompt=%d completion=%d cost=%.6f estimated=%v",
				c.name, rows[0].Prompt, rows[0].Completion, rows[0].Cost, rows[0].Estimated)
			if rows[0].Prompt != c.wantPrompt {
				t.Fatalf("prompt=%d, want %d(0/缺失必须回落到另一套字段名)", rows[0].Prompt, c.wantPrompt)
			}
			if c.wantPrompt > 0 {
				want := float64(c.wantPrompt) * 2 / 1e6
				if rows[0].Cost < want-1e-9 {
					t.Fatalf("输入侧未计费: cost=%.9f < 输入部分 %.9f", rows[0].Cost, want)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// P3:计费 kind = 端点标识
// ---------------------------------------------------------------------------

func TestR5BillingKindMatchesEndpoint(t *testing.T) {
	cases := []struct {
		name     string
		path     string
		body     string
		wantKind string
	}{
		{"chat", "/v1/chat/completions", `{"model":"r3-model","messages":[]}`, "chat"},
		{"completions(FIM)", "/v1/completions", `{"model":"r3-model","prompt":"def f():"}`, "completions"},
		{"responses", "/v1/responses", `{"model":"r3-model","input":"hi"}`, "responses"},
		{"messages(anthropic)", "/v1/messages", `{"model":"r3-model","messages":[]}`, "search"},
	}
	for _, c := range cases {
		for _, stream := range []bool{false, true} {
			mode := "非流式"
			if stream {
				mode = "流式"
			}
			t.Run(c.name+"/"+mode, func(t *testing.T) {
				u := newAuditR3Upstream(t)
				u.setNon(`{"id":"p","choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":5,"completion_tokens":6}}`)
				u.setStream("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: {\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":6}}\n\ndata: [DONE]\n\n")
				r, db, uid, token := newAuditR3Gateway(t, u, 100, 2, 8, 0.2)
				body := c.body
				if stream {
					body = strings.TrimSuffix(body, "}") + `,"stream":true}`
				}
				w := doPost(t, r, c.path, body, token, nil)
				if w.Code != 200 {
					t.Fatalf("status=%d body=%s", w.Code, bodyHead(w))
				}
				rows := r5UsageRows(t, db, uid)
				if len(rows) != 1 {
					t.Fatalf("usage 行数=%d, want 1", len(rows))
				}
				t.Logf("%s %s → kind=%q kind 计数=%v", c.path, mode, rows[0].Kind, kindsOf(rows))
				if rows[0].Kind != c.wantKind {
					t.Fatalf("kind=%q, want %q(按端点对账必须能区分)", rows[0].Kind, c.wantKind)
				}
			})
		}
	}
}

func kindsOf(rows []r5UsageRow) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.Kind)
	}
	return out
}

// TestBillingKindsRegisteredInServerstore:计费 kind 必须在 serverstore 的
// 白名单与 pending 清理集合里登记 —— 否则管理端按 kind 过滤会 400、流式残留
// pending 行不会被启动期清理(防漂移守卫)。
func TestBillingKindsRegisteredInServerstore(t *testing.T) {
	streamKinds := []string{billingKindChat, billingKindCompletions, billingKindResponses, billingKindSearch, billingKindEmbedding}
	for _, k := range streamKinds {
		if !serverstore.UsageRequestKind[k] {
			t.Errorf("kind %q 未登记在 serverstore.UsageRequestKind", k)
		}
	}
	// 只有流式端点会产生 pending 行;embedding 不是流式,不得进清理集合。
	for _, k := range []string{billingKindChat, billingKindCompletions, billingKindResponses, billingKindSearch} {
		found := false
		for _, p := range serverstore.UsageKindPendingCleanup {
			if p == k {
				found = true
			}
		}
		if !found {
			t.Errorf("流式 kind %q 未登记在 serverstore.UsageKindPendingCleanup(残留 pending 行不会被清理)", k)
		}
	}
	for _, p := range serverstore.UsageKindPendingCleanup {
		if p == billingKindEmbedding {
			t.Error("embedding 被登记进 pending 清理集合(会误删真实请求计数)")
		}
	}
}
