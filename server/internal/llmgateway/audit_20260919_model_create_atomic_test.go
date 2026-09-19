package llmgateway

// 审计 2026-09-19(N1):createModel 的"移出排除名单 + 建模型行"必须原子。
//
// 缺陷形态(本次改动引入,已实测复现,两条路径都用纯管理 API 可达):
//   (A) 渠道型上游的模型被管理员显式删除(进排除名单,H2 保护)后重新添加;
//       若建行因**非重复**原因失败(约束/唯一键/连接中断),旧实现返回 500
//       「创建失败」,但"移名单"那一步已经 autocommit ⇒ 名单被清空 ⇒ 下一轮
//       SyncOnce 返回 `{Added:1}`,被显式删除的模型**复活**。
//   (B) 同名重复创建(400「模型名已存在」)同样清空名单 —— 一个被**拒绝**的
//       请求撤销了管理员的删除意图。
//
// 修法:两步收进同一事务(serverstore.RemoveExcludedModelTx + AddModelTx),
// 提交后才失效缓存(AddModelTx 不失效模型缓存、SetSettingTx 不失效 settings
// 缓存 ⇒ 提交后必须显式 InvalidateSettings/InvalidateModelConfig/
// InvalidateModelsChanged,否则"保存成功但运行期读旧值")。
// 判据:"请求失败 ⇒ 不留任何状态变化";成功路径与此前逐字相同。

import (
	"database/sql"
	"net/http"
	"strconv"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// mcAtomicCatalog 是渠道同步目录(与 adminTestSetup 的缺省 fetchFn 一致:
// deepseek-chat + deepseek-reasoner)。
func mcAtomicCatalog(string) ([]byte, error) {
	return []byte(`{"data":[{"id":"deepseek-chat"},{"id":"deepseek-reasoner"}]}`), nil
}

// mcAtomicChannelProvider 建一个渠道型上游(创建即同步 2 个模型)并返回
// (providerID, deepseek-chat 的模型 id)。
func mcAtomicChannelProvider(t *testing.T, r http.Handler, db *sql.DB, hdr map[string]string) (int64, int64) {
	t.Helper()
	if w, _ := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"deepseek","api_key":"sk","channel":"deepseek"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create channel provider: %d %s", w.Code, w.Body.String())
	}
	var providerID, modelID int64
	if err := db.QueryRow(`SELECT id FROM gateway_providers WHERE name = 'deepseek'`).Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT id FROM models WHERE provider_id = ? AND name = 'deepseek-chat'`, providerID).Scan(&modelID); err != nil {
		t.Fatalf("渠道上游未同步出 deepseek-chat: %v", err)
	}
	return providerID, modelID
}

// mcAtomicDeleteExcluded 走管理端删除渠道模型(进排除名单),并断言前置成立。
func mcAtomicDeleteExcluded(t *testing.T, r http.Handler, db *sql.DB, hdr map[string]string, providerID, modelID int64) {
	t.Helper()
	if w, _ := adminReq(t, r, "DELETE", "/api/server/admin/models/"+strconv.FormatInt(modelID, 10), "", hdr); w.Code != http.StatusOK {
		t.Fatalf("delete channel model: %d %s", w.Code, w.Body.String())
	}
	names, raw := mcAtomicExcluded(t, db, providerID)
	if len(names) != 1 || names[0] != "deepseek-chat" {
		t.Fatalf("前置条件不成立:排除名单 = %v (raw=%s)", names, raw)
	}
	if mcAtomicHasModel(t, db, providerID, "deepseek-chat") {
		t.Fatal("前置条件不成立:被删除的模型行仍在")
	}
}

// mcAtomicExcluded 返回名单(解析值)与 settings 行**原始值**(逐字判据:
// "名单未被改动"必须看到字节级相同,而不只是解析后等值)。
func mcAtomicExcluded(t *testing.T, db *sql.DB, providerID int64) ([]string, string) {
	t.Helper()
	names, err := serverstore.GetExcludedModels(db, providerID)
	if err != nil {
		t.Fatalf("GetExcludedModels: %v", err)
	}
	key := "gateway.excluded_models." + strconv.FormatInt(providerID, 10)
	var raw string
	if err := db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&raw); err != nil {
		raw = "<absent>"
	}
	return names, raw
}

// mcAtomicHasModel 判断某 provider 下是否存在该模型名。
func mcAtomicHasModel(t *testing.T, db *sql.DB, providerID int64, name string) bool {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM models WHERE provider_id = ? AND name = ?`, providerID, name).Scan(&n); err != nil {
		t.Fatalf("count model: %v", err)
	}
	return n > 0
}

// mcAtomicInjectInsertFailure 用真实 SQL 约束让同名 INSERT 必然失败
// (模拟唯一键冲突之外的建行失败:约束/DB 错误),而不是桩函数。
func mcAtomicInjectInsertFailure(t *testing.T, db *sql.DB) func() {
	t.Helper()
	if _, err := db.Exec(`ALTER TABLE models ADD CONSTRAINT audit0919_mc_block CHECK (name <> 'deepseek-chat')`); err != nil {
		t.Fatalf("inject insert failure: %v", err)
	}
	return func() { _, _ = db.Exec(`ALTER TABLE models DROP CONSTRAINT IF EXISTS audit0919_mc_block`) }
}

// TestCreateModelInsertFailureLeavesExclusionListUntouched(N1-①):
// 建行失败 ⇒ 500「创建失败」,排除名单**逐字未变**,下一轮同步不得复活模型。
func TestCreateModelInsertFailureLeavesExclusionListUntouched(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	providerID, modelID := mcAtomicChannelProvider(t, r, db, hdr)
	mcAtomicDeleteExcluded(t, r, db, hdr, providerID, modelID)
	beforeNames, beforeRaw := mcAtomicExcluded(t, db, providerID)

	dropFailure := mcAtomicInjectInsertFailure(t, db)
	w, _ := adminReq(t, r, "POST", "/api/server/admin/models",
		`{"name":"deepseek-chat","provider_id":`+strconv.FormatInt(providerID, 10)+`,"display_name":"re-add"}`, hdr)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("建行失败应 500,得到 %d %s", w.Code, w.Body.String())
	}
	if got, want := w.Body.String(), `{"error":{"code":"INTERNAL","message":"创建失败"}}`; got != want {
		t.Fatalf("500 响应体 = %s, want %s", got, want)
	}
	// 核心判据:失败请求不留任何状态变化(名单逐字未变)。
	afterNames, afterRaw := mcAtomicExcluded(t, db, providerID)
	if afterRaw != beforeRaw {
		t.Fatalf("失败的创建请求改写了排除名单:\n before raw=%s (%v)\n after  raw=%s (%v)", beforeRaw, beforeNames, afterRaw, afterNames)
	}
	if mcAtomicHasModel(t, db, providerID, "deepseek-chat") {
		t.Fatal("建行失败却留下了模型行")
	}

	// 去掉故障后跑下一轮同步:名单是唯一屏障,模型不得复活。
	dropFailure()
	results, err := SyncOnce(db, mcAtomicCatalog)
	if err != nil {
		t.Fatalf("SyncOnce: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %+v, want 1", results)
	}
	if results[0].Error != "" || results[0].Added != 0 || results[0].Removed != 0 {
		t.Fatalf("被显式删除的模型被同步复活: %+v", results[0])
	}
	if mcAtomicHasModel(t, db, providerID, "deepseek-chat") {
		t.Fatal("被显式删除的模型在下一轮同步后复活(H2 保护被失败请求撤销)")
	}
	if _, raw := mcAtomicExcluded(t, db, providerID); raw != beforeRaw {
		t.Fatalf("同步后排除名单被改写: %s, want %s", raw, beforeRaw)
	}
}

// TestCreateModelDuplicateRejectedLeavesExclusionListUntouched(N1-②):
// 纯管理 API 造出"行存在 + 名字在名单里",同名重复创建 400 ⇒ 名单逐字未变。
func TestCreateModelDuplicateRejectedLeavesExclusionListUntouched(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	providerID, modelID := mcAtomicChannelProvider(t, r, db, hdr)
	mcAtomicDeleteExcluded(t, r, db, hdr, providerID, modelID)

	// 手工上游 + 一个可改名的模型:改名防护只查用量与"当前 provider 是否渠道型",
	// **不查排除名单** ⇒ 纯管理 API 即可造出"同名行存在且名字仍在名单里"。
	if w, _ := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"manual","base_url":"https://manual.example","api_key":"sk2"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create manual provider: %d %s", w.Code, w.Body.String())
	}
	var manualProviderID int64
	if err := db.QueryRow(`SELECT id FROM gateway_providers WHERE name = 'manual'`).Scan(&manualProviderID); err != nil {
		t.Fatal(err)
	}
	if w, _ := adminReq(t, r, "POST", "/api/server/admin/models",
		`{"name":"tmp-name","provider_id":`+strconv.FormatInt(manualProviderID, 10)+`,"display_name":"tmp"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create tmp model: %d %s", w.Code, w.Body.String())
	}
	var tmpID int64
	if err := db.QueryRow(`SELECT id FROM models WHERE provider_id = ? AND name = 'tmp-name'`, manualProviderID).Scan(&tmpID); err != nil {
		t.Fatal(err)
	}
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/models/"+strconv.FormatInt(tmpID, 10),
		`{"name":"deepseek-chat","provider_id":`+strconv.FormatInt(providerID, 10)+`}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("rename into excluded name: %d %s", w.Code, w.Body.String())
	}
	beforeNames, beforeRaw := mcAtomicExcluded(t, db, providerID)
	if !mcAtomicHasModel(t, db, providerID, "deepseek-chat") {
		t.Fatal("前置条件不成立:改名后同名行不存在")
	}
	if len(beforeNames) != 1 || beforeNames[0] != "deepseek-chat" {
		t.Fatalf("前置条件不成立:排除名单 = %v", beforeNames)
	}

	// 同名重复创建 ⇒ 400,名单必须逐字未变。
	w, _ := adminReq(t, r, "POST", "/api/server/admin/models",
		`{"name":"deepseek-chat","provider_id":`+strconv.FormatInt(providerID, 10)+`,"display_name":"dup"}`, hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("同名重复创建应 400,得到 %d %s", w.Code, w.Body.String())
	}
	if got, want := w.Body.String(), `{"error":{"code":"VALIDATION","message":"模型名已存在"}}`; got != want {
		t.Fatalf("400 响应体 = %s, want %s", got, want)
	}
	afterNames, afterRaw := mcAtomicExcluded(t, db, providerID)
	if afterRaw != beforeRaw {
		t.Fatalf("被拒绝(400)的创建请求改写了排除名单:\n before raw=%s (%v)\n after  raw=%s (%v)", beforeRaw, beforeNames, afterRaw, afterNames)
	}
}

// TestCreateModelChannelSuccessAtomicAndCacheFresh(N1-③):
// 成功路径 ⇒ 模型建成 + 名单已移出该名 + 提交后缓存立刻可见(settings 名单与
// 模型定价两处);下一轮同步不得撤销这次显式添加。
func TestCreateModelChannelSuccessAtomicAndCacheFresh(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	providerID, modelID := mcAtomicChannelProvider(t, r, db, hdr)
	mcAtomicDeleteExcluded(t, r, db, hdr, providerID, modelID)

	// 预热 settings 名单缓存:此后 create 若漏了提交后的 InvalidateSettings,
	// 下面的运行期读取会拿到这份旧值(名单里仍有该名)。
	if names, _ := serverstore.GetExcludedModels(db, providerID); len(names) != 1 {
		t.Fatalf("预热失败:名单 = %v", names)
	}
	// 预热模型定价缓存(modelConfigCache 的 "price:<name>" 键)。这里用直连 SQL
	// 造"缓存有旧值、库里没有行"的状态:DeleteModel/UpdateModel 自己会失效缓存,
	// 只有"绕过 DAO 的删除"才能在 create 之前留下旧价格 —— 本用例要测的正是
	// createModel 自己在提交后失效缓存的职责。
	if _, err := db.Exec(`INSERT INTO models (name, provider_id, display_name, default_params, input_modalities, input_price_per_1m)
		VALUES ('deepseek-chat', ?, 'stale', '{}', '["text"]', 0.5)`, providerID); err != nil {
		t.Fatal(err)
	}
	if in, _, _ := serverstore.ModelPrices(db, "deepseek-chat"); in != 0.5 {
		t.Fatalf("预热模型定价缓存失败: %v", in)
	}
	if _, err := db.Exec(`DELETE FROM models WHERE provider_id = ? AND name = 'deepseek-chat'`, providerID); err != nil {
		t.Fatal(err)
	}

	w, out := adminReq(t, r, "POST", "/api/server/admin/models",
		`{"name":"deepseek-chat","provider_id":`+strconv.FormatInt(providerID, 10)+`,"display_name":"re-add",
		  "input_price_per_1m":1.5,"output_price_per_1m":3}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("重新添加渠道模型: %d %s", w.Code, w.Body.String())
	}
	// 200 响应体:模型建成、字段与既有形态一致(逐字段抽查)。
	model, ok := out["model"].(map[string]any)
	if !ok {
		t.Fatalf("200 响应体缺少 model 对象: %s", w.Body.String())
	}
	if model["name"] != "deepseek-chat" {
		t.Fatalf("model.name = %v", model["name"])
	}
	if model["provider_id"] != float64(providerID) {
		t.Fatalf("model.provider_id = %v, want %d", model["provider_id"], providerID)
	}
	if model["default_params"] != "{}" {
		t.Fatalf("model.default_params = %v, want {}", model["default_params"])
	}
	if model["input_price_per_1m"] != 1.5 || model["output_price_per_1m"] != 3.0 {
		t.Fatalf("建成的模型价格不符: in=%v out=%v", model["input_price_per_1m"], model["output_price_per_1m"])
	}
	if !mcAtomicHasModel(t, db, providerID, "deepseek-chat") {
		t.Fatal("200 但模型行未建成")
	}
	// 名单已移出该名(空名单写回 `[]`,与"键不存在"同解)。
	names, raw := mcAtomicExcluded(t, db, providerID)
	for _, n := range names {
		if n == "deepseek-chat" {
			t.Fatalf("重新添加后该名仍在排除名单里: %v (raw=%s)", names, raw)
		}
	}
	if raw != "[]" {
		t.Fatalf("名单被移空后应写回 [] ,得到 %q", raw)
	}
	// 提交后缓存失效:①settings 名单(预热过,漏失效会读到 ["deepseek-chat"]);
	if names, _ := serverstore.GetExcludedModels(db, providerID); len(names) != 0 {
		t.Fatalf("运行期仍读到旧的排除名单(提交后漏了 InvalidateSettings): %v", names)
	}
	// ②模型定价(预热过 0.5,漏失效会读到旧价)。
	if in, out, _ := serverstore.ModelPrices(db, "deepseek-chat"); in != 1.5 || out != 3.0 {
		t.Fatalf("运行期仍读到旧模型定价(提交后漏了 InvalidateModelConfig): in=%v out=%v", in, out)
	}
	// 下一轮同步不得再删(与被原子化的"显式重新添加"语义一致)。
	results, err := SyncOnce(db, mcAtomicCatalog)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Error != "" || results[0].Removed != 0 {
		t.Fatalf("重新添加的模型被同步撤销: %+v", results)
	}
	if !mcAtomicHasModel(t, db, providerID, "deepseek-chat") {
		t.Fatal("重新添加的模型在下一轮同步后消失")
	}
}

// TestCreateModelManualProviderLeavesExclusionListUntouched(N1-④):
// 非渠道型 provider 不改名单(条件本身钉住:手动型上游没有同步语义)。
func TestCreateModelManualProviderLeavesExclusionListUntouched(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"manual","base_url":"https://manual.example","api_key":"sk"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create manual provider: %d %s", w.Code, w.Body.String())
	}
	var providerID int64
	if err := db.QueryRow(`SELECT id FROM gateway_providers WHERE name = 'manual'`).Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	// 合成前置:手动型上游凭空带一条排除记录(它不参与同步,名单只是普通 settings 键)。
	if err := serverstore.AddExcludedModel(db, providerID, "m2"); err != nil {
		t.Fatal(err)
	}
	beforeNames, beforeRaw := mcAtomicExcluded(t, db, providerID)

	if w, _ := adminReq(t, r, "POST", "/api/server/admin/models",
		`{"name":"m2","provider_id":`+strconv.FormatInt(providerID, 10)+`}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create manual model: %d %s", w.Code, w.Body.String())
	}
	afterNames, afterRaw := mcAtomicExcluded(t, db, providerID)
	if afterRaw != beforeRaw {
		t.Fatalf("非渠道型 provider 的创建改写了排除名单:\n before raw=%s (%v)\n after  raw=%s (%v)", beforeRaw, beforeNames, afterRaw, afterNames)
	}
	if !mcAtomicHasModel(t, db, providerID, "m2") {
		t.Fatal("模型未建成")
	}
}
