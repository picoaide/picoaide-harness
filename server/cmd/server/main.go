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
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/bootstrap"
	"github.com/picoaide/picoaide/internal/knowledge"
	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
	"github.com/picoaide/picoaide/webadmin"
)

// version is injectable at build time: go build -ldflags "-X main.version=x.y.z"
var version = "dev"

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	dataDir := flag.String("data", "./data", "data directory")
	bootstrapAdmin := flag.String("bootstrap-admin", "", "username of the initial admin (password from PICOAI_ADMIN_PASSWORD)")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	if err := os.MkdirAll(*dataDir, 0700); err != nil {
		log.Fatalf("create data dir: %v", err)
	}
	db, err := serverstore.EnsureMigrated(*dataDir + "/picoaide.db")
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
	// C-1: trust only loopback proxies, so gin's ClientIP never honors a
	// spoofed X-Forwarded-For from the public side (rate-limit keys also
	// derive from RemoteAddr as a second line of defense).
	if err := r.SetTrustedProxies([]string{"127.0.0.1", "::1"}); err != nil {
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
	knowledge.RegisterRoutes(r, db)
	uploadsDir := filepath.Join(*dataDir, "kb_uploads")
	// 独占 claim 模式:崩溃残留的 processing 行启动时回到队列
	if err := serverstore.ResetProcessingClaims(db); err != nil {
		log.Printf("kb reset processing claims: %v", err)
	}
	knowledge.StartUploadQueue(db, uploadsDir, 2)
	// 0014 迁移窗口:为存量 ready 文档补分块(幂等,后台执行)
	go func() {
		if err := knowledge.BackfillChunks(db); err != nil {
			log.Printf("kb backfill chunks: %v", err)
		}
	}()
	// 向量检索(B2):网关 embedder + 后台向量化循环;模型未配置时纯词法
	embedder := llmgateway.NewEmbedder(db)
	knowledge.SetEmbedder(embedder)
	go func() { knowledge.BackfillEmbeddings(db, embedder) }()
	knowledge.StartEmbeddingLoop(db, embedder, time.Second)
	knowledge.RegisterAdminRoutes(r, db, uploadsDir)
	bootstrap.RegisterRoutes(r, db)
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
				c.Request.URL.Path = rel
				fileServer.ServeHTTP(c.Writer, c.Request)
				return
			}
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
