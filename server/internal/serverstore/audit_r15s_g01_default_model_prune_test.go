package serverstore

// R15C-G-01 回归判据：**四条会删/停用 models 行的路径对
// `settings.gateway.default_model` 必须完全等价**。
//
// 缺陷形态（第 15 轮审计子泳道 G）：`SyncProviderModelsTx` 的剪枝循环只
// `DELETE FROM models`，而 `DeleteGatewayProvider` / `RemoveMissingProviderModels` /
// `DeleteModelTx` 三条兄弟路径都调 `clearDefaultModelIf` ⇒ 管理员在网关页改一次
// 模型清单就能留下跨表自相矛盾的终态：settings 指向一行已被 DELETE 的模型，
// bootstrap 会把它当默认模型下发给客户端，而 `/v1/models` 目录（按 models 表生成）
// 里没有它，且没有任何路径会自愈。
//
// 判据形态（与探针一致）：同一个库、同一份数据，**只换剪枝入口**，比对终态。
// 这是"一致性判据"而不是四条各自的行为断言 —— 四条各自都绿、彼此却不一致，
// 正是这条缺陷活下来的原因。
//
// 变异验证（`git show HEAD:server/internal/serverstore/gateway.go` 覆盖本文件所在
// 包的同名文件 ⇒ 本用例必红）：
//   - 去掉 `SyncProviderModelsTx` 剪枝循环里的 `clearDefaultModelIf` ⇒
//     TestR15SG01DefaultModelClearedByEveryPrunePath 的 SyncProviderModels 分支红
//     （dm="gone-model"，与另外三条路径的 "" 不等价）；
//   - 把 `clearDefaultModelIf` 改成无条件清空 ⇒
//     TestR15SG01DefaultModelKeptWhenModelSurvives 红（把仍然有效的默认模型清掉了）。

import (
	"database/sql"
	"testing"
)

// r15sPruneOutcome 是一条剪枝路径的终态（用于跨路径等价性比对）。
type r15sPruneOutcome struct {
	modelRowGone bool   // models 表里 gone-model 是否已消失
	defaultModel string // 剪枝之后 settings.gateway.default_model 的值
}

// r15sRunPrunePath 建一份"provider 有 keep-model + gone-model，且默认模型指向
// gone-model"的夹具，跑指定的剪枝入口，返回终态。
func r15sRunPrunePath(t *testing.T, prune func(t *testing.T, db *sql.DB, providerID, modelID int64)) r15sPruneOutcome {
	t.Helper()
	db, cleanup := NewTestDB(t)
	defer cleanup()

	pid, err := AddGatewayProvider(db, &GatewayProvider{
		Name: "r15s-prov", BaseURL: "http://127.0.0.1:9", APIKeyEnc: "k",
		Enabled: 1, Protocol: "openai",
	})
	if err != nil {
		t.Fatalf("AddGatewayProvider: %v", err)
	}
	if err := SyncProviderModels(db, pid, []string{"keep-model", "gone-model"}); err != nil {
		t.Fatalf("SyncProviderModels(seed): %v", err)
	}
	var modelID int64
	if err := db.QueryRow(`SELECT id FROM models WHERE provider_id = ? AND name = 'gone-model'`, pid).Scan(&modelID); err != nil {
		t.Fatalf("读 gone-model 行: %v", err)
	}
	if err := SetSetting(db, "gateway.default_model", "gone-model"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}

	prune(t, db, pid, modelID)

	var gone bool
	if err := db.QueryRow(`SELECT NOT EXISTS(SELECT 1 FROM models WHERE provider_id = ? AND name = 'gone-model')`, pid).Scan(&gone); err != nil {
		t.Fatalf("复查 models: %v", err)
	}
	dm, _, err := GetSetting(db, "gateway.default_model")
	if err != nil {
		t.Fatalf("GetSetting: %v", err)
	}
	return r15sPruneOutcome{modelRowGone: gone, defaultModel: dm}
}

// TestR15SG01DefaultModelClearedByEveryPrunePath 是核心判据：四条路径的终态必须
// 完全一致，且"模型行已消失 ⇒ default_model 必须已被清空"。
func TestR15SG01DefaultModelClearedByEveryPrunePath(t *testing.T) {
	paths := []struct {
		name  string
		prune func(t *testing.T, db *sql.DB, providerID, modelID int64)
	}{
		{
			// 管理端 PUT /providers/:id 改模型清单（最常被用到的那条）。
			name: "SyncProviderModels(全量替换语义)",
			prune: func(t *testing.T, db *sql.DB, providerID, _ int64) {
				if err := SyncProviderModels(db, providerID, []string{"keep-model"}); err != nil {
					t.Fatalf("SyncProviderModels: %v", err)
				}
			},
		},
		{
			// 渠道同步遇到上游目录抖动：带运营方配置的行只"停用"（不删行）。
			name: "RemoveMissingProviderModels(标记/删除)",
			prune: func(t *testing.T, db *sql.DB, providerID, _ int64) {
				if _, err := RemoveMissingProviderModels(db, providerID, []string{"keep-model"}); err != nil {
					t.Fatalf("RemoveMissingProviderModels: %v", err)
				}
			},
		},
		{
			name: "DeleteModel(删单个模型)",
			prune: func(t *testing.T, db *sql.DB, _, modelID int64) {
				if err := DeleteModel(db, modelID); err != nil {
					t.Fatalf("DeleteModel: %v", err)
				}
			},
		},
		{
			name: "DeleteGatewayProvider(删整个上游)",
			prune: func(t *testing.T, db *sql.DB, providerID, _ int64) {
				if err := DeleteGatewayProvider(db, providerID); err != nil {
					t.Fatalf("DeleteGatewayProvider: %v", err)
				}
			},
		},
	}

	var outcomes []r15sPruneOutcome
	for _, p := range paths {
		t.Run(p.name, func(t *testing.T) {
			out := r15sRunPrunePath(t, p.prune)
			t.Logf("剪枝路径=%s | models 里 gone-model 已消失=%v | gateway.default_model=%q",
				p.name, out.modelRowGone, out.defaultModel)
			if !out.modelRowGone {
				t.Fatalf("夹具失效：%s 之后 gone-model 行仍在", p.name)
			}
			// 判据 1（本路径自洽）：模型行没了，默认模型就不能再指向它。
			if out.defaultModel != "" {
				t.Errorf("终态自相矛盾：models 行已不存在，但 settings.gateway.default_model=%q", out.defaultModel)
			}
			outcomes = append(outcomes, out)
		})
	}

	// 判据 2（跨路径等价）：四条路径的终态必须逐字段相同。
	if len(outcomes) != len(paths) {
		t.Fatalf("夹具失效：只收集到 %d/%d 条路径的终态", len(outcomes), len(paths))
	}
	for i := 1; i < len(outcomes); i++ {
		if outcomes[i] != outcomes[0] {
			t.Errorf("四条剪枝路径行为不一致：%s=%+v 而 %s=%+v",
				paths[0].name, outcomes[0], paths[i].name, outcomes[i])
		}
	}
}

// TestR15SG01DefaultModelKeptWhenModelSurvives 是上一条的**反向判据**：
// 清空只允许发生在"默认模型真的消失了"的时候。少了它，把 clearDefaultModelIf
// 改成无条件 `UPDATE settings SET value=”` 也能让上一条变绿 —— 而那会把一个
// 仍然有效的默认模型静默清掉（运维面上表现为"默认模型莫名其妙没了"）。
//
// 覆盖两种语义：
//   - ON CONFLICT（SyncProviderModel 单行 upsert）：从不删行 ⇒ 绝不清；
//   - 全量替换（SyncProviderModels）但清单里保留了默认模型 ⇒ 绝不清。
func TestR15SG01DefaultModelKeptWhenModelSurvives(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	pid, err := AddGatewayProvider(db, &GatewayProvider{
		Name: "r15s-keep-prov", BaseURL: "http://127.0.0.1:9", APIKeyEnc: "k",
		Enabled: 1, Protocol: "openai",
	})
	if err != nil {
		t.Fatalf("AddGatewayProvider: %v", err)
	}
	if err := SyncProviderModels(db, pid, []string{"keep-model", "other-model", "third-model"}); err != nil {
		t.Fatalf("SyncProviderModels(seed): %v", err)
	}
	if err := SetSetting(db, "gateway.default_model", "keep-model"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	dmNow := func() string {
		t.Helper()
		dm, _, err := GetSetting(db, "gateway.default_model")
		if err != nil {
			t.Fatalf("GetSetting: %v", err)
		}
		return dm
	}
	if got := dmNow(); got != "keep-model" {
		t.Fatalf("夹具失效：default_model=%q", got)
	}

	// ① ON CONFLICT 语义：upsert 一个**另外**的模型名，默认模型不受影响。
	if err := SyncProviderModel(db, pid, "other-model", "{}"); err != nil {
		t.Fatalf("SyncProviderModel: %v", err)
	}
	if got := dmNow(); got != "keep-model" {
		t.Errorf("ON CONFLICT upsert 不该动 default_model：%q", got)
	}

	// ② 全量替换语义：清单里仍保留默认模型（同时把 other-model 剪掉）⇒ 不清。
	if err := SyncProviderModels(db, pid, []string{"keep-model", "third-model"}); err != nil {
		t.Fatalf("SyncProviderModels(剪掉 other-model): %v", err)
	}
	if got := dmNow(); got != "keep-model" {
		t.Errorf("默认模型仍在清单里，不该被清空：%q", got)
	}

	// ③ 删掉的是**别的**模型 ⇒ 不清。
	var thirdID int64
	if err := db.QueryRow(`SELECT id FROM models WHERE provider_id = ? AND name = 'third-model'`, pid).Scan(&thirdID); err != nil {
		t.Fatalf("读 third-model: %v", err)
	}
	if err := DeleteModel(db, thirdID); err != nil {
		t.Fatalf("DeleteModel(third-model): %v", err)
	}
	if got := dmNow(); got != "keep-model" {
		t.Errorf("删除另一个模型不该清空 default_model：%q", got)
	}
}

// TestR15SG01PruneInsideCallerTxRollsBackTheClear 钉住"清空与剪枝同事务":
// 调用方（R14 P0-2 的 UpdateGatewayProviderTx）把剪枝与 provider 行写入放在同一个
// 事务里，任一步失败整体回滚 —— 那么 default_model 也**必须**跟着回滚，
// 否则会出现"保存失败却把默认模型清掉了"的第三种不一致。
func TestR15SG01PruneInsideCallerTxRollsBackTheClear(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	pid, err := AddGatewayProvider(db, &GatewayProvider{
		Name: "r15s-tx-prov", BaseURL: "http://127.0.0.1:9", APIKeyEnc: "k",
		Enabled: 1, Protocol: "openai",
	})
	if err != nil {
		t.Fatalf("AddGatewayProvider: %v", err)
	}
	if err := SyncProviderModels(db, pid, []string{"gone-model"}); err != nil {
		t.Fatalf("SyncProviderModels(seed): %v", err)
	}
	if err := SetSetting(db, "gateway.default_model", "gone-model"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}

	tx, err := db.Begin()
	if err != nil {
		t.Fatalf("Begin: %v", err)
	}
	if _, err := SyncProviderModelsTx(tx, pid, []string{"keep-model"}); err != nil {
		t.Fatalf("SyncProviderModelsTx: %v", err)
	}
	// 事务内视图：行已删、设置已清 —— 证明"清空"发生在调用方的事务里，
	// 而不是提交之后的补偿动作（补偿动作会在保存失败时留下第三种不一致）。
	var goneInTx bool
	if err := tx.QueryRow(`SELECT NOT EXISTS(SELECT 1 FROM models WHERE provider_id = ? AND name = 'gone-model')`, pid).Scan(&goneInTx); err != nil {
		t.Fatalf("事务内复查 models: %v", err)
	}
	var dmInTx string
	if err := tx.QueryRow(`SELECT value FROM settings WHERE key = 'gateway.default_model'`).Scan(&dmInTx); err != nil {
		t.Fatalf("事务内复查 settings: %v", err)
	}
	if !goneInTx || dmInTx != "" {
		t.Fatalf("事务内终态 =行已删:%v/default_model:%q，期望 true/\"\"", goneInTx, dmInTx)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatalf("Rollback: %v", err)
	}

	// 回滚之后：gone-model 行还在（剪枝回滚），default_model 也必须是原值。
	var gone bool
	if err := db.QueryRow(`SELECT EXISTS(SELECT 1 FROM models WHERE provider_id = ? AND name = 'gone-model')`, pid).Scan(&gone); err != nil {
		t.Fatalf("复查 models: %v", err)
	}
	if !gone {
		t.Errorf("回滚之后 gone-model 行应仍在（剪枝随事务回滚）")
	}
	dm, _, err := GetSetting(db, "gateway.default_model")
	if err != nil {
		t.Fatalf("GetSetting: %v", err)
	}
	if dm != "gone-model" {
		t.Errorf("回滚之后 default_model = %q，期望原值 \"gone-model\"（清空必须与剪枝同事务）", dm)
	}
}
