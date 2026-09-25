package llmgateway

// R17A-06（审计 2026-09-25，P1）：**未定价模型**（输入价 NULL 或 <= 0）上，
// R16C-02 的第 ③ 层（最小计费额）整体不参与：
//
//	minBillableMicro: inputPer1M <= 0 ⇒ ok=false ⇒ 「算不出下界就不拦」
//
// 而成本侧对**同一份 0 价**算出的 cost 也是 0 —— 结算不会因余额不足失败
// （ErrInsufficientBalance 不产生）⇒ 第 ② 层「学到的下限」永不置位、余额一分不减
// ⇒ 第 ① 层（分位余额 <= 0）也永不成立。三层同时失效，账号可以**无限次**真实调用
// 上游（组织按平台的 key 付费），而平台上零计费、零扣款、零痕迹。
//
// 这不是"配置错误不可归因于修复"：`ModelPrices` 把 NULL 当 0、迁移
// 0022_money_quota.sql 的 `input_price_per_1m DOUBLE PRECISION` **可空且无默认值**
// ⇒ **新建模型未填价就是这个状态**，而成本侧对同一份 0 价没有等价的兜底 ——
// 判据两面口径不一致。
//
// 修法（本文件钉的契约）：准入对「未定价模型」**fail-closed 拒绝**（默认策略
// `reject`），错误码 `MODEL_NOT_PRICED`，拒绝记 `reason=unpriced_model`；
// 逃生门是网关设置 `gateway.unpriced_model_policy=allow`（显式声明"本组织确实有
// 免费/内部模型"），见 TestBalanceAdmissionUnpricedModelPolicyAllow。
//
// 为什么不是「按保守默认价算一个兜底最小计费额」：最小计费额 = prompt token × 单价，
// 而余额可以是**任意小的正数**（探针用 0.01 元）—— 任何按 token 计的单价 × 一个短
// prompt 都远小于 0.01 元，闸门照样放行，而成本恒为 0 ⇒ 循环依旧无界。也就是
// "兜底价"只能抬高放行门槛、不能闭合"余额永不减少"这个洞；能闭合的只有拒绝
// （或按兜底价**真的收费**，那等于平台凭空定价，不在本仓语义内）。

import (
	"bytes"
	"log"
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// unpricedProbeBody 与 admissionProbeBody 同形（短 prompt：兜底价方案在此形态下
// 仍会放行，正是本文件要钉住的洞察）。
const unpricedProbeBody = admissionProbeBody

// TestBalanceAdmissionRefusesUnpricedModel 钉 NULL 定价（= 新建模型未填价的默认态）。
//
// 修前实测：余额 0.01 的账号连发 20 次 ⇒ 20/20 交付、20 次真实上游命中、余额一分未减。
// 修后：0 次交付、0 次上游命中，且拒绝可检索（reason=unpriced_model）。
func TestBalanceAdmissionRefusesUnpricedModel(t *testing.T) {
	resetBalanceAdmissionState(t)
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	if _, err := db.Exec(`UPDATE models SET input_price_per_1m = NULL, output_price_per_1m = NULL WHERE name='deepseek-chat'`); err != nil {
		t.Fatal(err)
	}
	activateBalance(t, db, 1, 0.01)

	const rounds = 20
	delivered := 0
	for i := 0; i < rounds; i++ {
		w := doPost(t, r, "/v1/chat/completions", unpricedProbeBody, token, nil)
		if w.Code == http.StatusOK {
			delivered++
			continue
		}
		if w.Code != http.StatusTooManyRequests {
			t.Fatalf("第 %d 次 status = %d %s, want 429", i+1, w.Code, w.Body.String())
		}
		if code := errCodeOf(t, w); code != "MODEL_NOT_PRICED" {
			t.Fatalf("第 %d 次 error.code = %q, want MODEL_NOT_PRICED", i+1, code)
		}
	}
	if delivered != 0 {
		t.Fatalf("未定价模型上交付了 %d/%d 次（修前 = 20/20：每次都是真实上游调用 + 零计费）", delivered, rounds)
	}
	if n := f.requests.Load(); n != 0 {
		t.Fatalf("upstream calls = %d, want 0 —— 未定价模型的请求不得转发（修前 = %d）", n, rounds)
	}
	count, last, ok := serverstore.BalanceAdmissionStats()
	if !ok || count < rounds {
		t.Fatalf("准入拒绝没有留下可检索证据: count=%d ok=%v (want >= %d)", count, ok, rounds)
	}
	if last.Reason != "unpriced_model" {
		t.Fatalf("拒绝依据 = %q, want unpriced_model", last.Reason)
	}
	if last.Model != "deepseek-chat" || last.Endpoint != "chat" {
		t.Fatalf("拒绝形状缺少模型/端点: %+v", last)
	}
	// 余额与账本一字未动（拒绝发生在任何写入之前）。
	assertNoUsageAndBalanceIntact(t, db, 0.01)
}

// TestBalanceAdmissionRefusesZeroPricedModel 钉显式 0 定价（0022 的
// `nil/0 = 未定价`，见 serverstore.Model 的字段注释）。
//
// 修前实测：余额 0.01 的账号连发 25 次 ⇒ 25/25 交付、25 次真实上游命中。
func TestBalanceAdmissionRefusesZeroPricedModel(t *testing.T) {
	resetBalanceAdmissionState(t)
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	setModelPrices(t, db, 0, 0)
	activateBalance(t, db, 1, 0.01)

	const rounds = 25
	for i := 0; i < rounds; i++ {
		w := doPost(t, r, "/v1/chat/completions", unpricedProbeBody, token, nil)
		if w.Code != http.StatusTooManyRequests {
			t.Fatalf("第 %d 次 status = %d %s, want 429", i+1, w.Code, w.Body.String())
		}
	}
	if n := f.requests.Load(); n != 0 {
		t.Fatalf("零定价模型 upstream calls = %d, want 0（修前 = %d）", n, rounds)
	}
	if _, last, _ := serverstore.BalanceAdmissionStats(); last.Reason != "unpriced_model" {
		t.Fatalf("拒绝依据 = %q, want unpriced_model", last.Reason)
	}
}

// TestBalanceAdmissionUnpricedModelPolicyAllow 钉**逃生门与误伤面**：
// 显式把策略改成 allow（本组织确实有免费/内部模型）后逐字回到历史行为 ——
// 未定价模型照常放行、上游被真实调用。
//
// 这条同时是"修复没有把合法免费模型一刀切死"的判据；默认值必须是 reject，
// 理由见包内 SettingUnpricedModelPolicy 的注释（默认放行 = 洞原样保留）。
func TestBalanceAdmissionUnpricedModelPolicyAllow(t *testing.T) {
	resetBalanceAdmissionState(t)
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	setModelPrices(t, db, 0, 0)
	if err := serverstore.SetSetting(db, serverstore.UnpricedModelPolicySetting, serverstore.UnpricedModelPolicyAllow); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(serverstore.InvalidateSettings)
	activateBalance(t, db, 1, 0.01)

	if w := doPost(t, r, "/v1/chat/completions", unpricedProbeBody, token, nil); w.Code != http.StatusOK {
		t.Fatalf("policy=allow 时 status = %d %s, want 200（显式声明的免费模型不得被拦）", w.Code, w.Body.String())
	}
	if n := f.requests.Load(); n != 1 {
		t.Fatalf("policy=allow 时 upstream calls = %d, want 1", n)
	}
}

// TestBalanceAdmissionPricedModelUnaffected 钉"别过度修复"：已定价模型的路径
// 逐字不变（第 ① ② ③ 层的行为与理由都不动）。
func TestBalanceAdmissionPricedModelUnaffected(t *testing.T) {
	resetBalanceAdmissionState(t)
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	setModelPrices(t, db, 200000, 200000) // 最小计费额远超余额
	activateBalance(t, db, 1, 0.01)

	w := doPost(t, r, "/v1/chat/completions", unpricedProbeBody, token, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("已定价模型 status = %d %s, want 429（第 ③ 层照旧生效）", w.Code, w.Body.String())
	}
	if code := errCodeOf(t, w); code != "BALANCE_EXHAUSTED" {
		t.Fatalf("已定价模型的拒绝码 = %q, want BALANCE_EXHAUSTED（不得被新码替换）", code)
	}
	if _, last, _ := serverstore.BalanceAdmissionStats(); last.Reason != "min_billable" {
		t.Fatalf("已定价模型的拒绝依据 = %q, want min_billable", last.Reason)
	}
	if n := f.requests.Load(); n != 0 {
		t.Fatalf("upstream calls = %d, want 0", n)
	}
}

// TestUnpricedModelPolicyIsOperableThroughAdminGatewayConfig 钉"逃生门真的可操作":
// 管理端 GET 回显生效值（缺省 = reject），PUT 能改成 allow 并**进审计的字段级明细**，
// 非法取值一律 400 且不落库（写错一个字母想关闸门必须当场知道）。
func TestUnpricedModelPolicyIsOperableThroughAdminGatewayConfig(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	w, out := adminReq(t, r, "GET", "/api/server/admin/gateway", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("GET gateway = %d %s", w.Code, w.Body.String())
	}
	if got, _ := out["unpriced_model_policy"].(string); got != serverstore.UnpricedModelPolicyReject {
		t.Fatalf("空库 GET unpriced_model_policy = %v, want %q（缺省必须回显生效值）",
			out["unpriced_model_policy"], serverstore.UnpricedModelPolicyReject)
	}

	// 非法取值：400 + 不落库。
	w, _ = adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"unpriced_model_policy":"permit"}`, hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("非法取值 status = %d %s, want 400", w.Code, w.Body.String())
	}
	if _, ok := gwcSetting(t, db, serverstore.UnpricedModelPolicySetting); ok {
		t.Fatal("非法取值被写进了库（拒绝不得留下半套配置）")
	}

	// 合法取值：200 + 生效 + 审计明细带"旧→新"。
	w, _ = adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"unpriced_model_policy":"allow"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("合法取值 status = %d %s, want 200", w.Code, w.Body.String())
	}
	if got, ok := gwcSetting(t, db, serverstore.UnpricedModelPolicySetting); !ok || got != serverstore.UnpricedModelPolicyAllow {
		t.Fatalf("落库值 = %q ok=%v, want allow", got, ok)
	}
	var detail string
	if err := db.QueryRow(`SELECT detail FROM audit_logs WHERE action = 'gateway_config' ORDER BY id DESC LIMIT 1`).Scan(&detail); err != nil {
		t.Fatalf("审计行缺失: %v", err)
	}
	if !strings.Contains(detail, "未定价模型策略") || !strings.Contains(detail, "allow") {
		t.Fatalf("审计明细没有记录本次变更: %q", detail)
	}
	// 运行期立刻可见（同一份读取实现 + 缓存失效）。
	serverstore.InvalidateSettings()
	if got := serverstore.UnpricedModelPolicy(db); got != serverstore.UnpricedModelPolicyAllow {
		t.Fatalf("运行期读到 %q, want allow", got)
	}
}

// TestUnpricedModelPolicyDefaultsToReject 钉默认值：键缺失 / 空 / 非法取值
// 一律回落 reject（fail-closed 方向，不允许一个错字把闸门关掉）。
func TestUnpricedModelPolicyDefaultsToReject(t *testing.T) {
	resetBalanceAdmissionState(t)
	_, db, _ := newGateway(t, newFakeUpstream(t))
	t.Cleanup(serverstore.InvalidateSettings)
	if got := serverstore.UnpricedModelPolicy(db); got != serverstore.UnpricedModelPolicyReject {
		t.Fatalf("缺省策略 = %q, want %q", got, serverstore.UnpricedModelPolicyReject)
	}
	for _, bad := range []string{"", "ALLOW", "permit", "0"} {
		if err := serverstore.SetSetting(db, serverstore.UnpricedModelPolicySetting, bad); err != nil {
			t.Fatal(err)
		}
		serverstore.InvalidateSettings()
		if got := serverstore.UnpricedModelPolicy(db); got != serverstore.UnpricedModelPolicyReject {
			t.Fatalf("非法取值 %q 的回落 = %q, want %q", bad, got, serverstore.UnpricedModelPolicyReject)
		}
	}
}

// TestBalanceRejectionLogLinesAreBounded 钉 R17A-07（P2）：拒绝路径的日志量有上界。
//
// 缺陷形态：llmgateway 侧按用户节流（1 分钟/用户），但它紧接着调用的
// `serverstore.RecordBalanceAdmissionRejection` **无条件** `log.Printf` ⇒ 声称面
// 整体作废。实测 30 次拒绝 = **30 行** `balance admission rejected`。拒绝路径不转发、
// 默认不限速，所以那是个可以按任意速率放大日志的无界写入面。
//
// 修后判据：30 次拒绝（真 HTTP）的日志行数 ≤ 2（节流首行 + 携带 suppressed 的次行；
// 同一分钟内实际为 1 行），且被抑制的条数出现在节流行里（信息不丢）。
func TestBalanceRejectionLogLinesAreBounded(t *testing.T) {
	resetBalanceAdmissionState(t)
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	setModelPrices(t, db, 0, 0) // 未定价 ⇒ 每次都命中准入拒绝
	activateBalance(t, db, 1, 0.01)

	var buf bytes.Buffer
	old := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(old)

	const rounds = 30
	for i := 0; i < rounds; i++ {
		if w := doPost(t, r, "/v1/chat/completions", unpricedProbeBody, token, nil); w.Code != http.StatusTooManyRequests {
			t.Fatalf("第 %d 次 status = %d, want 429", i+1, w.Code)
		}
	}

	gatewayLines := strings.Count(buf.String(), "balance admission refused")
	storeLines := strings.Count(buf.String(), "balance admission rejected")
	if total := gatewayLines + storeLines; total > 2 {
		t.Fatalf("%d 次准入拒绝产生了 %d 行日志（gateway=%d serverstore=%d），want ≤ 2 —— "+
			"拒绝是攻击者可无限触发的事件，日志面必须有上界（修前 = %d 行）",
			rounds, total, gatewayLines, storeLines, rounds)
	}
	if gatewayLines == 0 {
		t.Fatal("节流日志一行都没有 ⇒ 运维看不到任何拒绝（证据面被过度修复关掉）")
	}
	if !strings.Contains(buf.String(), "suppressed_since_last=0") {
		t.Fatalf("节流行缺少 suppressed 计数：%s", buf.String())
	}
	if n := f.requests.Load(); n != 0 {
		t.Fatalf("upstream calls = %d, want 0", n)
	}
	if count, _, _ := serverstore.BalanceAdmissionStats(); count < rounds {
		t.Fatalf("计数 = %d, want >= %d（日志有上界，但计数不能丢）", count, rounds)
	}
}

// TestRecordBalanceAdmissionRejectionDoesNotLog 钉 R17A-07 的根因面：
// serverstore 的记录函数**本身**不再产生日志（唯一出口是 llmgateway 的节流日志）。
// A 泳道的探针正是直接调它 30 次来量日志量的。
func TestRecordBalanceAdmissionRejectionDoesNotLog(t *testing.T) {
	resetBalanceAdmissionState(t)
	var buf bytes.Buffer
	old := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(old)
	for i := 0; i < 30; i++ {
		serverstore.RecordBalanceAdmissionRejection(serverstore.BalanceAdmissionRejection{
			UserID: 42, Username: "alice", Endpoint: "chat", Model: "m",
			Reason: "learned_floor", RequiredMoney: 0.02, BalanceMoney: 0.01,
		})
	}
	if buf.Len() != 0 {
		t.Fatalf("RecordBalanceAdmissionRejection 仍在无条件打日志（%d 字节）:\n%s", buf.Len(), buf.String())
	}
	if n, _, ok := serverstore.BalanceAdmissionStats(); !ok || n != 30 {
		t.Fatalf("计数/最近一条丢了: n=%d ok=%v, want 30/true", n, ok)
	}
}
