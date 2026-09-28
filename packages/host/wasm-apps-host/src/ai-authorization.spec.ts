/**
 * 应用 AI 授权记录的用例（§21.1 Q9 / §21.6 判据 2、3）。
 *
 * 判据：
 *  - 授权维度是 **用户 ⊕ 服务端 ⊕ 应用**（换用户 / 换服务端 / 换应用都不继承，
 *    R21 B2-R21-01 —— 补上此前缺失的服务端维度）；
 *  - 三段**任一段缺失或含 NUL** ⇒ 读面 false、写面拒绝，且一个字都不落盘；
 *  - 落盘后**重新构造**一个记录实例仍然记得（重启不重问）；
 *  - 撤销 ⇒ 立刻不再授权（同进程、无需重启）；
 *  - 旧格式（v1，没有服务端段）⇒ 整份作废（**不**猜读成"已授权"），但
 *    允许就地改写（否则 v1 用户永远无法重新授权）；
 *  - **损坏 ≠ 合法旧版本**（FIX-17 / V6 F3）：截断 JSON / 顶层非对象 / 单条坏记录 /
 *    `version` 字段类型错 / 不认识的版本 / 认不出的 v1 形状 ⇒ **拒绝写**（抛
 *    `AiConsentReadError`，路由回 500 `CONSENT_NOT_PERSISTED`）且**原文件字节不变**，
 *    只有"可识别的旧版本"才允许就地改写（否则第一次写就把别的账号的记录静默销毁）；
 *  - 读失败/损坏 ⇒ fail-closed（当成未授权）且**留一条 warn**（"磁盘坏了"不能长得像
 *    "没人用过"）；
 *  - **读不动（非 ENOENT）的文件不得被下一次写整份覆盖**（R21 B2-R21-02 / B2-R21-05）：
 *    写面必须拒绝并如实报错；
 *  - 写失败 ⇒ grant/revoke 抛错（静默成功会让下一次调用仍然 403）。
 *
 * 变异验证（拆掉修复即红）：
 *  - `aiConsentKey` 去掉服务端段 ⇒「换服务端不继承」整组红；
 *  - `aiConsentKey` 去掉 user 段 ⇒「换用户不继承」红；
 *  - `load()` 把非 ENOENT 也当空并允许写 ⇒「读不动的文件不被覆盖」红（探针会看到
 *    目标被替换且 grant 正常 resolve）；
 *  - `serializeAiConsent` 回到"静默丢弃解析不出的键" ⇒ 含 NUL 那组红；
 *  - `parseAiConsent` 容忍 v1 ⇒「v1 = 未授权」红；
 *  - `classifyAiConsent` 把 `corrupt` 折回 `legacy`（= 退回 FIX-17 修前的"任何形状
 *    不符都当升级路径"）⇒「损坏 ⇒ 拒绝写 + 原文件字节不变」整组红（grant 会 resolve、
 *    文件被整份覆盖）；
 *  - `classifyAiConsent` 把 `legacy` 折进 `corrupt`（= 把升级路径一并禁掉）⇒
 *    「v1 就地升级」那两条红（grant 抛 AiConsentReadError）；
 *  - `load()` 在读失败时不 warn ⇒ warn 用例红。
 */
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AI_CONSENT_FILE_NAME,
  AI_CONSENT_FORMAT_VERSION,
  AiConsentReadError,
  AiConsentScopeError,
  aiConsentKey,
  classifyAiConsent,
  createAiChatAuthorization,
  isAiConsentReadError,
  isAiConsentScopeError,
  parseAiConsent,
  serializeAiConsent,
} from './ai-authorization.ts'

/** 宿主侧的作用域段（生产上来自同一个 `picoSession` 快照）。 */
const SERVER = 'https://harness.example'
const OTHER_SERVER = 'https://second.example'

const homes: string[] = []

function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pico-app-ai-consent-'))
  homes.push(dir)
  return dir
}

function temporaryFile(): string {
  return join(temporaryDir(), AI_CONSENT_FILE_NAME)
}

/** 走**唯一键构造点**（`aiChatAuthorization` 内部也用同一个函数）。 */
const key = (user: string, app: string, server: string = SERVER): string =>
  aiConsentKey({ userId: user, serverURL: server }, app)!

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('授权键与文件形状（三段作用域）', () => {
  it('键含三个维度（换用户 / 换服务端 / 换应用都不相等）', () => {
    const base = key('alice', 'my-notes')
    expect(base).toBe('alice\u0000https://harness.example\u0000my-notes')
    expect(key('bob', 'my-notes')).not.toBe(base)
    expect(key('alice', 'other-app')).not.toBe(base)
    // R21 B2-R21-01：服务端是判据的一部分（同名用户在两台服务端上是两个人）。
    expect(key('alice', 'my-notes', OTHER_SERVER)).not.toBe(base)
  })

  it('任一段缺失 / 纯空白 / 含 NUL ⇒ null（= 不匹配，不是"匹配空段"）', () => {
    expect(aiConsentKey(null, 'app')).toBeNull()
    expect(aiConsentKey(undefined, 'app')).toBeNull()
    expect(aiConsentKey({ userId: 'alice', serverURL: SERVER }, '')).toBeNull()
    expect(aiConsentKey({ userId: '', serverURL: SERVER }, 'app')).toBeNull()
    expect(aiConsentKey({ userId: '   ', serverURL: SERVER }, 'app')).toBeNull()
    expect(aiConsentKey({ userId: 'alice', serverURL: '' }, 'app')).toBeNull()
    expect(aiConsentKey({ userId: 'alice', serverURL: '   ' }, 'app')).toBeNull()
    // B2-R21-04：段内含分隔符会让一个键被切错 ⇒ 构造期就拒绝。
    expect(aiConsentKey({ userId: 'alice\u0000evil', serverURL: SERVER }, 'app')).toBeNull()
    expect(aiConsentKey({ userId: 'alice', serverURL: `${SERVER}\u0000x` }, 'app')).toBeNull()
    expect(aiConsentKey({ userId: 'alice', serverURL: SERVER }, 'app\u0000x')).toBeNull()
  })

  it('序列化可往返，且两次序列化逐字相同（稳定排序）', () => {
    const keys = new Set([key('bob', 'x'), key('alice', 'y'), key('alice', 'x')])
    const text = serializeAiConsent(keys)
    expect(parseAiConsent(text)).toEqual(keys)
    expect(serializeAiConsent(parseAiConsent(text) ?? new Set())).toBe(text)
    expect(JSON.parse(text)).toMatchObject({ version: AI_CONSENT_FORMAT_VERSION })
    expect(JSON.parse(text).grants[0]).toEqual({ user: 'alice', server: SERVER, app: 'x' })
  })

  it('无法解析成三段的键 ⇒ 序列化**抛错**（静默丢弃会让写面报成功而闸门仍拒绝）', () => {
    expect(() => serializeAiConsent(new Set(['alice\u0000app']))).toThrow(/refusing to serialize/u)
    expect(() => serializeAiConsent(new Set(['alice\u0000s\u0000app\u0000extra']))).toThrow(/refusing to serialize/u)
  })

  it('损坏/未知版本/多余形状/v1 一律整份作废（返回 null，不返回空集合）', () => {
    expect(parseAiConsent('not json')).toBeNull()
    expect(parseAiConsent('[]')).toBeNull()
    expect(parseAiConsent(JSON.stringify({ version: 99, grants: [] }))).toBeNull()
    expect(parseAiConsent(JSON.stringify({ version: AI_CONSENT_FORMAT_VERSION, grants: [{ user: 'a', server: SERVER }] }))).toBeNull()
    expect(parseAiConsent(JSON.stringify({ version: AI_CONSENT_FORMAT_VERSION, grants: [{ user: '', server: SERVER, app: 'x' }] }))).toBeNull()
    // v1（没有服务端段的旧形状）不得被读成"已授权"。
    expect(parseAiConsent(JSON.stringify({ version: 1, grants: [{ user: 'a', app: 'x' }] }))).toBeNull()
  })
})

describe('授权记录（文件形态）', () => {
  it('grant 落盘 ⇒ 新实例仍记得；revoke ⇒ 立刻不再授权', async () => {
    const file = temporaryFile()
    const first = createAiChatAuthorization({ file })
    expect(await first.isGranted('alice', 'my-notes', SERVER)).toBe(false)
    await first.grant('alice', 'my-notes', SERVER)
    expect(await first.isGranted('alice', 'my-notes', SERVER)).toBe(true)

    // 重启：新实例从同一文件读。
    const second = createAiChatAuthorization({ file })
    expect(await second.isGranted('alice', 'my-notes', SERVER)).toBe(true)
    await second.revoke('alice', 'my-notes', SERVER)
    expect(await second.isGranted('alice', 'my-notes', SERVER)).toBe(false)
    // 撤销对**同一进程里的另一个实例**也立刻生效（每次调用重读文件）。
    expect(await first.isGranted('alice', 'my-notes', SERVER)).toBe(false)
  })

  it('用户维度隔离：alice 的授权不给 bob，也不给另一个应用', async () => {
    const file = temporaryFile()
    const store = createAiChatAuthorization({ file })
    await store.grant('alice', 'my-notes', SERVER)
    expect(await store.isGranted('alice', 'my-notes', SERVER)).toBe(true)
    expect(await store.isGranted('bob', 'my-notes', SERVER)).toBe(false)
    expect(await store.isGranted('alice', 'other-app', SERVER)).toBe(false)
  })

  it('服务端维度隔离（R21 B2-R21-01）：同名用户换一台服务端 ⇒ 不继承，且两条记录并存', async () => {
    const file = temporaryFile()
    const store = createAiChatAuthorization({ file })
    await store.grant('alice', 'my-notes', SERVER)
    // 换租户：接口拿到的 serverURL 变了 ⇒ 是另一个键。
    expect(await store.isGranted('alice', 'my-notes', OTHER_SERVER)).toBe(false)
    await store.grant('alice', 'my-notes', OTHER_SERVER)
    const document = JSON.parse(readFileSync(file, 'utf8')) as { grants: unknown[] }
    expect(document.grants).toHaveLength(2)
    // 回到租户 1：租户 1 的记录仍在，租户 2 的那条不会被误当成它。
    expect(await store.isGranted('alice', 'my-notes', SERVER)).toBe(true)
  })

  it('拿不到服务端地址 ⇒ 读面 false、写面拒绝、一个字都不落盘（不得当成"无服务端"）', async () => {
    const file = temporaryFile()
    const store = createAiChatAuthorization({ file })
    for (const server of [undefined, null, '', '   ']) {
      expect(await store.isGranted('alice', 'my-notes', server), String(server)).toBe(false)
      const rejection = await store.grant('alice', 'my-notes', server).then(() => null, (cause: unknown) => cause)
      expect(isAiConsentScopeError(rejection), String(server)).toBe(true)
    }
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })

  it('空 user/app 与含 NUL 的段一律拒绝（写一条"谁都不是"的记录更糟）', async () => {
    const file = temporaryFile()
    const store = createAiChatAuthorization({ file })
    expect(await store.isGranted('', 'my-notes', SERVER)).toBe(false)
    expect(await store.isGranted('alice', '', SERVER)).toBe(false)
    await expect(store.grant('', 'my-notes', SERVER)).rejects.toBeInstanceOf(AiConsentScopeError)
    await expect(store.revoke('alice', '', SERVER)).rejects.toBeInstanceOf(AiConsentScopeError)
    // B2-R21-04：含 NUL 的用户名（服务端可下发）不得静默丢记录 —— 写面直接拒绝。
    await expect(store.grant('alice\u0000evil', 'my-notes', SERVER)).rejects.toBeInstanceOf(AiConsentScopeError)
    expect(await store.isGranted('alice\u0000evil', 'my-notes', SERVER)).toBe(false)
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })

  it('v1 旧文件整体判为未授权，但重新授权会就地改写成 v2', async () => {
    const file = temporaryFile()
    writeFileSync(file, JSON.stringify({ version: 1, grants: [{ user: 'alice', app: 'my-notes' }] }), { mode: 0o600 })
    const store = createAiChatAuthorization({ file })
    expect(await store.isGranted('alice', 'my-notes', SERVER)).toBe(false)
    await store.grant('alice', 'my-notes', SERVER)
    const document = JSON.parse(readFileSync(file, 'utf8')) as { version: number, grants: unknown[] }
    expect(document.version).toBe(AI_CONSENT_FORMAT_VERSION)
    expect(document.grants).toEqual([{ user: 'alice', server: SERVER, app: 'my-notes' }])
  })

  it('文件损坏 ⇒ 当作未授权并记 warn（fail-closed + 可诊断）', async () => {
    const file = temporaryFile()
    const warnings: string[] = []
    writeFileSync(file, '{ this is not json', 'utf8')
    const store = createAiChatAuthorization({ file, warn: message => warnings.push(message) })
    expect(await store.isGranted('alice', 'my-notes', SERVER)).toBe(false)
    expect(warnings.join('\n')).toMatch(/not a usable record \(the file is not valid JSON\)/u)
    expect(warnings.join('\n')).toMatch(/refusing writes/u)
  })

  it('并发 grant 不互相覆盖（读-改-写串行化）', async () => {
    const file = temporaryFile()
    const store = createAiChatAuthorization({ file })
    await Promise.all([
      store.grant('alice', 'a', SERVER),
      store.grant('alice', 'b', SERVER),
      store.grant('bob', 'a', SERVER),
      store.grant('bob', 'b', OTHER_SERVER),
    ])
    expect(await store.isGranted('alice', 'a', SERVER)).toBe(true)
    expect(await store.isGranted('alice', 'b', SERVER)).toBe(true)
    expect(await store.isGranted('bob', 'a', SERVER)).toBe(true)
    expect(await store.isGranted('bob', 'b', OTHER_SERVER)).toBe(true)
    expect(await store.isGranted('bob', 'b', SERVER)).toBe(false)
  })

  it('没有文件路径 ⇒ 只在内存（同实例有效、新实例 Forget）', async () => {
    const store = createAiChatAuthorization({})
    await store.grant('alice', 'my-notes', SERVER)
    expect(await store.isGranted('alice', 'my-notes', SERVER)).toBe(true)
    expect(await createAiChatAuthorization({}).isGranted('alice', 'my-notes', SERVER)).toBe(false)
  })

  it('写失败 ⇒ 抛错（不静默）', async () => {
    // 目标是一个**目录**：读它是 EISDIR ⇒ 写面在读不动这一档就拒绝。
    const dir = temporaryDir()
    const store = createAiChatAuthorization({ file: dir })
    await expect(store.grant('alice', 'my-notes', SERVER)).rejects.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// R21 B2-R21-02 / B2-R21-05：读失败的文件不得被下一次写整份覆盖
// ---------------------------------------------------------------------------

describe('读不动的记录文件：读面 fail-closed，写面拒绝覆盖', () => {
  /**
   * 构造"文件存在、读它是非 ENOENT 的错误、而包含它的目录可写"的形态。
   *
   * 用**指向目录的符号链接**：`readFile()` 跟随链接得到 `EISDIR`（不是 ENOENT），
   * 而 `rename(tmp, link)` 只需要**目录**写权限、会把链接本身替换成普通文件 ——
   * 正是"读失败但写得进去"那个组合。**不用 chmod 000**：root（CAP_DAC_OVERRIDE，
   * 容器/CI 常见）下它根本挡不住读；本文件另有一段带自校准的 chmod 用例。
   * @returns 记录文件路径（符号链接）与它指向的真实目录。
   */
  function unreadableTarget(): { file: string, real: string } {
    const dir = temporaryDir()
    const real = join(dir, 'real-records-dir')
    const file = join(dir, AI_CONSENT_FILE_NAME)
    // 真实目录：rename 到链接路径会**替换链接**（而不是失败），所以"拒绝写"是唯一
    // 能保住它的行为。
    mkdirSync(real, { recursive: true })
    symlinkSync('real-records-dir', file)
    return { file, real }
  }

  it('读面：非 ENOENT 的读失败 ⇒ false（fail-closed）并留一条 warn', async () => {
    const { file } = unreadableTarget()
    const warnings: string[] = []
    const store = createAiChatAuthorization({ file, warn: message => warnings.push(message) })
    expect(await store.isGranted('alice', 'my-notes', SERVER)).toBe(false)
    expect(warnings.join('\n')).toMatch(/reading the app AI consent file failed/u)
    // 留痕必须点出"同时拒绝写"，否则读者会以为只是读面降级。
    expect(warnings.join('\n')).toMatch(/refusing writes/u)
  })

  it('写面：拒绝并抛 AiConsentReadError，链接与它指向的目录一字未动', async () => {
    const { file, real } = unreadableTarget()
    const store = createAiChatAuthorization({ file })
    const rejection = await store.grant('brand-new', 'my-notes', SERVER).then(() => null, (cause: unknown) => cause)
    expect(isAiConsentReadError(rejection)).toBe(true)
    expect(rejection).toBeInstanceOf(AiConsentReadError)
    // 目标仍然是那个符号链接（未被 rename 替换），指向的目录仍然是目录。
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
    expect(readlinkSync(file)).toBe('real-records-dir')
    expect(statSync(real).isDirectory()).toBe(true)
  })

  it('撤销同样不得覆盖（撤销走的是同一条读-改-写）', async () => {
    const { file } = unreadableTarget()
    const store = createAiChatAuthorization({ file })
    await expect(store.revoke('alice', 'my-notes', SERVER)).rejects.toBeInstanceOf(AiConsentReadError)
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
  })

  it('文件名不存在（ENOENT）仍然是"首次运行"：允许建文件', async () => {
    const file = temporaryFile()
    const store = createAiChatAuthorization({ file })
    await store.grant('alice', 'my-notes', SERVER)
    expect(await store.isGranted('alice', 'my-notes', SERVER)).toBe(true)
  })

  it('真 EACCES（自校准）：记录不被吞 + 写面如实报错 + 原字节不变', async () => {
    const file = temporaryFile()
    const seeded = createAiChatAuthorization({ file })
    await seeded.grant('alice', 'keep-me', SERVER)
    await seeded.grant('bob', 'keep-me-too', SERVER)
    const before = readFileSync(file)
    await chmodSync(file, 0o000)
    try {
      // **自校准**：直接做一遍用例要做的动作（读这个 000 文件），确认本环境真的挡得住。
      const blocked = await readFile(file, 'utf8').then(() => false, () => true)
      const store = createAiChatAuthorization({ file })
      if (blocked) {
        expect(await store.isGranted('alice', 'keep-me', SERVER)).toBe(false)
        await expect(store.grant('alice', 'brand-new', SERVER)).rejects.toBeInstanceOf(AiConsentReadError)
        // **先恢复读权限再对字节**：`blocked === true` 说明本环境的读确实被挡，
        // 此时直接 `readFileSync` 会以 EACCES 抛错 —— 那不是被测行为的问题，而是
        // **观测手段**的问题（恢复权限只改变"怎么验"，不改变"验什么"：判据仍然是
        // "写面拒绝覆盖后原字节不变"）。2026-09-28 修 "本地绿、CI 红"：本地以 root
        // 跑（CAP_DAC_OVERRIDE ⇒ 走 else 支），CI runner 是非 root ⇒ 走这一支，
        // 于是这条断言在 CI 上必然以 EACCES 失败。
        await chmodSync(file, 0o600)
        expect(readFileSync(file).equals(before)).toBe(true)
      } else {
        // root/CAP_DAC_OVERRIDE（容器与 CI 常见）：读得到就照常工作，**不因环境变红**，
        // 但写面仍然必须只增不减（其它账号的记录不能被抹掉）。
        await store.grant('alice', 'brand-new', SERVER)
        expect(await store.isGranted('bob', 'keep-me-too', SERVER)).toBe(true)
      }
    } finally {
      await chmodSync(file, 0o600)
    }
    // 无论走哪一支：控制权交回后，原先两条记录都必须在（这条与文件系统无关）。
    const after = createAiChatAuthorization({ file })
    expect(await after.isGranted('alice', 'keep-me', SERVER)).toBe(true)
    expect(await after.isGranted('bob', 'keep-me-too', SERVER)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// FIX-17 / V6 F3：损坏 ≠ 合法旧版本
//
// 修前：`parseAiConsent` 只回 "键集合 or null"，而 `load()` 把 `null` 一律当作
// "旧格式 ⇒ 可写" ⇒ 截断 JSON / 单条坏记录 / 顶层非对象 / version 类型错 都会让下一次
// `grant` 以"空集合 + 本次一条"整份 rename 覆盖：**同一文件里其它账号/应用的合法记录
// 静默消失**，而调用方收到成功。
//
// 修后：只有"可识别的旧版本"（version: 1 且 v1 形状完整）才允许就地改写；其余一律
// `AiConsentReadError`（路由 500 CONSENT_NOT_PERSISTED）+ **原文件字节不变**。
// ---------------------------------------------------------------------------

/** 内容摘要（判"原文件一字未动"用 sha256，不用 mtime/size 这类弱判据）。 */
const digestOf = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')

describe('损坏 ≠ 合法旧版本（FIX-17 / V6 F3）', () => {
  /** 一份**合法 v2 记录**的落盘文本（alice + bob 两条，代表"别人的记录"）。 */
  const seededText = (): string => serializeAiConsent(new Set([key('alice', 'my-notes'), key('bob', 'my-notes')]))

  /** 四种"形状不符"的形态（判据逐条要求：拒绝写 + 原文件字节不变）。 */
  const corruptShapes: Array<[label: string, text: string]> = [
    ['截断 JSON', '{"version":2,"grants":[{"user":"alice"'],
    ['顶层非对象', '[]'],
    [
      '单条坏记录',
      JSON.stringify({
        version: AI_CONSENT_FORMAT_VERSION,
        grants: [{ user: 'alice', server: SERVER, app: 'my-notes' }, 42],
      }),
    ],
    ['version 字段类型错', JSON.stringify({ version: String(AI_CONSENT_FORMAT_VERSION), grants: [] })],
  ]

  it.each(corruptShapes)('%s ⇒ 拒绝写 + 原文件字节不变 + 读面可判因（不是静默 false）', async (label, text) => {
    const file = temporaryFile()
    writeFileSync(file, text, { mode: 0o600 })
    const before = digestOf(file)
    const warnings: string[] = []
    const store = createAiChatAuthorization({ file, warn: message => warnings.push(message) })

    // 读面：fail-closed（不是"已授权"）。
    expect(await store.isGranted('alice', 'my-notes', SERVER), label).toBe(false)

    // 写面：拒绝，且是**可判因**的类型（本机路由据此回 500 CONSENT_NOT_PERSISTED）。
    const rejection = await store.grant('carol', 'my-notes', SERVER).then(() => null, (cause: unknown) => cause)
    expect(isAiConsentReadError(rejection), label).toBe(true)
    expect(rejection).toBeInstanceOf(AiConsentReadError)
    // 撤销走的是同一条读-改-写 ⇒ 同样不得覆盖。
    await expect(store.revoke('alice', 'my-notes', SERVER), label).rejects.toBeInstanceOf(AiConsentReadError)

    // **原文件一字未动**（sha256 相同）：其它账号/应用的记录不可能被静默销毁。
    expect(digestOf(file), label).toBe(before)
    // 读面不是"静默 false"：留了一条可诊断的 warn，并点明"同时拒绝写"。
    expect(warnings.join('\n'), label).toMatch(/not a usable record/u)
    expect(warnings.join('\n'), label).toMatch(/refusing writes/u)
  })

  it('一份 v2 记录里有一条坏条目 ⇒ 拒绝写，同一文件里其它账号的**合法记录不消失**', async () => {
    const file = temporaryFile()
    // alice / carol 两条是**合法**记录，只有中间那条被改坏（人手编辑 / 半写 / 磁盘错误）。
    const text = JSON.stringify({
      version: AI_CONSENT_FORMAT_VERSION,
      grants: [
        { user: 'alice', server: SERVER, app: 'my-notes' },
        { user: 'bob', server: SERVER, app: 42 },
        { user: 'carol', server: SERVER, app: 'my-notes' },
      ],
    }, null, 2)
    writeFileSync(file, text, { mode: 0o600 })
    const store = createAiChatAuthorization({ file })
    await expect(store.grant('dave', 'my-notes', SERVER)).rejects.toBeInstanceOf(AiConsentReadError)
    // 字节级证据：carol 的合法记录还在（修前这里会被整份覆盖成 134B 的单条记录）。
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(readFileSync(file, 'utf8')).toContain('"carol"')
  })

  it('不认识的版本号（更高/更低）与"认不出的 v1 形状"都不是升级路径 ⇒ 拒绝写', async () => {
    const shapes = [
      JSON.stringify({ version: AI_CONSENT_FORMAT_VERSION + 1, grants: [] }),
      JSON.stringify({ version: AI_CONSENT_FORMAT_VERSION - 2, grants: [] }),
      // version = 1 但形状认不出来（缺 app 字段）⇒ 坏文件，不是"旧版本"。
      JSON.stringify({ version: 1, grants: [{ user: 'alice' }] }),
    ]
    for (const text of shapes) {
      const file = temporaryFile()
      writeFileSync(file, text, { mode: 0o600 })
      const before = digestOf(file)
      const store = createAiChatAuthorization({ file })
      await expect(store.grant('alice', 'my-notes', SERVER), text).rejects.toBeInstanceOf(AiConsentReadError)
      expect(digestOf(file), text).toBe(before)
    }
  })

  it('正：真实 v1 文件仍**就地升级**成 v2（升级路径没被误伤）', async () => {
    const file = temporaryFile()
    // 上一版真实写出的形状（v1 没有服务端段）——注意结尾换行与缩进都与历史产出同形。
    const v1 = `${JSON.stringify({ version: 1, grants: [{ user: 'alice', app: 'my-notes' }] }, null, 2)}\n`
    writeFileSync(file, v1, { mode: 0o600 })
    const warnings: string[] = []
    const store = createAiChatAuthorization({ file, warn: message => warnings.push(message) })

    // 读面：v1 内容**不得**被读成"已授权"（没有服务端段）。
    expect(await store.isGranted('alice', 'my-notes', SERVER)).toBe(false)
    // 写面：可写（这就是"升级路径"），不抛错。
    await store.grant('alice', 'my-notes', SERVER)
    expect(await store.isGranted('alice', 'my-notes', SERVER)).toBe(true)

    const document = JSON.parse(readFileSync(file, 'utf8')) as { version: number, grants: unknown[] }
    expect(document.version).toBe(AI_CONSENT_FORMAT_VERSION)
    expect(document.grants).toEqual([{ user: 'alice', server: SERVER, app: 'my-notes' }])
    // 与"损坏"一侧的 warn **可区分**（运维据此判"这是升级"还是"文件坏了"）。
    expect(warnings.join('\n')).toMatch(/is a version 1 record/u)
    expect(warnings.join('\n')).not.toMatch(/refusing writes/u)
  })

  it('正：合法 v2 记录正常授权时，其它账号的记录一条不少（正常路径不丢数据）', async () => {
    const file = temporaryFile()
    writeFileSync(file, seededText(), { mode: 0o600 })
    const store = createAiChatAuthorization({ file })
    await store.grant('carol', 'other-app', SERVER)
    const document = JSON.parse(readFileSync(file, 'utf8')) as { version: number, grants: Array<{ user: string }> }
    expect(document.version).toBe(AI_CONSENT_FORMAT_VERSION)
    expect(document.grants.map(grant => grant.user).sort()).toEqual(['alice', 'bob', 'carol'])
  })

  it('classifyAiConsent 是三档判定的唯一实现（parseAiConsent 只是它的当前版本视图）', () => {
    const current = serializeAiConsent(new Set([key('alice', 'my-notes')]))
    expect(classifyAiConsent(current).kind).toBe('current')
    expect(classifyAiConsent(JSON.stringify({ version: 1, grants: [{ user: 'alice', app: 'my-notes' }] })).kind).toBe('legacy')
    for (const text of ['nope', '[]', 'null', JSON.stringify({ grants: [] }), JSON.stringify({ version: 3, grants: [] })]) {
      expect(classifyAiConsent(text).kind, text).toBe('corrupt')
    }
    // 两函数必须**同源**：current ⇒ 键集合，legacy/corrupt ⇒ null。
    for (const text of [current, JSON.stringify({ version: 1, grants: [] }), 'nope']) {
      const verdict = classifyAiConsent(text)
      const parsed = parseAiConsent(text)
      if (verdict.kind === 'current') expect(parsed).toEqual(verdict.keys)
      else expect(parsed, text).toBeNull()
    }
  })
})
