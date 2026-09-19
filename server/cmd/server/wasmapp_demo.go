package main

import (
	"context"
	"database/sql"
	"log"
	"os"
	"strings"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/appseed"
)

// 本文件是「内置演示应用」的启动播种入口（2026-09-19 用户要求：仓库里要有几个
// 不同权限模式的 demo，装完即可给客户演示，且可以删除）。
//
// 分工：制品与清单随镜像分发（`/opt/picoaide/demo-apps/{app.wasm,demos.json}`，
// 由 Dockerfile 构建），播种逻辑在 internal/wasmapp/appseed；本文件只负责
// 「找到归属人 → 调用播种 → 记日志」。
//
// 为什么归属人取"最早的超管"：apps.owner 决定谁能管理它（发布新版/删除），
// 演示应用需要一个**真实存在**的账号作为归属；没有超管时静默跳过（播种失败不该
// 影响服务启动，日志里说清楚）。
const (
	// EnvDemoAppsDir 覆盖演示目录（缺省 = 镜像内路径；源码构建没有该目录时自动跳过）。
	EnvDemoAppsDir = "PICOAI_DEMO_APPS_DIR"
	// defaultDemoAppsDir 是镜像内演示目录（Dockerfile 的 COPY 目标）。
	defaultDemoAppsDir = "/opt/picoaide/demo-apps"
)

// seedDemoApps 播种内置演示应用；任何失败都只记日志（不影响服务启动）。
func seedDemoApps(ctx context.Context, db *sql.DB, dataRoot string) {
	// W4（设计 §9 的 A 方案）：先把**磁盘资产**里残留的 access=public 一次性收敛为 login。
	// 放在最前面、且在演示目录的任何提前返回之前：它与"镜像里有没有演示目录"无关 ——
	// 库里任何 wasm 应用的资源目录里留着 public 都要退场（DB 侧由迁移 0074 同批改写；
	// 只改一侧就会出现"库说 login、应用自己读到 public"的分叉）。
	rewritePublicAccessAssets(ctx, db, dataRoot)

	dir := strings.TrimSpace(os.Getenv(EnvDemoAppsDir))
	if dir == "" {
		dir = defaultDemoAppsDir
	}
	owner := firstSuperAdmin(ctx, db)
	if owner == "" {
		log.Printf("appseed: 没有可用的超管账号，跳过内置演示应用播种（目录 %s）", dir)
		return
	}
	seeder, err := appseed.New(appseed.Options{
		DB:       db,
		DataRoot: dataRoot,
		Dir:      dir,
		Owner:    owner,
		Logger:   log.Printf,
		// 复用 serverstore 的审计入口（哈希链在它里面；直接 INSERT 会断链）。
		Audit: func(username, action, detail string) { _ = serverstore.AuditLog(db, username, action, detail) },
	})
	if err != nil {
		log.Printf("appseed: ⚠️ 演示应用装载失败（跳过播种）：%v", err)
		return
	}
	if seeder == nil {
		log.Printf("appseed: 演示目录不存在或清单为空（%s），跳过播种", dir)
		return
	}
	// W4（设计 §9）：**存量**演示应用的标题一次性收敛到清单口径。
	//
	// 为什么必须紧挨着播种之前做：`Seed` 对已存在的行跳过、`healIncomplete` 按口径
	// **不覆盖标题**（否则管理员改过的标题每次启动都会回滚）⇒ 清单改标题对存量部署
	// 完全无效，只能靠这条一次性改写。它读清单（`seeder.Demos()`），因此天然在
	// "演示目录存在"之后 —— 目录不存在时既没有新播种、也没有可对齐的清单。
	rewriteLegacyDemoTitles(ctx, seeder)

	res, err := seeder.Seed(ctx)
	if err != nil {
		log.Printf("appseed: ⚠️ 播种失败（其余功能正常）：%v", err)
		return
	}
	if len(res.Seeded) > 0 {
		log.Printf("appseed: 已播种 %d 个内置演示应用：%v（归属 %s；删除后不会重建）",
			len(res.Seeded), res.Seeded, owner)
	}
	for _, sk := range res.Skipped {
		log.Printf("appseed: 跳过 %s（%s）", sk.AppID, sk.Reason)
	}
}

// rewritePublicAccessAssets 是 appseed.RewritePublicAccessAssets 的启动接线。
//
// 失败处置与播种一致：**只记日志、不影响服务启动**（跳过数量必须可见 —— 这一轮是
// 幂等的运维兜底动作，下一次启动会重扫；静默跳过会让人以为"已经改完了"）。
func rewritePublicAccessAssets(ctx context.Context, db *sql.DB, dataRoot string) {
	res, err := appseed.RewritePublicAccessAssets(ctx, db, dataRoot, log.Printf)
	if err != nil {
		log.Printf("appseed: ⚠️ 磁盘资产 access 归一化未执行（不影响服务启动）：%v", err)
		return
	}
	log.Printf("appseed: 磁盘资产 access 归一化完成：应用 %d / 版本 %d / 可解析配置 %d / 改写 %d / 缺文件 %d / 跳过 %d",
		res.Apps, res.Releases, res.Files, res.Rewritten, res.Missing, res.Skipped)
}

// rewriteLegacyDemoTitles 是 appseed.RewriteLegacyDemoTitles 的启动接线。
//
// 失败处置与播种一致：**只记日志、不影响服务启动**。计数必须可见（改写 / 刻意不动 /
// 库里没有）—— 静默跳过会让人以为"已经对齐了"。
func rewriteLegacyDemoTitles(ctx context.Context, seeder *appseed.Seeder) {
	res, err := appseed.RewriteLegacyDemoTitles(ctx, seeder, log.Printf)
	if err != nil {
		log.Printf("appseed: ⚠️ 演示标题对齐未执行（不影响服务启动）：%v", err)
		return
	}
	log.Printf("appseed: 演示标题对齐完成：清单 %d 条 / 改写 %d / 保留管理员标题 %d / 库里没有 %d / 失败 %d",
		res.Examined, res.Rewritten, res.Kept, res.Missing, len(res.Problems))
}

// firstSuperAdmin 返回最早创建的启用超管用户名（没有则空串）。
func firstSuperAdmin(ctx context.Context, db *sql.DB) string {
	if db == nil {
		return ""
	}
	var name string
	err := db.QueryRowContext(ctx,
		`SELECT username FROM users WHERE role = 'super_admin' AND status = 1 ORDER BY id LIMIT 1`).Scan(&name)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(name)
}
