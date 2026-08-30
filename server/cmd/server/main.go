package main

import (
	"context"
	"database/sql"
	"encoding/json"
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
	"github.com/picoaide/picoaide/internal/bootstrap"
	"github.com/picoaide/picoaide/internal/brand"
	"github.com/picoaide/picoaide/internal/capabilities"
	"github.com/picoaide/picoaide/internal/connectors"
	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/router"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/sharedskills"
	"github.com/picoaide/picoaide/internal/telemetry"
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
	cfg := serverstore.DBConfig{
		Driver: serverstore.DriverName(*dbDriver),
		DSN:    *pgDSN,
	}
	db, err := serverstore.EnsureMigrated(cfg)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

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
		DB:         db,
		Auth:       auth.Handlers(),
		Admin:      (&serverauth.AdminAPI{DB: db}).Handlers(),
		Bootstrap:  bootstrap.NewHandlers(db),
		Brand:      brand.NewHandlers(db, *dataDir),
		Market:     marketplace.NewHandlers(db, *dataDir+"/skills-cache"),
		Agentshare: agentshare.NewHandlers(db, *dataDir+"/agent-presets-cache"),
		Shared:     sharedskills.NewHandlers(db, *dataDir+"/shared-skills-cache"),
		Capability: capabilities.NewHandlers(db, *dataDir+"/skills-cache"),
		Connector:  connectors.NewHandlers(db),
		Telemetry:  telemetry.NewHandlers(db),
		Gateway:    llmgateway.NewHandlers(db),
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

// servePortal renders the public portal page (v3b): brand login config +
// portal welcome + client download URL, served at / and /portal.
func servePortal(c *gin.Context, db *sql.DB) {
	settings, _ := serverstore.GetAllSettings(db)
	// §9: portal.public=false 时门户不对外开放, 跳转管理后台登录。
	if settings["portal.public"] == "false" {
		c.Redirect(http.StatusFound, "/admin/")
		return
	}
	loginName := settings["brand.login.display_name"]
	tagline := settings["brand.login.tagline"]
	welcome := settings["portal.welcome"]
	subtitle := settings["portal.subtitle"]
	dlURL := settings["portal.client_download_url"]
	dlNote := settings["portal.client_download_note"]
	enabled := settings["brand.enabled"] == "true"
	logoURL := ""
	if enabled && settings["brand.login.logo"] != "" {
		logoURL = "/api/client/v2/brand/logo/login"
	}
	if loginName == "" {
		loginName = "PicoAide"
	}
	if tagline == "" {
		tagline = "Enterprise AI Gateway"
	}
	if dlURL == "" {
		dlURL = "https://github.com/picoaide/picoaide-harness/releases/latest"
	}
	// 内嵌 JSON 注入(仅静态文本, 无用户输入直接进 HTML——安全)。
	payload, _ := json.Marshal(map[string]any{
		"name": loginName, "tagline": tagline, "logo": logoURL,
		"welcome": welcome, "subtitle": subtitle,
		"download_url": dlURL, "download_note": dlNote, "admin_url": "/admin/",
	})
	html := `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>` + loginName + `</title>
<style>
  :root{--accent:#4176E6}
  body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#F9FAFB;color:#1a1d24}
  .card{max-width:520px;width:90%;text-align:center;padding:48px 32px;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(15,17,21,.06)}
  .logo{width:72px;height:72px;border-radius:16px;background:#0f1115;color:#fff;display:inline-flex;align-items:center;justify-content:center;font-size:30px;font-weight:700}
  .logo img{width:100%;height:100%;object-fit:contain;border-radius:16px}
  h1{margin:16px 0 4px;font-size:26px;font-weight:700}
  .tag{color:#6b7280;font-size:14px}
  .welcome{margin-top:12px;font-size:14px;color:#374151;white-space:pre-wrap}
  .actions{margin-top:28px;display:grid;gap:12px}
  .btn{display:block;padding:12px;border-radius:10px;font-size:15px;font-weight:600;text-decoration:none}
  .btn-primary{background:var(--accent);color:#fff}
  .btn-outline{border:1px solid #d0d5dd;color:#1a1d24}
  .note{margin-top:10px;font-size:12px;color:#6b7280}
  footer{margin-top:24px;font-size:12px;color:#9ca3af}
</style>
</head>
<body>
<div class="card">
  __LOGO__
  <h1>__NAME__</h1>
  <div class="tag">__TAGLINE__</div>
  <div class="welcome">__WELCOME__</div>
  <div class="actions">
    <a class="btn btn-primary" href="__ADMIN__">管理后台</a>
    <a class="btn btn-outline" href="__DOWNLOAD__">下载客户端</a>
  </div>
  <div class="note">__NOTE__</div>
  <footer>PicoAide Harness</footer>
</div>
</body>
</html>`
	logoHTML := `<span class="logo">P</span>`
	if logoURL != "" {
		logoHTML = `<span class="logo"><img src="` + logoURL + `" alt="logo"></span>`
	}
	repl := func(s, k, v string) string {
		return strings.ReplaceAll(s, k, v)
	}
	html = repl(html, "__LOGO__", logoHTML)
	html = repl(html, "__NAME__", htmlEscape(loginName))
	html = repl(html, "__TAGLINE__", htmlEscape(tagline))
	html = repl(html, "__WELCOME__", htmlEscape(welcome))
	html = repl(html, "__ADMIN__", "/admin/")
	html = repl(html, "__DOWNLOAD__", htmlEscape(dlURL))
	html = repl(html, "__NOTE__", htmlEscape(dlNote))
	_ = payload
	c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
	c.Data(http.StatusOK, "text/html; charset=utf-8", []byte(html))
}

// htmlEscape escapes a string for safe embedding in HTML text/attributes.
func htmlEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")
	return r.Replace(s)
}

// mountAPIGuards 装配 API JSON 契约的两个护栏(审计 2026-09):
//
//  1. CustomRecovery:panic 时返回 JSON 错误信封,替换 gin 默认 Recovery
//     的无 body 500 text/plain —— 客户端/第三方进程绝不拿到 HTML 或空文本。
//  2. NoRoute:凡 /api/、/v1/ 前缀(含 405 落 NoRoute 场景)一律 JSON 信封;
//     HTML 面仅保留 /、/portal、/admin/*(产品页面)。
//
// 单独成函数以便 cmd/server 集成测试用与生产完全一致的逻辑断言契约。
func mountAPIGuards(r *gin.Engine, db *sql.DB, fileServer http.Handler, dist fs.FS) {
	r.Use(gin.Logger(), gin.CustomRecoveryWithWriter(gin.DefaultErrorWriter, func(c *gin.Context, _ any) {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "服务端内部错误")
	}))
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
