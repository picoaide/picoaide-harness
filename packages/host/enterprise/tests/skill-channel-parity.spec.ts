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
})
