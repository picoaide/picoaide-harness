/**
 * COI 内置技能同步 — 适配器使用指南的"源头"在插件里。
 *
 * 设计（用户拍板）：AI 使用 COI 的指南 = 正常技能（默认启用，可在
 * 「技能管理」Tab 禁用）。插件包内自带内置技能（skills/ 目录），
 * 插件启动时同步到技能库（~/.agents/skills）：
 *   - 目标不存在 → 复制（装上）
 *   - 目标 x-version 更低 → 整目录覆盖（源头在插件，升级随插件更新）
 *   - 一致 → 跳过
 * 同步以**整目录**为单位（SKILL.md + scripts/ 等辅助文件随技能一起走）；
 * 被禁用的技能文件仍存在，只是不注入模型。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomicSafeAt, writeTargetRefusedError } from '../sync/filesets.js'

/** 插件内置的技能清单（目录名 = 技能名）。 */
export const BUILTIN_SKILLS = [
  'kimi-cli-calling',
  'codex-cli-calling',
  'grok-cli-calling',
  'hermes-cli-calling',
  'memory-consolidate',
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
 * 覆盖策略（保护用户编辑）：目标缺失 → 复制；目标 x-version 更低 →
 * 整目录覆盖（插件升级，SKILL.md 与 scripts/ 等辅助文件一起更新）；
 * 否则不动（用户可能编辑过，x-version 未变不覆盖）。
 *
 * 落点（NF-1，2026-09-13 审计加固；2026-09-16 与上游整目录语义合流）：
 * `<userSkillsDir>/<name>` 是本插件**自有内容**的固定落点，必须先过断言——
 * 从技能库根到落点的整条链没有符号链接、真实路径留在库内。第一轮这里是裸
 * `writeFileSync`：预置一个同名符号链接就能把库外任意文件覆盖成内置技能正文，
 * 而函数仍返回 `action:"synced"`（成功），且这条路径在插件启动时无条件执行，
 * 无需用户动作。上游 v26091501 起改按整目录同步（辅助文件随技能走），落点
 * 依然逐个文件走自锚定原子写，断言不放松。
 * 单个技能落点被拒只记 `refused`，不阻塞其余技能同步。
 *
 * @param {string} pluginSkillsDir - 插件包内 skills/ 目录的绝对路径。
 * @param {string} userSkillsDir - 用户技能库目录（~/.agents/skills）。
 * @returns {Array<{name:string, action:'synced'|'unchanged'|'missing'|'refused', message?:string}>}
 */
export function syncBuiltinSkills(pluginSkillsDir, userSkillsDir) {
  const results = []
  for (const name of BUILTIN_SKILLS) {
    const srcDir = join(pluginSkillsDir, name)
    const srcFile = join(srcDir, 'SKILL.md')
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
        syncSkillDirSafe(srcDir, destDir, userSkillsDir)
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

/**
 * 整目录落盘（上游 v26091501 的"整目录同步"语义 × 本地 NF-1 落点断言）。
 *
 * 语义：目标目录先清空再整体复制（上游行为：技能辅助文件随技能一起更新，
 * 用户自加在内置技能目录里的文件会被删除）。安全面：
 *   - `<userSkillsDir>/<name>` 存在但不是真实目录（符号链接 / 普通文件）→ 拒收；
 *   - 目标目录内**任何**符号链接条目 → 拒收（清空之前先扫，见下）；
 *   - 逐文件 `writeFileAtomicSafeAt(..., { anchorDir })`：从技能库根到落点整条链
 *     逐层 lstat，任一符号链接或真实路径逃出技能库即拒收（含 TOCTOU 窗口——
 *     断言在原子写内部对写入前的真实路径复检）。
 * 任一文件被拒即抛错，由调用方记 `refused` 并跳过该技能（不静默半写）。
 *
 * @param {string} srcDir - 插件包内技能目录。
 * @param {string} destDir - 用户技能库内的目标目录。
 * @param {string} anchorDir - 技能库根（落点断言的基准）。
 */
function syncSkillDirSafe(srcDir, destDir, anchorDir) {
  try {
    const stat = lstatSync(destDir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw writeTargetRefusedError(destDir)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  // 清空**之前**先扫一遍：目标目录里任何符号链接条目都拒收。上游的整目录语义
  // 是 `rm -rf` 后重铺，遇到预置的 `<name>/SKILL.md` 链接会"顺带删掉链接再写真
  // 文件"——不写穿，但把拒收变成了静默删除（调用方看到 synced，用户预置的链接
  // 却没了）。本地 NF-1 的口径是 fail-loud：不动那个链接、如实报 refused。
  const planted = findSymlinkEntry(destDir)
  if (planted !== null) throw writeTargetRefusedError(join(destDir, planted))
  rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })
  for (const rel of listFilesRel(srcDir)) {
    writeFileAtomicSafeAt(join(destDir, rel), readFileSync(join(srcDir, rel)), { anchorDir })
  }
}

/** 递归列出目录下的普通文件（相对路径，'/'-分隔，供跨平台 join 使用）。 */
function listFilesRel(dir, prefix = '') {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...listFilesRel(join(dir, entry.name), rel))
    else if (entry.isFile()) files.push(rel)
  }
  return files
}

/**
 * 递归找目录下第一个符号链接条目（**不跟随**，`withFileTypes` 的
 * `isSymbolicLink()` 对"链接到目录"同样为真）。返回相对路径；无则 null。
 * 目录不存在/不可读按"没有"处理（清空前的探测，不制造新的失败面）。
 */
function findSymlinkEntry(dir, prefix = '') {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isSymbolicLink()) return rel
    if (entry.isDirectory()) {
      const found = findSymlinkEntry(join(dir, entry.name), rel)
      if (found !== null) return found
    }
  }
  return null
}
