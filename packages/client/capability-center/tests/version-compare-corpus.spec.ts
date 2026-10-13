/// <reference types="node" />
/**
 * **跨端版本先后语义的共享语料对拍**（R4-D-1 / 2026-09-23 第四轮审计，P1）。
 *
 * 审计现场：同一版本对在服务端与客户端结论相反 —— `1.0.0-rc10` vs `1.0.0-rc2`
 * （Go -1 / 客户端 +1 ⇒ 能力中心把**降级**当升级展示）与 `1.0.0-rc1` vs `1.0.0-rc.1`
 * （Go +1 / 客户端 0 ⇒ 判成同一个版本、漏更新）。根因是语义有六份实现，而客户端那份
 * 的头注释声称"对齐服务端 `util.CompareSemVer`"却**无处可验**。
 *
 * 本文件就是那道闸：语料 `server/internal/util/testdata/semver-corpus.json` 是仓内
 * **唯一的语义真源**，Go 侧四个包（internal/util、-/updatecheck、-/skillmanifest、
 * -/wasmapp/registry）与 TS 侧两个包（本包的 `src/client/version-compare.ts`、
 * `dsh-plugin-desktop` 的 `src/updates.ts`）各自读同一份逐条断言。
 *
 * 三层判据（缺任一层都会被"看起来改好了"骗过）：
 *  1. 逐条：`signOf(compareVersions(left, right))` 必须等于语料里的 `want`
 *     （不是"两端相等"这种自证式断言），并断言反对称；
 *  2. 完整性：必备对写死在判据里（不读语料）—— 把两对分叉从语料里删掉，本文件立刻红；
 *  3. 规模下限：`cases.length >= 20`（删条目还要同时改判据才可能绿）。
 *
 * 变异验证（实跑见交付报告）：把 `version-compare.ts` 换回旧的 tokenizer
 * ⇒ 「R4-D-1 分叉对①/②」两组红；把语料里的两对分叉删掉 ⇒ 第 2 层红。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compareVersions } from '../src/client/version-compare.ts'

/**
 * `Math.sign(-0)` 是 `-0`，而 vitest 的 `toBe` 用 `Object.is` 比较 ⇒ `-0` 与 `0`
 * 被判不相等（本仓踩过）。判据只关心符号，这里统一归一成 -1/0/1。
 */
function signOf(value: number): number {
  return value < 0 ? -1 : value > 0 ? 1 : 0
}

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
 * 必备对：**写死在判据里**（与语料文件解耦）。
 *
 * 语料是数据，判据不能只信数据 —— 一个"遍历语料"的用例在语料被裁剪后反而全绿。
 * 这份清单是"语料被裁剪"的探针；两端（Go/TS）各持一份，任何一侧被删都会红。
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
  ['2.7.2-beta.7', '2.7.2-beta.8'],
  ['1.0.0-rc.01', '1.0.0-rc.1'],
]

function loadCorpus(): CorpusCase[] {
  // 真源缺席 ⇒ 直接失败（不是 skip）：语料不在，"两端语义一致"这件事完全静默
  // （与 `appcfg-contract.spec.ts` 的既定口径一致）。
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

describe('版本先后语义 · 仓内共享语料（R4-D-1）', () => {
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

  it('两对分叉（审计现场）逐条一致', () => {
    // 单独成组：这两条红了，用户可见后果最重（降级当升级 / 漏更新）。
    expect(signOf(compareVersions('1.0.0-rc10', '1.0.0-rc2'))).toBe(-1)
    expect(signOf(compareVersions('1.0.0-rc2', '1.0.0-rc10'))).toBe(1)
    expect(signOf(compareVersions('1.0.0-rc1', '1.0.0-rc.1'))).toBe(1)
    expect(signOf(compareVersions('1.0.0-rc.1', '1.0.0-rc1'))).toBe(-1)
  })

  it('build metadata 忽略（§10）', () => {
    expect(signOf(compareVersions('1.0.0+build.1', '1.0.0'))).toBe(0)
    expect(signOf(compareVersions('1.0.0-rc.1+build.5', '1.0.0-rc.1'))).toBe(0)
    expect(signOf(compareVersions('2.7.2-beta.8+build.5', '2.7.2-beta.8'))).toBe(0)
  })

  it.each(CASES.map(c => [c.id, c.left, c.right, c.want] as const))(
    '语料 [%s] %s vs %s ⇒ %i',
    (_id, left, right, want) => {
      expect(signOf(compareVersions(left, right))).toBe(want)
      expect(signOf(compareVersions(right, left)), '反对称性').toBe(signOf(-want))
    },
  )
})
