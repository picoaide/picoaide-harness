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

客户端在**登录之前**就要用到的两项必须随包分发（不能等服务端下发：
服务端地址是鸡生蛋，产品名/窗口标题在登录页出现时已可见）。CI 在打包前把
`channels/<id>/channel.json` 复制到 `packages/host/desktop/build/channel.json`，
electron-builder 通过 `files` 把它打进应用资源。

```jsonc
{
  "channel_id": "acme",                      // 必填,形状校验
  "identity": { "display_name": "Acme AI" }, // 缺省产品名来源
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
| `desktop.product_name` / `window_title` | `profile.ts` → `desktop-shell` 行配置 | 窗口标题 / 托盘 / 通知文案 |
| `desktop.product_name` | `src/main.ts` 的 `PRODUCT_NAME` | 通知发送者 / `app.setName` 数据目录 |
| `channel_id` | 供排查与将来对账 | — |

文件缺失（本地开发、未渠道化的构建）时所有字段按"未配置"处理，沿用原有行为
—— 渠道化是增量能力，缺失不能变成启动失败。

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
| 渠道目录里的 `logo.svg` / `app-icon.png` | `directories.buildResources` 下的图标 | `brands/official/` |

规则：

- **官方渠道不做任何覆盖**（`channelBuilderConfigArgs()` 返回空数组），产物与
  渠道化改造前一致；`tests/channel-build.spec.ts` 用**漂移断言**把
  `channel-build.ts` 里的官方默认值与 `package.json build` 块钉死。
- 渠道目录里缺的素材**逐文件回落** `brands/official/`：渠道只换 logo 是合法的。
- 渠道 logo 必须由 `brands/official/logo.svg` 派生（几何单一权威，见 `AGENTS.md`）。
- `slug` 必须是纯 ASCII（它进安装包名与可执行名）；`app_id` 必须是反向域名形状。
  两者非法即**抛错**，不产出错误渠道的包。
- 打包后的验证脚本（`verify-win-installer.ts` / `verify-win-portable.ts` /
  `release-mac.ts`）从同一上下文推导期望文件名，不再硬编码厂商名。

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
