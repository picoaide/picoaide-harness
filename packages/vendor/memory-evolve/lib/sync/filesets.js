/**
 * lib/sync/filesets.js — 同步文件集定义（全局轨二期并入一期，2026-08-11
 * 用户拍板：开关做好功能必须实现）
 *
 * 同步机制按"文件集"（fileset）区分同步范围：
 *   project       项目级（KEY/日志/归档/项目待办/logs/）——一期已有
 *   memory-global 全局记忆轨：MEMORY.md + MEMORY-archive.md
 *   user-global   用户档案轨：USER.md + USER-archive.md
 *   daily-global  每日日志轨：daily/*.md（记忆格式，追加型）
 *   todo-global   全局待办轨：TODOS-life.md / TODOS-work.md /
 *                 daily/*.todo.md（TODO 格式，tag id）
 *
 * 全局轨承载于**全局记忆仓库**（记忆根目录的 .git，deny-all 白名单只放行
 * 全局记忆文件），每个轨一条远端分支（dsh-shared/memory-global / user /
 * daily / todo-global，需求 #5 命名空间）与本地分支（refs/heads/<轨>），
 * 各轨互不干扰；仅共享记忆仓库（setup 带 url）可用。
 *
 * 纯路径逻辑（只 import node:fs/node:path 做本地符号链接探测；不引入仓库
 * 逻辑，merge.js 等模块可安全 import）。
 */

import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * 项目级文件集规格（memory=记忆格式文件、todo=TODO 格式文件、
 * logs=logs/ 目录放行）。'daily' 特殊项 = daily 目录（日志 .md 或 .todo.md）。
 */
export const PROJECT_SPEC = {
  memory: ['KEY.md', 'KEY-archive.md', 'MEMORY.md'],
  todo: ['TODOS.md'],
  logs: true,
}

/** 全局轨文件集规格（key = fileset 名 = 本地/远端分支名主体）。 */
export const GLOBAL_FILESETS = {
  'memory-global': { memory: ['MEMORY.md', 'MEMORY-archive.md'], todo: [], logs: false },
  'user-global': { memory: ['USER.md', 'USER-archive.md'], todo: [], logs: false },
  'daily-global': { memory: ['daily'], todo: [], logs: false },
  'todo-global': { memory: [], todo: ['TODOS-life.md', 'TODOS-work.md', 'daily'], logs: false },
}

/** 全部全局 fileset 列表（迭代用）。 */
export const GLOBAL_FILESET_KEYS = Object.keys(GLOBAL_FILESETS)

/** 全局轨远端分支名（dsh-shared/<轨>）。 */
export function globalBranchFor(fileset) {
  const name = {
    'memory-global': 'memory-global',
    'user-global': 'user',
    'daily-global': 'daily',
    'todo-global': 'todo-global',
  }[fileset]
  return `dsh-shared/${name ?? fileset}`
}

/** 全局轨本地分支名（refs/heads/<fileset>，与远端分支解耦）。 */
export function globalLocalBranchFor(fileset) {
  return fileset
}

/** 取 fileset 的规格对象（未知 fileset 抛错）。 */
export function filesetSpec(fileset) {
  if (fileset === 'project') return PROJECT_SPEC
  const spec = GLOBAL_FILESETS[fileset]
  if (spec === undefined) throw new Error(`dsh-memory-evolve: 未知同步文件集 "${fileset}"`)
  return spec
}

/** daily 日志文件路径模式（记忆格式）。 */
const DAILY_LOG_RE = /^daily\/\d{4}-\d{2}-\d{2}\.md$/
/** daily 待办文件路径模式（TODO 格式）。 */
const DAILY_TODO_RE = /^daily\/\d{4}-\d{2}-\d{2}\.todo\.md$/
/**
 * logs/ 下的日志文件名模式（P1-9）：单层、纯文件名。
 *
 * 此前是 `path.startsWith('logs/') && path.endsWith('.md')`——`..`、绝对
 * 路径段、子目录都能通过（`logs/../../victim/MEMORY.md` 判为合法同步
 * 文件，冲突侧车的 `file` 字段据此写穿到仓库外）。`resolveFilesetFiles`
 * 只从 `logs/` 目录**直接**枚举文件名，单层模式与真实生产路径完全一致；
 * 同时排除反斜杠（Windows 风格分隔符在 POSIX 上也是普通字符，但不该
 * 出现在仓库相对路径里）。
 */
const LOGS_FILE_RE = /^logs\/[^/\\]+\.md$/

/**
 * 判断路径是否属于某 fileset 的同步记忆文件（按路径模式，不依赖磁盘存在
 * ——readTreeFiles 要判断远端树里的路径名，本地可能不存在）。
 *
 * **本函数是信任边界**（P1-9）：冲突侧车 CONFLICTS.md 的 `file` 字段唯一
 * 的白名单校验点（worker.resolveConflict），命中后会被 `join(dir, file)`
 * 落盘重写。因此所有模式都必须锚定且只匹配**仓库相对路径**，绝不接受
 * `..` 段、绝对路径、子目录穿透（`resolveFilesetFiles` 生成的路径要么是
 * 规格里的固定文件名，要么是目录单层枚举结果，与此完全一致）。
 *
 * @param {string} path - 仓库相对路径。
 * @param {string} [fileset='project'] - 文件集。
 * @param {string} [rootDir] - 仓库根目录。给了就额外做**符号链接**校验
 *   （FIX-22，2026-09-12）：仓库内已存在的符号链接路径直接拒收 ——
 *   `logs -> <仓库外目录>` 这类条目（git 记录为 120000，clone/checkout 会
 *   实体化成真符号链接）会让"路径字符串合法"的白名单写穿到仓库外。
 *   远端树路径（本地不存在，readTreeFiles）不传即可，模式校验照旧。
 * @returns {boolean}
 */
export function isMemoryFile(path, fileset = 'project', rootDir) {
  if (!matchesFileset(path, fileset)) return false
  if (typeof rootDir !== 'string' || rootDir === '') return true
  return !hasSymlinkComponent(rootDir, path)
}

/* ---------------- FIX-22 落点安全断言（唯一实现，多处写回出口共用） ----------------
 *
 * **行为收紧要登记（2026-09-13）**：仓库内任何符号链接一律拒收 —— 不区分它
 * 指向仓库内还是仓库外（严格性换安全）。理由：本插件自己的写回只有
 * writeFileSync/renameSync，**从不创建符号链接**；仓库里出现的符号链接只可能
 * 来自共享分支里被跟踪的 120000 条目（clone/checkout 会实体化成真符号链接）
 * 或用户在磁盘上自行摆放。放过"指向仓库内"的链接等于给攻击者留一节阶梯
 * （先把链接指向仓库内合法目录骗过检查，再在 TOCTOU 窗口内把它换成仓库外
 * 目标），收益为零而风险为正，故一律拒收。
 *
 * 这一组函数是**唯一实现**：冲突侧车出口（resolveConflict）与三路合并写回
 * 出口（runSync）以及固定名元数据出口（PROVENANCE/.gitignore/.gitattributes/
 * CONFLICTS.md）必须调用同一份，不得各写一份。 */

/** p 是否在 root 之内（含 root 自身）——纯字符串层包含性。 */
export function isInsideRoot(root, p) {
  return p === root || p.startsWith(root + sep)
}

/** 从 p 起向上找第一个存在的路径（不存在则返回 null）。 */
export function nearestExistingAncestor(p) {
  let current = p
  for (;;) {
    if (existsSync(current)) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * 逐层 lstat：path 的任意一层（leaf + 各级祖先）是符号链接即返回 true。
 * 不做字符串包含性判断（调用方负责）——只看磁盘上真实存在的组件类型，
 * lstat 对**悬空符号链接**同样有效（existsSync 对悬空链接为假，会漏）。
 *
 * 不存在的组件（ENOENT/ENOTDIR）→ 停止下钻并视为"未发现符号链接"（更深的
 * 组件此刻不可能存在）；其它错误（EACCES 等）无法判定 → fail closed 返回
 * true（拒收），把不可判定的落点交给上层的 realpath 包含性断言。
 *
 * @param {string} rootDir - 仓库根目录（相对路径的基准）。
 * @param {string} path - 仓库相对路径（'/' 分隔）。
 * @returns {boolean}
 */
export function hasSymlinkComponent(rootDir, path) {
  let current = rootDir
  for (const part of String(path).split('/')) {
    if (part === '') continue
    current = join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) return true
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return false
      return true
    }
  }
  return false
}

/**
 * 固定名/白名单落点的**安全解析**（FIX-22 第一层）：符号链接拒收 + 字符串
 * 包含性 + realpath 包含性（仓库根 / 最近已存在祖先 / 目标文件本身）。
 *
 * 字符串 `resolve()` 挡不住 `logs -> /outside`：`resolve(root,'logs/x.md')`
 * 以 root 开头，写盘却穿透到仓库外。
 *
 * @param {string} rootDir - 仓库目录。
 * @param {string} relPath - 仓库相对路径（调用方负责模式/白名单校验）。
 * @returns {string | null} 绝对落点；null = 拒收（fail closed）。
 */
export function resolveSafeRepoTarget(rootDir, relPath) {
  if (typeof rootDir !== 'string' || rootDir === '') return null
  if (typeof relPath !== 'string' || relPath === '') return null
  if (hasSymlinkComponent(rootDir, relPath)) return null
  let realRoot
  try {
    realRoot = realpathSync(resolve(rootDir))
  } catch {
    return null // 仓库不存在/不可读：fail closed
  }
  const abs = resolve(realRoot, relPath)
  if (abs === realRoot || !isInsideRoot(realRoot, abs)) return null
  if (!assertSafeRepoTarget(rootDir, abs)) return null
  return abs
}

/**
 * 记忆文件集落点（FIX-22 第一层 + 白名单）：模式白名单 + 符号链接拒收 +
 * realpath 包含性。**三路合并写回与冲突侧车写回共用本函数**。
 *
 * @param {string} rootDir - 同步仓库目录。
 * @param {string} relPath - 仓库相对路径。
 * @param {string} [fileset='project'] - 文件集。
 * @returns {string | null} 绝对落点；null = 白名单/包含性/符号链接校验失败。
 */
export function resolveFilesetTarget(rootDir, relPath, fileset = 'project') {
  if (!isMemoryFile(relPath, fileset, rootDir)) return null
  return resolveSafeRepoTarget(rootDir, relPath)
}

/**
 * 落盘前的 **TOCTOU 复检**（FIX-22 第二层，与第一层同源）：校验与
 * writeFileSync 之间存在窗口（另一进程/同步任务可以在 `logs` 位置放一个
 * 符号链接，把目录换成指向仓库外的链接）。建目录之后、写盘之前再解析一次
 * 真实路径，仍必须在仓库内、且路径上不得新出现符号链接。
 *
 * @param {string} rootDir - 仓库目录。
 * @param {string} abs - 已经过第一层校验的绝对落点。
 * @returns {boolean} true = 仍可安全写入。
 */
export function assertSafeRepoTarget(rootDir, abs) {
  let realRoot
  try {
    realRoot = realpathSync(resolve(rootDir))
  } catch {
    return false
  }
  if (typeof abs !== 'string' || abs === '' || abs === realRoot) return false
  if (!isInsideRoot(realRoot, abs)) return false
  // 相对 realRoot 反推仓库相对路径，复检路径链上是否出现（新放置的）符号链接
  // ——包括指向仓库**内**的链接（行为收紧要登记：一律拒收）。
  const rel = relative(realRoot, abs)
  if (rel === '' || rel.startsWith('..')) return false
  if (hasSymlinkComponent(rootDir, rel.split(sep).join('/'))) return false
  // 落点父目录（或最近的已存在祖先）真实路径：符号链接在这里现形。
  const anchor = nearestExistingAncestor(dirname(abs))
  if (anchor === null) return false
  try {
    if (!isInsideRoot(realRoot, realpathSync(anchor))) return false
  } catch {
    return false
  }
  // 目标文件本身已存在：自己就是符号链接（指向仓库外）时同样拒收。
  if (existsSync(abs)) {
    try {
      if (!isInsideRoot(realRoot, realpathSync(abs))) return false
    } catch {
      return false
    }
  }
  return true
}

/** 纯路径模式校验（不含磁盘状态）。 */
function matchesFileset(path, fileset) {
  const spec = filesetSpec(fileset)
  if (spec.memory.includes(path)) return true
  if (spec.todo.includes(path)) return true
  if (spec.logs && LOGS_FILE_RE.test(path)) return true
  if (spec.memory.includes('daily') && DAILY_LOG_RE.test(path)) return true
  if (spec.todo.includes('daily') && DAILY_TODO_RE.test(path)) return true
  return false
}

/**
 * **读侧/锁侧**落点断言（FIX-22 同源，唯一实现，2026-09-13 第四轮）。
 *
 * 与**写侧**（resolveSafeRepoTarget / assertSafeRepoTarget）共用同一份逐层
 * lstat（hasSymlinkComponent），差别只有两点，都是读语义决定的：
 *   - 不做 realpath 包含性断言：读不落盘，符号链接检查已足够；
 *   - **容忍根目录尚不存在**：首次写入前 memoryDir 可能还没建，那是一次
 *     ENOENT 空读，不是越界（写侧对不存在的根 fail closed 是对的——写必须
 *     保证落点真实存在且在内）。
 *
 * 为什么读侧也要断言：共享记忆分支里一个 120000 条目就能让 checkout 把
 * `KEY.md` / `KEY-archive.md` / `daily/` / `.memory.lock` 变成指向仓库外的真
 * 符号链接；读侧若跟随，仓库外文件内容会被当成记忆**注入上下文**（信息外泄），
 * 归档读侧还会把仓库外内容搬进仓库再推上共享分支；锁侧则永远拿不到锁
 * （O_EXCL 对已存在的链接恒 EEXIST）而退化成 5s 超时假死。
 *
 * @param {string} rootDir - 记忆仓库根目录。
 * @param {string} abs - 目标绝对路径。
 * @returns {boolean} true = 路径链上无符号链接且未越界，可安全读/落锁。
 */
export function isSymlinkFreeRepoTarget(rootDir, abs) {
  const root = resolve(rootDir)
  const rel = relative(root, resolve(abs))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
  return !hasSymlinkComponent(root, rel.split(sep).join('/'))
}

/**
 * 判断路径是否是 TODO 格式文件（合并器按文件分流：TODO 用 tag id 做
 * entryKey、不补发行首身份证、写回带 header）。全局模式匹配，不依赖
 * fileset——同一路径在任何文件集里格式不变。
 * @param {string} path - 相对路径。
 * @returns {boolean}
 */
export function isTodoPath(path) {
  return path === 'TODOS.md' || path === 'TODOS-life.md' || path === 'TODOS-work.md' || DAILY_TODO_RE.test(path)
}

/**
 * 冲突侧车文件名（Codex 二轮 P0-2 修复）：多轨共享同一 .git 时，共用单个
 * CONFLICTS.md 会让"无冲突轨的同步"删掉其他轨的冲突侧车（冲突数据连同
 * 工作树清空一起永久丢失）。每 fileset 独立侧车：
 *   project → CONFLICTS.md（保持历史兼容）
 *   全局轨  → CONFLICTS-<fileset>.md
 * @param {string} [fileset='project'] - 文件集。
 * @returns {string}
 */
export function conflictsFileFor(fileset = 'project') {
  return fileset === 'project' ? 'CONFLICTS.md' : `CONFLICTS-${fileset}.md`
}
