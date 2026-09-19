package appseed_test

import (
	"context"
	"database/sql"
	"encoding/json"
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
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "app.wasm"), fakeWasm(), 0o644); err != nil {
		t.Fatalf("写 app.wasm: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, appseed.ManifestFileName), []byte(demosJSON), 0o644); err != nil {
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
		if strings.Contains(sk.Reason, "补齐") {
			t.Fatalf("%s 第三次播种仍在补齐（补齐不幂等）：%q", sk.AppID, sk.Reason)
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
		if strings.Contains(sk.Reason, "补齐") {
			t.Fatalf("补齐必须幂等，第三次播种仍在补：%q", sk.Reason)
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
				if strings.Contains(sk.Reason, "补齐") {
					t.Fatalf("%s 的应用被当成半成品补齐了：%+v", tc.name, sk)
				}
			}
		})
	}
}
