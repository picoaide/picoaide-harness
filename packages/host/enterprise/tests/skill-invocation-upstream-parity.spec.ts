/**
 * R13-B P1-1 的结构性收口：invocation 布尔取值语料的**三方对拍**。
 *
 * 缺陷形态：`SKILL.md` 写 `user-invocable:`（YAML 空值）/`null`/`~` 时，客户端预检
 * 与服务端校验都把 `null` 当成「没声明」放过，安装器只复核 name/description ——
 * 三关全绿、上传 201、审核通过、装得上、能力中心显示「已安装」；而 pinned 上游
 * `frontmatterBoolean` 对它**直接 throw**，调用方 catch 后把**整份技能丢弃**
 * ⇒ 模型永远看不到，全链路零报错。
 *
 * 本项目登记在案的死法之一是「**两端各钉自己的字面量集合**」，所以这份用例：
 *   ① 从 **pinned 上游的真实实现**（submodule 源码，或运行时真正加载的
 *      `dsh-skill-filesystem/lib/index.js`）里**派生**合法取值集合；
 *   ② 断言「上游派生集合 == 客户端 `INVOCATION_BOOLEAN_LITERALS` == 服务端
 *      `manifest.go` 的 `booleanLiterals`」三方逐项相等（服务端那份也从源码抽，
 *      不从本文件复述）；
 *   ③ 用冻结件 `server/internal/skillmanifest/testdata/upstream-invocation-boolean.json`
 *      的取值语料**真跑 pinned 上游注册表**得到"上游是否加载"的判据，再断言
 *      客户端预检/安装器与它逐条一致；
 *   ④ 断言冻结件与活上游一致（sha256 + 集合 + 判定形状），上游一动就红。
 *
 * 冻结件所在的那半张网（server CI job 只 checkout `server/`，没有 submodule 与
 * node_modules）由 `server/internal/skillmanifest/upstream_invocation_parity_test.go`
 * 用同一份冻结件兜住；两边都读到同一份期望值。
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { INVOCATION_BOOLEAN_LITERALS, PrecheckCode, precheckSkillPackage } from '../src/manifest-precheck.ts'
import { assertLoadableSkillMetadata } from '../src/skill-install.ts'
import { listRuntimeSkills, UPSTREAM_SKILL_FILESYSTEM_LIBS, UPSTREAM_SKILL_FILESYSTEM_SOURCE } from './helpers/upstream-skill-registry.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..', '..')

/** pinned 上游实现的两个来源（submodule 源码 = 权威；安装产物 = 运行时真正加载的那份）。 */
const UPSTREAM_SOURCE = UPSTREAM_SKILL_FILESYSTEM_SOURCE
const UPSTREAM_LIBS = UPSTREAM_SKILL_FILESYSTEM_LIBS
const FIXTURE = join(REPO_ROOT, 'server', 'internal', 'skillmanifest', 'testdata', 'upstream-invocation-boolean.json')

interface CorpusEntry { id: string, line: string, upstreamLoads: boolean, why: string }
interface Fixture {
  note: string
  submoduleSourceSha256: string
  acceptedStringLiterals: string[]
  acceptedNumbers: number[]
  acceptsBoolean: boolean
  lowercases: boolean
  trims: boolean
  throwsOtherwise: boolean
  corpus: CorpusEntry[]
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 切出上游 `frontmatterBoolean` 的函数体（找不到即 throw —— 上游改名/重构了）。 */
function frontmatterBooleanBody(text: string, where: string): string {
  const start = text.indexOf('function frontmatterBoolean')
  if (start < 0) throw new Error(`上游实现里找不到 frontmatterBoolean（${where}）：上游改名/重构了，请重新对拍`)
  const rest = text.slice(start + 'function frontmatterBoolean'.length)
  const next = rest.indexOf('\nfunction ')
  return next < 0 ? rest : rest.slice(0, next)
}

/** 从函数体**派生**它接受的字符串字面量集合与数字集合（不重述判定逻辑）。 */
function deriveAcceptedLiterals(body: string): { literals: string[], numbers: number[] } {
  // `typeof value === 'boolean'` 这类比较先摘掉，否则 'boolean'/'string' 会被当成字面量。
  const comparable = body.replace(/typeof\s+\w+\s*===\s*['"][^'"]*['"]/gu, 'typeof-compared')
  const literals = new Set<string>()
  for (const m of comparable.matchAll(/case\s*['"]([^'"]+)['"]\s*:/gu)) literals.add(m[1]!)
  for (const m of comparable.matchAll(/(?:^|[^.\w])value\s*===\s*['"]([^'"]+)['"]/gu)) literals.add(m[1]!)
  const numbers = new Set<number>()
  for (const m of comparable.matchAll(/(?:^|[^.\w])value\s*===\s*(-?\d+)(?:[^\d.]|$)/gu)) numbers.add(Number(m[1]))
  return { literals: [...literals].sort(), numbers: [...numbers].sort((a, b) => a - b) }
}

/** 从服务端 `manifest.go` 抽 `booleanLiterals` 的键（同样不从测试里复述）。 */
function deriveServerLiterals(goSource: string): string[] {
  const block = /var booleanLiterals = map\[string\]bool\{([\s\S]*?)\n\}/u.exec(goSource)
  if (block === null) throw new Error('server/internal/skillmanifest/manifest.go 里找不到 booleanLiterals 字面量表：判据漂移，请重新对拍')
  return [...new Set([...block[1]!.matchAll(/"([^"]+)":/gu)].map(m => m[1]!))].sort()
}

async function loadFixture(): Promise<Fixture> {
  return JSON.parse(await readFile(FIXTURE, 'utf8')) as Fixture
}

/** 除 invocation 布尔外**每一条**预检规则都合规的模板（变量只剩那一个键）。 */
function skillMd(name: string, line: string | null): string {
  return `---\nname: ${name}\nversion: 1.0.0\ntitle: Corpus Entry\nauthor: parity\ncategory: parity\ndescription: corpus entry for the upstream invocation parity check\n${line === null ? '' : `${line}\n`}---\n\n# corpus\n\n${'body text for the corpus entry. '.repeat(3)}\n`
}

describe('R13-B P1-1：invocation 布尔取值语料与 pinned 上游三方对拍', () => {
  it('① 上游派生集合 == 客户端集合 == 服务端集合（三方逐项相等）', async () => {
    const source = await readFile(UPSTREAM_SOURCE, 'utf8').catch(() => undefined)
    const libPath = UPSTREAM_LIBS.find(existsSync)
    const live = source ?? (libPath === undefined ? undefined : await readFile(libPath, 'utf8'))
    expect(live, `pinned 上游实现必须可读（${UPSTREAM_SOURCE} 或 ${UPSTREAM_LIBS.join(' / ')}）`).toBeDefined()

    const derived = deriveAcceptedLiterals(frontmatterBooleanBody(live!, source === undefined ? 'installed lib' : 'submodule'))
    const serverLiterals = deriveServerLiterals(await readFile(join(REPO_ROOT, 'server', 'internal', 'skillmanifest', 'manifest.go'), 'utf8'))

    expect(derived.literals, '客户端取值集合必须等于从上游派生的集合').toEqual([...INVOCATION_BOOLEAN_LITERALS].sort())
    expect(serverLiterals, '服务端 booleanLiterals 必须等于从上游派生的集合').toEqual(derived.literals)
    expect(derived.numbers, '上游接受的数字集合').toEqual([0, 1])
    // 判定形状：boolean 直通、字符串小写化、**不 trim**、其余 throw。
    // 少任何一条，「键存在但取值非法 ⇒ 整份技能被丢弃」的结论就不再成立。
    const body = frontmatterBooleanBody(live!, 'shape check')
    expect(/typeof\s+value\s*===\s*['"]boolean['"]/u.test(body), '上游必须直接接受 boolean').toBe(true)
    expect(/value\.toLowerCase\(\)/u.test(body), '上游必须做 toLowerCase（字面量比较口径）').toBe(true)
    expect(/value\.trim\(\)/u.test(body), '上游不 trim ⇒ 带空白的字符串是非法值').toBe(false)
    expect(/throw\s+new\s+TypeError/u.test(body), '上游必须对非法取值 throw').toBe(true)
  })

  it('② 冻结件与活上游一致（上游一动就红；UPDATE_UPSTREAM_FIXTURE=1 时重写派生字段）', async () => {
    let fixture = await loadFixture()
    const source = await readFile(UPSTREAM_SOURCE, 'utf8').catch(() => undefined)
    if (source === undefined) {
      // 只有安装产物时至少对拍集合（submodule 缺席的检出里不静默通过：下面的断言照跑）。
      const libPath = UPSTREAM_LIBS.find(existsSync)
      expect(libPath, 'submodule 与安装产物至少要有一个，否则这份判据失去输入').toBeDefined()
    }
    const live = source ?? await readFile(UPSTREAM_LIBS.find(existsSync)!, 'utf8')
    const derived = deriveAcceptedLiterals(frontmatterBooleanBody(live, 'fixture check'))
    const body = frontmatterBooleanBody(live, 'fixture shape check')
    const shape = {
      acceptsBoolean: /typeof\s+value\s*===\s*['"]boolean['"]/u.test(body),
      lowercases: /value\.toLowerCase\(\)/u.test(body),
      trims: /value\.trim\(\)/u.test(body),
      throwsOtherwise: /throw\s+new\s+TypeError/u.test(body),
    }

    if (process.env.UPDATE_UPSTREAM_FIXTURE === '1' && source !== undefined) {
      // 只重写**可派生**的字段；corpus 的"上游是否加载"由测试 ③ 真跑注册表逐条复核
      // （陈旧即红），所以这里不猜、也不动它。
      await writeFile(FIXTURE, `${JSON.stringify({
        ...fixture,
        submoduleSourceSha256: sha256(source),
        acceptedStringLiterals: derived.literals,
        acceptedNumbers: derived.numbers,
        ...shape,
      }, null, 2)}\n`)
      fixture = await loadFixture()
    }

    if (source !== undefined) {
      expect(sha256(source), `pinned 上游源码 sha256 变了：请重新提取并更新 ${FIXTURE}`).toBe(fixture.submoduleSourceSha256)
    }
    expect(derived.literals, '冻结件的取值集合与活上游不一致').toEqual(fixture.acceptedStringLiterals)
    expect(derived.numbers, '冻结件的数字集合与活上游不一致').toEqual(fixture.acceptedNumbers)
    expect(shape.acceptsBoolean).toBe(fixture.acceptsBoolean)
    expect(shape.lowercases).toBe(fixture.lowercases)
    expect(shape.trims).toBe(fixture.trims)
    expect(shape.throwsOtherwise).toBe(fixture.throwsOtherwise)
    expect(fixture.corpus.length, '语料不能为空').toBeGreaterThan(0)
  })

  it('③ 取值语料：真跑 pinned 上游注册表，客户端预检必须逐条一致', async () => {
    const fixture = await loadFixture()
    const home = await mkdtemp(join(tmpdir(), 'r13gc-parity-'))
    try {
      const skillsDir = join(home, 'skills')
      for (const entry of fixture.corpus) {
        await mkdir(join(skillsDir, entry.id), { recursive: true })
        await writeFile(join(skillsDir, entry.id, 'SKILL.md'), skillMd(entry.id, entry.line))
      }
      const loaded = new Set((await listRuntimeSkills(skillsDir)).map(s => s.name))

      for (const entry of fixture.corpus) {
        const upstreamLoads = loaded.has(entry.id)
        expect(upstreamLoads, `语料 ${entry.id}（${entry.line}）：上游注册表的判定变了（冻结件记的是 ${String(entry.upstreamLoads)}）—— ${entry.why}`)
          .toBe(entry.upstreamLoads)

        const issues = precheckSkillPackage(skillMd(entry.id, entry.line), entry.id)
        const other = issues.filter(i => i.code !== PrecheckCode.InvocationInvalid)
        expect(other, `语料 ${entry.id} 除 invocation 外必须全部合规，否则这条对拍失去意义`).toEqual([])
        const precheckRejects = issues.some(i => i.code === PrecheckCode.InvocationInvalid)
        expect(precheckRejects, `语料 ${entry.id}（${entry.line}）：上游${entry.upstreamLoads ? '会加载' : '会丢弃整份技能'}，客户端预检必须${entry.upstreamLoads ? '放行' : '拒绝'}（${entry.why}）`)
          .toBe(!entry.upstreamLoads)
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 30_000)

  it('④ 安装器（第三关）与上游同样逐条一致：装得上就必须加载得到', async () => {
    const fixture = await loadFixture()
    for (const entry of fixture.corpus) {
      const dir = await mkdtemp(join(tmpdir(), 'r13gc-install-gate-'))
      try {
        await writeFile(join(dir, 'SKILL.md'), skillMd(entry.id, entry.line))
        const attempt = assertLoadableSkillMetadata(dir, entry.id)
        if (entry.upstreamLoads) await expect(attempt, `语料 ${entry.id} 上游可加载，安装器不该拒`).resolves.toBeUndefined()
        else await expect(attempt, `语料 ${entry.id}（${entry.line}）上游会丢弃整份技能，安装器必须拒（${entry.why}）`).rejects.toThrow(/never load|discards? the entire skill|boolean literal/u)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  })
})
