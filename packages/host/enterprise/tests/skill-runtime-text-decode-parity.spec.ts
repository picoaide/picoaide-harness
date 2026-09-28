/**
 * tests/skill-runtime-text-decode-parity.spec.ts — R23-W2-01 的仓内回归判据。
 *
 * ## 缺陷原形态（第二十三轮独立复审 W2-01，P2）
 *
 * 生产形态下运行时**先过一关解码**再谈 frontmatter：桌面装配了 `ctx.fs`
 * （`cordis.patch.yml` 把 `fs-sandbox` 换成继承 `LocalFileSystem` 的
 * `asar-file-system`），于是上游 `readSkillText` 走
 * `readSkillTextFromFileSystem` → `ctx.fs.readText` → `readWholeText`（pinned
 * `fs-local/src/fsio.ts`）：前 8192 字节里有 `NUL` ⇒ `FS_NOT_TEXT "binary file"`；
 * 整份字节不是合法 UTF-8 ⇒ `FS_NOT_TEXT "invalid UTF-8 text"`。两条都让上游
 * **`logger.warn` + 整份技能丢弃**。
 *
 * 而安装器 / 发现面 / 发布预检读文件用的是 `readFile(…, 'utf8')` —— 它**永不抛错**
 * （非法字节静默变 U+FFFD）。修前实测读数：
 *
 * ```
 * precheck=[] | install ok | panel=["alpha"] | discover=["alpha"] | runtime(fs)=[]
 * ```
 *
 * 与 R21-A1-01 / R22-V1-N1 逐字同一签名（装得上、面板说已安装、模型永远看不到）。
 * 更糟的是上一轮新加的"我们接受集合 == 上游加载集合"判据**看不见它**：测试用的
 * 注册表 harness 不注册 `ctx.fs`，走的是 `node:fs` 直读那条回落。
 *
 * ## 这份用例怎么判（四条互不替代的证据）
 *
 *  1. **与上游实现逐条对拍**（不是复述规则）：同一份语料，一边跑我们的
 *     `decodeSkillTextBytes`，一边跑**真** `ctx.fs`（`readViaRuntimeFileSystem`，
 *     与上游那两行逐字同形），逐条比 `ok`；
 *  2. **三面同集合**：`assertLoadableSkillMetadata`（安装第三关）/
 *     `discoverRuntimeSkills` + `listInstalledSkills`（发现面）/ 生产形态的
 *     `listRuntimeSkills`（运行时）在同一份语料上给出**同一个**集合 —— 双向为空；
 *  3. **端到端**：含 NUL / 非法 UTF-8 的归档**装不上**（旧实现返回 200 + ok:true），
 *     纯文本归档装得上且运行时真的加载；
 *  4. **判据来源对拍**：读 pinned `fsio.ts`，采样窗口常量必须逐字等于我们的
 *     {@link SKILL_TEXT_BINARY_SAMPLE_BYTES}、`readWholeText` 的两条拒绝语义必须仍在
 *     （上游哪天放宽/改名 ⇒ 本用例红并逼我们重新对拍）。
 *
 * ## 语料（含正向：不许为了"拒收"误杀正常文件）
 *
 * 负向：NUL（正文 / frontmatter 值 / 采样窗口边界内）、非法 UTF-8 各类形态
 * （孤立续字节、截断三字节序列、过长编码、代理对半、0xFF/0xFE）、UTF-16 BOM、
 * CRLF + 非法字节混合。正向：纯文本 / CJK / emoji / CRLF / 无尾换行 / 超长单行 /
 * **NUL 恰好落在采样窗口之外**（`readWholeText` 只采样前 8192 字节 —— 把它写成
 * "全文找 NUL"就会在这一条上分叉）。
 *
 * ## 变异验证（把判据退回旧形态 ⇒ 本文件红）
 *
 *  - `readSkillFrontmatterStrict` / `assertRuntimeReadableSkillText` 退回
 *    `readFile(…, 'utf8')` ⇒ 第 2、3 组红（gate=accept / panel=["alpha"] 而
 *    runtime 为空）；
 *  - `decodeSkillTextBytes` 的采样窗口改成"全文找 NUL" ⇒ 第 1、2 组红（窗口外
 *    NUL 的正向语料被判 binary）；
 *  - `upstream-skill-registry.ts` 退回不装 `ctx.fs` ⇒ 第 2、3 组的运行时读数变成
 *    harness 人造形态，与三面不一致 ⇒ 红。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ArchiveInstallRefusal,
  assertLoadableSkillMetadata,
  discoverRuntimeSkills,
  installSkillArchive,
  listInstalledSkills,
  packSkill,
} from '../src/skill-install.ts'
import { SKILL_TEXT_BINARY_SAMPLE_BYTES, decodeSkillTextBytes } from '../src/skill-frontmatter.ts'
import { isolateRuntimeSkillRoots } from './helpers/runtime-skill-roots.ts'
import {
  listRuntimeSkills,
  readViaRuntimeFileSystem,
  UPSTREAM_FS_LOCAL_SOURCE,
} from './helpers/upstream-skill-registry.ts'

/** frontmatter 头部（字段齐全，描述长度足以越过发布预检的下限）。 */
const FRONT = [
  '---',
  'name: alpha',
  'title: Alpha 示例技能',
  'version: 1.0.0',
  'description: 用于解码层判据的示例技能,描述长度足以通过发布前预检的下限要求。',
  'author: tester',
  'category: security',
]

/** 正文（长度同样过预检下限）。 */
const BODY = '正文用于通过预检的长度下限要求,内容本身没有实际用途,仅用于验证判据与运行时一致。\n'

/** 一份完全合法的 SKILL.md（UTF-8 纯文本）。 */
function goodText(): string {
  return [...FRONT, '---', BODY].join('\n')
}

const GOOD = Buffer.from(goodText(), 'utf8')

/** 把一段 ASCII 垫到**恰好** `size` 字节（用于精确落在采样窗口边界上）。 */
function headOfSize(size: number): Buffer {
  const prefix = `${[...FRONT, '---'].join('\n')}\n`
  if (Buffer.byteLength(prefix, 'utf8') > size) throw new Error('垫长前缀本身已超过目标长度')
  return Buffer.from(prefix + 'x'.repeat(size - Buffer.byteLength(prefix, 'utf8')), 'utf8')
}

/** 正文尾巴（放在采样窗口边界形态的 `tail` 位置）。 */
function tail(): Buffer {
  return Buffer.from(`tail\n${BODY}`, 'utf8')
}

/** NUL 落在**采样窗口的最后一个字节**（第 8192 字节）上。 */
const NUL_AT_LAST_SAMPLED = Buffer.concat([headOfSize(SKILL_TEXT_BINARY_SAMPLE_BYTES - 1), Buffer.from([0x00]), tail()])

/** NUL 落在**窗口之外**的第一个字节（第 8193 字节）上。 */
const NUL_AFTER_WINDOW = Buffer.concat([headOfSize(SKILL_TEXT_BINARY_SAMPLE_BYTES), Buffer.from([0x00]), tail()])

/** UTF-16LE BOM 落在窗口之外（把"非法 UTF-8"与"采样到 NUL"两条成因分开）。 */
const UTF16_BOM_AFTER_WINDOW = Buffer.concat([
  headOfSize(SKILL_TEXT_BINARY_SAMPLE_BYTES),
  Buffer.from([0xff, 0xfe]),
  tail(),
])

interface Case {
  label: string
  bytes: Buffer
  /** 运行时的判据（`readWholeText`）：读得出文本为 true。 */
  runtimeReads: boolean
}

/** 负向：运行时读不出文本（解码层必须与之一致）。 */
const NOT_TEXT_CASES: Case[] = [
  {
    label: 'NUL in body',
    bytes: Buffer.concat([GOOD, Buffer.from([0x41, 0x00, 0x42]), Buffer.from(`\n${BODY}`, 'utf8')]),
    runtimeReads: false,
  },
  {
    label: 'NUL in frontmatter value',
    bytes: Buffer.from(`---\nname: alpha\ndescription: d\u0000d\n---\n${BODY}`, 'utf8'),
    runtimeReads: false,
  },
  { label: 'NUL at the last sampled byte', bytes: NUL_AT_LAST_SAMPLED, runtimeReads: false },
  {
    label: 'invalid UTF-8 lone continuation byte (0x80)',
    bytes: Buffer.concat([GOOD, Buffer.from([0x80]), Buffer.from(`\n${BODY}`, 'utf8')]),
    runtimeReads: false,
  },
  {
    label: 'invalid UTF-8 lone 0xE9 (truncated 3-byte lead)',
    bytes: Buffer.concat([GOOD, Buffer.from([0xe9]), Buffer.from(`\n${BODY}`, 'utf8')]),
    runtimeReads: false,
  },
  {
    label: 'invalid UTF-8 truncated sequence (0xE2 0x82)',
    bytes: Buffer.concat([GOOD, Buffer.from([0xe2, 0x82]), Buffer.from(`\n${BODY}`, 'utf8')]),
    runtimeReads: false,
  },
  {
    label: 'invalid UTF-8 overlong encoding (0xC0 0xAF)',
    bytes: Buffer.concat([GOOD, Buffer.from([0xc0, 0xaf]), Buffer.from(`\n${BODY}`, 'utf8')]),
    runtimeReads: false,
  },
  {
    label: 'invalid UTF-8 surrogate half (0xED 0xA0 0x80)',
    bytes: Buffer.concat([GOOD, Buffer.from([0xed, 0xa0, 0x80]), Buffer.from(`\n${BODY}`, 'utf8')]),
    runtimeReads: false,
  },
  {
    label: 'invalid UTF-8 lone 0xFF',
    bytes: Buffer.concat([GOOD, Buffer.from([0xff]), Buffer.from(`\n${BODY}`, 'utf8')]),
    runtimeReads: false,
  },
  { label: 'UTF-16LE BOM then ASCII', bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), GOOD]), runtimeReads: false },
  { label: 'UTF-16BE BOM then ASCII', bytes: Buffer.concat([Buffer.from([0xfe, 0xff]), GOOD]), runtimeReads: false },
  { label: 'UTF-16LE BOM beyond the sample window', bytes: UTF16_BOM_AFTER_WINDOW, runtimeReads: false },
  {
    label: 'CRLF + invalid byte mix',
    bytes: Buffer.concat([
      Buffer.from([...FRONT, '---', BODY].join('\r\n'), 'utf8'),
      Buffer.from([0x9f]),
      Buffer.from(`\r\n${BODY.replace(/\n/gu, '\r\n')}`, 'utf8'),
    ]),
    runtimeReads: false,
  },
]

/** 正向：合法文本，一条都不许误杀。 */
const TEXT_CASES: Case[] = [
  { label: 'pure UTF-8 (control)', bytes: GOOD, runtimeReads: true },
  { label: 'CJK only body', bytes: Buffer.from([...FRONT, '---', '中文正文'.repeat(40)].join('\n'), 'utf8'), runtimeReads: true },
  { label: 'emoji body', bytes: Buffer.from([...FRONT, '---', '🚀🧪'.repeat(60)].join('\n'), 'utf8'), runtimeReads: true },
  { label: 'CRLF', bytes: Buffer.from(goodText().replace(/\n/gu, '\r\n'), 'utf8'), runtimeReads: true },
  { label: 'no trailing newline', bytes: Buffer.from(goodText().trimEnd(), 'utf8'), runtimeReads: true },
  {
    label: 'very long single line (64 KiB, no newline inside)',
    bytes: Buffer.from([...FRONT, '---', 'y'.repeat(64 * 1024)].join('\n'), 'utf8'),
    runtimeReads: true,
  },
  { label: 'NUL right after the sample window', bytes: NUL_AFTER_WINDOW, runtimeReads: true },
  {
    label: 'BOM (U+FEFF) — `TextDecoder` 剥 BOM ⇒ 解码层放行、运行时照常加载',
    bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), GOOD]),
    runtimeReads: true,
  },
]

const ALL_CASES: Case[] = [...NOT_TEXT_CASES, ...TEXT_CASES]

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

/** 把一份 SKILL.md（原始字节）放进 `<home>/skills/alpha/SKILL.md`。 */
async function place(prefix: string, bytes: Buffer, dirName = 'alpha'): Promise<{ skillsDir: string, dir: string }> {
  const home = await freshHome(prefix)
  const skillsDir = join(home, 'skills')
  const dir = join(skillsDir, dirName)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), bytes)
  return { skillsDir, dir }
}

/** 一个空技能库（安装用例用：不给安装器任何预置内容）。 */
async function emptySkillsDir(prefix: string): Promise<string> {
  const home = await freshHome(prefix)
  const skillsDir = join(home, 'skills')
  await mkdir(skillsDir, { recursive: true })
  return skillsDir
}

function archiveOf(bytes: Buffer): Buffer {
  const zip = new AdmZip()
  zip.addFile('SKILL.md', bytes, '', 0o644)
  return zip.toBuffer()
}

describe('R23-W2-01 解码判据与上游 `readWholeText` 逐条对拍（真跑 ctx.fs）', () => {
  it('同一份语料：我们的 ok 必须逐条等于上游 ctx.fs 的 ok（含采样窗口边界）', async () => {
    const mismatches: string[] = []
    const rows: string[] = []
    for (const item of ALL_CASES) {
      const { dir } = await place('r23w2-dec-', item.bytes)
      const upstream = await readViaRuntimeFileSystem(join(dir, 'SKILL.md'))
      const ours = decodeSkillTextBytes(item.bytes)
      rows.push(`| ${item.label} | ours=${ours.ok} | upstream=${upstream.ok} | expected=${item.runtimeReads} |`)
      if (ours.ok !== upstream.ok) mismatches.push(`${item.label}: ours=${ours.ok} upstream=${upstream.ok}`)
      expect(ours.ok, `${item.label}：我们与 readWholeText 的判据必须同源`).toBe(upstream.ok)
      expect(upstream.ok, `${item.label}：上游读数必须等于语料表里的期望（期望错 ⇒ 语料要改，不是判据要改）`)
        .toBe(item.runtimeReads)
      if (!ours.ok) {
        // 成因也要对得上：NUL 采样 → binary，其余 → invalid-utf8。
        expect(['binary', 'invalid-utf8'], item.label).toContain(ours.failure)
      }
    }
    // eslint-disable-next-line no-console
    console.log(['| case | readings |', '|---|---|', ...rows].join('\n'))
    expect(mismatches, '逐条对拍不得有分歧').toEqual([])
  }, 300_000)

  it('采样窗口语义：NUL 在窗口内拒、窗口外放（"全文找 NUL"的近似会在这里分叉）', () => {
    expect(NUL_AT_LAST_SAMPLED[SKILL_TEXT_BINARY_SAMPLE_BYTES - 1], '语料构造：第 8192 个字节是 NUL').toBe(0)
    expect(NUL_AFTER_WINDOW[SKILL_TEXT_BINARY_SAMPLE_BYTES], '语料构造：第 8193 个字节是 NUL').toBe(0)
    expect(
      decodeSkillTextBytes(NUL_AT_LAST_SAMPLED),
      '采样窗口内的 NUL ⇒ binary（与 readWholeText 同一条）',
    ).toEqual({ ok: false, failure: 'binary' })
    expect(
      decodeSkillTextBytes(NUL_AFTER_WINDOW),
      '窗口之外的 NUL ⇒ 照常解码（readWholeText 只采样前 8192 字节；"全文找 NUL"会在这里分叉）',
    ).toMatchObject({ ok: true })
  })
})

describe('R23-W2-01 三面（安装第三关 / 发现面 / 面板）与运行时同集合', () => {
  it('逐形态：gate===accept ⟺ discover ⟺ panel ⟺ 生产形态运行时加载（双向为空）', async () => {
    const rows: string[] = []
    const acceptedButNotLoaded: string[] = []
    const loadedButNotAccepted: string[] = []
    for (const item of ALL_CASES) {
      const { skillsDir, dir } = await place('r23w2-face-', item.bytes)
      const gate = await assertLoadableSkillMetadata(dir, 'alpha').then(
        () => 'accept',
        (cause: unknown) => cause instanceof ArchiveInstallRefusal ? `refuse:${cause.code}` : `throw:${String(cause)}`,
      )
      const discovered = (await discoverRuntimeSkills(skillsDir)).map(row => row.name)
      const panel = await listInstalledSkills(skillsDir)
      // 生产形态（helper 缺省就装 ctx.fs）—— 这才是"运行时到底加载了什么"的判据。
      const runtime = (await listRuntimeSkills(skillsDir)).map(skill => skill.name)
      // harness 的人造形态（不装 ctx.fs，走 node:fs 直读）：只作为"上一轮判据为什么瞎"的留痕。
      const harnessNoFs = (await listRuntimeSkills(skillsDir, { fs: false })).map(skill => skill.name)
      const loaded = runtime.includes('alpha')
      rows.push(`| ${item.label} | gate=${gate} | discover=${JSON.stringify(discovered)} | panel=${JSON.stringify(panel)} | runtime=${JSON.stringify(runtime)} | harness(noFs)=${JSON.stringify(harnessNoFs)} |`)
      if (gate === 'accept' && !loaded) acceptedButNotLoaded.push(item.label)
      if (loaded && gate !== 'accept') loadedButNotAccepted.push(item.label)
      expect(discovered.includes('alpha'), `${item.label}：发现面必须与运行时同集合`).toBe(loaded)
      expect(panel.includes('alpha'), `${item.label}：面板必须与运行时同集合`).toBe(loaded)
    }
    // eslint-disable-next-line no-console
    console.log(['| case | readings |', '|---|---|', ...rows].join('\n'))
    // 修前的签名就是"放行但运行时不加载"；这个集合必须为空。
    expect(acceptedButNotLoaded, '我们接受集合不得大于上游加载集合').toEqual([])
    expect(loadedButNotAccepted, '我们不得误杀运行时本来会加载的技能').toEqual([])
  }, 600_000)

  it('harness 人造形态（不装 ctx.fs）就是上一轮判据的盲区 —— 它读作"已加载"', async () => {
    const nul = NOT_TEXT_CASES[0]!
    const { skillsDir } = await place('r23w2-blind-', nul.bytes)
    const production = (await listRuntimeSkills(skillsDir)).map(skill => skill.name)
    const harnessNoFs = (await listRuntimeSkills(skillsDir, { fs: false })).map(skill => skill.name)
    expect(production, '生产形态：整份丢弃').toEqual([])
    expect(harnessNoFs, '不装 ctx.fs 的 harness 走 node:fs 直读 ⇒ 读作已加载（这正是判据的盲区）').toEqual(['alpha'])
    expect(await listInstalledSkills(skillsDir), '面板与生产形态同集合而非与盲区同集合').toEqual([])
  }, 120_000)
})

describe('R23-W2-01 端到端：装得上就必须加载得到（反向也成立）', () => {
  it('含 NUL 的归档装不上（旧实现：200 + ok:true、面板"已安装"、运行时为空）', async () => {
    const skillsDir = await emptySkillsDir('r23w2-e2e-nul-')
    const nul = NOT_TEXT_CASES[0]!
    const cause = await installSkillArchive({
      name: 'alpha', archive: archiveOf(nul.bytes), skillsDir, channel: 'market',
    }).then(() => undefined, (error: unknown) => error)
    expect(cause, '运行时读不出文本 ⇒ 安装必须被拒').toBeInstanceOf(ArchiveInstallRefusal)
    expect((cause as ArchiveInstallRefusal).code).toBe('SKILL_MD_NOT_TEXT')
    expect((cause as Error).message).toContain('NUL')
    expect(await listInstalledSkills(skillsDir)).toEqual([])
    expect((await listRuntimeSkills(skillsDir)).map(skill => skill.name)).toEqual([])
  }, 60_000)

  it('非法 UTF-8 的归档装不上，且文案点名"不是合法 UTF-8"', async () => {
    const skillsDir = await emptySkillsDir('r23w2-e2e-utf8-')
    const bad = NOT_TEXT_CASES[4]!
    const cause = await installSkillArchive({
      name: 'alpha', archive: archiveOf(bad.bytes), skillsDir, channel: 'market',
    }).then(() => undefined, (error: unknown) => error)
    expect(cause).toBeInstanceOf(ArchiveInstallRefusal)
    expect((cause as ArchiveInstallRefusal).code).toBe('SKILL_MD_NOT_TEXT')
    expect((cause as Error).message).toContain('UTF-8')
  }, 60_000)

  it('正向对照：合法文本归档装得上、面板列得出、运行时真加载', async () => {
    const skillsDir = await emptySkillsDir('r23w2-e2e-ok-')
    await installSkillArchive({ name: 'alpha', archive: archiveOf(GOOD), skillsDir, channel: 'market' })
    expect(await listInstalledSkills(skillsDir)).toEqual(['alpha'])
    expect((await listRuntimeSkills(skillsDir)).map(skill => skill.name)).toEqual(['alpha'])
  }, 60_000)

  it('发布预检面（packSkill）：含 NUL 的本地技能**发不出去**（旧实现预检 0 问题）', async () => {
    const nul = NOT_TEXT_CASES[0]!
    const home = await freshHome('r23w2-pack-')
    const skillsDir = join(home, 'skills')
    await mkdir(join(skillsDir, 'alpha'), { recursive: true })
    await writeFile(join(skillsDir, 'alpha', 'SKILL.md'), nul.bytes)
    const cause = await packSkill(skillsDir, 'alpha').then(() => undefined, (error: unknown) => error)
    expect(cause, '预检的输入是文本 ⇒ 解码层必须在打包面先拒').toBeInstanceOf(Error)
    expect((cause as Error).message).toMatch(/NUL/u)
  }, 60_000)

  it('发布预检面：BOM 这条**独立**的发布质量规则不得被解码层顺手吃掉', async () => {
    // 解码器（`TextDecoder`）会剥掉 BOM，而预检的 `BOM_DETECTED` 是发布面的质量
    // 规则 —— 打包面必须把**原样**文本交给预检，否则这条规则静默失效。
    const home = await freshHome('r23w2-pack-bom-')
    const skillsDir = join(home, 'skills')
    await mkdir(join(skillsDir, 'alpha'), { recursive: true })
    await writeFile(join(skillsDir, 'alpha', 'SKILL.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), GOOD]))
    // 显式给 version：BOM 前缀会让**宽松**的展示用读取器取不到 frontmatter version
    // （那是另一条独立行为），这里要测的是"预检拿到的文本里 BOM 还在不在"。
    const cause = await packSkill(skillsDir, 'alpha', '1.0.0').then(() => undefined, (error: unknown) => error)
    expect((cause as Error).message, '预检的输入必须仍是含 BOM 的那一份').toMatch(/BOM_DETECTED/u)
  }, 60_000)
})

describe('R23-W2-01 判据来源：读 pinned `fsio.ts`（上游放宽/改名即红）', () => {
  it('采样窗口常量与两条拒绝语义逐字对拍', async () => {
    const upstream = await readFile(UPSTREAM_FS_LOCAL_SOURCE, 'utf8')
    const constant = /const BINARY_SAMPLE_BYTES = (\d+)/u.exec(upstream)
    if (constant === null) throw new Error('上游 fs-local 里找不到 BINARY_SAMPLE_BYTES：判据失去输入必须红，请重新对拍')
    expect(Number(constant[1]), '我们的采样窗口必须逐字等于上游的 BINARY_SAMPLE_BYTES')
      .toBe(SKILL_TEXT_BINARY_SAMPLE_BYTES)

    // `readWholeText` 的两条拒绝语义：先采样 NUL，再整份 fatal UTF-8 解码。
    const readWholeText = /async function readWholeText[\s\S]*?\n\}/u.exec(upstream)?.[0]
    if (readWholeText === undefined) throw new Error('上游 fs-local 里找不到 readWholeText：判据失去输入必须红，请重新对拍')
    expect(readWholeText, '采样 NUL 的判据不得消失').toContain('raw.subarray(0, BINARY_SAMPLE_BYTES).includes(0)')
    expect(readWholeText, 'NUL ⇒ FS_NOT_TEXT').toContain("'FS_NOT_TEXT'")
    expect(readWholeText, '整份解码走 decodeUtf8').toMatch(/return decodeUtf8\(raw/u)
    expect(upstream, 'decodeUtf8 必须是 fatal 的 UTF-8 解码').toContain("new TextDecoder('utf-8', { fatal: true })")

    // 上游在 `ctx.fs` 存在时**必走** fs 读取（fs 缺失才回落 node:fs）—— harness 若不装
    // ctx.fs，读到的就不是生产形态。
    const skillSource = await readFile(
      join(dirname(UPSTREAM_FS_LOCAL_SOURCE), '..', '..', '..', 'skill', 'skill-filesystem', 'src', 'index.ts'),
      'utf8',
    )
    expect(skillSource, 'ctx.fs 存在时必须走 readSkillTextFromFileSystem').toMatch(/if \(fs !== undefined && !trustedHost\)/u)
    expect(skillSource, 'FS_NOT_TEXT ⇒ 整份技能被丢弃（只 warn）').toMatch(/hasErrorCode\(error, 'FS_NOT_TEXT'\)/u)
  })
})
