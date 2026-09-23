/**
 * COI 内置技能同步 — 适配器使用指南的"源头"在插件里。
 *
 * 设计（用户拍板）：AI 使用 COI 的指南 = 正常技能（默认启用，可在
 * 「技能管理」Tab 禁用）。插件包内自带内置技能（skills/ 目录），
 * 插件启动时同步到技能库（落点 = `config.skillDir`，桌面端缺省 `<DSH_HOME>/skills`）：
 *   - 目标不存在 → 复制（装上）
 *   - 目标存在且**溯源渠道就是 plugin**，x-version 更低 → 整目录覆盖
 *     （源头在插件，升级随插件更新）
 *   - 一致 → 跳过
 *   - 目标存在、**没有**任何溯源，而内容与随包技能**逐字相同** → **采纳**
 *     （补写 `channel:'plugin'`，见 {@link isIdenticalTree}）—— 给 A9 之前
 *     落下的历史副本用的一次性兼容
 *   - 目标存在但是用户自制内容 / 另一条商店渠道的同名技能 → **拒绝**（fail-loud，
 *     `action: 'refused'` + `code`），绝不整树覆盖 —— 见 {@link classifySyncTarget}
 *     与本文档的"来源闸门"段（P1-1/P1-2，2026-09-23 独立审计 W4）
 * 同步以**整目录**为单位（SKILL.md + scripts/ 等辅助文件随技能一起走）；
 * 被禁用的技能文件仍存在，只是不注入模型。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { writeFileAtomicSafeAt, writeTargetRefusedError } from '../sync/filesets.js'

/**
 * 换入过程中的两个临时目录名（都与目标同父目录，同一文件系统才能 rename）：
 *   - `.staging-<name>-<pid>-<ts>`：新内容先全部写这里，写完整体换入；
 *   - `.old-<name>-<pid>-<ts>`：旧目录先原子改名到这里"旁置"，换入成功后再删。
 * 两个名字都带 pid/时间戳：既是并发同步的隔离（互不覆盖），也是崩溃残留的
 * 清扫判据（见 {@link sweepStaleSwapDirs}）。
 *
 * ⚠️ **前导点（A16 修复，2026-09-23 独立审计）**：这两个目录此前是
 * `<name>.staging-<pid>-<ts>`（无前导点，形如 `memory-consolidate.staging-…`）。
 * 那个名字**命中**客户端的 `SKILL_NAME_PATTERN`（`^[a-z0-9][a-z0-9._-]{0,63}$`）
 * 且内部有完整 SKILL.md ⇒ 换入被 SIGKILL 打断的窗口期内，能力中心的
 * `listInstalledSkills` 会把它报成"一个已安装技能"、上游发现器也会加载它
 * （同名重复候选），直到下次启动清扫。前导点让它在两条路径上同时消失
 * （客户端与上游的名字规则都要求首字符是 [a-z0-9]）。
 * 旧命名仍被 {@link parseSwapDirName} 解析：升级后盘上可能还留着旧版本写下的
 * 残留，不认它们就等于让这些幽灵目录永久占位。
 */
const STAGING_INFIX = '.staging-'
const ASIDE_INFIX = '.old-'

/**
 * 安装器写在技能目录里的**非技能内容**（A9 修复，2026-09-23 独立审计）：
 * 整目录换入时必须从旧目录搬进新内容，否则——
 *   - `.picoaide/release.json`（来源徽章 + 「是否被本地修改」的判据）消失，
 *     同步后该技能在能力中心退回"用户自制"；
 *   - `.install-version`（遥测读的已装版本）消失。
 * 两者都由客户端安装器写，本插件只负责**不丢**它们。
 */
const INSTALLER_MARKERS = ['.picoaide', '.install-version']

/**
 * 本插件写下的溯源目录/文件名，与 enterprise 安装器的
 * `PROVENANCE_DIR` / `release.json` **同值**：跨包 import 禁止（本插件是随包
 * vendored 副本，不依赖企业包），所以这里是本地常量而不是 import。
 */
const PROVENANCE_DIR = '.picoaide'
const PROVENANCE_FILE = 'release.json'

/**
 * 本插件来源的渠道取值（A9 修复）：`SkillProvenance.channel` 的取值域由
 * `'market' | 'org' | 'builtin'` 扩展为 `'market' | 'org' | 'builtin' | 'plugin'`
 * （跨泳道契约，由企业包的 `readProvenance` 接受）。装上之后能力中心据此知道
 * 这份技能是**插件随包**装上的，而不是用户自制。
 */
const PLUGIN_CHANNEL = 'plugin'

/**
 * 商店来源渠道（P1-1/P1-2 修复，2026-09-23 独立审计 W4）。
 *
 * ⚠️ 这是**企业包安装器同一判据的本地副本**，真源在
 * `packages/host/enterprise/src/skill-install.ts` 的
 * `STORE_PROVENANCE_CHANNELS`（值 `['market','org','builtin','plugin']`）。
 * 跨包 import 禁止（本插件是随包 vendored 副本，不依赖企业包），所以这里复刻
 * 取值集合，不 import。**改真源必须同步改这里**：两边漂移的后果是"安装器认为
 * 是商店来源、同步器认为是用户内容"（或反过来），也就是本次要修的这类静默覆盖。
 */
const STORE_CHANNELS = ['market', 'org', 'builtin', PLUGIN_CHANNEL]

/**
 * 拒绝码（P1-1 修复）：与安装器一样，**如实报 refused 并点名原因**，绝不静默
 * 覆盖。三者都出现在 `syncBuiltinSkills` 结果的 `code` 字段上：
 *   - {@link SKILL_LOCAL_CONTENT}：目标目录没有可用的安装器溯源、且**不能**用内容
 *     同一性证明它是本插件的副本 ⇒ 按"用户自制"处理（判据与安装器的
 *     `classifyInstalledSkill === 'local'` 同源）；
 *   - {@link SKILL_CHANNEL_CONFLICT}：目标目录是**另一条商店渠道**（market /
 *     org / builtin）装进来的 ⇒ 整树换入会把渠道从那条改成 plugin，两边会在
 *     每次开机互相覆盖（P1-2 的乒乓球）；
 *   - {@link SKILL_ADOPT_FAILED}：内容同一性成立（= 已证明是本插件的副本），但
 *     **补写溯源失败** ⇒ 仍然拒绝。这一条必须 fail-loud：否则会出现"内容按 plugin
 *     更新了、溯源却还不是 plugin"的中间态。
 */
const SKILL_LOCAL_CONTENT = 'SKILL_LOCAL_CONTENT'
const SKILL_CHANNEL_CONFLICT = 'SKILL_CHANNEL_CONFLICT'
const SKILL_ADOPT_FAILED = 'SKILL_ADOPT_FAILED'

/**
 * 暂存/旁置目录的"陈旧"年龄上限：超过它一律按崩溃残留清扫（即便 pid 还在
 * 进程表里 —— pid 会被复用，长时间没人管的目录不可能是"正在跑的同步"）。
 */
const STALE_SWAP_MAX_AGE_MS = 6 * 60 * 60 * 1000

/**
 * 插件内置的技能清单（目录名 = 技能名）—— **只含本插件自己的技能**。
 *
 * ⚠️ **平台技能不在这个清单里**（2026-09-18，用户口径 + 独立审计 P1-1 的修复）：
 * 平台内置的 WASM 应用作者手册（原名 `picoaide-app-builder`，2026-09-19 改名
 * `app-builder`）是**平台内置技能**：内容随服务端镜像发布
 * （`GET /api/client/v2/skills/builtin`），由员工在客户端「能力中心 → 平台内置技能」
 * **按需安装**。
 *
 * 为什么会踩：要"内置到服务端 + 按需安装"，就不能有一条开机自动把它写进技能库的
 * 旁路 —— 否则员工什么都没点，面板已经显示"已安装"，安装按钮永远走不到，
 * 「按需」名存实亡（审计实测：apply() 一次之后技能就在 `<DSH_HOME>/skills` 里，
 * 且没有能力中心的溯源信息）。
 *
 * 2026-09-19 起它的**源目录也不在本包了**：真源在服务端仓库的
 * `server/skills/app-builder/`（随镜像分发，见 `server/Dockerfile`）—— 所以本包
 * `skills/` 目录里剩下的**全部**都是本插件自己的技能（{@link BUILTIN_SKILLS} 与
 * 磁盘内容一一对应，回归用例钉住）。
 *
 * 回归门禁：`tests/coi.test.js` 断言本清单里不含任何平台技能、且平台技能目录不在包内；
 * `tests/builtin-skills-decoupled.test.js` 断言 apply() 之后它**没有**被装上。
 */
export const BUILTIN_SKILLS = [
  'kimi-cli-calling',
  'codex-cli-calling',
  'grok-cli-calling',
  'hermes-cli-calling',
  'memory-consolidate',
]

/**
 * 由**服务端**分发、客户端按需安装的技能名（不属于本插件的同步范围）。
 *
 * 单独列出来是为了让"哪些是平台技能"这件事有唯一真源：同步逻辑与回归测试都读它，
 * 而不是各自写一遍字面量（写两处就会漂移，漂移的后果见 {@link BUILTIN_SKILLS}）。
 *
 * ⚠️ **2026-09-19 起清单里的技能已不在本包内**：作者手册改名 `app-builder`，
 * 源目录搬到服务端仓库的 `server/skills/app-builder/`（随服务端镜像发布；
 * `server/Dockerfile` 直接 COPY，不再有 `--build-context skillassets`）。
 *
 * 清单**保留而不是清空**：它挡的从来不是"目录在哪"，而是"**这个技能名永远不许经
 * 开机同步落进用户技能库**"。`syncBuiltinSkills` 里那句守卫与两条回归用例都靠它
 * 承重，清空会让「平台技能不得被自动安装」这条不变量静默失去覆盖 —— 而一旦有人
 * 手滑把 `app-builder` 目录（连同 BUILTIN_SKILLS 里的一行）加回本包，就该由这里拦住。
 */
export const PLATFORM_SKILLS = ['app-builder']

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
 * 读目标技能目录的安装器溯源渠道（P1-1 修复，2026-09-23 独立审计 W4）。
 *
 * 判据与企业包安装器的 `isStoreProvenance`（`skill-install.ts:483-485`）
 * **逐条同源**，三件事必须同时成立才算"这份内容不是用户手写的"：
 *   1. `<dir>/.picoaide/release.json` 可读且是 JSON 对象；
 *   2. `appId` 是 string 且**等于目录名**（目录被改名/被占用时不算）；
 *   3. `channel` 是已知的商店渠道取值（见 {@link STORE_CHANNELS}；未知取值按
 *      "非商店来源"处理 —— 与安装器"未知渠道不回落成 market"的历史修复同口径）。
 * 任何一条不成立都返回 `undefined` = 按用户自制内容处理（宁可多拒一次，不可
 * 静默覆盖/删除用户内容）。
 *
 * @param {string} destDir - 技能库内的目标技能目录。
 * @param {string} name - 期望的技能名（= 目录名）。
 * @returns {string|undefined} 渠道取值；不是商店来源时为 undefined。
 */
function readStoreChannel(destDir, name) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(join(destDir, PROVENANCE_DIR, PROVENANCE_FILE), 'utf8'))
  } catch {
    return undefined // 没有标记 / 读不出来 / JSON 坏 —— 都是"不是商店来源"
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  if (typeof parsed.appId !== 'string' || parsed.appId !== name) return undefined
  if (typeof parsed.channel !== 'string' || !STORE_CHANNELS.includes(parsed.channel)) return undefined
  return parsed.channel
}

/**
 * 整树换入**之前**的来源闸门（P1-1 / P1-2 修复，2026-09-23 独立审计 W4）。
 *
 * 为什么必须有它：本插件的开机同步原先只看 `x-version`（{@link syncBuiltinSkills}
 * 的 `needsCopy`），于是**任何**同名目录都会被整树换入 —— 用户手写的同名技能连同
 * 自己的笔记/脚本一起被删、还被补上 `channel: 'plugin'` 的溯源（能力中心此后按
 * "商店来源"对待）。实测（W4 probe5 情形 1）：用户文件消失、`installedOrigin`
 * 从 `local` 翻 `store`，全程零确认。它同时是 P1-2 的一半：市场装进来的同名技能
 * 会被换回插件版而 `.picoaide` 原样保留 ⇒ 内容与徽章归属不一致。
 *
 * 判据（**同一个函数同时决定覆盖与不覆盖**，不在调用点各写一遍）：
 *   - 目录不存在 → 允许（首次安装，正常路径）；
 *   - 渠道 === `plugin` → 允许（`x-version` 正常更新；安装器标记由 A9 保留）；
 *   - 渠道是**其它**商店渠道（market/org/builtin）→ 拒绝（换渠道 = 两边每次开机
 *     互相覆盖，必须由用户显式处置，见 {@link SKILL_CHANNEL_CONFLICT}）；
 *   - 没有任何 `release.json` → 拒绝，但标 `adoptable: true`：调用方再用**内容同一
 *     性**（{@link isIdenticalTree}）决定能不能"采纳"（成立则补写溯源后报 `adopted`）；
 *   - 有 `release.json` 但读不出可用渠道（JSON 坏 / `appId` 不符 / 未知渠道）→ 拒绝，
 *     且 `adoptable: false` —— **不覆盖看不懂的标记**（宁可多拒一次）。
 *
 * 注意"目录存在但没有 SKILL.md"同样按**存在**处理：那可能是用户自己的目录
 * （只有若干笔记文件），整树换入会把它们删掉。首次安装请让落点不存在。
 *
 * @param {string} destDir - 技能库内的目标技能目录。
 * @param {string} name - 技能名（= 目录名）。
 * @returns {{ok:true}|{ok:false, adoptable:boolean, code:string, message:string}} 判定结果。
 */
function classifySyncTarget(destDir, name) {
  const channel = readStoreChannel(destDir, name)
  if (channel === PLUGIN_CHANNEL) return { ok: true }
  if (channel !== undefined) {
    return {
      ok: false,
      adoptable: false,
      code: SKILL_CHANNEL_CONFLICT,
      message: `${destDir} 是「${channel}」渠道装进来的同名技能 —— 整树换入会把它的来源改成 plugin`
        + '（内容与溯源归属不一致，且两条渠道会在每次开机互相覆盖）；已拒绝。'
        + '若要使用随包内置技能，请先在能力中心卸载该同名技能或改掉它的目录名。',
    }
  }
  // 有没有"看不懂的标记"决定能不能走内容同一性采纳：有标记就一律不采纳
  // （覆盖别人的来源标记比拒绝危险得多）。
  const hasMarker = existsSync(join(destDir, PROVENANCE_DIR, PROVENANCE_FILE))
  return {
    ok: false,
    adoptable: !hasMarker,
    code: SKILL_LOCAL_CONTENT,
    message: hasMarker
      ? `${destDir} 有安装器溯源标记但读不出可用来源（JSON 坏 / appId 不符 / 渠道未知）—— 不覆盖看不懂的标记；已拒绝。`
      : `${destDir} 已存在，但没有安装器溯源（按"用户自制"处理）—— 整树换入会连同你自己的文件一起删掉；已拒绝。`,
  }
}

/**
 * 目标目录是不是随包技能目录的**逐字副本**（P1-1 兼容路径的判据，内容同一性）。
 *
 * **背景**：写溯源的 A9 修复不在任何已发布版本里 ⇒ 现场存在"旧版插件同步落下、
 * 目录里没有 `.picoaide`"的技能目录。来源闸门会把它们按用户自制拒收：今天无碍
 * （磁盘状态与旧行为相同），但**将来**插件升 `x-version` 时它们不会更新。这个判据
 * 给它们一次自证机会（见 {@link syncBuiltinSkills} 的采纳分支）。
 *
 * 三条同时成立才算（**可验证的同一性，不是启发式**）：
 *   1. 条目集合逐项相同：文件**与目录**都算，相对路径、排序位置、种类（file/dir）
 *      全部一致 —— 多一个、少一个、改名、文件↔目录都判不同；
 *   2. 每个普通文件字节相同（`Buffer.equals`，不做文本解码，避免编码层归一化）；
 *   3. 全程没有任何**符号链接**、FIFO/设备等异常条目，也没有读不出来的条目
 *      （任何一项异常都判不同 —— 宁可拒收）。
 *
 * **为什么可以采纳"用户手工复制的随包技能副本"**：内容既然与随包技能逐字相同，
 * 这份目录里就不存在任何用户创作的字节；采纳只写一个来源标记（不动正文），之后
 * 升级替换掉的也只是随包技能自己的字节。反过来，只要用户改过一个字节、加过一个
 * 文件，判据就不成立 ⇒ 仍然 `refused`，绝不触碰。
 *
 * **为什么不用 mtime/大小做更严的判据**：大小是字节比较的推论，不增加信息；
 * mtime 在真实链路里不可比（随包技能来自安装包/asar 解包，取值由打包工具决定；
 * 旧同步写下的文件 mtime 是同步当时的时间），拿它判等只会造成误拒 —— 即"更严的
 * 判据"实际是"更不可靠的判据"。**字节等同是此处可得的最强证据**。
 *
 * 目录项用 `lstat` 逐个判定（不依赖 `readdirSync(..., {withFileTypes:true})` 的
 * Dirent 合成）：随包技能目录在打包版里位于 asar 内，`lstat` 是 Electron 必然会
 * 补的那一层；任何一步拿不到真实类型都按"不同"处理（fail-safe，不会误采纳）。
 *
 * @param {string} srcDir - 插件包内技能目录。
 * @param {string} destDir - 目标技能目录。
 * @returns {boolean} 逐字相同为 true。
 */
function isIdenticalTree(srcDir, destDir) {
  const srcEntries = listEntriesRel(srcDir)
  const destEntries = listEntriesRel(destDir)
  if (srcEntries === null || destEntries === null) return false
  // 条目集合必须逐项相同（多一个 / 少一个 / 改名 / 种类不同都算不同）。
  if (srcEntries.length !== destEntries.length) return false
  for (let i = 0; i < srcEntries.length; i += 1) {
    const src = srcEntries[i]
    const dest = destEntries[i]
    if (src.rel !== dest.rel || src.dir !== dest.dir) return false
    if (src.dir) continue
    const left = readFileOrNull(join(srcDir, src.rel))
    const right = readFileOrNull(join(destDir, dest.rel))
    if (left === null || right === null) return false
    if (!left.equals(right)) return false
  }
  return true
}

/**
 * 列出目录下的条目（相对路径 + 是目录否），按相对路径排序。
 *
 * 只认普通文件与目录；遇到符号链接、FIFO/设备等异常条目、或任一 `lstat`/`readdir`
 * 失败，一律返回 `null`（调用方按"无法证明相同"处理）。
 * @param {string} dir - 目录。
 * @param {string} [prefix] - 递归用前缀。
 * @returns {Array<{rel:string, dir:boolean}>|null} 条目列表；异常为 null。
 */
function listEntriesRel(dir, prefix = '') {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  const out = []
  for (const name of names) {
    const rel = prefix === '' ? name : `${prefix}/${name}`
    const full = join(dir, name)
    let stat
    try {
      stat = lstatSync(full)
    } catch {
      return null // 悬空符号链接 / 权限 / 竞态删除 —— 都判"不同"
    }
    if (stat.isSymbolicLink()) return null
    if (stat.isDirectory()) {
      out.push({ rel, dir: true })
      const nested = listEntriesRel(full, rel)
      if (nested === null) return null
      out.push(...nested)
    } else if (stat.isFile()) {
      out.push({ rel, dir: false })
    } else {
      return null // FIFO / socket / 设备节点
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/**
 * 读文件字节；读不出来返回 null（调用方判"不同"）。
 * @param {string} file - 绝对路径。
 * @returns {Buffer|null} 内容。
 */
function readFileOrNull(file) {
  try {
    return readFileSync(file)
  } catch {
    return null
  }
}

/**
 * 落点是否**已经存在任何东西**（不跟随符号链接，`lstat` 语义）。
 *
 * 与 `existsSync` 的差别正是闸门要的那种：指向不存在目标的悬空符号链接
 * `existsSync` 为假，但它**占着这个落点**，必须交给 {@link syncSkillDirSafe} 的
 * 断言去拒收（预置链接是拒收而不是被换入静默删掉，本地 NF-1 口径）。
 * @param {string} path - 待检查的路径。
 * @returns {boolean} 存在（含符号链接、普通文件）为 true。
 */
function isPresent(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
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
 * 覆盖策略（保护用户内容）：目标缺失 → 复制；目标存在且溯源渠道就是 `plugin`、
 * 且 x-version 更低 → 整目录覆盖（插件升级，SKILL.md 与 scripts/ 等辅助文件一起
 * 更新）；版本一致 → 不动；**目标是用户自制内容或另一条商店渠道的同名技能 →
 * 拒收**（`refused`，见 {@link classifySyncTarget}）；目标没有任何溯源但内容与
 * 随包技能**逐字相同** → 采纳（补写溯源后报 `adopted`）。
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
 * **来源闸门（P1-1 / P1-2 修复，2026-09-23 独立审计 W4）**：覆盖之前先判定目标
 * 目录的安装器溯源（{@link classifySyncTarget}）——用户自制内容与"另一条商店渠道"
 * 的同名技能一律不动、如实记 `refused`（并打日志点名技能与原因）；只有目录不存在
 * 或渠道就是 `plugin` 时才走 `x-version` 更新。这一条与安装器的
 * `classifyInstalledSkill` / `isStoreProvenance` 是同一份判据（本地副本，见
 * {@link STORE_CHANNELS}），不是第二套口径。
 *
 * **兼容路径（P1-1 追加，同轮）**：目录**完全没有** `release.json`、但内容与随包技能
 * **逐字相同**时（{@link isIdenticalTree}）⇒ 内容是随包
 * 技能的副本这一点已被证明，于是补写 `channel: 'plugin'` 溯源并报 `adopted`，
 * 此后走正常更新路径。这是给"旧版插件同步落下、还没写溯源"的目录的一次性兼容；
 * 同一性不成立（多/少文件、任何字节差异、符号链接、读失败）一律照旧 `refused`。
 *
 * @param {string} pluginSkillsDir - 插件包内 skills/ 目录的绝对路径。
 * @param {string} userSkillsDir - 用户技能库目录（`config.skillDir`，桌面端缺省 `<DSH_HOME>/skills`）。
 * @returns {Array<{name:string, action:'synced'|'unchanged'|'adopted'|'missing'|'refused', message?:string, code?:string}>}
 *   `adopted` = 内容与随包技能逐字相同、本次只补写了溯源（未换入）。
 *   `code` 只在可区分的失败上出现：换入+回滚双失败的
 *   `SKILL_SWAP_RECOVERY_FAILED`（见 {@link SkillSwapRecoveryError}），以及来源闸门
 *   的 `SKILL_LOCAL_CONTENT` / `SKILL_CHANNEL_CONFLICT` / `SKILL_ADOPT_FAILED`。
 */
export function syncBuiltinSkills(pluginSkillsDir, userSkillsDir) {
  const results = []
  // S13-3 复核（2026-09-17）：先清扫上次同步留下的暂存/旁置目录。SIGKILL/断电
  // 不会走 catch，`<name>.staging-<pid>-<ts>` 会永久留在技能库里（它的 SKILL.md
  // 带真实技能的 frontmatter name，是个只会越积越多的幽灵）；清扫放在同步开头，
  // 每次启动都收一遍。
  sweepStaleSwapDirs(userSkillsDir)
  for (const name of BUILTIN_SKILLS) {
    // 纵深防御：平台技能由服务端分发、员工按需安装，任何情况下都不许经这条
    // 开机同步路径落进技能库。清单本身已经把它们排除了，这一条挡的是"将来有人
    // 手滑把平台技能名加回 BUILTIN_SKILLS"——那种回归会让「按需安装」静默失效，
    // 而失效的表现只是"按钮变成已安装"，没有任何报错。
    if (PLATFORM_SKILLS.includes(name)) continue
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
    let code
    /** 本次是否走了"内容同一性采纳"（决定 unchanged 是否报成 adopted）。 */
    let adopted = false
    // 来源闸门（P1-1/P1-2）：目标目录存在时，**先**判定它是不是本插件自己的
    // （渠道 = plugin）。用户自制内容与其它商店渠道的同名技能都拒收；这一判定
    // 与 x-version 无关 —— 版本相同也照样如实报 refused，否则"本机是别的东西"
    // 会被 `unchanged` 掩盖成"已经是最新"。
    if (isPresent(destDir)) {
      const verdict = classifySyncTarget(destDir, name)
      if (!verdict.ok) {
        // 兼容路径（P1-1 追加，2026-09-23）：目录**没有任何** `release.json` 时，
        // 允许用"内容与随包技能逐字相同"来自证它确实是一份未经溯源的本插件副本
        // （A9 写溯源的修复不在任何已发布版本里 ⇒ 现场存在这类目录）。同一性
        // 不成立就照旧拒收；证明成立则**先补写溯源**再走正常路径。
        if (verdict.adoptable) {
          if (!isIdenticalTree(srcDir, destDir)) {
            const reason = `${verdict.message} 内容同一性判据不成立：目标目录必须与随包技能逐项相同`
              + '（多一个/少一个条目、改名、文件↔目录、任何字节差异、符号链接或读取失败都算不同）。'
            console.warn(`[dsh-memory-evolve] 内置技能 ${name} 未同步（保留本机内容，${SKILL_LOCAL_CONTENT}）：${reason}`)
            results.push({ name, action: 'refused', message: reason, code: SKILL_LOCAL_CONTENT })
            continue
          }
          // 同一性成立 = 已证明这是随包技能的副本，且目录里没有任何用户字节。
          // **先写溯源再走后面**：写失败即拒（绝不出现"内容换了、溯源没写"）。
          try {
            writePluginProvenance(destDir, name, skillVersion(srcText), userSkillsDir)
          } catch (error) {
            // 失败即拒（不换入、不改内容）。顺手把本次可能已建出来的**空**
            // `.picoaide/` 收掉：同一性检查刚刚证明它原本不存在，所以这里只删空目录
            // （`rmdirSync` 非空即失败，绝不递归删任何东西）——否则那个空目录会让
            // 下一次开机的同一性判据恒不成立，把这一份永久挡在门外（无法自愈）。
            try { rmdirSync(join(destDir, PROVENANCE_DIR)) } catch { /* 非空/不存在/删不掉：留着，下次照旧拒收（fail-safe） */ }
            const reason = '内容同一性成立（确认是随包技能的逐字副本），但补写溯源（channel: plugin）失败，'
              + `已拒绝（不换入、不改内容）：${String(error?.message ?? error)}`
            console.warn(`[dsh-memory-evolve] 内置技能 ${name} 未同步（保留本机内容，${SKILL_ADOPT_FAILED}）：${reason}`)
            results.push({ name, action: 'refused', message: reason, code: SKILL_ADOPT_FAILED })
            continue
          }
          adopted = true
          console.log(`[dsh-memory-evolve] 内置技能 ${name} 已采纳（内容与随包技能逐字一致、原缺溯源，已补写 channel: plugin）：${destDir}`)
        } else {
          // fail-loud：点名技能、原因与落点。整树换入会删掉目标目录里的**全部**
          // 内容（含用户自己的文件），所以这里绝不"尽力而为"。
          console.warn(`[dsh-memory-evolve] 内置技能 ${name} 未同步（保留本机内容，${verdict.code}）：${verdict.message}`)
          results.push({ name, action: 'refused', message: verdict.message, code: verdict.code })
          continue
        }
      }
    }
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
        if (typeof error?.code === 'string') code = error.code
        if (error?.code === 'SKILL_SWAP_RECOVERY_FAILED') {
          // S13-3 复核（2026-09-17）：换入失败**且**回滚也失败——比普通 refused
          // 严重一级（技能目录当前缺失，新旧两份副本还在盘上）。用 error 级别 +
          // 点名路径，让它在启动日志里不被 warn 洪水淹没。
          console.error(`[dsh-memory-evolve] 内置技能 ${name} 换入失败且未能回滚，需人工恢复：${message}`)
        } else {
          console.warn(`[dsh-memory-evolve] 内置技能 ${name} 落点被拒（跳过）：${message}`)
        }
      }
    } else if (adopted) {
      // 内容既然与随包技能逐字相同，`x-version` 必然相同（同一份 SKILL.md）⇒
      // 不需要换入。本次的唯一动作就是补写溯源，如实报 `adopted`（不是 unchanged：
      // 调用方/日志要能看出"这份目录是被采纳的，不是本来就带溯源的"）。
      action = 'adopted'
    }
    results.push({
      name,
      action,
      ...(message === undefined ? {} : { message }),
      ...(code === undefined ? {} : { code }),
    })
  }
  // S13-3 三轮复核（2026-09-17）：**收尾再扫一遍**。SIGKILL 落在"改名为 .old-* 之后、
  // 暂存目录换入之前"时（dest 缺失 + .old-* 是旧内容唯一副本），开头的清扫必须留下
  // .old-*；本次同步刚把真目录装回来，这一遍就能立刻收掉它 —— 否则它会以"带真实
  // frontmatter name 的幽灵目录"活到下次启动，被 DSH 技能发现记成重复候选
  // （skill … ignored because a higher-priority skill already exists，整整一个会话）。
  sweepStaleSwapDirs(userSkillsDir)
  return results
}

/**
 * 整目录落盘（上游 v26091501 的"整目录同步"语义 × 本地 NF-1 落点断言）。
 *
 * 语义：**先写暂存目录、全部写成后整体换入**——用户自加在内置技能目录里的
 * 文件随整目录替换一起消失（上游"整目录覆盖"行为不变）。安全面：
 *   - `<userSkillsDir>/<name>` 存在但不是真实目录（符号链接 / 普通文件）→ 拒收；
 *   - 目标目录内**任何**符号链接条目 → 拒收（换入之前先扫，见下）；
 *   - 逐文件 `writeFileAtomicSafeAt(..., { anchorDir })`：从技能库根到落点整条链
 *     逐层 lstat，任一符号链接或真实路径逃出技能库即拒收（含 TOCTOU 窗口——
 *     断言在原子写内部对写入前的真实路径复检）。
 * 任一文件被拒即抛错，由调用方记 `refused` 并跳过该技能（不静默半写）。
 * S13-3（2026-09-17 审计）：上一版是"先 rm 目标目录再逐文件写"，循环里任何
 * 一次失败（ENOSPC/EACCES/预扫之后才出现的符号链接…）都会把已装好的技能删空
 * 或写一半，而调用方只记 refused——与本函数"不静默半写"的承诺相反（v2.7.4 的
 * 单文件原子写在失败时保留旧文件，属回归）。
 *
 * **换入是三步可恢复的（S13-3 复核，2026-09-17）**：
 *   1) `rename(old → .old-<name>-<pid>-<ts>)` 把旧目录原子旁置（不再先 rm）；
 *   2) `rename(.staging-<name>-<pid>-<ts> → dest)` 让新内容就位；
 *   3) 删除旁置副本（尽力而为，删不掉留给下次同步清扫）。
 * 因此失败面只有两种，且都不丢内容：
 *   - 第 2 步失败 → 先把旁置副本改回原处再抛原始错误（旧技能原封不动，暂存副本
 *     清理掉），调用方记 `refused`；
 *   - 第 2 步失败**且**回滚也失败 → 抛 {@link SkillSwapRecoveryError}
 *     （code=SKILL_SWAP_RECOVERY_FAILED），错误文本点名暂存（新）与旁置（旧）两份
 *     副本路径，调用方按"需要人工恢复"上报，而不是含糊的 refused。
 * 保证的边界要说清：**"旧目录在失败时原样保留"只覆盖到上面这两条路径**；进程被
 * SIGKILL/断电打断（不走 catch）时目录状态取决于断点，残留由下次同步开头的
 * {@link sweepStaleSwapDirs} 收拾。
 *
 * A9（2026-09-23）追加一条：换入前后**安装器标记不丢**——旧目录的
 * `.picoaide/`.install-version 先搬进新内容，再补一份本插件自己的 provenance
 * （channel: 'plugin'），见 {@link stashInstallerMarkers} / {@link writePluginProvenance}。
 *
 * @param {string} srcDir - 插件包内技能目录。
 * @param {string} destDir - 用户技能库内的目标目录。
 * @param {string} anchorDir - 技能库根（落点断言的基准）。
 */
function syncSkillDirSafe(srcDir, destDir, anchorDir) {
  const name = basename(destDir)
  let hadDest = false
  try {
    const stat = lstatSync(destDir)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw writeTargetRefusedError(destDir)
    hadDest = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  // 换入**之前**先扫一遍：目标目录里任何符号链接条目都拒收。上游的整目录语义
  // 是 `rm -rf` 后重铺，遇到预置的 `<name>/SKILL.md` 链接会"顺带删掉链接再写真
  // 文件"——不写穿，但把拒收变成了静默删除（调用方看到 synced，用户预置的链接
  // 却没了）。本地 NF-1 的口径是 fail-loud：不动那个链接、如实报 refused。
  const planted = findSymlinkEntry(destDir)
  if (planted !== null) throw writeTargetRefusedError(join(destDir, planted))
  // 暂存目录与目标同父目录（同一文件系统，rename 才能原子换入）；落点仍在
  // 技能库根之下，逐文件断言（anchorDir）照旧生效。名字**以点开头**（A16）：
  // 窗口期内既不被能力中心当成"已安装技能"，也不被上游发现器加载。
  const stamp = `${process.pid}-${Date.now()}`
  const stagingDir = join(anchorDir, `${STAGING_INFIX}${name}-${stamp}`)
  let asideDir = null
  /** 从旧目录搬进暂存目录的安装器标记（回滚时要搬回去）。 */
  let stashedMarkers = []
  try {
    mkdirSync(stagingDir, { recursive: true })
    const srcText = readFileSync(join(srcDir, 'SKILL.md'), 'utf8')
    for (const rel of listFilesRel(srcDir)) {
      writeFileAtomicSafeAt(join(stagingDir, rel), readFileSync(join(srcDir, rel)), { anchorDir })
    }
    // A9（2026-09-23）：整目录换入**不丢安装器标记**——旧目录里的 `.picoaide/`
    // 与 `.install-version` 先搬进新内容，随同一次原子 rename 回到位；目标没有
    // provenance 时再补一份本插件自己的（channel: 'plugin'），使能力中心不会把
    // 随包装上的技能当成"用户自制"。两步都在换入之前完成，所以没有"换入成功但
    // 溯源丢了"的中间态。
    stashedMarkers = stashInstallerMarkers(destDir, stagingDir)
    writePluginProvenance(stagingDir, name, skillVersion(srcText), anchorDir)
    // 1) 旧目录旁置（原子；不再有"rm 之后 rename 失败 ⇒ 技能消失"的窗口）
    if (hadDest) {
      asideDir = join(anchorDir, `${ASIDE_INFIX}${name}-${stamp}`)
      renameSync(destDir, asideDir)
    }
    // 2) 新内容就位；失败先把旧目录改回来（回滚再失败 → 抛可恢复错误）
    try {
      renameSync(stagingDir, destDir)
    } catch (error) {
      if (asideDir === null) throw error
      try {
        renameSync(asideDir, destDir)
      } catch (restoreError) {
        throw new SkillSwapRecoveryError(destDir, stagingDir, asideDir, error, restoreError)
      }
      throw error
    }
    // 3) 旁置副本已是垃圾：删除尽力而为，删不掉留给下次同步清扫
    if (asideDir !== null) {
      try { rmSync(asideDir, { recursive: true, force: true }) } catch { /* 留给清扫 */ }
    }
  } catch (error) {
    // 回滚成功（或目标一直都在）时，把搬进暂存目录的安装器标记原样搬回目标目录——
    // 清理暂存副本不能顺手带走用户的溯源。目标缺失（SkillSwapRecoveryError 那一路）
    // 时两份副本刻意保留，标记随暂存副本一起留在盘上，可人工恢复。
    if (existsSync(destDir)) restoreInstallerMarkers(destDir, stagingDir, stashedMarkers)
    // 只有"目标目录仍然在盘上（旧内容在位 / 回滚成功 / 新内容已就位）"或
    // "本来就没有旧目录"时才删暂存副本；目标缺失时暂存目录是这份内容的唯一
    // 完整副本，必须保留并在错误里点名（S13-3 复核：否则技能将凭空消失）。
    if (!hadDest || existsSync(destDir)) {
      try { rmSync(stagingDir, { recursive: true, force: true }) } catch { /* 残留由下次同步清扫 */ }
    }
    throw error
  }
}

/**
 * 把旧目标目录里的安装器标记搬进新内容暂存目录（A9 修复，2026-09-23）。
 *
 * 只搬**真实存在的**目录/文件，且暂存目录里已有同名条目时不动（源包自带的
 * 优先）。搬不动（跨设备/权限）就留在旧目录里——随后它会被旁置副本带着走，
 * 内容不丢，只是下一次同步不再被保留。
 *
 * @param {string} destDir - 技能库内的旧技能目录。
 * @param {string} stagingDir - 已写好新内容的暂存目录。
 * @returns {string[]} 实际搬走的条目名（供 {@link restoreInstallerMarkers} 回滚）。
 */
function stashInstallerMarkers(destDir, stagingDir) {
  const moved = []
  for (const marker of INSTALLER_MARKERS) {
    const from = join(destDir, marker)
    const to = join(stagingDir, marker)
    if (existsSync(to) || !existsSync(from)) continue
    try {
      renameSync(from, to)
      moved.push(marker)
    } catch { /* 搬不动：留在旧目录（内容不丢） */ }
  }
  return moved
}

/**
 * 换入失败并回滚后，把搬进暂存目录的安装器标记原样搬回目标目录。
 * @param {string} destDir - 已复原的技能目录。
 * @param {string} stagingDir - 暂存目录（即将被清理）。
 * @param {string[]} moved - {@link stashInstallerMarkers} 的返回值。
 * @returns {void}
 */
function restoreInstallerMarkers(destDir, stagingDir, moved) {
  for (const marker of moved) {
    const back = join(destDir, marker)
    if (existsSync(back)) continue
    try { renameSync(join(stagingDir, marker), back) } catch { /* 尽力；清不掉也不影响同步 */ }
  }
}

/**
 * 补齐本插件自己的来源溯源（A9 修复，2026-09-23）。
 *
 * 目标没有 `.picoaide/release.json` 时写一份 `channel: 'plugin'` 的：
 * 字段与 enterprise 安装器 `writeProvenance` 一致（`appId` / `version` /
 * `channel` / `installedAt`），版本号取 SKILL.md 的 `x-version`（没有则 `''`）。
 * `archiveChecksum` 刻意不写：它必须与企业侧 `computeSkillContentHash`
 * 逐字节同源，而跨包 import 禁止，第二份实现算错反而会让「是否被本地修改」
 * 的判据出错——宁缺勿错。
 * `.install-version` 只在缺失时补写（有版本才写，与安装器同口径），
 * 已有的一律原样保留（安装器/旧版本写下的记录优先）。
 *
 * @param {string} stagingDir - 暂存目录（换入前）。
 * @param {string} name - 技能名。
 * @param {number} xVersion - SKILL.md 的 `x-version`（缺失为 0）。
 * @param {string} anchorDir - 技能库根（落点断言的基准）。
 * @returns {void}
 */
function writePluginProvenance(stagingDir, name, xVersion, anchorDir) {
  const version = xVersion > 0 ? String(xVersion) : ''
  const releaseFile = join(stagingDir, PROVENANCE_DIR, PROVENANCE_FILE)
  if (!existsSync(releaseFile)) {
    const info = { appId: name, version, channel: PLUGIN_CHANNEL, installedAt: new Date().toISOString() }
    writeFileAtomicSafeAt(releaseFile, `${JSON.stringify(info, null, 2)}\n`, { anchorDir })
  }
  const versionFile = join(stagingDir, '.install-version')
  if (version !== '' && !existsSync(versionFile)) {
    writeFileAtomicSafeAt(versionFile, version, { anchorDir })
  }
}

/**
 * 换入失败且旧目录回滚也失败（S13-3 复核，2026-09-17）。
 *
 * 这是"内容还在、但技能目录暂时缺失"的第三态：暂存目录里是完整的新副本，
 * 旁置目录里是完整的旧副本，两者都刻意保留（见 {@link syncSkillDirSafe} 的
 * catch）。调用方（{@link syncBuiltinSkills}）按 `code` 把它与普通 `refused`
 * 区分开，用 error 级别上报路径供人工恢复。
 */
export class SkillSwapRecoveryError extends Error {
  /**
   * @param {string} destDir - 本应就位的技能目录。
   * @param {string} stagingDir - 新内容副本（保留）。
   * @param {string} asideDir - 旧内容副本（保留）。
   * @param {unknown} swapError - 换入 rename 的原始错误。
   * @param {unknown} restoreError - 回滚 rename 的错误。
   */
  constructor(destDir, stagingDir, asideDir, swapError, restoreError) {
    super(`dsh-memory-evolve: 技能目录 ${destDir} 换入失败且旧目录回滚失败 —— 需人工恢复：新副本 ${stagingDir}，旧副本 ${asideDir}（换入错误：${swapError?.message ?? swapError}；回滚错误：${restoreError?.message ?? restoreError}）`)
    this.name = 'SkillSwapRecoveryError'
    this.code = 'SKILL_SWAP_RECOVERY_FAILED'
    this.destDir = destDir
    this.stagingDir = stagingDir
    this.asideDir = asideDir
  }
}

/**
 * 解析换入临时目录名。
 *
 * **新命名**（A16 修复，2026-09-23，写入时一律用这一种；前导点让目录对
 * `SKILL_NAME_PATTERN` 与上游发现器的目录名契约都不可见）：
 *   `.staging-<skill>-<pid>-<ts>` / `.old-<skill>-<pid>-<ts>`
 * **旧命名**（升级前写下的崩溃残留，仍要能清掉）：
 *   `<skill>.staging-<pid>-<ts>` / `<skill>.old-<pid>-<ts>`
 *
 * @param {string} name - 技能库根下的目录名。
 * @returns {{skillName:string, pid:number, ts:number, aside:boolean}|null}
 */
function parseSwapDirName(name) {
  for (const [infix, aside] of [[STAGING_INFIX, false], [ASIDE_INFIX, true]]) {
    // 新命名：<infix><skill>-<pid>-<ts>（以点开头、隐藏）。贪婪匹配让技能名里的
    // 连字符不被吃进 pid/ts。
    const hidden = new RegExp(`^\\${infix}(.+)-(\\d+)-(\\d+)$`).exec(name)
    if (hidden !== null) {
      return { skillName: hidden[1], pid: Number(hidden[2]), ts: Number(hidden[3]), aside }
    }
    // 旧命名：<skill><infix><pid>-<ts>（无前导点）
    const at = name.lastIndexOf(infix)
    if (at <= 0) continue
    const match = /^(\d+)-(\d+)$/.exec(name.slice(at + infix.length))
    if (match === null) continue
    return { skillName: name.slice(0, at), pid: Number(match[1]), ts: Number(match[2]), aside }
  }
  return null
}

/**
 * pid 是否还活着。唯一用途是判断某个暂存/旁置目录是否属于"正在跑的同步"。
 * ESRCH=不存在；EPERM=存在但无权限（宁可漏扫，不可误扫）；非法 pid 当不存在。
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 清扫上次同步留下的暂存/旁置目录（S13-3 复核，2026-09-17）。
 *
 * 判据三条同时成立才删，且只在本插件自己的命名空间内动手：
 *   - **同父目录 + 名字形状匹配**：`.staging-<BUILTIN_SKILLS 成员>-<pid>-<ts>` /
 *     `.old-…`（新命名），以及升级前留下的 `<成员>.staging-<pid>-<ts>` /
 *     `<成员>.old-<pid>-<ts>`（旧命名，见 {@link parseSwapDirName}）；技能名限定
 *     在内置清单里，绝不碰用户自己的目录；
 *   - **陈旧**：pid 已不存在，或目录年龄超过 {@link STALE_SWAP_MAX_AGE_MS}
 *     （pid 复用兜底）；仍在跑的并发同步（活 pid + 新时间戳）不动；
 *   - **旁置副本额外要求真技能目录还在**：真目录缺失时那个旁置目录是旧内容的
 *     唯一副本（双 rename 失败路径），刻意留给人工恢复，不清。syncBuiltinSkills
 *     在同步循环**之后**会再调用一次本函数（2026-09-17 三轮复核）：本次同步把
 *     真目录装回来时，这个旁置副本立刻被收掉，不再以幽灵技能候选活到下次启动。
 * 删除失败只忽略：残留不影响同步正确性，下次启动再扫。
 *
 * @param {string} userSkillsDir - 用户技能库目录（`config.skillDir`，桌面端缺省 `<DSH_HOME>/skills`）。
 */
function sweepStaleSwapDirs(userSkillsDir) {
  let names
  try {
    names = readdirSync(userSkillsDir)
  } catch {
    return // 技能库还不存在：没有残留可扫
  }
  const now = Date.now()
  for (const name of names) {
    const parsed = parseSwapDirName(name)
    if (parsed === null || !BUILTIN_SKILLS.includes(parsed.skillName)) continue
    if (parsed.aside && !existsSync(join(userSkillsDir, parsed.skillName))) continue
    if (isPidAlive(parsed.pid) && now - parsed.ts <= STALE_SWAP_MAX_AGE_MS) continue
    try { rmSync(join(userSkillsDir, name), { recursive: true, force: true }) } catch { /* 清不掉不影响同步 */ }
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
