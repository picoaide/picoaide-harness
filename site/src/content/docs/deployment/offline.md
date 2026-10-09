---
title: 离线部署
description: 服务器或员工机器不能访问外网时的 PicoAide Harness 部署与升级：旁路取包、校验、内网镜像与更新检查的开关语义。
---

产品的主要形态就是企业内网部署，所以"能不能离线"要分成两件事看：**员工侧本来就零外网**，
**服务端侧只有一个外部依赖**（检查更新 + 取镜像）。本页说明这个边界，以及完全隔离时的旁路流程。

## 这一页解决什么问题

回答三个问题：员工机器到底需不需要外网？服务器断网还能不能部署与升级？更新检查该关还是该改？
本页覆盖：外网依赖边界 → 旁路取包（含校验判据）→ 内网镜像与更新检查开关 →
完全隔离时的版本锚点与升级节奏 → 内网证书信任 → 判据 → 失败行为。

**前提**：

| 前提 | 说明 |
|---|---|
| 有一台**能出网**的中转机器 | 只需一次下载镜像包与 `SHA256SUMS`，再带进内网 |
| 目标机能装 Docker、能 `docker load` | 导入镜像不需要外网 |
| 已确认本部署的渠道 id | 取包目录与清单里的 `channel_id` 必须与它一致 |

## 外网依赖边界

| 谁 | 是否需要外网 | 说明 |
|---|---|---|
| **员工电脑** | **完全不需要** | 客户端安装包与更新包都由企业服务器下发（见[客户端分发与升级](/deployment/client-delivery/)） |
| **企业服务器** | 只有"检查更新 + 下载镜像"需要 | 能访问 `release.picoaide.com` 即可；完全隔离时按本页旁路取包 |
| 已部署的运行时 | 不需要 | 服务端不依赖任何外部服务；上游模型由管理员在网关页配置 |

## 设计取舍

**为什么镜像不放在镜像仓库里。** 见[部署总览](/deployment/)：交付物只有一个 zip + 一份 `SHA256SUMS`，
放在按渠道分目录的 HTTPS 站点上。这样"完全隔离的机房"只需要**一次带外传输**（U 盘/跳板机）
就能完成部署与升级，而不需要在这台机器上开一个 registry 端口或配一套镜像代理。

**为什么更新检查"留空 ≠ 关闭"。** `PICOAI_UPDATE_ENDPOINT` 留空表示"用本渠道的默认目录"，
显式写 `off` / `none` / `-` / `disabled` 才是关闭。把"留空"解释成"关闭"会让**所有**默认部署
静默失去升级提示；反过来，把"关闭"解释成"留空"会向纯内网机器发外网请求。
两种误读都有真实代价，所以语义必须显式。

**为什么只保留 3 个版本。** 更新服务器上每个渠道**只保留最近 3 个版本**：镜像包很大
（每个版本数百 MB 到 1 GB 级，内含三平台客户端），保留策略让"回滚锚点"（上一版、上两版）
仍然可取，又不至于让存储与分发成本随版本数无限增长。更早的版本从
[GitHub Release](https://github.com/picoaide/picoaide-harness/releases) 取（公开渠道的完整历史归档）。

## 操作步骤

### 1. 在能出网的机器上取包并校验

```bash
# 1) 读版本（权威字段：server.version / server.image_tag）
curl -fsS https://release.picoaide.com/<渠道>/latest.json

# 2) 下载镜像包与校验文件
VER=<版本>            # ← 用清单里的 server.version（不带 v）
curl -fL -o picoaide-server-${VER}-amd64.zip \
  "https://release.picoaide.com/<渠道>/releases/${VER}/picoaide-server-${VER}-amd64.zip"
curl -fL -O "https://release.picoaide.com/<渠道>/releases/${VER}/SHA256SUMS"

# 3) 校验（在出网机器上先校一次，带进内网后再校一次）
sha256sum -c SHA256SUMS
```

**判据**：`sha256sum -c` 输出 `OK`，且 zip 大小与清单无关——以 `SHA256SUMS` 为准。
`<渠道>` 必须与本部署渠道一致；取错渠道的包在导入后会被启动期校验拒绝（见[渠道与白标](/deployment/channels/)）。

跨境下载慢时可用并行分块：实测单流 75–260 KB/s，8 路并行约 2 MB/s。某些 Range 请求会被 CDN
忽略并返回整份文件 —— **校验哈希仍是最终判据**，不要因为"分块下载成功"就跳过校验。

### 2. 带进内网并导入

```bash
# 拷贝到目标机（示例：scp；U 盘/跳板机同理）
scp picoaide-server-${VER}-amd64.zip SHA256SUMS <user>@<目标机>:/tmp/

# 在目标机上：先校验，再导入
ssh <user>@<目标机>
cd /tmp && sha256sum -c SHA256SUMS
unzip -p picoaide-server-${VER}-amd64.zip image.tar | docker load
```

没有 `unzip` 的机器可以用 Python 的标准库代替：

```bash
python3 -c 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extract("image.tar")' \
  picoaide-server-${VER}-amd64.zip
docker load -i image.tar
```

导入之后的部署步骤与在线完全相同，见[容器化部署](/deployment/compose/)；
升级流程见[升级、备份与回滚](/deployment/upgrade/)，区别只在于第 4 步的镜像来源换成
"从外部带进来的 zip"。

**判据**：`docker run --rm --entrypoint /app/picoaide-server picoaide-harness-server:<版本> --version`
输出等于 `<版本>`。不要用 `docker images` 的 IMAGE ID 判断版本。

### 3. 关闭或改造更新检查

```bash
# 关闭更新检查（纯内网、不希望任何外发请求时）
PICOAI_UPDATE_ENDPOINT=off
```

- **留空不等于关闭**：留空 = 用本渠道默认目录；要关闭必须显式写 `off` / `none` / `-` / `disabled`；
- 内网有自建的静态文件服务时，也可以把镜像包与 `latest.json` 镜像到内网，并把
  `PICOAI_UPDATE_ENDPOINT` 指向内网地址 —— `latest.json` 的 `channel_id` 必须与本部署渠道一致，
  否则会被判为"检查更新不可用"（这是有意的：宁可明说不可用，也不静默跨渠道升级）；
- 关闭后管理后台「服务器信息」页不再显示新版本提示，升级由运维按[升级流程](/deployment/upgrade/)手工执行。

**判据**：`docker compose logs --tail=200 server | grep -i 'channel resolved'` ——
端点为空说明更新检查已关闭；指向内网地址说明改造成了内网镜像。两种都符合预期，
**但要知道自己选了哪一种**。

### 4. 离线升级节奏与版本锚点

完全隔离的部署没有"新版本提示"，版本锚点靠两处人工核对：

```bash
cat /opt/picoaide/VERSION                                     # 当前部署版本
docker exec picoaide-server /app/picoaide-server --version    # 运行中的版本
```

两者都应等于上次升级时写入的目标版本。两者不一致说明上次升级只改了文件或只换了容器之一，
**在下次升级前先查清**（见[升级、备份与回滚](/deployment/upgrade/)的判据表）。
建议同时记录"本机保留的旧镜像 tag"（回滚锚点）：离线环境里重新取旧包要再走一次带外传输。

### 5. 内网证书与客户端信任

`internal` 模式由 Caddy 本地 CA 签发证书，链路是加密的，但客户端首次连接需要信任该 CA：

- 内网有企业 CA 时用 `manual` 模式挂正式证书，客户端无需额外操作；
- 用 `internal` 模式时，把 Caddy 根证书分发给员工机器导入信任库；
- 无论哪种模式，客户端登录页都拒绝非 HTTPS 的远程地址。

部署后自检（不依赖 DNS，直接解析到本机）：

```bash
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
```

第二条必须能看到 `client.assets` 且地址为绝对 https —— 内网反代/证书场景下最容易漏配
`PICOAI_PUBLIC_BASE_URL`，症状是员工端"检查更新永远说已是最新"。
注意这一条与"更新检查"是两件事：**客户端从本服务器取包**（这条），**服务端从更新服务器检查新版本**（第 3 步）。

## 判据

| # | 判据 | 怎么判 |
|---|---|---|
| 1 | 包完整 | `sha256sum -c SHA256SUMS` 输出 `OK`（出网机器上一次、目标机上一次） |
| 2 | 镜像可用 | `<镜像> --version` == 目标版本 |
| 3 | 部署可用 | `/healthz` 返回 200，清单有 `client.assets` 且地址绝对 https |
| 4 | 更新检查语义明确 | 启动日志 `channel resolved: …` 里的端点符合你的选择（空 = 关闭 / 内网地址 = 镜像） |
| 5 | 版本锚点一致 | `VERSION` 文件 == `--version` 输出 |
| 6 | 员工侧零外网 | 在员工机器上确认只需访问企业域名即可下载与登录 |

## 边界与失败行为

| 现象 | 判据 | 恢复动作 |
|---|---|---|
| 目标版本已超出保留窗口（404） | 下载返回 404 | 更新服务器每个渠道**只保留最近 3 个版本**：从 GitHub Release 取（仅公开渠道），或从本机保留的旧镜像 tag 回滚 |
| 同版本号重发后拿到的还是旧字节 | 下载内容的 sha256 与新版 `SHA256SUMS` 不一致 | `<渠道>/releases/<版本>/` 下的 zip 与 `SHA256SUMS` 是**不可变长缓存**（`immutable`）：同版本号覆盖后边缘可能仍发旧字节。要么按新版本号发布，要么在 URL 上加一个缓存穿透参数再校验 |
| 内网镜像的清单被判"检查更新不可用" | 日志里 `manifest channel "…" != this server's channel "…"` | 内网 `latest.json` 的 `channel_id` 必须与本部署渠道一致 —— 这条校验是防止跨渠道升级的，不要绕过 |
| 纯内网机器仍发外网请求 | 抓包/防火墙日志 | `PICOAI_UPDATE_ENDPOINT` 写的是留空而不是 `off`：留空 = 用默认公网目录 |
| 员工首次连接报证书不受信任 | 仅 `internal` 模式 | 属预期：分发 Caddy 本地 CA 给员工机器，或改用 `manual` 挂企业证书 |
| 镜像导入后容器启动即退出 | 日志"渠道不一致"或"渠道配置非法" | 取错了渠道的包：换成本渠道的包重取（见[渠道与白标](/deployment/channels/)） |
| 离线环境里想回滚却找不到旧镜像 | `docker image ls` 里没有旧版本 tag | 保留策略只覆盖更新服务器：离线部署必须**在本机保留旧镜像 tag**，或提前把旧包带进来 |

## 相关

- [部署总览](/deployment/) —— 交付物与取镜像面
- [容器化部署](/deployment/compose/) —— 导入镜像之后的步骤
- [升级、备份与回滚](/deployment/upgrade/) —— 离线升级与回滚顺序
- [客户端分发与升级](/deployment/client-delivery/) —— 员工侧为什么零外网
- [渠道与白标](/deployment/channels/) —— 渠道目录与渠道校验
