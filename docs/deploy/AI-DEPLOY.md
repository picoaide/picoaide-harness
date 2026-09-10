# PicoAide Harness 服务端部署与升级说明（AI 执行版）

> **这份文档是唯一交付物。** 没有安装脚本、没有 deploy.sh、没有 GitHub 依赖。
> 使用者是 **AI 代理**（Claude / DeepSeek / 内部 Agent）或运维工程师 —— 两种读者都按同一套步骤执行。
>
> 执行前先读完整份文档。**§1 的四条铁律违反会造成数据不可恢复的损失。**

---

## §0 这份文档解决什么

在一台 Linux 服务器上部署 PicoAide Harness 服务端，并在后续版本发布时升级它。
服务端镜像**自带客户端安装包**（Windows / macOS / Linux 三平台），员工客户端从这台服务器下载，
因此**服务端升级后客户端会自动跟着升级**，不会出现版本错配。

```
更新服务器 release.picoaide.com (R2)      ← 只放服务端镜像
        │  检查新版本 / 下载镜像
        ▼
客户服务器（本文档的部署目标）            ← 镜像里已含客户端安装包
        │  员工客户端下载
        ▼
员工电脑（Windows / macOS / Linux）
```

**服务器需要能访问 `https://release.picoaide.com`**（检查更新与下载镜像）。
这是唯一的外部依赖；员工电脑不需要访问任何外网。

---

## §1 四条铁律（违反会造成不可恢复的数据损失）

| # | 禁止 | 原因 |
|---|---|---|
| 1 | **绝不执行** `docker compose down -v`、`docker volume prune`、`docker system prune --volumes` | `-v` / `prune` 会删除数据卷与镜像层，**数据库和 master.key 一起没**。数据在 bind mount 目录里，`down`（不带 `-v`）不会删 |
| 2 | **绝不用 `latest` 标签** | 不可复现、无法回滚锚定。一律用 `vX.Y.Z` 具体版本 |
| 3 | **升级前必须备份**，且确认备份文件非空 | `picoaide-data`（含 `master.key`）+ `pg_dump`。**`master.key` 丢了，数据库里所有加密的上游密钥永久无法解密** |
| 4 | **不得用 `.env` 覆盖已有部署目录** | 部署目录已存在 `.env` 说明已部署过 —— 那是**升级**场景，走 §6，不要重装 |

补充禁令：

- 不要用 `docker compose down` 之后 `rm -rf` 任何 `*-data/` 目录；
- 不要在健康检查通过前删掉旧镜像 —— 它是回滚的唯一锚点；
- 不要为了让服务起来而修改 `docker-compose.yml` 里的固定 IP / 网段（会与已有容器冲突）；
- 数据库迁移是**不可逆**的：一旦新版本含新增迁移，回滚镜像**不能**把数据库降回旧结构（见 §7）。

---

## §2 交付形态：只有一个镜像

所有文件都在镜像里。用一条命令把它们导到部署目录即可，不需要克隆仓库、不需要下载配置。

```
发布物 = 一个容器镜像（内含：服务端二进制 + webadmin + 客户端安装包 + compose + Caddyfile）
```

### 2.1 目标目录布局（本文档全程用 `/opt/picoaide`）

```
/opt/picoaide/                 ← 部署目录（下称 DEPLOY_DIR）
  docker-compose.yml           ┐
  Caddyfile.internal           │ 由镜像导出（步骤 3.2）
  Caddyfile.autocert           │
  Caddyfile.manual             │
  .env.example                 ┘
  .env                         ← 你创建（步骤 4.3），权限 600
  certs/server.crt|server.key  ← manual 模式需要（步骤 4.4）
  picoaide-data/               ← 应用数据 + master.key（**必须备份**）
  pg-data/                     ← PostgreSQL 数据
  caddy-data/ caddy-config/    ← Caddy 状态
  deploy-backup/               ← 备份输出
  client/                      ← 客户端安装包（给员工下载；由服务端自己对外提供）
  VERSION                      ← 当前部署版本（用于比对是否需要升级）
```

### 2.2 三个对外变量（**先向用户确认，不要自己编**）

| 变量 | 含义 | 示例 |
|---|---|---|
| `DOMAIN` | 员工访问的地址（域名或 IP） | `ai.example.com` 或 `10.0.0.5` |
| `TLS_MODE` | 证书模式，见 §2.3 | `internal` / `auto` / `manual` |
| `PICOAI_ADMIN_PASSWORD` | 初始超管密码（≥10 位） | 由你生成强密码 |

另外有一个**强烈建议一并确认**的变量（不确认也能跑，但反代场景下会踩坑）：

| 变量 | 含义 | 何时必须配 |
|---|---|---|
| `PICOAI_PUBLIC_BASE_URL` | 本服务端对外的**绝对 https 地址** | 宿主机已有别的反代（附录 A）、或反代不设 `X-Forwarded-Proto`、或服务端判断不出协议时 |

> 为什么重要：客户端更新清单里的下载地址必须是**绝对 https**（客户端会整份丢弃非
> https 的清单）。服务端推不出安全地址时会**按设计拒发** `client` 段并给出
> `client_unavailable` 原因 —— 用户看到的表现是"检查更新永远说已是最新"。
> 2026-09-10 在测试环境实测踩到（容器前面是宿主机共享 Caddy），配了该变量即恢复。

### 2.3 证书模式怎么选（选错会连不上）

| 模式 | 用 Caddyfile | 适用 | 前提 |
|---|---|---|---|
| `internal` | `Caddyfile.internal` | **纯内网 / 无公网域名**（最常见） | 无。客户端首次连接需信任 Caddy 本地 CA |
| `auto` | `Caddyfile.autocert` | 有公网域名且**直连**本机 | 域名 A 记录指向本机公网 IP；**80/443 对公网开放**（Let's Encrypt HTTP-01 校验）；域名经 CDN 会失败 |
| `manual` | `Caddyfile.manual` | 企业已有正式证书 | 需提供 `certs/server.crt` + `certs/server.key` |

**判断方法**：域名解析到公网且能直连 → `auto`；否则 → `internal`。
`auto` 模式**不接受 IP**（Let's Encrypt 不为 IP 签证书），IP 部署一律 `internal`。

---

## §3 阶段一：准备（只读检查，不改系统）

### 3.1 检查依赖与资源

```bash
docker --version && docker compose version
openssl version
curl --version | head -1
free -g | head -2 ; df -h /opt | tail -1
```

要求：Docker ≥ 24、Compose v2（`docker compose`，不是 `docker-compose`）、openssl、curl。
建议：**≥ 4 核 / 8GB 内存 / 50GB 可用磁盘**（`pg-data` 会持续增长）。

> 若 Docker 未安装，先装（不要用本项目的任何脚本，用发行版官方方式）：
> `curl -fsSL https://get.docker.com | sh` 或 `apt-get install -y docker.io docker-compose-plugin`。

### 3.2 导入镜像

**唯一来源 = 更新服务器**（2026-09-10 起不再使用任何镜像仓库）：

```bash
# 先从清单里读版本号(权威):server.version / server.image_tag
curl -fsS https://release.picoaide.com/official/latest.json | grep -E '"(version|image_tag)"'
VER=2.7.0                     # ← 用上面读到的 server.version(不带 v)
curl -fL -o /tmp/pa.zip \
  "https://release.picoaide.com/${CHANNEL}/releases/${VER}/picoaide-server-${VER}-amd64.zip"
unzip -p /tmp/pa.zip image.tar | docker load
# unzip 缺失时：apt-get install -y unzip（或 yum install -y unzip）
```

导入后的镜像名：**`picoaide-harness-server:<VER>`**，同时存在**带 v 的等价 tag**
`picoaide-harness-server:v<VER>`（CI 打的第一个 tag 是带 v 的，部署示例用不带 v 的，
所以镜像 tar 里两个都带，`docker load` 后都能用 —— 2026-09-10 修：此前只带 v 形式，
照本文档敲 `docker run ${IMAGE}:${VER}` 会去 docker.io 拉取而在隔离网/镜像代理下 403）。

> **下载慢（跨境）**：实测单流 75–260 KB/s（616MB ≈ 40–90 分钟），**8 路并行分块可到
> ~2 MB/s（约 5 分钟）**，做法与坑（某些 Range 请求会被 CDN 忽略、返回整份）见
> [`r2-update-server-runbook.md` §11](../planning/2026-09-10-r2-update-server-runbook.md)。
> 下完**务必用同目录的 `SHA256SUMS` 校验**再 `docker load`。

### 3.3 导出部署文件到目标目录

```bash
IMAGE=picoaide-harness-server
VER=2.7.0
mkdir -p /opt/picoaide
docker run --rm -v /opt/picoaide:/out -e PICOAI_UNPACK_STACK=/out ${IMAGE}:${VER}
ls -1 /opt/picoaide     # 应看到 docker-compose.yml / Caddyfile* / .env.example / VERSION / client/
ls -1 /opt/picoaide/client
#   CLIENT-RELEASE.json + 三平台安装包：
#   Windows *-Setup.exe / macOS *.dmg / Linux *.AppImage
#   （Linux 只带 AppImage —— deb 与它是同一个应用的两种打包，员工装一个即可，
#    2026-09-10 定案：deb 不再进镜像，给每个渠道省 ~115MB）
```

### 3.4 记录当前版本（升级时要靠它比对）

```bash
cat /opt/picoaide/VERSION                       # 期望输出 2.7.0
docker run --rm --entrypoint /app/picoaide-server ${IMAGE}:${VER} --version
```

> **这两条是"部署成功"的权威判据之一**：`VERSION` 文件内容与 `--version` 输出必须都等于目标版本。
> 不要用 `docker images` 的 IMAGE ID 判断版本 —— digest 语义与版本号不同。

---

## §4 阶段二：首次部署

### 4.1 检查网段冲突（固定 IP 部署的必须步骤）

compose 使用私有网段 `172.28.0.0/24`（caddy=.2 / server=.3 / postgres=.4）。

```bash
# 网段是否已被其他 docker 网络占用？
docker network ls -q | while read -r n; do
  docker network inspect "$n" -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
done | grep -F 172.28.0.0

# 端口是否空闲？
ss -tlnp | grep -E ':(80|443)\b'
```

- 网段被占用 → 在 `.env` 里改 `NETWORK_SUBNET`（如 `172.30.0.0/24`）与 `CADDY_IP`/`SERVER_IP`/`PG_IP`；
- 端口被占用 → 改 `.env` 的 `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT`，**并同步改 Caddyfile 里的端口**；
- 已存在名为 `picoaide-net` 的网络 → 若子网与配置不一致，**停下来问用户**，不要 `network rm`（会断开现有容器）。

### 4.2 生成密钥材料

```bash
cd /opt/picoaide
openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20    # → PG_PASSWORD
openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20    # → PICOAI_ADMIN_PASSWORD
```

把生成的密码**同时记录给用户**（不要只留在终端输出里）。

### 4.3 写 `.env`

若 `/opt/picoaide/.env` **已存在 → 停止**，这是升级场景，转 §6。

```bash
cd /opt/picoaide
cat > .env <<'EOF'
DOMAIN=<确认过的域名或IP>
TLS_MODE=<internal|auto|manual>
ADMIN_USER=admin
PICOAI_ADMIN_PASSWORD=<刚生成的超管密码>
PG_PASSWORD=<刚生成的数据库密码>
TZ=Asia/Shanghai
# 对外绝对地址(§2.2):反代场景必配,否则客户端更新清单拒发下载链接
PICOAI_PUBLIC_BASE_URL=https://<确认过的域名>
# 仅测试环境建议放开登录失败上限,免得反复登录锁死管理员账号
# PICOAI_LOGIN_MAX_ATTEMPTS=100000
EOF
chmod 600 .env
```

> `PICOAI_ADMIN_PASSWORD` 只在**首次启动**用于创建超管（已有 admin 时幂等跳过）。
> 首次登录成功后可以把该行置空，避免明文长期留在文件里。

### 4.4 `manual` 模式才需要：放置证书

```bash
cd /opt/picoaide && mkdir -p certs
# 无正式证书时先生成自签占位（10 年，SAN=你的域名/IP）：
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/CN=<DOMAIN>" -addext "subjectAltName=DNS:<DOMAIN>"
chmod 600 certs/server.key
```

企业有正式 PEM 时直接覆盖这两个文件（文件名必须一致）。
`internal` / `auto` 模式**跳过本步**（Caddy 自己管证书）。

### 4.5 启动

```bash
cd /opt/picoaide
docker compose up -d
docker compose ps          # 期望 picoaide-caddy / picoaide-server / picoaide-postgres 均 Up
```

> 首次启动会跑全部数据库迁移（60+ 条）并建用量分区，**可能需要 1–2 分钟**。
> `docker compose up -d` 返回不等于服务就绪 —— 必须做 4.6 的健康检查。

### 4.6 健康检查（**必须通过，否则不算部署成功**）

```bash
cd /opt/picoaide
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
for i in $(seq 1 40); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
    --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz")
  echo "第 ${i} 次: HTTP $code"
  [ "$code" = "200" ] && break
  sleep 3
done
```

- `200` → 继续 4.7；
- 120 秒仍非 200 → **视为失败**：`docker compose logs --tail=100`，修好再继续。
  **不要**在健康检查未通过时报"部署完成"。

> 若 `CADDY_HTTPS_PORT` 不是 443，把上面两处 `443` 换成实际端口。

### 4.7 验证并交付

```bash
cd /opt/picoaide
docker compose ps                                  # 三容器 Up
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"   # {"ok":true...}
docker exec picoaide-server sh -c 'ls -1 /data'     # 应有 master.key
ls -1 /opt/picoaide/picoaide-data/master.key        # master.key 存在（**必须长期保留**）
```

然后向用户报告：访问地址、管理员用户名、管理员密码、数据目录、证书模式，并**明确提示**：

1. `picoaide-data/master.key` 必须长期保留并单独备份 —— 丢失后数据库内加密的上游密钥不可恢复；
2. 登录 webadmin 后到「网关」页填写「对外访问地址」= `https://$DOMAIN`；
3. 员工客户端安装包由服务器对外提供（员工从 `https://$DOMAIN` 下载或由客户端自动更新）。

---

## §5 阶段三：交付给员工

服务端启动后自动提供客户端安装包，**不需要额外上传**：

```bash
# 客户端更新清单（含版本与各平台安装包哈希）
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"

# 安装包下载（自动支持断点续传）
curl -skO --resolve "$DOMAIN:443:127.0.0.1" \
  "https://$DOMAIN/updates/client/<清单里的文件名>"
```

把 `https://$DOMAIN` 告诉员工，让他们在客户端登录页填入该地址即可。
**客户端版本由服务端决定** —— 服务端升级后，员工的客户端会自动提示升级到配套版本。

---

## §6 升级

### 6.1 检查是否有新版本

```bash
curl -fsS https://release.picoaide.com/official/latest.json | \
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
cat /opt/picoaide/VERSION        # 当前版本
```

（也可以在 webadmin「服务器信息」页看到"发现新版本"提示，那里还会显示升级目标 tag。）
若远端版本 ≤ 当前版本 → **无需升级**，结束。

### 6.2 升级前的必做检查

```bash
cd /opt/picoaide

# (a) PG 18 数据布局检查 —— 旧布局直接启动会被拒绝且可能损坏数据
[ -f pg-data/PG_VERSION ] && echo "!!! 旧版 PG16 布局，必须先做 dump/restore 迁移，停止升级" || echo "PG 布局 OK"

# (b) 磁盘余量（镜像 + 备份需要空间）
df -h /opt | tail -1
```

出现 `!!!` 时**停止**：按 PostgreSQL 官方 dump/restore 流程迁移数据后再说。

### 6.3 备份（**不可跳过**）

```bash
cd /opt/picoaide
TS=$(date +%Y%m%d-%H%M%S); OUT=deploy-backup; mkdir -p "$OUT"

# 应用数据（含 master.key）
docker exec picoaide-server sh -c 'tar czf - -C /data .' > "$OUT/picoaide-data-$TS.tar.gz"

# 数据库（自定义格式，在线安全）
docker exec picoaide-postgres pg_dump -U picoaide -Fc picoaide > "$OUT/pg-data-$TS.dump"

# auto 模式额外备份证书库
[ -d caddy-data ] && tar czf "$OUT/caddy-data-$TS.tar.gz" -C . caddy-data

ls -lh "$OUT" | tail -5
```

**验证备份非空**（否则后面的升级没有退路）：

```bash
[ -s "$OUT/picoaide-data-$TS.tar.gz" ] || echo "!!! 应用数据备份为空"
[ -s "$OUT/pg-data-$TS.dump" ]          || echo "!!! 数据库备份为空"
```

### 6.4 拉取/导入新镜像

```bash
VER=<6.1 得到的版本>
IMAGE=picoaide-harness-server

curl -fL -o /tmp/pa.zip \
  "https://release.picoaide.com/official/releases/${VER}/picoaide-server-${VER}-amd64.zip"
unzip -p /tmp/pa.zip image.tar | docker load
```

### 6.5 切换版本并重启

```bash
cd /opt/picoaide
# SERVER_IMAGE 用 latest.json 里的 server.image_tag(权威,形如 v2.7.0);
# 镜像里 v2.7.0 与 2.7.0 两个 tag 都在,写哪个都能起来(§3.2)。
sed -i "s|^SERVER_IMAGE=.*|SERVER_IMAGE=${IMAGE}:${VER}|" .env
grep -q '^SERVER_IMAGE=' .env || echo "SERVER_IMAGE=${IMAGE}:${VER}" >> .env
docker compose up -d
```

> `docker compose up -d` 只重建变化的容器；`picoaide-data` / `pg-data` / `caddy-data` 是 bind mount，**数据不受影响**。
> **宿主机已有反代时**（附录 A）：只重建本产品容器 `docker compose up -d postgres server`，
> 别把共享反代牵进来。

### 6.6 升级后验证（三项全过才算成功）

```bash
cd /opt/picoaide
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)

# (a) 健康检查
for i in $(seq 1 40); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
    --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz")
  [ "$code" = "200" ] && { echo "healthz OK"; break; }; sleep 3
done

# (b) 运行版本 == 目标版本（权威判据）
docker exec picoaide-server /app/picoaide-server --version

# (c) 数据仍在（迁移已应用）
docker exec picoaide-postgres psql -U picoaide -d picoaide -c 'select count(*) from users;'
```

**三项有任何一项失败 → 执行 §7 回滚，不要继续。**

### 6.7 收尾

```bash
cd /opt/picoaide
echo "$VER" > VERSION                       # 更新本地版本记录
docker compose ps                           # 三容器 Up
# 旧镜像先留着（回滚锚点）；确认稳定运行 1～2 天后再清理：
# docker image rm picoaide-harness-server:<旧版本>
```

客户端会在下次检查时看到新版本并提示员工升级（升级源就是这台服务器）。

---

## §7 回滚

**前提：确认新版本是否引入了数据库迁移。** 若引入了，回滚镜像后数据库结构仍是新的，
服务端可能报错 —— 此时正确做法是**向前修复**（发布修复版）或**恢复数据库备份**（会丢失升级后的数据）。

```bash
cd /opt/picoaide
OLD=<升级前的版本>
IMAGE=picoaide-harness-server

# 1) 切回旧镜像
sed -i "s|^SERVER_IMAGE=.*|SERVER_IMAGE=${IMAGE}:${OLD}|" .env
docker compose up -d

# 2) 验证旧版本健康
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
curl -sk -o /dev/null -w '%{http_code}\n' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"
docker exec picoaide-server /app/picoaide-server --version      # 应等于 OLD
echo "$OLD" > VERSION

# 3) 仅当应用数据被破坏时才恢复（会丢数据，需用户确认）
# docker compose stop server
# tar xzf deploy-backup/picoaide-data-<TS>.tar.gz -C picoaide-data
# docker compose start server
#
# 4) 仅当数据库被破坏时才恢复
# docker compose stop server
# docker exec -i picoaide-postgres pg_restore -U picoaide -d picoaide --clean \
#   < deploy-backup/pg-data-<TS>.dump
# docker compose start server
```

**回滚 3)/4) 会让升级后产生的数据丢失，执行前必须获得用户明确同意。**

---

## §8 排障

| 现象 | 排查 |
|---|---|
| 容器反复重启 | `docker compose logs --tail=100 server`；PG 密码错（`.env` 与 `pg-data` 不一致）最常见 |
| healthz 一直非 200 | `docker compose ps` 看 postgres 是否 healthy；首次启动迁移未完成需等 1–2 分钟 |
| 证书告警 / 客户端连不上 | `internal` 模式需信任 Caddy 本地 CA；`auto` 模式确认域名直连本机且 80 端口对公网开放 |
| `docker compose up` 报端口占用 | 改 `.env` 的 `CADDY_HTTP_PORT`/`CADDY_HTTPS_PORT`，并同步改 Caddyfile |
| 报网段冲突 | 改 `.env` 的 `NETWORK_SUBNET` 与三个固定 IP |
| postgres 启动即退出且日志提 `OLD_DATABASES`/`unused mount` | PG16→18 旧布局问题，见 §6.2，需 dump/restore 迁移 |
| 忘记超管密码 | 用另一个 super_admin 在 webadmin 重置；或 `docker exec picoaide-server /app/picoaide-server --reset-mfa <user>` |
| webadmin「发现新版本」不出现 | 先看启动日志的 `channel resolved: … (update endpoint …)`：端点为空说明更新检查被关（显式设了 `off`）；端点正常则再看 `manifest channel … != …`。**服务端有 6 小时缓存**，刚发版时等待属正常延迟 |

常用查看命令：

```bash
cd /opt/picoaide
docker compose ps
docker compose logs --tail=200 server
docker compose logs -f --tail=50 caddy
docker exec picoaide-server sh -c 'ls -l /data'          # 数据与 master.key
docker exec picoaide-postgres psql -U picoaide -d picoaide -c '\dt' | head
```

---

## §9 渠道与渠道隔离（重要）

系统有三种**互不升级**的渠道：`beta`（我们自己内测）、`official`（正式发布）、
`<brand-id>`（企业定制渠道）。

**渠道隔离是正确性要求**：品牌部署若接受了官方渠道的版本清单，升级后会被"洗"成官方版，
品牌与渠道配置一起丢失。因此服务端会**强制校验**清单里的 `channel_id` 与本部署渠道相等，
不一致直接判为"检查不可用"（`update_check: null`），**绝不跨渠道升级**。

### 配渠道时三个值必须自洽

```bash
# .env 追加（三者必须指向同一个渠道）
PICOAI_CHANNEL=<channel-id>                                                  # 本部署属于哪个渠道
PICOAI_UPDATE_ENDPOINT=https://release.picoaide.com/<channel-id>/latest.json # 从哪个目录取
# 该目录里的 latest.json 必须声明 "channel_id": "<channel-id>"
```

| 现象 | 原因 |
|---|---|
| webadmin 一直不显示"发现新版本" | 三者不一致（最常见：改了 `PICOAI_CHANNEL` 却没改端点，或反之）。`docker compose logs server` 会打印 `manifest channel "official" != this server's channel "acme"`。也可能是 `PICOAI_UPDATE_ENDPOINT` 被显式设成了 `off` |
| 容器启动即退出并打印 `渠道配置非法…` | `PICOAI_CHANNEL`（或镜像内的渠道标记）不是合法渠道 id。**服务端不会回落到 official** —— 回落会让渠道部署接受官方清单、把品牌洗掉，所以直接拒绝启动。修好拼写或去掉覆盖 |
| 容器启动即退出并打印 `渠道不一致…` | 镜像里的渠道内容（`channels/<id>/channel.json`）与本进程按的渠道不同，典型成因是 `.env`/compose 覆盖了镜像自带的渠道声明。去掉 `PICOAI_CHANNEL` 覆盖，或改成与镜像一致的值 |
| 升级后品牌没了 | 正常路径下**不应该发生**（启动期两道校验 + 清单渠道比对）。若发生说明有人手工指定了错误的镜像/清单，立即停止升级并排查 |

**渠道由镜像自带，不需要在 `.env` 里配**（2026-09-10 改）：

```
镜像构建 --build-arg CHANNEL=acme
        ├─ ENV PICOAI_CHANNEL=acme
        ├─ /opt/picoaide/CHANNEL          ← 权威声明（部署侧不配也生效）
        └─ /opt/picoaide/channel/         ← 渠道内容（品牌/文案/logo）
```

- `PICOAI_CHANNEL` **留空即可**；填了就必须与镜像内的渠道一致，否则拒绝启动。
  （compose 默认不再写死 `official` —— 那会覆盖镜像渠道，正是"品牌被洗掉"的入口。）
- `PICOAI_UPDATE_ENDPOINT` **留空 = 用本渠道的默认目录**
  （`release.picoaide.com/<channel>/latest.json`）。**留空不等于关闭**；
  要关闭请显式写 `off` / `none` / `-` / `disabled`。
- 从端点路径推导渠道只在**既没有 env、也没有镜像标记**时才生效（本地开发）。
  镜像部署一律以镜像标记为准 —— 否则"把端点指向哪个目录就变成哪个渠道"，
  渠道校验会自我实现、形同虚设。

`PICOAI_UPDATE_ENDPOINT` 设为 `off` / `none` / `-` 可关闭更新检查（纯内网、不希望检查时使用）。

**渠道不影响员工客户端**：客户端永远从**这台服务器**取包，所以服务端属于哪个渠道，
它的员工客户端就属于哪个渠道 —— 不存在"客户端渠道与服务端渠道不一致"的状态。

---

## 附录 A：宿主机已有反向代理（80/443 被别的服务占用）

**什么时候看这一节**：`ss -tlnp | grep -E ':(80|443)\b'` 发现 80/443 已被别的容器占用
（典型：这台机器上还跑着 glitchtip / 别的站点，由一个共享 Caddy 或 nginx 统一反代）。

**原则：不要抢端口，也不要停别人的反代。** 栈内自带的 caddy 只服务本产品，而共享反代
已经持有证书与多站点配置 —— 正确做法是让本产品的 server 容器**并入现有反代的上游**：

```bash
cd /opt/picoaide
# 1) 不启动栈内 caddy:只拉起 server + postgres
# 2) 把 server 发布到共享反代能访问到的宿主机地址(与现有 vhost 的 upstream 同址)
cat > docker-compose.override.yml <<'EOF'
services:
  server:
    environment:
      # 反代场景必配(§2.2):给不出 https 地址时客户端清单会拒发下载链接
      PICOAI_PUBLIC_BASE_URL: ${PICOAI_PUBLIC_BASE_URL:-https://ai.example.com}
    ports:
      # 与现有 vhost 的 upstream 一致(例:共享 Caddy 里写的是 172.20.0.1:8082)
      - "172.20.0.1:8082:8080"
EOF
docker compose up -d postgres server      # 注意:不写 caddy
```

`.env` 里还要把**可信代理**改成共享反代连过来的地址（默认值只认栈内 caddy 的
`172.28.0.2`；宿主机共享反代通常是 docker 网桥网关，如 `172.20.0.1`）：

```bash
PICOAI_TRUSTED_PROXIES=172.20.0.1
```

现有 vhost **不需要改动**（upstream 地址保持原样），例如共享 Caddy 里：

```
picoaide-harness.example.cn {
    encode gzip zstd
    reverse_proxy 172.20.0.1:8082      # ← 以前指向 systemd 二进制,现在指向容器,同一个地址
}
```

**从 systemd 二进制迁到容器**（同一台机器换部署形态）的推荐顺序：

1. 备份：`pg_dump` + 打包应用数据目录（含 `master.key`）——见 §6.3 与 §1 铁律 3；
2. 老库导入新栈的内置 PG：`gunzip -c dump.sql.gz | docker exec -i picoaide-postgres psql -U picoaide -d picoaide`；
   **老库容器保持原样不动**（它是数据库回滚锚点）；
3. `master.key` 等应用数据复制进 `/opt/picoaide/picoaide-data/`（**哈希核对一致**；
   丢了 master.key，库里所有加密的上游密钥永久无法解密）；
4. 先让容器监听一个**临时端口**（如 `172.20.0.1:8085`），健康检查 + 渠道自证
   （`/api/client/v2/channel`）+ 客户端清单（`/api/client/v2/updates/manifest`）全过；
5. `systemctl stop` + `disable` 旧服务（**保留 unit 与二进制**做回滚锚点），把容器改回
   原端口并 `docker compose up -d server`；
6. 经**真实域名**复验：`/healthz`、`/admin/`、`/api/client/v2/channel`、
   `/api/client/v2/updates/manifest`、`/updates/client/<安装包>`（range 请求 206）。

2026-09-10 在测试环境（101.42.228.128）按上述步骤完成过一次真实切换，现场记录模板见
部署目录里的 `DEPLOY-NOTES-<host>.md`（含备份路径、回滚命令、与文档的偏差说明）。

---

## §10 执行清单（AI 自检用）

首次部署：

- [ ] `docker --version` / `docker compose version` 可用，磁盘 ≥50GB（§3.1）
- [ ] 镜像已导入，`--version` 输出 == 目标版本（§3.2-3.4）
- [ ] 部署文件已导出到 `/opt/picoaide`（§3.3）
- [ ] 网段与端口无冲突（§4.1）
- [ ] `.env` 已创建、权限 600、`DOMAIN`/`TLS_MODE` 经用户确认（§4.3）
- [ ] `manual` 模式证书就位（§4.4）
- [ ] `docker compose up -d` 后三容器 Up（§4.5）；**宿主机已有反代时只起 server+postgres**（附录 A）
- [ ] **healthz 返回 200**（§4.6）
- [ ] `/api/client/v2/updates/manifest` 里有 `client.assets` 且 url 是**绝对 https**
      （反代场景必查；出现 `client_unavailable` = `PICOAI_PUBLIC_BASE_URL` 没配，§2.2）
- [ ] `picoaide-data/master.key` 存在（§4.7）
- [ ] 客户端安装包可下载：`/updates/client/<平台包>` 返回 206（§5）
- [ ] 已向用户报告地址/账号/密码，并提示 master.key 必须备份（§4.7）

升级：

- [ ] 已确认远端版本 > 当前 `VERSION`（§6.1）
- [ ] PG 布局检查通过（无 `pg-data/PG_VERSION`）（§6.2）
- [ ] **备份已完成且非空**（§6.3）
- [ ] 新镜像已 pull 或 load（§6.4）
- [ ] `.env` 的 `SERVER_IMAGE` 指向新版本（§6.5）
- [ ] **healthz 200 + `--version` == 目标版本 + 数据可查**（§6.6）
- [ ] 本地 `VERSION` 文件已更新（§6.7）
- [ ] 客户端安装包与 `CLIENT-RELEASE.json` 版本已随镜像更新（`/api/client/v2/updates/manifest`）

失败时：

- [ ] 已尝试回滚（§7），并向用户说明数据库迁移是否可逆
- [ ] **没有**执行任何 §1 禁止的命令
