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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTERPRISE_FILE = join(HERE, '..', 'src', 'skill-install.ts')
const VENDOR_FILE = join(HERE, '..', '..', '..', 'vendor', 'memory-evolve', 'lib', 'coi', 'skills-sync.js')

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
