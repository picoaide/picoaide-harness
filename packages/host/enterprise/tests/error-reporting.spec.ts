import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '../src/server-connector/config.ts'
import {
  apply,
  captureRendererError,
  captureRendererGone,
  dsnHostOf,
  getErrorReportingStatus,
  HEARTBEAT_TAG,
  initSentry,
  probeSdkDsnAcceptance,
  reportErrorReportingStatus,
  resetErrorReportingStatusForTest,
  SDK_REJECTED_DSN_REASON,
  unsupportedDsnReason,
} from '../src/error-reporting.ts'

type InitOpts = {
  dsn: string
  release: string
  beforeSend?: (e: { level?: string; tags?: Record<string, unknown> }) => unknown
}

/** @sentry/node 的最小替身:init/captureMessage/captureException/close 都可断言。 */
const sentryMock = vi.hoisted(() => {
  const captured: { init: InitOpts[] } = { init: [] }
  return {
    captured,
    init: vi.fn((opts: InitOpts) => { captured.init.push(opts) }),
    captureMessage: vi.fn(),
    captureException: vi.fn(),
    close: vi.fn(async () => true),
    /** 让下一次 init 抛错(模拟非法 DSN / 模块加载失败)。 */
    failNextInit: false,
    /**
     * F-04 探针的替身:有效时 `getClient()` 返回它,否则返回 undefined。
     * ESM 的模块命名空间对象不可扩展,所以探针面必须在 mock 工厂里就存在,
     * 由这个可变槽位切换返回内容。
     */
    clientProvider: undefined as undefined | (() => { getDsn: () => unknown }),
  }
})

vi.mock('@sentry/node', () => ({
  init: (opts: InitOpts) => {
    if (sentryMock.failNextInit) {
      sentryMock.failNextInit = false
      throw new Error('Invalid Sentry Dsn: boom')
    }
    sentryMock.init(opts)
  },
  captureMessage: sentryMock.captureMessage,
  captureException: sentryMock.captureException,
  close: sentryMock.close,
  getClient: () => sentryMock.clientProvider?.(),
}))

/** 状态上报(fetchJSON)捕获。 */
const reported: Array<{ path: string; body: Record<string, string> }> = []
let fetchShouldFail = false
vi.mock('../src/server-connector/auth.ts', () => ({
  fetchJSON: vi.fn(async (_serverURL: string, path: string, opts: { body?: unknown }) => {
    if (fetchShouldFail) throw new Error('network down')
    reported.push({ path, body: opts.body as Record<string, string> })
    return { ok: true }
  }),
}))

/** getBootstrap 替身:由每个用例设置返回值。 */
let bootstrapResult: { config: unknown; fellBack: boolean } | Error = {
  config: { default_model: 'm', models: [], skills: [], mcp: [], web: {} },
  fellBack: false,
}
// 只替换 getBootstrap,保留真实的 validateBootstrap —— 回退种类(empty vs
// default_model_substituted)本身就是被测契约,不能被替身抹平。
vi.mock('../src/server-connector/bootstrap.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/server-connector/bootstrap.ts')>()
  return {
    ...actual,
    getBootstrap: vi.fn(async () => {
      if (bootstrapResult instanceof Error) throw bootstrapResult
      return bootstrapResult
    }),
  }
})

/** subscribeSession 替身:捕获监听器,由用例手动触发会话变更。 */
let sessionListener: ((session: Session | null) => void) | null = null
vi.mock('../src/session-service.ts', () => ({
  subscribeSession: (_ctx: Context, listener: (session: Session | null) => void) => {
    sessionListener = listener
    return () => { sessionListener = null }
  },
  SESSION_CHANGED_EVENT: 'pico/session-changed',
}))

const SESSION: Session = { serverURL: 'https://gateway.example', username: 'tester', token: 'tok-1' }
const PUBLIC_KEY = 'deadbeefdeadbeefdeadbeefdeadbeef'
const GOOD_DSN = `https://${PUBLIC_KEY}@glitchtip.example.com/1`

function lastInit(): InitOpts {
  expect(sentryMock.init).toHaveBeenCalled()
  return sentryMock.init.mock.calls.at(-1)![0] as InitOpts
}

function initCalls(): number {
  return sentryMock.init.mock.calls.length
}

/** 造一个带 logger 收集器的 ctx。 */
function stubCtx(): { ctx: Context; warns: string[]; infos: string[]; debug: string[] } {
  const warns: string[] = []
  const infos: string[] = []
  const debug: string[] = []
  const ctx = {
    logger: {
      debug: (m: unknown) => { debug.push(String(m)) },
      info: (m: unknown) => { infos.push(String(m)) },
      warn: (...args: unknown[]) => { warns.push(args.map(String).join(' ')) },
      error: vi.fn(),
    },
  } as unknown as Context
  return { ctx, warns, infos, debug }
}

/** 运行一次 sync(经 apply + subscribeSession 的真实接线)。 */
async function runSync(ctx: Context, session: Session | null): Promise<void> {
  apply(ctx)
  expect(sessionListener).not.toBeNull()
  sessionListener!(session)
  // sync 是 async 且内部有 await(initSentry/getBootstrap);让微任务队列排空。
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(async () => {
  vi.clearAllMocks()
  resetErrorReportingStatusForTest()
  // sentry 是模块级单例:上一个用例 init 过就必须真的关掉,否则"未 init"类
  // 断言会被上一个用例的实例污染(测试隔离,不是被测行为)。
  await initSentry('', 'test-reset')
  vi.clearAllMocks()
  reported.length = 0
  fetchShouldFail = false
  sessionListener = null
  bootstrapResult = { config: { default_model: 'm', models: [], skills: [], mcp: [], web: {} }, fellBack: false, fallback: 'ok' }
})

// ---------------------------------------------------------------------------
// P0-3:状态机 + 失败不再静默
// ---------------------------------------------------------------------------

describe('initSentry 返回值与状态(P0-3)', () => {
  it('is a no-op for an empty DSN', async () => {
    await expect(initSentry('', 'r1')).resolves.toEqual({ ok: true })
    await expect(initSentry('   ', 'r1')).resolves.toEqual({ ok: true })
    expect(initCalls()).toBe(0)
    expect(sentryMock.captureMessage).not.toHaveBeenCalled()
    expect(getErrorReportingStatus()).toEqual({ state: 'disabled' })
  })

  it('calls init with the normalized DSN and release', async () => {
    await initSentry(`  ${GOOD_DSN}  `, '2.5.9')
    expect(initCalls()).toBe(1)
    const opts = lastInit()
    expect(opts.dsn).toBe(GOOD_DSN)
    expect(opts.release).toBe('2.5.9')
    expect(typeof opts.beforeSend).toBe('function')
    // 默认(未开心跳)不再无条件发自检:阈值 error 会吃掉它,发了也是噪音(F9)。
    expect(sentryMock.captureMessage).not.toHaveBeenCalled()
    expect(getErrorReportingStatus()).toEqual({ state: 'ready', dsnHost: 'glitchtip.example.com', level: 'error' })
  })

  it('closes a prior instance with a finite flush window', async () => {
    await initSentry(GOOD_DSN, 'r1')
    await initSentry(GOOD_DSN, 'r1')
    // close(1500) 而不是 close(0):后者会丢弃尚未冲刷的队列(P1-5 验证结论)。
    expect(sentryMock.close).toHaveBeenCalledWith(1500)
  })

  it('reports failed status and returns a reason when Sentry init throws', async () => {
    sentryMock.failNextInit = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await initSentry(GOOD_DSN, 'r1')
    expect(result.ok).toBe(false)
    expect(result).toHaveProperty('reason', 'Invalid Sentry Dsn: boom')
    expect(getErrorReportingStatus()).toMatchObject({ state: 'failed', reason: 'Invalid Sentry Dsn: boom', dsnHost: 'glitchtip.example.com' })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('filters events below the configured level (warning threshold)', async () => {
    await initSentry(GOOD_DSN, 'r1', 'warning')
    const { beforeSend } = lastInit()
    expect(beforeSend!({ level: 'debug' })).toBeNull()
    expect(beforeSend!({ level: 'info' })).toBeNull()
    expect(beforeSend!({ level: 'warning' })).toEqual({ level: 'warning' })
    expect(beforeSend!({ level: 'error' })).toEqual({ level: 'error' })
    expect(beforeSend!({ level: 'fatal' })).toEqual({ level: 'fatal' })
    // Missing level defaults to error (passes at warning threshold).
    expect(beforeSend!({})).toEqual({})
  })

  it('uses the error default threshold when the level is unknown', async () => {
    await initSentry(GOOD_DSN, 'r1', 'verbose')
    const { beforeSend } = lastInit()
    expect(beforeSend!({ level: 'info' })).toBeNull()
    expect(beforeSend!({ level: 'warning' })).toBeNull()
    expect(beforeSend!({ level: 'error' })).toEqual({ level: 'error' })
    expect(beforeSend!({ level: 'fatal' })).toEqual({ level: 'fatal' })
  })

  it('passes warning-level events at the default (error) threshold', async () => {
    await initSentry(GOOD_DSN, 'r1')
    const { beforeSend } = lastInit()
    expect(beforeSend!({ level: 'warning' })).toBeNull()
    expect(beforeSend!({ level: 'error' })).toEqual({ level: 'error' })
  })
})

// ---------------------------------------------------------------------------
// 修复轮 1:F-04「initSentry 谎报 ready」+ F-14 端口
// ---------------------------------------------------------------------------

describe('DSN 形状预检与 SDK 接受度(F-04/F-14)', () => {
  it('rejects DSNs the SDK would silently drop (port / shape), without calling init', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 端口越界:`@sentry/node` 不抛异常但把 transport 换成"不发任何事件"的空实现。
    for (const bad of [
      'https://key@glitchtip.example.com:99999/1',
      'https://key@glitchtip.example.com:0/1',
      'https://key@glitchtip.example.com:65536/1',
      'not-a-url',
      'https://key@glitchtip.example.com/0',
    ]) {
      const result = await initSentry(bad, 'r1')
      expect(result.ok, bad).toBe(false)
      expect(getErrorReportingStatus().state, bad).toBe('failed')
    }
    // 一条都不该进 SDK(进了就是"谎报 ready"的来源)。
    expect(initCalls()).toBe(0)
    warn.mockRestore()
  })

  it('reports failed when the SDK bound a client without a DSN (谎报 ready 的真实路径)', async () => {
    // 模拟 `@sentry/node` 对非法 DSN 的行为:init 不抛,但 client.getDsn() 为空
    // (复核员实测 `https://key@[fd00::1]/1` 就是这条路径)。
    sentryMock.clientProvider = () => ({ getDsn: () => undefined })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await initSentry('https://key@[fd00::1]/1', 'r1')
      expect(result.ok).toBe(false)
      expect(result).toHaveProperty('reason', SDK_REJECTED_DSN_REASON)
      expect(getErrorReportingStatus()).toMatchObject({ state: 'failed', dsnHost: '[fd00::1]' })
      // 失败后绝不留下一个"看起来已 init"的实例(capture* 会假成功)。
      expect(captureRendererError({ type: 'error', message: 'x' })).toBe(false)
      expect(warn).toHaveBeenCalled()
    } finally {
      sentryMock.clientProvider = undefined
      warn.mockRestore()
    }
  })

  it('stays ready (fail-soft) when the SDK exposes no probe API', async () => {
    // 探针 API 拿不到 client(未来 SDK 改动/测试替身)= unknown ⇒ **不得**误判失败:
    // 因探针失效而把所有部署静默关掉,比原缺陷更严重。
    sentryMock.clientProvider = undefined
    await initSentry(GOOD_DSN, 'r1')
    expect(getErrorReportingStatus()).toMatchObject({ state: 'ready' })
    expect(probeSdkDsnAcceptance()).toBe('unknown')
  })

  it('accepts a DSN the SDK confirms (getDsn 非空)', async () => {
    sentryMock.clientProvider = () => ({ getDsn: () => ({ host: 'glitchtip.example.com' }) })
    try {
      await initSentry(GOOD_DSN, 'r1')
      expect(getErrorReportingStatus()).toMatchObject({ state: 'ready', dsnHost: 'glitchtip.example.com' })
    } finally {
      sentryMock.clientProvider = undefined
    }
  })

  it('unsupportedDsnReason 只拒绝"必然不可用",不越权改服务端策略', () => {
    // 私网/http 是服务端的告警语义,客户端必须原样放行(内网自建是合法主场景)。
    expect(unsupportedDsnReason('http://key@10.0.0.5/1')).toBeUndefined()
    expect(unsupportedDsnReason('https://key@glitchtip.example.com/sentry/1')).toBeUndefined()
    expect(unsupportedDsnReason('https://key:secret@glitchtip.example.com/1')).toBeUndefined()
    expect(unsupportedDsnReason('https://key@[2001:db8::1]/1')).toBeUndefined()
    expect(unsupportedDsnReason('https://key@glitchtip.example.com:65535/1')).toBeUndefined()
    expect(unsupportedDsnReason('ftp://key@glitchtip.example.com/1')).toContain('不受支持')
    expect(unsupportedDsnReason('https://key@glitchtip.example.com:99999/1')).toContain('端口')
  })
})

describe('sync() 状态映射(P0-3)', () => {
  it('reports config_unavailable when bootstrap falls back to EMPTY', async () => {
    // ★ PLAN §2.6 的最强静默路径:服务端下发了 DSN,但 models 为空 ⇒ 整份配置
    // 被换成 EMPTY(web:{}) ⇒ 旧实现一个字节都不发、连 warn 都没有。
    bootstrapResult = { config: { default_model: '', models: [], skills: [], mcp: [], web: {} }, fellBack: true, fallback: 'empty' }
    const { ctx, warns } = stubCtx()
    await runSync(ctx, SESSION)
    expect(getErrorReportingStatus()).toMatchObject({ state: 'config_unavailable' })
    expect(initCalls()).toBe(0)
    expect(warns.some((w) => w.includes('服务端配置不可用'))).toBe(true)
    // 状态必须回传服务端(P1-3)。
    expect(reported.some((r) => r.path === '/api/client/v2/telemetry/error-reporting' && r.body.state === 'config_unavailable')).toBe(true)
  })

  it('reports config_unavailable when bootstrap rejects', async () => {
    bootstrapResult = new Error('AuthError: network')
    const { ctx, warns } = stubCtx()
    await runSync(ctx, SESSION)
    expect(getErrorReportingStatus()).toMatchObject({ state: 'config_unavailable', reason: 'AuthError: network' })
    expect(warns.some((w) => w.includes('bootstrap 失败'))).toBe(true)
  })

  it('reports disabled without a DSN and warns only once per process', async () => {
    bootstrapResult = {
      config: { default_model: 'm', models: [{ id: 'm' }], skills: [], mcp: [], web: { error_reporting_enabled: true, error_reporting_dsn: '   ' } },
      fellBack: false,
      fallback: 'ok',
    }
    const { ctx, warns } = stubCtx()
    await runSync(ctx, SESSION)
    expect(getErrorReportingStatus()).toEqual({ state: 'disabled' })
    expect(warns.filter((w) => w.includes('错误上报未启用')).length).toBe(1)

    // 第二次 sync(如登出后重新登录)不得再刷同一条 warn。
    sessionListener!(SESSION)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(warns.filter((w) => w.includes('错误上报未启用')).length).toBe(1)
  })

  it('reports ready with the dsn host and never logs the full DSN', async () => {
    bootstrapResult = {
      config: {
        default_model: 'm',
        models: [{ id: 'm' }],
        skills: [],
        mcp: [],
        web: { error_reporting_enabled: true, error_reporting_dsn: GOOD_DSN, error_reporting_level: 'warning' },
      },
      fellBack: false,
      fallback: 'ok',
    }
    const { ctx, warns, infos, debug } = stubCtx()
    await runSync(ctx, SESSION)
    expect(getErrorReportingStatus()).toEqual({ state: 'ready', dsnHost: 'glitchtip.example.com', level: 'warning' })
    // 成功路径必须有 info(默认日志阈值 info ⇒ 会落盘),这是链路活着的第一手痕迹。
    expect(infos.some((m) => m.includes('glitchtip.example.com'))).toBe(true)
    // 绝不打印完整 DSN / public key。
    const all = [...warns, ...infos, ...debug].join('\n')
    expect(all).not.toContain(PUBLIC_KEY)
    expect(all).not.toContain(GOOD_DSN)
    // 上报体也不含公钥或完整 DSN。
    const body = JSON.stringify(reported)
    expect(body).not.toContain(PUBLIC_KEY)
  })

  it('surfaces a failed init through status, warn log and the reported state', async () => {
    sentryMock.failNextInit = true
    bootstrapResult = {
      config: {
        default_model: 'm',
        models: [{ id: 'm' }],
        skills: [],
        mcp: [],
        web: { error_reporting_enabled: true, error_reporting_dsn: GOOD_DSN },
      },
      fellBack: false,
      fallback: 'ok',
    }
    const { ctx, warns } = stubCtx()
    await runSync(ctx, SESSION)
    expect(getErrorReportingStatus()).toMatchObject({ state: 'failed' })
    expect(warns.some((w) => w.includes('Sentry 初始化失败'))).toBe(true)
    expect(reported.some((r) => r.body.state === 'failed')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// P1-2:正向心跳(独立开关 + tag 定向绕过阈值)
// ---------------------------------------------------------------------------

describe('心跳开关(P1-2/D4)', () => {
  it('lets a heartbeat event pass the error threshold', async () => {
    await initSentry(GOOD_DSN, 'r1', 'error', true)
    const { beforeSend } = lastInit()
    const heartbeat = { level: 'info', tags: { [HEARTBEAT_TAG]: '1' } }
    expect(beforeSend!(heartbeat)).toEqual(heartbeat)
  })

  it('still filters ordinary info events when heartbeat is enabled', async () => {
    // ★ 这条是「error_reporting_level 语义未被破坏」的判据:心跳的例外**只**
    // 对带 tag 的事件生效,普通 info 事件仍被阈值丢掉。
    await initSentry(GOOD_DSN, 'r1', 'error', true)
    const { beforeSend } = lastInit()
    expect(beforeSend!({ level: 'info' })).toBeNull()
    expect(beforeSend!({ level: 'info', tags: { other: '1' } })).toBeNull()
  })

  it('sends exactly one heartbeat per process when enabled', async () => {
    await initSentry(GOOD_DSN, 'r1', 'error', true)
    expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1)
    expect(sentryMock.captureMessage.mock.calls[0]![0]).toContain('链路自检')
    const opts = sentryMock.captureMessage.mock.calls[0]![1] as { level?: string; tags?: Record<string, string> }
    expect(opts.level).toBe('info')
    expect(opts.tags?.[HEARTBEAT_TAG]).toBe('1')
    // 重 init(登录/登出)不重复发。
    await initSentry(GOOD_DSN, 'r1', 'error', true)
    expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1)
  })

  it('sends no heartbeat when the switch is off', async () => {
    await initSentry(GOOD_DSN, 'r1', 'error', false)
    expect(sentryMock.captureMessage).not.toHaveBeenCalled()
  })

  it('delivers the heartbeat switch from bootstrap to init', async () => {
    bootstrapResult = {
      config: {
        default_model: 'm',
        models: [{ id: 'm' }],
        skills: [],
        mcp: [],
        web: { error_reporting_enabled: true, error_reporting_dsn: GOOD_DSN, error_reporting_heartbeat: true },
      },
      fellBack: false,
      fallback: 'ok',
    }
    const { ctx } = stubCtx()
    await runSync(ctx, SESSION)
    expect(sentryMock.captureMessage).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// P1-3:状态上报服务端
// ---------------------------------------------------------------------------

describe('状态上报(P1-3/D7)', () => {
  it('reports the status to the server once per state', async () => {
    bootstrapResult = {
      config: {
        default_model: 'm',
        models: [{ id: 'm' }],
        skills: [],
        mcp: [],
        web: { error_reporting_enabled: true, error_reporting_dsn: GOOD_DSN },
      },
      fellBack: false,
      fallback: 'ok',
    }
    const { ctx } = stubCtx()
    await runSync(ctx, SESSION)
    const first = reported.filter((r) => r.path === '/api/client/v2/telemetry/error-reporting')
    expect(first.length).toBe(1)
    expect(first[0]!.body).toMatchObject({ state: 'ready', dsn_host: 'glitchtip.example.com' })
    expect(first[0]!.body.release).toContain('picoaide-desktop@')
    // 同一状态再报一次被去重(每次登录都刷 = 噪音)。
    sessionListener!(SESSION)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reported.filter((r) => r.path === '/api/client/v2/telemetry/error-reporting').length).toBe(1)
  })

  it('never fails the host when the status report rejects', async () => {
    fetchShouldFail = true
    bootstrapResult = {
      config: {
        default_model: 'm',
        models: [{ id: 'm' }],
        skills: [],
        mcp: [],
        web: { error_reporting_enabled: true, error_reporting_dsn: GOOD_DSN },
      },
      fellBack: false,
      fallback: 'ok',
    }
    const { ctx } = stubCtx()
    // 不抛、不阻断:Sentry 依然被 init,sync 正常结束。
    await expect(runSync(ctx, SESSION)).resolves.toBeUndefined()
    expect(getErrorReportingStatus()).toMatchObject({ state: 'ready' })
    expect(initCalls()).toBe(1)
  })

  it('does not report without a session', async () => {
    const ok = await reportErrorReportingStatus(null, { state: 'ready', dsnHost: 'h', level: 'error' })
    expect(ok).toBe(false)
    expect(reported.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// P0-6(D8):渲染进程采集
// ---------------------------------------------------------------------------

describe('渲染进程采集(P0-6/D8)', () => {
  it('captures a renderer error with process/kind tags after init', async () => {
    await initSentry(GOOD_DSN, 'r1')
    const ok = captureRendererError({
      type: 'error',
      message: 'Uncaught TypeError: x is not a function',
      stack: 'TypeError: x is not a function\n    at App (app.js:1:2)',
      source: 'app.js',
      lineno: 1,
      colno: 2,
      url: 'http://127.0.0.1:1/',
    })
    expect(ok).toBe(true)
    expect(sentryMock.captureException).toHaveBeenCalledTimes(1)
    const [error, hint] = sentryMock.captureException.mock.calls[0]! as [Error, { tags: Record<string, string>; extra: Record<string, unknown> }]
    expect(error.message).toBe('Uncaught TypeError: x is not a function')
    expect(error.stack).toContain('at App')
    expect(hint.tags['picoaide.process']).toBe('renderer')
    expect(hint.tags['picoaide.kind']).toBe('error')
    expect(hint.extra.lineno).toBe(1)
  })

  it('captures unhandled rejections distinctly', async () => {
    await initSentry(GOOD_DSN, 'r1')
    captureRendererError({ type: 'unhandledrejection', message: 'boom' })
    const [, hint] = sentryMock.captureException.mock.calls[0]! as [Error, { tags: Record<string, string> }]
    expect(hint.tags['picoaide.kind']).toBe('unhandledrejection')
  })

  it('captures a renderer crash with reason/exitCode tags (F-10)', async () => {
    await initSentry(GOOD_DSN, 'r1')
    const ok = captureRendererGone({ reason: 'oom', exitCode: 5 })
    expect(ok).toBe(true)
    // 修复轮 1(F-10):崩溃事件必须带 tag(此前走 captureMessage(msg, 'error') —
    // 第二参是 level,tags 丢失 ⇒ 后台无法用 picoaide.process 统一筛渲染进程问题)。
    const [message, context] = sentryMock.captureMessage.mock.calls[0]! as [
      string,
      { level: string; tags: Record<string, string>; extra: Record<string, unknown> },
    ]
    expect(message).toBe('渲染进程崩溃 (reason: oom, exitCode: 5)')
    expect(context.level).toBe('error')
    expect(context.tags['picoaide.process']).toBe('renderer')
    expect(context.tags['picoaide.kind']).toBe('render-process-gone')
    expect(context.tags['picoaide.reason']).toBe('oom')
    expect(context.tags['picoaide.exit_code']).toBe('5')
    expect(context.extra).toMatchObject({ reason: 'oom', exitCode: 5 })
  })

  it('silently drops renderer errors before init and never throws', async () => {
    // 未 init(未登录/开关关闭/init 失败)⇒ 静默丢弃,绝不抛 ——
    // 错误上报坏掉不得影响界面可用性。
    expect(() => captureRendererError({ type: 'error', message: 'x' })).not.toThrow()
    expect(captureRendererError({ type: 'error', message: 'x' })).toBe(false)
    expect(() => captureRendererGone({ reason: 'crashed', exitCode: 1 })).not.toThrow()
    expect(captureRendererGone({ reason: 'crashed', exitCode: 1 })).toBe(false)
    expect(sentryMock.captureException).not.toHaveBeenCalled()
    expect(sentryMock.captureMessage).not.toHaveBeenCalled()
  })

  it('never throws even when the Sentry call itself fails', async () => {
    await initSentry(GOOD_DSN, 'r1')
    sentryMock.captureException.mockImplementationOnce(() => { throw new Error('sdk exploded') })
    expect(captureRendererError({ type: 'error', message: 'x' })).toBe(false)
  })
})

describe('dsnHostOf', () => {
  it('returns the host only, never the public key', () => {
    expect(dsnHostOf(GOOD_DSN)).toBe('glitchtip.example.com')
    expect(dsnHostOf('https://key@host.example:8443/1')).toBe('host.example:8443')
    expect(dsnHostOf('not a dsn')).toBeUndefined()
    expect(dsnHostOf('')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 回修(2026-09-16):`fellBack` 的两种回退后果不同,不能一律关掉上报
// ---------------------------------------------------------------------------

describe('bootstrap 回退种类(P0-3 回修)', () => {
  it('keeps reporting when only default_model was substituted (benign fallback)', async () => {
    // ★ 实测缺陷:夹具/现场只要有 models 而 default_model 没配上,
    // validateBootstrap 就返回 fellBack=true —— 但**配置原样保留**、DSN 仍在。
    // 早期实现按布尔判定 ⇒ 静默关掉上报,一个字节都不发(正是本轮要消灭的缺陷)。
    bootstrapResult = {
      config: {
        default_model: 'deepseek-v4', // models[0] 的替补值
        models: [{ id: 'deepseek-v4' }],
        skills: [],
        mcp: [],
        web: { error_reporting_enabled: true, error_reporting_dsn: GOOD_DSN },
      },
      fellBack: true,
      fallback: 'default_model_substituted',
    }
    const { ctx, warns } = stubCtx()
    await runSync(ctx, SESSION)
    // 必须真的 init(而不是 config_unavailable)。
    expect(initCalls()).toBe(1)
    expect(getErrorReportingStatus()).toMatchObject({ state: 'ready', dsnHost: 'glitchtip.example.com' })
    expect(warns.some((w) => w.includes('未指定有效默认模型'))).toBe(true)
    expect(reported.some((r) => r.body.state === 'ready')).toBe(true)
  })

  it('validateBootstrap distinguishes empty from default_model substitution', async () => {
    const { validateBootstrap, EMPTY } = await import('../src/server-connector/bootstrap.ts')
    const empty = validateBootstrap({ default_model: '', models: [], skills: [], mcp: [], web: {} } as never)
    expect(empty.fallback).toBe('empty')
    expect(empty.fellBack).toBe(true)
    expect(empty.config).toBe(EMPTY)

    const substituted = validateBootstrap({
      default_model: 'missing-model',
      models: [{ id: 'real-model', display_name: 'Real' }],
      skills: [],
      mcp: [],
      web: { error_reporting_enabled: true, error_reporting_dsn: GOOD_DSN },
    })
    expect(substituted.fallback).toBe('default_model_substituted')
    expect(substituted.fellBack).toBe(true)
    // 关键:web 段(DSN/开关)必须原样保留。
    expect(substituted.config.web.error_reporting_dsn).toBe(GOOD_DSN)
    expect(substituted.config.default_model).toBe('real-model')

    const ok = validateBootstrap({
      default_model: 'real-model',
      models: [{ id: 'real-model', display_name: 'Real' }],
      skills: [],
      mcp: [],
      web: {},
    })
    expect(ok.fallback).toBe('ok')
    expect(ok.fellBack).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 修复轮 1:F-05 退出前冲刷必须把 promise 交回宿主
// ---------------------------------------------------------------------------

describe('退出冲刷的 disposer 契约(F-05)', () => {
  /** 造一个能收集 effect disposer 的 ctx(apply 时 Cordis 会调 ctx.effect)。 */
  function ctxWithDisposers(): { ctx: Context; disposers: Array<() => unknown> } {
    const disposers: Array<() => unknown> = []
    const ctx = {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      effect: (fn: () => () => unknown) => {
        disposers.push(fn())
        return () => {}
      },
      get: () => undefined,
    } as unknown as Context
    return { ctx, disposers }
  }

  it('disposer 返回 thenable(而不是 void 掉 close) —— 宿主才会等它', async () => {
    const { ctx, disposers } = ctxWithDisposers()
    apply(ctx)
    await initSentry(GOOD_DSN, 'r1')
    expect(disposers.length).toBeGreaterThan(0)
    const flush = disposers[0]!
    const returned = flush()
    // 关键判据:返回的必须是 close(1500) 的 promise。此前写成
    // `void current?.close(1500)` ⇒ 返回 undefined ⇒ 宿主立刻退出 ⇒ 实测到达 0 条。
    expect(typeof (returned as Promise<unknown> | undefined)?.then).toBe('function')
    await expect(returned as Promise<unknown>).resolves.toBe(true)
    expect(sentryMock.close).toHaveBeenCalledWith(1500)
    // 冲刷后实例已摘除:后续 capture* 静默丢弃(不会再用已关闭的 client)。
    expect(captureRendererError({ type: 'error', message: 'after-dispose' })).toBe(false)
  })

  it('未 init 时 disposer 返回 undefined 且不抛（无头组合/降级路径）', () => {
    const { ctx, disposers } = ctxWithDisposers()
    apply(ctx)
    expect(() => disposers[0]!()).not.toThrow()
    expect(disposers[0]!()).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 第 1 轮审计修复(ent-1 / ent-2 / ent-5):回归防线
// 发现来源:.multiagent/audit-beta3-introduced/round-1/FINDINGS-enterprise-reporting.md
// ---------------------------------------------------------------------------

describe('审计修复轮回归(ent-1: 状态说"不上报"就必须关掉旧实例)', () => {
  /** 造一份"已启用"的 bootstrap 响应(enabled=true + 好 DSN)。 */
  function enabledBootstrap(): { config: unknown; fellBack: boolean; fallback: string } {
    return {
      config: {
        default_model: 'm',
        models: [{ id: 'm' }],
        skills: [],
        mcp: [],
        web: { error_reporting_enabled: true, error_reporting_dsn: GOOD_DSN },
      },
      fellBack: false,
      fallback: 'ok',
    }
  }

  /** 走一次真实接线(apply + subscribeSession)让实例真的 init,并清空 close 记录。 */
  async function primeReady(ctx: Context): Promise<void> {
    await runSync(ctx, SESSION)
    expect(getErrorReportingStatus()).toMatchObject({ state: 'ready', dsnHost: 'glitchtip.example.com' })
    expect(initCalls()).toBe(1)
    sentryMock.close.mockClear()
  }

  it('ent-1: 开关关闭后必须 close 旧实例(disabled 分支不再外发)', async () => {
    bootstrapResult = enabledBootstrap()
    const { ctx, warns } = stubCtx()
    await primeReady(ctx)

    // 第二次会话变化(**无中间登出**,与审计 r2 B 段一致):服务端把开关关掉。
    bootstrapResult = {
      config: {
        default_model: 'm',
        models: [{ id: 'm' }],
        skills: [],
        mcp: [],
        web: { error_reporting_enabled: false, error_reporting_dsn: GOOD_DSN },
      },
      fellBack: false,
      fallback: 'ok',
    }
    sessionListener!(SESSION)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(getErrorReportingStatus()).toEqual({ state: 'disabled' })
    // ★ 回归点:基线在这里 `await initSentry('', release)` 关掉旧实例;改后 early
    // return 漏了这一步 ⇒ 旧 DSN 继续外发。close(1500) 是 initSentry('') 的关闭路径。
    expect(sentryMock.close).toHaveBeenCalledWith(1500)
    // 实例已摘除 ⇒ 渲染进程错误不再外发(capture 返回 falsy,SDK 一次都不被调用)。
    expect(captureRendererError({ type: 'error', message: 'AFTER-DISABLED' })).toBe(false)
    expect(captureRendererGone({ reason: 'crashed', exitCode: 1 })).toBe(false)
    expect(sentryMock.captureException).not.toHaveBeenCalled()
    expect(sentryMock.captureMessage).not.toHaveBeenCalled()
    // 日志不再说谎:它必须说明"已关闭上报",而不是"不会上报"却仍在发。
    expect(warns.some((w) => w.includes('已关闭上报'))).toBe(true)
  })

  it('ent-1/R3: 同服务端回退空配置 ⇒ 保留实例(抖动可自愈),状态转 config_unavailable', async () => {
    // 2026-09-17 第 3 轮审计 R3-ent-1:ent-1 当初"一律 close"的修法把**同服务端的
    // 一次抖动**放大成"本会话永久零上报"(只有下次 session-changed 才恢复),比修复前
    // 更差(修复前这两条分支不关实例、抖动自愈)。改成按**服务端身份是否变了**判定:
    // 同服务端 ⇒ 保留实例;换服务端 ⇒ 才关(避免拿旧租户 DSN 上报)。
    bootstrapResult = enabledBootstrap()
    const { ctx, warns } = stubCtx()
    await primeReady(ctx)

    bootstrapResult = {
      config: { default_model: '', models: [], skills: [], mcp: [], web: {} },
      fellBack: true,
      fallback: 'empty',
    }
    sessionListener!(SESSION)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // 状态如实说"本次不上报"…
    expect(getErrorReportingStatus()).toMatchObject({ state: 'config_unavailable' })
    expect(warns.length).toBeGreaterThan(0)
    // …但**不关**实例:同服务端的一次配置抖动不该永久停报。
    expect(sentryMock.close).not.toHaveBeenCalled()
    // 状态仍然回传服务端(P1-3 契约不变)。
    expect(reported.some((r) => r.body.state === 'config_unavailable')).toBe(true)
    void ctx
  })

  it('ent-1/R3: bootstrap 抛错且**换了服务端** ⇒ 必须 close(跨租户防线)', async () => {
    bootstrapResult = enabledBootstrap()
    const { ctx } = stubCtx()
    await primeReady(ctx)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      bootstrapResult = new Error('AuthError: network')
      // ★ 关键:换到**另一台服务端**(同机换账号/换租户的场景)。
      sessionListener!({ ...SESSION, serverURL: 'https://other-gateway.example', username: 'other' })
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(getErrorReportingStatus()).toMatchObject({ state: 'config_unavailable', reason: 'AuthError: network' })
      // 服务端身份变了 ⇒ 旧实例(上一个租户的 DSN)必须停,否则就是跨租户误报。
      expect(sentryMock.close).toHaveBeenCalledWith(1500)
      expect(captureRendererError({ type: 'error', message: 'AFTER-BOOTSTRAP-FAIL' })).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it('ent-1/R3: bootstrap 抛错但**服务端没变** ⇒ 保留实例(抖动自愈,不永久停报)', async () => {
    bootstrapResult = enabledBootstrap()
    const { ctx } = stubCtx()
    await primeReady(ctx)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      bootstrapResult = new Error('AuthError: network')
      sessionListener!(SESSION)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(getErrorReportingStatus()).toMatchObject({ state: 'config_unavailable' })
      // 服务端没变 ⇒ **不关**:一次网络抖动不该让本会话永久零上报(R3-ent-1)。
      expect(sentryMock.close).not.toHaveBeenCalled()
      void ctx
    } finally {
      warn.mockRestore()
    }
  })
})

describe('审计修复轮回归(ent-2: DSN 预检与 SDK 归一化对齐)', () => {
  it('ent-2: `/1abc` 形态不再被判 failed(SDK 归一成 project 1 并真实投递)', async () => {
    // 真实 SDK 的 `dsnFromString()` 取尾段**前导数字**作 projectId(/1abc ⇒ 1,
    // path 为空),审计用 A/B 对照实测事件真的投递到 `/api/1/envelope/`。
    // 此前全串匹配 `/^[0-9]+$/` 把这种"能用的形状"误判成必然不可用。
    expect(unsupportedDsnReason('https://key@glitchtip.example.com/1abc')).toBeUndefined()
    expect(unsupportedDsnReason('https://key@glitchtip.example.com/sentry/1abc')).toBeUndefined()

    sentryMock.clientProvider = () => ({ getDsn: () => ({ host: 'glitchtip.example.com' }) })
    try {
      const result = await initSentry('https://key@glitchtip.example.com/1abc', 'r1')
      expect(result).toEqual({ ok: true })
      // 预检放行 ⇒ 真的进了 SDK、状态是 ready(而不是 failed)。
      expect(initCalls()).toBe(1)
      expect(getErrorReportingStatus()).toMatchObject({ state: 'ready', dsnHost: 'glitchtip.example.com' })
    } finally {
      sentryMock.clientProvider = undefined
    }
  })

  it('ent-2: 放宽归一化没有放行确实非法的形状(缺 host / 非 http(s) / 非数字 / project 0)', async () => {
    // 这次修的是"误杀",不是"一律放行":预检的"必然不可用"判定面必须保留。
    expect(unsupportedDsnReason('https://key@/1')).toContain('不是合法的 URL')
    expect(unsupportedDsnReason('ftp://key@glitchtip.example.com/1')).toContain('不受支持')
    expect(unsupportedDsnReason('https://key@glitchtip.example.com:99999/1')).toContain('端口')
    expect(unsupportedDsnReason('https://key@glitchtip.example.com/abc')).toContain('项目 ID')
    expect(unsupportedDsnReason('https://key@glitchtip.example.com/0')).toContain('项目 ID')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const bad of [
        'https://key@/1',
        'ftp://key@glitchtip.example.com/1',
        'https://key@glitchtip.example.com/abc',
        'https://key@glitchtip.example.com/0',
      ]) {
        await initSentry(bad, 'r1')
        expect(getErrorReportingStatus().state, bad).toBe('failed')
      }
      // 一条都不进 SDK(进了就是"谎报 ready"的来源)。
      expect(initCalls()).toBe(0)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('审计修复轮回归(ent-5: 状态 getter 返回快照)', () => {
  it('ent-5: 外部改写返回对象污染不了内部状态与上报体', async () => {
    await initSentry(GOOD_DSN, 'r1')
    const snapshot = getErrorReportingStatus()
    expect(snapshot).toEqual({ state: 'ready', dsnHost: 'glitchtip.example.com', level: 'error' })

    // 消费方改写"读到的"对象(审计实测 `a.state='HACKED'` 曾真的改写模块内状态)。
    const hack = snapshot as unknown as Record<string, string>
    hack.state = 'HACKED'
    hack.dsnHost = 'evil.example.com'
    hack.level = 'debug'
    expect(getErrorReportingStatus()).toEqual({ state: 'ready', dsnHost: 'glitchtip.example.com', level: 'error' })

    // 每次都是新对象(不是同一个引用),并且内部状态改写不了 ⇒ 上报体也不会被污染。
    expect(getErrorReportingStatus()).not.toBe(getErrorReportingStatus())
    await reportErrorReportingStatus(SESSION, getErrorReportingStatus())
    const body = reported.at(-1)!.body
    expect(body.state).toBe('ready')
    expect(body.dsn_host).toBe('glitchtip.example.com')
    expect(JSON.stringify(reported)).not.toContain('HACKED')
  })
})
