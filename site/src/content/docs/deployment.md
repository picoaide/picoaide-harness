---
title: 部署总览
description: PicoAide Harness 私有化部署总览：为什么交付物只有一个镜像、数据为什么只能落 bind mount、证书模式怎么选，以及四条数据安全铁律。
---

PicoAide Harness 面向**企业内网**交付：一台服务器跑企业服务端，员工在自己机器上装桌面客户端，
会话、文件与沙箱留在员工机器，账号、模型网关、计量计费与审批留在企业自己的服务器上。
本页说明部署形态、交付物与贯穿全篇的设计取舍；具体操作在[容器化部署](/deployment/compose/)、
[升级、备份与回滚](/deployment/upgrade/)等页面。

> 仓库里的 [`docs/deploy/AI-DEPLOY.md`](https://github.com/picoaide/picoaide-harness/blob/master/docs/deploy/AI-DEPLOY.md)
> 是**唯一权威的部署说明**（首次部署 / 升级 / 回滚 / 排障），可以直接交给 AI 代理执行。
> 本 Wiki 是面向人的同一套流程；两者出现偏差时，以仓库文档与代码为准。

## 这一页解决什么问题

| 你要回答的问题 | 看哪一节 |
|---|---|
| 我们这种情况该用哪种形态？ | [三种部署形态](#三种部署形态) |
| 交付物到底是什么、从哪里拿、怎么校验？ | [交付物](#交付物一个镜像)、[取镜像](#从哪里取镜像) |
| 服务器上会跑什么、数据落在哪、会不会丢？ | [容器架构](#容器架构)、[数据落在哪](#数据落在哪bind-mount) |
| HTTPS 证书怎么来？ | [证书模式](#证书模式三选一) |
| 哪些操作绝对禁止？ | [四条铁律](#四条铁律) |
| 怎么算部署成功、失败了是什么样？ | [判据](#判据)、[边界与失败行为](#边界与失败行为) |

**前提**：目标机是 Linux x64，能装 Docker；你手上有三样已经跟用户确认过的事实 ——
对外地址（`DOMAIN`）、证书模式（`TLS_MODE`）、初始超管密码。这三样**不要自己编**：
地址决定员工能不能连上，证书模式选错会让客户端直接连不上（见[边界与失败行为](#边界与失败行为)）。

## 三种部署形态

| 形态 | 适用 | 说明 | 入口 |
|---|---|---|---|
| **单机桌面** | 试用 / 单机评估 | 只装桌面客户端（自带本地 Harness 运行时、沙箱与随包 Node / pnpm / Python）。**仍需要一台可登录的服务端**：模型目录、密钥与授权都从服务端下发，未登录时主界面就是登录页 | [桌面客户端](/desktop/) |
| **企业内网容器化**（推荐） | 组织全员 | 内网服务器跑 `caddy + server + postgres` 三个容器；账号、网关、余额、审批、审计集中在服务端 | [容器化部署](/deployment/compose/) |
| **并入已有反代 / 单二进制** | 已有统一入口的机房 | 80/443 已被共享 Caddy/nginx 占用时只起 `server + postgres` 并入现有 vhost；也支持单二进制 + 外部 PostgreSQL（含从 systemd 迁移） | [运维与排障](/deployment/operations/) |

三种形态用的**是同一个客户端**：它始终登录到一台服务端取模型目录与配置（这台服务端可以就部署在你本机，
见上面的单机形态）。企业形态下客户端版本由服务端决定（见[客户端分发与升级](/deployment/client-delivery/)）。

## 设计取舍：为什么是这样

这五条不是实现细节，而是这套交付方式的**约束条件**；改动它们会连带破坏部署、升级与回滚。 

**① 交付物只有一个容器镜像。** 镜像里装好了部署需要的一切（服务端二进制、内嵌管理后台、
三平台客户端安装包、compose、Caddyfile 模板、`.env.example`、渠道内容、内置技能）。
为什么不做安装脚本：脚本会随仓库演进而与镜像内容漂移，而"脚本 + 一堆外网依赖"在没有外网的
客户机房里根本跑不起来。一个镜像 = 一次下载、一次校验、一次 `docker load`，版本号与内容
天然绑定（`VERSION` 与 `--version` 可以对拍），也不存在"从 GitHub 拉配置"这一步。

**② 不经任何镜像仓库。** 服务端镜像**不推**任何公共或私有 registry（GHCR 已下线），
每个渠道在更新服务器上有自己的目录（`<渠道>/releases/<版本>/`）。
原因有两个：一是渠道镜像里带着**客户品牌与随包客户端**，把定制交付物推进多租户 registry
等于把客户身份暴露在第三方存储上；二是很多客户机房根本不允许拉公共 registry，
"从 HTTPS 目录取 zip" 是唯一在每个环境都成立的分发方式。
代价是客户要自己校验哈希 —— 所以每个版本目录里都有 `SHA256SUMS`（见[取镜像](#从哪里取镜像)）。

**③ 数据只能落 bind mount，不能用命名卷。** `picoaide-data/`、`pg-data/`、`caddy-data/`、`certs/`
全部是部署目录下的**宿主机目录**（bind mount）。因为：备份要能"打包一个目录就完事"，
审计要能指着宿主机文件说清数据在哪，迁移机器要能整体拷贝，而命名卷的生命周期挂在 Docker 上
（`docker compose down -v`、`docker volume prune` 会连数据一起删）。
用 bind mount 之后，"删库"这件事必须**显式地**在宿主文件系统上发生 —— 这也是铁律 1 的由来。

**④ 绝不用 `latest` 标签。** 镜像 tag 是回滚锚点：出问题时唯一的动作是"把 `SERVER_IMAGE`
指回上一版"。`latest` 无法回答"上一版是哪一个"，也让"现在跑的是不是我以为的那一版"无法自证。
一律用具体版本 tag；同机多栈时还要用**渠道专属** tag（见[升级、备份与回滚](/deployment/upgrade/)）。

**⑤ 升级前必须备份，而且必须校验备份非空。** 数据库迁移是**不可逆**的（新版本会把库结构
往前推），所以回滚的退路只有升级前的那份 `pg_dump` 与 `picoaide-data/` 快照。
"文件存在"不等于"内容有效"：空文件、被截断的 tar 与失败的 `pg_dump` 都会留下一个同名文件，
因此流程里比对的是 `[ -s … ]`（非空），不是 `ls`。
其中 `picoaide-data/master.key` 尤其致命 —— 它丢了，库里所有加密的上游 API Key
（AES-GCM 密文）**永久无法解密**，只能重新录入。

## 交付物：一个镜像

```
交付物 = 一个容器镜像
  ├─ 服务端二进制（含内嵌 webadmin 管理后台）
  ├─ 三平台客户端安装包 + CLIENT-RELEASE.json   ← 员工从这里下载
  ├─ docker-compose.yml + Caddyfile.{internal,autocert,manual} + .env.example
  ├─ VERSION / CHANNEL                          ← 本部署的版本与渠道
  ├─ channel/                                   ← 渠道内容（名称 / 文案 / 标识 / 主题色）
  └─ skills/                                    ← 内置技能（能力中心按需安装）
```

一条命令把部署文件导出到部署目录（镜像自带的 `PICOAI_UNPACK_STACK` 入口）：

```sh
mkdir -p /opt/picoaide
docker run --rm -v /opt/picoaide:/out -e PICOAI_UNPACK_STACK=/out \
  picoaide-harness-server:<版本>
ls -1 /opt/picoaide   # docker-compose.yml / Caddyfile.* / .env.example / VERSION / client/
```

导出是**替换语义**：`docker-compose.yml`、`Caddyfile.*`、`.env.example`、`client/`、`VERSION`
会先清掉旧的再写入（否则升级后 `client/` 里会同时留着两个版本的安装器，员工可能下到旧包）；
`.env`、`picoaide-data/`、`pg-data/`、`caddy-data/`、`certs/` **一律不动**。
导出**不需要**停机，也不改变当前运行的容器 —— 它只写文件，切换版本发生在改 `.env` 与
`docker compose up -d` 之后。

## 从哪里取镜像

```
https://release.picoaide.com/<渠道>/latest.json                          ← 版本清单（服务端升级检查也读它）
https://release.picoaide.com/<渠道>/releases/<版本>/picoaide-server-<版本>-amd64.zip
https://release.picoaide.com/<渠道>/releases/<版本>/SHA256SUMS           ← 下载后务必校验
```

`latest.json` 的关键字段：

| 字段 | 含义 |
|---|---|
| `schema` | 清单结构版本，当前为 `1` |
| `channel_id` | 该清单属于哪个渠道（服务端会强制比对，见[渠道与白标](/deployment/channels/)） |
| `server.version` | 目标版本（不带 `v`，如 `<版本>`） |
| `server.image_tag` | 镜像 tag（带 `v`，如 `v<版本>`）；归档里同时有裸版本 tag 与渠道专属 tag `<channel-id>-<版本>`（同机多栈必须用渠道 tag） |
| `server.image_asset` | 镜像压缩包下载地址 |
| `client.version` | 随该版本镜像发布的客户端版本（与服务端同源） |
| `published_at` | 该版本的发布时间（UTC） |

- 更新服务器每个渠道**只保留最近 3 个版本**；更早的版本从
  [GitHub Release](https://github.com/picoaide/picoaide-harness/releases) 取（公开渠道的历史归档）；
- GitHub Release **只发公开渠道**（官方 / 预发布）的镜像包与 `SHA256SUMS`；品牌渠道是客户定制交付，
  不进公开 Release；
- 服务器不能出网时见[离线部署](/deployment/offline/)。

## 环境要求

| 项目 | 要求 |
|---|---|
| 服务器 | Linux x64；Docker ≥ 24 与 Compose v2（`docker compose`，不是 `docker-compose`）、`openssl`、`curl`、`unzip` |
| 资源 | 建议 ≥ 4 核 / 8GB 内存 / 50GB 可用磁盘（`pg-data/` 会持续增长）；**可用内存 < 4GiB 的机器必须显式选 `small` 档**，否则服务端启动自检会拒绝启动 |
| 网络 | 服务器需要能访问 `https://release.picoaide.com`（检查更新 + 下载镜像）；**员工电脑不需要访问任何外网** |
| 端口 | Caddy 占用宿主机 80/443（可用 `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` 改，改完要同步改 Caddyfile） |
| 客户端 | Windows x64 / macOS（Apple 芯片）/ Linux x64；员工机器无需 Node.js、pnpm 或 DSH |

## 容器架构

```
员工客户端 / 浏览器
      │ HTTPS(80/443)
      ▼
   Caddy 2（反代 + TLS 终结，固定 IP 172.28.0.2）
      │ HTTP:8080（仅 compose 私有网段）
      ▼
   Go 服务端（entrypoint 以 root 修正挂载卷属主后降权到 picoaide 用户运行，固定 IP 172.28.0.3）
      │
      ▼
   PostgreSQL 18（内置容器，固定 IP 172.28.0.4，数据 ./pg-data）
```

- 自定义 bridge 私有网段（默认 `172.28.0.0/24`，`NETWORK_SUBNET` 可改），容器 IP 在 compose 里固定声明，
  重建 / 升级后不变；
- **server 不映射宿主机端口**（只有 `expose: 8080`），外部流量只能经 Caddy 进入；
- caddy / server / postgres 三个容器的日志都带 `max-size: 50m` + `max-file: 3` 轮转。

## 数据落在哪：bind mount

| 目录 | 内容 | 丢了会怎样 |
|---|---|---|
| `picoaide-data/` | 应用数据 + **`master.key`** | 数据库中加密的上游密钥**永久无法解密** |
| `pg-data/` | PostgreSQL 18 数据 | 账号、用量、审批、审计全部丢失 |
| `caddy-data/` `caddy-config/` | Caddy 证书库与配置 | `auto` 模式需重新签发证书 |
| `certs/` | 手动证书（`manual` 模式） | 需要重新放置证书 |
| `deploy-backup/` | 备份输出 | 只是备份目录，删了等于没有退路 |

`pg-data/` 挂载到容器内 `/var/lib/postgresql`（PG 18 起数据落 `18/docker/` 子目录）——
**不要**改成旧的 `/var/lib/postgresql/data`：entrypoint 会把它判定为 "unused mount" 并拒绝启动。

## 应用访问模型：应用不需要公网入口

员工自建的 WASM 应用**只在桌面客户端内**打开：客户端为应用开一个独立窗口，加载自定义协议地址
`<渠道 app 源 scheme>://<app_id>/`（scheme 由渠道配置决定，官方与预发渠道为 `picoaide-app`），
由客户端的协议处理器转发到服务端唯一入口 `POST /api/client/v2/apps/wasm/:app_id/request`
（携带员工令牌）执行。

- 服务器**不需要**为应用准备任何公网访问面：不需要应用专用域名解析、不需要应用专用证书、
  Caddy 也不需要额外的站点块 —— 下节的三种证书模式都只服务主站域名；
- 2026-09-19 之前的"应用独立域名 + 浏览器访问"链路已整体删除；升级后旧客户端**无法再打开应用**，
  因此服务端升级后要确认员工客户端一起升到配套版本；
- **本版不提供降级通道**：不支持新旧访问模型并存，也不支持把服务端降回旧访问模型。

## 证书模式三选一

由 `.env` 的 `TLS_MODE` 决定 compose 挂载哪个 Caddyfile 模板：

| 模式 | 模板 | 适用 | 前提 |
|---|---|---|---|
| `internal` | `Caddyfile.internal` | **纯内网 / 无公网域名**（最常见） | 无；客户端首次连接需信任 Caddy 本地 CA |
| `auto` | `Caddyfile.autocert` | 有公网域名且**直连**本机 | 域名 A 记录指向本机公网 IP、80/443 对公网开放；**经 CDN 会失败**，不接受 IP |
| `manual` | `Caddyfile.manual` | 企业已有正式证书（支持 IP） | 提供 `certs/server.crt` + `certs/server.key` |

判断方法：域名解析到公网且能直连 → `auto`；否则 → `internal`。IP 部署一律 `internal` 或 `manual`。
三种模式共用同一个 compose，切换只是改 `.env` 的 `TLS_MODE` 后 `docker compose up -d`。

## 四条铁律

| # | 禁止 | 原因 |
|---|---|---|
| 1 | **绝不执行** `docker compose down -v`、`docker volume prune`、`docker system prune --volumes` | 这类命令会删数据卷与镜像层；数据虽然都在 bind mount 里，但这类命令常与"顺手清理"一起出现，是现场最常见的不可恢复事故 |
| 2 | **绝不用 `latest` 标签** | 不可复现、无法回滚锚定；一律用具体版本 tag |
| 3 | **升级前必须备份**，且确认备份文件**非空** | `picoaide-data/`（含 `master.key`）+ `pg_dump`；`master.key` 丢了，库里所有加密的上游密钥永久无法解密 |
| 4 | **不得用 `.env` 覆盖已有部署目录** | 部署目录已有 `.env` 说明部署过，那是**升级**场景，走升级流程而不是重装 |

补充：

- 不要在健康检查通过前删旧镜像 —— 它是回滚锚点；
- 不要为了让服务起来而改 compose 里的固定 IP / 网段（会与已有容器冲突）；
- 数据库迁移**不可逆**：回滚镜像不能把数据库降回旧结构，跨代回滚必须连库一起回退。

## 判据

部署（首次）成功的判据 —— 全部满足才算成功：

| # | 判据 | 命令 |
|---|---|---|
| 1 | 三个容器都是 Up（postgres 为 healthy） | `docker compose ps` |
| 2 | 健康探针返回 200 | `curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"` |
| 3 | 运行版本 == 目标版本 | `docker exec picoaide-server /app/picoaide-server --version` |
| 4 | `master.key` 存在 | `ls -1 /opt/picoaide/picoaide-data/master.key` |
| 5 | 客户端清单里有 `client.assets`，地址是**绝对 https** | `curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"` |
| 6 | 本栈渠道与镜像一致 | `docker exec picoaide-server cat /opt/picoaide/CHANNEL` 与 `GET /api/client/v2/channel` 的 `channel_id` 相同 |

**怎么算失败**：第 2 条 120 秒仍非 200、第 3 条版本不符、第 5 条出现 `client_unavailable`、
第 6 条两个渠道不一致 —— 任何一条不成立都**不要**报"部署完成"，按[边界与失败行为](#边界与失败行为)
定位；升级场景下任何一条不成立都直接走[回滚](/deployment/upgrade/)。

## 边界与失败行为

| 现象 | 判据（怎么确认） | 处置 |
|---|---|---|
| 服务端起来但员工连不上 | `internal` 模式下客户端提示证书不受信任 | 属预期：把 Caddy 本地 CA 分发给员工机器导入信任库，或改用 `manual` 挂企业证书 |
| `auto` 模式证书一直签不下来 | Caddy 日志里是 ACME 校验失败 | 域名必须**直连**本机且 80/443 对公网开放；经 CDN / 只有 IP ⇒ 改用 `manual` / `internal` |
| caddy 容器创建失败，报 `not a directory` | 挂载源 `Caddyfile.<mode>` 不存在 | `TLS_MODE` 拼写错误（只有 `internal` / `auto` / `manual` 三个取值） |
| 容器反复重启 | `docker compose logs --tail=100 server` | 常见两种：PG 密码与 `pg-data` 不一致；可用内存 < 4GiB 而档位仍是 `default`（日志里是"WASM 应用平台启动自检失败…拒绝启动"）⇒ 在 `.env` 写 `PICOAI_WASM_MEMORY_PROFILE=small` |
| healthz 一直非 200 | `docker compose ps` 看 postgres 是否 healthy | 首次启动要跑全部数据库迁移，需要 1–2 分钟；超过仍不通看服务端日志 |
| `docker compose up` 报端口/网段冲突 | `ss -tlnp`、`docker network inspect` | 改端口要**同步改 Caddyfile**；网段冲突改 `NETWORK_SUBNET` 与三个固定 IP；已有 `picoaide-net` 且子网不一致时**停下来确认**，不要 `docker network rm` |
| 员工端"检查更新永远说已是最新" | 清单里出现 `client_unavailable` | 服务端给不出绝对 https 下载地址：在 `.env` 配 `PICOAI_PUBLIC_BASE_URL=https://<域名>` 后 `docker compose up -d server` |
| 应用打不开 / 提示不可用 | 客户端版本低于服务端 | 应用只在桌面客户端内打开且要求两端同版本：把客户端升到配套版本；旧客户端打不开是预期行为，不是故障 |
| 80/443 已被同机别的服务占用 | `ss -tlnp \| grep -E ':(80\|443)\b'` | 不要抢端口：只起 `server + postgres` 并入现有反代，见[运维与排障](/deployment/operations/) |

**认账的边界**：三种形态覆盖的是"服务端放在哪、怎么暴露"这三类现实 —— 服务端始终存在，客户端始终要登录它。
完全没有 Linux 主机、也不打算准备一台的团队，只能先用别人的部署（或本机临时跑一份服务端）来评估客户端；
这种用法没有账号体系、没有集中计量，也没有集中审批与审计。

## 接下来

1. [容器化部署](/deployment/compose/) —— 从取镜像到健康检查的完整首次部署
2. [升级、备份与回滚](/deployment/upgrade/) —— 版本检查、备份、切换镜像与回退
3. [客户端分发与升级](/deployment/client-delivery/) —— 客户端随服务端发布，员工零外网
4. [渠道与白标](/deployment/channels/) —— 官方 / 预发布 / 企业定制渠道
5. [离线部署](/deployment/offline/) —— 服务器不能出网时的旁路取包
6. [运维与排障](/deployment/operations/) —— 反代、证书、备份恢复、常见故障
