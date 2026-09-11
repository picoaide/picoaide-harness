---
title: 容器化部署
description: 首次部署 PicoAide Harness 服务端：取镜像、导出部署文件、写 .env、启动与健康检查。
---

本页是**首次部署**的完整步骤，全程在目标服务器上执行（示例目录 `/opt/picoaide`，下称部署目录）。
升级已有部署请看[升级、备份与回滚](/deployment/upgrade/)。

## 0. 先确认三件事

| 变量 | 含义 | 示例 |
|---|---|---|
| `DOMAIN` | 员工访问的地址（域名或 IP） | `ai.example.com` 或 `10.0.0.5` |
| `TLS_MODE` | 证书模式：`internal` / `auto` / `manual` | 内网 IP → `internal` |
| `PICOAI_ADMIN_PASSWORD` | 初始超管密码（≥10 位） | 现场生成强密码 |

强烈建议**一并确认** `PICOAI_PUBLIC_BASE_URL`（本服务端对外的绝对 https 地址）：
客户端更新清单里的下载地址必须是绝对 https，服务端推不出安全地址时会按设计拒发 `client` 段
（`client_unavailable`），用户看到的现象是"检查更新永远说已是最新"。反代场景必配。

## 1. 检查依赖、资源与端口

```bash
docker --version && docker compose version
openssl version && curl --version | head -1
free -g | head -2 ; df -h /opt | tail -1
```

Docker 未安装时用发行版官方方式安装（`apt-get install -y docker.io docker-compose-plugin` 或
`curl -fsSL https://get.docker.com | sh`）。

compose 使用私有网段 `172.28.0.0/24`（caddy=.2 / server=.3 / postgres=.4）。检查冲突：

```bash
# 网段是否已被其他 docker 网络占用？
docker network ls -q | while read -r n; do
  docker network inspect "$n" -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
done | grep -F 172.28.0.0

# 80/443 是否空闲？
ss -tlnp | grep -E ':(80|443)\b'
```

- 网段冲突 → 在 `.env` 改 `NETWORK_SUBNET` 与 `CADDY_IP` / `SERVER_IP` / `PG_IP`；
- 端口被占用 → 改 `.env` 的 `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT`，**并同步改 Caddyfile 里的端口**；
- 已存在名为 `picoaide-net` 的网络且子网不一致 → 停下来确认，**不要** `docker network rm`（会断开现有容器）。

若 80/443 被同机其他服务占用（共享反代），不要抢端口：见[运维与排障 § 宿主机已有反向代理](/deployment/operations/#宿主机已有反向代理)。

## 2. 导入镜像

从更新服务器读版本并下载镜像包（这是唯一来源）：

```bash
curl -fsS https://release.picoaide.com/official/latest.json | grep -E '"(version|image_tag)"'
VER=2.7.0            # ← 用清单里的 server.version（不带 v）
curl -fL -o /tmp/pa.zip \
  "https://release.picoaide.com/official/releases/${VER}/picoaide-server-${VER}-amd64.zip"
curl -fL -O "https://release.picoaide.com/official/releases/${VER}/SHA256SUMS"
sha256sum -c SHA256SUMS          # 务必校验通过再导入
unzip -p /tmp/pa.zip image.tar | docker load
```

- 导入后镜像名为 `picoaide-harness-server:<VER>`，同时存在带 v 的等价 tag `picoaide-harness-server:v<VER>`；
- 把清单地址里的 `official` 换成本部署的渠道 id 即取本渠道的包（品牌渠道只有这一个分发面）；
- 下载慢时可用并行分块（实测单流 75–260 KB/s，8 路并行约 5 分钟），做法与坑见仓库
  [`docs/planning/2026-09-10-r2-update-server-runbook.md`](https://github.com/picoaide/picoaide-harness/blob/master/docs/planning/2026-09-10-r2-update-server-runbook.md) §11。

## 3. 导出部署文件

```bash
IMAGE=picoaide-harness-server
VER=2.7.0
mkdir -p /opt/picoaide
docker run --rm -v /opt/picoaide:/out -e PICOAI_UNPACK_STACK=/out ${IMAGE}:${VER}
ls -1 /opt/picoaide        # docker-compose.yml / Caddyfile.* / .env.example / VERSION / client/
ls -1 /opt/picoaide/client # CLIENT-RELEASE.json + 三平台安装包
```

`client/` 里是随本版本发布的客户端安装包（Windows `.exe`、macOS `.dmg`、Linux `.AppImage`），
由服务端自己对外提供，不需要额外上传。

记录当前版本（升级与排障都要靠它比对）：

```bash
cat /opt/picoaide/VERSION
docker run --rm --entrypoint /app/picoaide-server ${IMAGE}:${VER} --version
```

两者都必须等于目标版本。不要用 `docker images` 的 IMAGE ID 判断版本 —— digest 与版本号语义不同。

## 4. 生成密钥并写 `.env`

```bash
cd /opt/picoaide
openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20   # → PG_PASSWORD
openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20   # → PICOAI_ADMIN_PASSWORD
```

**若 `.env` 已存在 → 停止**：这是升级场景，转[升级、备份与回滚](/deployment/upgrade/)。

```bash
cd /opt/picoaide
cat > .env <<'EOF'
DOMAIN=ai.example.com
TLS_MODE=internal
ADMIN_USER=admin
PICOAI_ADMIN_PASSWORD=<刚生成的超管密码>
PG_PASSWORD=<刚生成的数据库密码>
TZ=Asia/Shanghai
# 对外绝对地址：反代场景必配，否则客户端更新清单拒发下载链接
PICOAI_PUBLIC_BASE_URL=https://ai.example.com
EOF
chmod 600 .env
```

必填的只有 `DOMAIN`、`TLS_MODE`、`PICOAI_ADMIN_PASSWORD` 与 `PG_PASSWORD`，其余键都有默认值。常用可选项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `SERVER_IMAGE` | `picoaide-harness-server:latest` | 部署与升级都显式写版本 tag；`latest` 不可复现 |
| `PICOAI_PUBLIC_BASE_URL` | 按请求推导 | 配了就是**唯一权威**；客户端下载地址必须绝对 https |
| `PICOAI_TRUSTED_PROXIES` | `172.28.0.2` | 可信反代地址，登录限流据此解析真实客户端 IP；换网段/换反代时要改 |
| `PICOAI_CHANNEL` | 空（用镜像自带渠道） | **留空即可**；填了必须与镜像内渠道一致，否则拒绝启动 |
| `PICOAI_UPDATE_ENDPOINT` | 空 = 本渠道默认目录 | **留空不等于关闭**；要关闭更新检查写 `off` |
| `PICOAI_LOGIN_MAX_ATTEMPTS` | 服务端默认 | 仅测试环境建议调大，免得反复登录锁死管理员账号 |
| `NETWORK_SUBNET` / `CADDY_IP` / `SERVER_IP` / `PG_IP` | `172.28.0.0/24` 与 `.2/.3/.4` | 网段冲突时整体改 |
| `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` | `80` / `443` | 改端口需同步改 Caddyfile |

> `PICOAI_ADMIN_PASSWORD` 只在**首次启动**用于创建超管（已有 admin 时幂等跳过），
> 首次登录成功后可以把该行置空，避免明文长期留在文件里。

### `manual` 模式才需要：放置证书

```bash
cd /opt/picoaide && mkdir -p certs
# 无正式证书时先生成自签占位（10 年，SAN = 你的域名/IP）
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/CN=<DOMAIN>" -addext "subjectAltName=DNS:<DOMAIN>"
chmod 600 certs/server.key
```

企业有正式 PEM 时直接覆盖这两个文件（文件名必须一致）。`internal` / `auto` 模式跳过本步。

## 5. 启动与健康检查

```bash
cd /opt/picoaide
docker compose up -d
docker compose ps        # 期望 picoaide-caddy / picoaide-server / picoaide-postgres 均 Up
```

首次启动会跑全部数据库迁移并建用量分区，**可能需要 1–2 分钟**；`up -d` 返回不等于服务就绪。

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

- `200` → 继续下一步；120 秒仍非 200 → 视为失败：`docker compose logs --tail=100` 修好再继续，
  **不要**在健康检查未通过时报"部署完成"；
- `CADDY_HTTPS_PORT` 不是 443 时，把上面两处 `443` 换成实际端口。

### 部署自检清单

```bash
cd /opt/picoaide
docker compose ps                                   # 三容器 Up
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"
ls -1 /opt/picoaide/picoaide-data/master.key        # master.key 存在（必须长期保留）
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
```

最后一条要能看到 `client.assets` 且 `url` 是**绝对 https**；出现 `client_unavailable`
说明 `PICOAI_PUBLIC_BASE_URL` 没配，员工端会表现为"客户端检查更新永远说已是最新"。

## 6. 交付给员工

1. 把访问地址 `https://$DOMAIN` 告诉员工，客户端登录页填入该地址即可；
2. 员工也可以直接打开门户页（`/` 或 `/portal`）下载三平台安装包；
3. 管理员登录 `/admin/`，在**网关**页配置上游供应商、默认模型、限价与登录方式，
   详见[管理后台](/admin/)；
4. 首次交付前**明确告知运维**：`picoaide-data/master.key` 必须长期保留并单独备份。

客户端如何取包、如何随服务端升级，见[客户端分发与升级](/deployment/client-delivery/)。
