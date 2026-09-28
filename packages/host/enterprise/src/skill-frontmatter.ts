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
 *
 * ## 解码层（审计 2026-09-26 R23-W2-01，P2）：先问"运行时读得出来这是文本吗"
 *
 * 切分只是第二关。生产形态下上游**先过一关解码**：桌面装配了 `ctx.fs`
 * （`cordis.patch.yml` 把 `fs-sandbox` 换成 `asar-file-system`，它继承
 * `LocalFileSystem`），所以 `readSkillText` 走
 * `readSkillTextFromFileSystem` → `ctx.fs.readText` →
 * `@deepseek-ai/dsh-fs-local` 的 `readWholeText`（pinned 源码 `fsio.ts`）：
 *
 *   1. 前 {@link SKILL_TEXT_BINARY_SAMPLE_BYTES} 字节里出现 `NUL` ⇒
 *      `FS_NOT_TEXT "binary file"`；
 *   2. 整份字节不是合法 UTF-8 ⇒ `FS_NOT_TEXT "invalid UTF-8 text"`。
 *
 * 两条都让上游 **`logger.warn` + 整份技能丢弃**。而 `node:fs` 的
 * `readFile(…, 'utf8')` **永不抛错**（非法字节被替换成 U+FFFD），于是含 NUL /
 * 非法 UTF-8 的 SKILL.md 在旧实现里读作"预检 0 问题 → 安装 200 → 面板已安装"，
 * 生产运行时却一份都不加载 —— 与 R21-A1-01 / R22-V1-N1 逐字同一签名（装得上、
 * 模型永远看不到），而当时新加的"我们接受集合 == 上游加载集合"判据也看不见它，
 * 因为测试用的注册表 harness 不注册 `ctx.fs`（走 `node:fs` 直读）。
 *
 * 现在的口径：**读取一律按字节进来**，先过 {@link decodeSkillTextBytes}
 * （逐条对齐 `readWholeText` 的两条拒绝语义，不是"含 NUL 就拒"的近似），
 * 再进切分。三面（发布预检 / 安装第三关 / 发现面）共用这一份实现；
 * 对拍由 `tests/skill-runtime-text-decode-parity.spec.ts` 真跑上游 `ctx.fs`
 * （`fs-local` 一路）在**同一份语料**上逐条比对读数钉住。
 */
import { readFile } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'

/**
 * "二进制采样"窗口的字节数 —— **逐字等于**上游
 * `@deepseek-ai/dsh-fs-local` 的 `BINARY_SAMPLE_BYTES`（pinned `fsio.ts`）。
 *
 * 语义不是"扫全文找 NUL"，而是"前 8192 字节里有 NUL 就判二进制"：只对拍这个
 * 窗口才是与运行时同源；把窗口改大/改小都会让"我们接受集合 == 上游加载集合"
 * 这条不变量在边界形态（NUL 恰好落在 8192 字节之后）上分叉。
 */
export const SKILL_TEXT_BINARY_SAMPLE_BYTES = 8192

/** 运行时读不出文本的两种成因（`readWholeText` 的两条 `FS_NOT_TEXT`）。 */
export type SkillTextFailure =
  /** 前 {@link SKILL_TEXT_BINARY_SAMPLE_BYTES} 字节里有 `NUL`（`FS_NOT_TEXT "binary file"`）。 */
  | 'binary'
  /** 整份字节不是合法 UTF-8（`FS_NOT_TEXT "invalid UTF-8 text"`）。 */
  | 'invalid-utf8'

/** 解码结论：`ok` 为真时带着运行时会给的那份文本。 */
export type SkillTextDecode =
  | { readonly ok: true, readonly text: string }
  | { readonly ok: false, readonly failure: SkillTextFailure }

/**
 * 按**运行时同源的判据**解码一份技能文件（纯函数，无 IO）。
 *
 * 与 `readWholeText`（`fs-local/src/fsio.ts`）逐条对齐，顺序也一样：先看采样窗口
 * 的 `NUL`，再整份做 `fatal` UTF-8 解码。两条的任何一条命中 ⇒ 运行时整份丢弃。
 *
 * 正向不得误杀：纯文本 / CJK / emoji / CRLF / 极长单行 / 无尾换行都是合法 UTF-8，
 * 一律放行（`tests/skill-runtime-text-decode-parity.spec.ts` 有正向语料）。
 * @param raw - 文件原始字节。
 * @returns 运行时会给的文本，或它拒绝的那一条。
 */
export function decodeSkillTextBytes(raw: Uint8Array): SkillTextDecode {
  // 顺序与 `readWholeText` 一致：二进制采样先于 UTF-8 解码（一个含 NUL 的字节串
  // 也可能是合法 UTF-8，两者都命中时运行时报的是 "binary file"）。
  if (raw.subarray(0, SKILL_TEXT_BINARY_SAMPLE_BYTES).includes(0)) return { ok: false, failure: 'binary' }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(raw) }
  } catch {
    return { ok: false, failure: 'invalid-utf8' }
  }
}

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

/** {@link readSkillTextStrict} 的结论：读不出来时带上是"读不到文件"还是运行时那两条。 */
export type SkillTextRead =
  | { readonly ok: true, readonly text: string }
  /** 文件读不到（不存在 / 权限 / 是目录）—— 上游同样按"这份技能不存在"处理。 */
  | { readonly ok: false, readonly failure: 'unreadable' }
  | { readonly ok: false, readonly failure: SkillTextFailure }

/**
 * 按**字节**读一份技能文件，再用运行时同源的判据解码。
 *
 * 为什么不能 `readFile(path, 'utf8')`：那个形态**永不抛错**，非法字节被替换成
 * U+FFFD ⇒ 判据看见的是一份"看起来正常"的文本，而运行时（`ctx.fs` →
 * `readWholeText`）整份丢弃它。见模块头"解码层"一节。
 * @param path - 文件路径。
 * @returns 运行时会给的文本、或它的拒绝成因（含"读不到文件"）。
 */
export async function readSkillTextStrict(path: string): Promise<SkillTextRead> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch {
    return { ok: false, failure: 'unreadable' }
  }
  return decodeSkillTextBytes(bytes)
}

/**
 * 读一个 SKILL.md 的 frontmatter **映射**（解码 + 严格切分 + YAML + 必须是映射）。
 *
 * 发现面（{@link discoverRuntimeSkills} 的元数据读取）与安装面
 * （`assertLoadableSkillMetadata`）共用这一个函数 —— 两边各写一份严格解析器
 * 正是"判据各自钉自己字面量"的复发形态。
 *
 * R23-W2-01：读取按**字节**进来并过 {@link decodeSkillTextBytes} ⇒ "运行时读不出
 * 文本"的 SKILL.md 在这里与"没有 frontmatter"同样落 `undefined`（发现面因此与
 * 运行时同集合）；需要区分成因的调用方（安装第三关、发布预检）走
 * {@link readSkillTextStrict}。
 * @param skillMdPath - SKILL.md 的路径。
 * @returns frontmatter 映射；读不到 / 不是文本 / 不是 frontmatter / 不是映射时为 `undefined`。
 */
export async function readSkillFrontmatterStrict(skillMdPath: string): Promise<Record<string, unknown> | undefined> {
  const read = await readSkillTextStrict(skillMdPath)
  if (!read.ok) return undefined
  const raw = read.text
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
