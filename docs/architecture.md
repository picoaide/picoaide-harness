# PicoAide Harness 架构

## 总览

PicoAide Harness 是一个薄的 Electron 宿主。它在 Electron main 进程中启动官方 DSH Host，Host 再通过 loopback HTTP/WebSocket 提供普通 Web UI。PicoAide Harness 没有另造一条 renderer IPC 插件系统，也不把 Electron API暴露给页面。

```mermaid
flowchart LR
  User[用户] --> Native[Electron main / tray / window]
  Native --> Launcher[Profile launcher]
  Launcher --> Host[Host Cordis generation]
  Host --> Carrier[Loopback HTTP + WebSocket]
  Carrier --> Renderer[Sandboxed Web renderer]
  Host --> Upstream[Upstream DSH services]
  Host --> Desktop[Desktop-owned plugins]
  Host --> ThirdParty[Third-party plugins]
```

## 启动顺序

1. Electron 获取单实例锁，并读取 Desktop 私有的 profile/mode 状态。
2. Launcher 准备固定的 `desktop` profile，但不会为了列举 profile 而改写用户 profile。
3. Launcher 提供当前 generation 的 native runtime 与 profile 修复（安装属主前缀、bundle 顺序保留、desktop 层插入 `dsh-web-app` 之后且不持久化）。
4. Host Cordis root 启动 Loader entries。Desktop service 在第三方插件可读取前注册。
5. 官方 `dsh-base`、`dsh-web-app` 和 profile 中的第三方 bundle 组成 Web carrier。
6. Host 绑定 loopback 端口（`127.0.0.1` 随机端口），Electron 创建 BrowserWindow 并加载同源页面。
7. Web surface 成功加载后才创建托盘并提交 profile 的 last-known-good 状态。

应用固定运行 `desktop` profile 与高级（advanced）呈现；port 等启动设置变更会 dispose 当前 generation，再启动新的 generation。Service reference、窗口对象和 subprocess handle 都不能跨 generation 缓存。

## Host、Client 和 native runtime

- **Upstream Host**：agent、model、tool、session、settings、webServer 和 subprocess 等官方能力。
- **Desktop Host**：窗口、托盘、更新、诊断导出；对第三方公开 `desktopRuntime.registerTrayItem` 与 `desktopActions`（重启能力，见 plugin-services）。
- **Web Client**：官方 Web UI 和第三方浏览器界面。它通过 loopback carrier 工作，不直接调用 Electron。
- **Native runtime**：Electron BrowserWindow、系统托盘、文件/网络/安装器适配。`desktopRuntime` 只供 Desktop 自有 row 使用。

桌面壳固定高级呈现：Client face 安装 Desktop-owned layout、frame 和原生材质（macOS vibrancy / Windows Mica），同时尊重上游和第三方 slot 组合；Linux 无平台原生材质，使用标准系统窗口边框，布局与 macOS/Windows 一致。

## Profile 与服务边界

Launcher 只管理一个固定的 `desktop` profile，无 profile 选择器与 `web` 默认项；插件管理走官方 `dsh plugin --profile desktop` 语义（系统 shell 执行）。

Launcher 私有的 `desktopRuntime`、`desktopPlugins`（profile bundle 禁用预览/执行）、Electron executable、Node helper 和 ABI 环境不是第三方 API。公开 contract 见 [`dsh-plugin-desktop/docs/plugin-services.md`](../packages/host/desktop/docs/plugin-services.md)。

## 打包与运行时闭包

发布包使用 Electron Builder 和 `app.asar`，但需要物理 unpack 的依赖（例如 node-pty、node-addon、Windows ACL/native 文件）会放在 `app.asar.unpacked`。Packaged runtime gate 会检查 ASAR 入口和物理运行时入口，profile fallback 不能把符号链接指向无法被 Node 解析的虚拟 ASAR 路径。

根 workspace 使用 Yarn；固定的 `deepseek-harness/` 子模块保持上游自己的 pnpm workspace。桌面代码、测试、打包配置和发布脚本属于 `packages/host/desktop/`，不修改上游子模块。

## 维护者深入阅读

- [Desktop service contract](../packages/host/desktop/docs/plugin-services.md)
- [Package README](../packages/host/desktop/README.md)
- [Pinned upstream and isolated Yarn workspace](../.agents/notes/implemented/process/2026-08-15-pinned-upstream-and-isolated-yarn-workspace.md)
- [Advanced shell decision](../.agents/notes/implemented/architecture/2026-08-15-desktop-advanced-shell.md)
