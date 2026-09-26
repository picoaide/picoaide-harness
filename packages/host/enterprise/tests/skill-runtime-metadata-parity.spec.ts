/**
 * tests/skill-runtime-metadata-parity.spec.ts — R22-V1-N1 的仓内回归判据。
 *
 * ## 缺陷原形态（第二十二轮独立复审 V1-N1，与 R21-A1-01 逐字同一签名）
 *
 * 安装器"第三关"（`assertLoadableSkillMetadata`）此前用 `metaString` 取 `name` /
 * `description` —— 它是 `value.trim() !== '' ? value.trim() : undefined`（**trim**）。
 * 而 pinned 上游 `skill-filesystem` 的 `stringField` 是
 * `typeof value === 'string' && value.length > 0 ? value : undefined`（**不 trim**）。
 * 取值维度一分叉，两个方向都会坏事：
 *
 *  - **放行**（严重方向）：`name: "alpha "` / `" alpha"` / 未加引号的尾随 NBSP（复制
 *    粘贴常见）⇒ 我们读成 `alpha` 而通过，运行时的 `isSkillName("alpha ")` 为假 ⇒
 *    整份技能被静默丢弃：预检 0 问题 → 安装 200 + `ok:true` → 文件落盘 →
 *    `listInstalledSkills` / `discoverRuntimeSkills` 都列不出 ⇒ 面板永远"未安装"、
 *    反复点安装每次都被回成功、零报错；
 *  - **误杀**：`description: "   "` 上游**能**加载（`length > 0`），trim 判据却拒收。
 *    更硬的一例是自相矛盾：`synthesizeSkillFrontmatter` 在 gateway 形态归档上自己
 *    合成出 `description: '   '`，紧接着被自己的第三关拒收。
 *
 * ## 判据（三条互不替代）
 *
 *  1. **形态矩阵**（见 {@link FORMS}：V1 复审的 48 条逐条搬入，另补 3 条取值维度）：
 *     逐形态真跑 pinned 上游注册表（`listRuntimeSkills`）取"运行时到底加载不加载"，
 *     与第三关的接受/拒绝集合**双向相等** —— `放行`（我们接受、上游不加载）与`误杀`
 *     （上游加载、我们拒收）都必须为空（唯一例外是 {@link DELIBERATE_STRICTER} 列出的
 *     写侧长度上限，有意更严，另行钉住）。这是判据的主承重件：任何一维语义
 *     （取值 trim / 分隔符 / 旧键 / 名字正则）与上游分叉都会在这里变红。
 *  2. **判据来源对拍**：读 pinned 上游源码，`stringField` 必须是 `length > 0` 且
 *     **不含** `trim`；`parseSkillFile` 的 `name`/`description` 必须走它。上游哪天改成
 *     trim，本组变红并逼我们重新对拍（而不是让我们悄悄分叉）。
 *  3. **实现同一性**：`assertLoadableSkillMetadata` 的取值必须走 `runtimeString`，
 *     且 `runtimeString` 自己**不 trim**（防止"两边一起改"式的自我一致分叉）。
 *
 * ## 变异验证（拆掉修复必红）
 *
 *  - `runtimeString` 换回 `metaString`（= trim 回来）⇒ 第 1 组红
 *    （`放行 = ["name with trailing space"]`）；把 trim 去掉但改成"任意非空"（等价于
 *    上游）则绿 —— 这正是本组的语义；
 *  - 给 `runtimeString` 加 `.trim()` ⇒ 同组红（放行侧复活）；
 *  - 把 `runtimeString` 改成上游之外的第三态（例如 `typeof value === 'string'`，
 *    不做 `length > 0`）⇒ 同组红（`name: ""` 会被放行，而上游忽略它）。
 */
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ArchiveInstallRefusal,
  assertLoadableSkillMetadata,
  discoverRuntimeSkills,
  installSkillArchive,
  listInstalledSkills,
  synthesizeSkillFrontmatter,
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
function upstreamFunctionBody(text: string, name: string): string {
  const start = text.indexOf(`function ${name}`)
  if (start < 0) throw new Error(`上游实现里找不到 ${name}：上游改名/重构了，请重新对拍 frontmatter 取值判据`)
  const rest = text.slice(start + `function ${name}`.length)
  const next = rest.indexOf('\nfunction ')
  return next < 0 ? rest : rest.slice(0, next)
}

/** 正文：足够长以越过发布预检的正文下限（本文件判的是**安装闸门 vs 运行时**，不是预检）。 */
const BODY = '正文用于通过预检的长度下限要求,内容本身没有实际用途,仅用于验证判据与运行时一致。\n'

/** 基础 frontmatter 行（顺序固定，只有被点名的形态才改）。 */
const FM = ['name: alpha', 'title: Alpha 示例技能', 'version: 1.0.0',
  'description: 用于 frontmatter 判据的示例技能,描述长度足以通过发布前预检。',
  'author: tester', 'category: security']

interface Form {
  label: string
  text: string
  /**
   * 该形态的 frontmatter 名（= 运行时注册表的键，也是第三关的"技能 ID"实参）。
   * 缺省 `alpha`；只有刻意换名字的形态（见 {@link DELIBERATE_STRICTER}）才给。
   */
  skillId?: string
}

/**
 * 形态语料（V1 复审差分矩阵的 48 条**逐条搬入**，另补 3 条取值维度：
 * 前导空格 / 尾随 NBSP / 尾随全角空格）：
 * 分隔符维度、取值维度、YAML 结构维度、编码维度、旧键维度都在里面。
 */
const FORMS: Form[] = [
  { label: 'baseline LF', text: ['---', ...FM, '---', BODY].join('\n') },
  { label: 'closing "--- "', text: ['---', ...FM, '--- ', BODY].join('\n') },
  { label: 'closing "---\\t"', text: ['---', ...FM, '---\t', BODY].join('\n') },
  { label: 'closing "---x"', text: ['---', ...FM, '---x', BODY].join('\n') },
  { label: 'closing " ---" (leading space)', text: ['---', ...FM, ' ---', BODY].join('\n') },
  { label: 'closing "----"', text: ['---', ...FM, '----', BODY].join('\n') },
  { label: 'opening "--- " + closing "---"', text: ['--- ', ...FM, '---', BODY].join('\n') },
  { label: 'opening "----" + closing "----"', text: ['----', ...FM, '----', BODY].join('\n') },
  { label: 'closing is last line (no trailing NL)', text: ['---', ...FM, '---'].join('\n') },
  { label: 'closing is last line + trailing NL', text: `${['---', ...FM, '---'].join('\n')}\n` },
  { label: 'CRLF baseline', text: ['---', ...FM, '---', BODY].join('\r\n') },
  { label: 'CRLF closing "--- "', text: ['---', ...FM, '--- ', BODY].join('\r\n') },
  { label: 'CRLF opening "--- "', text: ['--- ', ...FM, '---', BODY].join('\r\n') },
  { label: 'lone \\r separators (classic mac)', text: ['---', ...FM, '---', BODY].join('\r') },
  { label: 'BOM before opening', text: `\uFEFF${['---', ...FM, '---', BODY].join('\n')}` },
  { label: 'BOM alone on first line', text: ['\uFEFF', '---', ...FM, '---', BODY].join('\n') },
  { label: 'no frontmatter at all', text: ['# Alpha', BODY].join('\n') },
  { label: 'empty frontmatter "---\\n---"', text: ['---', '---', BODY].join('\n') },
  { label: 'empty map "{}" frontmatter', text: '---\n{}\n---\n' + BODY },
  { label: 'frontmatter is a scalar', text: '---\nhello\n---\n' + BODY },
  { label: 'frontmatter is a sequence', text: '---\n- a\n- b\n---\n' + BODY },
  { label: 'frontmatter is null (comments only)', text: '---\n# nothing\n---\n' + BODY },
  { label: 'duplicate keys in frontmatter', text: ['---', 'name: alpha', ...FM.slice(1), 'name: alpha', '---', BODY].join('\n') },
  { label: 'nested "---" line inside block scalar', text: ['---', ...FM, 'notes: |', '  line one', '---', '  line two', '---', BODY].join('\n') },
  { label: 'name only, no description', text: ['---', 'name: alpha', '---', BODY].join('\n') },
  { label: 'description only, no name', text: ['---', 'description: something long enough', '---', BODY].join('\n') },
  { label: 'name empty string', text: ['---', 'name: ""', 'description: d', '---', BODY].join('\n') },
  { label: 'name as number', text: ['---', 'name: 123', 'description: d', '---', BODY].join('\n') },
  { label: 'description whitespace only', text: ['---', 'name: alpha', 'description: "   "', '---', BODY].join('\n') },
  { label: 'description with leading space', text: ['---', 'name: alpha', 'description: " hello"', '---', BODY].join('\n') },
  { label: 'name with trailing space', text: ['---', 'name: "alpha "', 'description: "d"', '---', BODY].join('\n') },
  { label: 'name with leading space', text: ['---', 'name: " alpha"', 'description: "d"', '---', BODY].join('\n') },
  { label: 'name with trailing NBSP (unquoted paste)', text: ['---', 'name: alpha\u00a0', 'description: "d"', '---', BODY].join('\n') },
  { label: 'name with trailing ideographic space', text: ['---', 'name: alpha\u3000', 'description: "d"', '---', BODY].join('\n') },
  { label: 'tab-indented mapping', text: ['---', ...FM, 'metadata:', '\towner: x', '---', BODY].join('\n') },
  { label: 'anchor + alias', text: ['---', ...FM, 'extra: &a x', 'other: *a', '---', BODY].join('\n') },
  { label: 'flow mapping frontmatter', text: '---\n{name: alpha, description: dd}\n---\n' + BODY },
  { label: 'legacy key disableModelInvocation', text: ['---', ...FM, 'disableModelInvocation: true', '---', BODY].join('\n') },
  { label: 'legacy key modelInvocable: null', text: ['---', ...FM, 'modelInvocable:', '---', BODY].join('\n') },
  { label: 'legacy key userInvocable: false', text: ['---', ...FM, 'userInvocable: false', '---', BODY].join('\n') },
  { label: 'disable-model-invocation: " true "', text: ['---', ...FM, 'disable-model-invocation: " true "', '---', BODY].join('\n') },
  { label: 'disable-model-invocation: null', text: ['---', ...FM, 'disable-model-invocation:', '---', BODY].join('\n') },
  { label: 'disable-model-invocation: 2', text: ['---', ...FM, 'disable-model-invocation: 2', '---', BODY].join('\n') },
  { label: 'disable-model-invocation: yes', text: ['---', ...FM, 'disable-model-invocation: yes', '---', BODY].join('\n') },
  { label: 'user-invocable: 1', text: ['---', ...FM, 'user-invocable: 1', '---', BODY].join('\n') },
  { label: 'user-invocable: [true]', text: ['---', ...FM, 'user-invocable: [true]', '---', BODY].join('\n') },
  { label: 'whenToUse non-string', text: ['---', ...FM, 'whenToUse: [1, 2]', '---', BODY].join('\n') },
  { label: 'unknown extra keys', text: ['---', ...FM, 'whatever: {a: 1}', '---', BODY].join('\n') },
  { label: 'long frontmatter (200 unknown keys)', text: ['---', ...FM, ...Array.from({ length: 200 }, (_, i) => `k${i}: v${i}`), '---', BODY].join('\n') },
  { label: 'name > 64 chars', text: ['---', `name: ${'a'.repeat(70)}`, 'description: dd', '---', BODY].join('\n'), skillId: 'a'.repeat(70) },
  { label: 'trailing spaces after opening on CRLF', text: ['---\r', ...FM, '---\r', BODY].join('\n') },
]

/**
 * **有意更严**的一处（不是分叉缺陷）：写侧名字上限 {@link MAX_SKILL_NAME_LENGTH}
 * 64 字符。上游 `SKILL_NAME` 正则不限长 ⇒ 70 字符的名字上游会加载、我们拒装。
 *
 * 这条由 `skill-install.spec.ts`（"长度上限是我们额外加的"）单独钉住；矩阵把它
 * 显式列进白名单，并要求**除它以外零分歧** —— 白名单只允许这一个条目，且它必须
 * 仍然命中（若哪天上限被删掉，或上游自己加了长度限制，本组都会红）。
 */
const DELIBERATE_STRICTER: ReadonlySet<string> = new Set(['name > 64 chars'])

/**
 * **发现面**有意允许"多列出"的那一组（R21-A1-02 的认账残项；V1 复审登记为残项而
 * 非发现）。`readRuntimeSkillMetadata` 只判"严格 frontmatter + name/description
 * 是非空字符串"，**不跑 invocation 策略** —— 于是旧调用键 / 非法布尔值让运行时丢掉
 * 整份技能，而面板仍列得出它。
 *
 * 为什么不去把发现面拧到与运行时逐字一致：面板是**唯一的删除入口**（没有本地删除
 * 路由），列不出就删不掉 —— 那会把"装得上、用不到"换成"看不见、删不掉"，而后者是
 * 本仓反复消灭的更坏形态（见 `validateRuntimeSkillName` 的注释）。所以这里钉的口径是
 * **发现面 ⊇ 运行时**，且多出来的必须**恰好**是下面这一组（多一条、少一条都红）。
 */
const DISCOVERY_SUPERSET: readonly string[] = [
  'legacy key disableModelInvocation',
  'legacy key modelInvocable: null',
  'legacy key userInvocable: false',
  'disable-model-invocation: " true "',
  'disable-model-invocation: null',
  'disable-model-invocation: 2',
  'user-invocable: [true]',
]

const dirs: string[] = []

async function freshHome(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(home)
  return home
}

beforeEach(isolateRuntimeSkillRoots)

afterAll(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** 一份 SKILL.md 原样落进 `<skills>/alpha/SKILL.md`（不走安装器，直接给两路读数取输入）。 */
async function place(prefix: string, md: string): Promise<string> {
  const home = await freshHome(prefix)
  const skillsDir = join(home, 'skills')
  await mkdir(join(skillsDir, 'alpha'), { recursive: true })
  await writeFile(join(skillsDir, 'alpha', 'SKILL.md'), md, 'utf8')
  return skillsDir
}

describe('R22-V1-N1 48 形态双向矩阵：第三关接受集合 == pinned 上游加载集合', () => {
  it('放行（我们接受、上游不加载）与误杀（上游加载、我们拒收）必须都为空', async () => {
    const rows: string[] = []
    const misses: string[] = []
    const kills: string[] = []
    const extraDiscovery: string[] = []
    const lostDiscovery: string[] = []
    for (const form of FORMS) {
      const skillsDir = await place('r22v1-matrix-', form.text)
      const skillId = form.skillId ?? 'alpha'

      const loaded = (await listRuntimeSkills(skillsDir)).some(skill => skill.name === skillId)
      const gate = await assertLoadableSkillMetadata(join(skillsDir, 'alpha'), skillId)
        .then(() => 'accept', (cause: unknown) => cause instanceof ArchiveInstallRefusal ? `refuse:${cause.code}` : `throw:${String(cause)}`)
      // 发现面/面板与运行时的关系是 **⊇**（见 {@link DISCOVERY_SUPERSET}）。
      const discovered = (await discoverRuntimeSkills(skillsDir)).some(skill => skill.name === skillId)
      const installed = (await listInstalledSkills(skillsDir)).includes(skillId)

      rows.push(`| ${form.label} | upstream=${String(loaded)} | gate=${gate} | discover=${String(discovered)} | panel=${String(installed)} |`)
      if (gate === 'accept' && !loaded) misses.push(form.label)
      if (loaded && gate !== 'accept') kills.push(form.label)
      if (discovered && !loaded) extraDiscovery.push(form.label)
      if (loaded && !discovered) lostDiscovery.push(form.label)
      expect(installed, `${form.label}：面板"已安装"与发现面同判`).toBe(discovered)
    }
    // 失败时把整张矩阵打出来（否则只剩几个数组，看不出是哪一维分叉）。
    // eslint-disable-next-line no-console
    console.log(['| form | reading |', '|---|---|', ...rows].join('\n'))
    // eslint-disable-next-line no-console
    console.log(`[R22-V1-N1 matrix] 放行 = ${JSON.stringify(misses)} | 误杀 = ${JSON.stringify(kills)}`
      + ` | 发现面多列 = ${JSON.stringify(extraDiscovery)} | 发现面漏列 = ${JSON.stringify(lostDiscovery)}`)
    // 白名单只许有一个条目，且它必须仍然命中（见 {@link DELIBERATE_STRICTER}）。
    expect(kills, '写侧长度上限必须仍然是有意更严的那唯一一条').toEqual([...DELIBERATE_STRICTER])
    expect(
      { misses, kills: kills.filter(label => !DELIBERATE_STRICTER.has(label)) },
      '除白名单那一条以外，双向必须都为空：放行=装得上而运行时不加载；误杀=上游能加载而我们拒装',
    ).toEqual({ misses: [], kills: [] })
    expect(lostDiscovery, '运行时加载的技能面板必须列得出（否则卸载入口就没了）').toEqual([])
    expect(extraDiscovery, '发现面多列出的必须恰好是"有意保留可删"的那一组').toEqual([...DISCOVERY_SUPERSET])
  }, 300_000)

  it('端到端：带尾随空白的 name **装不上**（旧实现：安装成功 + ok:true，运行时零加载）', async () => {
    const home = await freshHome('r22v1-e2e-')
    const skillsDir = join(home, 'skills')
    await mkdir(skillsDir, { recursive: true })
    const kept: Form[] = [
      { label: 'name with trailing space', text: ['---', 'name: "alpha "', 'description: "d"', '---', BODY].join('\n') },
      { label: 'name with trailing NBSP', text: ['---', 'name: alpha\u00a0', 'description: "d"', '---', BODY].join('\n') },
      { label: 'name with trailing ideographic space', text: ['---', 'name: alpha\u3000', 'description: "d"', '---', BODY].join('\n') },
    ]
    for (const form of kept) {
      const zip = await archiveOf(form.text)
      const cause = await installSkillArchive({ name: 'alpha', archive: zip, skillsDir, channel: 'market' })
        .then(() => undefined, (error: unknown) => error)
      expect(cause, `${form.label}：严重形态（装得上、永不加载）⇒ 安装必须被拒`).toBeInstanceOf(ArchiveInstallRefusal)
      expect((await listRuntimeSkills(skillsDir)).map(skill => skill.name), `${form.label}：上游必须不加载`).toEqual([])
      expect(await listInstalledSkills(skillsDir), `${form.label}：拒绝后不得留下落盘`).toEqual([])
    }
  }, 60_000)

  it('反向对照：`description: "   "` **必须**放行（上游 length > 0 会加载，trim 判据会误杀）', async () => {
    const md = ['---', 'name: alpha', 'description: "   "', '---', BODY].join('\n')
    const skillsDir = await place('r22v1-blank-desc-', md)
    expect((await listRuntimeSkills(skillsDir)).map(skill => skill.name), '上游确实加载这一形态').toEqual(['alpha'])
    await expect(assertLoadableSkillMetadata(join(skillsDir, 'alpha'), 'alpha'), '上游能加载 ⇒ 我们不许拒收').resolves.toBeUndefined()
  })

  it('对照（正向）：普通 frontmatter 照常放行且上游真的加载它', async () => {
    const skillsDir = await place('r22v1-ok-', ['---', ...FM, '---', BODY].join('\n'))
    await expect(assertLoadableSkillMetadata(join(skillsDir, 'alpha'), 'alpha')).resolves.toBeUndefined()
    expect((await listRuntimeSkills(skillsDir)).map(skill => skill.name)).toEqual(['alpha'])
  })
})

describe('R22-V1-N1 合成器自洽：合成产物必须能过第三关、且是"非空白"的描述', () => {
  it('metadata.yaml 的 description 是纯空白 ⇒ 回落成 `<name> skill`，合成产物过第三关且上游加载', async () => {
    const home = await freshHome('r22v1-synth-')
    const dir = join(home, 'alpha')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '# Alpha\n\n正文\n')
    await writeFile(join(dir, 'metadata.yaml'), 'name: alpha\ndescription: "   "\nversion: 1.0.0\n')

    await synthesizeSkillFrontmatter(dir, 'alpha', '1.0.0')
    const md = await readFile(join(dir, 'SKILL.md'), 'utf8')
    expect(md, '合成器不产出自相矛盾的空白 description').toContain('description: alpha skill')
    await expect(assertLoadableSkillMetadata(dir, 'alpha'), '合成器写出来的东西自己必须认').resolves.toBeUndefined()

    // 真跑上游：把合成结果放进库里，运行时必须加载它。
    const skillsDir = join(home, 'skills')
    await mkdir(join(skillsDir, 'alpha'), { recursive: true })
    await writeFile(join(skillsDir, 'alpha', 'SKILL.md'), md, 'utf8')
    expect((await listRuntimeSkills(skillsDir)).map(skill => skill.name)).toEqual(['alpha'])
  })

  it('metadata.yaml 完全没有 description 时同样回落（既有行为不退化）', async () => {
    const home = await freshHome('r22v1-synth2-')
    const dir = join(home, 'alpha')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '# Alpha\n\n正文\n')
    await writeFile(join(dir, 'metadata.yaml'), 'name: alpha\n')
    await synthesizeSkillFrontmatter(dir, 'alpha')
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toContain('description: alpha skill')
    await expect(assertLoadableSkillMetadata(dir, 'alpha')).resolves.toBeUndefined()
  })
})

describe('R22-V1-N1 判据来源：上游 stringField 语义 + 唯一实现', () => {
  it('pinned 上游的取值判据是 `length > 0` 且**不 trim**', () => {
    const upstream = readFileSync(UPSTREAM_SKILL_FILESYSTEM_SOURCE, 'utf8')
    const field = upstreamFunctionBody(upstream, 'stringField')
    expect(field, '上游必须按长度判空').toContain('value.length > 0')
    expect(field, '上游取值不 trim（trim 会让两边语义分叉）').not.toContain('trim')
    const parse = upstreamFunctionBody(upstream, 'parseSkillFile')
    expect(parse, 'name 必须取 stringField').toContain("stringField(parsed.data, 'name')")
    expect(parse, 'description 必须取 stringField').toContain("stringField(parsed.data, 'description')")
  })

  it('第三关的取值走 runtimeString，且 runtimeString 自己逐字等于上游（不 trim、按长度判空）', () => {
    const installSrc = readSrc('skill-install.ts')
    expect(installSrc, '第三关必须用运行时取值判据').toContain('const fmName = runtimeString(meta.name)')
    expect(installSrc, '第三关必须用运行时取值判据').toContain('const fmDescription = runtimeString(meta.description)')
    // 实现形状：与上游 `stringField` 逐字同形（形态断言挡"两边一起改"的自我一致分叉）。
    const helper = /function runtimeString\(value: unknown\): string \| undefined \{\n([\s\S]*?)\n\}/u.exec(installSrc)
    expect(helper, '找不到 runtimeString 的实现（改名/内联了？请重新对拍）').not.toBeNull()
    const body = helper?.[1] ?? ''
    expect(body, 'runtimeString 必须按长度判空').toContain('value.length > 0')
    expect(body, 'runtimeString 不得 trim（放行侧会复活）').not.toContain('trim')
  })
})

/** 把一份 SKILL.md 打成技能归档（归档根即技能目录）。 */
function archiveOf(md: string): Buffer {
  const zip = new AdmZip()
  zip.addFile('SKILL.md', Buffer.from(md, 'utf8'), '', 0o644)
  return zip.toBuffer()
}
