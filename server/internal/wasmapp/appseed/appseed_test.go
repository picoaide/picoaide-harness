package appseed_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
	"github.com/picoaide/picoaide/internal/wasmapp/appseed"
)

// 本文件是「内置演示应用」的门禁：播种 = 装完即用；已存在/已删除 = **不重建**。
//
// 变异验证（交付时实跑过，勿删）：
//   - 把 Seed 里的 "存在即跳过" 判断去掉 ⇒ TestSeedIsIdempotentAndDeleteSticks 必红；
//   - 把 whitelist 的"补上归属人"去掉 ⇒ TestWhitelistDemoIncludesOwner 必红；
//   - 把 validateWasm 的魔数检查去掉 ⇒ TestRejectsNonWasm 必红。

// fakeWasm 构造一个"结构上像 wasm"的最小制品：魔数 + 版本 1 + 含 _start/memory 的名字串。
func fakeWasm() []byte {
	b := []byte{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00}
	return append(b, []byte("\x06_start\x06memory")...)
}

const demosJSON = `{"demos":[
  {"app_id":"demo-public","title":"公开演示","description":"匿名可达","access":"public","purpose":"演示","data_sensitivity":"公开"},
  {"app_id":"demo-login","title":"登录演示","description":"需登录","access":"login","purpose":"演示","data_sensitivity":"内部"},
  {"app_id":"demo-whitelist","title":"名单演示","description":"需名单","access":"whitelist","whitelist":["someone"],"purpose":"演示","data_sensitivity":"内部"}
]}`

func writeDemoDir(t *testing.T) string {
	t.Helper()
	return writeDemoDirWithManifest(t, demosJSON)
}

// writeDemoDirWithManifest 用给定清单造演示目录（W4-7 的用例要换一份清单重播）。
func writeDemoDirWithManifest(t *testing.T, manifest string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "app.wasm"), fakeWasm(), 0o644); err != nil {
		t.Fatalf("写 app.wasm: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, appseed.ManifestFileName), []byte(manifest), 0o644); err != nil {
		t.Fatalf("写清单: %v", err)
	}
	return dir
}

func newSeeder(t *testing.T, db *sql.DB, dir string) *appseed.Seeder {
	t.Helper()
	s, err := appseed.New(appseed.Options{
		DB:       db,
		DataRoot: t.TempDir(),
		Dir:      dir,
		Owner:    "admin",
	})
	if err != nil {
		t.Fatalf("appseed.New: %v", err)
	}
	if s == nil {
		t.Fatal("有清单时应返回播种器")
	}
	return s
}

func TestSeedCreatesThreeAccessModes(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	s := newSeeder(t, db, writeDemoDir(t))

	res, err := s.Seed(ctx)
	if err != nil {
		t.Fatalf("Seed: %v", err)
	}
	if len(res.Seeded) != 3 {
		t.Fatalf("应播种 3 个演示，得到 %v（跳过：%+v）", res.Seeded, res.Skipped)
	}

	want := map[string]appcfg.Access{
		"demo-public":    appcfg.AccessPublic,
		"demo-login":     appcfg.AccessLogin,
		"demo-whitelist": appcfg.AccessWhitelist,
	}
	for appID, access := range want {
		app, err := serverstore.GetWasmApp(ctx, db, appID)
		if err != nil {
			t.Fatalf("GetWasmApp(%s): %v", appID, err)
		}
		if !app.Enabled {
			t.Fatalf("%s 播种后应处于上架状态", appID)
		}
		if app.Owner != "admin" {
			t.Fatalf("%s 归属应为 admin，得到 %q", appID, app.Owner)
		}
		if got := appcfg.AccessOfConfigJSON(app.ConfigJSON); got != access {
			t.Fatalf("%s 的 access 应为 %s，得到 %s", appID, access, got)
		}
		if app.CurrentReleaseID == 0 {
			t.Fatalf("%s 应指向一个当前版本", appID)
		}
		rel, err := serverstore.LatestApprovedWasmReleaseFull(ctx, db, appID)
		if err != nil {
			t.Fatalf("LatestApprovedWasmReleaseFull(%s): %v", appID, err)
		}
		if rel.Status != serverstore.ReleaseStatusApproved {
			t.Fatalf("%s 的版本应为 approved，得到 %s", appID, rel.Status)
		}
		if len(rel.Wasm) == 0 {
			t.Fatalf("%s 的版本必须带制品字节（审核不变量 N-4）", appID)
		}
	}
}

// TestSeedWritesReleaseAssets：每个播种版本都必须有资源目录 + 应用配置
// （缺了应用子域管线直接 500 —— 这是本用例存在的唯一理由）。
func TestSeedWritesReleaseAssets(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	dataRoot := t.TempDir()
	dir := writeDemoDir(t)
	s, err := appseed.New(appseed.Options{DB: db, DataRoot: dataRoot, Dir: dir, Owner: "admin"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := s.Seed(ctx); err != nil {
		t.Fatalf("Seed: %v", err)
	}
	app, err := serverstore.GetWasmApp(ctx, db, "demo-public")
	if err != nil {
		t.Fatalf("GetWasmApp: %v", err)
	}
	cfgPath := filepath.Join(dataRoot, "apps", "demo-public", "assets",
		strconv.FormatInt(app.CurrentReleaseID, 10), "picoaide.app.json")
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("资源目录/配置必须存在（%s）：%v", cfgPath, err)
	}
	if appcfg.AccessOfConfigJSON(string(raw)) != appcfg.AccessPublic {
		t.Fatalf("资源目录里的配置应与库内一致，得到 %s", string(raw))
	}
}

func TestSeedIsIdempotentAndDeleteSticks(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	s := newSeeder(t, db, writeDemoDir(t))

	if _, err := s.Seed(ctx); err != nil {
		t.Fatalf("首次播种: %v", err)
	}
	// 幂等：再次播种全部跳过（不会重复建版本）。
	res, err := s.Seed(ctx)
	if err != nil {
		t.Fatalf("二次播种: %v", err)
	}
	if len(res.Seeded) != 0 || len(res.Skipped) != 3 {
		t.Fatalf("二次播种应全部跳过：seeded=%v skipped=%+v", res.Seeded, res.Skipped)
	}
	// 管理员删除其中一个演示 ⇒ 再播种也**不重建**（可删除的语义）。
	if err := serverstore.SoftDeleteWasmApp(ctx, db, "demo-login"); err != nil {
		t.Fatalf("软删: %v", err)
	}
	res, err = s.Seed(ctx)
	if err != nil {
		t.Fatalf("删除后播种: %v", err)
	}
	if len(res.Seeded) != 0 {
		t.Fatalf("删除后的演示不得被重建，得到 %v", res.Seeded)
	}
	app, err := serverstore.GetWasmApp(ctx, db, "demo-login")
	if err != nil {
		t.Fatalf("GetWasmApp: %v", err)
	}
	if app.DeletedAt == nil {
		t.Fatal("软删状态应保留（这正是'不重建'的判据）")
	}
}

func TestWhitelistDemoIncludesOwner(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	s := newSeeder(t, db, writeDemoDir(t))
	if _, err := s.Seed(ctx); err != nil {
		t.Fatalf("Seed: %v", err)
	}
	app, err := serverstore.GetWasmApp(ctx, db, "demo-whitelist")
	if err != nil {
		t.Fatalf("GetWasmApp: %v", err)
	}
	var cfg appcfg.Config
	if err := json.Unmarshal([]byte(app.ConfigJSON), &cfg); err != nil {
		t.Fatalf("解析配置: %v", err)
	}
	// 名单必须包含归属人（否则播种完连管理员都进不去，演示无法开场）+ 清单里的账号。
	found := map[string]bool{}
	for _, n := range cfg.Whitelist {
		found[n] = true
	}
	if !found["admin"] || !found["someone"] {
		t.Fatalf("名单应同时含归属人 admin 与清单账号 someone，得到 %v", cfg.Whitelist)
	}
}

func TestRejectsNonWasm(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "app.wasm"), []byte("not a wasm at all"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, appseed.ManifestFileName), []byte(demosJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := appseed.New(appseed.Options{DB: db, DataRoot: t.TempDir(), Dir: dir, Owner: "admin"})
	if err == nil {
		t.Fatal("坏制品必须被拒（结构性校验）")
	}
	if !strings.Contains(err.Error(), "魔数") {
		t.Fatalf("错误文案应点名魔数：%v", err)
	}
	// DB 为空（装配缺陷）也必须报错。
	if _, err := appseed.New(appseed.Options{Dir: dir}); err == nil {
		t.Fatal("DB 为空必须报错")
	}
	// DataRoot 为空同样是装配缺陷（资源目录写不出来 ⇒ 请求时 500）。
	if _, err := appseed.New(appseed.Options{DB: db, Dir: dir, Owner: "admin"}); err == nil {
		t.Fatal("DataRoot 为空必须报错")
	}
}

func TestMissingDirIsNotAnError(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	s, err := appseed.New(appseed.Options{DB: db, DataRoot: t.TempDir(), Dir: filepath.Join(t.TempDir(), "nope"), Owner: "admin"})
	if err != nil {
		t.Fatalf("目录不存在不是错误（源码构建没有演示）：%v", err)
	}
	if s != nil {
		t.Fatal("目录不存在时应返回 nil 播种器（调用方据此跳过）")
	}
}

// TestSeedHalfSeededIsHealedAndNeverPointsAtMissingAssets 是 **R1-rt-19** 的护栏。
//
// 缺陷现场（旧顺序 `SetWasmAppCurrentRelease` → `writeReleaseAssets`）：资源目录写失败时
// 库里留下一个**已经指向不存在目录**的应用（子域每请求 500，报"资源目录不可用"），
// 而播种判据是"库里是否已有该 app_id" ⇒ **重启也不自愈**，只能人工删行。
//
// 本用例不用 mock 注入失败，而是制造一个真实的写失败：把 `<dataRoot>/apps` 放成**普通文件**
// ⇒ MkdirAll 报 ENOTDIR（与磁盘满/只读同一类"写不进去"，见报告 R1-rt-19 的触发条件）。
//
// 判据三段（缺一不可）：
//  1. 失败后：应用行/版本行已落，但 `current_release_id` **必须是 0**（不许指向不存在的目录）；
//  2. 修好磁盘后**重跑播种必须自愈**：不重建版本，但要补齐资源目录 + 生效版本；
//  3. 第三次播种完全幂等（全部跳过、无写入）。
//
// 变异验证（实测）：把 seedOne 的两个写动作换回旧顺序（先置当前版本、后写资源目录）
// ⇒ 第 1 段必红（current_release_id ≠ 0）；把 healIncomplete 的调用去掉（退回"存在即跳过"）
// ⇒ 第 2 段必红（重启后仍是半成品）。
func TestSeedHalfSeededIsHealedAndNeverPointsAtMissingAssets(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	dataRoot := t.TempDir()
	dir := writeDemoDir(t)

	// 制造写失败：<dataRoot>/apps 是普通文件 ⇒ 任何 <root>/apps/... 的 MkdirAll 都报 ENOTDIR。
	appsPath := filepath.Join(dataRoot, "apps")
	if err := os.WriteFile(appsPath, []byte("占位：不是目录"), 0o644); err != nil {
		t.Fatalf("制造写失败现场: %v", err)
	}

	s, err := appseed.New(appseed.Options{DB: db, DataRoot: dataRoot, Dir: dir, Owner: "admin"})
	if err != nil {
		t.Fatalf("appseed.New: %v", err)
	}
	res, err := s.Seed(ctx)
	if err != nil {
		t.Fatalf("单个演示播种失败不该让整次播种报错: %v", err)
	}
	if len(res.Seeded) != 0 {
		t.Fatalf("资源目录写不出去时不得报告播种成功：%v", res.Seeded)
	}
	if len(res.Skipped) != 3 {
		t.Fatalf("三个演示都应记为跳过（附失败原因）：%+v", res.Skipped)
	}

	// ---- ① 失败后：不置生效版本 ----
	demos := []string{"demo-public", "demo-login", "demo-whitelist"}
	for _, appID := range demos {
		app, gerr := serverstore.GetWasmApp(ctx, db, appID)
		if gerr != nil {
			t.Fatalf("失败点之前的应用行应已落库（%s）：%v", appID, gerr)
		}
		if app.CurrentReleaseID != 0 {
			t.Fatalf("%s 在资源目录写失败后 current_release_id=%d（应为 0）：应用指向了一个不存在的"+
				"资源目录 ⇒ 子域每请求 500（R1-rt-19）", appID, app.CurrentReleaseID)
		}
	}

	// ---- ② 修好磁盘后重跑：自愈（补齐资源目录 + 生效版本，不重建版本）----
	if err := os.Remove(appsPath); err != nil {
		t.Fatalf("恢复数据根: %v", err)
	}
	res, err = s.Seed(ctx)
	if err != nil {
		t.Fatalf("二次播种: %v", err)
	}
	if len(res.Seeded) != 0 {
		t.Fatalf("应用行已存在 ⇒ 二次播种不得重新播种（否则版本号会撞唯一约束），得到 %v", res.Seeded)
	}
	for _, appID := range demos {
		app, gerr := serverstore.GetWasmApp(ctx, db, appID)
		if gerr != nil {
			t.Fatalf("GetWasmApp(%s): %v", appID, gerr)
		}
		if app.CurrentReleaseID <= 0 {
			t.Fatalf("%s 二次播种后仍没有生效版本（current_release_id=0）：半成品没有自愈 —— "+
				"这正是「重启不自愈」的现场", appID)
		}
		cfgPath := filepath.Join(dataRoot, "apps", appID, "assets",
			strconv.FormatInt(app.CurrentReleaseID, 10), "picoaide.app.json")
		raw, rerr := os.ReadFile(cfgPath)
		if rerr != nil {
			t.Fatalf("%s 的资源目录没被补齐（%s）：%v", appID, cfgPath, rerr)
		}
		if appcfg.AccessOfConfigJSON(string(raw)) == "" {
			t.Fatalf("%s 补齐的资源目录里配置不可解析：%q", appID, string(raw))
		}
		// 版本行不得因为补齐而多出一份（补齐不是"再发一版"）。
		rels, lerr := serverstore.ListWasmReleases(ctx, db, appID, false)
		if lerr != nil {
			t.Fatalf("ListWasmReleases(%s): %v", appID, lerr)
		}
		if len(rels) != 1 {
			t.Fatalf("%s 的版本行数 = %d，应为 1（补齐只写资源目录/生效版本）", appID, len(rels))
		}
	}

	// ---- ③ 三次播种：完全幂等 ----
	res, err = s.Seed(ctx)
	if err != nil {
		t.Fatalf("三次播种: %v", err)
	}
	if len(res.Seeded) != 0 || len(res.Skipped) != 3 {
		t.Fatalf("三次播种应全部跳过：seeded=%v skipped=%+v", res.Seeded, res.Skipped)
	}
	for _, sk := range res.Skipped {
		if sk.Healed {
			t.Fatalf("%s 第三次播种仍在自愈（补齐不幂等）：%q", sk.AppID, sk.Reason)
		}
	}
}

// ===== 第二轮对抗式审计（诊断与播种区域 R2-DG-4/5/6）的行为级护栏 =====

// demoAssetsPath 返回某个演示版本的资源目录（与 appseed 的推导一致）。
func demoAssetsPath(dataRoot, appID string, relID int64) string {
	return filepath.Join(dataRoot, "apps", appID, "assets", strconv.FormatInt(relID, 10),
		"picoaide.app.json")
}

// TestSeedHealsAppRowWithoutAnyRelease 守住 R2-DG-4：**apps 行已落、一个版本行都没有**
// 这种半成品必须自愈（旧实现把它当"不是我们播的"跳过 ⇒ 应用永久没有可交付版本，
// 而日志给的理由是误导性的"已存在"；触发条件 = 首次启动时 CreateWasmRelease 失败）。
//
// 现场构造（与真实失败点同形）：正常播种后删掉该应用的**全部版本行**并把
// current_release_id 归零、资源目录删掉 —— 这正是 seedOne 在 "UpsertWasmApp 成功、
// CreateWasmRelease 失败" 之后留在库里的状态（应用行/归属/配置齐备，版本什么都没有）。
//
// 判据（三段）：
//  1. 重跑播种后必须补出**恰好一条** approved 版本行，且 current_release_id 指向它；
//  2. 资源目录必须就位，内容与库内 config_json 逐字节相同（应用自己 assets.read 读它）；
//  3. 应用行不得被改写（标题/归属/配置不变）—— 补齐不是"重新播种"。
//
// 变异验证：把 healMissingRelease 的调用换回 `return false, nil`（旧行为）⇒ 第 1 段必红。
func TestSeedHealsAppRowWithoutAnyRelease(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	dataRoot := t.TempDir()
	dir := writeDemoDir(t)
	s, err := appseed.New(appseed.Options{DB: db, DataRoot: dataRoot, Dir: dir, Owner: "admin"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := s.Seed(ctx); err != nil {
		t.Fatalf("首次播种: %v", err)
	}
	const appID = "demo-public"
	before, err := serverstore.GetWasmApp(ctx, db, appID)
	if err != nil {
		t.Fatalf("GetWasmApp: %v", err)
	}
	oldRelID := before.CurrentReleaseID
	assetsDir := filepath.Dir(demoAssetsPath(dataRoot, appID, oldRelID))

	// ---- 制造"A2 半成品"：版本行全没、current 归零、资源目录不在 ----
	if _, err := db.ExecContext(ctx, `DELETE FROM app_releases WHERE app_id = $1`, appID); err != nil {
		t.Fatalf("删除版本行: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE apps SET current_release_id = 0 WHERE app_id = $1`, appID); err != nil {
		t.Fatalf("归零 current_release_id: %v", err)
	}
	if err := os.RemoveAll(assetsDir); err != nil {
		t.Fatalf("删除资源目录: %v", err)
	}
	if rels, _ := serverstore.ListWasmReleases(ctx, db, appID, true); len(rels) != 0 {
		t.Fatalf("夹具失效：版本行应为 0，得到 %d", len(rels))
	}

	// ---- 重跑播种：必须自愈 ----
	res, err := s.Seed(ctx)
	if err != nil {
		t.Fatalf("二次播种: %v", err)
	}
	app, err := serverstore.GetWasmApp(ctx, db, appID)
	if err != nil {
		t.Fatalf("GetWasmApp: %v", err)
	}
	if app.CurrentReleaseID <= 0 {
		t.Fatalf("半成品没有自愈：current_release_id 仍为 0（seeded=%v skipped=%+v）", res.Seeded, res.Skipped)
	}
	rels, err := serverstore.ListWasmReleases(ctx, db, appID, false)
	if err != nil {
		t.Fatalf("ListWasmReleases: %v", err)
	}
	if len(rels) != 1 {
		t.Fatalf("补齐后版本行数 = %d，应为 1（补齐只补这一条，不重复建版本）", len(rels))
	}
	if rels[0].ID != app.CurrentReleaseID {
		t.Fatalf("current_release_id=%d 必须指向补齐出来的版本 %d", app.CurrentReleaseID, rels[0].ID)
	}
	if rels[0].Status != serverstore.ReleaseStatusApproved {
		t.Fatalf("补齐的版本必须是 approved，得到 %s", rels[0].Status)
	}
	full, err := serverstore.LatestApprovedWasmReleaseFull(ctx, db, appID)
	if err != nil {
		t.Fatalf("LatestApprovedWasmReleaseFull: %v", err)
	}
	if len(full.Wasm) == 0 {
		t.Fatal("补齐的版本必须带制品字节（否则冷启动编译一定失败）")
	}
	if full.Checksum != rels[0].Checksum {
		t.Fatalf("补齐的版本指纹与列表不一致：%q vs %q", full.Checksum, rels[0].Checksum)
	}
	// 资源目录 + 内容与库内一致。
	raw, err := os.ReadFile(demoAssetsPath(dataRoot, appID, app.CurrentReleaseID))
	if err != nil {
		t.Fatalf("资源目录没被补齐（%s）：%v", demoAssetsPath(dataRoot, appID, app.CurrentReleaseID), err)
	}
	if string(raw) != app.ConfigJSON {
		t.Fatalf("资源目录里的配置必须与库内逐字节相同：\n库内=%q\n盘上=%q", app.ConfigJSON, string(raw))
	}
	// 应用行不得被改写。
	if app.Owner != before.Owner || app.Title != before.Title || app.ConfigJSON != before.ConfigJSON {
		t.Fatalf("补齐不得改写应用行：before=%+v after=%+v", before, app)
	}
	// 幂等：再播一次不再动手。
	res, err = s.Seed(ctx)
	if err != nil {
		t.Fatalf("三次播种: %v", err)
	}
	for _, sk := range res.Skipped {
		if sk.Healed {
			t.Fatalf("补齐必须幂等，第三次播种仍在动手：%q", sk.Reason)
		}
	}
}

// TestSeedRefusesForeignAppWithoutReleases 是 R2-DG-4 的**反向判据**：
// "应用行存在、没有任何版本行"**不足以**证明这是我们播的 —— 判据是内容。
//
// 同名但归属人/配置不同的应用（他人占用同一 app_id、或管理员改过配置）一律不碰：
// 否则一次启动就会把一个别人的空应用塞上我们的演示制品与配置。
//
// 变异：把 healMissingRelease 里的内容判据（Owner/ConfigJSON 比对）去掉 ⇒ 本用例红。
func TestSeedRefusesForeignAppWithoutReleases(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	dataRoot := t.TempDir()
	s, err := appseed.New(appseed.Options{DB: db, DataRoot: dataRoot, Dir: writeDemoDir(t), Owner: "admin"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// 构造"同名但不是我们播的"应用行：归属人不同 + 配置不同（此处刻意不用 list 里的任何一个）。
	foreign := serverstore.WasmApp{
		AppID:      "demo-public",
		Title:      "别人的同名应用",
		Owner:      "someone-else",
		Channel:    serverstore.AppChannelWasm,
		Enabled:    true,
		ConfigJSON: `{"access":"login","owner":"someone-else"}`,
	}
	if err := serverstore.UpsertWasmApp(ctx, db, foreign); err != nil {
		t.Fatalf("UpsertWasmApp: %v", err)
	}

	if _, err := s.Seed(ctx); err != nil {
		t.Fatalf("Seed: %v", err)
	}
	rels, err := serverstore.ListWasmReleases(ctx, db, "demo-public", true)
	if err != nil {
		t.Fatalf("ListWasmReleases: %v", err)
	}
	if len(rels) != 0 {
		t.Fatalf("他人的同名应用不得被塞入我们的演示版本，得到 %d 条版本行", len(rels))
	}
	app, err := serverstore.GetWasmApp(ctx, db, "demo-public")
	if err != nil {
		t.Fatalf("GetWasmApp: %v", err)
	}
	if app.Owner != "someone-else" || app.ConfigJSON != foreign.ConfigJSON {
		t.Fatalf("他人的应用行不得被改写：%+v", app)
	}
}

// TestSeedDoesNotHealRetiredStates 守住 R2-DG-5/R2-DG-6：**软删 / 冻结 / 下架**三种
// "不要再服务它"的处置态都不是半成品，heal 一律不补（此前只判了软删与冻结，且**没有任何
// 用例覆盖**：删掉那一行守卫全部用例仍绿）。
//
// 判据（行为级）：三种状态下都先把资源目录删掉，再跑播种 —— 目录**必须仍然不存在**
// （一个字节都不写），且跳过理由里不得出现"补齐"。
//
// 变异：去掉 `!app.Enabled` ⇒ 下架子用例红；去掉 `app.DeletedAt/FrozenAt` ⇒ 对应子用例红。
func TestSeedDoesNotHealRetiredStates(t *testing.T) {
	cases := []struct {
		name   string
		retire func(t *testing.T, db *sql.DB, appID string)
	}{
		{"软删", func(t *testing.T, db *sql.DB, appID string) {
			if err := serverstore.SoftDeleteWasmApp(context.Background(), db, appID); err != nil {
				t.Fatalf("软删: %v", err)
			}
		}},
		{"冻结", func(t *testing.T, db *sql.DB, appID string) {
			if err := serverstore.FreezeWasmApp(context.Background(), db, appID, time.Now().UTC()); err != nil {
				t.Fatalf("冻结: %v", err)
			}
		}},
		{"下架", func(t *testing.T, db *sql.DB, appID string) {
			if err := serverstore.SetWasmAppEnabled(context.Background(), db, appID, false); err != nil {
				t.Fatalf("下架: %v", err)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db, cleanup := serverstore.NewTestDB(t)
			defer cleanup()
			ctx := context.Background()
			dataRoot := t.TempDir()
			s, err := appseed.New(appseed.Options{DB: db, DataRoot: dataRoot, Dir: writeDemoDir(t), Owner: "admin"})
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			if _, err := s.Seed(ctx); err != nil {
				t.Fatalf("首次播种: %v", err)
			}
			app, err := serverstore.GetWasmApp(ctx, db, "demo-public")
			if err != nil {
				t.Fatalf("GetWasmApp: %v", err)
			}
			assetsDir := filepath.Dir(demoAssetsPath(dataRoot, "demo-public", app.CurrentReleaseID))
			tc.retire(t, db, "demo-public")
			if err := os.RemoveAll(assetsDir); err != nil {
				t.Fatalf("删除资源目录: %v", err)
			}

			res, err := s.Seed(ctx)
			if err != nil {
				t.Fatalf("二次播种: %v", err)
			}
			if _, serr := os.Stat(assetsDir); !os.IsNotExist(serr) {
				t.Fatalf("%s 的应用不得被补齐资源目录（「删了不再回来」），stat err=%v", tc.name, serr)
			}
			for _, sk := range res.Skipped {
				if sk.Healed {
					t.Fatalf("%s 的应用被当成半成品补齐了（「删了不再回来」被破坏）：%+v", tc.name, sk)
				}
			}
		})
	}
}

// ===== 第三轮对抗式审计 C 区（P3-4）的行为级护栏 =====

// seedDemoPublic 播种一次并返回 (dataRoot, 配置路径, 原始配置字节, 版本行 id 列表)。
func seedDemoPublic(t *testing.T, s *appseed.Seeder, db *sql.DB, dataRoot string) (string, []byte, []int64) {
	t.Helper()
	ctx := context.Background()
	if _, err := s.Seed(ctx); err != nil {
		t.Fatalf("首次播种: %v", err)
	}
	app, err := serverstore.GetWasmApp(ctx, db, "demo-public")
	if err != nil {
		t.Fatalf("GetWasmApp: %v", err)
	}
	cfgPath := demoAssetsPath(dataRoot, "demo-public", app.CurrentReleaseID)
	orig, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("读配置: %v", err)
	}
	rels, err := serverstore.ListWasmReleases(ctx, db, "demo-public", true)
	if err != nil {
		t.Fatalf("ListWasmReleases: %v", err)
	}
	ids := make([]int64, 0, len(rels))
	for _, r := range rels {
		ids = append(ids, r.ID)
	}
	return cfgPath, orig, ids
}

// skippedHealed 找出某个演示这一趟的处置结论（Healed 是机器可读的"动了手"事实）。
func skippedHealed(res appseed.Result, appID string) (appseed.SkipReason, bool) {
	for _, sk := range res.Skipped {
		if sk.AppID == appID {
			return sk, true
		}
	}
	return appseed.SkipReason{}, false
}

// TestSeedHealsTruncatedReleaseConfig 是 **P3-4** 的核心判据：
// "存在但内容不完整"的配置（半写/截断）必须被自愈，而不是被当成"已存在"跳过。
//
// 缺陷现场（审计实测，真 PG）：`releaseAssetsPresent` 只做 os.Stat ⇒ 截断到 49 字节的
// `picoaide.app.json` 被认为完整，二次播种不动手、日志理由"已存在（含已删除/已冻结）"，
// 而线上 `loadAppConfig` 解析失败 ⇒ 应用子域**每请求 500**，且重启也不自愈
// （只有人工删文件才触发补齐）。
//
// 判据四段：
//  1. 截断（原长的一半 / 原长减一，覆盖 49 与 99 字节两个现场尺寸）⇒ 二次播种**修复**：
//     文件逐字节等于原始配置，且能过 appcfg.Parse（= 请求路径给出 200 的前提）；
//  2. 处置结论必须**如实**：SkipReason.Healed=true 且理由点名"内容不完整 ⇒ 已重写"；
//  3. 修复**不得**覆盖既有 approved 版本行（版本行 id 集合不变）——自愈不是"再发一版"；
//  4. 修好之后再播种 ⇒ 幂等：Healed=false、代码不再写盘（inode/ModTime 都不变），
//     且资源目录里没有留下原子写用的临时文件。
func TestSeedHealsTruncatedReleaseConfig(t *testing.T) {
	cases := []struct {
		name   string
		trunc  func(orig []byte) []byte
		expect string // 理由里必须出现的关键词
	}{
		{"截断到一半（49 字节）", func(o []byte) []byte { return o[:len(o)/2] }, "内容不完整"},
		{"截断到只差一字节（99 字节）", func(o []byte) []byte { return o[:len(o)-1] }, "内容不完整"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db, cleanup := serverstore.NewTestDB(t)
			defer cleanup()
			ctx := context.Background()
			dataRoot := t.TempDir()
			s, err := appseed.New(appseed.Options{DB: db, DataRoot: dataRoot, Dir: writeDemoDir(t), Owner: "admin"})
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			cfgPath, orig, relIDs := seedDemoPublic(t, s, db, dataRoot)
			broken := tc.trunc(orig)
			if _, perr := appcfg.Parse(broken); perr == nil {
				t.Fatalf("夹具失效：截断后的配置仍能解析（%d 字节）", len(broken))
			}
			fiBefore, err := os.Stat(cfgPath)
			if err != nil {
				t.Fatalf("Stat: %v", err)
			}
			if err := os.WriteFile(cfgPath, broken, 0o644); err != nil {
				t.Fatalf("写坏配置: %v", err)
			}

			res, err := s.Seed(ctx)
			if err != nil {
				t.Fatalf("二次播种: %v", err)
			}
			// ① 修复：内容恢复成原始配置，且请求路径能解析（= 应用子域回到 200 的前提）。
			after, err := os.ReadFile(cfgPath)
			if err != nil {
				t.Fatalf("复读配置: %v", err)
			}
			if string(after) != string(orig) {
				t.Fatalf("截断到 %d 字节的配置没有被修复：盘上 %d 字节（原始 %d 字节）\n"+
					"（旧判据是『文件存在即完整』⇒ 永不修复、线上每请求 500）",
					len(broken), len(after), len(orig))
			}
			if _, perr := appcfg.Parse(after); perr != nil {
				t.Fatalf("修复后的配置仍不可解析（请求路径会 500）：%v", perr)
			}
			// ② 处置理由必须与行为一致。
			sk, ok := skippedHealed(res, "demo-public")
			if !ok {
				t.Fatalf("二次播种没有 demo-public 的处置结论：%+v", res.Skipped)
			}
			if !sk.Healed {
				t.Fatalf("半写配置必须被自愈（Healed=true），得到 %+v", sk)
			}
			if !strings.Contains(sk.Reason, tc.expect) || !strings.Contains(sk.Reason, "重写") {
				t.Fatalf("理由必须如实说明『已存在但内容不完整 ⇒ 重写』，得到 %q", sk.Reason)
			}
			// 原子替换：文件是**另一个** inode（rename），不是原地覆盖。
			fiHealed, err := os.Stat(cfgPath)
			if err != nil {
				t.Fatalf("Stat: %v", err)
			}
			if os.SameFile(fiBefore, fiHealed) {
				t.Fatalf("自愈必须走原子替换（临时文件 + rename），不能原地 O_TRUNC 覆盖（同一 inode）")
			}
			// ③ 既有 approved 版本行不得被覆盖/新增。
			rels, err := serverstore.ListWasmReleases(ctx, db, "demo-public", true)
			if err != nil {
				t.Fatalf("ListWasmReleases: %v", err)
			}
			var ids []int64
			for _, r := range rels {
				if r.Status != serverstore.ReleaseStatusApproved {
					t.Fatalf("版本行状态被改写：%+v", r)
				}
				ids = append(ids, r.ID)
			}
			if len(ids) != len(relIDs) {
				t.Fatalf("版本行数从 %d 变成 %d（自愈不得新建/删除版本行）", len(relIDs), len(ids))
			}
			for i := range ids {
				if ids[i] != relIDs[i] {
					t.Fatalf("版本行 id 被改写：%v → %v", relIDs, ids)
				}
			}
			// ④ 幂等 + 完好文件不动手：再播种必须一个字节都不写。
			res2, err := s.Seed(ctx)
			if err != nil {
				t.Fatalf("三次播种: %v", err)
			}
			sk2, _ := skippedHealed(res2, "demo-public")
			if sk2.Healed {
				t.Fatalf("完好文件不得再动手（自愈不幂等）：%+v", sk2)
			}
			if !strings.Contains(sk2.Reason, "完整") {
				t.Fatalf("完好文件的理由必须说明『内容完整』，得到 %q", sk2.Reason)
			}
			fiAfter, err := os.Stat(cfgPath)
			if err != nil {
				t.Fatalf("Stat: %v", err)
			}
			if !os.SameFile(fiHealed, fiAfter) || !fiHealed.ModTime().Equal(fiAfter.ModTime()) {
				t.Fatalf("完好文件被重写了（inode/mtime 变化）：%v → %v", fiHealed.ModTime(), fiAfter.ModTime())
			}
			entries, err := os.ReadDir(filepath.Dir(cfgPath))
			if err != nil {
				t.Fatalf("ReadDir: %v", err)
			}
			for _, en := range entries {
				if strings.HasPrefix(en.Name(), ".") {
					t.Fatalf("资源目录里留下了原子写的临时文件：%s", en.Name())
				}
			}
		})
	}
}

// TestSeedRewritesConfigWithForeignOwner 守住 P3-4 判据里的"归属人一致"：
// 内容能解析、但与随安装清单的归属人不同的配置**同样**不是"完整"——它会被重写成
// 版本快照（自愈只碰"制品指纹 = 随安装"的版本，所以这不是改写别人的应用）。
func TestSeedRewritesConfigWithForeignOwner(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	dataRoot := t.TempDir()
	s, err := appseed.New(appseed.Options{DB: db, DataRoot: dataRoot, Dir: writeDemoDir(t), Owner: "admin"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	cfgPath, orig, _ := seedDemoPublic(t, s, db, dataRoot)

	// 合法 JSON、必需字段齐备，但归属人是别人（半成品/被手工改写的形态）。
	var cfg map[string]any
	if err := json.Unmarshal(orig, &cfg); err != nil {
		t.Fatalf("解析原始配置: %v", err)
	}
	cfg["owner"] = "someone-else"
	tampered, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("编码: %v", err)
	}
	if _, perr := appcfg.Parse(tampered); perr != nil {
		t.Fatalf("夹具失效：改写归属人后的配置不可解析：%v", perr)
	}
	if err := os.WriteFile(cfgPath, tampered, 0o644); err != nil {
		t.Fatalf("写配置: %v", err)
	}

	res, err := s.Seed(ctx)
	if err != nil {
		t.Fatalf("二次播种: %v", err)
	}
	sk, _ := skippedHealed(res, "demo-public")
	if !sk.Healed {
		t.Fatalf("归属人不一致的配置必须被重写，得到 %+v", sk)
	}
	if !strings.Contains(sk.Reason, "归属人") {
		t.Fatalf("理由必须点名归属人不一致，得到 %q", sk.Reason)
	}
	after, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("复读: %v", err)
	}
	if string(after) != string(orig) {
		t.Fatalf("重写后的配置必须等于版本快照：%q ≠ %q", after, orig)
	}
}

// ===== W4（2026-09-19「客户端专属」改造）的护栏：磁盘资产改写 + heal 不覆盖标题 =====

// 导出签名是**启动接线（cmd/server/wasmapp_demo.go）依赖的契约**：改签名必须同时改接线，
// 这里用编译期断言把两者钉在一起（整包编译在并发泳道施工期间可能因别的文件是红的，
// 这条断言仍然会拦住签名漂移）。
var _ func(context.Context, *sql.DB, string, func(string, ...any)) (appseed.AssetRewriteResult, error) = appseed.RewritePublicAccessAssets

// assetPathOf 返回某个演示**生效版本**的磁盘资产路径（连同应用行）。
func assetPathOf(t *testing.T, ctx context.Context, db *sql.DB, dataRoot, appID string) (string, *serverstore.WasmApp) {
	t.Helper()
	app, err := serverstore.GetWasmApp(ctx, db, appID)
	if err != nil {
		t.Fatalf("GetWasmApp(%s): %v", appID, err)
	}
	return demoAssetsPath(dataRoot, appID, app.CurrentReleaseID), app
}

// assertNoTempFiles 断言资源目录里没有留下原子写用的隐藏临时文件
// （writeReleaseAssets 的 `.picoaide.app.json.tmp*`）。
func assertNoTempFiles(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir(%s): %v", dir, err)
	}
	for _, en := range entries {
		if strings.HasPrefix(en.Name(), ".") {
			t.Fatalf("资源目录里留下了原子写的临时文件：%s", en.Name())
		}
	}
}

// TestRewritePublicAccessAssetsRewritesPublicOnDisk 是 W4-6「磁盘资产改写（A 方案）」的判据：
// 磁盘上残留的 `access=public` 必须被**原子改写**为 `login`，且只动这一个值。
//
// 为什么磁盘侧必须改（设计 §9 事实订正 ②）：运行期权威在磁盘资产，应用自己 assets.read 读它；
// 读侧虽已把 public 映射为 login，但配置里的 public 会让应用可能自行实现一套"匿名可用"行为。
// 只改 DB（迁移 0074）不改磁盘 ⇒ 磁盘上永久残留 public。
//
// 判据五段：
//  1. 命中行改写：只替换 access 的值，其余字节**逐字保留**（键序/空白/其它键都不动）；
//  2. 原子替换：inode 变了（temp+fsync+rename），且目录里没有留下临时文件；
//  3. 未命中的文件（login/whitelist）一个字节都不写；
//  4. **DB 侧不动**：那是迁移 0074 的职责，本入口只改磁盘（两侧分工不得互相越界）；
//  5. 幂等：第二次 0 命中、字节不变。
func TestRewritePublicAccessAssetsRewritesPublicOnDisk(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	dataRoot := t.TempDir()
	s, err := appseed.New(appseed.Options{DB: db, DataRoot: dataRoot, Dir: writeDemoDir(t), Owner: "admin"})
	if err != nil {
		t.Fatalf("appseed.New: %v", err)
	}
	if _, err := s.Seed(ctx); err != nil {
		t.Fatalf("Seed: %v", err)
	}

	pubPath, pubApp := assetPathOf(t, ctx, db, dataRoot, "demo-public")
	before, err := os.ReadFile(pubPath)
	if err != nil {
		t.Fatalf("读资源目录配置: %v", err)
	}
	if appcfg.AccessOfConfigJSON(string(before)) != appcfg.AccessPublic {
		t.Fatalf("前置条件失败：demo-public 的磁盘资产应当是 public，得到 %q", before)
	}
	fiBefore, err := os.Stat(pubPath)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	loginPath, _ := assetPathOf(t, ctx, db, dataRoot, "demo-login")
	loginBefore, err := os.ReadFile(loginPath)
	if err != nil {
		t.Fatalf("读 demo-login 配置: %v", err)
	}

	var logs []string
	res, err := appseed.RewritePublicAccessAssets(ctx, db, dataRoot, func(format string, args ...any) {
		logs = append(logs, fmt.Sprintf(format, args...))
	})
	if err != nil {
		t.Fatalf("RewritePublicAccessAssets: %v", err)
	}
	if res.Apps != 3 || res.Releases != 3 || res.Files != 3 || res.Rewritten != 1 ||
		res.Missing != 0 || res.Skipped != 0 || len(res.Problems) != 0 {
		t.Fatalf("统计不对（应 3 应用/3 版本/3 可解析/1 改写/0 跳过）：%+v", res)
	}

	// ① 只改 access 的值：其余字节逐字保留（紧凑形态）。
	after, err := os.ReadFile(pubPath)
	if err != nil {
		t.Fatalf("复读: %v", err)
	}
	want := strings.Replace(string(before), `"access":"public"`, `"access":"login"`, 1)
	if string(after) != want {
		t.Fatalf("改写必须只动 access 一个值（其余键逐字保留）：\n got=%q\nwant=%q", after, want)
	}
	if appcfg.AccessOfConfigJSON(string(after)) != appcfg.AccessLogin {
		t.Fatalf("改写后应当是 login：%q", after)
	}
	// ② 原子替换（temp+rename ⇒ 另一个 inode）+ 不留临时文件。
	fiAfter, err := os.Stat(pubPath)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if os.SameFile(fiBefore, fiAfter) {
		t.Fatal("改写必须走原子替换（临时文件 + rename），不能原地 O_TRUNC 覆盖（同一 inode）")
	}
	assertNoTempFiles(t, filepath.Dir(pubPath))
	// ③ 未命中的文件一个字节都不写。
	loginAfter, err := os.ReadFile(loginPath)
	if err != nil {
		t.Fatalf("复读 demo-login: %v", err)
	}
	if string(loginAfter) != string(loginBefore) {
		t.Fatalf("非 public 的配置不得被改写：\n got=%q\nwant=%q", loginAfter, loginBefore)
	}
	// ④ DB 侧不动（迁移 0074 的职责）。
	dbApp, err := serverstore.GetWasmApp(ctx, db, "demo-public")
	if err != nil {
		t.Fatalf("GetWasmApp: %v", err)
	}
	if dbApp.ConfigJSON != pubApp.ConfigJSON {
		t.Fatalf("本入口只改磁盘，不得改 DB（DB 侧归迁移 0074）：\n got=%q\nwant=%q", dbApp.ConfigJSON, pubApp.ConfigJSON)
	}
	// 日志里必须能看见"改写了哪一个"（跳过数量与改写明细都是诊断面）。
	if joined := strings.Join(logs, "\n"); !strings.Contains(joined, "已由 public 收敛为 login") {
		t.Fatalf("改写必须记日志（否则线上无从判断这一轮做了什么）：%v", logs)
	}
	// ⑤ 幂等：第二次 0 命中、字节不变。
	res2, err := appseed.RewritePublicAccessAssets(ctx, db, dataRoot, nil)
	if err != nil {
		t.Fatalf("二次改写: %v", err)
	}
	if res2.Rewritten != 0 || res2.Skipped != 0 || res2.Files != 3 {
		t.Fatalf("二次改写必须 0 命中（幂等）：%+v", res2)
	}
	again, err := os.ReadFile(pubPath)
	if err != nil {
		t.Fatalf("复读: %v", err)
	}
	if string(again) != string(after) {
		t.Fatalf("幂等被破坏：\n first=%q\nsecond=%q", after, again)
	}
	// 装配缺陷（nil DB / 空 DataRoot）必须报错 —— 否则会静默"什么都没做"。
	if _, err := appseed.RewritePublicAccessAssets(ctx, nil, dataRoot, nil); err == nil {
		t.Fatal("DB 为空必须报错")
	}
	if _, err := appseed.RewritePublicAccessAssets(ctx, db, "", nil); err == nil {
		t.Fatal("DataRoot 为空必须报错")
	}
}

// TestRewritePublicAccessAssetsSkipsBrokenButKeepsGoing：单个文件读不到 / 坏 JSON
// ⇒ **跳过并计数、不 panic、不中断整轮**（W4-6 的失败语义）。
//
// 三种现场一次构造：
//   - demo-public  ：jsonb 空格形态（`{"access": "public", …}`）⇒ 必须被改写
//     （**字面 REPLACE 会漏掉它**，这正是 A 方案走 JSON 解析的理由）；
//   - demo-login   ：坏 JSON ⇒ 跳过并计数（文件不得被覆盖/删除）；
//   - demo-whitelist：文件缺失 ⇒ Missing（不是失败，单独计数）。
//
// 关键判据是"坏文件之后的那个应用仍然被处理"（不中断整轮）+ 跳过数量出现在日志里。
func TestRewritePublicAccessAssetsSkipsBrokenButKeepsGoing(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	dataRoot := t.TempDir()
	s, err := appseed.New(appseed.Options{DB: db, DataRoot: dataRoot, Dir: writeDemoDir(t), Owner: "admin"})
	if err != nil {
		t.Fatalf("appseed.New: %v", err)
	}
	if _, err := s.Seed(ctx); err != nil {
		t.Fatalf("Seed: %v", err)
	}

	pubPath, _ := assetPathOf(t, ctx, db, dataRoot, "demo-public")
	loginPath, _ := assetPathOf(t, ctx, db, dataRoot, "demo-login")
	whitePath, _ := assetPathOf(t, ctx, db, dataRoot, "demo-whitelist")

	// 现场：空格形态 / 坏 JSON / 文件缺失。
	const spaced = `{"access": "public", "purpose": "匿名可达", "owner": "admin"}`
	if err := os.WriteFile(pubPath, []byte(spaced), 0o644); err != nil {
		t.Fatalf("写空格形态: %v", err)
	}
	if err := os.WriteFile(loginPath, []byte(`{not json`), 0o644); err != nil {
		t.Fatalf("写坏 JSON: %v", err)
	}
	if err := os.Remove(whitePath); err != nil {
		t.Fatalf("删文件: %v", err)
	}

	var logs []string
	res, err := appseed.RewritePublicAccessAssets(ctx, db, dataRoot, func(format string, args ...any) {
		logs = append(logs, fmt.Sprintf(format, args...))
	})
	if err != nil {
		t.Fatalf("单文件失败不得让整轮报错: %v", err)
	}
	if res.Rewritten != 1 || res.Skipped != 1 || res.Missing != 1 || res.Files != 1 || res.Releases != 3 {
		t.Fatalf("统计不对（应 1 改写 / 1 跳过 / 1 缺失 / 1 可解析 / 3 版本）：%+v", res)
	}
	if len(res.Problems) != 1 || res.Problems[0].AppID != "demo-login" {
		t.Fatalf("跳过明细必须点名 demo-login：%+v", res.Problems)
	}
	if !strings.Contains(res.Problems[0].Reason, "不可解析") {
		t.Fatalf("跳过原因必须如实（坏 JSON ⇒ 不可解析）：%q", res.Problems[0].Reason)
	}
	// 坏文件不得被覆盖/删除（跳过就是跳过）。
	if broken, rerr := os.ReadFile(loginPath); rerr != nil || string(broken) != `{not json` {
		t.Fatalf("坏 JSON 文件不得被改动：%q（err=%v）", broken, rerr)
	}
	// 空格形态必须被精确改写（字面 REPLACE 会漏掉它）。
	after, rerr := os.ReadFile(pubPath)
	if rerr != nil {
		t.Fatalf("复读: %v", rerr)
	}
	if string(after) != `{"access": "login", "purpose": "匿名可达", "owner": "admin"}` {
		t.Fatalf("空格形态必须被改写且其余键逐字保留：%q", after)
	}
	// 跳过数量必须出现在日志里（调用方据此发现问题）。
	if joined := strings.Join(logs, "\n"); !strings.Contains(joined, "跳过 1 个文件") {
		t.Fatalf("跳过数量必须记日志：%v", logs)
	}
}

// TestSeedDoesNotOverwriteTitleOnExistingRows 钉住 **W4-7 的 appseed 半边**：
// heal **不得覆盖标题**（标题以库里既有行为准；只有**新建行**才写 demos.json 的标题）。
//
// 为什么需要这条（现状已满足，但要钉死）：W4-7 改了 `server/demoapps/demos.json` 的口径
// （access 收敛 login、标题去掉"匿名可达"）。演示应用**保留 app_id**（历史行里有既存数据：
// 归属、版本行、资源目录、管理员改过的标题），所以清单文案的变化**只对新建行生效** ——
// 若哪一天有人在 heal 里顺手补一句"把标题同步成清单里的"，客户场上已被改名的演示会被
// 静默改回去（而这不是"修复半成品"）。
//
// 判据三段：
//  1. 换一份清单（demo-public 的标题/描述/access 全变）重播 ⇒ 已存在行的
//     title/description/config_json **一个都不变**，磁盘资产也**没被重写**（同 inode）；
//  2. 该行的处置结论是幂等跳过（Healed=false）；
//  3. 同一份清单里的**新**演示正常播种，且取的是**清单里的新标题**（证明"只有新建行写标题"）。
func TestSeedDoesNotOverwriteTitleOnExistingRows(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	dataRoot := t.TempDir()
	dir := writeDemoDir(t) // 第一版清单
	s, err := appseed.New(appseed.Options{DB: db, DataRoot: dataRoot, Dir: dir, Owner: "admin"})
	if err != nil {
		t.Fatalf("appseed.New: %v", err)
	}
	if _, err := s.Seed(ctx); err != nil {
		t.Fatalf("首次播种: %v", err)
	}
	pubPath, before := assetPathOf(t, ctx, db, dataRoot, "demo-public")
	origAssets, err := os.ReadFile(pubPath)
	if err != nil {
		t.Fatalf("读资源目录配置: %v", err)
	}
	fiBefore, err := os.Stat(pubPath)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}

	// 第二版清单 = W4-7 的口径变更（access 收敛 + 标题去掉"匿名可达"），外加一个新演示。
	const demosJSONv2 = `{"demos":[
  {"app_id":"demo-public","title":"公开演示（登录后使用）","description":"需登录","access":"login","purpose":"演示","data_sensitivity":"公开"},
  {"app_id":"demo-login","title":"登录演示","description":"需登录","access":"login","purpose":"演示","data_sensitivity":"内部"},
  {"app_id":"demo-whitelist","title":"名单演示","description":"需名单","access":"whitelist","whitelist":["someone"],"purpose":"演示","data_sensitivity":"内部"},
  {"app_id":"demo-added","title":"新增演示","description":"只有新建行才取清单标题","access":"login","purpose":"演示","data_sensitivity":"内部"}
]}`
	if err := os.WriteFile(filepath.Join(dir, appseed.ManifestFileName), []byte(demosJSONv2), 0o644); err != nil {
		t.Fatalf("换清单: %v", err)
	}
	s2, err := appseed.New(appseed.Options{DB: db, DataRoot: dataRoot, Dir: dir, Owner: "admin"})
	if err != nil {
		t.Fatalf("appseed.New(二版清单): %v", err)
	}
	res, err := s2.Seed(ctx)
	if err != nil {
		t.Fatalf("二次播种: %v", err)
	}

	// ① 已存在行：标题/描述/配置一律不动。
	after, err := serverstore.GetWasmApp(ctx, db, "demo-public")
	if err != nil {
		t.Fatalf("GetWasmApp: %v", err)
	}
	if after.Title != before.Title {
		t.Fatalf("heal 覆盖了标题：%q → %q（W4-7：标题以库里既有行为准）", before.Title, after.Title)
	}
	if after.Description != before.Description {
		t.Fatalf("heal 覆盖了描述：%q → %q", before.Description, after.Description)
	}
	if after.ConfigJSON != before.ConfigJSON {
		t.Fatalf("清单里的 access 变化不得回写到已存在行（那是迁移 0074 的职责）：\n got=%q\nwant=%q",
			after.ConfigJSON, before.ConfigJSON)
	}
	// 磁盘资产也不得被重写（同 inode = 一个字节都没写）。
	nowAssets, err := os.ReadFile(pubPath)
	if err != nil {
		t.Fatalf("复读资源目录配置: %v", err)
	}
	if string(nowAssets) != string(origAssets) {
		t.Fatalf("已存在行的磁盘资产被重写了：\n got=%q\nwant=%q", nowAssets, origAssets)
	}
	fiAfter, err := os.Stat(pubPath)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if !os.SameFile(fiBefore, fiAfter) {
		t.Fatal("已存在且内容完整的行不得被原子替换（一个字节都不该写）")
	}
	// ② 处置结论：幂等跳过（没有动手）。
	if sk, ok := skippedHealed(res, "demo-public"); !ok || sk.Healed {
		t.Fatalf("已存在行必须幂等跳过（Healed=false）：%+v", res.Skipped)
	}
	// ③ 新建行取清单标题（只有新建行写标题）。
	if len(res.Seeded) != 1 || res.Seeded[0] != "demo-added" {
		t.Fatalf("只应有 demo-added 被播种：seeded=%v skipped=%+v", res.Seeded, res.Skipped)
	}
	added, err := serverstore.GetWasmApp(ctx, db, "demo-added")
	if err != nil {
		t.Fatalf("GetWasmApp(demo-added): %v", err)
	}
	if added.Title != "新增演示" {
		t.Fatalf("新建行必须取清单里的标题，得到 %q", added.Title)
	}
	if _, err := os.Stat(demoAssetsPath(dataRoot, "demo-added", added.CurrentReleaseID)); err != nil {
		t.Fatalf("新建行的资源目录必须就位：%v", err)
	}
	// ④ 再播一次仍然幂等：标题不会被"越播越新"。
	if _, err := s2.Seed(ctx); err != nil {
		t.Fatalf("三次播种: %v", err)
	}
	again, err := serverstore.GetWasmApp(ctx, db, "demo-public")
	if err != nil {
		t.Fatalf("GetWasmApp: %v", err)
	}
	if again.Title != before.Title || again.ConfigJSON != before.ConfigJSON {
		t.Fatalf("三次播种改动了已存在行：%+v（want title=%q）", again, before.Title)
	}
}

// ===== W4-7 的另一半：存量演示应用的**标题**一次性对齐（临时文件不属于本波次） =====

// TestRewriteLegacyDemoTitlesAlignsStaleRowsOnly 覆盖设计 §9 的「一次性改写标题」。
//
// 现场：`Seed` 对已存在的行跳过、heal 按口径不覆盖标题（否则管理员改过的标题每次启动
// 都会被回滚）⇒ 清单改了标题对**存量部署**完全无效，演示应用点开还是历史口径。
//
// 判据四段：
//  1. 标题仍带历史字样的行 ⇒ 改成清单值（title + description 一起换）；
//  2. **管理员自己改过的标题**（不含历史字样）⇒ 一个字节都不动（Kept）；
//  3. 幂等：第二次 Rewritten = 0（改完就不再含历史字样）；
//  4. 只改 `apps` 行，不动 `app_releases`（版本行是每版不可变快照）。
func TestRewriteLegacyDemoTitlesAlignsStaleRowsOnly(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	dataRoot := t.TempDir()
	s, err := appseed.New(appseed.Options{DB: db, DataRoot: dataRoot, Dir: writeDemoDir(t), Owner: "admin"})
	if err != nil {
		t.Fatalf("appseed.New: %v", err)
	}
	if _, err := s.Seed(ctx); err != nil {
		t.Fatalf("Seed: %v", err)
	}

	// 造"存量"现场：demo-public 的标题被旧版本写成了历史口径；demo-login 的标题被
	// 管理员改成了自己的名字（不含历史字样）。
	if err := serverstore.SetWasmAppDisplay(ctx, db, "demo-public",
		"演示 · 公开应用（匿名可达）", "不需要登录就能打开：演示 access=public 的准入模式。"); err != nil {
		t.Fatalf("造存量标题: %v", err)
	}
	if err := serverstore.SetWasmAppDisplay(ctx, db, "demo-login", "我们自己的演示", "管理员改过的描述"); err != nil {
		t.Fatalf("造管理员标题: %v", err)
	}
	// demo-whitelist 保留播种时的标题（清单口径，不含历史字样）⇒ 也不动。

	var logs []string
	res, err := appseed.RewriteLegacyDemoTitles(ctx, s, func(format string, args ...any) {
		logs = append(logs, fmt.Sprintf(format, args...))
	})
	if err != nil {
		t.Fatalf("RewriteLegacyDemoTitles: %v", err)
	}
	if res.Examined != 3 || res.Rewritten != 1 || res.Kept != 2 || res.Missing != 0 || len(res.Problems) != 0 {
		t.Fatalf("统计不对（应 3 条/1 改写/2 保留）：%+v", res)
	}

	// ① 历史口径行被改成清单值（title + description 一起换）。
	pub, err := serverstore.GetWasmApp(ctx, db, "demo-public")
	if err != nil {
		t.Fatalf("GetWasmApp: %v", err)
	}
	if pub.Title != "公开演示" || pub.Description != "匿名可达" {
		t.Fatalf("存量标题未对齐到清单口径: title=%q desc=%q", pub.Title, pub.Description)
	}
	// ② 管理员改过的标题一个字节都不动。
	login, err := serverstore.GetWasmApp(ctx, db, "demo-login")
	if err != nil {
		t.Fatalf("GetWasmApp: %v", err)
	}
	if login.Title != "我们自己的演示" || login.Description != "管理员改过的描述" {
		t.Fatalf("管理员自己命名的标题被覆盖了（这是 heals 语义要避免的形态）: %+v", login)
	}
	// 日志必须能看见"改了哪一行"（诊断面）。
	if joined := strings.Join(logs, "\n"); !strings.Contains(joined, "演示标题已由历史口径改写为清单值") {
		t.Fatalf("改写必须记日志：%v", logs)
	}
	// ③ 幂等：第二次 0 改写。
	res2, err := appseed.RewriteLegacyDemoTitles(ctx, s, nil)
	if err != nil {
		t.Fatalf("二次改写: %v", err)
	}
	if res2.Rewritten != 0 || res2.Kept != 3 {
		t.Fatalf("二次改写必须 0 命中：%+v", res2)
	}
	// ④ `app_releases` 的标题不得被动过（每版不可变快照）。
	rels, err := serverstore.ListWasmReleases(ctx, db, "demo-public", true)
	if err != nil {
		t.Fatalf("ListWasmReleases: %v", err)
	}
	if len(rels) == 0 {
		t.Fatal("前置条件失败：demo-public 应当有版本行")
	}
	for _, rel := range rels {
		if strings.Contains(rel.Title, "匿名可达") {
			t.Fatalf("版本行的标题被本入口改动了（历史快照必须逐字保留）: %+v", rel)
		}
	}
	// 装配缺陷：nil Seeder 必须报错（否则静默"什么都没做"）。
	if _, err := appseed.RewriteLegacyDemoTitles(ctx, nil, nil); err == nil {
		t.Fatal("Seeder 为 nil 必须报错")
	}
}
