---
title: 离线部署
description: 服务器或员工机器不能访问外网时的 PicoAide Harness 部署与升级方式。
---

产品的主要形态就是企业内网部署，所以"能不能离线"分成两件事来看：

| 谁 | 是否需要外网 | 说明 |
|---|---|---|
| **员工电脑** | **完全不需要** | 客户端安装包与更新包都由企业服务器下发（见[客户端分发与升级](/deployment/client-delivery/)） |
| **服务器** | 只有"检查更新 + 下载镜像"需要 | 能访问 `release.picoaide.com` 即可；完全隔离时按本页旁路取包 |

## 员工侧：零外网依赖

服务端镜像里已经带着三平台客户端安装包，部署完成后由这台服务器对外提供。
员工只需要能访问企业域名，不需要访问更新服务器、GitHub 或任何公网地址。

## 服务端侧：完全隔离时怎么取镜像

在**任意一台能出网的机器**上下载镜像包与校验文件，再带进内网：

```bash
# 1) 读版本（权威字段：server.version / server.image_tag）
curl -fsS https://release.picoaide.com/<渠道>/latest.json

# 2) 下载镜像包与校验文件
VER=2.7.0
curl -fL -o picoaide-server-${VER}-amd64.zip \
  "https://release.picoaide.com/<渠道>/releases/${VER}/picoaide-server-${VER}-amd64.zip"
curl -fL -O "https://release.picoaide.com/<渠道>/releases/${VER}/SHA256SUMS"

# 3) 拷贝进内网后校验并导入
sha256sum -c SHA256SUMS
unzip -p picoaide-server-${VER}-amd64.zip image.tar | docker load
```

- 更新服务器每个渠道**只保留最近 3 个版本**；更早的版本从
  [GitHub Release](https://github.com/picoaide/picoaide-harness/releases) 取（公开渠道的完整历史存档，
  资产名同为 `picoaide-server-<版本>-amd64.zip` + `SHA256SUMS`）；
- 跨境下载慢时可用并行分块（实测单流 75–260 KB/s，8 路并行约 2 MB/s）：做法与坑见仓库
  [`docs/planning/2026-09-10-r2-update-server-runbook.md`](https://github.com/picoaide/picoaide-harness/blob/master/docs/planning/2026-09-10-r2-update-server-runbook.md) §11。
  某些 Range 请求会被 CDN 忽略并返回整份文件，校验哈希仍是最终判据；
- 校验 `SHA256SUMS` 之后再 `docker load` —— 内网里没有第二条获取渠道，包坏了要重走一遍流程。

导入之后的部署步骤与在线完全相同，见[容器化部署](/deployment/compose/)。

## 关闭或改造更新检查

服务端默认按本渠道默认目录检查更新（`release.picoaide.com/<渠道>/latest.json`）：

```bash
# 关闭更新检查（纯内网、不希望任何外发请求时）
PICOAI_UPDATE_ENDPOINT=off
```

- **留空不等于关闭**：留空 = 用本渠道默认目录；要关闭必须显式写 `off` / `none` / `-` / `disabled`；
- 内网有自建的静态文件服务时，也可以把镜像包与 `latest.json` 镜像到内网，并把
  `PICOAI_UPDATE_ENDPOINT` 指向内网地址（`latest.json` 的 `channel_id` 必须与本部署渠道一致，
  否则会被判为"检查更新不可用"）；
- 关闭后 webadmin「服务器信息」页不再显示新版本提示，升级由运维按[升级流程](/deployment/upgrade/)手工执行。

## 离线升级节奏

完全隔离的部署没有"新版本提示"，版本锚点靠两处人工核对：

```bash
cat /opt/picoaide/VERSION                                     # 当前部署版本
docker exec picoaide-server /app/picoaide-server --version     # 运行中的版本
```

两者都应等于上次升级时写入的目标版本。升级时按[升级、备份与回滚](/deployment/upgrade/)执行，
区别只在于第 4 步的镜像来源换成"从外部带进来的 zip"。

## 内网证书与客户端信任

`internal` 模式由 Caddy 本地 CA 签发证书，链路是加密的，但客户端首次连接需要信任该 CA：

- 内网有企业 CA 时用 `manual` 模式挂正式证书，客户端无需额外操作；
- 用 `internal` 模式时，把 Caddy 根证书分发给员工机器导入信任库；
- 无论哪种模式，客户端登录页都拒绝非 HTTPS 的远程地址（TOFU 校验）。

部署后自检（不依赖 DNS，直接解析到本机）：

```bash
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz"
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
```

第二条必须能看到 `client.assets` 且地址为绝对 https —— 内网反代/证书场景下最容易漏配
`PICOAI_PUBLIC_BASE_URL`，症状是员工端"检查更新永远说已是最新"。
