# Agent Note: 桌面端文件日志

Status: implemented

[English](2026-08-16-desktop-logging.md) | 中文

## Problem

桌面端把 Cordis 根跑在 Electron 主进程内，所以每一条日志——经 `logger-console` 输出的 `ctx.logger`，以及 bootstrap 与 Electron 适配器里显式的 `process.stderr.write`——都落到进程的 stdout/stderr。打包后的 GUI 应用里这条流不可见，开发者与上报者拿不到日志。

## Decision

新增一个 Cordis `Exporter`，把格式化后的日志记录写到 `app.getPath('userData')/logs/` 下的文件，并通过 `ctx.logger.exporter(...)` 在桌面 bootstrap 里注册。它不包裹、不重定向 `console.*`、`process.stdout` 或 `process.stderr`。

三个模块实现它：

- `log-level.ts` —— 纯 verbosity 辅助：`LogType`、`LogLevel`、`shouldEmit(type, threshold)`、`isErrorType(type)`。
- `log-files.ts` —— 同步追加式 sink（`appendFileSync`），写 `dsh-YYYY-MM-DD.log`（全部级别）与 `dsh-YYYY-MM-DD.error.log`（warn 与 error）；单文件超过 10MB 滚到 `.1`、`.2` …；本地日期变化时切换文件；目录超过 200MB 时删最旧文件。
- `file-exporter.ts` —— `FileExporter implements Exporter`，把每条 `Message` 渲染成 `<本地时间戳> [LEVEL] [name] <body>`（经 `Logger.format`），按阈值过滤后路由到 sink。

`dsh-desktop.logLevel` 设置字段（`debug | info | warn | error`，默认 `info`）扩展已有的 `dsh-desktop` 命名空间。bootstrap 在 `boot()` 后读一次，并订阅 `settings/updated` 就地更新 exporter 阈值。

## Alternatives considered

**包裹 `console.*` 或 `process.stdout` / `process.stderr`。** sink 自身打印时会递归，`ctx.logger` 每一行会重复（console exporter 一次 + 流包裹一次），并破坏 Electron 的 devtools 与附加调试器控制台。Cordis 的 `Exporter` 接缝收到带 type、level、timestamp、name 的结构化 `Message`，文件目标完全不需要这些 hack。

**单个无上限日志文件。** 没有单文件与目录上限时，长时间运行或某个吵闹的插件会占满磁盘。按天命名 + 10MB 轮转 + 200MB 目录上限既限制了增长，又让日志可按日期与严重度查看。

**复用 console exporter 的渲染器。** 它带颜色、按 label 对齐，是为终端调过的；文件目标渲染更朴素的带时间戳行，让文件在编辑器里可读、可粘贴。

## Consequences

日志持久化到桌面用户数据目录，打包运行后也能排查。verbosity 阈值走标准设置服务配置，同时作用于全量文件与错误文件。`logLevel` 字段在启动时与 `settings/updated` 时读取，改动无需重启即生效。

每天日志以一条启动 header（app 版本、平台、Node 版本、运行时间戳）开头，并在启动时清理 7 天前的文件，配合 200MB 目录上限。

绕过 Cordis `ctx.logger` 的 Electron 主进程级错误通过 `DesktopLogger` 接口记录：`ElectronStderrLogger` 写入 sink 并镜像到 `process.stderr`（开发时可终端可见）。它被注入 `ElectronDesktopRuntime`，后者把原先的 `process.stderr.write` 调用、`launchWindowsUpdateInstaller` 的子进程错误、以及 `render-process-gone` / `did-fail-load` 渲染器事件都路由过去。`main.ts` 注册的 `uncaughtException` 与 `unhandledRejection` 处理器也写入 sink。

渲染后的日志行经过脱敏层，屏蔽 `sk-` 风格 key、长 hex/base64 token 与 bearer token。`desktopRuntime.exportDiagnostics()` 把日志目录与系统信息摘要打包成 `userData/diagnostics/` 下的 zip，并在系统文件管理器中打开。

带手动清空的设置页日志查看器尚未构建，作为后续项。
