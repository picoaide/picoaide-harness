package serverstore

import (
	"database/sql"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// 0074 回归（WASM「客户端专属」改造 · W4-6）：**wasm 应用的 access 由 public 改写为 login**。
//
// 这条迁移最容易出事的地方是**形状与范围**（R1-DAT-2/3/4）：
//
//	① 字面替换（`REPLACE(config_json,'"access":"public"',…)`）只认紧凑形态，
//	   而库里真实存在 jsonb 形态（`{"access": "public", …}` 冒号后带空格）；
//	② 范围必须限定 `kind='wasm_app'`：技能/智能体行的 config_json 是同一个列，
//	   语义与本平台无关（它们也可能碰巧写着 access=public）；
//	③ 幂等可重放：第二次执行命中 0 行、逐字节不变；
//	④ 坏 JSON 行（列是 TEXT）跳过而不是炸库 —— 自检只 RAISE WARNING 报数量；
//	⑤ 自检**必须真的 fail-loud**：改写没生效时整条迁移要失败（见文件末尾的用例）。
//
// 手法与 migration_0071_test.go 一致：先只应用到 0073 造"升级前"的库，构造存量数据，
// 再应用 0074，逐条断言。
func TestMigration0074RewritesPublicAccessToLogin(t *testing.T) {
	post := applyPreThen(t, 73)
	db, cleanup := newTestDB(t)
	defer cleanup()

	// --- 1) 存量数据：覆盖"该改"与"一律不碰"的每一类 ---
	// 该改的两类（紧凑 / jsonb 空格形态），以及"不该被碰"的四类。
	cases := []struct {
		appID      string
		configJSON string
		rewritten  bool
	}{
		// 紧凑形态：字面替换也认，但改写必须走 jsonb 往返（其余键逐字保留）。
		{"compact", `{"access":"public"}`, true},
		// jsonb 空格形态：**字面替换对它 0 命中** —— 本用例就是为它存在的。
		{"spaced", `{"access": "public", "purpose": "匿名可达", "data_sensitivity": "public", "owner": "alice"}`, true},
		// 已经是 login：逐字节不变（幂等的前提）。
		{"already-login", `{"access":"login","purpose":"登录后全员"}`, false},
		// whitelist 不受影响。
		{"whitelist", `{"access":"whitelist","whitelist":["alice"],"purpose":"名单"}`, false},
		// 没有 access 键（缺省即 login）：不写。
		{"no-access", `{"purpose":"没有 access 键"}`, false},
		// 空串：jsonb 无法解析，跳过（也不进坏 JSON 告警）。
		{"empty", ``, false},
		// 坏 JSON：跳过而不是炸库。
		{"broken", `{not json`, false},
		// 合法 JSON 但不是对象（数组）：jsonb_set 不适用，跳过。
		{"json-array", `[{"access":"public"}]`, false},
	}
	for _, c := range cases {
		insertWasmConfig(t, db, "wasm_app", c.appID, c.configJSON)
	}
	// kind != 'wasm_app' 的行**一律不得被改**：同一个列，语义与本平台无关。
	insertWasmConfig(t, db, "skill", "skill-public", `{"access":"public","purpose":"技能"}`)
	insertWasmConfig(t, db, "agent", "agent-public", `{"access":"public"}`)
	// 版本快照同规则改写（wasm），而非 wasm 的版本行不碰。
	insertWasmReleaseConfig(t, db, "wasm_app", "compact", "1.0.0", `{"access":"public","purpose":"v1"}`)
	insertWasmReleaseConfig(t, db, "wasm_app", "already-login", "1.0.0", `{"access":"login"}`)
	insertWasmReleaseConfig(t, db, "wasm_app", "broken", "1.0.0", `{not json`)
	insertWasmReleaseConfig(t, db, "skill", "skill-public", "1.0.0", `{"access":"public"}`)

	// --- 2) 前置条件：这是"升级前"的库（public 真的在） ---
	if got := readAppConfigJSONOfKind(t, db, "wasm_app", "spaced"); !strings.Contains(got, `"access": "public"`) {
		t.Fatalf("前置条件失败：jsonb 空格形态的 public 应当还在，得到 %q", got)
	}
	if got := readAppConfigJSONOfKind(t, db, "wasm_app", "compact"); got != `{"access":"public"}` {
		t.Fatalf("前置条件失败：紧凑形态的 public 应当还在，得到 %q", got)
	}

	// --- 3) 应用 0074 ---
	testMigrationHook = func() []migration { return post }
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("应用 0074: %v", err)
	}

	// --- 4) 逐行对拍 ---
	for _, c := range cases {
		got := readAppConfigJSONOfKind(t, db, "wasm_app", c.appID)
		if !c.rewritten {
			// 不命中的行必须**逐字节不变**（含坏 JSON / 空串 / 非对象）。
			if got != c.configJSON {
				t.Errorf("%s: 不该被改写的行被动过\n got=%q\nwant=%q", c.appID, got, c.configJSON)
			}
			continue
		}
		var doc map[string]any
		if err := json.Unmarshal([]byte(got), &doc); err != nil {
			t.Errorf("%s: 改写后不是合法 JSON: %q (%v)", c.appID, got, err)
			continue
		}
		if doc["access"] != "login" {
			t.Errorf("%s: access = %v, want \"login\"（doc=%s）", c.appID, doc["access"], got)
		}
		// 其余键逐字保留：改写只动 access 一个键。
		var before map[string]any
		if err := json.Unmarshal([]byte(c.configJSON), &before); err != nil {
			t.Fatalf("%s: 测试夹具自身不是合法 JSON: %v", c.appID, err)
		}
		for k, v := range before {
			if k == "access" {
				continue
			}
			if !reflect.DeepEqual(doc[k], v) {
				t.Errorf("%s: 键 %q 被改写: got %v, want %v（改写只应动 access）", c.appID, k, doc[k], v)
			}
		}
	}
	// 紧凑形态的**原始形态**（无空格）在改写后仍是紧凑形态（jsonb 归一化只加冒号空格）。
	if got := readAppConfigJSONOfKind(t, db, "wasm_app", "compact"); got != `{"access": "login"}` {
		t.Errorf("紧凑形态改写结果 = %q, want `{\"access\": \"login\"}`", got)
	}
	// 非 wasm 行不得被碰（skill / agent）。
	if got := readAppConfigJSONOfKind(t, db, "skill", "skill-public"); got != `{"access":"public","purpose":"技能"}` {
		t.Errorf("skill 行的 config_json 不得被改写: %q", got)
	}
	if got := readAppConfigJSONOfKind(t, db, "agent", "agent-public"); got != `{"access":"public"}` {
		t.Errorf("agent 行的 config_json 不得被改写: %q", got)
	}
	// 版本快照：wasm 的 public 改写、login 与非 wasm 行不动。
	if got := readReleaseConfigJSON(t, db, "wasm_app", "compact", "1.0.0"); got != `{"access": "login", "purpose": "v1"}` {
		t.Errorf("wasm 版本快照的 public 应被改写为 login: %q", got)
	}
	if got := readReleaseConfigJSON(t, db, "wasm_app", "already-login", "1.0.0"); got != `{"access":"login"}` {
		t.Errorf("wasm 版本快照的 login 行不得被改写: %q", got)
	}
	if got := readReleaseConfigJSON(t, db, "wasm_app", "broken", "1.0.0"); got != `{not json` {
		t.Errorf("wasm 版本快照的坏 JSON 行不得被改写: %q", got)
	}
	if got := readReleaseConfigJSON(t, db, "skill", "skill-public", "1.0.0"); got != `{"access":"public"}` {
		t.Errorf("skill 版本行的 config_json 不得被改写: %q", got)
	}
	// 其它列不得被迁移顺手改掉（只动 config_json）。
	if got := readAppTitle(t, db, "spaced"); got != "旧标题 spaced" {
		t.Errorf("title 被迁移改掉了: %q", got)
	}
	// 验收 SQL（设计 §9）：`SELECT count(*) FROM apps WHERE kind='wasm_app'
	// AND config_json::jsonb->>'access'='public'` 必须 = 0。
	// 这里补 `config_json <> '' AND config_json IS JSON OBJECT` 守卫：设计原句的裸
	// `::jsonb` 遇到坏 JSON 行直接 22P02（本用例刻意造了坏行，真实库同理 —— 迁移
	// 自身也带同一守卫，坏行只由自检 RAISE WARNING 计数）。
	var remaining int
	if err := db.QueryRow(`SELECT count(*) FROM apps
		WHERE kind = 'wasm_app' AND config_json <> '' AND config_json IS JSON OBJECT
		  AND config_json::jsonb ->> 'access' = 'public'`).Scan(&remaining); err != nil {
		t.Fatalf("验收 SQL: %v", err)
	}
	if remaining != 0 {
		t.Errorf("升级后 wasm 应用的 access=public 行数 = %d，必须为 0", remaining)
	}

	// --- 5) 幂等：把 0074 的 SQL 再执行一遍，结果必须逐字节不变 ---
	snapshot := snapshotWasmConfigs(t, db)
	if _, err := db.Exec(post[0].sql); err != nil {
		t.Fatalf("重放 0074（幂等要求可重放）: %v", err)
	}
	if after := snapshotWasmConfigs(t, db); !reflect.DeepEqual(snapshot, after) {
		t.Errorf("重放 0074 改变了数据 —— 迁移必须幂等\n before=%v\n after =%v", snapshot, after)
	}
}

// TestMigration0074SelfCheckIsFailLoud 证明末尾的 DO 自检**真的会炸**（W4-6 的变异判据 ③）。
//
// 为什么需要专门构造一次"改写没生效"：自检的谓词与 UPDATE 的 WHERE 逐条对齐
// （0071 P2-1 的教训 —— 两者不一致会把合法行算成未改写、升级直接失败），
// 因此在改写正常生效时它永远不会命中。要证明它 fail-loud，只能把改写变成空操作：
// 这里挂一个 `BEFORE UPDATE ... RETURN NULL` 触发器（返回 NULL = 该行静默跳过），
// 复现"迁移跑了、public 还在"的形态 —— 正是自检要拦的那一类。
//
// 变异验证：删掉 0074 末尾的 DO 段 ⇒ `db.Exec` 静默成功 ⇒ 本用例红。
func TestMigration0074SelfCheckIsFailLoud(t *testing.T) {
	post := applyPreThen(t, 73)
	db, cleanup := newTestDB(t)
	defer cleanup()

	insertWasmConfig(t, db, "wasm_app", "legacy-public", `{"access":"public"}`)

	if _, err := db.Exec(`CREATE OR REPLACE FUNCTION test_0074_block_apps_update() RETURNS trigger
		LANGUAGE plpgsql AS $fn$ BEGIN RETURN NULL; END $fn$`); err != nil {
		t.Fatalf("建触发器函数: %v", err)
	}
	if _, err := db.Exec(`CREATE TRIGGER test_0074_block_apps_update BEFORE UPDATE ON apps
		FOR EACH ROW EXECUTE FUNCTION test_0074_block_apps_update()`); err != nil {
		t.Fatalf("建触发器: %v", err)
	}

	_, err := db.Exec(post[0].sql)
	if err == nil {
		t.Fatal("改写没有生效（public 仍在）时自检必须 RAISE EXCEPTION —— 现在整条迁移静默通过了")
	}
	if !strings.Contains(err.Error(), "0074") {
		t.Fatalf("自检失败必须点名 0074: %v", err)
	}
	// 前置现场成立：改写确实被挡下了（行还是 public）。
	if got := readAppConfigJSONOfKind(t, db, "wasm_app", "legacy-public"); got != `{"access":"public"}` {
		t.Fatalf("夹具失效：改写被触发器挡住后行应仍是 public，得到 %q", got)
	}
}

// ---- 0074 用例的小工具 ----

// insertWasmConfig 插入一行"升级前"的应用（默认列集足够，不再引用 0071 已删的 visible）。
func insertWasmConfig(t *testing.T, db *sql.DB, kind, appID, configJSON string) {
	t.Helper()
	channel := "wasm"
	if kind != "wasm_app" {
		channel = "market"
	}
	if _, err := db.Exec(`INSERT INTO apps
		(kind, app_id, title, description, owner, channel, enabled, purpose, data_sensitivity, config_json)
		VALUES (?, ?, ?, '', 'alice', ?, 1, '', '', ?)`,
		kind, appID, "旧标题 "+appID, channel, configJSON); err != nil {
		t.Fatalf("插入存量应用 %s/%s: %v", kind, appID, err)
	}
}

// insertWasmReleaseConfig 插入一行"升级前"的版本快照。
func insertWasmReleaseConfig(t *testing.T, db *sql.DB, kind, appID, version, configJSON string) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO app_releases (kind, app_id, version, title, status, config_json)
		VALUES (?, ?, ?, ?, 'approved', ?)`, kind, appID, version, "旧标题 "+appID, configJSON); err != nil {
		t.Fatalf("插入存量版本行 %s/%s/%s: %v", kind, appID, version, err)
	}
}
