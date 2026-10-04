package llmgateway

// S2-01（审计 2026-10-04，P1）：**不可路由的模型名**在余额闸门开启时被 429
// MODEL_NOT_PRICED 顶替了 handler 的 404 NOT_FOUND。
//
// 机制：五个网关端点都在 `MatchModelsByProtocol`（随后 `len(ups) == 0 ⇒ 404`）**之前**
// 跑钱闸门。名字拼错 / 模型已删 / provider 停用或协议不匹配时候选集合为空，
// `admissionPricingFor` 给出 `candidates == 0`，而修前 ③ 层会回落到"按名字取一行价"
// （`serverstore.ModelPrices`：查不到行返回 0,0）⇒ 判成未定价 ⇒ 429 + 一句"请联系
// 管理员在网关的模型列表里为它填写价格"——把一个**不存在的模型**说成"没定价"。
//
// 修后契约（本文件钉住的三条，全部只看**响应码 + error.code**，不看源码字符串）：
//  1. 闸门开启 + 不可路由的模型名 ⇒ 与闸门关闭时逐字一致：**404 NOT_FOUND**，
//     且钱闸门**不记账**（不是"把 429 换个码"）；
//  2. 闸门开启 + 存在但零定价的模型 ⇒ 仍然 **429 MODEL_NOT_PRICED**（对照面，别修坏）；
//  3. 与模型无关的 ①② 层（分位余额 ≤ 0 / 学到的下限）**保留**：不可路由的名字上
//     仍然 429 BALANCE_EXHAUSTED（理由见 balance_gate.go 的早退注释：这两条只读
//     请求者本人的账户状态，不读模型目录、不读定价 ⇒ 未知模型名在其上零信息增益，
//     而余额本身是该用户能从账户读面看到的量；跳过它们反而是对外契约的另一处变更）。
//
// 每条用例都带**闸门确实在跑**的正控（同一 DB、同一账号、同一个库上可路由的未定价
// 模型必须 429 MODEL_NOT_PRICED）——否则"闸门被整体关掉"也会让 404 断言变绿。
//
// 正控**逐端点**（S2-01 验证报告 §4 的判据缺口 (b)，M5）：主用例的正控原先硬写
// `/v1/chat/completions`，于是某一个端点的闸门接线被整块拆掉（实测：删掉
// `embedding.go` 的 `rejectBalanceAdmission` 调用）时原套件仍然 exit=0 —— 那个端点的
// 404 断言靠"闸门开着但没参与"同样成立。现在正控打在本用例自己的 `tc.path` 上。
//
// 另加一条独立用例 `TestBalanceAdmissionRouteLookupFailureStaysFailClosed` 钉住早退
// 条件里的 `!pricing.lookupFailed`（同报告 §4 的缺口 (a)，M1：丢掉它时原套件 exit=0）。

import (
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// unroutableModel 在 `gateway_providers.models` 与 `models` 里都不存在：前者让
// `MatchModelsByProtocol` 返回空集（handler ⇒ 404），后者让修前的"按名字取一行"
// 回退拿到 0,0（⇒ 误判未定价 ⇒ 429）。
const unroutableModel = "no-such-model-xyz"

// routableModel 是 seed 里那个"存在、可路由"的模型名（正控把它置成 0 价）。
const routableModel = "deepseek-chat"

// unroutableChatBody 与 admissionProbeBody 同形，只换模型名。
const unroutableChatBody = `{"model":"` + unroutableModel + `","messages":[{"role":"user","content":"hi"}]}`

// TestBalanceAdmissionUnroutableModelKeeps404 是主判据（五个端点同源，全部覆盖）。
//
// 每格两跳：闸门关闭（v2.8.1 的常规路径）与闸门开启（三套生产栈的常规配置）——
// 两者的错误面必须逐字一致；随后是正控（证明闸门在这个库上确实会拒绝）。
func TestBalanceAdmissionUnroutableModelKeeps404(t *testing.T) {
	// label 是端点在 `rejectBalanceAdmission(..., where, ...)` 里传的端点标签，
	// 与 `BalanceAdmissionStats()` 的 `Endpoint` 对拍（正控"确实由**本端点**触发"）。
	cases := []struct{ name, path, body, label string }{
		{"chat", "/v1/chat/completions", unroutableChatBody, "chat"},
		{"completions", "/v1/completions", `{"model":"` + unroutableModel + `","prompt":"hi"}`, "completions"},
		{"responses", "/v1/responses", `{"model":"` + unroutableModel + `","input":"hi"}`, "responses"},
		{"messages", "/v1/messages", unroutableChatBody, "messages"},
		{"embeddings", "/v1/embeddings", `{"model":"` + unroutableModel + `","input":"hi"}`, "embeddings"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetBalanceAdmissionState(t)
			f := newFakeUpstream(t)
			r, db, token := newGateway(t, f)
			activateBalance(t, db, 1, 10.0) // 余额充足：不是 ①② 层的问题

			// 基线：闸门关闭（v2.8.1 的常规路径）。
			enableBalanceGate(t, db, false)
			off := doPost(t, r, tc.path, tc.body, token, nil)

			// 闸门开启：结论必须与基线一致。
			enableBalanceGate(t, db, true)
			on := doPost(t, r, tc.path, tc.body, token, nil)

			if off.Code != http.StatusNotFound || errCodeOf(t, off) != "NOT_FOUND" {
				t.Fatalf("基线（闸门关闭）就不是 404 NOT_FOUND: status=%d code=%s body=%s",
					off.Code, errCodeOf(t, off), off.Body.String())
			}
			if on.Code != http.StatusNotFound {
				t.Fatalf("闸门开启 + 不可路由的模型名 status = %d, want 404（修前 = 429 MODEL_NOT_PRICED 顶替 404）: %s",
					on.Code, on.Body.String())
			}
			if code := errCodeOf(t, on); code != "NOT_FOUND" {
				t.Fatalf("闸门开启 + 不可路由的模型名 error.code = %q, want NOT_FOUND（修前 = MODEL_NOT_PRICED）", code)
			}
			// 钱闸门**没有参与**：它既不该改写响应，也不该记账（只断言状态码的话，
			// "照旧按未定价记账、再把响应码改成 404"也能骗过判据）。
			if count, last, _ := serverstore.BalanceAdmissionStats(); count != 0 {
				t.Fatalf("钱闸门对不可路由的名字记了 %d 次拒绝（最近一条 reason=%s），want 0", count, last.Reason)
			}
			if n := f.requests.Load(); n != 0 {
				t.Fatalf("upstream calls = %d, want 0（不可路由的名字不得转发）", n)
			}

			// 正控：**本端点自己**的闸门接线必须生效 —— 把模型换成"存在但零定价"的
			// 那个名字，闸门必须当场拒绝。
			//
			// ⚠️ 这里不得硬写 `/v1/chat/completions`（判据缺口 (b)）：正控只打一个端点时，
			// 另一个端点的闸门接线被整块拆掉，本用例照旧绿。
			//
			// messages 的候选走 anthropic 协议，而 seed 的 provider 是 openai-only ⇒ 先把
			// 协议放宽成 both，让**每个**端点在自己的协议上都有候选（三个负例轮次已跑完，
			// 且负例用的名字在任何协议下都不可路由，不受影响）。
			if _, err := db.Exec(`UPDATE gateway_providers SET protocol = 'both' WHERE id = 1`); err != nil {
				t.Fatal(err)
			}
			setModelPrices(t, db, 0, 0)
			s18Reload()
			before, _, _ := serverstore.BalanceAdmissionStats()

			// 正控的请求体 = 负例体换名（同一个端点解析器已经受过的形状）。
			ctrlBody := strings.Replace(tc.body, unroutableModel, routableModel, 1)
			ctrl := doPost(t, r, tc.path, ctrlBody, token, nil)
			if ctrl.Code != http.StatusTooManyRequests || errCodeOf(t, ctrl) != "MODEL_NOT_PRICED" {
				t.Fatalf("正控（本端点的闸门必须生效）%s: status=%d code=%s body=%s, want 429 MODEL_NOT_PRICED"+
					"（404/502/200 都说明该端点的闸门接线没跑）",
					tc.path, ctrl.Code, errCodeOf(t, ctrl), ctrl.Body.String())
			}
			count, last, _ := serverstore.BalanceAdmissionStats()
			if count != before+1 || last.Reason != "unpriced_model" || last.Endpoint != tc.label {
				t.Fatalf("正控的拒绝记账 = count:%d(起始 %d) reason:%s endpoint:%s, want count:+1 reason:unpriced_model endpoint:%s",
					count, before, last.Reason, last.Endpoint, tc.label)
			}
			if n := f.requests.Load(); n != 0 {
				t.Fatalf("被钱闸门拒绝的请求不得转发上游: upstream calls = %d, want 0", n)
			}
		})
	}
}

// TestBalanceAdmissionRoutableZeroPricedModelStillRefused 是对照面（回归保护）：
// **存在**的模型（`MatchModelsByProtocol` 有候选）但定价为 0 ⇒ 仍然是
// 429 MODEL_NOT_PRICED。修法只应把 404 还给"不可路由"，不得顺手放过真正要拦的形态。
func TestBalanceAdmissionRoutableZeroPricedModelStillRefused(t *testing.T) {
	resetBalanceAdmissionState(t)
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	setModelPrices(t, db, 0, 0) // 存在（可路由）但 0 价
	activateBalance(t, db, 1, 10.0)

	w := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("零定价的可路由模型 status = %d %s, want 429", w.Code, w.Body.String())
	}
	if code := errCodeOf(t, w); code != "MODEL_NOT_PRICED" {
		t.Fatalf("零定价的可路由模型 error.code = %q, want MODEL_NOT_PRICED", code)
	}
	if _, last, _ := serverstore.BalanceAdmissionStats(); last.Reason != "unpriced_model" {
		t.Fatalf("零定价的可路由模型拒绝依据 = %q, want unpriced_model", last.Reason)
	}
	if n := f.requests.Load(); n != 0 {
		t.Fatalf("upstream calls = %d, want 0", n)
	}
}

// TestBalanceAdmissionProtocolMismatchKeeps404 是"不可路由"的第二种形态：模型**存在**
// 且**在别的协议下可路由**，但本端点协议上没有候选（seeded provider 是 openai-only，
// 同一个名字发到 anthropic 的 `/v1/messages`）。它同样不是"没定价"，结论归 handler。
func TestBalanceAdmissionProtocolMismatchKeeps404(t *testing.T) {
	resetBalanceAdmissionState(t)
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	setModelPrices(t, db, 0, 0) // 0 价：若"不可路由"被误判成"未定价"，这里就会 429
	activateBalance(t, db, 1, 10.0)

	// 正控：同一个 0 价模型在它真正可路由的协议（openai/chat）上必须 429。
	ctrl := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil)
	if ctrl.Code != http.StatusTooManyRequests || errCodeOf(t, ctrl) != "MODEL_NOT_PRICED" {
		t.Fatalf("正控（同名字在 openai 协议上）: status=%d code=%s, want 429 MODEL_NOT_PRICED",
			ctrl.Code, errCodeOf(t, ctrl))
	}

	w := doPost(t, r, "/v1/messages", admissionProbeBody, token, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("协议不匹配（该名字在 anthropic 端点无候选）status = %d %s, want 404", w.Code, w.Body.String())
	}
	if code := errCodeOf(t, w); code != "NOT_FOUND" {
		t.Fatalf("协议不匹配 error.code = %q, want NOT_FOUND", code)
	}
	if count, _, _ := serverstore.BalanceAdmissionStats(); count != 1 {
		t.Fatalf("钱闸门拒绝计数 = %d, want 1（只有正控那一次；协议不匹配那次不得记账）", count)
	}
	if n := f.requests.Load(); n != 0 {
		t.Fatalf("upstream calls = %d, want 0", n)
	}
}

// TestBalanceAdmissionUnroutableModelWithStalePricedRowKeeps404 是"不可路由"的第三种
// 形态，也是审计探针**没有**覆盖的同族写法：名字在 `models` 表里**还留着正的价**
// （provider 已停用 / 目录已移除），只是没有候选 provider。修前 ③ 的按名字回退会读到
// 这个残留价 ⇒ 判成"已定价"，于是 ④ 用同一份残留价算出下界 ⇒ 仍然 429（换成
// `BALANCE_EXHAUSTED`）—— 同一个根因的另一个错误面（错误码不同、误导相同）。
func TestBalanceAdmissionUnroutableModelWithStalePricedRowKeeps404(t *testing.T) {
	resetBalanceAdmissionState(t)
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	// 残留的正价：短 prompt 的下界 ≈ 8 token × 5000/1M = 0.04 元 > 余额 0.01 ⇒ ④ 命中。
	setModelPrices(t, db, 5000, 3000)
	activateBalance(t, db, 1, 0.01)

	// 正控（provider 还在）：可路由的名字上，④ 最小计费额照旧生效 ——
	// 429 BALANCE_EXHAUSTED / reason=min_billable（这条路径不得被本次修复改动）。
	ctrl := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil)
	if ctrl.Code != http.StatusTooManyRequests || errCodeOf(t, ctrl) != "BALANCE_EXHAUSTED" {
		t.Fatalf("正控（可路由 + 残留价 + 余额盖不住下界）: status=%d code=%s body=%s, want 429 BALANCE_EXHAUSTED",
			ctrl.Code, errCodeOf(t, ctrl), ctrl.Body.String())
	}
	if _, last, _ := serverstore.BalanceAdmissionStats(); last.Reason != "min_billable" {
		t.Fatalf("正控的拒绝依据 = %q, want min_billable", last.Reason)
	}
	if n := f.requests.Load(); n != 0 {
		t.Fatalf("正控就不该转发上游：upstream calls = %d, want 0（否则结算会顺带抬起学到的下限，污染下一步）", n)
	}

	// 停用 provider：名字不可路由，但价还在 ⇒ 结论必须归 handler 的 404。
	if _, err := db.Exec(`UPDATE gateway_providers SET enabled = 0 WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	s18Reload()

	w := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("不可路由 + 残留价 status = %d %s, want 404（修前 = 429 BALANCE_EXHAUSTED）", w.Code, w.Body.String())
	}
	if code := errCodeOf(t, w); code != "NOT_FOUND" {
		t.Fatalf("不可路由 + 残留价 error.code = %q, want NOT_FOUND", code)
	}
	if count, _, _ := serverstore.BalanceAdmissionStats(); count != 1 {
		t.Fatalf("钱闸门拒绝计数 = %d, want 1（只有正控那一次）", count)
	}
	if n := f.requests.Load(); n != 0 {
		t.Fatalf("upstream calls = %d, want 0", n)
	}
}

// TestBalanceAdmissionUnroutableModelKeepsModelIndependentLayers 钉"①② 层保留"这个
// 判定（S2-01 判定记录）：不可路由的名字上，与模型无关的两条仍然生效 —— 否则
// "余额 0 的账号请求一个不存在的模型"会从 v2.8.1 的 429 BALANCE_EXHAUSTED 变成 404。
func TestBalanceAdmissionUnroutableModelKeepsModelIndependentLayers(t *testing.T) {
	t.Run("non_positive_balance", func(t *testing.T) {
		resetBalanceAdmissionState(t)
		f := newFakeUpstream(t)
		r, db, token := newGateway(t, f)
		enableBalanceGate(t, db, true)
		activateBalance(t, db, 1, 1)
		activateBalance(t, db, 1, 0) // 花光

		w := doPost(t, r, "/v1/chat/completions", unroutableChatBody, token, nil)
		if w.Code != http.StatusTooManyRequests {
			t.Fatalf("余额 ≤ 0 + 不可路由的名字 status = %d %s, want 429", w.Code, w.Body.String())
		}
		if code := errCodeOf(t, w); code != "BALANCE_EXHAUSTED" {
			t.Fatalf("余额 ≤ 0 的拒绝码 = %q, want BALANCE_EXHAUSTED（不得变成 MODEL_NOT_PRICED/404）", code)
		}
		if _, last, _ := serverstore.BalanceAdmissionStats(); last.Reason != "non_positive" {
			t.Fatalf("余额 ≤ 0 的拒绝依据 = %q, want non_positive", last.Reason)
		}
		if n := f.requests.Load(); n != 0 {
			t.Fatalf("upstream calls = %d, want 0", n)
		}
	})

	t.Run("learned_floor", func(t *testing.T) {
		resetBalanceAdmissionState(t)
		f := newFakeUpstream(t)
		r, db, token := newGateway(t, f)
		enableBalanceGate(t, db, true)
		activateBalance(t, db, 1, 1)
		activateBalance(t, db, 1, 0.01)
		serverstore.RecordBalanceSettlementFailure(1, 0.01)

		w := doPost(t, r, "/v1/chat/completions", unroutableChatBody, token, nil)
		if w.Code != http.StatusTooManyRequests {
			t.Fatalf("学到的下限 + 不可路由的名字 status = %d %s, want 429", w.Code, w.Body.String())
		}
		if code := errCodeOf(t, w); code != "BALANCE_EXHAUSTED" {
			t.Fatalf("学到的下限的拒绝码 = %q, want BALANCE_EXHAUSTED", code)
		}
		if _, last, _ := serverstore.BalanceAdmissionStats(); last.Reason != "learned_floor" {
			t.Fatalf("学到的下限的拒绝依据 = %q, want learned_floor", last.Reason)
		}
		if n := f.requests.Load(); n != 0 {
			t.Fatalf("upstream calls = %d, want 0", n)
		}
	})
}

// TestBalanceAdmissionRouteLookupFailureStaysFailClosed 钉早退条件里的
// `!pricing.lookupFailed`（S2-01 判据缺口 (a)；验证报告 §4 的 M1：把它丢掉时原套件
// exit=0，只有验证方的独立套件咬住）。
//
// 语义：`admissionPricingFor` 在 `MatchModelsByProtocol` **返回 error**（不是空集）时给出
// `{candidates:0, lookupFailed:true}` ⇒ 闸门在转发之前拒绝（fail-closed），但用的是
// **独立错误码** `MODEL_ROUTING_UNAVAILABLE`（+ reason `routing_lookup_failed`），而不是
// ③ 层的 `429 MODEL_NOT_PRICED`："判不出来"与"未定价"是两件事（S2-01 验证报告 §2 的
// 同族补集：修前后者顶替前者，把一次数据库读取故障说成模型的定价问题）。这与"不可路由"
// （⇒ 404 归 handler）也是**两种不同的结论**：早退只放行后者。
//
// `unpricedFor` 对 lookupFailed 恒真这条仍保留为纵深防御（语义层判据见本文件末尾）。
//
// 可控形态：把路由表改名（SQLSTATE 42P01）⇒ `MatchModelsByProtocol` 必然返回 error。
// 该形态在整个用例里稳定成立：`loadUpstreamsCached` **只在成功时写缓存**（见 upstream.go），
// 一次读失败不会被缓存成"空集"；DB 又是每用例独立克隆的临时库（`serverstore.NewTestDB`），
// 改名不外溢。
func TestBalanceAdmissionRouteLookupFailureStaysFailClosed(t *testing.T) {
	resetBalanceAdmissionState(t)
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	setModelPrices(t, db, 0, 0)
	activateBalance(t, db, 1, 10.0)

	// 正控：读面完好时闸门确实在跑（可路由 + 0 价 ⇒ 429 MODEL_NOT_PRICED）。
	ctrl := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil)
	if ctrl.Code != http.StatusTooManyRequests || errCodeOf(t, ctrl) != "MODEL_NOT_PRICED" {
		t.Fatalf("正控（读面完好）: status=%d code=%s body=%s, want 429 MODEL_NOT_PRICED",
			ctrl.Code, errCodeOf(t, ctrl), ctrl.Body.String())
	}
	if count, _, _ := serverstore.BalanceAdmissionStats(); count != 1 {
		t.Fatalf("正控的拒绝计数 = %d, want 1", count)
	}

	// 把"路由面读失败"做成事实，并断言形态确实是 **error**（不是空集）——否则本用例会
	// 悄悄退化成"又测了一遍不可路由 404"，而那条分支已经有别的用例。
	if _, err := db.Exec(`ALTER TABLE gateway_providers RENAME TO gateway_providers_hidden`); err != nil {
		t.Fatal(err)
	}
	s18Reload()
	if _, err := MatchModelsByProtocol(db, routableModel, "openai"); err == nil {
		t.Fatalf("前置不成立：路由表改名后 MatchModelsByProtocol 仍返回 nil error（本用例要的是 lookupFailed 形态）")
	}

	// 闸门开启 + 路由面读失败 ⇒ **不早退**：保持 fail-closed，但呈现必须与"未定价"
	// **可区分**（S2-01 验证报告 §2 的同族补集：修前它落进 ③，用
	// `429 MODEL_NOT_PRICED` + "该模型未配置价格…" 把一次数据库读取故障说成模型的
	// 定价问题，与闸门关闭时的 `500 INTERNAL 模型路由查询失败` 也对不上）。
	on := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil)
	if on.Code != http.StatusTooManyRequests {
		t.Fatalf("路由面读失败（闸门开）status = %d %s, want 429 —— 丢掉早退条件里的 "+
			"!pricing.lookupFailed 时这里会变成 handler 的 500 INTERNAL（等于闸门对这条分支失效）",
			on.Code, on.Body.String())
	}
	if code := errCodeOf(t, on); code != "MODEL_ROUTING_UNAVAILABLE" {
		t.Fatalf("路由面读失败（闸门开）error.code = %q, want MODEL_ROUTING_UNAVAILABLE"+
			"（若变成 MODEL_NOT_PRICED，就是把「判不出来」说成了「未定价」——管理员会照着"+
			"提示去查定价，永远查不出问题）", code)
	}
	if body := on.Body.String(); !strings.Contains(body, "模型路由暂不可用") {
		t.Fatalf("路由面读失败的文案没有点名真实原因: %s", body)
	}
	count, last, _ := serverstore.BalanceAdmissionStats()
	if count != 2 || last.Reason != "routing_lookup_failed" || last.Endpoint != "chat" {
		t.Fatalf("路由面读失败的拒绝记账 = count:%d reason:%s endpoint:%s, want count:2 reason:routing_lookup_failed endpoint:chat"+
			"（reason 是机器可读的归因面，记成 unpriced_model 会把运维引向定价）",
			count, last.Reason, last.Endpoint)
	}
	if n := f.requests.Load(); n != 0 {
		t.Fatalf("路由面读失败时不得转发上游: upstream calls = %d, want 0", n)
	}

	// 闸门关闭 ⇒ 该路径的**既有行为**：handler 的 500 INTERNAL（不是 200 放行）。
	// 两跳都要钉：只钉闸门开那一跳时，"把 429 换成 500/200"也能骗过判据。
	enableBalanceGate(t, db, false)
	off := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil)
	if off.Code != http.StatusInternalServerError {
		t.Fatalf("路由面读失败（闸门关）status = %d %s, want 500 INTERNAL（handler 的「模型路由查询失败」）",
			off.Code, off.Body.String())
	}
	if code := errCodeOf(t, off); code != "INTERNAL" {
		t.Fatalf("路由面读失败（闸门关）error.code = %q, want INTERNAL", code)
	}
	if after, _, _ := serverstore.BalanceAdmissionStats(); after != 2 {
		t.Fatalf("闸门关闭后不得记账：拒绝计数 = %d, want 2", after)
	}
	if n := f.requests.Load(); n != 0 {
		t.Fatalf("路由面读失败时不得转发上游: upstream calls = %d, want 0", n)
	}

	// 语义层补判据（与上面的端到端判据**成对**存在）：`candidates > 0 && lookupFailed`
	// 这条子形态在 SQL 层构造不出来 —— `modelPricesForProviderQ` 把取价失败吞成 0、0、0，
	// `ModelPricesForProviders` 只在开只读连接失败时才返回 error。所以直接钉判据函数
	// 本身：`unpricedFor` 必须对 lookupFailed 恒真，不得被当成"已定价"放行。
	if !(admissionPricing{candidates: 1, lookupFailed: true}).unpricedFor(false) {
		t.Fatalf("unpricedFor(candidates=1, lookupFailed=true) = false, want true（判不出来必须按未定价 fail-closed）")
	}
}
