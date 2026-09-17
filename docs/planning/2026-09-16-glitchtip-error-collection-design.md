# GlitchTip 错误收集为空 —— 设计蓝图（v1）

> 状态：**已归档**（本文件是 2026-09-16 的规划蓝图；决策结论见
> [决策记录](../decisions/2026-09-16-glitchtip-error-collection.md)，实施任务见
> [实施计划](2026-09-16-glitchtip-error-collection-implementation.md)）| 日期：2026-09-16
> 分支：`fix/glitchtip-error-collection-20260916`（基点 `master` = `39692cac6e`）
> 版本沿革：v1（本文件）—— 基于现场事实 F1–F13 + 本轮仓库只读勘察。
>
> **归位说明（P2-1，2026-09-16）**：本文件由本轮规划的 `PLAN.md`（**未经版本库跟踪**的编排工作稿）
> **逐字迁入** `docs/` 永久位置（正文未改，只修正跨文件引用并改写本节头部）。迁入后**本文件即权威**。
>
> **口径提醒**：正文 §3 决策表的"待拍板"是**规划期**状态，实际已全部拍板（并新增 D8/D9）——
> **以 [决策记录](../decisions/2026-09-16-glitchtip-error-collection.md) 为准**。
> 正文 §3.6 / §4.1 中"渲染进程采集本轮不做（F-i）"的判断**已被 D8 推翻**：渲染进程最小可用采集
> 纳入本轮范围，登记为实施计划 **P0-6**。
>
> **D9 运维动作由人执行**：生产 GlitchTip 的 `GLITCHTIP_DOMAIN` 修复（R4/D9）**不由本仓任何代理执行**，
> 人工操作步骤见 [运维手册 docs/deploy/2026-09-16-glitchtip-selfhost-operations.md](../deploy/2026-09-16-glitchtip-selfhost-operations.md)，
> 配套只读核查脚本 `scripts/glitchtip-ops-check.mjs`。

---

## 0. 执行摘要

- **目标**：让「客户端 → GlitchTip」这条链路**可判定地活着或可判定地坏掉**，并让坏配置在入口处就存不进去。
- **一句话结论**：F2 证明代码可用、F3/F4 证明配置下发正确、F1 证明服务端收包可用，因此本轮
  **不是修一条断线，而是补三个盲区**：(1) 坏 DSN 能存进去（F7）；(2) 客户端失败完全静默（F7/H3）；
  (3) 链路健康与否在后台长得一模一样（F9）。修复主体是**可观测性 + 入口校验**，不是改上报逻辑。
- **最重要的新发现（见 §2.6、§3.5）**：
  1. `validateBootstrap()` 在 `models` 为空时把整份配置替换成 `EMPTY`（`web: {}`），而
     `error-reporting` 调用方**丢弃了 `fellBack` 标志** → 服务端下发的 DSN 被客户端**静默丢弃**。
  2. `afterPack` 打包门禁**根本不检查** `@picoaide/dsh-enterprise/error-reporting` 与任何
     `@sentry/*` 条目 → H1 类故障（插件或 SDK 没打进包）**永远是绿的**。
  3. 主进程致命异常存在**退出竞态**：宿主的优雅退出（`app.exit`）会与 Sentry 的异步冲刷竞争，
     且全仓**没有任何一处**在退出时调用 `Sentry.close()` → 最有价值的错误最可能丢。
- **对 H1–H4 的初步判断**见 §3.5：最可能是 **H4（叠加"只采主进程"的覆盖面缺口）+ H5（崩溃退出竞态）**，
  H2 已证伪（生产 tag 与 HEAD 零差异），H1 在已抽样的打包产物上基本证伪但**门禁无背书**。

---

## 1. 术语表

| 术语（内部） | 定义 | UI 文案（用户可见） |
|---|---|---|
| **GlitchTip** | 自托管 Sentry 兼容的错误收集后端（本现场 6.2.6，`https://glitchtip.example.com/`，org `picoaide`，project `picoaide-web`） | 「错误监控服务」 |
| **Sentry DSN** | `{proto}://{public_key}[:{secret}]@{host}[:{port}]/{project_id}`，可选路径前缀 `https://key@host/prefix/1`。**由服务端下发**，源码/本地配置不含任何上报地址（安全约束，见 §4.4） | 「错误上报 DSN」 |
| **store 端点** | DSN 推导出的 ingest 地址：`{proto}://{host}[:{port}]{prefix}/api/{project_id}/store/`，认证走 `X-Sentry-Auth: Sentry sentry_version=7, sentry_key=<public>, sentry_client=<name>/<ver>`（F1 实测可用） | ——（内部） |
| **bootstrap** | `GET /api/client/v2/config/bootstrap`（`server/internal/bootstrap/bootstrap.go`）；响应含 `models/default_model/skills/web/connectors/server_version`。`web` 段即错误上报配置的下发通道 | ——（内部） |
| **`web.error_reporting_dsn`** | settings 键，管理员在 webadmin「错误监控」页配置；经 bootstrap `web.error_reporting_dsn` 下发 | 「错误上报 DSN」 |
| **`web.error_reporting_enabled`** | settings 键（布尔，默认 false=安全）；客户端仅当 `=== true` 才 init | 「启用客户端错误上报」 |
| **`web.error_reporting_level`** | settings 键，`debug|info|warning|error`，客户端 `beforeSend` 的**最低上报等级**（`>=` 才发）。**语义契约，本轮不得改变** | 「上报等级」 |
| **error-reporting 插件** | `packages/host/enterprise/src/error-reporting.ts`，Cordis 行 id `picoaide-error-reporting`（`cordis.patch.yml:14-15`），`inject=['picoSession']`，在主进程用 `@sentry/node` init | ——（内部） |
| **beforeSend 等级阈值** | `LEVEL_RANK`（`error-reporting.ts` 的 `const LEVEL_RANK`，勘察时 `:99`）+ `beforeSend`（同文件 `beforeSend: (event`，勘察时 `:158-163`）纯等级过滤；`debug=10 < info=20 < warning=30 < error=40 < fatal=50` | ——（内部） |
| **自检消息 / 心跳** | init 成功后发的 `info` 级 `captureMessage('客户端错误上报链路自检 (release)')`（勘察时 `:174`，**不是**早先写的 `:74-78`）。当前被 `level=error` 阈值吃掉（F9），**不是**正向信号 | 「链路心跳」 |
| **asar / asarUnpack** | Electron 打包归档与「必须保持物理文件」清单（`desktop/package.json:330-345`）。`@sentry/*` 是纯 JS → 留在 asar 内，靠 Electron 的 fs patch 解析 | ——（内部） |
| **打包外置依赖** | `tsdown.config.ts:42-52` 的 `external` 列表；`@sentry/node` 在其中（`:47`）→ 产物里是 `import * as SentryNode from "@sentry/node"`，运行时必须在 asar 内可解析 | ——（内部） |
| **afterPack 门禁** | `desktop/scripts/verify-packaged-runtime.ts`，electron-builder `afterPack` 钩子（`desktop/package.json:346`），签名前拦截不完整产物 | ——（内部） |
| **R1（客户端状态上报）** | 本方案新增：客户端把 error-reporting 的初始化状态回传服务端，供 webadmin 展示 | 「客户端上报状态」 |
| **R2（发送测试事件）** | 本方案新增：管理员点一下，**服务端**代发一条测试事件到 DSN | 「发送测试事件」 |
| **H 编号** | REQUEST §3 的未解释假设 H1–H4；**H5** 为本轮新发现（崩溃退出竞态） | ——（内部） |

---

## 2. 现状核实（逐文件亲自打开，行号已核对）

> 核对方式：`read` 全文 + `sed -n` 定位 + `grep -n`；打包产物用 `@electron/asar` 列表/抽取 +
> 真 Node `require()` 实测。凡与需求书不一致处标 `⚠️ 需求书更正`。
>
> **⚠️ 行号免责标注（修复轮 1，F-15）**：本文所有 `文件:行号` 都是**勘察/复核时快照**（HEAD =
> `39692cac6e`，工作区尚未落地本轮改动）。其中至少两处经复核实测已失准并已就地更正
> （`LEVEL_RANK` 的 `:46`→`:99`、自检消息的 `:74-78`→`:174`）。**引用时一律按锚点定位**
> （函数名 / 唯一字符串 / 唯一代码片段），行号只作为"当时大概在哪"的线索；源码改动后行号必然位移。

> **本文引用的外部文件（按可点击句柄索引）**：`REQUEST.md`、`EVIDENCE-ADDENDUM.md`、`DECIDED.md`
> 均为本轮编排的**工作稿文件名**（在未跟踪的黑板目录里，故不给链接）；
> 下文 `PLAN.md` = 本文件，`IMPLEMENTATION.md` =
> [实施计划](2026-09-16-glitchtip-error-collection-implementation.md)，`TASKS.md` = 黑板任务清单。
>
> **⚠️ 未跟踪目录说明（修复轮 1，F-16）**：本轮协作黑板 `.multiagent/glitchtip-collect-fix/`
> **不在版本库中**（`git check-ignore` exit 1、未被跟踪），所以本文**不提供**指向它的链接 ——
> 那些链接在提交后必然 404。它在提交前承载 `REQUEST.md`（需求书 + 现场事实 F1–F9）、
> `EVIDENCE-ADDENDUM.md`（实测补充 F10–F13）、`DECIDED.md`（拍板结果）、`TASKS.md`（勾选清单）；
> **结论性内容已分别落在**：[决策记录](../decisions/2026-09-16-glitchtip-error-collection.md)（D1–D9/AC1–AC15）、
> [实施计划](2026-09-16-glitchtip-error-collection-implementation.md)（任务分解 + 实际验证记录）、
> [运维手册](../deploy/2026-09-16-glitchtip-selfhost-operations.md)（现场事实与修法）。
> 正文里出现的 `REQUEST.md` / `DECIDED.md` / `TASKS.md` 一律按**当时的黑板文件名**理解。

### 2.1 客户端错误上报插件 — `packages/host/enterprise/src/error-reporting.ts`（132 行）

| 位置 | 实际代码形态 | 命中什么 |
|---|---|---|
| `:6-8` | **静态** `import * as SentryNode from '@sentry/node'`；注释明写「动态 import 会被 tsdown 拆 chunk 导致运行时解析挂起——已加日志确认 dsn 拿到后 init 卡住」 | H1 的爆炸半径：静态 import 抛错 = **整个模块加载失败**，连 `console.warn` 都没有 |
| `:36-37` | 模块级 `let sentry: SentryModule \| null`（`SentryModule` 只声明了 `close`） | 无状态导出、无法被上层观测 |
| `:46` | `LEVEL_RANK` | 等级语义真源 |
| `:48` | `initSentry(dsn, release, level = 'error'): Promise<void>` | 返回 `void` → 失败信息无法外传 |
| `:49-55` | 重 init 前 `sentry.close(0)` —— **timeout 传 0（不等待冲刷）** | 重 init/登出会丢缓冲区事件 |
| `:56-57` | `if (!normalized) return`（空 DSN 静默返回，**不记录状态**） | 静默点 ① |
| `:60-72` | `mod.init({ dsn, release, beforeSend })` | 真正的 sentry init |
| `:65-69` | `beforeSend` 是**纯等级过滤**（无 tag 例外、无采样） | D4 必须在不破坏它的前提下加心跳 |
| `:73-78` | `sentry = SentryNode`，随后 `captureMessage('客户端已启动…', 'info')` 自检 | 现有的唯一"正向信号"，被 F9 的阈值吃掉 |
| `:79-83` | `catch (cause) { console.warn('error-reporting: Sentry init 失败(降级不启用):', cause); sentry = null }` | F7 的静默点：GUI 应用里 `console.warn` = 无人可见；**且状态无处可查** |
| `:87-132` | `apply(ctx)` | 插件入口 |
| `:90` | `ctx.logger?.debug('error-reporting: plugin applied')` | **debug 级**，而桌面默认日志阈值是 `info`（`desktop/src/index.ts:88`、`main.ts:359`）→ **默认不落盘** |
| `:95-117` | `sync(session)` | 同步逻辑 |
| `:102` | `const { config } = await getBootstrap(session)` —— **`fellBack` 被丢弃** | ⭐ 见 §2.6，本轮最重要的发现之一 |
| `:105-110` | `enabled = web?.error_reporting_enabled === true`；false → `initSentry('', release)` | `web:{}` 时落在这里 → 完全静默 |
| `:106` | `ctx.logger?.debug('…dsn from bootstrap', 'configured'\|'disabled/empty')` | **debug 级 → 默认看不到**；且不含 host，无法定位 |
| `:111` | `initSentry(web?.error_reporting_dsn ?? '', release, web?.error_reporting_level ?? 'error')` | 正常路径 |
| `:112-116` | `catch { console.warn('[error-reporting] bootstrap 失败,不上报:', cause); ctx.logger?.warn?.(…) }` | H3 的吞点：**这条是 warn，会落盘**——但只有真的抛错才触发 |
| `:126-131` | 注释记录「裸 `ctx.on` + 1s×60 轮询」已删除，改用 `subscribeSession` | 与 2.5 节一致 |

### 2.2 单测 — `packages/host/enterprise/tests/error-reporting.spec.ts`（89 行）

- `:6-15` `vi.hoisted` + `vi.mock('@sentry/node', …)`：mock 只有 `init`/`captureMessage`，**没有 `close`**。
- 7 个用例：`:27` 空 DSN no-op、`:34` dsn/release/beforeSend、`:45` 自检消息、`:52` warning 阈值、
  `:65` 未知等级回落 error、`:75` 默认 error 阈值、`:83` 重 init 不抛。
- ⚠️ **`:83-88` 明确断言 `resolves.toBeUndefined()`** → 一旦把 `initSentry` 改成返回状态对象，
  这个用例必红（实施计划里的适配点，见 IMPLEMENTATION T3.2）。
- 缺口：**没有任何**「init 抛错时行为」用例（`:79-83` 的 catch 分支零覆盖）、没有「bootstrap 失败」用例
  （`:112-116` 零覆盖）、没有「`web:{}`/`fellBack`」用例。

### 2.3 构建外置清单 — `packages/host/enterprise/tsdown.config.ts`（90 行）

- `external` 在 `:42-52`，其中 `'@sentry/node'` 在 **`:47`**（另有 `@sentry/core`/`utils`/`types` 与 `electron`）。
- 产物形态已实测确认（见 §2.9）：`import * as SentryNode from "@sentry/node";` 原样保留。

### 2.4 组合行 — `packages/host/enterprise/cordis.patch.yml`（55 行）

- `:14-15`：`- id: picoaide-error-reporting` / `name: '@picoaide/dsh-enterprise/error-reporting'` ✅ 存在且未被
  任何 `disabled` 覆盖（对比 `:26-27` 的 `ui-settings-models` 是显式 disabled）。
- 桌面 profile 合成确实加载企业 overlay：`desktop/src/profile.ts:60` 解析
  `@picoaide/dsh-enterprise/package.json` 旁的 `cordis.patch.yml`，`:516` 读入，`:528` 入列。

### 2.5 会话事件时序 — `packages/host/enterprise/src/session-service.ts`（223 行）

- `:29` `SESSION_CHANGED_EVENT = 'pico/session-changed'`。
- `:52-61` `subscribeSession(ctx, listener)`：`:56` 先 `ctx.on`，`:59` 再判 `ctx.picoSession.isRestored()`
  → true 时**补发一次** `getSession()`。注释 `:31-47` 说明根因（`restore()` 在构造期跑，事件可能早于
  插件 `apply`）与判据（`isRestored()` 在 `restore()` 的 `finally` 里置位，事件在那之前 emit）。
- `:103-114` 构造函数：`:113` `void this.restore().finally(() => { this.restoreDone = true })`。
- `:134-147` `setSession`：`:146` `emit(SESSION_CHANGED_EVENT, session)`；`:142-145` 持久化失败只 warn。
- `:149-154` `clear()`：`:153` emit `null`。
- `:156-161` `restore()`：`:157` `await loadPersisted`，`:158` 若期间 `setSession` 已发生则**不覆盖**，
  `:159-160` 赋值并 emit。
- **结论**：补发逻辑成立，`subscribeSession` 的时序竞态**当前已闭合**。残留缺口（非本轮修复项）：
  启动期/登录前的崩溃永不上报（没有 session 就没有 DSN）。

### 2.6 bootstrap 消费 — `packages/host/enterprise/src/server-connector/bootstrap.ts`（19 行）

```ts
:4   export const EMPTY: BootstrapConfig = { default_model: '', models: [], skills: [], mcp: [], web: {} }
:6   export function validateBootstrap(cfg) {
:7     if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.models) || cfg.models.length === 0)
:8       return { config: EMPTY, fellBack: true }        // ← web 段被整体丢弃
:10    if (cfg.models.some(m => m.id === cfg.default_model)) return { config: cfg, fellBack: false }
:13    return { config: { ...cfg, default_model: cfg.models[0]!.id }, fellBack: true }
:16  export async function getBootstrap(session) { … }
```

⭐ **这是本轮勘察发现的最强静默路径**：只要服务端 bootstrap 的 `models` 为空（或形状不合），客户端就把
**整份**配置换成 `EMPTY`（`web: {}`），于是 `error-reporting.ts:105` 的 `enabled === true` 为假 →
`initSentry('')` → 静默返回（连 `console.warn` 都没有，`:106` 的 debug 日志默认不落盘）。
服务端明明下发了正确的 DSN（F3/F4），客户端却一个字节都不发。

> **待一次性只读判定**：生产 `GET /api/client/v2/config/bootstrap` 的 `models` 是否非空。
> 判定方式（只读）：带客户端 token 的 curl，或 `SELECT value FROM settings WHERE key='gateway.default_model'`
> 与模型表行数。**结论会改变 H3 的排序**（见 §3.5）。

### 2.7 桌面打包清单 — `packages/host/desktop/package.json`（528 行）

- `:314` `"build"` 段；`:330-332` `asar.smartUnpack=false`；`:333-345` `asarUnpack`（只有 `*.node`/`*.dll`/
  `*.so*`/`ripgrep`/`landlock-run`/`node-pty` prebuilds —— **不含** 任何 `@sentry` 规则，符合预期：
  `@sentry/*` 是纯 JS，应当留在 asar 内）。
- `:346` `"afterPack": "./scripts/verify-packaged-runtime.ts"`。
- `:356-423` `files`：白名单 + 一长串 `!node_modules/...` 排除（shiki/katex/mermaid/d3/…），
  **没有任何一条排除 `@sentry` 或 `@picoaide/dsh-enterprise`** → `@sentry/node` 作为
  `@picoaide/dsh-enterprise` 的 prod dependency 正常进包。
- `:283-287` desktop 的 workspace 依赖含 `@picoaide/dsh-enterprise`。

### 2.8 打包后验证链 — `packages/host/desktop/scripts/verify-packaged-runtime.ts`（1088 行）

| 位置 | 内容 | 与本需求的关系 |
|---|---|---|
| `:44-95` | `REQUIRED_PACKAGED_RUNTIME_ENTRIES`（asar 内必需条目） | 只有 desktop 自身产物；**无任何 enterprise 插件行** |
| `:98-121` | `REQUIRED_UNPACKED_RUNTIME_ENTRIES`（必须物理存在的原生条目） | 与 sentry 无关 |
| `:576-596` | `REQUIRED_ASAR_EXPORTS` | ⚠️ **缺口**：含 `session-service`/`auth-gate`/`gateway-model`/`bootstrap`/`client`，
  **不含 `error-reporting`**（也不含 `skill-telemetry`/`channel-sync`/`invariant`），**不含任何 `@sentry/*`** |
| `:604-616` | `verifyUnpackedPackageResolution` | 只做**条目存在性**断言 |
| `:857-1063` | 现成的「打包后可执行」smoke 范式：`FLOCK_SMOKE_SCRIPT`（`:874-906`）+ `smokePackagedFlockLock`（`:999-1063`），
  用打包后的 Electron 以 `ELECTRON_RUN_AS_NODE=1` 跑一段脚本、要求 stdout 出现成功标记 | ⭐ **新断言应挂在这里**（照抄该范式，见 IMPLEMENTATION T4） |
| `:1073-1088` | `afterPack()`：`verify()` → `smoke()`（诊断 worker）→ `flockSmoke()` | 新 smoke 加在 `:1087` 之后 |
| — | `tests/verify-packaged-runtime.spec.ts`（31 KB）存在，`check:win-package` 已跑它 | 新用例的家 |

**⇒ H1 类故障（插件行或 SDK 没进包）当前**在任何门禁里都不会被发现**。**

### 2.9 打包产物实测（只读）

- 本机既有产物 `packages/host/desktop/dist/linux-unpacked/resources/app.asar`（**2026-09-01 构建，package.json version = 2.5.7**）：
  - `@sentry/node`、`@sentry/core`、`@sentry/utils`、`@sentry/types`、`@sentry/integrations`、
    `@sentry-internal/tracing`、`tslib`、`cookie`、`https-proxy-agent` **全部在 asar 内**，`@sentry/node/cjs/index.js` 在。
  - 把 asar 解到物理目录后，**用真 Node `require('@sentry/node')` 成功**：
    `typeof init === 'function'`，version **7.120.4**；`@picoaide/dsh-enterprise/error-reporting` 亦可解析，
    导出 `{ apply, initSentry, inject, name }`。
  - ⚠️ **但这份产物里的 `lib/error-reporting.js` 是旧版**（裸 `ctx.on` + `setInterval` 1s×60 轮询），
    且 asar 内还带着 `src/`、`tests/`、`docs/`、`COVERAGE-MATRIX.md` —— **本地产物不能外推到生产**。
- `.glitchtip-recon/asar-x/`（别人解出来的目录）：我核对过它与上述本地产物 asar 内的
  `lib/error-reporting.js` **sha256 完全一致**、`package.json` version=2.5.7 ⇒
  ⚠️ **需求书更正**：`asar-x/` 来自**本地 2.5.7 旧产物**，**不是**生产 2.7.5-beta.2 产物。
- **生产 2.7.5-beta.2 发布树：本轮已一手验证通过**（下载在我勘察期间完成，`app.AppImage` = 152 752 897 字节，
  与生产 `ls -la` 一致）。我在解包树 `.glitchtip-recon/artifact/shipped/`（`package.json` version = **2.7.5-beta.2**）
  上亲自跑了两条解析测试：
  ```
  require('@sentry/node')            → OK, version 7.120.4, typeof init = 'function'
  import '@picoaide/dsh-enterprise/error-reporting'
                                     → OK, exports = apply,initSentry,inject,name
  ```
  ⇒ **H1 在生产产物上被直接证伪**（与 EVIDENCE-ADDENDUM.md 的 F10 独立互证，结论一致）。
- ⚠️ **注意区分三份产物**：`artifact/shipped/`=生产 2.7.5-beta.2（**权威**）；
  `artifact/asar-x/` 与 `dist/linux-unpacked/`=本地 2.5.7 旧构建（其 `lib/error-reporting.js` 是旧的
  裸 `ctx.on` + 1s×60 轮询版本，**不能用于任何结论**）。

### 2.10 生产客户端的源码形态（用 git 代替拿不到产物）

```
$ git merge-base --is-ancestor 69cae0d6cc v2.7.5-beta.2   → 通过
$ git diff v2.7.5-beta.2 HEAD -- packages/host/enterprise/src/error-reporting.ts session-service.ts  → 空
```

⇒ **生产 2.7.5-beta.2 跑的就是当前 HEAD 的源码形态**（`subscribeSession` 补发已在其中）。
`69cae0d6cc`（2026-09-11「渠道 logo 裂图 —— 素材 URL 绝对化 + 窗口 CSP 放行 + 启动期会话同步竞态」）
已进入 `v2.6.9-beta.3` 起的全部 tag。

### 2.11 webadmin 错误监控页

`server/webadmin/src/pages/ErrorMonitoring.tsx`（166 行）：

- `:52-83` `save()`；`:55-58` **唯一**的 DSN 校验是 `/^https?:\/\//i` ⇒ `http://key@localhost:8000/1` 照收
  （F7 已核实，行号确认）；`:59-62` `glitchtip_base_url` 同样只校验协议。
- `:66-75` PUT `{ADMIN_API}/gateway`，只提交错误监控域五个字段；`:77` `setOkMsg('已保存')`。
- `:110-113` DSN 输入框（`id="error-reporting-dsn"`，label 文案被测试用作查询锚点）；
  `:117-125` 等级 Select（**无 fatal 选项**，与 `LEVEL_RANK` 有 fatal 但 UI 不产生一致，非本轮问题）；
  `:162` 保存按钮。
- `ErrorMonitoring.test.tsx`（81 行）4 个用例：`:24` 回填、`:34` 仅提交错误监控域、`:60` 非法 DSN 校验、
  `:69` 关闭开关。`:65` 逐字断言中文文案 ⇒ 改动文案必须同步测试。

### 2.12 服务端网关配置读写 — `server/internal/llmgateway/admin.go`（1053 行）

| 位置 | 内容 |
|---|---|
| `:37-39` | `auditSetSetting(db, key, label, value, &changes)`：写 settings + 记旧→新（审计链） |
| `:771-798` | `getGatewayConfig`：`:791-795` 回显 `error_reporting_dsn/enabled/level` + `glitchtip_*` |
| `:838-848` | `setGatewayConfig` 请求结构：`:844-848` 五个 `*string`/`*bool` 指针字段（**缺省 null 不覆盖**） |
| `:862-880` | 已有校验范式：`peak_windows` 非法即 400、`default_model` 必须在启用模型内、`rate_limit` 正整数 |
| `:921-927` | DSN 写入 —— **当前零校验**（F7 的服务端半边） |
| `:928-935` | enabled 写入（`strconv.FormatBool`） |
| `:936-946` | level 写入 + **已有白名单** `""|error|warning|info|debug`（**无 fatal**，与 UI 一致） |
| `:947-952` / `:953-958` | `glitchtip_base_url` / `glitchtip_organization` 写入（均零校验） |

> 所有写路径都走 `auditSetSetting` ⇒ 新增校验只要放在对应 `if req.X != nil` 块**之前**，
> 拒绝时天然不会留审计噪音（也不会写库）。

### 2.13 bootstrap 下发 — `server/internal/bootstrap/bootstrap.go`

- `:20-38` `WebConfig` 结构体（json tag 与客户端 `BootstrapConfig.web` 对齐）；
  `:43-58` `Response`（`models`/`web`/`connectors`/`server_version`）。
- `:159-176` web 段组装：`:161` dsn、`:163` `settings[...] == "true"`、`:164-168` level（空→`error`）、
  `:170-171` glitchtip 两项、`:173-176` thinking level（白名单 `off|low|high|max`）。
- `:198` 装入 `Response.Web`。路由挂在 `server/internal/router/router.go:149`
  （`cli.GET("/config/bootstrap", BearerAuth, d.Bootstrap.Bootstrap)`）。
- ⇒ **服务端下发路径无缺陷**（与 F3/F4 一致）。加新字段（如心跳开关）只需在此处加一行。

### 2.14 路由唯一真源 — `server/internal/router/router.go`（393 行）

- `:38` `NamespaceServer = "/api/server"`；`:40` `NamespaceClientV2 = "/api/client/v2"`（**禁止旧前缀**）。
- `:72` `cli := r.Group(NamespaceClientV2, …)`；`:73` `srv := r.Group(NamespaceServer, …)`。
- `:131` `cli.Group("/auth")`；`:149` bootstrap；`:171-194` marketplace/shared/agent-presets/capabilities/
  **`:194` `cli.POST("/telemetry/skill-call", BearerAuth, d.Telemetry.ReportSkillCall)`**。
- `:228` `sg := srv.Group("/admin")`；`:235` `authed := sg.Group("", AdminAuth(d.DB))`。
- `:291-292` `GET/PUT /gateway`（`PermGatewayRead` / `PermGatewayWrite`）；`:293+` 网关其余端点；
  `:274` `POST /auth/test`（`PermAuthWrite`）——**「测试连接」类端点的既有先例**。
- 所有生产路由必须经 `Register(r, Deps)` 集中声明（`server/AGENTS.md` §7.0），业务包**不得**自行 `r.Group()`。

### 2.15 遥测范式（客户端→服务端的既有通道）

- `server/internal/telemetry/routes.go:43-49` `RegisterRoutes`（测试用）+ `handlers.go:16-27`
  `Handlers`/`NewHandlers` 暴露面；`:59-117` `reportSkillCall`（Bearer + 参数上限 + 双桶限流 `:28-32`
  + 「未知目标静默成功」的非致命语义）。
- 客户端侧对拍：`packages/host/enterprise/src/skill-telemetry.ts`（`inject=['picoSession','tools']`，
  用 `fetchJSON(session.serverURL, '/api/client/v2/telemetry/skill-call', {token})`，失败静默、不重试）。
- ⇒ **D1 的客户端状态上报应复用这条通道的形态**，不要另造一套。

### 2.16 出站安全护栏（D2/D3 的关键约束）

- `server/internal/util/netguard.go`：`:1-9` 包注释明确 **「允许私网（企业内网自建 LLM 网关是产品主要场景）」**；
  `:38-56` `IsBlockedOutboundIP` 只拦**链路本地 / 云 metadata / unspecified**，**环回与私网不在列**；
  `:100` `SafeOutboundTransport()`（含代理感知复检 `:111-133`）、`:140` `CheckOutboundTarget`。
- 服务端连接器策略**唯一源**：`server/internal/serverstore/connectors.go:379-420`（含 `TestConnectorBlockedNetworksMatchClientOutbound` 跨语言对拍测试）；
  客户端侧 `packages/host/connectors/src/outbound.ts`（`:218` `assertOutboundUrlAllowed`、`:259` `isOutboundUrlAllowed`），
  其模块注释**明确写着**「enterprise 若也学会同一套私网规则，两者应合并为一个共享模块」。
- 客户端服务端地址护栏：`packages/host/enterprise/src/server-connector/auth.ts:86-96` `assertServerURLAllowed`
  （**https，或 http 仅限 loopback**）。
- ⚠️ **设计红线**：**不得**为了让 DSN 拒绝 loopback 而去改 `netguard.go` 的私网策略 ——
  那会同时收紧全部上游/余额/报表出站，属于跨需求破坏。新规则必须落在**错误上报自己的校验函数**里。

### 2.17 宿主的致命异常路径（H5 的证据链）

- `packages/host/desktop/src/main.ts:186` 安装子进程日志；`:191` `exit: code => { app.exit(code) }`；
  `:222-226` `installDesktopUncaughtExceptionLogging(process, electronLogger, requestQuit)`
  —— **在启动期注册**（早于任何登录/`initSentry`）。
- `packages/host/desktop/src/desktop-logger.ts:57-72`：handler 在第一个 `uncaughtException` 上
  `proc.off(...)` → `logger.errorCause(error)` → `exit(1)`（即 `requestQuit(1)` → 优雅退出 → `nativeExit.finish` → `app.exit`）。
- `@sentry/node` 的 `OnUncaughtException` 集成要到 `initSentry`（**登录后**）才 `process.on('uncaughtException', …)`；
  Node 按注册顺序调用 ⇒ 宿主的退出逻辑先跑。Sentry 自己的 `logAndExitProcess`
  （`@sentry/node/cjs/integrations/utils/errorhandling.js`）本来会 `client.close(2000)` 等冲刷，
  但它可能是**来不及被调用**的那一个。
- 全仓 `grep`：`packages/host/enterprise/src/*.ts` 里**只有** `error-reporting.ts:52` 一处 `sentry.close(0)`
  （且 timeout=0 不等等待）⇒ **正常退出/崩溃退出都没有冲刷**。
- `packages/host/desktop/src/index.ts:88` `logLevel` 默认 `'info'`；`main.ts:359` 用该值设置文件阈值。

### 2.18 ⚠️ 需求书更正汇总

| # | 需求书原文 | 实际情况 |
|---|---|---|
| C1 | H1「已抽查本地 `dist/linux-unpacked`（9/1 旧构建）asar」 | 事实成立，但要补一句：`.glitchtip-recon/asar-x/` **就是这个旧产物**（`error-reporting.js` sha256 一致、version=2.5.7），**不是**生产 2.7.5-beta.2 |
| C2 | §6「已下载的现场产物 … `artifact/app.AppImage`（后台下载中）」 | 该下载在勘察期间完成（152 752 897 字节，与生产一致），生产发布树已可验证 —— 见 §2.9 与 EVIDENCE-ADDENDUM.md F10；**H1 因此在生产产物上被直接证伪** |
| C8 | （需求书与 F1–F9 均未提） | **E2E fixture 假绿 + 生产 DSN 硬编码**：`packages/host/desktop/scripts/e2e-fixture-gateway.mjs:57` 在 `web` 段只给了 `error_reporting_dsn`（**生产真值**），**没有 `error_reporting_enabled: true`** ⇒ 客户端 `sync()` 走 `enabled !== true` 分支 `initSentry('')`，**E2E 从来没有验证过错误上报**（假绿）；同时把生产域名+公钥写进受版本控制的源码，与 `error-reporting.ts:16-17`「源码与本地配置不含任何上报地址」的自我约束冲突（该域名 2026-08-27 还专门做过历史清理）。见 §2.19 |
| C3 | F7「`error-reporting.ts:79-83` 把 init 失败降级为 console.warn」 | 行号**正确**；但漏了**同类更严重的静默点**：`sync()` 的 `enabled===false` 分支（`:107-110`）与 `validateBootstrap` 的 `EMPTY` 覆盖（§2.6）——两者连 `console.warn` 都没有 |
| C4 | AC3「客户端上报初始化失败时不再静默（三选一，由规划师拍板）」 | 采纳；但补充一条**当前完全没有覆盖**的失败面：`getBootstrap` 返回 `fellBack=true`（§2.6） |
| C5 | §4.2「静态 import 改惰性/可失败」 | **建议不改**：源码注释（`:6-8`）记录了「动态 import 会被 tsdown 拆 chunk 导致运行时解析挂起」的实测结论，改成惰性加载属于**重新踩已知的坑**；正确做法是"保持静态 external + 打包期断言"（D5） |
| C6 | §2 F1「`GLITCHTIP_EMBED_WORKER=true` 已开」 | 与本轮只读复核一致；`GET /api/0/projects/picoaide/picoaide-web/keys/` 仍返回 `http://…@localhost:8000/1`（F6 复现） |
| C7 | （需求书未提） | 打包产物里还打进了 workspace 包的 `src/`、`tests/`、`docs/`、`COVERAGE-MATRIX.md`（`!src/**` 等排除只对 app 根生效）——体积/信息面问题，**本轮不动**，仅登记 |

### 2.19 E2E fixture 的假绿与地址泄漏（本轮新增核实）

`packages/host/desktop/scripts/e2e-fixture-gateway.mjs`（`e2e:client` 用的 mock 网关）：

- `:45-58` `/api/client/v2/config/bootstrap` 返回 `web: { error_reporting_dsn: 'https://<glitchtip-public-key>@glitchtip.example.com/1' }`
  —— **只有 DSN，没有 `error_reporting_enabled`**（已 `grep` 确认该文件内 `error_reporting_enabled` **零出现**）。
- 客户端侧 `error-reporting.ts:105` 要求 `web.error_reporting_enabled === true` 才 init ⇒
  走 `:107-110` 的 `initSentry('')` 分支 ⇒ **E2E 里错误上报链路从未被激活**，
  而 `e2e:client` 的宣传口径包含错误上报相关面的验证 ⇒ **假绿**（与 §2.8 的门禁缺口同源：
  这条链路的每一道防线都恰好不查它）。
- 同一个字面量把**生产域名 + 生产 public key** 固定在受版本控制的源码里，
  与 `error-reporting.ts:16-17`「DSN 一律由服务端下发,源码与本地配置不含任何上报地址」冲突；
  该域名在 2026-08-27 还专门用 `git filter-repo` 清理过历史泄漏 ⇒ 属于**同一类问题的复发**。
- 处置：**P0-5**（`scripts` 侧去硬编码 + 开 `enabled: true`，改用本地 mock DSN）
  + **P1-6**（让 E2E 真的断言"上报被触发"）。见
  [实施计划](2026-09-16-glitchtip-error-collection-implementation.md)。

---

## 3. 拍板决策摘要

| # | 决策点 | 拍板结果 | 状态 | 对架构的影响 |
|---|---|---|---|---|
| D1 | 客户端 init 失败如何"不再静默" | **结构化日志（P0）+ 状态上报服务端（P1）** 两者都做，分阶段；不做「只写日志」 | **(待拍板)** | D1 后半段引入 1 张表 + 1 个客户端端点 + 1 个管理端点 + 1 个 UI 卡片 |
| D2 | DSN 校验强度 | **硬拒绝 loopback/链路本地/metadata/未指定**；**私网与 http 只告警不阻断**；"保存前真发测试事件"**不采纳**（改为可点按的 R2） | loopback 硬拒绝=已定；私网/http 的宽严 **(待拍板)** | 新增错误上报专属校验函数（**不动 netguard**） |
| D3 | 「发送测试事件」由谁发 | **服务端 Go 代发**（复用 `util.SafeOutboundTransport` + `admin/auth/test` 的范式）；浏览器直发**否决** | **已定（有仓库既有约定支撑）** | 新增 `POST /api/server/admin/gateway/error-reporting/test` + webadmin 按钮 |
| D4 | 正向心跳方案 | **独立 settings 开关 `web.error_reporting_heartbeat`（默认 off）**，心跳事件带 tag **定向绕过** `beforeSend` 等级阈值；**不修改** `error_reporting_level` 语义、不新增等级取值 | **(待拍板)** | 客户端 `beforeSend` 增加一条 tag 例外；服务端 + 客户端 + UI 各加一个字段 |
| D5 | `@sentry/node` 静态 import vs 惰性加载 | **保持静态 external**，靠**打包期 smoke 断言**兜底（照抄 flock smoke 范式）；**不**改惰性加载 | **已定（有仓库既有约定 + 源码实测注释支撑）** | `verify-packaged-runtime.ts` 增加 sentry smoke + `REQUIRED_ASAR_EXPORTS` 补条目 |
| D6 | 改动范围边界 | 见 §3.6；desktop 侧**只允许**动 `scripts/verify-packaged-runtime.ts` 与其 spec（属 AGENTS.md 允许的 "test adaptations in desktop-owned scripts"） | **已定** | 把越界风险显式登记 |
| D7 | 客户端状态上报的落库方式 | **新增 `client_error_reporting_status` 表（迁移 0068，按 user_id upsert）**；备选：写进 `settings` 一个 JSON blob（省一次迁移但混淆配置与运行时状态） | **(待拍板)** | D1 的实施成本主要在这里 |

### 3.1 D1 选项明细

| 选项 | 建议 | 理由 | 影响面 |
|---|---|---|---|
| a) 只把日志从 debug 升到 warn | 采纳（P0） | 零成本、立刻可测；`logLevel` 默认 `info` ⇒ warn 一定落盘。但**解决不了"没人看桌面日志"**——这正是 bug 活了 20 天的原因 | `error-reporting.ts` + spec |
| b) 只上报状态到服务端 | 不单独采纳 | 无 P0 兜底时，上报自身失败仍不可见（鸡生蛋） | —— |
| c) a + b | **建议** | a 保证单机可诊断，b 保证管理员在 webadmin 一眼看到「N 个客户端已启用 / M 个失败（最近原因）」 | 见 D7 |

### 3.2 D2 选项明细

| 选项 | 建议 | 理由 |
|---|---|---|
| 仅拒绝 loopback/`::1`/`localhost` | 不够 | 云 metadata（`169.254.169.254`）与 unspecified 同样必然失败，且是 SSRF 面 |
| 拒绝 loopback + 链路本地 + metadata + unspecified（**复用 `netguard.IsBlockedOutboundIP` 的语义**） | **建议（硬拒绝）** | 这些地址**从客户端视角**永远不可能指向真实 GlitchTip；F6 的 `localhost:8000` 正是这一类 |
| 同时拒绝私网（10/8、172.16/12、192.168/16） | **不采纳（只告警）** | 违反仓库既有判断：`netguard.go:5` 与 `outbound.ts` 模块注释都明确"企业内网自建"是主场景；内网自建 GlitchTip 完全合法。**UI 给黄色提示**，让管理员自己判断 |
| 同时拒绝 http | **不采纳（只告警）** | 内网自建无 TLS 的场景真实存在；且客户端的 CSP/同源不适用于主进程上报 |
| 保存时**强制**真发测试事件 | **不采纳** | 把"能否保存配置"绑死在网络可用性上（GlitchTip 可能正在部署/重启），会拦住合法保存。改为**显式点按**的 R2（D3） |
| 服务端 + webadmin 双侧校验 | **建议** | 服务端是权威（绕过 webadmin 直接 PUT 也拦得住）；webadmin 侧是体验（即时中文报错、不发无谓请求）。二者规则必须一致 + 对拍测试（T9） |

### 3.3 D3 选项明细

| 选项 | 建议 | 理由 |
|---|---|---|
| 浏览器直发（前端 fetch/Sentry browser SDK） | **否决** | ① webadmin 由服务端同源提供，窗口 CSP `connect-src` 不应为第三方放开（2026-09-11 那次「CSP 放行」的教训）；② 会把 DSN 交给浏览器网络栈并留下跨域预检/混合内容问题；③ 失败原因（DNS/TLS/连接）在浏览器里被 CORS 抹平，**给不出可读原因**（AC3 要求区分 DNS/连接/HTTP 4xx/5xx） |
| 服务端 Go 代发 | **建议** | ① 复用 `util.SafeOutboundTransport()`（已有 metadata/DNS-rebinding 复检、代理感知）+ `CheckOutboundTarget`；② 能拿到真实错误分类（Go 的 `net.DNSError`/`url.Error`/TLS 错误/HTTP 状态）；③ 有现成范式 `POST /api/server/admin/auth/test`（`router.go:274`，`PermAuthWrite`） |
| **必须写清的局限** | —— | 服务端代发证明的是**服务端视角**的连通性，**不**等于员工桌面的连通性（出口防火墙/DNS 可能不同）。所以 UI 文案与返回体要明确标注「服务端视角」，并用 R1（D1 的客户端状态上报）作为客户端侧的正面证据。**审计一定会打这一条，必须自己先说** |

### 3.4 D4 选项明细

| 选项 | 建议 | 理由 |
|---|---|---|
| 改 `error_reporting_level` 的取值范围/默认 | **否决** | REQUEST §5 硬红线：不得动等级阈值语义；且 `admin.go:936-946` 与 webadmin Select 的白名单已一致（无 fatal），改它会引起跨端不一致 |
| 把现有 info 自检**无条件**放行 | **否决** | 等于让 `error_reporting_level=error` 的部署每客户端每次启动都收一条 info，悄悄破坏运维的降噪意图 |
| 新增 `web.error_reporting_heartbeat`（布尔，默认 false），为 true 时发一条**带 tag** 的心跳并**仅对带 tag 的事件**绕过阈值 | **建议** | ① 默认行为与今天完全一致（零回归）；② 语义写成"心跳不受等级阈值限制"并写进 UI 文案，是**显式、可审计**的例外；③ 普通事件仍走原 `beforeSend` 纯等级过滤 ⇒ `error_reporting_level` 语义**未被改变** |
| 心跳用 `captureMessage(..., 'error')` 冒充 | **否决** | 污染错误计数与告警规则 |
| 完全不要 GlitchTip 事件，只在 webadmin 显示"最近一次上报时间"（由 R1 提供） | 采纳为**默认**（P1） | 零噪音、零语义风险，且证明的是**真正出问题的那一段**（配置下发 + 客户端 init） |
| 心跳的落地形态 | 复用现有自检消息 + 一个新 tag（不是新文案），并加"每进程只发一次"守卫 | 避免每次登录/登出都重复上报 |

> **结论**：D4 = 「R1 的最近上报时间」为默认可见性 + 「`error_reporting_heartbeat` 开关」为可选端到端证明。
> 两者都**不**触碰 `error_reporting_level` 的既有语义。

### 3.5 假设判定（H1–H4 + 新增 H5/H6）

| # | REQUEST 的假设 | 判定 | 依据 |
|---|---|---|---|
| **H1** 插件没被加载 / `@sentry/node` 解析失败 | **已证伪（在生产发布树上直接验证）** | 我在 `.glitchtip-recon/artifact/shipped/`（version = **2.7.5-beta.2**，AppImage 152 752 897 字节与生产一致）上亲手跑通 `require('@sentry/node')`（7.120.4，`typeof init === 'function'`）与 `import '@picoaide/dsh-enterprise/error-reporting'`（导出 `apply,initSentry,inject,name`）；EVIDENCE-ADDENDUM F10 用同一棵树真发事件也成功（`PICOAIDE-WEB-D`）。**但是**：`REQUIRED_ASAR_EXPORTS` 压根没有 `error-reporting`/`@sentry/*` 条目 ⇒ 下次打包漏了也**全绿**（§2.8）⇒ T4 仍必做 |
| **H2** 只在登录后 init / `setSession` 不触达插件 | **证伪（作为当前根因）** | `subscribeSession` 补发（`session-service.ts:52-61`）已在 `69cae0d6cc` 落地，且 `git merge-base --is-ancestor 69cae0d6cc v2.7.5-beta.2` 通过、`git diff v2.7.5-beta.2 HEAD` 对该两文件为空 ⇒ 生产客户端跑的就是修好的形态。**残留真实缺口**：启动期/登录流程本身的崩溃永远不上报（无 session 即无 DSN）——这是设计取舍，本轮不改，但要写进文档 |
| **H3** `sync()` 里 bootstrap 抛错被吞 | **可能性下调；但发现同类更强的静默路径** | 真正的吞点在 `validateBootstrap`：`models` 为空/形状不合 ⇒ 整份配置替换为 `EMPTY`（`web: {}`，`bootstrap.ts:4,6-8`），而调用方 `error-reporting.ts:102` **丢弃 `fellBack`** ⇒ `enabled===false` ⇒ `initSentry('')` ⇒ **连 warn 都没有**。另一条 F4 未覆盖的失败面：`getBootstrap` 抛 `AuthError('network')`/非 JSON 响应时走 `:112-116`（这条是 warn，**会**落盘） |
| **H4** 真的只是没发生过 error 级事件 | **最可能，且被两个机制放大（F11/F12 已把它们从推断升为实测）** | ① 插件**只覆盖主进程**（`@sentry/node` 在主进程 init；`error-reporting.ts:43` 注释自认"渲染进程采集后续阶段接入"，此后再无下文；F12 实测发布树里**没有** `@sentry/browser`、源码里**没有** `window.onerror`/`unhandledrejection` 采集）⇒ 用户可见的绝大多数错误（UI/渲染进程）**结构上不会进 GlitchTip**；② F11 实测：`level=error` 下 `info` 心跳被 `beforeSend` 丢弃（查无此 issue）、`error` 事件 5 秒入库 ⇒ **链路完全健康时后台也一条都没有**，H4 在当前架构下**不可证伪**——这本身就是缺陷 |
| **H5**（本轮新增）主进程致命异常在**退出竞态**中丢失 | **高可能，且直接解释"连崩溃都没收到"（唯一新识别的真实丢失机制）** | `main.ts:222` 在**启动期**注册宿主 `uncaughtException` handler（`desktop-logger.ts:63-69` 立即 `exit(1)`→`requestQuit`→`nativeExit.finish`→`app.exit`）；Sentry 的 `OnUncaughtException` 要到**登录后** `initSentry` 才注册 ⇒ Node 按注册顺序先跑宿主退出；Sentry 的 `logAndExitProcess`（本应 `client.close(2000)` 等冲刷）可能根本没机会执行。且**全仓无任何退出时 `Sentry.close()`**（唯一的 `close(0)` 在 `error-reporting.ts:52`，timeout=0 不等等待） |
| **H6**（本轮新增）E2E 假绿：上报链路从未在自动化里被激活 | **已确认** | `e2e-fixture-gateway.mjs:57` 只给 DSN、未给 `error_reporting_enabled: true` ⇒ 客户端走 `initSentry('')`（§2.19）。这意味着"改坏了也没有回归防线"，与 §2.8 的门禁缺口叠加 |

**综合判断（按可能性排序）**：

1. **H4（叠加"只采主进程"的覆盖面缺口）** —— 最能解释"20 天零真实错误"（F11/F12 已把机制实测钉死），且与所有已核实事实相容。
2. **H5（崩溃退出竞态 + 从不 close）** —— 最能解释"连崩溃都没收到"，是本轮**唯一新识别的真实丢失机制**。
3. **H3′（`validateBootstrap` 把 `web` 换成空）** —— 只需**一次只读查询**即可证实/证伪（生产 bootstrap 的 `models` 是否非空），判定成本极低，**编码前先做**。
4. **H6（E2E 假绿）** —— 已确认，是"改坏了也发现不了"的根因之一，与 §2.8 门禁缺口叠加。
5. **H1** —— **已证伪**（生产发布树一手验证），但门禁无背书，所以 T4（打包断言）无论如何都要做。
6. **H2** —— 已修复，非根因。

> **对"本轮到底修什么"的含义**：用户的诉求是"收集不到内容"。既然最可能的解释是
> **"没有可收集的 + 有也丢了 + 丢了也没人知道"**，那么本轮的交付物主体必然是
> **入口校验 + 可观测性 + 打包防线**（P0/P1），而**不是**改上报调用链。
> 任何声称"改一行就让 GlitchTip 开始收数据"的方案都与现有证据不符，必须拒绝。

### 3.6 D6 改动范围边界（逐条）

**必须动（P0/P1）**

| 文件 | 改动性质 |
|---|---|
| `packages/host/enterprise/src/error-reporting.ts` | 状态导出 + 日志升级 + 心跳（不碰明文 DSN 日志） |
| `packages/host/enterprise/tests/error-reporting.spec.ts` | 用例适配 + 新增 |
| `server/internal/llmgateway/admin.go`（+ 新 `dsn.go`/`dsn_test.go`） | DSN 校验 + 测试事件端点 |
| `server/internal/router/router.go`（`:291-292` 区域） | 集中声明新路由（唯一真源） |
| `server/webadmin/src/pages/ErrorMonitoring.tsx` + `ErrorMonitoring.test.tsx` | 校验 + 按钮 + 状态卡片 |
| `packages/host/desktop/scripts/verify-packaged-runtime.ts` + `packages/host/desktop/tests/verify-packaged-runtime.spec.ts` | 打包断言（**desktop 侧唯一改动点，属 AGENTS.md 允许的 test adaptation**） |
| `server/internal/bootstrap/bootstrap.go`（仅当 D4 采纳） | 下发心跳开关 |
| `server/internal/telemetry/*`、`server/internal/serverstore/*`、迁移 `0068`（仅当 D1/D7 采纳） | 状态上报通道与落库 |
| `docs/**` | 蓝图/实施/决策/运维纠偏/release notes |

**绝不能动（红线）**

- `deepseek-harness/`（上游 submodule，pin `dsh-v0.1.5-rc.2` = `fb2c4b9e`）。
- `server/internal/util/netguard.go` —— 它的"允许私网"是**跨需求**的既定策略（网关上游/余额/报表共用）；
  为其加 loopback 拦截会波及其他出站面。新规则写在错误上报自己的校验函数里。
- `error-reporting` 的既有语义：`error_reporting_level` 的阈值含义、DSN 一律服务端下发、
  源码/本地配置不含任何上报地址。
- `packages/host/desktop/package.json` 的 `build.files` / `asarUnpack`（`@sentry/*` 本来就该留在 asar 内；
  加 `asarUnpack` 反而会踩 `listUnpackedUnsafeJs` 的「JS 泄漏到物理树」门禁 `verify-packaged-runtime.ts:741-746`）。
- 其他服务包（connectors/browser/cron/account-card）与品牌素材。
- 生产环境（生产主机、GlitchTip 实例）：**只读**，一切运维纠正走文档交付给人工。
  （具体主机地址**只允许出现在运维手册** `docs/deploy/2026-09-16-glitchtip-selfhost-operations.md`；
  设计文档不记录内部地址。2026-09-17 审计修复。）

---

## 4. 设计

### 4.1 数据流（现状 + 失败面标注）

```
┌─────────────┐   PUT /api/server/admin/gateway      ┌──────────────────────────────┐
│  webadmin   │ ───────────────────────────────────▶ │ server/internal/llmgateway   │
│ ErrorMonitor│   {error_reporting_dsn, enabled,     │  admin.go:921  ← ✗ 零校验(F7) │
│  :55 只查协议│     level, glitchtip_*}              │  → auditSetSetting → settings│
└─────────────┘                                      └──────────────┬───────────────┘
        ▲                                                           │ web.error_reporting_*
        │ GET /gateway (回显 :791-795)                               ▼
        │                                              ┌──────────────────────────────┐
        │                                              │ internal/bootstrap           │
        │                                              │  bootstrap.go:159-176 组装   │
        │                                              │  router.go:149 下发          │
        │                                              └──────────────┬───────────────┘
        │                                                             │ GET /api/client/v2/config/bootstrap
        │                                                             ▼ (F4: 200 OK)
        │                                              ┌──────────────────────────────┐
        │                                              │ 客户端 server-connector       │
        │                                              │  bootstrap.ts:6 validateBootstrap
        │                                              │  ← ✗✗ models 为空 ⇒ EMPTY(web:{}) │  ★§2.6
        │                                              └──────────────┬───────────────┘
        │                                                             │
        │                            subscribeSession(session-service.ts:52-61，已修)
        │                                                             ▼
        │                                              ┌──────────────────────────────┐
        │                                              │ error-reporting.ts:95 sync()  │
        │                                              │  :105 enabled? ──false──▶ initSentry('') ✗静默
        │                                              │  :111 initSentry(dsn, release, level)
        │                                              │      :60 mod.init(...)        │
        │                                              │      :79 catch → console.warn ✗静默(F7)
        │                                              │  :112 catch → warn ✓(会落盘)  │
        │                                              └──────────────┬───────────────┘
        │                                                             │ HTTPS POST /api/1/store/
        │                                                             ▼
        │                                              ┌──────────────────────────────┐
        │                                              │ GlitchTip (glitchtip.example.com)│
        │                                              │  F1 收包可用 / F5 零真实客户端 │
        │                                              └──────────────────────────────┘
        │
        └── 缺口：管理员**没有任何**正向信号能区分「链路好但没错误」与「链路坏了」(F9)
```

**失败面清单（每一条都要有拦它的手段）**

| # | 失败面 | 现状 | 本轮拦截手段 |
|---|---|---|---|
| F-a | 管理员填了必然失败的 DSN（loopback/metadata/非 URL） | 静默接受（`ErrorMonitoring.tsx:55`、`admin.go:921`） | T1 服务端硬拒绝 + T2 webadmin 前置报错 |
| F-b | DSN 指向真实但不可达/证书错/4xx 的地址 | 保存成功、客户端静默降级 | T5 服务端测试事件（分类原因） |
| F-c | `@sentry/node` 或 `error-reporting` 没进打包产物 | 插件整个模块加载失败，**零日志**；门禁全绿 | T4 打包 smoke（afterPack 硬失败） |
| F-d | `getBootstrap` 返回 `fellBack` / `web:{}` | `initSentry('')` **零日志**（★§2.6） | T3 状态机 + warn 日志 + T6 状态上报 |
| F-e | 客户端 init 抛错 | 只有 `console.warn`（GUI 无人可见） | T3 状态 + warn 落盘（默认阈值 info） |
| F-f | bootstrap 网络失败 | 有 warn（`error-reporting.ts:114`）但无聚合可见性 | T3 状态 + T6 上报 |
| F-g | 链路正常但确实没有 error（H4） | 与 F-c/F-e **在后台长得完全一样** | T6 最近上报时间（默认可见）+ T7 心跳开关（可选端到端） |
| F-h | 主进程致命异常在退出竞态中丢失（H5） | 崩溃无事件、无痕迹 | P1-5 先验证后决定（条件性） |
| F-i | 渲染进程/UI 错误从不采集 | 结构缺口（`error-reporting.ts:43` 注释自认；F12 实测无 `@sentry/browser`、无 `window.onerror`） | **本轮不做**（属新功能，登记为后续项，写进文档避免再次误解） |
| F-j | E2E mock 没开 `error_reporting_enabled` ⇒ 上报链路从未被自动化激活（假绿） | §2.19 已确认 | P0-5（开开关 + 去硬编码）+ P1-6（加真断言） |

### 4.2 新增/修改的数据结构

**客户端状态（`error-reporting.ts` 导出，供测试与状态上报使用）**

```ts
export type ErrorReportingState =
  | { state: 'idle' }                                                     // 未登录/未同步
  | { state: 'disabled' }                                                 // 开关关闭或 DSN 空
  | { state: 'ready'; dsnHost: string; level: string }                    // init 成功
  | { state: 'failed'; reason: string; dsnHost?: string }                 // init 抛错
  | { state: 'config_unavailable'; reason: string }                       // bootstrap 失败或 fellBack
export function getErrorReportingStatus(): ErrorReportingState            // 纯读，便于断言
```

> **不记录、不打印完整 DSN**：只记 `new URL(dsn).host` 与 `level`（DSN 的 public key 虽非机密，
> 但没有出现在日志/DB 里的必要；沿用 `maskSecrets` 的既有取向）。

**settings 新增键（仅 D4 采纳时）**

| 键 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `web.error_reporting_heartbeat` | `"true"`/`"false"` | `false` | true = 客户端每次进程启动发一条 tag 为 `picoaide.heartbeat` 的 info 事件，**不受 `error_reporting_level` 阈值限制** |

**客户端状态表（仅 D1/D7 采纳时，迁移 `0068_client_error_reporting_status.sql`）**

```sql
CREATE TABLE IF NOT EXISTS client_error_reporting_status (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state       TEXT        NOT NULL,   -- ready|disabled|failed|config_unavailable
  reason      TEXT        NOT NULL DEFAULT '',   -- 失败原因（服务端截断到 200 字符）
  dsn_host    TEXT        NOT NULL DEFAULT '',
  level       TEXT        NOT NULL DEFAULT '',
  release     TEXT        NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**R1 上报契约（客户端 → 服务端，Bearer）**

```
POST /api/client/v2/telemetry/error-reporting
{ "state": "ready|disabled|failed|config_unavailable",
  "reason": "…",           // ≤200，客户端已截断；服务端再截断一次
  "dsn_host": "glitchtip.example.com",
  "level": "error", "release": "picoaide-desktop@2.7.5-beta.2" }
→ 200 {"ok":true}   （未知/非法字段静默忽略；限流复用 telemetry 的 callLimiter）
```

**R2 测试事件契约（webadmin → 服务端）**

```
POST /api/server/admin/gateway/error-reporting/test      （PermGatewayWrite）
{ "dsn": "https://key@host/1" }                            // 缺省=用当前已保存的 DSN
→ 200 {"ok":true,"event_id":"…","http_status":200,"endpoint":"https://host/api/1/store/","elapsed_ms":123}
→ 502 {"error":{"code":"UPSTREAM","message":"无法连接上报服务:…"},
       "detail":{"kind":"DNS|CONNECT|TLS|TIMEOUT|HTTP_4XX|HTTP_5XX","http_status":0,"endpoint":"…"}}
```

**心跳事件（D4）**

```
captureMessage(`客户端错误上报链路自检 (${release})`, { level: 'info', tags: { 'picoaide.heartbeat': '1' } })
beforeSend: event.tags?.['picoaide.heartbeat'] ? event : (rank >= threshold ? event : null)
```

### 4.3 状态机（客户端）

```
                 apply()                       subscribeSession
   [idle] ───────────────▶ [idle] ──session─null──▶ [disabled]  (initSentry(''))
                                │
                                ├─ bootstrap 抛错 ────────▶ [config_unavailable]  + logger.warn  + R1
                                ├─ fellBack=true ─────────▶ [config_unavailable]  + logger.warn  + R1  ★新
                                ├─ enabled!==true / dsn 空 ▶ [disabled]           + logger.warn(降噪: 只 warn 一次) + R1
                                └─ initSentry 抛错 ───────▶ [failed]              + logger.warn  + R1
                                       initSentry 成功 ───▶ [ready]               + logger.info  + R1
```

### 4.4 安全约束（沿用的 + 新增的）

- **DSN 一律服务端下发**，客户端源码/本地配置**不含任何上报地址**（沿用）。
- **R1 不得成为新的外泄面**：客户端只上报 `dsn_host`（不含 public key、不含完整 DSN、不含 URL 路径段）。
- **R2 是管理员可控地址的出站请求** ⇒ 必须走 `util.SafeOutboundTransport()` + `CheckOutboundTarget()`；
  受限权限 `PermGatewayWrite`；超时 ≤ 8s；请求体固定（不含任何服务端机密）。**注意**：`SafeOutbound*`
  **允许私网**（既定策略），所以 R2 会真的去连私网地址 —— 这是**有意**的（内网自建 GlitchTip），
  但必须在代码注释里写明"这是管理员显式动作 + 权限受控"，避免审计误判为 SSRF。
- **webadmin 的 loopback 硬拒绝只作用于 DSN 字段**，不影响 `glitchtip_base_url`（连接器预填，客户端用户自己填 token，语义不同）。

---

## 5. 验证计划

### 5.1 验证环境

| 层级 | 手段 | 能证明什么 |
|---|---|---|
| 单测（Go） | `cd server && go test ./internal/llmgateway/ ./internal/telemetry/ ./internal/serverstore/` | 校验规则、测试事件分类、状态落库（DB 用例需 PG，见 §5.3） |
| 单测（TS 客户端） | `corepack yarn workspace @picoaide/dsh-enterprise test` | 状态机、日志级别、心跳阈值例外 |
| 单测（webadmin） | `cd server/webadmin && npm test` | 前置校验文案、按钮与提交体 |
| 打包断言 | `corepack yarn workspace dsh-plugin-desktop vitest run tests/verify-packaged-runtime.spec.ts`；真机 `yarn dist:linux` 走 afterPack | 产物里 `@sentry/node` + `error-reporting` 可解析可 require |
| **真实链路** | `.glitchtip-recon/client-probe.mjs`（已存在的探针）+ GlitchTip 只读 API 计数 | 客户端库 → GlitchTip 端到端 |
| **真实打包态** | `corepack yarn workspace dsh-plugin-desktop e2e:client`（Xvfb + mock gateway）后，用 CDP/日志断言插件 applied | 打包客户端里插件真的被加载 |
| **生产只读复核** | `curl` GlitchTip API（cookie jar 已在 `.glitchtip-recon/c.txt`）；生产 `docker logs`/`psql SELECT`（**需人工执行，本轮不做**） | 现场事实 |

### 5.2 验收标准（AC1–AC13，可判定、可逐条打勾）

| # | 判定陈述 | 判定命令 / 断言 | 对应任务 |
|---|---|---|---|
| **AC1** | 服务端**拒绝**指向 loopback（`localhost`/`127.0.0.1`/`127.1.2.3`/`::1`/`[::1]`）、链路本地与云 metadata（`169.254.169.254`/`fd00:ec2::/64`）、unspecified（`0.0.0.0`）的 DSN：HTTP 400 + JSON 信封 `{"error":{"code":"VALIDATION","message":"…中文…"}}`，且 **settings 未被写入**；`https://key@glitchtip.example.com/1` 行为与今天完全一致（200 + 写库） | `cd server && go test ./internal/llmgateway/ -run TestValidateErrorReportingDSN -v` 全 PASS；`go test ./internal/llmgateway/ -run TestSetGatewayConfigDSNRejected` 断言 400 + 库值不变 | T1 |
| **AC2** | webadmin 在**发请求之前**就拦下同类 DSN，给出中文报错并**不产生 PUT**；合规 DSN 仍提交 | `cd server/webadmin && npm test -- ErrorMonitoring` → 新增用例「拒绝指向本机的 DSN 并给出中文提示」+ 既有「非法 DSN 触发校验」不回归 | T2 |
| **AC3** | 「发送测试事件」：可达 DSN → 200 `{ok:true,event_id,http_status}` 且 GlitchTip 侧新增一条 issue；不可达 → 5xx + **可读中文原因**且 `detail.kind ∈ {DNS,CONNECT,TLS,TIMEOUT,HTTP_4XX,HTTP_5XX}` | `cd server && go test ./internal/llmgateway/ -run TestErrorReportingTestEvent -v`（`httptest` 正例 + 关闭端口反例 + 4xx 反例 + 超时反例） | T5 |
| **AC4** | 客户端 init 失败**不再静默**：`initSentry` 失败后 `getErrorReportingStatus().state === 'failed'` 且带 `reason`；同时 `ctx.logger.warn` 被调用（默认 `logLevel=info` ⇒ 会落盘）；`enabled!==true`、`fellBack=true`、bootstrap 抛错三种情形分别得到 `disabled` / `config_unavailable` / `config_unavailable`，且都**至少一条 warn** | `corepack yarn workspace @picoaide/dsh-enterprise test -- error-reporting` 全 PASS（新增 5 个用例） | T3 |
| **AC5** | 客户端状态可上报并被 webadmin 看到：`POST /api/client/v2/telemetry/error-reporting` 200 + upsert；`GET /api/server/admin/gateway/error-reporting/clients` 返回 `{ready,failed,disabled,config_unavailable,last_report_at,items[]}`；webadmin 页面渲染「已启用 N / 失败 M」与最近原因 | `cd server && go test ./internal/telemetry/ -run TestReportErrorReportingStatus -v`；`go test ./internal/serverstore/ -run TestUpsertErrorReportingStatus -v`（PG 用例须见 `--- PASS` 而非 `--- SKIP`）；`cd server/webadmin && npm test -- ErrorMonitoring` | T6 |
| **AC6** | 打包产物断言：`afterPack` 阶段用**打包后的 Electron**（`ELECTRON_RUN_AS_NODE=1`）`require('@sentry/node')` 成功（`typeof init === 'function'`）且 `@picoaide/dsh-enterprise/error-reporting` 可解析，stdout 出现 `SENTRY-SMOKE-OK`；缺失时 **afterPack 硬失败**（不是警告） | `corepack yarn workspace dsh-plugin-desktop vitest run tests/verify-packaged-runtime.spec.ts` 全 PASS（新增 4 用例：缺 sentry / 缺插件行 / 缺 package.json / 成功路径）；`REQUIRED_ASAR_EXPORTS` 含 `@picoaide/dsh-enterprise/error-reporting` | T4 |
| **AC7** | 正向心跳：`web.error_reporting_heartbeat=true` 时，`level=error` 下带 `picoaide.heartbeat` tag 的 info 事件**通过** `beforeSend`；开关 false 时**不发**；**且**开关 true 时普通 info 事件**仍被**过滤（证明 `error_reporting_level` 语义未变） | `corepack yarn workspace @picoaide/dsh-enterprise test -- error-reporting`（新增 3 用例）；`cd server && go test ./internal/llmgateway/ -run TestGatewayHeartbeatSetting -v`；`cd server/webadmin && npm test -- ErrorMonitoring` | T7 |
| **AC8** | （条件性，取决于 P1-5 验证结论）主进程致命异常发生后，GlitchTip **确实**收到该事件；若验证判定为"丢失"，则修复后必须复测通过，并在 PLAN/文档中记录修复前后的观测差异 | 打包态 AppImage + Xvfb 注入未捕获异常 → GlitchTip issue 列表出现该 release 的 `Error`；判据 = 「注入前后 issue 计数 +1」 | T9（条件性） |
| **AC9** | 四条命令全绿（明细见 §5.3）：`corepack yarn workspace @picoaide/dsh-enterprise typecheck`、`corepack yarn workspace @picoaide/dsh-enterprise test`、`cd server/webadmin && npm test`、`cd server && go test ./internal/llmgateway/` | 四条命令 exit code = 0；失败时必须**单独**重跑被改测试文件以区分"与本次无关的既有失败" | 全部 |
| **AC10** | `corepack yarn check` 全绿；若有既有失败，必须逐条列出并给出**归属判定**（缺依赖 / `lib/` 比 `src/` 旧 / 与本轮无关） | `corepack yarn check`；`ls -la --time-style=+%m-%d_%H:%M packages/host/enterprise/lib/ packages/host/enterprise/src/` 比时间戳 | 全部 |
| **AC11** | 运维纠偏文档落地：`docs/` 下存在一份文档，明确写清 `GLITCHTIP_DOMAIN` 与 `MAIN_URL` 的区别、`GLITCHTIP_DOMAIN=https://glitchtip.example.com` 的修法、以及生产 DSN 的正确写法 `https://<glitchtip-public-key>@glitchtip.example.com/1`；**不要求也不允许代理执行生产改配置** | `grep -l 'GLITCHTIP_DOMAIN' docs/**/*.md` 命中；文件含上述完整 DSN 字符串 | T10 |
| **AC12** | 交付物归位：蓝图/实施/决策 按 REQUEST §8 归入 `docs/planning/`、`docs/decisions/`；若本轮打 tag，`docs/releases/<tag>.md` 必须存在（`scripts/check-workflows.mjs` 的静态守卫会拦） | `ls docs/planning/2026-09-16-glitchtip-error-collection-*.md docs/decisions/2026-09-16-glitchtip-error-collection.md`；tag 前 `node scripts/check-workflows.mjs` | T10 |
| **AC13** | E2E 夹具不再假绿、不再携带生产上报地址：`e2e-fixture-gateway.mjs` 的 bootstrap `web` 段**不含**任何 `glitchtip.example.com` / 生产 public key 字面量，且 `error_reporting_enabled: true`；`e2e:client` 能**断言上报被触发**（至少断言客户端状态为 `ready` 或 mock 侧收到上报请求）而不是只断言页面可用 | `grep -c 'glitchtip.example.com\|<glitchtip-public-key>' packages/host/desktop/scripts/e2e-fixture-gateway.mjs` → **0**；`grep -c 'error_reporting_enabled' …` → **≥1**；`corepack yarn workspace dsh-plugin-desktop e2e:client` 报告中出现错误上报断言条目且为 pass | T12（P0-5）/ T13（P1-6） |

### 5.3 门禁命令与期望输出

```bash
# 1) 客户端插件（typecheck + 单测）
corepack yarn workspace @picoaide/dsh-enterprise typecheck     # 期望 exit 0，无 TS 错误
corepack yarn workspace @picoaide/dsh-enterprise test          # 期望 Tests  N passed（error-reporting 由 7 → ≥15）

# 2) webadmin
cd server/webadmin && npm test                                  # 期望 ErrorMonitoring.test.tsx 由 4 → ≥7 passed

# 3) Go
cd server && go test ./internal/llmgateway/ -run 'DSN|ErrorReporting' -v   # 期望逐条 --- PASS
cd server && go test ./internal/telemetry/ -run ErrorReporting -v
# DB 用例必须看 --- PASS 而不是 --- SKIP（本机 PG 可用：postgres://postgres:postgres@127.0.0.1:5432/picoaide_test）
cd server && PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/picoaide_test go test ./internal/serverstore/ -run ErrorReporting -v

# 4) 打包断言
corepack yarn workspace dsh-plugin-desktop vitest run tests/verify-packaged-runtime.spec.ts

# 5) 全量门禁
corepack yarn check                                             # 期望全绿（既有失败须逐条归属）
```

### 5.4 真实验证（不可省）

| 验证 | 做法 | 期望 |
|---|---|---|
| V1 库可用性（回归 F2） | `node .glitchtip-recon/client-probe.mjs 'https://<glitchtip-public-key>@glitchtip.example.com/1' T3`；**更强的版本**：在**生产发布树**里跑 `.glitchtip-recon/artifact/shipped/` 的探针（EVIDENCE-ADDENDUM F10 已做通，可直接复用其 `probe.mjs`） | `[probe] flush result = true`，GlitchTip 新增 issue |
| V2 坏 DSN 的真实行为（回归 F8） | `node .glitchtip-recon/client-probe.mjs 'http://<glitchtip-public-key>@localhost:8000/1' T4` | 现在**必须**同时得到：`ECONNREFUSED` **且** 客户端状态为 `failed`/`config_unavailable`（修复后新增可观测性） |
| V2b 等级盲区（回归 F11） | 在生产发布树里 `initSentry(DSN,'x','error')` + `captureMessage(info)` + `captureMessage(error)`，`Sentry.close(8000)` | `info` 查无此 issue、`error` 到达（修复后：开 `error_reporting_heartbeat` 时心跳必须**到达**） |
| V3 打包态插件真的被加载 | `corepack yarn workspace dsh-plugin-desktop e2e:client`（Xvfb `:99` + mock gateway `e2e-fixture-gateway.mjs`）；检查产物日志出现 `error-reporting: plugin applied` | 若 debug 不可见，则用 R1 的状态上报在 mock 侧观测（这是把 D1 做成 P0/P1 的另一个理由） |
| V4 打包断言真的会红 | 临时把 `@sentry/node` 从 desktop 的依赖树里移掉（或在 smoke 里把期望包名写错）跑一次 `afterPack` | **必须失败**（防止门禁空转——这正是 `verify-packaged-runtime.ts:663-674` 那条 P2-52 教训） |
| V5 生产只读复核（**人工**，本轮不执行） | 生产 `docker logs picoaide-server | grep bootstrap`；`SELECT` settings；GlitchTip issue 列表 | 复核 F3/F4/F5 是否仍成立（尤其 §2.6 的 `models` 是否为空 ⇒ H3′ 判定） |
| V6 H5 判定（条件性） | 打包态注入一次主进程未捕获异常，看事件是否到达 | 到达 = H5 证伪；未到达 = 采纳 T9 修复并复测 |

---

## 6. 未决与风险登记

| # | 事项 | 处置 |
|---|---|---|
| R-1 | 生产 2.7.5-beta.2 产物未验证（AppImage 未下完） | T4 的打包断言是**结构性**防线，不依赖这一次抽样；若需要，V5 里人工补齐 |
| R-2 | §2.6 的 H3′ 只差一次只读查询 | **编码前**由主控执行（成本极低，可能直接改变 P0 排序） |
| R-3 | 渲染进程错误从未采集（F-i） | **本轮不做**。写进 PLAN 与交付文档，避免下一轮再次误判为"链路坏了" |
| R-4 | `error_reporting_level` 的 UI 无 `fatal` 选项，而 `LEVEL_RANK` 有 | 非缺陷（`fatal` 只能由 SDK 自身产生）。登记，不改 |
| R-5 | 打包产物含 workspace 包的 `src/`/`tests/`/`docs/` | 体积与信息面问题，与本需求无关。登记，不动 |
| R-6 | D1 引入迁移 0068 + 新端点 | 若用户选择最小范围，可退化为"只做 P0 的日志 + 状态导出"，AC5/AC7 顺延到下一轮 |
