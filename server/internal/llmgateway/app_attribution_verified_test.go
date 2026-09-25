package llmgateway

// R14-K · D-04 的判据：应用归因标签**必须指向本平台上真实存在、未软删的 wasm 应用**。
//
// 被审形态（lane D 的 D-04）：`usage.app_id` 的值完全来自客户端请求头
// （`x-deepseek-harness-session-id` 的 `app:` 前缀），服务端原先只做**形状**校验
// ⇒ 任何持员工 Bearer 的调用方都能把自己的用量记到任意 app_id 上，包括**平台上
// 根本不存在的应用**（真 PG 实测：伪造 `brand-new-not-in-db` 落库成功，管理端
// ai-usage 如实统计且 `attribution_available=true`）。
//
// 影响面如实界定：`usage.app_id` **不参与**计价 / 余额 / 路由（唯一读方是
// `QueryWasmAppAIUsage`，在 `capability:read` 之后）⇒ 不是资损、不是越权；
// 真实后果是"管理端应用维度成本可被任何员工污染"。
//
// 本文件钉住两件事：
//
//	① **已修**：不存在（或已软删）的 app_id ⇒ 不写标签（变异：拆掉存在性校验 ⇒ 红）；
//	② **边界（没修，也不该假装修了）**：把用量记到**另一个真实存在**的应用上**仍然
//	   可能**（员工使用他人的应用是正常业务，"必须是 owner"是错的判据；而服务端今天
//	   没有"该会话确属该应用"的凭据链路）。这条作为**判据**存在：将来若真的加了更严的
//	   校验，本用例会红，迫使口径（`AI_ATTRIBUTION_NOTE` / `app_attribution.go` 注释）
//	   同步更新 —— 见 webadmin 的 `app-attribution-claim-parity.spec.ts`。

import (
	"context"
	"database/sql"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// seedAttributionApp 播一个真实的 wasm 应用（存在性校验的唯一合法目标）。
func seedAttributionApp(t *testing.T, db *sql.DB, appID string) {
	t.Helper()
	if err := serverstore.UpsertWasmApp(context.Background(), db, serverstore.WasmApp{
		AppID: appID, Title: appID, Owner: "someone-else", Enabled: true,
	}); err != nil {
		t.Fatalf("播应用 %s: %v", appID, err)
	}
}

// TestBindUsageAppIDRejectsUnknownApp 是 D-04 的主判据。
func TestBindUsageAppIDRejectsUnknownApp(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	seedAttributionApp(t, db, "notes") // 真实存在的应用
	uid := createAttributionUser(t, db, "u-verify")
	api := &API{DB: db}

	// ① 伪造一个平台上不存在的应用 ⇒ 不归因（旧实现会照写）。
	unknownID, err := serverstore.RecordUsageKind(db, uid, "demo-model", 10, 5, "chat")
	if err != nil {
		t.Fatal(err)
	}
	api.bindUsageAppID(ginContextWithHeader(appSessionIDHeaderName(), "app:brand-new-not-in-db#alice@abc"), unknownID)
	if got := readAttributionRow(t, db, unknownID).appID; got != "" {
		t.Errorf("不存在的应用被写进归因列：app_id=%q（want 空串）—— 存在性校验没有生效", got)
	}

	// ② 真实存在的应用 ⇒ 归因（正对照：证明①不是因为别的原因恒空）。
	knownID, err := serverstore.RecordUsageKind(db, uid, "demo-model", 10, 5, "chat")
	if err != nil {
		t.Fatal(err)
	}
	api.bindUsageAppID(ginContextWithHeader(appSessionIDHeaderName(), "app:notes#alice@abc"), knownID)
	if got := readAttributionRow(t, db, knownID).appID; got != "notes" {
		t.Errorf("真实存在的应用没有归因：app_id=%q（want notes）", got)
	}

	// ③ 已软删的应用 ⇒ 不归因（退役应用不该继续出现在新的成本统计里）。
	if _, err := db.Exec(`UPDATE apps SET deleted_at = now() WHERE kind = ? AND app_id = ?`,
		serverstore.AppKindWasmApp, "notes"); err != nil {
		t.Fatal(err)
	}
	deletedID, err := serverstore.RecordUsageKind(db, uid, "demo-model", 10, 5, "chat")
	if err != nil {
		t.Fatal(err)
	}
	api.bindUsageAppID(ginContextWithHeader(appSessionIDHeaderName(), "app:notes#alice@abc"), deletedID)
	if got := readAttributionRow(t, db, deletedID).appID; got != "" {
		t.Errorf("已软删的应用仍被归因：app_id=%q（want 空串）", got)
	}

	// ④ 技能/智能体（kind != wasm_app）的同名 app_id **不得**成为目标。
	if _, err := db.Exec(`INSERT INTO apps (kind, app_id, title, channel) VALUES ('skill', 'notes-skill', 'notes-skill', 'market')`); err != nil {
		t.Fatal(err)
	}
	skillID, err := serverstore.RecordUsageKind(db, uid, "demo-model", 10, 5, "chat")
	if err != nil {
		t.Fatal(err)
	}
	api.bindUsageAppID(ginContextWithHeader(appSessionIDHeaderName(), "app:notes-skill#alice@abc"), skillID)
	if got := readAttributionRow(t, db, skillID).appID; got != "" {
		t.Errorf("技能行的 app_id 被当成应用归因目标：app_id=%q（want 空串）", got)
	}
}

// TestBindUsageAppIDStillAcceptsAnotherUsersApp 是**边界判据**（D-04 明确不修的那一半）。
//
// 员工使用他人的应用是正常业务 ⇒ "调用方必须是 owner" 是错的判据；而服务端没有
// "该会话确属该应用"的凭据链路可查 ⇒ 把用量记到另一个真实存在的应用上仍然可能。
// 这条用例把**当前真实能力**钉住，防止有人在文案里写成"已校验归属"却没有代码支撑
// （webadmin 的 claim-parity spec 从另一侧对拍同一件事）。
func TestBindUsageAppIDStillAcceptsAnotherUsersApp(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	// 应用属于 someone-else；调用方是另一个员工。
	seedAttributionApp(t, db, "someone-elses-app")
	uid := createAttributionUser(t, db, "u-other")
	id, err := serverstore.RecordUsageKind(db, uid, "demo-model", 10, 5, "chat")
	if err != nil {
		t.Fatal(err)
	}
	(&API{DB: db}).bindUsageAppID(
		ginContextWithHeader(appSessionIDHeaderName(), "app:someone-elses-app#u-other@abc"), id)
	if got := readAttributionRow(t, db, id).appID; got != "someone-elses-app" {
		t.Fatalf("边界变了：把用量记到**他人真实存在**的应用上现在被拒绝（app_id=%q）—— "+
			"若这是有意的收紧，请同步更新 AI_ATTRIBUTION_NOTE 与 app_attribution.go 的口径"+
			"（webadmin/app-attribution-claim-parity.spec.ts 会同时红）", got)
	}
}
