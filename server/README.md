# PicoAide Harness 服务端

PicoAide Harness 平台的企业管控面：Go 服务端提供认证（local / LDAP / OIDC）、LLM 网关（密钥不出服务端、按用户计量计费）、技能商城、共享内容（技能 / Agent）与全部管理接口；webadmin 管理端（shadcn SPA，内嵌进服务端二进制）负责用户 / 部门 / 网关 / 用量 / 商城 / 能力中心 / 品牌与门户的配置。

仓库内服务端与桌面客户端（`packages/host/*`）同源；接入方（企业客户端、任何 HTTP 客户端）经 `/api/client/v2/*` 与 `/v1/*` 网关接入。

## 快速开始

### 0. 一键部署（oh-my-zsh 式，单命令）

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/picoaide/picoaide-harness/master/server/scripts/install-server.sh)"
```

> 注意:必须用 `bash` 执行(脚本使用 bash 专属语法);`sh -c`(Debian/Ubuntu 上
> `/bin/sh`=dash)会解析失败。交互运行时会询问域名(必填,生产前必须设置为真实
> 域名/IP);也可非交互指定(需 root/sudo):

```bash
# 指定域名 + 管理员密码（PostgreSQL 内置容器，DB_MODE=pg 默认）
curl -fsSL https://raw.githubusercontent.com/picoaide/picoaide-harness/master/server/scripts/install-server.sh | \
  sudo DOMAIN=picoaide.example.com ADMIN_PASS=your-strong-password bash

# 使用已有 PostgreSQL 实例（DB_MODE=pg-external + PG_DSN）
curl -fsSL https://raw.githubusercontent.com/picoaide/picoaide-harness/master/server/scripts/install-server.sh | \
  sudo DOMAIN=picoaide.example.com ADMIN_PASS=your-strong-password DB_MODE=pg-external PG_DSN='postgres://user:pass@host:5432/db' bash
```

- 数据库后端 `DB_MODE`：`pg`（默认，内置 postgres:18-alpine 容器）| `pg-external`（已有 PostgreSQL 实例，需 `PG_DSN`）；PG-only，SQLite 已下线。
- 部署目录默认 `/data/picoaide/deploy`（可用 `INSTALL_DIR` 覆盖；兼容旧版 `DEPLOY_DIR`）；依赖自动安装可用 `SKIP_DEPS=1` 跳过；Docker 安装可用 `DOCKER_MIRROR` 指定镜像源。
- 已有部署时提示改用 `./deploy.sh update`（升级）或 `REINSTALL=yes`（清除重装）。

### 1. 服务端（Go 1.26+）

```bash
make build-server
PICOAI_ADMIN_PASSWORD=admin123 bin/picoaide-server \
  -addr :8080 -data ./data \
  -db-driver pg -pg-dsn 'postgres://picoaide:pass@127.0.0.1:5432/picoaide?sslmode=disable' \
  --bootstrap-admin admin
```

- `--bootstrap-admin` + `PICOAI_ADMIN_PASSWORD` 首次创建超管；`PICOAI_MASTER_KEY` 可显式指定加密主密钥（不设则自动生成于 data 目录，请备份）。
- 管理页：`http://localhost:8080/admin/`（用户 / 部门 / 网关 / 用量 / 商城 / 能力中心 / 品牌 / 门户）。
- 无外网环境可 `go run scripts/mock-upstream.go` 起假上游联调网关。

## 文档

| 文档 | 内容 |
|------|------|
| [docs/01-architecture.md](docs/01-architecture.md) | 系统架构 / 进程模型 / 数据流 / 安全设计 |
| [docs/02-build-deploy.md](docs/02-build-deploy.md) | 构建 / 部署 / 镜像 / CI |
| [docs/03-api-reference.md](docs/03-api-reference.md) | 全部 HTTP 端点（管理面 + 客户端面 + 网关） |
| [docs/04-auth.md](docs/04-auth.md) | 认证体系（local / LDAP / OIDC / token / 管理端 CSRF） |
| [docs/06-database.md](docs/06-database.md) | PostgreSQL 表结构 / 迁移（0001–0048） / 分区账本 |
| [docs/07-marketplace.md](docs/07-marketplace.md) | 技能商城 / 授权 / 共享内容 |
| [docs/08-agent-share.md](docs/08-agent-share.md) | 共享 Agent（上传 / 审核 / 授权 / 双门制） |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 容器化部署（compose 私有网段、Caddy、备份恢复） |
| [docs/08-development.md](docs/08-development.md) | 开发指南 / TDD / 契约 |

## License

MIT。本项目基于 DeepSeek Harness 构建的社区版本，与 DeepSeek 官方无隶属关系。
