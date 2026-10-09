---
title: 运维与排障
description: PicoAide Harness 服务端的日常运维：备份与恢复、探针与日志、共享反代、从单二进制迁移、安全要点与常见故障定位。
---

本页是**在跑的部署**要用的东西：数据在哪、怎么备份与恢复、状态怎么看、出问题从哪查。
首次部署见[容器化部署](/deployment/compose/)，版本切换见[升级、备份与回滚](/deployment/upgrade/)。

## 这一页解决什么问题

把"部署完成"之后的日子管起来：日常巡检看什么、备份怎么做才算有效、共享反代怎么并入、
以及每一种常见故障的**判据**（怎么确认是这个问题）与**恢复动作**。

**前提**：服务端已按[容器化部署](/deployment/compose/)跑起来，三容器 Up 且 `/healthz` 返回 200。
本页命令默认部署目录是 `/opt/picoaide`、容器名是 `picoaide-server` / `picoaide-postgres`。

## 设计取舍

**为什么备份就是"打包几个目录"。** 所有持久数据都在部署目录下的 bind mount 里
（见[部署总览](/deployment/)），所以备份不需要数据库特有的导出格式，也不需要停机：
`picoaide-data/` 打包 + `pg_dump` 在线导出就是完整退路。反过来，"有没有备份"这件事
可以**在文件系统上直接证伪**（文件在不在、非不非空），不依赖任何外部服务的状态。

**为什么 `master.key` 要单独强调。** 它是**唯一的**解密根：`picoaide-data/master.key` 丢了以后，
数据库里所有 `enc:v1:` 密文（上游 API Key）永久无法解密，只能重新录入。所以它既要跟着
应用数据备份，也要**单独长期保留**一份。

**为什么状态面分成两个探针。** `/healthz` 回答"执行面能不能服务请求"（DB Ping 失败返回 503）；
`/readyz` 回答"资源水位与发布面能不能继续工作"（内存档位与预算、编译缓存占用、
写入阻塞与发布阻塞原因）。分开的理由：**执行面健康不等于发布面可用** ——
例如应用平台的编译缓存触顶会挡住新的应用发布，但员工照常使用已有应用。
两个探针都无需认证，可以直接接负载均衡与监控。

**为什么不去抢共享反代的端口。** 宿主机上 80/443 往往已经被别的服务（另一个站点、错误追踪等）
持有，且那套反代已经在管证书与多站点配置。正确做法是让本产品的 `server` 容器**并入现有反代
的上游**（只发布一个内网地址），而不是停别人的反代、也不是把本产品的 Caddy 也绑到 443。

## 数据与备份

| 目录 | 内容 | 丢失后果 |
|---|---|---|
| `picoaide-data/` | 应用数据 + **`master.key`** | 数据库中加密的上游密钥**永久无法解密** |
| `pg-data/` | PostgreSQL 18 数据 | 账号、用量、审批、审计全部丢失 |
| `caddy-data/` `caddy-config/` | Caddy 证书库与配置 | `auto` 模式需重新签发 |
| `certs/` | 手动证书（`manual` 模式） | 需重新放置证书 |

```bash
cd /opt/picoaide
TS=$(date +%Y%m%d-%H%M%S); OUT=deploy-backup; mkdir -p "$OUT"

docker exec picoaide-server sh -c 'tar czf - -C /data .' > "$OUT/picoaide-data-$TS.tar.gz"
docker exec picoaide-postgres pg_dump -U picoaide -Fc picoaide > "$OUT/pg-data-$TS.dump"
[ -d caddy-data ] && tar czf "$OUT/caddy-data-$TS.tar.gz" -C . caddy-data

[ -s "$OUT/picoaide-data-$TS.tar.gz" ] || echo "!!! 应用数据备份为空"
[ -s "$OUT/pg-data-$TS.dump" ]          || echo "!!! 数据库备份为空"
ls -lh "$OUT" | tail -5
```

**判据**：两条 `[ -s … ]` 都不打印 `!!!`，且文件大小是可信量级。
**备份为空意味着什么**：`pg_dump` 失败但 shell 仍建了同名文件 —— 此时**没有数据库退路**，
不要把它当成"备份已完成"。先修 `pg_dump`（容器名、用户 `picoaide`、库名 `picoaide`、磁盘空间），
重做并重新校验。

恢复步骤见[升级、备份与回滚](/deployment/upgrade/)的回滚节：**同代**回滚只换镜像；
**跨代**回滚必须 **停服 → 恢复 `pg_dump` → 回退镜像 → 客户端一起回退**。
`picoaide-data/` 的恢复只在应用数据被破坏时才做（会丢升级后写入的数据，需明确同意）。

**迁移到新机器**：整个部署目录可以直接拷走（保持文件权限，尤其是 `picoaide-data/` 与 `certs/`），
再改 `.env` 的 `DOMAIN` / `PICOAI_PUBLIC_BASE_URL` 与证书模式。

## 证书与反向代理

证书模式（`internal` / `auto` / `manual`）的选择判据见[部署总览](/deployment/)。
三种模式共用同一个 compose，只切换 `.env` 的 `TLS_MODE`。

### 宿主机已有反向代理

若 80/443 已被别的服务占用，**不要抢端口，也不要停别人的反代** —— 让本产品的 `server` 容器
并入现有反代的上游：

```bash
cd /opt/picoaide
# 1) 只拉起 server + postgres，不启动栈内 caddy
cat > docker-compose.override.yml <<'EOF'
services:
  server:
    environment:
      # 反代场景必配：给不出 https 地址时客户端清单会拒发下载链接
      PICOAI_PUBLIC_BASE_URL: ${PICOAI_PUBLIC_BASE_URL:-https://harness.example.com}
    ports:
      # 与现有 vhost 的 upstream 一致（例：共享 Caddy 里写的是 172.20.0.1:8082）
      - "172.20.0.1:8082:8080"
EOF

# 2) 只起这两个服务（注意：不写 caddy）
docker compose up -d postgres server
```

`.env` 里还要把**可信代理**改成共享反代连过来的地址（默认只认栈内 caddy 的 `172.28.0.2`；
宿主机共享反代通常是 docker 网桥网关，如 `172.20.0.1`）：

```bash
PICOAI_TRUSTED_PROXIES=172.20.0.1
```

现有 vhost **不需要改动**（upstream 地址保持原样）：

```
harness.example.com {
    encode gzip zstd
    reverse_proxy 172.20.0.1:8082
}
```

**判据**：`docker compose ps` 里只有 `server` 与 `postgres` 在跑；经**真实域名**访问
`/healthz` 返回 200，且 `/api/client/v2/updates/manifest` 有 `client.assets`。
`PICOAI_TRUSTED_PROXIES` 写错的表现是登录限流把全组织算成一个来源 IP（改网段只改一处 =
`X-Forwarded-For` 静默失效），启动日志里会有一行 WARNING。

### 网段与端口冲突

- 网段冲突 → 改 `.env` 的 `NETWORK_SUBNET` 与 `CADDY_IP` / `SERVER_IP` / `PG_IP`（四个一起改）；
- 端口冲突 → 改 `.env` 的 `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT`，**并同步改 Caddyfile 里的端口**；
- 已存在 `picoaide-net` 网络且子网不一致 → 停下来确认，**不要** `docker network rm`（会断开现有容器）。

## 从单二进制（systemd）迁移到容器

早期版本可能以 systemd + 单二进制运行。同一台机器换成容器部署的推荐顺序：

1. **备份**：`pg_dump` + 打包应用数据目录（含 `master.key`）；
2. **老库导入新栈的内置 PG**：
   `gunzip -c dump.sql.gz | docker exec -i picoaide-postgres psql -U picoaide -d picoaide`；
   **老库容器保持原样不动**（它是数据库回滚锚点）；
3. **应用数据**复制进 `/opt/picoaide/picoaide-data/`（核对哈希一致）；
4. 先让容器监听一个**临时端口**（如 `172.20.0.1:8085`），逐项验证：`/healthz`、
   `/api/client/v2/channel`、`/api/client/v2/updates/manifest`；
5. `systemctl stop` + `disable` 旧服务（**保留 unit 与二进制**做回滚锚点），把容器改回原端口并
   `docker compose up -d server`；
6. 经**真实域名**复验：`/healthz`、`/admin/`、`/api/client/v2/channel`、
   `/api/client/v2/updates/manifest`、`/updates/client/<安装包>`（Range 请求返回 206）。

## 日常巡检

| 看什么 | 命令 | 正常的样子 |
|---|---|---|
| 容器状态 | `docker compose ps` | 三容器 Up，`picoaide-postgres` 为 healthy |
| 执行面健康 | `curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"` | `{"ok":true,…}` |
| 资源与发布面 | `curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/readyz"` | `ok` 为真；`mem_budget_ok` / `mem_budget_known` 正常；`compile_cache_bytes` 未触顶 |
| 版本 | `docker exec picoaide-server /app/picoaide-server --version` | 等于 `cat VERSION` |
| 渠道 | `docker exec picoaide-server cat /opt/picoaide/CHANNEL` | 与本栈渠道一致（见[渠道与白标](/deployment/channels/)） |
| 后台调度器 | `docker compose logs server \| grep 'scheduler status'` | 启动/关停各打一行：`name=… started=… runs=… errors=… last_error=…` |
| 数据库迁移 | `docker compose logs server \| grep -i 'migrate:'` | 每条迁移前后各一行；出现 `migrate: SLOW migration` 说明这次升级锁表时间偏长 |
| 磁盘 | `df -h /opt` | 余量足够放下一个镜像包 + 一份备份 |

几个可调的运维旋钮（都在 `.env`，写完要 `docker compose up -d server`）：

| 变量 | 作用 | 什么时候动它 |
|---|---|---|
| `PICOAI_WASM_MEMORY_PROFILE` | 应用平台内存档位（`default` / `small` / `large`） | 可用内存 < 4GiB 的机器必须写 `small`，否则启动自检拒绝启动 |
| `PICOAI_COMPILE_ISOLATION` | 应用编译子进程的 OS 级隔离档（`require` / `auto` / `off`） | 生产建议 `require`：隔离不可用就拒绝启动，而不是静默降级 |
| `PICOAI_MIGRATION_LOCK_TIMEOUT_MS` / `PICOAI_MIGRATION_ADVISORY_TIMEOUT_MS` / `PICOAI_MIGRATION_SLOW_MS` | 迁移的有界等锁预算与"慢迁移"告警阈值（毫秒） | 启动日志出现等锁超时且确认是运维侧长事务（`pg_dump` / 长查询 / idle in transaction）时临时放宽 |
| `PICOAI_AUDIT_CHAIN_INTERVAL` | 审计哈希链周期校验间隔（Go duration，缺省 `1h`） | 它同时是"篡改可见性窗口"与"每轮一次全表只读扫描"的取舍 |
| `PICOAI_DB_MAX_OPEN_CONNS` | 数据库连接池上限 | 多实例部署 / 托管 PG 配额有限时下调 |

管理后台里的两组热调项（改完即时生效，不需要重启）：

- **运维 → 应用平台**：并发与队列、单实例内存、各类时间预算等限制项（**改单实例内存需要重启**）；
- **运维 → 网关文件**：按员工查看 Files API 占用并清理；文件保留上限由 `gateway.file_expiry_days`
  决定（缺省 7 天），超期文件由服务端周期回收。
- **审计日志**的保留期可配（缺省 180 天），由周期调度器执行 —— 不是"启动时清一次"。

## 判据

日常运维只需要回答四个问题，每个都有可照抄的判据（失败的样子见下一节）：

| 问题 | 判据 | 命令 |
|---|---|---|
| 服务可用吗？ | `/healthz` 返回 200，且三容器 Up | `docker compose ps` + `curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"` |
| 资源与发布面有余量吗？ | `/readyz` 的 `ok` 为真、内存档位判定正常、编译缓存未触顶 | `curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/readyz"` |
| 跑的版本与渠道对吗？ | `VERSION` == `--version`，且 `/opt/picoaide/CHANNEL` == `/api/client/v2/channel` 的 `channel_id` | `cat VERSION`、`docker exec picoaide-server /app/picoaide-server --version`、`curl -sk …/api/client/v2/channel` |
| 还有退路吗？ | 最近一次备份存在且**非空**，磁盘余量放得下新镜像 + 一份备份 | `ls -lh deploy-backup \| tail -5` + `df -h /opt` |

**怎么算失败**：`/healthz` 非 200、`/readyz` 报出发布阻塞项、版本或渠道两处不一致、备份为空、
磁盘放不下一次升级 —— 任一条不成立都按下一节定位，而不是"等等看"。

## 安全要点

| 面向 | 机制 |
|---|---|
| 上游密钥 | AES-GCM 加密存储（`enc:v1:`，master key 文件 0600），永不落明文 |
| 员工令牌 | 只存哈希、90 天过期；改密 / 降权 / 禁用**同事务**吊销全部令牌 |
| 管理端会话 | 12 小时硬上限 + 60 分钟空闲滑动过期；CSRF 与会话绑定 |
| 登录限流 | 只对失败计数、5 分钟滑动窗口、成功即清空；账号维度与来源 IP 维度分别计数，来源 IP 按信任边界解析 |
| 内容可见性 | 市场与共享内容"审核 + 授权"双门制；未授权一律 404，不泄露存在性 |
| 审计 | 关键操作留痕，哈希链防篡改，保留期可配 |
| 客户端接入 | 登录页拒绝非 HTTPS 远程地址；安装包按清单里的 SHA-256 流式校验 |
| 探针 | `/healthz`、`/readyz` 无需认证；前者 DB Ping 失败返回 503 |
| 出站代理 | 客户端默认**不使用**系统代理；需要时用渠道字段或真实进程环境变量显式打开 |

## 边界与失败行为

| 现象 | 判据（怎么确认） | 恢复动作 |
|---|---|---|
| 容器反复重启 | `docker compose ps` 里 restart 计数上涨；`docker compose logs --tail=100 server` | 两类最常见：PG 密码与 `pg-data` 不一致；可用内存 < 4GiB 而档位是 `default`（日志"启动自检失败…拒绝启动"）⇒ 写 `small` 后重建 |
| healthz 一直非 200 | `docker compose ps` 看 postgres 是否 healthy | 首次启动迁移需 1–2 分钟；仍不通看 `logs postgres` 与 `logs server` |
| 容器起来就退出，日志提 `SchemaMismatchError` | 日志点名迁移版本号 | **跨代回滚**：停服 → 恢复升级前 `pg_dump` → 回退镜像 → 客户端回退，不能只换镜像 |
| caddy 容器创建失败，报 `not a directory` | `docker compose ps` 里没有 caddy | `TLS_MODE` 拼写错误（挂载源 `Caddyfile.<mode>` 不存在） |
| `docker compose up` 报端口占用 | 报错点名端口 | 改 `.env` 端口并同步改 Caddyfile；或走共享反代（只起 server+postgres） |
| 报网段冲突 | 已有网络使用同一子网 | 改 `NETWORK_SUBNET` 与三个固定 IP；已有 `picoaide-net` 且子网不一致时先确认再动 |
| postgres 启动即退出，日志提 `OLD_DATABASES` / `unused mount` | 日志关键字 | PG16 时代的旧数据布局：按 PostgreSQL 官方 dump/restore 迁移，不要改挂载点硬试 |
| 证书告警 / 客户端连不上 | 仅 `internal` / `auto` 模式 | `internal` 需把 Caddy 本地 CA 分发给员工机器；`auto` 必须域名直连本机且 80/443 对公网开放（经 CDN 会失败） |
| 员工端"检查更新永远说已是最新" | 清单里有 `client_unavailable` | 配 `PICOAI_PUBLIC_BASE_URL` 后重建 server（见[客户端分发与升级](/deployment/client-delivery/)） |
| 管理后台"发现新版本"不出现 | 启动日志 `channel resolved: …` 与 `manifest channel "…" != …` | 渠道三值不自洽或端点被设成 `off`；服务端有 6 小时缓存，刚发版属正常延迟 |
| 应用能打开但发布新版本被拒 | `/readyz` 的发布阻塞项与 `actions` | 常见是应用平台编译缓存触顶：清理 `<部署目录>/picoaide-data/_compile-cache/` 下的派生缓存（不需要重启），再重试发布 |
| 忘记超管**密码** | 是否还有**其他超管** | 有：让其在管理后台「用户管理 → 重置密码」重置（重置即吊销该账号全部会话，并强制下次登录改密）。没有：`--reset-mfa <user>` **不重置密码**（它只清 MFA 并吊销会话），唯一超管且密码也丢了时只能在库上改写该账号的 `users.password_hash`（Argon2id 编码串，格式见 `server/internal/util/password.go`）并把 `password_must_change` 置 1，改完立即登录改密；**动手前先做备份** |
| 磁盘吃紧 | `df -h /opt`、`du -sh pg-data picoaide-data` | `pg-data/` 会持续增长；先确认余量能放下"新镜像 + 一份备份"。**不要**用 `docker volume prune` / `docker system prune --volumes` 清理 |

## 常用命令

```bash
cd /opt/picoaide

docker compose ps                                  # 三个容器状态
docker compose logs --tail=200 server              # 服务端日志
docker compose logs -f --tail=50 caddy             # Caddy 日志（证书问题看这里）
docker exec picoaide-server sh -c 'ls -l /data'    # 应用数据与 master.key
docker exec picoaide-postgres psql -U picoaide -d picoaide -c '\dt' | head   # 库表
docker exec picoaide-server /app/picoaide-server --version                    # 运行版本

# 健康与分发自检
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/readyz"
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
```

**绝不要执行**（会删除数据卷与镜像层）：

```bash
docker compose down -v          # ✗
docker volume prune             # ✗
docker system prune --volumes   # ✗
```

## 相关

- [部署总览](/deployment/) —— 容器架构、证书模式与四条铁律
- [容器化部署](/deployment/compose/) —— 首次部署与自检清单
- [升级、备份与回滚](/deployment/upgrade/) —— 备份与恢复的完整顺序
- [客户端分发与升级](/deployment/client-delivery/) —— 下载地址与客户端升级
- [渠道与白标](/deployment/channels/) —— 渠道一致性与数据隔离
- [离线部署](/deployment/offline/) —— 无外网环境的取包与更新检查
