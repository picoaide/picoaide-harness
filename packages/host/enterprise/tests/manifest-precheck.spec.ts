import { describe, expect, it } from 'vitest'
import { isAppId, isVersion, precheckSkillPackage, PrecheckCode } from '../src/manifest-precheck.ts'

const BODY = '本技能用于单元测试:正文需要足够长才能通过空壳校验,因此这里补充两句完整的说明文字,确保长度稳稳超过下限要求。'

const md = (over: Record<string, string> = {}, omit: string[] = []): string => {
  const fields: Record<string, string> = {
    name: 'demo-skill', title: '演示技能', version: '1.2.0',
    description: '用于单元测试的技能描述,长度满足下限。', author: 'tester', category: '测试', ...over,
  }
  for (const k of omit) delete fields[k]
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')
  return `---\n${lines}\n---\n\n${BODY}\n`
}

describe('precheckSkillPackage（与服务端同码）', () => {
  it('合规包无问题', () => {
    expect(precheckSkillPackage(md(), 'demo-skill')).toEqual([])
  })

  it('必填字段矩阵:逐个缺失都报 MISSING_FIELD 并指明字段', () => {
    for (const field of ['name', 'title', 'version', 'description', 'author', 'category']) {
      const issues = precheckSkillPackage(md({}, [field]), 'demo-skill')
      const hit = issues.find((i) => i.field === field)
      expect(hit?.code, `字段 ${field}`).toBe(PrecheckCode.MissingField)
    }
  })

  it('非 kebab 命名被拒（与上游运行时同规则）', () => {
    for (const name of ['My-Skill', 'my.skill', 'my_skill', 'my--skill', 'my-skill-', '中文名']) {
      const issues = precheckSkillPackage(md({ name }), name)
      expect(issues.some((i) => i.code === PrecheckCode.InvalidAppID), name).toBe(true)
    }
  })

  it('包内 name 与目标应用 ID 不一致 → IDENTITY_MISMATCH', () => {
    const issues = precheckSkillPackage(md({ name: 'other-skill' }), 'demo-skill')
    expect(issues[0]?.code).toBe(PrecheckCode.IdentityMismatch)
  })

  it('版本文法与 BOM', () => {
    for (const v of ['v1', 'abc', '1.0', '1']) {
      const issues = precheckSkillPackage(md({ version: `"${v}"` }), 'demo-skill')
      expect(issues.some((i) => i.code === PrecheckCode.InvalidVersion), v).toBe(true)
    }
    expect(precheckSkillPackage(`\ufeff${md()}`, 'demo-skill')[0]?.code).toBe(PrecheckCode.BomDetected)
  })

  it('空壳正文与自带溯源块被拒', () => {
    const shell = `---\nname: demo-skill\ntitle: 演示\nversion: 1.0.0\ndescription: 描述足够长可以通过。\nauthor: t\ncategory: c\n---\n\n短\n`
    expect(precheckSkillPackage(shell, 'demo-skill').some((i) => i.code === PrecheckCode.BodyEmpty)).toBe(true)
    const forged = md().replace('---\n\n', 'metadata:\n  picoaide:\n    app_id: forged\n---\n\n')
    expect(precheckSkillPackage(forged, 'demo-skill').some((i) => i.code === PrecheckCode.ProvenanceForbidden)).toBe(true)
    expect(precheckSkillPackage(md(), 'demo-skill', ['SKILL.md', '.picoaide/release.json'])
      .some((i) => i.code === PrecheckCode.ProvenanceForbidden)).toBe(true)
  })

  it('旧 camelCase 调用策略键与非布尔值被拒', () => {
    expect(precheckSkillPackage(md({ userInvocable: 'true' }), 'demo-skill')
      .some((i) => i.code === PrecheckCode.InvocationInvalid)).toBe(true)
    expect(precheckSkillPackage(md({ 'user-invocable': 'maybe' }), 'demo-skill')
      .some((i) => i.code === PrecheckCode.InvocationInvalid)).toBe(true)
    expect(precheckSkillPackage(md({ 'user-invocable': 'no' }), 'demo-skill')).toEqual([])
  })

  it('文法助手与服务端同规则', () => {
    expect(isAppId('dws')).toBe(true)
    expect(isAppId('a')).toBe(false)
    expect(isVersion('2.0.0-rc.1')).toBe(true)
    expect(isVersion('1.0')).toBe(false)
  })
})
