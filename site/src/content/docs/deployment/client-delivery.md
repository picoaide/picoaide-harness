---
title: 客户端分发与升级
description: 客户端安装包随服务端镜像发布：员工从自己企业的服务器下载与自动升级，不需要访问外网。
---

PicoAide Harness 的客户端**不单独发布**：三平台安装包打进服务端镜像，由服务端自己对外提供。
员工机器不需要访问任何外网，客户端版本也因此天然跟随服务端版本 —— "客户端升了、服务端没升"在结构上不可能发生。

## 分发链路

```
官方更新服务器 release.picoaide.com/<渠道>/   ← 只有服务端镜像（管理员升级服务端用）
        │ 管理员取镜像并部署
        ▼
企业服务器（本项目部署目标）                  ← 镜像里已含三平台客户端安装包
        │ 员工打开 https://<企业域名>/ 下载 / 客户端自查更新
        ▼
员工电脑（Windows / macOS / Linux）
```

## 服务端提供了什么

| 端点 | 说明 |
|---|---|
| `GET /api/client/v2/updates/manifest` | 版本清单（公开，无需登录）：本次发布的客户端版本与各平台安装包地址、SHA-256、大小 |
| `GET /updates/client/<文件名>` | 安装包下载；支持断点续传（Range）、文件名含版本号故可长期缓存 |
| `GET /`、`GET /portal` | 门户页：企业名与欢迎语来自渠道配置，列出三平台下载入口 |

清单结构（示例）：

```json
{
  "schema": 1,
  "channel_id": "official",
  "server": { "version": "2.7.0" },
  "client": {
    "version": "2.7.0",
    "assets": {
      "win-x64":       { "url": "https://ai.example.com/updates/client/PicoAide-Harness-2.7.0-x64-Setup.exe", "sha256": "…", "size": 123456789 },
      "mac-universal": { "url": "https://ai.example.com/updates/client/PicoAide-Harness-2.7.0-mac.dmg",        "sha256": "…", "size": 123456789 },
      "linux-x64":     { "url": "https://ai.example.com/updates/client/PicoAide-Harness-2.7.0-x86_64.AppImage", "sha256": "…", "size": 123456789 }
    }
  }
}
```

安装包列表来自镜像内的 `CLIENT-RELEASE.json`，随镜像升级一起更新，因此**服务端升级后客户端包自动跟着换新**。

## 平台与安装包

| 平台 | 安装包 | 说明 |
|---|---|---|
| Windows x64 | `.exe`（NSIS 安装程序） | 未签名，SmartScreen 可能提示"未知发布者" |
| macOS（Apple 芯片 / arm64） | `.dmg` | 正式发布版签名 + 公证；预发布版仅签名 |
| Linux x64 | `.AppImage` | 授予执行权限后直接运行；企业交付面**不含 deb**（deb 只在本地构建时产出） |

> 客户端依赖 Electron、Node.js 与固定版本 DSH 运行时，安装包体积较大（每个平台约 150MB），
> 这是因为运行时已随包提供 —— 员工机器**不需要**安装 Node.js、pnpm 或 DSH。

## 下载地址是怎么定的（部署最常踩的一个坑）

服务端按以下优先级推导"客户端可达的绝对地址"：

1. `PICOAI_PUBLIC_BASE_URL`（**配了就是唯一权威**）；
2. 反向代理声明的 `X-Forwarded-Proto: https`；
3. 本请求是 TLS 直连；
4. 回环地址（本地开发，允许 http）。

以上都拿不到时，清单会**按设计拒发** `client` 段，并给出原因：

```json
{ "schema": 1, "channel_id": "official", "server": { "version": "2.7.0" },
  "client_unavailable": "server origin is not https; set PICOAI_PUBLIC_BASE_URL" }
```

为什么这样设计：客户端只接受**绝对 https** 的下载地址（非 https 的清单会被整份丢弃）。
如果服务端下发一个 http 链接，客户端会静默地"永远显示已是最新" —— 宁可明说不可用，也不给假象。

**部署后自检**（放在 `internal` 模式自签证书的内网环境尤其重要）：

```bash
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
```

- 看到 `client.assets` 且地址是 `https://…` → 正常；
- 看到 `client_unavailable` → 在 `.env` 补 `PICOAI_PUBLIC_BASE_URL=https://<域名>` 后
  `docker compose up -d server`。

## 客户端如何自动升级

- **更新源只有一处**：它登录的那台服务端。客户端不访问更新服务器、不访问 GitHub，也不需要知道自己属于哪个渠道；
- **检查时机**：启动 60 秒后首次检查，之后每 6 小时一次；托盘菜单与「设置 → 关于」提供手动检查；
- **校验**：清单 `schema` 必须为 `1`、`channel_id` 必须与服务端一致、下载地址必须绝对 https、
  安装包 SHA-256 必须与清单一致（流式校验）；任何一步不通过都不安装；
- **失败不破坏当前版本**：下载中断/校验失败时继续使用已安装版本，界面给出重试；
- **安装**：Windows 走安装程序、macOS 打开 DMG 覆盖安装；Linux AppImage 下载完成后提示由用户替换当前文件
  （AppImage 无静默自安装）。

因此**客户端升级的正确做法是升级服务端**（见[升级、备份与回滚](/deployment/upgrade/)），
员工端无需任何操作，下一次检查就会看到新版本。

## 员工怎么装、怎么登录

1. 打开 `https://<企业域名>/`（门户页）或 `https://<企业域名>/portal`，按平台下载安装包；
2. 首次启动填入**服务端地址**（即 `https://<企业域名>`），选择登录方式（local / LDAP / OIDC，由管理员配置）；
3. 账号由管理员在管理后台创建，配额与余额由服务端决定（见[管理后台](/admin/)）；
4. `internal`（内网自签）模式下，首次连接需要信任本部署的 Caddy 本地 CA；
   登录页与客户端会拒绝非 HTTPS 的远程地址（TOFU）。

单机桌面（不接服务器）的形态见[桌面客户端](/desktop/)；
企业定制渠道的品牌与渠道内容见[渠道与白标](/deployment/channels/)。
