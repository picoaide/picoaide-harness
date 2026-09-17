import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '../src/server-connector/config.ts'
import {
  apply,
  captureRendererError,
  captureRendererGone,
  dsnHostOf,
  type ErrorReportingState,
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
/** 每一次尝试(含失败)的目标服务器:S07-02 的重试/换服务器用例要看"是否真的又发了一次"。 */
const attempts: Array<{ server: string; path: string; token?: string }> = []
let fetchShouldFail = false
/** 非 null 时挂起请求(S07-02 的在飞去重用例需要一次"尚未返回"的上报)。 */
let fetchGate: Promise<void> | null = null
vi.mock('../src/server-connector/auth.ts', () => ({
  fetchJSON: vi.fn(async (serverURL: string, path: string, opts: { body?: unknown; token?: string }) => {
    // token 决定服务端把那行状态 upsert 到**哪个用户**(S07-02 复核 2026-09-17):
    // 每个用例只读 server/path,但"两个用户 = 两行"要靠它区分。
    attempts.push({ server: serverURL, path, token: opts.token })
    if (fetchGate !== null) {
      // 只挡第一次(S07-02 在飞去重用例):后续请求不该被同一个闸门拖住,
      // 否则断言失败会退化成 5s 超时、看不出真正的差异。
      const gate = fetchGate
      fetchGate = null
      await gate
    }
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
  attempts.length = 0
  fetchShouldFail = false
  fetchGate = null
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
    //
    // 2026-09-17 改判据:原先 `infos.some((m) => m.includes('glitchtip.example.com'))`
    // 既弱(换域名/后面多打一段也绿),又正是 CodeQL
    // js/incomplete-url-substring-sanitization 命中的"域名字串判据"形态。
    // 现在钉**整条形状**,并把 dsn 值绑到上面那条结构化状态(同一真源):
    // `release=` 前缀里是产品版本(运行期拼接),用 startsWith/endsWith 组合避开
    // 硬编码整条文案,同时仍能抓住"少打/多打字段"。
    const status = getErrorReportingStatus()
    expect(
      infos.some((m) =>
        m.startsWith(`error-reporting: 已启用(dsn=${status.dsnHost}, release=picoaide-desktop@`)
        && m.endsWith(', level=warning)')),
    ).toBe(true)
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

  // -------------------------------------------------------------------------
  // S07-02(2026-09-17 审计):去重键必须是整份载荷的身份,且只能在 POST 成功
  // 之后消费 —— 旧实现"POST 之前入集、失败不摘除"会让一次瞬时失败把这台机器
  // 从管理端永久抹掉,并让换服务器/改 DSN 后的新载荷永不外发。
  // -------------------------------------------------------------------------

  const STATUS_PATH = '/api/client/v2/telemetry/error-reporting'
  const reportAttempts = (): Array<{ server: string; path: string }> =>
    attempts.filter((a) => a.path === STATUS_PATH)
  const delivered = (): Array<{ path: string; body: Record<string, string> }> =>
    reported.filter((r) => r.path === STATUS_PATH)
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
  /** 再触发一次会话变更同步(apply 已由 runSync 装好监听器)。 */
  const syncAgain = async (session: Session): Promise<void> => {
    sessionListener!(session)
    await tick()
  }
  /** 一份"上报已启用"的 bootstrap 载荷(DSN/等级可调)。 */
  function enableReporting(dsn = GOOD_DSN, level?: string): void {
    bootstrapResult = {
      config: {
        default_model: 'm',
        models: [{ id: 'm' }],
        skills: [],
        mcp: [],
        web: {
          error_reporting_enabled: true,
          error_reporting_dsn: dsn,
          ...(level === undefined ? {} : { error_reporting_level: level }),
        },
      },
      fellBack: false,
      fallback: 'ok',
    }
  }

  it('retries the report on the next session change after a failure (S07-02)', async () => {
    enableReporting()
    fetchShouldFail = true
    const { ctx } = stubCtx()
    await runSync(ctx, SESSION)
    expect(reportAttempts().length).toBe(1)
    expect(delivered().length).toBe(0)

    // 瞬时故障(5xx / 超时 / 遥测 10 次每分限流的 429)过去后再同步一次必须重发。
    // 修复前:key 在 POST 之前就已入集且失败不摘除 ⇒ 这里恒为 1 条、0 条送达。
    fetchShouldFail = false
    await syncAgain(SESSION)
    expect(reportAttempts().length).toBe(2)
    expect(delivered().length).toBe(1)
    expect(delivered()[0]!.body).toMatchObject({ state: 'ready', dsn_host: 'glitchtip.example.com' })

    // 只重试一次,不是每次同步都发:成功后同一载荷重新去重。
    await syncAgain(SESSION)
    expect(reportAttempts().length).toBe(2)
  })

  it('reports again after switching to a different server (S07-02)', async () => {
    enableReporting()
    const { ctx } = stubCtx()
    await runSync(ctx, SESSION)
    expect(reportAttempts().map((a) => a.server)).toEqual(['https://gateway.example'])

    // 登出后登录另一台服务器是允许的(登录闸只在已登录时拒绝换服务器);
    // 键不含 serverURL 时,第二台服务器的管理端一行都收不到。
    await syncAgain({ ...SESSION, serverURL: 'https://other.example' })
    expect(reportAttempts().map((a) => a.server)).toEqual(['https://gateway.example', 'https://other.example'])
    expect(delivered().at(-1)!.body).toMatchObject({ state: 'ready', dsn_host: 'glitchtip.example.com' })
  })

  it('reports again for a different user on the same machine and server (S07-02)', async () => {
    enableReporting()
    const { ctx } = stubCtx()
    await runSync(ctx, { ...SESSION, username: 'alice', token: 'tok-alice' })
    expect(delivered().length).toBe(1)

    // S07-02 复核(2026-09-17,P3):服务端那行状态是**按用户** upsert 的
    // (telemetry/errorreporting.go 用认证用户 id,管理端列表 select 用户名),
    // 而键此前不含身份 —— 同一台机器换用户登录时载荷逐字节相同、键也不变,
    // bob 的上报被 alice 的键挡住,后台永远只有 alice 那一行(可执行探针复现)。
    await syncAgain({ ...SESSION, username: 'bob', token: 'tok-bob' })
    expect(reportAttempts().length).toBe(2)
    expect(delivered().length).toBe(2)
    // 两条上报各带自己的会话令牌 ⇒ 服务端落到两个用户的两行(行身份 = 用户)。
    expect(reportAttempts().map((a) => a.token)).toEqual(['tok-alice', 'tok-bob'])

    // 身份缺失(旧服务端/畸形登录响应)既不能与具名用户同键、也不能整条丢弃:
    // 匿名第一次要发出去,之后再同步仍按同一身份降噪。
    await syncAgain({ ...SESSION, username: undefined as unknown as string, token: 'tok-anon' })
    expect(reportAttempts().length).toBe(3)
    await syncAgain({ ...SESSION, username: undefined as unknown as string, token: 'tok-anon-2' })
    expect(reportAttempts().length).toBe(3)

    // 同一用户重新登录(新令牌、同名)保持原有降噪:键里放的是身份,不是令牌。
    await syncAgain({ ...SESSION, username: 'alice', token: 'tok-alice-2' })
    expect(reportAttempts().length).toBe(3)
  })

  it('reports again when the admin changes the DSN host or the level (S07-02)', async () => {
    enableReporting()
    const { ctx } = stubCtx()
    await runSync(ctx, SESSION)
    expect(delivered().length).toBe(1)

    // dsn_host/level 就是服务端那一段 upsert 行的内容:配置变了就要重报,
    // 否则后台一直显示旧 DSN 主机/旧等级。
    enableReporting(`https://${PUBLIC_KEY}@glitchtip2.example.com/1`, 'warning')
    await syncAgain(SESSION)
    expect(reportAttempts().length).toBe(2)
    expect(delivered().at(-1)!.body).toMatchObject({ dsn_host: 'glitchtip2.example.com', level: 'warning' })
  })

  it('does not double-POST the same status while one report is in flight (S07-02)', async () => {
    // "成功后才登记"必须配一个在飞集合,否则并发同步会为同一载荷发两条。
    const value: ErrorReportingState = { state: 'ready', dsnHost: 'h', level: 'error' }
    let release!: () => void
    fetchGate = new Promise<void>((resolve) => { release = resolve })
    const first = reportErrorReportingStatus(SESSION, value)
    await expect(reportErrorReportingStatus(SESSION, value)).resolves.toBe(false)
    expect(reportAttempts().length).toBe(1)

    release()
    await expect(first).resolves.toBe(true)
    expect(reportAttempts().length).toBe(1)
    // 成功后同一载荷仍然去重。
    await expect(reportErrorReportingStatus(SESSION, value)).resolves.toBe(false)
    expect(reportAttempts().length).toBe(1)
  })

  it('caps the reported-key set so a changing payload cannot grow it without bound (S07-02)', async () => {
    for (let i = 0; i < 65; i++) {
      await expect(reportErrorReportingStatus(SESSION, { state: 'config_unavailable', reason: `r${i}` })).resolves.toBe(true)
    }
    // 上限 64、淘汰最旧:第 1 个键已被挤出,同一载荷会重新上报(不是永久占位)。
    await expect(reportErrorReportingStatus(SESSION, { state: 'config_unavailable', reason: 'r0' })).resolves.toBe(true)
    // 最近一批仍在集合内(淘汰最旧 ≠ 整体清空)。
    await expect(reportErrorReportingStatus(SESSION, { state: 'config_unavailable', reason: 'r64' })).resolves.toBe(false)
    expect(reportAttempts().length).toBe(66)
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
