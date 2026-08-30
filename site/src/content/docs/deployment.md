---
title: 企业私有化部署指南
description: 了解 PicoAide Harness 的企业内网部署形态：容器化服务端(PostgreSQL)、LDAP/OIDC 接入与运维。
---

本文介绍 PicoAide Harness 在企业内网中的部署形态，从环境准备到接入成员。

## 部署形态

| 形态 | 适用 | 说明 |
|---|---|---|
| **单机桌面部署** | 个人 / 小团队 | 员工安装桌面客户端，客户端自动启动本地 Harness 服务并创建默认 `desktop` profile，数据留在本机 |
| **企业内网部署** | 组织全员 | 在内网服务器运行 Go 服务端 + 管理后台（webadmin），员工用客户端或浏览器访问；账号、配额、计费、审批集中管控 |

## 环境要求

- **桌面客户端**：Windows 10+ x64 / macOS 12+（Apple 芯片）/ Linux x64（AppImage + deb）；无需 Node.js、pnpm 或 DSH；
- **服务端**：Linux x64 服务器；单二进制即可运行（`picoaide-server`，gin），也支持 Docker Compose 容器化（Caddy 反代、私有网段固定 IP、非 root uid 10001、数据 bind mount）；
- **数据库**：
  
  - **内置 PostgreSQL**：`DB_MODE=pg`，Compose 内 postgres:16-alpine 容器；
  - **外部 PostgreSQL**：`DB_MODE=pg-external` + `PG_DSN`（企业已有 PG 统一运维）；


## 部署方式

### 一键脚本

```sh
# 服务端一键部署（自动提权、按发行版装依赖、交互收集配置、复用 deploy.sh）
sh -c "$(curl -fsSL .../server/scripts/install-server.sh)"
# 非交互：给 DOMAIN / ADMIN_PASS / DB_MODE / TLS_MODE 等环境变量
./deploy.sh install|update|status|logs|backup|uninstall
```

`deploy.sh` 子命令按 `.env` 的 `DB_MODE` **自动叠加 compose override**，无需手传 `-f`：
- `install`：网段/端口预检 → DNS/CDN 校验（auto 模式）→ 证书准备 → 生成 `.env`/Caddyfile → 拉镜像启动 → 等待 `/healthz` 就绪；
- `update`：拉新镜像重建（数据目录不变，零停机升级；迁移自动按序执行）；
- `backup`：打包 `picoaide-data`（数据库 + master.key）+ auto 模式 Caddy 证书库 + pg 模式 `pg_dump`；

- `uninstall [--volumes]`：停容器（可选删除数据目录）。

### Docker Compose 架构

```
员工客户端 / 浏览器
      │ HTTPS(80/443)
      ▼
   Caddy 2（反代 + TLS 终结，固定 IP 172.28.0.2）
      │ HTTP:8080（仅 compose 私有网段）
      ▼
   Go 服务端（非 root uid 10001，expose 8080，固定 IP 172.28.0.3）
      │
      ▼
   ./picoaide-data/（master.key + 应用数据，bind mount，升级不丢）
```

- 私有网段自定义 bridge（默认 `172.28.0.0/24`，`NETWORK_SUBNET` 可改）；固定 IP 容器重建后不变；
- server 不映射宿主机端口，外部流量只能经 Caddy 进入（内网隔离 + 攻击面收敛）；
- **所有持久化数据用 `./` bind mount，不使用命名卷**：`picoaide-data/`、`caddy-data/`、`caddy-config/`、`certs/`（手动证书）、`pg-data/`（PG 模式）；备份 = 直接拷走部署目录或 `deploy.sh backup`。

### 镜像与版本

- 镜像：`ghcr.io/picoaide/picoaide-harness-server`（linux/amd64，附 SBOM + provenance 证明）；
- 标签：`latest` + `vX.Y.Z` + `vX.Y`；推送版本 tag 后 CI 自动构建发布（`--build-arg VERSION` 注入，`picoaide-server --version` 与 tag 强一致）；
- **版本线说明**：服务端镜像与桌面客户端同属一个产品线，共用同一 `v*` tag（如 `v2.4.x`，与仓库根 `package.json` 同源）；CI 在 push tag 时用 `scripts/version.mjs check` 校验镜像版本与 root `package.json` 一致，`picoaide-server --version` 与 tag 强一致；
- 内网无外网？`make release-export` 导出镜像 tar + `docker load` 离线部署；本地构建 `make docker-image`。

## 配置网关

部署完成后登录管理后台 `/admin/`，在**网关配置**页：

1. 添加**上游供应商**：渠道（如 deepseek）、base URL、API key、模型列表；
2. 设置**默认模型**与 per-user **限流**；
3. 配置**高峰时段**（北京时间多段窗口 + 每周几）与模型 `offpeak_discount`；
4. 配置**模型定价**（input/output 单价，元/M tokens；留空 = 未定价或按输入价计费）；DeepSeek 缓存命中按缓存价计费；
5. 设置**登录模式**：local / LDAP / OIDC / both（LDAP 与 OIDC 字段见[管理后台](./admin)）。

> 计费记录时定价：改价/改窗口只影响之后产生的费用；配额链（员工 token → 员工金额 → 部门预算，任一超限 429 `QUOTA_EXCEEDED`，admin 豁免）。

## 接入成员

1. 在**用户管理**创建用户（用户名 + 密码 + 角色：super_admin / auditor / user），或配置 LDAP/OIDC 后由外部身份源接入；
2. 分配部门与预算；设置用户配额（token / 金额）或跟随全局默认；
3. 员工登录客户端/浏览器后即可使用对话、能力中心、连接器、定时任务等能力；
4. 管理员在**能力中心**审批员工上传的技能/智能体并授权（用户/部门）——共享内容才可见可装。

## 安全与运维要点

- **密钥**：上游供应商密钥 **AES-GCM 加密存储**（`enc:v1:`，master key 文件，0600），永不落明文；API token 只存 SHA-256 哈希（90 天过期），改密/降权/禁用自动吊销全部令牌（同事务）；
- **管理端**：session 12h（硬上限 + 60min 空闲滑动过期）+ CSRF（HMAC 时间窗 ±1h）；登录双桶限流（10 次/5 分钟/键，不信任 X-Forwarded-For）；错误统一信封；`/healthz` 无认证探针（DB Ping，503=DB 不可用）；
- **证书**：三模式——`manual`（企业 CA/自签占位，支持 IP）、`auto`（Let's Encrypt 自动续期，仅公网域名直连，内置直连/IP 校验）、`internal`（Caddy 本地 CA，内网开箱即用）；员工客户端登录拒绝非 HTTPS 地址（TOFU）；
- **备份与恢复**：`deploy.sh backup` 一次打包 DB + **master.key**（丢失=已加密密钥不可解）+ Caddy 证书库（+ pg_dump）；恢复 = 停服解包 → `up -d`；`update` 零停机，降级不保证兼容；
- **离线部署**：`make release-export` 导出镜像 tar + `docker load`。

## 深入资料

- [系统架构](./architecture) — 服务端分层、数据流、安全设计
- [API 参考](./api-reference) — 健康探针、认证与网关端点
- [管理后台](./admin) — webadmin 操作指南
- 仓库内完整运维手册：`server/docs/DEPLOY.md`（compose 私有网段、deploy.sh 生命周期、镜像发布）与 `server/docs/02-build-deploy.md`（构建、systemd、CI）
