/**
 * 应用 AI 授权记录的用例（§21.1 Q9 / §21.6 判据 2、3）。
 *
 * 判据：
 *  - 授权维度是 **用户 × 应用**（换用户不继承）;
 *  - 落盘后**重新构造**一个记录实例仍然记得（重启不重问）;
 *  - 撤销 ⇒ 立刻不再授权（同进程、无需重启）;
 *  - 读失败/损坏 ⇒ fail-closed（当成未授权）且**留一条 warn**（"磁盘坏了"不能长得像
 *    "没人用过"）;
 *  - 写失败 ⇒ grant/revoke 抛错（静默成功会让下一次调用仍然 403）。
 *
 * 变异验证：
 *  - `aiConsentKey` 去掉 user 维度 ⇒ "换用户不继承"必红;
 *  - `parseAiConsent` 对损坏输入返回空集合而不是 `null` ⇒ fail-closed 用例仍绿但
 *    warn 用例红（本套件同时钉住两条）;
 *  - `load()` 在读失败时返回空集合而不 warn ⇒ warn 用例红。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AI_CONSENT_FILE_NAME,
  AI_CONSENT_FORMAT_VERSION,
  aiConsentKey,
  createAiChatAuthorization,
  parseAiConsent,
  serializeAiConsent,
} from './ai-authorization.ts'

const homes: string[] = []

function temporaryFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pico-app-ai-consent-'))
  homes.push(dir)
  return join(dir, AI_CONSENT_FILE_NAME)
}

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('授权键与文件形状', () => {
  it('键含两个维度（换用户/换应用都不相等）', () => {
    expect(aiConsentKey('alice', 'my-notes')).toBe(aiConsentKey('alice', 'my-notes'))
    expect(aiConsentKey('alice', 'my-notes')).not.toBe(aiConsentKey('bob', 'my-notes'))
    expect(aiConsentKey('alice', 'my-notes')).not.toBe(aiConsentKey('alice', 'other-app'))
  })

  it('序列化可往返，且两次序列化逐字相同（稳定排序）', () => {
    const keys = new Set([aiConsentKey('bob', 'x'), aiConsentKey('alice', 'y'), aiConsentKey('alice', 'x')])
    const text = serializeAiConsent(keys)
    expect(parseAiConsent(text)).toEqual(keys)
    expect(serializeAiConsent(parseAiConsent(text) ?? new Set())).toBe(text)
    expect(JSON.parse(text)).toMatchObject({ version: AI_CONSENT_FORMAT_VERSION })
  })

  it('损坏/未知版本/多余形状一律整份作废（返回 null，不返回空集合）', () => {
    expect(parseAiConsent('not json')).toBeNull()
    expect(parseAiConsent('[]')).toBeNull()
    expect(parseAiConsent(JSON.stringify({ version: 99, grants: [] }))).toBeNull()
    expect(parseAiConsent(JSON.stringify({ version: AI_CONSENT_FORMAT_VERSION, grants: [{ user: 'a' }] }))).toBeNull()
    expect(parseAiConsent(JSON.stringify({ version: AI_CONSENT_FORMAT_VERSION, grants: [{ user: '', app: 'x' }] }))).toBeNull()
  })
})

describe('授权记录（文件形态）', () => {
  it('grant 落盘 ⇒ 新实例仍记得；revoke ⇒ 立刻不再授权', async () => {
    const file = temporaryFile()
    const first = createAiChatAuthorization({ file })
    expect(await first.isGranted('alice', 'my-notes')).toBe(false)
    await first.grant('alice', 'my-notes')
    expect(await first.isGranted('alice', 'my-notes')).toBe(true)

    // 重启：新实例从同一文件读。
    const second = createAiChatAuthorization({ file })
    expect(await second.isGranted('alice', 'my-notes')).toBe(true)
    await second.revoke('alice', 'my-notes')
    expect(await second.isGranted('alice', 'my-notes')).toBe(false)
    // 撤销对**同一进程里的另一个实例**也立刻生效（每次调用重读文件）。
    expect(await first.isGranted('alice', 'my-notes')).toBe(false)
  })

  it('用户维度隔离：alice 的授权不给 bob，也不给另一个应用', async () => {
    const file = temporaryFile()
    const store = createAiChatAuthorization({ file })
    await store.grant('alice', 'my-notes')
    expect(await store.isGranted('alice', 'my-notes')).toBe(true)
    expect(await store.isGranted('bob', 'my-notes')).toBe(false)
    expect(await store.isGranted('alice', 'other-app')).toBe(false)
  })

  it('空 user/app 一律不授权；grant/revoke 直接拒绝（写一条"谁都不是"的记录更糟）', async () => {
    const file = temporaryFile()
    const store = createAiChatAuthorization({ file })
    expect(await store.isGranted('', 'my-notes')).toBe(false)
    expect(await store.isGranted('alice', '')).toBe(false)
    await expect(store.grant('', 'my-notes')).rejects.toThrow(/both a user and an app id/u)
    await expect(store.revoke('alice', '')).rejects.toThrow(/both a user and an app id/u)
  })

  it('文件损坏 ⇒ 当作未授权并记 warn（fail-closed + 可诊断）', async () => {
    const file = temporaryFile()
    const warnings: string[] = []
    writeFileSync(file, '{ this is not json', 'utf8')
    const store = createAiChatAuthorization({ file, warn: message => warnings.push(message) })
    expect(await store.isGranted('alice', 'my-notes')).toBe(false)
    expect(warnings.join('\n')).toMatch(/not a version 1 record/u)
  })

  it('并发 grant 不互相覆盖（读-改-写串行化）', async () => {
    const file = temporaryFile()
    const store = createAiChatAuthorization({ file })
    await Promise.all([
      store.grant('alice', 'a'),
      store.grant('alice', 'b'),
      store.grant('bob', 'a'),
      store.grant('bob', 'b'),
    ])
    expect(await store.isGranted('alice', 'a')).toBe(true)
    expect(await store.isGranted('alice', 'b')).toBe(true)
    expect(await store.isGranted('bob', 'a')).toBe(true)
    expect(await store.isGranted('bob', 'b')).toBe(true)
  })

  it('没有文件路径 ⇒ 只在内存（同实例有效、新实例 Forget）', async () => {
    const store = createAiChatAuthorization({})
    await store.grant('alice', 'my-notes')
    expect(await store.isGranted('alice', 'my-notes')).toBe(true)
    expect(await createAiChatAuthorization({}).isGranted('alice', 'my-notes')).toBe(false)
  })

  it('写失败 ⇒ 抛错（不静默）', async () => {
    // 目标是一个**目录**：rename 到已存在的目录必失败。
    const dir = mkdtempSync(join(tmpdir(), 'pico-app-ai-consent-dir-'))
    homes.push(dir)
    const store = createAiChatAuthorization({ file: dir })
    await expect(store.grant('alice', 'my-notes')).rejects.toBeDefined()
  })
})
