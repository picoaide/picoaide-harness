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
