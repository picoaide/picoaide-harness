# 企业渠道定制打包参数化规划（2026-09-04）

> 状态：规划提案（未实施）。目标读者：产品/工程/商务。
> 原则：**代码一份，配置多份**。不 fork 代码库；渠道差异全部收敛为"渠道配置包"；构建/签名/发布管线一套，参数化输入。

---

## 0. 目标与范围

### 目标
一条参数化构建/发布管线：输入 = `channels/<channel-id>/` 渠道配置包（企业 logo、名称、默认配置、签名/分发方式），输出 = 该企业定制安装包（macOS universal DMG / Windows NSIS / Linux AppImage+deb），复用现有 GitHub Actions 与 macOS 签名/公证链路。

### 明确两层品牌（避免重复建设）

> **Phase 0 已产出**：品牌点全量盘点清单（含每项位置/现值/渠道化判定）见 `docs/planning/2026-09-04-channel-brand-inventory.md`——🟥必改 ≈16 处、🟨可选 ≈10 处、🟩保留 ≈15 处。

| 层 | 解决什么 | 现状 | 本规划 |
|---|---|---|---|
| **运行时品牌** | 登录页/客户端界面内的 logo、欢迎语、标题、favicon | **已存在**：服务端 `server/internal/brand`（`/api/client/v2/brand` + `/api/server/admin/brand`，settings KV + dataDir/brand 文件，login/client/favicon 三类 logo，SVG sanitize）；客户端 `packages/host/enterprise` 的 `brand-sync.ts` + `packages/client/branding`（BRAND_CSS）；门户 `portal`（欢迎语/下载地址） | 不动 |
| **编译期品牌** | 安装包层面的：app 图标（Dock/任务栏/安装器）、应用名/可执行名/安装器名、bundle id、版权与公司名、**企业默认配置**（默认服务器地址等）、**更新源**、签名主体 | **硬编码**（清单见 §1） | 本规划主体 |

**边界**：企业只买服务端品牌配置（路线 A）走现有能力、零构建；企业要求"安装出来就是自家产品"（路线 B）才需要本管线。商务上两条路线分开定价，避免为配置化而配置化。

### 边界约束
- `deepseek-harness/` 子模块不动；渠道化基础设施落在 `packages/host/desktop/`（desktop-owned branding 允许）+ 仓库根 `channels/` + `.github/workflows/`。
- 品牌注入尽量走 profile composition config（仓库既有约定）。
- 官方版本 = 内置渠道 `official`，缺省行为与今天完全一致（向后兼容）。

---

## 1. 可定制面清单与现有硬编码点（盘点结果）

### A. 图标资产（编译期）
| 项 | 现状位置 | 渠道化后 |
|---|---|---|
| win/linux app 图标 | `packages/host/desktop/build/app-icon.png`（1024²，直用） | 由渠道 logo 派生 |
| mac Dock 图标 | `build/app-icon-mac.png`（`generate-mac-app-icon.mjs` 从 app-icon.png 缩 1024→824 居中加透明边距，适配系统圆角遮罩；要求源 RGBA16 + ICC） | 同一脚本参数化输入源 |
| tray 图标系列 | `build/tray-icon*.png`（`generate-tray-icons.mjs` 派生，含蓝色变体） | 同上 |
| electron-builder 用 icon | `package.json` `build.mac.icon` / `build.win.icon` / `build.linux.icon`（icns/ico 由 builder 从 PNG 自动转换） | 指向派生输出目录 |

### B. 名称与元数据（编译期）
| 项 | 现状位置 |
|---|---|
| `appId`（bundle id） | `package.json` build.appId = `ai.deepseek.dsh.desktop` |
| `productName`（显示名/dock 名/关于页） | build.productName = `PicoAide Harness` |
| 产物文件名模板（×3 平台） | build.mac/win/nsis/linux `artifactName` = `PicoAide-Harness-${version}-…` |
| windows 快捷方式名 | `nsis.shortcutName` = `PicoAide Harness` |
| linux 维护者/简介 | `build.linux.maintainer`=picoaide、`synopsis` |
| 深链 scheme | build.protocols schemes = `picoaide`（企业定制后与官方 app 互抢 scheme，需渠道化或关闭） |
| 版权/公司 | 由 package.json author/copyright 生成（目前未显式设置，需确认） |

### C. 运行时文案与默认配置（编译期注入）
| 项 | 现状位置 |
|---|---|
| 更新源仓库常量 | `src/update-checker.ts`、`src/update-download.ts` 的 `DESKTOP_RELEASE_REPOSITORY = 'picoaide/picoaide-harness'` |
| 资产名匹配模板 | `update-download.ts` 硬编码 `PicoAide-Harness-<v>-mac.dmg` / `-x64-Setup.exe` / `-x86_64.AppImage` |
| 默认品牌文案（服务端未配品牌时） | `packages/host/enterprise/src/brand-sync.ts` `DEFAULT_BRAND`（display_name/tagline/title） |
| 登录页标题/样式 | `packages/host/enterprise/src/auth-gate.ts` `LOGIN_HTML`（title `PicoAide 登录`、配色） |
| 默认服务器地址 | 登录页让用户输入（无渠道预填）——企业版应预填企业网关地址 |
| 功能开关/插件启停、遥测渠道 id | 无现成渠道概念，新增 |

### D. 签名与分发（编译期+发布期）
| 项 | 现状位置 |
|---|---|
| mac 签名/公证 | `scripts/release-preflight.ts` 常量清单：`APPLE_API_ISSUER/KEY/KEY_ID`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`MAC_CERT_P12_BASE64`、`CSC_*` 等；`release-mac.ts` 走 Developer ID + notarize |
| mac universal 运行时准备 | `scripts/mac-universal.ts`（与品牌无关，不动） |
| 发布目标 | `ci.yml` release job → `gh release create` 到 `picoaide/picoaide-harness`，产物 `SHA256SUMS.txt` |

**结论**：技术栈（electron-builder 配置结构、universal 打包、签名/公证、verify 脚本）全部已有；真正要做的 = ①把上述硬编码点收敛为单一配置源 ②加"渠道配置包"与素材派生 ③CI 按渠道矩阵化 ④更新源与默认配置运行时可注入。

---

## 2. 核心设计：渠道配置包

### 2.1 目录结构（**独立品牌私有仓**，2026-09-05 定案）
> 渠道配置不在主仓（主仓公开，无私有分支可言，见 §6 风险 2）；存放于同账号私有仓（如 `picoaide/brands`）。主仓仅保留官方 `brands/official/` 与本地开发回落骨架。
```
# 品牌私有仓 <picoaide/brands>（纯数据仓：配置+素材，无代码/脚本/证书）
channels/
  index.json                 # 渠道注册表：id/display_name/slug/app_id 全局唯一
  acme/                      # 企业渠道（示例）
    channel.json             # 单渠道唯一事实源（schema v1）
    assets/
      logo.svg               # 企业 logo 权威源（矢量优先），其余图标全部派生
    NOTES.md                 # 授权声明/素材交接记录（法务留痕）
```

### 2.2 channel.json 字段分组（schema v1 概要）
```jsonc
{
  "schema": 1,
  "channel_id": "acme",                    // 唯一；遥测/许可/客服归因用
  "product": {
    "display_name": "Acme AI 助手",         // 用户可见名（可中文）
    "slug": "acme-ai",                     // ASCII，用于文件名/可执行名/快捷方式
    "app_id": "com.acme.ai",               // bundle id / electron-builder appId
    "company": "Acme Inc.",
    "copyright": "© 2026 Acme Inc.",
    "deep_link_scheme": "acmeai"           // 可选；不填=官方 scheme 冲突下关闭？
  },
  "assets": {
    "logo": "assets/logo.svg",             // 权威源，≥1024、方形、有安全边距
    "accent_color": "#2563eb"              // 可选，驱动品牌色派生
  },
  "defaults": {                            // 编译期注入的默认配置（profile 层）
    "server_url": "https://ai.acme.example.com",   // 登录页预填
    "brand": { "display_name": "Acme AI 助手", "tagline": "…" },  // 服务端未配品牌时的缺省
    "features": {},                        // 插件启停/功能开关（profile composition）
    "telemetry_channel": "acme"
  },
  "updates": {
    "mode": "manifest",                    // manifest（推荐）| github | none
    "base_url": "https://update.acme.example.com/app/"
  },
  "signing": { "mode": "vendor" },         // vendor（厂商统一签）| customer（企业自签）
  "release": { "target": "static", "base_url": "…", "private": true }
}
```

> 注：`updates.mode=manifest` 是本规划的关键设计——把更新源从"GitHub API 专用"泛化为"任意静态服务器 + `latest.json`（版本、下载地址、sha256）"。企业随便用 Nginx/OSS 即可做更新服务器；官方渠道继续 `github` 模式，向后兼容。

### 2.3 派生规则（与官方 logo 单一权威规则同构）
企业渠道内 `brands/<channel-id>/logo.svg` 是该渠道的**唯一 logo 权威源**（对应官方 `brands/official/logo.svg` 的地位，见 `brands/official/README.md`）；所有图标/托盘/位图一律派生自它，禁止手绘/文字字符/第三方标识。官方渠道派生链（`brand-prepare.mjs` → `generate-*.mjs` + logo.svg）保持不动。

### 2.4 更新源托管方案（2026-09-04 补充）

`updates.mode=manifest` 协议只认一个东西：`base_url/latest.json`（版本、下载 URL、sha256）。所以**托管方案 = 换一个 base_url**，客户端代码零改动。按渠道场景选：

| 方案 | 流量成本 | 国内可达 | 运维 | 适用场景 |
|---|---|---|---|---|
| **企业自部署服务端升级端点**（默认首选） | 企业自有带宽 | ✅ 内网/国内 | 服务端新增 `GET /api/client/v2/updates/manifest`（静态文件面，webadmin 品牌页托版本），零外部依赖 | 部署了我们服务端的企业（主流） |
| **Cloudflare R2 + 自定义域名** | egress=0，仅存储($0.015/GB/月)+请求费 | ❌ 差：默认路由境外节点，大陆节点仅企业版+ICP 备案域名 | 低（S3 兼容 API 上传） | 我方托管、海外/跨国渠道 |
| 阿里云 OSS / 腾讯云 COS + CDN | 低（非零，国内最便宜档） | ✅ | 低 | 我方托管、国内企业渠道 |
| GitHub Releases per-channel | 免费无限 | ❌ 差 | 每渠道一 repo | 不推荐给国内企业 |
| 企业内网 MinIO / Nginx 静态目录 | 内部网络 | ✅ | 企业自担 | 信创/内网隔离要求 |

**R2 使用要点**（若采用）：①生产必须绑**自定义域名**（R2 自定义域要求该域在 Cloudflare DNS 下；裸 `*.r2.dev` 开发域名有限速、无 CDN 行为，仅限测试）；②`latest.json` 响应头 no-store，安装包按 `<slug>-<version>-<platform>` 长缓存（文件名含版本即天然缓存键）；③下载走 CF 网络出站免费，且自带全球 CDN；④可选 Cloudflare Access/presigned URL 做私有渠道。

**2026-09-04 补充：国内的流量与链路结论**：
- **国内无 R2 级"无限免费流量"等价物**——对象存储/CDN 免费额度均为 10GB 级（腾讯云 COS 50GB 存储+10GB 流量活动、阿里云 OSS 更低、免费 CDN 每月 10~15GB），约等于 50 次 200MB 下载，企业更新场景不可用；国内 CDN 实际单价约 ¥0.1~0.2/GB（200MB×月 1 万次 = 2TB ≈ ¥200~400/月，可接受但非零）。
- **R2 国内链路质量差（实测一致）**：免费/Pro 计划默认路由境外节点（东京/香港/洛杉矶），大文件下载中断频繁；大陆节点仅企业版+备案域名开放；社区"自选优选 IP"属玄学方案且可能违反 CF 条款，禁止用于企业升级链路。→ **国内企业渠道排除 R2**。
- **国内"流量免费"的真正答案：下载不走公网**——企业自部署服务端端点（客户端内网/企业网关拉包，走企业带宽，对我方 0 成本、对内网是本地速度）；轻量渠道用国内 OSS+CDN；远期做**差分更新**（全量 200MB → 增量几十 MB），任何托管方案成本降一个数量级（列为 Phase 3 评估项）。

**推荐默认**：企业部署服务端 → 更新源默认指向"登录的服务器 `/updates`"（客户端零配置，国内外通吃）；我方托管 → R2（仅海外/跨国渠道）；国内企业且要求厂商托管 → 阿里云 OSS / 腾讯云 COS + CDN。manifest 化的直接收益：换方案 = 换 URL，不动代码、不动渠道配置结构。

---

## 3. 构建管线（build-time 五阶段）

```
[validate-channel] → [brand-prepare] → [平台打包 ×3] → [verify-branded] → [publish]
```

1. **validate-channel**（fail-loud）：channel.json schema 校验；注册表唯一性（id/display_name/slug/app_id 冲突）；素材规格（SVG 无害化无 script/外链；PNG ≥1024、方形、RGBA、ICC、大小上限）；名称合规（禁止"官方/旗舰"等误导词，与官方名近似度校验）。
2. **brand-prepare**：读 channel.json → 输出构建产物到 `packages/host/desktop/dist/branding/<channel>/`：
   - 派生图标（app-icon.png / mac 安全区版 / tray 系列）——现有 `generate-mac-app-icon.mjs`、`generate-tray-icons.mjs` 改为接受"输入源 + 输出目录"参数
   - 生成 electron-builder 覆盖配置 `builder.<channel>.json`（productName/appId/artifactName/icon/nsis.shortcutName/linux.*/mac 说明）——打包脚本以 `--config` 传入（实施时验证 --config 与 package.json build 的合并语义）
   - 生成运行时配置 `channel.build.json`（打进 app resources：defaults/updates/signing-info/build-info）
   - 生成 `build-info.json`：channel_id、base commit、套餐版本、构建时间、证书指纹摘要（审计/客服/合规用；不含任何机密）
3. **平台打包**：复用 `package-mac.ts`（sign+notarize）、`package-win.ts`、`package-linux.mjs`，输入改读渠道配置；mac universal 运行时准备（`mac-universal.ts`）与品牌无关、原样复用。
4. **verify-branded**：扩展现有 `verify-*` 脚本族（已先例：`verify-mac-smoke.ts` 读 package.json productName 而非硬编码）：断言 productName/appId/图标已替换、内嵌 channel 配置完整、更新源 URL 与渠道一致、`codesign --verify` + notary stapling 通过、资产名模板命中。
5. **publish**：按 `release.target` 分发（企业私有 repo / 静态服务器 / 仅 artifact 交付包）；产出 `SHA256SUMS.txt`（沿用裸文件名规范，防 checksum-missing 老坑）；渠道交付包 = 三平台安装器 + 哈希 + 版本说明 + 部署/更新指南 + 签名信息。

---

## 4. 运行时读取（三类配置的优先级）

```
渠道打包配置（内嵌 channel.build.json，最高） → 服务端下发（brand API / bootstrap / 企业服务器）→ 用户设置（本地）
```

- **更新源**：客户端升级逻辑读内嵌配置——`manifest` 模式请求 `base_url/latest.json`（版本+URL+sha256，沿用现有 SHA256SUMS 校验语义）；`github` 模式=现状；`none`=关闭自动更新。资产名模板随 `product.slug` 生成。
- **默认品牌文案**：`brand-sync.ts` 的 `DEFAULT_BRAND` 改为读渠道配置（企业版在"服务端未配品牌"时也显示企业品牌）。
- **默认服务器地址**：登录页预填 `defaults.server_url`（沿用现有 `assertServerURLAllowed` 环回/HTTPS 校验）。
- **功能开关/插件启停**：走 profile composition（仓库既有注入面），不动上游插件。
- **遥测渠道 id**：现有 telemetry 上报伴生字段，支持渠道维度的用量/支持归因（服务端是否有消费面另行评估）。

---

## 5. CI 与多企业组织（mac 编译是成本核心）

### 5.1 三种共存模式
| 模式 | 适用 | 特点 |
|---|---|---|
| **单仓 + workflow_dispatch + matrix** | 起步/内部演示渠道 | 最快；secrets 只有一套（厂商证书），不可多企业隔离 |
| **渠道 = GitHub Environment**（推荐主流） | 多企业并存 | 每个渠道一个 environment，独立 secrets（签名证书/发布 token/更新服务器凭证）；job 用 `environment: <channel>`，secrets 按环境隔离 |
| **企业私仓**（fork 或仅配置仓） | 企业自签/高合规 | 完全隔离：企业自己的证书、自己的发布；上游版本发布时经 `repository_dispatch` 触发企业仓 rebuild |

### 5.2 mac 编译计划
- 现状：`ci.yml` `desktop-macos` job 跑 GitHub 托管 `macos-latest`（arm64，经 `mac-universal.ts` 准备双架构运行时）→ 渠道化后**每渠道一平台一 job**，受 Actions 并发上限约束。
- 成本：GitHub macos runner 按 10 倍分钟计费、高峰排队可达数小时——**多渠道商业交付建议自托管 mac runner**（Mac mini/MacStadium，自托管可并发、免排队），作为 Phase 3 项；缓存策略（node_modules、electron 缓存）避免每渠道全量安装。
- 触发流：①官方 tag 发布 → 可选"重建全部活跃渠道"矩阵（一次性为主渠道升版）；②`workflow_dispatch` 对指定渠道+版本+平台（企业换 logo/升包）；③渠道冻结后仅安全更新按渠道重建。

### 5.3 构建记录与审计
每次渠道构建落一条记录（channel、版本、base commit、触发人、凭证指纹、产物哈希）→ 渠道构建日志（可先文档/manifest 形式，远期服务端管理面）。

---

## 6. 风险与坑（提前点名）

1. **更新源污染（P0）**：企业版内嵌官方更新源 → 升级即被"洗"成官方版。`updates.mode` 必须由渠道配置强驱动，verify-branded 断言更新源 = 渠道配置值。
2. **企业素材进公开仓库**（2026-09-05 定案）：主仓 `picoaide/picoaide-harness` 为公开仓库（`private: false`），GitHub 公开仓**不存在私有分支/私有 PR**——渠道素材进主仓=必然公开 → 渠道目录放**同账号独立品牌私有仓**（单仓多渠道），CI 构建时检出到 `temp/` 引用（pin ref）；大文件用 git-lfs 或构建时从 secrets/artifact 注入。
3. **多企业 secrets 集中单仓**：任何有 repo 写权限的人可在 CI 中读取 environment secrets → 企业自签模式（含企业证书 p12）强烈建议走企业私仓；厂商统一签名则无此顾虑。
4. **mac 证书生命周期**：Developer ID/公证凭证会过期 → 渠道构建失败；需要证书有效期登记与轮换提醒（构建记录含指纹）。
5. **图标规范不合格**（512px、JPG、非方形、无安全边距）：validate-channel fail-loud，素材清单文档化（Phase 3 输出《企业素材清单模板》）。
6. **版本号冲突**：渠道版本与官方版本同号混乱 → 渠道构建版本 = 套餐版本 + 渠道后缀（如 `2.5.9+acme.20240904`），更新源按渠道隔离后无跨渠道比较。
7. **electron-builder 配置合并语义**：`--config` 与 package.json `build` 的深合并行为需实施时验证（若覆盖不干净，改为生成完整 build 段）。
8. **中文名与 ASCII**：显示名可中文，`slug` 必须 ASCII（文件名/可执行名/安装器名/域名路径），两字段分离防中文文件名坑。
9. **深链 scheme 冲突**：多款产品共用 `picoaide://` 会互抢；企业渠道默认关闭或强制渠道私有 scheme。

---

## 7. 分阶段实施路线

| 阶段 | 内容 | 产出 | 参考周期 |
|---|---|---|---|
| **Phase 0 收敛** | 盘点品牌点（§1 清单落地）；把官方品牌收敛到 `packages/host/desktop/brand/official.json`（第一份配置）；文案去硬编码 | 官方=渠道 0 模型 | ~1 周 |
| **Phase 1 内测 MVP** | channel.json schema + validate-channel + brand-prepare（图标派生参数化 + builder 覆盖配置）+ 三平台打包 + verify-branded + workflow_dispatch（厂商证书签名） | 一个内测渠道全链路跑通 | 2–3 周 |
| **Phase 2 多渠道生产** | channels/index.json 注册表 + GitHub Environments 按渠道隔离 secrets + 更新源 `manifest` 模式改造（update-checker/update-download 泛化）+ 渠道发布面 | 可同时服务 ≥3 个企业渠道 | ~2 周 |
| **Phase 3 企业进阶** | 企业自签模式 + 自托管 mac runner + 版本冻结/安全更新 rebuild 流水线 + 交付包自动化（文档/哈希/签名信息）+ 企业素材清单模板 | 商务大规模交付 | 视商务 |
| **Phase 4 远期** | 服务端渠道管理 API（webadmin 品牌页一键发起构建）、许可绑定 channel_id、构建记录管理面 | 自助化 | 待评估 |

---

## 8. 商务配套（建议）

- **定价**：①渠道定制一次性搭建费（渠道 profile + 素材校验 + 首次试构建）；②按构建/版本计费（以 mac 构建分钟为成本锚）；③企业自签/更新服务器托管为增值项；④路线 A（纯运行时品牌）另售、更低价。
- **交付物**：三平台安装器 + SHA256SUMS + 版本说明 + 部署/更新指南 + 签名信息说明。
- **素材收集**：《企业素材清单模板》（logo 源/主色/显示名/版权主体/默认服务器地址/分发方式/签名模式/授权声明）——签合同前收集，校验通过再进管线。
- **识别**：渠道 id 贯穿安装包/遥测/客服归因；支持"这个客户装的哪个渠道哪个版本"快速定位。

---

## 9. 待拍板决策点

1. 更新源默认形态：**推荐 `manifest` + 默认指向企业自部署服务端（/updates 端点）**；我方托管用 Cloudflare R2（egress 免费，自定义域名），国内渠道托管用阿里云 OSS/腾讯云 COS；官方渠道继续 GitHub Releases（详见 §2.4）。
2. 签名默认：厂商统一签名（推荐起步）还是首单即支持企业自签？
3. 渠道素材放主仓私有分支（我方维护）还是企业私仓（客户隔离）？——大客户合规导向后者。
4. 官方发布是否迁移进渠道管线（单一管线）还是保持双轨并行（官方 tag 流不动，渠道流新增）？推荐双轨并行、渐进归一。
