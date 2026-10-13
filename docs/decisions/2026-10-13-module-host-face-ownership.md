# 功能模块的 host 面归属（本机 API 随模块走）

**状态**：已实施（P0-b）
**日期**：2026-10-13
**相关**：[渠道声明功能模块（`features`）](./2026-10-13-channel-feature-modules.md)、
[功能模块编译期拆分设计稿](../planning/2026-10-13-feature-split-build-time.md)（§5bis 是本轮的实测依据）、
[能力中心命名与信息架构](./2026-08-25-capability-hub-naming-and-ia.md)

---

## 1. 一句话

把「技能商店」与「WASM 应用中心」的**本机 API（host 面）**从必需包
`@picoaide/dsh-enterprise` 搬进各自的模块包，使 **base 侧零导入模块代码** ——
这是设计稿不变量 1（"模块关闭 ⇒ 它的代码不进产物"）成立的前提。

## 2. 为什么必须做（实测口径）

`app.asar` 里 `@picoaide/*` 的集合**恰好等于** `packages/host/desktop/package.json`
的 `dependencies` 集合；不在依赖里的包在 asar 里 0 条。所以"从 profile 的 bundle 层里
摘掉某模块"只等于"不加载它"，**文件照样进包**。

P0 第一版只搬了客户端面，host 面留在 `enterprise`（= 基础，恒随包）。按那一版形态
关闭 `skills` 时的残留（实测，见设计稿 §5bis）：

| 残留 | 字节 |
| --- | --- |
| `@picoaide/dsh-enterprise/lib/skill-install-<hash>.js` | 220,271 |
| `@picoaide/dsh-enterprise/lib/skill-telemetry.js` | 9,608 |
| `@picoaide/dsh-enterprise/lib/auth-gate.js` 里的四条技能路由（sourcemap 归因，下界） | 28,395（整文件 263,254） |
| **最小残留合计** | **≈493 KB** |

## 3. 目标形态（照 `packages/host/connectors` 的双面包）

| 模块 | 包 | 面 |
| --- | --- | --- |
| `skills` | `packages/host/capability-center`（`@picoaide/dsh-capability-center`） | **host + client 双面**：`/api/pico/{skills,agent-presets,shared-skills,capabilities}` 四条本机路由 + `/skill-telemetry` 插件行 + 客户端面板/字典/底部条目 |
| `apps` | `packages/host/wasm-apps-host`（`@picoaide/dsh-wasm-apps-host`） | **host + client 双面**：`picoaide-app://` origin handler（原有）+ `/api/pico/apps/wasm*` 本机路由与 `wasm_app_*` 工具面（本轮搬入） |

## 4. 两个必须先解决的耦合 —— 选择与理由

### 4.1 耦合 1：`auth-gate.ts` 是单一 tsdown 入口

**选择**：做**入口切分**，并新增一个由 base 提供的**共用围栏服务**。

搬走四条技能路由（1,088 行 = 该文件 34.6%）与两条应用面注册块之后，
`packages/host/enterprise/tsdown.config.ts` 的 entry 减一（`skill-telemetry` 随技能面
搬走），`lib/auth-gate.js` 体积与 chunk 重排随之变化 —— 这是**接受**的代价。

但路由要用的**判定**不能跟着搬：回环 + 同源 + 持有性证明、审计只读、网关失败分支、
按请求解析的宿主语言、"先改密"的稳定码应答 —— 这些是**信任边界**。复制一份到模块包
就是第二真源（本仓已记录过 `loopback.ts` 四份分裂的同族事故）。

**因此**：`auth-gate.apply()` 末尾 `ctx.provide('picoLocalRoutes', { … })` 把**同一批
闭包**交出去（`guard` / `requireWriteProof` / `proofOfPossession` / `writeGuard` /
`session` / `json` / `collectBody` / `readBodyLimited` / `hostLocale` / `gatewayError` /
`passwordChangeRequired` / `clearSessionIfCurrent`）。模块行按**结构类型**探测这个服务
（`ctx.get('picoLocalRoutes')`），与 `wasm-apps-host/src/session.ts` 探测 `picoSession`
同形 —— 模块包**不 import** `enterprise`。

**为什么模块包不能 import `enterprise`**：`enterprise` 的 tsc 读 `dsh-plugin-desktop`
（`desktop-channel`），而 desktop 的 tsdown 把 `@picoaide/*` 内联进自己的 `lib/`
（`main.ts` 值导入 wasm-apps-host）⇒ 指向 enterprise 就闭合出
`desktop → wasm-apps-host → enterprise → desktop` 这个构建环。**服务名 + 结构类型**是
本仓既有的断环姿势（`ctx.get('picoSession')`、`ctx.get('desktopRuntime')`、
`ctx.get('workspaceRegistry')` 都是它）。

行为零变化由这条形态保证：模块行调的是**同一批函数对象**，不是同形副本。

### 4.2 耦合 2：`apps → skills` 反向依赖

实测的边是 `wasm-app-tools.ts` → `builtin-skills.ts` → `skill-install.ts` 的
`resolveSkillsDir`（"内置作者手册装了没有"必须看磁盘事实）。

**选择**：**② 把路径解析抽到零依赖叶子**（而不是 ① apps 包声明对能力中心包的依赖）。
理由：① 会让"关掉技能商店就发布不了应用"，与三个独立开关的契约直接冲突。

落点（本轮实测调整过一版）：`resolveSkillsDir` 搬进**既有**零依赖叶子
`@picoaide/dsh-host-home`（`packages/host/host-home`），而不是新建包。三条理由：

1. 它本来就是**数据根布局**的一部分（`<数据根>/skills`），且 base 组合里的
   `@deepseek-ai/dsh-skill-filesystem` 行扫的就是这个目录 —— 它是基础知识，不是某个
   可选模块的私有知识；
2. 消费方横跨**两个**可选模块（技能安装器 / 应用工具面），落在一个 base 恒在的叶子上，
   两个模块各自独立开合都不会缺依赖；
3. 少一个包 = 少一组登记面（layout / workspaces / prebuild / ci tar / 打包清单 /
   `AGENTS.md` 计数），而收益完全相同。

`builtin-skills.ts` 本身搬进 `wasm-apps-host`（它的**唯一**生产消费方是
`wasm-app-tools.ts`）；`skill-install.ts` 保留同名 re-export，导出面不变。

### 4.3 顺带产生的一个叶子包：`@picoaide/dsh-gateway-client`

搬完才发现第三处硬耦合：模块包的本机路由**必须真的调网关**，而网关客户端
（`gatewayFetch` / `fetchJSON` / `normalizeServerURL` / `AuthError` / `ApiError` /
`isPasswordChangeRequired` / `Session` 形状）住在 `enterprise/src/server-connector/`。
按 4.1 的同一条理由（环），模块包不能 import 它。

**选择**：实现逐字迁进新叶子包 `packages/host/gateway-client`
（`@picoaide/dsh-gateway-client`，子路径 `./auth` `./config` `./electron`），
`enterprise/src/server-connector/{auth,config,electron}.ts` 保留**同名 re-export** ——
与 2026-09-23 `loopback.ts` 四份合一同一姿势。对外契约
（`@picoaide/dsh-enterprise/server-connector/auth`，`account-card` 在消费）逐字不变。
它只依赖 `@picoaide/dsh-host-locale`（鉴权文案），没有出边通往任何功能模块。

## 5. base 零导入证明（交付物 A）

判据脚本（口径 = **只算真实 import/require 边**，把注释与文档里的包名提及排除）：

```bash
# 扫描 packages/ scripts/ integration-tests/ server/webadmin/src 下的
# from '…' / import('…') / require('…')（含跨包相对路径读模块包 src/）
node -e "…"   # 见提交信息里的复算命令；结论如下
```

**结论（实测）**：`packages/host/enterprise/src/**` 对两个模块包的**真实 import 边 = 0**。
按任务书点名的 base 清单逐条核对，**全部为 0**：

`bootstrap.ts`、`session-service.ts`、`gateway-model.ts`、`gateway-llm.ts`、
`error-reporting.ts`、`channel-sync.ts`、`deep-link.ts`、`channel-content.ts`、
`session-identity.ts`、`loopback.ts`、`invariant.ts`、`server-connector/**`，
**外加 `auth-gate.ts`**（本轮搬走之后）。

**白名单**（导入模块包或模块包 `src/` 的全部文件，74 个；按类归并）：

| 类别 | 文件 | 性质 |
| --- | --- | --- |
| 桌面壳自身 | `packages/host/desktop/src/main.ts`、`app-ai-runner.ts`、`wasm-apps-windows.ts` | **base → apps**。协议注册、Adium 适配器、应用 AI runner 与窗口适配器接线；这是 P2"按变体排包"要处理的那三处（设计稿 §7 已登记） |
| 测试 | `packages/host/enterprise/tests/**`（含 `helpers/apply-full-composition.ts`）、`packages/client/account-card/tests/**`（2 条真挂载用例）、`packages/host/desktop/tests/**`（7 条） | 判据面，不进产物 |

**跨包测试 import 的口径统一（任务书 ⑫）**：两类都用**声明依赖**那一口径 ——
`enterprise` 与 `account-card` 都在 `scripts/check-workspaces.mjs` 的
`PACKAGES[*].needs` 里登记了对两个模块包的边（`enterprise` → capability-center、
wasm-apps-host；`account-card` → capability-center），`account-card` 另有
`devDependencies`。**没有**"用相对路径读别人 src 却不声明依赖"的第二种口径。
判据面的装具从"各自 `apply(auth-gate)`"改成 `tests/helpers/apply-full-composition.ts`
一处：它按**真实 profile 的层序**装 auth-gate → 能力中心 → 应用宿主，并把假 ctx 的
`provide`/`get` 兜住（夹具形状不该决定判据红绿）。

## 6. 变体摘除集（交付物 B，供 P2 直接消费）

关闭某个模块时，**必须同时**删掉下列各处；漏一处的后果写在括号里。

### 6.1 关闭 `skills`

| # | 位置 | 删什么 | 漏了会怎样 |
| --- | --- | --- | --- |
| 1 | `packages/host/desktop/package.json` → `dependencies` | `"@picoaide/dsh-capability-center": "workspace:*"` | **这是唯一的真开关**：留着它，整包照样进 asar（≈171.5 KB 客户端面 + 本轮搬入的 host 面） |
| 2 | `packages/host/desktop/src/profile.ts` → `REQUIRED_BUNDLES` | `'@picoaide/dsh-capability-center'` | 组合里不再插它的两行（`picoaide-capability-center` / `picoaide-skill-telemetry`） |
| 3 | `packages/host/desktop/src/startup-rows.ts` → `REQUIRED_DESKTOP_ROWS` | `'picoaide-capability-center'`、`'picoaide-skill-telemetry'` | 否则 boot 后的必需行断言直接抛错（这是**有意的**：它把"行没了"从静默变成失败） |
| 4 | `packages/host/desktop/scripts/verify-packaged-runtime.ts` | 扁平清单里 `@picoaide/dsh-capability-center/**` 五条；`REQUIRED_WORKSPACE_PACKAGE_COVERAGE` 的 `dsh-capability-center` 行；`REQUIRED_WORKSPACE_PACKAGE_COVERAGE_MANIFEST_FLOOR` 下调 5 | afterPack 会因"清单里的条目在归档里不存在"拒包（fail-loud，方向安全但会红） |
| 5 | 同上 → `REQUIRED_PROFILE_PATCH_ANCHORS` | 该包的 `package.json` / `cordis.patch.yml` 两条 | profile 组装期解析不到包名 |
| 6 | `packages/host/desktop/scripts/prebuild-workspace-deps.ts` → `WORKSPACE_PACKAGES` | 该包条目 | 三个 `dist:*` 会去构建一个不存在的包 |
| 7 | `.github/workflows/ci.yml` 的 `workspace-build` tar 清单 | `packages/host/capability-center/lib` | 打包 job 解压后缺 `lib/`，插件行加载失败 |
| 8 | `scripts/check-workspaces.mjs` | `PACKAGES` 一行、`PATH_OWNERS` 一行、`DEPENDENTS` 键一行（以及消费方 `needs` 里的名字） | 表自检直接红（`needs ↔ DEPENDENTS` 双向判据） |
| 9 | `scripts/verify-layout.mjs` 的包名表 | `['packages/host/capability-center', '@picoaide/dsh-capability-center']` | 目录与包名对拍红 |
| 10 | `scripts/verify-inventories.mjs` / `scripts/check-install-integrity.mjs` | 后者 `EXECUTION_POINT_REGISTRY` 四条 + `NPM_PROJECT_MANIFEST_REGISTRY` 一条 | 双向登记判据（"派生却未登记"与"登记了却不在"）红 |
| 11 | `AGENTS.md` 的 `15 个` workspace 包 / `planned=34`、`packages/host/desktop/tests/prebuild-workspace-deps.spec.ts` 的下限 `15`、`tests/verify-packaged-runtime.spec.ts` 的清单 | 相应下调 | `check-doc-claims` 与两条棘轮红 |
| 12 | i18n 字典清单 | `packages/host/desktop/tests/i18n-keys.spec.ts` 的包清单、`i18n-dictionary-hygiene.spec.ts` 的字典路径 | 死键/字典面判据红 |

### 6.2 关闭 `apps`

| # | 位置 | 删什么 | 漏了会怎样 |
| --- | --- | --- | --- |
| 1 | `packages/host/desktop/package.json` → `dependencies` | `"@picoaide/dsh-wasm-apps"`、`"@picoaide/dsh-wasm-apps-host"` | 两个包照样进 asar |
| 2 | `packages/host/desktop/src/profile.ts` → `REQUIRED_BUNDLES` | `'@picoaide/dsh-wasm-apps'`、`'@picoaide/dsh-wasm-apps-host'` | 两行仍被插入 |
| 3 | `packages/host/desktop/src/startup-rows.ts` → `REQUIRED_DESKTOP_ROWS` | `'pico-wasm-apps-host'` | 必需行断言抛错 |
| 4 | `packages/host/desktop/src/main.ts`、`app-ai-runner.ts`、`wasm-apps-windows.ts` | 三处对 `@picoaide/dsh-wasm-apps-host` 的 import 与接线（协议注册 / `createInstallKeyStore` / 窗口适配器 / AI runner） | **base 侧仍在导入模块代码** ⇒ 不变量 1 不成立（编译期就会把模块内容内联进 desktop 的 `lib/`） |
| 5 | `packages/host/wasm-apps-host/package.json` → `dependencies` | `@picoaide/dsh-gateway-client`、`@picoaide/dsh-host-home` | 只在 `apps` 关闭时这两个叶子其实仍被 base 需要（见 §6.3），**不要**跟着删 `dsh-host-home` |
| 6 | `packages/host/desktop/scripts/verify-packaged-runtime.ts` | `@picoaide/dsh-wasm-apps*` 的全部条目（扁平清单 5 条 + `REQUIRED_ASAR_EXPORTS` 里没有它的条目 + 锚点表 2 条）、`REQUIRED_WORKSPACE_PACKAGE_COVERAGE` 两行、总下限下调 | afterPack 拒包 |
| 7 | `packages/host/desktop/scripts/prebuild-workspace-deps.ts` | 两个包条目 | 构建不存在的包 |
| 8 | `.github/workflows/ci.yml` 的 tar 清单 | `packages/client/wasm-apps/lib`、`packages/host/wasm-apps-host/lib` | 打包 job 缺产物 |
| 9 | `scripts/check-workspaces.mjs` / `verify-layout.mjs` / `verify-inventories.mjs` | 两个包的对应行 | 表自检红 |
| 10 | `scripts/wasm/*` 的门禁与 `integration-tests/electron-shots/mock-gateway.mjs` | 应用面路由的探针 | 探针指向不存在的路由 |
| 11 | `packages/host/desktop/tests/**` 里 7 条引用 wasm-apps-host 的用例 | 整条摘除 | 测试引用不存在的包 |
| 12 | `site/src/content/docs/**` 与 webadmin 侧描述 | 文案 | 文档承诺与产物不一致 |

### 6.3 **不要**跟着模块一起删的（本轮新出现的共享节点）

| 包 | 为什么两个模块都关掉时也要在 |
| --- | --- |
| `@picoaide/dsh-host-home` | 它是 base 的数据根叶子（`connectors` / `browser` / `desktop` 都在读）；本轮只多了一个 `resolveSkillsDir` 导出 |
| `@picoaide/dsh-host-locale` | 同理（base 的语言叶子） |
| `@picoaide/dsh-gateway-client` | **只在两个模块都关掉时可以摘**：它的消费方是 enterprise（登录门/深链/通道同步——base，恒在）+ 两个模块包。所以 `skills`/`apps` 关掉任何一个它都得留；两个都关才跟着走 |

## 7. 判据在哪（本轮新增/改动的）

- **行为零变化的判据 = 既有测试**：四条技能路由与两条应用面注册块的
  pathname / 状态码 / 错误码 / 文案键**逐字未改**，全部既有断言原样通过
  （`packages/host/enterprise/tests/**` 105 个文件；技能面 40+ 条、应用面 9 条）；
- **host 面真的随包走**：`packages/host/desktop/scripts/verify-packaged-runtime.ts` 的
  扁平清单 + `REQUIRED_WORKSPACE_PACKAGE_COVERAGE` 每包计数棘轮 + 反向 oracle
  （清单必须覆盖**产物**）——搬走的 `lib/skill-telemetry.js` 归到能力中心包、
  网关客户端新包的 5 条进表，生效清单总下限 `133 → 138`（实测值，见该文件的注释）；
- **跨包依赖图**：`scripts/check-workspaces.mjs` 的 `PACKAGES[*].needs` +
  `DEPENDENTS` 双向一致性 + 环检测；
- **哨兵落点**：`scripts/verify-ci-scripts.mjs` 的 `SENTINEL_SITES.skills` 改指
  `packages/host/capability-center/src/host/skill-telemetry.ts`（那一行就是技能模块的
  loader 行）；
- **新叶子的契约**：`packages/host/gateway-client/tests/gateway-client.spec.ts`
  （10 条：URL 归一 / 401 分流（含"带同样码的 500 不登出"与
  "AUDITOR_NOT_ALLOWED 不清会话"）/ 先改密只看码 / http 只放行回环）。

## 8. 本轮**没有**做的事

- 没有做真正的变体裁剪构建：P1（服务端 `-tags`）、P2（客户端按变体排包）、
  P3（webadmin）都不在本轮；
- 没有让 `desktop/src/{main,app-ai-runner,wasm-apps-windows}.ts` 变得可选 —— 那三处
  是 P2 的工作面（§5 白名单第一行），本轮的产出是"它现在是**仅剩**的三处"；
- 没有动 webadmin 与服务端 Go 侧的路由/作业条件化。
