package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/bootstrap"
	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/sharedskills"
	"github.com/picoaide/picoaide/internal/util"
	"github.com/picoaide/picoaide/webadmin"
)

// version is injectable at build time: go build -ldflags "-X main.version=x.y.z"
var version = "dev"

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	dataDir := flag.String("data", "./data", "data directory")
	dbDriver := flag.String("db-driver", "sqlite", "database backend: sqlite (default) or pg")
	pgDSN := flag.String("pg-dsn", "", "PostgreSQL connection string (required when -db-driver=pg, e.g. postgres://user:pass@host:5432/db)")
	bootstrapAdmin := flag.String("bootstrap-admin", "", "username of the initial admin (password from PICOAI_ADMIN_PASSWORD)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	if *dbDriver != "sqlite" && *dbDriver != "pg" {
		log.Fatalf("unsupported -db-driver %q (want sqlite or pg)", *dbDriver)
	}
	if *dbDriver == "pg" && *pgDSN == "" {
		log.Fatal("-pg-dsn is required when -db-driver=pg")
	}

	if *dbDriver == "sqlite" {
		if err := os.MkdirAll(*dataDir, 0700); err != nil {
			log.Fatalf("create data dir: %v", err)
		}
	}
	cfg := serverstore.DBConfig{
		Driver: serverstore.DriverName(*dbDriver),
		Path:   *dataDir + "/picoaide.db",
		DSN:    *pgDSN,
	}
	db, err := serverstore.EnsureMigrated(cfg)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	if *bootstrapAdmin != "" {
		if err := serverauth.EnsureBootstrapAdmin(db, *bootstrapAdmin); err != nil {
			log.Fatalf("bootstrap admin: %v", err)
		}
	}

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery())
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

	// 认证 provider 只按 ConfigureProviders 注册:auth.mode=ldap 时不注册 local,
	// 防止过期本地账号(含管理员)仍可登录
	authCfg := serverauth.NewConfiguredAPI(db)
	auth := authCfg.API
	if authCfg.OIDC != nil {
		auth.RegisterOIDC(authCfg.OIDC)
	}
	auth.RegisterRoutes(r)

	serverauth.RegisterAdminRoutes(r, db)
	llmgateway.RegisterRoutes(r, db)
	llmgateway.RegisterAdminRoutes(r, db)
	marketplace.RegisterRoutes(r, db, *dataDir+"/skills-cache")
	marketplace.RegisterAdminRoutes(r, db, *dataDir+"/skills-cache")
	agentshare.RegisterRoutes(r, db, *dataDir+"/agent-presets-cache")
	agentshare.RegisterAdminRoutes(r, db, *dataDir+"/agent-presets-cache")
	sharedskills.RegisterRoutes(r, db, *dataDir+"/shared-skills-cache")
	sharedskills.RegisterAdminRoutes(r, db, *dataDir+"/shared-skills-cache")
	bootstrap.RegisterRoutes(r, db)
	// 审计日志保留策略(90 天):启动时清理过期条目
	if err := serverstore.PurgeOldAuditLogs(db, time.Now().Add(-90*24*time.Hour)); err != nil {
		log.Printf("audit log purge: %v", err)
	}
	// 渠道模型自动同步(固定间隔 1 小时;拉取上游 /models 自动上架/下架,
	// 并顺带清理过期的 pending usage 行 — 审计 C-9)
	go llmgateway.SyncLoop(db, time.Hour, nil)

	// webadmin SPA: /admin/ serves built assets with index.html fallback.
	dist, _ := fs.Sub(webadmin.FS, "dist")
	fileServer := http.FileServer(http.FS(dist))
	r.NoRoute(func(c *gin.Context) {
		p := c.Request.URL.Path
		if p == "/admin" {
			c.Redirect(http.StatusFound, "/admin/")
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
