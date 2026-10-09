---
title: 升级、备份与回滚
description: 升级 PicoAide Harness 服务端：版本检查、备份与校验、切换镜像、升级后判据，以及同代与跨代回滚的不同做法。
---

升级只换镜像：`picoaide-data/`、`pg-data/`、`caddy-data/`、`certs/` 与 `.env` 都不动。
但**数据库迁移不可逆**，所以"备份 + 校验非空"和"升级后三项验证"是流程的一部分，不是可选项。

## 这一页解决什么问题

把一台在跑的部署从版本 A 换到版本 B，并且在换错时**能退回**。本页按顺序覆盖：
版本检查 → 升级前检查 → 备份与校验 → 导入镜像 → 切换与重启 → 升级后验证 → 回滚。

**前提**：

| 前提 | 说明 |
|---|---|
| 远端版本 **高于**当前运行版本 | 否则无需升级（第 1 步会给判据） |
| 备份**必须做**，而且必须确认非空 | 唯一退路是升级前那份 `pg_dump` 与 `picoaide-data/` 快照 |
| 知道本栈属于哪个渠道 | 同机多栈时必须用渠道专属 tag 做锚点（见[同一台服务器上跑多个渠道栈](#同一台服务器上跑多个渠道栈)） |
| 能接受"升级后管理员需重登一次"这类行为变化 | 见第 2 步的行为变化清单，逐条判断是否需要处置 |

> **服务端与客户端必须同版本升级**：应用（WASM）只在桌面客户端内打开，浏览器访问链路已删除 ——
> 旧客户端在服务端升级后**无法再打开应用**。客户端从这台服务器取包，升级后请确认员工客户端
> 升到配套版本（见[客户端分发与升级](/deployment/client-delivery/)）。

## 设计取舍

**为什么升级只换镜像。** 所有持久状态都在 bind mount 目录与 PostgreSQL 里，镜像本身**无状态**。
"升级"因此可以缩成一次 `docker load` + 改一行 `SERVER_IMAGE` + 重建容器；
部署文件（compose / Caddyfile / `.env.example`）的刷新是可选的第二步，两者互不影响。
这也是"回滚只需切回旧镜像"能成立的原因。

**为什么不能用 `latest`，为什么要固化回滚锚点。** 回滚的动作是"把 `SERVER_IMAGE` 指回上一版"，
所以"上一版"必须是一个**此刻仍然存在于本机**的具体引用。`latest` 回答不了这个问题；
而只靠 tag 名字也不够 —— 同一台机器上第二个渠道栈 `docker load` 会覆盖同名 tag
（渠道差异在镜像内容里，不在 tag 里），所以多栈宿主机要把**升级前正在跑的**镜像固化成
**渠道 tag**，那才是安全的锚点。

**为什么备份后必须校验非空。** 备份命令失败（磁盘满、容器名写错、`pg_dump` 权限不足）时，
shell 仍会留下一个同名文件 —— 空文件、几 KB 的残件、被截断的 tar。
如果升级随后出问题，你会在最需要退路的时候才发现退路不存在。因此判据是 `[ -s … ]`（非空），
而不是"文件在不在"。`picoaide-data/` 尤其关键：里面的 `master.key` 一旦丢失，
数据库中所有加密的上游 API Key **永久无法解密**。

**为什么迁移不可逆，以及为什么"跨代回滚"要和数据库一起退。** 迁移只向前推进库结构；
新版本可能删表、改存量数据（例如把 `access='public'` 改写成 `login`）。
2026-09-25 起服务端在启动期做**双向**迁移对账：`schema_migrations` 里只要存在当前二进制
不认识的版本号，就**拒绝启动**（`SchemaMismatchError`，点名版本号并给出两条可行动作）。
这是有意的：静默跳过会让"降级"和"死条目"永远不可见。代价是跨代回滚必须按
**先停服 → 恢复 `pg_dump` → 再回退镜像**的顺序做，不能只改 `SERVER_IMAGE` 就重启。

## 概念与结构

镜像归档里带三种 tag 形状（以版本 `${VER}` 为例）：

| tag | 用途 | 注意 |
|---|---|---|
| `${IMAGE}:${VER}` | 裸版本 tag | 所有渠道的归档里**完全相同** ⇒ 多栈宿主机会互相覆盖 |
| `${IMAGE}:v${VER}` | 带 `v` 的等价 tag | 同上 |
| `${IMAGE}:<channel-id>-${VER}` | **渠道专属 tag** | 只有本渠道的归档会写它；多栈宿主机必须用它 |

> tag 形状示例（讲的是**形状**，与具体版本无关）：归档里同时带裸号 `2.7.0` 与带 `v` 的 `v2.7.0`，
> 命令里一律写 `${IMAGE}:${VER}`，不要照抄某个具体版本号。

**回滚锚点** = 升级前那一刻**正在运行的**镜像，被固化成的**渠道 tag**
（`${IMAGE}:<channel-id>-<旧版本>`）。切换容器发生在改 `.env` 之后，所以"取锚点"必须
在读新镜像之前完成。

**迁移集合**是回滚分类的判据：新旧二进制可见的迁移集合相同 = **同代回滚**（可以只换镜像）；
库比二进制新 = **跨代回滚**（必须连数据库一起退）。当前迁移区间是 `0001–0084`。

## 操作步骤

### 1. 检查是否有新版本

```bash
# 远端最新版本（权威：latest.json 的 server.version）
curl -fsS https://release.picoaide.com/official/latest.json \
  | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
cat /opt/picoaide/VERSION        # 当前部署版本
docker exec picoaide-server /app/picoaide-server --version   # 运行中的版本
```

也可以直接看管理后台的**服务器信息**页：服务端自己检查更新并显示"发现新版本"（含目标镜像 tag）。

- 检查地址来自 `PICOAI_UPDATE_ENDPOINT`，留空 = 本渠道默认目录 `release.picoaide.com/<渠道>/latest.json`；
- 服务端有 **6 小时缓存**，刚发版时等待属正常延迟；
- "一直不显示新版本"先看 `docker compose logs server` 里的 `channel resolved: …` 与
  `manifest channel "official" != this server's channel "…"` —— 那是渠道配置不自洽
  （见[渠道与白标](/deployment/channels/)），不是"没有新版本"。

**判据**：远端 `server.version` > 当前 `VERSION`。远端 ≤ 当前 → **无需升级，结束**。

### 2. 升级前检查

```bash
cd /opt/picoaide

# (a) PG 数据布局检查：旧布局（PG16 时代）直接启动会被拒绝
[ -f pg-data/PG_VERSION ] && echo "!!! 旧版 PG16 布局，需先做 dump/restore 迁移，停止升级" || echo "PG 布局 OK"

# (b) 磁盘余量（新镜像 + 备份都需要空间）
df -h /opt | tail -1
```

出现 `!!!` 时**停止升级**，先按 PostgreSQL 官方 dump/restore 流程迁移数据 —— 旧 `pg-data/` 布局与
新镜像不兼容，不会被自动迁移。

**(c) 行为变化清单**（升级后按需处置，逐条判断）：

| 变化 | 为什么要看 |
|---|---|
| 管理端存量会话失效（迁移 `0066`：会话令牌只存哈希） | **管理员需重新登录一次**，属预期，不是故障 |
| 不可逆迁移（`0073` 删表、`0074` 改写应用配置） | 引入这两条的版本线**回滚 ≠ 只换镜像**，必须连库一起退 |
| 网关限流缺省值变化 | 代码缺省改成"不限速"，但**库里已保存的 `settings.gateway.rate_limit` 不会被自动覆盖** —— 老库仍按旧值限流，要放开请在管理后台「网关」页显式改成 `0` 或清空 |
| 应用平台内存档位 | 可用内存 < 4GiB 的机器必须显式写 `PICOAI_WASM_MEMORY_PROFILE=small`，否则**升级后容器反复重启**（启动自检拒绝启动） |
| 客户端行为变化（例如不再使用系统代理） | 只有"经代理才能出公网"的部署需要处置：打开渠道字段或真实进程环境变量里的退路 |
| 应用访问模型与客户端同版本要求 | 旧客户端升级后打不开应用，属预期；要确保客户端跟着升 |

**判据**：PG 布局 OK、磁盘余量足够放下新镜像与备份、行为变化清单逐条有结论。

### 3. 备份（不可跳过）

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

**校验备份非空**（否则后面的升级没有退路）：

```bash
[ -s "$OUT/picoaide-data-$TS.tar.gz" ] || echo "!!! 应用数据备份为空"
[ -s "$OUT/pg-data-$TS.dump" ]          || echo "!!! 数据库备份为空"
```

**判据**：两条 `[ -s … ]` 都不打印 `!!!`，且 `ls -lh` 里的两个文件大小是**可信量级**
（`pg-data` 的 dump 随数据量增长；几十字节的 dump 说明库名/用户写错了）。

**备份为空意味着什么**：`pg_dump` 失败但 shell 仍创建了文件 —— 此时**没有数据库退路**。
不要带着空备份继续升级：先修 `pg_dump`（容器名、用户 `picoaide`、库名 `picoaide`、
磁盘空间），重做一次并重新校验。

### 4. 导入新镜像

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

**判据**：`sha256sum -c` 输出 `OK`。校验失败**不要** `docker load` —— 换一个下载路径重取，
或按[离线部署](/deployment/offline/)的旁路流程重来。

### 5. 切换版本并重启

单栈宿主机：

```bash
cd /opt/picoaide
# 用 latest.json 的 server.image_tag（权威，形如 v<版本>）
# 归档里裸号与 v 号两种 tag 都在，写哪个都能起来；同机多栈必须用渠道 tag（见下一节）
sed -i "s|^SERVER_IMAGE=.*|SERVER_IMAGE=${IMAGE}:${VER}|" .env
grep -q '^SERVER_IMAGE=' .env || echo "SERVER_IMAGE=${IMAGE}:${VER}" >> .env

# 可选但推荐：重新导出部署文件（替换语义，.env / 数据目录不动）
docker run --rm -v /opt/picoaide:/out -e PICOAI_UNPACK_STACK=/out ${IMAGE}:${VER}

docker compose up -d
```

- `docker compose up -d` 只重建变化的容器；数据目录是 bind mount，**数据不受影响**；
- 重新导出是**替换**语义：`client/`、`VERSION`、`docker-compose.yml`、`Caddyfile.*`、`.env.example`
  先清旧再写（否则 `client/` 里会同时留着两个版本的安装器）；`.env` 与全部数据目录一律不动；
- **宿主机已有反代时**：只重建本产品容器 `docker compose up -d postgres server`，
  别把共享反代牵进来（见[运维与排障](/deployment/operations/)）。

#### 同一台服务器上跑多个渠道栈

渠道差异在**镜像内容**（品牌、随包客户端、镜像内的渠道标记），**不在 tag**：每个渠道的归档内部
都带同一个裸版本 tag 与 v 号 tag。因此同一台机器上导入第二个渠道的包时，后 `docker load`
的那一份会**覆盖**先前的 tag，此后任一栈 `docker compose up -d server` 都可能用**另一个渠道**
的镜像重建 —— 品牌与随包安装包全错，而该栈 `.env` 里的 `SERVER_IMAGE` 看起来完全正确。

每个渠道的归档从 `v2.8.2-beta.1`（2026-09-24）起**额外**带一个渠道专属 tag
`${IMAGE}:<channel-id>-<版本>`；三个 tag 都指向**新**镜像，`docker load` 会一并恢复，
**不需要重打任何 tag**。多栈宿主机的正确顺序：

```bash
VER=<本次版本，不带 v>
OLD=<升级前版本，不带 v>
IMAGE=picoaide-harness-server
CHANNEL=<本栈渠道 id>          # ← 与镜像内烘焙的渠道标记一致
STACK=/opt/picoaide            # ← 本栈部署目录
CT=picoaide-server             # ← 本栈 server 容器名

# 0) 把**升级前正在跑的**镜像固化成回滚锚点 —— "运行中容器"唯一正当的用途：
#    它此刻代表的是**旧版本**，所以只能记成**旧版本**的渠道 tag。
#    ⚠ 变量名不要用 GID / UID：远端 shell 是 zsh 时它们是只读特殊变量。
docker exec "$CT" cat /opt/picoaide/CHANNEL        # 先确认这一栈此刻跑的确实是本渠道
ROLLBACK_IMAGE_ID="$(docker inspect "$CT" --format '{{.Image}}')"
docker tag "$ROLLBACK_IMAGE_ID" "${IMAGE}:${CHANNEL}-${OLD}"

# 1) 导入本渠道的包（两栈各 load 自己渠道的包）
unzip -p /tmp/pa.zip image.tar | docker load

# 2) 取**刚导入的新镜像**的 id：只认渠道 tag
NEW_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "${IMAGE}:${CHANNEL}-${VER}")"
test -n "$NEW_IMAGE_ID"
test "$NEW_IMAGE_ID" != "$ROLLBACK_IMAGE_ID"       # 新旧必须是两份不同的镜像
docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' \
  "${IMAGE}:${CHANNEL}-${VER}"                     # 应等于 ${VER}
docker run --rm --entrypoint cat "${IMAGE}:${CHANNEL}-${VER}" /opt/picoaide/CHANNEL   # == ${CHANNEL}

# 3) 本栈 .env 指向渠道 tag（不要留裸 `v<版本>`）
cd "$STACK"
sed -i "s|^SERVER_IMAGE=.*|SERVER_IMAGE=${IMAGE}:${CHANNEL}-${VER}|" .env
grep -q '^SERVER_IMAGE=' .env || echo "SERVER_IMAGE=${IMAGE}:${CHANNEL}-${VER}" >> .env
docker compose up -d server

# 4) 断言这一栈跑的确实是本渠道的新版本（五项全过）
ENV_TAG="$(sed -n 's/^SERVER_IMAGE=//p' .env)"
test "$(docker image inspect --format '{{.Id}}' "$ENV_TAG")" = "$NEW_IMAGE_ID"   # .env 的 tag 指向新镜像
docker inspect "$CT" --format '{{.Image}}'         # == $NEW_IMAGE_ID ← 最关键的一条
docker exec "$CT" /app/picoaide-server --version   # == 目标版本（看二进制自报，不看 tag）
docker exec "$CT" cat /opt/picoaide/CHANNEL        # == $CHANNEL
curl -sk "https://<本栈域名>/api/client/v2/channel" | head -c 300   # channel_id 与之一致
```

> **不要按"运行中的容器"取 id 去贴新版本的渠道 tag。** 切换容器的动作在第 3 步，所以第 2 步
> `docker inspect "$CT"` 拿到的是**升级前**那份镜像的 id —— 拿它贴成 `${IMAGE}:${CHANNEL}-${VER}`，
> 等于把旧镜像改名为"新版本的渠道 tag"，并覆盖掉归档刚恢复的正确 tag；随后 `.env` 指向该 tag、
> `docker compose up -d` 又从同一个 image id 重建 ⇒ **升级静默不生效**，而 tag 与 `.env` 都声称
> 新版本，且回滚锚点被污染。全过程零报错，只有第 4 步的 image id / `--version` 断言能发现。

> **裸 tag 不能用来判定"我刚导入的是哪个镜像"**：它们在所有渠道的归档里完全相同，同机第二个
> 渠道栈 `docker load` 会覆盖它们（覆盖后 `docker image inspect` 不报错，只是给出**别渠道**
> 镜像的 id）。只有 `<channel-id>-<版本>` 是每个渠道独有的名字。

旧包（不带渠道 tag 的归档，即 2026-09-24 之前）只能退回裸 tag：`docker load` 之后**立刻**用
`docker image inspect --format '{{.Id}}' ${IMAGE}:${VER}` 取 id，并当场核对镜像内烘焙的渠道
（`docker run --rm --entrypoint cat ${IMAGE}:${VER} /opt/picoaide/CHANNEL` 应等于 `${CHANNEL}`），
通过后再贴成渠道 tag。首次部署（还没有运行中的容器）没有第 0 步，第 1–4 步照做。

### 6. 升级后验证（三项全过才算成功）

```bash
cd /opt/picoaide
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)

# (a) 健康检查
for i in $(seq 1 40); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
    --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz")
  [ "$code" = "200" ] && { echo "healthz OK"; break; }; sleep 3
done

# (b) 运行版本 == 目标版本（权威判据：看二进制自报，不看 tag）
docker exec picoaide-server /app/picoaide-server --version

# (c) 数据仍在（迁移已应用）
docker exec picoaide-postgres psql -U picoaide -d picoaide -c 'select count(*) from users;'
```

再抽查两条客户端分发链路：

```bash
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
curl -sk -o /dev/null -w '%{http_code}\n' --resolve "$DOMAIN:443:127.0.0.1" \
  "https://$DOMAIN/updates/client/<清单里的文件名>"
```

清单里的 `client.version` 应随本次升级一起变化，安装包应可下载（断点续传返回 206）。
多栈宿主机还要跑第 5 节的第 4 步五项断言。

**任一项失败 → 执行第 7 步回滚，不要继续。**

### 7. 收尾

```bash
cd /opt/picoaide
echo "$VER" > VERSION                       # 若第 5 步没重新导出，这里手动更新
docker compose ps                           # 三容器 Up
# 旧镜像先留着（回滚锚点）；确认稳定运行 1～2 天后再清理：
# docker image rm picoaide-harness-server:<旧版本>
```

客户端会在下次检查时看到新版本并提示员工升级（升级源就是这台服务器）。

## 回滚

**先判断新版本引入了哪一类迁移**，两种情形做法完全不同。

| 情形 | 判据 | 做法 |
|---|---|---|
| **同代回滚** | 新旧二进制可见的迁移集合**完全相同** | 可以只换镜像：库结构仍是新的，旧二进制不引用新列 |
| **跨代回滚** | 库比二进制**新**（`schema_migrations` 里有当前二进制不认识的版本） | **不能只换镜像**：2026-09-25 起的二进制在启动期就拒绝启动（`SchemaMismatchError`）。必须 **停服 → 恢复升级前的 `pg_dump` → 回退镜像 → 客户端一起回退** |
| **含不可逆迁移的版本线** | 引入了 `0073`（删表）/ `0074`（改写存量配置）这类迁移 | 同上四步；只回退镜像会让没有双向对账判据的旧二进制逐请求报 `42P01`（`undefined_table`），症状是"服务能起来、健康检查通过，但应用相关请求运行期 500" |

> **只加列 / 只建表这一类迁移还有一条更轻的同等路径**：把 `schema_migrations` 里那一行删掉，
> 库与二进制就重新"同代"，再换镜像即可 —— **不恢复 `pg_dump`、不丢升级后写入的数据**。
> 适用条件两条：① 该迁移可回滚（只加列 / 只建表；删表或改写存量数据的迁移不适用）；
> ② 你接受"库结构保留新列"。命令（容器名 / 用户 / 库名用你自己部署里的取值）：
>
> ```bash
> docker exec -i <pg容器> psql -U <库用户> -d <库名> \
>   -c 'DELETE FROM schema_migrations WHERE version = <NNNN>;'
> ```
>
> **两条路都不允许"只改 `SERVER_IMAGE` 就重启"**。前滚（重新升回新版本）时那一行会被自动补回
> 并回填内容摘要。

```bash
cd /opt/picoaide
OLD=<升级前的版本>
IMAGE=picoaide-harness-server
CHANNEL=<本栈渠道 id>          # ← 与镜像内烘焙的渠道标记一致

# 1) 切回旧镜像 —— 用多栈章节第 0 步固化出来的**渠道 tag**（回滚锚点就是那一个）
#    ⚠ 不要写裸 `${IMAGE}:${OLD}`：同机多栈时那个裸 tag 可能已被别渠道的 `docker load`
#    覆盖，而 compose 的 PICOAI_CHANNEL 缺省为空 ⇒ 这一栈会以别渠道的品牌静默起来。
docker image inspect --format '{{.Id}} {{.RepoTags}}' "${IMAGE}:${CHANNEL}-${OLD}"   # 锚点必须存在
sed -i "s|^SERVER_IMAGE=.*|SERVER_IMAGE=${IMAGE}:${CHANNEL}-${OLD}|" .env
docker compose up -d

# 2) 验证旧版本健康（版本 + 渠道两面）
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
curl -sk -o /dev/null -w '%{http_code}\n' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"
docker exec picoaide-server /app/picoaide-server --version      # 应等于 OLD
docker exec picoaide-server cat /opt/picoaide/CHANNEL           # 应等于 $CHANNEL（防静默换品牌）
echo "$OLD" > VERSION

# 3) 仅当应用数据被破坏时才恢复（会丢数据，需明确同意）
# docker compose stop server
# tar xzf deploy-backup/picoaide-data-<TS>.tar.gz -C picoaide-data
# docker compose start server
#
# 4) 跨代回滚 / 含不可逆迁移的版本线：必须做这一步（会丢数据，需明确同意）
# docker compose stop server
# docker exec -i picoaide-postgres pg_restore -U picoaide -d picoaide --clean \
#   < deploy-backup/pg-data-<TS>.dump
# docker compose start server
```

**回滚 3) / 4) 会让升级后产生的数据丢失**，执行前必须获得明确同意。

## 判据

| 判据 | 怎么判 |
|---|---|
| 备份有效 | 两条 `[ -s … ]` 都不告警，且文件大小是可信量级 |
| 镜像可信 | `sha256sum -c SHA256SUMS` 输出 `OK` |
| 运行版本正确 | `docker exec picoaide-server /app/picoaide-server --version` == 目标版本 |
| 渠道正确（多栈必查） | 容器 image id == 新镜像 id；`/opt/picoaide/CHANNEL` == `${CHANNEL}`；`/api/client/v2/channel` 的 `channel_id` 与之一致 |
| 服务可用 | `/healthz` 返回 200 |
| 数据在 | `select count(*) from users;` 有结果；迁移已应用到当前区间 |
| 客户端链路 | 清单 `client.version` 已变化；安装包可下载（206） |
| 收尾完成 | `VERSION` 文件 == 运行版本；旧镜像仍在（回滚锚点） |

## 边界与失败行为

| 现象 | 判据 | 恢复动作 |
|---|---|---|
| 升级后容器反复重启 | 日志里 `SchemaMismatchError` | **跨代回滚**：按第 7 节四步顺序（停服 → 恢复 `pg_dump` → 回退镜像 → 客户端回退） |
| 升级后容器反复重启 | 日志里"WASM 应用平台启动自检失败…拒绝启动" | 可用内存 < 4GiB：`.env` 写 `PICOAI_WASM_MEMORY_PROFILE=small` 后 `docker compose up -d server` |
| `--version` 与 `.env` 声称的版本不一致 | 二进制自报值 ≠ 目标版本 | 说明容器没换到新镜像：多栈场景按第 5 节五项断言重做（关键看 `docker inspect <容器> --format '{{.Image}}'`） |
| 升级后品牌变了 / 门户变成厂商品牌 | `/opt/picoaide/CHANNEL` ≠ `/api/client/v2/channel` 的 `channel_id` | 用错渠道镜像：改 `.env` 指回本渠道的渠道 tag 后重建；不要继续用它升级 |
| healthz 一直非 200 | `docker compose ps` / `logs` | 先确认 postgres healthy 与迁移是否仍在跑（首次 1–2 分钟）；仍不通按第 7 节回滚 |
| 备份为空 | `[ -s … ]` 打印 `!!!` | **停止升级**：修 `pg_dump`（容器名/用户/库名/磁盘）后重做备份并重新校验 |
| 回滚后旧版本能起来但请求 500 | 日志里 `42P01`（`undefined_table`） | 这是"只换镜像、没回退数据库"的形态（没有双向对账判据的旧二进制）：停服 → 恢复升级前 `pg_dump` → 再启动 |
| 回滚锚点已被覆盖 | `docker image inspect` 的 `RepoTags` 指向别渠道 / 不存在 | 从更新服务器重新 `docker load` 该渠道的旧包，固化渠道 tag 后再回滚（旧包可能已超出保留窗口，见[离线部署](/deployment/offline/)） |
| 升级后管理员被要求重新登录 | 迁移 `0066` 使存量管理会话失效 | 预期行为，重新登录即可 |

## 升级清单

- [ ] 远端版本 > 当前 `VERSION`
- [ ] PG 布局检查通过（无 `pg-data/PG_VERSION`），磁盘余量足够
- [ ] 行为变化清单逐条有结论（限流缺省、内存档位、客户端行为、不可逆迁移）
- [ ] 备份已完成且**非空**（`picoaide-data/` + `pg_dump`）
- [ ] 新镜像已导入并校验 `SHA256SUMS`
- [ ] 多栈宿主机：升级前镜像已固化成**旧版本**的渠道 tag
- [ ] `.env` 的 `SERVER_IMAGE` 指向新版本（多栈用渠道 tag）
- [ ] healthz 200 + `--version` == 目标版本 + 数据可查
- [ ] `client.version` 与安装包下载正常
- [ ] 已确认员工客户端升到配套版本（应用只在客户端内打开）
- [ ] 本地 `VERSION` 文件已更新；旧镜像仍保留
- [ ] 没有执行任何[铁律](/deployment/)禁止的命令

## 相关

- [部署总览](/deployment/) —— 交付物、证书模式与四条铁律
- [容器化部署](/deployment/compose/) —— 首次部署
- [客户端分发与升级](/deployment/client-delivery/) —— 客户端怎么跟着服务端升级
- [渠道与白标](/deployment/channels/) —— 为什么渠道 tag 是多栈宿主机上的必需项
- [离线部署](/deployment/offline/) —— 取包与更新检查的旁路
- [运维与排障](/deployment/operations/) —— 备份恢复、日志与常见故障
