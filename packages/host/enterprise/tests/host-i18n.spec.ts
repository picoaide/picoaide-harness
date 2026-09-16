/**
 * 宿主侧用户可见文案的双语回归（2026-09-16 i18n）。
 *
 * 覆盖三类**用户可见**的宿主文案（此前只有中文）：
 *   1. `manifest-precheck.ts` 的 23 条预检问题 —— `packSkill()` 抛出的消息经
 *      `auth-gate.ts` 的 `{ error: message }` 回到能力中心面板
 *      (`t('capability.failed', { error })`)；
 *   2. `skill-install.ts` 的「缺少 version」与「（另有 N 项问题）」；
 *   3. `server-connector/auth.ts` 的认证失败文案（登录页直接渲染 AuthError.message）
 *      与 `fetchJSON` 的 NOT_JSON / UPSTREAM。
 *
 * 语言由调用方**按请求**解析后传入（`hostLocaleFrom`）；缺省中文 = 历史行为，
 * 所以这里同时钉住"不传语言时仍是原来的中文"（服务端文案与既有调用方不变）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { precheckSkillPackage, PrecheckCode } from '../src/manifest-precheck.ts'
import { packSkill } from '../src/skill-install.ts'
import { archiveTooLargeError } from '../src/auth-gate.ts'
import { ApiError, AuthError, authErrorMessage, fetchJSON, login } from '../src/server-connector/auth.ts'

const BODY = '本技能用于单元测试:正文需要足够长才能通过空壳校验,因此这里补充两句完整的说明文字,确保长度稳稳超过下限要求。'
const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/u

/** 合规技能包（与 tests/manifest-precheck.spec.ts 同款夹具）。 */
function skillMd(over: Record<string, string> = {}, omit: string[] = []): string {
  const fields: Record<string, string> = {
    name: 'demo-skill', title: '演示技能', version: '1.2.0',
    description: '用于单元测试的技能描述,长度满足下限。', author: 'tester', category: '测试', ...over,
  }
  for (const k of omit) delete fields[k]
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')
  return `---\n${lines}\n---\n\n${BODY}\n`
}

afterEach(() => { vi.unstubAllGlobals() })

describe('manifest-precheck 预检文案（能力中心面板可见）', () => {
  it('缺省不传语言 → 中文原文逐字不变（历史行为）', () => {
    const issues = precheckSkillPackage(skillMd({}, ['title']), 'demo-skill')
    const hit = issues.find((i) => i.field === 'title')
    expect(hit?.code).toBe(PrecheckCode.MissingField)
    expect(hit?.message).toBe('缺少必填字段 title')
    expect(precheckSkillPackage(`\ufeff${skillMd()}`, 'demo-skill', [], 'zh')[0]?.message)
      .toBe('SKILL.md 含 UTF-8 BOM,会导致技能被运行时忽略;请另存为「UTF-8 无 BOM」')
    expect(precheckSkillPackage(skillMd(), 'demo-skill', [], 'zh')[0]).toBeUndefined()
  })

  it('zh 的插值文案逐字保留（占位符改成 {n}/{field} 后渲染结果不变）', () => {
    const long = precheckSkillPackage(skillMd({ title: 'x'.repeat(101) }), 'demo-skill', [], 'zh')
    expect(long.find((i) => i.field === 'title')?.message).toBe('字段 title 超长(上限 100 字)')
    const badName = precheckSkillPackage(skillMd({ name: 'My-Skill' }), 'My-Skill', [], 'zh')
    expect(badName[0]?.message).toBe('技能名 "My-Skill" 不合法:必须是小写 kebab-case(如 my-skill)')
    const mismatch = precheckSkillPackage(skillMd({ name: 'other-skill' }), 'demo-skill', [], 'zh')
    expect(mismatch[0]?.message)
      .toBe('SKILL.md 的 name("other-skill")必须等于应用 ID("demo-skill");中文展示名请写在 title')
    const short = precheckSkillPackage(`---\nname: demo-skill\ntitle: 演示\nversion: 1.0.0\ndescription: 描述足够长可以通过。\nauthor: t\ncategory: c\n---\n\n短\n`, 'demo-skill', [], 'zh')
    expect(short.find((i) => i.code === PrecheckCode.BodyEmpty)?.message)
      .toBe('技能正文过短(至少 50 字):只有 frontmatter 的空壳技能对模型没有价值')
    const tags = precheckSkillPackage(skillMd({ tags: 'not-an-array' }), 'demo-skill', [], 'zh')
    expect(tags.some((i) => i.message === '字段 tags 必须是数组')).toBe(true)
  })

  it('en → 全英文（且没有任何中文），错误码仍是服务端同款', () => {
    const cases: Array<[ReturnType<typeof precheckSkillPackage>, string]> = [
      [precheckSkillPackage(skillMd({}, ['title']), 'demo-skill', [], 'en'), PrecheckCode.MissingField],
      [precheckSkillPackage(`\ufeff${skillMd()}`, 'demo-skill', [], 'en'), PrecheckCode.BomDetected],
      [precheckSkillPackage('no frontmatter', 'demo-skill', [], 'en'), PrecheckCode.FrontmatterInvalid],
      [precheckSkillPackage(skillMd({ name: 'My-Skill' }), 'My-Skill', [], 'en'), PrecheckCode.InvalidAppID],
      [precheckSkillPackage(skillMd({ name: 'other-skill' }), 'demo-skill', [], 'en'), PrecheckCode.IdentityMismatch],
      [precheckSkillPackage(skillMd({ version: '"1.0"' }), 'demo-skill', [], 'en'), PrecheckCode.InvalidVersion],
      [precheckSkillPackage(skillMd({ title: 'x'.repeat(101) }), 'demo-skill', [], 'en'), PrecheckCode.FieldTooLong],
      [precheckSkillPackage(skillMd(), 'demo-skill', ['.picoaide/release.json'], 'en'), PrecheckCode.ProvenanceForbidden],
    ]
    for (const [issues, code] of cases) {
      const hit = issues.find((i) => i.code === code)
      expect(hit, `code ${code} must be reported`).toBeDefined()
      expect(hit!.message, `${code} 的英文文案不应含中文: ${hit!.message}`).not.toMatch(CJK)
      expect(hit!.message.length).toBeGreaterThan(0)
    }
    // 抽查译文质量（不是占位符泄漏、也不是原样中文）。
    expect(precheckSkillPackage(skillMd({}, ['author']), 'demo-skill', [], 'en')
      .find((i) => i.field === 'author')?.message).toBe('Missing required field author')
    expect(precheckSkillPackage(`\ufeff${skillMd()}`, 'demo-skill', [], 'en')[0]?.message)
      .toContain('UTF-8 BOM')
    expect(precheckSkillPackage(skillMd({ description: 'short' }), 'demo-skill', [], 'en')
      .find((i) => i.code === PrecheckCode.FieldTooShort)?.message)
      .toBe('description is too short (at least 10 characters); it decides when the model loads this skill')
    const legacy = precheckSkillPackage(skillMd({ userInvocable: 'true' }), 'demo-skill', [], 'en')
      .find((i) => i.code === PrecheckCode.InvocationInvalid)
    expect(legacy?.message).toBe('frontmatter field userInvocable is deprecated; use user-invocable instead (keeping the old key makes the runtime ignore the skill)')
    expect(precheckSkillPackage(skillMd({}, ['category']), 'demo-skill', [], 'en')
      .find((i) => i.field === 'category')?.message).toBe('Missing required field category')
  })
})

describe('skill-install 的用户可见消息', () => {
  const noVersionMd = '---\nname: demo-skill\ntitle: demo\ndescription: 用于单测的技能包描述,需满足最短长度。\nauthor: tester\ncategory: 测试\n---\n\n本技能用于单元测试:正文需要足够长才能通过空壳校验,因此这里补充两句完整的说明文字,确保长度稳稳超过五十字的下限要求。\n'

  it('缺 version：zh 逐字保留 / en 全英文', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-pack-i18n-'))
    try {
      await mkdir(join(root, 'demo-skill'), { recursive: true })
      await writeFile(join(root, 'demo-skill', 'SKILL.md'), noVersionMd)
      await expect(packSkill(root, 'demo-skill')).rejects.toThrow('技能 "demo-skill" 的 SKILL.md 缺少 version 字段:请写明版本号(如 version: 1.0.0)后再上传')
      const en = await packSkill(root, 'demo-skill', undefined, 'en').then(() => null, (e: Error) => e.message)
      expect(en).toBe('Skill "demo-skill" has no version field in SKILL.md: add a version (for example version: 1.0.0) and upload again')
      expect(en).not.toMatch(CJK)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('多条问题时：「（另有 N 项问题）」有英文对照', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-pack-i18n-'))
    try {
      await mkdir(join(root, 'demo-skill'), { recursive: true })
      // 缺 title + 缺 author + 缺 category → 至少 3 项问题。
      await writeFile(join(root, 'demo-skill', 'SKILL.md'),
        `---\nname: demo-skill\nversion: 1.2.0\ndescription: 用于单测的技能包描述,需满足最短长度。\n---\n\n${BODY}\n`)
      const zh = await packSkill(root, 'demo-skill').then(() => null, (e: Error) => e.message)
      expect(zh).toMatch(/（另有 \d+ 项问题）$/u)
      const en = await packSkill(root, 'demo-skill', undefined, 'en').then(() => null, (e: Error) => e.message)
      expect(en).toMatch(/ \(\d+ more issues\)$/u)
      expect(en).not.toMatch(CJK)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('auth-gate 归档超限文案（上传/安装路径可见）', () => {
  it('zh 逐字保留（全角括号与上限值都不动）', () => {
    // 逐字取自改造前：`归档过大（超过 16MB）`（MAX_ARCHIVE_BYTES = 16MiB）。
    expect(archiveTooLargeError('zh')).toBe('归档过大（超过 16MB）')
  })

  it('en 全英文且带上限值', () => {
    const en = archiveTooLargeError('en')
    expect(en).toBe('Archive too large (over 16MB)')
    expect(en).not.toMatch(CJK)
  })
})

describe('server-connector/auth 的认证文案（登录页可见）', () => {
  it('authErrorMessage：缺省中文，en 全英文', () => {
    expect(authErrorMessage('invalid_credentials')).toBe('账号或密码错误')
    expect(authErrorMessage('auth_expired')).toBe('登录已过期，请重新登录')
    expect(authErrorMessage('network')).toBe('网络错误，请检查网络连接')
    expect(authErrorMessage('server_error')).toBe('服务端错误，请稍后重试')
    for (const kind of ['invalid_credentials', 'auth_expired', 'network', 'server_error'] as const) {
      const en = authErrorMessage(kind, 'en')
      expect(en, `${kind} 的英文文案不应含中文`).not.toMatch(CJK)
      expect(en.length).toBeGreaterThan(0)
    }
    expect(authErrorMessage('invalid_credentials', 'en')).toBe('Incorrect username or password')
  })

  it('login 401：按语言抛出的消息不同（登录页直接渲染它）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401, json: async () => ({ error: { code: 'AUTH_FAILED' } }),
    }))
    await expect(login('https://gw.example', 'alice', 'pw', 'zh')).rejects.toThrow('账号或密码错误')
    await expect(login('https://gw.example', 'alice', 'pw', 'en')).rejects.toThrow('Incorrect username or password')
    // AuthError 的分类不变（auth-gate 按 kind 决定 401/502）。
    const err = await login('https://gw.example', 'alice', 'pw', 'en').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AuthError)
    expect((err as AuthError).kind).toBe('invalid_credentials')
  })

  it('login 审计账号拒绝：按语言给出提示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401, json: async () => ({ error: { code: 'AUDITOR_NOT_ALLOWED' } }),
    }))
    await expect(login('https://gw.example', 'auditor', 'pw', 'zh'))
      .rejects.toThrow('审计账号不可登录客户端,请使用管理后台')
    await expect(login('https://gw.example', 'auditor', 'pw', 'en'))
      .rejects.toThrow('Audit accounts cannot sign in to the desktop client. Please use the admin console.')
  })

  it('fetchJSON 的 NOT_JSON / UPSTREAM：缺省中文，en 全英文', async () => {
    const html = () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, status: 200,
        headers: { get: () => 'text/html; charset=utf-8' },
        json: async () => { throw new Error('not json') },
      }))
    }
    html()
    await expect(fetchJSON('https://gw.example', '/x')).rejects.toThrow('服务端返回了 HTML 页面而非 JSON,请确认地址指向 API 服务根,而非门户/SPA 页面')
    html()
    const en = await fetchJSON('https://gw.example', '/x', { locale: 'en' }).catch((e: unknown) => e)
    expect(en).toBeInstanceOf(ApiError)
    expect((en as ApiError).code).toBe('NOT_JSON')
    expect((en as ApiError).message).not.toMatch(CJK)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => { throw new Error('not json') },
    }))
    await expect(fetchJSON('https://gw.example', '/x')).rejects.toThrow('网关响应不是合法 JSON')
    const upstream = await fetchJSON('https://gw.example', '/x', { locale: 'en' }).catch((e: unknown) => e)
    expect((upstream as ApiError).code).toBe('UPSTREAM')
    expect((upstream as ApiError).message).toBe('The gateway response is not valid JSON')
  })
})
