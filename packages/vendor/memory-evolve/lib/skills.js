/**
 * dsh-memory-evolve — skill management tool.
 *
 * The `skill_manage` tool lets LLM agents (the in-turn memory review and
 * ordinary sessions) create and maintain skills in the shared skills
 * directory (`~/.agents/skills` by default — scanned by both DSH's
 * skill-local and Hermes' external dirs).
 *
 * Design:
 *   - `create` writes `<dir>/<name>/SKILL.md`; the name must be kebab-case
 *     (which also rules out path traversal) and the body must be a canonical
 *     SKILL.md whose frontmatter declares name + description;
 *   - `patch` replaces the whole SKILL.md and REQUIRES prior read evidence:
 *     the calling agent's own session log must contain a `tool/call` event
 *     for `skill_manage action=read <name>` (read-before-write, the Hermes
 *     protection against editing skills the agent never actually read);
 *   - disabled skills (any plugin registered a `modelInvocable: false`
 *     shadow through the core `ctx.skills` registry) are skipped — this
 *     reads the shared runtime registry, never another plugin's private
 *     state, so deployments without dsh-skills-manager behave identically;
 *   - sizes are capped; writes are atomic.
 *
 * Zero runtime dependencies (node:fs only).
 *
 * @module dsh-memory-evolve/skills
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { translate, getLocale, SKILL_DICT, SKILL_MSG_DICT } from './i18n.js'

/** Translate through the SKILL_DICT dictionary in the active locale. */
const skt = (key, params) => translate(SKILL_DICT, key, params)
/** Translate through SKILL_MSG_DICT in the active host locale. */
const smt = (key, params) => translate(SKILL_MSG_DICT, key, params, getLocale())
import { join } from 'node:path'
import { resolveSafeRepoTarget, writeFileAtomicSafeAt, writeTargetRefusedError } from './sync/filesets.js'

/** Skill name grammar (matches DSH's isSkillName; kebab-case rules out traversal). */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Whether a string is a valid skill name.
 * @param {string} name - the candidate name.
 * @returns {boolean} true for kebab-case lowercase names.
 */
export function isSkillName(name) {
  return SKILL_NAME.test(name)
}

/** Strip one level of matching surrounding quotes. */
function unquote(value) {
  if (value.length >= 2
    && ((value[0] === '"' && value[value.length - 1] === '"')
      || (value[0] === "'" && value[value.length - 1] === "'"))) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Parse a canonical SKILL.md body (frontmatter block + markdown body).
 * Frontmatter is parsed line-wise for simple `key: value` fields; `name` and
 * `description` are required and must be single-line scalars.
 * @param {string} text - the full SKILL.md content.
 * @returns {{name: string, description: string, body: string} | undefined}
 *   the parsed skill, or undefined when not canonical.
 */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return undefined
  const fields = {}
  for (const line of match[1].split('\n')) {
    // Windows/CRLF 兼容（issue #17）：split('\n') 后每行尾部残留 \r，
    // 而 JS 正则中 . 不匹配 \r、$ 不匹配 \r 前的位置——"name: foo\r"
    // 整行匹配失败 → fields 缺 name → 返回 undefined → 技能被静默跳过。
    // 先剥掉行尾 \r 再解析（分隔符正则已支持 \r?\n，这里补行内处理）。
    const field = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line.replace(/\r+$/, ''))
    if (!field) continue
    const rawValue = field[2].trim()
    const quoted = (rawValue.startsWith('"') && rawValue.endsWith('"'))
      || (rawValue.startsWith("'") && rawValue.endsWith("'"))
    // YAML bare scalars reject `: ` and inline comments; a quoted value is
    // safe. This mirrors the strict YAML frontmatter parser DSH's skill-local
    // uses — a skill we accept must parse there too.
    if (!quoted && (rawValue.includes(': ') || rawValue.includes(' #'))) return undefined
    fields[field[1]] = quoted ? unquote(rawValue) : rawValue
  }
  if (typeof fields.name !== 'string' || fields.name.length === 0) return undefined
  if (typeof fields.description !== 'string' || fields.description.length === 0) return undefined
  return { name: fields.name, description: fields.description, body: match[2] }
}

/**
 * List skills in a directory (directory bundles with a parseable SKILL.md).
 * @param {string} dir - the skills directory.
 * @returns {Array<{name: string, description: string}>} sorted entries.
 */
export function listSkills(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const result = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const text = readFileSync(join(dir, entry.name, 'SKILL.md'), 'utf8')
      const parsed = parseFrontmatter(text)
      if (parsed && parsed.name === entry.name) {
        result.push({ name: entry.name, description: parsed.description })
      }
    } catch {
      // unreadable or unparseable skill — skip
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * List pending (awaiting user confirmation) skills with their full content.
 * @param {string} dir - the pending-skills directory.
 * @returns {Array<{name: string, description: string, content: string}>}
 *   entries in name order.
 */
export function listPendingSkills(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const result = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const content = readFileSync(join(dir, entry.name, 'SKILL.md'), 'utf8')
      const parsed = parseFrontmatter(content)
      if (parsed && parsed.name === entry.name) {
        result.push({ name: entry.name, description: parsed.description, content })
      }
    } catch {
      // unreadable or unparseable — skip
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 技能库落点的**唯一实现**（A4 修复，2026-09-23 独立审计）。
 *
 * 缺陷形态：`writeFileAtomicSafeAt(<库>/<name>/SKILL.md, …, { followFileSymlink:
 * false })` **不带 anchorDir** 时会退到"以落点父目录为断言基准"的兜底档
 * （`lib/sync/filesets.js` 的 `resolveSelfAnchoredTarget` 末段）——父目录本身是
 * 符号链接时 `realpath(父)` 自己变成包含性根、判定恒真，而
 * `hasSymlinkComponent` 又只从父目录**之下**开始 lstat，于是预置
 * `<库>/evil -> <库外目录>` 就能把 SKILL.md 写到库外并报 `ok:true`（对照：
 * `approvePendingSkill` 走锚定分支，同形态如实拒收）。
 *
 * 因此：**所有**技能写入（`skill_manage` 的 create/patch 直写与 pending 写、
 * `approvePendingSkill` 的采纳落点与逐文件拷贝）都经这里解析落点，断言基准一律
 * 是**根**（技能库根 / 待确认队列根），并复用 `resolveSafeRepoTarget` 这**同一份**
 * 断言；写盘时再把同一个根交给 `writeFileAtomicSafeAt` 的 `anchorDir` 做 TOCTOU
 * 复检。
 *
 * 这里额外做一件写原语不做的事：**逐级目录必须是真实目录**。它发生在任何
 * mkdir/拷贝之前，所以
 *   - 拒收本身没有副作用（不会先建目录再失败）；
 *   - 「目标同路径处是普通文件」得到的是可读的拒绝，而不是原生 `cpSync` 的
 *     `terminate called … cannot create directory: File exists`（A5：宿主进程
 *     abort，exit 134）。
 * 技能库根本身是符号链接的合法布局不受影响：包含性基准是 `realpath(根)`。
 *
 * @param {string} rootDir - 落点所在的根（技能库根，或待确认队列根）。
 * @param {string} relPath - 相对根的路径（'/' 分隔，不得含空段/`.`/`..`）。
 * @param {{ leaf?: 'file' | 'dir' }} [options] - 末段是文件（缺省）还是目录。
 * @returns {string | null} 绝对落点（realpath 基准）；null = 拒收（fail closed）。
 */
export function resolveSkillLanding(rootDir, relPath, options = {}) {
  if (typeof rootDir !== 'string' || rootDir === '') return null
  if (typeof relPath !== 'string' || relPath === '' || relPath.startsWith('/')) return null
  const parts = relPath.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  // 根可以还不存在（首次写入 / 首次采纳）；只建根，落点由断言决定。
  try {
    mkdirSync(rootDir, { recursive: true })
  } catch {
    return null
  }
  const dirParts = options.leaf === 'dir' ? parts : parts.slice(0, -1)
  let current = rootDir
  for (const part of dirParts) {
    current = join(current, part)
    let stat
    try {
      stat = lstatSync(current)
    } catch (error) {
      if (error?.code === 'ENOENT') break // 更深的组件此刻不存在：允许（随后创建）
      return null
    }
    // 符号链接（预置链接 / stow / chezmoi）、普通文件、其它特殊文件一律拒收。
    if (!stat.isDirectory()) return null
  }
  // 与 approvePendingSkill 同一份断言（同一个 resolveSafeRepoTarget）。
  return resolveSafeRepoTarget(rootDir, relPath)
}

/** 递归列出目录下的普通文件（相对路径，'/'-分隔）。 */
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
 * 逐文件安全拷贝一棵技能目录（A5 + A10 修复，2026-09-23 独立审计）。
 *
 * **绝不用 `cpSync` 整树拷贝**：目标同相对路径处若已是普通文件（或悬空链接），
 * libstdc++ 在 `std::filesystem::create_directory` 冲突时抛的是**未捕获的 C++
 * 异常**，Node 侧的 `try/catch` 抓不住 —— 实测 `terminate called … cannot create
 * directory: File exists` + `exit 134`，宿主进程（插件的 HTTP 面与它同进程）被
 * 直接 abort，而 abort 之前已经写下半成品。
 *
 * 语义（与从前的 cpSync 回落一致，只把实现换成可中断、可回收的）：
 *   - 目标目录已存在（可能装着用户自加的笔记/附件）→ **合并**覆盖，绝不先删；
 *   - 逐文件 `writeFileAtomicSafeAt(…, { anchorDir: 根 })`：每个落点都过根锚定
 *     断言（符号链接/越界/同名普通文件 → 抛错，而不是 abort）；
 *   - `SKILL.md` **最后写**：它是"已安装"的唯一判据 —— 中途失败时目标目录里
 *     不会出现 SKILL.md，下一次采纳照常可成功（A10 的半成品死锁由此闭合）；
 *   - 中途失败只回收**本次写下的文件**，既有内容一律不动（回滚不删用户数据）。
 *
 * @param {string} fromDir - 源技能目录（待确认队列里的那一份）。
 * @param {string} toDir - 目标技能目录（技能库内，已过落点断言）。
 * @param {string} rootDir - 技能库根（落点断言的基准）。
 * @param {string} name - 技能名（相对库根的目录名）。
 * @returns {string[]} 本次写下的落点（绝对路径）。
 * @throws {Error} 任一落点被拒（调用方必须当失败处理，绝不报成功）。
 */
function copySkillTreeSafe(fromDir, toDir, rootDir, name) {
  // 先非 SKILL.md，最后才是 SKILL.md（"装好"的判据最后落地）。
  const relFiles = listFilesRel(fromDir).filter((rel) => rel !== 'SKILL.md')
  if (existsSync(join(fromDir, 'SKILL.md'))) relFiles.push('SKILL.md')
  const written = []
  try {
    mkdirSync(toDir, { recursive: true })
    for (const rel of relFiles) {
      const landing = resolveSkillLanding(rootDir, `${name}/${rel}`)
      if (landing === null) throw writeTargetRefusedError(join(rootDir, name, rel))
      // 落点用未解析的 join + anchorDir=根：技能库根自身是符号链接时（合法布局）
      // relative(resolve(根), resolve(落点)) 仍然成立（与 coi/skills-sync.js 同形）。
      writeFileAtomicSafeAt(join(rootDir, name, rel), readFileSync(join(fromDir, rel)), {
        anchorDir: rootDir,
        followFileSymlink: false,
      })
      written.push(join(rootDir, name, rel))
    }
  } catch (error) {
    // 只回收本函数这一次写下的文件；目标目录里既有/用户自加的内容原样保留。
    for (const file of written) {
      try { rmSync(file, { force: true }) } catch { /* 尽力回收，失败不影响拒绝语义 */ }
    }
    throw error
  }
  return written
}

/**
 * 整树落点**预检**（A5 修复的"拷贝前对目标做一次类型检查"）：源目录里第一条
 * 在技能库中落点不可用的相对路径；全部可用返回 null。
 *
 * 判据与 {@link resolveSkillLanding} 同一份实现（不新造第二套），只读、无副作用
 * （不会先 mkdir 再失败）。它把"目标同相对路径处是普通文件/符号链接"变成可读的
 * 拒绝，而不是让底层 `cp` 抛出未捕获的原生异常。
 *
 * @param {string} rootDir - 技能库根。
 * @param {string} name - 技能名（相对库根的目录名）。
 * @param {string} fromDir - 源技能目录。
 * @returns {string | null} 被挡住的相对路径；null = 全部可用。
 */
function firstBlockedSkillRelPath(rootDir, name, fromDir) {
  for (const rel of listFilesRel(fromDir)) {
    if (resolveSkillLanding(rootDir, `${name}/${rel}`) === null) return rel
  }
  return null
}

/**
 * Approve one pending skill: move it from the pending directory into the
 * live skills directory (a rename — the skill is "installed" by the move).
 *
 * 落点断言（NF-1 第三轮 + A4/A5 修复，2026-09-23）：`to` 是 renameSync/拷贝的
 * **写入落点**，一律经 {@link resolveSkillLanding}（锚定技能库根、与
 * `skill_manage` 的写入同一份实现）。技能库里预置一条 `<name>` 符号链接
 * （指向任意目录）→ 如实拒收、库外零写入；`<name>` 是普通文件 → 可读拒收，
 * 不再交给原生 cp 去 abort 进程。
 *
 * @param {string} pendingDir - the pending-skills directory.
 * @param {string} skillDir - the live skills directory.
 * @param {string} name - the skill name (kebab-case).
 * @returns {{ok: true, path: string} | {ok: false, message: string}} the
 *   outcome; refuses to overwrite a live skill with the same name.
 */
export function approvePendingSkill(pendingDir, skillDir, name) {
  if (!isSkillName(name)) return { ok: false, message: smt('skillmsg.invalidNameShort', { name }) }
  const from = join(pendingDir, name)
  if (!existsSync(join(from, 'SKILL.md'))) {
    return { ok: false, message: smt('skillmsg.pendingMissing', { name }) }
  }
  const to = resolveSkillLanding(skillDir, name, { leaf: 'dir' })
  if (to === null) return { ok: false, message: smt('skillmsg.landingRefused', { name }) }
  if (existsSync(join(to, 'SKILL.md'))) {
    return { ok: false, message: smt('skillmsg.alreadyInLib', { name }) }
  }
  try {
    renameSync(from, to)
  } catch (error) {
    // Cross-device move (e.g. memoryDir on D: → ~/.agents/skills on C: on
    // Windows): rename(2) cannot cross filesystems. Fall back to copy + delete
    // so a pending skill on another volume can still be adopted.
    if (
      error?.code === 'EXDEV' ||
      error?.code === 'EBUSY' ||
      error?.code === 'EPERM' ||
      error?.code === 'EACCES' ||
      error?.code === 'ENOTEMPTY'
    ) {
      // If a live skill with the same name already exists (stub dir or real),
      // refuse — the check above only verified SKILL.md; the rename may have
      // failed because a directory already occupies the destination. Do not
      // clobber an existing skill directory.
      //
      // MERGE semantics: never remove `to` first. A pre-existing destination
      // directory may hold user data (notes, attachments) that an
      // unconditional rmSync(to) destroyed. The per-file copy overlays the
      // pending skill and leaves every other file in place (A5).
      if (existsSync(join(to, 'SKILL.md'))) {
        return { ok: false, message: smt('skillmsg.alreadyInLib', { name }) }
      }
      // A5（2026-09-23）：拷贝前的整树类型预检。目标目录里任何"同相对路径处不是
      // 目录"的条目在这里就变成可读拒收 —— 这正是从前交给原生 `cpSync` 的形态
      // （libstdc++ 未捕获异常 → `terminate called … cannot create directory:
      // File exists` → 宿主进程 exit 134），绝不能再走到底层去。
      if (firstBlockedSkillRelPath(skillDir, name, from) !== null) {
        return { ok: false, message: smt('skillmsg.landingRefused', { name }) }
      }
      copySkillTreeSafe(from, to, skillDir, name)
      rmSync(from, { recursive: true, force: true })
    } else {
      throw error
    }
  }
  return { ok: true, path: join(to, 'SKILL.md') }
}

/**
 * Reject one pending skill: delete it from the pending directory.
 * @param {string} pendingDir - the pending-skills directory.
 * @param {string} name - the skill name (kebab-case).
 * @returns {{ok: true} | {ok: false, message: string}} the outcome.
 */
export function rejectPendingSkill(pendingDir, name) {
  if (!isSkillName(name)) return { ok: false, message: smt('skillmsg.invalidNameShort', { name }) }
  const target = join(pendingDir, name)
  if (!existsSync(join(target, 'SKILL.md'))) {
    return { ok: false, message: smt('skillmsg.pendingMissing', { name }) }
  }
  rmSync(target, { recursive: true, force: true })
  return { ok: true }
}

/**
 * Read one skill's SKILL.md.
 * @param {string} dir - the skills directory.
 * @param {string} name - the skill name (kebab-case).
 * @returns {string | undefined} the raw content, or undefined when absent.
 */
export function readSkill(dir, name) {
  if (!isSkillName(name)) return undefined
  try {
    return readFileSync(join(dir, name, 'SKILL.md'), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Atomically write one skill's SKILL.md (creates the directory).
 * FIX-27（2026-09-13）：自锚定安全原子写（`SKILL.md.tmp.<pid>` 是可预置的
 * 写落点，预置同名符号链接即写穿到技能目录外）。
 * A4（2026-09-23 独立审计）：落点必须先过 {@link resolveSkillLanding} 的**库根**
 * 锚定断言，写盘时再把同一个根当 `anchorDir` —— 从前这里没有 anchorDir，落点
 * 父目录自己是符号链接时断言基准变成父目录，包含性判定恒真，`<库>/evil -> 库外`
 * 即可写穿并报成功。
 * @param {string} rootDir - 技能库根（或待确认队列根）。
 * @param {string} name - 技能名（kebab-case）。
 * @param {string} content - SKILL.md 全文。
 * @returns {string} 落点绝对路径。
 * @throws {Error} 落点被拒（符号链接 / 越出根 / 同名普通文件）。
 */
function writeSkill(rootDir, name, content) {
  const rel = `${name}/SKILL.md`
  const landing = resolveSkillLanding(rootDir, rel)
  if (landing === null) throw writeTargetRefusedError(join(rootDir, name, 'SKILL.md'))
  // NF-3 收敛后 writeFileAtomicSafeAt 缺省会跟随「落点文件本身是符号链接」
  // 的合法布局；技能内容不是状态文件——预置链接一律拒收（保持第一轮的判据）。
  writeFileAtomicSafeAt(join(rootDir, name, 'SKILL.md'), content, {
    anchorDir: rootDir,
    followFileSymlink: false,
  })
  return landing
}

/**
 * Whether the calling agent has read the skill before (read-before-write):
 * its own session log must contain a `skill_manage action=read <name>`
 * tool call. The session log is the authoritative reconstruction boundary.
 * @param {object | undefined} agent - the calling agent (may be absent for
 *   headless callers — those are refused by the caller's policy anyway).
 * @param {string} toolName - the configured skill tool name.
 * @param {string} name - the skill name.
 * @returns {boolean} true when a read is proven by the log.
 */
export function hasReadSkill(agent, toolName, name) {
  // ⚠️ DSH 0.1.2-alpha.4+ 的 Session 不再暴露 `.events` 数组，只有 `ownEvents()`
  // （同 lib/bookmarks.js / lib/review.js 的 2026-09-04 适配）。这里漏适配过一次：
  // `agent.session.events` 恒为 undefined，read-before-write 于是变成"永远没读过"，
  // `skill_manage action=patch` 在同一轮 read 成功之后仍被无条件拒绝
  // （真机工具诊断报告 2026-09-12）。
  const events = agent?.session?.ownEvents?.() ?? agent?.session?.events
  if (!Array.isArray(events)) return false
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    if (event.data?.name !== toolName) continue
    try {
      const args = JSON.parse(event.data.arguments)
      if (args.action === 'read' && args.name === name) return true
    } catch {
      // unparseable arguments — ignore
    }
  }
  return false
}

/**
 * Build the `skill_manage` tool definition.
 * @param {object} ctx - the plugin context (for the optional `skills`
 *   service used by the disabled-skill check).
 * @param {object} config - resolved plugin config (skillDir etc.).
 * @returns {object} a ToolDefinition-shaped object for ctx.tools.register.
 */
export function skillManageTool(ctx, config) {
  const dir = config.skillDir
  const pendingDir = join(config.memoryDir, 'pending-skills')

  /** Check the shared runtime registry for a disabled shadow. */
  const disabledReason = async (name) => {
    const skills = ctx.get('skills')
    if (!skills || typeof skills.list !== 'function') return undefined
    try {
      const list = await skills.list({})
      const skill = list.find((entry) => entry.name === name)
      return skill?.invocation?.modelInvocable === false
        ? skt('skill.disabledShadow', { name })
        : undefined
    } catch {
      return undefined
    }
  }

  /** 落点被拒 → fail-loud 的工具结果（A4：绝不把"没写成"报成 ok:true）。 */
  const refusedResult = (name, error) => ({
    ok: false,
    message: `${smt('skillmsg.writeRefused', { name })}（${String(error?.message ?? error)}）`,
  })

  /** Validate a create/patch body against the canonical format. */
  const validateBody = (name, description, body) => {
    if (!isSkillName(name)) {
      return { ok: false, message: skt('skill.invalidName', { name }) }
    }
    if (description !== undefined && !String(description).trim()) {
      return { ok: false, message: skt('skill.emptyDescription') }
    }
    if (typeof body !== 'string' || body.length === 0) {
      return { ok: false, message: skt('skill.emptyBody') }
    }
    if (body.length > config.skillMaxBytes) {
      return { ok: false, message: skt('skill.tooLarge', { limit: config.skillMaxBytes }) }
    }
    const parsed = parseFrontmatter(body)
    if (!parsed) {
      return { ok: false, message: skt('skill.badFrontmatter') }
    }
    if (parsed.name !== name) {
      return { ok: false, message: skt('skill.nameMismatch', { parsed: parsed.name, name }) }
    }
    if (description !== undefined && parsed.description !== String(description).trim()) {
      return { ok: false, message: skt('skill.descriptionMismatch') }
    }
    return { ok: true }
  }

  return {
    name: config.skillManageToolName,
    get description() { return skt('skill.desc') },
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'patch', 'read', 'list'],
          get description() { return skt('skill.action') },
        },
        name: {
          type: 'string',
          get description() { return skt('skill.name') },
        },
        description: {
          type: 'string',
          get description() { return skt('skill.description') },
        },
        body: {
          type: 'string',
          get description() { return skt('skill.body') },
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          name: { type: 'string' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
          content: { type: 'string' },
        },
        required: ['ok', 'message'],
      },
      render: (_args, value) => {
        const lines = [value.message ?? '']
        if (Array.isArray(value.entries) && value.entries.length > 0) {
          lines.push(skt('skill.listHeader', { count: value.entries.length }))
          value.entries.forEach((entry, index) => lines.push(`${index + 1}. ${entry.name} — ${entry.description}`))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const action = args.action
      const name = String(args.name ?? '').trim()
      switch (action) {
        case 'list': {
          const entries = listSkills(dir)
          return { ok: true, message: smt('skillmsg.listHead', { count: entries.length }), entries }
        }
        case 'read': {
          if (!isSkillName(name)) {
            return { ok: false, message: smt('skillmsg.invalidNameCase', { name }) }
          }
          const content = readSkill(dir, name)
          if (content === undefined) {
            return { ok: false, message: smt('skillmsg.missing', { name }) }
          }
          return { ok: true, message: smt('skillmsg.read', { name, bytes: content.length }), name, content }
        }
        case 'create': {
          const checked = validateBody(name, args.description, args.body)
          if (!checked.ok) return checked
          const disabled = await disabledReason(name)
          if (disabled) return { ok: false, message: disabled }
          if (readSkill(dir, name) !== undefined) {
            return { ok: false, message: smt('skillmsg.existsUsePatch', { name }) }
          }
          // Skill creations go through the pending queue unless the user
          // enabled direct auto-harvest: the skill lands in
          // <memoryDir>/pending-skills/ and is installed by moving it into
          // the live skills dir when the user approves it in the panel.
          // Applies to every session (the review runs in the main session).
          if (!config.skillReviewEnabled) {
            if (readSkill(pendingDir, name) !== undefined) {
              return { ok: false, message: smt('skillmsg.pendingDuplicate', { name }) }
            }
            // 待确认队列的落点同样锚定队列根（A4：写穿在两条分支上是同一个缺陷）。
            try {
              writeSkill(pendingDir, name, args.body)
            } catch (error) {
              return refusedResult(name, error)
            }
            return {
              ok: true,
              message: smt('skillmsg.createdPending', { name }),
              name,
            }
          }
          try {
            writeSkill(dir, name, args.body)
          } catch (error) {
            return refusedResult(name, error)
          }
          return { ok: true, message: smt('skillmsg.created', { name, bytes: args.body.length }), name }
        }
        case 'patch': {
          const checked = validateBody(name, undefined, args.body)
          if (!checked.ok) return checked
          const disabled = await disabledReason(name)
          if (disabled) return { ok: false, message: disabled }
          if (readSkill(dir, name) === undefined) {
            return { ok: false, message: smt('skillmsg.missingUseCreate', { name }) }
          }
          if (!hasReadSkill(exec?.agent, config.skillManageToolName, name)) {
            return {
              ok: false,
              message: smt('skillmsg.readFirst', { name, tool: config.skillManageToolName }),
            }
          }
          try {
            writeSkill(dir, name, args.body)
          } catch (error) {
            return refusedResult(name, error)
          }
          return { ok: true, message: smt('skillmsg.updated', { name, bytes: args.body.length }), name }
        }
        default:
          return { ok: false, message: smt('skillmsg.unknownAction', { action }) }
      }
    },
  }
}
