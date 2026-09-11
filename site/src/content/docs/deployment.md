---
title: 部署总览
description: PicoAide Harness 企业私有化部署总览：交付物、分发面、容器架构、证书模式与数据安全铁律。
---

PicoAide Harness 面向**企业内网**交付：一台服务器跑服务端，员工装客户端，数据与密钥都在企业自己的机器上。
本页说明部署形态与交付物；具体操作见本节其余页面。

> 仓库内的 [`docs/deploy/AI-DEPLOY.md`](https://github.com/picoaide/picoaide-harness/blob/master/docs/deploy/AI-DEPLOY.md)
> 是**唯一权威的部署说明**（首次部署 / 升级 / 回滚 / 排障 + 四条数据安全铁律），可以直接交给 AI 代理执行。
> 本 Wiki 是面向人的同一套流程，两者出现偏差时以仓库文档与代码为准。

## 三种部署形态

| 形态 | 适用 | 说明 | 入口 |
|---|---|---|---|
| **单机桌面** | 个人 / 小团队 | 只装桌面客户端。客户端自带本地 Harness 运行时并在本机启动服务，会话与凭据留在本机，无需服务器 | [桌面客户端](/desktop/) |
| **企业内网容器化**（推荐） | 组织全员 | 内网服务器跑 `caddy + server + postgres` 三个容器；账号、网关、配额、计费、审批集中在服务端 | [容器化部署](/deployment/compose/) |
| **并入已有反代 / 单二进制** | 已有统一入口的机房 | 80/443 已被共享 Caddy/nginx 占用时只起 `server + postgres` 并入现有 vhost；也支持单二进制 + 外部 PostgreSQL（含从 systemd 迁移） | [运维与排障](/deployment/operations/) |

## 交付物：一个镜像 + 一份说明

服务端**只有一种发布物**：一个容器镜像。镜像里已经装好部署需要的一切，不需要克隆仓库、不需要外网拉配置、
也没有任何安装脚本。

```
发布物 = 一个容器镜像
  ├─ 服务端二进制（含内嵌 webadmin 管理后台）
  ├─ 三平台客户端安装包 + CLIENT-RELEASE.json   ← 员工从这里下载
  ├─ docker-compose.yml + Caddyfile.{internal,autocert,manual} + .env.example
  ├─ VERSION / CHANNEL                          ← 本部署的版本与渠道
  └─ channel/                                   ← 品牌与文案（渠道内容）
```

一条命令即可把部署文件导出到部署目录（镜像自带的 `PICOAI_UNPACK_STACK` 入口）：

```sh
mkdir -p /opt/picoaide
docker run --rm -v /opt/picoaide:/out -e PICOAI_UNPACK_STACK=/out \
  picoaide-harness-server:<版本>
ls -1 /opt/picoaide   # docker-compose.yml / Caddyfile.* / .env.example / VERSION / client/
```

导出是**替换语义**：`docker-compose.yml`、`Caddyfile.*`、`.env.example`、`client/`、`VERSION` 会先清旧再写；
`.env`、`picoaide-data/`、`pg-data/`、`caddy-data/`、`certs/` 一律不动。

## 从哪里取镜像

**不经任何镜像仓库**（GHCR 已下线）。所有渠道的镜像都从更新服务器取，每个渠道一个独立目录：

```
https://release.picoaide.com/<渠道>/latest.json                         ← 版本清单（服务端升级检查也读它）
https://release.picoaide.com/<渠道>/releases/<版本>/picoaide-server-<版本>-amd64.zip
https://release.picoaide.com/<渠道>/releases/<版本>/SHA256SUMS          ← 下载后务必校验
```

`latest.json` 的关键字段：

| 字段 | 含义 |
|---|---|
| `channel_id` | 该清单属于哪个渠道（服务端会强制比对，见[渠道与白标](/deployment/channels/)） |
| `server.version` | 目标版本（不带 `v`，如 `2.7.0`） |
| `server.image_tag` | 镜像 tag（带 `v`，如 `v2.7.0`）；导入后 `2.7.0` 与 `v2.7.0` 两个 tag 都在 |
| `server.image_asset` | 镜像压缩包下载地址 |
| `client.version` | 随该版本镜像发布的客户端版本（与服务端同源） |

- 更新服务器**只保留最近 3 个版本**；更早的版本从 GitHub Release 取（公开渠道的完整历史存档）；
- GitHub Release **只发公开渠道**（官方 / 预发布）的镜像包与 `SHA256SUMS`；品牌渠道是客户定制交付，不经公开 Release；
- 无外网环境见[离线部署](/deployment/offline/)。

## 环境要求

| 项目 | 要求 |
|---|---|
| 服务器 | Linux x64；Docker ≥ 24 与 Compose v2（`docker compose`，不是 `docker-compose`）、`openssl`、`curl`、`unzip` |
| 资源 | 建议 ≥ 4 核 / 8GB 内存 / 50GB 可用磁盘（`pg-data/` 会持续增长） |
| 网络 | 服务器需要能访问 `https://release.picoaide.com`（检查更新 + 下载镜像）；**员工电脑不需要访问任何外网** |
| 端口 | Caddy 占用宿主机 80/443（可改 `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT`） |
| 客户端 | Windows 10+ x64 / macOS 12+（Apple 芯片）/ Linux x64；无需 Node.js、pnpm 或 DSH |

## 容器架构

```
员工客户端 / 浏览器
      │ HTTPS(80/443)
      ▼
   Caddy 2（反代 + TLS 终结，固定 IP 172.28.0.2）
      │ HTTP:8080（仅 compose 私有网段）
      ▼
   Go 服务端（非 root uid 10001，固定 IP 172.28.0.3）
      │
      ▼
   PostgreSQL 18（内置容器，固定 IP 172.28.0.4，数据 ./pg-data）
```

- 自定义 bridge 私有网段（默认 `172.28.0.0/24`，`NETWORK_SUBNET` 可改），容器 IP 固定在 compose 里声明，
  重建/升级后不变；
- **server 不映射宿主机端口**，外部流量只能经 Caddy 进入（内网隔离 + 攻击面收敛）；
- **全部持久化数据用 `./` bind mount，不使用命名卷**：

| 目录 | 内容 | 备注 |
|---|---|---|
| `picoaide-data/` | 应用数据 + **`master.key`** | 丢失 = 数据库内加密的上游密钥**永久不可解**，必须备份 |
| `pg-data/` | 内置 PostgreSQL 18 数据 | 挂载到容器 `/var/lib/postgresql`（PG18 起数据落 `18/docker/` 子目录） |
| `caddy-data/` `caddy-config/` | Caddy 证书库与配置 | `auto` 模式必须备份，否则重新签发 |
| `certs/` | 手动证书 | 仅 `manual` 模式 |
| `deploy-backup/` | 备份输出 | 备份步骤写入 |

## 证书模式（三选一）

由 `.env` 的 `TLS_MODE` 决定挂载哪个 Caddyfile 模板：

| 模式 | 模板 | 适用 | 前提 |
|---|---|---|---|
| `internal` | `Caddyfile.internal` | **纯内网 / 无公网域名**（最常见） | 无；客户端首次连接需信任 Caddy 本地 CA |
| `auto` | `Caddyfile.autocert` | 有公网域名且**直连**本机 | 域名 A 记录指向本机公网 IP、80/443 对公网开放；**经 CDN 会失败**，不接受 IP |
| `manual` | `Caddyfile.manual` | 企业已有正式证书（支持 IP） | 提供 `certs/server.crt` + `certs/server.key` |

判断方法：域名解析到公网且能直连 → `auto`；否则 → `internal`。IP 部署一律 `internal` 或 `manual`。

## 四条铁律（违反会造成不可恢复的数据损失）

| # | 禁止 | 原因 |
|---|---|---|
| 1 | **绝不执行** `docker compose down -v`、`docker volume prune`、`docker system prune --volumes` | `-v` / `prune` 会删数据卷与镜像层，数据库和 `master.key` 一起没；数据在 bind mount 目录里，`down`（不带 `-v`）不会删 |
| 2 | **绝不用 `latest` 标签** | 不可复现、无法回滚锚定；一律用 `vX.Y.Z` 具体版本 |
| 3 | **升级前必须备份**，且确认备份文件非空 | `picoaide-data`（含 `master.key`）+ `pg_dump`；`master.key` 丢了，库里所有加密的上游密钥永久无法解密 |
| 4 | **不得用 `.env` 覆盖已有部署目录** | 部署目录已有 `.env` 说明部署过，那是**升级**场景，走升级流程而不是重装 |

补充：不要在健康检查通过前删旧镜像（它是回滚锚点）；不要为让服务起来而改 compose 里的固定 IP / 网段；
数据库迁移不可逆，回滚镜像**不能**把数据库降回旧结构。

## 接下来

1. [容器化部署](/deployment/compose/) —— 从取镜像到健康检查的完整首次部署
2. [升级、备份与回滚](/deployment/upgrade/) —— 版本检查、备份、切换与回退
3. [客户端分发与升级](/deployment/client-delivery/) —— 客户端随服务端发布，员工零外网
4. [渠道与白标](/deployment/channels/) —— 官方 / 预发布 / 企业定制渠道
5. [离线部署](/deployment/offline/) —— 服务器不能出网时的旁路取包
6. [运维与排障](/deployment/operations/) —— 反代、证书、备份恢复、常见故障
