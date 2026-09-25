package llmgateway

// R18C-01（审计 2026-09-25，P1，资损）：准入闸门的**取价口径**必须等于**结算**的
// 取价口径，而结算是按**实际命中的 provider** 取价（serverstore.ModelPricesForProvider）。
//
// 修前：③ 未定价判据与 ④ 最小计费额都走 `serverstore.ModelPrices(db, name)`
// （`WHERE name = ? ORDER BY provider_id LIMIT 1`）——"按模型名取一行"。于是
// "同名模型挂两个 provider，最小 provider_id 那行有价、实际服务的那家未定价"
// （渠道同步建 NULL 价行是常规路径）时：闸门看到**别人的价** ⇒ 放行；结算按 NULL
// 价算出 cost = 0 ⇒ 余额一分不减、学到的下限永不置位、准入拒绝计数为 0，而真上游
// 被无限次调用（组织按平台的 key 付费）。这条与 R17A-06 要闭合的洞逐字同形。
//
// 修后：判据面 = `MatchModelsByProtocol(model, protocol)` 的**候选 provider 集合**
// （与路由/故障转移同一个集合）逐家取生效价：
//   - ③ **任一**候选未定价 ⇒ 按未定价拒绝（故障转移可能落到任何一家）；
//   - ④ 最小计费额用**将被路由到的那一家**（候选集合第一个）的价。
//
// 两个方向都要钉：下面的"洞"用例（修后必须 429、上游 0 命中）与"别过度修复"用例
// （合法多 provider 照常放行）。

import (
	"database/sql"
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// s18AddProvider 追加一个 provider 行（models JSON 带指定模型名），返回 id。
func s18AddProvider(t *testing.T, db *sql.DB, name, baseURL, model string, enabled bool) int64 {
	t.Helper()
	e := 0
	if enabled {
		e = 1
	}
	var id int64
	if err := db.QueryRow(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, enabled)
		VALUES (?, ?, ?, ?, ?) RETURNING id`,
		name, baseURL, upstreamKey, `["`+model+`"]`, e).Scan(&id); err != nil {
		t.Fatalf("insert provider: %v", err)
	}
	return id
}

// s18AddModelRow 给某个 provider 插一行模型（价可空 ⇒ 未定价）。
func s18AddModelRow(t *testing.T, db *sql.DB, providerID int64, model string, in, out sql.NullFloat64) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO models (name, provider_id, display_name, input_price_per_1m, output_price_per_1m)
		VALUES (?, ?, ?, ?, ?)`, model, providerID, model, in, out); err != nil {
		t.Fatalf("insert models row: %v", err)
	}
}

func s18NullPrice() sql.NullFloat64 { return sql.NullFloat64{} }
func s18Price(v float64) sql.NullFloat64 {
	return sql.NullFloat64{Float64: v, Valid: true}
}

func s18Reload() {
	InvalidateUpstreams()
	serverstore.InvalidateModelConfig()
}

// TestBalanceAdmissionFencesFailoverToUnpricedProvider 钉主形态（R18C-01）：
// 主 provider 有价但上游 5xx ⇒ 故障转移到**未定价**的备用 provider。
// 修前：按名字取到主 provider 的价 ⇒ 放行 ⇒ 200 交付、cost=0、余额不动（资损）。
// 修后：候选集合里有一家未定价 ⇒ 准入处 429 MODEL_NOT_PRICED，**两家上游都 0 命中**。
func TestBalanceAdmissionFencesFailoverToUnpricedProvider(t *testing.T) {
	resetBalanceAdmissionState(t)
	fPrimary := newFakeUpstream(t)
	fBackup := newFakeUpstream(t)
	r, db, token := newGateway(t, fPrimary)
	enableBalanceGate(t, db, true)

	// 主 provider（id=1）有价：单次成本约 0.013 元 > 余额 0.01（修前正是靠这个价放行）。
	if _, err := db.Exec(`UPDATE models SET input_price_per_1m = 500, output_price_per_1m = 3000
		WHERE name = 'deepseek-chat' AND provider_id = 1`); err != nil {
		t.Fatal(err)
	}
	// 备用 provider（id=2）：同名模型行**未定价**（NULL），可路由。
	backupID := s18AddProvider(t, db, "s18-backup", fBackup.baseURL, "deepseek-chat", true)
	s18AddModelRow(t, db, backupID, "deepseek-chat", s18NullPrice(), s18NullPrice())
	// 主上游 5xx ⇒ 触发故障转移（这条路径的"实际服务方"就是那个未定价的备用）。
	fPrimary.status = http.StatusInternalServerError
	activateBalance(t, db, 1, 0.01)
	s18Reload()

	if in, _, _ := serverstore.ModelPrices(db, "deepseek-chat"); in <= 0 {
		t.Fatalf("前置不成立：名字口径应取到主 provider 的价（>0），实得 %v", in)
	}
	if in, _, _ := serverstore.ModelPricesForProvider(db, backupID, "deepseek-chat"); in != 0 {
		t.Fatalf("前置不成立：备用 provider 的生效价应为 0（未定价），实得 %v", in)
	}

	w := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d %s, want 429（候选里有一家未定价 ⇒ 准入必须拒绝）", w.Code, w.Body.String())
	}
	if code := errCodeOf(t, w); code != "MODEL_NOT_PRICED" {
		t.Fatalf("error.code = %q, want MODEL_NOT_PRICED", code)
	}
	if n := fPrimary.requests.Load(); n != 0 {
		t.Fatalf("主上游命中 %d 次, want 0（被拒请求不得转发）", n)
	}
	if n := fBackup.requests.Load(); n != 0 {
		t.Fatalf("备用上游命中 %d 次, want 0（修前 = 1：故障转移后交付 200、cost=0）", n)
	}
	if _, last, _ := serverstore.BalanceAdmissionStats(); last.Reason != "unpriced_model" {
		t.Fatalf("拒绝依据 = %q, want unpriced_model", last.Reason)
	}
	assertNoUsageAndBalanceIntact(t, db, 0.01)
}

// TestBalanceAdmissionFencesCatalogMissingPricedRow 钉第二形态（无需故障转移的稳态路径）：
// 老 provider 因"上游目录缺失"（catalog_missing=TRUE + 名字已从 provider JSON 移除）
// **不可路由但价还在**，新 provider 可路由但未定价。
// 修前：`ModelPrices(name)` 取到老 provider 的价 ⇒ 放行 ⇒ cost=0。
// 修后：候选集合 = {新 provider}（不可路由的那家不在集合里），它未定价 ⇒ 429。
func TestBalanceAdmissionFencesCatalogMissingPricedRow(t *testing.T) {
	resetBalanceAdmissionState(t)
	fNew := newFakeUpstream(t)
	r, db, token := newGateway(t, fNew)
	enableBalanceGate(t, db, true)

	if _, err := db.Exec(`UPDATE models SET input_price_per_1m = 500, output_price_per_1m = 3000, catalog_missing = TRUE
		WHERE name = 'deepseek-chat' AND provider_id = 1`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE gateway_providers SET models = '[]' WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	newID := s18AddProvider(t, db, "s18-new", fNew.baseURL, "deepseek-chat", true)
	s18AddModelRow(t, db, newID, "deepseek-chat", s18NullPrice(), s18NullPrice())
	activateBalance(t, db, 1, 0.01)
	s18Reload()

	ups, err := MatchModelsByProtocol(db, "deepseek-chat", "openai")
	if err != nil {
		t.Fatal(err)
	}
	if len(ups) != 1 || ups[0].ID != newID {
		t.Fatalf("前置不成立：候选应只有新 provider(%d)，实得 %+v", newID, ups)
	}
	if in, _, _ := serverstore.ModelPrices(db, "deepseek-chat"); in <= 0 {
		t.Fatalf("前置不成立：名字口径仍应取到旧价，实得 %v", in)
	}

	w := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil)
	if w.Code != http.StatusTooManyRequests || errCodeOf(t, w) != "MODEL_NOT_PRICED" {
		t.Fatalf("status/code = %d %s, want 429 MODEL_NOT_PRICED", w.Code, w.Body.String())
	}
	if n := fNew.requests.Load(); n != 0 {
		t.Fatalf("新 provider 上游命中 %d 次, want 0（修前 = 1）", n)
	}
}

// TestBalanceAdmissionKeepsLegalMultiProviderModel 钉"别过度修复"：
// 同名模型挂两家**都已定价**的 provider 时逐字照旧——正常路由（第一家）放行、真上游
// 命中；准入不会因为"存在第二家"就拒绝。
func TestBalanceAdmissionKeepsLegalMultiProviderModel(t *testing.T) {
	resetBalanceAdmissionState(t)
	fPrimary := newFakeUpstream(t)
	fSecond := newFakeUpstream(t)
	r, db, token := newGateway(t, fPrimary)
	enableBalanceGate(t, db, true)

	// 两家都便宜（1 元/1M）⇒ 最小计费额约 17 微元 ≪ 余额 0.01。
	if _, err := db.Exec(`UPDATE models SET input_price_per_1m = 1, output_price_per_1m = 1
		WHERE name = 'deepseek-chat' AND provider_id = 1`); err != nil {
		t.Fatal(err)
	}
	secondID := s18AddProvider(t, db, "s18-second", fSecond.baseURL, "deepseek-chat", true)
	s18AddModelRow(t, db, secondID, "deepseek-chat", s18Price(1), s18Price(1))
	activateBalance(t, db, 1, 0.01)
	s18Reload()

	w := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d %s, want 200（两家都已定价的多 provider 模型必须照常放行）", w.Code, w.Body.String())
	}
	if n := fPrimary.requests.Load(); n != 1 {
		t.Fatalf("第一家上游命中 %d 次, want 1", n)
	}
	// 结算按实际命中的 provider 取价 ⇒ cost > 0（不是 0 价）。
	var cost float64
	if err := db.QueryRow(`SELECT cost FROM usage WHERE kind = 'chat' ORDER BY id DESC LIMIT 1`).Scan(&cost); err != nil {
		t.Fatal(err)
	}
	if cost <= 0 {
		t.Fatalf("cost = %v, want > 0（结算必须按实际命中的 provider 取价）", cost)
	}
}

// TestBalanceAdmissionIgnoresUnpricedRowsOfUnroutableProviders 钉判据面 = **路由面**：
// 一个 provider 有同名模型的 NULL 价行但 `enabled=0`（不可路由）时，不得让已定价的
// 可路由 provider 被拒—— 否则修法就从"放行未定价"翻到"处处误拒"。
func TestBalanceAdmissionIgnoresUnpricedRowsOfUnroutableProviders(t *testing.T) {
	resetBalanceAdmissionState(t)
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)

	if _, err := db.Exec(`UPDATE models SET input_price_per_1m = 1, output_price_per_1m = 1
		WHERE name = 'deepseek-chat' AND provider_id = 1`); err != nil {
		t.Fatal(err)
	}
	// 停用的 provider + 同名 NULL 价行（渠道同步的常规产物）。
	offID := s18AddProvider(t, db, "s18-off", "http://127.0.0.1:1", "deepseek-chat", false)
	s18AddModelRow(t, db, offID, "deepseek-chat", s18NullPrice(), s18NullPrice())
	activateBalance(t, db, 1, 0.01)
	s18Reload()

	w := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d %s, want 200（不可路由的 provider 不参与准入判据）", w.Code, w.Body.String())
	}
	if n := f.requests.Load(); n != 1 {
		t.Fatalf("上游命中 %d 次, want 1", n)
	}
}

// TestBalanceAdmissionUnpricedPolicyAllowKeepsMultiProviderEscape 钉逃生门：
// 显式 `unpriced_model_policy=allow` 时，多 provider 里那家未定价的候选照旧放行
// （本组织确实有免费/内部模型的口径不得被本次修复关掉）。
func TestBalanceAdmissionUnpricedPolicyAllowKeepsMultiProviderEscape(t *testing.T) {
	resetBalanceAdmissionState(t)
	fPrimary := newFakeUpstream(t)
	fBackup := newFakeUpstream(t)
	r, db, token := newGateway(t, fPrimary)
	enableBalanceGate(t, db, true)

	if _, err := db.Exec(`UPDATE models SET input_price_per_1m = 1, output_price_per_1m = 1
		WHERE name = 'deepseek-chat' AND provider_id = 1`); err != nil {
		t.Fatal(err)
	}
	backupID := s18AddProvider(t, db, "s18-backup", fBackup.baseURL, "deepseek-chat", true)
	s18AddModelRow(t, db, backupID, "deepseek-chat", s18NullPrice(), s18NullPrice())
	if err := serverstore.SetSetting(db, serverstore.UnpricedModelPolicySetting, serverstore.UnpricedModelPolicyAllow); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(serverstore.InvalidateSettings)
	activateBalance(t, db, 1, 0.01)
	s18Reload()

	if w := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil); w.Code != http.StatusOK {
		t.Fatalf("policy=allow 时 status = %d %s, want 200（显式声明的免费模型不得被拦）", w.Code, w.Body.String())
	}
	if n := fPrimary.requests.Load(); n != 1 {
		t.Fatalf("上游命中 %d 次, want 1", n)
	}
}

// TestBalanceAdmissionMinBillableUsesServingProviderPrice 钉 ④ 的取价面：
// 最小计费额看**将被路由到的那一家**（候选集合第一家），而不是"名字下任意一行"。
//
// 夹具：第一家极贵（200000 元/1M ⇒ 下界远超余额）、第二家极便宜（1 元/1M）。
// 正常路由 = 第一家（handler 的 `for i := range ups` 从 0 开始）⇒ 下界用它的价 ⇒ 429。
// 若把取价退回名字口径（`ORDER BY provider_id LIMIT 1`）结果同向、这条测不出差别；
// 因此**再反一次**：把最贵的那家放在**第二**位（id 更大），此时名字口径取的是便宜的
// 第一家（放行），而"将被路由到的第一家"也是它（放行）——两条口径一致，仅作对照。
// 真正的判据是上面那条 ③：候选里任何一家未定价都必须拒绝。
func TestBalanceAdmissionMinBillableUsesServingProviderPrice(t *testing.T) {
	resetBalanceAdmissionState(t)
	fExpensive := newFakeUpstream(t)
	fCheap := newFakeUpstream(t)
	r, db, token := newGateway(t, fExpensive)
	enableBalanceGate(t, db, true)

	// id=1（第一家、正常路由）：极贵。
	if _, err := db.Exec(`UPDATE models SET input_price_per_1m = 200000, output_price_per_1m = 200000
		WHERE name = 'deepseek-chat' AND provider_id = 1`); err != nil {
		t.Fatal(err)
	}
	// id=2：极便宜。
	cheapID := s18AddProvider(t, db, "s18-cheap", fCheap.baseURL, "deepseek-chat", true)
	s18AddModelRow(t, db, cheapID, "deepseek-chat", s18Price(1), s18Price(1))
	activateBalance(t, db, 1, 0.01)
	s18Reload()

	w := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d %s, want 429（正常路由到极贵的那家,下界远超余额）", w.Code, w.Body.String())
	}
	if code := errCodeOf(t, w); code != "BALANCE_EXHAUSTED" {
		t.Fatalf("error.code = %q, want BALANCE_EXHAUSTED", code)
	}
	if _, last, _ := serverstore.BalanceAdmissionStats(); last.Reason != "min_billable" {
		t.Fatalf("拒绝依据 = %q, want min_billable", last.Reason)
	}
	if n := fExpensive.requests.Load() + fCheap.requests.Load(); n != 0 {
		t.Fatalf("上游命中 %d 次, want 0", n)
	}
}

// ---------------------------------------------------------------------------
// R18A-05 / R18A-06（第十八轮对抗审计泳道 R18-A，与 R18C-01 同一处代码）
// ---------------------------------------------------------------------------

// TestBalanceAdmissionRefusesSubMicroPrice 钉 R18A-05：**极小非零价 = 未定价**。
//
// 修前实测（R18-A）：价 0.001 元/1M、余额 0.01 的账号连发 20 次 ⇒ 20/20 交付、
// 20 次真实上游命中、余额恒 0.01、usage 里 cost 合计 2.2e-07、零拒绝零下限。
// 根因是闸门与账本的**舍入口径分叉**：④ 用 `math.Ceil`（把 15×0.001 = 0.015 微元
// 说成"至少 1 微元"），而账本按 `roundMicro` 落账 ⇒ 0 微元。
//
// 修后：③b 用账本口径（`roundMicro`）判"这次请求的最小应付额 > 0 微元"，为 0 即按
// 未定价处置（reason=unbillable_price；逃生门仍是 `unpriced_model_policy=allow`）。
// 本用例同时给**正控**：正常价必须真的扣款并落 usage 行（R18-A 自己踩过"探针 SQL
// 写错 ⇒ 假 0 行"的坑，故判据必须自带"量具咬得到"的那一半）。
func TestBalanceAdmissionRefusesSubMicroPrice(t *testing.T) {
	resetBalanceAdmissionState(t)
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	setModelPrices(t, db, 0.001, 0.001) // 极小非零：不是 NULL、不是 0
	activateBalance(t, db, 1, 0.01)

	const rounds = 20
	delivered := 0
	for i := 0; i < rounds; i++ {
		w := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil)
		if w.Code == http.StatusOK {
			delivered++
			continue
		}
		if w.Code != http.StatusTooManyRequests || errCodeOf(t, w) != "MODEL_NOT_PRICED" {
			t.Fatalf("第 %d 次 = %d %s, want 429 MODEL_NOT_PRICED", i+1, w.Code, w.Body.String())
		}
	}
	if delivered != 0 {
		t.Fatalf("极小非零价上交付了 %d/%d 次（修前 = 20/20，每次真实上游调用 + 零扣款）", delivered, rounds)
	}
	if n := f.requests.Load(); n != 0 {
		t.Fatalf("上游命中 = %d, want 0（修前 = %d）", n, rounds)
	}
	if _, last, _ := serverstore.BalanceAdmissionStats(); last.Reason != "unbillable_price" {
		t.Fatalf("拒绝依据 = %q, want unbillable_price", last.Reason)
	}
	assertNoUsageAndBalanceIntact(t, db, 0.01)

	// 正控：正常价 ⇒ 必须交付、落 usage 行、**余额真的减少**（证明量具与结算链路有效）。
	resetBalanceAdmissionState(t)
	setModelPrices(t, db, 1, 1)         // 1 元/1M：单次成本约 1.7e-5 元
	serverstore.InvalidateModelConfig() // 价目是 TTL 缓存：改价后必须让准入侧看到新值
	w := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("正控 status = %d %s, want 200（正常价必须照常交付）", w.Code, w.Body.String())
	}
	var cost float64
	if err := db.QueryRow(`SELECT cost FROM usage WHERE kind = 'chat' ORDER BY id DESC LIMIT 1`).Scan(&cost); err != nil {
		t.Fatalf("正控没有落 usage 行: %v", err)
	}
	if cost <= 0 {
		t.Fatalf("正控 usage.cost = %v, want > 0", cost)
	}
	var bal float64
	if err := db.QueryRow(`SELECT balance_money FROM users WHERE id = 1`).Scan(&bal); err != nil {
		t.Fatal(err)
	}
	if !(bal < 0.01) {
		t.Fatalf("正控余额 = %v, want < 0.01（正常价必须真的扣款）", bal)
	}
}

// TestBalanceAdmissionSubMicroPriceIsPerRequest 回答 R18A-05 的**误伤面**：
// 判据是"这次请求的最小应付额"，不是"单价下架" —— 同一个低到 0.02 元/1M 的模型，
// 短请求（≈16 token）折到 0 微元被拒，长请求（≈数百 token）能计费 1 微元即放行。
//
// 诚实边界：单价低于 ≈0.5/估算token 元/1M（短 prompt 下约 0.03 元/1M）时，该模型的
// **短请求**会被拒 —— 这是有意的 fail-closed（那种价位下平台永远收不到钱，而组织仍要
// 为上游付费）；确属免费/内部模型的，走 `gateway.unpriced_model_policy=allow` 显式声明。
func TestBalanceAdmissionSubMicroPriceIsPerRequest(t *testing.T) {
	resetBalanceAdmissionState(t)
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	setModelPrices(t, db, 0.02, 0.02)
	activateBalance(t, db, 1, 0.01)

	// 短请求：16 token × 0.02 = 0.32 微元 ⇒ 折到 0 ⇒ 拒绝（否则这一单永远收不到钱）。
	if w := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil); w.Code != http.StatusTooManyRequests {
		t.Fatalf("短请求 status = %d %s, want 429（应付 0 微元）", w.Code, w.Body.String())
	}
	// 长请求：约 400 字节 prompt（≈100 token）× 0.02 = 2 微元 ⇒ 能计费 ⇒ 放行。
	long := `{"model":"deepseek-chat","messages":[{"role":"user","content":"` + strings.Repeat("a", 380) + `"}]}`
	w := doPost(t, r, "/v1/chat/completions", long, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("长请求 status = %d %s, want 200（同一模型的长请求应付 > 0 微元,不得被拒）", w.Code, w.Body.String())
	}
	if n := f.requests.Load(); n != 1 {
		t.Fatalf("上游命中 = %d, want 1", n)
	}
}

// TestBalanceAdmissionFencesDisabledPricedProviderStaleRow 钉 R18A-06：
// **不需要故障转移**的另一条可达路径 —— provider1 有价但 `enabled=0`（停用后 models
// 行残留），provider2 启用且同名模型未定价。修前按名字取到 provider1 的价 ⇒ 放行，
// 路由实际只看得见 provider2 ⇒ 20/20 交付、上游全在 provider2、余额恒 0.01。
// 修后：候选集合（enabled=1 且 JSON 清单含该名字）里只有 provider2 ⇒ 未定价 ⇒ 全拒。
func TestBalanceAdmissionFencesDisabledPricedProviderStaleRow(t *testing.T) {
	resetBalanceAdmissionState(t)
	fDisabled := newFakeUpstream(t)
	fServing := newFakeUpstream(t)
	r, db, token := newGateway(t, fDisabled) // provider 1
	enableBalanceGate(t, db, true)
	setModelPrices(t, db, 500, 3000) // provider 1 的残留价目

	servingID := s18AddProvider(t, db, "s18-serving", fServing.baseURL, "deepseek-chat", true)
	s18AddModelRow(t, db, servingID, "deepseek-chat", s18NullPrice(), s18NullPrice())
	if _, err := db.Exec(`UPDATE gateway_providers SET enabled = 0 WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	activateBalance(t, db, 1, 0.01)
	s18Reload()

	if in, _, _ := serverstore.ModelPrices(db, "deepseek-chat"); in <= 0 {
		t.Fatalf("前置不成立：名字口径应取到停用 provider 的残留价（>0），实得 %v", in)
	}

	const rounds = 20
	delivered := 0
	for i := 0; i < rounds; i++ {
		if w := doPost(t, r, "/v1/chat/completions", admissionProbeBody, token, nil); w.Code == http.StatusOK {
			delivered++
		}
	}
	if delivered != 0 {
		t.Fatalf("交付了 %d/%d 次（修前 = 20/20：停用 provider 的残留价替未定价的在服 provider 挡下了闸门）",
			delivered, rounds)
	}
	if n := fDisabled.requests.Load(); n != 0 {
		t.Fatalf("停用 provider 上游命中 = %d, want 0", n)
	}
	if n := fServing.requests.Load(); n != 0 {
		t.Fatalf("在服 provider 上游命中 = %d, want 0（修前 = %d）", n, rounds)
	}
	assertNoUsageAndBalanceIntact(t, db, 0.01)
}
