package serverstore

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// ---- WASM 应用平台 DAO 测试(迁移 0069 / wasmapps.go / audit.go 的链版本化)----
//
// 变异验证(改回危险实现时哪条用例必红):
//   - 哈希链版本化取消(校验恒按 v1 算)      → TestAuditChainVersioningLegacyAndAppRows 红(app_id 篡改检不出)
//   - GetWasmAppByHost 去掉 kind/deleted 过滤 → TestWasmAppHostLookupIsKindScoped 红
//   - PruneWasmReleases 去掉 current_release 保护 / 去掉 status='approved' → 对应用例红
//   - UpsertWasmApp 的 owner 改成 excluded.owner → TestWasmAppOwnerFirstClaim 红
//   - 0069 少放开一个 CHECK                   → TestMigration0069ReleasesChecks 红(插入即约束冲突)

func newWasmApp(t *testing.T, db *sql.DB, appID, owner string) {
	t.Helper()
	if err := UpsertWasmApp(context.Background(), db, WasmApp{
		AppID: appID, Title: appID + " 标题", Owner: owner, Enabled: true,
	}); err != nil {
		t.Fatalf("UpsertWasmApp(%s): %v", appID, err)
	}
}

// TestMigration0069ReleasesChecks 证明 0069 真的放开了 kind/channel,并且可重放。
func TestMigration0069ReleasesChecks(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()

	var m69 *migration
	for _, m := range migrationsFor() {
		if m.version == 69 {
			mm := m
			m69 = &mm
		}
	}
	if m69 == nil {
		t.Fatal("找不到 0069 迁移")
	}
	// 幂等重放两次:任一语句不幂等(重复 ADD COLUMN / CREATE INDEX)会在这里报错。
	for i := 0; i < 2; i++ {
		if _, err := db.Exec(m69.sql); err != nil {
			t.Fatalf("重放 0069(第 %d 次): %v", i+1, err)
		}
	}

	// 放开后的两个取值都要真的能落库。
	if err := UpsertWasmApp(ctx, db, WasmApp{AppID: "probe-app", Owner: "alice", Enabled: true}); err != nil {
		t.Fatalf("wasm_app 行插入失败(CHECK 未放开?): %v", err)
	}
	var channel string
	if err := db.QueryRow(`SELECT channel FROM apps WHERE kind = $1 AND app_id = $2`,
		AppKindWasmApp, "probe-app").Scan(&channel); err != nil {
		t.Fatal(err)
	}
	if channel != AppChannelWasm {
		t.Fatalf("wasm 应用渠道 = %q, want %q", channel, AppChannelWasm)
	}
	// CHECK 仍然生效(bogus kind 必须被拒):证明约束是被"放开"而不是被删掉。
	if _, err := db.Exec(`INSERT INTO apps (kind, app_id, channel) VALUES ('bogus', 'x', 'wasm')`); err == nil {
		t.Fatal("apps.kind CHECK 被删掉了:bogus kind 竟然插入成功")
	}
	if _, err := db.Exec(`INSERT INTO apps (kind, app_id, channel) VALUES ('skill', 'x', 'bogus')`); err == nil {
		t.Fatal("apps.channel CHECK 被删掉了:bogus channel 竟然插入成功")
	}
	// 调用事件表与审计新列就位。
	if _, err := db.Exec(`INSERT INTO wasm_call_events (app_id, user_id, outcome) VALUES ('probe-app', 1, 'ok')`); err != nil {
		t.Fatalf("wasm_call_events 不可写: %v", err)
	}
}

// TestWasmAppOwnerFirstClaim 归属首占不可改写(复用 0053 的 owner 语义,§8)。
func TestWasmAppOwnerFirstClaim(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()
	newWasmApp(t, db, "expense-note", "alice")

	// 第二个发布者发布同名应用:owner 必须仍是 alice(否则谁都能"重新发布"接管)。
	if err := UpsertWasmApp(ctx, db, WasmApp{
		AppID: "expense-note", Title: "改过的标题", Owner: "bob", Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	app, err := GetWasmApp(ctx, db, "expense-note")
	if err != nil {
		t.Fatal(err)
	}
	if app.Owner != "alice" {
		t.Fatalf("owner = %q, want alice(首占不可改写)", app.Owner)
	}
	if app.Title != "改过的标题" {
		t.Fatalf("title = %q, want 改过的标题(展示元数据仍应更新)", app.Title)
	}
	// 归属转移是显式动作。
	if err := TransferWasmAppOwner(ctx, db, "expense-note", "carol"); err != nil {
		t.Fatal(err)
	}
	if app, _ = GetWasmApp(ctx, db, "expense-note"); app.Owner != "carol" {
		t.Fatalf("转移后 owner = %q", app.Owner)
	}
	if err := TransferWasmAppOwner(ctx, db, "expense-note", ""); err == nil {
		t.Fatal("空归属必须被拒(归属悬空 = 无人能接手)")
	}
}

// TestUpsertWasmAppDoesNotClobberSideFields 一次只带标题的 upsert 不得抹掉
// 配置/上下架/生效版本(它们各有唯一写入口,否则"重新发布"会静默改变线上行为)。
func TestUpsertWasmAppDoesNotClobberSideFields(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()
	newWasmApp(t, db, "app-a", "alice")
	if err := SetWasmAppConfig(ctx, db, "app-a", `{"visible":false}`, "报销", "internal"); err != nil {
		t.Fatal(err)
	}
	if err := SetWasmAppEnabled(ctx, db, "app-a", false); err != nil {
		t.Fatal(err)
	}
	rel, err := CreateWasmRelease(ctx, db, WasmRelease{
		AppID: "app-a", Version: "1.0.0", Publisher: "alice", Wasm: []byte("x"),
		Status: ReleaseStatusApproved,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := SetWasmAppCurrentRelease(ctx, db, "app-a", rel); err != nil {
		t.Fatal(err)
	}

	// 再次 upsert(典型场景:发布新版本时确认应用身份)。
	if err := UpsertWasmApp(ctx, db, WasmApp{AppID: "app-a", Title: "新标题", Owner: "alice"}); err != nil {
		t.Fatal(err)
	}
	app, err := GetWasmApp(ctx, db, "app-a")
	if err != nil {
		t.Fatal(err)
	}
	if app.Title != "新标题" {
		t.Fatalf("title = %q, want 新标题", app.Title)
	}
	if app.Purpose != "报销" || app.DataSensitivity != "internal" {
		t.Fatalf("配置被 upsert 抹掉: purpose=%q sensitivity=%q", app.Purpose, app.DataSensitivity)
	}
	if app.Enabled {
		t.Fatal("上下架状态被 upsert 改写(下架的应用被静默重新上架)")
	}
	if app.CurrentReleaseID != rel {
		t.Fatalf("生效版本被 upsert 改写: %d, want %d", app.CurrentReleaseID, rel)
	}
}

// TestFailedPublishDoesNotOccupyVersion §10.5 第 59 项:失败发布不落行 ⇒
// 同一个版本号可以重发;只有**落了行**的版本才永久占号(两条规则不得互相推导)。
func TestFailedPublishDoesNotOccupyVersion(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()

	// 应用还不存在 ⇒ 发布失败(不落行)。
	if _, err := CreateWasmRelease(ctx, db, WasmRelease{
		AppID: "later-app", Version: "1.0.0", Publisher: "alice", Wasm: []byte("x"),
	}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("应用不存在时的发布 err = %v, want ErrNotFound", err)
	}
	newWasmApp(t, db, "later-app", "alice")
	// 同一个版本号重发必须成功(失败没占号)。
	if _, err := CreateWasmRelease(ctx, db, WasmRelease{
		AppID: "later-app", Version: "1.0.0", Publisher: "alice", Wasm: []byte("x"),
	}); err != nil {
		t.Fatalf("失败发布占用了版本号: %v", err)
	}
}

// TestWasmAppIDCaseInsensitive 域名不区分大小写 ⇒ 入库与反查统一小写。
func TestWasmAppIDCaseInsensitive(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()
	newWasmApp(t, db, "My-App", "alice")

	app, err := GetWasmApp(ctx, db, "MY-APP")
	if err != nil {
		t.Fatalf("大写查询应命中: %v", err)
	}
	if app.AppID != "my-app" {
		t.Fatalf("入库 app_id = %q, want my-app(统一小写)", app.AppID)
	}
	// 大小写不同不会产生第二个应用(同 kind 主键)。
	list, err := ListWasmApps(ctx, db, WasmAppFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("应用数 = %d, want 1(大小写不得产生第二个身份)", len(list))
	}
}

// TestWasmAppHostLookupIsKindScoped §4.8:主机名反查只认 wasm_app、不认软删,
// 查不到返回可识别的 not-found(调用方据此 404,绝不回落主站)。
func TestWasmAppHostLookupIsKindScoped(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()

	newWasmApp(t, db, "my-app", "alice")
	// 同名技能行(PK 是 (kind, app_id),两者可共存):绝不能被当成应用命中。
	if err := UpsertApp(db, &App{Kind: AppKindSkill, AppID: "my-app", Channel: AppChannelOrg, Enabled: 1}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertApp(db, &App{Kind: AppKindAgent, AppID: "only-skill", Channel: AppChannelOrg, Enabled: 1}); err != nil {
		t.Fatal(err)
	}

	for _, host := range []string{"my-app", "MY-APP", "my-app.example.com", "my-app.example.com:8443", "my-app.example.com."} {
		app, err := GetWasmAppByHost(ctx, db, host)
		if err != nil {
			t.Fatalf("host %q 反查失败: %v", host, err)
		}
		if app.AppID != "my-app" {
			t.Fatalf("host %q → app_id %q", host, app.AppID)
		}
	}
	// kind 作用域:只有技能行的名字必须查不到(否则技能名字会变成可路由的域名)。
	if _, err := GetWasmAppByHost(ctx, db, "only-skill"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("技能名反查 err = %v, want ErrNotFound", err)
	}
	if _, err := GetWasmAppByHost(ctx, db, "never-registered"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("未登记主机 err = %v, want ErrNotFound", err)
	}
	// 退役(软删)后立即停止路由。
	if err := SoftDeleteWasmApp(ctx, db, "my-app"); err != nil {
		t.Fatal(err)
	}
	if _, err := GetWasmAppByHost(ctx, db, "my-app"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("软删应用仍可反查 err = %v, want ErrNotFound", err)
	}
	// 软删行本身仍可读(R37:冻结/退役后 90 天内还要能导出)。
	app, err := GetWasmApp(ctx, db, "my-app")
	if err != nil || app.DeletedAt == nil {
		t.Fatalf("软删行应可读且带 DeletedAt: app=%+v err=%v", app, err)
	}
}

// TestWasmReleaseVersionUniqueAndOccupied 版本号唯一、且被拒/软删后仍占号(§4.1)。
func TestWasmReleaseVersionUniqueAndOccupied(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()
	newWasmApp(t, db, "expense-note", "alice")

	id, err := CreateWasmRelease(ctx, db, WasmRelease{
		AppID: "expense-note", Version: "1.0.0", Publisher: "alice",
		Wasm: []byte("wasm-v1"), Checksum: "sum1", Status: ReleaseStatusApproved,
	})
	if err != nil {
		t.Fatal(err)
	}
	// 唯一冲突必须是可识别的 ErrDuplicate,而不是裸驱动错误。
	if _, err := CreateWasmRelease(ctx, db, WasmRelease{
		AppID: "expense-note", Version: "1.0.0", Publisher: "alice", Wasm: []byte("x"),
	}); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("重复版本 err = %v, want ErrDuplicate", err)
	}
	// 制品字节随 GetWasmRelease 读回(复用 archive 列)。在**软删之前**读:
	// 软删会释放字节(R15C-G-03,2026-09-25),见本用例末尾那一段。
	rel, err := GetWasmRelease(ctx, db, "expense-note", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if string(rel.Wasm) != "wasm-v1" || rel.Size != int64(len("wasm-v1")) {
		t.Fatalf("制品读回 wasm=%q size=%d", rel.Wasm, rel.Size)
	}
	// 软删后版本号仍然占位(防止"删了再发"覆盖外部契约)。
	if err := SoftDeleteWasmRelease(ctx, db, id); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateWasmRelease(ctx, db, WasmRelease{
		AppID: "expense-note", Version: "1.0.0", Publisher: "alice", Wasm: []byte("y"),
	}); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("软删后复用版本号 err = %v, want ErrDuplicate", err)
	}
	// 应用不存在 ⇒ ErrNotFound(外键冲突被翻译),调用方可据此 404。
	if _, err := CreateWasmRelease(ctx, db, WasmRelease{
		AppID: "no-such-app", Version: "1.0.0", Publisher: "alice", Wasm: []byte("z"),
	}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("不存在的应用 err = %v, want ErrNotFound", err)
	}
	// includeDeleted 用于判重视图;默认清单不含软删行。
	live, err := ListWasmReleases(ctx, db, "expense-note", false)
	if err != nil || len(live) != 0 {
		t.Fatalf("默认清单 = %d 条 err=%v, want 0", len(live), err)
	}
	all, err := ListWasmReleases(ctx, db, "expense-note", true)
	if err != nil || len(all) != 1 {
		t.Fatalf("含软删清单 = %d 条 err=%v, want 1", len(all), err)
	}
	// 软删之后:版本号仍占位、行还在(上面两段),但**制品字节随即释放**
	// (R15C-G-03,2026-09-25)。语义 = 与"审核拒绝即释放归档"(N-4)同一口径:
	// 版本一旦对所有人不可见、且没有任何 restore 路径(全仓没有把 deleted_at
	// 置回 NULL 的写入),字节就是纯死重;而配额闸门把这种不可达字节算进去会造成
	// "发布失败 ⇒ 永久吃配额 ⇒ 再也发不出任何东西"的自锁。
	//
	// ⚠️ 本条原先在此处断言"软删后仍能读回字节"——那是平台的初版形态(提交
	// a24be47933),与本轮刻意改变的语义冲突,故拆成"活版本读回字节"(上面)
	// + "软删即释放"(这里)两段。
	released, err := GetWasmRelease(ctx, db, "expense-note", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if len(released.Wasm) != 0 || released.Size != 0 {
		t.Fatalf("软删应释放制品字节:wasm=%d 字节 size=%d", len(released.Wasm), released.Size)
	}
	if released.DeletedAt == nil {
		t.Fatalf("软删之后 DeletedAt 必须非空(判重视图与审计靠它)")
	}
}

// TestPruneWasmReleasesKeepsThreeMostRecent 版本 GC:保留最近 3 个曾生效版本,
// 且绝不回收当前生效版本;pending 版本不参与 GC。
func TestPruneWasmReleasesKeepsThreeMostRecent(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()
	newWasmApp(t, db, "expense-note", "alice")

	ids := map[string]int64{}
	for _, v := range []string{"1.0.0", "2.0.0", "3.0.0", "4.0.0", "5.0.0"} {
		id, err := CreateWasmRelease(ctx, db, WasmRelease{
			AppID: "expense-note", Version: v, Publisher: "alice",
			Wasm: []byte("wasm-" + v), Status: ReleaseStatusApproved,
		})
		if err != nil {
			t.Fatal(err)
		}
		ids[v] = id
	}
	// 待审版本:GC 不得回收(它还在等审核,回收等于把待审包删了)。
	if _, err := CreateWasmRelease(ctx, db, WasmRelease{
		AppID: "expense-note", Version: "6.0.0", Publisher: "alice",
		Wasm: []byte("wasm-6.0.0"), Status: ReleaseStatusPending,
	}); err != nil {
		t.Fatal(err)
	}
	// 当前生效版本故意指向旧版(回滚场景):GC 必须保护它。
	if err := SetWasmAppCurrentRelease(ctx, db, "expense-note", ids["2.0.0"]); err != nil {
		t.Fatal(err)
	}

	pruned, err := PruneWasmReleases(ctx, db, "expense-note", limits.RetainedVersions)
	if err != nil {
		t.Fatal(err)
	}
	if len(pruned) != 1 || pruned[0] != ids["1.0.0"] {
		t.Fatalf("被回收的版本 = %v, want [%d](只该回收 1.0.0)", pruned, ids["1.0.0"])
	}
	// 被回收版本:软删 + 字节释放 + size 归零(不变量 size == 字节长度)。
	var size int64
	var archiveLen sql.NullInt64
	var deleted sql.NullTime
	if err := db.QueryRow(`SELECT size, octet_length(archive), deleted_at FROM app_releases WHERE id = $1`,
		ids["1.0.0"]).Scan(&size, &archiveLen, &deleted); err != nil {
		t.Fatal(err)
	}
	if !deleted.Valid || size != 0 || archiveLen.Valid {
		t.Fatalf("回收后 deleted=%v size=%d archive_len=%v, want 已软删/size=0/archive NULL",
			deleted.Valid, size, archiveLen)
	}
	// 保留的版本字节还在;当前生效版本(2.0.0)必须活着。
	for _, v := range []string{"2.0.0", "3.0.0", "4.0.0", "5.0.0"} {
		rel, err := GetWasmRelease(ctx, db, "expense-note", v)
		if err != nil {
			t.Fatalf("保留版本 %s 读不到: %v", v, err)
		}
		if rel.DeletedAt != nil || len(rel.Wasm) == 0 {
			t.Fatalf("保留版本 %s 被回收: deleted=%v wasm=%d", v, rel.DeletedAt, len(rel.Wasm))
		}
	}
	if rel, err := GetWasmRelease(ctx, db, "expense-note", "6.0.0"); err != nil || rel.DeletedAt != nil {
		t.Fatalf("pending 版本被 GC 动了: %+v err=%v", rel, err)
	}
	// 幂等:再跑一次没有可回收的行。
	again, err := PruneWasmReleases(ctx, db, "expense-note", limits.RetainedVersions)
	if err != nil {
		t.Fatal(err)
	}
	if len(again) != 0 {
		t.Fatalf("重复 GC 回收了 %v, want 空", again)
	}
	// keep <= 0 必须报错(传错就是"抹掉全部制品字节",不可逆)。
	if _, err := PruneWasmReleases(ctx, db, "expense-note", 0); err == nil {
		t.Fatal("keep=0 必须被拒")
	}
	if _, err := PruneWasmReleases(ctx, db, "expense-note", -1); err == nil {
		t.Fatal("keep<0 必须被拒")
	}
}

// TestCountUserArtifactBytes 制品总量按发布者统计(PG BYTEA 口径,§5.3)。
func TestCountUserArtifactBytes(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()
	newWasmApp(t, db, "app-a", "alice")
	newWasmApp(t, db, "app-b", "alice")
	newWasmApp(t, db, "app-c", "bob")

	mk := func(app, owner, version, blob string) int64 {
		t.Helper()
		id, err := CreateWasmRelease(ctx, db, WasmRelease{
			AppID: app, Version: version, Publisher: owner,
			Wasm: []byte(blob), Status: ReleaseStatusApproved,
		})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	mk("app-a", "alice", "1.0.0", "aaaa")
	mk("app-a", "alice", "2.0.0", "bb")
	old := mk("app-a", "alice", "0.0.1", "cccccc")
	mk("app-c", "bob", "1.0.0", "dddddddd")

	n, err := CountUserArtifactBytes(ctx, db, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if n != 4+2+6 {
		t.Fatalf("alice 制品总量 = %d, want 12", n)
	}
	if n, _ = CountUserArtifactBytes(ctx, db, "bob"); n != 8 {
		t.Fatalf("bob 制品总量 = %d, want 8(不得串号)", n)
	}
	// GC 后配额立即释放(字节被置空)。
	if _, err := db.Exec(`UPDATE app_releases SET deleted_at = now(), archive = NULL, size = 0 WHERE id = $1`, old); err != nil {
		t.Fatal(err)
	}
	if n, _ = CountUserArtifactBytes(ctx, db, "alice"); n != 6 {
		t.Fatalf("GC 后 alice 制品总量 = %d, want 6", n)
	}
}

// TestWasmAppConfigProjectionAndFilters 配置投影 + 列表过滤 + 生命周期动作。
//
// ⚠️ 2026-09-18 收敛为 access 三模式后：**可见性投影列（apps.visible）已删**，
// 访问模式要从 config_json 现解（appcfg.AccessOfConfigJSON，见 api 侧用例）；
// 本用例守的是"投影列只有 config_json/purpose/data_sensitivity、非法 JSON 拒写"。
func TestWasmAppConfigProjectionAndFilters(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()
	newWasmApp(t, db, "app-visible", "alice")
	newWasmApp(t, db, "app-hidden", "alice")
	newWasmApp(t, db, "app-bob", "bob")

	// 投影：config_json / purpose / data_sensitivity 一次写入（旧 schema 的 JSON 也照存，
	// 解析与访问模式的映射由 appcfg 负责，DAO 不做业务解释）。
	if err := SetWasmAppConfig(ctx, db, "APP-HIDDEN", `{"access":"whitelist","whitelist":["alice"],"purpose":"报销"}`, "报销", "internal"); err != nil {
		t.Fatal(err)
	}
	app, _ := GetWasmApp(ctx, db, "app-hidden")
	if app.Purpose != "报销" || app.DataSensitivity != "internal" || app.ConfigJSON == "" {
		t.Fatalf("配置未落库: %+v", app)
	}
	// 旧 schema 一样能落库（迁移窗口期里两种形态并存）。
	if err := SetWasmAppConfig(ctx, db, "app-hidden", `{"login_required":true,"whitelist":["alice"]}`, "报销", "internal"); err != nil {
		t.Fatal(err)
	}
	if app, _ = GetWasmApp(ctx, db, "app-hidden"); app.ConfigJSON == "" {
		t.Fatal("旧 schema 的 config_json 也应落库（读取侧由 appcfg 的兼容 shim 映射）")
	}
	// 非法 JSON 拒写(存进去要投影与展示,落库前失败好过之后静默漂移)。
	if err := SetWasmAppConfig(ctx, db, "app-visible", "{not json", "x", "y"); err == nil {
		t.Fatal("非法配置 JSON 必须被拒")
	}
	if app, _ = GetWasmApp(ctx, db, "app-visible"); app.ConfigJSON != "" {
		t.Fatal("被拒的配置不得落库")
	}

	mine, err := ListWasmApps(ctx, db, WasmAppFilter{Owner: "alice"})
	if err != nil || len(mine) != 2 {
		t.Fatalf("按 owner 过滤 = %d 条 err=%v, want 2", len(mine), err)
	}
	// 零值过滤 = 全部未删除（**没有**可见性维度：目录不看这一列）。
	if all, err := ListWasmApps(ctx, db, WasmAppFilter{}); err != nil || len(all) != 3 {
		t.Fatalf("零值过滤 = %d 条 err=%v, want 3（目录不过滤访问级别）", len(all), err)
	}

	// 上下架 + 过滤。
	if err := SetWasmAppEnabled(ctx, db, "app-bob", false); err != nil {
		t.Fatal(err)
	}
	no := false
	off, err := ListWasmApps(ctx, db, WasmAppFilter{Enabled: &no})
	if err != nil || len(off) != 1 || off[0].AppID != "app-bob" {
		t.Fatalf("按 enabled=false 过滤 = %+v err=%v", off, err)
	}
	// 冻结/解冻。
	at := time.Now().UTC().Truncate(time.Second)
	if err := FreezeWasmApp(ctx, db, "app-visible", at); err != nil {
		t.Fatal(err)
	}
	if app, _ = GetWasmApp(ctx, db, "app-visible"); app.FrozenAt == nil || !app.FrozenAt.Equal(at) {
		t.Fatalf("冻结时刻 = %v, want %v", app.FrozenAt, at)
	}
	if err := FreezeWasmApp(ctx, db, "app-visible", time.Time{}); err != nil {
		t.Fatal(err)
	}
	if app, _ = GetWasmApp(ctx, db, "app-visible"); app.FrozenAt != nil {
		t.Fatal("零值应解冻(frozen_at 置 NULL)")
	}
	// 软删:默认清单不再包含,IncludeDeleted 才看得到。
	if err := SoftDeleteWasmApp(ctx, db, "app-bob"); err != nil {
		t.Fatal(err)
	}
	if list, _ := ListWasmApps(ctx, db, WasmAppFilter{}); len(list) != 2 {
		t.Fatalf("默认清单 = %d 条, want 2(不含软删)", len(list))
	}
	if list, _ := ListWasmApps(ctx, db, WasmAppFilter{IncludeDeleted: true}); len(list) != 3 {
		t.Fatalf("含软删清单 = %d 条, want 3", len(list))
	}
	// 已软删的应用不能再被上下架/转移/冻结(ErrNotFound)。
	if err := SetWasmAppEnabled(ctx, db, "app-bob", true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("软删后上下架 err = %v, want ErrNotFound", err)
	}
	if err := SoftDeleteWasmApp(ctx, db, "app-bob"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("重复软删 err = %v, want ErrNotFound", err)
	}
	if err := SetWasmAppEnabled(ctx, db, "no-such-app", true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("不存在的应用 err = %v, want ErrNotFound", err)
	}
}

// TestSetWasmAppCurrentReleaseOwnershipCheck 生效版本必须属于本应用(否则一次
// 写错的 id 会让应用子域交付别人的内容)。
func TestSetWasmAppCurrentReleaseOwnershipCheck(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()
	newWasmApp(t, db, "app-a", "alice")
	newWasmApp(t, db, "app-b", "alice")

	mine, err := CreateWasmRelease(ctx, db, WasmRelease{
		AppID: "app-a", Version: "1.0.0", Publisher: "alice",
		Wasm: []byte("a1"), Status: ReleaseStatusApproved,
	})
	if err != nil {
		t.Fatal(err)
	}
	other, err := CreateWasmRelease(ctx, db, WasmRelease{
		AppID: "app-b", Version: "1.0.0", Publisher: "alice",
		Wasm: []byte("b1"), Status: ReleaseStatusApproved,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := SetWasmAppCurrentRelease(ctx, db, "app-a", mine); err != nil {
		t.Fatal(err)
	}
	if err := SetWasmAppCurrentRelease(ctx, db, "app-a", other); !errors.Is(err, ErrNotFound) {
		t.Fatalf("跨应用生效版本 err = %v, want ErrNotFound", err)
	}
	if err := SetWasmAppCurrentRelease(ctx, db, "app-a", 0); err == nil {
		t.Fatal("release id=0 必须被拒")
	}
	// LatestApprovedWasmReleaseFull 取最新 approved（含制品字节）。
	if rel, err := LatestApprovedWasmReleaseFull(ctx, db, "app-a"); err != nil || rel.ID != mine {
		t.Fatalf("latest approved = %+v err=%v", rel, err)
	}
	if _, err := LatestApprovedWasmReleaseFull(ctx, db, "no-such-app"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("无版本应用 err = %v, want ErrNotFound", err)
	}
}

// ---- 哈希链版本化:本任务最易错的一点 ----

// TestAuditChainVersioningLegacyAndAppRows 是 0069 的**核心证据用例**:
//
//	① 旧库(未加 app_id/hash_version 列)按 0048 口径写入的行,
//	   加列之后链仍然校验通过;
//	② 新代码写入的带 app_id 的行(v2 口径)同样校验通过,且与旧行同链共存;
//	③ 篡改新行的 app_id 必须被链校验发现(证明 app_id 真的进了链输入);
//	④ 篡改旧行的 detail 仍会被发现(证明旧行是被"校验"而不是被"跳过")。
func TestAuditChainVersioningLegacyAndAppRows(t *testing.T) {
	all := migrationsFor()
	var pre, post []migration
	for _, m := range all {
		if m.version <= 68 {
			pre = append(pre, m)
		}
		if m.version == 69 {
			post = append(post, m)
		}
	}
	if len(post) == 0 {
		t.Fatal("找不到 0069 迁移")
	}
	// 先造一个"0069 之前"的库(与 migration_0062_test.go 同一手法)。
	testMigrationHook = func() []migration { return pre }
	t.Cleanup(func() { testMigrationHook = nil })
	db, cleanup := newTestDB(t)
	defer cleanup()

	// --- 1) 用旧口径(0048:不含 app_id)写入两行,完全模拟升级前的历史数据 ---
	var legacyHash string
	prev := ""
	for i, detail := range []string{"alice", "bob"} {
		now := time.Now().UTC().Format(time.RFC3339)
		sum := sha256.Sum256([]byte(auditHashPayload(prev, "legacy-admin", "user_create", detail, now)))
		hash := hex.EncodeToString(sum[:])
		if _, err := db.Exec(`INSERT INTO audit_logs (username, action, detail, prev_hash, hash, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`, "legacy-admin", "user_create", detail, prev, hash, now); err != nil {
			t.Fatalf("写历史审计行 %d: %v", i, err)
		}
		prev = hash
		legacyHash = hash
	}
	// 升级前必须确认列还不存在(否则这个用例证明不了"加列"这件事)。
	var exists bool
	if err := db.QueryRow(`SELECT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_name = 'audit_logs' AND column_name = 'app_id')`).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Fatal("前置条件失败:0069 之前不该有 audit_logs.app_id")
	}

	// --- 2) 应用 0069(加列 + 哈希链版本化) ---
	testMigrationHook = func() []migration { return post }
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("应用 0069: %v", err)
	}
	// 加列之后,加列之前写入的行仍必须整链校验通过。
	if id, err := VerifyAuditChain(db); err != nil || id != 0 {
		t.Fatalf("加列后旧行链校验失败: id=%d err=%v", id, err)
	}
	var version int16
	var appID sql.NullString
	if err := db.QueryRow(`SELECT hash_version, app_id FROM audit_logs ORDER BY id DESC LIMIT 1`).
		Scan(&version, &appID); err != nil {
		t.Fatal(err)
	}
	if version != 1 || appID.Valid {
		t.Fatalf("历史行 hash_version=%d app_id=%v, want 1/NULL(默认值必须回填成旧口径)", version, appID)
	}

	// --- 3) 新代码写入:一条带应用维度(v2)、一条不带(v1),与旧行同链 ---
	if err := AuditLogApp(db, "Expense-Note", "alice", "wasm_publish", "1.0.0"); err != nil {
		t.Fatal(err)
	}
	if err := AuditLog(db, "admin", "user_create", "carol"); err != nil {
		t.Fatal(err)
	}
	if err := AuditLogApp(db, "expense-note", "alice", "wasm_unpublish", "1.0.0"); err != nil {
		t.Fatal(err)
	}
	if id, err := VerifyAuditChain(db); err != nil || id != 0 {
		t.Fatalf("新旧混链校验失败: id=%d err=%v", id, err)
	}
	if err := db.QueryRow(`SELECT hash_version, app_id FROM audit_logs
		WHERE action = 'wasm_publish'`).Scan(&version, &appID); err != nil {
		t.Fatal(err)
	}
	if version != 2 || !appID.Valid || appID.String != "expense-note" {
		t.Fatalf("应用审计行 hash_version=%d app_id=%v, want 2/expense-note(入链统一小写)",
			version, appID)
	}
	// app 维度可查(只回应用行,且只有该应用的)。
	logs, err := ListAuditLogsByApp(db, "EXPENSE-NOTE", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) != 2 {
		t.Fatalf("按应用查审计 = %d 条, want 2", len(logs))
	}
	for _, l := range logs {
		if l.AppID != "expense-note" {
			t.Fatalf("越界条目: %+v", l)
		}
	}
	if _, err := ListAuditLogsByApp(db, "", 10); err == nil {
		t.Fatal("空 app_id 必须被拒(否则应用维度静默变成全局视图)")
	}
	// 列表接口把 app_id 透出(空值 = 非应用审计)。
	paged, _, err := ListAuditLogsPagedFiltered(db, 0, 50, "", "")
	if err != nil {
		t.Fatal(err)
	}
	var sawLegacy, sawApp bool
	for _, l := range paged {
		if l.Action == "user_create" && l.AppID == "" {
			sawLegacy = true
		}
		if l.Action == "wasm_unpublish" && l.AppID == "expense-note" {
			sawApp = true
		}
	}
	if !sawLegacy || !sawApp {
		t.Fatalf("审计列表 app_id 透传不完整(legacy=%v app=%v)", sawLegacy, sawApp)
	}

	// --- 4) 篡改 app_id → 必须被链校验发现(变异验证:若校验恒按 v1 算,这里会漏) ---
	if _, err := db.Exec(`UPDATE audit_logs SET app_id = 'evil-app' WHERE action = 'wasm_publish'`); err != nil {
		t.Fatal(err)
	}
	id, err := VerifyAuditChain(db)
	if err == nil || id == 0 {
		t.Fatalf("篡改 app_id 未被发现: id=%d err=%v", id, err)
	}
	// 复原后链恢复,再篡改**旧行**(v1 口径)的 detail:旧行同样是被校验的。
	if _, err := db.Exec(`UPDATE audit_logs SET app_id = 'expense-note' WHERE action = 'wasm_publish'`); err != nil {
		t.Fatal(err)
	}
	if id, err := VerifyAuditChain(db); err != nil || id != 0 {
		t.Fatalf("复原后链校验仍失败: id=%d err=%v", id, err)
	}
	if _, err := db.Exec(`UPDATE audit_logs SET detail = 'mallory' WHERE hash = $1`, legacyHash); err != nil {
		t.Fatal(err)
	}
	if id, err := VerifyAuditChain(db); err == nil || id == 0 {
		t.Fatalf("篡改旧行 detail 未被发现: id=%d err=%v", id, err)
	}
}
