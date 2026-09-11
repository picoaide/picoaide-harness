---
title: 交付方式：一个镜像完成私有化部署
description: PicoAide Harness 当前的交付形态——服务端与客户端同包发版、从更新服务器取镜像、渠道白标与数据隔离，以及升级与回滚的边界。
pubDate: 2026-09-11
author: PicoAide Team
tags:
  - 产品
  - 部署
---

过去一年里 PicoAide Harness 的交付方式换过一次骨架：从"服务端、客户端、更新通道各自发布"，
收敛成**一个镜像 + 一份说明**。这篇说明当前这套交付形态长什么样、为什么这么设计，
以及运维需要知道的边界。完整的操作步骤见 [私有化部署](/deployment/)。

## 一、发布物只有一个容器镜像

镜像里装好了部署所需的一切，部署机上不需要克隆仓库、不需要外网拉配置，也没有任何安装脚本：

```
picoaide-harness-server:<版本>
  ├─ 服务端二进制（webadmin 管理后台内嵌）
  ├─ 三平台客户端安装包 + CLIENT-RELEASE.json
  ├─ docker-compose.yml + Caddyfile.{internal,autocert,manual} + .env.example
  └─ VERSION / CHANNEL / channel/（品牌与文案）
```

一条命令把部署文件导出到部署目录：

```sh
docker run --rm -v /opt/picoaide:/out -e PICOAI_UNPACK_STACK=/out \
  picoaide-harness-server:<版本>
```

导出是**替换语义**：`compose`、`Caddyfile.*`、`client/` 会先清旧再写，
而 `.env` 与数据目录一律不动 —— 这也是"升级"与"重装"的分界线。

## 二、镜像从更新服务器取，不经镜像仓库

每个渠道在 `release.picoaide.com/<渠道>/` 下有一套独立目录：

```
<渠道>/latest.json                                                  ← 版本清单（服务端升级检查也读它）
<渠道>/releases/<版本>/picoaide-server-<版本>-amd64.zip
<渠道>/releases/<版本>/SHA256SUMS                                   ← 下载后校验
```

- 更新服务器**只保留最近 3 个版本**，GitHub Release 作为公开渠道的长期归档；
- 品牌渠道的镜像**只经更新服务器自己的目录**分发，不进公开 Release；
- 内网完全隔离时，在能出网的机器上下载镜像包与校验文件，带进内网 `docker load` 即可（见[离线部署](/deployment/offline/)）。

## 三、客户端与服务端同包发版

客户端安装包不打在某个下载站上，而是**随服务端镜像发布**，由企业自己的服务器下发：

- 员工从门户页（`https://<企业域名>/`）下载安装；
- 客户端只向**它登录的那台服务端**检查更新（`GET /api/client/v2/updates/manifest`），
  安装包地址与 SHA-256 都来自清单，下载支持断点续传；
- 于是"客户端升了、服务端没升"在结构上不可能发生：**升级服务端就是升级全员客户端**；
- 企业员工机器全程不需要访问任何外网。

清单里的下载地址必须是**绝对 https**。反代场景下若服务端判断不出协议，会按设计拒发下载链接并给出
`client_unavailable` 原因，而不是下发一个会被客户端丢弃的 http 地址 —— 配置方式见
[客户端分发与升级](/deployment/client-delivery/)。

## 四、渠道：同一套代码，多份品牌

同一个版本可以交付成多个渠道（正式 / 预发布 / 企业定制）。
渠道内容（名称、标语、欢迎语、标识、主题色、深链 scheme）在构建期注入镜像，
同时作用于客户端登录页、客户端界面、管理后台侧栏与门户页。

渠道之间**互不升级**，并且这是被强制的：

- 服务端启动时校验自身渠道与镜像内渠道内容一致，不一致**拒绝启动**；
- 检查更新时校验远端清单的 `channel_id`，不一致判为"检查不可用"，
  绝不允许品牌部署接受官方清单、升级后被"洗"成官方版；
- 定制渠道的客户端使用**独立的数据目录与深链 scheme**，同一台机器上装两个渠道也互不影响。

细节见[渠道与白标](/deployment/channels/)。

## 五、运维要记住的边界

- **数据都在部署目录的 bind mount 里**：`picoaide-data/`（含 `master.key`）与 `pg-data/`，
  升级只换镜像、不动数据；`master.key` 丢失会导致库内加密的上游密钥永久无法解密，必须单独备份；
- **数据库迁移不可逆**：回滚镜像不会把数据库降回旧结构，出问题优先向前修复，或恢复数据库备份；
- **四条数据安全约定**：不执行带 `-v` 的卷清理、不使用 `latest` 标签、升级前必须备份且校验非空、
  不覆盖已有部署目录的 `.env`；
- **升级后有明确判据**：健康探针 200、`--version` 等于目标版本、数据可查，三项全过才算成功。

一步一步的首次部署、升级、回滚与排障，见 [私有化部署](/deployment/) 章节；
仓库内的 [`docs/deploy/AI-DEPLOY.md`](https://github.com/picoaide/picoaide-harness/blob/master/docs/deploy/AI-DEPLOY.md)
是同一套流程的 AI 执行版。
