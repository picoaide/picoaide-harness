/**
 * COI 内置技能同步 — 适配器使用指南的"源头"在插件里。
 *
 * 设计（用户拍板）：AI 使用 COI 的指南 = 正常技能（默认启用，可在
 * 「技能管理」Tab 禁用）。插件包内自带 4 个内置技能（skills/ 目录），
 * 插件启动时同步到技能库（~/.agents/skills）：
 *   - 目标不存在 → 复制（装上）
 *   - 目标内容与内置不一致 → 覆盖（源头在插件，升级随插件更新）
 *   - 一致 → 跳过
 * 禁用状态由技能管理 Tab 的 shadow 机制管理（skills-state.json），
 * 与本同步互不影响——被禁用的技能文件仍存在，只是不注入模型。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSafeAt } from '../sync/filesets.js'

/** 插件内置的适配器技能清单（目录名 = 技能名）。 */
export const BUILTIN_SKILLS = [
  'kimi-cli-calling',
  'codex-cli-calling',
  'grok-cli-calling',
  'hermes-cli-calling',
]

/**
 * 技能名白名单（kebab-case，与 dsh-skill 的公开规则一致）。
 * 技能名直接参与路径拼接（`join(skillDir, name, 'SKILL.md')`），
 * 未校验时 `../../x` 可把读写落点带出技能库。
 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * @param {unknown} name
 * @returns {boolean} 是否是合法技能名。
 */
export function isSafeSkillName(name) {
  return typeof name === 'string' && SKILL_NAME_RE.test(name)
}

/** 从 SKILL.md frontmatter 读 x-version；缺省 0。 */
function skillVersion(text) {
  const match = String(text).match(/^---\n[\s\S]*?^x-version:\s*(\d+)\s*$/m)
  return match ? Number(match[1]) : 0
}

/**
 * 校验并规范化一段 SKILL.md 内容（技能格式要求）：
 *   - 空内容 / 超上限 → 抛错
 *   - 已有 frontmatter：必须完整（--- 包裹、含 name 与 description），
 *     缺失必填字段 → 抛错（提示用户补全）
 *   - 无 frontmatter：自动补全 name/description 头部
 * @param {string} raw - 用户输入内容。
 * @param {string} skillName - 技能名（补全 frontmatter 用）。
 * @param {string} displayName - 适配器显示名（补全 description 用）。
 * @returns {string} 规范化后的完整 SKILL.md 文本。
 */
export function normalizeSkillText(raw, skillName, displayName) {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error('技能内容不能为空')
  if (text.length > 128 * 1024) throw new Error('技能内容超过 128 KiB 上限')
  const lines = text.split('\n')
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end < 0) throw new Error('frontmatter 未闭合：需要以 --- 结尾的 YAML 头')
    const fm = lines.slice(1, end).join('\n')
    const missing = []
    if (!/^name:\s*\S+/m.test(fm)) missing.push('name')
    if (!/^description:\s*\S+/m.test(fm)) missing.push('description')
    if (missing.length > 0) {
      throw new Error(`frontmatter 缺少必填字段：${missing.join('、')}（SKILL.md 必须含 name 与 description）`)
    }
    return text
  }
  return `---\nname: ${skillName}\ndescription: ${displayName} 的 AI 使用指南（由 dsh-memory-evolve COI 适配器创建）。\n---\n${text}`
}

/**
 * 同步内置技能到用户技能库。
 * 覆盖策略（保护用户编辑）：目标缺失 → 复制；目标存在但内置版本更高 →
 * 覆盖（插件升级）；否则不动（用户可能编辑过，x-version 未变不覆盖）。
 *
 * 落点（NF-1）：`<userSkillsDir>/<name>/SKILL.md` 是本插件**自有内容**的固定
 * 落点，必须先过断言——`anchorDir` 保证从技能库根到落点的整条链没有符号链接、
 * 真实路径留在库内。第一轮这里是裸 `writeFileSync`：预置一个同名符号链接就能
 * 把库外任意文件覆盖成内置技能正文，而函数仍返回 `action:"synced"`（成功），
 * 且这条路径在插件启动时无条件执行，无需用户动作。
 * 单个技能落点被拒只记 `refused`，不阻塞其余技能同步。
 *
 * @param {string} pluginSkillsDir - 插件包内 skills/ 目录的绝对路径。
 * @param {string} userSkillsDir - 用户技能库目录（~/.agents/skills）。
 * @returns {Array<{name:string, action:'synced'|'unchanged'|'missing'|'refused', message?:string}>}
 */
export function syncBuiltinSkills(pluginSkillsDir, userSkillsDir) {
  const results = []
  for (const name of BUILTIN_SKILLS) {
    const srcFile = join(pluginSkillsDir, name, 'SKILL.md')
    if (!existsSync(srcFile)) {
      results.push({ name, action: 'missing' })
      continue
    }
    const destDir = join(userSkillsDir, name)
    const destFile = join(destDir, 'SKILL.md')
    const srcText = readFileSync(srcFile, 'utf8')
    let action = 'unchanged'
    let message
    const needsCopy = !existsSync(destFile)
      || skillVersion(srcText) > skillVersion(readFileSync(destFile, 'utf8'))
    if (needsCopy) {
      try {
        writeFileAtomicSafeAt(destFile, srcText, { anchorDir: userSkillsDir })
        action = 'synced'
      } catch (error) {
        // fail-loud 但可感知：绝不把"没写成/写到库外"报成 synced。
        action = 'refused'
        message = String(error?.message ?? error)
        console.warn(`[dsh-memory-evolve] 内置技能 ${name} 落点被拒（跳过）：${message}`)
      }
    }
    results.push(message === undefined ? { name, action } : { name, action, message })
  }
  return results
}
