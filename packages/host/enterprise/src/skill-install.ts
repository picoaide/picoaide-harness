/**
 * Skill archive installation: download-side verification and safe unpacking
 * into the user skill root (`<dshHome>/skills/<name>`), which the upstream
 * `@deepseek-ai/dsh-skill-filesystem` provider watches and auto-discovers.
 *
 * Security posture (matches the connector-store review):
 * - archive bytes are bounded (`MAX_ARCHIVE_BYTES`) before any unpacking;
 * - the unpacked tree is bounded (`MAX_UNPACKED_BYTES`) via a dry-run
 *   listing pass;
 * - every tar entry path must stay inside the staging directory: absolute
 *   paths, `..` segments, and symbolic/hard links are rejected;
 * - when the gateway supplies `x-skill-checksum` (sha256 hex), the archive
 *   must match it or installation is refused;
 * - the staged tree is moved into place with a same-filesystem rename after
 *   the SKILL.md check, and an existing target directory is replaced only
 *   after the new tree is fully verified.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import AdmZip from 'adm-zip'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { assertArchiveSafe, archiveFormat, extractTar, extractZip, MAX_ARCHIVE_BYTES } from './archive-util.ts'
import { invocationBooleanVerdict, precheckSkillPackage } from './manifest-precheck.ts'
import {
  isSameSkillRoot,
  runtimeSkillRoots,
  type RuntimeSkillRoot,
} from './skill-runtime-roots.ts'
import { DEFAULT_HOST_LOCALE, hostCopy, type HostLocale } from 'dsh-plugin-desktop/host-locale'
import { dshHomeSafe } from 'dsh-plugin-desktop/desktop-home'

/**
 * 运行时技能名规则 —— **单一真源指向上游**：
 * `deepseek-harness/packages/skill/skill/src/index.ts` 的 `SKILL_NAME`（导出为
 * `isSkillName`）。它不是"我们选的规则"，而是运行时**真正用它决定加载与否**的
 * 那一条：frontmatter `name` 不匹配的 SKILL.md 会被 `skill-filesystem` 静默忽略
 * （`ignored: invalid skill name`），界面上却什么都看不出来。
 *
 * 独立审计 2026-09-23 A1 实测的形态：安装器此前用 `[a-z0-9][a-z0-9._-]{0,63}`
 * （只保证"是一个安全的目录段"），于是 `my.skill` / `my_skill` / `alpha--beta`
 * 全都**安装成功但永远加载不到**。安装器是这条链上最宽的一道门，必须与运行时
 * 逐字一致 —— 谁要放宽它，先改运行时。
 *
 * 变异验证：把它改回 `[a-z0-9][a-z0-9._-]{0,63}` ⇒
 * `skill-install.spec.ts` 的「名字规则与上游 isSkillName 逐字一致」必红。
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/**
 * 目录段长度上限（64）。上游正则本身不限长，但目录名要落到用户家目录里，
 * 与服务端应用 ID 的上限（`skillmanifest` 的 maxAppId=64）保持一致。
 */
export const MAX_SKILL_NAME_LENGTH = 64

/** 是否是运行时可加载的技能名（目录名与 frontmatter name 都用它）。 */
export function isLoadableSkillName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_SKILL_NAME_LENGTH && SKILL_NAME_PATTERN.test(name)
}

/** Validate a skill name for use as a single directory segment. */
export function validateSkillName(name: string): string {
  if (!isLoadableSkillName(name)) {
    throw new ArchiveInstallRefusal('NAME_INVALID', `invalid skill name ${JSON.stringify(name)}`)
  }
  return name
}

/**
 * 安装器自己的**拒绝类**错误：文案已经面向用户、且**不含本机路径**，
 * 因此 {@link describeArchiveFailure} 原样透出，不做脱敏（脱敏会吃掉
 * `SKILL.md`/`checksum` 这类可判定的关键词）。
 *
 * `code` 是稳定错误码（路由据此决定 HTTP 状态，客户端据此决定要不要弹确认条）。
 */
export class ArchiveInstallRefusal extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ArchiveInstallRefusal'
    this.code = code
  }
}

/** 结果与 HTTP 信封一一对应：路由不再自己写 `/checksum|archive|…/` 正则。 */
export interface ArchiveFailureDescription {
  /** HTTP 状态码（409=需要用户确认覆盖/删除本机内容,422=拒绝,404=未安装,413=过大,502=系统级失败）。 */
  status: number
  /** 给用户看的文案（系统级错误已脱敏）。 */
  message: string
  /** 稳定错误码（有则透出到响应体）。 */
  code?: string | undefined
  /** 是否是"归档/参数不合规"这一类客户端错误。 */
  refusal: boolean
}

/**
 * 兜底分类用的关键词（老路径上仍有**非** {@link ArchiveInstallRefusal} 的拒绝：
 * `archive-util` 的条目校验、以及历史调用点）。它们全是客户端错误，不能因为
 * "不是typed"就被当成上游 502。
 */
const REFUSAL_HINT = /checksum|archive|SKILL\.md|skill name|link entry|too large|traversal|empty path|frontmatter|duplicate entry|not installed|local content/u

/** 系统级 errno → 一句人话（保留原因、去掉路径，审计 2026-09-23 A12）。 */
const ERRNO_HINT: Record<string, string> = {
  EACCES: 'permission denied',
  EBUSY: 'the file is in use by another process',
  EEXIST: 'the path already exists',
  EISDIR: 'expected a file but found a directory',
  EMFILE: 'too many open files',
  ENOENT: 'path not found',
  ENOSPC: 'no space left on device',
  ENOTDIR: 'expected a directory but found a file',
  ENOTEMPTY: 'target directory not empty (a concurrent install/uninstall may be running)',
  EPERM: 'operation not permitted',
  EROFS: 'read-only file system',
}

/**
 * 脱敏：把本机绝对路径换成 `…/<basename>`。
 *
 * 审计 2026-09-23 A12 实测的形态：安装失败时界面直接显示
 * `ENOTEMPTY: directory not empty, rename '/home/<user>/.picoaide-harness/skills/…'`
 * —— 家目录/用户名连同内部 staging 结构一起透出。保留 errno 与原因，只去掉路径。
 * @param raw - 原始错误文案。
 * @returns 可安全展示的文案（≤300 字符）。
 */
export function sanitizeArchiveErrorText(raw: string): string {
  const errno = /^([A-Z][A-Z0-9]+):/u.exec(raw)?.[1]
  const hint = errno === undefined ? undefined : ERRNO_HINT[errno]
  if (errno !== undefined && hint !== undefined) return `${errno}: ${hint}`
  const text = raw
    // 带引号的路径是 Node 错误文案的普遍形态。
    .replace(/(['"`])((?:[A-Za-z]:)?[\\/][^'"`\n]*)\1/gu, (_match, quote: string, path: string) => `${quote}…/${basename(path)}${quote}`)
    // 其余裸绝对路径 token。
    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\s'",;:)\]]+[\\/])*([^\s'",;:)\]]+)/gu, (_match, base: string) => `…/${base}`)
  return text.length > 300 ? `${text.slice(0, 297)}…` : text
}

/**
 * 把归档安装/卸载的失败翻译成 HTTP 信封（分类 + 脱敏 + 状态码）。
 *
 * **唯一实现**：技能（`/api/pico/skills*`、`/api/pico/shared-skills*`）与共享智能体
 * （`/api/pico/agent-presets*`）四条写面共用它。抽出来的理由：这三件事此前散在
 * auth-gate 的四处 `isRefusal ? 422 : 502` 正则里，任一处漏改就会出现"同一个拒绝
 * 在这里 422、在那里 502"；而独立复审 2026-09-23 **A12** 实测智能体路径仍是旧写法
 * （裸分类 + 原文）⇒ 系统级错误（如
 * `ENOTDIR: not a directory, mkdir '/home/<user>/.picoaide-harness/agent-presets'`）
 * 会把**本机绝对路径**透给 UI。
 * @param cause - the thrown value.
 * @returns status / message / code / refusal。
 */
export function describeArchiveFailure(cause: unknown): ArchiveFailureDescription {
  const raw = cause instanceof Error ? cause.message : String(cause)
  const typed = cause instanceof ArchiveInstallRefusal ? cause : undefined
  if (typed?.code === 'NOT_INSTALLED') return { status: 404, message: raw, code: typed.code, refusal: true }
  if (typed?.code === 'LOCAL_CONTENT') return { status: 409, message: raw, code: typed.code, refusal: true }
  if (typed?.code === 'ARCHIVE_TOO_LARGE') return { status: 413, message: raw, code: typed.code, refusal: true }
  // per-name 锁竞争（F3 修复）：**可重试**的瞬时状态，不是"请求有问题"——报 503，
  // 面板按错误文案提示稍后重试（不要报 422 让用户以为要改请求）。
  if (cause instanceof SkillLockedError) return { status: 503, message: raw, code: cause.code, refusal: true }
  if (typed !== undefined || REFUSAL_HINT.test(raw)) {
    return {
      status: 422,
      message: raw,
      ...typed === undefined ? {} : { code: typed.code },
      refusal: true,
    }
  }
  return { status: 502, message: sanitizeArchiveErrorText(raw), refusal: false }
}

/**
 * 安装器私有临时区（staging 与"换入前的旧目录"都放这里）。
 *
 * 三条硬要求（独立审计 2026-09-23 A7/A12）：
 *  1. **以 `.` 开头**、且**不以技能名开头** —— 上游 `skill-filesystem` 的
 *     `discoverRoot` 只看技能库的**直接子目录**里有没有 `SKILL.md`，不排除点号目录。
 *     旧实现把备份放在 `<skills>/.<name>.backup-<pid>-<ts>`：目录根上就有真
 *     frontmatter，于是**卸载后运行时仍然加载得到那份技能**（"卸载不生效"）。
 *  2. **必须还是直接子目录之下的第二层**（`.skill-tmp/install-*`）：运行时只认
 *     直接子目录，因此 `install-XXX/unpacked/SKILL.md` 永远不会被发现；
 *     `listInstalledSkills` 同样只列直接子目录 ⇒ 备份残留既不会被当技能、也不会
 *     被列成"已安装"。
 *  3. 与技能库**同一文件系统** ⇒ `rename()` 仍然是原子的（staging 因此在
 *     `skillsDir` 之内，而不是 os.tmpdir()）。
 *
 * ⚠️ 第 2 条是**结构判据**（层数），不是"目录名以点开头"（第四轮审计 R4-B-2：
 * 上游 `discoverRoot` 按 frontmatter 认技能名、还会把点号目录排在真目录**之前**，
 * 所以"藏在根上的点号目录"在上游侧反而会赢下注册表）。随包同步器的换入临时目录
 * 用的是同一个目录名（跨包契约，见 {@link SKILL_REMOVED_DIR} 附近的说明与
 * `tests/skill-channel-parity.spec.ts` 的对拍）。
 */
export const SKILL_TEMP_DIR = '.skill-tmp'

/**
 * "用户显式卸载过这个随包技能"的墓碑目录（R4-B-4，第四轮审计）。
 *
 * 落点 `<skills>/.skill-removed/<name>.json`，与 {@link PROVENANCE_DIR} /
 * {@link SKILL_TEMP_DIR} / `.skill-locks` 同源：技能库根下的点号私有目录 ——
 * 运行时发现器只认直接子目录里的 `SKILL.md`，`listInstalledSkills` 也只列直接
 * 子目录，所以墓碑既不会被当成技能，也不会出现在能力中心列表里。
 *
 * **跨包契约**：随包插件（`dsh-memory-evolve`）的开机同步读同一个落点、按同一个
 * 判据（`appId` === 技能名 && `channel === 'plugin'`）跳过 —— vendored 包不能
 * import 企业包，两端各自实现；由 `tests/skill-channel-parity.spec.ts` 读源码对拍。
 *
 * 为什么必须有它：能力中心对 `originChannel === 'plugin'` 的本机行给了「卸载」，
 * 而卸载是纯本地删目录 ⇒ 下一次开机同步看到落点不存在，就走"首次安装"路径原样
 * 装回（用户视角：卸载后重启，技能又回来了，全程零提示）。
 */
export const SKILL_REMOVED_DIR = '.skill-removed'

/** 安装器写入的版本标记文件（安装器独占面：打包与安装两端都要净化它）。 */
export const INSTALL_VERSION_FILE = '.install-version'

/** 陈旧 staging 的保留时长：超过它才允许清扫（正在安装的那一份不会被误删）。 */
const STALE_TEMP_MS = 24 * 60 * 60 * 1000

/** 回滚失败时旧内容的保留前缀 —— 清扫器**不碰**它（宁可留垃圾，不可删用户内容）。 */
const ORPHAN_PREFIX = 'orphan-'

/**
 * per-name 文件锁的**协议常量**（独立复审 r3 F3 的修复）—— 跨包契约，与
 * `packages/vendor/memory-evolve/lib/coi/skills-sync.js` 的同名常量必须同值
 * （vendored 包不能 import 企业包，故两端各自实现同一协议；由
 * `tests/skill-channel-parity.spec.ts` 读源码文本对拍，找不到字面量即 throw）。
 *
 * 为什么必须有它：随包插件（dsh-memory-evolve）的**开机同步**与这里的安装器都会
 * 整目录换入 `<skillsDir>/<name>`，此前两者完全不互斥（同步侧连这把锁都不取）。
 * 复审实测的并发终态是「内容是插件版 + `.picoaide` 是市场版 + 市场内容被删」
 * （5/5；真实体量 20 轮 15 轮），而且此后插件侧永久 `SKILL_CHANNEL_CONFLICT`
 * 拒收该目录 ⇒ **不会自愈**。
 *
 * 协议（两端逐条一致）：
 *   - 落点 `<skillsDir>/.skill-locks/<name>.lock`（与技能库同一文件系统、以点开头
 *     ⇒ 不是技能目录，也不被 `listInstalledSkills` / 上游发现器看见；释放后**空目录
 *     留在技能库根上**，与 `.skill-tmp` 同类 —— 现有"技能库不留私有目录"的断言按
 *     这两者之一放行）；
 *   - 创建 `O_CREAT|O_EXCL`（`open(..., 'wx')`）：预置的符号链接或文件一律 EEXIST，
 *     **绝不跟随**（因此不存在"锁落点写穿库外"这条路）；
 *   - 内容 `{"pid":<number>,"at":<ms>}`（陈旧判定的依据）；
 *   - 陈旧 = 持锁 pid **确定已死**（`kill(pid,0)` 抛 ESRCH），或没有可用 pid 且
 *     mtime 超过 {@link SKILL_LOCK_STALE_MS}；`EPERM`（不可判定）保守视为仍持有；
 *   - 释放只删**自己创建的那个 inode**（dev/ino 比对），不误删别人的锁；
 *   - **有界等待**：这里（异步路径）最多等 {@link SKILL_LOCK_WAIT_MS}，等待期间
 *     让出事件循环（同进程里的持锁者才推进得动）；同步侧（插件启动路径）零等待，
 *     拿不到就拒收 —— 见 vendored 侧的同名注释。
 */
export const SKILL_LOCK_DIR = '.skill-locks'

/** 锁文件名后缀（协议常量，两端同值）。 */
export const SKILL_LOCK_SUFFIX = '.lock'

/** 无可用 pid 的锁文件的陈旧阈值（协议常量，两端同值）。 */
export const SKILL_LOCK_STALE_MS = 10_000

/** 拿不到锁时的等待上限：**有界**（绝不无界等待），超时 fail-loud 而不是无锁写入。 */
export const SKILL_LOCK_WAIT_MS = 5_000

/** 等待期的轮询间隔（让出事件循环，见 {@link SKILL_LOCK_DIR}）。 */
const SKILL_LOCK_POLL_MS = 25

/** 安装器标记（`.picoaide/release.json`）的体积上限 —— 与同步侧同值（协议常量）。 */
const MARKER_MAX_BYTES = 64 * 1024

/** 拿不到 per-name 锁时的失败（`SKILL_LOCKED`，对外 503：可重试，不是"请求有问题"）。 */
export class SkillLockedError extends Error {
  readonly code = 'SKILL_LOCKED'

  /** @param message - 用户可读原因（点名技能/落点/持有者）。 */
  constructor(message: string) {
    super(message)
    this.name = 'SkillLockedError'
  }
}

/**
 * 读一个小普通文件（类型 + 体积闸门，**先闸门后读**）。
 *
 * 与同步侧 `skills-sync.js` 的 `readSmallRegularFile` 同一份判据：`lstat` 必须是
 * 普通文件（拒 FIFO/目录/符号链接/设备节点）+ 体积上限。这里不做 fd 复验（异步
 * API 下 open 一个 FIFO 仍会阻塞），但**先 lstat** 已经挡掉"一开始就是 FIFO"的
 * 形态；与同步侧那条"启动路径绝不能被 FIFO 阻塞"的硬要求相比，这里的读取都在
 * 请求路径上，且有界（`installSkillArchive` 的调用方有超时）。
 *
 * @param file - 文件绝对路径。
 * @param maxBytes - 体积上限。
 * @returns 正文；不是小普通文件/读不出来时为 undefined。
 */
async function readSmallRegularFile(file: string, maxBytes: number = MARKER_MAX_BYTES): Promise<string | undefined> {
  const stat = await lstat(file).catch(() => undefined)
  if (stat === undefined || !stat.isFile() || stat.size > maxBytes) return undefined
  return await readFile(file, 'utf8').catch(() => undefined)
}

/**
 * 锁文件是否陈旧（{@link SKILL_LOCK_DIR} 的协议判据之一；与同步侧
 * `skills-sync.js` 的 `isSkillLockStale` 逐条同源）。
 *
 * 先 `lstat` 要求**普通文件**：符号链接/目录/设备不是我们的锁形态 ⇒ 一律不按陈旧
 * 删除（fail-safe：预置链接的形态到这里就变成"等不到锁 ⇒ fail-loud"，而不是
 * "被我们删掉"或"无锁写入"）。
 *
 * @param lockPath - 锁文件绝对路径。
 * @returns 可抢占为 true。
 */
async function isSkillLockStale(lockPath: string): Promise<boolean> {
  const stat = await lstat(lockPath).catch(() => undefined)
  if (stat === undefined || !stat.isFile()) return false
  const raw = await readSmallRegularFile(lockPath)
  if (raw !== undefined) {
    let owner: { pid?: unknown } | undefined
    try {
      owner = JSON.parse(raw) as { pid?: unknown }
    } catch {
      owner = undefined
    }
    if (owner !== null && typeof owner === 'object' && Number.isInteger(owner.pid) && (owner.pid as number) > 0) {
      try {
        process.kill(owner.pid as number, 0) // 信号 0 = 只探测存活
        return false
      } catch (cause) {
        // 只有 ESRCH（进程确实不存在）算陈旧；EPERM 等"不可判定"保守视为仍持有。
        return (cause as NodeJS.ErrnoException).code === 'ESRCH'
      }
    }
  }
  return Date.now() - stat.mtimeMs > SKILL_LOCK_STALE_MS
}

/**
 * 取一个技能名的 per-name 文件锁（{@link SKILL_LOCK_DIR} 的协议实现）。
 *
 * 有界等待：最多 `waitMs`，每轮让出事件循环；陈旧锁（持锁进程已死）立即抢占。
 * 超时抛 {@link SkillLockedError}（fail-loud）——**绝不**在没拿到锁的情况下往下走。
 *
 * @param skillsDir - the skill root.
 * @param name - the skill directory name.
 * @param waitMs - 拿不到锁时的等待上限（缺省 {@link SKILL_LOCK_WAIT_MS}）。
 * @returns 释放函数（只删自己创建的那个 inode）。
 * @throws SkillLockedError 在等待超时后。
 */
async function acquireSkillDirLock(skillsDir: string, name: string, waitMs: number): Promise<() => Promise<void>> {
  const lockDir = join(skillsDir, SKILL_LOCK_DIR)
  const lockPath = join(lockDir, `${name}${SKILL_LOCK_SUFFIX}`)
  await mkdir(lockDir, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + Math.max(0, waitMs)
  for (;;) {
    let handle
    try {
      handle = await open(lockPath, 'wx') // O_CREAT|O_EXCL：绝不跟随预置的符号链接
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
      handle = undefined
    }
    if (handle !== undefined) {
      let stat
      try {
        stat = await handle.stat()
        // 按 **handle**（fd）写：关闭前不再按路径解析（祖先被换走时不写到库外）。
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }))
      } catch (cause) {
        await handle.close().catch(() => { /* 已关闭 */ })
        await rm(lockPath, { force: true }).catch(() => { /* 收不掉就留给陈旧判定 */ })
        throw cause
      }
      await handle.close().catch(() => { /* 已关闭 */ })
      return async () => {
        // 只删自己创建的那个 inode：祖先被换走/已被别人抢占时不误删。
        const now = await lstat(lockPath).catch(() => undefined)
        if (now !== undefined && now.dev === stat.dev && now.ino === stat.ino) {
          await rm(lockPath, { force: true }).catch(() => { /* 留给陈旧判定 */ })
        }
      }
    }
    // 被占用：陈旧（持锁进程确定已死 / 无 pid 且 mtime 超时）⇒ 抢占一次。
    if (await isSkillLockStale(lockPath)) {
      await rm(lockPath, { force: true }).catch(() => { /* 抢不掉 ⇒ 走下面的等待/超时 */ })
      if (!existsSync(lockPath)) continue
    }
    if (Date.now() >= deadline) {
      throw new SkillLockedError(
        `another writer holds the "${name}" lock (${SKILL_LOCK_DIR}/${name}${SKILL_LOCK_SUFFIX}: `
        + 'the bundled-skill sync or another install/uninstall is in flight); retry shortly — '
        + 'refusing to write the same skill directory concurrently',
      )
    }
    await sleep(SKILL_LOCK_POLL_MS)
  }
}

/** 等待 `ms` 毫秒（等待锁时让出事件循环；同进程的持锁者才推进得动）。 */
async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/**
 * per-name 互斥（审计 A7）：同一技能目录的 install/uninstall 必须串行。
 *
 * 面板只有一个 `inFlight` 槽，多窗口/重试/脚本都能绕过它；两个 install 交错会
 * 留下孤儿备份目录，install+uninstall 交错则可能"两边都回 200 但技能还在"。
 * 锁按 (skillsDir, name) 取，键里不含路径分隔歧义。
 *
 * **两层（F3 修复，2026-09-23 独立复审 r3）**：
 *   1. 进程内 promise 链（这一层，`skillLocks`）——同进程串行，避免自己人抢文件锁；
 *   2. **跨包/跨进程的文件锁**（{@link SKILL_LOCK_DIR}）——随包插件的开机同步与这里
 *      是**同一个进程里的两个包**，跨包 import 禁止，所以只能靠这份文件锁协议互斥。
 * 顺序是先内存链、再文件锁：拿到文件锁的临界区因此一定是"这个名字在本进程里唯一
 * 的那一个"，等待也不会与自己的前一个持锁者互相等。
 */
const skillLocks = new Map<string, Promise<void>>()

/**
 * Run `task` while holding the per-(skillsDir, name) lock.
 * @param skillsDir - the skill root.
 * @param name - the skill directory name.
 * @param task - the critical section.
 * @param options - `waitMs`：文件锁的等待上限（测试用它把"拿不到锁"钉成毫秒级）。
 * @returns whatever `task` resolves to.
 */
export async function withSkillLock<T>(
  skillsDir: string,
  name: string,
  task: () => Promise<T>,
  options: { waitMs?: number | undefined } = {},
): Promise<T> {
  const key = `${skillsDir}\u0000${name}`
  const previous = skillLocks.get(key) ?? Promise.resolve()
  // 前一个持锁者失败也要放行（否则一次失败会把该名字永久锁死）。
  const run = previous.then(() => undefined, () => undefined).then(async () => {
    const release = await acquireSkillDirLock(skillsDir, name, options.waitMs ?? SKILL_LOCK_WAIT_MS)
    try {
      return await task()
    } finally {
      await release()
    }
  })
  const tail = run.then(() => undefined, () => undefined)
  skillLocks.set(key, tail)
  void tail.then(() => { if (skillLocks.get(key) === tail) skillLocks.delete(key) })
  return await run
}

/** Result of a successful install. */
export interface SkillInstallResult {
  /** The skill name installed (validated, directory segment). */
  name: string
  /** Version reported by the gateway (`x-skill-version`), when supplied. */
  version?: string | undefined
  /** The user skill root the skill was installed under. */
  skillsDir: string
  /** The final installed directory. */
  targetDir: string
}

export interface InstallSkillArchiveOptions {
  /** Validated skill name. */
  name: string
  /** Raw archive bytes (gzipped tar or zip). */
  archive: Buffer
  /** Optional sha256 hex from the gateway (`x-skill-checksum`); mismatch refuses. */
  checksum?: string | undefined
  /** The user skill root (e.g. `<dshHome>/skills`). */
  skillsDir: string
  /** Optional gateway-reported version (`x-skill-version`), passed through. */
  version?: string | undefined
  /** 分发渠道(写入溯源标记;缺省 market)。 */
  channel?: SkillProvenanceChannel | undefined
  /** 来源服务端地址(写入溯源标记)。 */
  server?: string | undefined
  /**
   * 用户已在界面上确认"覆盖本机同名内容"（审计 A2/A3 的显式覆盖标记）。
   *
   * 目标目录存在、而它**不是**能力中心装的（没有 provenance / 渠道不是商店来源 /
   * appId 对不上）时，视为用户自制内容：没有这个标记一律拒绝（409
   * `LOCAL_CONTENT`），绝不静默整树替换。
   */
  overwrite?: boolean | undefined
  /** staging 清扫阈值(ms)；缺省 24h。测试用它钉住"陈旧目录会被清掉"。 */
  staleTempMaxAgeMs?: number | undefined
  /**
   * per-name 文件锁的等待上限(ms)；缺省 {@link SKILL_LOCK_WAIT_MS}。
   * **测试专用**：把"拿不到锁 ⇒ 有界 fail-loud"这条路钉成毫秒级，不必等满 5s。
   */
  lockWaitMs?: number | undefined
}

/**
 * Verify and install one skill archive.
 *
 * @throws Error with a user-facing message on any refusal; never leaves a
 * partial install behind (the staging directory is removed on failure).
 */
export async function installSkillArchive(options: InstallSkillArchiveOptions): Promise<SkillInstallResult> {
  const { name, skillsDir } = options
  // 名字先于锁校验（非法名不参与排队）。
  validateSkillName(name)
  // per-name 文件锁（跨包协议，见 SKILL_LOCK_DIR）：随包插件的开机同步取的是**同一把**，
  // 两端因此互斥；拿不到就在 waitMs 之后 fail-loud，绝不无锁写入。
  return await withSkillLock(skillsDir, name, () => runInstallSkillArchive(options), { waitMs: options.lockWaitMs })
}

/** {@link installSkillArchive} 的临界区（调用方必须已持有 per-name 锁）。 */
async function runInstallSkillArchive(options: InstallSkillArchiveOptions): Promise<SkillInstallResult> {
  const { name, archive, checksum, skillsDir, version, server, overwrite } = options
  const channel = options.channel ?? 'market'

  if (archive.byteLength === 0) throw new ArchiveInstallRefusal('ARCHIVE_EMPTY', 'empty archive')
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new ArchiveInstallRefusal('ARCHIVE_TOO_LARGE', `archive too large (${archive.byteLength} bytes)`)
  }
  if (checksum !== undefined) {
    const actual = createHash('sha256').update(archive).digest('hex')
    if (actual !== checksum.toLowerCase()) {
      throw new ArchiveInstallRefusal('CHECKSUM_MISMATCH', 'archive checksum mismatch; refused')
    }
  }

  // 陈旧 staging 清扫（审计 A12）：SIGKILL/断电会留下 `.install-*`（旧布局）或
  // `.skill-tmp/install-*`（新布局），此前没有任何清扫者，会一直堆积
  // （每个最多 16MiB 原始 + 64MiB 解包）。只清"超过阈值"的，正在跑的那一份不受影响。
  await sweepStaleSkillTemps(skillsDir, options.staleTempMaxAgeMs)

  // 同名覆盖守卫（审计 A2/A3 + W4 P1-2 + R4-B-3）：本机自制内容、**被本地修改过的
  // 商店内容**，以及**换渠道覆盖**（目标那份来自另一条商店渠道，如随包插件同步写下
  // 的 `plugin`）都必须由用户显式确认（面板确认条 → `?overwrite=1`）；缺确认一律
  // 409 `LOCAL_CONTENT`。三档共用同一份判据（{@link requiresOverwriteConfirmation}），
  // 面板侧是它的镜像（`CapabilityCenterPanel.needsOverwriteConfirm`）。
  const targetDir = join(skillsDir, name)
  const existingOrigin = await classifyInstalledSkill(targetDir, name)
  if (existingOrigin !== undefined && overwrite !== true) {
    const existingProv = existingOrigin === 'store' ? await readProvenance(targetDir) : undefined
    const existingChannel = existingProv?.channel
    // R4-B-3：`dirty` 与面板同一份事实（同一次内容哈希），否则会出现"面板挂了
    // 「已本地修改」徽章、宿主却照旧放行整树覆盖"的两端漂移。
    const existingDirty = await isInstalledSkillDirty(targetDir, existingProv)
    if (requiresOverwriteConfirmation(existingOrigin, existingChannel, channel, existingDirty)) {
      throw new ArchiveInstallRefusal(
        'LOCAL_CONTENT',
        describeOverwriteRefusal(name, existingOrigin, existingChannel, channel, existingDirty),
      )
    }
  }

  // Stage under the skill root so the final rename stays on one filesystem.
  await mkdir(skillsDir, { recursive: true, mode: 0o700 })
  const tempRoot = join(skillsDir, SKILL_TEMP_DIR)
  await mkdir(tempRoot, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(tempRoot, 'install-'))

  try {
    const format = archiveFormat(archive)
    if (format === null) throw new ArchiveInstallRefusal('ARCHIVE_UNSUPPORTED', 'unsupported archive format')

    // Pass 1: reject unsafe entries and bound the unpacked size without
    // extracting (zip via AdmZip in-memory scan; tar.gz via node-tar listing).
    // Violations are collected (throwing inside onentry does not terminate
    // the tar stream) and abort the offending entry; the stream still runs
    // to completion, then the first violation is thrown.
    await assertArchiveSafe(archive)

    // Pass 2: extract into the staging directory.
    const unpackRoot = join(staging, 'unpacked')
    await mkdir(unpackRoot, { recursive: true })
    if (format === 'zip') {
      await extractZip(archive, unpackRoot)
    } else {
      const archiveFile = join(staging, 'archive.tar.gz')
      await writeFile(archiveFile, archive, { mode: 0o600 })
      // 审计 A8：tar 通道与 zip 通道必须用同一套权限口径（剥掉 0o7000）。
      await extractTar(archiveFile, unpackRoot)
    }

    // The archive must carry a top-level SKILL.md (directory bundle or flat).
    await stat(join(unpackRoot, 'SKILL.md')).catch(() => {
      throw new ArchiveInstallRefusal('SKILL_MD_MISSING', 'archive has no SKILL.md at its root')
    })

    // The upstream skill-filesystem parser requires YAML frontmatter
    // (name + description) on SKILL.md; gateway archives keep the metadata
    // in a separate metadata.yaml instead. Synthesize the frontmatter from
    // metadata.yaml when SKILL.md lacks it, so installed skills are
    // discovered — and carry the gateway-reported version so hasUpdate can
    // compare against the installed copy. Archives that already carry
    // frontmatter are untouched (installer-only archives still get a version
    // injected here only when they lacked any frontmatter; full-control
    // archives keep their own metadata).
    await synthesizeSkillFrontmatter(unpackRoot, name, version)
    // 审计 A1：**装得上就必须加载得到** —— 按运行时的同一份规则复核最终
    // frontmatter（缺 name/description、非 kebab、name 与技能 ID 不一致都在此拒绝）。
    await assertLoadableSkillMetadata(unpackRoot, name)
    // 审计 A13：安装器自有标记文件是**安装器独占面**。归档自带同名文件时忽略它
    // （否则能力中心/遥测会把归档伪造的版本当成真版本）。
    await rmInstallerOwnedMarkers(unpackRoot)

    // Replace an existing installation only with a fully verified tree.
    // 审计 2026-08-25 P2-4:此前直接 rm(targetDir)+rename——两步之间 crash
    // 窗口会让已装技能目录整个消失。改为「rename 旧 → backup,rename 新 →
    // target,成功后删 backup」;失败时回滚旧目录。
    const backupDir = join(staging, 'backup')
    try {
      await rename(targetDir, backupDir).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== 'ENOENT') throw cause // 不存在 = 首次安装
      })
    } catch (cause) {
      throw cause instanceof Error ? cause : new Error(String(cause))
    }
    try {
      await rename(unpackRoot, targetDir)
    } catch (cause) {
      // 回滚:把旧目录还原,不留半安装状态。回滚失败时旧内容**绝不能删**:
      // 移出 install-* 清扫面(orphan- 前缀)并留一条日志。
      const restored = await rename(backupDir, targetDir).then(() => true).catch(() => false)
      if (!restored) {
        const orphan = join(tempRoot, `${ORPHAN_PREFIX}${Date.now()}-${name}`)
        await rename(backupDir, orphan)
          .then(() => { console.warn(`[skill-install] rollback failed for "${name}"; previous content kept in ${SKILL_TEMP_DIR}/${basename(orphan)}`) })
          .catch(() => { console.warn(`[skill-install] rollback failed for "${name}"`) })
      }
      throw cause instanceof Error ? cause : new Error(String(cause))
    }
    await rm(backupDir, { recursive: true, force: true }).catch((cause: unknown) => {
      // 尽力而为,但不再静默:残留会占空间(运行时看不到它)。
      console.warn(`[skill-install] could not remove the backup of "${name}": ${cause instanceof Error ? cause.message : String(cause)}`)
    })

    // 版本标记:安装在技能目录内写 .install-version(仅当版本已知),
    // host 代理读取它作为 installedVersion(hasUpdate 比较基准)。
    // 不碰 SKILL.md 内容(保留上游/用户归档原样)。
    if (version !== undefined && version !== '') {
      await writeFile(join(targetDir, INSTALL_VERSION_FILE), version, { mode: 0o600 }).catch(() => { /* 非致命 */ })
    }
    // 溯源标记(决策 2026-09-01 D6):记录应用 ID/版本/渠道/来源服务端与
    // 安装时的内容哈希,客户端据此判定归属与「是否被本地修改过」。
    // 写失败不致命——溯源是展示能力,不影响技能可用性。
    await writeProvenance(targetDir, {
      appId: name,
      version: version ?? '',
      channel,
      ...server === undefined ? {} : { server },
      archiveChecksum: await computeSkillContentHash(targetDir),
      installedAt: new Date().toISOString(),
    }).catch(() => { /* 非致命 */ })

    // 墓碑清除（R4-B-4）：用户重新装上了这个技能 ⇒ 之前"我卸载过它"的选择到此为止，
    // 否则下一次开机同步仍会因为墓碑跳过它（内容与墓碑互相矛盾）。放在安装**成功
    // 之后**，失败路径不动墓碑（宁可保持用户的选择）。
    await clearSkillTombstone(skillsDir, name)

    // R13-B P1-2：**"装好了"必须等于"运行时加载的是刚装的那一份"**。旧安装器
    // （≤2.8.1）留下的同名备份 `.name.backup-<pid>-<ts>` 排在同名真目录之前，
    // 会赢下运行时注册表 —— 界面按 `.install-version` 说"已是最新"，模型读的却是
    // 旧备份内容。清掉安装器自己的同名影子（用户自建的同名条目不动，由面板的
    // 覆盖守卫负责确认）。
    await sweepInstallerOwnedShadowSkills(skillsDir, name)

    return { name, version, skillsDir, targetDir }
  } catch (cause) {
    throw cause instanceof Error ? cause : new Error(String(cause))
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    // 临时区是安装器的私有目录：本次安装没留下任何东西时顺手摘掉它（非空则
    // rmdir 失败 = 有别的 staging/orphan 在用，保持原样 —— 不做递归删除）。
    await rmdir(tempRoot).catch(() => {})
  }
}

/**
 * 清扫陈旧安装临时目录（审计 A12/A7）。
 *
 * 只删超过 `maxAgeMs`（缺省 24h）的条目，因此正在进行的安装不受影响；
 * `orphan-`（回滚失败时保留的旧内容）**永不清理**。全程 best-effort：清扫
 * 失败绝不能让安装本身失败。
 * @param skillsDir - the user skill root.
 * @param maxAgeMs - age threshold in ms.
 * @returns 清掉的目录数（诊断/测试用）。
 */
export async function sweepStaleSkillTemps(skillsDir: string, maxAgeMs: number = STALE_TEMP_MS): Promise<number> {
  const now = Date.now()
  let removed = 0
  const stale = async (path: string): Promise<boolean> => {
    const st = await lstat(path).catch(() => undefined)
    if (st === undefined) return false
    return now - st.mtimeMs >= maxAgeMs
  }
  const drop = async (path: string): Promise<void> => {
    await rm(path, { recursive: true, force: true }).then(() => { removed++ }).catch(() => {})
  }
  // 当前布局：<skills>/.skill-tmp/install-*
  const tempRoot = join(skillsDir, SKILL_TEMP_DIR)
  for (const entry of await readdir(tempRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.name.startsWith('install-')) continue
    const path = join(tempRoot, entry.name)
    if (await stale(path)) await drop(path)
  }
  // 旧布局(≤2.8.1)：staging/备份直接建在技能库根，名字形如 `.install-<name>-XXXXXX`
  // 与 `.<name>.backup-<pid>-<ts>`。旧备份的**根上就有 SKILL.md**，运行时会把整份
  // 技能重复加载（A7 实测："卸载后技能仍然可用"）⇒ 升级后第一次安装顺手清掉。
  for (const entry of await readdir(skillsDir, { withFileTypes: true }).catch(() => [])) {
    const isLegacyStaging = entry.name.startsWith('.install-')
    const isLegacyBackup = /^\..+\.backup-\d+-\d+$/u.test(entry.name)
    if (!isLegacyStaging && !isLegacyBackup) continue
    const path = join(skillsDir, entry.name)
    if (await stale(path)) await drop(path)
  }
  return removed
}

/**
 * 判断 `<skillsDir>/<name>` 里那一份东西是"能力中心装的"还是"用户自己放的"
 * （审计 A2/A3 的唯一来源判据）。
 *
 * `store` 的条件见 {@link isStoreProvenance}；任何一条不成立都按 `local`
 * （用户内容）处理 —— 宁可多问一次，不可静默覆盖/删除。
 * @param skillDir - the candidate skill directory.
 * @param name - the expected skill id (directory name).
 * @returns `'store'` / `'local'`；目标不存在时 `undefined`。
 */
export async function classifyInstalledSkill(skillDir: string, name: string): Promise<InstalledSkillOrigin | undefined> {
  try {
    await lstat(skillDir)
  } catch {
    return undefined
  }
  const prov = await readProvenance(skillDir)
  return isStoreProvenance(prov, name) ? 'store' : 'local'
}

/**
 * 溯源标记是否表示"这份内容由能力中心/平台装进来的"（分类的**唯一谓词**）。
 *
 * 三个条件必须同时成立：标记可读 + 渠道是商店来源 + appId 与目录名一致。
 * {@link classifyInstalledSkill} 与能力中心聚合面共用它，避免"两处各判一次"漂移。
 * @param prov - the provenance marker (undefined when absent).
 * @param name - the expected skill id (directory name).
 * @returns 商店来源为 true，其余（含标记缺失）为 false。
 */
export function isStoreProvenance(prov: SkillProvenance | undefined, name: string): boolean {
  return prov !== undefined && isStoreChannel(prov.channel) && prov.appId === name
}

/**
 * 本机那一份技能的内容是否**已被本地修改**（审计 R4-B-3，第四轮）。
 *
 * 判据只有一条：上次写内容时记下的 `archiveChecksum`（{@link computeSkillContentHash}
 * 的内容树哈希）与**现在重算**的值不同。这是"用户动过这份内容"的唯一可验证证据 ——
 * 面板据此渲染「已本地修改」徽章，覆盖/删除据此决定要不要先问一声。
 *
 * **dirty 的语义 = "用户改过内容"**（N1b，独立复审 R5-B-4 收窄）：平台自己管理的
 * frontmatter 字段（当前只有「技能管理」禁用开关写的 `disable-model-invocation`，
 * 见 {@link DISABLE_MODEL_KEY} / {@link normalizeSkillManifestBytes}）**不参与**这个
 * 哈希 —— 否则用户点一次「禁用」就会被判成"改了内容"（徽章误导 + 此后每次更新/卸载
 * 都多一张确认条）。用户真的改了正文/加了文件，照样判脏（判据不因此变松）。
 *
 * **基准的两个写者**（缺任一个就有来源整块落在判据外）：
 *  - 本安装器：{@link writeProvenance} 在装完/覆盖完写 `archiveChecksum`；
 *  - 随包插件同步器（`packages/vendor/memory-evolve/lib/coi/skills-sync.js`，独立复审
 *    N1）：首次安装 / 随包升版换入 / 内容同一性采纳之后都写一份 `channel: 'plugin'`
 *    的标记，**含 `archiveChecksum`**（取值 = 它自己那份 `skillContentChecksum`，
 *    与本文件的 {@link computeSkillContentHash} 逐字节同源；跨包 import 禁止，所以是
 *    "各自实现 + 机器对拍"，对拍用例见 `tests/skill-channel-parity.spec.ts`）。
 *    在此之前的随包溯源刻意不写基准，于是随包技能**结构性不判脏**（面板没有徽章），
 *    而它是唯一不需要用户动作就会覆盖内容的写者 ⇒ 用户改过的随包技能在下次升版时被
 *    静默整树换掉。同步侧的同一条闸门：基准对不上就 `refused` + `SKILL_LOCAL_CONTENT`，
 *    绝不整树换入。
 *
 * 三个边界（都取"宁可少判脏"）：
 *  - 没有溯源标记、或标记里没有 `archiveChecksum` ⇒ `false`。没有基准就没有可比
 *    事实，凭空判脏会让每次更新都多出一张确认条。**这一档只应出现在本闸门之前
 *    落下的随包目录上**（同步器下一次开机在"内容与随包逐字相同"时补写基准；内容
 *    已经不同时它无从证明、只能照旧换入并打日志 —— 那一窗口的认账口径写在
 *    `skills-sync.js` 的模块头注释里）；
 *  - 目标目录不存在 / 读不出来 ⇒ `false`（调用方在此之前已用
 *    {@link classifyInstalledSkill} 判过"有没有"）；
 *  - 哈希计算抛错（权限/IO）⇒ `false`（保守：不因为算不出来就拦下正常更新）。
 *
 * **唯一实现**：安装器（{@link requiresOverwriteConfirmation} / {@link uninstallSkill}）
 * 与能力中心聚合面（`auth-gate` 的 `?source=local` 与 enriched 两个分支）都调它 ——
 * 三处各算一次是这条 finding 的温床（面板会显示徽章而宿主放行覆盖）；
 * 随包同步侧的同一条判据是它在本包的镜像（本地副本，见上）。
 *
 * @param skillDir - 目标技能目录。
 * @param prov - 该目录的 provenance（已读出的那一份，避免重复 IO）。
 * @returns 内容与上次写下的基准不一致为 true。
 */
export async function isInstalledSkillDirty(
  skillDir: string,
  prov: SkillProvenance | undefined,
): Promise<boolean> {
  if (prov?.archiveChecksum === undefined) return false
  const now = await computeSkillContentHash(skillDir).catch(() => undefined)
  return now !== undefined && now !== prov.archiveChecksum
}

/**
 * 覆盖/删除一个**已存在**的同名技能目录时，是否必须由用户显式确认
 * （审计 W4 P1-2 + 第四轮 R4-B-3，2026-09-23）。
 *
 * 判据把"来源"拆成三件不同的事（此前混在一起 ⇒ 静默覆盖 + 归属错 + 吃掉本地改动）：
 *  - {@link isStoreProvenance} 回答"这份内容是不是用户手写的"（决定卸载/更新要不要
 *    当成用户数据对待）；
 *  - **本函数还要问"这份内容被改过没有"**（{@link isInstalledSkillDirty}，R4-B-3）：
 *    商店装来的技能被用户改过之后，它**同时**是"商店来源"和"里面装着用户的字节"。
 *    只看来源就会放行整树替换 ⇒ 一次单击「更新」把用户加的文件与改过的正文全删掉，
 *    而面板上还挂着「已本地修改」徽章（有徽章、无后果提示）。用户内容不得静默替换 ——
 *    与"本机自制"同档，必须先确认；
 *  - 以及"这次覆盖会不会**换渠道**"：目标是商店来源、但渠道与本次安装的渠道不同
 *    （market ↔ org ↔ builtin ↔ plugin）时，整树替换会把这份技能从一条渠道搬到另一条：
 *    内容来源变了、而调用方按"商店来源 ⇒ 直接更新"放行，用户零感知。实测（W4 probe10）：
 *    市场安装无确认覆盖随包插件技能 → 下次开机插件同步又换回插件版（插件侧现在也会
 *    拒收，见 `skills-sync.js` 的来源闸门），两边互相覆盖。
 *
 * 因此：目标不存在 → 不需要确认；用户自制 / 已本地修改 / 换渠道 → 需要确认；
 * 商店来源 + 渠道相同 + 内容未被改过 → 正常更新（安装器自己的升级路径）。
 *
 * @param existingOrigin - {@link classifyInstalledSkill} 的结果（`undefined` = 目标不存在）。
 * @param existingChannel - 目标那一份的 provenance 渠道（仅商店来源时有值）。
 * @param incomingChannel - 本次安装写入的渠道。
 * @param existingDirty - {@link isInstalledSkillDirty} 的结果（缺省 false = 未改过）。
 * @returns 需要用户显式确认（面板确认条 / `?overwrite=1`）为 true。
 */
export function requiresOverwriteConfirmation(
  existingOrigin: InstalledSkillOrigin | undefined,
  existingChannel: string | undefined,
  incomingChannel: SkillProvenanceChannel,
  existingDirty = false,
): boolean {
  if (existingOrigin === undefined) return false
  if (requiresRemoveConfirmation(existingOrigin, existingDirty)) return true
  return existingChannel !== incomingChannel
}

/**
 * 删除（uninstall）一个**已存在**的同名技能目录时，是否必须由用户显式确认。
 *
 * 与 {@link requiresOverwriteConfirmation} 共用"用户内容"的那一半判据
 * （本机自制 或 已本地修改）—— 删除比覆盖更不可逆，判据不该比覆盖更松。**不是
 * 第二套口径**：这里调的就是同一个函数，调用点不该自己再写一遍 `origin === 'local'`。
 *
 * @param existingOrigin - {@link classifyInstalledSkill} 的结果（`undefined` = 目标不存在）。
 * @param existingDirty - {@link isInstalledSkillDirty} 的结果（缺省 false = 未改过）。
 * @returns 需要用户显式确认（`?overwrite=1`）为 true。
 */
export function requiresRemoveConfirmation(
  existingOrigin: InstalledSkillOrigin | undefined,
  existingDirty = false,
): boolean {
  if (existingOrigin === undefined) return false
  return existingOrigin === 'local' || existingDirty
}

/**
 * 覆盖被拒时的用户可读原因（三种成因共用 `LOCAL_CONTENT` 这一个拒绝码：
 * 面板对 409 的处理是同一条确认条，见 `CapabilityCenterPanel` 的 `performInstall`）。
 * @param name - the skill id.
 * @param existingOrigin - 目标那一份的来源分类。
 * @param existingChannel - 目标那一份的 provenance 渠道。
 * @param incomingChannel - 本次安装写入的渠道。
 * @param existingDirty - 目标那一份是否被本地修改过（R4-B-3）。
 * @returns 英文（对外文案语言与其它拒绝一致）说明。
 */
function describeOverwriteRefusal(
  name: string,
  existingOrigin: InstalledSkillOrigin,
  existingChannel: string | undefined,
  incomingChannel: SkillProvenanceChannel,
  existingDirty: boolean,
): string {
  if (existingDirty && existingOrigin === 'store' && existingChannel === incomingChannel) {
    // R4-B-3：这一条必须点明"你改过的东西会丢" —— 用户看到的徽章是「已本地修改」，
    // 拒绝文案却只说"已存在同名内容"的话，等于让他自己猜后果。
    return `the "${String(existingChannel)}" skill "${name}" has local modifications; installing the `
      + `${JSON.stringify(incomingChannel)} version replaces the whole directory and discards your changes `
      + '— confirm the overwrite to continue'
  }
  if (existingOrigin === 'local') {
    return `a skill named "${name}" already exists locally but was not installed by the Capability Hub; `
      + 'installing would replace it (including your own files) — confirm the overwrite to continue'
  }
  return `a skill named "${name}" is installed from the "${String(existingChannel)}" channel; installing the `
    + `"${incomingChannel}" version would move it to another channel and replace its content — `
    + 'confirm the overwrite to continue'
}

/** 本机那一份技能/智能体的来源：商店（能力中心装的）或本机自制。 */
export type InstalledSkillOrigin = 'store' | 'local'

/**
 * 复核最终 SKILL.md 的 frontmatter 是否能被运行时加载（审计 A1）。
 *
 * 上游 `skill-filesystem` 的判据逐条对齐：frontmatter 必须是合法 YAML 映射、
 * `name`/`description` 必填、`name` 必须匹配运行时正则。额外加一条**一致性**：
 * `name` 必须等于技能 ID（目录名），否则能力中心的"已装/卸载/遥测"全按目录名
 * 记账，而模型侧看到的是另一个名字（`@` 谁都不对）。
 *
 * 审计 R13-B P1-1（第三关）：invocation 布尔也要复核。上游
 * `frontmatterBoolean` 对"键存在但取值不是合法布尔字面量"（含 YAML 空值 /
 * `null` / `~` / 空串 / `' true '` 这类带空白的字符串）**直接 throw**，调用方
 * catch 后把**整份技能丢弃** —— 只在发布前预检拦是不够的：市场上已经存在的
 * 存量技能、或绕过预检的归档，装到这里时同样必须被拒，否则能力中心显示
 * "已安装"而模型永远加载不到（这正是 A1 要消灭的形态）。
 * @param dir - the unpacked skill directory.
 * @param name - the skill id being installed.
 * @throws ArchiveInstallRefusal with a user-readable reason.
 */
export async function assertLoadableSkillMetadata(dir: string, name: string): Promise<void> {
  const meta = await readSkillFrontmatter(join(dir, 'SKILL.md'))
  const fmName = metaString(meta.name)
  const fmDescription = metaString(meta.description)
  if (fmName === undefined || fmDescription === undefined) {
    throw new ArchiveInstallRefusal(
      'FRONTMATTER_INVALID',
      'SKILL.md must carry YAML frontmatter with a non-empty name and description; '
      + 'without them the runtime ignores the skill (it would install but never load)',
    )
  }
  if (!isLoadableSkillName(fmName)) {
    throw new ArchiveInstallRefusal(
      'NAME_INVALID',
      `SKILL.md name ${JSON.stringify(fmName)} is not a loadable skill name `
      + '(lowercase kebab-case such as my-skill is required); the runtime would ignore this skill',
    )
  }
  if (fmName !== name) {
    throw new ArchiveInstallRefusal(
      'FRONTMATTER_INVALID',
      `SKILL.md name ${JSON.stringify(fmName)} must equal the skill id ${JSON.stringify(name)}`,
    )
  }
  // 取值语料与上游 `frontmatterBoolean` 逐条对齐（判定实现只有一处：
  // `manifest-precheck.ts` 的 `invocationBooleanVerdict`，本函数不再写第二份）。
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    if (!Object.hasOwn(meta, key)) continue
    const verdict = invocationBooleanVerdict(meta[key])
    if (verdict === 'ok') continue
    throw new ArchiveInstallRefusal(
      'FRONTMATTER_INVALID',
      verdict === 'empty'
        ? `SKILL.md field ${key} is present but empty; the runtime discards the entire skill, `
          + 'so it would install but never load — write true/false (or yes/no, on/off, 1/0), or remove the line'
        : `SKILL.md field ${key} must be a boolean literal (true/false, yes/no, on/off, 1/0); `
          + 'any other value makes the runtime discard the entire skill',
    )
  }
}

/** 删掉归档自带的安装器独占标记（审计 A13）。 */
async function rmInstallerOwnedMarkers(dir: string): Promise<void> {
  await rm(join(dir, PROVENANCE_DIR), { recursive: true, force: true }).catch(() => { /* 不存在即无事 */ })
  await rm(join(dir, INSTALL_VERSION_FILE), { force: true }).catch(() => { /* 不存在即无事 */ })
}

/**
 * Ensure `SKILL.md` under `dir` carries YAML frontmatter with `name`,
 * `description`, and (when known) `version` (the upstream parser ignores
 * skills without name/description; `version` lets hasUpdate compare reliably
 * against the installed copy). Reads a sibling `metadata.yaml` (gateway
 * format: `name`/`description`/`version` keys) and prepends `---`-delimited
 * frontmatter when the file has none.
 *
 * 审计 2026-09-23 A1：合成出来的 `name` **恒等于技能 ID（目录名）**。旧实现直接抄
 * `metadata.yaml` 的 `name`（任意字符串，含中文展示名），于是合成的 frontmatter
 * 让运行时判 `invalid skill name "Epsilon 技能"` 静默忽略整份技能。展示名不丢：
 * 它与技能 ID 不一致时写进 `title`。
 */
export async function synthesizeSkillFrontmatter(dir: string, fallbackName: string, version?: string): Promise<void> {
  const skillMdPath = join(dir, 'SKILL.md')
  const raw = await readFile(skillMdPath, 'utf8')
  // 已有 frontmatter 一律不动(上游/用户归档的元数据保持原样;版本由
  // 安装器写入独立标记文件 .install-version,见 installSkillArchive)。
  if (raw.trimStart().startsWith('---')) return

  let meta: { name?: unknown; description?: unknown; version?: unknown } = {}
  try {
    const metaRaw = await readFile(join(dir, 'metadata.yaml'), 'utf8')
    const parsed = parseYaml(metaRaw) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      meta = parsed as { name?: unknown; description?: unknown; version?: unknown }
    }
  } catch {
    // No (or unreadable) metadata.yaml: fall back to the archive name.
  }

  const metaName = typeof meta.name === 'string' && meta.name.trim() !== '' ? meta.name.trim() : undefined
  const name = fallbackName
  const description = typeof meta.description === 'string' && meta.description !== ''
    ? meta.description
    : `${fallbackName} skill`
  const metaVersion = typeof meta.version === 'string' && meta.version !== '' ? meta.version : undefined
  const versionValue = version ?? metaVersion
  const frontmatter = stringifyYaml({
    name,
    description,
    ...metaName === undefined || metaName === fallbackName ? {} : { title: metaName },
    ...versionValue === undefined ? {} : { version: versionValue },
  }).trimEnd()
  await writeFile(skillMdPath, `---\n${frontmatter}\n---\n${raw}`)
}

/**
 * Resolve the user skill root from the environment (product home default).
 *
 * 2026-09-11:缺省值走共享的 `dshHomeSafe()`(数据目录唯一权威) —— 数据根随渠道,
 * 自己抄一份 `~/.picoaide-harness` 会在改渠道目录时漏掉,技能就落回官方目录。
 */
export function resolveSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  // 审计 2026-08-25 P2-3:DSH_HOME 不得指向系统关键目录(同机注入面)。
  return join(dshHomeSafe({ env }), 'skills')
}

/** 上游 `skipSystem` 根里唯一被跳过的目录名（skill-filesystem 的 `roots()`）。 */
export const SKILL_SYSTEM_DIR = '.system'

/** ≤2.8.1 的安装器在技能库根写下的备份形态 `.<name>.backup-<pid>-<ts>`。 */
const LEGACY_SKILL_BACKUP_NAME = /^\..+\.backup-\d+-\d+$/u
/** 同一时期的 staging 形态 `.install-<name>-XXXXXX`。 */
const LEGACY_SKILL_STAGING_PREFIX = '.install-'

/**
 * 直接子条目名是不是**安装器自己**写下的形态（旧备份 / 旧暂存）。
 * 这类目录里可能带着一份完整技能（根上就有 SKILL.md），而运行时把它们当候选 ——
 * 于是它们能"赢下"同名真目录。属于安装器的东西可以无确认删除；用户自建的不行。
 * @param entryName - the direct child name under the skill root.
 */
export function isInstallerOwnedSkillEntry(entryName: string): boolean {
  return LEGACY_SKILL_BACKUP_NAME.test(entryName) || entryName.startsWith(LEGACY_SKILL_STAGING_PREFIX)
}

/** 运行时会发现的一份技能（判据与上游 `discoverRoot` 逐条对齐）。 */
export interface DiscoveredSkill {
  /** frontmatter 里的 `name` —— **运行时注册表用的就是它**（不是目录名）。 */
  name: string
  /** 技能库里的直接子条目名（目录名，或根上散落 `.md` 的文件名）。 */
  entryName: string
  /** SKILL.md 所在目录（根上散落 `.md` 时为技能库根）。 */
  dir: string
  /** SKILL.md 的绝对路径。 */
  skillMdPath: string
  /** 该条目是不是安装器写下的形态（见 {@link isInstallerOwnedSkillEntry}）。 */
  installerOwned: boolean
}

/**
 * 上游 `skill-filesystem/src/index.ts` 的 `parseSkillFile` 逐条对齐的元数据读取：
 * 首行必须**恰是** `---`，收尾是其后第一行**恰为** `---` 的那一行，区间内必须是
 * YAML 映射，`name`/`description` 必须是非空**字符串**。
 *
 * 不复用 {@link readSkillFrontmatter}：那个是"展示用"的宽松解析（收尾正则只要
 * 出现 `\n---` 即可），宽松方向会让"我们说已安装、运行时其实不加载"复活。
 * @param skillMdPath - path to the candidate SKILL.md.
 */
async function readRuntimeSkillMetadata(skillMdPath: string): Promise<{ name: string, description: string } | undefined> {
  let raw: string
  try {
    raw = await readFile(skillMdPath, 'utf8')
  } catch {
    return undefined
  }
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/u, '') !== '---') return undefined
  let front: string | undefined
  let lineStart = firstLineEnd + 1
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/u, '') === '---') {
      front = raw.slice(firstLineEnd + 1, lineStart)
      break
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  if (front === undefined) return undefined
  let parsed: unknown
  try {
    parsed = parseYaml(front)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const meta = parsed as Record<string, unknown>
  const name = typeof meta.name === 'string' && meta.name.length > 0 ? meta.name : undefined
  const description = typeof meta.description === 'string' && meta.description.length > 0 ? meta.description : undefined
  if (name === undefined || description === undefined) return undefined
  return { name, description }
}

/**
 * 运行时**真正会加载**的技能集合（审计 R13-B P1-2 的唯一判据）。
 *
 * 与上游 `discoverRoot` 逐条对齐（本地真跑 pinned 注册表实测过）：
 *  - 只看技能库的**直接子条目**；目录取 `<dir>/SKILL.md`，根上散落的 `.md` 文件
 *    本身就是候选；
 *  - 只跳过名字恰为 {@link SKILL_SYSTEM_DIR} 的那一个（**其他点号目录照样发现**
 *    —— 这正是 `.alpha.backup-<pid>-<ts>` 能挤掉真目录的原因）；
 *  - 技能名取自 **frontmatter**，不是目录名；名字必须匹配运行时的 kebab 正则；
 *  - 按条目名 `localeCompare` 升序，同名先到先得（调用方按顺序取第一份即"赢家"）。
 *
 * 旧实现只认「非点号目录 + 目录名 kebab + 有 SKILL.md」，于是与运行时是两个集合：
 * 差集里的技能"卸载成功而模型照旧能用"、界面按真目录说"已是最新"而模型读的是
 * 旧备份内容。
 * @param skillsDir - the user skill root (e.g. `<dshHome>/skills`).
 * @param options - `skipSystem: false` = 这个根**不**跳过 `.system`（上游只给 `user-dsh`
 *   根设 `skipSystem`；agent/bundled 根里的 `.system` 照样是候选 —— R13-GH3 跨根收口
 *   必须逐根同判据，不能拿一个根的口径去扫另一个根）。
 * @returns discovered skills in runtime precedence order; unreadable root = 空。
 */
export async function discoverRuntimeSkills(skillsDir: string, options: { skipSystem?: boolean } = {}): Promise<DiscoveredSkill[]> {
  const skipSystem = options.skipSystem ?? true
  let entries
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const rows: DiscoveredSkill[] = []
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (skipSystem && entry.name === SKILL_SYSTEM_DIR) continue
    const isDir = entry.isDirectory()
    const isLooseMarkdown = entry.isFile() && entry.name.endsWith('.md')
    if (!isDir && !isLooseMarkdown) continue
    const dir = isDir ? join(skillsDir, entry.name) : skillsDir
    const skillMdPath = isDir ? join(dir, 'SKILL.md') : join(skillsDir, entry.name)
    const meta = await readRuntimeSkillMetadata(skillMdPath)
    if (meta === undefined) continue
    // 只认运行时的 kebab 正则（长度上限是**写侧**规则：我们从不装超长名字，
    // 但用户手放的超长名字运行时确实会加载 ⇒ 这里必须如实列出，否则又成差集）。
    if (!SKILL_NAME_PATTERN.test(meta.name)) continue
    rows.push({
      name: meta.name,
      entryName: entry.name,
      dir,
      skillMdPath,
      installerOwned: isInstallerOwnedSkillEntry(entry.name),
    })
  }
  return rows
}

/**
 * List installed skills: **the names the runtime actually loads**.
 *
 * 审计 R13-B P1-2：判据收敛到与运行时同一来源（{@link discoverRuntimeSkills}）——
 * 按 frontmatter 名 + 全部直接子条目，而不是"非点号目录 + 目录名 kebab"。否则
 * 差集里的技能在上游赢下注册表（模型读到旧备份内容）而界面说"已是最新"、
 * `uninstallSkill` 返回成功却仍可加载 —— 与 A7 声称已消灭的症状同形。
 * @param skillsDir - the user skill root (e.g. `<dshHome>/skills`).
 * @returns 去重后的技能名（= 运行时注册表的键），排序。
 */
export async function listInstalledSkills(skillsDir: string): Promise<string[]> {
  const rows = await discoverRuntimeSkills(skillsDir)
  return [...new Set(rows.map(row => row.name))].sort((a, b) => a.localeCompare(b))
}

/**
 * 同名**影子**：`<skillsDir>` 下所有"运行时会当作 `name` 加载、但不是规范落点
 * `<skillsDir>/<name>` 那一份"的条目（旧备份、旧暂存、根上散落的 `<name>.md`、
 * 目录名非 kebab 但 frontmatter 名合法的自建目录…）。
 *
 * 它们的存在意味着"删掉规范落点"不等于"运行时不再加载这个技能"。
 * @param skillsDir - the user skill root.
 * @param name - the skill name (frontmatter name).
 * @returns 影子条目（运行时顺序），没有则空数组。
 */
export async function listShadowingSkills(skillsDir: string, name: string): Promise<DiscoveredSkill[]> {
  const canonical = join(skillsDir, name)
  return (await discoverRuntimeSkills(skillsDir))
    .filter(row => row.name === name && !(row.entryName === name && row.dir === canonical))
}

/**
 * 删除**一个**「安装器所有」的影子条目的**唯一删除点**（R14 C-01 根守卫）。
 *
 * 为什么不能直接 `rm(shadow.dir, {recursive: true})`：{@link discoverRuntimeSkills} 忠实
 * 镜像上游 `discoverRoot` —— 技能库**根上散落的 `*.md` 文件**也是候选技能，而它的
 * `dir` 就是**技能库根本身**（那里正是它的 SKILL.md 所在）。{@link isInstallerOwnedSkillEntry}
 * 只看名字前缀，于是名为 `.install-*.md` 的散落文件会让 `rm(dir)` 变成
 * `rm -rf <skillsDir>`：**静默删掉整个技能库**（正在卸载的那个技能、刚装好的那个、
 * 以及用户自建的每一份都不见了），而 `uninstallSkill()` 还返回成功。
 *
 * 删除面因此收敛成一条可判定的规则（三种形态，只有中间一种允许递归删除）：
 *  - `dir` 严格等于技能库根 ⇒ 散落文件形态：**只删那个文件**，绝不碰根；
 *  - `dir` 是技能库根的直接子目录 ⇒ 旧 staging / 旧备份就是这个形态：允许递归删除；
 *  - 其它（更深的路径、根之外的路径）⇒ 不是本函数认识的形态：**不删**（宁可留下，
 *    也不让一个来历不明的路径成为 `rm -rf` 的目标）。
 * @param skillsDir - the user skill root.
 * @param shadow - 一个 `installerOwned === true` 的影子条目。
 * @returns 真的删掉了返回 `true`（删的是文件或那个直接子目录）。
 */
async function removeInstallerOwnedShadow(skillsDir: string, shadow: DiscoveredSkill): Promise<boolean> {
  const root = resolve(skillsDir)
  const dir = resolve(shadow.dir)
  if (dir === root) {
    return await rm(shadow.skillMdPath, { force: true }).then(() => true).catch(() => false)
  }
  if (dirname(dir) !== root) return false
  return await rm(dir, { recursive: true, force: true }).then(() => true).catch(() => false)
}

/**
 * 清掉同名影子里**属于安装器**的那些（旧备份 / 旧暂存）。
 *
 * 运行时的同名先到先得按 `localeCompare` 排序，而 `.` 开头的备份恰好排在同名真
 * 目录之前 ⇒ 它会赢下注册表。安装/卸载都必须先把它清掉，否则"装好了"与"卸载了"
 * 都只是界面上的说法。
 *
 * **用户自建的同名条目一律不动**（那是用户内容，删除要显式确认）——调用方用
 * {@link listShadowingSkills} 如实报告残留。
 *
 * **删除一律经 {@link removeInstallerOwnedShadow} 的根守卫**（R14 C-01）：根上散落的
 * `.install-*.md` 文件其 `dir` 就是技能库根，直接递归删除会连库一起删。
 * @param skillsDir - the user skill root.
 * @param name - the skill name.
 * @returns 删掉的 SKILL.md 路径（诊断/测试用）。
 */
export async function sweepInstallerOwnedShadowSkills(skillsDir: string, name: string): Promise<string[]> {
  const removed: string[] = []
  for (const shadow of await listShadowingSkills(skillsDir, name)) {
    if (!shadow.installerOwned) continue
    if (await removeInstallerOwnedShadow(skillsDir, shadow)) removed.push(shadow.skillMdPath)
  }
  return removed
}

/** 运行时多根发现的一行：哪个根里的哪一条被当成了 `name`。 */
export interface RuntimeSkillResidue {
  /** 发现根（含 source/rank/managed，供报告"是哪一种根"）。 */
  readonly root: RuntimeSkillRoot
  /** 该根里被运行时当作 `name` 加载的条目（SKILL.md 所在目录 / 根上散落的 .md）。 */
  readonly skill: DiscoveredSkill
}

/**
 * 按**运行时同一判据**在**全部已知根**里查同名技能（R13-GH3 · H2「跨根」）。
 *
 * 为什么不能只看一个根：运行时发现面是多根合并（见 {@link runtimeSkillRoots} 的模块头），
 * 而能力中心只拥有 `<dshHome>/skills`。同一个名字若还在别的根里（最常见的是
 * `<agentsHome>/skills`），"卸载成功"就只是界面上的说法 —— 模型照旧读得到。
 *
 * 合并口径与上游注册表一致：**rank 小的赢**，同 rank 按传入顺序；每个根内部按
 * {@link discoverRuntimeSkills} 的顺序（条目名 `localeCompare` 升序）先到先得。
 * 因此返回的行直接就是"这些根里会被加载的那个名字来自哪里"（第一名 = 赢家）。
 * @param roots - the runtime discovery roots (see {@link runtimeSkillRoots}).
 * @param name - the skill name (frontmatter name); 省略 = 列出全部同名合并结果。
 * @returns 每个被加载的名字对应的一行（同名只留赢家），按运行时优先级排序。
 */
export async function discoverRuntimeSkillsAcrossRoots(
  roots: readonly RuntimeSkillRoot[],
  name?: string,
): Promise<RuntimeSkillResidue[]> {
  const ordered = [...roots].sort((a, b) => a.rank - b.rank)
  const winners = new Map<string, RuntimeSkillResidue>()
  for (const root of ordered) {
    // 逐根用**同一个**判据扫（skipSystem 也逐根取上游的值，不拿一个根的口径套全部）。
    for (const skill of await discoverRuntimeSkills(root.path, { skipSystem: root.skipSystem })) {
      if (name !== undefined && skill.name !== name) continue
      if (winners.has(skill.name)) continue // rank 小的先到先得 = 上游的赢家
      winners.set(skill.name, { root, skill })
    }
  }
  return [...winners.values()]
}

/**
 * 「卸载后运行时仍会加载这个名字」的**跨根残留**：全部已知根里，除了我正在管的
 * 那一个根以外，还有哪些根里有同名技能。
 *
 * 判据与"运行时会加载什么"同一份实现（{@link discoverRuntimeSkills}）：根里的条目
 * 是不是候选、frontmatter 名是什么、点号目录算不算、`.system` 跳不跳，全部按上游
 * `discoverRoot` 的口径 —— 不是"目录名 == 技能名"的近似。
 * @param roots - the runtime discovery roots (see {@link runtimeSkillRoots}).
 * @param managedSkillsDir - 我能管的那个根（`<dshHome>/skills`）；它自己由调用方单独处理。
 * @param name - the skill name (frontmatter name).
 * @returns 残留（按运行时优先级；空数组 = 没有跨根残留）。
 */
export async function listCrossRootSkillResidues(
  roots: readonly RuntimeSkillRoot[],
  managedSkillsDir: string,
  name: string,
): Promise<RuntimeSkillResidue[]> {
  const foreign = roots.filter(root => !isSameSkillRoot(root.path, managedSkillsDir))
  const rows = await discoverRuntimeSkillsAcrossRoots(foreign, name)
  return rows.filter(row => row.skill.name === name)
}

/**
 * Uninstall one skill: remove `<skillsDir>/<name>` after verifying it really
 * is an installed skill (valid name + SKILL.md present). Everything else is
 * refused, so this API can never delete an arbitrary directory.
 *
 * 审计 2026-09-23 A3：**来源感知** —— 目标目录里的那一份若不是能力中心装的
 * （没有溯源标记 / 渠道不是商店来源 / appId 对不上），视为用户自制内容，
 * 没有 `overwrite` 显式确认一律拒绝（409 `LOCAL_CONTENT`）。旧实现的判据只有
 * "名字合法 + 有 SKILL.md"，于是市场里存在同名条目时，**用户在技能库里手写的
 * 同名技能（连同笔记/脚本）被一键删除**。
 *
 * 第四轮 R4-B-3：判据扩到"**被本地修改过的商店内容**"——删除比覆盖更不可逆，
 * 不能放过"装来的是商店版、但里面已经有用户改过的正文/自加的文件"这一形态。
 * 与 {@link requiresOverwriteConfirmation} 共用同一次内容哈希（{@link isInstalledSkillDirty}），
 * 不是第二套口径。
 *
 * 第四轮 R4-B-4：删掉的若是 `channel === 'plugin'` 的随包技能，成功之后写一个
 * **墓碑**（{@link SKILL_REMOVED_DIR}），否则下一次开机同步看到落点不存在就走
 * "首次安装"路径原样装回 —— 用户视角是"卸载后重启，技能又回来了"。
 *
 * R13-GH3（H2 跨根）：成功语义扩到**跨根**——不是"本根删掉了"，而是"**运行时再列一次
 * 看不到它**"（上游发现面是多根合并，见 {@link runtimeSkillRoots}）。别的根里还有
 * 同名技能 ⇒ 抛 `RESIDUE`，不返回成功。
 * @param skillsDir - the user skill root (e.g. `<dshHome>/skills`).
 * @param name - the skill directory name (single safe segment).
 * @param options - `overwrite: true` = 用户已确认删除本机内容；`runtimeRoots` 覆盖运行时
 *   根表（测试 seam；生产走 `runtimeSkillRoots({ skillsDir })`，即 pinned 上游
 *   `roots()` 的用户/agent/bundled 三个根），`env` 是同一推导用的环境 seam。
 * @returns the removed directory path.
 * @throws Error when the name is invalid, the skill is not installed, local content needs
 *   confirmation, or the runtime would still load it (单根影子 / 跨根残留都报 `RESIDUE`).
 */
export async function uninstallSkill(
  skillsDir: string,
  name: string,
  options: { overwrite?: boolean | undefined, runtimeRoots?: readonly RuntimeSkillRoot[] | undefined, env?: Record<string, string | undefined> | undefined } = {},
): Promise<string> {
  validateSkillName(name)
  return await withSkillLock(skillsDir, name, async () => {
    const target = join(skillsDir, name)
    try {
      await stat(join(target, 'SKILL.md'))
    } catch {
      throw new ArchiveInstallRefusal('NOT_INSTALLED', `skill "${name}" is not installed`)
    }
    const prov = await readProvenance(target)
    const origin = isStoreProvenance(prov, name) ? 'store' : 'local'
    const dirty = await isInstalledSkillDirty(target, prov)
    if (options.overwrite !== true && requiresRemoveConfirmation(origin, dirty)) {
      throw new ArchiveInstallRefusal(
        'LOCAL_CONTENT',
        origin === 'local'
          ? `the skill directory "${name}" was not installed by the Capability Hub; `
            + 'deleting it removes your own files — confirm the deletion to continue'
          : `the skill "${name}" has local modifications; deleting it discards your changes `
            + '— confirm the deletion to continue',
      )
    }
    await rm(target, { recursive: true, force: true })
    // 只有**随包**（plugin）技能需要墓碑：它是唯一会在下次开机被同步装回来的来源
    // （market/org/builtin 没有自动重装路径 —— 给它们也写墓碑只会留下永久的陈旧
    // 记录，还会在用户日后重新安装同名技能时干扰判断）。写失败不致命：最坏情况
    // 退回升级前的行为（下次开机会装回来），而删除本身已经成功。
    if (prov?.channel === 'plugin') await writeSkillTombstone(skillsDir, name, prov)

    // R13-B P1-2：**"卸载成功"必须等于"运行时不再加载"**。删掉规范落点之后：
    //  1. 先清掉安装器自己的同名影子（旧备份/旧暂存 —— 它们排在同名真目录之前，
    //     会赢下运行时注册表：界面显示已卸载、模型照旧读得到旧内容）；
    //  2. 再复核运行时集合。**用户自建**的同名条目（目录名非 kebab 的自建目录、
    //     根上散落的 `<name>.md`…）一律不删（那是用户内容），而是如实报成残留 ——
    //     绝不返回成功却不生效。
    await sweepInstallerOwnedShadowSkills(skillsDir, name)
    const residue = await listShadowingSkills(skillsDir, name)
    if (residue.length > 0) {
      throw new ArchiveInstallRefusal(
        'RESIDUE',
        `skill "${name}" was removed from its install location, but ${residue.length} other copy/copies `
        + `in the skill root still make the runtime load "${name}": `
        + `${residue.map(row => `"${row.entryName}"`).join(', ')} — `
        + 'rename or delete them (they are your own files, so the Capability Hub will not touch them) '
        + `and the skill will really be gone`,
      )
    }

    // R13-GH3（H2 跨根）：运行时发现面是**多根合并**（上游 `skill-filesystem` 的
    // `roots()`：project → custom → `<dshHome>/skills` → `<agentsHome>/skills` →
    // bundled），而能力中心只拥有 `<dshHome>/skills`。所以"把本根清干净"**不等于**
    // "运行时不再加载"：同名技能还在 `<agentsHome>/skills`（默认
    // `$DSH_AGENTS_HOME` 或 `~/.agents`）时，V13-B 的边界探针实测
    // `uninstallSkill` 返回成功、`listInstalledSkills` = []，而 pinned 上游注册表
    // 照旧加载它（`runtime = [["alpha","FROM-AGENTS-ROOT"]]`）。
    //
    // 判据口径（任务给出的 (a) 方案）：按**运行时同一判据**在**全部已知根**里查同名；
    // 不属于自己能管的根 ⇒ 抛 `RESIDUE`（列条目名 + 根 + 指引），**绝不返回成功**。
    // 根表是单一真源（`skill-runtime-roots.ts`，由 pinned 上游 `roots()` 派生，
    // 行为探针 `tests/skill-runtime-roots.spec.ts` 守住漂移）。
    const roots = options.runtimeRoots ?? runtimeSkillRoots({ skillsDir, env: options.env })
    const foreign = await listCrossRootSkillResidues(roots, skillsDir, name)
    if (foreign.length > 0) {
      const where = foreign
        .map(row => `"${row.skill.entryName}" in ${row.root.path} (${row.root.source})`)
        .join(', ')
      throw new ArchiveInstallRefusal(
        'RESIDUE',
        `skill "${name}" was removed from the Capability Hub skill root, but the runtime still loads it `
        + `from ${foreign.length} other discovery root(s): ${where} — `
        + 'those roots are not managed by the Capability Hub (they belong to the agent/project/bundled '
        + `skill roots), so the skill is NOT uninstalled: rename or delete that copy there `
        + `(or point $DSH_AGENTS_HOME elsewhere) and it will really be gone`,
      )
    }
    return target
  })
}

/**
 * 写"用户显式卸载过这个随包技能"的墓碑（R4-B-4）。
 *
 * 落点/判据见 {@link SKILL_REMOVED_DIR}；由 {@link uninstallSkill} 在删除成功之后
 * 调用，随包同步器（`dsh-memory-evolve` 的 `skills-sync.js`）读它并跳过该技能。
 * 写入是 best-effort（`catch` 吞掉）：墓碑丢了最坏退回升级前的行为，不该让
 * "已经删掉的技能"报成失败。
 *
 * @param skillsDir - the user skill root.
 * @param name - the skill id.
 * @param prov - 被删那一份的 provenance（版本等事实记进墓碑，便于排障）。
 * @returns 墓碑文件的绝对路径（写失败也返回——调用方据此打日志）。
 */
export async function writeSkillTombstone(
  skillsDir: string,
  name: string,
  prov?: SkillProvenance | undefined,
): Promise<string> {
  const dir = join(skillsDir, SKILL_REMOVED_DIR)
  const file = join(dir, `${name}.json`)
  const info = {
    appId: name,
    channel: 'plugin',
    ...prov?.version === undefined || prov.version === '' ? {} : { version: prov.version },
    removedAt: new Date().toISOString(),
  }
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => { /* 非致命 */ })
  await writeFile(file, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 }).catch(() => { /* 非致命 */ })
  return file
}

/**
 * 清除墓碑（用户重新安装了这个技能 ⇒ 之前"我卸载过它"的选择到此为止）。
 *
 * 只在安装**成功之后**调用（见 `runInstallSkillArchive`）；失败路径不动墓碑 ——
 * 用户的卸载选择不该被一次失败的安装抹掉。删不掉只忽略：陈旧墓碑会让下一次
 * 随包同步继续跳过该技能，而技能已经在盘上（同步侧只在落点不存在时才需要它）
 * —— 影响面是"随包升版不会自动更新它"，由下一次安装/卸载自然收敛。
 *
 * @param skillsDir - the user skill root.
 * @param name - the skill id.
 * @returns 目标墓碑路径（**幂等**：本来就没有墓碑也返回同一个路径 —— 调用方据此
 *   知道"这个技能的墓碑现在不在盘上了"）；`rm` 抛错时为 undefined（best-effort）。
 */
export async function clearSkillTombstone(skillsDir: string, name: string): Promise<string | undefined> {
  const file = join(skillsDir, SKILL_REMOVED_DIR, `${name}.json`)
  try {
    await rm(file, { force: true })
    return file
  } catch {
    return undefined
  }
}

/** 安装器写入的溯源目录名(服务端拒绝归档自带同名目录)。 */
export const PROVENANCE_DIR = '.picoaide'

/**
 * 「技能管理」禁用开关写进 SKILL.md frontmatter 的字段名（N1b，跨端同值契约）：
 * 写入端是 vendored 插件的 `lib/skills-manager.js`（经 `lib/skill-manifest.js`
 * 的 `DISABLE_MODEL_KEY`），本包只在**内容哈希**里把它剔除
 * （{@link normalizeSkillManifestBytes}）—— 平台自己的元数据不得被判成"用户改了内容"。
 * 两侧同值由 `tests/skill-channel-parity.spec.ts` 对拍。
 */
export const DISABLE_MODEL_KEY = 'disable-model-invocation'

/** 该字段的整行匹配（与 vendored `lib/skill-manifest.js` 逐字相同）。 */
const DISABLE_MODEL_KEY_LINE = /^\s*disable-model-invocation\s*:.*$/m

/**
 * 分发渠道（跨泳道契约 S2 ↔ S1 写死）：
 *  - `market` 市场（服务端 marketplace 表）
 *  - `org` 组织共享库（shared-skills）
 *  - `builtin` 平台内置（随服务端镜像发布，客户端按需安装）
 *  - `plugin` **随客户端内置**（随包插件开机同步进技能库的技能，如 dsh-memory-evolve）
 *
 * 这四个是"商店来源"：内容由平台/客户端写成，覆盖与删除都不需要额外确认。
 * 任何其它取值（含读不出来的）都按"用户自制"处理。
 */
export type SkillProvenanceChannel = 'market' | 'org' | 'builtin' | 'plugin'

/**
 * 商店来源渠道（判据："这份内容不是用户手写的"）。
 *
 * ⚠️ 这个集合**只**回答"是不是用户内容"（卸载/更新按它决定要不要当用户数据对待）。
 * 它**不**表示"可以直接被另一条渠道覆盖" —— 覆盖时的渠道互斥由
 * {@link requiresOverwriteConfirmation} 单独判定（审计 W4 P1-2：此前把 `plugin`
 * 放进这个集合就顺带获得了"无需确认即可被市场覆盖"的待遇，于是市场安装静默吃掉
 * 随包插件技能、内容与徽章归属错位）。
 */
export const STORE_PROVENANCE_CHANNELS: readonly SkillProvenanceChannel[] = ['market', 'org', 'builtin', 'plugin']

/** 渠道是否属于商店来源（类型收窄）。 */
export function isStoreChannel(channel: unknown): channel is SkillProvenanceChannel {
  return typeof channel === 'string' && (STORE_PROVENANCE_CHANNELS as readonly string[]).includes(channel)
}

/** 安装来源溯源:客户端据此判断「这份技能是市场上的哪个应用的哪个版本」。 */
export interface SkillProvenance {
  /** 市场/组织库中的应用 ID(= 技能目录名 = frontmatter name)。 */
  appId: string
  /** 安装时的版本号。 */
  version: string
  /** 分发渠道(见 {@link SkillProvenanceChannel})；未知取值原样保留并按"非商店来源"处理。 */
  channel: SkillProvenanceChannel | (string & {})
  /** 来源服务端(多环境时区分)。 */
  server?: string | undefined
  /** 安装时归档的 sha256(本地改动检测的基准)。 */
  archiveChecksum?: string | undefined
  /** 安装时间(ISO)。 */
  installedAt: string
}

/**
 * Write the provenance marker into an installed skill directory.
 * 取代旧的 `.install-version` 单值文件:除版本外还记录应用 ID、渠道、
 * 来源服务端与归档校验和,使客户端能可靠回答「装的是市场哪个技能」。
 */
export async function writeProvenance(skillDir: string, info: SkillProvenance): Promise<void> {
  const dir = join(skillDir, PROVENANCE_DIR)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, 'release.json'), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Read the provenance marker; undefined when absent or unreadable.
 *
 * 未知渠道**不再回落成 `market`**（跨泳道契约 S2）：回落会把"我们不知道这是哪
 * 来的"伪装成"这是市场装的"，进而在覆盖/删除判定里被当成商店内容（正是审计
 * A2/A3 的数据丢失面）。现在未知渠道原样返回字符串（`channel` 之外的类型仍按
 * 原文透出，由 {@link isStoreChannel} 判定为非商店来源）。
 */
export async function readProvenance(skillDir: string): Promise<SkillProvenance | undefined> {
  try {
    // 类型 + 体积闸门（独立复审 r3 F2 同族）：`.picoaide/release.json` 可能是 FIFO /
    // 目录 / 符号链接 / 超大文件 —— 直接 `readFile` 会永久阻塞（FIFO）或整份读进内存。
    // 这里与同步侧 `skills-sync.js` 的 `readSmallRegularFile` 同一份判据：不是"小普通
    // 文件"就按"读不出来"处理 ⇒ 该份内容按用户自制对待（fail-safe 方向：宁可多要
    // 一次覆盖确认，也不把 FIFO 当来源标记）。
    const raw = await readSmallRegularFile(join(skillDir, PROVENANCE_DIR, 'release.json'))
    if (raw === undefined) return undefined
    const parsed = JSON.parse(raw) as Partial<SkillProvenance>
    if (typeof parsed.appId !== 'string' || typeof parsed.version !== 'string') return undefined
    return {
      appId: parsed.appId,
      version: parsed.version,
      // 'plugin'（随客户端内置）必须原样保留 —— 回落成 'market' 会让面板显示错的
      // 来源徽章，也会把"随包内容"与"市场内容"混为一谈。
      channel: typeof parsed.channel === 'string' ? parsed.channel : '',
      server: typeof parsed.server === 'string' ? parsed.server : undefined,
      archiveChecksum: typeof parsed.archiveChecksum === 'string' ? parsed.archiveChecksum : undefined,
      installedAt: typeof parsed.installedAt === 'string' ? parsed.installedAt : '',
    }
  } catch {
    return undefined
  }
}

/**
 * Compute a stable content hash of an installed skill directory, excluding
 * the installer-owned provenance directory. 与安装时记录的归档校验和不同源,
 * 因此只用于「与上次计算相比是否变化」——首次安装时由 writeProvenance
 * 记录当时的内容哈希,之后据此判定本地是否被改动过。
 *
 * **跨包同源契约（独立复审 N1）**：随包插件同步器（vendored
 * `lib/coi/skills-sync.js` 的 `skillContentChecksum`）在每次自己写内容之后也写一份
 * 同样的哈希（`channel: 'plugin'` 落点的 `archiveChecksum`）。跨包 import 禁止 ⇒
 * 两份实现各自持有，等价性由 `tests/skill-channel-parity.spec.ts` 用真实 fixture
 * 对拍（嵌套目录 / 空目录 / 二进制 / 非 ASCII 名 / 符号链接 / 顶层 `.picoaide`）。
 * **改这里的算法必须同步改那边**（差异会让随包技能恒判脏或恒不判脏）。
 */
export async function computeSkillContentHash(skillDir: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (prefix === '' && entry.name === PROVENANCE_DIR) continue
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        hash.update(`D:${rel}\n`)
        await walk(join(dir, entry.name), rel)
      } else if (entry.isFile()) {
        hash.update(`F:${rel}:`)
        const bytes = await readFile(join(dir, entry.name))
        // 顶层 SKILL.md 走**规范化**字节（N1b / 复审 R5-B-4）：平台管理的
        // frontmatter 字段（`disable-model-invocation`，由「技能管理」的禁用开关写）
        // 不进内容哈希 —— 「禁用」是平台动作，不是"用户改了内容"。
        hash.update(rel === 'SKILL.md' ? normalizeSkillManifestBytes(bytes) : bytes)
        hash.update('\n')
      }
    }
  }
  await walk(skillDir, '')
  return hash.digest('hex')
}

/**
 * 内容哈希用的**规范化字节**：把平台管理的 frontmatter 字段从 SKILL.md 里剔除
 * （N1b / 独立复审 R5-B-4）。
 *
 * 为什么必须有：`disable-model-invocation` 是「技能管理」Tab 的禁用开关写进
 * SKILL.md 的字段（写入端在 vendored 插件 `lib/skills-manager.js`，本轮起与
 * `lib/skill-manifest.js` 共用同一份实现）。它是**平台自己的元数据**，而内容哈希
 * 此前把它当成"用户改了内容"：①能力中心误显示「已本地修改」；②此后每次更新/卸载
 * 都要多一张确认条。判据因此收窄为"**用户改过内容**"。
 *
 * 与其余跨包契约一样：**逐字节复刻** vendored 侧 `lib/skill-manifest.js` 的
 * `normalizeSkillManifestBytes`（跨包 import 禁止），等价性由
 * `tests/skill-channel-parity.spec.ts` 用真实 fixture 对拍。
 *
 * 三条性质（缺一条都会出事）：
 *  - **无 frontmatter / 无该字段 ⇒ 原样返回入参 Buffer**（不做往返编解码）：本修复
 *    之前写下的老基准里，从没带过该字段的技能必须逐字节仍然可比，否则全量技能会
 *    瞬间变成"已本地修改"；
 *  - 有该字段 ⇒ 按 `toggleDisableFlag` 的同一套 splice 规则移除并重建 frontmatter
 *    块（`---\n<data>\n---<原闭合换行><body>`），于是"禁用/启用"开关对哈希不可见；
 *  - 只影响顶层 `SKILL.md`（{@link computeSkillContentHash} 只在 `rel === 'SKILL.md'`
 *    时调用它）；正文/其它文件一律按原始字节哈希 ⇒ 用户真的改了正文**照样**判脏。
 *
 * @param bytes - SKILL.md 的原始字节。
 * @returns 参与哈希的字节（多数情况下就是入参本身）。
 */
export function normalizeSkillManifestBytes(bytes: Buffer): Buffer {
  const text = bytes.toString('utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n?)([\s\S]*)$/u.exec(text)
  if (match === null) return bytes
  const data = match[1] as string
  if (!DISABLE_MODEL_KEY_LINE.test(data)) return bytes
  const next = data.split('\n').filter((line) => !DISABLE_MODEL_KEY_LINE.test(line)).join('\n')
  return Buffer.from(`---\n${next}\n---${match[2] as string}${match[3] as string}`, 'utf8')
}

/** One locally authored skill row (name + display metadata from frontmatter). */
export interface LocalSkillRow {
  name: string
  displayName?: string | undefined
  description?: string | undefined
  version?: string | undefined
}

/** Extract a trimmed string from an unknown YAML value ('' → undefined). */
function metaString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Enumerate locally authored skills (SKILL.md directories under the root)
 * with their frontmatter display metadata: what the upstream filesystem
 * provider discovers. Metadata is best-effort (unreadable frontmatter
 * degrades to the id — presentation, not capability).
 * @param skillsDir - the user skill root (e.g. `<dshHome>/skills`).
 * @returns rows sorted by name.
 */
export async function listLocalSkills(skillsDir: string): Promise<LocalSkillRow[]> {
  // 用**运行时发现的行**（带落点路径）而不是"名字 → join(skillsDir, name)"：目录名与
  // frontmatter 名不一致时（用户自建目录、旧备份），按名字拼路径会读错文件（R13-B P1-2）。
  const rows = await discoverRuntimeSkills(skillsDir)
  const seen = new Set<string>()
  const result: LocalSkillRow[] = []
  for (const row of rows) {
    if (seen.has(row.name)) continue
    seen.add(row.name)
    const meta = await readSkillFrontmatter(row.skillMdPath)
    const displayName = metaString(meta.name)
    const description = metaString(meta.description)
    const version = metaString(meta.version)
    result.push({
      name: row.name,
      ...displayName === undefined ? {} : { displayName },
      ...description === undefined ? {} : { description },
      ...version === undefined ? {} : { version },
    })
  }
  return result
}

/** Parse the YAML frontmatter of a SKILL.md (best-effort). */
async function readSkillFrontmatter(skillMdPath: string): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(skillMdPath, 'utf8')
  } catch {
    return {}
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(raw)
  if (match === null) return {}
  try {
    const parsed = parseYaml(match[1]!) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Unparsable frontmatter: degrade to id (presentation only).
  }
  return {}
}

/** Result of packing one local skill for upload. */
export interface SkillPackResult {
  name: string
  displayName?: string | undefined
  description?: string | undefined
  version: string
  checksum: string
  archive: Buffer
}

/**
 * Pack a locally authored skill's WHOLE directory into a zip whose entries
 * are the directory's contents (the archive root IS the skill directory).
 * Symlinks are refused by the safety scan, so an archive can never smuggle a
 * reference outside the skill.
 *
 * 版本号取自包内 `SKILL.md` 的 frontmatter `version`(决策 2026-09-01
 * 「包内即真相」)。此前这里的默认值 '1.0.0' 让每次上传都声称是 1.0.0——
 * 服务端因此永远看到同一个版本号,「本地与线上版本一致就拒绝」无从判断。
 * @param skillsDir - the skill root (`<dshHome>/skills`).
 * @param name - the skill directory name.
 * @param version - 可选覆盖;缺省时用包内 frontmatter 的 version。
 * @param locale - 宿主语言(调用方按请求解析后传入;缺省中文,与历史行为一致)。
 * @returns the archive plus metadata, or throws with a user-facing message.
 */
export async function packSkill(
  skillsDir: string, name: string, version?: string, locale: HostLocale = DEFAULT_HOST_LOCALE,
): Promise<SkillPackResult> {
  validateSkillName(name)
  const dir = join(skillsDir, name)
  // The walk root must be a REAL directory BEFORE anything is read (R10-B-03):
  // `stat` follows a symbolic link, so `<skills>/<name>` pointing at a working
  // copy elsewhere turned "pack this skill" into "pack whatever that directory
  // holds" — the archive carried files that are not part of the skill at all
  // (measured: a `secret.txt` living outside the skill root).
  const root = await assertRealSkillDirectory(dir, name, locale)
  const skillFile = await lstat(join(root, 'SKILL.md')).catch(() => undefined)
  if (skillFile === undefined || !skillFile.isFile()) {
    throw new Error(`skill "${name}" has no SKILL.md`)
  }
  const meta = await readSkillFrontmatter(join(root, 'SKILL.md'))
  const packVersion = version ?? metaString(meta.version)
  if (packVersion === undefined) {
    // 用户可见(经 auth-gate 的 { error } 回到能力中心面板), 故按宿主语言取。
    throw new Error(hostCopy(
      locale,
      `技能 "${name}" 的 SKILL.md 缺少 version 字段:请写明版本号(如 version: 1.0.0)后再上传`,
      `Skill "${name}" has no version field in SKILL.md: add a version (for example version: 1.0.0) and upload again`,
    ))
  }

  const zip = new AdmZip()
  await addDirToZip(zip, root, root, '')
  const archive = zip.toBuffer()
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`skill archive too large (${archive.byteLength} bytes)`)
  }
  await assertArchiveSafe(archive)
  // 发布前本地预检(决策 §5.5):与服务端同一套规则的前 7 步,错误码一致。
  // 在这里失败就不发请求——用户不必等一次网络往返才知道包不合规。
  const raw = await readFile(join(root, 'SKILL.md'), 'utf8')
  const entryNames = zip.getEntries().map((e) => e.entryName)
  const issues = precheckSkillPackage(raw, name, entryNames, locale)
  if (issues.length > 0) {
    const first = issues[0]!
    const more = issues.length > 1
      ? hostCopy(locale, `（另有 ${issues.length - 1} 项问题）`, ` (${issues.length - 1} more issues)`)
      : ''
    throw new Error(`${first.code}: ${first.message}${more}`)
  }
  const checksum = createHash('sha256').update(archive).digest('hex')
  const displayName = metaString(meta.name)
  const description = metaString(meta.description)
  return {
    name,
    ...displayName === undefined ? {} : { displayName },
    ...description === undefined ? {} : { description },
    version: packVersion,
    checksum,
    archive,
  }
}

/**
 * Assert that one skill directory is a REAL directory, and return its real path.
 *
 * The traversal root is the one place the "archive can never smuggle a
 * reference outside the skill" invariant did NOT hold (R10-B-03): the walk
 * refused symbolic links INSIDE the tree but happily followed a link that WAS
 * the skill directory, so every file of the link target — files that are not
 * part of the skill, and may live anywhere the process can read — went into the
 * upload archive. A pre-existing link is refused, loudly: a silently empty or
 * silently partial package would be worse than a refusal.
 *
 * The returned real path is what the walk is anchored on, so a legitimately
 * symlinked SKILL ROOT (`<DSH_HOME>/skills` itself pointing at a working tree)
 * keeps working while the skill directory does not.
 * @param dir - `<skillsDir>/<name>` as it was joined.
 * @param name - the skill name, for the user-facing message.
 * @param locale - host locale for that message.
 * @returns the resolved real path of the skill directory.
 */
async function assertRealSkillDirectory(dir: string, name: string, locale: HostLocale): Promise<string> {
  const info = await lstat(dir).catch(() => undefined)
  if (info === undefined) throw new Error(`skill "${name}" has no SKILL.md`)
  if (info.isSymbolicLink()) {
    // 用户可见(经 auth-gate 的 { error } 回到能力中心面板), 故按宿主语言取。
    // **库内别名同样拒收**（有意, 不是漏洞）: 能力中心本来就列不出符号链接形态的
    // 技能目录, 放行它只会让"界面上不存在、上传包里却存在"两种事实并存
    // （2026-09-24 复审 V3 的 N7）。要恢复打包, 把目录换成真实目录即可。
    throw new Error(hostCopy(
      locale,
      `技能 "${name}" 是符号链接:拒绝打包(技能必须是技能库里的真实目录,不能指向库外)`,
      `Skill "${name}" is a symbolic link: refusing to pack it (a skill must be a real directory in the skill library, not a link pointing outside)`,
    ))
  }
  if (!info.isDirectory()) throw new Error(`skill "${name}" has no SKILL.md`)
  return await realpath(dir)
}

/**
 * Recursively add a directory tree into an AdmZip (relative entry names).
 *
 * Two assertions per entry, both fail-loud (R10-B-03):
 *  - `lstat`, never `stat`, decides what the entry is — a symbolic link is
 *    refused instead of followed (the same rule the installer applies);
 *  - the entry's REAL path must stay inside `root` (the skill directory's real
 *    path), which is the containment half of the invariant and catches any
 *    traversal the type check above cannot see.
 * The caller guarantees `root` is a real directory ({@link assertRealSkillDirectory}).
 * @param zip - archive under construction.
 * @param root - real path of the skill directory (the containment anchor).
 * @param dir - directory being walked (always inside `root`).
 * @param relPrefix - archive-relative prefix of `dir`.
 */
async function addDirToZip(zip: AdmZip, root: string, dir: string, relPrefix: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const abs = join(dir, entry.name)
    const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`
    // 安装器自有文件**不是技能内容**，重新上传时必须排除（审计 2026-09-23 A13）：
    //  - `.picoaide/`：溯源目录，服务端以 PROVENANCE_FORBIDDEN 拒绝（伪造归属防护）；
    //  - `.install-version`：安装器写的版本标记，此前会被打进上传包流出去。
    if (relPrefix === '' && (entry.name === PROVENANCE_DIR || entry.name === INSTALL_VERSION_FILE)) continue
    const info = await lstat(abs).catch(() => undefined)
    if (info === undefined) throw new Error(`skill entry vanished while packing: ${rel}`)
    // 拒绝符号链接:打包时即失败(安装侧同样拒绝)。
    if (info.isSymbolicLink()) {
      throw new Error(`symlink refused in package: ${rel}`)
    }
    const real = await realpath(abs).catch(() => undefined)
    if (real === undefined || (real !== root && !real.startsWith(`${root}${sep}`))) {
      throw new Error(`skill entry escapes the skill root: ${rel}`)
    }
    // 认账的残量（2026-09-24 复审 V3 的 N8）：**硬链接**不受上面这条落点断言约束
    // —— `realpath` 对硬链接返回的仍是该目录里的路径（硬链接没有"目标路径"），
    // 结构性修不了。要利用它，攻击者必须已经能在技能库里创建硬链接（即已有库内
    // 写权限），因此按"与既有写权限同级"接受，不额外加无效判据。
    if (info.isDirectory()) {
      zip.addFile(`${rel}/`, Buffer.alloc(0), '', 0o755)
      await addDirToZip(zip, root, abs, rel)
    } else if (info.isFile()) {
      const data = await readFile(abs)
      zip.addFile(rel, data, '', info.mode & 0o777)
    } else {
      // FIFO / socket / device: neither packable nor silently omittable — an
      // archive that quietly misses an entry is how a "published" skill ends up
      // different from the one on disk.
      throw new Error(`unsupported skill entry: ${rel}`)
    }
  }
}
