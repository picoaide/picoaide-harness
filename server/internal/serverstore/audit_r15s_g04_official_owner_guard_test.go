package serverstore

// R15C-G-04 回归判据：`official = 1 ⇒ owner = ”` 这条不变量必须在**每一个** App
// 身份写入口成立 —— 两个孪生 upsert（技能/智能体面的 `UpsertApp` 与 wasm 面的
// `UpsertWasmApp`）行为必须逐字等价。
//
// 缺陷形态（第 15 轮审计子泳道 G，P2）：`UpsertWasmApp` 在 R3-A A-9 加了
// `owner = CASE WHEN apps.official = 1 THEN '' ELSE … END` 守卫，而 `UpsertApp`
// 没有 ⇒ DAO 层可以造出 `SetAppOfficial` 显式拒绝的禁止状态
// （official=1 ∧ owner="alice"）：聚合面随后把官方内容当"某个人的应用"展示
// （is_owner 为真），而该人发版仍被 OFFLICIAL_LOCKED 拒。
//
// 判据与 A-9 同一条纪律：**不变量必须在唯一写入口成立，与调用点无关**
// （调用点今天恰好传了现值不构成防线）—— 所以判据打在 DAO 上，不依赖任何路由。
//
// 变异验证（把 apps.go 的 `upsertApp` 换回 HEAD 版 ⇒ 本用例必红：
// 技能/智能体两个分支都造出 official=1 ∧ owner="alice"）。

import (
	"context"
	"testing"
)

func TestR15SG04OfficialOwnerInvariantHoldsOnEveryUpsert(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	ctx := context.Background()

	read := func(kind, appID string) (string, int) {
		t.Helper()
		var owner string
		var official int
		if err := db.QueryRow(`SELECT owner, official FROM apps WHERE kind = ? AND app_id = ?`,
			kind, appID).Scan(&owner, &official); err != nil {
			t.Fatalf("读 %s/%s: %v", kind, appID, err)
		}
		return owner, official
	}

	cases := []struct {
		name string
		kind string
		app  string
		// seed 造一条官方行（owner=''、official=1）。
		seed func(t *testing.T, appID string)
		// claim 是"带非空 owner 的 upsert 命中官方行"那一击。
		claim func(t *testing.T, appID string)
	}{
		{
			name: "UpsertApp(智能体面)",
			kind: AppKindAgent,
			app:  "r15s-official-agent",
			seed: func(t *testing.T, appID string) {
				if err := UpsertApp(db, &App{
					Kind: AppKindAgent, AppID: appID, Title: "官方内容",
					Owner: "", Channel: AppChannelMarket, Enabled: 1,
				}); err != nil {
					t.Fatalf("UpsertApp(seed): %v", err)
				}
			},
			claim: func(t *testing.T, appID string) {
				if err := UpsertApp(db, &App{
					Kind: AppKindAgent, AppID: appID, Title: "官方智能体",
					Owner: "alice", Channel: AppChannelMarket, Enabled: 1,
				}); err != nil {
					t.Fatalf("UpsertApp(带 owner): %v", err)
				}
			},
		},
		{
			name: "UpsertApp(技能面)",
			kind: AppKindSkill,
			app:  "r15s-official-skill",
			seed: func(t *testing.T, appID string) {
				if err := UpsertApp(db, &App{
					Kind: AppKindSkill, AppID: appID, Title: "官方内容",
					Owner: "", Channel: AppChannelMarket, Enabled: 1,
				}); err != nil {
					t.Fatalf("UpsertApp(seed): %v", err)
				}
			},
			claim: func(t *testing.T, appID string) {
				if err := UpsertApp(db, &App{
					Kind: AppKindSkill, AppID: appID, Title: "官方技能",
					Owner: "alice", Channel: AppChannelMarket, Enabled: 1,
				}); err != nil {
					t.Fatalf("UpsertApp(带 owner): %v", err)
				}
			},
		},
		{
			name: "UpsertWasmApp(wasm 面，A-9 已有守卫)",
			kind: AppKindWasmApp,
			app:  "r15s-official-wasm",
			seed: func(t *testing.T, appID string) {
				if err := UpsertWasmApp(ctx, db, WasmApp{
					AppID: appID, Title: "官方内容", Owner: "",
					Channel: AppChannelWasm, Enabled: true,
				}); err != nil {
					t.Fatalf("UpsertWasmApp(seed): %v", err)
				}
			},
			claim: func(t *testing.T, appID string) {
				if err := UpsertWasmApp(ctx, db, WasmApp{
					AppID: appID, Title: "官方应用", Owner: "alice",
					Channel: AppChannelWasm, Enabled: true,
				}); err != nil {
					t.Fatalf("UpsertWasmApp(带 owner): %v", err)
				}
			},
		},
	}

	outcomes := make([][2]any, 0, len(cases))
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			c.seed(t, c.app)
			if err := SetAppOfficial(db, c.kind, c.app, true, ""); err != nil {
				t.Fatalf("SetAppOfficial: %v", err)
			}
			if owner, official := read(c.kind, c.app); owner != "" || official != 1 {
				t.Fatalf("夹具失效：期望 official=1/owner=''，实际 official=%d/owner=%q", official, owner)
			}
			c.claim(t, c.app)
			owner, official := read(c.kind, c.app)
			t.Logf("%s 之后：official=%d owner=%q", c.name, official, owner)
			if official == 1 && owner != "" {
				t.Errorf("禁止状态：%s 造出了 official=1 ∧ owner=%q（SetAppOfficial 显式拒绝该状态）",
					c.name, owner)
			}
			outcomes = append(outcomes, [2]any{owner, official})
		})
	}
	// 跨入口等价：三个 kind 的终态必须一模一样（这才是"不变量"）。
	for i := 1; i < len(outcomes); i++ {
		if outcomes[i] != outcomes[0] {
			t.Errorf("同一条不变量在不同 upsert 上结论不同：%s=%v 而 %s=%v",
				cases[0].name, outcomes[0], cases[i].name, outcomes[i])
		}
	}
}

// TestR15SG04OwnerFirstClaimStillWorks 是反向判据：守卫只对**官方行**生效，
// 普通行的"首个成功发布者占名，且不可被后续发布改写"语义一字不动 ——
// 少了它，把 owner 一律写成空串也能让上一条变绿。
func TestR15SG04OwnerFirstClaimStillWorks(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	if err := UpsertApp(db, &App{
		Kind: AppKindSkill, AppID: "r15s-claim", Title: "T", Owner: "alice",
		Channel: AppChannelOrg, Enabled: 1,
	}); err != nil {
		t.Fatalf("UpsertApp(首次): %v", err)
	}
	// 后续发布（bob）不得改写归属。
	if err := UpsertApp(db, &App{
		Kind: AppKindSkill, AppID: "r15s-claim", Title: "T2", Owner: "bob",
		Channel: AppChannelOrg, Enabled: 1,
	}); err != nil {
		t.Fatalf("UpsertApp(第二次): %v", err)
	}
	var owner, title string
	if err := db.QueryRow(`SELECT owner, title FROM apps WHERE kind = ? AND app_id = ?`,
		AppKindSkill, "r15s-claim").Scan(&owner, &title); err != nil {
		t.Fatalf("读行: %v", err)
	}
	if owner != "alice" {
		t.Errorf("归属被后续发布改写：owner=%q，期望 \"alice\"（首占者）", owner)
	}
	if title != "T2" {
		t.Errorf("标题应随 upsert 更新：title=%q", title)
	}
	// 空 owner 的历史行可被首次占名。
	if err := UpsertApp(db, &App{
		Kind: AppKindSkill, AppID: "r15s-claim-empty", Title: "T", Owner: "",
		Channel: AppChannelOrg, Enabled: 1,
	}); err != nil {
		t.Fatalf("UpsertApp(空 owner 首次): %v", err)
	}
	if err := UpsertApp(db, &App{
		Kind: AppKindSkill, AppID: "r15s-claim-empty", Title: "T", Owner: "bob",
		Channel: AppChannelOrg, Enabled: 1,
	}); err != nil {
		t.Fatalf("UpsertApp(空 owner 行被认领): %v", err)
	}
	var o2 string
	if err := db.QueryRow(`SELECT owner FROM apps WHERE kind = ? AND app_id = ?`,
		AppKindSkill, "r15s-claim-empty").Scan(&o2); err != nil {
		t.Fatalf("读行: %v", err)
	}
	if o2 != "bob" {
		t.Errorf("空归属的历史行应可被首占：owner=%q", o2)
	}
}
