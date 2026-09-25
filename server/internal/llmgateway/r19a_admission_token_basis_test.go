package llmgateway

// R19A-S1-01 / S1-03（审计 2026-09-25）的判据：准入闸门的判据面必须与**结算**同源。
//
// 两条缺陷形态（互为镜像，都在 ③/③b 层）：
//
//	① **token 数不同源**（S1-01，P1）：embeddings 的闸门用**客户端原始 body** 的字节数
//	   当 prompt 量，而结算用 `estimateEmbeddingPromptTokens(inputs)`（input 文本）——
//	   出站体由服务端自建 `{model,input}`，客户端 body 从不转发 ⇒ JSON 外壳（字段名、
//	   引号、括号、任意客户端字段）被算成 prompt token。低价档（0.1 元/1M）实测
//	   20/20 交付、20 次真实上游命中、余额与账本一分未动（闸门判"应付 ≥1 微元"、
//	   账本 roundMicro 落 0）。
//	② **只看输入价**（S1-03，P2 回归）：`输入价 0/极低 + 输出价正常` 的模型（很多模型
//	   靠输出侧赚钱）在基线上 200 + 真计费，第十八轮之后**每一笔** 429
//	   MODEL_NOT_PRICED ⇒ 整个模型不可用，而文案还说"该模型未配置价格"。
//
// 修法与判据（两处都改在 `balance_gate.go`）：
//   - 准入估量由调用方按端点给：`admissionTokensFromBody`（chat/completions/responses/
//     messages，结算兜底同一个函数）/ `admissionTokensFromEmbeddingInputs`（embeddings）；
//   - ③/③b 的"这次请求能不能被计费"按**两侧**算（有补全侧时输出侧按 1 token 下界），
//     embeddings 无补全侧只看输入。
//
// 变异（必须变红）：
//   - 把 embeddings 的准入估量改回 `admissionTokensFromBody(raw)` ⇒ 第 1 条用例红
//     （200 交付 + 账本不动）；
//   - 把 ③/③b 改回只算输入价（`billableMicro` 的输入侧口径）⇒ 第 2、3 条用例红。

import (
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// admissionEmbedUpstream 是 embeddings 的假上游：usageTokens < 0 时不报 usage
// （结算因此走 `estimateEmbeddingPromptTokens` 兜底 —— 正是闸门必须同源的那条路径）。
func admissionEmbedUpstream(t *testing.T, usageTokens int64) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if usageTokens < 0 {
			fmt.Fprint(w, `{"data":[{"index":0,"embedding":[0.1,0.2,0.3]}],"model":"r3-model"}`)
			return
		}
		fmt.Fprintf(w, `{"data":[{"index":0,"embedding":[0.1,0.2,0.3]}],"model":"r3-model","usage":{"prompt_tokens":%d,"total_tokens":%d}}`,
			usageTokens, usageTokens)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func ledgerCount(t *testing.T, db *sql.DB, uid int64) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM balance_ledger WHERE user_id = ?`, uid).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// TestEmbeddingAdmissionUsesSettlementTokenBasis 是 S1-01 的判据（不变量形态）：
// **交付了就必须扣费**。0.1 元/1M（text-embedding-3-small 量级）+ input=["hi"] 时，
// 结算基准是 1 token ⇒ 1×0.1/1e6 元 = 0.1 微元 ⇒ 账本 roundMicro 落 0 ⇒ 这条请求
// 根本不可能被计费，③b 必须拒（429 MODEL_NOT_PRICED）。
//
// 修前：闸门按 body 35 字节估出 8 token（0.8 微元 ⇒ 以为可计费）⇒ 200 交付、
// 20 次真实上游命中、账本一分未动（可无限重复）。
func TestEmbeddingAdmissionUsesSettlementTokenBasis(t *testing.T) {
	resetBalanceAdmissionState(t)
	up := admissionEmbedUpstream(t, -1) // 不报 usage ⇒ 结算按 input 文本估算
	r, db, uid, token := newAuditR3GatewayAt(t, up.URL, 0.01, 0.1, 0.1, 0.1)

	body := `{"model":"r3-model","input":["hi"]}`
	before := auditR3Snapshot(t, db, uid)
	beforeLedger := ledgerCount(t, db, uid)

	for i := 0; i < 3; i++ {
		w := doPost(t, r, "/v1/embeddings", body, token, nil)
		if w.Code == http.StatusOK {
			if after := ledgerCount(t, db, uid); after == beforeLedger {
				t.Fatalf("第 %d 次：embeddings 被 200 交付但账本一分未动（闸门估算=%d token（客户端 body %d 字节）／"+
					"结算基准=%d token）—— 准入估量必须与结算同一个函数（admissionTokensFromEmbeddingInputs）",
					i+1, admissionTokensFromBody([]byte(body)), len(body),
					admissionTokensFromEmbeddingInputs([]string{"hi"}))
			}
			continue
		}
		if w.Code != http.StatusTooManyRequests || errCodeOf(t, w) != "MODEL_NOT_PRICED" {
			t.Fatalf("第 %d 次：status=%d code=%s，want 429/MODEL_NOT_PRICED（这次请求的最小应付额折到 0 微元 ⇒ 拒绝）",
				i+1, w.Code, errCodeOf(t, w))
		}
	}
	after := auditR3Snapshot(t, db, uid)
	if after.balance != before.balance {
		t.Fatalf("余额动了：%v → %v（本次夹具下应当要么拒、要么拒）", before.balance, after.balance)
	}
	// 被拒请求绝不转发、绝不记账。
	var usageRows int
	if err := db.QueryRow(`SELECT COUNT(*) FROM usage WHERE user_id = ?`, uid).Scan(&usageRows); err != nil {
		t.Fatal(err)
	}
	if usageRows != 0 {
		t.Fatalf("被拒请求仍落了 %d 行 usage（被拒请求不得转发、不得记账）", usageRows)
	}
}

// TestInputPriceZeroWithOutputPricedStaysUsable 是 S1-03 的判据：输入价 0/极低 +
// 输出价正常 ⇒ 模型**必须可用且真计费**（基线行为）。
//
// 修前：③ 判 `输入价 <= 0` 即未定价（输入价 0 那档 429）；③b 只看输入侧 ⇒
// 输入价 0.0001/0.01 档也 429（"单次调用计费不足最小单位"）⇒ 整个模型不可用。
func TestInputPriceZeroWithOutputPricedStaysUsable(t *testing.T) {
	resetBalanceAdmissionState(t)
	for _, inPrice := range []float64{0, 0.0001, 0.01} {
		f := newFakeUpstream(t)
		r, db, token := newGateway(t, f)
		enableBalanceGate(t, db, true)
		if _, err := db.Exec(`UPDATE models SET input_price_per_1m = ?, output_price_per_1m = 8 WHERE name = 'deepseek-chat'`, inPrice); err != nil {
			t.Fatal(err)
		}
		activateBalance(t, db, 1, 1.0)
		body := `{"model":"deepseek-chat","messages":[{"role":"user","content":"h"}]}`
		w := doPost(t, r, "/v1/chat/completions", body, token, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("输入价 %g + 输出价 8 元/1M：status=%d code=%s —— 输出侧有价 ⇒ 这次调用能被计费，"+
				"不得按「未定价/计费不足最小单位」拒绝（整个模型不可用）",
				inPrice, w.Code, errCodeOf(t, w))
		}
		if f.requests.Load() != 1 {
			t.Fatalf("输入价 %g：上游命中 %d 次, want 1", inPrice, f.requests.Load())
		}
		var cost float64
		if err := db.QueryRow(`SELECT COALESCE(SUM(cost),0) FROM usage WHERE user_id = 1`).Scan(&cost); err != nil {
			t.Fatal(err)
		}
		if cost <= 0 {
			t.Fatalf("输入价 %g：cost=%v —— 输出侧必须真的计费（基线实测 ≈2.4e-5 元）", inPrice, cost)
		}
	}
}

// TestUnbillableMicroCountsBothSides 是 ③b 判据面的单元级判据（与上面两条互为补充）：
// "这次请求能不能被计费"必须按**两侧**算。
func TestUnbillableMicroCountsBothSides(t *testing.T) {
	// 输入价 0.0001 + 输出价 8：输入侧 17 token 只有 0.0017 微元（折 0），
	// 但输出侧 1 token = 8 微元 ⇒ 可计费（S1-03 的形态）。
	if micro, ok := billableMicroFor(17, 0.0001, true, 8); !ok || micro <= 0 {
		t.Fatalf("输入 0.0001/输出 8：billableMicroFor = (%d,%v), want ok（输出侧下界 8 微元）", micro, ok)
	}
	// 两侧都为 0 ⇒ 不可计费（③ 的未定价形态）。
	if _, ok := billableMicroFor(17, 0, true, 0); ok {
		t.Fatal("两侧都无价：billableMicroFor 必须 ok=false（未定价）")
	}
	// embeddings（无补全侧）：只有输入价可算 —— 极低价必须判不可计费。
	if _, ok := billableMicroFor(1, 0.1, false, 8); ok {
		t.Fatal("embeddings 1 token × 0.1 元/1M = 0.1 微元 ⇒ 不可计费，输出价不得参与")
	}
	// 输入侧下界（④ 用的那一条）不看输出侧：余额闸门要的是"成本下界 > 0"。
	if _, ok := billableMicro(17, 0); ok {
		t.Fatal("billableMicro（输入侧下界）在输入价 0 时必须 ok=false")
	}

	// unpricedFor：有补全侧的端点只有**两侧都无价**才算未定价。
	hasOut := admissionPricing{inputPer1M: []float64{0}, outputPer1M: []float64{8}}
	if hasOut.unpricedFor(true) {
		t.Fatal("输入价 0 + 输出价 8：有补全侧的端点不得判为未定价（模型照常计费）")
	}
	if !hasOut.unpricedFor(false) {
		t.Fatal("输入价 0：embeddings（无补全侧）必须判为未定价")
	}
	both := admissionPricing{inputPer1M: []float64{0}, outputPer1M: []float64{0}}
	if !both.unpricedFor(true) {
		t.Fatal("两侧都无价：必须判为未定价")
	}
	// 取价失败仍然 fail-closed。
	if !(admissionPricing{lookupFailed: true}).unpricedFor(true) {
		t.Fatal("取价失败必须按未定价处置（fail-closed）")
	}
	// 多候选取"任一"：故障转移到未定价那家仍是拒绝面（R18C-01 不退化）。
	mixed := admissionPricing{inputPer1M: []float64{2, 0}, outputPer1M: []float64{8, 0}}
	if !mixed.unpricedFor(true) {
		t.Fatal("候选里有一家两侧都无价 ⇒ 整次请求按未定价处置（R18C-01）")
	}
}

// TestAllowPolicyScopeIsGlobalByDesign 是 R19A-S1-04 的**判定判据**（保留语义 + 披露）：
// `unpriced_model_policy=allow` 是**全局**开关 —— 它同时放行"整体未定价的免费/内部模型"
// 与"同名模型挂多 provider、其中一家未定价"的混合候选集合（故障转移到那家即 cost=0）。
//
// 为什么保留而不是收紧：这是上一轮 R18C-01 的显式产品决策，并由既有判据
// `TestBalanceAdmissionUnpricedPolicyAllowKeepsMultiProviderEscape` 钉住
// （"显式声明的免费模型不得被拦"）；收紧成"allow 只覆盖整体无价"会把这条既有承诺
// 关掉，且真正干净的修法是**按模型**的 allow 名单（新 settings 形状 + 迁移）= 产品决策。
// 本轮的处置是**披露**（webadmin 策略说明写明作用范围 + 审计报告登记判定保留）。
//
// 本用例的作用：把"我们知道并有意保留它"写成可执行事实 —— 若有人悄悄收紧/放松这条
// 语义，这里会立刻红，而不是靠读注释。
func TestAllowPolicyScopeIsGlobalByDesign(t *testing.T) {
	resetBalanceAdmissionState(t)
	fPrimary := newFakeUpstream(t)
	fBackup := newFakeUpstream(t)
	r, db, token := newGateway(t, fPrimary)
	enableBalanceGate(t, db, true)
	if _, err := db.Exec(`UPDATE models SET input_price_per_1m = 1, output_price_per_1m = 1
		WHERE name = 'deepseek-chat' AND provider_id = 1`); err != nil {
		t.Fatal(err)
	}
	var backupID int64
	if err := db.QueryRow(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, enabled)
		VALUES ('r19a-backup', ?, 'sk', '["deepseek-chat"]', 1) RETURNING id`, fBackup.baseURL).Scan(&backupID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO models (name, provider_id, display_name) VALUES ('deepseek-chat', ?, 'backup')`, backupID); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, serverstore.UnpricedModelPolicySetting, serverstore.UnpricedModelPolicyAllow); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(serverstore.InvalidateSettings)
	activateBalance(t, db, 1, 0.01)
	InvalidateUpstreams()

	body := `{"model":"deepseek-chat","messages":[{"role":"user","content":"h"}]}`
	w := doPost(t, r, "/v1/chat/completions", body, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("policy=allow + 混合候选：status=%d code=%s, want 200（allow 是全局逃生门，"+
			"含「整体免费」与「部分渠道缺价」两种形态；要收紧必须先做按模型的 allow 名单）",
			w.Code, errCodeOf(t, w))
	}
}

// TestPurgeSnapshotSkipsFileRenewedAfterSnapshot 是 R19A-S1-05 的判据：
// 批量清理的"快照 → 逐条删除"之间被主人**合法续期**的文件绝不能被删。
//
// 修前：`ListGatewayFilesForPurge` 只返回 file_id，而认领协议对**任意世代**都成立
// （自己把世代 +1）⇒ 快照之后被续期（世代 +1、expires_at 推到未来）的有效文件照样被
// 删掉上游对象与台账行，且新增的 skipped 计数看不见它（认领成功）。实测：purge 响应
// `deleted:2 skipped:0`、被续期的那一行 exists=false。
//
// 变异（必须变红）：把 admin purge 循环换回不带世代的
// `deleteGatewayFileFenced(id, up)`（或去掉 `ClaimGatewayFileForDeletionAtGeneration`
// 的世代谓词）⇒ 本用例红（p2 被销毁）。
func TestPurgeSnapshotSkipsFileRenewedAfterSnapshot(t *testing.T) {
	env := gwfSetup(t)
	a := env.user(t, "r19a-a6", "employee")
	expired := time.Now().Add(-time.Hour)
	env.seed(t, "purge-p1", a, &expired, 10)
	env.seed(t, "purge-p2", a, &expired, 10)

	// 假上游：第一条 DELETE 到达时，模拟"p2 的主人在循环跑到它之前续期/重传"。
	future := time.Now().Add(24 * time.Hour)
	renewed := false
	env.up.respond = func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete && !renewed {
			renewed = true
			other := "purge-p2"
			if r.URL.Path != "" && len(r.URL.Path) >= 2 && r.URL.Path[len(r.URL.Path)-2:] == "p1" {
				other = "purge-p2"
			} else {
				other = "purge-p1"
			}
			if err := serverstore.RecordGatewayFileSize(env.db, other, a, &future, 0); err != nil {
				t.Logf("（续期 %s 失败：%v）", other, err)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"x","object":"file","deleted":true}`))
	}

	w, out := adminReq(t, env.r, "POST", "/api/server/admin/gateway/files/purge",
		`{"state":"expired"}`, env.hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("purge: %d %v", w.Code, out)
	}
	var existsP2 bool
	if err := env.db.QueryRow(`SELECT count(*) > 0 FROM gateway_files WHERE file_id = 'purge-p2'`).Scan(&existsP2); err != nil {
		t.Fatal(err)
	}
	t.Logf("purge 响应=%v 上游 DELETE 次数=%d p2 exists=%v", out, env.up.deletes.Load(), existsP2)
	if !existsP2 {
		t.Fatalf("批量清理删掉了**快照之后被主人合法续期**的有效文件（p2 续期到 %v 后仍被删掉上游对象 + 台账行）——"+
			"快照必须带世代号（ListGatewayFilePurgeCandidates + ClaimGatewayFileForDeletionAtGeneration）",
			future.Format(time.RFC3339))
	}
	// 快照里"世代未变"的那一条仍应被正常删掉（修复不得把整批清理变成 no-op）。
	var existsP1 bool
	if err := env.db.QueryRow(`SELECT count(*) > 0 FROM gateway_files WHERE file_id = 'purge-p1'`).Scan(&existsP1); err != nil {
		t.Fatal(err)
	}
	if existsP1 {
		t.Fatal("p1（快照后没被动过）必须被删掉 —— 修复不能把批量清理变成 no-op")
	}
}
