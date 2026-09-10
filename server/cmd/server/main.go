package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/bootstrap"
	"github.com/picoaide/picoaide/internal/capabilities"
	"github.com/picoaide/picoaide/internal/channel"
	"github.com/picoaide/picoaide/internal/clientrelease"
	"github.com/picoaide/picoaide/internal/connectors"
	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/portal"
	"github.com/picoaide/picoaide/internal/reports"
	"github.com/picoaide/picoaide/internal/router"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/sharedskills"
	"github.com/picoaide/picoaide/internal/telemetry"
	"github.com/picoaide/picoaide/internal/updatecheck"
	"github.com/picoaide/picoaide/internal/util"
	"github.com/picoaide/picoaide/webadmin"
)

// version is injectable at build time: go build -ldflags "-X main.version=x.y.z"
var version = "dev"

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	dataDir := flag.String("data", "./data", "data directory (app data, not the DB — PG is external)")
	dbDriver := flag.String("db-driver", "pg", "database backend: pg (default) or pg-external (alias)")
	pgDSN := flag.String("pg-dsn", "", "PostgreSQL connection string (required, e.g. postgres://user:pass@host:5432/db)")
	bootstrapAdmin := flag.String("bootstrap-admin", "", "username of the initial admin (password from PICOAI_ADMIN_PASSWORD)")
	resetMFA := flag.String("reset-mfa", "", "clear MFA for an admin username and revoke all their sessions (operation mode, no server started)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	if *dbDriver != "pg" && *dbDriver != "pg-external" {
		log.Fatalf("unsupported -db-driver %q (want pg)", *dbDriver)
	}
	if *pgDSN == "" {
		log.Fatal("-pg-dsn is required (PostgreSQL only since 2026-08)")
	}
	// server-info 上报与版本检查使用与 --version 同一版本(单一来源)。
	serverauth.SetBuildVersion(version)
	cfg := serverstore.DBConfig{
		Driver: serverstore.DriverName(*dbDriver),
		DSN:    *pgDSN,
	}
	db, err := serverstore.EnsureMigrated(cfg)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	// --reset-mfa: 运维兜底操作模式(唯一超管丢失验证器场景, 规划 2026-09-04)。
	// 清空目标的 TOTP 配置并吊销其全部会话; 完成即退出, 不启动 HTTP。
	if *resetMFA != "" {
		u, err := serverstore.GetUserByUsername(db, *resetMFA)
		if err != nil {
			log.Fatalf("reset-mfa: user %q not found: %v", *resetMFA, err)
		}
		if !u.TotpEnabled && u.TotpSecret == "" {
			log.Printf("reset-mfa: user %q has no MFA configured; nothing to reset", *resetMFA)
			return
		}
		if err := serverstore.ClearUserMFA(db, u.ID); err != nil {
			log.Fatalf("reset-mfa: %v", err)
		}
		if err := serverstore.RevokeAllUserSessions(db, u.ID); err != nil {
			log.Fatalf("reset-mfa: revoke sessions: %v", err)
		}
		_ = serverstore.AuditLog(db, "cli", "admin_mfa_reset", u.Username+" (CLI --reset-mfa)")
		log.Printf("reset-mfa: MFA cleared for %q; all its sessions revoked", *resetMFA)
		return
	}

	// 启动账本自愈:补算最近 N 个月(保留窗口)的日账/月账(幂等),随后清理
	// 超出保留期的明细分区(先校验对应月日账已生成,防删明细丢账)。
	if n, rerr := serverstore.EffectiveRetentionMonths(db); rerr == nil {
		from := time.Now().AddDate(0, -max(n, 6), 0)
		if lerr := serverstore.RebuildUsageLedger(db, from, time.Now()); lerr != nil {
			log.Printf("startup rebuild usage ledger: %v", lerr)
		}
	}
	if cerr := serverstore.CleanupUsageRetention(db); cerr != nil {
		log.Printf("startup cleanup usage retention: %v", cerr)
	}

	if *bootstrapAdmin != "" {
		if err := serverauth.EnsureBootstrapAdmin(db, *bootstrapAdmin); err != nil {
			log.Fatalf("bootstrap admin: %v", err)
		}
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	// 2026-09-08 P1-2:Logger/Recovery 必须在任何路由注册之前挂载。gin 在
	// 注册路由时快照当前中间件链,此前 mountAPIGuards 在 router.Register 之后
	// 才 r.Use(...),导致 162 条 API 路由 panic 时不返回 JSON 信封(直接断连)
	// 且零访问日志(违反 server/AGENTS.md §7.0)。
	installAPIMiddleware(r)
	// 可信代理(审计 2026-08-25 F-02):信任 loopback + 默认 compose
	// 私有网段中的 Caddy(172.28.0.2),使 gin.ClientIP 解析 X-Forwarded-For
	// 得到真实客户端 IP,登录限流键不再坍缩为单一代理 IP(否则 10 次错
	// 密码即可锁死任意用户名——账号级 DoS)。仅从可信代理接受该头:
	// 外部攻击者伪造的 XFF 不会生效,只会被计为 Caddy 本身(更严格)。
	trusted := []string{"127.0.0.1", "::1"}
	if v := os.Getenv("PICOAI_TRUSTED_PROXIES"); v != "" {
		for _, p := range strings.Split(v, ",") {
			if p = strings.TrimSpace(p); p != "" {
				trusted = append(trusted, p)
			}
		}
	}
	if err := r.SetTrustedProxies(trusted); err != nil {
		log.Fatalf("trusted proxies: %v", err)
	}

	if _, err := util.EnsureMasterKey(*dataDir); err != nil {
		log.Fatalf("master key: %v", err)
	}
	// Upstream API keys are AES-GCM encrypted with the master key (Task 1.12).
	llmgateway.DecryptSecret = func(s string) (string, error) {
		key, err := util.GetMasterKey()
		if err != nil {
			return "", err
		}
		return util.Decrypt(key, s)
	}

	// 认证 provider 按 ConfigureProviders 注册:local 恒注册(admin 回退),
	// ldap/oidc/openid 按配置启用;多套 browser(oidc/openid)独立路由
	authCfg := serverauth.NewConfiguredAPI(db)
	auth := authCfg.API
	for _, b := range authCfg.Browsers {
		auth.RegisterBrowser(b)
	}
	// 工程化重构(2026-09): 全部 API 路由集中在 internal/router 包声明——
	// /api/server(管理面) + /api/client/v2(员工面),旧命名空间(/api、/v1、
	// /v2/api、/v2/v1)迁移后不再注册。
	router.Register(r, router.Deps{
		DB:        db,
		Auth:      auth.Handlers(),
		Admin:     (&serverauth.AdminAPI{DB: db}).Handlers(),
		Appstore:  appstore.NewHandlers(db),
		Bootstrap: bootstrap.NewHandlers(db),
		// 客户端安装包随镜像发布:服务端把它所在的镜像目录直接对外提供
		// (GET /api/client/v2/updates/manifest 与 /updates/client/<file>)。
		ClientRelease: clientrelease.NewHandlers(func() string { return version }, updatecheck.ResolveChannel()),
		// 渠道内容随镜像发布(channels/<id>/ → /opt/picoaide/channel/),服务端读文件下发。
		Channel: channel.NewHandlers(),
		// 门户页配置:只管"是否公开 / 下载地址覆盖 / 说明文字"。
		// 站点名与欢迎语来自渠道配置(上一行),因此没有在线编辑名称的入口。
		PortalAdmin: portal.NewAdminHandlers(db),
		Market:      marketplace.NewHandlers(db, *dataDir+"/skills-cache"),
		Agentshare:  agentshare.NewHandlers(db, *dataDir+"/agent-presets-cache"),
		Shared:      sharedskills.NewHandlers(db, *dataDir+"/shared-skills-cache"),
		Capability:  capabilities.NewHandlers(db, *dataDir+"/skills-cache"),
		Connector:   connectors.NewHandlers(db),
		Telemetry:   telemetry.NewHandlers(db),
		Gateway:     llmgateway.NewHandlers(db),
		Reports:     reports.NewHandlers(db),
	})
	// 固定探针(不属于两命名空间)。
	r.GET("/healthz", bootstrap.NewHandlers(db).Health)
	// 审计日志保留策略(v3b: settings audit.retention_days, 默认 180 天;
	// 安全/权限类事件 365 天由应用策略保证, 这里按全局保留清理)。
	retentionDays := 180
	if v, ok, _ := serverstore.GetSetting(db, "audit.retention_days"); ok && v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			retentionDays = n
		}
	}
	if err := serverstore.PurgeOldAuditLogs(db, time.Now().Add(-time.Duration(retentionDays)*24*time.Hour)); err != nil {
		log.Printf("audit log purge: %v", err)
	}
	// 渠道模型自动同步(固定间隔 1 小时;拉取上游 /models 自动上架/下架,
	// 并顺带清理过期的 pending usage 行 — 审计 C-9)
	go llmgateway.SyncLoop(db, time.Hour, nil)
	// LDAP 目录全量同步(固定间隔 1 小时;用户/组自动对账;配置保存时
	// 已触发一轮,此处兜底周期同步——新员工入职/离职/组变化在 1h 内反映)
	go serverauth.SyncDirectoryLoop(db, serverauth.LDAPSyncInterval, nil)

	dist, _ := fs.Sub(webadmin.FS, "dist")
	fileServer := http.FileServer(http.FS(dist))
	mountAPIGuards(r, db, fileServer, dist)

	log.Printf("picoaide-server v%s listening on %s (data=%s)", version, *addr, *dataDir)
	// 显式超时(slowloris/慢体攻击防护);WriteTimeout 需覆盖 SSE 流(空闲流由网关侧
	// 90s idle 判定终止),给足 5 分钟
	srv := &http.Server{
		Addr:              *addr,
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      5 * time.Minute,
		IdleTimeout:       120 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// 月度报表推送调度(2026-09 P1):每小时检查补跑上月报表。
	reports.NewScheduler(db, time.Hour, nil).Start(ctx)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()
	<-ctx.Done()
	log.Println("shutting down…")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

// servePortal 渲染公开门户页(/ 与 /portal):站点名 + 欢迎语 + 客户端下载。
//
// 2026-09-10 重构:门户内容**全部来自渠道配置**(镜像内 channels/<id>/channel.json),
// 不再读 webadmin 的 brand.* / portal.welcome 设置 —— 改内容 = 改渠道配置 → 重新
// 构建镜像,因此内容可审计、可追溯。模板与动效样式在 internal/portal
// (纯 HTML+CSS,零脚本)。
//
// 下载链接默认指向**本服务端**:安装包随服务端镜像发布,由
// GET /updates/client/<file> 下发,门户因此不需要任何外网地址;
// 管理员仍可用 portal.client_download_* 覆盖为自有分发地址。
func servePortal(c *gin.Context, db *sql.DB) {
	settings, _ := serverstore.GetAllSettings(db)
	// portal.public=false 时门户不对外开放, 跳转管理后台登录。
	if settings["portal.public"] == "false" {
		c.Redirect(http.StatusFound, "/admin/")
		return
	}

	ch := channel.Load()
	view := portal.View{
		Name:         ch.Identity.DisplayName,
		Tagline:      ch.Identity.Tagline,
		Welcome:      ch.Copy.PortalWelcome,
		LogoURL:      channelLogoURL(),
		AdminURL:     "/admin/",
		DownloadNote: settings["portal.client_download_note"],
		Version:      version,
		Channel:      updatecheck.ResolveChannel(),
		Downloads:    portalDownloads(settings),
	}

	c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
	// 门户是唯一对未认证访客开放的 HTML 面,补基础安全头。
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("X-Frame-Options", "DENY")
	// 零脚本页面:不放开 script-src(没有 JS 也就没有脚本注入面)。
	c.Header("Content-Security-Policy", "default-src 'none'; img-src 'self' data: https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(portal.Render(view)))
}

// channelLogoURL 返回渠道 logo 的下发地址;渠道未配 logo 时返回空(模板改用文字标识)。
func channelLogoURL() string {
	if channel.LogoPath(false) == "" {
		return ""
	}
	return "/api/client/v2/channel/logo"
}

// portalDownloads 组装三平台下载项。
//
// 默认地址指向**本服务端**的安装包(随镜像发布,见 internal/clientrelease);
// 管理员配置了 portal.client_download_* 时以配置为准(可指向自有 CDN)。
// 两者都没有时该平台显示为不可用(而不是给一个坏链接)。
func portalDownloads(settings map[string]string) []portal.Platform {
	legacy := settings["portal.client_download_url"]

	pick := func(configured string) string {
		if configured != "" {
			return configured
		}
		return legacy
	}
	// 内置地址:/updates/client/<文件名>(文件由 clientrelease 从镜像目录下发)
	builtin := func(assetKey string) string {
		info := clientrelease.LoadInfo()
		if info == nil {
			return ""
		}
		a, ok := info.Client.Assets[assetKey]
		if !ok || a.File == "" {
			return ""
		}
		return "/updates/client/" + a.File
	}

	item := func(name, meta, configured, assetKey string) portal.Platform {
		url := pick(configured)
		if url == "" {
			url = builtin(assetKey)
		}
		if url == "" {
			meta = "该平台暂无可用安装包"
		}
		return portal.Platform{Name: name, Meta: meta, URL: url}
	}

	return []portal.Platform{
		item("Windows", "x64 · .exe 安装程序", settings["portal.client_download_win"], "win-x64"),
		item("macOS", "Universal · .dmg 磁盘映像", settings["portal.client_download_mac"], "mac-universal"),
		item("Linux", "x64 · .AppImage / .deb", settings["portal.client_download_linux"], "linux-x64"),
	}
}

// htmlEscape escapes a string for safe embedding in HTML text/attributes.
func htmlEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")
	return r.Replace(s)
}

// installAPIMiddleware installs the JSON-contract middleware that must be
// registered BEFORE any route (gin snapshots the middleware chain per route):
// access logging + panic recovery into the standard error envelope.
func installAPIMiddleware(r *gin.Engine) {
	r.Use(gin.Logger(), gin.CustomRecoveryWithWriter(gin.DefaultErrorWriter, func(c *gin.Context, _ any) {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "服务端内部错误")
	}))
}

// mountAPIGuards 装配 API JSON 契约的 NoRoute 护栏(审计 2026-09)。
// 中间件由 installAPIMiddleware 在路由注册前安装(P1-2)。
//
//	NoRoute:凡 /api/、/v1/ 前缀(含 405 落 NoRoute 场景)一律 JSON 信封;
//	HTML 面仅保留 /、/portal、/admin/*(产品页面)。
//
// 单独成函数以便 cmd/server 集成测试用与生产完全一致的逻辑断言契约。
func mountAPIGuards(r *gin.Engine, db *sql.DB, fileServer http.Handler, dist fs.FS) {
	r.NoRoute(func(c *gin.Context) {
		p := c.Request.URL.Path
		// 契约(审计 2026-09): 凡客户端/第三方进程 API 前缀(/api/、/v1/),
		// 未匹配路由一律 JSON 错误信封。gin 默认 HandleMethodNotAllowed=false,
		// 405 也会落到这里 —— 统一 JSON,绝不返回 text/html 或空文本。
		// (HTML 面仅 /、/portal、/admin/* 产品页面;其 404 不在此列。)
		if strings.HasPrefix(p, "/api/") || strings.HasPrefix(p, "/v1/") || p == "/api" || p == "/v1" {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "接口不存在")
			return
		}
		if p == "/admin" {
			c.Redirect(http.StatusFound, "/admin/")
			return
		}
		// v3b: 门户首页(未登录默认页)——服务端根路径与 /portal 展示
		// 品牌(login)+欢迎语+客户端下载地址。数据内嵌(public brand+portal)。
		if p == "/" || p == "/portal" {
			servePortal(c, db)
			return
		}
		if len(p) >= 7 && p[:7] == "/admin/" {
			rel := strings.TrimPrefix(p, "/admin")
			if rel == "" {
				rel = "/"
			}
			if strings.HasPrefix(rel, "/assets/") {
				// 性能优化 2026-P: assets 含内容哈希,内容变则文件名变,
				// 浏览器缓存 1 年不重新校验(回访首屏零下载)。
				c.Header("Cache-Control", "public, max-age=31536000, immutable")
				c.Request.URL.Path = rel
				fileServer.ServeHTTP(c.Writer, c.Request)
				return
			}
			// SPA 入口/路由回退:index.html 无哈希,no-cache 保证
			// 每次部署后都能拿到新版本(assets 由文件名哈希保证新鲜)。
			c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
			index, err := dist.Open("index.html")
			if err != nil {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "webadmin 未构建")
				return
			}
			defer index.Close()
			c.DataFromReader(http.StatusOK, -1, "text/html", index, nil)
			return
		}
		// 错误信封契约(审计2026-S37):非 2xx 一律 {"error":{code,message}}
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "接口不存在")
	})
}
