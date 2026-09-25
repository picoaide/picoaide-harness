package llmgateway

// R16C-02（审计 2026-09-25，P1）：余额闸门只看"分位余额 > 0"⇒ 余额 0.01 元的账号
// 可以**无限次**请求，每次都已真实调用上游（组织按平台的 key 付费），随后结算失败
// 整笔回滚 ⇒ usage / usage_daily / usage_monthly / balance_ledger 一行不动，
// 管理端零痕迹；默认不限速 ⇒ 循环没有终点。
//
// 探针实测（修前，真 HTTP + 假上游）：余额 0.01、单次成本 0.02 的账号连发 10 次 =
// **10 次上游命中**、四张账表行数与金额一字不变、只多出 13 行 stdout 日志。
//
// 修后判据（本文件）：被拒的请求**在转发之前**就被拦下 —— 上游命中数不增长；
// 且拒绝留下可检索证据（进程内计数 + 最近一条的形状，经 /server-info 对外）。
//
// 两层（都在转发之前）：
//  ① 最小计费额（minBillableMicro）：prompt 估算 token × 模型输入价。连成本下界都
//     盖不住 ⇒ 转发必然白烧；
//  ② 学到的下限：任何一次"结算时钱不够"的事实都把该账号的准入下限抬到当时余额之上
//     （失败整笔回滚 ⇒ 余额不变 ⇒ 不会自我解除），直到余额真的增长。
//
// 只做 ① 是不够的：prompt 估算只是成本**下界**，输出侧长度事前不可知 —— 余额 0.01
// 的账号仍能凭"最小计费额只有 0.0085"反复过闸（下面前两条用例分别钉这两层）。

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// resetBalanceAdmissionState 复位准入侧的进程内状态（计数/最近一条/下限/日志节流）。
// 与 resetSharedLimitersForTest 同一纪律：包级单例 + 进程级累积状态必须在统一入口复位，
// 否则"单跑绿、整包红"。
func resetBalanceAdmissionState(t *testing.T) {
	t.Helper()
	serverstore.ResetBalanceAdmissionForTest()
	resetBalanceRejectionLogForTest()
	t.Cleanup(func() {
		serverstore.ResetBalanceAdmissionForTest()
		resetBalanceRejectionLogForTest()
	})
}

// setModelPrices 给测试模型定价（元 / 1M token）。
func setModelPrices(t *testing.T, db *sql.DB, in, out float64) {
	t.Helper()
	if _, err := db.Exec(`UPDATE models SET input_price_per_1m = ?, output_price_per_1m = ? WHERE name = 'deepseek-chat'`, in, out); err != nil {
		t.Fatal(err)
	}
}

const admissionProbeBody = `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}`

// TestBalanceAdmissionMinBillableRefusesBeforeForwarding 钉第 ① 层：
// 余额连"这次请求的成本下界"都盖不住 ⇒ 429，且**上游命中 0 次**（修前是命中 1 次）。
func TestBalanceAdmissionMinBillableRefusesBeforeForwarding(t *testing.T) {
	resetBalanceAdmissionState(t)
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	// 输入 200000 元/1M：请求体约 68 字节 → 约 17 token → 最小计费额约 3.4 元。
	setModelPrices(t, db, 200000, 200000)
	activateBalance(t, db, 1, 0.01)

	w := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d %s, want 429", w.Code, w.Body.String())
	}
	if code := errCodeOf(t, w); code != "BALANCE_EXHAUSTED" {
		t.Fatalf("error.code = %q, want BALANCE_EXHAUSTED", code)
	}
	if n := f.requests.Load(); n != 0 {
		t.Fatalf("upstream calls = %d, want 0 —— 余额不足以支付最小计费额时**不得转发**（修前是 1）", n)
	}
	// 可检索证据：进程内计数 + 最近一条的形状（/server-info 的 balance 字段读的就是它）。
	n, last, ok := serverstore.BalanceAdmissionStats()
	if !ok || n < 1 {
		t.Fatalf("准入拒绝没有被记录: count=%d ok=%v（被拒请求必须留下证据）", n, ok)
	}
	if last.Reason != "min_billable" {
		t.Fatalf("拒绝依据 = %q, want min_billable", last.Reason)
	}
	if last.Endpoint != "chat" || last.Model != "deepseek-chat" {
		t.Fatalf("拒绝形状缺少端点/模型: %+v", last)
	}
	if last.RequiredMoney <= last.BalanceMoney {
		t.Fatalf("要求金额(%v) 应大于余额(%v)：否则不该被拒", last.RequiredMoney, last.BalanceMoney)
	}
}

// TestBalanceAdmissionLearnedFloorStopsRepeatUpstreamBurn 钉第 ② 层：
// 第 1 次放行（成本下界盖得住），结算因钱不够失败并抬高准入下限；
// 之后**任意多次**请求都不得再产生上游调用；充值后自动放行。
func TestBalanceAdmissionLearnedFloorStopsRepeatUpstreamBurn(t *testing.T) {
	resetBalanceAdmissionState(t)
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	// 输入 500、输出 3000：假上游回报 prompt=8/completion=3 ⇒ 单次 0.013 元 > 余额 0.01，
	// 而最小计费额 ≈ 17×500 微元 = 0.0085 元 < 0.01 ⇒ 第 1 次**会**放行（这正是要收口的洞）。
	setModelPrices(t, db, 500, 3000)
	activateBalance(t, db, 1, 0.01)

	// 第 1 次：放行 → 上游被真调用一次 → 结算失败 → 429 + 记下限。
	w := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("第一次 status = %d %s, want 429（结算失败，交付前拒绝）", w.Code, w.Body.String())
	}
	if n := f.requests.Load(); n != 1 {
		t.Fatalf("第一次 upstream calls = %d, want 1（成本下界盖得住，所以会放行）", n)
	}
	if _, ok := serverstore.BalanceAdmissionFloor(1); !ok {
		t.Fatalf("结算失败后没有记下准入下限 —— 第 ② 层没生效")
	}

	// 第 2..11 次：必须在准入处被拒，**一次上游调用都不产生**。
	for i := 2; i <= 11; i++ {
		w := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil)
		if w.Code != http.StatusTooManyRequests {
			t.Fatalf("第 %d 次 status = %d %s, want 429", i, w.Code, w.Body.String())
		}
	}
	if n := f.requests.Load(); n != 1 {
		t.Fatalf("循环 11 次后 upstream calls = %d, want 1 —— 学到的下限必须止住重复烧额度"+
			"（修前 = 11）", n)
	}
	_, last, _ := serverstore.BalanceAdmissionStats()
	if last.Reason != "learned_floor" {
		t.Fatalf("第 2 次起的拒绝依据 = %q, want learned_floor", last.Reason)
	}
	// 账户状态未被污染：没有 usage、余额不变（失败整笔回滚）。
	assertNoUsageAndBalanceIntact(t, db, 0.01)

	// 充值 ⇒ 下限自动失效（余额真的增长了），请求恢复。
	activateBalance(t, db, 1, 1.0)
	if w := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil); w.Code != http.StatusOK {
		t.Fatalf("充值后 status = %d %s, want 200（下限必须随余额增长自动解除）", w.Code, w.Body.String())
	}
	if n := f.requests.Load(); n != 2 {
		t.Fatalf("充值后 upstream calls = %d, want 2", n)
	}
}

// TestBalanceAdmissionFloorIgnoresUnactivatedAndAdminAccounts 钉"别过度修复"：
// 未开通余额账户的员工不受闸门约束（存量部署开启闸门不会误拦全员），
// 管理员豁免 —— 两者的既有语义逐字保留。
func TestBalanceAdmissionFloorIgnoresUnactivatedAndAdminAccounts(t *testing.T) {
	resetBalanceAdmissionState(t)
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	setModelPrices(t, db, 200000, 200000) // 最小计费额远超任何余额

	// 未开通（从未入账）：闸门不适用 ⇒ 放行并真实调用上游。
	w := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("未开通余额账户 status = %d %s, want 200（闸门不适用）", w.Code, w.Body.String())
	}
	if n := f.requests.Load(); n != 1 {
		t.Fatalf("未开通账户 upstream calls = %d, want 1", n)
	}

	// 管理员豁免：即使余额为 0 也放行（与既有口径一致）。
	adminToken := issueAdminGatewayToken(t, db)
	w2 := doPost(t, r, "/v1/chat/completions", admissionProbeBody, adminToken, nil)
	if w2.Code != http.StatusOK {
		t.Fatalf("管理员 status = %d %s, want 200（管理员豁免余额闸门）", w2.Code, w2.Body.String())
	}
}

// TestBalanceAdmissionFloorNeverLowers 钉下限的单调性：并发/重试下只抬不降
// （更保守 = 更不容易放行烧额度）。
func TestBalanceAdmissionFloorNeverLowers(t *testing.T) {
	resetBalanceAdmissionState(t)
	serverstore.RecordBalanceSettlementFailure(7, 5)
	if floor, ok := serverstore.BalanceAdmissionFloor(7); !ok || floor != 5_000_000 {
		t.Fatalf("floor = %d ok=%v, want 5000000 微元（5 元）", floor, ok)
	}
	serverstore.RecordBalanceSettlementFailure(7, 1) // 更低的值不得把下限拉下来
	if floor, _ := serverstore.BalanceAdmissionFloor(7); floor != 5_000_000 {
		t.Fatalf("较低余额把下限拉低了: %d，want 5000000", floor)
	}
	serverstore.RecordBalanceSettlementFailure(7, 9) // 更高 ⇒ 抬上去
	if floor, _ := serverstore.BalanceAdmissionFloor(7); floor != 9_000_000 {
		t.Fatalf("更高余额没有抬高下限: %d，want 9000000", floor)
	}
}

// TestBalanceRejectionLogIsThrottledPerUser 钉"证据可检索但日志不被刷爆"：
// 同一用户 1 分钟内只打一条日志，被抑制的条数累计到下一次（信息不丢）。
func TestBalanceRejectionLogIsThrottledPerUser(t *testing.T) {
	resetBalanceAdmissionState(t)
	base := time.Now()
	if ok, _ := shouldLogBalanceRejection(42, base); !ok {
		t.Fatal("第一次拒绝必须打日志（否则运维看不到任何东西）")
	}
	for i := 0; i < 5; i++ {
		if ok, _ := shouldLogBalanceRejection(42, base.Add(time.Duration(i+1)*time.Second)); ok {
			t.Fatal("1 分钟内的后续拒绝不该逐条打日志（会被循环请求刷爆）")
		}
	}
	ok, suppressed := shouldLogBalanceRejection(42, base.Add(balanceRejectionLogInterval+time.Second))
	if !ok {
		t.Fatal("超过节流窗口后必须再打一条")
	}
	if suppressed != 5 {
		t.Fatalf("suppressed = %d, want 5（被抑制的条数必须累计上报，信息不丢）", suppressed)
	}
	// 另一个用户有自己的窗口（节流是 per-user 的）。
	if ok, _ := shouldLogBalanceRejection(43, base); !ok {
		t.Fatal("不同用户的节流窗口必须独立")
	}
}

// issueAdminGatewayToken 造一个管理员账号并签发网关令牌（钉"管理员豁免"那一半契约）。
func issueAdminGatewayToken(t *testing.T, db *sql.DB) string {
	t.Helper()
	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "boss", Source: "local", Status: 1, IsAdmin: true})
	if err != nil {
		t.Fatalf("建管理员: %v", err)
	}
	u, err := serverstore.GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	u.IsAdmin = true
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatalf("置管理员: %v", err)
	}
	tok, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatalf("签发管理员令牌: %v", err)
	}
	return tok
}

// errCodeOf 取错误信封里的 code（断言失败时打印完整 body 便于定位）。
func errCodeOf(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	body := w.Body.String()
	i := strings.Index(body, `"code":"`)
	if i < 0 {
		t.Fatalf("响应不是错误信封: %s", body)
	}
	rest := body[i+len(`"code":"`):]
	j := strings.Index(rest, `"`)
	return rest[:j]
}
