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

import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { open as openAsync, rename as renameAsync, unlink as unlinkAsync } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

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

/* ---------------- FIX-26 落点写入原语（唯一实现，2026-09-13 第六轮） ----------------
 *
 * 第五轮对抗复核（`temp/r5-verify-server/memory/FINDINGS.md` §4）在断言之外又找到
 * 两处 check-then-use 窗口，都出在**落点被断言、但真正被打开/写入的不是那个
 * 路径**：
 *   4a `tmp = <目标>.tmp.<pid>` 从未被断言 —— 攻击者按可见 pid 预置同名真符号
 *      链接，`writeFileSync(tmp)` 跟随链接写穿仓库外，`renameSync` 再把链接搬到
 *      目标文件名上（实测 `append` 返回 `ok:true`）。
 *   4b 锁 `openSync(lockPath,'wx')` 之后按**路径**写锁内容 —— 打开与写入之间
 *      祖先目录被换成符号链接时，锁 JSON 落在仓库外。
 *
 * 本组原语把"断言"与"打开/写入"绑在一起，任何写回都必须经过：
 *   1) 打开前对**真实要写的那个路径**（临时文件路径 / 锁路径）做同一份断言；
 *   2) `openSync(path,'wx')`（O_EXCL）——预置的同名文件/符号链接直接 EEXIST，
 *      绝不跟随；
 *   3) **按 fd 写入**，关闭前不再按路径解析；
 *   4) 打开后校验 fd 与路径仍是同一个 inode（打开→写入窗口的祖先替换现形），
 *      逃逸时回收我们刚创建的那个文件；
 *   5) rename 前后各复检一次落点（写侧 realpath 包含性）。
 */

/**
 * 只删"确实是我们刚创建的那个 inode"的文件。
 *
 * 打开后校验失败（祖先被换成符号链接）时用它回收逃逸落点：先 lstat 比对
 * dev/ino，只有路径**当前仍解析到我们创建的那个文件**才 unlink —— 避免在
 * 祖先被换走/换成别处的竞态里误删同名他人文件。
 *
 * 注意：攻击者把祖先换**回**真目录后，这条路径就找不到我们那个（落在仓库外
 * 的）文件了——那是 `openExclusiveSafe` 里 `/proc/self/fd` 那条真实路径回收
 * 负责的形态（实测 315,191 次 append 里仍有仓库外 `.memory.lock` 残留）。
 *
 * @param {string} abs - 打开用的绝对路径。
 * @param {import('node:fs').Stats} createdStat - 打开时的 fstatSync 结果。
 */
export function removeCreatedFile(abs, createdStat) {
  if (!createdStat) return
  try {
    const st = lstatSync(abs)
    if (st.dev === createdStat.dev && st.ino === createdStat.ino) unlinkSync(abs)
  } catch { /* 路径已不可解析/已被替换：不删 */ }
}

/**
 * 从**已打开的 fd** 反查真实路径（唯一实现）。
 *
 * `/proc/self/fd/N`（Linux）/`/dev/fd/N`（macOS/BSD）是"这个 fd 到底开在哪"的
 * 权威答案：祖先目录被换成符号链接（又被换回来）之后，按路径 lstat 已经找不到
 * 落点，但 fd 仍指向那个 inode，realpath 读出来就是仓库外的真实位置——逃逸
 * 回收只有靠它才不依赖"翻转后的路径仍指得回去"。
 *
 * **macOS 陷阱（2026-09-16 客户现场，阻塞级）**：`realpathSync('/dev/fd/N')`
 * 在 macOS 上**不解析**（原样返回 `/dev/fd/N`，且不抛错；`/proc/self/fd` 不存在）。
 * 于是 fd 反查返回的是**入口自身**的字符串，包含性检查把它判成"落在仓库外"
 * ⇒ `openExclusiveSafe` 返回 `unsafe` ⇒ 取锁抛出误导性的「仓库内 .memory.lock
 * 是符号链接（或越出仓库边界）」；而清理用的 `unlinkSync('/dev/fd/N')` 什么都
 * 删不掉 ⇒ 每个目录留下 0 字节残留锁、越积越多。**macOS 上 memory / dtodo /
 * 归档 / sync 的全部写入因此失败**（读取正常——读路径不做这项检查）。
 *
 * 修法（两条都做）：
 *  1. **只在真解析出路径时才返回**：候选结果若仍带 `/proc/self/fd/`、`/dev/fd/`
 *     前缀（= 没解析），或 stat 出的 dev/ino 与已打开 fd 对不上，一律丢弃 →
 *     返回 null ⇒ 调用方跳过包含性检查。方向是保守的：这项检查是"定位逃逸落点"
 *     的**加强**手段，不是唯一防线——打开后的 inode 一致性复核与路径链无符号链接
 *     复核在它之后仍照跑，且清理走 `removeCreatedFile`（按 inode 比对后 unlink
 *     真实路径），不再碰 `/dev/fd` 入口本身。
 *  2. 逐个候选尝试（不是"第一个不抛就返回"），第一个真的解析成功者胜出。
 *
 * @param {number} fd - 已打开的文件描述符。
 * @returns {string | null} 真实绝对路径；平台不支持/未真解析/文件已删除时 null。
 */
export function fdRealPath(fd) {
  for (const base of ['/proc/self/fd/', '/dev/fd/']) {
    const candidate = `${base}${fd}`
    let resolved
    try {
      resolved = realpathSync(candidate)
    } catch { continue /* 平台无此入口或 fd 已失效 → 试下一个 */ }
    if (resolved.startsWith(base)) continue // 没解析（macOS 的 /dev/fd/N）→ 丢弃
    // 与 fd 自身比对 dev/ino：对不上说明该候选指向的不是我们打开的那个文件
    try {
      const viaFd = fstatSync(fd)
      const viaPath = statSync(resolved)
      if (viaFd.dev !== viaPath.dev || viaFd.ino !== viaPath.ino) continue
    } catch { continue }
    return resolved
  }
  return null
}

/**
 * `O_EXCL` 打开落点 + 打开后校验（唯一实现）。
 *
 * @param {string} rootDir - 仓库根（断言基准）。
 * @param {string} abs - 要创建的绝对路径。
 * @param {'write'|'lock'} [mode='write'] - 前置断言：`write` 用写侧
 *   `assertSafeRepoTarget`（realpath 包含性，要求仓库根已存在）；`lock` 用
 *   `isSymlinkFreeRepoTarget`（容忍仓库根/目录尚未创建——首次写入前取锁）。
 * @returns {{ok: true, fd: number, stat: import('node:fs').Stats}
 *   | {ok: false, reason: 'exists' | 'unsafe', stat?: import('node:fs').Stats}}
 *   `exists` = 落点已被占用（锁竞争，或攻击者/崩溃残留预置的同名条目）；
 *   `unsafe` = 符号链接/越界（含"打开后祖先被换走"——逃逸落点已回收）。
 */
export function openExclusiveSafe(rootDir, abs, mode = 'write') {
  const safe = mode === 'lock'
    ? isSymlinkFreeRepoTarget(rootDir, abs)
    : assertSafeRepoTarget(rootDir, abs)
  if (!safe) return { ok: false, reason: 'unsafe' }
  let fd
  try {
    fd = openSync(abs, 'wx') // O_CREAT|O_EXCL：预置的同名链接/文件 → EEXIST，绝不跟随
  } catch (error) {
    if (error.code === 'EEXIST') return { ok: false, reason: 'exists' }
    throw error
  }
  let opened
  try {
    opened = fstatSync(fd)
  } catch {
    try { closeSync(fd) } catch { /* 已关闭 */ }
    return { ok: false, reason: 'unsafe' }
  }
  // 打开后校验（4b 的核心）：先按 fd 反查真实路径（祖先被换走又换回来时，
  // 只有它能定位逃逸落点），再按路径复核 inode 一致 + 路径链无符号链接。
  let realRoot = null
  try {
    realRoot = realpathSync(resolve(rootDir))
  } catch { realRoot = null }
  const realOpen = fdRealPath(fd)
  if (realRoot !== null && realOpen !== null && !isInsideRoot(realRoot, realOpen)) {
    // 创建落到了仓库外：按 fd 真实路径回收（不依赖路径此刻是否还指得回去）
    try { closeSync(fd) } catch { /* 已关闭 */ }
    try { unlinkSync(realOpen) } catch { /* 已被移走/删除 */ }
    return { ok: false, reason: 'unsafe', stat: opened }
  }
  let same = false
  try {
    const viaPath = statSync(abs)
    same = viaPath.dev === opened.dev && viaPath.ino === opened.ino
  } catch { same = false }
  // 路径复核与**前置断言同一份实现**（不能混用：写侧落点是 realpath 基准的
  // `resolveSafeRepoTarget` 结果，而"记忆目录本身是符号链接"是合法布局——
  // `isSymlinkFreeRepoTarget` 按未解析的 root 做相对化，会把这种落点误判越界；
  // 锁侧落点则是未解析的 join(dir,…)，只能用容忍 root 尚不存在的读侧断言）。
  const pathSafe = mode === 'lock'
    ? isSymlinkFreeRepoTarget(rootDir, abs)
    : assertSafeRepoTarget(rootDir, abs)
  if (!same || !pathSafe) {
    try { closeSync(fd) } catch { /* 已关闭 */ }
    removeCreatedFile(abs, opened) // 逃逸回收：仓库外不得留下我们创建的文件
    return { ok: false, reason: 'unsafe', stat: opened }
  }
  return { ok: true, fd, stat: opened }
}

/**
 * 原子写回（tmp + rename）的**唯一实现**：临时落点也断言 + O_EXCL 按 fd 写入
 * + rename 前后各复检一次。
 *
 * 替换原先各处手写的 `writeFileSync(`${safe}.tmp.${pid}`) + renameSync(...)`：
 * 那段代码只断言了**最终落点**，临时落点从未校验（第五轮 4a：预置同名真符号
 * 链接即写穿仓库外并返回成功）。
 *
 * @param {string} rootDir - 仓库根（断言基准）。
 * @param {string} targetAbs - 已过第一层断言的最终落点（realpath 基准）。
 * @param {string | Buffer} data - 文件正文。
 * @returns {{ok: true, path: string} | {ok: false, refusedPath: string}}
 *   `ok:false` = 临时落点/最终落点被拒（符号链接、越界、预置同名条目）。
 */
export function writeFileAtomicSafe(rootDir, targetAbs, data) {
  const tmp = `${targetAbs}.tmp.${process.pid}`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const opened = openExclusiveSafe(rootDir, tmp, 'write')
    if (opened.ok === true) {
      try {
        writeFileSync(opened.fd, data) // 按 fd 写入：关闭前不再按路径解析
      } catch (error) {
        try { closeSync(opened.fd) } catch { /* 已关闭 */ }
        removeCreatedFile(tmp, opened.stat)
        throw error
      }
      closeSync(opened.fd)
      // rename 前复检：临时落点与最终落点都必须仍然安全（含"临时落点自己也
      // 成了符号链接"的形态）
      if (!assertSafeRepoTarget(rootDir, tmp) || !assertSafeRepoTarget(rootDir, targetAbs)) {
        removeCreatedFile(tmp, opened.stat)
        return { ok: false, refusedPath: targetAbs }
      }
      renameSync(tmp, targetAbs)
      // rename 后复检：落点真实路径必须仍在仓库内——祖先目录在窗口内被换掉时
      // fail-loud（绝不把写穿仓库外的结果报成 ok），并回收刚落地的那个文件
      // （只删 inode 与我们对得上的那个：祖先被换走/换成别处时不动手）。
      if (!assertSafeRepoTarget(rootDir, targetAbs)) {
        removeCreatedFile(targetAbs, opened.stat)
        return { ok: false, refusedPath: targetAbs }
      }
      return { ok: true, path: targetAbs }
    }
    if (opened.reason !== 'exists') return { ok: false, refusedPath: tmp }
    // 预置同名临时文件：
    //   - 符号链接/目录 = 攻击形态（或不可判定）→ 拒收，且不删改仓库内链接；
    //   - 普通文件 = 崩溃残留 → 断言后清理，重试一次（不把正常写入修死）。
    let st
    try {
      st = lstatSync(tmp)
    } catch {
      continue // 竞态里刚好消失：重试
    }
    if (!st.isFile()) return { ok: false, refusedPath: tmp }
    if (!assertSafeRepoTarget(rootDir, tmp)) return { ok: false, refusedPath: tmp }
    try {
      unlinkSync(tmp)
    } catch {
      return { ok: false, refusedPath: tmp }
    }
  }
  return { ok: false, refusedPath: tmp }
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

/* ---------------- 自锚定原子写（仓库外配置/状态文件的唯一入口） ----------------
 *
 * 同一根因族的收口（R7 审计 me-1/me-2 横向排查，2026-09-13 第七轮）：手写的
 * `<file>.tmp.<process.pid>`（以及 `.tmp`、`.bak.<Date.now()>`、`.tmp-<pid>`）
 * 落点**从不经过断言**。pid 在本机 /proc 可见、时间戳/nonce 可枚举，预置同名
 * 真符号链接即可让 `writeFileSync`/`copyFileSync` 跟随链接写穿到任意路径，
 * 而调用方仍报成功。这与 `writeFileAtomicSafe`（仓库内写回）是同一个缺陷形态，
 * 差别只是这些文件没有"仓库根"概念。
 */

/**
 * **受管记忆仓库根**登记表（第八轮 NF-3：把"仓库内"这一概念送到写原语）。
 *
 * 为什么需要它：这些状态存储（aliases / notifications / coi/* / advisor/* /
 * plugin-state）构造时只拿到一个路径，没有"仓库根"参数；把 root 逐个穿透
 * 十几个 store 构造函数既啰嗦又容易漏。安装期登记一次，写原语据此区分
 * 两种落点策略（见 {@link resolveSelfAnchoredTarget}）：
 *   - 文件在受管仓库内 → **整条路径链（含各级目录与落点文件自身）** 任一符号
 *     链接一律拒收，且真实路径必须留在仓库根内：共享记忆分支的一个 120000
 *     条目就能让 checkout 把状态文件**或整个状态目录**实体化成指向仓库外的
 *     链接（第九轮 NF-3：目录级形态此前被"用落点父目录当基准"短路）；
 *   - 文件在受管仓库外（用户显式配置的 stateFile / coiDataDir / 技能库 …）
 *     → 跟随"链接指向已存在的普通文件"的合法布局（stow/chezmoi）。
 *
 * 进程内单例插件语义：`apply()` 登记，卸载时注销。
 */
const MANAGED_ROOTS = new Set()

/**
 * 登记一个受管仓库根（幂等）。
 * @param {string} dir - 记忆仓库目录（`config.memoryDir`）。
 * @returns {void}
 */
export function registerManagedRoot(dir) {
  if (typeof dir === 'string' && dir !== '') MANAGED_ROOTS.add(resolve(dir))
}

/**
 * 注销一个受管仓库根（幂等）。
 * @param {string} dir - 记忆仓库目录。
 * @returns {void}
 */
export function unregisterManagedRoot(dir) {
  if (typeof dir === 'string' && dir !== '') MANAGED_ROOTS.delete(resolve(dir))
}

/**
 * 命中落点的**受管仓库根**（含根自身；多层嵌套时取最深的那个）。
 *
 * 判定只用**字符串层**的 `resolve()`：落点是符号链接、其父链是符号链接都不
 * 影响"这个落点在哪个受管仓库之下"这一事实（真实路径包含性由后续的
 * `resolveSafeRepoTarget` 负责）。NF-3：写原语必须拿到这个根当断言基准，
 * 否则会出现"用落点自己的父目录当根 ⇒ realpath(父) 自己变成根 ⇒ 包含性
 * 断言恒真"的短路（目录级 120000 链接写穿仓库外）。
 *
 * @param {string} file - 绝对/相对落点。
 * @returns {string | null} 命中的受管根（resolve 后的形式）；不在任何受管根下为 null。
 */
export function managedRootOf(file) {
  let abs
  try {
    abs = resolve(file)
  } catch {
    return null
  }
  let best = null
  for (const root of MANAGED_ROOTS) {
    if (!(abs === root || isInsideRoot(root, abs))) continue
    if (best === null || root.length > best.length) best = root
  }
  return best
}

/**
 * 落点是否位于任一受管仓库根之下（含根自身）。
 * @param {string} file - 绝对/相对落点。
 * @returns {boolean}
 */
export function isInsideManagedRoot(file) {
  return managedRootOf(file) !== null
}

/** 自锚定落点被拒时的统一异常（fail-loud：绝不"静默不写"）。 */
export function writeTargetRefusedError(abs) {
  return new Error(`dsh-memory-evolve: write target ${abs} is a symlink or escapes its directory — write refused (pre-placed symlinks at atomic-write landing spots are rejected; remove the symlink and retry)`)
}

/**
 * **自锚定落点解析**（`writeFileAtomicSafeAt` / `writeFileAtomicSafeAtAsync` /
 * `appendFileSafeAt` 的共用入口，2026-09-13 第八轮 NF-3 收敛）。
 *
 * 判据与危害同构（复核报告 NF-3）：
 *   - **危害** = 落点被引到调用方意图之外（写到目录/仓库外、覆盖任意文件）；
 *   - **不是危害** = 状态文件本身是符号链接、但写的是它指向的那个真实文件
 *     （stow/chezmoi 一类「把单个文件软链到位」的合法布局；第一轮把它一律
 *     判成故障，属于判据严于危害的误伤，且 `NotificationStore.add` 还会以
 *     未处理的 Promise 拒绝形式穿透）。
 *
 * 因此（2026-09-13 第九轮：档位顺序按"受管仓库优先"重排，见 NF3-1）：
 *   0) 落点在**受管记忆仓库**之下（{@link registerManagedRoot}）——无论调用方
 *      有没有给 `anchorDir`，一律以**登记的仓库根**为断言基准：整条链（含落点
 *      文件自身、含各级目录）逐层 lstat，任一符号链接即拒收，真实路径必须留在
 *      仓库内。共享分支的一个 120000 条目就能把状态文件**或整个状态目录**实体
 *      化成指向仓库外的链接，所以这里保持第一轮的"仓库内一律拒收"。
 *   1) 以 `options.anchorDir`（调用方声明的受管根，如技能库根）为准时——
 *      从根到落点的整条路径链不得出现符号链接、真实路径必须留在根内。
 *      **插件自有的内容落点**（内置技能同步 / 适配器技能）用这一档：预置的
 *      链接不得把技能正文写到技能库之外（NF-1）。
 *   2) 缺省（仓库外的状态文件）——落点文件**自身**是符号链接且指向一个**已存在
 *      的普通文件**时，按真实目标写入（保留链接本身，stow/chezmoi 合法布局）；
 *      悬空链接、目录目标、父链越界等"能写到目录外/写到新位置"的形态仍然
 *      fail-loud 拒收。
 *   3) `options.followFileSymlink === false` —— 严格档：落点文件是符号链接
 *      一律拒收（技能内容编辑等"改的是我们自己的文件"的场景）。
 *
 * 无论哪一档，**临时落点**始终 `O_EXCL` + 断言（me-1/me-2 的防护不变）。
 *
 * @param {string} file - 目标文件绝对路径（父目录不存在时自动创建）。
 * @param {{anchorDir?: string, followFileSymlink?: boolean}} [options]
 * @returns {{dir: string, target: string}} 写入目录（断言基准）+ 真实落点。
 * @throws {Error} 落点被拒。
 */
function resolveSelfAnchoredTarget(file, options = {}) {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const base = basename(file)
  // NF-3（第三轮对抗复核）：**受管记忆仓库内的落点一律先走仓库级断言**，基准
  // 是登记的那个根，不是落点自己的父目录。
  //
  // 用父目录当基准是恒真的：`resolveSafeRepoTarget(dir, base)` 里 realpath(dir)
  // 自己变成"包含性根"，于是 `hasSymlinkComponent` 只看 base 这一层、包含性
  // 断言永远为真 —— 一条**目录级** 120000 条目（共享分支里
  // `<memoryDir>/coi` = 120000，git 的链接条目不区分"文件用/目录用"）就能让该
  // 目录下的全部状态写入实体化到仓库外，而下面的 `managedRootOf` 那一关因为
  // 提前 return 永远走不到（第三轮 NF3-1 实测：NotificationStore / TaskStore /
  // writeFileAtomicSafeAt 三种调用方全部写穿）。
  //
  // 判据：整条链（含落点文件自身）逐层 lstat，任一符号链接即拒收；真实路径
  // 必须留在受管根内（`resolveSafeRepoTarget` 的 realpath 包含性 + 目标文件
  // realpath 复检）。这与第一轮"仓库内落点是符号链接一律拒收"同一条口径，
  // 只是把判定基准从"落点父目录"抬到"受管仓库根"。
  const managedRoot = managedRootOf(file)
  if (managedRoot !== null) {
    const rel = relative(resolve(managedRoot), resolve(file))
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw writeTargetRefusedError(file)
    const relPosix = rel.split(sep).join('/')
    if (hasSymlinkComponent(managedRoot, relPosix)) throw writeTargetRefusedError(file)
    const anchored = resolveSafeRepoTarget(managedRoot, relPosix)
    if (anchored === null) throw writeTargetRefusedError(file)
    return { dir: dirname(anchored), target: anchored }
  }
  if (typeof options.anchorDir === 'string' && options.anchorDir !== '') {
    const anchor = options.anchorDir
    const rel = relative(resolve(anchor), resolve(file))
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw writeTargetRefusedError(file)
    const relPosix = rel.split(sep).join('/')
    if (hasSymlinkComponent(anchor, relPosix)) throw writeTargetRefusedError(file)
    const anchored = resolveSafeRepoTarget(anchor, relPosix)
    if (anchored === null) throw writeTargetRefusedError(file)
    return { dir: dirname(anchored), target: anchored }
  }
  const target = resolveSafeRepoTarget(dir, base)
  if (target !== null) return { dir, target }
  if (options.followFileSymlink === false) throw writeTargetRefusedError(file)
  // 落点文件本身是符号链接：跟随到已存在的普通文件目标（写链接目标、保留链接）。
  // 受管仓库内**到不了这里**（上面已按仓库级断言拒收一切符号链接），所以这一段
  // 只服务"用户显式配置在仓库外的状态文件"（stow/chezmoi 一类合法布局）。
  let realDir
  try {
    realDir = realpathSync(resolve(dir))
  } catch {
    throw writeTargetRefusedError(file)
  }
  const abs = join(realDir, base)
  let linkReal
  try {
    if (!lstatSync(abs).isSymbolicLink()) throw new Error('not-a-file-symlink')
    linkReal = realpathSync(abs)
    if (!statSync(linkReal).isFile()) throw new Error('not-a-regular-file')
  } catch {
    // 悬空链接 / 目录目标 / 其它越界形态：写进去等于在调用方意图之外
    // 创建或改写文件 → 仍拒收。
    throw writeTargetRefusedError(file)
  }
  return { dir: dirname(linkReal), target: linkReal }
}

/**
 * **自锚定**的原子写（tmp + rename）：以目标文件所在目录为断言基准，供不在
 * 同步仓库内的配置/状态文件使用（`~/.dsh/**`、技能目录、COI 各状态存储 …）。
 *
 * 与 {@link writeFileAtomicSafe} 的落点规则一致：
 *   1) 目标文件与临时落点都过 `assertSafeRepoTarget`（逐层 lstat 拒符号链接
 *      + realpath 包含性）；落点文件的符号链接按 {@link resolveSelfAnchoredTarget}
 *      的三档策略处理（缺省跟随到已存在的真实文件，`followFileSymlink:false`
 *      或 `anchorDir` 则拒收）；
 *   2) 临时落点 `O_EXCL` 打开（预置的同名符号链接/文件 → 拒收，绝不跟随），
 *      "普通文件 = 崩溃残留"时断言后清理重试一次；
 *   3) 按 fd 写入，rename 前后各复检一次。
 *
 * @param {string} file - 目标文件绝对路径（父目录不存在时自动创建）。
 * @param {string | Buffer} data - 正文。
 * @param {{anchorDir?: string, followFileSymlink?: boolean}} [options] - 见
 *   {@link resolveSelfAnchoredTarget}。
 * @returns {string} 落点绝对路径。
 * @throws {Error} 落点被拒（符号链接/越界/预置同名条目）——调用方必须把它
 *   当失败处理，不得吞成"写成功"。
 */
export function writeFileAtomicSafeAt(file, data, options) {
  const { dir, target } = resolveSelfAnchoredTarget(file, options)
  const written = writeFileAtomicSafe(dir, target, data)
  if (written.ok !== true) throw writeTargetRefusedError(written.refusedPath ?? file)
  return written.path
}

/**
 * 自锚定**追加**写（`appendFileSafeAt`）：落盘语义要求目标可已存在，因此
 * 不能用 `O_EXCL`（见 {@link writeFileAtomicSafe}）。做法：写前断言落点 +
 * `open(target,'a')` + **只按 fd 写入** + 打开后按 inode/路径复检；预置的
 * 同名符号链接在写前断言就被拒（打开窗口内的翻转由打开后复检兜住）。
 *
 * @param {string} file - 目标文件绝对路径（父目录不存在时自动创建）。
 * @param {string | Buffer} data - 追加内容。
 * @param {{anchorDir?: string, followFileSymlink?: boolean}} [options] - 见
 *   {@link resolveSelfAnchoredTarget}。
 * @returns {string} 落点绝对路径。
 * @throws {Error} 落点被拒。
 */
export function appendFileSafeAt(file, data, options) {
  const { dir, target } = resolveSelfAnchoredTarget(file, options)
  let fd
  try {
    fd = openSync(target, 'a')
  } catch (error) {
    if (error && error.code === 'EISDIR') throw writeTargetRefusedError(target)
    throw error
  }
  try {
    const opened = fstatSync(fd)
    let same = false
    try {
      const viaPath = statSync(target)
      same = viaPath.dev === opened.dev && viaPath.ino === opened.ino
    } catch {
      same = false
    }
    if (!same || !assertSafeRepoTarget(dir, target)) throw writeTargetRefusedError(target)
    writeFileSync(fd, data) // 按 fd 写入：关闭前不再按路径解析
  } finally {
    try { closeSync(fd) } catch { /* 已关闭 */ }
  }
  return target
}

/**
 * {@link writeFileAtomicSafeAt} 的异步版：给必须异步落盘的大文件用
 * （同步 stringify+写盘几十万条会阻塞主进程数秒）。
 *
 * 安全性不因异步而放宽：打开前断言 + `open(tmp,'wx')`（O_EXCL 绝不跟随预置
 * 链接）+ **按 fd 写入**（`FileHandle.writeFile`，关闭前不再按路径解析）+
 * rename 前后复检。
 *
 * @param {string} file - 目标文件绝对路径（父目录不存在时自动创建）。
 * @param {string | Buffer} data - 正文。
 * @param {{anchorDir?: string, followFileSymlink?: boolean}} [options] - 见
 *   {@link resolveSelfAnchoredTarget}。
 * @returns {Promise<string>} 落点绝对路径。
 * @throws {Error} 落点被拒。
 */
export async function writeFileAtomicSafeAtAsync(file, data, options) {
  const { dir, target } = resolveSelfAnchoredTarget(file, options)
  const tmp = `${target}.tmp.${process.pid}`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!assertSafeRepoTarget(dir, tmp)) throw writeTargetRefusedError(tmp)
    let handle
    try {
      handle = await openAsync(tmp, 'wx') // O_EXCL：预置的同名链接/文件 → EEXIST
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let st
      try {
        st = lstatSync(tmp)
      } catch {
        continue // 竞态里刚好消失：重试
      }
      if (!st.isFile()) throw writeTargetRefusedError(tmp)
      if (!assertSafeRepoTarget(dir, tmp)) throw writeTargetRefusedError(tmp)
      try {
        await unlinkAsync(tmp)
      } catch {
        throw writeTargetRefusedError(tmp)
      }
      continue
    }
    try {
      await handle.writeFile(data) // 按 fd 写入，绝不按路径二次解析
    } catch (error) {
      try { await handle.close() } catch { /* 已关闭 */ }
      throw error
    }
    await handle.close()
    if (!assertSafeRepoTarget(dir, tmp) || !assertSafeRepoTarget(dir, target)) {
      try { await unlinkAsync(tmp) } catch { /* 已被移走 */ }
      throw writeTargetRefusedError(target)
    }
    await renameAsync(tmp, target)
    if (!assertSafeRepoTarget(dir, target)) throw writeTargetRefusedError(target)
    return target
  }
  throw writeTargetRefusedError(tmp)
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
