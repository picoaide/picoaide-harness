# 渠道包（channel package）字段参考

> 2026-09-10 定案后落地。**这是 `picoaide/channels` 私有仓里
> `channels/<channel-id>/channel.json` 的权威字段表** —— 写渠道配置时以本文 +
> 代码为准；`docs/planning/2026-09-04-enterprise-channel-branding.md` 是早期
> 设计草图（字段分组不同，勿照抄）。
>
> 代码真源：
> - 服务端读取：`server/internal/channel/channel.go`
> - 客户端读取：`packages/host/desktop/src/desktop-channel.ts`
> - CI 注入：`.github/workflows/ci.yml` 的 `release` job

## 1. 渠道包是什么、放到哪

```
picoaide/channels  (私有仓)
  channels/
    official/           # 官方渠道(= 默认品牌)
      channel.json
      logo.svg          # 可选,由 brands/official/logo.svg 派生
      logo-dark.svg
      favicon.*
    beta/               # 预发渠道:独立渠道,复用官方品牌内容
      channel.json
    acme/               # 品牌渠道
      channel.json
      logo.svg
```

- **每个渠道一个目录，目录名 = 渠道 id**。id 形状 `^[a-z0-9][a-z0-9-]{0,31}$`
  （客户端 `CHANNEL_ID_PATTERN` / 服务端 `IsChannelID` / CI grep 三处同源），
  且 `channel.json` 的 `channel_id` 必须与目录名一致（CI 强校验，不一致即中止）。
- 渠道 id 决定三处落点，必须自洽：R2 目录 `release.picoaide.com/<id>/`、
  镜像内 `/opt/picoaide/channel/`、客户端 `channel_id` 校验。
- 仓库**不保存**任何渠道包内容（`.gitignore` 忽略 `channels/*`），
  仓库里也不应有客户品牌字样。

## 2. beta 渠道（特殊：独立渠道 + 官方品牌）

`beta` 是**独立渠道**（自己的 R2 目录 `beta/`、自己的 `latest.json`，
与 official 互不升级），但**复用官方渠道的品牌内容**。落地方式：
`channels/beta/channel.json` 的 `channel_id` 写 `beta`，品牌字段
（`identity` / `copy` / `assets`）与 `channels/official/` 保持一致。

## 3. 服务端读取的字段（`GET /api/client/v2/channel`）

```jsonc
{
  "schema": 1,
  "channel_id": "acme",                     // 必填,须等于目录名
  "identity": {
    "display_name": "Acme AI",              // 门户站点名 / 页脚
    "short_name": "Acme",                   // 短名
    "tagline": "企业内部 AI 平台",           // 可选
    "title": "Acme AI"                      // 可选;缺省 = display_name
  },
  "copy": {
    "login_display_name": "Acme",           // 登录页品牌名(缺省 short_name)
    "login_tagline": "企业内部 AI 平台",     // 可选
    "login_welcome": "…",                   // 可选,多行保留换行
    "client_display_name": "Acme AI",       // 客户端界面名(缺省 display_name)
    "client_tagline": "…",                  // 可选
    "portal_welcome": "…"                   // 门户欢迎语,可选
  },
  "assets": {
    "logo": "logo.svg",                     // 渠道目录内的文件名(非路径)
    "logo_dark": "logo-dark.svg",           // 可选
    "favicon": "favicon.png",               // 可选
    "accent": "#2563eb"                     // 可选,缺省官方蓝
  }
}
```

约束与兜底（`channel.go`）：

- 素材名必须是**单段文件名**（含 `/`、`\` 或为空一律拒绝），文件不存在时
  不下发对应 URL（避免 404 图片链接）。
- 配置缺失/超 64KB/JSON 损坏/`channel_id` 为空 → **回落内置官方文案**。
  这条兜底是历史行为，渠道化构建下意味着"配置没打进镜像"，属交付事故；
  构建期已由 CI 拦住（文件必须存在 + `channel_id` 必须匹配目录名）。
- 客户端登录页/界面/服务端门户读的是**同一份**内容 —— 改内容 = 改渠道配置
  并重新构建镜像。

## 4. 客户端读取的字段（随包分发的 `channel.json`）

客户端在**登录之前**就要用到的三项必须随包分发（不能等服务端下发：
服务端地址是鸡生蛋，产品名/窗口标题/品牌文案在登录页出现时已可见）。

**就位机制**（2026-09-10 修正，此前文档描述与实际不符）：`scripts/channel-build.ts`
的 `stageChannelProfile()` 在**每个打包入口**（各 `package-*.mjs/ts` 都会调用的
`prepareChannelBuilderOverrides()`）把 `channels/<id>/channel.json` 复制到
`packages/host/desktop/build/channel.json`；electron-builder 的 **`build.files`**
里有这一项，于是它进 asar，运行时 `src/desktop-channel.ts` 用
`new URL('../build/channel.json', import.meta.url)` 读回。

三条硬性约束（都踩过）：

1. **官方/本地构建必须清掉残留**：`stageChannelProfile()` 每次构建都明确二选一
   （有渠道包→覆盖写；没有→删除）。留一个上轮的渠道包会让官方构建继承别的渠道
   的品牌 —— 比"没生效"更糟。
2. **`channel_id` 必须与所选渠道一致**：不一致说明渠道包放错了位置（目录名、
   R2 目录、镜像内 `channel_id` 三处对账就此各说各话），构建期直接中止。
3. **entry 必须写进 `build.files`，不是 npm 的 `files`**：两者不是一回事，
   写错了文件不会进 asar —— 而运行时"读不到"是按"没有渠道包"静默降级的，
   于是客户端不直连渠道域名、登录页显示厂商名，全程零报错（2026-09-10 实测
   发现的断链）。

```jsonc
{
  "channel_id": "acme",                      // 必填,形状校验
  "identity": {
    "display_name": "Acme AI",               // 必填(CI 拦住);产品名与界面名的兜底
    "short_name": "Acme",                    // 必填(CI 拦住);登录页名字、侧边栏短名
    "tagline": "企业内部 AI 平台",            // 可选
    "title": "Acme AI"                       // 可选;缺省 = display_name
  },
  "copy": {
    "login_display_name": "Acme",            // 可选;缺省 = identity.short_name
    "login_tagline": "企业内部 AI 平台",      // 可选
    "login_welcome": "…",                    // 可选
    "client_display_name": "Acme AI",        // 可选;缺省 = identity.display_name
    "client_tagline": "…"                    // 可选
  },
  "defaults": {
    // 配了 → 客户端开机直接进登录(跳过"输入服务端地址"这一步);
    // 必须是 https,或 http+回环(本机调试)。其它一律忽略并保留两步流程。
    "server_url": "https://ai.acme.example.com"
  },
  "desktop": {
    "product_name": "Acme AI",               // 可选;覆盖 identity.display_name
    "window_title": "Acme AI",               // 可选;缺省 = product_name
    // ↓ 编译期品牌(打包时由 electron-builder 落地,见 §5)
    "slug": "Acme-AI",                       // 可选;安装包名/可执行名的 ASCII 段
    "app_id": "com.acme.ai",                 // 可选;bundle id / AppUserModelId
    "shortcut_name": "Acme AI",              // 可选;缺省 = product_name
    "maintainer": "acme",                    // 可选;deb/Linux 软件中心
    "synopsis": "Acme 企业内部助手"           // 可选;缺省 = product_name
  }
}
```

生效点：

| 字段 | 生效位置 | 效果 |
|---|---|---|
| `defaults.server_url` | `profile.ts` → `picoaide-auth-gate` 的 `defaultServer` | 登录页跳过 Step1 直连服务端；若只配了浏览器 SSO 方式(纯 OIDC/OpenID),直接发起跳转 |
| `desktop.product_name` / `window_title` | `profile.ts` → `desktop-shell` 行配置 | 窗口标题 / 托盘 / 通知文案 / 插件加载失败弹窗 / 渲染失败页 |
| `desktop.product_name` | `src/main.ts` 的 `PRODUCT_NAME` | 通知发送者 / `app.setName` 数据目录 |
| `identity.*` / `copy.*`（品牌文案） | `profile.ts` → `picoaide-auth-gate` + `picoaide-channel-sync` 的 `brand` | 登录页标题与品牌区、客户端侧边栏/顶栏、服务端不可达时的兜底内容 |
| `channel_id` | 供排查与将来对账 | — |

**为什么品牌文案必须随包**（而不是等服务端下发）：登录页是**认证之前**的界面，
那一刻服务端地址可能正是用户要输入的东西（问服务端要它自己是鸡生蛋）。窗口
标题、登录页标题、品牌区在用户敲第一个键之前就已可见 —— 它们只能来自包内配置。

品牌取值链**与服务端 `channel.go` 的 `applyDefaults` 同序**：`copy.login_display_name`
→ `identity.short_name`、`copy.client_display_name` → `identity.display_name`。
顺序不一致会出现"登录页一个名、登录后另一个名"。

**品牌字段是 CI 硬性要求**：`identity.display_name` 与 `identity.short_name` 缺一
即中止构建（`scripts/ci-channels.sh`）。因为包里没有品牌时客户端回落的是**中性
占位**（`Harness`，绝不含厂商品牌），交付出去就是"渠道客户看到中性名/厂商名"的
观感事故 —— 这类事故只能在构建期拦住。本地开发（没有渠道包）走的是官方内置
文案，行为与渠道化改造前一致。

**品牌渠道（official/beta 之外）另有三个编译期字段是硬性必填**（2026-09-10 审计
后加严，同样是构建期中止）：

| 字段 | 缺了会怎样 |
|---|---|
| `desktop.slug` | 安装包名回落 `PicoAide-Harness-…` —— **交付物上直接出现厂商品牌** |
| `desktop.app_id` | bundle id / AppUserModelId 回落厂商值 —— 两个渠道的客户端在系统里变成"同一个 app" |
| `desktop.deep_link_scheme` | 回落 `picoaide` —— 浏览器 SSO 回调的确认框里出现厂商名 |

`ci-channels.sh` 同时做字段形状校验（slug 纯 ASCII、app_id 反向域名、
scheme 合法、`defaults.server_url` 必须 https 或回环 http）与**素材存在性/几何
校验**：`assets.*` 里声明的文件名必须在渠道目录里真实存在（否则服务端不下发
URL、客户端拿到死链），`app-icon.png` 必须是 **1024×1024、16 位 RGBA、内嵌 ICC**
（mac 图标管线的硬要求，见 `generate-mac-app-icon.mjs`）—— 这两项在打包时才炸，
而打包要跑三个平台，所以在拉取渠道包的阶段就拦。

**侧边栏短名**：服务端不下发 `short_name`（`GET /api/client/v2/channel` 没有这个
字段），所以它来自随包品牌；渠道没配短名时回落到显示名，不回落任何具体品牌。

文件缺失（本地开发、未渠道化的构建）时所有字段按"未配置"处理，沿用原有行为
—— 渠道化是增量能力，缺失不能变成启动失败。

### 4.1 客户端品牌的三条来源与优先级

客户端界面上的品牌有三个来源，**优先级从高到低**：

| 来源 | 何时生效 | 说明 |
|---|---|---|
| 服务端 `GET /api/client/v2/channel` | 已登录且服务端可达 | 管理员在服务端改了内容，这里胜出 |
| 随包 `build/channel.json` | 服务端缺字段 / 不可达 / 未登录 | 同一个渠道包构建的，内容一致 |
| 内置官方内容 | 没有渠道包（本地开发、官方构建） | 与渠道化改造前逐字节一致 |

中间两条靠 `mergeChannel(base, override)` **逐字段**合并（服务端有值即胜出），
不是整体替换 —— 整体替换会让"服务端少给一个字段"变成"客户端露出厂商名"。

**载荷结构校验**（`asChannelPayload()`）：`/api/pico/channel` 的响应必须至少
含一个非空品牌字段，否则一律不采纳。为什么需要：服务端对未知路由可能回
`{ok:true}` 之类的兜底对象（旧服务端、网关、代理），把它当渠道内容存进 store
会让**每个**品牌字段取不到值，消费方全部回落到内置厂商文案 —— 界面上就是
"渠道客户看到 PicoAide"，而链路里一处报错都没有（2026-09-10 实测，E2E 抓到）。

**中性占位 vs 官方内容**：判据是"有没有非空名字"，不是"品牌对象是否存在"。
schemastery 会把未注入的 `brand` 物化成 `{}`，把它当渠道会让**官方**构建改名
成中性占位。渠道构建里"包里没写品牌"由 `desktop-channel.ts` 在注入前就落成
中性名（`Harness`），不需要消费方再判一次。

**E2E 是白标的门禁**：渠道构建下 `e2e:client` 会断言 body/标题里不出现厂商品牌
（官方构建跳过 —— 那里厂商名是合法文案；`E2E_FORCE_BRAND_LEAK_CHECK=1` 可在
官方构建上强制开启以自证门禁有效）。另有静态门禁
`packages/host/desktop/tests/verification-brand-agnostic.spec.ts`：验证脚本里
出现品牌字面量标题断言、或从 `package.json` 取产品名，直接红。

## 5. 编译期品牌（渠道矩阵在打包时落地）

以下由 electron-builder 在**打包时**决定，运行时读文件来不及改。渠道由环境变量
`DSH_BUILD_CHANNEL=<id>` 选择，`scripts/channel-build.ts` 把它翻译成
`--config.*` 覆盖参数：

| 字段 | electron-builder 覆盖 | 缺省（官方渠道） |
|---|---|---|
| `desktop.product_name` | `productName` | `package.json build.productName` |
| `desktop.app_id` | `appId` | `ai.deepseek.dsh.desktop` |
| `desktop.slug` | `mac/win/nsis/linux.artifactName` | `PicoAide-Harness-*` |
| `desktop.shortcut_name` | `nsis.shortcutName` | `package.json build.nsis.shortcutName` |
| `desktop.maintainer` / `synopsis` | `linux.maintainer` / `linux.synopsis` | `package.json build.linux.*` |
| `desktop.deep_link_scheme` / `deep_link_name` | `protocols[0].schemes[0]` / `protocols[0].name` | `picoaide` / `<产品名> Deep Link` |
| 渠道目录里的 `logo.svg` / `app-icon.png` | 打包脚本调 `prepareChannelPackaging()` 派生到 `build/`（electron-builder 的 `directories.buildResources`）后再打包 | `brands/official/` |

规则：

- **官方渠道不做任何覆盖**（`channelBuilderConfigArgs()` 返回空数组），产物与
  渠道化改造前一致；`tests/channel-build.spec.ts` 用**漂移断言**把
  `channel-build.ts` 里的官方默认值与 `package.json build` 块钉死。
- **位图必须走 `prepareChannelPackaging()`**（`scripts/channel-prepare.ts`）：
  它按渠道派生 `build/` 下的 app 图标/托盘位图并就位 `build/channel.json`。
  2026-09-10 审计发现的 P0 是"这条链没人调用"——`brand-prepare` 只挂在 desktop 的
  `build` 脚本里，而 CI 打包一律 `--no-prebuild`（构建产物来自 gate job），于是
  **渠道包带着官方图标出厂**，而本地打包（会经 prebuild 触发）却看不出问题。
  五个打包入口（linux/win/win-portable/mac-smoke/mac-release/dir）现在都显式调用。
- 渠道目录里缺的素材**逐文件回落** `brands/official/`：渠道只换 logo 是合法的。
- 渠道 logo 必须由 `brands/official/logo.svg` 派生（几何单一权威，见 `AGENTS.md`）；
  渠道 `app-icon.png` 必须 1024×1024 / RGBA16 / 带 ICC（见 §4 的构建期校验）。
- `slug` 必须是纯 ASCII（它进安装包名与可执行名）；`app_id` 必须是反向域名形状。
  两者非法即**抛错**，不产出错误渠道的包。
- 打包后的验证脚本（`verify-win-installer.ts` / `verify-win-portable.ts` /
  `release-mac.ts`）从同一上下文推导期望文件名，不再硬编码厂商名。
- **打包后还有一条白标门禁**（`scripts/verify-channel-package.ts`，由
  `scripts/ci-package-clients.sh` 每渠道调用）：现场按本渠道重新派生一遍位图并
  逐字节比对、断言 `channel.json` 的 `channel_id`，给了 `--app-dir` 时再拆开
  `app.asar` 确认"随包分发"真的生效（官方构建则断言**没有**渠道包残留）。
  它同时进了 `yarn check`（`verify:channel`）。

仍未渠道化：

- macOS 签名统一用**厂商证书**（2026-09-10 定案，后续不更换）。

### 5.1 深链 scheme：三处必须一致

`desktop.deep_link_scheme` 决定浏览器从 IdP 回调跳回客户端时的 scheme ——
确认框里显示的就是它，渠道客户不该在这里看到厂商名。**三处必须同源**：

| 位置 | 作用 | 真源 |
|---|---|---|
| electron-builder `protocols` | 操作系统级注册（`x-scheme-handler/<scheme>`） | `scripts/channel-build.ts` 生成的配置文件 |
| 客户端解析 | `main.ts` / `src/deep-link.ts` / `enterprise/src/deep-link.ts` | `src/desktop-channel.ts` 读随包 `channel.json` |
| 服务端 OIDC 回调 | 拼 `<scheme>://auth?token=…` | `server/internal/channel` 的 `DeepLinkScheme()` |

校验口径：构建期（`channel-build.ts`）遇到畸形 scheme **fail-loud**；运行期
（`desktop-channel.ts` / 服务端）**回落官方值** —— 那里没有"拒绝启动/构建"这个
选项，能用比报错好。

> **实现坑（2026-09-10 实测）**：`protocols` 是数组，**不能**用
> `--config.protocols[0].schemes[0]=…` 覆盖 —— electron-builder 的 CLI 点号覆盖
> 不支持数组下标，会以 `configuration has an unknown property 'protocols[0]'`
> 拒绝整次构建。渠道覆盖必须走 `--config <生成的配置文件>`
> （`writeChannelBuilderConfig()`，里面深展开 package.json 的 build 块）。

## 6. 更新源（客户端不碰分发面）

- 客户端（官方与渠道一致）**只从它登录的那台服务端取更新**：
  `GET {serverURL}/api/client/v2/updates/manifest`。客户端不再有任何指向
  `release.picoaide.com` 的路径 —— 渠道身份由服务端在结构上决定，
  跨渠道版本错乱不可能发生。相关代码：`desktop-release.ts`、`updates.ts`。
- 服务端自己的"检查更新"仍读 R2：`release.picoaide.com/<channel>/latest.json`，
  仅用于在 webadmin 提醒管理员。清单的 `channel_id` 必须等于本部署渠道，
  不一致报"检查不可用"（fail-loud，不是"无更新"）。
- R2 上**只放镜像**；客户端安装包在镜像里，由服务端下发。
- 镜像内的 Linux 客户端**只有 AppImage**（`ci-build-channel-images.sh` 装配时删掉
  `*.deb`，2026-09-10 定案）：deb 与 AppImage 是同一应用的两种打包，员工装一个即可；
  CI 仍会构建 deb（`dist:linux` 的产物之一），只是不进任何交付面。

## 7. 品牌渠道产物不进公开面（2026-09-10 审计定案）

**问题**：tag 运行时三平台 job 会把每个渠道的安装包归集到 `client-assets/<channel>/`
再上传为 artifact。artifact 名是中性了，但**内容是客户身份**：目录名就是渠道 id、
文件名由渠道 slug 决定（`Acme-AI-…-Setup.exe`）、包内还带着随包 `channel.json`
（含 `defaults.server_url`）。公开仓的 artifact 对任何登录账号可下载，而
`::add-mask::` 只作用于日志 —— 与"品牌渠道绝不公开"的定策直接冲突。

**做法**（`scripts/ci-channel-transfer.sh`）：

```
官方/beta  → 照旧走 artifact（它们的品牌本来就公开，GitHub Release 也发它们）
品牌渠道   → 三平台 job 上传到 R2 临时前缀 → release job 取回后立即删除
```

前缀形如 `s3://<bucket>/_transfer/<run-id>-<HMAC(R2 密钥, run-id)>/ch-<index>/`：

- `ch-<index>` 用渠道列表行号，**路径里没有渠道 id**；
- token 是 HMAC 派生的，桶虽然公开读（`release.picoaide.com` 是 R2 自定义域），
  但没有 R2 凭据就算不出对象地址，无法按 run id 猜；
- 上传/下载都用 `--only-show-errors`，避免 aws 回显含品牌文件名的对象键；
- **R2 凭据缺失 + 存在品牌渠道 = 直接失败**（`ci-channel-transfer.sh` 与
  `ci-publish-update-server.sh` 都是），因为 R2 是品牌渠道唯一的分发面，
  静默跳过等于"客户零交付而流水线全绿"。

官方/beta 仍可缺 R2 凭据（只告警跳过），它们另有 GitHub Release 兜底。
