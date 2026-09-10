# PicoAide 服务端容器化部署文档

> **2026-09-10 变更**：本仓库的部署脚本（`scripts/deploy.sh`、`scripts/install-server.sh`）
> 与 `make release-export` **已全部移除**。部署与升级改为**一份给 AI 代理/运维执行的说明**
> 驱动，交付物只有一个容器镜像（镜像内自带 compose、Caddyfile、客户端安装包）。
>
> 👉 **部署/升级/回滚/排障一律看 [`docs/deploy/AI-DEPLOY.md`](../../docs/deploy/AI-DEPLOY.md)**
>
> 本文保留仍然有效的设计说明（架构、证书模式、固定 IP、数据目录、FAQ），不再描述任何脚本用法。

## 0. 架构总览

```
员工客户端 / 浏览器
        │ HTTPS (80/443)
        ▼
┌──────────────────┐   Caddy 2(前端反代 + TLS 终结,证书模式见 §3)
│ caddy            │   固定 IP 172.28.0.2(容器重建不变)
└──────┬───────────┘
       │ HTTP :8080(仅 compose 私有网段,不发布宿主机端口)
       ▼
┌──────────────────┐   Go 服务端(非 root uid 10001,仅 expose 8080)
│ server           │   固定 IP 172.28.0.3
└──────┬───────────┘
       ▼
   ./picoaide-data/   master.key + 应用数据(0700,目录 bind mount,升级不丢)
```

- 私有网段:自定义 bridge `picoaide-net`,默认子网 `172.28.0.0/24`(`.env` 的 `NETWORK_SUBNET` 可改)。
- 固定 IP:容器 `ipv4_address` 锁定,`docker compose up -d` 重建/升级后 IP 不变,Caddyfile 的 `reverse_proxy server:8080` 恒可达。
- server 不映射宿主机端口,外部流量只能经 Caddy 进入(内网隔离 + 攻击面收敛)。
- **所有持久化数据均用 `./` 当前目录 bind mount,不使用命名卷**:`picoaide-data/`(应用数据+主密钥)、`caddy-data/`(Caddy 自动证书库)、`caddy-config/`(Caddy 配置)+ `certs/`(手动证书);pg 模式另加 `pg-data/`(内置 postgres 数据,挂载到容器 `/var/lib/postgresql`)。备份 = 直接拷走部署目录，或按部署说明打包 `picoaide-data/` + `pg_dump`。

### 0.1 数据库后端:PostgreSQL(唯一形态,内置容器)

> 2026-08 起 SQLite 已全面下线,服务端只支持 PostgreSQL,且部署形态固定为
> **内置 postgres 容器**(`docker-compose.yml` 单文件含 caddy+server+postgres
> 三服务)。早前的 `DB_MODE` / `pg-external`(外部实例)模式已删除。

| 项目 | 值 |
|---|---|
| 数据落地 | `pg-data/`(容器 `postgres:18-alpine`,固定 IP `.4`) |
| 连接 | 容器内 `postgres://picoaide:<密码>@postgres:5432/picoaide` |
| 密码 | `.env` 的 `PG_PASSWORD`(compose 强必填,缺失时 `docker compose up` 直接报错) |

> **PG18 挂载点变化(重要)**:PostgreSQL 18 起官方镜像把 PGDATA 改为
> `/var/lib/postgresql/<major>/docker`,compose 挂载 **父目录**
> `./pg-data:/var/lib/postgresql`(容器内数据实际落在 `18/docker/` 子目录)。
> 旧挂载点 `/var/lib/postgresql/data` 会被镜像 entrypoint 判定为
> "unused mount/volume" 并**拒绝启动(exit 1)**。
> **从 PG16 旧部署升级**:先备份 `pg-data/`,然后按新挂载点启动(空目录自动
> initdb),用 `pg_dump` 从旧实例导出、`pg_restore` 导入;或停在旧镜像上
> 用 `pg_upgrade --link`(需挂载 `/var/lib/postgresql` 父目录)。不要直接用
> 旧 `pg-data/` 目录顶到新镜像(目录布局不兼容,旧 16 数据不会自动迁移)。

pg 模式架构(caddy → server → postgres,全部内网固定 IP):

```
员工客户端 / 浏览器
        │ HTTPS (80/443)
        ▼
┌──────────────────┐   Caddy 2(前端反代 + TLS 终结)
│ caddy            │   固定 IP 172.28.0.2
└──────┬───────────┘
       │ HTTP :8080(仅 compose 私有网段)
       ▼
┌──────────────────┐   Go 服务端(-db-driver pg -pg-dsn …)
│ server           │   固定 IP 172.28.0.3
└──────┬───────────┘
       │ postgres://picoaide:…@postgres:5432/picoaide
       ▼
┌──────────────────┐   PostgreSQL 18(不发布宿主机端口)
│ postgres         │   固定 IP 172.28.0.4,数据 ./pg-data
└──────────────────┘
```

- 使用最新镜像(本地 `make docker-image` 或 CI 发布的 `ghcr.io/picoaide/picoaide-harness-server`);PG 支持是当前所有发布镜像的默认能力;
- 服务端首次启动自动应用 `migrations-pg` 建表(幂等,空库即建);
- usage 明细按月原生分区(保留 N 月可配,默认 6),日/月账本永久保留(见 docs/06-database.md)。

## 1. 证书模式（三选一，由 `.env` 的 `TLS_MODE` 决定挂载哪个模板）

compose 按 `./Caddyfile.${TLS_MODE:-manual}` 挂载模板，三种模式命名统一：

| 模式 | `TLS_MODE` | 模板 | 行为 | 前置条件 |
|---|---|---|---|---|
| 本地自签 | `internal` | `Caddyfile.internal` | `tls internal`（Caddy 本地 CA 签发） | 无；客户端首次连接需信任 Caddy 本地 CA |
| 自动证书 | `auto` | `Caddyfile.autocert` | Caddy 自动申请/续期 Let's Encrypt | **域名直接解析到本机**（非 CDN），80/443 对公网开放；不支持 IP |
| 手动证书 | `manual` | `Caddyfile.manual` | `tls /certs/server.crt /certs/server.key` | 部署者提供 PEM；无证书时可用 openssl 生成自签占位 |

> **2026-09-10 修复**：此前 compose 拼接的是 `./Caddyfile.internal`，而 internal 模式的模板
> 文件名实际是 `Caddyfile` —— `TLS_MODE=internal` 从未真正可用（挂载源不存在，caddy 容器
> 创建即失败，且 Docker 会在宿主上创建一个同名**目录**）。现三种模式统一为 `Caddyfile.<mode>`。

## 2. 数据目录（升级不丢，备份清单）

全部用 `./` 当前目录 bind mount，**不使用命名卷**：

| 目录 | 内容 | 备注 |
|---|---|---|
| `picoaide-data/` | 应用数据 + **`master.key`** | 丢失 = 数据库内加密的上游密钥**永久不可解**，必须备份 |
| `pg-data/` | 内置 PostgreSQL 18 数据 | 挂载到容器 `/var/lib/postgresql`（PG18 起数据落 `18/docker/` 子目录） |
| `caddy-data/` `caddy-config/` | Caddy 证书库与配置 | `auto` 模式必须备份（否则重新签发） |
| `certs/` | 手动证书 | 仅 `manual` 模式 |
| `deploy-backup/` | 备份输出 | 由部署说明中的备份步骤写入 |

备份/恢复命令见 [`docs/deploy/AI-DEPLOY.md`](../../docs/deploy/AI-DEPLOY.md) §6.3 与 §7。

## 3. 固定 IP 与私有网段

- 容器 IP 由 compose `ipam` + `ipv4_address` 声明式锁定：caddy `172.28.0.2`、
  server `172.28.0.3`、postgres `172.28.0.4`，`docker compose up -d` 重建后不变；
- server 经 compose DNS（服务名 `server`）被 Caddy 反代，**无需写死 IP**；
- `PICOAI_TRUSTED_PROXIES` 默认 `172.28.0.2`，使登录限流键解析真实客户端 IP；
- 与宿主机其他网段/容器冲突时改 `.env` 的 `NETWORK_SUBNET` 与三个固定 IP。

## 4. 常见问题

| 现象 | 原因与处理 |
|---|---|
| caddy 容器创建失败，报 `not a directory` | 挂载源 `Caddyfile.<mode>` 不存在（旧版 internal 模式的坑）；确认 `.env` 的 `TLS_MODE` 与仓库内模板名匹配 |
| postgres 启动即退出，日志提 `OLD_DATABASES` / `unused mount` | PG16→18 旧数据布局；需 dump/restore 迁移，见 AI-DEPLOY §6.2 |
| healthz 一直非 200 | 首次启动要跑 60+ 条迁移并建用量分区，等 1–2 分钟；仍失败看 `docker compose logs server` |
| 镜像拉取失败 | GHCR 不可达时从更新服务器下载镜像包后 `docker load`（AI-DEPLOY §6.4） |
| 忘了超管密码 | 另一个 super_admin 在 webadmin 重置，或 `docker exec picoaide-server /app/picoaide-server --reset-mfa <user>` |
