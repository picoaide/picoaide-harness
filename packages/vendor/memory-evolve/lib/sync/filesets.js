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

import { lstatSync } from 'node:fs'
import { join } from 'node:path'

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
  // 逐层检查已存在的路径组件（leaf + 各级祖先）：任何一层是符号链接即拒收。
  // 不存在的组件（ENOENT）停止下钻——落点真实路径断言在 worker 侧还有一层。
  let current = rootDir
  for (const part of path.split('/')) {
    current = join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) return false
    } catch {
      break
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
