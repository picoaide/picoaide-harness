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
    "synopsis": "Acme 企业内部助手",          // 可选;缺省 = product_name
    // ↓ 数据根(运行期;见 §4.4)。**除 official 外每个渠道都必填**(2026-09-12 起)
    "home_dir": ".acme-harness"              // `~` 下的单段目录名
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
| `desktop.home_dir` | `src/main.ts` 的 `dshHomeSafe({ productDir })` → `DSH_HOME` | **本次安装的数据根**（账户 token/settings/会话/连接器凭据）；见 §4.4 |
| `desktop.app_id` | `src/main.ts` 的 `app.setAppUserModelId` | Windows 通知身份（必须与快捷方式的 AppUserModelId 一致） |
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

**`desktop.home_dir`（数据根）是硬性必填字段**（2026-09-11 加；2026-09-12 两次修订）：
它不是编译期品牌，而是运行期数据隔离 —— 缺了就与官方客户端共用数据根（共享登录
token/settings/会话），品牌渠道之间更不该共享（跨租户）。取值只有两种合法形状：

- **`beta`（预发布渠道）必须与官方正式版一致**（`.picoaide-harness`）：预发版是正式版
  的前置验证，登录态/设置/会话要与正式版延续；写成自己的目录会让已装预发版的用户
  升级后看不到既有会话（2026-09-12 实测事故：beta.2 → beta.6 用户报"所有对话都没了"，
  详见 `docs/decisions/2026-09-11-channel-scoped-data-roots.md` 的两次 2026-09-12 修订）。
- **品牌渠道不得写 `.picoaide-harness`**：渠道线与 official 的会话格式世代可能不同
  （正式线稳定版 v0 / 含上游 0.1.5-rc.2 的预发线 v3），共用会让两代客户端各写一份、
  旧版静默看不到新版会话并造成历史分叉。

official 不需要写（官方构建不随包分发渠道包，写了也不生效）。

**渠道 logo 的格式约束**（`desktop/scripts/generate-tray-icons.mjs`）：托盘位图是
**把方块色字符串替换成托盘变体色**渲染的，所以渠道 `logo.svg` 必须

- 用**平坦的十六进制色 `<rect fill="#RRGGBB">`** 画方块（渐变 / `url(#…)` 替换不到，
  会得到一个颜色没归一的托盘图标）；
- 全部内联属性，**不能有 `<style>`**（样式表里的颜色替换不到）。

这条约束以前是"必须恰好是官方黑 `#000000`"，于是渠道用自己的品牌色画 logo 会直接
打包失败（报错还只说"必须用 #000000"）—— 2026-09-11 改成按方块自身的颜色替换，
官方路径逐字节不变。品牌渠道可以用自己的品牌色（用平坦十六进制色画方块，见上一段）。

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

### 4.2 渠道素材 URL 的客户端契约（2026-09-10：一次"裂图"复盘）

服务端下发的 `login.logo_url` / `client.logo_url` / `favicon_url` 是**相对路径**
（`/api/client/v2/channel/logo`，命名空间真源在 `server/internal/router`），而消费
它们的是渲染层的 `<img src>`。这一层有三个坑，任意一个没堵住，渠道客户看到的就是
一张裂图（2026-09-10 测试环境实测）：

| 环节 | 规则 | 位置 |
|---|---|---|
| 谁拼服务端地址 | `/api/pico/channel` 在**出口**统一绝对化；没有服务端地址就**丢弃**相对 URL（宁可回落内置品牌图形，也不渲染必然 404 的地址） | `enterprise/src/channel-content.ts` 的 `absolutizeChannelAssets` |
| store 播种 | 该端点的载荷可能来自旧版本代码，播种前再丢一次相对素材 URL | `enterprise/src/client/channel-store.ts` 的 `stripRelativeAssetURLs` |
| 窗口 CSP | `img-src` 必须放行 `http:` / `https:` —— 渠道 logo 来自**客户自己的服务器**，打包期不可能知道它的地址；只写 `'self' data: blob:` 会被 CSP 直接拦掉（微实验复现：`violates the following Content Security Policy directive: "img-src 'self' data: blob:"`，`naturalWidth=0`） | `desktop/src/electron-runtime.ts` 的 `APP_CONTENT_SECURITY_POLICY` |
| 服务端不可达 / 旧版服务端 | 渠道目录里的 logo 由 `stageChannelProfile()` **内联成 `data:` URI** 写进随包 `channel.json`（`assets.logo_inline` / `logo_dark_inline`），随包品牌因此自带标识 —— 否则客户端只能回落编译期内置的**官方**花括号 mark，白标客户的登录页上出现厂商图形（2026-09-11 在 acme 渠道线上实测） | `desktop/scripts/channel-build.ts` → `desktop-channel.ts` 的 `brand.logoURL` → `brandChannel()` |

另外三条配套约束：

- **相对路径在本地 origin 下必然 404**：桌面渲染层的 origin 是本地 webServer
  （`http://127.0.0.1:<port>`），那里没有 `/api/client/v2/*` 路由（那是服务端命名
  空间）。所以"服务端下发相对路径 → 直接塞给 `<img>`"在任何版本里都不成立。
- **加载失败要能回落**：侧边栏/英雄区品牌图在服务端不可达（离线、未连内网）时，
  `<img>` 的 `onError` 必须换回内置花括号 mark，而不是留一个破图图标；登录页早就
  是这么做的（`auth-gate` 的 `onerror`），客户端两处（`client/Channel.tsx` 的
  `BraceMark` / `BrandBadge`）2026-09-10 才补上。
- **拼装顺序**：素材 URL 一律"先删后写"—— `{ ...client, ...(logo ? { logo_url: logo } : {}) }`
  在 logo **被丢弃**时不会覆盖原值，原对象里的相对地址会被 spread 原样带回来
  （2026-09-10 实测踩到：`stripRelativeAssetURLs` 实际一条都没丢，测试才发现）。

排障提示：`logo_url_dark` 目前只有服务端在发，客户端没有消费面（暗色用的是
`currentColor` 花括号 mark）。它曾被 `mergeChannel` 丢掉一轮，现已保留 —— 将来做
暗色素材时别再踩。

### 4.3 服务端不下发的字段（`short_name`）与侧边栏品牌名（2026-09-11）

`client.short_name` 是**随包品牌独有**的字段：服务端 `channel.Response` 里没有它，
侧边栏却只用它（"PicoAide" 而不是 "PicoAide Harness"）。所以**每一个把渠道内容交给
客户端的出口都必须以随包品牌为底做逐字段叠加**（`mergeChannel`），只透传服务端载荷
就会让这个字段整条消失：

| 出口 | 叠加 | 位置 |
|---|---|---|
| `/api/pico/channel`（登录页与客户端 store 的播种源） | `mergeChannel(builtInChannel(brand), 绝对化后的服务端载荷)` | `enterprise/src/auth-gate.ts` |
| `pico/channel-changed`（登录后的服务端同步） | `mergeChannel(builtIn, 绝对化的服务端载荷)` | `enterprise/src/channel-sync.ts` |

两个出口的"随包品牌 → 渠道内容"映射只允许有一份实现：`channel-content.ts` 的
`brandChannel()`（`auth-gate` 曾自己写第二份，两份在"只配了 `login.short_name`"时
给出不同短名 —— 2026-09-11 由测试发现）。

**侧边栏那一行是定高的**：上游 `ui-sidebar` 的 `.brandName` 是 18px 字号、**24px**
高的行；名字长了必须**截断**而不是折行（折行会把行撑到 48px，整个侧边栏头部错位，
2026-09-11 现场截图）。所以 `client/Channel.tsx` 的 `BrandName` 固定
`white-space: nowrap` + `text-overflow: ellipsis`（父级 `min-width: 0` 才让 flex 项
肯收缩），全名挂 `title`。判空口径也只有一份：`channel-content.ts` 的 `nonEmpty`
（`'   '` 算缺失 —— 客户端曾有一份不 trim 的副本，会让侧边栏渲染成空白）。

### 4.4 渠道数据根（两份，都随渠道；2026-09-11）

白标客户端是**独立产品**，不能和官方客户端（或另一个渠道）共用数据根。同一个
用户目录下有两份数据根，两份都随渠道：

| 数据根 | 官方 | 渠道 | 里面是什么 |
|---|---|---|---|
| Harness home（`~/.<目录名>`） | `~/.picoaide-harness` | `desktop.home_dir`（如 `~/.acme-harness`） | 账户 token（`session.json`）、`.credentials.yaml`、`settings.yaml`（含服务端地址）、`sessions/`、`storages/`、`profiles/`、`users/<用户名>/connectors/`（连接器凭据）、cron ledger、browser store |
| Electron userData（`appData/<产品名>`） | `~/.config/PicoAide Harness` | 渠道产品名（如 `~/.config/Acme Harness`） | 日志、更新状态、插件管理状态、崩溃取证、**单实例锁** |

**为什么必须分开**（不是"目录名好不好看"）：
- 共用 home ⇒ 渠道客户端启动时会恢复**官方那台**的登录 token 并连上官方服务端
  （跨租户）；连接器凭据、`settings.yaml` 也是同一个文件，last-writer-wins；
- 共用 userData ⇒ 单实例锁互斥：先启动的那个客户端会把后启动的渠道客户端
  "顶掉"（第二个进程直接退出并把窗口让给第一个）。
- 白标：路径出现在文件管理器/诊断包里，不应带厂商名。

**`desktop.home_dir` 取值规则**（真源 `src/desktop-home.ts` 的
`channelDshHomeDir`，构建期与运行期同一个函数）：

```
official                          → .picoaide-harness        （逐字节不变，存量数据不搬）
显式 home_dir                     → 原值（须匹配 ^\.[a-z0-9][a-z0-9-]{0,62}$）
没有 home_dir，有 slug            → "." + slug 小写（Acme-Harness → .acme-harness）
都没有（beta 这类复用官方品牌的）  → .picoaide-harness-<channel id>
```

**派生/回落路径永不撞上官方目录**（slug 恰好等于官方 slug 会被忽略并退档），
但**显式声明一律照办** —— 包括显式写 `.picoaide-harness`（beta 就是这么配的）；
品牌渠道写官方目录由 `ci-channels.sh` 在构建期拦下。
`$DSH_HOME` / 显式配置仍然优先（e2e、便携安装、多 profile 依赖它）。

**userData 目录名**（真源 `src/desktop-user-data.ts` 的
`desktopUserDataDirectoryName`）：官方 = 产品名（不变）；品牌渠道 = 产品名；
**产品名与官方逐字相同的渠道（beta）= `<产品名> (<渠道 id>)`** —— beta 复用官方
品牌，不消歧就会与 official 撞在同一个 userData 上（单实例锁互斥）。

**校验与门禁**：
- `scripts/ci-channels.sh`：`desktop.home_dir` 形状校验；**品牌渠道必填**且不得等于
  `.picoaide-harness`（公共渠道 official/beta 不受此限，beta 正是显式共用官方目录）；
- `scripts/verify-channel-package.ts`：用**运行期解析器**读随包 `channel.json`，
  断言这次装出来的数据目录就是本渠道的（`yarn check` 的 `verify:channel` 会跑）；
- `tests/desktop-home.spec.ts` / `desktop-channel.spec.ts` / `desktop-user-data.spec.ts`：
  取值链、畸形值、以及"非官方渠道永不得到官方目录"的穷举断言。

**没有迁移逻辑**：品牌渠道客户端在 2026-09-11 之前没有正式发布过（beta tag 只产
official/beta），所以直接切换；官方渠道目录不变，存量用户无感。若某个渠道确实已
经交付过、数据落在旧目录，需要单独做一次性搬运，**不要**用"回落官方目录"兜底。

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
- `desktop.home_dir` **不进** electron-builder 覆盖（它不影响安装包内容），但构建期
  会按同一个 `channelDshHomeDir()` 算一遍（`ChannelBuildContext.homeDir`），供
  `verify-channel-package.ts` 断言"这个包的数据根只属于本渠道"（见 §4.4）。
- **位图必须走 `prepareChannelPackaging()`**（`scripts/channel-prepare.ts`）：  它按渠道派生 `build/` 下的 app 图标/托盘位图并就位 `build/channel.json`。
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

### 5.0 渠道包的 mac 交付面：必须**签名 + 公证 + staple**（2026-09-11 修复）

渠道包是**交付物**，不是内测包：客户在 Mac 上双击打开，Gatekeeper 必须直接放行。此前
渠道走的是"预发 tag 那条" sign-only 路径（`dist:mac:pack --sign-only` + `dist:mac:dmg`），
包**已用厂商 Developer ID 签名**（实测：`identifier=com.<渠道 app_id>`、`teamID=78W9HZYR6Q`、
`flags=0x10000` hardened runtime、CMS 可验、链到 Apple Root CA），但**没有公证票据** ——
首次打开被拦成「Apple 无法验证此 App 是否包含恶意软件 / 未能验证开发者」。

判据（离线可查，不需要 macOS）：公证+staple 过的 app bundle 里有票据文件
`Contents/CodeResources`（magic `s8ch`，signer 链 = Software Ticket Signing ← Apple
System Integration CA 4 ← Apple Root CA - G3）；sign-only 的包没有这个文件。
官方 2.6.7 DMG 有、渠道 2.7.0 DMG 没有 —— 这就是客户看到的差异。

CI 现在的规则（`.github/workflows/ci.yml` 的 `desktop-macos`）：

| tag | 官方/beta 客户端 | 品牌渠道客户端 |
|---|---|---|
| 正式 `vX.Y.Z` | 签名 + 公证 + staple | **签名 + 公证 + staple**（逐渠道 3 次重试，与官方同链） |
| 预发 `vX.Y.Z-beta.N` | 只签名（不公证） | 不构建（预发 tag 的渠道列表只有 `beta`） |

成本提示：公证排队 1–5 小时是**每个渠道各自**的，且与官方共享同一个 mac job 的
360 分钟预算；渠道数变多后必须改成"按序号矩阵拆 job"（矩阵维度用序号，不用渠道 id，
避免品牌名出现在 job 名里）。

### 5.1 深链 scheme：一处真源、四处生效（2026-09-11 修正）

`desktop.deep_link_scheme` 决定浏览器从 IdP 回调跳回客户端时的 scheme ——
确认框里显示的就是它，渠道客户不该在这里看到厂商名。**真源只有随包
`channel.json` 一处**（`desktop-channel.ts` 解析），生效点有四个：

| 位置 | 作用 | 取值方式 |
|---|---|---|
| electron-builder `protocols` | 操作系统级注册（`x-scheme-handler/<scheme>`） | `scripts/channel-build.ts` 生成的配置文件 |
| 桌面壳的深链闸门 | argv/`open-url`/第二实例的严格校验（P2-62） | `main.ts` 的 `DEEP_LINK_SCHEME` → 构造 `ElectronDesktopRuntime` 时注入 |
| 会话服务（企业插件） | 解析 `<scheme>://auth?token=…` 完成 SSO 登录 | 组装期由 `profile.ts` 的 `channelProfilePatches()` 注入 `picoaide-session` 行的 config（**不要**让它自己读 `channel.json`，见下） | 
| 服务端 OIDC 回调 | 拼 `<scheme>://auth?token=…` | `server/internal/channel` 的 `DeepLinkScheme()` |

校验口径：构建期（`channel-build.ts`）遇到畸形 scheme **fail-loud**；运行期
（`desktop-channel.ts` / 服务端）**回落官方值** —— 那里没有"拒绝启动/构建"这个
选项，能用比报错好。

> **实现坑一（2026-09-10 实测）**：`protocols` 是数组，**不能**用
> `--config.protocols[0].schemes[0]=…` 覆盖 —— electron-builder 的 CLI 点号覆盖
> 不支持数组下标，会以 `configuration has an unknown property 'protocols[0]'`
> 拒绝整次构建。渠道覆盖必须走 `--config <生成的配置文件>`
> （`writeChannelBuilderConfig()`，里面深展开 package.json 的 build 块）。
>
> **实现坑二（2026-09-11 真机复现，曾让渠道客户端的浏览器 SSO 完全不可用）**：
> 随包 `channel.json` 只能由**桌面包自己**读（`readDesktopChannelProfile()` 的
> `../build/channel.json` 是相对模块位置算的）。企业插件被打进**自己的** lib，
> 同样的代码在那里会指向 `@picoaide/dsh-enterprise/build/channel.json` —— 打包产物
> 里不存在（asar 只有应用根的 `/build/`），于是静默回落官方 scheme；桌面壳的深链
> 闸门当时也漏传 scheme，渠道回调在闸门处就被丢掉。**规则：跨包的渠道内容一律在
> 组装期注入（`channelProfilePatches`），插件不得自行读随包文件。**

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
