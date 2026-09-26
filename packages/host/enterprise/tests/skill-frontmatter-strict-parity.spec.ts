/**
 * tests/skill-frontmatter-strict-parity.spec.ts — R21-A1-01 的仓内回归判据。
 *
 * ## 缺陷原形态（第二十一轮审计 A1，P1）
 *
 * 安装器与发布预检此前用**宽松**切分 frontmatter（`indexOf('\n---')`），而 pinned
 * 上游运行时要求收尾行**恰为**整行 `---`（`skill-filesystem/src/index.ts` 的
 * `findClosingFrontmatter`）。于是 SKILL.md 的结束行写成 `--- `（尾随空格）时：
 *
 *   客户端预检 **0 问题** → 服务端放行 → 安装 200 + `ok:true`、文件落盘
 *   → **上游不加载**（模型看不到）→ 企业侧 `listInstalledSkills`（严格判据）
 *   **也列不出** ⇒ 面板永远显示"未安装"，用户反复点安装每次都被回成功，零报错。
 *
 * ## 这份用例怎么判（三条互不替代的证据）
 *
 *  1. **预检面 / 安装面 / 发现面三处同一性**：同一条 SKILL.md 在
 *     `precheckSkillPackage`（拒收）、`assertLoadableSkillMetadata`（拒收）、
 *     `discoverRuntimeSkills` / `listInstalledSkills`（列不出）三处结论必须一致；
 *  2. **真跑 pinned 上游注册表**（`listRuntimeSkills`，走 `@deepseek-ai/dsh-skill-filesystem`
 *     自己的发现器，不是复述我们的规则）：`--- ` 形态**不加载**、`---` 形态**加载**；
 *  3. **读上游源码**的判据：`findClosingFrontmatter` 的收尾比较必须是整行相等
 *     （`=== '---'`）且不得出现 `includes/startsWith` 这类宽松形态 —— 上游若哪天放宽，
 *     本用例变红并逼我们重新对拍。
 *
 * 三处实现同一性由源码读法钉住：`skill-install.ts`（安装面 + 发现面）必须调
 * `readSkillFrontmatterStrict`，`manifest-precheck.ts`（预检面）必须调
 * `splitSkillFrontmatter`，两份都在 `skill-frontmatter.ts`（唯一实现）。
 *
 * ## 变异验证（拆掉修复必红）
 *
 *  - 把 `assertLoadableSkillMetadata` 换回 `readSkillFrontmatter`（宽松）⇒ 第 1、2 组红
 *    （安装成功 + 上游注册表为空 + 发现面列不出）；
 *  - 把 `skill-frontmatter.ts` 的 `!== FRONTMATTER_FENCE` 改成 `startsWith('---')` ⇒
 *    第 1、2、3 组一起红；
 *  - 让 `precheckSkillPackage` 换回 `rest.indexOf('\n---')` ⇒ 第 1 组红。
 */
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PrecheckCode, precheckSkillPackage } from '../src/manifest-precheck.ts'
import { splitSkillFrontmatter } from '../src/skill-frontmatter.ts'
import {
  ArchiveInstallRefusal,
  assertLoadableSkillMetadata,
  discoverRuntimeSkills,
  installSkillArchive,
  listInstalledSkills,
} from '../src/skill-install.ts'
import { isolateRuntimeSkillRoots } from './helpers/runtime-skill-roots.ts'
import { listRuntimeSkills, UPSTREAM_SKILL_FILESYSTEM_SOURCE } from './helpers/upstream-skill-registry.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

/** 读被测源码；读不到即 throw（判据失去输入必须红，不许静默跳过）。 */
function readSrc(file: string): string {
  try {
    return readFileSync(join(SRC, file), 'utf8')
  } catch (cause) {
    throw new Error(`读不到被测源码 ${file}（${cause instanceof Error ? cause.message : String(cause)}）—— 本用例不允许 skip`)
  }
}

/** 切出上游某个顶层函数的函数体；找不到即 throw（上游改名/重构了要重新对拍）。 */
function upstreamFunctionBody(text: string, name: string, where: string): string {
  const start = text.indexOf(`function ${name}`)
  if (start < 0) throw new Error(`上游实现里找不到 ${name}（${where}）：上游改名/重构了，请重新对拍 frontmatter 判据`)
  const rest = text.slice(start + `function ${name}`.length)
  const next = rest.indexOf('\nfunction ')
  return next < 0 ? rest : rest.slice(0, next)
}

/** 一份**字段齐全**（能过全部其它预检规则）的 SKILL.md，只有收尾分隔行可变。 */
function skillMd(closingLine: string): string {
  return [
    '---',
    'name: alpha',
    'title: Alpha 示例技能',
    'version: 1.0.0',
    'description: 用于 frontmatter 分隔符判据的示例技能,描述长度足以通过发布前预检。',
    'author: tester',
    'category: security',
    closingLine,
    '本技能只用于自动化回归测试,不会执行任何静态分析任务;正文刻意写长以通过发布前预检的',
    '正文长度下限要求,内容本身没有任何实际用途,仅用于验证分隔符判据与运行时一致。',
    '',
  ].join('\n')
}

/** 把一份 SKILL.md 打成技能归档（归档根即技能目录）。 */
function archiveOf(md: string): Buffer {
  const zip = new AdmZip()
  zip.addFile('SKILL.md', Buffer.from(md, 'utf8'), '', 0o644)
  return zip.toBuffer()
}

/** 需要收尾行**不是**整行 `---` 的三种常见作者笔误（宽松切分全都放行）。 */
const LOOSE_CLOSINGS: ReadonlyArray<readonly [label: string, line: string]> = [
  ['尾随空格', '--- '],
  ['尾随制表符', '---\t'],
  ['尾随其它字符', '---x'],
]

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

describe('R21-A1-01 严格分隔符：预检 / 安装 / 发现三面同判据', () => {
  for (const [label, closing] of LOOSE_CLOSINGS) {
    it(`结束行是 ${JSON.stringify(closing)}（${label}）时：预检拒收 + 安装拒收 + 发现面列不出 + 上游不加载`, async () => {
      const md = skillMd(closing)

      // ① 预检面：旧实现返回 0 问题（≡ 包能被上传到市场）。
      const issues = precheckSkillPackage(md, 'alpha')
      expect(issues.map(issue => issue.code), '宽松分隔符必须被预检拒收').toContain(PrecheckCode.FrontmatterInvalid)

      // ② 发现面：运行时与企业侧都列不出（同一份严格元数据读取）。
      const home = await freshHome('r21a1-strict-')
      const skillsDir = join(home, 'skills')
      await mkdir(join(skillsDir, 'alpha'), { recursive: true })
      await writeFile(join(skillsDir, 'alpha', 'SKILL.md'), md, 'utf8')
      expect(await listInstalledSkills(skillsDir), '企业侧不得把它列成"已安装"').toEqual([])
      expect(await discoverRuntimeSkills(skillsDir)).toEqual([])
      expect((await listRuntimeSkills(skillsDir)).map(skill => skill.name), 'pinned 上游注册表必须为空').toEqual([])

      // ③ 安装面（第三关）：目录里已经是这份 SKILL.md 时必须拒收。
      const refusal = await assertLoadableSkillMetadata(join(skillsDir, 'alpha'), 'alpha').catch((cause: unknown) => cause)
      expect(refusal, '安装器必须拒收这份 SKILL.md').toBeInstanceOf(ArchiveInstallRefusal)
      expect((refusal as ArchiveInstallRefusal).code).toBe('FRONTMATTER_INVALID')
    })
  }

  it('端到端：宽松分隔符的归档**装不上**（旧实现返回成功 + ok:true，而运行时零加载）', async () => {
    const home = await freshHome('r21a1-e2e-')
    const skillsDir = join(home, 'skills')
    await mkdir(skillsDir, { recursive: true })
    const cause = await installSkillArchive({
      name: 'alpha',
      archive: archiveOf(skillMd('--- ')),
      skillsDir,
      channel: 'market',
    }).then(() => undefined, (error: unknown) => error)
    expect(cause, '严重形态：装得上、永不加载 ⇒ 安装必须被拒').toBeInstanceOf(ArchiveInstallRefusal)
    expect(await listInstalledSkills(skillsDir)).toEqual([])
    expect((await listRuntimeSkills(skillsDir)).map(skill => skill.name)).toEqual([])
  })

  it('对照（正向）：结束行恰为 --- 时预检 0 问题、安装成功、上游运行时真的加载它', async () => {
    const home = await freshHome('r21a1-ok-')
    const skillsDir = join(home, 'skills')
    await mkdir(skillsDir, { recursive: true })
    expect(precheckSkillPackage(skillMd('---'), 'alpha')).toEqual([])
    await installSkillArchive({ name: 'alpha', archive: archiveOf(skillMd('---')), skillsDir, channel: 'market' })
    expect(await listInstalledSkills(skillsDir)).toEqual(['alpha'])
    expect((await listRuntimeSkills(skillsDir)).map(skill => skill.name), '同一份内容上游必须加载').toEqual(['alpha'])
  })

  it('边界：CRLF 文件的整行分隔符照旧放行（只允许一个 \\r，与上游同判据）', () => {
    const crlf = skillMd('---').replace(/\n/gu, '\r\n')
    expect(splitSkillFrontmatter(crlf), 'CRLF 是两个平台都合法的形态').toBeDefined()
    const loose = `${skillMd('---').replace(/\n/gu, '\r\n').replace(/\r\n---\r\n/u, '\r\n--- \r\n')}`
    expect(splitSkillFrontmatter(loose), 'CRLF 下尾随空格同样不是收尾行').toBeUndefined()
  })
})

describe('R21-A1-01 判据来源：读上游源码 + 三处实现同一性（防"各钉自己的字面量"）', () => {
  it('pinned 上游的收尾判定是**整行相等**，不是包含/前缀匹配', () => {
    const upstream = readFileSync(UPSTREAM_SKILL_FILESYSTEM_SOURCE, 'utf8')
    const closing = upstreamFunctionBody(upstream, 'findClosingFrontmatter', UPSTREAM_SKILL_FILESYSTEM_SOURCE)
    expect(closing, '上游必须逐行与字面量 --- 比较').toContain("=== '---'")
    expect(closing, '上游不得退化成"包含 --- 即可"').not.toMatch(/includes\(|startsWith\(/u)
    const parse = upstreamFunctionBody(upstream, 'parseFrontmatter', UPSTREAM_SKILL_FILESYSTEM_SOURCE)
    expect(parse, '首行同样是整行相等').toContain("!== '---'")
  })

  it('三处执行点共用同一份实现（安装面/发现面 = readSkillFrontmatterStrict，预检面 = splitSkillFrontmatter）', () => {
    const shared = readSrc('skill-frontmatter.ts')
    // 唯一实现自己必须逐字与字面量比较（改宽松 ⇒ 上面两组行为用例会红，这里先钉住形状）。
    expect(shared).toContain('FRONTMATTER_FENCE')
    expect(shared).toContain("const FRONTMATTER_FENCE = '---'")
    expect(shared).toMatch(/!== FRONTMATTER_FENCE/u)

    const installSrc = readSrc('skill-install.ts')
    // 两个**具体**执行点各一行：发现面的元数据读取（readRuntimeSkillMetadata）与
    // 安装面的第三关（assertLoadableSkillMetadata）。只数字符串出现次数会漏掉
    // "其中一个换回宽松解析器"的形态，所以逐点断言。
    expect(installSrc, '发现面必须走严格读取').toContain('const meta = await readSkillFrontmatterStrict(skillMdPath)')
    expect(installSrc, '安装面（可加载性第三关）必须走严格读取')
      .toContain("const meta = await readSkillFrontmatterStrict(join(dir, 'SKILL.md'))")
    expect(installSrc, '安装器的可加载性第三关不得再用宽松解析器').not.toMatch(/assertLoadableSkillMetadata[\s\S]{0,400}readSkillFrontmatter\(/u)

    const precheckSrc = readSrc('manifest-precheck.ts')
    expect(precheckSrc, '预检面必须走同一份切分实现').toContain('splitSkillFrontmatter(normalized)')
    // 旧实现的**语句**形态（注释里提到它不算，只钉代码）。
    expect(precheckSrc, "预检面不得再用 rest.indexOf('\\n---') 宽松切分").not.toContain("const end = rest.indexOf('\\n---')")
  })
})
