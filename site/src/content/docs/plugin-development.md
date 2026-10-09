---
title: 插件开发
description: 从零写一个 DSH 插件：Cordis 形态、宿主面与客户端面、平台模块表、本地调试，到打进客户端或服务端。
---

插件是给 DSH 添加能力的扩展包——模型、工具、界面、工作流都能做成插件。PicoAide Harness **不魔改上游源码**：桌面壳本身就是一个合法的 DSH 插件，与第三方插件走同一条官方 Cordis 组合路径。这一页写给二次开发者与维护者，讲清「写一个插件 → 本地调试 → 打进桌面客户端 / 装到企业服务端」的完整路径，以及每一步的边界在哪。

## 设计目标：为什么是插件而不是分支

三种做法里只有一种是可维护的：

| 做法 | 后果 |
|---|---|
| 改上游源码 | 每次跟随上游都要重做一遍，且上游的修复与安全更新无法合并 |
| 另造一套 renderer IPC 插件系统 | 与官方 slot/service 体系并行，生态里的插件再也装不进来 |
| **在组合层加自己的 bundle 层** | 上游原样运行，产品能力以插件身份参与组合，与第三方同权 |

所以本仓的形态是：固定的 `desktop` profile + 十层自有组装补丁层（`packages/host/desktop/cordis.patch.yml` 与九个自有包各自的补丁），加上少量**带判据的**上游补丁（`patches/` 与 `docs/decisions/`）。桌面壳不是特权层——它注册的服务和槽位，第三方插件同样可以用。

## 概念与结构

后面全篇复用这一套名词：

| 名词 | 含义 | 真源 |
|---|---|---|
| Cordis 插件 | 一个导出 `apply(ctx, config)`（或默认导出服务类）的模块 | 上游 `@deepseek-ai/cordis` |
| bundle | `package.json` 里声明了 `dsh.bundle.patch` 的包；补丁文件用 insert 把插件行插进组合 | 上游 `deepseek-harness/packages/boot/app-boot` |
| 补丁层（patch layer） | 一份 `cordis.patch.yml`；层序 = 各 bundle 层 → profile 自有层 → 用户 home 层 → 启动器 overlay | 上游 `deepseek-harness/vendor/include/src/index.ts` |
| profile | 固定 `desktop`，无选择器、无 CLI 入口 | `packages/host/desktop/src/profile.ts` 的 `DESKTOP_PROFILE_NAME` |
| 宿主面（host face） | 在 Electron main 进程里跑的 Node 半边：工具、HTTP 路由、系统提示词、子进程、托盘 | 各包的 `src/index.ts` |
| 客户端面（client face） | 在沙箱渲染进程里跑的浏览器半边：槽位、主题、语言、面板 | 各包的 `src/client/index.ts` |
| 平台模块表 | 外壳共享给所有客户端 bundle 的模块集合（React 等），决定哪些 import 必须保持 external | `scripts/platform-modules.mjs` |
| 槽位（slot） | 界面上的具名席位；父组件声明 children，插件往席位里注册组件 | 上游 `@deepseek-ai/dsh-client-ui-slots` |

## 写一个最小插件

一个只有宿主面的插件不需要构建工具，两个文件即可。`package.json`：

```json
{
  "name": "@example/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: my-plugin
      name: '@example/my-plugin'
      config: {}
```

`index.js` 只能选下面两种导出形态之一，不要混用：

```ts
// 形态一：函数插件 —— 只命名导出，没有 default export
import z from '@deepseek-ai/schemastery'

export const name = 'my-plugin'
export const inject = ['tools']
export const Config = z.object({ /* … */ })

export function apply(ctx, config) {
  ctx.effect(() => {
    const dispose = ctx.tools.register(/* … */)
    return () => { dispose() }
  }, 'my-plugin: tools')
}
```

```ts
// 形态二：服务类包 —— 默认导出服务类，别的插件用 ctx.get 取
export default class MyService extends Service {
  constructor(ctx) { super(ctx, 'myService') }
}
```

约定（本仓自研包一律遵守）：

- 函数插件只命名导出 `name` / `inject` / `Config` / `apply`，**没有 default export**；服务类包默认导出服务类；
- `Config` 用 Schemastery schema 校验行的 `config`；**行上没有的键就是 schema 缺省值**，写 schema 时要显式决定每个键的默认行为；
- 所有副作用（工具、路由、监听、定时器、槽位）都包在 `ctx.effect` 内并返回清理函数：插件卸载与 generation 重建都靠它回滚；
- 每个自研包自带 `./invariant` 子路径（包内不变量自检）与显式 `exports`。

补丁语义有三条必须记住（实现在上游 `deepseek-harness/vendor/include/src/index.ts`）：

1. **`config` 是整键替换**：补丁里写的 `config` 会替换整份配置，不是深合并。要覆盖一个键，就得把同层其它键一起重述。
2. **行 id 不存在时只 warn 后跳过**（`patch: entry "<id>" not found`），不会让启动失败——这是补丁"看起来写了但没生效"的头号原因。
3. `name` 与目标行不符时同样跳过（`patch: name mismatch`）。所以给已有行写补丁时，`id` 与 `name` 都要照抄。

## 宿主面与客户端面

一个插件可以有半边，也可以两半都有；两半**不在同一个进程**里，也不共享内存。

| 能力 | 在哪一面 | 说明 |
|---|---|---|
| 模型工具、系统提示词、HTTP 路由、子进程、文件系统、沙箱、设置命名空间 | **宿主面** | 需要 Node 能力或需要接触本地资源的能力只能在这边 |
| 托盘项 | 宿主面 | 只能经 `desktopRuntime.registerTrayItem` 贡献（见下文） |
| 界面面板、槽位、主题、语言字典、客户端 store、命令面板 | **客户端面** | 渲染进程是沙箱 Web 页面，拿不到 Node |
| 会话、登录态 | 两面各有一份视图 | 宿主面是 `sessionController` 与自有会话服务，客户端面是客户端的 `sessions`——两份不同的服务 |

两半之间**只有 loopback HTTP 与 WebSocket 这一条通道**：客户端面不能直接读宿主服务，产品也没有给它们加 preload 或 Electron IPC 桥。带界面的插件走普通 DSH 模式——宿主面注册同源 HTTP 路由（惯例前缀 `/api/pico/…`），客户端面用 fetch 消费；写面必须自己挂持有性证明（同源校验），不能假设"是本机请求就可信"。

一个具体的坑：`ctx.locale` 是**客户端面专属**服务，宿主面拿不到它。宿主侧要输出多语言文案（内嵌 HTML 页面、窗口标题、托盘文案、错误载荷）时用 `@picoaide/dsh-host-locale`（`hostLocaleFrom(...)` + `hostCopy(locale, zh, en)`），并且**按请求解析**，不要把语言冻结在模块级常量里。

### 跨包客户端 import 为什么被禁止

客户端 bundle 之间的值 import 会破坏两个不变量：

- **模块身份**：外壳把 React、cordis、store、slots 等放进一张冻结的模块表（平台模块表）。两个包各自内联一份 React，就是两个运行时实例，hook 与 context 对不上。
- **可解析性**：模块表答不出的 specifier，浏览器里就是一次必抛的 `require`。构建产物能编过，运行时才炸。

所以构建期有一道 **purity gate**：客户端 bundle 里任何 `@deepseek-ai/*` 的值 import，只有在"属于平台模块表"、"在 `dsh.client.external` 里显式请求过"、"属于可内联的纯契约层"三种情况之一时才放行，其余直接构建失败（类型 import 会被擦除，不受影响）。上游实现见 `deepseek-harness/packages/client/tsdown.client.ts`。

**跨插件协作只有两条路**：Cordis 服务（推荐，例如各面板向 `@picoaide/dsh-foot-menu` 提供的 `ctx.picoFootMenu` 登记条目），或者共享的槽位契约。

### 槽位：注入与注册的正确姿势

槽位是"父组件声明席位、插件往席位里放组件"的机制。两条 API：

```ts
ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
  name: 'sidebar.footer.action',
  id: 'my-entry',
  order: 5,
}, MyEntryComponent)), 'my-plugin: sidebar entry')
```

- `ctx.slots.register(options, component)`：注册一个占用者。**槽必须已被某个父条目的 children 表声明**，否则抛 `slot "<name>" is not declared`；同名同优先级重复占用也抛错，换一个 `priority` 才是 shadow（数值低者渲染）。
- `ctx.slots.inject(key, callback)`：等这个槽**被声明**时再跑 callback，声明折叠时自动 dispose；对还没挂载的父插件是必需的，直接 `register` 会因为"槽未声明"当场抛。
- 两个调用都必须在 `ctx.effect` 内，disposer 由 fiber 卸载统一回收。

不要去读别的插件的 DOM、样式表或组件源码来猜位置：选一个已经分配好空间的槽位（`conversation.composer.dock`、`sidebar.footer.action`、`shell.overlay`、`settings.section` 等）。产品界面的每个功能面板都是这么注入的。

## 平台模块表与 external 对齐

这一行是硬契约：

- **平台模块表（`PLATFORM_MODULES`）**：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`，共 9 项；本仓唯一真源是 `scripts/platform-modules.mjs`，逐项镜像自固定上游的 `deepseek-harness/packages/client/web/src/platform.ts`。

对齐规则：

- 表里的模块 + 上游的 `PRELOADED_CLIENT_EXTERNALS` + 你在 `dsh.client.external` 里显式声明的 specifier = **必须保持 external 的集合**；其余全部内联。tsdown 侧就是这么判的（`neverBundle = isRequested`、`alwaysBundle = !isRequested`）。
- 本仓的自研包在各自的 `tsdown.config.ts` 里手写 `external` 列表，并从 `scripts/platform-modules.mjs` 引入 `PLATFORM_MODULES` / `PRELOADED_CLIENT_EXTERNALS`（例如 `packages/host/connectors/tsdown.config.ts`）——**不要在包内抄一份字面量**。
- 客户端 bundle 还要定义 `process.env.NODE_ENV`（`define`），否则内联进来的库在浏览器里读 `process` 会抛 `ReferenceError`。
- 产物形态固定：`lib/client.js` 里一句 `window.__ModuleLoader__.load({ id: '<包名>', factory(require) { … } })`，factory 里 `require('react')` 从模块表取。
- 漂移由门禁判：`node scripts/verify-inventories.mjs` 把 `scripts/platform-modules.mjs` 与子模块里的上游真源逐项对拍，读不到上游即失败（不是"跳过"）。

## 本地调试

| 命令 | 作用 |
|---|---|
| `corepack yarn check` | 全量门禁：构建 + typecheck + 测试 + 17 条根守卫（受依赖图约束的并行编排） |
| `yarn check:fast` | 只跑本次改动影响的包（按 `git status`/`git diff` 映射；顶层文件改动升格为全量） |
| `yarn workspace <包名> check` | 单包：构建 + 测试 |
| `yarn workspace <包名> typecheck` | 单包类型检查（**vitest 不做全量类型检查**，新判据必须跑 tsc） |
| `yarn workspace dsh-plugin-desktop verify:profile` | 无头 Loader 冒烟：装配固定 profile、比对组合与运行时的行集合与 `disabled`，并钉住必须保持关闭的产品决策行 |
| `yarn workspace dsh-plugin-desktop verify:loader` | Loader 启动冒烟（headless） |
| `yarn dev` | 有图形会话时启动桌面应用（先构建） |
| `yarn workspace dsh-plugin-desktop e2e:client` | 打包产物 + Xvfb 的客户端端到端自动化 |

无头环境是常态：构建、类型检查、单元测试、Loader 冒烟都必须能在没有显示器时跑。应用日志写在 Electron userData 目录下的 `logs/dsh-<日期>.log`（告警与错误另写 `.error.log`），排查启动失败先看这里——`ctx.logger` 的 warn 不会出现在 stderr。

## 打进桌面客户端

### 固定 profile 与用户补丁层

应用**只跑一个 profile**：`desktop`。托盘没有 profile 选择器，CLI 也拒绝操作它（`dsh --profile desktop` 与 `dsh plugin --profile desktop` 都会报 "managed exclusively by the Electron application"）。

第三方插件有两条落地路径：

| 路径 | 做法 | 生效时机 |
|---|---|---|
| 运行期安装 | 编辑**当前数据根**下的 `cordis.patch.yml`，按 patch 语法追加行；包本体放进 profile 的 `node_modules` | **重启应用** |
| 随包分发 | 把包加进 profile 的 bundle 列表与打包清单（见下） | 随新版本安装包 |

运行期安装的最小补丁：

```yaml
- insert:
    - id: my-plugin
      name: my-plugin-package
```

数据根随渠道不同（渠道内容决定 `home_dir`，品牌渠道各自的目录互相独立）；补丁写到错误的数据根 = 插件不出现。**profile 没有 HMR**：`hmr` 行在桌面组合里被显式关闭（它要求一个桌面不提供的 `appReady` 服务），所以"改完重启"是既定语义，不是缺陷。

### 随包分发要登记的清单

把一个包做成随桌面分发的插件，除了 `dsh.bundle.patch` 与 `dsh.client`，还要在下面几处登记（漏一处就会出现"本机绿、CI 红"或"打包版启动即崩"）：

- `scripts/check-workspaces.mjs`：包表、路径属主、依赖关系；
- `packages/host/desktop/scripts/prebuild-workspace-deps.ts`：构建顺序（叶子包 → 业务包 → 桌面）；
- `scripts/verify-layout.mjs`：包名表；
- CI 的 workspace 构建产物归档清单；
- `packages/host/desktop/scripts/verify-packaged-runtime.ts` 的必需条目（真实的 asar / 物理运行时入口）。

profile 的 bundle 列表由 `desktopBundleList()` 修复：必装层按固定顺序排在前面，第三方 bundle 保持原顺序接在后面；**任何必装层被跳过都是 fail-loud**（静默掉一层会让"设置写入复算组合"把那些行从运行树上摘掉）。

### 随包运行时：让 agent 真的能跑起来

客户端在 `resources/runtimes/` 下随包分发三套运行时（不进 asar）：Node.js 24、pnpm 11、CPython 3.12。启动时把 `<resources>/runtimes/bin` **前置到应用自己的 PATH**，只影响应用派生的子进程（agent 的 shell 命令、MCP stdio 服务、`plugin_manager` 用的 pnpm），不改系统环境；`pip install` 的目标与 `.pyc` 缓存被重定向进应用数据根。

这条链路对插件作者的意义：

- `plugin_manager` 的 `install_bundle` / `remove_bundle` 在客户端上真的能跑（包管理器来自随包 pnpm）；
- 插件可以假设 agent 写的 JS / Python 能被直接执行；
- 出网仍受客户端策略约束（默认不用任何代理），**离线环境只能安装工作区里的本地 bundle**。

### 托盘与桌面契约

桌面为第三方开放的 surface 只有两处，见 [`packages/host/desktop/docs/plugin-services.zh.md`](https://github.com/picoaide/picoaide-harness/tree/master/packages/host/desktop/docs)：

```ts
export const inject = ['desktopRuntime']

export function apply(ctx) {
  ctx.effect(() => {
    const registration = ctx.desktopRuntime.registerTrayItem({
      group: 'tools',
      order: 30,
      label: () => 'Example Action',
      invoke: () => { /* 显式用户操作 */ },
    })
    return () => { registration.dispose() }
  }, 'my-plugin: tray command')
}
```

规则：托盘贡献必须在 `ctx.effect` 内（dispose 时移除）；`registration` 不得活过它的 effect；`invoke()` 里自己处理异步失败；**不要假设托盘的 label 集合**——桌面自有项会变。`desktopActions`（只暴露 restart）目前只为桌面 shell 描述契约，第三方使用前先 `ctx.get('desktopActions')` 探测，且不视为保证存在。

**不是第三方 API**：`desktopRuntime` 的 window/tray 方法、launcher bootstrap 值、生成的 shim、状态文件格式、Loader 行顺序、Electron 实现细节。插件作者不要读它们，也不要缓存跨 generation 的 service 引用与窗口对象。

## 装到企业服务端

服务端是 Go 程序，**不是 Cordis 宿主**：运行镜像里没有 Node，DSH 插件在服务端跑不了。要加服务端能力就是加 Go 模块：

- 业务包在 `server/internal/<模块>/`（`serverauth` / `llmgateway` / `marketplace` / `capabilities` / `serverstore` / `bootstrap` / `util` 等），管理端在 `server/webadmin/src/`（go:embed 内嵌的 SPA）；
- **路由集中声明**在 `internal/router`：业务包不得自行 `r.Group()` 注册生产路由，管理面路由要申报权限点；API 的失败响应统一 `{"error":{"code","message"}}` 信封；
- 新增 API 时两端必须同步：客户端（`packages/host/enterprise`）调 `/api/client/v2/*`，管理端调 `/api/server/admin/*`。

### 编译期注入与运行时配置的边界

| 类别 | 例子 | 生效方式 |
|---|---|---|
| **编译期注入**（改内容 = 重新构建镜像） | 渠道内容：产品名、标语、欢迎语、标识、主题色、数据根、深链 scheme、应用源 scheme、内置服务端地址 | 构建时从私有渠道仓注入镜像的 `/opt/picoaide/channel/`，客户端在**组装期**由 `channelProfilePatches()` 写进对应行的 config |
| **运行时配置**（管理后台 / 数据库 / 环境变量） | 模型目录与定价、限流与峰谷窗口、余额闸门策略、连接器目录与下发开关、能力中心审批与授权、审计保留天数、应用中心限制项 | 管理后台保存即生效；少数项（如应用单实例内存）需要重启服务端 |

为什么品牌文案不做成运行时可编辑：它是客户可见交付物，必须可审计、可复现——同一份配置构建出来的镜像，任何一台机器上的呈现都一样。客户端的随包品牌是兜底（服务端不可达时用），登录后以服务端下发的渠道内容为准。

给客户端的渠道值**必须在组装期注入**，不能让插件自己去读随包的 `channel.json`：插件的 `lib/` 是内联产物，`new URL('../build/channel.json', import.meta.url)` 在插件包里指向不存在的路径而静默回落（真机复现过：渠道客户端的 SSO 回调被按官方 scheme 校验后丢弃）。

## 验证与门禁

改完必须过门禁，命令与它们各自判什么：

| 命令 | 判什么 |
|---|---|
| `corepack yarn check` | 唯一全量入口：受构建依赖约束地并行跑各包 `check` + 根守卫 |
| `node scripts/check-workspaces.mjs --list` | 打印包表与守卫清单（唯一真源） |
| `node scripts/verify-inventories.mjs` | 平台模块表 ↔ 上游、CI 产物归档清单 ↔ 包表 ↔ 磁盘 |
| `node scripts/package-dir.mjs` | 真实打包并跑 afterPack 必需条目冒烟（唯一能发现"包内容不对"的判据） |
| `node scripts/check-doc-claims.mjs` | 文档里的硬数字与模块表 ↔ 代码真源 |
| `node scripts/check-migration-range.mjs` | 文档里的迁移区间 ↔ 迁移目录 |
| `node scripts/check-no-real-domains.mjs` | 公开面纪律：不得出现真实域名/主机名/渠道身份 |

常见失败形态（按排查顺序）：

| 现象 | 真实原因 | 怎么确定 |
|---|---|---|
| 打包版启动即 `ERR_MODULE_NOT_FOUND` | `exports` 声明了子路径，但 tsdown 的 `entry` 没列它，产物没生成；本机跑源码路径所以全绿 | 对照 `package.json` 的 `exports` 与 tsdown `entry`，再跑 `verify-packaged-runtime` 的必需条目对拍 |
| 补丁写了但行没变 | 行 id 拼错或 `name` 不符，上游只 warn 跳过 | 启动日志里找 `patch: entry "<id>" not found` / `patch: name mismatch` |
| 覆盖配置后丢字段 | 补丁的 `config` 是整键替换 | 把目标行原有的键在补丁里重述一遍 |
| 某一行永远 pending、没有任何报错 | `inject` 了不存在的服务，或往未声明的槽 `register` | 先看 `inject` 列表里的服务在本组合里有没有提供者；槽要用 `ctx.slots.inject` |
| 客户端 bundle 构建失败，报 purity | 跨包值 import | 改成 Cordis 服务或槽位协作，或在 `dsh.client.external` 里显式请求 |
| 本机绿、CI 红 | 本机 `lib/` 产物早已存在 | 清掉 `lib/` 后重跑（**不要删 `packages/vendor/memory-evolve/lib`**，那是入库源码） |

### 会被拒绝的，和会静默跳过的

排查插件问题时，先分清失败属于哪一类——三类里只有第一类会吵：

- **硬失败（fail-loud）**：必装 bundle 层被跳过（`required profile bundles were skipped`）；往未声明的槽 `register`（`slot "<name>" is not declared`）；同槽同优先级重复占用；客户端 bundle 里的跨包值 import（构建期 purity 报错）；组合与运行时的行集合或 `disabled` 不一致（`verify:profile` 红）。
- **只 warn 后跳过（必须自己找）**：补丁行 id 不存在（`patch: entry "<id>" not found`）；补丁的 `name` 与目标行不符（`patch: name mismatch … skipping`）；用户补丁里请求了本 profile 解析不到的可选客户端 UI 行（那一行被丢掉，只留一条 skipped 记录）。
- **完全没有反应**：`inject` 了一个本次组合里没有提供者的服务 ⇒ 整条 fiber 永久 pending 且不报错——诊断时先确认提供者行在不在；托盘项 `invoke()` 里的异步异常只进日志，用户看不到。

## 相关

- [插件生态](/plugin-ecosystem/) — 随包分发的插件清单、四条扩展路径与边界
- [系统架构](/architecture/) — 三层拓扑与启动顺序
- [桌面客户端](/desktop/) — 用户侧的插件管理与随包运行时
- [API 参考](/api-reference/) — 服务端接口契约
- [桌面插件服务 contract（仓库）](https://github.com/picoaide/picoaide-harness/tree/master/packages/host/desktop/docs/plugin-services.zh.md) — 类型、生命周期与失败语义
