/// <reference types="node" />
/**
 * **跨端版本先后语义的共享语料对拍**（R4-D-1 / 2026-09-23 第四轮审计，P1）。
 *
 * 本包是客户端里第二份比较实现（`src/updates.ts` 的 `compareVersions`，用于"上次下载的
 * 安装包还能不能复用"）。审计认定它当时就是 SemVer-correct 的，但**没有任何判据**把这件事
 * 固定下来 —— 而企业包的 `version-compare.ts`（能力中心的版本先后）恰恰是错的那份，
 * 客户端内部自己就两种结论。修法有两半：企业包改成服务端语义 + 两处客户端实现都读**同一份
 * 仓内语料**逐条对拍（真源 `server/internal/util/testdata/semver-corpus.json`）。
 *
 * 三层判据（同企业包，缺任一层都会被"看起来改好了"骗过）：
 *  1. 逐条：`signOf(compareVersions(left, right))` == 语料里的 `want`，并断言反对称；
 *  2. 完整性：必备对写死在判据里（不读语料）—— 语料被裁剪即红；
 *  3. 规模下限：`cases.length >= 20`。
 *
 * 变异验证：把 `compareVersions` 换成按整串字典序比较 ⇒ 分叉对与 §11 链成片红；
 * 把语料里的两对分叉删掉 ⇒ 第 2 层红。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compareVersions } from '../src/updates.ts'

/** 与 Go 侧同一个相对路径（相对**仓库根**解析：测试 cwd 是包目录）。 */
const CORPUS_URL = new URL('../../../../server/internal/util/testdata/semver-corpus.json', import.meta.url)

interface CorpusCase {
  id: string
  left: string
  right: string
  want: number
  note?: string
}

/**
 * 必备对：写死在判据里（与语料文件解耦）。语料是数据，判据不能只信数据 ——
 * 一个"遍历语料"的用例在语料被裁剪后反而全绿，这份清单就是裁剪的探针。
 */
const REQUIRED_PAIRS: readonly (readonly [string, string])[] = [
  ['1.0.0-rc10', '1.0.0-rc2'], // R4-D-1 分叉对①
  ['1.0.0-rc1', '1.0.0-rc.1'], // R4-D-1 分叉对②
  ['1.0.0+build.1', '1.0.0'], // §10 build metadata 忽略
  ['1.0.0-alpha', '1.0.0-alpha.1'], // §11 规范样例链
  ['1.0.0-alpha.1', '1.0.0-alpha.beta'],
  ['1.0.0-alpha.beta', '1.0.0-beta'],
  ['1.0.0-beta', '1.0.0-beta.2'],
  ['1.0.0-beta.2', '1.0.0-beta.11'],
  ['1.0.0-beta.11', '1.0.0-rc.1'],
  ['1.0.0-rc.1', '1.0.0'],
]

/** `Math.sign(-0)` 是 `-0`，`toBe` 用 `Object.is` ⇒ 归一成 -1/0/1 再比。 */
function signOf(value: number): number {
  return value < 0 ? -1 : value > 0 ? 1 : 0
}

function loadCorpus(): CorpusCase[] {
  // 真源缺席 ⇒ 直接失败（不是 skip）：语料不在，"两端语义一致"这件事完全静默。
  const raw = readFileSync(CORPUS_URL, 'utf8')
  const doc = JSON.parse(raw) as { schema?: unknown; cases?: unknown }
  expect(doc.schema, '共享语料 schema 必须是 picoaide-semver-corpus/1').toBe('picoaide-semver-corpus/1')
  expect(Array.isArray(doc.cases), '共享语料必须有 cases 数组').toBe(true)
  const cases = doc.cases as CorpusCase[]
  for (const c of cases) {
    expect(typeof c.id === 'string' && c.id !== '', `条目缺少 id：${JSON.stringify(c)}`).toBe(true)
    expect(typeof c.left === 'string' && c.left !== '', `[${c.id}] left 缺失`).toBe(true)
    expect(typeof c.right === 'string' && c.right !== '', `[${c.id}] right 缺失`).toBe(true)
    expect([-1, 0, 1], `[${c.id}] want 必须是 -1/0/1`).toContain(c.want)
  }
  return cases
}

const CASES = loadCorpus()

describe('desktop compareVersions · 仓内共享语料（R4-D-1）', () => {
  it('语料规模下限 ≥ 20 对', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(20)
  })

  it('语料包含全部必备对（删语料即红）', () => {
    const have = new Set(CASES.map(c => `${c.left}\u0000${c.right}`))
    const missing = REQUIRED_PAIRS
      .filter(([left, right]) => !have.has(`${left}\u0000${right}`))
      .map(([left, right]) => `${left} vs ${right}`)
    expect(missing, '共享语料缺少必备对（R4-D-1 的语义真源不允许被裁剪）').toEqual([])
  })

  it.each(CASES.map(c => [c.id, c.left, c.right, c.want] as const))(
    '语料 [%s] %s vs %s ⇒ %i',
    (_id, left, right, want) => {
      expect(signOf(compareVersions(left, right))).toBe(want)
      expect(signOf(compareVersions(right, left)), '反对称性').toBe(signOf(-want))
    },
  )

  it('非规范版本号仍按相等处理（本包既定语义：不可比 ⇒ 0）', () => {
    // parseSemVer 是严格 SemVer（拒绝缺段/前导零/非法字符），调用方据此不做"安装包可复用"判断。
    expect(compareVersions('dev', '2.8.1')).toBe(0)
    expect(compareVersions('2.5', '2.5.0')).toBe(0)
    expect(compareVersions('1.0.0-rc.01', '1.0.0-rc.1')).toBe(0)
  })
})
