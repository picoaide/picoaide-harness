---
title: 运维与排障
description: PicoAide Harness 服务端的日常运维：数据备份、证书与反向代理、从单二进制迁移、安全要点与常见故障。
---

## 数据与备份

所有持久化数据都在部署目录的 `./` bind mount 里，**不使用命名卷** —— 备份就是打包这些目录：

| 目录 | 内容 | 丢失后果 |
|---|---|---|
| `picoaide-data/` | 应用数据 + **`master.key`** | 数据库中加密的上游密钥**永久无法解密** |
| `pg-data/` | PostgreSQL 18 数据 | 账号、用量、审批、审计全部丢失 |
| `caddy-data/` `caddy-config/` | Caddy 证书库与配置 | `auto` 模式需重新签发 |
| `certs/` | 手动证书 | 仅 `manual` 模式需要 |

```bash
cd /opt/picoaide
TS=$(date +%Y%m%d-%H%M%S); OUT=deploy-backup; mkdir -p "$OUT"

docker exec picoaide-server sh -c 'tar czf - -C /data .' > "$OUT/picoaide-data-$TS.tar.gz"
docker exec picoaide-postgres pg_dump -U picoaide -Fc picoaide > "$OUT/pg-data-$TS.dump"
[ -d caddy-data ] && tar czf "$OUT/caddy-data-$TS.tar.gz" -C . caddy-data

[ -s "$OUT/picoaide-data-$TS.tar.gz" ] || echo "!!! 应用数据备份为空"
[ -s "$OUT/pg-data-$TS.dump" ]          || echo "!!! 数据库备份为空"
```

- **`master.key` 必须单独长期保留**（它也在 `picoaide-data/` 里），不要只依赖数据库备份；
- 恢复步骤见[升级、备份与回滚 § 回滚](/deployment/upgrade/#7-回滚)；
- 迁移到新机器时，整个部署目录可以直接拷走（注意保持文件权限）。

## 证书与反向代理

证书模式（`internal` / `auto` / `manual`）的选择见[部署总览 § 证书模式](/deployment/#证书模式三选一)。
三种模式共用同一个 compose，只切换 `.env` 的 `TLS_MODE`。

### 宿主机已有反向代理

若 80/443 已被别的服务占用（典型：机器上还有其它站点，由共享 Caddy / nginx 统一反代），
**不要抢端口，也不要停别人的反代** —— 让本产品的 `server` 容器并入现有反代的上游：

```bash
cd /opt/picoaide
# 1) 只拉起 server + postgres，不启动栈内 caddy
cat > docker-compose.override.yml <<'EOF'
services:
  server:
    environment:
      # 反代场景必配：给不出 https 地址时客户端清单会拒发下载链接
      PICOAI_PUBLIC_BASE_URL: ${PICOAI_PUBLIC_BASE_URL:-https://ai.example.com}
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
picoaide-harness.example.cn {
    encode gzip zstd
    reverse_proxy 172.20.0.1:8082
}
```

### 网段与端口冲突

- 网段冲突 → 改 `.env` 的 `NETWORK_SUBNET` 与 `CADDY_IP` / `SERVER_IP` / `PG_IP`；
- 端口冲突 → 改 `.env` 的 `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT`，**并同步改 Caddyfile 里的端口**；
- 已存在 `picoaide-net` 网络且子网不一致 → 停下来确认，**不要** `docker network rm`（会断开现有容器）。

## 从单二进制（systemd）迁移到容器

早期版本可能以 systemd + 单二进制运行。同一台机器换成容器部署的推荐顺序：

1. **备份**：`pg_dump` + 打包应用数据目录（含 `master.key`）—— 见上面「数据与备份」；
2. **老库导入新栈的内置 PG**：
   `gunzip -c dump.sql.gz | docker exec -i picoaide-postgres psql -U picoaide -d picoaide`；
   **老库容器保持原样不动**（它是数据库回滚锚点）；
3. **应用数据**复制进 `/opt/picoaide/picoaide-data/`（核对哈希一致；丢了 `master.key`，
   库里所有加密的上游密钥永久无法解密）；
4. 先让容器监听一个**临时端口**（如 `172.20.0.1:8085`），逐项验证：`/healthz`、
   `/api/client/v2/channel`、`/api/client/v2/updates/manifest`；
5. `systemctl stop` + `disable` 旧服务（**保留 unit 与二进制**做回滚锚点），把容器改回原端口并
   `docker compose up -d server`；
6. 经**真实域名**复验：`/healthz`、`/admin/`、`/api/client/v2/channel`、
   `/api/client/v2/updates/manifest`、`/updates/client/<安装包>`（Range 请求返回 206）。

## 安全要点

| 面向 | 机制 |
|---|---|
| 上游密钥 | AES-GCM 加密存储（`enc:v1:`，master key 文件 0600），永不落明文 |
| 员工令牌 | 只存 SHA-256 哈希、90 天过期；改密 / 降权 / 禁用**同事务**吊销全部令牌 |
| 管理端会话 | 12 小时硬上限 + 60 分钟空闲滑动过期；CSRF 与会话绑定（HMAC 时间窗） |
| 登录限流 | 双桶（按账号与来源），10 次 / 5 分钟；`PICOAI_TRUSTED_PROXIES` 决定来源 IP 的取法 |
| 内容可见性 | 市场与共享内容"审核 + 授权"双门制；未授权一律 404，不泄露存在性 |
| 审计 | 用户 / 部门 / 配额 / 定价 / 审批 / 授权 / 余额等关键操作全程留痕，哈希链防篡改 |
| 客户端接入 | 登录页与客户端拒绝非 HTTPS 远程地址（TOFU）；安装包 SHA-256 校验 |
| 健康探针 | `/healthz` 无需认证，DB Ping 失败返回 503 |

## 排障

| 现象 | 排查 |
|---|---|
| 容器反复重启 | `docker compose logs --tail=100 server`；最常见是 PG 密码与 `pg-data` 不一致 |
| healthz 一直非 200 | `docker compose ps` 看 postgres 是否 healthy；首次启动迁移需 1–2 分钟 |
| caddy 容器创建失败，报 `not a directory` | 挂载源 `Caddyfile.<mode>` 不存在：确认 `.env` 的 `TLS_MODE` 拼写 |
| postgres 启动即退出，日志提 `OLD_DATABASES` / `unused mount` | PG16 时代旧数据布局；按[升级前检查](/deployment/upgrade/#2-升级前检查)做 dump/restore 迁移 |
| `docker compose up` 报端口占用 | 改 `.env` 的 `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT` 并同步改 Caddyfile |
| 报网段冲突 | 改 `.env` 的 `NETWORK_SUBNET` 与三个固定 IP |
| 证书告警 / 客户端连不上 | `internal` 模式需信任 Caddy 本地 CA；`auto` 模式确认域名直连本机且 80 端口对公网开放 |
| 员工端"检查更新永远说已是最新" | 清单里出现 `client_unavailable`：配 `PICOAI_PUBLIC_BASE_URL` |
| webadmin「发现新版本」不出现 | 渠道三值不自洽（见[渠道与白标](/deployment/channels/#排障)）；服务端有 6 小时缓存 |
| 忘记超管密码 | 用另一个 super_admin 在管理后台重置；或 `docker exec picoaide-server /app/picoaide-server --reset-mfa <user>` |

## 常用命令

```bash
cd /opt/picoaide

docker compose ps                                  # 三个容器状态
docker compose logs --tail=200 server              # 服务端日志
docker compose logs -f --tail=50 caddy             # Caddy 日志（证书问题看这里）
docker exec picoaide-server sh -c 'ls -l /data'    # 应用数据与 master.key
docker exec picoaide-postgres psql -U picoaide -d picoaide -c '\dt' | head   # 库表
docker exec picoaide-server /app/picoaide-server --version                    # 运行版本

# 健康检查与客户端分发自检
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
```

**绝不要执行**（会删除数据卷与镜像层，数据库和 `master.key` 一起没）：

```bash
docker compose down -v          # ✗
docker volume prune             # ✗
docker system prune --volumes   # ✗
```
