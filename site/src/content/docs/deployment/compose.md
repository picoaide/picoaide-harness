---
title: 容器化部署
description: 首次部署 PicoAide Harness 企业服务端的完整步骤：检查环境、导入镜像、导出部署文件、写 .env、启动与逐项判据。
---

本页是**首次部署**的完整步骤，全程在目标服务器上执行（示例目录 `/opt/picoaide`，下称**部署目录**）。
每一步都给出**判据**（怎么算这一步成功）与失败时的处置。
升级已有部署不要走本页，走[升级、备份与回滚](/deployment/upgrade/)。

## 这一页解决什么问题

把"一台空的 Linux 服务器"变成"员工可以下载客户端并登录的企业服务端"。
本页覆盖：环境与端口检查 → 导入镜像 → 导出部署文件 → 写 `.env` → 启动 → 健康检查 → 交付给员工。

**前提**（缺任一项都不要往下走）：

| 前提 | 为什么必须先在部署前定下来 |
|---|---|
| 一个**已确认**的对外地址（域名或 IP） | 它同时决定 TLS 证书怎么签、客户端清单里的下载地址，以及员工登录页要填什么 |
| 一个**已确认**的证书模式（`internal` / `auto` / `manual`） | 模式选错不是"警告"，而是客户端连不上（见[边界与失败行为](#边界与失败行为)） |
| 初始超管密码（≥10 位） | 只在首次启动用于创建超管账号；已有超管时幂等跳过 |
| Docker ≥ 24 + Compose v2、`openssl`、`curl`、`unzip` | 部署流程本身依赖它们 |

> **如果部署目录里已经有 `.env`：立刻停下。** 那说明这台机器部署过了，你要做的是升级，
> 不是重装 —— 用 `.env.example` 覆盖它会丢掉 `SERVER_IMAGE`、`PICOAI_PUBLIC_BASE_URL` 等全部现场配置。

## 设计取舍

**为什么是一个单文件 compose。** `docker-compose.yml` 把 caddy、server、postgres 三个服务写在一个文件里，
不含任何外部依赖（没有 `env_file` 之外的引用、没有 `include`、没有 override 模板）。
这样"部署"这件事的输入只有两个：一个 `.env` 和一个镜像；没有"仓库里的 compose 与现场的 compose 不一致"
这种漂移面。宿主机已有反代时，用 `docker-compose.override.yml` 叠加（见[运维与排障](/deployment/operations/)），
而不是改主文件。

**为什么容器 IP 固定在 compose 里。** Caddy 与 server 之间的可信代理关系、审计里的客户端 IP 归属、
以及"升级只重建一个容器"都依赖"谁知道谁在哪"。固定 IP 写在同一份 compose 里，
网段冲突时**整体改**（`NETWORK_SUBNET` + `CADDY_IP`/`SERVER_IP`/`PG_IP`），避免"改了一半"导致
`X-Forwarded-For` 静默失效、登录限流桶坍缩成全组织共用一个桶。

**为什么数据必须落 bind mount。** 见[部署总览](/deployment/)的设计取舍：备份 = 打包目录、
迁移机器 = 拷贝目录、数据位置可指认；命名卷的生命周期挂在 Docker 上，`down -v` 与 `prune`
会把数据一起带走。

**为什么 server 不映射宿主机端口。** 外部流量只能经 Caddy 进入：这样"谁是对外入口"只有一个答案，
TLS 只有一份配置，服务端也不需要自己处理 80/443 与证书。反代场景下这条被显式打开一次
（override 里发布到共享反代能访问的地址），而不是默认放开。

## 概念与结构

部署目录的最终形态：

```
/opt/picoaide/                 ← 部署目录（下称 DEPLOY_DIR）
  docker-compose.yml           ┐
  Caddyfile.internal           │ 镜像导出（替换语义）
  Caddyfile.autocert           │
  Caddyfile.manual             │
  .env.example                 ┘
  .env                         ← 你创建，权限 600
  certs/server.crt|server.key  ← manual 模式需要
  picoaide-data/               ← 应用数据 + master.key（必须备份）
  pg-data/                     ← PostgreSQL 数据
  caddy-data/ caddy-config/    ← Caddy 状态（auto 模式必须备份）
  deploy-backup/               ← 备份输出
  client/                      ← 客户端安装包（由服务端对外提供）
  VERSION                      ← 当前部署版本（升级时靠它比对）
```

三个必填变量（**先跟用户确认，不要自己编**）：

| 变量 | 含义 | 示例 |
|---|---|---|
| `DOMAIN` | 员工访问的地址（域名或 IP） | `harness.example.com` 或 `10.0.0.5` |
| `TLS_MODE` | 证书模式：`internal` / `auto` / `manual` | 内网 IP → `internal` |
| `PICOAI_ADMIN_PASSWORD` | 初始超管密码（≥10 位） | 现场生成强密码 |

外加两个强烈建议一起确认的：

| 变量 | 为什么建议配 |
|---|---|
| `PICOAI_PUBLIC_BASE_URL` | 本服务端对外的绝对 https 地址。客户端更新清单里的下载地址必须是绝对 https，服务端推不出安全地址时会**按设计拒发** `client` 段（`client_unavailable`），用户看到的是"检查更新永远说已是最新"。反代场景必配 |
| `PICOAI_WASM_MEMORY_PROFILE` | 应用平台内存档位。可用内存 < 4GiB 的机器必须写 `small`，否则启动自检拒绝启动（容器反复重启） |

## 操作步骤

### 0. 检查依赖、资源与端口

```bash
docker --version && docker compose version
openssl version && curl --version | head -1
free -g | head -2 ; df -h /opt | tail -1
```

Docker 未安装时用发行版官方方式装（`apt-get install -y docker.io docker-compose-plugin`，
或 `curl -fsSL https://get.docker.com | sh`）——**不要**用本项目的任何脚本。

compose 使用私有网段 `172.28.0.0/24`（caddy=.2 / server=.3 / postgres=.4）。检查冲突：

```bash
# 网段是否已被其他 docker 网络占用？
docker network ls -q | while read -r n; do
  docker network inspect "$n" -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
done | grep -F 172.28.0.0

# 80/443 是否空闲？
ss -tlnp | grep -E ':(80|443)\b'
```

- 网段冲突 → 在 `.env` 改 `NETWORK_SUBNET` 与 `CADDY_IP` / `SERVER_IP` / `PG_IP`（**四个一起改**）；
- 端口被占用 → 改 `.env` 的 `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT`，**并同步改 Caddyfile 里的端口**；
- 已存在名为 `picoaide-net` 的网络且子网与配置不一致 → **停下来问用户**，不要 `docker network rm`
  （会断开现有容器）。

**判据**：`free -g` 的可用内存 ≥ 4GiB（否则准备好 `small` 档）；端口检查有输出说明 80/443 被占用，
按上一节处置。

### 1. 导入镜像

唯一来源是更新服务器（不经任何镜像仓库）：

```bash
# 先从清单读版本号（权威字段：server.version / server.image_tag）
curl -fsS https://release.picoaide.com/official/latest.json | grep -E '"(version|image_tag)"'
VER=<版本>            # ← 用清单里的 server.version（不带 v）
curl -fL -o /tmp/pa.zip \
  "https://release.picoaide.com/official/releases/${VER}/picoaide-server-${VER}-amd64.zip"
curl -fL -O "https://release.picoaide.com/official/releases/${VER}/SHA256SUMS"
sha256sum -c SHA256SUMS          # 校验通过再导入
unzip -p /tmp/pa.zip image.tar | docker load
```

- 导入后镜像名为 `picoaide-harness-server:<版本>`，同时存在带 `v` 的等价 tag `v<版本>`；
- 把地址里的 `official` 换成本部署的渠道 id，即取本渠道的包（品牌渠道只有这一个分发面）；
- `unzip` 缺失时先装（`apt-get install -y unzip`）；没有 `unzip` 的机器可以用
  `python3 -c 'import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extract("image.tar")' /tmp/pa.zip` 后 `docker load -i image.tar`；
- 下载慢（跨境）时可用并行分块：实测单流 75–260 KB/s，8 路并行约 2 MB/s；某些 Range 请求会被 CDN
  忽略并返回整份文件，**校验哈希仍是最终判据**。

**判据**：`sha256sum -c SHA256SUMS` 输出 `OK`；`docker image ls picoaide-harness-server` 能看到目标版本 tag。
校验不通过**不要**继续 —— 内网里没有第二条获取渠道。

### 2. 导出部署文件

```bash
IMAGE=picoaide-harness-server
VER=<版本>
mkdir -p /opt/picoaide
docker run --rm -v /opt/picoaide:/out -e PICOAI_UNPACK_STACK=/out ${IMAGE}:${VER}
ls -1 /opt/picoaide        # docker-compose.yml / Caddyfile.* / .env.example / VERSION / client/
ls -1 /opt/picoaide/client # CLIENT-RELEASE.json + 三平台安装包
```

`client/` 里是随本版本发布的客户端安装包（Windows `.exe`、macOS `.dmg`、Linux `.AppImage`），
由服务端自己对外提供，**不需要额外上传**。导出是替换语义：`client/` 与 `VERSION` 会先清旧再写。

记录版本（升级与排障都要靠它比对）：

```bash
cat /opt/picoaide/VERSION
docker run --rm --entrypoint /app/picoaide-server ${IMAGE}:${VER} --version
```

**判据**：`ls -1 /opt/picoaide` 能看到上列文件；`VERSION` 内容与 `--version` 输出**都等于**目标版本。
不要用 `docker images` 的 IMAGE ID 判断版本 —— digest 与版本号语义不同。

### 3. 生成密钥并写 `.env`

```bash
cd /opt/picoaide
openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20   # → PG_PASSWORD
openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20   # → PICOAI_ADMIN_PASSWORD
```

把生成的密码**同时记录给用户**（不要只留在终端输出里）。然后：

```bash
cd /opt/picoaide
cat > .env <<'EOF'
DOMAIN=<确认过的域名或IP>
TLS_MODE=<internal|auto|manual>
ADMIN_USER=admin
PICOAI_ADMIN_PASSWORD=<刚生成的超管密码>
PG_PASSWORD=<刚生成的数据库密码>
TZ=Asia/Shanghai
# 对外绝对地址：反代场景必配，否则客户端更新清单拒发下载链接
PICOAI_PUBLIC_BASE_URL=https://<确认过的域名>
# 可用内存 < 4GiB 的机器必须写 small
# PICOAI_WASM_MEMORY_PROFILE=small
EOF
chmod 600 .env
```

必填的只有 `DOMAIN`、`TLS_MODE`、`PICOAI_ADMIN_PASSWORD` 与 `PG_PASSWORD`，其余键都有默认值。
常用可选项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `SERVER_IMAGE` | `picoaide-harness-server:latest` | **必须显式写版本 tag**；`latest` 不可复现，也无法做回滚锚点 |
| `PICOAI_PUBLIC_BASE_URL` | 按请求推导 | 配了就是**唯一权威**；客户端下载地址必须绝对 https |
| `PICOAI_TRUSTED_PROXIES` | 从 `CADDY_IP` 派生 | 可信反代地址，登录/MFA/OIDC 限流据此解析真实客户端 IP；换反代时才显式写 |
| `PICOAI_CHANNEL` | 空（用镜像自带渠道） | **留空即可**；填了必须与镜像内渠道一致，否则拒绝启动 |
| `PICOAI_UPDATE_ENDPOINT` | 空 = 本渠道默认目录 | **留空不等于关闭**；要关闭更新检查写 `off` |
| `PICOAI_LOGIN_MAX_ATTEMPTS` | 服务端默认 | 仅测试环境建议调大，免得反复登录锁死管理员账号 |
| `NETWORK_SUBNET` / `CADDY_IP` / `SERVER_IP` / `PG_IP` | `172.28.0.0/24` 与 `.2/.3/.4` | 网段冲突时整体改 |
| `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` | `80` / `443` | 改端口需同步改 Caddyfile |
| `PICOAI_COMPILE_ISOLATION` | `auto` | 应用编译子进程的 OS 级隔离档；生产建议 `require`（隔离不可用就拒绝启动） |

> `PICOAI_ADMIN_PASSWORD` 只在**首次启动**用于创建超管（已有 admin 时幂等跳过）；
> 首次登录成功后可以把该行置空，避免明文长期留在文件里。

**判据**：`ls -l .env` 权限是 `-rw-------`（600）；`grep -c '^DOMAIN=' .env` 为 1。
写入前再确认一次 `TLS_MODE` 的三个取值之一 —— 写错的表现是 caddy 容器创建即失败。

#### `manual` 模式才需要：放置证书

```bash
cd /opt/picoaide && mkdir -p certs
# 无正式证书时先生成自签占位（10 年，SAN = 你的域名/IP）
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/CN=<DOMAIN>" -addext "subjectAltName=DNS:<DOMAIN>"
chmod 600 certs/server.key
```

企业有正式 PEM 时直接覆盖这两个文件（文件名必须一致），然后 `docker compose restart caddy`。
`internal` / `auto` 模式**跳过本步**（Caddy 自己管证书）。

### 4. 启动与健康检查

```bash
cd /opt/picoaide
docker compose up -d
docker compose ps        # 期望 picoaide-caddy / picoaide-server / picoaide-postgres 均 Up
```

首次启动会跑全部数据库迁移（当前区间 `0001–0084`）并建用量分区，**可能需要 1–2 分钟**；
`up -d` 返回不等于服务就绪 —— 必须做健康检查：

```bash
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
for i in $(seq 1 40); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
    --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz")
  echo "第 ${i} 次: HTTP $code"
  [ "$code" = "200" ] && break
  sleep 3
done
```

**判据**：40 次循环内拿到 `200`。120 秒仍非 200 → **视为失败**：`docker compose logs --tail=100 server`
定位后重来，**不要**在健康检查未通过时报"部署完成"。
`CADDY_HTTPS_PORT` 不是 443 时，把上面两处 `443` 换成实际端口。

### 5. 部署自检

```bash
cd /opt/picoaide
docker compose ps                                   # 三容器 Up
docker exec picoaide-server /app/picoaide-server --version   # == 目标版本
ls -1 /opt/picoaide/picoaide-data/master.key        # master.key 存在（必须长期保留）
docker exec picoaide-server cat /opt/picoaide/CHANNEL        # 本栈渠道
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/channel"
```

最后两条要能看到 `client.assets` 且 `url` 是**绝对 https**；出现 `client_unavailable`
说明 `PICOAI_PUBLIC_BASE_URL` 没配。`/api/client/v2/channel` 的 `channel_id` 必须与
`/opt/picoaide/CHANNEL` 一致。

### 6. 交付给员工

1. 把访问地址 `https://$DOMAIN` 告诉员工，客户端登录页填入该地址即可；
2. 员工也可以直接打开门户页（`/` 或 `/portal`）下载三平台安装包；
3. 管理员登录 `/admin/`，在**网关**页配置上游供应商、默认模型、定价与登录方式，见[管理后台](/admin/)；
4. 交付时**明确告知运维**：`picoaide-data/master.key` 必须长期保留并单独备份。

## 判据汇总

| # | 判据 | 怎么判 |
|---|---|---|
| 1 | 镜像可用且版本正确 | `docker run --rm --entrypoint /app/picoaide-server <镜像> --version` == 目标版本 |
| 2 | 部署文件导出完整 | `/opt/picoaide` 里有 compose、三个 Caddyfile、`.env.example`、`VERSION`、`client/` |
| 3 | `.env` 就位且不外泄 | 权限 `600`，`TLS_MODE` 是三个取值之一，`SERVER_IMAGE` 是具体版本 |
| 4 | 三容器 Up | `docker compose ps` |
| 5 | 探针 200 | `/healthz` 返回 200 |
| 6 | 数据目录就位 | `picoaide-data/master.key` 存在；`pg-data/` 有内容 |
| 7 | 客户端分发自洽 | 清单有 `client.assets` 且 url 绝对 https |
| 8 | 渠道自洽 | `/opt/picoaide/CHANNEL` == `/api/client/v2/channel` 的 `channel_id` |

## 边界与失败行为

| 现象 | 判据 | 恢复动作 |
|---|---|---|
| `.env` 已存在 | `ls /opt/picoaide/.env` | **停止**，转[升级、备份与回滚](/deployment/upgrade/)；覆盖 `.env` 会丢掉现场配置 |
| `docker compose up` 报端口占用 | 报错点名 80 或 443 | 改 `CADDY_HTTP_PORT`/`CADDY_HTTPS_PORT` **并同步改 Caddyfile**；或走共享反代方案 |
| 报网段冲突 | `docker network ls` 里已有同子网网络 | 改 `NETWORK_SUBNET` 与三个固定 IP；已有 `picoaide-net` 且子网不一致时先确认再动 |
| caddy 容器创建失败：`not a directory` | `docker compose ps` 里 caddy 不存在 | `TLS_MODE` 拼写错误（挂载源 `Caddyfile.<mode>` 不存在） |
| postgres 启动即退出 | 日志提 `OLD_DATABASES` / `unused mount` | PG16 时代的旧数据布局：先按 PostgreSQL 官方 dump/restore 迁移，再部署 |
| 服务端反复重启 | 日志提"WASM 应用平台启动自检失败…拒绝启动" | 可用内存 < 4GiB：在 `.env` 写 `PICOAI_WASM_MEMORY_PROFILE=small` 后 `docker compose up -d server` |
| healthz 超过 2 分钟非 200 | `docker compose ps` postgres 不是 healthy | 先看 `docker compose logs --tail=100 postgres`（密码与 `pg-data` 不一致最常见），再 `docker compose logs server` |
| 清单里 `client_unavailable` | 该字段存在 | 配 `PICOAI_PUBLIC_BASE_URL=https://<域名>` 后 `docker compose up -d server` |
| 客户端首次连接报证书不受信任 | 仅 `internal` 模式 | 把 Caddy 本地 CA 分发给员工机器导入信任库，或改用 `manual` |
| 渠道不一致 | `/opt/picoaide/CHANNEL` ≠ `/api/client/v2/channel` 的 `channel_id` | 容器启动期会拒绝；检查 `.env` 是否残留 `PICOAI_CHANNEL=official`（定制渠道部署要删掉这一行） |

## 相关

- [部署总览](/deployment/) —— 形态选择、交付物、证书模式与四条铁律
- [升级、备份与回滚](/deployment/upgrade/) —— 已有部署的下一个动作
- [客户端分发与升级](/deployment/client-delivery/) —— 员工怎么拿到客户端
- [渠道与白标](/deployment/channels/) —— 渠道内容与渠道隔离
- [离线部署](/deployment/offline/) —— 服务器不能出网时怎么取包
- [运维与排障](/deployment/operations/) —— 共享反代、备份恢复、常见故障
