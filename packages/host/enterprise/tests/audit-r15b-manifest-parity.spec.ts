/// <reference types="node" />
/**
 * R15B-03：客户端"发布前预检"与服务端 `internal/skillmanifest` 的**跨端对拍**。
 *
 * ## 缺陷原形态
 *
 * `manifest-precheck.ts` 的限额表是**手抄字面量**（注释里就写着"与服务端一致"），
 * 既没有对拍守卫，又少了服务端 6 条规则（`MaxSkillMDBytes`、frontmatter 的深度/
 * 流式集合/列表项/锚点四条上限、`changelog` 长度），其中 `maxChangelog` 还是
 * **声明了却从没用过**的死常量。用户可见后果当时就成立：600 字的 `changelog`、
 * >128 KiB 的 `SKILL.md`、嵌套 40 层的 frontmatter 都能过预检（面板显示"预检
 * 通过"）而在上传后被服务端 422 拒 —— 正是预检要消灭的那类"上传才知道"的失败。
 *
 * ## 这份对拍做什么
 *
 * 真源只有一个：`server/internal/skillmanifest/manifest.go` 的 Go 常量。本文件
 * 用 `node:fs` 把它读出来，**逐值**对拍客户端的镜像；真源缺席（被删/改名/搬走）
 * ⇒ 用例**直接失败**，不是 skip（skip 会让"两端契约漂移"完全静默）。
 *
 * 五组判据：
 *  1. 限额逐值对拍（键名 → Go 常量的映射逐条登记，缺任一 Go 常量即红）；
 *  2. **没有死常量**：镜像表里的每个键都必须在规则体里被真正引用；
 *  3. **规则覆盖**：服务端的 6 条规则在预检里都有对应实现（按同一个键表）；
 *  4. merge key（`<<`）判定在**同一份语料**上与 Go 的正则逐例一致；
 *  5. 稳定错误码：客户端用到的码都必须在 Go 侧存在（含新增的 `INPUT_TOO_LARGE`）。
 *
 * ## 变异验证
 *  - 把 `LIMITS.maxSkillMdBytes` 改成 `64 * 1024` ⇒ 第 1、3 组红；
 *  - 删掉 `LIMITS.maxChangelog`（回到死常量状态）⇒ 第 2 组红；
 *  - 从规则体里删掉 `LIMITS.maxFrontmatterReferences` 的引用 ⇒ 第 2、3 组红；
 *  - 把 `MERGE_KEY_PATTERN` 放宽成 `/<<[ ]*:?/u` ⇒ 第 4 组红；
 *  - 改名 Go 的 `MaxFrontmatterIndicators` ⇒ 第 1 组红（fail-loud）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MERGE_KEY_PATTERN,
  LIMITS,
  PrecheckCode,
  precheckSkillPackage,
  scanFrontmatterComplexity,
} from '../src/manifest-precheck.ts'

/** 仓库根：从本文件（`packages/host/enterprise/tests/`）往上走四级。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

/** 服务端真源（限额、规则、错误码的唯一权威）。 */
const GO_REPO_PATH = 'server/internal/skillmanifest/manifest.go'
/** 客户端镜像（与上面同一份真源的两处执行点之一）。 */
const TS_REPO_PATH = 'packages/host/enterprise/src/manifest-precheck.ts'

/**
 * 读真源。**缺席即失败**（不返回 null、不 skip）：真源被删/改名是"必须有人来看"
 * 的事件，静默跳过等于把两端契约漂移变成不可观测。
 * @param relative - 仓库内相对路径。
 * @returns 文件全文。
 */
function readSource(relative: string): string {
  try {
    return readFileSync(join(REPO_ROOT, relative), 'utf8')
  } catch (cause) {
    throw new Error(`跨端对拍的真源读不到：${relative}（${cause instanceof Error ? cause.message : String(cause)}）—— 这条用例不允许 skip`)
  }
}

const GO = readSource(GO_REPO_PATH)
const TS = readSource(TS_REPO_PATH)

/** 从 Go 常量块里取 `Name = 数字` 与 `Name = 数字 << 数字`（左移按 Go 语义求值）。 */
function goConstants(text: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const match of text.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*(\d+)\s*$/gmu)) {
    out.set(match[1]!, Number(match[2]))
  }
  for (const match of text.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*=\s*(\d+)\s*<<\s*(\d+)\s*$/gmu)) {
    out.set(match[1]!, Number(match[2]) << Number(match[3]))
  }
  return out
}

const GO_CONSTS = goConstants(GO)

/**
 * 客户端键 → Go 常量。两边命名惯例不同（`maxTitle` vs `MaxTitleRunes`），所以
 * 逐条登记 —— 这正是"看起来一致"最会骗人的地方。
 */
const LIMIT_PAIRS: ReadonlyArray<readonly [keyof typeof LIMITS, string]> = [
  ['minAppId', 'MinAppIDLen'],
  ['maxAppId', 'MaxAppIDLen'],
  ['maxTitle', 'MaxTitleRunes'],
  ['minDescription', 'MinDescriptionRunes'],
  ['maxDescription', 'MaxDescriptionRunes'],
  ['maxAuthor', 'MaxAuthorRunes'],
  ['maxCategory', 'MaxCategoryRunes'],
  ['maxChangelog', 'MaxChangelogRunes'],
  ['maxTags', 'MaxTags'],
  ['maxTagRunes', 'MaxTagRunes'],
  ['minBody', 'MinBodyRunes'],
  ['maxSkillMdBytes', 'MaxSkillMDBytes'],
  ['maxFrontmatterDepth', 'MaxFrontmatterDepth'],
  ['maxFrontmatterCollections', 'MaxFrontmatterCollections'],
  ['maxFrontmatterIndicators', 'MaxFrontmatterIndicators'],
  ['maxFrontmatterReferences', 'MaxFrontmatterReferences'],
]

/** 规则体（LIMITS 表本身之外的部分）—— "有没有真的用到这个键"只在这里找。 */
const TS_RULES = TS.slice(TS.indexOf('} as const', TS.indexOf('export const LIMITS')))

describe('R15B-03 预检限额表 ↔ 服务端 skillmanifest 逐值对拍', () => {
  it('真源在（fail-loud，不是 skip）', () => {
    expect(GO.length).toBeGreaterThan(0)
    expect(GO_CONSTS.size).toBeGreaterThan(10)
  })

  it.each(LIMIT_PAIRS)('%s ↔ Go 的 %s：数值必须逐字相同', (tsKey, goKey) => {
    const goValue = GO_CONSTS.get(goKey)
    // Go 侧常量消失 = 服务端改名/删规则 ⇒ 镜像必须同步，不能静默留旧值。
    expect(goValue, `服务端常量 ${goKey} 在 ${GO_REPO_PATH} 里找不到（改名或删除了？）`).toBeTypeOf('number')
    expect(LIMITS[tsKey], `${tsKey} 与服务端 ${goKey} 不一致`).toBe(goValue)
  })

  it('镜像表里没有死常量：每个键都在规则体里被真正引用', () => {
    const unused = Object.keys(LIMITS).filter((key) => !TS_RULES.includes(`LIMITS.${key}`))
    expect(unused, `声明了却没用到的限额（正是 R15B-03 的死常量形态）：${unused.join(', ')}`).toEqual([])
  })

  it('服务端每条规则在预检里都有实现（6 条曾经缺失的规则按名覆盖）', () => {
    const required = [
      'MaxSkillMDBytes',
      'MaxFrontmatterDepth',
      'MaxFrontmatterCollections',
      'MaxFrontmatterIndicators',
      'MaxFrontmatterReferences',
      'MaxChangelogRunes',
    ] as const
    const covered = new Set(LIMIT_PAIRS.map(([, goKey]) => goKey))
    const missing = required.filter((name) => !covered.has(name) || GO_CONSTS.get(name) === undefined)
    expect(missing, `服务端有、预检完全没实现的规则：${missing.join(', ')}`).toEqual([])
  })

  it('merge key（<<）的判定与 Go 的 reMergeKey 在同一份语料上逐例一致', () => {
    // 从 Go 源码里把 `regexp.MustCompile(` + "`…`" + `)` 的字面量读出来 ——
    // 不是两边各写一个"看起来一样"的正则。
    const literal = /var reMergeKey = regexp\.MustCompile\(`([^`]*)`\)/u.exec(GO)
    expect(literal, 'Go 的 reMergeKey 定义读不到（改名了？）').not.toBeNull()
    const goPattern = new RegExp(literal![1]!, 'u')

    const corpus = [
      'title: x',
      '<<: *base',
      '<<:*base',
      '{<<: *a}',
      'a: b << c',
      'a: <<b',
      'a: <<: b',
      '  <<   : *base',
      'description: 1 << 2 位移说明',
      '',
    ]
    for (const sample of corpus) {
      expect(MERGE_KEY_PATTERN.test(sample), `客户端与 Go 对 ${JSON.stringify(sample)} 的判定不一致`).toBe(goPattern.test(sample))
    }
  })

  it('稳定错误码：客户端用到的码在 Go 侧都存在，且新增的 INPUT_TOO_LARGE 两端齐备', () => {
    const goCodes = new Set([...GO.matchAll(/^\s*Code[A-Za-z]+\s*=\s*"([A-Z_]+)"\s*$/gmu)].map((m) => m[1]!))
    expect(goCodes.has(PrecheckCode.InputTooLarge)).toBe(true)
    for (const code of Object.values(PrecheckCode)) {
      expect(goCodes.has(code), `客户端错误码 ${code} 在服务端不存在`).toBe(true)
    }
  })
})

// ------------------------------------------------------------------ 规则行为

const HEAD = '---\n'
const TAIL = '---\n'

/** 拼一份 SKILL.md（frontmatter 逐行给）。 */
function skillMd(frontmatter: readonly string[], body = 'x'.repeat(60)): string {
  return `${HEAD}${frontmatter.join('\n')}\n${TAIL}${body}\n`
}

const VALID_FRONT = [
  'name: demo-skill',
  'version: 1.0.0',
  'title: 示例技能',
  'description: 这是一段足够长的描述,用于通过预检的描述长度下限要求。',
  'author: tester',
  'category: security',
]

const codesOf = (issues: Array<{ code: string }>): string[] => issues.map((i) => i.code)

describe('R15B-03 新补齐的规则真的会拒（不是只加常量）', () => {
  it('基线：合法包装过预检', () => {
    expect(precheckSkillPackage(skillMd(VALID_FRONT), 'demo-skill')).toEqual([])
  })

  it('>128 KiB 的 SKILL.md ⇒ INPUT_TOO_LARGE（按字节，与服务端 len(raw) 同口径）', () => {
    const huge = skillMd(VALID_FRONT, 'x'.repeat(LIMITS.maxSkillMdBytes))
    const issues = precheckSkillPackage(huge, 'demo-skill')
    expect(codesOf(issues)).toEqual([PrecheckCode.InputTooLarge])

    // 边界：恰好等于上限（字节数）时通过规模闸（下面会因为正文过长而没事，
    // 所以这里用一份正文短、但正好补到上限的文档）。
    const pad = LIMITS.maxSkillMdBytes - Buffer.byteLength(skillMd(VALID_FRONT), 'utf8')
    expect(pad).toBeGreaterThan(0)
    expect(codesOf(precheckSkillPackage(skillMd(VALID_FRONT, 'x'.repeat(59 + pad)), 'demo-skill'))).toEqual([])
  })

  it('frontmatter 嵌套 40 层 ⇒ FRONTMATTER_INVALID（深度闸，先于 YAML 解析）', () => {
    const nested = `${'['.repeat(40)}${']'.repeat(40)}`
    const issues = precheckSkillPackage(skillMd([...VALID_FRONT, `extra: ${nested}`]), 'demo-skill')
    expect(codesOf(issues)).toEqual([PrecheckCode.FrontmatterInvalid])
    expect(issues[0]!.message).toContain('嵌套过深')
  })

  it('流式集合 / 块序列 / 锚点三类字符炸弹各自被拒（与服务端同一遍扫描同三个计数）', () => {
    const budget = scanFrontmatterComplexity(`${'['.repeat(300)}`)
    expect(budget.collections).toBe(300)
    const many = precheckSkillPackage(skillMd([...VALID_FRONT, `extra: "${'&'.repeat(1100)}"`]), 'demo-skill')
    expect(codesOf(many)).toEqual([PrecheckCode.FrontmatterInvalid])

    // 块序列指示符：'- ' 单独成行 —— 纯 `-`（kebab-case 连字符）不计数。
    const dashes = `${'- \n'.repeat(300)}`
    expect(scanFrontmatterComplexity(dashes).indicators).toBe(300)
    expect(scanFrontmatterComplexity('name: a-b-c').indicators).toBe(0)
  })

  it('YAML merge key ⇒ FRONTMATTER_INVALID（指数解码构造，服务端零误杀的硬拒绝）', () => {
    const issues = precheckSkillPackage(skillMd([...VALID_FRONT, '<<: *base']), 'demo-skill')
    expect(codesOf(issues)).toEqual([PrecheckCode.FrontmatterInvalid])
    expect(issues[0]!.message).toContain('merge key')
    // 反证：普通的 `<<` 文本（不是 merge key）不误杀。
    expect(precheckSkillPackage(skillMd([...VALID_FRONT, 'note: 1 << 2']), 'demo-skill')).toEqual([])
  })

  it('600 字的 changelog ⇒ FIELD_TOO_LONG（死常量接上了）', () => {
    const issues = precheckSkillPackage(skillMd([...VALID_FRONT, `changelog: ${'修'.repeat(600)}`]), 'demo-skill')
    expect(codesOf(issues)).toEqual([PrecheckCode.FieldTooLong])
    expect(issues[0]!.field).toBe('changelog')
    // 边界：恰好 500 字通过；非字符串按 INVALID_TYPE（与服务端 optionalString 同口径）。
    expect(precheckSkillPackage(skillMd([...VALID_FRONT, `changelog: ${'修'.repeat(LIMITS.maxChangelog)}`]), 'demo-skill')).toEqual([])
    expect(codesOf(precheckSkillPackage(skillMd([...VALID_FRONT, 'changelog: [a, b]']), 'demo-skill'))).toEqual([PrecheckCode.InvalidType])
  })
})
