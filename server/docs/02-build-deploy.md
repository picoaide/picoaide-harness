# 构建与部署

## 1. Makefile 目标

> **2026-08-19**:自研 Electron 客户端(desktop/)与浏览器插件已下线删除。项目只保留**服务端 + webadmin 管理端**;接入方经保留的 HTTP 接口(`/api/auth/*`、`/v1/*`、`/api/config/bootstrap`)接入。

```bash
make test              # go test ./... -count=1(服务端全量)
make test-server       # 服务端各域测试(serverauth/llmgateway/marketplace/knowledge/serverstore)
make build-server      # make webadmin + go build -o bin/picoaide-server
make webadmin          # cd webadmin && npm run build(产物嵌入服务端二进制)
make docker-image      # 服务端 Docker 镜像
make check             # gofmt 校验 + go vet + make test-server + webadmin 测试与构建
```

## 2. 服务端构建与部署

### 构建

```bash
make build-server
```

服务端为单二进制,webadmin 静态资源通过 `go:embed` 内嵌(需先 `make webadmin` 构建)。

### 运行参数

```bash
PICOAI_ADMIN_PASSWORD=xxx bin/picoaide-server \
  -addr :8080 \
  -data ./data \
  --bootstrap-admin admin
```

| 参数/环境变量 | 说明 |
|------|------|
| `-addr` | 监听地址,默认 `:8080` |
| `-data` | 数据目录(0700),默认 `./data`;内含 master key 文件、`skills-cache/`(PG 库在外部) |
| `-db-driver` | 数据库后端:`pg`(默认,PG-only)或 `pg-external`;需 `-pg-dsn` |
| `-pg-dsn` | PostgreSQL 连接串(如 `postgres://user:pass@host:5432/db?sslmode=disable`);pg 模式必填 |
| `--bootstrap-admin` | 初始超管用户名;首次启动时用 `PICOAI_ADMIN_PASSWORD` 创建(已存在则校验其为管理员);**首次启动后不可重复创建** |
| `PICOAI_ADMIN_PASSWORD` | 初始超管密码(**必须**与 `--bootstrap-admin` 同时提供,否则启动失败) |
| `PICOAI_MASTER_KEY` | 可选;不设置时首次启动自动生成随机 master key 写入 `data/` 下(0700)。**备份该文件**,丢失后已加密的网关/商城凭证无法解密 |

### 运行参数(PostgreSQL 后端)

```bash
PICOAI_ADMIN_PASSWORD=xxx bin/picoaide-server \
  -addr :8080 -data ./data \
  -db-driver pg -pg-dsn 'postgres://picoaide:pass@127.0.0.1:5432/picoaide?sslmode=disable' \
  --bootstrap-admin admin
```

首次启动自动应用 `migrations-pg`(幂等);`-data` 仍用于 master.key 与 skills-cache(请备份)。usage 明细按月原生分区,日/月账本永久保留(见 docs/06-database.md)。

### 生产建议

- 服务端放在企业内网,前置 HTTPS(反向代理终结 TLS);登录页拒绝非 HTTPS 远程地址。
- 迁移/备份:PG 数据在 pg-data/,备份用 `deploy.sh backup`(含 pg_dump)+ picoaide-data/ master key;
  PostgreSQL 后端用 `deploy.sh backup`(pg_dump)或外部 PG 运维策略。
- 假上游联调:无外网/无 key 环境 `bash scripts/mock-upstream.go` 起 mock 上游,验证网关链路。
- **容器化部署(推荐)**:见 [docs/DEPLOY.md](DEPLOY.md)(compose 私有网段+固定 IP、Caddy 双证书模式、deploy.sh 自动化、PG 后端、升级/备份/恢复)。

## 3. Docker 镜像构建与发布

### 3.1 镜像结构(server/Dockerfile,多阶段)

- Stage1 `node:24-alpine` 构建 webadmin dist(go:embed 需要);
- Stage2 `golang:1.26-alpine` 交叉编译:`CGO_ENABLED=0`,ldflags 注入 `-X main.version=$VERSION`(VERSION 默认 `dev`,CI 传 git tag 去 v 前缀);
- Stage3 `alpine:3.21` 运行:非 root uid 10001(picoaide),`su-exec` 降权入口,`VOLUME /data`,`HEALTHCHECK` 与 compose 同源。

### 3.2 构建命令

```bash
make docker-image                 # 本地单平台(版本=VERSION,默认 git describe)
make docker-image TAG=v0.4.0      # 指定版本
make release-export TAG=v0.4.0    # 离线导出 tar(内网 docker load)
docker buildx build --platform linux/amd64 \
  --build-arg VERSION=0.4.0 -t ghcr.io/picoaide/picoaide-harness-server:v0.4.0 --push .
```

### 3.3 发布(CI 自动,Workflow: .github/workflows/docker.yml)

- 触发:`push tag v*` 或手动 `workflow_dispatch`(填版本号);
- 单平台 `linux/amd64`(2026-08-26 起移除 arm64,不再 QEMU 模拟);注入 VERSION;推送标签 `vX.Y.Z` / `vX.Y` / `latest`;
- 附加 `type=gha` 构建缓存、`sbom=true`、`provenance=mode=max`;`imagetools inspect` 校验 amd64 manifest;
- 镜像地址 `ghcr.io/picoaide/picoaide-harness-server`(部署 .env `SERVER_IMAGE` 可换私有 registry)。

### 3.4 镜像验证清单

| 检查 | 命令 | 预期 |
|---|---|---|
| 版本注入 | `docker run --rm <image> --version` | 构建时注入版本(非 `dev`) |
| 非 root | `docker run --rm --entrypoint id <image>` | `uid=10001(picoaide)` |
| 健康端点 | 起容器后 `curl /healthz` | 200 `{"ok":true}` |
| 架构 | `docker buildx imagetools inspect <image>:vX.Y.Z` | `linux/amd64`(arm64 已移除) |
| 持久化 | 写数据→重启→数据在 | 卷挂载有效 |

## 3. 接入方(客户端)接入说明

自研客户端已下线,但**服务端接口全部保留**,任何 HTTP 客户端可直接接入:

1. `POST /api/auth/login` 获取 Bearer token(90 天);`GET /api/auth/me` 校验身份。
2. `GET /api/config/bootstrap` 拉默认模型与建议清单(零配置接入)。
3. `POST /v1/chat/completions` / `/v1/embeddings` 调用 LLM(经网关计量计费)。
4. `GET /api/auth/usage` 查询本员工余额(金额/token)与今日/昨日/本月/累计统计。

接口契约见 `docs/03-api-reference.md`。

## 4. CI

`.github/workflows/ci.yml`,push/PR 触发,两个 job:

| Job | 环境 | 内容 |
|-----|------|------|
| `server` | ubuntu, Go 1.26 | `make test-server` + `make build-server`(原生 amd64) |
| `webadmin` | ubuntu, Node 24 | `npm ci && npm run build`(产物 artifact 供 server 内嵌) |

## 5. 管理页访问

`http(s)://<server>/admin/`(webadmin SPA;未构建时返回 "webadmin 未构建")。管理员登录后管理用户/网关/用量/商城。
