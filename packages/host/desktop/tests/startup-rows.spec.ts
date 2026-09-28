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
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { prepareDesktopProfile } from '../src/profile.ts'
import {
  assertRequiredClientEntries,
  assertRequiredRowsActive,
  FIBER_ACTIVE,
  FIBER_FAILED,
  inactiveRequiredRows,
  missingRequiredClientEntries,
  REQUIRED_CLIENT_ENTRIES,
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

/**
 * 第二张面（2026-09-28，审计 §8.9.12）：客户端条目列表里的必需包。
 *
 * 这一组判据守的是**可观测结果**：宿主下发的 `__DSH_BOOT__.entries` 里必须有
 * `dsh-plugin-desktop`（客户端 layout 的唯一提供者）。上游把"解析不出来的行"静默跳过，
 * 实测能让它消失而宿主启动成功 ⇒ 登录后整页 Failed to load plugins。
 */
describe('desktop required client entries', () => {
  const ctxWith = (ids: readonly string[]) => ({
    get: (name: string) => name === 'clientModules'
      ? { graph: () => ({ entries: ids.map(id => ({ id })) }) }
      : undefined,
  })

  it('the required list names this package, and the name is the packaged one', () => {
    const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { name?: string }
    // 包改名而清单没跟着改时，断言会变成对另一个 id 的恒假检查 —— 这里先红。
    expect(REQUIRED_CLIENT_ENTRIES).toContain(manifest.name)
  })

  it('is quiet when the entry is present, and names it when missing', () => {
    expect(missingRequiredClientEntries(ctxWith(['dsh-plugin-desktop', '@deepseek-ai/dsh-client-ui-sidebar'])))
      .toEqual([])
    // 现场形态：条目数 > 0（68 条）但少了桌面自己那一条 ⇒ 只看"非空"的判据是假绿。
    expect(missingRequiredClientEntries(ctxWith(['@deepseek-ai/dsh-client-ui-sidebar'])))
      .toEqual(['dsh-plugin-desktop'])
    expect(() => { assertRequiredClientEntries(ctxWith(['@deepseek-ai/dsh-client-ui-sidebar'])) })
      .toThrow(/dsh-plugin-desktop/)
    expect(() => { assertRequiredClientEntries(ctxWith(['dsh-plugin-desktop'])) }).not.toThrow()
  })

  it('reports "not audited" (undefined) instead of "passed" when the surface is absent', () => {
    // 组合里没有客户端模块系统时，这是"没有可判的面"，不是"判过且通过"：
    // 返回值必须与"空数组"区分开（真挂宿主面的组合不该被静默放过）。
    expect(missingRequiredClientEntries({ get: () => undefined })).toBeUndefined()
    expect(missingRequiredClientEntries({ get: () => ({}) })).toBeUndefined()
    expect(() => { assertRequiredClientEntries({ get: () => undefined }) }).not.toThrow()
  })

  it('main.ts wires the assertion into the boot path', () => {
    // 判据本体有牙、但没接线 = 静默通过（本仓记录过的形态）。这里钉住调用点，
    // 且必须出现在 `assertRequiredRowsActive` 之后（同一段 boot 收尾）。
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts'), 'utf8')
    const rowsAt = source.indexOf('assertRequiredRowsActive(ctx)')
    const entriesAt = source.indexOf('assertRequiredClientEntries(ctx)')
    expect(rowsAt, 'main.ts 里找不到 assertRequiredRowsActive(ctx)').toBeGreaterThan(-1)
    expect(entriesAt, 'main.ts 里找不到 assertRequiredClientEntries(ctx)').toBeGreaterThan(rowsAt)
  })
})
