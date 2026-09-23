/**
 * B-02（2026-09-23 独立审计 P1）：致命启动失败必须有**用户可见出口**。
 *
 * 缺陷形态：`main.ts` 的致命 `catch` 只 `errorCause` + `exit 1`，而
 * `startup-rows.ts` 的模块注释**自称**会弹恢复对话框 —— 注释与实现不一致。
 * 打包 GUI 上（Windows 双击 / macOS 启动台）没有 stderr 接收方、也没有窗口，
 * "必要行没激活 / 数据根不可写 / YAML 解析失败"全都表现为双击之后什么都没有。
 *
 * 判据分两层：
 *  1. **行为**：对话框选项（三个出口的返回值语义）、打开日志后重新询问、
 *     原生面不可用时的兜底与"绝不抛穿"；
 *  2. **接线**：`main.ts` 的 catch 真的调用它（并且顺序在退出之前），
 *     `startup-rows.ts` 的注释点向真实实现（注释与实现必须一致）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  fatalBootDialogOptions,
  reportFatalBootFailure,
  type FatalBootDialogCopy,
  type FatalBootSurface,
} from '../src/fatal-boot.ts'

const COPY: FatalBootDialogCopy = {
  title: 'Example Harness 无法启动',
  message: 'Example Harness 启动失败，已关闭。',
  detail: 'boom\n\n日志目录：/tmp/example/logs',
  openLogs: '打开日志',
  retry: '重试',
  quit: '退出',
}

interface Surface {
  showMessageBoxSync: ReturnType<typeof vi.fn>
  showErrorBox: ReturnType<typeof vi.fn>
  openPath: ReturnType<typeof vi.fn>
}

function surface(responses: readonly number[]): Surface {
  const queue = [...responses]
  return {
    showMessageBoxSync: vi.fn(() => queue.shift() ?? 2),
    showErrorBox: vi.fn(),
    openPath: vi.fn(async () => ''),
  }
}

describe('致命启动错误面（B-02）', () => {
  it('按钮顺序即返回值语义：打开日志 / 重试 / 退出', () => {
    const options = fatalBootDialogOptions(COPY)
    expect(options.type).toBe('error')
    expect(options.buttons).toEqual(['打开日志', '重试', '退出'])
    // 默认 = 打开日志（致命失败的第一动作是取证）；Esc/关窗 = 退出（不是"重试"：
    // 用户没改任何东西之前重试只会再失败一次）。
    expect(options.defaultId).toBe(0)
    expect(options.cancelId).toBe(2)
    expect(options.detail).toContain('/tmp/example/logs')
  })

  it('选「重试」返回 retry，且不再打开日志', async () => {
    const ui = surface([1])
    await expect(reportFatalBootFailure(ui as unknown as FatalBootSurface, { copy: COPY, logDirectory: '/tmp/example/logs' })).resolves.toBe('retry')
    expect(ui.showMessageBoxSync).toHaveBeenCalledTimes(1)
    expect(ui.openPath).not.toHaveBeenCalled()
  })

  it('选「退出」（或关窗）返回 quit', async () => {
    const ui = surface([2])
    await expect(reportFatalBootFailure(ui as unknown as FatalBootSurface, { copy: COPY, logDirectory: '/tmp/example/logs' })).resolves.toBe('quit')
    expect(ui.openPath).not.toHaveBeenCalled()
  })

  it('选「打开日志」→ 打开目录后重新询问；日志打不开也要继续问', async () => {
    const ui = surface([0, 1])
    ui.openPath.mockResolvedValueOnce('ENOENT')
    const log = vi.fn()
    await expect(reportFatalBootFailure(ui as unknown as FatalBootSurface, { copy: COPY, logDirectory: '/tmp/example/logs', log }))
      .resolves.toBe('retry')
    expect(ui.openPath).toHaveBeenCalledWith('/tmp/example/logs')
    expect(ui.showMessageBoxSync).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not open the log directory'))
  })

  it('原生对话框不可用时退回 showErrorBox，仍然让用户看到（绝不静默）', async () => {
    const ui = surface([1])
    ui.showMessageBoxSync.mockImplementation(() => { throw new Error('no display') })
    const log = vi.fn()
    await expect(reportFatalBootFailure(ui as unknown as FatalBootSurface, { copy: COPY, logDirectory: '/tmp/example/logs', log })).resolves.toBe('quit')
    expect(ui.showErrorBox).toHaveBeenCalledWith(COPY.title, expect.stringContaining('boom'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fatal startup dialog unavailable'))
  })

  it('两个原生面都不可用时也不抛穿（只记录），由调用方以非零码退出', async () => {
    const ui = surface([1])
    ui.showMessageBoxSync.mockImplementation(() => { throw new Error('no display') })
    ui.showErrorBox.mockImplementation(() => { throw new Error('no window server') })
    const log = vi.fn()
    await expect(reportFatalBootFailure(ui as unknown as FatalBootSurface, { copy: COPY, logDirectory: '/tmp/example/logs', log })).resolves.toBe('quit')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('fatal startup error box unavailable'))
  })
})

describe('main.ts / startup-rows.ts 的接线与注释一致性（B-02）', () => {
  const mainSource = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8')
  const rowsSource = readFileSync(fileURLToPath(new URL('../src/startup-rows.ts', import.meta.url)), 'utf8')

  /** 致命 catch 块（`errorCause` 那一个）的源码片段。 */
  function fatalCatch(): string {
    const at = mainSource.indexOf('electronLogger.errorCause(cause)')
    expect(at, 'main.ts 必须保留致命路径的 errorCause').toBeGreaterThan(-1)
    return mainSource.slice(at, at + 1_500)
  }

  it('致命 catch 真的调用原生错误面，且顺序在退出之前', () => {
    const block = fatalCatch()
    // 锚在真实调用语句上（注释里也提到了 `shutdown.request(1)`，不能用裸子串）。
    const dialogAt = block.indexOf('\n    const action = await reportFatalStartupFailure(')
    const exitAt = block.indexOf('\n    await shutdown.request(')
    expect(dialogAt, '致命路径必须调用 reportFatalStartupFailure（否则用户什么都看不到）').toBeGreaterThan(-1)
    expect(exitAt, '致命路径必须仍然以显式退出收尾').toBeGreaterThan(-1)
    expect(exitAt, '弹窗必须在退出之前').toBeGreaterThan(dialogAt)
  })

  it('接的是真的 Electron 原生面（不是空实现）', () => {
    // 三个出口依赖的原生能力：富对话框、兜底错误框、打开日志目录。
    for (const needle of ['dialog.showMessageBoxSync(', 'dialog.showErrorBox(', 'shell.openPath(']) {
      expect(mainSource, `main.ts 必须接线 ${needle}`).toContain(needle)
    }
    expect(mainSource).toContain("from './fatal-boot.ts'")
    // 重试必须走既有的 relaunch 通道（code 0 才真重启，见 shutdown.ts）。
    expect(fatalCatch()).toContain('requestRelaunch()')
  })

  it('详情里的日志目录与日志系统同源（<userData>/logs）', () => {
    expect(mainSource).toContain("join(app.getPath('userData'), 'logs')")
    // 详情先过掩码：原生弹窗是渠道客户可见面，不能比日志更"诚实"。
    expect(mainSource).toContain('maskSecrets(')
  })

  it('startup-rows 的注释与实现一致（指名真实实现文件）', () => {
    expect(rowsSource).toContain('fatal-boot.ts')
    expect(rowsSource).toContain('reportFatalStartupFailure')
  })
})
