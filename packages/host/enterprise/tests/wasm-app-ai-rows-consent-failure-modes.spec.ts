/**
 * R21 B2 的**失败面**判据（读行授权）：B2-R21-02 / B2-R21-03 / B2-R21-04 / B2-R21-05。
 *
 * 为什么单独一个文件：既有的两组判据
 * （`wasm-app-ai-rows-consent.spec.ts` 27 例 + `…-scope.spec.ts` 14 例）把**判定面**
 * 钉得很密（三段键、v1 作废、作用域缺失拒绝、路由 401），而**失败面**几乎在判据面之外：
 * B2 的变异 M7（三处 `warn` 全去掉）与 M10（**实现**读失败后拒绝覆盖）都是
 * `41 passed / EXIT=0`——也就是说那组判据既不能证明修好了，也不能证明没修。
 * 本文件把三条失败面各钉一条：
 *
 *  1. **留痕**（B2-R21-03）：作用域解析抛错 / 读失败 / 版本不符三处 `warn` 都必须真的发；
 *  2. **读不动的文件不得被下一次写整份覆盖**（B2-R21-02 / B2-R21-05）：记录被吞 +
 *     写面如实报错 + 原文件一字未改（`ENOENT` 才允许建文件）；
 *  3. **段内含 NUL ⇒ 写面拒绝，不能"报成功而落盘零记录"**（B2-R21-04）。
 *
 * ---- 变异验证（拆掉哪一处，哪条用例必红）----
 *   - 三处 `warn(...)` 任一删掉 ⇒ 第 1 组对应用例红；
 *   - `load()` 把非 ENOENT 的读失败也当"空记录"并允许写 ⇒「链接/原文件被替换」与
 *     「写面如实报错」红（那正是 M10 的形态）；
 *   - `serializeAiRowsConsent` 回到 `continue`（静默丢弃）⇒ 第 3 组红（`setEnabled` 会 resolve）；
 *   - `aiRowsConsentKey` 去掉 NUL 检查 ⇒ 第 3 组的"构造期拒绝"与"落盘零记录"红。
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AI_ROWS_CONSENT_FILE_NAME,
  AI_ROWS_CONSENT_FORMAT_VERSION,
  AiRowsConsentReadError,
  AiRowsConsentScopeError,
  aiRowsConsentKey,
  createAiRowsConsentStore,
  isAiRowsConsentReadError,
  isAiRowsConsentScopeError,
  serializeAiRowsConsent,
} from '../src/wasm-apps-ai-rows-consent.ts'
import type { AiRowsConsentScope } from '../src/wasm-apps-ai-rows-consent.ts'

const SCOPE: AiRowsConsentScope = { user: 'alice', server: 'https://harness.example' }

const homes: string[] = []

function temporaryDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pico-ai-rows-failure-'))
  homes.push(dir)
  return dir
}

function temporaryFile(): string {
  return join(temporaryDir(), AI_ROWS_CONSENT_FILE_NAME)
}

/** 记录 warn 的替身（与生产同形：`ctx.logger.warn` 是一条字符串）。 */
function warnings(): { messages: string[], warn: (message: string) => void } {
  const messages: string[] = []
  return { messages, warn: (message) => { messages.push(message) } }
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. B2-R21-03：三处失败留痕都必须真的发（此前三条 warn 零判据，变异 M7 全绿）
// ---------------------------------------------------------------------------

describe('失败留痕：三处 warn 各有一条断言（不是"存在性断言"）', () => {
  it('作用域解析抛错 ⇒ 留痕，且读面 false / 写面按作用域错误拒绝', async () => {
    const sink = warnings()
    const store = createAiRowsConsentStore({
      file: temporaryFile(),
      scope: () => { throw new Error('session snapshot exploded') },
      warn: sink.warn,
    })
    expect(await store.isEnabled('notes')).toBe(false)
    expect(sink.messages.join('\n')).toMatch(/resolving the AI rows consent scope failed/u)
    expect(sink.messages.join('\n')).toMatch(/session snapshot exploded/u)
    const rejection = await store.setEnabled('notes', true).then(() => null, (cause: unknown) => cause)
    expect(isAiRowsConsentScopeError(rejection)).toBe(true)
    expect(rejection).toBeInstanceOf(AiRowsConsentScopeError)
  })

  it('读失败（非 ENOENT）⇒ 留痕，并点明"同时拒绝写"（否则读者会以为只是读面降级）', async () => {
    const dir = temporaryDir()
    const file = join(dir, AI_ROWS_CONSENT_FILE_NAME)
    // 指向**已存在**的目录：`readFile` 得到 EISDIR（悬空链接会是 ENOENT = 首次运行，
    // 那一条**不该**留痕 —— 见下一组用例）。
    mkdirSync(join(dir, 'real-records-dir'), { recursive: true })
    symlinkSync('real-records-dir', file)
    const sink = warnings()
    const store = createAiRowsConsentStore({ file, scope: () => SCOPE, warn: sink.warn })
    expect(await store.isEnabled('notes')).toBe(false)
    expect(sink.messages.join('\n')).toMatch(/reading the AI rows consent file failed/u)
    expect(sink.messages.join('\n')).toMatch(/refusing writes/u)
  })

  it('版本/形状不符 ⇒ 留痕（并且仍然 fail-closed）', async () => {
    const file = temporaryFile()
    writeFileSync(file, JSON.stringify({ version: 1, apps: ['notes'] }), { mode: 0o600 })
    const sink = warnings()
    const store = createAiRowsConsentStore({ file, scope: () => SCOPE, warn: sink.warn })
    expect(await store.isEnabled('notes')).toBe(false)
    expect(sink.messages.join('\n')).toMatch(new RegExp(`not a version ${String(AI_ROWS_CONSENT_FORMAT_VERSION)} record`, 'u'))
  })

  it('一切正常时不留痕（防止"warn 恒发"这种假绿）', async () => {
    const file = temporaryFile()
    const sink = warnings()
    const store = createAiRowsConsentStore({ file, scope: () => SCOPE, warn: sink.warn })
    await store.setEnabled('notes', true)
    expect(await store.isEnabled('notes')).toBe(true)
    expect(sink.messages).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. B2-R21-02 / B2-R21-05：读不动的记录文件不得被下一次写整份覆盖
// ---------------------------------------------------------------------------

describe('读不动的记录文件：记录不被吞 + 写面如实报错 + 原文件一字未改', () => {
  /**
   * 构造"文件存在、读它是非 ENOENT 的错误、而包含它的目录可写"的形态。
   *
   * 用**指向目录的符号链接**：`readFile()` 跟随链接得到 `EISDIR`（不是 ENOENT），而
   * `rename(tmp, link)` 只需要**目录**写权限、会把链接本身替换成普通文件 —— 正是
   * "读失败但写得进去"那个组合。**不用 chmod 000**：root（CAP_DAC_OVERRIDE，
   * 容器/CI 常见）下它根本挡不住读；本文件另有一段带自校准的 chmod 用例。
   */
  function unreadableTarget(): { file: string, real: string } {
    const dir = temporaryDir()
    const real = join(dir, 'real-records-dir')
    const file = join(dir, AI_ROWS_CONSENT_FILE_NAME)
    mkdirSync(real, { recursive: true })
    symlinkSync('real-records-dir', file)
    return { file, real }
  }

  it('写面拒绝并抛 AiRowsConsentReadError，链接与它指向的目录一字未动', async () => {
    const { file, real } = unreadableTarget()
    const store = createAiRowsConsentStore({ file, scope: () => SCOPE })
    const rejection = await store.setEnabled('brand-new', true).then(() => null, (cause: unknown) => cause)
    expect(isAiRowsConsentReadError(rejection)).toBe(true)
    expect(rejection).toBeInstanceOf(AiRowsConsentReadError)
    // 修前：rename 覆盖链接 ⇒ 这里变成一个普通文件、`grant` 正常 resolve（M10 的形态）。
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
    expect(readlinkSync(file)).toBe('real-records-dir')
    expect(statSync(real).isDirectory()).toBe(true)
  })

  it('撤销同样不得覆盖（撤销走的是同一条读-改-写）', async () => {
    const { file } = unreadableTarget()
    const store = createAiRowsConsentStore({ file, scope: () => SCOPE })
    await expect(store.setEnabled('notes', false)).rejects.toBeInstanceOf(AiRowsConsentReadError)
    expect(lstatSync(file).isSymbolicLink()).toBe(true)
  })

  it('真 EACCES（自校准）：三条记录不被吞 + 写面如实报错 + 原字节不变', async () => {
    const file = temporaryFile()
    const seeded = createAiRowsConsentStore({ file, scope: () => SCOPE })
    await seeded.setEnabled('keep-me', true)
    const other = createAiRowsConsentStore({ file, scope: () => ({ user: 'bob', server: SCOPE.server }) })
    await other.setEnabled('keep-me-too', true)
    const third = createAiRowsConsentStore({ file, scope: () => ({ user: 'alice', server: 'https://other.example' }) })
    await third.setEnabled('keep-me-three', true)
    const before = readFileSync(file)
    await chmodSync(file, 0o000)
    try {
      // **自校准**：直接做一遍用例要做的动作（读这个 000 文件），确认本环境真的挡得住。
      const blocked = await readFile(file, 'utf8').then(() => false, () => true)
      const store = createAiRowsConsentStore({ file, scope: () => SCOPE })
      if (blocked) {
        expect(await store.isEnabled('keep-me')).toBe(false)
        await expect(store.setEnabled('brand-new', true)).rejects.toBeInstanceOf(AiRowsConsentReadError)
        expect(readFileSync(file).equals(before)).toBe(true)
      } else {
        // root/CAP_DAC_OVERRIDE（容器与 CI 常见）：读得到就照常工作，**不因环境变红**，
        // 但写面仍然必须只增不减（别人的记录不能被抹掉）。
        await store.setEnabled('brand-new', true)
      }
    } finally {
      await chmodSync(file, 0o600)
    }
    // 与文件系统无关的那一半：控制权交回后三条记录都必须在。
    const document = JSON.parse(readFileSync(file, 'utf8')) as { grants: Array<{ app: string }> }
    const apps = document.grants.map(grant => grant.app).sort()
    expect(apps).toContain('keep-me')
    expect(apps).toContain('keep-me-too')
    expect(apps).toContain('keep-me-three')
  })

  it('文件不存在（ENOENT）仍然是"首次运行"：允许建文件', async () => {
    const file = temporaryFile()
    const store = createAiRowsConsentStore({ file, scope: () => SCOPE })
    await store.setEnabled('notes', true)
    expect(await store.isEnabled('notes')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. B2-R21-04：含 NUL 的作用域段 ⇒ 写面拒绝（不能"报成功而落盘零记录"）
// ---------------------------------------------------------------------------

describe('段内含 NUL：构造期就拒绝（此前写面 resolve、落盘零记录、读面 false）', () => {
  it('aiRowsConsentKey 对含 NUL 的三段各回 null（不再切成 4 段）', () => {
    expect(aiRowsConsentKey({ user: 'alice\u0000evil', server: SCOPE.server }, 'notes')).toBeNull()
    expect(aiRowsConsentKey({ user: 'alice', server: `${SCOPE.server}\u0000x` }, 'notes')).toBeNull()
    expect(aiRowsConsentKey({ user: 'alice', server: SCOPE.server }, 'notes\u0000x')).toBeNull()
    // 正常取值不受影响。
    expect(aiRowsConsentKey(SCOPE, 'notes')).toBe(`alice\u0000${SCOPE.server}\u0000notes`)
  })

  it('写面拒绝（可判因的作用域错误），读面 false，且一个字都不落盘', async () => {
    const file = temporaryFile()
    const store = createAiRowsConsentStore({ file, scope: () => ({ user: 'alice\u0000evil', server: SCOPE.server }) })
    const rejection = await store.setEnabled('notes', true).then(() => null, (cause: unknown) => cause)
    expect(isAiRowsConsentScopeError(rejection)).toBe(true)
    expect(isAiRowsConsentReadError(rejection)).toBe(false)
    expect(await store.isEnabled('notes')).toBe(false)
    // 修前：`setEnabled` resolve、文件被写成 `{"version":2,"grants":[]}`（面板"已允许"、
    // 闸门仍拒绝）。
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })

  it('序列化遇到解析不成三段的键 ⇒ 抛错（不静默丢弃）', () => {
    expect(() => serializeAiRowsConsent(new Set(['alice\u0000notes']))).toThrow(/refusing to serialize/u)
    expect(() => serializeAiRowsConsent(new Set([`a\u0000b\u0000c\u0000d`]))).toThrow(/refusing to serialize/u)
  })

  it('用户名为普通中文/大写/点号（合法取值）不受 NUL 检查影响', async () => {
    const file = temporaryFile()
    const scope: AiRowsConsentScope = { user: '张 三.A', server: SCOPE.server }
    const store = createAiRowsConsentStore({ file, scope: () => scope })
    await store.setEnabled('notes', true)
    expect(await store.isEnabled('notes')).toBe(true)
  })
})
