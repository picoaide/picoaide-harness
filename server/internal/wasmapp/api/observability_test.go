package api

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/capapi"
	"github.com/picoaide/picoaide/internal/wasmapp/events"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// R2-L1-5（P2，2026-09-20）：OPS-6 的**准入级可观测性**必须有行为级判据。
//
// 缺陷形态（审计原文）：`observability.go` 的两个出口 —— `admissionFailed` 的
// `Events.Record(...)`（:53）与 `admissionOK`（:73+）—— 在本包**从未被任何用例执行过**
// （夹具不注入 `Options.Events`，`l1-mutations.sh` 的 14 条变异里也没有它）。
// 实现与生产接线都在（`cmd/server/wasmapp.go` 注入真 sink），缺的是回归守卫：
// 把 `Record` 删掉不会有任何用例变红。
//
// 判据（行为级，不是"函数被调用过"）：注入**真** events sink（真库、真批量落库，
// 只把 flush 周期压到 10ms），跑三条请求，然后读 `wasm_call_events`：
//
//	① 缺 proof ⇒ 401：error 行 + reason_code=proof_required + Evidence 带
//	   `source=admission` / 客户端看到的 `request_id` / `status=401`；
//	② 未登记应用 ⇒ 404：error 行 + reason_code=NOT_FOUND + `reason=open: app_not_found`；
//	③ 正常 open ⇒ 200：**成功也要落一行**（Outcome=ok + `action=open; version=…`）——
//	   准入成功不进执行管线，不记的话"今天这个应用被打开了多少次"在事件表里是空白。
//
// 同时断言 user_id（"谁打不开"是运营面第一个问题）与 `sink.Failed()==0`（真落库，不是内存里转）。
//
// 变异：①删掉 `admissionFailed` 里的 `h.opt.Events.Record(...)` ⇒ 本用例红（error 行消失）；
//
//	②删掉 `admissionOK` 的 `Record` ⇒ 本用例红（ok 行消失）。
func TestAdmissionObservabilityIsRecordedAsCallEvents(t *testing.T) {
	var sink *events.Sink
	e := newTestEnv(t, func(o *Options) {
		sink = events.NewSink(o.DB, events.Options{
			RingSize:      32,
			FlushInterval: 10 * time.Millisecond,
			BatchMax:      8,
		})
		o.Events = sink
	})
	sink.Start(context.Background())
	// Close 是幂等的，且**先 flush 再返回** —— 因此不需要 sleep/轮询来等落库。
	t.Cleanup(func() { _ = sink.Close() })

	seedOpenApp(t, e, "alive", "1.0.0", "正常应用", true)

	// ① 缺 proof ⇒ 401（admissionFailed ← proof.go）
	recNoProof := e.postOpen("ghost", e.tokens["alice"], "", false)
	if recNoProof.Code != http.StatusUnauthorized {
		t.Fatalf("缺 proof 应 401，得到 %d body=%s", recNoProof.Code, recNoProof.Body.String())
	}
	ridNoProof := responseRequestID(t, recNoProof.Header().Get(requestIDHeader))

	// ② 未登记应用（带 proof ⇒ 走到应用反查）⇒ 404
	recGhost := e.postOpen("ghost", e.tokens["alice"], "", true)
	if recGhost.Code != http.StatusNotFound {
		t.Fatalf("未登记应用应 404，得到 %d body=%s", recGhost.Code, recGhost.Body.String())
	}
	ridGhost := responseRequestID(t, recGhost.Header().Get(requestIDHeader))

	// ③ 正常打开 ⇒ 200（admissionOK）
	recOK := e.postOpen("alive", e.tokens["alice"], "", true)
	if recOK.Code != http.StatusOK {
		t.Fatalf("正常应用应 200，得到 %d body=%s", recOK.Code, recOK.Body.String())
	}
	ridOK := responseRequestID(t, recOK.Header().Get(requestIDHeader))

	if err := sink.Close(); err != nil {
		t.Fatalf("sink.Close: %v", err)
	}
	if got := sink.Written(); got != 3 {
		t.Fatalf("应当落库 3 条准入事件，得到 %d（failed=%d dropped=%d）", got, sink.Failed(), sink.Dropped())
	}
	if got := sink.Failed(); got != 0 {
		t.Fatalf("调用事件落库失败 %d 条（判据必须建立在真落库上）", got)
	}

	aliceID := e.ids["alice"]
	// ① 缺 proof：error + proof_required + request_id 可对齐
	row := callEventFor(t, e.db, "ghost", ridNoProof)
	if row.outcome != capapi.OutcomeError || row.reasonCode != "proof_required" {
		t.Fatalf("缺 proof 的事件行 = {outcome:%q reason_code:%q}, want {error proof_required}（evidence=%q）",
			row.outcome, row.reasonCode, row.evidence)
	}
	if row.userID != aliceID {
		t.Fatalf("缺 proof 的事件行 user_id = %d, want %d（「谁打不开」是运营面第一个问题）", row.userID, aliceID)
	}
	for _, want := range []string{"source=admission", "request_id=" + ridNoProof, "status=401", "reason=缺少持有性证明"} {
		if !strings.Contains(row.evidence, want) {
			t.Fatalf("缺 proof 的 evidence 必须含 %q（排障要把客户端看到的 id 与服务端记录对齐）：%q", want, row.evidence)
		}
	}

	// ② 未登记应用：error + NOT_FOUND + reason 落进 Evidence
	row = callEventFor(t, e.db, "ghost", ridGhost)
	if row.outcome != capapi.OutcomeError || row.reasonCode != "NOT_FOUND" {
		t.Fatalf("未登记应用的事件行 = {outcome:%q reason_code:%q}, want {error NOT_FOUND}", row.outcome, row.reasonCode)
	}
	for _, want := range []string{"source=admission", "request_id=" + ridGhost, "status=404", "reason=open: app_not_found"} {
		if !strings.Contains(row.evidence, want) {
			t.Fatalf("未登记应用的 evidence 必须含 %q，得到 %q", want, row.evidence)
		}
	}

	// ③ 成功打开：Outcome=ok（准入成功也要落一行，否则"打开了多少次"在事件表里空白）
	row = callEventFor(t, e.db, "alive", ridOK)
	if row.outcome != capapi.OutcomeOK || row.reasonCode != "" {
		t.Fatalf("成功打开的事件行 = {outcome:%q reason_code:%q}, want {ok \"\"}", row.outcome, row.reasonCode)
	}
	for _, want := range []string{"source=admission", "request_id=" + ridOK, "action=open", "version=1.0.0"} {
		if !strings.Contains(row.evidence, want) {
			t.Fatalf("成功打开的 evidence 必须含 %q，得到 %q", want, row.evidence)
		}
	}

	// 观测面纪律（§8）：evidence 不得夹带 bearer / proof / Cookie。
	if strings.Contains(row.evidence, e.tokens["alice"]) {
		t.Fatalf("evidence 里出现了 bearer：%q", row.evidence)
	}
	if len(row.evidence) > capapi.MaxEvidenceBytes {
		t.Fatalf("evidence 超过 %d 字节：%d", capapi.MaxEvidenceBytes, len(row.evidence))
	}
	if limits.CallEventRetentionDays <= 0 {
		t.Fatalf("保留期常量失效：%d", limits.CallEventRetentionDays)
	}
}

// responseRequestID 取出响应头里的 request_id（`requestID` 会把它回写给客户端，
// 因此"客户端看到的 id"与"服务端记录里的 id"必须能对上）。
func responseRequestID(t *testing.T, header string) string {
	t.Helper()
	if strings.TrimSpace(header) == "" {
		t.Fatalf("响应必须带 %s（排障入口：拿到 id 才能查服务端记录）", requestIDHeader)
	}
	return header
}

// callEventRow 是判据用到的列（只取需要断言的，列集变更不该让本用例静默通过）。
type callEventRow struct {
	appID      string
	userID     int64
	outcome    string
	reasonCode string
	evidence   string
}

// callEventFor 按 (app_id, evidence 里的 request_id) 取唯一一条事件行。
//
// 用 request_id 而不是"最近一条"：三条请求是同一用例里连续发生的，"最近"会随执行顺序
// 漂移（而且那正是"存在性断言"的写法 —— 拿到哪条都算过）。
func callEventFor(t *testing.T, db *sql.DB, appID, requestID string) callEventRow {
	t.Helper()
	rows, err := db.Query(`SELECT app_id, user_id, outcome, reason_code, evidence
		FROM wasm_call_events WHERE app_id = $1 ORDER BY id DESC LIMIT 20`, appID)
	if err != nil {
		t.Fatalf("查 wasm_call_events: %v", err)
	}
	defer rows.Close()
	matches := []callEventRow{}
	for rows.Next() {
		var r callEventRow
		if serr := rows.Scan(&r.appID, &r.userID, &r.outcome, &r.reasonCode, &r.evidence); serr != nil {
			t.Fatalf("扫 wasm_call_events: %v", serr)
		}
		if strings.Contains(r.evidence, "request_id="+requestID) {
			matches = append(matches, r)
		}
	}
	if rerr := rows.Err(); rerr != nil {
		t.Fatalf("遍历 wasm_call_events: %v", rerr)
	}
	if len(matches) != 1 {
		t.Fatalf("app_id=%s request_id=%s 应当恰好命中 1 条调用事件，得到 %d 条：%s",
			appID, requestID, len(matches), fmt.Sprint(matches))
	}
	return matches[0]
}
