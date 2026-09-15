package llmgateway

import (
	"database/sql"
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// FIX-05(审计 2026-09-12,P1,上一轮修复引入的回归):结算失败仍 200 交付 +
// 零落账 + 分文未扣,且可无限重复。
//
// 背景:P0-C 给 settleUsageCostTx 加了余额下限,余额不足时返回
// ErrInsufficientBalance 并让**整个事务回滚**。但四个调用点只 log 一行就继续
// 把上游响应交付给客户端 —— 于是"记了账没扣钱"变成了"**没记账也没扣钱**":
//
//	闸门(handler.go:102)只看"分位余额 > 0",余额 1.00 的账户能过闸;
//	上游真实调用一次(上游真被计费);
//	结算 cost(比如 8.00 元)> 余额 1.00 → ErrInsufficientBalance → 回滚;
//	调用方 log 后继续 → 客户端拿到 200 + 完整响应体;
//	usage 0 行、余额不变 ⇒ 第二次、第三次……永远免费。
//
// 修法(用户拍板"失败即拒绝 + 不再静默"):
//   - 非流式:在**交付响应体之前**返回 429 BALANCE_EXHAUSTED;
//   - 流式:SSE 头已发,状态码改不了 → 写一条 error 事件后终止。
//
// 定这个测试的口径:断言「429 + 不交付响应体 + usage 0 行 + 余额不变 +
// 可重复(不会因为重试而漏拦)」。
//
// 审计 r7 srvbill-1(P1)修正了流式那一半的**结算语义**:usage chunk 在流末尾,
// 拦截只能拦住后续字节,拦不住已交付的正文 —— "余额不足就整笔回滚"让这次真实
// 消费变成零落账零扣费,而闸门只看分位余额 > 0 ⇒ 同一请求可无限重复。流式现在
// 走 allowOverdraft 后付费(欠款如实落账,后续请求被闸门拦下),见
// TestBalanceSettlementOverdraftChargesStream;本文件上半部分(非流式 + 其它
// 结算错误的 fail-closed)不变。

// seedExpensiveModel 把模型单价抬到「一次调用必然超过余额」。
// 上游固定回 usage{prompt:8, completion:3}:输入 2e5 元/1M → 1.60 元,
// 输出 2e5 元/1M → 0.60 元,合计 2.20 元。
//
// 余额必须能过**两**道口径(这是踩过的坑,别再改小):
//   - SetUserBalance 经 roundMoney 取整到**分**,0.0001 会被取整成 0
//     → 开通位不会置位 → 变成"未开通用户(不扣不记)"而不是"余额不足";
//   - 闸门判定用 QuantizeMoney(分位),余额必须 > 0 才能过闸门走到结算。
//
// 所以余额取 0.01 元(¥0.01,展示与判定都 > 0,过闸门),而单次费用
// 2.20 元 → 结算必然返回 ErrInsufficientBalance。
//
// ⚠️ 单次费用必须 **> 1 元**(delta < -1):settleUsageCostTx 的余额下限
// 里有一处 `OR ? >= 0`,PG 把对比的整数字面量 0 推断成 integer,pgx 于是把
// float 参数**截断成整数** —— delta ∈ (-1, 0) 会变成 0 从而让该分支恒真,
// 下限形同虚设(详见 FIX-server.md 的 FIX-NEW-A)。这里刻意避开那条路径,
// 让本测试测的是 FIX-05 本身(结算返回 ErrInsufficientBalance → 调用方必须
// 拒绝)。这个坑不修,本测试就会变成"余额被扣成负数却仍然 200"。
const smallBalance = 0.01

func seedExpensiveModel(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`UPDATE models SET input_price_per_1m = 200000, output_price_per_1m = 200000 WHERE name = 'deepseek-chat'`); err != nil {
		t.Fatal(err)
	}
}

// TestBalanceSettlementFailureRejectsNonStream 是非流式路径的回归锁。
func TestBalanceSettlementFailureRejectsNonStream(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	seedExpensiveModel(t, db)
	activateBalance(t, db, 1, smallBalance)

	body := `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}`
	w := doPost(t, r, "/v1/chat/completions", body, token, nil)

	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 (body=%s) —— 结算失败必须在交付响应体之前拒绝", w.Code, w.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("429 body must be the JSON error envelope: %v (%s)", err, w.Body.String())
	}
	code := out["error"].(map[string]any)["code"]
	if code != "BALANCE_EXHAUSTED" {
		t.Fatalf("code = %v, want BALANCE_EXHAUSTED", code)
	}
	if strings.Contains(w.Body.String(), `"id":"x"`) {
		t.Fatalf("上游响应体被交付给客户端(拒绝必须是完整的): %s", w.Body.String())
	}
	// 上游确实被调用过(这正是问题:钱花在上游,账落不下来)。
	if n := f.requests.Load(); n != 1 {
		t.Fatalf("upstream calls = %d, want 1(闸门放行后才会走到结算)", n)
	}
	// 账本与余额都必须原封不动:没有半个事务落库。
	assertNoUsageAndBalanceIntact(t, db, smallBalance)

	// 可重复:第二次仍然 429,不会因为被拒过一次就漏拦。
	w2 := doPost(t, r, "/v1/chat/completions", body, token, nil)
	if w2.Code != http.StatusTooManyRequests {
		t.Fatalf("second call status = %d, want 429", w2.Code)
	}
	assertNoUsageAndBalanceIntact(t, db, smallBalance)
}

// TestBalanceSettlementOverdraftChargesStream 是流式路径的回归锁(审计 r7
// srvbill-1 起口径变更):SSE 的 usage chunk 出现在流的**末尾**,读到它时全部
// 正文早已交付给客户端 —— "余额不够就整笔回滚"对这次调用等于零落账零扣费,
// 而闸门只看分位余额 > 0 ⇒ 余额 1 分钱的账户可以无限重复拿到完整回答。
//
// 现在流式结算走 allowOverdraft(先交付后结算 = 后付费):欠款如实落账
// (balance_money 走负 + consume 流水,账本 I1 成立),该用户**后续**请求被
// BalanceBlocked 拦下。非流式仍然在交付前拒绝(见上一条用例)。
func TestBalanceSettlementOverdraftChargesStream(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	seedExpensiveModel(t, db)
	activateBalance(t, db, 1, smallBalance)

	w := doPost(t, r, "/v1/chat/completions",
		`{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"hi"}]}`, token, nil)

	out := w.Body.String()
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200(body=%s)", w.Code, bodyHead(w))
	}
	// 上游内容必须完整交付(结算成功 ⇒ 不写 error 事件、不终止泵送)。
	if !strings.Contains(out, `"content":"hi"`) || !strings.Contains(out, "[DONE]") {
		t.Fatalf("上游内容未完整交付: %q", out)
	}
	if strings.Contains(out, "BALANCE_EXHAUSTED") {
		t.Fatalf("流式结算已允许透支欠款,不应再报余额不足: %q", out)
	}
	// 欠款如实落账:上游上报 pt=10 / ct=5 @ 2e5 元/1M → 3.00 元。
	var pt, ct int64
	var cost float64
	if err := db.QueryRow(`SELECT prompt_tokens, completion_tokens, cost FROM usage`).Scan(&pt, &ct, &cost); err != nil {
		t.Fatalf("已交付的流式请求没有落账(零落账): %v", err)
	}
	if pt != 10 || ct != 5 || math.Abs(cost-3.0) > 1e-9 {
		t.Fatalf("落账数据不符: pt=%d ct=%d cost=%.9f, want 10/5/3.0", pt, ct, cost)
	}
	var balance, ledgerSum float64
	if err := db.QueryRow(`SELECT balance_money FROM users WHERE id = 1`).Scan(&balance); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COALESCE(SUM(amount),0) FROM balance_ledger WHERE user_id = 1`).Scan(&ledgerSum); err != nil {
		t.Fatal(err)
	}
	if want := smallBalance - cost; math.Abs(balance-want) > 1e-9 {
		t.Fatalf("balance = %.9f, want %.9f(欠款必须走负,而不是整笔回滚)", balance, want)
	}
	if balance >= 0 {
		t.Fatalf("balance = %.9f, want < 0(先交付后结算 = 后付费)", balance)
	}
	if math.Abs(balance-ledgerSum) > 1e-6 {
		t.Fatalf("I1 被破坏: balance=%.9f SUM(ledger)=%.9f", balance, ledgerSum)
	}
	// 上限已经被这次欠款校验过,后续请求必须在**调用上游之前**被闸门拦下。
	if n := f.requests.Load(); n != 1 {
		t.Fatalf("upstream calls = %d, want 1", n)
	}
	w2 := doPost(t, r, "/v1/chat/completions",
		`{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"hi"}]}`, token, nil)
	if w2.Code != http.StatusTooManyRequests {
		t.Fatalf("欠款账户的后续请求 status = %d, want 429", w2.Code)
	}
	if n := f.requests.Load(); n != 1 {
		t.Fatalf("欠款账户的后续请求仍打到上游: calls = %d, want 1", n)
	}
}

// TestBalanceSettlementFailureAnthropicNonStream 覆盖 /v1/messages 的同一处
// 回归(server/internal/llmgateway/messages.go)。审计报告只列了消息流式那一处,
// 但非流式路径的调用点形态完全相同(RecordUsageKindCached + log 后继续)。
func TestBalanceSettlementFailureAnthropicNonStream(t *testing.T) {
	f := newFakeUpstream(t)
	// /v1/messages 只路由到 protocol=anthropic 的 provider(消息端点是
	// Anthropic 原生协议),因此这里自建一个 anthropic 协议的上游路由。
	DecryptSecret = func(s string) (string, error) { return s, nil }
	InvalidateUpstreams()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, protocol) VALUES ('fake-anthropic', ?, ?, '["deepseek-v4-flash"]', 'anthropic')`, f.baseURL, upstreamKey); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO models (name, provider_id, display_name, input_price_per_1m, output_price_per_1m) VALUES ('deepseek-v4-flash', 1, 'DeepSeek V4 Flash', 200000, 200000)`); err != nil {
		t.Fatal(err)
	}
	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "alice", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterRoutes(r, db)

	enableBalanceGate(t, db, true)
	activateBalance(t, db, uid, smallBalance)

	// 上游 usage 用 anthropic 形状(input_tokens/output_tokens):8 输入 +
	// 3 输出 → ~1.7e-3 元 > 余额 1e-4 元 → 结算必然失败。
	f.nonStream = `{"id":"msg_1","type":"message","usage":{"input_tokens":8,"output_tokens":3}}`
	w := doPost(t, r, "/v1/messages",
		`{"model":"deepseek-v4-flash","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}`, token, nil)

	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("messages status = %d, want 429 (body=%s)", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), `"msg_1"`) {
		t.Fatalf("上游响应体被交付: %s", w.Body.String())
	}
	assertNoUsageAndBalanceIntact(t, db, smallBalance)
}

// assertNoUsageAndBalanceIntact 断言「结算失败 = 零落账 + 余额不变」。
// 这是回归的核心不变量:修复前 usage 是 0 行但余额也不变(等于白嫖),
// 修复后仍然是 0 行 + 余额不变(等于拒绝),差别在**是否交付**。
func assertNoUsageAndBalanceIntact(t *testing.T, db *sql.DB, want float64) {
	t.Helper()
	var rows int
	if err := db.QueryRow(`SELECT COUNT(*) FROM usage`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		// 若未来改成"部分扣款 + 全额记账",这里必须同步改成"至少留痕"。
		t.Fatalf("usage rows = %d, want 0(结算失败必须整笔回滚)", rows)
	}
	assertBalanceIntact(t, db, want)
}

// assertBalanceIntact 断言拒绝路径没有改动余额。
func assertBalanceIntact(t *testing.T, db *sql.DB, want float64) {
	t.Helper()
	u, err := serverstore.GetUserByID(db, 1)
	if err != nil {
		t.Fatal(err)
	}
	if diff := u.BalanceMoney - want; diff > 1e-9 || diff < -1e-9 {
		t.Fatalf("balance = %v, want %v(拒绝路径不得改动余额)", u.BalanceMoney, want)
	}
}

// TestBalanceFloorEnforcedForFullYuanCharge 是 FIX-05 的**前置条件**回归:
// 只有 settleUsageCostTx 真的返回 ErrInsufficientBalance,四个调用点的分支
// 才有意义。单次费用 > 余额且 > 1 元时必须整笔回滚。
func TestBalanceFloorEnforcedForFullYuanCharge(t *testing.T) {
	f := newFakeUpstream(t)
	_, db, _ := newGateway(t, f)
	enableBalanceGate(t, db, true)
	seedExpensiveModel(t, db)
	activateBalance(t, db, 1, smallBalance)

	_, err := serverstore.RecordUsageKind(db, 1, "deepseek-chat", 8, 3, "chat")
	if !isBalanceSettlementFailure(err) {
		t.Fatalf("err = %v, want ErrInsufficientBalance(余额下限未生效)", err)
	}
	assertNoUsageAndBalanceIntact(t, db, smallBalance)
}
