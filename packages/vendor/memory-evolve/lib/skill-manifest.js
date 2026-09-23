/**
 * dsh-memory-evolve — SKILL.md frontmatter 里**由本插件管理**的那部分：
 * 单一实现（源）。
 *
 * 为什么需要一份共享实现：`disable-model-invocation` 这个字段同时被两处碰：
 *   1. 「技能管理」Tab 的禁用开关（`skills-manager.js` 的 `setSkillDisabled`）；
 *   2. 「这份内容是否被用户改过」的判据（内容树哈希）。
 * 两处对同一个字段的写法/判法一旦漂移，就会出现 R5-B-4 那类缺陷：**平台自己写的
 * 元数据被当成"用户改了内容"**（能力中心显示「已本地修改」+ 每次更新都要确认条），
 * 或者反过来，用户真的改了正文却判不出来。所以：
 *   - 写入端（skills-manager）与换入端（coi/skills-sync 的保留逻辑）共用
 *     {@link toggleDisableFlag} / {@link hasDisableFlag}；
 *   - 哈希端（`coi/skills-sync.js` 的 `skillContentChecksum`）用
 *     {@link normalizeSkillManifestBytes} 把该字段从内容哈希里**剔除**；
 *   - 企业侧（`packages/host/enterprise/src/skill-install.ts` 的
 *     `computeSkillContentHash`）**逐字节复刻**同一份归一化（跨包 import 禁止），
 *     等价性由 `packages/host/enterprise/tests/skill-channel-parity.spec.ts` 对拍。
 *
 * **dirty 的语义因此被收窄为"用户改过内容"**：本插件管理的字段（当前只有
 * `disable-model-invocation`）无论谁写、写成什么值，都不进内容哈希。
 *
 * 归一化必须是**无字段即逐字节原样**（返回原始 Buffer，不做任何往返编解码）：
 * 老基准（本修复之前写下的 `archiveChecksum`）里那些从没带过该字段的技能因此
 * 仍逐字节可比 —— 否则全量技能会瞬间变成"已本地修改"。
 */
import { Buffer } from 'node:buffer'

/** frontmatter 禁用标记字段名（skill-local 官方 canonical key）。 */
export const DISABLE_MODEL_KEY = 'disable-model-invocation'

/** 该字段的一整行（`^\s*disable-model-invocation\s*:.*$`）。 */
const DISABLE_KEY_LINE = /^\s*disable-model-invocation\s*:.*$/m

/** SKILL.md 的 frontmatter 块（与 `skills-manager.js` 的解析同形）。 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n?)([\s\S]*)$/

/**
 * SKILL.md 文本里是否带禁用标记（忽略缩进与取值）。
 * @param {string} text - 完整 SKILL.md 内容。
 * @returns {boolean} 带该字段为 true。
 */
export function hasDisableFlag(text) {
  const match = FRONTMATTER_RE.exec(text)
  if (match === null) return false
  return DISABLE_KEY_LINE.test(match[1])
}

/**
 * 在 SKILL.md 文本的 frontmatter 中插入/移除禁用标记，其余内容原样保留。
 * @param {string} text - 完整 SKILL.md 内容。
 * @param {boolean} disabled - true=插入 `disable-model-invocation: true`；
 *   false=移除该字段（无论其当前值）。
 * @returns {string|null} 修改后的文本；状态已一致时返回原文本；
 *   非规范 SKILL.md（无 frontmatter）返回 null（调用方按失败处理）。
 */
export function toggleDisableFlag(text, disabled) {
  const match = FRONTMATTER_RE.exec(text)
  if (match === null) return null
  const [, data, closingNewline, body] = match
  const has = DISABLE_KEY_LINE.test(data)
  if (disabled === has) return text
  let next
  if (disabled) {
    next = `${data}${data.endsWith('\n') ? '' : '\n'}${DISABLE_MODEL_KEY}: true`
  } else {
    next = data.split('\n').filter((line) => !DISABLE_KEY_LINE.test(line)).join('\n')
  }
  return `---\n${next}\n---${closingNewline}${body}`
}

/**
 * 内容哈希用的**规范化字节**：把本插件管理的 frontmatter 字段从 SKILL.md 里剔除。
 *
 * 判据（与企业侧 `normalizeSkillManifestBytes` 逐字节一致）：
 *   - 不是 `SKILL.md` 的调用点不使用本函数（只有顶层 SKILL.md 会过它）；
 *   - 没有 frontmatter 块 ⇒ **原样返回**（不做任何归一化，宁可少归一）；
 *   - frontmatter 里**没有**该字段 ⇒ **逐字节原样返回**（老基准不受影响）；
 *   - 有该字段 ⇒ 按 {@link toggleDisableFlag} 的同一套 splice 规则移除它们，
 *     并把 frontmatter 块重建为 `---\n<data>\n---<原闭合换行><body>`。
 *     `toggleDisableFlag(text, true)` 写下的文本经本函数处理，会**逐字节**回到
 *     写之前的文本（当且仅当原文本的换行是 LF），所以"开关禁用"这件事对内容哈希
 *     完全不可见。
 *
 * @param {Buffer} bytes - SKILL.md 的原始字节。
 * @returns {Buffer} 参与哈希的字节（多数情况下就是入参本身）。
 */
export function normalizeSkillManifestBytes(bytes) {
  const text = bytes.toString('utf8')
  const match = FRONTMATTER_RE.exec(text)
  if (match === null) return bytes
  const [, data, closingNewline, body] = match
  if (!DISABLE_KEY_LINE.test(data)) return bytes
  const next = data.split('\n').filter((line) => !DISABLE_KEY_LINE.test(line)).join('\n')
  return Buffer.from(`---\n${next}\n---${closingNewline}${body}`, 'utf8')
}
