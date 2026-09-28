/**
 * tests/skill-legacy-invocation-install.spec.ts — R21-A1-02 的仓内回归判据。
 *
 * ## 缺陷原形态
 *
 * 上游 `parseInvocationPolicy` 的第一件事是 `rejectLegacyInvocationKey`：frontmatter
 * 里出现 `disableModelInvocation` / `modelInvocable` / `userInvocable` 任一旧键即
 * **throw** ⇒ `parseSkillFile` 把**整份技能**丢弃（只 warn）。发布预检
 * （`manifest-precheck.ts` 的 `LEGACY_INVOCATION` 循环）与服务端
 * （`skillmanifest/manifest.go`）都拦，**只有安装器的"可加载性第三关"漏了** ⇒
 * 装成功、企业侧列出"已安装"、模型永远用不到，且零报错。
 *
 * ## 判据
 *
 *  1. 安装面：`assertLoadableSkillMetadata` 必须拒（`FRONTMATTER_INVALID`），端到端
 *     `installSkillArchive` 也必须拒；
 *  2. 对照：同一份内容上游注册表确实**不加载**（证明"装上了也没用"这条因果成立，
 *     而不是我们的一厢情愿）；
 *  3. 键集合的对拍：从 pinned 上游源码的 `parseInvocationPolicy` 函数体里**派生**
 *     `rejectLegacyInvocationKey` 的三对 (legacy, canonical)，断言与
 *     `LEGACY_INVOCATION`（预检面与安装面共用的唯一真源）逐项相等 —— 上游增删键或
 *     改名 ⇒ 用例红（"各钉自己的字面量"是本仓登记在案的死法）。
 *
 * ## 变异验证
 *
 *  - 删掉 `assertLoadableSkillMetadata` 里的 `LEGACY_INVOCATION` 循环 ⇒ 第 1 组红；
 *  - 从 `LEGACY_INVOCATION` 里去掉 `modelInvocable` ⇒ 第 3 组红（且第 1 组的
 *    `modelInvocable` 用例红）。
 */
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LEGACY_INVOCATION, PrecheckCode, precheckSkillPackage } from '../src/manifest-precheck.ts'
import { ArchiveInstallRefusal, assertLoadableSkillMetadata, installSkillArchive, listInstalledSkills } from '../src/skill-install.ts'
import { isolateRuntimeSkillRoots } from './helpers/runtime-skill-roots.ts'
import { listRuntimeSkills, UPSTREAM_SKILL_FILESYSTEM_SOURCE } from './helpers/upstream-skill-registry.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 一份字段齐全的 SKILL.md；`extra` 是要插入 frontmatter 的那一行（旧调用键）。 */
function skillMd(name: string, extra: string): string {
  return [
    '---',
    `name: ${name}`,
    'title: Legacy 示例技能',
    'version: 1.0.0',
    'description: 用于旧调用键判据的示例技能,描述长度足以通过发布前预检。',
    'author: tester',
    'category: security',
    extra,
    '---',
    '本技能只用于自动化回归测试,不会执行任何静态分析任务;正文刻意写长以通过发布前预检的',
    '正文长度下限要求,内容本身没有任何实际用途,仅用于验证旧调用键在安装面也被拒。',
    '',
  ].join('\n')
}

function archiveOf(md: string): Buffer {
  const zip = new AdmZip()
  zip.addFile('SKILL.md', Buffer.from(md, 'utf8'), '', 0o644)
  return zip.toBuffer()
}

const dirs: string[] = []

async function freshHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(home)
  return home
}

beforeEach(isolateRuntimeSkillRoots)

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('R21-A1-02 旧调用键：安装面必须与预检面/上游同判据（装得上、加载不到 = 拒绝）', () => {
  for (const [legacy, canonical] of Object.entries(LEGACY_INVOCATION)) {
    it(`frontmatter 带 ${legacy} 时：上游丢弃整份技能、安装器必须拒（不许"已安装"）`, async () => {
      const md = skillMd('legacy', `${legacy}: false`)
      const home = await freshHome('r21a1-legacy-')
      const skillsDir = join(home, 'skills')
      const dir = join(skillsDir, 'legacy')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'SKILL.md'), md, 'utf8')

      // 因果前提：上游确实不加载它（否则这条判据没有意义）。
      expect((await listRuntimeSkills(skillsDir)).map(skill => skill.name), `${legacy} 会让上游丢弃整份技能`).toEqual([])

      // 预检面：本来就有这条（对照组，证明语料本身能触发该规则）。
      expect(precheckSkillPackage(md, 'legacy').map(issue => issue.code)).toContain(PrecheckCode.InvocationInvalid)

      // 安装面（缺陷所在）：必须拒收。
      const refusal = await assertLoadableSkillMetadata(dir, 'legacy').catch((cause: unknown) => cause)
      expect(refusal, `${legacy} 必须被安装器拒收`).toBeInstanceOf(ArchiveInstallRefusal)
      expect((refusal as ArchiveInstallRefusal).code).toBe('FRONTMATTER_INVALID')
      expect((refusal as ArchiveInstallRefusal).message).toContain(canonical)
    })
  }

  it('端到端：带旧调用键的归档**装不上**（旧实现装成功、企业侧列出"已安装"而模型用不到）', async () => {
    const home = await freshHome('r21a1-legacy-e2e-')
    const skillsDir = join(home, 'skills')
    await mkdir(skillsDir, { recursive: true })
    const cause = await installSkillArchive({
      name: 'legacy',
      archive: archiveOf(skillMd('legacy', 'modelInvocable: false')),
      skillsDir,
      channel: 'market',
    }).then(() => undefined, (error: unknown) => error)
    expect(cause).toBeInstanceOf(ArchiveInstallRefusal)
    expect(await listInstalledSkills(skillsDir)).toEqual([])
  })

  it('对照（正向）：两个官方键的合法取值照常装得上，且上游加载它', async () => {
    const home = await freshHome('r21a1-legacy-ok-')
    const skillsDir = join(home, 'skills')
    await mkdir(skillsDir, { recursive: true })
    const md = skillMd('legacy', 'disable-model-invocation: false\nuser-invocable: true')
    expect(precheckSkillPackage(md, 'legacy')).toEqual([])
    await installSkillArchive({ name: 'legacy', archive: archiveOf(md), skillsDir, channel: 'market' })
    expect((await listRuntimeSkills(skillsDir)).map(skill => skill.name)).toEqual(['legacy'])
  })

  it('键集合从 pinned 上游源码派生并逐项相等（上游增删/改名 ⇒ 红）', () => {
    const upstream = readFileSync(UPSTREAM_SKILL_FILESYSTEM_SOURCE, 'utf8')
    const start = upstream.indexOf('function parseInvocationPolicy')
    if (start < 0) throw new Error('上游实现里找不到 parseInvocationPolicy：上游改名/重构了，请重新对拍旧调用键清单')
    const rest = upstream.slice(start)
    const next = rest.indexOf('\nfunction ')
    const body = next < 0 ? rest : rest.slice(0, next)
    const pairs = [...body.matchAll(/rejectLegacyInvocationKey\([^,]+,\s*'([^']+)',\s*'([^']+)'\)/gu)]
      .map(match => [match[1]!, match[2]!] as const)
    expect(pairs.length, '上游必须仍有三条旧键拒绝（找不到即解析失败 ⇒ 红）').toBe(3)
    expect(Object.fromEntries(pairs), 'LEGACY_INVOCATION 必须与上游逐项一致').toEqual(LEGACY_INVOCATION)
  })
})
