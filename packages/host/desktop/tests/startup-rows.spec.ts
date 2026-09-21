/**
 * 守卫：桌面自有 Loader 行的「必需 ACTIVE」清单与断言。
 *
 * 背景（2026-09-20 DSH 0.1.6 升级审计 P0-9）：上游 `auditStartupEntries` 只对
 * 7 个全局 required id 抛错，我方 19 个行失败只 warn（且"树上不存在"与"被 disabled"
 * 两类被它明确忽略）；Windows GUI 无 stderr ⇒ 静默。`src/startup-rows.ts` 为此补了
 * 一条 boot 后断言，本文件守住它：
 * ①清单里的每个 id 必须真的出现在桌面组合树里（改名/被 filterRows 丢掉时先红，
 * 而不是等真机启动）；②`FIBER_ACTIVE` 必须与上游 cordis 的 `FiberState` 一致
 * （const enum 运行时被擦除 ⇒ 只能对拍声明）；③断言本身对"缺席/禁用/无 fiber/
 * 状态不对"四种形态都判红（否则清单在、判据假）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { prepareDesktopProfile } from '../src/profile.ts'
import {
  assertRequiredRowsActive,
  FIBER_ACTIVE,
  FIBER_FAILED,
  inactiveRequiredRows,
  REQUIRED_DESKTOP_ROWS,
} from '../src/startup-rows.ts'

const require_ = createRequire(import.meta.url)
const homes: string[] = []

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-startup-rows-'))
  homes.push(dir)
  return dir
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop() as string, { recursive: true, force: true })
})

describe('desktop required startup rows', () => {
  it('every required row id exists in the composed desktop profile', async () => {
    const prepared = await prepareDesktopProfile(undefined, home(), 'linux')
    const rows = composeEntries([prepared.patches])
    const ids = new Set(rows.map(row => row.id))
    const missing = REQUIRED_DESKTOP_ROWS.filter(id => !ids.has(id))
    // 行被改名、或 filterRows 把它当"解析不到的客户端行"丢掉时，这里先红：
    // 否则真机上只会看到"功能不见了"，没有任何错误。
    expect(missing).toEqual([])
  })

  it('the required rows are enabled in the composition', async () => {
    const prepared = await prepareDesktopProfile(undefined, home(), 'linux')
    const rows = composeEntries([prepared.patches])
    const disabled = REQUIRED_DESKTOP_ROWS
      .map(id => rows.find(row => row.id === id))
      .filter(row => row !== undefined && row.disabled === true)
      .map(row => row?.id)
    expect(disabled).toEqual([])
  })

  it('FIBER_ACTIVE matches the upstream cordis FiberState declaration', () => {
    const fiberTypes = join(
      dirname(require_.resolve('@deepseek-ai/cordis/package.json')),
      'lib', 'types', 'fiber.d.ts',
    )
    const source = readFileSync(fiberTypes, 'utf8')
    const declared = /const enum FiberState \{([\s\S]*?)\}/.exec(source)?.[1] ?? ''
    const active = /ACTIVE\s*=\s*(\d+)/.exec(declared)?.[1]
    const failed = /FAILED\s*=\s*(\d+)/.exec(declared)?.[1]
    expect(active, 'cordis fiber.d.ts 里找不到 FiberState.ACTIVE').toBeDefined()
    expect(failed, 'cordis fiber.d.ts 里找不到 FiberState.FAILED').toBeDefined()
    expect(Number(active)).toBe(FIBER_ACTIVE)
    expect(Number(failed)).toBe(FIBER_FAILED)
  })

  it('flags absent, disabled, fiber-less and non-active rows', () => {
    const active = { options: { id: 'desktop-shell' }, fiber: { state: FIBER_ACTIVE } }
    const problems = inactiveRequiredRows([
      active,
      { options: { id: 'desktop-diagnostics' }, disabled: true, fiber: { state: FIBER_ACTIVE } },
      { options: { id: 'desktop-updates' } },
      { options: { id: 'desktop-loop-notify' }, fiber: { state: 3 } },
    ], ['desktop-shell', 'desktop-diagnostics', 'desktop-updates', 'desktop-loop-notify', 'pico-cron'])
    expect(problems.map(p => p.id)).toEqual([
      'desktop-diagnostics', 'desktop-updates', 'desktop-loop-notify', 'pico-cron',
    ])
    expect(problems[0]?.reason).toContain('disabled')
    expect(problems[1]?.reason).toContain('no fiber')
    expect(problems[2]?.reason).toContain('fiber state 3')
    expect(problems[3]?.reason).toContain('absent')
  })

  it('throws with the offending rows and stays quiet when all are active', () => {
    const entries = REQUIRED_DESKTOP_ROWS.map(id => ({ options: { id }, fiber: { state: FIBER_ACTIVE } }))
    expect(() => { assertRequiredRowsActive({ loader: { entries: () => entries } }) }).not.toThrow()

    // 变异等价形态：把桌面壳置为 FAILED，断言必须抛出并点名该行。
    const broken = entries.map(entry => entry.options.id === 'desktop-shell'
      ? { ...entry, fiber: { state: 3 } }
      : entry)
    expect(() => { assertRequiredRowsActive({ loader: { entries: () => broken } }) })
      .toThrow(/desktop-shell/)
  })

  it('fails loudly when the Loader surface is unavailable', () => {
    // 拿不到 loader 时不能"就当通过"——那正是要修的静默形态。
    expect(() => { assertRequiredRowsActive({}) }).toThrow(/ctx\.loader is unavailable/)
  })
})
