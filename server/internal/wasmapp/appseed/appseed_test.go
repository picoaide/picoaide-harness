package appseed_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io/fs"
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

// 本文件是「内置演示应用」的门禁：播种 = 装完即用；已存在/已删除 = **不重建**；
// 落点只有 PostgreSQL（2026-09-20 起随包资源改内存直出，宿主盘上不许再出现资源目录）。
//
// 变异验证（交付时实跑过，勿删）：
//   - 把 Seed 里的 "存在即跳过" 判断去掉 ⇒ TestSeedIsIdempotentAndDeleteSticks 必红；
//   - 把 whitelist 的"补上归属人"去掉 ⇒ TestWhitelistDemoIncludesOwner 必红；
//   - 把 validateWasm 的魔数检查去掉 ⇒ TestRejectsNonWasm 必红；
//   - 把"抽资源目录落盘"（旧 writeReleaseAssets）加回 seedOne ⇒ TestSeedWritesNoAssetsToDisk 必红。

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
	return newSeederIn(t, db, dir, t.TempDir())
}

// newSeederIn 与 newSeeder 相同，但由调用方给出平台数据根 —— 需要断言"播种不落盘"的
// 用例要能盯着那个目录（2026-09-20 起 appseed 一个字节都不该写进去）。
func newSeederIn(t *testing.T, db *sql.DB, dir, dataRoot string) *appseed.Seeder {
	t.Helper()
	s, err := appseed.New(appseed.Options{
		DB:       db,
		DataRoot: dataRoot,
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

// assertNothingWrittenToDataRoot 是**负向断言**：播种的落点只有 PostgreSQL，
// `<dataRoot>` 下不得出现任何东西 —— 尤其是历史形态的
// `<dataRoot>/apps/<app_id>/assets/<release_id>/picoaide.app.json`。
//
// 为什么用"整个数据根必须为空"这种强判据，而不是只查那个具体路径：写盘这件事一旦回到
// 播种路径，落点必然落在这棵目录树里（资源目录、配置副本、原子写的临时文件都算），
// 逐路径断言会漏掉新造的路径。变异验证：把旧 writeReleaseAssets 加回 seedOne ⇒ 必红。
func assertNothingWrittenToDataRoot(t *testing.T, dataRoot string) {
	t.Helper()
	var found []string
	err := filepath.WalkDir(dataRoot, func(p string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p != dataRoot {
			found = append(found, p)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("遍历数据根 %s: %v", dataRoot, err)
	}
	if len(found) > 0 {
		t.Fatalf("播种不得在宿主盘上留下任何东西（随包资源已改内存直出；历史形态是 "+
			"<dataRoot>/apps/<app_id>/assets/<release_id>/picoaide.app.json），实际留下 %d 项：%v",
			len(found), found)
	}
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
		// 配置的唯一权威在库内：apps 行（目录投影）与版本行（运行期注入内存资源集的
		// 那一份）逐字节相同 —— 内存直出后盘上不再有第二份副本可比。
		if rel.ConfigJSON != app.ConfigJSON {
			t.Fatalf("%s 的应用行与版本行配置必须逐字节相同：\napp=%q\nrel=%q",
				appID, app.ConfigJSON, rel.ConfigJSON)
		}
		if _, perr := appcfg.Parse([]byte(rel.ConfigJSON)); perr != nil {
			t.Fatalf("%s 的库内配置应能过 appcfg.Parse（运行期要注入内存资源集）：%v", appID, perr)
		}
	}
}

// TestSeedMultiArtifactAndWindow：清单可以给**每条演示指定不同的制品与窗口比例**。
//
// 存在的理由（2026-09-20）：演示不再是"同一份 wasm 按权限播种三次"，而是几个功能
// 不同的应用（能力全集手机比例 / 论坛与留言板电脑比例）。两条判据都必须是**产物级**的：
//   - 版本行里的制品字节 = 该条清单指向的那一份（不是别的演示的），且两份制品必须
//     真的不同（否则"指定了 wasm 字段但读的还是同一份"会假绿）；
//   - 配置 JSON 里的 window 与清单**逐字一致**（含 `"9:19.5"` 这种字符串形态 ——
//     经 appcfg 的 float 往返会变成 0.4615，文档主用法就从产物里消失了）。
func TestSeedMultiArtifactAndWindow(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()

	dir := t.TempDir()
	phone := fakeWasm()
	desktop := append(fakeWasm(), []byte("\x00second\x01")...)
	if err := os.WriteFile(filepath.Join(dir, "phone.wasm"), phone, 0o644); err != nil {
		t.Fatalf("写 phone.wasm: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "desktop.wasm"), desktop, 0o644); err != nil {
		t.Fatalf("写 desktop.wasm: %v", err)
	}
	manifest := `{"demos":[
	  {"app_id":"demo-phone","wasm":"phone.wasm","title":"手机演示","description":"d","access":"login",
	   "purpose":"演示","data_sensitivity":"公开","window":{"ratio":"9:19.5","width":420,"height":910}},
	  {"app_id":"demo-desktop","wasm":"desktop.wasm","title":"电脑演示","description":"d","access":"login",
	   "purpose":"演示","data_sensitivity":"内部","window":{"ratio":"16:9"}}
	]}`
	if err := os.WriteFile(filepath.Join(dir, appseed.ManifestFileName), []byte(manifest), 0o644); err != nil {
		t.Fatalf("写清单: %v", err)
	}

	s := newSeeder(t, db, dir)
	if _, err := s.Seed(ctx); err != nil {
		t.Fatalf("Seed: %v", err)
	}

	phoneRel, err := serverstore.LatestApprovedWasmReleaseFull(ctx, db, "demo-phone")
	if err != nil {
		t.Fatalf("查 demo-phone 版本: %v", err)
	}
	desktopRel, err := serverstore.LatestApprovedWasmReleaseFull(ctx, db, "demo-desktop")
	if err != nil {
		t.Fatalf("查 demo-desktop 版本: %v", err)
	}
	if bytes.Equal(phoneRel.Wasm, desktopRel.Wasm) {
		t.Fatal("两条演示的制品必须各自来自清单指定的那一份（现在看起来读的是同一份）")
	}
	if !bytes.Equal(phoneRel.Wasm, phone) {
		t.Fatal("demo-phone 的制品应是 phone.wasm")
	}
	if !bytes.Equal(desktopRel.Wasm, desktop) {
		t.Fatal("demo-desktop 的制品应是 desktop.wasm")
	}

	phoneApp, err := serverstore.GetWasmApp(ctx, db, "demo-phone")
	if err != nil {
		t.Fatalf("查 demo-phone: %v", err)
	}
	// window 逐字保留字符串形态（"9:19.5" 而不是 0.4615）。
	if !strings.Contains(phoneApp.ConfigJSON, `"ratio":"9:19.5"`) {
		t.Fatalf("配置里应逐字保留 \"9:19.5\"（作者手写形态），得到 %s", phoneApp.ConfigJSON)
	}
	cfg, perr := appcfg.Parse([]byte(phoneApp.ConfigJSON))
	if perr != nil {
		t.Fatalf("播种出的配置应能过 appcfg.Parse: %v", perr)
	}
	if cfg.Window == nil || cfg.Window.Width != 420 || cfg.Window.Height != 910 {
		t.Fatalf("窗口尺寸应落进配置，得到 %+v", cfg.Window)
	}
	// 解析后的 ratio 是 9/19.5 ≈ 0.4615（与"手机竖屏"一致）。
	if ratio := cfg.Window.Ratio; ratio < 0.46 || ratio > 0.47 {
		t.Fatalf("9:19.5 应折算成 ≈0.4615，得到 %v", ratio)
	}
}

// TestSeedRejectsOutOfRangeWindow：窗口比例越界必须在**播种前**就被 appcfg 拒掉
// （清单是人手写的，写错一个小数点就让应用开不出窗口 —— 不能等客户端才发现）。
func TestSeedRejectsOutOfRangeWindow(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "app.wasm"), fakeWasm(), 0o644); err != nil {
		t.Fatalf("写 app.wasm: %v", err)
	}
	manifest := `{"demos":[{"app_id":"demo-bad","title":"越界","description":"d","access":"login",
	  "purpose":"演示","data_sensitivity":"内部","window":{"ratio":"1:9"}}]}`
	if err := os.WriteFile(filepath.Join(dir, appseed.ManifestFileName), []byte(manifest), 0o644); err != nil {
		t.Fatalf("写清单: %v", err)
	}
	if _, err := appseed.New(appseed.Options{DB: db, DataRoot: t.TempDir(), Dir: dir, Owner: "admin"}); err != nil {
		// New 不校验配置也没关系：播种必须失败。
		t.Logf("New 直接拒了（也可以）：%v", err)
	}
	s := newSeeder(t, db, dir)
	res, err := s.Seed(context.Background())
	// 播种的失败语义是**逐条**的（一条坏清单不该拖住其它演示）：这一条不落库，
	// 而是记进 Skipped 里、由启动日志如实打出来。所以判据是"没播出去 + 理由点名比例"，
	// 不是"Seed 返回 error"（第一版就写错成后者，跑到这里才发现语义不同）。
	if err != nil {
		t.Fatalf("单条配置不合规不该让整个 Seed 失败（其它演示还要照播）：%v", err)
	}
	if len(res.Seeded) != 0 {
		t.Fatalf("比例越界的演示不该被播出去，得到 %v", res.Seeded)
	}
	if len(res.Skipped) != 1 || !strings.Contains(res.Skipped[0].Reason, "window.ratio") {
		t.Fatalf("跳过理由必须点名 window.ratio，得到 %+v", res.Skipped)
	}
	if _, err := serverstore.GetWasmApp(context.Background(), db, "demo-bad"); err == nil {
		t.Fatal("比例越界的演示不该在库里留下应用行")
	}
}

// TestSeedWritesNoAssetsToDisk 是**内存直出**（决策文档
// docs/decisions/2026-09-20-wasm-assets-in-memory.md）的负向判据：播种的落点只有
// PostgreSQL，宿主盘上不允许再出现 `<dataRoot>/apps/<app_id>/assets/<release_id>/`
// 这类**按版本抽取的资源目录**（旧实现写这一份配置，也正是"每个版本都必须有资源目录、
// 缺了请求就 500"那套口径的成因）。
//
// 判据两段（缺一不可）：
//  1. 负向：整个数据根一个条目都不能有（`apps/`、`assets/`、原子写的临时文件都算）；
//  2. 正向：配置仍然交付 —— 它住在库内 `app_releases.config_json`（运行期由应用平台注入
//     内存资源集，应用自己 `assets.read("picoaide.app.json")` 仍读得到），且能过 appcfg.Parse。
func TestSeedWritesNoAssetsToDisk(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	dataRoot := t.TempDir()
	s := newSeederIn(t, db, writeDemoDir(t), dataRoot)

	res, err := s.Seed(ctx)
	if err != nil {
		t.Fatalf("Seed: %v", err)
	}
	if len(res.Seeded) != 3 {
		t.Fatalf("应播种 3 个演示，得到 %v（跳过：%+v）", res.Seeded, res.Skipped)
	}
	// ① 负向断言：宿主盘上什么都没有。
	assertNothingWrittenToDataRoot(t, dataRoot)
	for _, appID := range res.Seeded {
		app, err := serverstore.GetWasmApp(ctx, db, appID)
		if err != nil {
			t.Fatalf("GetWasmApp(%s): %v", appID, err)
		}
		// 逐条点名历史形态的路径（失败信息里直接给出来，一眼看懂违了什么）。
		forbidden := filepath.Join(dataRoot, "apps", appID, "assets",
			strconv.FormatInt(app.CurrentReleaseID, 10), "picoaide.app.json")
		if _, serr := os.Stat(forbidden); !os.IsNotExist(serr) {
			t.Fatalf("宿主盘上出现了按版本抽取的资源目录（%s）：stat err=%v", forbidden, serr)
		}
		// ② 正向：配置在库内（唯一权威）。
		rel, err := serverstore.LatestApprovedWasmReleaseFull(ctx, db, appID)
		if err != nil {
			t.Fatalf("LatestApprovedWasmReleaseFull(%s): %v", appID, err)
		}
		if rel.ConfigJSON != app.ConfigJSON {
			t.Fatalf("%s 的库内配置与应用行不一致：\nrel=%q\napp=%q", appID, rel.ConfigJSON, app.ConfigJSON)
		}
		if _, perr := appcfg.Parse([]byte(rel.ConfigJSON)); perr != nil {
			t.Fatalf("%s 的库内配置不可解析（运行期注入内存资源集会失败）：%v", appID, perr)
		}
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
	// DataRoot 为空同样是装配缺陷。⚠️ 本字段在 appseed 内**已没有读者**（随包资源改内存
	// 直出），校验保留只是"保守处理"：启动接线与测试都按平台数据根装配，删字段会波及它们
	// （见 Options.DataRoot 的注释）。
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

// TestSeedHealsMissingCurrentRelease 是 **R1-rt-19** 的护栏（2026-09-20 按内存直出后的
// 库内口径改写）。
//
// 缺陷现场（旧顺序 `SetWasmAppCurrentRelease` → 写资源目录）：交付物写失败时库里留下一个
// **已经指向不存在交付物**的应用（旧模型下子域每请求 500），而播种判据是"库里是否已有该
// app_id" ⇒ **重启也不自愈**，只能人工删行。内存直出后"交付物"就是版本行本身，同一形态
// 退化为：应用行 + 版本行都在，但 `current_release_id = 0`（没有生效版本 —— 请求路径按
// 404 的"无生效版本"处理，应用打不开）。
//
// 现场构造（不再依赖"制造写盘失败"：播种已经不写盘）：正常播种后把 current_release_id
// 归零，等价于播种在"置当前版本"那一步之前中断。
//
// 判据三段（缺一不可）：
//  1. 重跑播种必须自愈：current_release_id 指向我们那一版，且**不新建**版本行；
//  2. 处置结论必须如实：SkipReason.Healed=true 且理由点名"缺生效版本"；
//  3. 第三次播种完全幂等（Healed=false），应用行不被改写、宿主盘上仍然什么都没有。
//
// 变异验证（实测）：把 healIncomplete 的调用换回"存在即跳过"（旧行为）⇒ 第 1 段必红。
func TestSeedHealsMissingCurrentRelease(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	dataRoot := t.TempDir()
	s := newSeederIn(t, db, writeDemoDir(t), dataRoot)

	if _, err := s.Seed(ctx); err != nil {
		t.Fatalf("首次播种: %v", err)
	}
	const appID = "demo-public"
	before, err := serverstore.GetWasmApp(ctx, db, appID)
	if err != nil {
		t.Fatalf("GetWasmApp: %v", err)
	}
	if before.CurrentReleaseID <= 0 {
		t.Fatal("前置条件失败：首次播种应当有生效版本")
	}

	// ---- 制造半成品：有版本行、没有生效版本 ----
	if _, err := db.ExecContext(ctx, `UPDATE apps SET current_release_id = 0 WHERE app_id = $1`, appID); err != nil {
		t.Fatalf("归零 current_release_id: %v", err)
	}

	// ---- 重跑播种：必须自愈 ----
	res, err := s.Seed(ctx)
	if err != nil {
		t.Fatalf("二次播种: %v", err)
	}
	if len(res.Seeded) != 0 {
		t.Fatalf("应用行已存在 ⇒ 不得重新播种（否则版本号会撞唯一约束），得到 %v", res.Seeded)
	}
	app, err := serverstore.GetWasmApp(ctx, db, appID)
	if err != nil {
		t.Fatalf("GetWasmApp: %v", err)
	}
	if app.CurrentReleaseID <= 0 {
		t.Fatalf("半成品没有自愈：current_release_id 仍为 0（这正是「重启不自愈」的现场；"+
			"seeded=%v skipped=%+v）", res.Seeded, res.Skipped)
	}
	rels, err := serverstore.ListWasmReleases(ctx, db, appID, false)
	if err != nil {
		t.Fatalf("ListWasmReleases: %v", err)
	}
	if len(rels) != 1 {
		t.Fatalf("版本行数 = %d，应为 1（补齐只置生效版本，不新建版本）", len(rels))
	}
	if rels[0].ID != app.CurrentReleaseID {
		t.Fatalf("current_release_id=%d 必须指向既有的那一版 %d", app.CurrentReleaseID, rels[0].ID)
	}
	// ② 处置结论必须如实（Healed 是机器可读的"动了手"事实，理由点名缺的是什么）。
	sk, ok := skippedHealed(res, appID)
	if !ok {
		t.Fatalf("二次播种没有 %s 的处置结论：%+v", appID, res.Skipped)
	}
	if !sk.Healed {
		t.Fatalf("缺生效版本的半成品必须被自愈（Healed=true），得到 %+v", sk)
	}
	if !strings.Contains(sk.Reason, "缺生效版本") {
		t.Fatalf("理由必须点名「缺生效版本」，得到 %q", sk.Reason)
	}
	// 应用行不得被改写（补齐不是"重新播种"）。
	if app.Owner != before.Owner || app.Title != before.Title || app.ConfigJSON != before.ConfigJSON {
		t.Fatalf("补齐不得改写应用行：before=%+v after=%+v", before, app)
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
	assertNothingWrittenToDataRoot(t, dataRoot)
}

// ===== 第二轮对抗式审计（诊断与播种区域 R2-DG-4/5/6）的行为级护栏 =====

// TestSeedHealsAppRowWithoutAnyRelease 守住 R2-DG-4：**apps 行已落、一个版本行都没有**
// 这种半成品必须自愈（旧实现把它当"不是我们播的"跳过 ⇒ 应用永久没有可交付版本，
// 而日志给的理由是误导性的"已存在"；触发条件 = 首次启动时 CreateWasmRelease 失败）。
//
// 现场构造（与真实失败点同形）：正常播种后删掉该应用的**全部版本行**并把
// current_release_id 归零 —— 这正是 seedOne 在 "UpsertWasmApp 成功、CreateWasmRelease
// 失败" 之后留在库里的状态（应用行/归属/配置齐备，版本什么都没有）。资源目录已不再存在
// （2026-09-20 内存直出），夹具只需动库内两行。
//
// 判据（三段）：
//  1. 重跑播种后必须补出**恰好一条** approved 版本行，且 current_release_id 指向它；
//  2. 补齐的版本行必须带制品字节与库内配置（运行期注入内存资源集、应用自己
//     `assets.read("picoaide.app.json")` 读的都是它）；
//  3. 应用行不得被改写（标题/归属/配置不变）—— 补齐不是"重新播种"；宿主盘上仍什么都没有。
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
	// ---- 制造"A 半成品"：版本行全没、current 归零 ----
	if _, err := db.ExecContext(ctx, `DELETE FROM app_releases WHERE app_id = $1`, appID); err != nil {
		t.Fatalf("删除版本行: %v", err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE apps SET current_release_id = 0 WHERE app_id = $1`, appID); err != nil {
		t.Fatalf("归零 current_release_id: %v", err)
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
	// 补齐的版本行必须带库内配置（运行期注入内存资源集的那一份），且与应用行一致。
	if full.ConfigJSON != app.ConfigJSON {
		t.Fatalf("补齐的版本行配置必须与应用行逐字节相同：\nrel=%q\napp=%q", full.ConfigJSON, app.ConfigJSON)
	}
	if _, perr := appcfg.Parse([]byte(full.ConfigJSON)); perr != nil {
		t.Fatalf("补齐的版本行配置不可解析（运行期注入内存资源集会失败）：%v", perr)
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
	// 补齐同样只在库里动手：宿主盘上仍然什么都没有。
	assertNothingWrittenToDataRoot(t, dataRoot)
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
// 判据（行为级 + 库内）：三种状态下都先把它造成"最像半成品"的形态 —— 版本行删光、
// current_release_id 归零 —— 再跑播种：**一个字节的库内行都不许补回来**
// （current_release_id 仍为 0、版本行仍为 0），且处置结论里 Healed 必须为 false。
//
// 为什么这条产品语义**不随磁盘消失**（2026-09-20）：旧注释的动机是"下架 + 腾磁盘后重启
// 会把资源目录写回来"，而播种现在根本不写盘；留下的是纯粹的产品语义 —— 这三种态表达
// "不要再服务它"，播种不碰（R2-DG-5）。代价照旧认账：下架期间不补，管理员重新上架后
// 下一次播种才补齐。
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
			// 造成"最像半成品"的形态：版本行全没 + 没有生效版本（非退役态下这一定会被补）。
			if _, err := db.ExecContext(ctx, `DELETE FROM app_releases WHERE app_id = $1`, "demo-public"); err != nil {
				t.Fatalf("删除版本行: %v", err)
			}
			if _, err := db.ExecContext(ctx, `UPDATE apps SET current_release_id = 0 WHERE app_id = $1`, "demo-public"); err != nil {
				t.Fatalf("归零 current_release_id: %v", err)
			}
			tc.retire(t, db, "demo-public")

			res, err := s.Seed(ctx)
			if err != nil {
				t.Fatalf("二次播种: %v", err)
			}
			app, err := serverstore.GetWasmApp(ctx, db, "demo-public")
			if err != nil {
				t.Fatalf("GetWasmApp: %v", err)
			}
			if app.CurrentReleaseID != 0 {
				t.Fatalf("%s 的应用被补齐了生效版本（current_release_id=%d）：「删了不再回来」被破坏",
					tc.name, app.CurrentReleaseID)
			}
			rels, lerr := serverstore.ListWasmReleases(ctx, db, "demo-public", true)
			if lerr != nil {
				t.Fatalf("ListWasmReleases: %v", lerr)
			}
			if len(rels) != 0 {
				t.Fatalf("%s 的应用被补了 %d 条版本行：「删了不再回来」被破坏", tc.name, len(rels))
			}
			for _, sk := range res.Skipped {
				if sk.Healed {
					t.Fatalf("%s 的应用被当成半成品补齐了（「删了不再回来」被破坏）：%+v", tc.name, sk)
				}
			}
			assertNothingWrittenToDataRoot(t, dataRoot)
		})
	}
}

// ===== 第三轮对抗式审计 C 区（P3-4）的两条用例：已随磁盘判据删除（2026-09-20）=====
//
// 原用例 `TestSeedHealsTruncatedReleaseConfig`（磁盘配置被截断到一半/差一字节 ⇒ 二次播种
// 重写成完整配置、走原子替换）与 `TestSeedRewritesConfigWithForeignOwner`（磁盘配置的归属人
// 与随安装清单不一致 ⇒ 重写）判的都是**磁盘副本的内容完整性**。随包资源改内存直出后
// （决策文档 docs/decisions/2026-09-20-wasm-assets-in-memory.md）盘上不再有配置副本：
// 配置的唯一权威是库内 `app_releases.config_json`，它的合法性与必填字段由发布链路
// （appcfg 校验、审核不变量）与库内快照保证，播种既不写它也不修它 —— "存在但被截断"
// 这一类平台故障随之消失（决策文档 §3 失败语义：新的平台故障只剩"生效版本的 wasm/配置
// 读不出来"，仍是可读信封的 500）。因此这两条用例**整条删除**而不是改写，取而代之的库内判据是：
//
//   - 配置在库内、app 行与版本行逐字节一致、且能过 appcfg.Parse：TestSeedWritesNoAssetsToDisk
//     与 TestSeedCreatesThreeAccessModes；
//   - "归属人/配置是内容判据"这一半仍活在 A 形态（无版本行）的自愈里：
//     TestSeedRefusesForeignAppWithoutReleases；
//   - 半成品自愈的库内形态：TestSeedHealsMissingCurrentRelease / TestSeedHealsAppRowWithoutAnyRelease。

// ===== W4（2026-09-19「客户端专属」改造）的护栏：库内 access 归一化 + heal 不覆盖标题 =====

// 导出签名是**启动接线（cmd/server/wasmapp_demo.go）依赖的契约**：改签名必须同时改接线，
// 这里用编译期断言把两者钉在一起（`dataRoot` 形参已不再使用，但为不改接线而保留 ——
// 见 appseed.RewritePublicAccessAssets 的注释）。
var _ func(context.Context, *sql.DB, string, func(string, ...any)) (appseed.AssetRewriteResult, error) = appseed.RewritePublicAccessAssets

// releaseConfigOf 取某个演示**生效版本**的库内配置（2026-09-20 起配置的唯一权威在库内）。
func releaseConfigOf(t *testing.T, ctx context.Context, db *sql.DB, appID string) string {
	t.Helper()
	app, err := serverstore.GetWasmApp(ctx, db, appID)
	if err != nil {
		t.Fatalf("GetWasmApp(%s): %v", appID, err)
	}
	rels, err := serverstore.ListWasmReleases(ctx, db, appID, true)
	if err != nil {
		t.Fatalf("ListWasmReleases(%s): %v", appID, err)
	}
	for _, rel := range rels {
		if rel.ID == app.CurrentReleaseID {
			return rel.ConfigJSON
		}
	}
	t.Fatalf("%s 没有生效版本行（current_release_id=%d）：%+v", appID, app.CurrentReleaseID, rels)
	return ""
}

// TestRewritePublicAccessAssetsRewritesPublicInLibrary 是 W4-6「库内 access 归一化」的判据
// （2026-09-20 按内存直出后的口径改写：磁盘那一半已随资源目录一起删除）。
//
// 为什么必须改：内存直出后应用 `assets.read` 读到的配置就是运行期用
// `app_releases.config_json` 注入内存资源集的那一份。读侧虽已把 public 映射为 login，
// 但配置里的 public 会让应用可能自行实现一套"匿名可用"行为（设计 §9 事实订正 ②）；
// 库内是唯一还留着 public 的地方，不改就永远不干净。
//
// 判据六段：
//  1. 命中行改写：只替换 access 的值，其余字节**逐字保留**（键序/空白/其它键都不动）；
//  2. 未命中的行（login/whitelist）一个字节都不写；
//  3. **DB 行是唯一落点**：应用真正读到的那一份就是版本行；
//  4. **范围声明**：本入口不改 `apps` 行的 config_json（目录投影，与迁移 0074 的分工见函数注释）；
//  5. 统计与日志可见（改写了哪一行、跳过了多少行）；
//  6. 幂等：第二次 0 命中、字节不变；装配缺陷（nil DB）必须报错。
func TestRewritePublicAccessAssetsRewritesPublicInLibrary(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	dataRoot := t.TempDir()
	s := newSeederIn(t, db, writeDemoDir(t), dataRoot)
	if _, err := s.Seed(ctx); err != nil {
		t.Fatalf("Seed: %v", err)
	}

	before := releaseConfigOf(t, ctx, db, "demo-public")
	if appcfg.AccessOfConfigJSON(before) != appcfg.AccessPublic {
		t.Fatalf("前置条件失败：demo-public 的库内配置应当是 public，得到 %q", before)
	}
	pubApp, err := serverstore.GetWasmApp(ctx, db, "demo-public")
	if err != nil {
		t.Fatalf("GetWasmApp: %v", err)
	}
	loginBefore := releaseConfigOf(t, ctx, db, "demo-login")

	var logs []string
	res, err := appseed.RewritePublicAccessAssets(ctx, db, dataRoot, func(format string, args ...any) {
		logs = append(logs, fmt.Sprintf(format, args...))
	})
	if err != nil {
		t.Fatalf("RewritePublicAccessAssets: %v", err)
	}
	if res.Apps != 3 || res.Releases != 3 || res.Files != 3 || res.Rewritten != 1 ||
		res.Missing != 0 || res.Skipped != 0 || len(res.Problems) != 0 {
		t.Fatalf("统计不对（应 3 应用/3 版本行/3 可解析/1 改写/0 跳过）：%+v", res)
	}

	// ① 只改 access 的值：其余字节逐字保留（紧凑形态）。
	after := releaseConfigOf(t, ctx, db, "demo-public")
	want := strings.Replace(before, `"access":"public"`, `"access":"login"`, 1)
	if after != want {
		t.Fatalf("改写必须只动 access 一个值（其余键逐字保留）：\n got=%q\nwant=%q", after, want)
	}
	if appcfg.AccessOfConfigJSON(after) != appcfg.AccessLogin {
		t.Fatalf("改写后应当是 login：%q", after)
	}
	// ② 未命中的行一个字节都不写。
	if loginAfter := releaseConfigOf(t, ctx, db, "demo-login"); loginAfter != loginBefore {
		t.Fatalf("非 public 的配置不得被改写：\n got=%q\nwant=%q", loginAfter, loginBefore)
	}
	// ③④ 落点是版本行；apps 行（目录投影）不在本入口内 —— 那是迁移 0074 的职责。
	dbApp, err := serverstore.GetWasmApp(ctx, db, "demo-public")
	if err != nil {
		t.Fatalf("GetWasmApp: %v", err)
	}
	if dbApp.ConfigJSON != pubApp.ConfigJSON {
		t.Fatalf("本入口只改版本行，不得改 apps 行（apps 行归迁移 0074）：\n got=%q\nwant=%q",
			dbApp.ConfigJSON, pubApp.ConfigJSON)
	}
	// ⑤ 日志里必须能看见"改写了哪一行"（跳过数量与改写明细都是诊断面）。
	if joined := strings.Join(logs, "\n"); !strings.Contains(joined, "已由 public 收敛为 login") {
		t.Fatalf("改写必须记日志（否则线上无从判断这一轮做了什么）：%v", logs)
	}
	// ⑥ 幂等：第二次 0 命中、字节不变。
	res2, err := appseed.RewritePublicAccessAssets(ctx, db, dataRoot, nil)
	if err != nil {
		t.Fatalf("二次改写: %v", err)
	}
	if res2.Rewritten != 0 || res2.Skipped != 0 || res2.Files != 3 {
		t.Fatalf("二次改写必须 0 命中（幂等）：%+v", res2)
	}
	if again := releaseConfigOf(t, ctx, db, "demo-public"); again != after {
		t.Fatalf("幂等被破坏：\n first=%q\nsecond=%q", after, again)
	}
	// 装配缺陷（nil DB）必须报错 —— 否则会静默"什么都没做"。
	if _, err := appseed.RewritePublicAccessAssets(ctx, nil, dataRoot, nil); err == nil {
		t.Fatal("DB 为空必须报错")
	}
	// 本入口不触盘：dataRoot 形参保留只是为了不改启动接线。
	assertNothingWrittenToDataRoot(t, dataRoot)
}

// TestRewritePublicAccessAssetsSkipsBrokenButKeepsGoing：单行配置不可解析 ⇒ **跳过并计数、
// 不 panic、不中断整轮**（W4-6 的失败语义；2026-09-20 按库内口径改写）。
//
// 三种现场一次构造（都直接改库，模拟历史行 / 被手工改坏的行）：
//   - demo-public   ：jsonb 空格形态（`{"access": "public", …}`）⇒ 必须被改写
//     （**字面 REPLACE 会漏掉它**，这正是 A 方案走 JSON 解析的理由）；
//   - demo-login    ：坏 JSON ⇒ 跳过并计数（行不得被覆盖/删除）；
//   - demo-whitelist：config_json 为空 ⇒ Missing（不是失败，单独计数）。
//
// 关键判据是"坏行之后的那个应用仍然被处理"（不中断整轮）+ 跳过数量出现在日志里。
func TestRewritePublicAccessAssetsSkipsBrokenButKeepsGoing(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	dataRoot := t.TempDir()
	s := newSeederIn(t, db, writeDemoDir(t), dataRoot)
	if _, err := s.Seed(ctx); err != nil {
		t.Fatalf("Seed: %v", err)
	}

	setReleaseConfig := func(appID, cfg string) {
		t.Helper()
		if _, err := db.ExecContext(ctx,
			`UPDATE app_releases SET config_json = $1 WHERE app_id = $2`, cfg, appID); err != nil {
			t.Fatalf("写 %s 的版本配置: %v", appID, err)
		}
	}
	// 现场：空格形态 / 坏 JSON / 空配置。
	setReleaseConfig("demo-public", `{"access": "public", "purpose": "匿名可达", "owner": "admin"}`)
	setReleaseConfig("demo-login", `{not json`)
	setReleaseConfig("demo-whitelist", "")

	var logs []string
	res, err := appseed.RewritePublicAccessAssets(ctx, db, dataRoot, func(format string, args ...any) {
		logs = append(logs, fmt.Sprintf(format, args...))
	})
	if err != nil {
		t.Fatalf("单行失败不得让整轮报错: %v", err)
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
	// 坏行不得被覆盖/删除（跳过就是跳过）。
	if broken := releaseConfigOf(t, ctx, db, "demo-login"); broken != `{not json` {
		t.Fatalf("坏 JSON 行不得被改动：%q", broken)
	}
	// 空格形态必须被精确改写（字面 REPLACE 会漏掉它）。
	after := releaseConfigOf(t, ctx, db, "demo-public")
	if after != `{"access": "login", "purpose": "匿名可达", "owner": "admin"}` {
		t.Fatalf("空格形态必须被改写且其余键逐字保留：%q", after)
	}
	// 空配置的行保持为空（Missing 是"本来就没有"，不许被填值）。
	if empty := releaseConfigOf(t, ctx, db, "demo-whitelist"); empty != "" {
		t.Fatalf("config_json 为空的行不得被写入：%q", empty)
	}
	// 跳过数量必须出现在日志里（调用方据此发现问题）。
	if joined := strings.Join(logs, "\n"); !strings.Contains(joined, "跳过 1 行") {
		t.Fatalf("跳过数量必须记日志：%v", logs)
	}
}

// TestSeedDoesNotOverwriteTitleOnExistingRows 钉住 **W4-7 的 appseed 半边**：
// heal **不得覆盖标题**（标题以库里既有行为准；只有**新建行**才写 demos.json 的标题）。
//
// 为什么需要这条（现状已满足，但要钉死）：W4-7 改了 `server/demoapps/demos.json` 的口径
// （access 收敛 login、标题去掉"匿名可达"）。演示应用**保留 app_id**（历史行里有既存数据：
// 归属、版本行、管理员改过的标题），所以清单文案的变化**只对新建行生效** ——
// 若哪一天有人在 heal 里顺手补一句"把标题同步成清单里的"，客户场上已被改名的演示会被
// 静默改回去（而这不是"修复半成品"）。
//
// 判据三段：
//  1. 换一份清单（demo-public 的标题/描述/access 全变）重播 ⇒ 已存在行的
//     title/description/config_json **一个都不变**，版本行的 config_json 也**没被重写**；
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
	before, err := serverstore.GetWasmApp(ctx, db, "demo-public")
	if err != nil {
		t.Fatalf("GetWasmApp: %v", err)
	}
	origRelCfg := releaseConfigOf(t, ctx, db, "demo-public")

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
	// 版本行的 config_json（运行期注入内存资源集的那一份）也不得被重写。
	if now := releaseConfigOf(t, ctx, db, "demo-public"); now != origRelCfg {
		t.Fatalf("已存在行的版本配置被重写了：\n got=%q\nwant=%q", now, origRelCfg)
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
	if cfg := releaseConfigOf(t, ctx, db, "demo-added"); cfg != added.ConfigJSON {
		t.Fatalf("新建行的版本配置必须与 app 行一致：\n rel=%q\n app=%q", cfg, added.ConfigJSON)
	}
	// 播种仍然一个字节都不写盘（清单里新加的那条也一样）。
	assertNothingWrittenToDataRoot(t, dataRoot)
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
