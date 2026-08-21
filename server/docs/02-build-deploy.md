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
| `-data` | 数据目录(0700),默认 `./data`;内含 `picoaide.db`(SQLite)、master key 文件、`skills-cache/` |
| `--bootstrap-admin` | 初始超管用户名;首次启动时用 `PICOAI_ADMIN_PASSWORD` 创建(已存在则校验其为管理员);**首次启动后不可重复创建** |
| `PICOAI_ADMIN_PASSWORD` | 初始超管密码(**必须**与 `--bootstrap-admin` 同时提供,否则启动失败) |
| `PICOAI_MASTER_KEY` | 可选;不设置时首次启动自动生成随机 master key 写入 `data/` 下(0700)。**备份该文件**,丢失后已加密的网关/商城凭证无法解密 |

### 生产建议

- 服务端放在企业内网,前置 HTTPS(反向代理终结 TLS);登录页拒绝非 HTTPS 远程地址。
- 迁移/备份:单文件 SQLite,直接备份 `data/picoaide.db` + master key 文件。
- 假上游联调:无外网/无 key 环境 `bash scripts/mock-upstream.go` 起 mock 上游,验证网关链路。

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
| `server` | ubuntu, Go 1.26 | `make test-server` + `go build ./...` + 交叉编译 amd64/arm64 |
| `webadmin` | ubuntu, Node 24 | `npm ci && npm run build`(产物 artifact 供 server 内嵌) |

## 5. 管理页访问

`http(s)://<server>/admin/`(webadmin SPA;未构建时返回 "webadmin 未构建")。管理员登录后管理用户/网关/用量/商城/知识库。
