---
title: 插件开发
description: 如何为 PicoAide Harness 开发插件：一切皆插件、客户端/服务端两种形态、slot 组合与约束。
---

插件是给 DSH 添加能力的扩展包——模型、工具、界面、工作流都可以做成插件。**PicoAide Harness 没有魔改上游源码，一切皆插件组合**：桌面壳本身（窗口、托盘、终端、更新、profile）就是一个合法的 DSH 插件，与第三方插件走同一条官方 Cordis 组合路径。

## 插件机制总览

- **上游 Holder**：agent、model、tool、session、settings、webServer、subprocess 等官方能力，以固定 pin 版本原样运行；
- **Desktop Host 服务**：窗口、托盘、profile、终端、更新，对第三方开放明确的两个 contract（`dsh-plugin-desktop/profile-service`、`dsh-plugin-desktop/pnpm`）；
- **Web Client**：官方 Web UI + 第三方浏览器界面，经 loopback carrier 工作，不直接调用 Electron；
- **原生 runtime**：Electron BrowserWindow、系统托盘、文件/网络/安装器适配——`desktopRuntime` 仅供 Desktop 自有 row 使用，**不是第三方 API**。

## 两种插件形态

| 形态 | 约定 |
|---|---|
| **服务类包** | 默认导出服务类（如 `SessionService` / `HostCronService`），通过 `ctx.get` 提供服务；例子：`dsh-enterprise/session-service` |
| **函数插件** | 仅命名导出 `name` / `inject` / `Config` / `apply`，**无 default export**；`Config` 用 Schemastery schema 校验；所有副作用包在 `ctx.effect` 内（HMR/unload 可回滚）；例子：`pico-cron`、`pico-connectors`、`pico-browser` |

## 客户端插件

客户端插件使用 **`clientBundle` 预设**构建（tsdown），外部依赖对齐平台模块表（`PLATFORM_MODULES`——react-dom、react-dom/client、`@deepseek-ai/dsh-client-web-react`、`dsh-client-ui-primitives`、`dsh-client-ui-attachment`、`dsh-client-ui-schema-form`）与**实际 import 的 client 包**。

- **跨包客户端 import 禁止**：源包在 `ctx.effect` 内 `ctx.slots.inject` 注入，目标包在自己的 client 里 `ctx.slots.register` 注册；
- 类型检查 `tsconfig.client.json` 需 `skipLibCheck: true`（规避上游 `dsh-client-ui-sidebar` d.ts 内部类型错误）；
- **`immediately: true` 仅限 stage-one-prefetch 基础设施插件**；常规插件不加；
- 每个包自带 `./invariant` 子路径与 `./index` 等显式 exports。

### 界面扩展点（slot）

产品界面的每个功能面板都通过 slot 注入（`sidebar.footer.action` 等）。示例（连接器）：

```ts
ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
  name: 'sidebar.footer.action',
  // …面板标识、打开/关闭事件、图标与文案
}))
```

同样模式用于：能力中心入口（`sidebar.footer.action` id=`capability-center`）、定时任务 Tab、浏览器入口、设置分区（`settings.section`）、品牌区（`sidebar.brand.mark` / `conversation` hero mark）等。

## 服务端（Host）插件

- 服务类包默认导出服务类；函数插件仅命名导出 `name` / `inject` / `Config` / `apply`；
- Host 插件通过 `webServer` / `apiProxy` / `tools` / `systemPrompt` 等官方服务提供能力；
- **loopback API 模式**（连接器/定时任务/浏览器的通用做法）：插件注册同源 HTTP API（`/api/pico/...`），客户端 UI 通过 fetch 消费；`isLoopbackRequest` / `browserSameOriginMarker` 校验请求来自同源客户端；
- **模型工具注册**：`ctx.tools.register(defineTool({...}))`——定时任务暴露 `cron_create`/`cron_list`/`cron_set_enabled`/`cron_run`；浏览器暴露 `browser_*` 工具组；工具在 `ctx.effect` 内注册以便卸载；
- **跨插件事件**：类型只声明（`declare module '@deepseek-ai/cordis'`），运行时事件由拥有者发出——如 `pico/session-changed`（enterprise 拥有，connectors/cron/browser 只消费）。

## 常用约束清单

- 服务类包默认导出服务类；函数插件无 default export；
- 每个包自带 `./invariant` 子路径；
- `ctx.slots.inject` 在 `ctx.effect` 内包裹；不支持跨包客户端 import；
- 密码/密钥字段用 SecretInput 显隐切换；上传/下载 body 有上限（如 24MB 上传、100MB 浏览器下载）；
- 归档安全（技能/预设打包解包）双方校验（`archive-util` 的 `assertArchiveSafe` 公共化）；
- 目录/文件路径权限：凭据 0600/0700 原子写、防符号链接；DSH_HOME 安全校验（拒绝系统关键目录）。

## 企业服务端（Go）开发

服务端模块化于 `server/internal/`（serverauth / llmgateway / marketplace / sharedskills / agentshare / capabilities / serverstore / bootstrap / util），管理端为 `server/webadmin/src/`（shadcn React SPA，go:embed 内嵌）。开发者规约见仓库 `server/docs/` 与 `AGENTS.md`。

## 更多资料

- [仓库：插件开发完整文档](../docs/plugin-development.md)（仓库 docs/）
- [桌面插件服务 contract](../docs/plugin-services.md)（`packages/host/desktop/docs/plugin-services.zh.md`）
- [架构说明](../docs/architecture.md)
- [Community Fabric（社区互操作 RFC）](../community/fabric/README.zh.md)
