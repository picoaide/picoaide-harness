# PicoAide 服务端容器化部署文档

> 适用版本:服务端 Docker 镜像 `ghcr.io/picoaide/picoaide-server`(amd64/arm64 多平台)。
> 本文覆盖:镜像来源与发布、私有网段+固定 IP 的 Compose 部署、手动/自动两种证书模式、自动化脚本、升级/备份/恢复/卸载、安全清单与 FAQ。

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
   ./picoaide-data/   SQLite picoaide.db + master.key(0700,目录 bind mount,升级不丢)
```

- 私有网段:自定义 bridge `picoaide-net`,默认子网 `172.28.0.0/24`(`.env` 的 `NETWORK_SUBNET` 可改)。
- 固定 IP:容器 `ipv4_address` 锁定,`docker compose up -d` 重建/升级后 IP 不变,Caddyfile 的 `reverse_proxy server:8080` 恒可达。
- server 不映射宿主机端口,外部流量只能经 Caddy 进入(内网隔离 + 攻击面收敛)。
- **所有持久化数据均用 `./` 当前目录 bind mount,不使用命名卷**:`picoaide-data/`(数据库+主密钥)、`caddy-data/`(Caddy 自动证书库)、`caddy-config/`(Caddy 配置)+ `certs/`(手动证书);pg 模式另加 `pg-data/`(内置 postgres 数据)。备份 = 直接拷走部署目录或 `deploy.sh backup`。

### 0.1 数据库后端:SQLite / PostgreSQL

| 模式 | DB_MODE | 数据落地 | 适用 |
|---|---|---|---|
| SQLite(默认) | `sqlite` | `picoaide-data/picoaide.db`(单文件) | 单机/小规模,零运维 |
| 内置 PostgreSQL | `pg` | `pg-data/`(容器 `postgres:16-alpine`,固定 IP `.4`) | 需要完整 PG 能力/集中管理 |
| 外部 PostgreSQL | `pg-external` | 外部实例(`PG_DSN` 指定) | 企业已有 PG 统一运维 |

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
┌──────────────────┐   PostgreSQL 16(不发布宿主机端口)
│ postgres         │   固定 IP 172.28.0.4,数据 ./pg-data
└──────────────────┘
```

- 两种 pg 模式都需要含 `-db-driver`/`migrate-sqlite-pg` 的服务端镜像(发布 0.5.0+ 或本地 `make docker-image`);
- 服务端首次启动自动应用 `migrations-pg` 建表(幂等,空库即建);
- SQLite→PG 数据迁移:`./deploy.sh migrate`(见 §6.3),PG→SQLite 不提供。

## 1. 镜像来源与发布(编译 → 验证 → 推送)

镜像仓库:`ghcr.io/picoaide/picoaide-server`(GitHub Container Registry,与 picoaide-harness 同 org)。

### 1.1 发布流程(CI 自动)

```bash
git tag v0.4.0 && git push origin v0.4.0
```

`.github/workflows/docker.yml` 在 `push tags v*` 时自动:

1. buildx 多平台构建 `linux/amd64` + `linux/arm64`(Dockerfile 两阶段:webadmin 先构建,Go 交叉编译);
2. 注入版本:`--build-arg VERSION=0.4.0` → 镜像内 `picoaide-server --version` 输出 `0.4.0`(与 tag 强一致);
3. 推送标签:`v0.4.0`(精确)/ `v0.4`(minor)/ `latest`(仅默认分支);
4. 附注 SBOM 与构建证明(provenance mode=max);构建缓存 type=gha;
5. 最后 `imagetools inspect` 校验 amd64+arm64 manifest 双架构都在。

也可手动重发:Actions → Docker image → Run workflow → 填版本号(`workflow_dispatch`)。

### 1.2 本地构建 / 离线导出(无 registry / 内网部署)

```bash
make docker-image                        # 本地单平台构建(带 git describe 版本注入)
make docker-image TAG=v0.4.0             # 指定版本(与 CI 相同注入)
make release-export TAG=v0.4.0           # 导出 dist/picoaide-server-v0.4.0.tar
# 目标机(内网,无外网)导入:
docker load < dist/picoaide-server-v0.4.0.tar
# 然后 .env 的 SERVER_IMAGE 改成本地标签,或用 tar 镜像直接 compose up
```

注:镜像 tag 规范见 §1.3;`make docker-image` 默认 `VERSION=$(git describe --tags --always | sed 's/^v//')`,与 Makefile 顶部覆盖变量一致。

### 1.3 镜像验证清单(发布/升级前必须过)

| 检查 | 命令 | 预期 |
|---|---|---|
| 版本注入 | `docker run --rm <image> --version` | 输出构建时注入的版本号(非 `dev`) |
| 非 root | `docker run --rm --entrypoint id <image>` | `uid=10001(picoaide)` |
| 健康端点 | 起容器后 `curl http://127.0.0.1:8080/healthz` | `200 {"ok":true}` |
| 多架构 | `docker buildx imagetools inspect <image>:vX.Y.Z` | `linux/amd64` + `linux/arm64` 均在 |
| 数据持久化 | 写入数据 → 重启容器 → 数据仍在 | 卷挂载生效 |

## 2. 手动部署(Compose)

### 2.1 前置条件

- Linux 主机,Docker Engine 24+ 与 Compose v2 插件(安装:`curl -fsSL https://get.docker.com | sh`);
- 80/443 端口空闲(手动证书且换端口时另见 §5 FAQ);
- 域名解析:DNS 指向本机或加入 hosts(内网自签模式客户端需信任 CA)。

### 2.2 步骤

```bash
git clone https://github.com/picoaide/picoaide-harness.git
cd server

# 1. 配置(必改密码与域名)
cp .env.example .env
vi .env            # DOMAIN / PICOAI_ADMIN_PASSWORD 必改;TLS_MODE 按 §3 决策

# 2. 证书:按模式选择 Caddyfile
cp Caddyfile.manual Caddyfile     # 手动证书(自签占位,推荐内网)
# 或 cp Caddyfile.autocert Caddyfile   # 自动证书(公网域名)
# 手动证书若 certs/ 为空,先生成自签占位:
mkdir -p certs && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/CN=<域名>" -addext "subjectAltName=DNS:<域名>"   # IP 用 subjectAltName=IP:<IP>
chmod 600 certs/server.key

# 3. 启动
docker compose up -d

# 4. 验证
docker compose ps                 # server healthy
curl -sk https://<域名>/healthz   # 200
docker inspect picoaide-server -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'  # 172.28.0.3
```

## 3. 证书模式(重点)

| 模式 | TLS_MODE | Caddyfile | 行为 | 使用场景 | 前置 |
|---|---|---|---|---|---|
| **manual 手动证书** | `manual` | `Caddyfile.manual` | `tls /certs/server.crt /certs/server.key`;无证书时用 openssl 生成 **10 年自签占位**,部署后提示**正式证书替换路径** | 企业 CA/已购证书/内网 IP/CDN 后 | openssl(缺失脚本提示安装并退出) |
| **auto 自动证书** | `auto` | `Caddyfile.autocert` | Caddy 自动申请/续期 Let's Encrypt(**无 tls 指令即默认自动 HTTPS**) | 公网域名直连 | **域名直接解析到本机**(非 CDN);80/443 对外开放 |

### 3.1 auto 模式域名校验(脚本内置)

1. `dig +short A/AAAA <域名>`(或 nslookup 兜底)取解析记录;
2. `curl https://api.ipify.org`(或 ifconfig.me)取本机公网出口 IP;
3. **解析包含本机 IP → 直连判定通过**,自动申请证书;
4. **解析不包含本机 IP(CDN/代理/记录不完整)→ 停下要求人工确认**:
   - 交互:提示"是否确认 CDN/代理会将 HTTP-01 验证转发到本机? [y/N]",确认后继续,拒绝则中止并提示改用手动证书;
   - 无人值守:`CONFIRM_CDN=yes` 直接继续(仅在你明确确认真实流量会到本机时使用)。
5. 注意:Let's Encrypt 不支持纯 IP 域名;IP 访问请用 manual/internal。

### 3.2 证书切换与更新

```bash
# 从 manual 换 auto: 改 .env TLS_MODE=auto → 重新生成 Caddyfile(容器内模板替换)
#   或手动: cp Caddyfile.autocert Caddyfile && docker compose restart caddy
# 换正式证书(manual): 覆盖 certs/server.crt + certs/server.key(0600) → docker compose restart caddy
# Caddy 自动续期(auto): Caddy 自动处理,无需干预;备份见 §6
```

## 4. 自动化部署

### 4.0 oh-my-zsh 式一键安装(推荐,单命令)

```bash
sh -c "$(curl -fsSL https://raw.githubusercontent.com/picoaide/picoaide-harness/master/server/scripts/install-server.sh)"
```

**一条命令全自动完成**:自检提权(非 root + tty 自动走 sudo;无 tty 提示用 `sudo bash`)→ 按发行版探测包管理器(apt/dnf/yum/apk/zypper)→ **自动安装缺失依赖**(docker 官方安装脚本 + `DOCKER_MIRROR` 可指定镜像源;curl/jq/openssl/dns 工具按包管理器装)→ 交互(或环境变量)收集配置(域名/证书模式/数据库后端)→ 下载/复制部署资产(docker-compose.yml + Caddyfile 双模板 + .env.example + pg override + deploy.sh)→ 转发 `deploy.sh install`(网段/端口预检、证书、.env、Caddyfile、镜像启动、健康等待)→ 打印部署摘要。

非交互(无人值守,需 root/sudo):

```bash
curl -fsSL https://raw.githubusercontent.com/picoaide/picoaide-harness/master/server/scripts/install-server.sh | \
  sudo DOMAIN=picoaide.example.com ADMIN_PASS=your-strong-password DB_MODE=sqlite bash
```

| 安装器环境变量 | 默认 | 说明 |
|---|---|---|
| `DOMAIN` | - | 对外域名或 IP(生产必改;交互时询问,非交互必填) |
| `INSTALL_DIR` | /data/picoaide/deploy | 部署目录(兼容旧版 `DEPLOY_DIR`) |
| `DB_MODE` | sqlite | sqlite / pg(内置容器)/ pg-external(已有实例) |
| `PG_PASSWORD` | 随机生成 | pg 模式:postgres 容器密码 |
| `PG_DSN` | - | pg-external 必填(如 `postgres://user:pass@host:5432/db`) |
| `ADMIN_USER` / `ADMIN_PASS` | admin / 随机生成 | 超管账号/密码(兼容 `PICOAI_ADMIN_PASSWORD`) |
| `TLS_MODE` | manual | manual / auto |
| `SERVER_IMAGE` | ghcr.io/picoaide/picoaide-server:latest | 可换私有 registry;pg 模式须含 `-db-driver`(0.5.0+ 或本地构建) |
| `SKIP_DEPS=1` | 空 | 跳过依赖自动安装(仅检查,缺失即提示并退出) |
| `DOCKER_MIRROR` | 空 | docker 安装镜像源(如清华 `https://mirrors.tuna.tsinghua.edu.cn/docker-ce`) |
| `MIRROR_URL` | 空 | 通用镜像加速提示(apt 源需自行改) |
| `DEPLOY_BASE_URL` | harness master/server | 资产下载基址(可指向 tag 路径固定版本) |
| `SKIP_IMAGE_CHECK=1` | 空 | pg 模式跳过镜像 `-db-driver` 探测 |
| `REINSTALL=yes` | 空 | `.env` 已存在时清除重装(默认安全退出) |
| `NO_DEPS` | 空 | 同 `SKIP_DEPS`(兼容) |

旧命令(克隆仓库后直接脚本)同样可用:

```bash
cd server
./scripts/install-server.sh
# 或(兼容 curl 一键): DOMAIN=picoaide.example.com ./scripts/install-server.sh
```

### 4.1 子命令(db 感知)

| 子命令 | 说明 |
|---|---|
| `install` | 首次部署:命令检查 → 网段/端口预检 → DNS/CDN 校验(auto)→ 证书准备(manual 自签)→ 生成 .env/Caddyfile → 拉镜像启动 → 等就绪 → 打印账号密码与替换证书指引 |
| `update` | 拉新镜像 → 重建重启(数据目录不变,零停机升级) |
| `status` | 容器状态 + 健康检查 + 固定 IP 一览 |
| `logs [-t]` | 查看日志(--tail=200;`-t` 跟踪) |
| `backup` | 打包 `picoaide-data`(含 master.key)+ auto 模式 `caddy-data` + pg 模式 `pg_dump` |
| `migrate [--dry-run]` | SQLite→PostgreSQL 数据迁移(见 §6.3) |
| `uninstall [--volumes]` | 停容器;`--volumes` 连数据目录一并删除(需确认,交互或 `UNINSTALL_VOLUMES=yes`) |

`install`/`update`/`status`/`logs`/`backup`/`uninstall` 都会根据 `.env` 的 `DB_MODE` 自动叠加对应 compose override(pg → `docker-compose.pg.yml`,pg-external → `docker-compose.pg-ext.yml`),无需手工指定 `-f`。

### 4.2 环境变量(非交互)

```bash
DOMAIN=picoaide.example.com TLS_MODE=manual \
PICOAI_ADMIN_PASSWORD='强密码' \
./scripts/deploy.sh install
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `DOMAIN` | picoaide.example.com | 对外域名或 IP(生产必改) |
| `TLS_MODE` | manual | manual / auto |
| `ADMIN_USER` / `PICOAI_ADMIN_PASSWORD` | admin / 随机生成 | 首次启动创建超管;已有 admin 后密码可清空 |
| `SERVER_IMAGE` | ghcr.io/picoaide/picoaide-server:latest | 可换私有 registry |
| `NETWORK_SUBNET` / `CADDY_IP` / `SERVER_IP` | 172.28.0.0/24 / .2 / .3 | 私有网段与固定 IP |
| `DB_MODE` | sqlite | sqlite / pg / pg-external(见 §0 与 §6.3) |
| `PG_PASSWORD` | 随机生成 | pg 模式:内置 postgres 容器密码 |
| `PG_DSN` | - | pg-external 必填;pg 模式由脚本生成 `postgres://picoaide:<pw>@postgres:5432/picoaide` |
| `PG_IMAGE` | postgres:16-alpine | pg 模式内置镜像(可换内网镜像) |
| `PG_IP` | 172.28.0.4 | pg 容器固定 IP(需在 NETWORK_SUBNET 内) |
| `CONFIRM_CDN` | 空 | auto 模式非直连时 `yes` 跳过人工确认 |
| `REINSTALL` | 空 | `.env` 已存在时 `yes` 清除重装(否则安全退出) |
| `MIGRATE` | 空 | migrate 子命令 `yes` 跳过交互确认 |
| `INSTALL_DIR`(install-server.sh) | /data/picoaide/deploy | 部署目录(旧版 INSTALL_DIR 兼容) |

### 4.3 命令存在性检查(内置,缺失即提示安装并退出)

`docker` / `docker compose` 插件 / `curl` / `jq` / `openssl` / `dig`(或 nslookup)/ `ss`(或 lsof)逐条 `command -v` 检查,缺失输出对应安装包提示(如 `apt-get install -y dnsutils`),**不静默降级**。`backup`/`status` 等子命令只要求各自最小命令集(backup 仅需 docker)。**依赖自动安装由 `install-server.sh` 负责**(§4.0);直接运行 `deploy.sh` 需先自行安装上述命令。

## 5. 固定 IP 说明

- 容器 IP 由 compose 网络 `ipam` + `ipv4_address` 声明式锁定;`docker compose up -d` 重建(Caddyfile/环境变更)后 IP 不变。
- 修改网段:`.env` 改 `NETWORK_SUBNET`/`CADDY_IP`/`SERVER_IP` 后 `docker compose down && docker compose up -d`(网络重建)。
- 若 `picoaide-net` 已存在且子网与配置不符,脚本会报错并提示清除网络(或 `docker network rm picoaide-net` 后重试)。
- server 通过 compose DNS(服务名)访问即可;**无需在 Caddyfile 写死 IP**(写死 IP 与固定 IP 二选一,推荐服务名)。

## 6. 升级 / 备份 / 恢复 / 卸载

### 6.1 升级

```bash
./scripts/deploy.sh update          # 拉新镜像重建;数据目录不变
# 或手动: docker compose pull && docker compose up -d
```

兼容性:DB 迁移按顺序执行(0001→0027+),升级前建议 backup;降级**不保证**兼容(数据迁移不可逆),回滚=备份恢复。

### 6.2 备份(重要:master.key 与数据库同备)

```bash
./scripts/deploy.sh backup
# 产物: deploy-backup/picoaide-data-<时间>.tar.gz(含 picoaide.db + master.key)
#      deploy-backup/caddy-data-<时间>.tar.gz(auto 模式 Caddy 证书库)
#      deploy-backup/pg-data-<时间>.dump(pg 模式:pg_dump 自定义格式,含 schema+数据)
```

**master.key 丢失 = 已加密的上游密钥/商城凭证不可解密(永久失效)**。离线备份:直接 `cp -a picoaide-data/ 备份目录`(SQLite 单文件 + key,先 `docker compose stop server` 或直接冷备)。

### 6.3 SQLite → PostgreSQL 迁移(deploy.sh migrate)

前置:已有一份 SQLite 部署(`picoaide-data/picoaide.db`),且目标 PostgreSQL 可达(内置容器或外部实例);**服务端镜像须含迁移工具与 `-db-driver` 支持**(0.5.0+ 或本地 `make docker-image`)。PG 模式首次启动会自动应用 `migrations-pg` 建表(幂等)。

```bash
cd <部署目录>
./deploy.sh migrate --dry-run     # ① 预览:只统计各表行数,不写入
./deploy.sh backup                # ② 备份(强烈建议,回滚点)
./deploy.sh migrate               # ③ 正式迁移(交互确认;MIGRATE=yes 无人值守)
```

迁移流程(脚本自动完成):校验(DB_MODE=pg|pg-external + PG_DSN + sqlite 源)→ 起 postgres(内置模式)→ 停 server 保证 SQLite 一致性 → 清空目标库 12 张表(TRUNCATE ... CASCADE)→ 迁移镜像 `migrate-sqlite-pg` 写入(12 表按 FK 依赖序,时间戳转换,sequence setval)→ `.env` 的 `DB_MODE` 改为 `pg` → `docker compose up -d` → 健康等待。

- **迁移后原 SQLite 文件保留**(`picoaide-data/picoaide.db`,回滚点);
- **回滚**:`.env` 改回 `DB_MODE=sqlite` → `docker compose up -d`(SQLite 数据未动);
- master.key 不变(加密凭证仍可解密;注意 `pg_dump` 不含 master.key,备份保留 picoaide-data);
- SQLite→PG **没有自动迁移工具**(需上述 migrate);PG→SQLite 回迁同样不提供。

### 6.4 恢复

```bash
docker compose stop server            # 先停服
tar xzf deploy-backup/picoaide-data-<时间>.tar.gz -C picoaide-data/   # 解包覆盖(注意路径)
# auto 模式还恢复 Caddy 证书库:
tar xzf deploy-backup/caddy-data-<时间>.tar.gz -C .                    # 解包出 caddy-data/
# pg 模式恢复数据(pg_dump 产物):
docker exec -i picoaide-postgres pg_restore -U picoaide -d picoaide < deploy-backup/pg-data-<时间>.dump
docker compose up -d
```

### 6.5 卸载

```bash
./scripts/deploy.sh uninstall              # 停容器,保留数据目录(picoaide-data/ caddy-data/ caddy-config/)
./scripts/deploy.sh uninstall --volumes    # 停容器并删除以上数据目录(需确认)
```

## 7. 安全清单

- [ ] `.env` 权限 0600(生成脚本已处理;`chmod 600 .env`);**.env 不进 git**(已 .gitignore)。
- [ ] `PICOAI_ADMIN_PASSWORD` 强密码;首次启动后可在 .env 置空并 `docker compose up -d`(已存在 admin 幂等跳过)。
- [ ] `certs/server.key` 0600;正式证书走企业 CA 渠道时按密钥管理规定存放。
- [ ] server 仅 `expose` 8080(非 root uid 10001);**不要**给 server 加 `ports:` 映射。
- [ ] `PICOAI_MASTER_KEY` 若不显式设置,备份 `picoaide-data/master.key`(0700)。
- [ ] 防火墙:仅放行 80/443(或自定义端口);Caddy 网络被 cap_drop ALL + cap_add NET_BIND_SERVICE 收紧。
- [ ] 日志轮转:json-file 50MB×3(compose 已配);长期留存建议对接外部日志。
- [ ] 定期执行 `deploy.sh backup`;迁移数据库前先验证备份可恢复。

## 8. FAQ

**Q1:无公网域名,只有内网 IP?**
→ 用 `TLS_MODE=manual`(自签占位;或已购内网 CA 证书直接放 certs/)。`auto` 不支持 IP。

**Q2:域名走了 CDN,auto 证书失败?**
→ 脚本会检测非直连并要求确认;即使确认,ACME HTTP-01 需 CDN 将验证流量转发回源(且 80 端口可被外部访问)。更稳妥:CDN 后源站用 manual(源站证书由企业 CA 签),CDN 边缘用其自管证书。

**Q3:换域名了怎么改?**
→ 改 .env 的 DOMAIN → `docker compose up -d`;若用 manual,同时重新生成 certs(或自签新域名)→ restart caddy。

**Q4:前端一定要 Caddy 吗?其他反代(Nginx/Ingress)?**
→ 架构建议 Caddy(自动证书+反代一体);若用 Nginx:证书与转发照旧,注意传 `X-Forwarded-Proto` 与 WebSocket upgrade;本项目 Caddyfile 已含 websocket(默认支持)。

**Q5:升级失败/回滚?**
→ 先 `deploy.sh backup`;失败时 `docker compose down` → 恢复数据 → 用旧镜像 tag(改 .env SERVER_IMAGE)→ up。DB 迁移向前兼容**不向后兼容**,降级仅保证代码启动,数据完整性以备份为准。

**Q6:端口被占(80/443)?**
→ 改 compose 的 `CADDY_HTTP_PORT`/`CADDY_HTTPS_PORT`(如 8080/8443 并在防火墙放行),Caddyfile 域名块不变;`ss -tln` 查占用。

**Q7:buildx 多平台构建在哪跑?**
→ CI(GitHub Actions)默认;本地需 `docker buildx create --use`(或 Docker Desktop 自带);仅需单 amd64 时 `make docker-image` 即可。

**Q8:镜像拉不下来(GHCR 网络)?**
→ 配置镜像加速/代理;或 `make release-export` 导出 tar 到内网 `docker load`(见 §1.2)。

**Q9:webadmin 如何登录?**
→ `https://<域名>/admin/`(SPA 内嵌于服务端二进制;未构建时返回"webadmin 未构建",用发布镜像无此问题)。

**Q10:怎么查看当前版本?**
→ `docker exec picoaide-server /app/picoaide-server --version`(输出镜像构建注入的版本号)。

**Q11:PG 模式需要什么镜像?**
→ 服务端镜像须含 `-db-driver`/`migrate-sqlite-pg`(本分支 `feat/pgsql-storage` 已实现;发布镜像 0.5.0+ 或本地 `make docker-image`)。旧镜像(0.4.x)用 `docker exec … --version` 与 `docker run --rm --entrypoint picoaide-server <img> -h | grep db-driver` 校验;缺失时安装器会给出提示(`SKIP_IMAGE_CHECK=1` 可跳过)。

**Q12:SQLite → PG 要迁数据吗?**
→ 已有 SQLite 数据:先 `./deploy.sh migrate --dry-run` 预览,backup 后 `./deploy.sh migrate`(§6.3);全新部署:直接 `DB_MODE=pg` 安装,PG 空库自动建表。

**Q13:内置 postgres 容器安全吗?**
→ 不发布宿主机端口(仅 picoaide-net 内网);`PG_PASSWORD` 在 .env(600);建议企业内网同时限制到 pg 容器的网络(防火墙/iptables 只放行宿主机 80/443)。

**Q14:pg-data 目录权限/备份?**
→ postgres 官方镜像 entrypoint 自动处理 bind mount 目录所有权,勿手工 chown;备份用 `./deploy.sh backup`(pg_dump 运行中安全),冷备=停服后拷 `pg-data/`。
