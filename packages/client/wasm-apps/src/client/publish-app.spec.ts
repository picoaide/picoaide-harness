/**
 * 发布编排客户端半边的纯逻辑测试（FIX-38）。
 *
 * 这一层是**面板与宿主 `/api/pico/apps/wasm/publish` 之间的唯一契约**，因此断言
 * 全部对着"线上真实会发出去的字节"，而不是对着内部变量：
 *
 *  - 请求体字段名 = 服务端 `appcfg` 的封闭字段集（`access` / `whitelist` / `purpose` /
 *    `data_sensitivity` / `owner`）与宿主 `manifestOf` 的交集；
 *  - 失败信封 `code`/`message`/`details`/`hints` 一字段不丢（第一消费者是 AI）；
 *  - 预校验与服务端 `registry`/`appcfg` 同口径，且**只做加法**（不拦服务端会接受的输入）；
 *  - **不自己分片**：面板只发一次 `/publish`，分片/续传/90 s 预算全部由宿主那一份
 *    编排负责（复制一份 = 第二个契约，迟早漂移 —— FIX-43 的教训）。
 *
 * ---- 变异验证 ----
 *   - `buildPublishBody` 把 `access` 换回 `login_required`/`visible`（或两个一起发）⇒
 *     「旧字段一个都不发」红；
 *   - `buildPublishBody` 把 `access` 写成 `accessMode`（驼峰）⇒ 同上红（服务端只认下划线）；
 *   - `validatePublishDraft` 摘掉 whitelist 空名单那条 ⇒ 「access：白名单模式空名单命中」红；
 *   - `validatePublishDraft` 摘掉 app_id / version 形态检查 ⇒ 对应用例红；
 *   - `parseErrorEnvelope` 只留 `code`/`message`（丢掉 details/hints）⇒
 *     「结构化错误逐字段到达」红；
 *   - `submitPublish` 在 base64 > 8 MiB 时自己切分片（复制一份编排）⇒
 *     「大载荷只发一次 /publish」红；
 *   - `encodeBase64` 改回 `String.fromCharCode(...bytes)` ⇒ 「1 MiB 不爆栈」红；
 *   - `initialFormState` 不看 target（`access` 固定回缺省）⇒ 「发新版时预填当前值」红；
 *   - `initialFormState` 给出 `dataSensitivity` 默认值 ⇒ 「没有平台默认值」红；
 *   - `changesAccess` 恒 false ⇒ 「改动访问范围被识别」红。
 */
import { describe, expect, it } from 'vitest'
import {
  buildPublishBody,
  changesAccess,
  encodeBase64,
  initialFormState,
  parseErrorEnvelope,
  parsePublishOutcome,
  PUBLISH_PATH,
  splitWhitelist,
  submitPublish,
  validatePublishDraft,
  windowSpecFromText,
  type PublishDraft,
  type PublishTarget,
} from './publish-app.ts'
import { APP_CONFIG_FIELDS, DEFAULT_ACCESS, WHITELIST_MAX } from './appcfg-contract.ts'
import { setActiveLocale } from './locales.ts'

const DRAFT: PublishDraft = {
  appId: 'shift-notes',
  version: '1.0.0',
  title: '值班便签',
  changelog: '首版',
  config: {
    access: 'whitelist',
    whitelist: ['alice', 'bob'],
    purpose: '值班交接',
    dataSensitivity: 'internal',
    owner: 'alice',
  },
}

/** 改一处草稿（表驱动用例用）。 */
function draftWith(patch: {
  appId?: string, version?: string, title?: string, config?: Partial<PublishDraft['config']>,
}): PublishDraft {
  return {
    ...DRAFT,
    ...(patch.appId === undefined ? {} : { appId: patch.appId }),
    ...(patch.version === undefined ? {} : { version: patch.version }),
    ...(patch.title === undefined ? {} : { title: patch.title }),
    config: { ...DRAFT.config, ...(patch.config ?? {}) },
  }
}

describe('发布请求体：字段名与服务端 appcfg 逐字一致', () => {
  it('config 发五个声明字段；`window` **只在作者声明时**才出现（旧字段一个都不发）', () => {
    const body = buildPublishBody(DRAFT, 'BASE64')
    expect(body.app_id).toBe('shift-notes')
    expect(body.version).toBe('1.0.0')
    expect(body.wasm_base64).toBe('BASE64')
    expect(body.title).toBe('值班便签')
    expect(body.changelog).toBe('首版')
    // 键集合 = 契约里的字段集合 **减去"作者声明才有"的那几个**（`APP_CONFIG_FIELDS`
    // 是唯一真源）。它们是 `window`（窗口几何）与 `sensitive_columns`（声明脱敏列，
    // 2026-09-21 新增）：**不发 = 不声明**，而不是"声明了缺省值" —— 服务端对缺席有
    // 继承语义，客户端不替它写一个空值。
    // ⚠️ 这条断言此前只减 `window`；`sensitive_columns` 加进契约后它必须同步，
    // 否则"新增一个声明型字段"会被这条用例当成"客户端漏发"（同一类漂移）。
    const declaredOnly = new Set(['window', 'sensitive_columns'])
    const alwaysSent = [...APP_CONFIG_FIELDS].filter(field => !declaredOnly.has(field)).sort()
    expect(Object.keys(body.config as Record<string, unknown>).sort()).toEqual(alwaysSent)
    expect(body.config).not.toHaveProperty('window')
    expect(body.config).not.toHaveProperty('sensitive_columns')
    expect(body.config).toEqual({
      access: 'whitelist',
      whitelist: ['alice', 'bob'],
      purpose: '值班交接',
      data_sensitivity: 'internal',
      owner: 'alice',
    })
    // 旧字段必须**彻底消失**：服务端的字段集合是封闭的，多发一个 `visible` /
    // `login_required` 就等于整个发布被拒（APP_CONFIG_INVALID 未知字段）。
    expect(body.config).not.toHaveProperty('visible')
    expect(body.config).not.toHaveProperty('login_required')
    const sent = JSON.stringify(body)
    expect(sent).not.toContain('login_required')
    expect(sent).not.toContain('"visible"')
  })

  /**
   * 窗口声明（F3/§6，R1-L3-9）：作者填了才发、填错本地拦下。
   *
   * 变异验证：把 `windowSpecFromText` 改成"总是返回 {width:1280,height:720}"（替作者
   * 声明缺省）⇒ 第一条红；把 `validatePublishDraft` 的 ratio 校验删掉 ⇒ 第二条红。
   */
  it('window 声明：三项都填 ⇒ 原样进 config.window；只填部分 ⇒ 只带那几个键', () => {
    const fullWindow = windowSpecFromText('16:9', '1280', '720')
    const full: PublishDraft = { ...DRAFT, config: { ...DRAFT.config, ...(fullWindow === undefined ? {} : { window: fullWindow }) } }
    expect((buildPublishBody(full, 'B').config as { window?: unknown }).window).toEqual({ ratio: 16 / 9, width: 1280, height: 720 })
    const partialWindow = windowSpecFromText('', '1024', '')
    const partial: PublishDraft = { ...DRAFT, config: { ...DRAFT.config, ...(partialWindow === undefined ? {} : { window: partialWindow }) } }
    expect((buildPublishBody(partial, 'B').config as { window?: unknown }).window).toEqual({ width: 1024 })
    // 一个字段都没解析出来 ⇒ 不发 `window` 键（"不声明"与"声明了缺省"是两件事）。
    expect(windowSpecFromText('', '', '')).toBeUndefined()
    expect(windowSpecFromText('不是比例', '', '')).toBeUndefined()
  })

  it('window 填错 ⇒ 本地预校验拦住（比例越界 / 尺寸非正整数）', () => {
    const badRatio: PublishDraft = { ...DRAFT, config: { ...DRAFT.config, window: { ratio: 9 } } }
    const ratioIssues = validatePublishDraft(badRatio)
    expect(ratioIssues.map(issue => issue.code)).toContain('window_ratio_invalid')
    expect(ratioIssues.find(issue => issue.code === 'window_ratio_invalid')!.field).toBe('window.ratio')
    const badSize: PublishDraft = { ...DRAFT, config: { ...DRAFT.config, window: { width: 0 } } }
    expect(validatePublishDraft(badSize).map(issue => issue.code)).toContain('window_size_invalid')
    // 合法值不产生任何 window 相关问题。
    const good: PublishDraft = { ...DRAFT, config: { ...DRAFT.config, window: { ratio: 1.5, width: 1280, height: 720 } } }
    expect(validatePublishDraft(good).filter(issue => issue.field.startsWith('window'))).toEqual([])
  })

  it('access 原样发出（写侧两个取值都不改写）', () => {
    for (const access of ['login', 'whitelist'] as const) {
      const body = buildPublishBody(draftWith({ config: { access } }), 'B')
      expect((body.config as Record<string, unknown>).access).toBe(access)
    }
  })

  it('空的可选字段不发（"没填"不等于"填了空"）', () => {
    const body = buildPublishBody({ ...DRAFT, title: '  ', changelog: '' }, 'B')
    expect('title' in body).toBe(false)
    expect('changelog' in body).toBe(false)
    // app_id / version 必须原样带（宿主校验它们非空）。
    expect(buildPublishBody({ ...DRAFT, appId: ' a ', version: ' 1 ' }, 'B').app_id).toBe('a')
  })

  it('白名单文本：逗号/顿号/分号/换行都当分隔符，去重且保留顺序', () => {
    expect(splitWhitelist('alice, bob')).toEqual(['alice', 'bob'])
    expect(splitWhitelist('alice，bob、carol;dave\nerin')).toEqual(['alice', 'bob', 'carol', 'dave', 'erin'])
    expect(splitWhitelist(' alice , alice ,, ')).toEqual(['alice'])
    expect(splitWhitelist('')).toEqual([])
  })
})

/**
 * 前端预校验：与服务端 registry/appcfg 同口径。
 *
 * 断言对着 **`code`**（稳定标识）而不是文案，这样改文案不会误伤用例，
 * 而"规则被摘掉"必然让对应用例红。
 */
describe('前端预校验：与服务端同口径（只做加法，不放行服务端会拒的输入）', () => {
  it('完整草稿零问题（预校验不拦下服务端会接受的输入）', () => {
    expect(validatePublishDraft(DRAFT)).toEqual([])
  })

  it('app_id：空 / 超长 / 形态 / 纯数字 / xn-- 五条各自独立命中', () => {
    const codes = (appId: string): string[] => validatePublishDraft(draftWith({ appId })).map(i => i.code)
    expect(codes('')).toEqual(['app_id_required'])
    expect(codes('a'.repeat(64))).toEqual(['app_id_length'])
    // 63 是上限本身 ⇒ 合法（边界两侧都要钉）。
    expect(validatePublishDraft(draftWith({ appId: 'a'.repeat(63) }))).toEqual([])
    // 大写 / 连续连字符 / 首尾连字符 / 下划线，四种非法形态都归到 app_id_shape。
    for (const bad of ['Demo-App', 'shift--notes', '-shift', 'shift-', 'shift_notes', '值班便签']) {
      expect(codes(bad), bad).toEqual(['app_id_shape'])
    }
    expect(codes('12345')).toEqual(['app_id_numeric'])
    expect(codes('xn--fiqs8s')).toEqual(['app_id_punycode'])
    // 合法形态一个都不拦。
    for (const good of ['a', 'shift-notes', 'a1-b2-c3']) {
      expect(validatePublishDraft(draftWith({ appId: good })), good).toEqual([])
    }
  })

  it('version：空 / 非 x.y.z 各自命中，预发布后缀按服务端规则放行', () => {
    const codes = (version: string): string[] => validatePublishDraft(draftWith({ version })).map(i => i.code)
    expect(codes('')).toEqual(['version_required'])
    for (const bad of ['1', '1.0', 'v1.0.0', '1.0.0.0', 'x.y.z']) {
      expect(codes(bad), bad).toEqual(['version_shape'])
    }
    for (const good of ['1.0.0', '0.0.1', '10.20.30', '1.0.0-beta.1']) {
      expect(validatePublishDraft(draftWith({ version: good })), good).toEqual([])
    }
  })

  it('access：非法取值命中；白名单模式空名单命中（服务端 empty_whitelist 同因）', () => {
    const bad = validatePublishDraft(draftWith({ config: { access: 'everyone' as never } }), { firstRelease: false })
    expect(bad.map(i => i.code)).toEqual(['access_invalid'])

    const empty = validatePublishDraft(draftWith({ config: { access: 'whitelist', whitelist: [] } }), { firstRelease: false })
    expect(empty.map(i => i.code)).toEqual(['whitelist_empty'])
    expect(empty[0]!.field).toBe('whitelist')

    // 非白名单模式下空名单是合法的（服务端只在 access=whitelist 时要求非空）。
    expect(validatePublishDraft(draftWith({ config: { access: 'login', whitelist: [] } }), { firstRelease: false })).toEqual([])
    // 2026-09-19（冻结契约 §4.4）：写侧不再接受历史 public —— 本地预校验与服务端同一集合。
    const legacy = validatePublishDraft(draftWith({ config: { access: 'public' as never, whitelist: [] } }), { firstRelease: false })
    expect(legacy.map(issue => issue.code)).toContain('access_invalid')
  })

  it(`白名单条目超过上限（${String(WHITELIST_MAX)}）命中；正好等于上限放行`, () => {
    const at = validatePublishDraft(draftWith({
      config: { access: 'whitelist', whitelist: Array.from({ length: WHITELIST_MAX }, (_, i) => `u${String(i)}`) },
    }), { firstRelease: false })
    expect(at).toEqual([])
    const over = validatePublishDraft(draftWith({
      config: { access: 'whitelist', whitelist: Array.from({ length: WHITELIST_MAX + 1 }, (_, i) => `u${String(i)}`) },
    }), { firstRelease: false })
    expect(over.map(i => i.code)).toEqual(['whitelist_too_many'])
  })

  it('首版四条声明字段（title/purpose/data_sensitivity/owner）各自必填', () => {
    const issues = validatePublishDraft(draftWith({ title: '  ', config: { purpose: '', dataSensitivity: '', owner: '' } }))
    expect(issues.map(i => i.code).sort()).toEqual(['data_sensitivity_required', 'owner_required', 'purpose_required', 'title_required'])
    expect(issues.map(i => i.field).sort()).toEqual(['data_sensitivity', 'owner', 'purpose', 'title'])
    // 只声明第一个问题时也只剩一条（其它字段都合法）。
    expect(validatePublishDraft(draftWith({ config: { owner: '' } })).map(i => i.code)).toEqual(['owner_required'])
    // 非首版：这四个字段允许留空（服务端同样只在首版要求）。
    expect(validatePublishDraft(draftWith({ title: '', config: { purpose: '', dataSensitivity: '', owner: '' } }), { firstRelease: false })).toEqual([])
  })

  it('文案跟随语言（预校验消息不是硬编码中文）', () => {
    setActiveLocale('en')
    try {
      const issues = validatePublishDraft(draftWith({ appId: 'Demo' }))
      expect(issues[0]!.message).toBe('app_id allows lowercase letters, digits and single dashes only (no leading or trailing dash, no double dash)')
    } finally {
      setActiveLocale('zh')
    }
  })
})

/** 用 `atob` 把 base64 解回字节（与 `encodeBase64` 完全独立的另一条实现）。 */
function decodeBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

describe('base64 编码：真实字节逐字对拍', () => {
  it('已知向量 + 往返一致（含填充与边界长度）', () => {
    // 标准向量（RFC 4648）：不是"用同一个函数算出来的期望值"。
    expect(encodeBase64(new Uint8Array([0, 97, 115, 109]))).toBe('AGFzbQ==')
    expect(encodeBase64(new Uint8Array([102]))).toBe('Zg==')
    expect(encodeBase64(new Uint8Array([102, 111]))).toBe('Zm8=')
    expect(encodeBase64(new Uint8Array([102, 111, 111]))).toBe('Zm9v')
    expect(encodeBase64(new Uint8Array([]))).toBe('')
    for (const size of [1, 2, 3, 4, 5, 1023, 65535, 65536, 65537]) {
      const bytes = new Uint8Array(size)
      for (let i = 0; i < size; i += 1) bytes[i] = (i * 31) % 256
      expect(decodeBase64(encodeBase64(bytes)), `size=${String(size)}`).toEqual(bytes)
    }
  })

  it('1 MiB 载荷不会爆栈（`String.fromCharCode(...bytes)` 会 RangeError）', () => {
    const bytes = new Uint8Array(1024 * 1024)
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 7) % 256
    let encoded = ''
    expect(() => { encoded = encodeBase64(bytes) }).not.toThrow()
    expect(encoded.length).toBe(Math.ceil(bytes.length / 3) * 4)
    expect(decodeBase64(encoded)).toEqual(bytes)
  })
})

describe('失败信封：code / message / details / hints 一字段不丢', () => {
  it('服务端 §8 信封原样解析（含嵌套 details 与多条 hints）', () => {
    const failure = parseErrorEnvelope(422, {
      error: {
        code: 'APP_CONFIG_INVALID',
        message: 'login_required=true 但没有配置白名单',
        details: { field: 'whitelist', reason: 'empty_whitelist', nested: { deep: [1, 2] } },
        hints: ['把 login_required 改成 false', '或在 whitelist 里填入允许使用的账号'],
      },
    })
    expect(failure.ok).toBe(false)
    expect(failure.status).toBe(422)
    expect(failure.code).toBe('APP_CONFIG_INVALID')
    expect(failure.message).toBe('login_required=true 但没有配置白名单')
    expect(failure.details).toEqual({ field: 'whitelist', reason: 'empty_whitelist', nested: { deep: [1, 2] } })
    expect(failure.hints).toEqual(['把 login_required 改成 false', '或在 whitelist 里填入允许使用的账号'])
    expect(failure.transport).toBe(false)
  })

  it('缺字段时回落成可读替代值（不返回空串）', () => {
    const failure = parseErrorEnvelope(500, null, 'boom')
    expect(failure.code).toBe('HTTP_500')
    expect(failure.message).toBe('boom')
    expect(failure.hints).toEqual([])
    const network = parseErrorEnvelope(null, null)
    expect(network.code).toBe('NETWORK_ERROR')
    expect(network.transport).toBe(true)
  })
})

describe('submitPublish：一次请求走宿主编排（不自己分片）', () => {
  const file = (size: number): { name: string, bytes: Uint8Array } => ({
    name: 'demo.wasm',
    bytes: new Uint8Array(size).fill(3),
  })

  it('成功：POST /api/pico/apps/wasm/publish，解析出版本/状态（入口链接已不在契约里）', async () => {
    const calls: Array<{ url: string, init: RequestInit }> = []
    const result = await submitPublish(DRAFT, file(8), {
      fetch: (async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} })
        return new Response(JSON.stringify({
          app: { app_id: 'shift-notes', title: '值班便签', entry_url: 'https://shift-notes.apps.example.com/', version: '1.0.0' },
          release: { id: 1, version: '1.0.0', status: 'approved', current: true, checksum: 'abc', size: 8 },
          review_required: false,
          pruned_releases: [],
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(PUBLISH_PATH)
    expect(calls[0]!.init.method).toBe('POST')
    const sent = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    expect(sent.app_id).toBe('shift-notes')
    expect(sent.wasm_base64).toBe(encodeBase64(file(8).bytes))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.version).toBe('1.0.0')
    expect(result.pending).toBe(false)
    expect(result.live).toBe(true)
    // 2026-09-19（冻结契约 §4.5）：发布响应不再有入口链接，客户端也不再接住它 ——
    // 服务端仍带着 entry_url 时这里是**忽略**（分享形态是客户端自己拼的渠道深链）。
    expect(result).not.toHaveProperty('entryURL')
    expect(JSON.stringify(result)).not.toContain('entry')
    expect(JSON.stringify(result)).not.toContain('apps.example.com')
  })

  it('待审：review_required ⇒ pending=true 且不算"已生效"（R17）', async () => {
    const result = await submitPublish(DRAFT, file(4), {
      fetch: (async () => new Response(JSON.stringify({
        app: { app_id: 'shift-notes', title: 'T', entry_url: 'https://x/' },
        release: { version: '2.0.0', status: 'pending', current: false },
        review_required: true,
      }), { status: 201, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.pending).toBe(true)
    expect(result.live).toBe(false)
    expect(result.status).toBe('pending')
  })

  it('服务端业务错误：状态码 + 结构化信封原样回来（不被压成"失败"）', async () => {
    const result = await submitPublish(DRAFT, file(4), {
      fetch: (async () => new Response(JSON.stringify({
        error: { code: 'WASM_INVALID', message: '不是合法 wasm 模块', details: { symbol: 'x' }, hints: ['重新编译'] },
      }), { status: 422, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.status).toBe(422)
    expect(result.code).toBe('WASM_INVALID')
    expect(result.message).toBe('不是合法 wasm 模块')
    expect(result.details).toEqual({ symbol: 'x' })
    expect(result.hints).toEqual(['重新编译'])
  })

  it('大载荷（>8 MiB）仍然只发一次 /publish：分片是宿主的事，面板不复制编排', async () => {
    const calls: string[] = []
    const result = await submitPublish(DRAFT, file(9 * 1024 * 1024), {
      fetch: (async (url: unknown) => {
        calls.push(String(url))
        return new Response(JSON.stringify({
          app: { app_id: 'demo', entry_url: 'https://demo/' },
          release: { version: '1.0.0', status: 'approved', current: true },
        }), { status: 201, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(true)
    expect(calls).toEqual([PUBLISH_PATH])
    expect(calls.some(url => url.includes('/uploads'))).toBe(false)
  })

  it('2xx 但不是 JSON ⇒ 结构化失败（不假装成功）', async () => {
    const result = await submitPublish(DRAFT, file(4), {
      fetch: (async () => new Response('<!doctype html><html>portal</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('UNEXPECTED_RESPONSE')
    expect(String(result.details && JSON.stringify(result.details))).toContain('portal')
  })

  it('取消：AbortError ⇒ code=ABORTED（UI 据此回到空闲态而不是显示失败）', async () => {
    const controller = new AbortController()
    const result = await submitPublish(DRAFT, file(4), {
      signal: controller.signal,
      fetch: (async (_url: unknown, init?: RequestInit) => {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
          controller.abort()
        })
        return new Response('{}', { status: 200 })
      }) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('ABORTED')
    expect(result.transport).toBe(true)
  })

  it('传输层失败（宿主没起来）⇒ NETWORK_ERROR + 明确 hints', async () => {
    const result = await submitPublish(DRAFT, file(4), {
      fetch: (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('NETWORK_ERROR')
    expect(result.hints.join(' ')).toContain('本机')
  })

  it('阶段回调按 reading → uploading 走（UI 的"读取中/上传中"来自它）', async () => {
    const phases: string[] = []
    await submitPublish(DRAFT, file(4), {
      onPhase: phase => phases.push(phase),
      fetch: (async () => new Response(JSON.stringify({
        app: { app_id: 'demo' },
        release: { version: '1.0.0', status: 'approved', current: true },
      }), { status: 201, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    })
    expect(phases).toEqual(['reading', 'uploading'])
  })
})

describe('parsePublishOutcome：形状不对不假装成功', () => {
  it('缺 release.version ⇒ UNEXPECTED_RESPONSE + 原始体进 details', () => {
    const outcome = parsePublishOutcome({ app: { app_id: 'x' } })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('unreachable')
    expect(outcome.code).toBe('UNEXPECTED_RESPONSE')
    expect(JSON.stringify(outcome.details)).toContain('"app_id":"x"')
  })

  it('成功结果里没有任何入口链接字段（服务端给不给都不接）', () => {
    const withoutURL = parsePublishOutcome({ app: {}, release: { version: '1.0.0', status: 'approved', current: true } })
    expect(withoutURL.ok).toBe(true)
    if (!withoutURL.ok) throw new Error('unreachable')
    expect(withoutURL).not.toHaveProperty('entryURL')
    const withURL = parsePublishOutcome({
      app: { entry_url: 'https://legacy.example/' },
      release: { version: '1.0.0', status: 'approved', current: true },
    })
    expect(withURL.ok).toBe(true)
    if (!withURL.ok) throw new Error('unreachable')
    expect(JSON.stringify(withURL)).not.toContain('legacy.example')
  })

  /**
   * R1-uxc-1：服务端**确实**下发 `app.enabled`（`api/publish.go:682`；已存在应用保留
   * 原值 `:637-639`），而旧客户端把它丢掉 ⇒ 下架应用发新版的成功块写"已生效"。
   *
   * 变异验证：把 `parsePublishOutcome` 里的 `enabled` / `live` 两行删掉（旧实现）⇒
   * 本组两条红。
   */
  it('下架应用（app.enabled=false）⇒ enabled=false 且 live=false（不算已生效）', () => {
    const outcome = parsePublishOutcome({
      app: { app_id: 'gone', enabled: false },
      release: { version: '1.1.0', status: 'approved', current: true },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.enabled).toBe(false)
    // 版本是当前版本，但**没有对使用者生效**（应用子域 410 Gone）。
    expect(outcome.live).toBe(false)
  })

  it('上架应用（app.enabled=true）⇒ enabled=true 且 live=true（行为不变）', () => {
    const outcome = parsePublishOutcome({
      app: { app_id: 'live', enabled: true },
      release: { version: '1.1.0', status: 'approved', current: true },
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.enabled).toBe(true)
    expect(outcome.live).toBe(true)
    // 待审仍然是"没生效"（与 enabled 无关的那条判据不能被这次改动挤掉）。
    const pending = parsePublishOutcome({
      app: { app_id: 'live', enabled: true },
      release: { version: '1.1.0', status: 'pending', current: false },
      review_required: true,
    })
    expect(pending.ok).toBe(true)
    if (!pending.ok) throw new Error('unreachable')
    expect(pending.live).toBe(false)
  })

  it('`app.enabled` 缺席 ⇒ 按上架处理（不凭缺席宣称应用已下架）', () => {
    const outcome = parsePublishOutcome({ app: {}, release: { version: '1.0.0', status: 'approved', current: true } })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('unreachable')
    expect(outcome.enabled).toBe(true)
    expect(outcome.live).toBe(true)
  })
})

describe('模块级常量', () => {
  it('发布路径与宿主路由前缀逐字一致', () => {
    // 宿主：packages/host/enterprise/src/wasm-apps.ts 的 WASM_APPS_PREFIX。
    expect(PUBLISH_PATH).toBe('/api/pico/apps/wasm/publish')
  })

  it('没有第二份分片判定常量（编排只有宿主那一份）', async () => {
    const module = await import('./publish-app.ts') as Record<string, unknown>
    for (const key of Object.keys(module)) {
      expect(key.toLowerCase().includes('chunk')).toBe(false)
    }
  })
})

/**
 * P1-3：发布表单的**预填**与"访问范围改动"判据。
 *
 * 变异验证（改回旧实现必红）：
 *   - `initialFormState` 忽略 target、`access` 固定回 `DEFAULT_ACCESS`
 *     ⇒ 「发新版时 access 预填为当前值」红；
 *   - `initialFormState` 少给 `whitelistText`/`purpose`/`owner`
 *     ⇒ 对应用例红；
 *   - 给 `PublishFormInitial` 加一个 `dataSensitivity: 'internal'` 默认
 *     ⇒ 「没有平台默认值」红；
 *   - `changesAccess` 恒返回 false（去掉二次确认的判据）
 *     ⇒ 「改动访问范围被识别」红。
 */
describe('P1-3：发新版的预填基线与"访问范围改动"判据', () => {
  const TARGET: PublishTarget = {
    appId: 'shift-notes',
    title: '值班便签',
    access: 'login',
    currentVersion: '1.4.2',
    owner: 'alice',
    purpose: '值班交接',
    whitelist: ['alice', 'bob'],
  }

  it('发新版时 access / whitelist / purpose / owner / title 全部预填', () => {
    const initial = initialFormState(TARGET)
    expect(initial.appId).toBe('shift-notes')
    expect(initial.title).toBe('值班便签')
    // **核心断言**：access 是当前线上的值，不是硬编码的 login。
    expect(initial.access).toBe('login')
    expect(initial.currentAccess).toBe('login')
    expect(initial.currentVersion).toBe('1.4.2')
    expect(initial.whitelistText).toBe('alice, bob')
    expect(initial.purpose).toBe('值班交接')
    expect(initial.owner).toBe('alice')
  })

  it('data_sensitivity 没有任何默认值（平台上就没有这个字段的缺省）', () => {
    const initial = initialFormState(TARGET) as unknown as Record<string, unknown>
    // 结构性保证：初值类型里根本没有这个键 —— 想塞默认值必须先改类型。
    expect(Object.keys(initial)).not.toContain('dataSensitivity')
    expect(Object.keys(initial).some(key => key.toLowerCase().includes('sensitiv'))).toBe(false)
    // 首版发布同样不带任何默认值。
    expect(Object.keys(initialFormState() as unknown as Record<string, unknown>)).not.toContain('dataSensitivity')
  })

  it('首版发布（无基线）：缺省仍是 login，但**没有**"当前值"因而没有改动判定', () => {
    const initial = initialFormState()
    expect(initial.access).toBe(DEFAULT_ACCESS)
    expect(initial.currentAccess).toBeUndefined()
    expect(initial.appId).toBe('')
    // 没有"当前值"⇒ 任何取值都不算改动（首版发布本来就没有可比对的对象）。
    expect(changesAccess(initial, 'login')).toBe(false)
    expect(changesAccess(initial, 'whitelist')).toBe(false)
  })

  it('发布者本人之外的目录行拿不到 whitelist / purpose ⇒ 表单留空而不是编造', () => {
    // 非发布者的目录行里这两个字段**缺席**（服务端按调用者下发）；用解构剔除，
    // 因为 `exactOptionalPropertyTypes` 下不能显式传 `undefined`。
    const { whitelist: _w, purpose: _p, ...withoutAuthorFields } = TARGET
    const initial = initialFormState(withoutAuthorFields)
    expect(initial.whitelistText).toBe('')
    expect(initial.purpose).toBe('')
  })

  it('改动访问范围被识别（首版以外都算"改动"，值相同则不算）', () => {
    const initial = initialFormState(TARGET)
    expect(initial.currentAccess).toBe('login')
    expect(changesAccess(initial, 'login')).toBe(false)
    expect(changesAccess(initial, 'whitelist')).toBe(true)
  })
})
