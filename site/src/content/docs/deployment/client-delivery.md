---
title: 客户端分发与升级
description: 客户端安装包随服务端镜像发布：员工从自己企业的服务器下载与自动升级，服务器与员工机器都不需要外网。
---

PicoAide Harness 的客户端**不单独发布**：三平台安装包打进服务端镜像，由服务端自己对外提供。
员工机器不需要访问任何外网，客户端版本也因此天然跟随服务端版本 —— "客户端升了、服务端没升"
在结构上不可能发生。

## 这一页解决什么问题

让员工拿到客户端、让它一直跟着服务端升级，并且在异常时能判断"是分发坏了还是客户端坏了"。
本页覆盖：分发链路 → 服务端提供的端点 → 清单结构与下载地址的判定 → 员工安装与登录 →
自动升级的时机与校验 → 判据与失败行为。

**前提**：

| 前提 | 说明 |
|---|---|
| 服务端已部署且 `/healthz` 返回 200 | 见[容器化部署](/deployment/compose/) |
| 服务端能给客户端一个**绝对 https** 的下载地址 | 反代场景要配 `PICOAI_PUBLIC_BASE_URL`，否则清单按设计拒发 `client` 段 |
| 员工机器能访问企业域名 | 只需要这一个地址，不需要任何公网 |
| 员工客户端与服务端**同版本** | 应用（WASM）只在客户端内打开且要求两端同版本 |

> **"服务端升了、客户端没升"是可能的，而它会让应用打不开**：应用只在桌面客户端内打开，
> 浏览器访问链路已删除，旧客户端无法打开应用。客户端从这台服务器取包，请确认员工接受升级提示、
> 不要长期停留在旧版本。

## 设计取舍

**为什么客户端随镜像发，而不是单独发。** 客户端与服务端之间有版本契约（网关协议、应用访问模型、
清单结构）。把两者放在同一份交付物里，"客户端版本跟随服务端版本"就是结构事实而不是纪律要求；
顺带解决两件事：员工机器**零外网依赖**（只需要企业域名），以及渠道一致性
（服务端属于哪个渠道，它的客户端就是哪个渠道，不存在"客户端渠道与服务端渠道不一致"的状态）。

**为什么下载地址必须是绝对 https，宁可不给。** 客户端在拿到清单时无法区分"http 链接"与
"被中间人改过的链接"，而安装包一旦装错就是一台机器上的持久后门。所以服务端推不出安全地址时
**拒发** `client` 段并给出原因（`client_unavailable`），而不是下发一个会被客户端整份丢弃的
http 链接。为什么后者更糟：客户端丢弃非 https 清单后界面会显示"已是最新" —— 静默、无人报障、
也没有任何线索指向配置。

**为什么更新源只有一个，检查是静默的。** 客户端只问"我登录的那台服务端"：不访问更新服务器、
不访问 GitHub、也不需要知道自己属于哪个渠道。检查与下载都是后台静默的（有界退避重试、
断点续传），**安装一律由用户显式触发** —— 产品不做"静默重启安装"：客户端承载着本地会话与
未保存的工作，静默重启的代价远大于晚几分钟升级。

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

| 端点 | 认证 | 说明 |
|---|---|---|
| `GET /api/client/v2/updates/manifest` | 公开（无需登录） | 版本清单：客户端版本与各平台安装包地址、SHA-256、大小 |
| `GET /updates/client/<文件名>`（含 `HEAD`） | 公开 | 安装包下载；支持断点续传（Range/206）、文件名含版本号故可长期缓存 |
| `GET /`、`GET /portal` | 公开 | 门户页：企业名与欢迎语来自渠道配置，列出三平台下载入口 |

两个面都是公开的：员工**首次安装时还没有登录态**，所以清单与安装包必须在登录前就能取。
也正因如此，安装包目录里的文件被严格限制（见[判据](#判据)）。

清单结构（示例，地址是服务端按请求来源拼出来的）：

```json
{
  "schema": 1,
  "channel_id": "official",
  "server": { "version": "<版本>" },
  "client": {
    "version": "<版本>",
    "assets": {
      "win-x64":       { "url": "https://harness.example.com/updates/client/PicoAide-Harness-<版本>-x64-Setup.exe", "sha256": "…", "size": 123456789 },
      "mac-universal": { "url": "https://harness.example.com/updates/client/PicoAide-Harness-<版本>-mac.dmg",        "sha256": "…", "size": 123456789 },
      "linux-x64":     { "url": "https://harness.example.com/updates/client/PicoAide-Harness-<版本>-x86_64.AppImage", "sha256": "…", "size": 123456789 }
    }
  }
}
```

安装包列表来自镜像内的 `CLIENT-RELEASE.json`，随镜像升级一起更新，因此**服务端升级后客户端包
自动跟着换新**，不需要额外上传或发布。

## 平台与安装包

| 平台 | 安装包 | 说明 |
|---|---|---|
| Windows x64 | `.exe`（NSIS 安装程序） | 未签名，SmartScreen 可能提示"未知发布者" |
| macOS（Apple 芯片） | `.dmg` | 正式版签名 + 公证（`Contents/CodeResources` 内有公证票据）；预发布版仅签名 |
| Linux x64 | `.AppImage` | 授予执行权限后直接运行；企业交付面**不含 deb** |

> 安装包体积较大（随包提供 Electron 运行时、固定版本的上游 DSH 运行时，以及应用可用的
> Node.js / pnpm / CPython）：员工机器**不需要**安装 Node.js、pnpm 或 DSH，
> 这些都在包内、且只影响客户端自己派生的子进程。

## 下载地址是怎么定的（部署最常踩的一个坑）

服务端按以下优先级推导"客户端可达的绝对地址"：

1. `PICOAI_PUBLIC_BASE_URL`（**配了就是唯一权威**）；
2. 管理后台配置的对外地址（`settings: server.base_url`，取值非法时不生效并打印一条告警）；
3. 反向代理声明的 `X-Forwarded-Proto: https`；
4. 本请求是 TLS 直连；
5. 回环地址（本地开发，允许 http）。

以上都拿不到，或配置的地址不是一个**不带凭据、不带 query/fragment** 的绝对 http(s) 地址时，
清单**按设计拒发** `client` 段并给出原因：

```json
{ "schema": 1, "channel_id": "official", "server": { "version": "<版本>" },
  "client_unavailable": "server origin is not https; set PICOAI_PUBLIC_BASE_URL" }
```

**部署后自检**（`internal` 自签证书的内网环境尤其重要）：

```bash
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest"
```

- 看到 `client.assets` 且地址是 `https://…` → 正常；
- 看到 `client_unavailable` → 在 `.env` 补 `PICOAI_PUBLIC_BASE_URL=https://<域名>` 后
  `docker compose up -d server`。

## 客户端如何自动升级

- **更新源只有一处**：它登录的那台服务端；未连接服务端时**不做任何外发检查**；
- **检查时机**：启动 **60 秒**后首次检查，之后每 **6 小时一次**；托盘菜单与「设置 → 关于」可手动检查；
- **校验**：清单 `schema` 必须为 `1`、`channel_id` 必须与服务端一致、下载地址必须绝对 https、
  安装包 SHA-256 必须与清单一致（流式校验，并校验文件魔数）；任一步不通过都不安装；
- **失败不破坏当前版本**：下载中断/校验失败时继续使用已安装版本，界面给出重试；已下载的部分可复用（断点续传）；
- **安装由用户触发**：Windows 走安装程序、macOS 打开 DMG 覆盖安装、Linux 下载完成后提示由用户
  替换当前文件（AppImage 无静默自安装）。

因此**客户端升级的正确做法是升级服务端**（见[升级、备份与回滚](/deployment/upgrade/)），
员工端无需任何操作，下一次检查就会看到新版本。

## 员工怎么装、怎么登录

1. 打开 `https://<企业域名>/`（门户页）或 `https://<企业域名>/portal`，按平台下载安装包；
2. 首次启动填入**服务端地址**（即 `https://<企业域名>`），选择登录方式（本地 / LDAP / OIDC，
   由管理员配置）；渠道包内置了服务端地址时，这一步会被预填并跳过；
3. 账号由管理员在管理后台创建，余额与模型由服务端决定（见[管理后台](/admin/)）；
4. `internal`（内网自签）模式下，首次连接需要信任本部署的 Caddy 本地 CA；
   登录页与客户端拒绝非 HTTPS 的远程地址。

> **客户端默认不使用系统代理**（系统代理、代理环境变量、PAC 与启动参数一律忽略）。
> 只有"必须经代理才能出公网"的部署才需要打开退路：渠道字段 `desktop.allow_system_proxy`，
> 或**真实进程环境变量** `PICOAI_ALLOW_SYSTEM_PROXY=1`（写在 `.env` 分层里不生效）。
> 打开后启动日志会打印 `proxy system/<来源>`；默认直连时打印 `proxy direct`。

单机桌面（不接服务器）的形态见[桌面客户端](/desktop/)；企业定制渠道的品牌与渠道内容见[渠道与白标](/deployment/channels/)。

## 判据

| # | 判据 | 怎么判 |
|---|---|---|
| 1 | 清单可取且结构正确 | `schema` 为 `1`、`channel_id` 与 `/opt/picoaide/CHANNEL` 一致、`server.version` 是当前运行版本 |
| 2 | 下载地址安全 | `client.assets.*.url` 是**绝对 https**；出现 `client_unavailable` 即判失败并按其原因处置 |
| 3 | 安装包可下载且完整 | `curl -o` 拉下来后比对清单里的 `sha256` 与 `size` |
| 4 | 断点续传可用 | 带 `Range: bytes=0-99` 的请求返回 **206** 且长度 100 |
| 5 | 下载面只暴露安装包 | 请求 `.json` 等非白名单扩展名返回 404 JSON 信封；响应头带 `X-Content-Type-Options: nosniff` 与 `Content-Disposition: attachment` |
| 6 | 客户端包随镜像更新 | 升级服务端后清单里的 `client.version` 随之变化（见[升级、备份与回滚](/deployment/upgrade/)） |

判据 3/4 的可复制命令：

```bash
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
MANIFEST=$(curl -sk --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/client/v2/updates/manifest")
FILE=$(printf '%s' "$MANIFEST" | sed -n 's/.*"url": "https:\/\/[^"]*\/updates\/client\/\([^"]*\)".*/\1/p' | head -1)
curl -sk --resolve "$DOMAIN:443:127.0.0.1" -o /tmp/client.pkg "https://$DOMAIN/updates/client/$FILE"
sha256sum /tmp/client.pkg
curl -sk -o /dev/null -w '%{http_code}\n' -H 'Range: bytes=0-99' \
  --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/updates/client/$FILE"     # 期望 206
```

**下载面的两条隐含判据**（改代码时不要放宽）：

- **只有白名单扩展名可下发**（`.dmg` / `.exe` / `.appimage` / `.deb` / `.zip` / `.tar.gz` / `.msi` / `.pkg`），
  且必须是资产目录内的**普通文件**（符号链接、目录、设备文件一律 404）—— 这条路由未认证，
  目录由 CI 产物与 `docker cp` 注入，属不可信输入；
- **写截止时间按文件大小推导**（保底速率 64 KiB/s，下限 5 分钟、上限 1 小时）。
  为什么不是全局的 5 分钟：安装包以百 MB 计，慢链路（< 525 KB/s）会在全局超时处被切断，
  员工无法自助绕过。

## 边界与失败行为

| 现象 | 判据 | 恢复动作 |
|---|---|---|
| 员工端"检查更新永远说已是最新" | 清单里有 `client_unavailable` | 配 `PICOAI_PUBLIC_BASE_URL=https://<域名>` 后 `docker compose up -d server`；反代场景必配 |
| 门户页没有下载入口 | 清单没有 `client` 段且**没有** `client_unavailable` | 说明镜像里没带客户端资产（`CLIENT-RELEASE.json` 读不到）：确认用的是正式发布包，而不是本地自建镜像。另一种成因是管理端设置 `portal.public=false`（门户不对外开放，根路径会跳转到管理后台登录页）—— 清掉该设置即可 |
| 下载到一半断流 | 客户端提示可重试 | 属预期：文件大、链路慢；客户端支持 Range 续传，重试会接着下。服务端侧单次响应的写截止 = max(5 分钟, 体积/64 KiB/s)，上限 1 小时 |
| 下载 404 | 响应是 JSON 信封 `NOT_FOUND` | 文件名不在资产清单里，或扩展名不在白名单内；以清单里的 `file` 为准，不要手拼文件名 |
| 安装包校验失败 | 客户端界面提示校验不通过 | 传输损坏或缓存了半份文件：重新下载；服务端侧用第 3 条判据确认清单里的 sha256 与实际下发的字节一致 |
| 员工装的是旧版本、应用打不开 | 客户端版本 < 服务端版本 | 应用只在客户端内打开且要求同版本：提示员工升级客户端；旧客户端打不开是预期行为 |
| 客户端连不上服务器（只有经代理才能出公网） | 客户端日志里 `proxy direct` | 打开退路：渠道字段 `desktop.allow_system_proxy: true`，或真实进程环境 `PICOAI_ALLOW_SYSTEM_PROXY=1`，然后重启客户端 |
| macOS 提示"未能验证开发者" | 包内没有公证票据 | 只有**正式发布**的渠道包经过公证；预发布包仅签名。让员工使用正式版本，或按渠道流程重出正式 tag 的包 |
| 员工机器上重复安装了两个客户端 | 两个不同的应用标识 | 不同渠道的客户端是**独立应用**（应用 ID、数据根、单实例锁都按渠道区分）；同渠道重装是覆盖，跨渠道是并存（见[渠道与白标](/deployment/channels/)） |

## 相关

- [部署总览](/deployment/) —— 交付物与容器架构
- [容器化部署](/deployment/compose/) —— 首次部署与门户自检
- [升级、备份与回滚](/deployment/upgrade/) —— 服务端升级即客户端升级
- [渠道与白标](/deployment/channels/) —— 品牌内容与客户端数据隔离
- [离线部署](/deployment/offline/) —— 员工侧零外网依赖的边界
- [桌面客户端](/desktop/) —— 客户端能力与单机形态
