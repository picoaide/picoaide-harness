package llmgateway

import (
	"database/sql"
	"encoding/json"
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

// TestBalanceSettlementFailureAbortsStream 是流式路径的回归锁:SSE 头已经
// 发出,状态码改不了,唯一合法的做法是写一条 error 事件并终止,而不是
// 把剩余内容继续泵给客户端。
func TestBalanceSettlementFailureAbortsStream(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	seedExpensiveModel(t, db)
	activateBalance(t, db, 1, smallBalance)

	w := doPost(t, r, "/v1/chat/completions",
		`{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"hi"}]}`, token, nil)

	// 流式:状态码在 SSE 头写出时已定(200),只能靠 error 事件表达失败。
	if w.Code != http.StatusOK {
		t.Logf("status = %d (SSE 头已发,允许 200)", w.Code)
	}
	out := w.Body.String()
	if !strings.Contains(out, "BALANCE_EXHAUSTED") {
		t.Fatalf("流式结算失败必须写 error 事件,实际响应体 = %q", out)
	}
	// 上游的 usage chunk(带真实 token)不得在 error 事件之后再被转发。
	if idx := strings.Index(out, "BALANCE_EXHAUSTED"); idx >= 0 {
		if after := out[idx:]; strings.Contains(after, `"usage"`) {
			t.Fatalf("error 事件之后仍有内容被转发: %q", after)
		}
	}
	assertBalanceIntact(t, db, smallBalance)
	// 流式路径在转发前会插一条 pending usage 行(成本 0);结算失败后它仍是
	// 0 成本(不是"扣了钱"),余额不得变化。pending 行的清理由
	// CleanupPendingUsage 负责,不属于 FIX-05。
	assertNoChargedUsage(t, db)
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

// assertNoChargedUsage 断言没有任何 usage 行留下**非零**费用(流式 pending
// 行允许存在,但它必须是 0 成本)。
func assertNoChargedUsage(t *testing.T, db *sql.DB) {
	t.Helper()
	var charged int
	if err := db.QueryRow(`SELECT COUNT(*) FROM usage WHERE cost <> 0`).Scan(&charged); err != nil {
		t.Fatal(err)
	}
	if charged != 0 {
		t.Fatalf("charged usage rows = %d, want 0", charged)
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

	_, err := serverstore.RecordUsage(db, 1, "deepseek-chat", 8, 3)
	if !isBalanceSettlementFailure(err) {
		t.Fatalf("err = %v, want ErrInsufficientBalance(余额下限未生效)", err)
	}
	assertNoUsageAndBalanceIntact(t, db, smallBalance)
}
