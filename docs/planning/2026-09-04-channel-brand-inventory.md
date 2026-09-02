# 品牌点盘点清单（Phase 0 产出，2026-09-04）

> 目的：穷举仓库内所有 PicoAide / PicoAide Harness 品牌点，标注企业渠道化时"必改 / 可选改 / 保留"。
> 方法：全仓 grep `PicoAide|picoaide` + logo 资产 glob（已排除 node_modules/dist 噪声）。
> 配套：主规划 `docs/planning/2026-09-04-enterprise-channel-branding.md`。

**图例**：🟥必改（渠道化硬要求）/ 🟨可选改（建议）/ 🟩保留（技术标识或官方属性）

---

## A. 图形/Logo 资产

| # | 品牌点 | 位置 | 现值 | 渠道化 | 说明 |
|---|---|---|---|---|---|
| A1 | **主 logo 权威源** | `brands/official/logo.svg`（2026-09-04 由仓库根迁入；`logo-dark.svg` 反色成对） | 官方 black-tile+brace | 🟥 | 渠道内 `brands/<id>/logo.svg` 为渠道权威源；官方链已归一（brand-prepare 派生） |
| A2 | Win/Linux app 图标 | `packages/host/desktop/build/app-icon.png` | 1024² PNG | 🟥 | 由渠道 logo 派生（build 时生成，不入库） |
| A3 | macOS Dock 图标 | `build/app-icon-mac.png`（`generate-mac-app-icon.mjs`：1024→824 居中+透明边距，要求 RGBA16+ICC） | 派生自 A2 | 🟥 | 屏幕安全区规则保留，输入源换渠道 |
| A4 | Tray 图标系列 | `generate-tray-icons.mjs` 从 `brands/official/logo.svg` 派生（校验固定品牌色 `#000000`）；源 `tray-icon.svg` 已于 2026-09-04 删除（与 logo.svg 完全相同），输出 `build/tray-icon*.png` | 派生 | 🟥 | 已实施：brand-prepare 统一派生 |
| A5 | **服务端门户 / 默认 logo** | `server/cmd/server/main.go:339` `<span class="logo">P</span>` | 文字 glyph `P` | 🟥 | ⚠️ **违反仓库单一权威规则（禁止 text glyph）**；官方渠道也必须修：内联 logo.svg 派生 mark（参考客户端登录页 `auth-gate.ts:203` `BRACE_MARK_SVG` 已是合规兜底，门户应统一做法）；企业版门户在 `brand.enabled` 时走配置 logo（已有） |
| A6 | 官网 logo（明/暗） | `site` 引用 `brands/official/logo.svg` / `logo-dark.svg`（原 `site/src/assets/` 副本已删除） | 官方 | 🟩 | **官网只接收官方渠道**：site 是 official 渠道专属品牌面，渠道化复制不驱动官网（见 brands/official/README.md「官网边界」）；企业渠道不产生官网 |
| A7 | webadmin favicon | 无（`server/webadmin/index.html` 仅 title） | — | 🟩 | 管理端官方面；需要时可加，与渠道化无关 |
| A8 | **门户页其他品牌缺口** | `main.go:287,289`：title=`loginName`（已配置化）；**`--accent:#4176E6` 硬编码**；**无 favicon**（`<head>` 无 link） | 官方 | 🟨 | 品牌主色：brand API `client.accent` 已支持（`brand_test.go:80`），但 **Login 侧无 accent 字段** → 门户/登录页主色不可配置，应加 `login.accent`；favicon 补 `brand` 下发 |
| A9 | 客户端登录页 favicon | `auth-gate.ts` LOGIN_HTML `<head>` 无 favicon link | — | 🟨 | 登录页是独立 HTML（非 client UI），favicon 由 `client/favicon.ts` 只覆盖登录后界面；补登录页 favicon |

## B. 安装包级名称/元数据（electron-builder，编译期）

| # | 品牌点 | 位置 | 现值 | 渠道化 | 说明 |
|---|---|---|---|---|---|
| B1 | **appId / bundle id** | `packages/host/desktop/package.json` `build.appId` | `ai.deepseek.dsh.desktop` | 🟥 | 渠道 `app_id`（反域名唯一）；Developer ID 签名不依赖 bundle id，可自由换 |
| B2 | **productName** | 同上 `build.productName` | `PicoAide Harness` | 🟥 | 渠道 `display_name`；dock/任务栏/关于页/安装目录名 |
| B3 | **产物名模板 ×3** | `build.mac/win/nsis/linux.artifactName` | `PicoAide-Harness-${version}-mac.dmg` / `…-x64-Setup.exe` / `…-x86_64.AppImage` | 🟥 | 渠道 `slug`（ASCII）；更新下载匹配同源 |
| B4 | Windows 快捷方式名 | `nsis.shortcutName` | `PicoAide Harness` | 🟥 | 渠道 `display_name` |
| B5 | Linux maintainer/synopsis | `build.linux.maintainer`=`picoaide`、`synopsis` | 官方 | 🟥 | 渠道 company / 一句话描述 |
| B6 | 深链 scheme | `build.protocols`（name=`PicoAide Harness Deep Link`、schemes=`picoaide`）+ `src/main.ts:218-225` `setAsDefaultProtocolClient('picoaide')` + `runtime.ts`/`index.ts`/`deep-link.ts` 的 `picoaide://` 判断 | `picoaide` | 🟨 | 渠道私有 scheme（或关闭）；官方保留；不改会互抢 |
| B7 | 版权/作者 | `package.json` 无 author/copyright（electron-builder 默认取） | — | 🟥 | 渠道 `company`/`copyright` 显式注入 |
| B8 | NSIS 许可证页 | `nsis.license`=`THIRD_PARTY_NOTICES.md` | 开源第三方声明 | 🟨 | 企业版分发仍需保留第三方声明（合规），但可加渠道版许可协议 |
| B9 | **NSIS 安装引导文案** | `build/assistedMessages.yml`（`Installing PicoAide Harness…` × en/zh_CN/zh_TW） | 官方 | 🟥 | 安装器窗口文案，渠道 display_name |
| B10 | 包 description | `package.json` `description`（`PicoAide Harness: an Electron shell…`） | 官方 | 🟨 | 元数据描述，渠道化时为渠道一句话 |
| B11 | mac 技术参数 | `mac.hardenedRuntime`/`notarize`/`artifactName`/`x64ArchFiles`/`category`、`mac-universal.ts`、`asar*`、`electronFuses` | 技术 | 🟩 | 与品牌无关，不参数化 |

## C. 桌面运行时品牌默认值（编译期打包进 app）

| # | 品牌点 | 位置 | 现值 | 渠道化 | 说明 |
|---|---|---|---|---|---|
| C1 | **更新源** | `src/update-checker.ts:4`、`update-download.ts:20` `DESKTOP_RELEASE_REPOSITORY` | `picoaide/picoaide-harness` | 🟥 | **P0**：企业版不换 → 升级被官方版"洗掉"；改读渠道配置（manifest/github/none） |
| C2 | **更新资产名模板** | `update-download.ts:246,304-307,330` | `PicoAide-Harness-<v>-…` | 🟥 | 随 B3 slug 参数化，sha256 校验保留 |
| C3 | 窗口标题/单实例名 | `src/main.ts:55` `PRODUCT_NAME`、`index.ts:97-98` productName/windowTitle 默认、`electron-runtime.ts:108` | `PicoAide Harness` | 🟥 | 读渠道配置（Cordis Config 默认值改为生成注入） |
| C4 | 错误弹窗文案 | `electron-runtime.ts:364-366`（3 处 "PicoAide Harness could not…"）、`client/directory-picker.ts:30,32` | 官方名 | 🟨 | 走品牌常量注入 |
| C5 | Tray 更新文案 | `tray-locale.ts:23-46`（"PicoAide Harness ${version} Available" 等 4 条） | 官方名 | 🟥 | locale 模板参数化 |
| C6 | 用户数据目录 | `desktop-home.ts:27` `~/.picoaide-harness`；`bin.ts:56-60` APPDATA/Application Support/`.config` 下 `PicoAide Harness`；`session-service.ts`、`agent-preset-install.ts`、`skill-install.ts` 的 `.picoaide-harness` 散落引用 | 官方名 | 🟨 | 建议渠道化（如 `~/.<slug>`），防多渠道/官方版数据串扰（官方版既有用户数据兼容 → 官方渠道值不变） |
| C7 | 默认品牌文案（服务端未配品牌时） | `enterprise/src/brand-sync.ts:16-21` `DEFAULT_BRAND`（`PicoAide`/`Enterprise AI Gateway`/`PicoAide Harness`） | 官方 | 🟥 | 读渠道 `defaults.brand` |
| C8 | 登录页 | `enterprise/src/auth-gate.ts:43,204,215,473`（title `PicoAide 登录`、fallback `PicoAide`/`Enterprise AI Gateway`） | 官方 | 🟥 | 默认值渠道化（运行时 brand API 已能覆盖登录页品牌） |
| C9 | 客户端 hero/标题/favicon 默认 | `enterprise/src/client/index.ts:65,188`（BRAND_CSS hero headline 默认）、`brand-vars.ts:11`、`Brand.tsx:112,152`（`resolveClientName === 'PicoAide Harness' ? 'PicoAide'` 魔法串判断）、`favicon.ts` | 官方 | 🟨 | 默认值渠道化；魔法字符串判断改配置驱动 |
| C10 | 会话标题 locale | `enterprise/src/client/locales.ts:153,302`（`PicoAide 企业登录`/`PicoAide Enterprise Login`） | 官方 | 🟨 | 模板化 |
| C11 | 关于/更新信息 | `enterprise/src/client/UpdateSection.tsx:55`（`PicoAide Harness v…`） | 官方 | 🟥 | 读渠道显示名 |
| C12 | 遥测/错误上报 release id | `enterprise/src/error-reporting.ts:92` `picoaide-desktop@<v>` | 官方 | 🟨 | 渠道 id 伴生（`<slug>@<v>`），可按渠道过滤 |
| C14 | **登录页默认服务器地址** | `enterprise/src/auth-gate.ts:98` placeholder `__DEFAULT_SERVER__`（Step1 输入框） | 空 | 🟥 | 企业默认网关预填——这正是渠道 `defaults.server_url` 的注入点 |
| C15 | 侧边栏品牌按钮（`PicoAide`） | 客户端侧边栏品牌区（实时环境报告 `buttons=PicoAide`） | 短品牌名 | 🟨 | 运行时由 brand API 覆盖（`client.display_name`/`accent`），默认值渠道化 |
| C16 | 技能来源标记/目录 | `enterprise/src/skill-install.ts:296` `PROVENANCE_DIR='.picoaide'`、`manifest-precheck.ts` 校验 | 技术 | 🟩 | 保持（跨渠道兼容语义）；如企业渠道需隔离再评估 |

## D. 服务端/管理端（运行时品牌面）

| # | 品牌点 | 位置 | 现值 | 渠道化 | 说明 |
|---|---|---|---|---|---|
| D1 | 服务端品牌 API | `server/internal/brand`（`/api/client/v2/brand` + `/api/server/admin/brand`，login/client/favicon logo + title + 快照） | 配置化 | 🟩 | **已有**，运行时品牌面（员工侧） |
| D2 | 门户首页 | `server/cmd/server/main.go:250-344`（logo/name/tagline/welcome/下载链接走 settings `portal.*`+`brand.*`；**footer `PicoAide Harness` 硬编码**） | 部分配置化 | 🟨 | footer 待参数化；下载链接默认=官方 Releases，企业部署可在 webadmin 覆盖 |
| D3 | webadmin 自身品牌 | `webadmin/src/index.html` title `PicoAide 管理后台`；`App.tsx:240,367`；`Login.tsx:97,161`（`© 2026 PicoAide`）；`Brand.tsx:42-51` 默认常量 | 官方 | 🟩 | 管理端官方面（企业管理员看到的管理台品牌）；员工面由 D1 覆盖；webadmin 跟随品牌已有设计（RBAC Phase2） |
| D4 | 错误监控组织 `picoaide-web` | `error-reporting.ts`/scripts 注释 | 技术 | 🟩 | 保留 |

## E. 发布/CI/测试

| # | 品牌点 | 位置 | 现值 | 渠道化 | 说明 |
|---|---|---|---|---|---|
| E1 | 官方 Release | `.github/workflows/ci.yml:224-228`（`--repo picoaide/picoaide-harness`、title `PicoAide Harness ${TAG}`） | 官方 | 🟩 | 官方渠道保留；渠道发布走独立 job（per-channel repo/environment） |
| E2 | 打包验证脚本 | `verify-win-installer.ts:93,95`（`PicoAide-Harness-<v>-x64-Setup.exe`、`PicoAide Harness.exe`）、`verify-win-portable.ts:38,46,48,56` | 官方名 | 🟥 | verify-branded 参数化（读渠道配置而非硬编码——已有先例：`verify-mac-smoke.ts` 读 package.json productName） |
| E3 | E2E 断言 | `e2e-client.mjs:220`、`real-env-*.mjs`（`title.includes('PicoAide')`） | 官方 | 🟨 | 官方渠道保留；渠道 E2E 用渠道 title 断言 |
| E4 | 发布说明/文档 | `docs/releases/*.md`、`README*.md`+`README.i18n.yaml`、`docs/`、`site/` | 官方 | 🟩 | 官方渠道保留；企业交付物另出（部署/更新指南模板） |
| E5 | 版本校验 | `scripts/version.mjs`（两处 package.json + tag 强一致） | 技术 | 🟩 | 官方版保留；渠道版版本号 = 基础版+渠道后缀，校验规则扩展 |

## G. 官方渠道完整面（渠道化不动；盘点确认无遗漏）

| 组 | 位置 | 说明 |
|---|---|---|
| G1 | 桌面包文档 | `packages/host/desktop/README.md`/`README.zh.md`（含 `%APPDATA%\PicoAide Harness\logs`、产物名等）、`docs/plugin-services(.zh).md`、`COVERAGE-MATRIX.md` | 官方文档，渠道化不动；但内容里的**产物名/数据目录名**断言随品牌，实施时以生成配置为准 |
| G2 | 第三方声明头 | `packages/host/desktop/THIRD_PARTY_NOTICES.md`（`PicoAide Harness distributes…`） | 🟨 企业版生成时头部可换渠道名，**第三方表格必须原样保留**（法律面） |
| G3 | 根 README/i18n、docs/、site/ 整站 | 根 `README.md`+`README.i18n.yaml`、`docs/`（架构/FAQ/用户指南/发布说明）、`site/`（Header/Footer/首页 hero/about/rss/description/OG、8 篇 wiki ×2 语言） | 官方渠道面，全部保留；企业渠道不产出官网 |
| G4 | 测试产物 | `.e2e-report.md`、`.real-env-*.md` 等报告文件名与标题 | 🟨 可选：渠道化后报告标题含渠道名（利于排障） |
| G5 | 部署脚本 | `server/scripts/install-server.sh`、`deploy.sh`（`picoaide-data`/`picoaide-server`/镜像名/示例域名） | 技术标识 🟩；企业渠道部署用厂商交付的服务端（同一产品），脚本保留 |

## F. 技术标识（一律保留，渠道化时不动）

| # | 标识 | 位置 | 说明 |
|---|---|---|---|
| F1 | npm bin alias / 包名 | `dsh-desktop`、`dsh-plugin-desktop`、`@picoaide/dsh-*`、`picoaide-*-client` 插件名 | 改会破坏依赖解析与既有安装 |
| F2 | 设置/URL 参数 namespace | `dsh-desktop` 设置、`dsh-desktop-mode`/`dsh-desktop-platform` URL 参数 | 平台检测用，改了破坏 Windows 适配 |
| F3 | 数据目录根 | `~/.picoaide-harness`（`DSH_HOME` 优先；权威源 `desktop-home.ts`） | 见 C6：官方渠道值保持，渠道值随渠道 |
| F4 | Go module / 仓库 / 镜像名 | `github.com/picoaide/picoaide`、`ghcr.io/picoaide/picoaide-harness-server`、`picoaide-server` 二进制名 | 技术/发布标识 |
| F5 | 服务端 settings 键 | `brand.*`、`portal.*` | 运行时配置契约，勿动 |
| F6 | 上游约束 | `deepseek-harness/` 子模块、`~/.dsh` | 官方 pin/上游语义 |

---

## 汇总：渠道化必改（🟥）≈ 18 处 / 可选（🟨）≈ 14 处 / 保留（🟩）≈ 15 处 + 官方面 5 组

**Phase 0 收敛动作建议**：
1. 桌面侧官方品牌收敛为单一配置 `packages/host/desktop/brand/official.json`：productName/窗口标题/数据目录名/tray 文案/登录页默认（含默认服务器占位）/安装器文案/更新源/资产名——B、C 两组的"现值"全部改读该文件（缺口默认 `official`）。
2. 把 C6 数据目录与 C1 更新源列为最先（影响面最大：更新源错=版本被洗；数据目录冲突=用户数据串）。
3. **A5（门户 `P` glyph）是独立违规项，官方渠道也应修**——统一为 logo.svg 派生 mark（对齐 `auth-gate.ts` `BRACE_MARK_SVG` 的合规兜底做法）；顺带补 A8（login.accent 扩展 + 门户 favicon）。
4. G1/G2 相关性提醒：文档与第三方声明中的品牌/产物名断言随渠道参数化时同步核对（法律面不可丢）。
