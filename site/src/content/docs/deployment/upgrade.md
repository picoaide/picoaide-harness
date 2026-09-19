---
title: 升级、备份与回滚
description: 升级 PicoAide Harness 服务端：版本检查、备份、切换镜像、升级验证与回滚步骤。
---

升级只换镜像：`picoaide-data/`、`pg-data/`、`caddy-data/`、`certs/` 与 `.env` 都不动。
但**数据库迁移不可逆**，所以备份与验证是流程的一部分，不是可选项。

> **服务端与客户端必须同版本升级**：WASM 应用只在桌面客户端内打开，浏览器访问链路已删除 ——
> 旧客户端在服务端升级后**无法再打开应用**。客户端从这台服务器取包，升级后请确认员工客户端
> 升到配套版本（见[客户端分发与升级](/deployment/client-delivery/)）。
> 应用不需要任何公网入口：无需应用专用域名解析、证书或 Caddy 站点块（见[部署总览](/deployment/)）。

## 1. 检查是否有新版本

```bash
# 远端最新版本（权威：latest.json 的 server.version）
curl -fsS https://release.picoaide.com/official/latest.json \
  | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
cat /opt/picoaide/VERSION        # 当前部署版本
```

也可以直接看 webadmin 的**服务器信息**页：服务端会自己检查更新并显示"发现新版本"（含升级目标镜像 tag）。

- 检查地址来自 `PICOAI_UPDATE_ENDPOINT`，留空 = 本渠道默认目录 `release.picoaide.com/<渠道>/latest.json`；
- 服务端有 **6 小时缓存**，刚发版时等待属正常延迟；
- 若"一直不显示新版本"，先看 `docker compose logs server` 里的 `channel resolved: …` 与
  `manifest channel "official" != this server's channel "…"` —— 那是渠道配置不自洽（见[渠道与白标](/deployment/channels/)），
  不是"没有新版本"。

远端版本 ≤ 当前版本 → 结束。

## 2. 升级前检查

```bash
cd /opt/picoaide

# (a) PG 数据布局检查：旧布局（PG16 时代）直接启动会被拒绝
[ -f pg-data/PG_VERSION ] && echo "!!! 旧版 PG16 布局，需先做 dump/restore 迁移，停止升级" || echo "PG 布局 OK"

# (b) 磁盘余量（新镜像 + 备份都需要空间）
df -h /opt | tail -1
```

出现 `!!!` 时**停止升级**，先按 PostgreSQL 官方 dump/restore 流程迁移数据（旧 `pg-data/` 目录布局与新镜像不兼容，
不会自动迁移）。

## 3. 备份（不可跳过）

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

# 验证备份非空（否则后面的升级没有退路）
[ -s "$OUT/picoaide-data-$TS.tar.gz" ] || echo "!!! 应用数据备份为空"
[ -s "$OUT/pg-data-$TS.dump" ]          || echo "!!! 数据库备份为空"
```

> `picoaide-data/master.key` 丢失后，数据库里所有加密的上游密钥（网关 API key 等）**永久无法解密**。
> 该文件必须长期保留并单独备份。

## 4. 导入新镜像

```bash
VER=<第 1 步得到的版本>
IMAGE=picoaide-harness-server
curl -fL -o /tmp/pa.zip \
  "https://release.picoaide.com/official/releases/${VER}/picoaide-server-${VER}-amd64.zip"
curl -fL -O "https://release.picoaide.com/official/releases/${VER}/SHA256SUMS"
sha256sum -c SHA256SUMS
unzip -p /tmp/pa.zip image.tar | docker load
```

无外网环境见[离线部署](/deployment/offline/)。

## 5. 切换版本并重启

```bash
cd /opt/picoaide
# 用 latest.json 的 server.image_tag（权威，形如 v2.7.0）；
# 镜像里 2.7.0 与 v2.7.0 两个 tag 都在，写哪个都能起来
sed -i "s|^SERVER_IMAGE=.*|SERVER_IMAGE=${IMAGE}:${VER}|" .env
grep -q '^SERVER_IMAGE=' .env || echo "SERVER_IMAGE=${IMAGE}:${VER}" >> .env

# 可选但推荐：重新导出部署文件（替换语义，.env / 数据目录不动）
docker run --rm -v /opt/picoaide:/out -e PICOAI_UNPACK_STACK=/out ${IMAGE}:${VER}

docker compose up -d
```

- `docker compose up -d` 只重建变化的容器；数据目录是 bind mount，**数据不受影响**；
- 重新导出部署文件是**替换**语义：`client/`、`VERSION`、`docker-compose.yml`、`Caddyfile.*`、`.env.example`
  先清旧再写（否则 `client/` 里会同时留着两个版本的安装器）；`.env` 与全部数据目录一律不动；
- **宿主机已有反代时**（见[运维与排障](/deployment/operations/#宿主机已有反向代理)）：只重建本产品容器
  `docker compose up -d postgres server`，别把共享反代牵进来。

## 6. 升级后验证（三项全过才算成功）

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

同时建议抽查两条客户端分发链路：

```bash
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
curl -sk -o /dev/null -w '%{http_code}\n' --resolve "$DOMAIN:443:127.0.0.1" \
  "https://$DOMAIN/updates/client/<清单里的文件名>"
```

清单里的 `client.version` 应随本次升级一起变化，安装包应可下载（断点续传返回 206）。

**任一项失败 → 执行第 7 步回滚，不要继续。**

## 7. 回滚

前提：**先判断新版本引入了哪一类迁移**，两种情形做法完全不同。

- **一般迁移（只加列 / 只建表）**：回滚镜像后数据库结构仍是新的，但旧二进制不引用新列，通常可以只换镜像。
- **`v2.7.6-beta.5` 及之后的 `v2.7.6` 线（含 `0073` `DROP TABLE` 与 `0074` 配置改写）**：这两条**不可逆**，
  **回滚 ≠ 只换镜像**。正确顺序 = **停服 → 恢复升级前的 `pg_dump` → 回退镜像 → 客户端重装/回退**。
  只回退镜像会让旧二进制逐请求报 **`42P01`（`undefined_table`）**，而迁移器只跳过"已应用"的版本号、
  **启动期不报错**（症状：服务能起来、健康检查通过，应用相关请求运行期 500）。
  **本版不提供降级通道**（不支持新旧访问模型并存，也不支持把服务端降回旧访问模型）。

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

# 3) 仅当应用数据被破坏时才恢复（会丢数据，需明确同意）
# docker compose stop server
# tar xzf deploy-backup/picoaide-data-<TS>.tar.gz -C picoaide-data
# docker compose start server

# 4) v2.7.6-beta.5 及之后的 v2.7.6 线：回滚必须做这一步（会丢数据，需明确同意）
# docker compose stop server
# docker exec -i picoaide-postgres pg_restore -U picoaide -d picoaide --clean \
#   < deploy-backup/pg-data-<TS>.dump
# docker compose start server
```

**回滚 3) / 4) 会让升级后产生的数据丢失**，执行前必须获得明确同意。

## 8. 收尾

```bash
cd /opt/picoaide
echo "$VER" > VERSION          # 若第 5 步没重新导出，这里手动更新
docker compose ps              # 三容器 Up
# 旧镜像先留着（回滚锚点）；确认稳定运行 1～2 天后再清理：
# docker image rm picoaide-harness-server:<旧版本>
```

员工客户端不需要逐台操作：它们从**这台服务器**取包，下次检查更新时就会看到新版本（见[客户端分发与升级](/deployment/client-delivery/)）。
但**应用（WASM）访问要求客户端与服务端同版本**：停留在旧版本的客户端无法打开应用，请确认员工接受升级提示（见[部署总览](/deployment/)）。

## 升级清单

- [ ] 远端版本 > 当前 `VERSION`
- [ ] PG 布局检查通过（无 `pg-data/PG_VERSION`）
- [ ] 备份已完成且**非空**
- [ ] 新镜像已导入并校验 `SHA256SUMS`
- [ ] `.env` 的 `SERVER_IMAGE` 指向新版本
- [ ] healthz 200 + `--version` == 目标版本 + 数据可查
- [ ] `client.version` 与安装包下载正常
- [ ] 已确认员工客户端升到配套版本（应用只在客户端内打开；旧客户端无法打开应用）
- [ ] 本地 `VERSION` 文件已更新
- [ ] 没有执行任何[铁律](/deployment/#四条铁律违反会造成不可恢复的数据损失)禁止的命令
