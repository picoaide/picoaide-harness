# dsh-plugin-desktop 日志落盘 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `dsh-plugin-desktop` 里把 Cordis `ctx.logger` 的日志落到文件（按天+按级别、单文件轮转、200MB 目录安全阀），并支持 `dsh-desktop.logLevel` 级别过滤。

**Architecture:** 新增一个 `FileExporter` 实现 Cordis 的 `Exporter` 接口，经 `ctx.logger.exporter(...)` 注册；它把结构化 `Message` 渲染成行，交给纯文件管理模块 `log-files.ts` 写盘。级别过滤用纯函数 `log-level.ts`。

**Tech Stack:** TypeScript (ESM)、Cordis logger (`@deepseek-ai/cordis`)、`@deepseek-ai/schemastery`（settings schema）、Vitest。

**Spec:** `docs/superpowers/specs/2026-08-16-desktop-logging-design.md`

## Global Constraints

- 不劫持 `console.*` / `process.stdout` / `process.stderr`（走 Cordis `Exporter`）。
- 日志文件固定目录 `app.getPath('userData')/logs/`（sink 构造时由调用方传入绝对路径，sink 自身不依赖 Electron）。
- 文件名 `dsh-YYYY-MM-DD.log`（全部）、`dsh-YYYY-MM-DD.error.log`（warn+error）、超出单文件上限后 `.N.log`。
- 单文件上限 **10MB**；目录安全阀 **200MB**。
- 编码 UTF-8，写入即 flush（`append` + `flush`），旋转/清空时关闭句柄。
- 级别过滤：`error(0) < warn(1) < info(2) < debug(3)`，`shouldEmit(type, threshold) = verbosity[type] <= verbosity[threshold]`；默认阈值 `info`。
- `log-level.ts` 与 `log-files.ts` 不得 import `@deepseek-ai/*`（保持纯、可独立单测）；`file-exporter.ts` 允许 import `@deepseek-ai/cordis`。
- 源码 ESM（`import` + `.ts` 扩展名）；`noUncheckedIndexedAccess` 已开（数组下标需判空或非空断言）。

---

## File Structure

```
dsh-plugin-desktop/src/
  log-level.ts       # 纯逻辑：LogType / LogLevel / verbosity / shouldEmit / isErrorType
  log-files.ts       # 纯文件 sink：命名、轮转、安全阀、日期切换、clear
  file-exporter.ts   # FileExporter（Cordis Exporter）：Message → 行 → sink
  index.ts           # 修改：注册 FileExporter + logLevel 设置
dsh-plugin-desktop/tests/
  log-level.spec.ts
  log-files.spec.ts
  file-exporter.spec.ts
```

---

## Task 1: log-level.ts（级别类型 + 过滤）

**Files:**
- Create: `dsh-plugin-desktop/src/log-level.ts`
- Test: `dsh-plugin-desktop/tests/log-level.spec.ts`

**Interfaces:**
- Produces: `LogType = 'error' | 'info' | 'warn' | 'debug'`、`LogLevel = 'debug' | 'info' | 'warn' | 'error'`、`shouldEmit(type, threshold): boolean`、`isErrorType(type): boolean`（Task 2/3 依赖）。

- [ ] **Step 1: 写失败测试 `tests/log-level.spec.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { isErrorType, shouldEmit } from '../src/log-level.ts'

describe('shouldEmit', () => {
  it('emits nothing above the threshold', () => {
    expect(shouldEmit('debug', 'info')).toBe(false)
    expect(shouldEmit('info', 'info')).toBe(true)
    expect(shouldEmit('warn', 'info')).toBe(true)
    expect(shouldEmit('error', 'info')).toBe(true)
  })

  it('emits only errors at the error threshold', () => {
    expect(shouldEmit('error', 'error')).toBe(true)
    expect(shouldEmit('warn', 'error')).toBe(false)
    expect(shouldEmit('info', 'error')).toBe(false)
    expect(shouldEmit('debug', 'error')).toBe(false)
  })

  it('emits everything at the debug threshold', () => {
    expect(shouldEmit('debug', 'debug')).toBe(true)
    expect(shouldEmit('info', 'debug')).toBe(true)
    expect(shouldEmit('warn', 'debug')).toBe(true)
    expect(shouldEmit('error', 'debug')).toBe(true)
  })
})

describe('isErrorType', () => {
  it('treats warn and error as the error log', () => {
    expect(isErrorType('warn')).toBe(true)
    expect(isErrorType('error')).toBe(true)
    expect(isErrorType('info')).toBe(false)
    expect(isErrorType('debug')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `yarn vitest run tests/log-level.spec.ts`
Expected: FAIL（`Cannot find module '../src/log-level.ts'`）。

- [ ] **Step 3: 写 `src/log-level.ts`**

```ts
/** One Cordis logger severity, mirroring `@deepseek-ai/cordis`'s `LoggerType`. */
export type LogType = 'error' | 'info' | 'warn' | 'debug'

/** User-selectable log verbosity threshold. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const VERBOSITY: Record<LogType, number> = { error: 0, warn: 1, info: 2, debug: 3 }

/** Whether a message of `type` should be emitted at `threshold`. */
export function shouldEmit(type: LogType, threshold: LogLevel): boolean {
  return VERBOSITY[type] <= VERBOSITY[threshold]
}

/** Whether a message of `type` belongs in the per-day error log. */
export function isErrorType(type: LogType): boolean {
  return type === 'warn' || type === 'error'
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `yarn vitest run tests/log-level.spec.ts`
Expected: PASS（4 个用例）。

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-desktop/src/log-level.ts dsh-plugin-desktop/tests/log-level.spec.ts
git commit -m "feat(desktop): add log-level verbosity helpers"
```

---

## Task 2: log-files.ts（文件 sink）

**Files:**
- Create: `dsh-plugin-desktop/src/log-files.ts`
- Test: `dsh-plugin-desktop/tests/log-files.spec.ts`

**Interfaces:**
- Consumes: `LogType`、`shouldEmit`/`isErrorType`（Task 1）。
- Produces: `logFileName(suffix, error, segment)`、`LogFileSink` 类（`write(type, line)` / `clear()` / `close()` / `enforceDirectoryCap()`），供 Task 3 使用。

- [ ] **Step 1: 写失败测试 `tests/log-files.spec.ts`**

```ts
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LogFileSink, logFileName } from '../src/log-files.ts'

let dir: string

afterEach(() => { /* best-effort cleanup */ })

function sink(maxFileBytes = 10 * 1024 * 1024, maxDirectoryBytes = 200 * 1024 * 1024): LogFileSink {
  dir = mkdtempSync(join(tmpdir(), 'dsh-log-'))
  return new LogFileSink(dir, { maxFileBytes, maxDirectoryBytes })
}

describe('logFileName', () => {
  it('names the full and error logs by date and segment', () => {
    expect(logFileName('2026-08-16', false, 0)).toBe('dsh-2026-08-16.log')
    expect(logFileName('2026-08-16', true, 0)).toBe('dsh-2026-08-16.error.log')
    expect(logFileName('2026-08-16', false, 2)).toBe('dsh-2026-08-16.2.log')
  })
})

describe('LogFileSink', () => {
  it('writes info to the full log only, and errors to both logs', () => {
    const s = sink()
    s.write('info', 'hello info')
    s.write('error', 'hello error')
    s.close()
    const files = readdirSync(dir).sort()
    expect(files).toEqual(['dsh-2026-08-16.error.log', 'dsh-2026-08-16.log'])
    expect(readFileSync(join(dir, 'dsh-2026-08-16.log'), 'utf8')).toBe('hello info\nhello error\n')
    expect(readFileSync(join(dir, 'dsh-2026-08-16.error.log'), 'utf8')).toBe('hello error\n')
  })

  it('rotates a file when it exceeds the per-file cap', () => {
    const s = sink(10)
    s.write('info', 'x'.repeat(8))
    s.write('info', 'y'.repeat(8))
    s.close()
    const files = readdirSync(dir).filter(f => !f.includes('.error')).sort()
    expect(files).toEqual(['dsh-2026-08-16.1.log', 'dsh-2026-08-16.log'])
  })

  it('clear removes all files and reopens fresh streams', () => {
    const s = sink()
    s.write('info', 'first')
    s.clear()
    s.write('info', 'second')
    s.close()
    expect(readFileSync(join(dir, 'dsh-2026-08-16.log'), 'utf8')).toBe('second\n')
  })
})
```

（注：测试里的日期固定为 `2026-08-16` 依赖当天日期；若运行日期不是 2026-08-16，需把期望文件名改为当天日期——实现阶段用 `logFileName(new Date())` 动态断言更稳。）

- [ ] **Step 2: 跑测试确认失败**

Run: `yarn vitest run tests/log-files.spec.ts`
Expected: FAIL（`Cannot find module '../src/log-files.ts'`）。

- [ ] **Step 3: 写 `src/log-files.ts`**

```ts
import {
  createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync,
  type WriteStream,
} from 'node:fs'
import { join } from 'node:path'
import type { LogType } from './log-level.ts'
import { isErrorType } from './log-level.ts'

/** Sink configuration with its size ceilings. */
export interface LogFileSinkOptions {
  readonly maxFileBytes: number
  readonly maxDirectoryBytes: number
}

function localDateSuffix(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Build the file name for one date, level kind, and rotation segment. */
export function logFileName(suffix: string, error: boolean, segment: number): string {
  const base = `dsh-${suffix}${error ? '.error' : ''}`
  return segment === 0 ? `${base}.log` : `${base}.${segment}.log`
}

/** Append-only per-day file sink with size rotation and a directory cap. */
export class LogFileSink {
  private readonly directory: string
  private readonly maxFileBytes: number
  private readonly maxDirectoryBytes: number
  private currentDate: string | undefined
  private all: WriteStream | undefined
  private error: WriteStream | undefined
  private allBytes = 0
  private errorBytes = 0
  private allSegment = 0
  private errorSegment = 0

  constructor(directory: string, options: LogFileSinkOptions) {
    this.directory = directory
    this.maxFileBytes = options.maxFileBytes
    this.maxDirectoryBytes = options.maxDirectoryBytes
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true })
  }

  /** Append one rendered line, routing by level and rotating on size/date. */
  write(type: LogType, line: string): void {
    const suffix = localDateSuffix(new Date())
    if (suffix !== this.currentDate) this.rollDate(suffix)
    this.append('all', line)
    if (isErrorType(type)) this.append('error', line)
  }

  /** Delete every file in the directory and reopen fresh streams. */
  clear(): void {
    this.close()
    for (const name of readdirSync(this.directory)) unlinkSync(join(this.directory, name))
  }

  /** Close the open streams without deleting files. */
  close(): void {
    this.all?.close()
    this.error?.close()
    this.all = undefined
    this.error = undefined
    this.currentDate = undefined
  }

  /** Delete oldest files until the directory is under the cap. */
  enforceDirectoryCap(): void {
    const entries = readdirSync(this.directory).map(name => {
      const path = join(this.directory, name)
      return { path, mtime: statSync(path).mtimeMs }
    }).sort((a, b) => a.mtime - b.mtime)
    let total = entries.reduce((sum, e) => sum + statSync(e.path).size, 0)
    for (const entry of entries) {
      if (total <= this.maxDirectoryBytes) break
      total -= statSync(entry.path).size
      unlinkSync(entry.path)
    }
  }

  private rollDate(suffix: string): void {
    this.close()
    this.currentDate = suffix
    this.allBytes = 0
    this.errorBytes = 0
    this.allSegment = 0
    this.errorSegment = 0
  }

  private open(kind: 'all' | 'error'): WriteStream {
    const segment = kind === 'all' ? this.allSegment : this.errorSegment
    return createWriteStream(join(this.directory, logFileName(this.currentDate!, kind === 'error', segment)), { flags: 'a' })
  }

  private append(kind: 'all' | 'error', line: string): void {
    let stream = kind === 'all' ? this.all : this.error
    let bytes = kind === 'all' ? this.allBytes : this.errorBytes
    if (stream === undefined) {
      stream = this.open(kind)
      if (kind === 'all') this.all = stream
      else this.error = stream
    }
    if (bytes + line.length + 1 > this.maxFileBytes) {
      stream.close()
      if (kind === 'all') { this.allSegment += 1; this.allBytes = 0 }
      else { this.errorSegment += 1; this.errorBytes = 0 }
      stream = this.open(kind)
      if (kind === 'all') this.all = stream
      else this.error = stream
      bytes = 0
    }
    stream.write(`${line}\n`)
    if (kind === 'all') this.allBytes = bytes + line.length + 1
    else this.errorBytes = bytes + line.length + 1
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `yarn vitest run tests/log-files.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-desktop/src/log-files.ts dsh-plugin-desktop/tests/log-files.spec.ts
git commit -m "feat(desktop): add rotating per-day log file sink"
```

---

## Task 3: file-exporter.ts（Cordis FileExporter）

**Files:**
- Create: `dsh-plugin-desktop/src/file-exporter.ts`
- Test: `dsh-plugin-desktop/tests/file-exporter.spec.ts`

**Interfaces:**
- Consumes: `LogFileSink`（Task 2）、`shouldEmit`（Task 1）。
- Produces: `FileExporter`（实现 `@deepseek-ai/cordis` 的 `Exporter`；`export(message)`、`getDefaults()`），供 Task 4 注册。

- [ ] **Step 1: 写失败测试 `tests/file-exporter.spec.ts`**

```ts
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LogFileSink } from '../src/log-files.ts'
import { FileExporter } from '../src/file-exporter.ts'

let dir: string
afterEach(() => {})

function exporter(threshold: 'debug' | 'info' | 'warn' | 'error' = 'info'): { exporter: FileExporter; dir: string } {
  dir = mkdtempSync(join(tmpdir(), 'dsh-log-'))
  const sink = new LogFileSink(dir, { maxFileBytes: 10 * 1024 * 1024, maxDirectoryBytes: 200 * 1024 * 1024 })
  const exporter = new FileExporter(sink, threshold)
  return { exporter, dir }
}

describe('FileExporter', () => {
  it('renders and writes a message with timestamp and level', () => {
    const { exporter } = exporter()
    exporter.export({ sn: 0, ts: Date.now(), name: 'test', type: 'info', level: 1, args: ['hello'] })
    exporter.close()
    const text = readFileSync(join(dir, 'dsh-2026-08-16.log'), 'utf8')
    expect(text).toContain('[I]')
    expect(text).toContain('hello')
  })

  it('drops debug messages at the info threshold', () => {
    const { exporter } = exporter('info')
    exporter.export({ sn: 0, ts: Date.now(), name: 'test', type: 'debug', level: 3, args: ['hidden'] })
    exporter.close()
    expect(readFileSync(join(dir, 'dsh-2026-08-16.log'), 'utf8')).toBe('')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `yarn vitest run tests/file-exporter.spec.ts`
Expected: FAIL（`Cannot find module '../src/file-exporter.ts'`）。

- [ ] **Step 3: 写 `src/file-exporter.ts`**

```ts
import { Logger, type Exporter, type Message } from '@deepseek-ai/cordis'
import { shouldEmit, type LogLevel, type LogType } from './log-level.ts'
import { LogFileSink } from './log-files.ts'

/** File exporter that forwards formatted messages to a `LogFileSink`. */
export class FileExporter implements Exporter {
  formatters = {}
  maxLength?: number

  constructor(
    private readonly sink: LogFileSink,
    private readonly threshold: LogLevel = 'info',
  ) {}

  /** No per-message defaults needed; the sink owns level routing. */
  getDefaults() {
    return { showTime: 'yyyy-MM-dd hh:mm:ss ' }
  }

  export(message: Message): void {
    if (!shouldEmit(message.type as LogType, this.threshold)) return
    this.sink.write(message.type as LogType, Logger.format(this, message))
  }

  /** Close the underlying sink (used by tests and shutdown). */
  close(): void {
    this.sink.close()
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `yarn vitest run tests/file-exporter.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-desktop/src/file-exporter.ts dsh-plugin-desktop/tests/file-exporter.spec.ts
git commit -m "feat(desktop): add Cordis FileExporter writing to the log sink"
```

---

## Task 4: 接入 index.ts（注册 FileExporter + logLevel 设置）

**Files:**
- Modify: `dsh-plugin-desktop/src/index.ts`（`DesktopSettings`、`DesktopSettingsSchema`、`apply`）

**Interfaces:**
- Consumes: `FileExporter`（Task 3）、`LogFileSink`（Task 2）。
- Produces: 运行时可用的日志落盘 + `dsh-desktop.logLevel` 设置项。

- [ ] **Step 1: 写失败测试（设置 schema 校验）**

在 `tests/log-files.spec.ts` 或新 `tests/index.spec.ts` 里，针对新增的 schema 断言默认值与非法值拒绝：

```ts
import { describe, expect, it } from 'vitest'
import { DesktopSettingsSchema } from '../src/index.ts'

describe('DesktopSettingsSchema.logLevel', () => {
  it('defaults to info and rejects invalid levels', () => {
    expect(DesktopSettingsSchema({})).toEqual({ mode: 'compatibility', logLevel: 'info' })
    expect(() => DesktopSettingsSchema({ logLevel: 'verbose' })).toThrow()
  })
})
```

（`DesktopSettingsSchema` 是 schemastery 的 schema，调用即校验；具体校验函数形态以实现阶段核实为准。）

- [ ] **Step 2: 跑测试确认失败**

Run: `yarn vitest run tests/index.spec.ts`
Expected: FAIL。

- [ ] **Step 3: 修改 `src/index.ts`**

在 `DesktopSettings` / `DesktopSettingsSchema` 加 `logLevel`，并在 `apply()` 里注册 exporter：

```ts
import { app } from 'electron'
// 其余 import 保持不变，新增：
import { FileExporter } from './file-exporter.ts'
import { LogFileSink } from './log-files.ts'
import { join } from 'node:path'

export interface DesktopSettings {
  mode: DesktopShellMode
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export const DesktopSettingsSchema: z<DesktopSettings> = z.object({
  mode: z.union(['compatibility', 'advanced'] as const).default('compatibility'),
  logLevel: z.union(['debug', 'info', 'warn', 'error'] as const).default('info'),
})
```

在 `apply()` 里（`settings` 注册之后）加：

```ts
  const settings = ctx.settings.register(DESKTOP_SETTINGS_NAMESPACE, DesktopSettingsSchema, { applies: 'restart', validate: ... })
  // 新增：日志落盘
  const logSink = new LogFileSink(join(app.getPath('userData'), 'logs'), {
    maxFileBytes: 10 * 1024 * 1024,
    maxDirectoryBytes: 200 * 1024 * 1024,
  })
  logSink.enforceDirectoryCap()
  const fileExporter = new FileExporter(logSink, settings.get()?.logLevel ?? 'info')
  ctx.effect(() => {
    const dispose = ctx.logger.exporter(fileExporter)
    const stopWatching = settings.watch((next) => { fileExporter.setThreshold(next.logLevel) })
    return () => { stopWatching(); dispose(); fileExporter.close() }
  }, 'dsh-plugin-desktop: file logger')
```

（`FileExporter.setThreshold(level)` 是 Task 3 需要补的 setter；`settings.get()` 的准确签名以实现阶段核实。若 `app` 不可用则通过 `DesktopRuntime` 传入 logs 目录——以实际可用的 `app.getPath('userData')` 为准。）

- [ ] **Step 4: 跑测试 + typecheck**

Run: `yarn vitest run tests/index.spec.ts && yarn workspace dsh-plugin-desktop typecheck`
Expected: PASS + typecheck 通过。

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-desktop/src/index.ts dsh-plugin-desktop/src/file-exporter.ts dsh-plugin-desktop/tests/index.spec.ts
git commit -m "feat(desktop): register file logger and logLevel setting"
```

---

## 后续计划（不在本次范围）

- **阶段 3 查看面板 + 清空**：`logs` Typert Remote 服务（`list({tail})`/`clear()`）+ 设置页 tab + 打开文件夹按钮。依赖 Typert 代码生成器，需单独计划。
- **桌面壳自身错误落盘**：`main.ts` / `electron-runtime.ts` 的 `process.stderr.write(...)` 改走 sink（`write('error', …)`），需给 `ElectronDesktopRuntime` 传入 logger，单独计划。

## Self-Review

**Spec coverage：** 阶段 1（落盘：sink + 轮转 + 安全阀）→ Task 2；阶段 2（级别配置 + 过滤）→ Task 1 + Task 4。文件组织（§4）、行格式（§7 由 `Logger.format` 保证）落实在 Task 2/3。查看面板（§5.3）列为后续。

**Placeholder scan：** 无 TBD；Task 4 里 `settings.get()`/`app.getPath` 的精确签名标注了"以实现阶段核实"——这是明确的可验证点，非占位。

**Type consistency：** `LogType`/`LogLevel`/`shouldEmit`/`isErrorType`（Task 1）→ `LogFileSink.write(type, line)`（Task 2）→ `FileExporter`（Task 3）→ `index.ts`（Task 4），类型一致。
