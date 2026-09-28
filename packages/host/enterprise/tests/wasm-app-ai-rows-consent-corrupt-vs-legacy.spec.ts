/**
 * FIX-17 / V6 F3：**损坏 ≠ 合法旧版本**（AI 读行授权记录）。
 *
 * 修前：`parseAiRowsConsent` 只回 "键集合 or null"，而 `load()` 把 `null` 一律当作
 * "旧格式 ⇒ 可写" ⇒ 截断 JSON / 单条坏记录 / 顶层非对象 / `version` 类型错 都会让下一次
 * `setEnabled` 以"空集合 + 本次一条"整份 rename 覆盖：**同一文件里其它账号/应用的合法
 * 记录静默消失**，而本机路由收到成功（面板显示"已允许"，别人的开关没了）。
 *
 * 修后：只有"可识别的旧版本"（`version: 1` 且 v1 形状完整）才允许就地改写；其余一律
 * `AiRowsConsentReadError`（路由 500 `AI_ROWS_CONSENT_NOT_PERSISTED`）+ **原文件字节不变**。
 *
 * 与兄弟闸门 `wasm-apps-host/src/ai-authorization.ts` 是**逐条同形**的语义（两份实现在两个
 * 包里、不能跨包 import，见报告"两条存储的对称性"一节；对拍探针在
 * `temp/r21/fix-17/probe/consent-parity.mjs`）。
 *
 * ---- 变异验证（拆掉哪一处，哪条用例必红）----
 *   - `classifyAiRowsConsent` 把 `corrupt` 折回 `legacy`（= 退回修前形态）⇒「损坏 ⇒ 拒绝写 +
 *     原文件字节不变」整组红（`setEnabled` 会 resolve、文件被整份覆盖）；
 *   - 把 `legacy` 折进 `corrupt`（= 把升级路径一并禁掉）⇒「v1 就地升级」那两条红；
 *   - `load()` 不再把 `corrupt` 归入 `writable: false` ⇒ 第 1 组红。
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AI_ROWS_CONSENT_FILE_NAME,
  AI_ROWS_CONSENT_FORMAT_VERSION,
  AiRowsConsentReadError,
  aiRowsConsentKey,
  classifyAiRowsConsent,
  createAiRowsConsentStore,
  isAiRowsConsentReadError,
  parseAiRowsConsent,
  serializeAiRowsConsent,
} from '../src/wasm-apps-ai-rows-consent.ts'
import type { AiRowsConsentScope } from '../src/wasm-apps-ai-rows-consent.ts'

const SCOPE: AiRowsConsentScope = { user: 'alice', server: 'https://harness.example' }
const OTHER_SCOPE: AiRowsConsentScope = { user: 'bob', server: 'https://harness.example' }

const homes: string[] = []

function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pico-ai-rows-corrupt-'))
  homes.push(dir)
  return dir
}

function temporaryFile(): string {
  return join(temporaryDir(), AI_ROWS_CONSENT_FILE_NAME)
}

/** 走唯一键构造点（实现内部也用同一个函数）。 */
const key = (scope: AiRowsConsentScope, app: string): string => aiRowsConsentKey(scope, app)!

/** 内容摘要（判"原文件一字未动"用 sha256，不用 mtime/size 这类弱判据）。 */
const digestOf = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

/** 收集 warn 的替身（与生产同形：`ctx.logger.warn` 是一条字符串）。 */
function warnings(): { messages: string[], warn: (message: string) => void } {
  const messages: string[] = []
  return { messages, warn: message => { messages.push(message) } }
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('损坏 ≠ 合法旧版本（FIX-17 / V6 F3）', () => {
  /** 四种"形状不符"的形态（判据逐条要求：拒绝写 + 原文件字节不变）。 */
  const corruptShapes: Array<[label: string, text: string]> = [
    ['截断 JSON', '{"version":2,"grants":[{"user":"alice"'],
    ['顶层非对象', '[]'],
    [
      '单条坏记录',
      JSON.stringify({
        version: AI_ROWS_CONSENT_FORMAT_VERSION,
        grants: [{ user: 'alice', server: SCOPE.server, app: 'notes' }, 42],
      }),
    ],
    ['version 字段类型错', JSON.stringify({ version: String(AI_ROWS_CONSENT_FORMAT_VERSION), grants: [] })],
  ]

  it.each(corruptShapes)('%s ⇒ 拒绝写 + 原文件字节不变 + 读面可判因（不是静默 false）', async (label, text) => {
    const file = temporaryFile()
    writeFileSync(file, text, { mode: 0o600 })
    const before = digestOf(file)
    const sink = warnings()
    const store = createAiRowsConsentStore({ file, scope: () => SCOPE, warn: sink.warn })

    // 读面：fail-closed（不是"已授权"）。
    expect(await store.isEnabled('notes'), label).toBe(false)

    // 写面：拒绝，且是**可判因**的类型（本机路由据此回 500 AI_ROWS_CONSENT_NOT_PERSISTED）。
    const rejection = await store.setEnabled('brand-new', true).then(() => null, (cause: unknown) => cause)
    expect(isAiRowsConsentReadError(rejection), label).toBe(true)
    expect(rejection).toBeInstanceOf(AiRowsConsentReadError)
    // 撤销走的是同一条读-改-写 ⇒ 同样不得覆盖。
    await expect(store.setEnabled('notes', false), label).rejects.toBeInstanceOf(AiRowsConsentReadError)

    // **原文件一字未动**（sha256 相同）：其它账号/应用的记录不可能被静默销毁。
    expect(digestOf(file), label).toBe(before)
    // 读面不是"静默 false"：留了一条可诊断的 warn，并点明"同时拒绝写"。
    expect(sink.messages.join('\n'), label).toMatch(/not a usable record/u)
    expect(sink.messages.join('\n'), label).toMatch(/refusing writes/u)
  })

  it('一份 v2 记录里有一条坏条目 ⇒ 拒绝写，同一文件里其它账号的**合法记录不消失**', async () => {
    const file = temporaryFile()
    // alice / carol 两条合法，只有中间那条被改坏（人手编辑 / 半写 / 磁盘错误）。
    const text = JSON.stringify({
      version: AI_ROWS_CONSENT_FORMAT_VERSION,
      grants: [
        { user: 'alice', server: SCOPE.server, app: 'notes' },
        { user: 'bob', server: SCOPE.server, app: 42 },
        { user: 'carol', server: SCOPE.server, app: 'notes' },
      ],
    }, null, 2)
    writeFileSync(file, text, { mode: 0o600 })
    const store = createAiRowsConsentStore({ file, scope: () => SCOPE })
    await expect(store.setEnabled('dave-notes', true)).rejects.toBeInstanceOf(AiRowsConsentReadError)
    // 字节级证据：carol 的合法记录还在（修前这里会被整份覆盖成单条记录）。
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(readFileSync(file, 'utf8')).toContain('"carol"')
  })

  it('不认识的版本号（更高/更低）与"认不出的 v1 形状"都不是升级路径 ⇒ 拒绝写', async () => {
    const shapes = [
      JSON.stringify({ version: AI_ROWS_CONSENT_FORMAT_VERSION + 1, grants: [] }),
      JSON.stringify({ version: AI_ROWS_CONSENT_FORMAT_VERSION - 2, grants: [] }),
      // version = 1 但形状认不出来（apps 里混进非字符串）⇒ 坏文件，不是"旧版本"。
      JSON.stringify({ version: 1, apps: ['notes', 42] }),
    ]
    for (const text of shapes) {
      const file = temporaryFile()
      writeFileSync(file, text, { mode: 0o600 })
      const before = digestOf(file)
      const store = createAiRowsConsentStore({ file, scope: () => SCOPE })
      await expect(store.setEnabled('notes', true), text).rejects.toBeInstanceOf(AiRowsConsentReadError)
      expect(digestOf(file), text).toBe(before)
    }
  })

  it('正：真实 v1 文件仍**就地升级**成 v2（升级路径没被误伤）', async () => {
    const file = temporaryFile()
    // 上一版真实写出的形状（v1 是机器级记录：`{version: 1, apps: [...]}`）。
    const v1 = `${JSON.stringify({ version: 1, apps: ['notes', 'other-app'] }, null, 2)}\n`
    writeFileSync(file, v1, { mode: 0o600 })
    const sink = warnings()
    const store = createAiRowsConsentStore({ file, scope: () => SCOPE, warn: sink.warn })

    // 读面：v1 内容**不得**被读成"已授权"（机器级语义，R19B-03）。
    expect(await store.isEnabled('notes')).toBe(false)
    // 写面：可写（这就是"升级路径"），不抛错。
    await store.setEnabled('notes', true)
    expect(await store.isEnabled('notes')).toBe(true)

    const document = JSON.parse(readFileSync(file, 'utf8')) as { version: number, grants: unknown[] }
    expect(document.version).toBe(AI_ROWS_CONSENT_FORMAT_VERSION)
    // v1 记录按既定设计作废（它没有账号/服务端段，猜读它才是 R19B-03 要修的方向）；
    // 这里钉的是"升级路径本身仍可写、且写出来的是完整的 v2 形状"。
    expect(document.grants).toEqual([{ user: SCOPE.user, server: SCOPE.server, app: 'notes' }])
    // 与"损坏"一侧的 warn **可区分**（运维据此判"这是升级"还是"文件坏了"）。
    expect(sink.messages.join('\n')).toMatch(/is a version 1 record/u)
    expect(sink.messages.join('\n')).not.toMatch(/refusing writes/u)
  })

  it('正：合法 v2 记录正常授权时，其它账号的记录一条不少（正常路径不丢数据）', async () => {
    const file = temporaryFile()
    writeFileSync(file, serializeAiRowsConsent(new Set([key(SCOPE, 'notes'), key(OTHER_SCOPE, 'notes')])), { mode: 0o600 })
    const store = createAiRowsConsentStore({ file, scope: () => SCOPE })
    await store.setEnabled('third-app', true)
    const document = JSON.parse(readFileSync(file, 'utf8')) as { version: number, grants: Array<{ user: string, app: string }> }
    expect(document.version).toBe(AI_ROWS_CONSENT_FORMAT_VERSION)
    expect(document.grants.map(grant => `${grant.user}:${grant.app}`).sort()).toEqual([
      'alice:notes',
      'alice:third-app',
      'bob:notes',
    ])
  })

  it('classifyAiRowsConsent 是三档判定的唯一实现（parseAiRowsConsent 只是它的当前版本视图）', () => {
    const current = serializeAiRowsConsent(new Set([key(SCOPE, 'notes')]))
    expect(classifyAiRowsConsent(current).kind).toBe('current')
    expect(classifyAiRowsConsent(JSON.stringify({ version: 1, apps: ['notes'] })).kind).toBe('legacy')
    for (const text of ['nope', '[]', 'null', JSON.stringify({ apps: [] }), JSON.stringify({ version: 3, grants: [] })]) {
      expect(classifyAiRowsConsent(text).kind, text).toBe('corrupt')
    }
    // 两函数必须**同源**：current ⇒ 键集合，legacy/corrupt ⇒ null。
    for (const text of [current, JSON.stringify({ version: 1, apps: [] }), 'nope']) {
      const verdict = classifyAiRowsConsent(text)
      const parsed = parseAiRowsConsent(text)
      if (verdict.kind === 'current') expect(parsed).toEqual(verdict.keys)
      else expect(parsed, text).toBeNull()
    }
  })
})
