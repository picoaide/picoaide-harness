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
		rel, err := serverstore.LatestApprovedWasmRelease(ctx, db, appID)
		if err != nil {
			t.Fatalf("LatestApprovedWasmRelease(%s): %v", appID, err)
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
