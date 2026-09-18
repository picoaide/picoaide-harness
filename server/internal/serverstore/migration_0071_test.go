package serverstore

import (
	"database/sql"
	"encoding/json"
	"reflect"
	"testing"
)

// 0071 回归（2026-09-18）：**访问模式收敛为 access 三模式**。
//
// 这条迁移最容易出事的地方是**存量数据**：库里的 `config_json` 全是旧 schema
// （`visible` / `login_required`），而新代码只认 `access`。迁移必须：
//
//	① 删掉 apps.visible（目录不再按可见性过滤）；
//	② 把老 JSON 按**与 appcfg 兼容 shim 同一张映射表**就地改写：
//	     login_required=false                  ⇒ access=public
//	     login_required=true + whitelist 非空   ⇒ access=whitelist
//	     login_required=true + whitelist 空     ⇒ access=login（"登录后全员"是合法模式）
//	     visible                               ⇒ 丢弃
//	   其余键（purpose/owner/自定义键）**逐字保留**；
//	③ app_releases.config_json 同规则改写（版本快照与生效行不能两种 schema）；
//	④ 幂等可重放：第二次执行零副作用（逐字节不变）；
//	⑤ 非 wasm 行（skill/agent）与坏 JSON 行不得被碰。
//
// 手法与 migration_0062_test.go / 0069 的用例一致：先只应用到 0070 造"升级前"的库，
// 构造存量数据，再应用 0071，逐条断言。
func TestMigration0071RewritesLegacyConfigInPlace(t *testing.T) {
	all := migrationsFor()
	var pre, post []migration
	for _, m := range all {
		if m.version <= 70 {
			pre = append(pre, m)
		}
		if m.version == 71 {
			post = append(post, m)
		}
	}
	if len(post) != 1 {
		t.Fatalf("找不到 0071 迁移（got %d 条）", len(post))
	}
	// 必须先设置迁移集合再建库：否则会克隆"已迁移到最新"的模板库，0071 根本不会重放。
	testMigrationHook = func() []migration { return pre }
	t.Cleanup(func() { testMigrationHook = nil })
	db, cleanup := newTestDB(t)
	defer cleanup()

	// --- 1) 前置条件：这是"升级前"的库（visible 列在、config_json 是旧 schema） ---
	if !columnExists(t, db, "apps", "visible") {
		t.Fatal("前置条件失败：0070 时 apps.visible 应当存在（0069 建的）")
	}

	// --- 2) 存量数据：覆盖映射表的每一行，外加不该被碰的两类行 ---
	type legacyCase struct {
		appID      string
		configJSON string
		wantAccess string
	}
	cases := []legacyCase{
		// 旧 public：login_required=false，visible=false 也要丢掉
		{"legacy-public", `{"visible":false,"login_required":false,"whitelist":[],"purpose":"公开工具","data_sensitivity":"public","owner":"alice"}`, "public"},
		// 旧白名单：login_required=true + 名单非空
		{"legacy-white", `{"visible":true,"login_required":true,"whitelist":["alice","bob"],"purpose":"白名单工具","data_sensitivity":"internal","owner":"alice"}`, "whitelist"},
		// 旧"登录后全员"：login_required=true + 名单空（旧规则本会拒发布，但库里可能有历史行）
		{"legacy-login", `{"visible":true,"login_required":true,"whitelist":[],"purpose":"全员工具","data_sensitivity":"internal","owner":"bob"}`, "login"},
		// 只有 login_required=true、连 whitelist 键都没有
		{"legacy-bare", `{"login_required":true}`, "login"},
		// 只有 visible（没有 login_required）：按旧缺省 true 处理 ⇒ login
		{"legacy-visible-only", `{"visible":false}`, "login"},
		// 空 config_json：不碰（也解释不了 ⇒ 显示侧回落 login）
		{"legacy-empty", ``, "login"},
		// 坏 JSON：跳过而不是炸库（列是 TEXT，历史上手工写入过什么不可假设）
		{"legacy-broken", `{not json`, "login"},
		// 已是新 schema：一字不动（幂等的前提）
		{"new-schema", `{"access":"public","whitelist":["alice"],"purpose":"已经是新 schema"}`, "public"},
	}
	for _, c := range cases {
		insertLegacyWasmApp(t, db, c.appID, "旧标题 "+c.appID, c.configJSON)
	}
	// **混合形状**：同时带 `access` 与旧键。UPDATE 的有意跳过它（已是 canonical，
	// 旧键只是冗余）—— 自检段必须用**同一条件**判定，否则这一行会让整个迁移
	// RAISE、升级直接失败（独立审计 2026-09-18 P2-1，真 PG 复现过）。
	insertLegacyWasmApp(t, db, "mixed-schema", "混合形状",
		`{"access":"public","visible":true,"login_required":false,"purpose":"混合形状"}`)

	// skill 行：config_json 是 0069 才加的列，语义与本平台无关 ⇒ 不得被改写。
	if _, err := db.Exec(`INSERT INTO apps (kind, app_id, title, owner, channel, enabled, purpose, data_sensitivity, config_json)
		VALUES ('skill', 'legacy-skill', '旧技能', 'alice', 'market', 1, '', '', '{"visible":true,"login_required":true,"whitelist":["x"]}')`); err != nil {
		t.Fatalf("插入 skill 行: %v", err)
	}
	// 版本行：旧 schema 的快照同样要被改写（只改 wasm 应用的）。
	if _, err := db.Exec(`INSERT INTO app_releases (kind, app_id, version, title, status, config_json)
		VALUES ('wasm_app', 'legacy-white', '1.0.0', '白名单工具', 'approved', '{"login_required":true,"whitelist":["alice"],"purpose":"白名单工具"}')`); err != nil {
		t.Fatalf("插入 wasm 版本行: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO app_releases (kind, app_id, version, title, status, config_json)
		VALUES ('skill', 'legacy-skill', '1.0.0', '旧技能', 'approved', '{"visible":true}')`); err != nil {
		t.Fatalf("插入 skill 版本行: %v", err)
	}

	// --- 3) 应用 0071 ---
	testMigrationHook = func() []migration { return post }
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("应用 0071: %v", err)
	}
	if columnExists(t, db, "apps", "visible") {
		t.Fatal("0071 之后 apps.visible 必须已删除")
	}

	// --- 4) 逐行对拍：access 映射正确、旧键清零、其余键逐字保留 ---
	for _, c := range cases {
		got := readAppConfigJSON(t, db, c.appID)
		if c.configJSON == "" || c.configJSON == `{not json` {
			if got != c.configJSON {
				t.Errorf("%s: 空/坏 JSON 不得被改写: got %q, want %q", c.appID, got, c.configJSON)
			}
			continue
		}
		var doc map[string]any
		if err := json.Unmarshal([]byte(got), &doc); err != nil {
			t.Errorf("%s: 改写后不是合法 JSON: %q (%v)", c.appID, got, err)
			continue
		}
		if doc["access"] != c.wantAccess {
			t.Errorf("%s: access = %v, want %q（doc=%s）", c.appID, doc["access"], c.wantAccess, got)
		}
		for _, legacy := range []string{"visible", "login_required"} {
			if _, ok := doc[legacy]; ok {
				t.Errorf("%s: 旧键 %q 必须被删掉（doc=%s）", c.appID, legacy, got)
			}
		}
		// 其余键逐字保留（对拍 before 的每个非旧键）。
		var before map[string]any
		if err := json.Unmarshal([]byte(c.configJSON), &before); err != nil {
			t.Fatalf("%s: 测试夹具自身不是合法 JSON: %v", c.appID, err)
		}
		for k, v := range before {
			if k == "visible" || k == "login_required" {
				continue
			}
			if !reflect.DeepEqual(doc[k], v) {
				t.Errorf("%s: 键 %q 被改写: got %v, want %v（改写只应动旧的两个键）", c.appID, k, doc[k], v)
			}
		}
	}
	// 已经是新 schema 的那行必须**逐字节不变**。
	if got := readAppConfigJSON(t, db, "new-schema"); got != `{"access":"public","whitelist":["alice"],"purpose":"已经是新 schema"}` {
		t.Errorf("已含 access 的行不该被重写: %q", got)
	}
	// 混合形状同理逐字节不变（走的是同一条"已含 access 就跳过"的分支）。
	// 它的真正判据是**迁移没有失败** —— 自检条件与 UPDATE 不一致时 ApplyMigrations
	// 会在这里之前就 RAISE（P2-1 的形态）。
	if got := readAppConfigJSON(t, db, "mixed-schema"); got != `{"access":"public","visible":true,"login_required":false,"purpose":"混合形状"}` {
		t.Errorf("同时带 access 与旧键的行不该被重写: %q", got)
	}
	// skill 行与 skill 版本行不得被碰。
	if got := readAppConfigJSONOfKind(t, db, "skill", "legacy-skill"); got != `{"visible":true,"login_required":true,"whitelist":["x"]}` {
		t.Errorf("skill 行的 config_json 不得被改写: %q", got)
	}
	if got := readReleaseConfigJSON(t, db, "skill", "legacy-skill", "1.0.0"); got != `{"visible":true}` {
		t.Errorf("skill 版本行的 config_json 不得被改写: %q", got)
	}
	// wasm 版本行同规则改写。
	var relDoc map[string]any
	relRaw := readReleaseConfigJSON(t, db, "wasm_app", "legacy-white", "1.0.0")
	if err := json.Unmarshal([]byte(relRaw), &relDoc); err != nil {
		t.Fatalf("版本行改写后不是合法 JSON: %q (%v)", relRaw, err)
	}
	if relDoc["access"] != "whitelist" || relDoc["purpose"] != "白名单工具" {
		t.Errorf("wasm 版本行改写不对: %s", relRaw)
	}
	if _, ok := relDoc["login_required"]; ok {
		t.Errorf("wasm 版本行仍带旧键: %s", relRaw)
	}
	// 其它列不得被迁移顺手改掉（只动 config_json 与删列）。
	if got := readAppTitle(t, db, "legacy-public"); got != "旧标题 legacy-public" {
		t.Errorf("title 被迁移改掉了: %q", got)
	}

	// --- 5) 幂等：把 0071 的 SQL 再执行一次，结果必须逐字节不变 ---
	snapshot := snapshotWasmConfigs(t, db)
	if _, err := db.Exec(post[0].sql); err != nil {
		t.Fatalf("重放 0071（幂等要求可重放）: %v", err)
	}
	if after := snapshotWasmConfigs(t, db); !reflect.DeepEqual(snapshot, after) {
		t.Errorf("重放 0071 改变了数据 —— 迁移必须幂等\n before=%v\n after =%v", snapshot, after)
	}
}

// ---- 0071 用例的小工具 ----

func insertLegacyWasmApp(t *testing.T, db *sql.DB, appID, title, configJSON string) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO apps
		(kind, app_id, title, description, owner, channel, enabled, purpose, data_sensitivity, config_json, visible)
		VALUES ('wasm_app', ?, ?, '', 'alice', 'wasm', 1, '', '', ?, 1)`, appID, title, configJSON); err != nil {
		t.Fatalf("插入存量应用 %s: %v", appID, err)
	}
}

func readAppConfigJSON(t *testing.T, db *sql.DB, appID string) string {
	t.Helper()
	return readAppConfigJSONOfKind(t, db, "wasm_app", appID)
}

func readAppConfigJSONOfKind(t *testing.T, db *sql.DB, kind, appID string) string {
	t.Helper()
	var got string
	if err := db.QueryRow(`SELECT config_json FROM apps WHERE kind = ? AND app_id = ?`, kind, appID).Scan(&got); err != nil {
		t.Fatalf("读 %s/%s 的 config_json: %v", kind, appID, err)
	}
	return got
}

func readReleaseConfigJSON(t *testing.T, db *sql.DB, kind, appID, version string) string {
	t.Helper()
	var got string
	if err := db.QueryRow(`SELECT config_json FROM app_releases WHERE kind = ? AND app_id = ? AND version = ?`,
		kind, appID, version).Scan(&got); err != nil {
		t.Fatalf("读 %s/%s/%s 的 config_json: %v", kind, appID, version, err)
	}
	return got
}

func readAppTitle(t *testing.T, db *sql.DB, appID string) string {
	t.Helper()
	var got string
	if err := db.QueryRow(`SELECT title FROM apps WHERE kind = 'wasm_app' AND app_id = ?`, appID).Scan(&got); err != nil {
		t.Fatalf("读 %s 的 title: %v", appID, err)
	}
	return got
}

// snapshotWasmConfigs 抓一份 (kind/app_id/version → config_json) 快照用于对拍。
func snapshotWasmConfigs(t *testing.T, db *sql.DB) map[string]string {
	t.Helper()
	out := map[string]string{}
	rows, err := db.Query(`SELECT kind, app_id, config_json FROM apps ORDER BY kind, app_id`)
	if err != nil {
		t.Fatalf("快照 apps: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var kind, appID, cfg string
		if err := rows.Scan(&kind, &appID, &cfg); err != nil {
			t.Fatal(err)
		}
		out["apps/"+kind+"/"+appID] = cfg
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	rels, err := db.Query(`SELECT kind, app_id, version, config_json FROM app_releases ORDER BY kind, app_id, version`)
	if err != nil {
		t.Fatalf("快照 app_releases: %v", err)
	}
	defer rels.Close()
	for rels.Next() {
		var kind, appID, version, cfg string
		if err := rels.Scan(&kind, &appID, &version, &cfg); err != nil {
			t.Fatal(err)
		}
		out["releases/"+kind+"/"+appID+"/"+version] = cfg
	}
	return out
}

func columnExists(t *testing.T, db *sql.DB, table, column string) bool {
	t.Helper()
	var ok bool
	if err := db.QueryRow(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_name = ? AND column_name = ?)`, table, column).Scan(&ok); err != nil {
		t.Fatalf("查列 %s.%s: %v", table, column, err)
	}
	return ok
}
