package llmgateway

// 审计 2026-09-19(P2-4):排除名单双向 + "重新添加"不再被同步撤销。
//
// 缺陷形态(既有,已实测复现):排除名单只有 AddExcludedModel,没有移出接口,
// 而 webadmin 删除确认文案承诺「删除后同步不会自动恢复,**如需恢复请重新添加**」。
// 实测 `POST /api/server/admin/models` 重建同名渠道模型 → 200 且模型列表里有,
// 但下一轮 SyncOnce 返回 `{Added:0 Removed:1}`,模型又被删掉(它不在上游目录的
// keep 列表 newNames 里)⇒ UI 承诺的恢复路径不可兑现。
//
// 修法:恢复 serverstore.RemoveExcludedModel(幂等;名单被移空时写回 `[]`),
// createModel 在 provider.Channel != "" 时先移名单、再建行 —— 管理员的显式意图
// 优先于自动同步。deleteModel 的 AddExcludedModel 路径不变(H2 本身不退化)。

import (
	"database/sql"
	"net/http"
	"strconv"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// TestReAddExcludedChannelModelSurvivesNextSync:"重新添加"必须真的恢复模型,
// 下一轮同步不得再删。
func TestReAddExcludedChannelModelSurvivesNextSync(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"deepseek","api_key":"sk","channel":"deepseek"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create channel provider: %d %s", w.Code, w.Body.String())
	}
	var providerID, chatModelID int64
	if err := db.QueryRow(`SELECT id FROM gateway_providers WHERE name = 'deepseek'`).Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT id FROM models WHERE name = 'deepseek-chat'`).Scan(&chatModelID); err != nil {
		t.Fatal(err)
	}
	// 管理端删除渠道同步模型 ⇒ 进排除名单(H2)。
	if w, _ := adminReq(t, r, "DELETE", "/api/server/admin/models/"+strconv.FormatInt(chatModelID, 10), "", hdr); w.Code != http.StatusOK {
		t.Fatalf("delete channel model: %d", w.Code)
	}
	excluded, err := serverstore.GetExcludedModels(db, providerID)
	if err != nil || len(excluded) != 1 || excluded[0] != "deepseek-chat" {
		t.Fatalf("前置条件不成立:排除名单 = %v/%v", excluded, err)
	}

	// 管理员显式"重新添加"同名渠道模型。
	w, _ := adminReq(t, r, "POST", "/api/server/admin/models",
		`{"name":"deepseek-chat","provider_id":`+strconv.FormatInt(providerID, 10)+`,"display_name":"deepseek-chat"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("re-add model: %d %s", w.Code, w.Body.String())
	}
	// 名单必须已被清掉(显式意图优先),否则下一轮同步必然再删。
	excluded, err = serverstore.GetExcludedModels(db, providerID)
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range excluded {
		if n == "deepseek-chat" {
			t.Fatalf("重新添加后模型名仍在排除名单里: %v", excluded)
		}
	}

	// 下一轮同步:不得再删(修复前 Removed=1、模型消失)。
	results, err := SyncOnce(db, audit0919Catalog)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %+v, want 1", results)
	}
	if results[0].Error != "" || results[0].Removed != 0 {
		t.Fatalf("重新添加的模型被同步撤销: %+v", results[0])
	}
	if !audit0919HasModel(t, db, providerID, "deepseek-chat") {
		t.Fatal("重新添加的模型在下一轮同步后消失")
	}
}

// TestRemoveExcludedModelIsIdempotentAndKeepsEmptyList:移出接口的幂等与空名单
// 形态(写回 `[]`,与"键不存在"同解但可自证已处理)。
//
// 走**事务版**(`RemoveExcludedModelTx`)—— 生产路径(createModel)就是它,而且
// 刻意不再提供 autocommit 版:只留事务版,调用方不可能把"移名单 + 建模型行"
// 拆成两步(那正是 P2 的成因)。事务版**不失效缓存**,所以这里提交后显式
// `InvalidateSettings()`,顺带把这条契约钉在用例里(漏掉 ⇒ 下面的读取断言会红)。
func TestRemoveExcludedModelIsIdempotentAndKeepsEmptyList(t *testing.T) {
	_, db, _ := adminTestSetup(t)
	defer db.Close()

	const providerID int64 = 42 // 名单只是 settings 键,不需要 provider 行存在
	key := "gateway.excluded_models.42"
	remove := func(name string) (bool, error) {
		tx, err := db.Begin()
		if err != nil {
			return false, err
		}
		defer tx.Rollback()
		changed, err := serverstore.RemoveExcludedModelTx(tx, providerID, name)
		if err != nil {
			return false, err
		}
		if err := tx.Commit(); err != nil {
			return false, err
		}
		serverstore.InvalidateSettings()
		return changed, nil
	}
	if err := serverstore.AddExcludedModel(db, providerID, "a"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.AddExcludedModel(db, providerID, "b"); err != nil {
		t.Fatal(err)
	}
	// 移出一个:另一个保留;返回值证明"确实改了"。
	if changed, err := remove("a"); err != nil {
		t.Fatalf("remove a: %v", err)
	} else if !changed {
		t.Fatal("remove a: changed=false, want true")
	}
	assertExcluded0919(t, db, providerID, []string{"b"})
	// 幂等:不在名单里也算成功(不写、不报错),且 changed=false。
	if changed, err := remove("a"); err != nil {
		t.Fatalf("remove a again (幂等): %v", err)
	} else if changed {
		t.Fatal("remove a again: changed=true, want false")
	}
	assertExcluded0919(t, db, providerID, []string{"b"})
	// 移空 ⇒ 名单写回 `[]`(不删键)。
	if _, err := remove("b"); err != nil {
		t.Fatalf("remove b: %v", err)
	}
	assertExcluded0919(t, db, providerID, nil)
	var raw string
	if err := db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&raw); err != nil {
		t.Fatalf("空名单应写回 [] 而不是删键: %v", err)
	}
	if raw != "[]" {
		t.Fatalf("空名单形态 = %q, want []", raw)
	}
	// 空名单上再移出仍是幂等成功。
	if _, err := remove("b"); err != nil {
		t.Fatalf("remove on empty list: %v", err)
	}
	assertExcluded0919(t, db, providerID, nil)
}

// TestReAddModelForManualProviderLeavesExclusionListAlone:只有渠道型 provider
// 才动排除名单(手动型上游的模型不参与同步,不该被 createModel 清名单)。
// 手动型上游理论上不会进名单,这里用合成状态钉住条件本身。
func TestReAddModelForManualProviderLeavesExclusionListAlone(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"manual","base_url":"https://upstream.example.com","api_key":"sk","models":["m1"]}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create manual provider: %d %s", w.Code, w.Body.String())
	}
	var providerID int64
	if err := db.QueryRow(`SELECT id FROM gateway_providers WHERE name = 'manual'`).Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	// 合成前置:手动型上游凭空带上一条排除记录(名字不与已建模型冲突 ——
	// 手动型上游的 models 列表在创建时就已落成模型行)。
	if err := serverstore.AddExcludedModel(db, providerID, "m2"); err != nil {
		t.Fatal(err)
	}
	if w, _ := adminReq(t, r, "POST", "/api/server/admin/models",
		`{"name":"m2","provider_id":`+strconv.FormatInt(providerID, 10)+`}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create manual model: %d %s", w.Code, w.Body.String())
	}
	assertExcluded0919(t, db, providerID, []string{"m2"})
}

// assertExcluded0919 断言排除名单内容(顺序不敏感)。
func assertExcluded0919(t *testing.T, db *sql.DB, providerID int64, want []string) {
	t.Helper()
	got, err := serverstore.GetExcludedModels(db, providerID)
	if err != nil {
		t.Fatalf("GetExcludedModels: %v", err)
	}
	if len(got) != len(want) {
		t.Fatalf("排除名单 = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("排除名单 = %v, want %v", got, want)
		}
	}
}

// audit0919HasModel 判断某 provider 下是否存在该模型名。
func audit0919HasModel(t *testing.T, db *sql.DB, providerID int64, name string) bool {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM models WHERE provider_id = ? AND name = ?`, providerID, name).Scan(&n); err != nil {
		t.Fatalf("count model: %v", err)
	}
	return n > 0
}
