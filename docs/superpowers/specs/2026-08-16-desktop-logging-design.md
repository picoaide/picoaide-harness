# Design: dsh-plugin-desktop 日志系统

> 为 DSH Desktop（v2 `dsh-plugin-desktop`）补上开发者可用的日志能力：落盘、级别配置、查看面板与手动清空。

## 1. 背景与目标

v2 桌面端把 Harness 的 Cordis Host 直接跑在 Electron 主进程内（`main.ts` 的 `boot()`）。日志有两个来源：

1. Cordis `ctx.logger` → `logger-console`（一个 `ConsoleExporter`）→ 控制台。
2. `electron-runtime.ts` / `main.ts` 里显式的 `process.stderr.write(...)`（桌面壳自身的错误消息）。

打包后的 GUI 应用里控制台不可见，排查者拿不到日志。

**目标**：把日志落到文件，支持级别过滤，并在设置页提供查看与清空。**不劫持 `console.*` / `process.stdout` / `process.stderr`。**

## 2. 范围

**范围内**（按 §9 分阶段）：落盘、级别配置、查看面板 + 清空。

**范围外**：不改 Harness 核心日志语义；不做结构化遥测（session telemetry 已有）；不做系统级日志（EventLog/syslog）。

## 3. 架构（核心修正：走 Cordis `Exporter`，不劫持流）

Cordis logger 有 `Exporter` 接口：`export(message: Message): void`，`Message` 是结构化记录——`{ ts, name, type: 'error'|'info'|'warn'|'debug', level: 0..3, args }`。

- **宿主侧**：
  - `log-files.ts` —— 文件 sink：低层 `write(level, text)` 写文件，负责按天+级别分文件、单文件大小轮转、200MB 目录安全阀、日期切换、句柄管理。**它是唯一写文件出口。**
  - `FileExporter` —— 实现 Cordis `Exporter`，把结构化 `Message` 用 Cordis 的 `Logger.format()` 格式化成一行，喂给 `log-files.ts`。与 `ConsoleExporter` 并列注册到 logger 服务。
  - 桌面壳自身的 `process.stderr.write(...)` → 改为走 `log-files.ts` 的 `write('error', …)`（不再裸写 stderr）。
  - 级别设置 `dsh-desktop.logLevel`（`debug/info/warn/error`，默认 `info`），沿用 `dsh-desktop` settings namespace。
  - `logs` Remote 服务（Typert）：`list({ tail })` 尾部读取、`clear()` 清空。
- **客户端**：一个「日志」设置 tab——查看器、级别下拉、清空按钮、「打开日志文件夹」按钮。

**不劫持 `console.*` / `process.stdout` / `process.stderr`**，因此：
- 无死循环（sink 自己不用 `console`）；
- 无重复（`ctx.logger` 只经 `FileExporter` 落盘一次，不再被 stdout 二次捕获）；
- 不破坏 Electron 调试窗口 / 附加调试器的控制台。

## 4. 日志文件组织

目录固定为 `app.getPath('userData')/logs/`（Windows 下 `%APPDATA%\DSH Desktop\logs`）。

```
logs/
  dsh-2026-08-16.log         # 当天全部级别（按时间顺序）
  dsh-2026-08-16.error.log   # 当天 warn/error
  dsh-2026-08-16.1.log       # 当天超出单文件上限后轮转出的第 2 段
  dsh-2026-08-15.log
  ...
```

- **按天**：文件名 `dsh-YYYY-MM-DD.log` / `.error.log`，本地日期。
- **按级别**：`*.log` 写全部；`*.error.log` 只写 `warn`+`error`。
- **单文件大小上限（补充）**：单个文件超过 **10MB** 后，滚到 `.1`、`.2`、`.3` …（当日全量日志按段编号；`.error.log` 同理）。
- **目录安全阀（补充单文件上限后保留）**：`logs/` 总大小超过 **200MB** 时，按修改时间从旧到新删除，直到低于阈值，**只保留当天文件**。
- **手动清空**：设置页按钮触发 `logs.clear()`。

## 5. 三个功能

### 5.1 落盘

`FileExporter` 收到 `Message`，用 `Logger.format()` 生成一行，经 `log-files.ts` 写入。桌面壳自身错误同样经 `log-files.ts` 写入（`write('error', …)`）。

### 5.2 级别配置

- settings 字段 `dsh-desktop.logLevel`，取值 `debug | info | warn | error`，默认 `info`。
- 级别顺序 `debug(3) < info(1) < warn(2) < error(0)`（沿用 `LoggerLevel`）；sink 只写 `message.level <= logLevel` 的记录。
- settings 服务 hot-reload 后热生效，无需重启。

### 5.3 查看面板 + 清空

- `logs.list({ tail = 1000 })` 返回最近 `tail` 行（**不整包加载**），客户端展示 + 手动刷新。
- `logs.clear()`：先关闭当前打开的文件句柄 → 删除 `logs/` 下全部文件 → 重新打开当天句柄（**避免 Windows 下删除占用中文件报错**）。
- 「打开日志文件夹」用 `shell.openPath(logsDir)`。

## 6. 数据流

```
ctx.logger ──→ FileExporter ──┐
                              ├──→ log-files.ts ──→ *.log / *.error.log
桌面壳 stderr 错误 ───────────┘        （按天+级别、单文件轮转、安全阀）
                                        ↑  logs.list({tail}) / clear()
                                      客户端设置页
```

## 7. 日志行格式

每行：`<ISO-8601 时间戳，本地时间带毫秒> [LEVEL] [name] <message>`

- `ts` 来自 `Message.ts`；`LEVEL` 来自 `Message.type`；`name` 来自 `Message.name`。
- 多行 `args`（如堆栈）：首行按上式，后续行缩进两个空格续写，保持一次 `export` 的边界。
- 编码 UTF-8；写入即 flush（`append` + `flush`），旋转/清空时关闭句柄。

## 8. 错误处理

- 日志目录创建失败/不可写 → sink 降级为仅 stderr，绝不抛错中断主流程。
- 单条写入失败 → 丢弃该条，不重试。
- `logs.list()` / `logs.clear()` 的文件错误 → 返回 `{ ok: false, error }`，客户端展示。
- 多实例：`main.ts` 已用 `requestSingleInstanceLock()` 强制单实例，故不会双进程写同一文件。

## 9. 测试

- `log-files.ts` 纯逻辑单测：文件名生成（日期 + 级别 + 段号）、级别过滤边界、单文件 10MB 轮转、200MB 目录淘汰（构造超阈值目录）、日期切换。
- `FileExporter` 单测：`Message` → 行格式（时间戳/级别/name/多行续写）。
- `logs` Remote 服务 + 设置 tab 组件测试（仿照 `plugin-inventory`）。

## 10. 分阶段

1. **阶段 1 — 落盘**：`log-files.ts` + `FileExporter` + 单文件轮转 + 目录安全阀。
2. **阶段 2 — 级别配置**：`dsh-desktop.logLevel` 设置 + sink 过滤。
3. **阶段 3 — 查看面板 + 清空**：`logs` Remote + 设置 tab + 清空/打开文件夹按钮。
