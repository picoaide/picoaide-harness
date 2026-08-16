# Design: dsh-plugin-desktop 日志系统

> 为 DSH Desktop（v2 `dsh-plugin-desktop`）补上开发者可用的日志能力：落盘、级别配置、查看面板与手动清空。

## 1. 背景与目标

v2 桌面端把 Harness 的 Cordis Host 直接跑在 Electron 主进程内（`main.ts` 的 `boot()`）。所有日志——Cordis `ctx.logger` 经 `logger-console` 输出的 `console.*`，以及 `electron-runtime.ts` / `main.ts` 里显式的 `process.stderr.write(...)`——都进入该进程的 stdout/stderr。打包后的 GUI 应用里 stdout/stderr 不可见，用户与排查者都拿不到日志。

**目标**：在 `dsh-plugin-desktop` 里补一套日志系统，把进程日志落到文件，支持级别过滤，并在设置页提供查看与清空。

## 2. 范围

**范围内**（按 §9 分阶段）：

- 日志落盘（按天 + 按级别分文件 + 200MB 安全阀）。
- 日志级别配置（settings 字段，过滤 console 与文件输出）。
- 日志查看面板 + 手动清空 + 打开日志文件夹。

**范围外**：

- 不改动 Harness 核心的日志语义（只做桌面端的捕获与持久化）。
- 不做结构化/遥测上报（那是既有 session telemetry 的职责）。
- 不做跨平台系统级日志（EventLog / syslog）。

## 3. 架构

- **宿主侧（Electron main）**：
  - `log-files.ts` —— 日志 sink：接管进程日志输出，按天 + 按级别写文件，做安全阀轮转。
  - 日志级别设置 `dsh-desktop.logLevel`（`debug` / `info` / `warn` / `error`，默认 `info`），沿用既有 `dsh-desktop` settings namespace。
  - `logs` Remote 服务（Typert，宿主↔客户端桥）：`list()` 读日志、`clear()` 清空。
- **客户端（web UI 设置页）**：一个「日志」设置 tab，包含查看器、级别下拉、清空按钮、「打开日志文件夹」按钮。

## 4. 日志文件组织

目录固定为 `app.getPath('userData')/logs/`（Windows 下 `%APPDATA%\DSH Desktop\logs`）。

```
logs/
  dsh-2026-08-16.log         # 当天全部日志（按时间顺序）
  dsh-2026-08-16.error.log   # 当天 warn/error
  dsh-2026-08-15.log
  dsh-2026-08-15.error.log
  ...
```

- **按天**：文件名 `dsh-YYYY-MM-DD.log` 与 `dsh-YYYY-MM-DD.error.log`，以本地日期分段。
- **按级别**：`*.log` 写全部级别；`*.error.log` 只写 `warn` 与 `error`。
- **安全阀**：当 `logs/` 目录总大小超过 **200MB**，按文件修改时间从旧到新删除，直到低于阈值（或只剩当天文件）。
- **手动清空**：设置页「清空日志」删除当前全部日志文件。

## 5. 三个功能

### 5.1 落盘

`sink` 是唯一的写文件出口。它捕获两类来源：

- `console.log / info / warn / error / debug`（Cordis logger 经 logger-console 的输出）。
- `process.stdout.write` 与 `process.stderr.write`（`main.ts` / `electron-runtime.ts` 的显式输出）。

sink 按当前 `logLevel` 过滤，然后把每条按级别路由到 `*.log`（全部）与 `*.error.log`（仅 warn/error）。

### 5.2 级别配置

- settings 字段 `dsh-desktop.logLevel`，取值 `debug | info | warn | error`，默认 `info`。
- 级别顺序 `debug < info < warn < error`；sink 只写 `级别 >= logLevel` 的日志。
- 修改后热生效（settings 服务已有的 hot-reload），无需重启。

### 5.3 查看面板 + 清空

- 设置页「日志」tab 通过 `logs.list()` 拉取最近日志内容（只读，带刷新）。
- 「清空日志」按钮调用 `logs.clear()`，删除 `logs/` 下当前文件。
- 「打开日志文件夹」按钮用 `shell.openPath(logsDir)` 打开目录。

## 6. 数据流

```
console.* / process.stdout / process.stderr
        ↓  sink（按 logLevel 过滤，按级别路由）
   *.log  +  *.error.log（userData/logs/，安全阀轮转）
        ↑  logs.list()（宿主读文件 → Remote → 客户端设置页展示）
```

## 7. 错误处理

- 日志目录创建失败 / 不可写 → sink 降级为仅 stderr 输出，绝不抛错中断主流程。
- 单条写入失败 → 丢弃该条，不重试、不阻塞。
- `logs.list()` / `logs.clear()` 的文件错误 → 返回结构化错误（`{ ok: false, error }`），由客户端展示，不崩溃。

## 8. 测试

- `log-files.ts` 纯逻辑单测：文件名生成（日期 + 级别后缀）、级别过滤（各边界）、安全阀淘汰算法（构造超阈值目录）。
- `logs` Remote 服务 + 设置 tab 组件测试（仿照 `plugin-inventory` 的测试模式）。

## 9. 分阶段

1. **阶段 1 — 落盘**：`log-files.ts` sink + 文件 + 安全阀。
2. **阶段 2 — 级别配置**：`dsh-desktop.logLevel` 设置 + sink 过滤。
3. **阶段 3 — 查看面板 + 清空**：`logs` Remote + 设置 tab + 清空/打开文件夹按钮。
