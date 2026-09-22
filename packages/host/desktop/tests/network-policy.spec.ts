/**
 * 客户端"禁止使用任何代理"策略（2026-09-22 定案）。
 *
 * 真机判据在 `temp/proxy-probe/REPORT.md`：默认跟随宿主机代理、`no-proxy-server`
 * 覆盖全部 session 且压过显式 `--proxy-server`、逐 session `setProxy` 会漏分区、
 * Node 栈只有换 dispatcher 才撤得掉 `NODE_USE_ENV_PROXY`。
 *
 * 本文件守住两件事：
 *  1. 纯策略逻辑（判定顺序、真值、环境清理、dispatcher 替换）；
 *  2. **接线**（`main.ts` 必须在 `app.whenReady()` 之前 append 开关、必须清环境）——
 *     接线断了不会有任何运行时症状，只会静默回到"跟随宿主机代理"。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  ALLOW_SYSTEM_PROXY_ENV,
  applySystemProxyPolicy,
  enforceDirectNodeTransport,
  isEnabledFlag,
  lateAllowSystemProxyWarning,
  NODE_ENV_PROXY_FLAG,
  NO_PROXY_SWITCH,
  PROXY_ENV_NAMES,
  resolveSystemProxyPolicy,
  stripProxyEnvironment,
  type NodeDispatcherModule,
} from '../src/network-policy.ts'
import { parseDesktopChannelProfile } from '../src/desktop-channel.ts'

const REPO = join(__dirname, '../../../..')

function read(rel: string): string {
  return readFileSync(join(REPO, rel), 'utf8')
}

describe('出口策略判定：默认禁止，环境变量 > 渠道包 > 缺省', () => {
  it('没有任何配置时禁止代理', () => {
    expect(resolveSystemProxyPolicy({}, undefined)).toEqual({ allow: false, source: 'default' })
    expect(resolveSystemProxyPolicy({}, {})).toEqual({ allow: false, source: 'default' })
    expect(resolveSystemProxyPolicy({}, { allowSystemProxy: false })).toEqual({ allow: false, source: 'default' })
  })

  it('渠道包 desktop.allow_system_proxy: true 才允许，且来源记为 channel', () => {
    expect(resolveSystemProxyPolicy({}, { allowSystemProxy: true })).toEqual({ allow: true, source: 'channel' })
  })

  it('环境变量是**双向**开关，且压过渠道包', () => {
    expect(resolveSystemProxyPolicy({ [ALLOW_SYSTEM_PROXY_ENV]: '1' }, { allowSystemProxy: false }))
      .toEqual({ allow: true, source: 'environment' })
    // 显式关：渠道包开了也仍然禁止（"默认禁止"不能被渠道配置单方面推翻成无法回退）。
    expect(resolveSystemProxyPolicy({ [ALLOW_SYSTEM_PROXY_ENV]: '0' }, { allowSystemProxy: true }))
      .toEqual({ allow: false, source: 'environment' })
  })

  it('环境变量名大小写都认（Windows 环境名大小写不敏感）', () => {
    expect(resolveSystemProxyPolicy({ [ALLOW_SYSTEM_PROXY_ENV.toLowerCase()]: 'true' }, undefined))
      .toEqual({ allow: true, source: 'environment' })
  })

  it('真值表：只有明确的关闭值算关闭', () => {
    for (const off of ['', ' ', '0', 'false', 'FALSE', 'no', 'off']) expect(isEnabledFlag(off)).toBe(false)
    for (const on of ['1', 'true', 'yes', 'on', 'TRUE', ' 1 ']) expect(isEnabledFlag(on)).toBe(true)
    expect(isEnabledFlag(undefined)).toBe(false)
  })

  it('渠道包只认严格布尔 true（字符串 "true" 按缺省=禁止处理，误读只会更严）', () => {
    const profile = parseDesktopChannelProfile({
      channel_id: 'acme',
      desktop: { app_origin_scheme: 'acme-app', allow_system_proxy: 'true' },
    })
    expect(profile?.allowSystemProxy).toBe(false)
    const strict = parseDesktopChannelProfile({
      channel_id: 'acme',
      desktop: { app_origin_scheme: 'acme-app', allow_system_proxy: true },
    })
    expect(strict?.allowSystemProxy).toBe(true)
    // 缺省路径（官方构建/未配该字段）与渠道化改造前一致。
    const bare = parseDesktopChannelProfile({ channel_id: 'acme', desktop: { app_origin_scheme: 'acme-app' } })
    expect(bare?.allowSystemProxy).toBe(false)
  })
})

describe('Chromium 开关', () => {
  it('禁止时 append no-proxy-server，允许时一个开关都不动', () => {
    const appended: string[] = []
    const commandLine = { appendSwitch: (name: string) => { appended.push(name) } }
    expect(applySystemProxyPolicy(commandLine, { allow: false, source: 'default' })).toBe(true)
    expect(appended).toEqual([NO_PROXY_SWITCH])
    appended.length = 0
    expect(applySystemProxyPolicy(commandLine, { allow: true, source: 'channel' })).toBe(false)
    expect(appended).toEqual([])
  })
})

describe('代理环境清理', () => {
  it('删掉大小写两套代理名与 NODE_USE_ENV_PROXY，并如实回报删除项', () => {
    const env: Record<string, string | undefined> = {
      HTTP_PROXY: 'http://proxy.example.com:8080',
      https_proxy: 'http://proxy.example.com:8080',
      NO_PROXY: 'localhost',
      [NODE_ENV_PROXY_FLAG]: '1',
      PATH: '/usr/bin',
      DSH_HOME: '/home/u/.picoaide-harness',
    }
    const removed = stripProxyEnvironment(env)
    expect(removed).toEqual(['HTTP_PROXY', 'https_proxy', 'NO_PROXY', NODE_ENV_PROXY_FLAG])
    for (const name of [...PROXY_ENV_NAMES, NODE_ENV_PROXY_FLAG]) expect(env[name]).toBeUndefined()
    // 非代理名一字不动（尤其 DSH_ 与 PATH）。
    expect(env.PATH).toBe('/usr/bin')
    expect(env.DSH_HOME).toBe('/home/u/.picoaide-harness')
  })

  it('本来就没有代理配置时什么都不报', () => {
    expect(stripProxyEnvironment({ PATH: '/usr/bin' })).toEqual([])
  })
})

describe('Node 栈（undici dispatcher）', () => {  function fakeUndici(): { module: NodeDispatcherModule; installed: unknown[]; agent: object } {
    const agent = { kind: 'direct-agent' }
    const installed: unknown[] = []
    return {
      agent,
      installed,
      module: {
        Agent: class { constructor() { return agent as never } } as unknown as NodeDispatcherModule['Agent'],
        getGlobalDispatcher: () => ({ kind: 'env-proxy-agent' }),
        setGlobalDispatcher: (dispatcher: unknown) => { installed.push(dispatcher) },
      },
    }
  }

  it('宿主机没设 NODE_USE_ENV_PROXY 时完全不加载 undici', async () => {
    const load = vi.fn()
    expect(await enforceDirectNodeTransport({ HTTP_PROXY: 'http://proxy.example.com:8080' }, load)).toBe('not-requested')
    expect(load).not.toHaveBeenCalled()
    expect(await enforceDirectNodeTransport({ [NODE_ENV_PROXY_FLAG]: '0' }, load)).toBe('not-requested')
    expect(load).not.toHaveBeenCalled()
  })

  it('设了就换成直连 Agent（删环境变量撤不掉它，唯一可用手段）', async () => {
    const fake = fakeUndici()
    expect(await enforceDirectNodeTransport({ [NODE_ENV_PROXY_FLAG]: '1' }, async () => fake.module)).toBe('swapped')
    expect(fake.installed).toEqual([fake.agent])
  })

  it('undici 不可用时如实回报，不抛（打包缺件也要能启动）', async () => {
    expect(await enforceDirectNodeTransport({ [NODE_ENV_PROXY_FLAG]: '1' }, async () => {
      throw new Error('Cannot find module undici')
    })).toBe('unavailable')
  })
})

describe('环境分层里的排障开关（.env 太晚，必须留痕而不是静默无效）', () => {
  it('真实进程环境设的开关：不报"太晚"（它本来就生效了）', () => {
    const env = { [ALLOW_SYSTEM_PROXY_ENV]: '1' }
    expect(lateAllowSystemProxyWarning(env, resolveSystemProxyPolicy(env, undefined))).toBeUndefined()
  })

  it('.env 分层注入的开关：报一行说明为什么没生效', () => {
    const policy = resolveSystemProxyPolicy({}, undefined)
    const warning = lateAllowSystemProxyWarning({ [ALLOW_SYSTEM_PROXY_ENV]: '1' }, policy)
    expect(warning).toContain(ALLOW_SYSTEM_PROXY_ENV)
    expect(warning).toContain('real process environment')
    // 关闭值或没设：不产生日志噪音。
    expect(lateAllowSystemProxyWarning({ [ALLOW_SYSTEM_PROXY_ENV]: '0' }, policy)).toBeUndefined()
    expect(lateAllowSystemProxyWarning({}, policy)).toBeUndefined()
  })
})

describe('接线（源码级）：开关必须早于 app.whenReady()，清理必须发生在出站之前', () => {
  const main = read('packages/host/desktop/src/main.ts')
  const policy = read('packages/host/desktop/src/network-policy.ts')

  it('唯一字面量在 network-policy.ts，main.ts 只调用策略函数', () => {
    expect(policy).toContain(`export const NO_PROXY_SWITCH = '${NO_PROXY_SWITCH}'`)
    expect(main).toContain('applySystemProxyPolicy(app.commandLine, SYSTEM_PROXY_POLICY)')
  })

  it('append 发生在 app.whenReady() 之前（晚一行 Chromium 就不再读它）', () => {
    const call = main.indexOf('applySystemProxyPolicy(app.commandLine, SYSTEM_PROXY_POLICY)')
    const ready = main.indexOf('await app.whenReady()')
    expect(call).toBeGreaterThan(-1)
    expect(ready).toBeGreaterThan(-1)
    expect(call).toBeLessThan(ready)
  })

  it('策略在模块作用域取值（不能是插件 apply 期的 Config：那时已经晚于 ready）', () => {
    const declaration = main.indexOf('const SYSTEM_PROXY_POLICY = resolveSystemProxyPolicy(process.env, CHANNEL_PROFILE)')
    expect(declaration).toBeGreaterThan(-1)
    expect(declaration).toBeLessThan(main.indexOf('async function start()'))
  })

  it('loadLayeredEnv 之后清环境 + 撤 Node dispatcher（子进程与主进程两侧都断）', () => {
    const envLoad = main.indexOf('loadLayeredEnv(BIN_NAME, process.cwd())')
    const transport = main.indexOf('await enforceDirectNodeTransport(process.env)')
    const strip = main.indexOf('stripProxyEnvironment(process.env)')
    expect(envLoad).toBeGreaterThan(-1)
    expect(transport).toBeGreaterThan(envLoad)
    expect(strip).toBeGreaterThan(transport)
    // 撤销 dispatcher 必须发生在任何插件出站之前：boot() 在同一段代码里更靠后。
    expect(strip).toBeLessThan(main.indexOf('await boot('))
  })
})
