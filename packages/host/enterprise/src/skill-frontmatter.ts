/**
 * SKILL.md frontmatter 的**严格**切分 —— 判据从 **pinned 上游运行时**派生，不是
 * 我们自己选的规则。
 *
 * ## 为什么必须严格（审计 2026-09-23 R21-A1-01，P1）
 *
 * 运行时 `@deepseek-ai/dsh-skill-filesystem` 的 `parseFrontmatter` /
 * `findClosingFrontmatter`（pinned 源码 `packages/skill/skill-filesystem/src/index.ts`
 * 的 `parseFrontmatter`：首行 `=== '---'`、逐行找**恰为** `---` 的收尾行，找不到即
 * `undefined` ⇒ `parseSkillFile` 整份丢弃并只 `logger.warn`）要求两条分隔线都是
 * **整行**的 `---`。
 *
 * 而安装器与发布预检此前用的是**宽松**切分（`indexOf('\n---')`）：结束行写成
 * `--- `（尾随空格）、`---\t`、`---x` 时，
 *
 *   客户端预检 **0 问题** → 服务端放行 → 安装 200 + `ok:true`、文件落盘
 *   → **上游不加载**（模型看不到）→ 企业侧 `listInstalledSkills`（严格判据）
 *   **也列不出** ⇒ 面板永远显示"未安装"，用户反复点安装每次都被回成功，零报错。
 *
 * 这正是本模块要消灭的那类"装得上、永远加载不到"。因此**发现面 / 安装面 /
 * 预检面三处走同一份实现**（本文件），三处实现同一性由
 * `tests/skill-frontmatter-strict-parity.spec.ts` 读上游源码 + 真跑 pinned 注册表钉住。
 *
 * ## 判据细节（逐条对齐上游，含边界）
 *
 *  - 首行必须恰为 `---`（允许一个 `\r`，即 CRLF 文件）；文件里没有 `\n` ⇒ 不是 frontmatter；
 *  - 收尾行是**其后第一行**恰为 `---` 的那一行（同样允许 `\r`）；
 *    `--- `（尾随空格）/ `---\t` / `---x` 都**不是**收尾行 —— 宽松方向就在这里出错；
 *  - frontmatter 区间必须是合法 YAML **映射**（`null` / 标量 / 数组都不算）。
 */
import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'

/** frontmatter 分隔行（上游逐字比较的那一个字面量）。 */
const FRONTMATTER_FENCE = '---'

/** 切分结果：交给 YAML 解析器的那一段，与它之后的正文。 */
export interface SkillFrontmatterSplit {
  /** 两条分隔行之间的原始文本（**不含**分隔行与它们各自的换行）。 */
  front: string
  /** 收尾分隔行之后的正文（收尾行是最后一行时为 `''`）。 */
  body: string
}

/**
 * 严格切分 SKILL.md 的 frontmatter（与上游 `parseFrontmatter` 同一条判据）。
 *
 * 只管**切分**：YAML 解析留给调用方，因为发布预检在把文本交给解析器之前还要跑
 * 复杂度/merge-key 闸门并给出稳定的错误码（`manifest-precheck.ts`）。
 * @param raw - SKILL.md 全文。
 * @returns 切分结果；首行或收尾行不是整行 `---` 时为 `undefined`（= 运行时忽略整份技能）。
 */
export function splitSkillFrontmatter(raw: string): SkillFrontmatterSplit | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/u, '') !== FRONTMATTER_FENCE) return undefined
  let lineStart = firstLineEnd + 1
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/u, '') === FRONTMATTER_FENCE) {
      return {
        front: raw.slice(firstLineEnd + 1, lineStart),
        body: nextNewline < 0 ? '' : raw.slice(nextNewline + 1),
      }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

/**
 * 读一个 SKILL.md 的 frontmatter **映射**（严格切分 + YAML + 必须是映射）。
 *
 * 发现面（{@link discoverRuntimeSkills} 的元数据读取）与安装面
 * （`assertLoadableSkillMetadata`）共用这一个函数 —— 两边各写一份严格解析器
 * 正是"判据各自钉自己字面量"的复发形态。
 * @param skillMdPath - SKILL.md 的路径。
 * @returns frontmatter 映射；读不到 / 不是 frontmatter / 不是映射时为 `undefined`。
 */
export async function readSkillFrontmatterStrict(skillMdPath: string): Promise<Record<string, unknown> | undefined> {
  let raw: string
  try {
    raw = await readFile(skillMdPath, 'utf8')
  } catch {
    return undefined
  }
  const split = splitSkillFrontmatter(raw)
  if (split === undefined) return undefined
  let parsed: unknown
  try {
    parsed = parseYaml(split.front)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}
