/**
 * tests/skill-channel-parity.spec.ts — 独立复审 r3 **F4** 的回归：
 * 「随包同步器」与「能力中心安装器」之间那些**必须同值**的契约，此前是两份手写
 * 常量 + 一句"改真源必须同步改这里"的注释，**没有任何机器判据**。
 *
 * 为什么必须对拍（漂移的后果）：
 *   - **渠道集合**（`STORE_PROVENANCE_CHANNELS` ↔ `STORE_CHANNELS`）：真源新增/改名
 *     渠道时，同步器会把"新渠道装进来的同名技能"当成**用户自制**（或反过来）⇒
 *     回到本次要修的静默覆盖/误拒类别；
 *   - **per-name 锁**（F3 的修复）：两端必须锁在**同一个落点**上，否则"互斥"只是
 *     各自以为自己锁住了 —— 复审实测的终态（内容是插件版 + 溯源是市场版、且不可
 *     自愈）会原样复现；
 *   - **标记落点**（`.picoaide/release.json`）：两端读写同一个文件才有"归属"可言。
 *
 * 判据按仓库既有的跨端对拍风格写：**读对方源码文本**（不是 import —— vendored 包与
 * 企业包之间禁止跨包 import），集合相等，**找不到字面量即 throw**（缺失不能被静默
 * 当成"空集合相等"）。
 *
 * 变异验证：只改一侧（例如把 `skills-sync.js` 的 `SKILL_LOCK_DIR` 改成 `.skill-lock`
 * 或从 `STORE_CHANNELS` 里删掉 `'plugin'`）⇒ 本文件必红。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeSkillContentHash } from '../src/skill-install.ts'
// @ts-expect-error vendored plain JS (no types)
import { skillContentChecksum } from '../../../vendor/memory-evolve/lib/coi/skills-sync.js'
// @ts-expect-error vendored plain JS (no types)
import { toggleDisableFlag } from '../../../vendor/memory-evolve/lib/skill-manifest.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTERPRISE_FILE = join(HERE, '..', 'src', 'skill-install.ts')
const VENDOR_FILE = join(HERE, '..', '..', '..', 'vendor', 'memory-evolve', 'lib', 'coi', 'skills-sync.js')
/** 禁用字段（N1b）的唯一实现：vendored 的 `lib/skill-manifest.js`。 */
const VENDOR_MANIFEST_FILE = join(HERE, '..', '..', '..', 'vendor', 'memory-evolve', 'lib', 'skill-manifest.js')
const enterpriseSrc = readFileSync(ENTERPRISE_FILE, 'utf8')
const vendorSrc = readFileSync(VENDOR_FILE, 'utf8')

/**
 * 取一段字面量（找不到即 throw：对拍的前提是两端都还写着这份契约）。
 * @param source - 源文件正文。
 * @param pattern - 带一个捕获组的正则。
 * @param label - 契约名（报错用）。
 * @param file - 源文件路径（报错用）。
 * @returns 捕获到的原文。
 */
function literal(source: string, pattern: RegExp, label: string, file: string): string {
  const match = pattern.exec(source)
  if (match === null || match[1] === undefined) {
    throw new Error(`跨端对拍失败：在 ${file} 里找不到 ${label}（改契约必须两端同步改，并保持本用例可解析）`)
  }
  return match[1]
}

/**
 * 解析一个"字符串数组"字面量：支持字符串常量与同文件里的 `const X = '…'` 标识符。
 * @param source - 源文件正文。
 * @param pattern - 匹配数组字面量的正则（捕获组 = 括号内的表达式）。
 * @param label - 契约名。
 * @param file - 源文件路径。
 * @returns 解析后的取值集合（已排序去重）。
 */
function stringSet(source: string, pattern: RegExp, label: string, file: string): string[] {
  const consts = new Map<string, string>()
  for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*'([^']*)'/gu)) {
    consts.set(match[1] as string, match[2] as string)
  }
  const body = literal(source, pattern, label, file)
  const values = body
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '')
    .map((token) => {
      const quoted = /^'([^']*)'$/u.exec(token)
      if (quoted !== null) return quoted[1] as string
      const resolved = consts.get(token)
      if (resolved === undefined) {
        throw new Error(`跨端对拍失败：${file} 的 ${label} 里有无法解析的取值 ${token}（写成字符串字面量，或在本文件里给出 const 定义）`)
      }
      return resolved
    })
  return [...new Set(values)].sort()
}

describe('F4 跨端契约对拍（读对方源码文本，找不到即 throw）', () => {
  it('渠道集合：STORE_PROVENANCE_CHANNELS（安装器真源）=== STORE_CHANNELS（同步器副本）', () => {
    const enterpriseChannels = stringSet(
      enterpriseSrc,
      /STORE_PROVENANCE_CHANNELS[^=]*=\s*\[([^\]]*)\]/u,
      'STORE_PROVENANCE_CHANNELS',
      ENTERPRISE_FILE,
    )
    const vendorChannels = stringSet(vendorSrc, /STORE_CHANNELS\s*=\s*\[([^\]]*)\]/u, 'STORE_CHANNELS', VENDOR_FILE)

    expect(vendorChannels, '同步器副本的渠道集合必须与安装器真源逐项相同').toEqual(enterpriseChannels)
    // 集合本身也要有内容：空的"两边都空"不算通过。
    expect(enterpriseChannels.length).toBeGreaterThanOrEqual(4)
    expect(enterpriseChannels).toContain('plugin')
  })

  it('per-name 锁：落点目录 / 文件名后缀 / 陈旧阈值两端同值', () => {
    const pairs = [
      ['SKILL_LOCK_DIR', /const SKILL_LOCK_DIR = '([^']+)'/u],
      ['SKILL_LOCK_SUFFIX', /const SKILL_LOCK_SUFFIX = '([^']+)'/u],
      ['SKILL_LOCK_STALE_MS', /const SKILL_LOCK_STALE_MS = ([\d_]+)/u],
    ] as const
    for (const [label, pattern] of pairs) {
      const fromEnterprise = literal(enterpriseSrc, pattern, label, ENTERPRISE_FILE).replaceAll('_', '')
      const fromVendor = literal(vendorSrc, pattern, label, VENDOR_FILE).replaceAll('_', '')
      expect(fromVendor, `${label} 两端必须同值（否则"互斥"只是各自以为锁住了）`).toBe(fromEnterprise)
    }
  })

  it('锁竞争的拒绝码两端同值（同步侧 code / 安装器侧 error.code）', () => {
    const fromVendor = literal(vendorSrc, /const SKILL_LOCKED = '([^']+)'/u, 'SKILL_LOCKED', VENDOR_FILE)
    const fromEnterprise = literal(enterpriseSrc, /readonly code = '([^']+)'/u, 'SkillLockedError.code', ENTERPRISE_FILE)
    expect(fromVendor, '同一件事（拿不到 per-name 锁）两端必须报同一个码，否则排障与面板兜底会对不上').toBe(fromEnterprise)
  })

  it('安装器标记落点（.picoaide / release.json）两端同值', () => {
    const dirPattern = /const PROVENANCE_DIR = '([^']+)'/u
    expect(literal(vendorSrc, dirPattern, 'PROVENANCE_DIR', VENDOR_FILE))
      .toBe(literal(enterpriseSrc, dirPattern, 'PROVENANCE_DIR', ENTERPRISE_FILE))
    // 文件名在两侧都是内联字面量（安装器 writeProvenance / 同步器 PROVENANCE_FILE）。
    const filePattern = /(?:PROVENANCE_FILE\s*=\s*|join\([^)]*PROVENANCE_DIR,\s*)'([^']+)'/u
    expect(literal(vendorSrc, filePattern, 'release.json', VENDOR_FILE))
      .toBe(literal(enterpriseSrc, filePattern, 'release.json', ENTERPRISE_FILE))
  })

  it('R4-B-2：换入临时区的落点（SKILL_TEMP_DIR）两端同值', () => {
    // 前端（安装器）与随包同步器都把"未就位的副本"藏在技能库的第二层私有目录里；
    // 两处必须同值，否则两边的清扫器会各扫各的、并且"第二层不可见"这条结构判据
    // 只在其中一侧成立（另一侧会把临时目录写回技能库根 ⇒ 上游按 frontmatter 索引它）。
    const pattern = /const SKILL_TEMP_DIR = '([^']+)'/u
    expect(literal(vendorSrc, pattern, 'SKILL_TEMP_DIR', VENDOR_FILE))
      .toBe(literal(enterpriseSrc, pattern, 'SKILL_TEMP_DIR', ENTERPRISE_FILE))
    expect(literal(enterpriseSrc, pattern, 'SKILL_TEMP_DIR', ENTERPRISE_FILE)).toBe('.skill-tmp')
  })

  it('R4-B-4：用户卸载墓碑的落点与文件名两端同值', () => {
    // 安装器写墓碑（uninstallSkill）、同步器读墓碑（readSkillTombstone）；落点或
    // 文件名漂移的后果是"卸载还是不持久"（两边各写各的、谁也读不到谁）。
    const dirPattern = /const SKILL_REMOVED_DIR = '([^']+)'/u
    expect(literal(vendorSrc, dirPattern, 'SKILL_REMOVED_DIR', VENDOR_FILE))
      .toBe(literal(enterpriseSrc, dirPattern, 'SKILL_REMOVED_DIR', ENTERPRISE_FILE))
    expect(literal(enterpriseSrc, dirPattern, 'SKILL_REMOVED_DIR', ENTERPRISE_FILE)).toBe('.skill-removed')
    // 墓碑文件名：安装器写成 `` `${name}.json` ``、同步器读同一个形状。
    for (const [file, source, label] of [
      [ENTERPRISE_FILE, enterpriseSrc, '安装器（writeSkillTombstone）'],
      [VENDOR_FILE, vendorSrc, '同步器（readSkillTombstone）'],
    ] as const) {
      expect(
        /`\$\{name\}\.json`/u.test(source),
        `${file} 里找不到 ${label} 的墓碑文件名：两侧必须都是 <name>.json`,
      ).toBe(true)
    }
    // 墓碑判据的关键字段（channel 必须等于 plugin）两端同源。
    const channelPattern = /const PLUGIN_CHANNEL = '([^']+)'/u
    expect(literal(vendorSrc, channelPattern, 'PLUGIN_CHANNEL', VENDOR_FILE))
      .toBe(literal(enterpriseSrc, /export type SkillProvenanceChannel = 'market' \| 'org' \| 'builtin' \| '([^']+)'/u, 'SkillProvenanceChannel 的 plugin 取值', ENTERPRISE_FILE))
  })
})

// ---------------------------------------------------------------------------
// R4-D-8：技能名语法**四处**同源
//
// 同一 grammar `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` 在四个文件里各写一份：
//   ① `src/skill-install.ts`（安装器，**有**对拍：`skill-install.spec.ts` 读 pinned 上游
//      的 `isSkillName` 逐例比）；
//   ②③④ `packages/vendor/memory-evolve/lib/{skills.js,skills-manager.js,coi/skills-sync.js}`
//      ——此前只有一句"与 dsh-skill 一致"的注释，**没有任何判据**读上游或读彼此。
//
// 为什么必须对拍：同一个技能库 `<DSH_HOME>/skills` 有两个写入者（HTTP 安装链路 vs
// 随包同步），2026-09-23 的 A1 事故形态正是"安装器的名字规则比运行时宽 ⇒ 安装成功
// 但运行时**静默忽略**（`ignored: invalid skill name`）、界面无提示"。只要任一份语法
// 被放宽（或上游升级改了规则、我们只跟着改了其中一份），同一症状就会从另一个入口复现；
// 而 `skills-sync.js` 的 `SKILL_NAME_RE` 还是**导出面**，改它甚至不会有测试报警。
//
// 判据读**源码文本**（vendored 包与企业包之间禁止跨包 import），解析不到即 throw。
// **已知差异（有意保留、登记在此）**：三份 vendored 副本没有长度上限（企业侧是 64），
// 加长度检查属于 vendored 包的行为变更，需按三方合并流程单独评审 —— 本用例只在企业侧
// 钉住 64，并保证四处**语法本体**逐字一致。
// ---------------------------------------------------------------------------

describe('R4-D-8 技能名语法四处同源', () => {
  const VENDOR_SKILLS_FILE = join(HERE, '..', '..', '..', 'vendor', 'memory-evolve', 'lib', 'skills.js')
  const VENDOR_MANAGER_FILE = join(HERE, '..', '..', '..', 'vendor', 'memory-evolve', 'lib', 'skills-manager.js')

  /**
   * 取 `const NAME = /…/flags` 的**正则源文本**（去掉两侧斜杠与 flags；两侧写法不同：
   * 企业侧带 `u` 后缀、vendored 侧不带）。
   * @param source - 源文件正文。
   * @param name - 常量名。
   * @param file - 源文件路径（报错用）。
   * @returns 正则本体文本。
   */
  const grammarOf = (source: string, name: string, file: string): string => {
    const pattern = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*/([^/\\n]+)/[a-z]*`, 'u')
    const match = pattern.exec(source)
    if (match === null || match[1] === undefined) {
      throw new Error(`跨端对拍失败：在 ${file} 里找不到 ${name} 的正则字面量（改语法必须四处同步，并保持本用例可解析）`)
    }
    return match[1]
  }

  const ENTERPRISE_GRAMMAR = grammarOf(enterpriseSrc, 'SKILL_NAME_PATTERN', ENTERPRISE_FILE)

  it('企业侧语法自证：锚定且非平凡（防止"四处一起放宽"这种假绿）', () => {
    expect(ENTERPRISE_GRAMMAR.startsWith('^'), '技能名语法必须锚定开头').toBe(true)
    expect(ENTERPRISE_GRAMMAR.endsWith('$'), '技能名语法必须锚定结尾').toBe(true)
    // `my.skill` / `my_skill` / `alpha--beta` 都不该通过（A1 的现场）。
    const re = new RegExp(ENTERPRISE_GRAMMAR, 'u')
    for (const bad of ['my.skill', 'my_skill', 'alpha--beta', '-lead', 'trail-']) {
      expect(re.test(bad), `企业侧语法不应接受 ${bad}`).toBe(false)
    }
    expect(re.test('memory-consolidate'), '企业侧语法必须接受正常的 kebab-case 名').toBe(true)
  })

  it('vendored 三份语法与企业侧逐字一致，且常量**真的被用**（不是死常量）', () => {
    const copies: Array<[string, string, string]> = [
      ['lib/skills.js', VENDOR_SKILLS_FILE, 'SKILL_NAME'],
      ['lib/skills-manager.js', VENDOR_MANAGER_FILE, 'SKILL_NAME_RE'],
      ['lib/coi/skills-sync.js', VENDOR_FILE, 'SKILL_NAME_RE'],
    ]
    for (const [label, file, name] of copies) {
      const source = readFileSync(file, 'utf8')
      expect(
        grammarOf(source, name, file),
        `${label} 的技能名语法必须与企业侧 SKILL_NAME_PATTERN 逐字一致（放宽一份 = 装得上但永远加载不到）`,
      ).toBe(ENTERPRISE_GRAMMAR)
      // 常量存在但没人用 = 校验静默消失（常量还在、门已经没了）。
      expect(source, `${label} 的 ${name} 必须真的参与校验（找不到 \`${name}.test(\`）`).toContain(`${name}.test(`)
    }
  })

  it('企业侧长度上限仍是 64（vendored 三份**刻意**没有上限，属已登记差异）', () => {
    expect(
      literal(enterpriseSrc, /MAX_SKILL_NAME_LENGTH = (\d+)/u, 'MAX_SKILL_NAME_LENGTH', ENTERPRISE_FILE),
      '安装器目录段上限必须与 skillmanifest 的 64 保持一致',
    ).toBe('64')
  })
})

// ---------------------------------------------------------------------------
// N1：内容基准哈希**行为对拍**（独立复审 2026-09-23）
//
// 「这份技能是否被本地改过」的判据是"盘上内容哈希 vs 上次写下的基准"，而基准有
// **两个写者**：安装器（`computeSkillContentHash`，写 `archiveChecksum`）与随包
// 同步器（`skillContentChecksum`，写 `channel:'plugin'` 落点的 `archiveChecksum`）。
// 跨包 import 禁止 ⇒ 两份实现各自持有，于是"逐字节同源"必须由机器判据钉住：
// 任何一侧改了遍历顺序 / 前缀（`D:` `F:`）/ 分隔符 / 排除规则，都会让随包技能
// **恒判脏**（每次开机都拒收）或**恒不判脏**（回到 N1 的静默覆盖）。
//
// 判据是行为，不是源码文本：同一批真实 fixture 两侧都必须给出**同一个**哈希。
// 上面那组"读源码文本"的对拍对这两份实现无效（它们读的是字面量，不是算法）。
// ---------------------------------------------------------------------------

/**
 * 造一棵"什么都有"的技能树（模块级夹具，N1 与 N1b 两组共用）：嵌套目录 / 空目录 / 二进制 / 非 ASCII 名 /
 * 大小写与连字符（`localeCompare` 与字节序不同的名字）/ 符号链接 / 顶层 `.picoaide`。
 * 创建顺序刻意与排序顺序相反（先 z 后 a），任何"按 readdir 原始顺序"的实现都会分叉。
 * @param dir - 目标目录（必须已存在）。
 */
const buildParityTree = async (dir: string): Promise<void> => {
  await mkdir(join(dir, 'scripts', 'nested'), { recursive: true })
  await mkdir(join(dir, 'references'), { recursive: true }) // 空目录（必须进哈希）
  await mkdir(join(dir, '.picoaide'), { recursive: true }) // 顶层私有目录（必须被排除）
  await writeFile(join(dir, 'scripts', 'zz.mjs'), 'zz\n')
  await writeFile(join(dir, 'scripts', 'aa.mjs'), 'aa\n')
  await writeFile(join(dir, 'scripts', 'nested', 'deep.txt'), 'deep\n')
  await writeFile(join(dir, 'SKILL.md'), '---\nname: probe\n---\n\nbody\n')
  await writeFile(join(dir, '.install-version'), '7') // 内容的一部分（不是私有目录）
  await writeFile(join(dir, 'a-b.md'), 'dash\n')
  await writeFile(join(dir, 'aB.md'), 'camel\n')
  await writeFile(join(dir, '二进制.bin'), Buffer.from([0, 1, 2, 255, 0, 65]))
  await writeFile(join(dir, '.picoaide', 'release.json'), '{"appId":"probe"}\n')
  await symlink(join(dir, 'SKILL.md'), join(dir, 'link-to-skill.md')) // 两侧都按"不看"处理
}

describe('N1 内容基准哈希：安装器 computeSkillContentHash === 同步器 skillContentChecksum', () => {
  it('同一棵树：两侧哈希逐字相同；内容变了两侧一起变且仍相同', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-hash-parity-'))
    try {
      await buildParityTree(root)
      const fromInstaller = await computeSkillContentHash(root)
      const fromSync = skillContentChecksum(root)
      expect(fromSync, '同步器写下的基准与安装器重算的值必须逐字节相同（否则随包技能恒判脏/恒不判脏）').toBe(fromInstaller)

      await writeFile(join(root, 'scripts', 'nested', 'deep.txt'), 'deep EDITED\n')
      const editedInstaller = await computeSkillContentHash(root)
      const editedSync = skillContentChecksum(root)
      expect(editedSync, '内容变了之后两侧仍必须相同').toBe(editedInstaller)
      expect(editedInstaller, 'fixture 不是恒等函数：改一个字节必须换一个哈希').not.toBe(fromInstaller)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('顶层 .picoaide/ 两侧都排除（写溯源本身不得让这份内容变脏）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-hash-parity-'))
    try {
      await buildParityTree(root)
      const before = skillContentChecksum(root)
      await writeFile(join(root, '.picoaide', 'release.json'), '{"appId":"probe","archiveChecksum":"x"}\n')
      await writeFile(join(root, '.picoaide', 'extra.json'), '{}\n')
      expect(skillContentChecksum(root)).toBe(before)
      expect(await computeSkillContentHash(root)).toBe(before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('.install-version 两侧都**计入**（所以同步器必须先写它、再算基准）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-hash-parity-'))
    try {
      await buildParityTree(root)
      const before = skillContentChecksum(root)
      await writeFile(join(root, '.install-version'), '8')
      expect(skillContentChecksum(root), '.install-version 是内容树的一部分（安装器只排除顶层 .picoaide）').not.toBe(before)
      expect(skillContentChecksum(root)).toBe(await computeSkillContentHash(root))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// N1b：平台管理的 frontmatter 字段（「技能管理」禁用开关写的
// `disable-model-invocation`）**不进内容哈希** —— 复审 R5-B-4 的根因是
// "写入端（skills-manager）与哈希端对同一个字段的定义不同"。两端必须一致：
// 字段名同值（源文本对拍）+ 归一化行为同值（真实文件对拍）。
// ---------------------------------------------------------------------------

describe('N1b 禁用字段：两端同值且都不进内容哈希', () => {
  it('字段名两端同值（改一侧即红）', () => {
    const pattern = /DISABLE_MODEL_KEY = '([^']+)'/u
    const fromEnterprise = literal(enterpriseSrc, pattern, 'DISABLE_MODEL_KEY', ENTERPRISE_FILE)
    const fromVendor = literal(readFileSync(VENDOR_MANIFEST_FILE, 'utf8'), pattern, 'DISABLE_MODEL_KEY', VENDOR_MANIFEST_FILE)
    expect(fromVendor, '禁用字段名必须是同一个（写入端在 vendored，哈希端两侧都有）').toBe(fromEnterprise)
    expect(fromEnterprise).toBe('disable-model-invocation')
  })

  it('写入/清除该字段：两侧哈希都不变；改正文：两侧都变且仍相同', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pico-hash-n1b-'))
    try {
      await buildParityTree(root)
      const base = await computeSkillContentHash(root)
      expect(skillContentChecksum(root)).toBe(base)

      const mdPath = join(root, 'SKILL.md')
      const plain = readFileSync(mdPath, 'utf8')
      const withFlag = toggleDisableFlag(plain, true) as string
      expect(withFlag, '夹具必须能加上禁用标记').not.toBe(plain)
      await writeFile(mdPath, withFlag)
      expect(await computeSkillContentHash(root), '禁用是平台动作，不是"用户改了内容"').toBe(base)
      expect(skillContentChecksum(root)).toBe(base)

      // 反向对照：归一化只剔除该字段，正文改动照样判脏（两侧一致）。
      await writeFile(mdPath, withFlag.replace('body', 'body EDITED'))
      const editedInstaller = await computeSkillContentHash(root)
      expect(editedInstaller).not.toBe(base)
      expect(skillContentChecksum(root)).toBe(editedInstaller)

      // 清除标记（启用）：回到基准 —— 开关是双向不可见的。
      await writeFile(mdPath, toggleDisableFlag(withFlag, false) as string)
      expect(await computeSkillContentHash(root)).toBe(base)
      expect(skillContentChecksum(root)).toBe(base)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
