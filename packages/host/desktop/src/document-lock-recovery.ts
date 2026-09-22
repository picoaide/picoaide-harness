/**
 * 回收**孤儿写锁**：`<home>/settings.yaml.lock` 与 `<home>/.credentials.yaml.lock`。
 *
 * 上游 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock` 用 `wx` 建
 * `<document>.lock`、把属主 PID 写进去、在 `finally` 里删除它；它**故意不删别人的
 * 锁**（源码注释：orphan recovery is an operator action —— 文件年龄无法证明属主已
 * 停止）。于是"建锁之后、删锁之前"的任何一次崩溃/强杀/写入失败都会留下**永久**
 * 孤儿锁；此后该文档的**每一次**写入都要等 `DEFAULT_LOCK_WAIT_MS`（2s）后以
 * `atomic-write: timed out waiting for the writer lock` 失败，而失败被各插件的
 * `.catch` 吞进日志 ⇒ 表现是"设置静默改不动"，没有任何用户可见信号。
 *
 * 现场事故（2026-09-22，客户机）：数据根里一个 0 字节的 `settings.yaml.lock` 让
 * `llm-deepseek.protocol: chat-completions` 永远写不进 settings；客户端升级到
 * 0.1.6 后适配器回落缺省 `messages`，模型请求走只发 `x-api-key` 的路径，被自家
 * 网关的 `BearerAuth` 判 401「缺少认证令牌」——用户看到的却是"认证失败"，重新
 * 登录也救不回来（要写的那一行本身就走 settings 落盘）。
 *
 * ## 判据：只有**证据**成立才删，拿不准一律保留
 *
 * 三类可删路径，各自有独立证据；**任何一条都不依赖"同一数据根只有一个实例"**
 * （那个前提是错的：渠道包可以共用数据根——beta 渠道的 `home_dir` 就是官方目录
 * `.picoaide-harness`，而 Electron 单实例锁在**按渠道分流**的 userData 里，两个
 * 渠道的客户端可以同时跑在同一数据根上）：
 *
 * 证据的适用范围是**同一台机器、同一个 PID 命名空间**：`process.kill(pid, 0)` 的结论
 * 在"容器/绑定挂载共享数据根""网络家目录由另一台机器写锁"这类部署里不成立（活属主的
 * PID 在本地可能不存在 ⇒ 误判为 `ESRCH`）。这些部署形态不在本模块的保证范围内。
 *  1. `owner-is-this-process` —— 锁里记的就是本进程 PID。本函数由主进程在
 *     `requestSingleInstanceLock()` 之后、任何写入者启动之前调用，本进程此刻还
 *     没有写过任何文档锁，所以"属主是自己"只可能是上一轮运行的同号 PID（PID 复用）。
 *     这条"证明"同样只在**同一 PID 命名空间**内成立（跨容器共享数据根时，另一个命名
 *     空间里同号的活属主不会被探测到 —— 见上面保证范围的说明）。
 *  2. `owner-pid-gone` —— 锁里的 PID 探测为**已不存在**（`ESRCH`）。只有 `ESRCH`
 *     算证据：`EPERM` 说明进程活着（信号权限不足），其它错误码（`ERR_OUT_OF_RANGE`
 *     等）一律按"未知"处理并保留。
 *  3. `no-owner-recorded` —— 锁里没有可用属主（0 字节/纯空白/记为 0），**且**文件
 *     mtime 已经超过 {@link NO_OWNER_LOCK_MIN_AGE_MS}。理由：活着的写者"已建锁、
 *     还没写 PID"的窗口是微秒级，超过 45s 还是 0 字节只可能是"建锁后写入失败或进程
 *     死掉"留下的孤儿；年龄门槛把那个微秒窗口从判据里排除掉（与本仓 cron 的
 *     `host-ledger.ts:STALE_LOCK_AGE_MS` 同一口径）。
 *
 * 其余情况**一律保留并上报**（`kept`）：锁文件读不出来（EACCES/EIO）、体积超过
 * {@link LOCK_CONTENT_MAX_BYTES}（真实锁只有 ≤20 字节，超出的不读进主进程）、内容是
 * **不认识**的格式（上游若换锁文件格式，"不认识"≠"没有属主"）、属主存活、属主存活
 * 状态**未知**、路径上是目录/符号链接等非普通文件、以及"判定之后、删除之前文件已被
 * 换掉"（复检 `dev/ino/size/mtimeMs` **并与判定时读到的内容逐字节比较**；时间戳步进粗、
 * ext4 又会立即复用 inode，所以同长度换锁只有内容比较认得出来）。
 *
 * 只碰这两个文档：`settings.yaml`（网关模型目录/权限默认值/主题的落点）与
 * `.credentials.yaml`（企业网关令牌）。其余同名 `.lock` 一律不动——尤其
 * `session.lock` 是会话租约、**故意**常驻磁盘，删它会破坏租约语义。
 */

import { lstatSync, readFileSync, unlinkSync, type Stats } from 'node:fs'
import { join } from 'node:path'

/** 受管文档：写锁孤儿会让它们的写入**静默**变成永久失败。 */
const GUARDED_DOCUMENTS = ['settings.yaml', '.credentials.yaml'] as const

/**
 * "没有属主记录"的锁至少要有这么老才允许回收（毫秒）。
 * 与 `@picoaide/dsh-cron` 的 `host-ledger.ts:STALE_LOCK_AGE_MS` 同口径；导出只为
 * 让判据能精确回拨 mtime 测边界，不是部署可调项。
 */
export const NO_OWNER_LOCK_MIN_AGE_MS = 45_000

/**
 * 允许读进主进程的锁文件体积上限（字节）。上游写的是 `String(pid) + '\n'`（≤20 字节），
 * 所以这不是阈值调优而是"合理性闸门"：这个模块跑在**窗口创建之前**的启动路径上，
 * 固定路径上一个大文件不该把几十 MB 读进主进程内存（`readFileSync` 的真实上限是
 * `buffer.constants.MAX_STRING_LENGTH`，约 512MB）。超限按"读不出来"处理（保留 + 上报）。
 */
export const LOCK_CONTENT_MAX_BYTES = 4 * 1024

/** 判定为孤儿锁的依据；直接进日志（可检索）。 */
export type OrphanLockReason = 'no-owner-recorded' | 'owner-is-this-process' | 'owner-pid-gone'

/** 保留（不回收）的原因；同样直接进日志。 */
export type KeptLockReason =
  | 'inspect-failed'
  | 'not-a-regular-file'
  | 'unreadable'
  | 'unrecognized-content'
  | 'too-young'
  | 'owner-alive'
  | 'owner-liveness-unknown'
  | 'changed-since-inspection'
  | 'remove-failed'

/** 一条被回收的锁。 */
export interface ReclaimedDocumentLock {
  /** 被锁住的文档名（日志用）。 */
  document: string
  /** 被删除的锁文件绝对路径。 */
  path: string
  /** 判定依据。 */
  reason: OrphanLockReason
  /** 锁文件里记录的 PID；没有记录时缺席。 */
  pid?: number
  /** 删除前锁文件的 mtime（ISO 串）；取不到或缺席时没有该字段。 */
  modifiedAt?: string
  /** 附加诊断（例如"锁文件读不出来"的原因）；正常路径不产生。 */
  note?: string
}

/** 一条**保留**的锁：属主看起来还活着。 */
export interface HeldDocumentLock {
  document: string
  path: string
  pid: number
}

/** 一条**保留**的锁：无法证明它是孤儿（或删不掉）。 */
export interface KeptDocumentLock {
  document: string
  path: string
  reason: KeptLockReason
  /** 人读诊断（不含锁文件内容：不认识的格式只记字节数）。 */
  message: string
}

/** 一次回收的结果（调用方负责逐条落日志）。 */
export interface DocumentLockRecoveryReport {
  reclaimed: ReclaimedDocumentLock[]
  held: HeldDocumentLock[]
  kept: KeptDocumentLock[]
}

/** {@link reclaimOrphanedDocumentLocks} 的入参。 */
export interface DocumentLockRecoveryOptions {
  /** 数据根（`$DSH_HOME`；main.ts 里 `applyInstallDshHome()` 的结果，已是绝对路径）。 */
  home: string
  /**
   * 属主存活探测；缺省用 `process.kill(pid, 0)`。
   * 注入点只给测试用（真实进程表里造不出"确定已死"的 PID）。
   */
  probeOwner?: (pid: number) => OwnerLiveness
  /**
   * 删除锁文件；缺省 `unlinkSync`。注入点同样只给测试用（真实环境里造不出"确定删不掉
   * 但不涉及权限位"的形态，而 root 沙箱无法用权限位复现 `remove-failed`）。
   */
  removeFile?: (path: string) => void
  /**
   * 读取锁文件内容；缺省 `readFileSync(path, 'utf8')`。注入点只给测试用：它让判据能直接
   * 断言"复检在**读之前**就短路了"（不该读的形态下读取次数不增加），而不是只能靠时序或
   * 文件系统特性（inode 复用/时间戳粒度）间接推断。
   */
  readFile?: (path: string) => string
}

/** 属主存活探测的三态：只有 `gone` 能证明可以回收。 */
export type OwnerLiveness = 'alive' | 'gone' | 'unknown'

/**
 * 把一个 `process.kill(pid, 0)` 的错误码映射成三态。**只有 `ESRCH` 能证明进程已不存在**；
 * `EPERM` 表示信号权限不足（进程活着）；其余错误码（`ERR_OUT_OF_RANGE` /
 * `ERR_INVALID_ARG_TYPE` / `EACCES` …）都不能证明属主已死，按"未知"处理并保留。
 *
 * 单独导出（并在单测里逐码钉住）是因为"造一个真 `EPERM`"需要非特权进程去探测别人的
 * 进程，而这条映射正是"绝不替人删活锁"的最后一道 —— 它不能被静默改坏。
 * @param code - `NodeJS.ErrnoException.code`（可能缺席）。
 * @returns 该错误码能支持的结论。
 */
export function classifyOwnerProbeError(code: string | undefined): OwnerLiveness {
  if (code === 'ESRCH') return 'gone'
  if (code === 'EPERM') return 'alive'
  return 'unknown'
}

/**
 * 探测一个 PID：只有 `ESRCH` 能证明进程已不存在。
 * @param pid - 锁文件里记录的属主 PID（调用方已保证 > 0）。
 * @returns `alive`（成功或 `EPERM`）、`gone`（`ESRCH`）、`unknown`（其它错误码）。
 */
function probeOwnerLiveness(pid: number): OwnerLiveness {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    return classifyOwnerProbeError((error as NodeJS.ErrnoException | null)?.code)
  }
}

/** 期望的锁文件内容：`String(pid) + '\n'`，容错首尾空白。 */
const OWNER_PID_PATTERN = /^\s*([0-9]+)\s*$/u

/** 一条候选锁的检查结果（`| undefined` 是 `exactOptionalPropertyTypes` 下的显式写法）。 */
type CandidateVerdict =
  | { kind: 'absent' }
  | {
    kind: 'reclaim'
    reason: OrphanLockReason
    pid?: number | undefined
    modifiedAt?: string | undefined
  }
  | { kind: 'held', pid: number }
  | { kind: 'kept', reason: KeptLockReason, message: string }

/**
 * 判定阶段留下的证据，供删除前复检使用：`lstat` 快照 + 读到的锁内容。
 * 两者都由 {@link inspectCandidate} 写回，`undefined` 表示那一项没拿到（此时不删）。
 */
interface CandidateSnapshot {
  stats?: Stats
  content?: string
}

/** mtime 的 ISO 串；越界（`Date` 值域之外）时返回 undefined，绝不影响裁决。 */
function readableIso(mtime: Date): string | undefined {
  try {
    return mtime.toISOString()
  } catch {
    // 坏时间戳（归档恢复/touch/网络文件系统）只影响日志字段，不该让候选退化成不可回收。
    return undefined
  }
}

/** 错误消息提取（只用于日志，不含文件内容）。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 检查一条候选锁文件并给出裁决（只读判定，不做删除）。
 * @param path - 锁文件绝对路径。
 * @param probeOwner - 属主存活探测。
 * @param now - 当前时间（毫秒，年龄判据用）。
 * @param snapshot - 命中时写回 `lstat` 快照与读到的锁内容，两者都供删除前复检（TOCTOU）。
 * @returns 裁决；`absent` 与 `kept` 都不动文件。
 */
function inspectCandidate(
  path: string,
  probeOwner: (pid: number) => OwnerLiveness,
  now: number,
  snapshot: CandidateSnapshot,
  readFile: (path: string) => string,
): CandidateVerdict {
  let stats
  try {
    stats = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'kept', reason: 'inspect-failed', message: describeError(error) }
  }
  snapshot.stats = stats
  const modifiedAt = readableIso(stats.mtime)
  const ageMs = now - stats.mtimeMs
  // 只删我们自己写的那种普通文件：目录/符号链接/设备节点出现在这个路径上都属于
  // 需要人看的情况，这里不做"顺手清掉"。
  if (!stats.isFile()) {
    return {
      kind: 'kept',
      reason: 'not-a-regular-file',
      message: `not a regular file (mode ${(stats.mode & 0o777).toString(8)})`,
    }
  }
  // 体积闸门在读之前：这个模块跑在窗口创建之前的启动路径上，固定路径上的大文件不该被
  // 整份读进主进程内存（真实锁只有 ≤20 字节）。
  if (stats.size > LOCK_CONTENT_MAX_BYTES) {
    return {
      kind: 'kept',
      reason: 'unreadable',
      message: `lock file is ${String(stats.size)} bytes, over the ${String(LOCK_CONTENT_MAX_BYTES)}-byte sanity bound; refusing to read it`,
    }
  }
  let text: string
  try {
    text = readFile(path)
  } catch (error) {
    // 读不出来 ⇒ 无法证明没有属主（可能是别的进程按更严权限建的活锁），保留并上报。
    return { kind: 'kept', reason: 'unreadable', message: `lock unreadable: ${describeError(error)}` }
  }
  // 复检要比内容：锁内容是 `String(pid) + '\n'`，同长度的换锁只能靠字节比较认出来。
  snapshot.content = text
  const match = OWNER_PID_PATTERN.exec(text)
  // 没有可用属主：空内容，或记的是 PID 0（0 不是任何用户进程）。两者都要过年龄
  // 门槛，排除"活着的写者刚建锁、还没写 PID"的微秒窗口；未来时间（ageMs < 0）
  // 同样按"太新"保留。
  if (text.trim().length === 0 || (match !== null && Number(match[1]) === 0)) {
    if (ageMs < NO_OWNER_LOCK_MIN_AGE_MS) {
      return {
        kind: 'kept',
        reason: 'too-young',
        message: `no owner recorded yet, but the lock is only ${String(Math.max(0, Math.round(ageMs)))}ms old`
          + ` (threshold ${String(NO_OWNER_LOCK_MIN_AGE_MS)}ms); keeping it`,
      }
    }
    return { kind: 'reclaim', reason: 'no-owner-recorded', modifiedAt }
  }
  if (match === null) {
    return {
      kind: 'kept',
      reason: 'unrecognized-content',
      message: `unrecognized lock content (${String(text.trim().length)} bytes)`,
    }
  }
  const pid = Number(match[1])
  // 属主"就是本进程"：调用点在 boot 之前，本进程还没有写过任何文档锁 ⇒ 只可能是
  // 上一轮运行留下的同号 PID（PID 复用）。这条是**证明**，不是猜测。
  if (pid === process.pid) return { kind: 'reclaim', reason: 'owner-is-this-process', pid, modifiedAt }
  const liveness = probeOwner(pid)
  if (liveness === 'alive') return { kind: 'held', pid }
  if (liveness === 'gone') return { kind: 'reclaim', reason: 'owner-pid-gone', pid, modifiedAt }
  return {
    kind: 'kept',
    reason: 'owner-liveness-unknown',
    message: `could not determine whether owner pid ${String(pid)} is still running`,
  }
}

/**
 * 删除前复检：文件必须还是**被判定过的那个**。
 *
 * 先比 `lstat` 四项（`dev`/`ino`/`size`/`mtimeMs`，便宜且能挡掉绝大多数换锁），**再比内容**：
 * 锁内容是 `String(pid) + '\n'`，同一数量级的两条 PID 天然同长度；而时间戳步进（实测 4ms）
 * 粗于判定窗口、ext4 又会立即复用 inode ⇒ 三项都可能全等，这时只有**内容不同**能证明
 * "这是另一个写者刚建的锁"（第 4 轮审计用真实第二进程复现过 18/20 次漏检）。
 *
 * 反过来说：任何一项不同（含文件消失/读不出来）都不再动它 —— 宁可少回收一把孤儿锁。
 * @param path - 锁文件绝对路径。
 * @param before - 判定时的 `lstat` 快照。
 * @param content - 判定时读到的锁内容（受 {@link LOCK_CONTENT_MAX_BYTES} 限长）。
 * @returns true=仍是同一个文件（内容也一致）。
 */
function unchangedSinceInspection(
  path: string,
  before: Stats,
  content: string,
  readFile: (path: string) => string,
): boolean {
  try {
    const after = lstatSync(path)
    // 类型也要复验：判定窗口里可能被换成符号链接（`lstat` 的 size 是链接目标串长度，
    // 换成等长目标就能骗过下面的四项比较），而 `readFileSync` 会**跟随**它 —— 指向无写者
    // FIFO 时 open 永久阻塞，本函数跑在窗口创建之前的启动路径上（第 5 轮审计实测挂死）。
    if (!after.isFile()) return false
    if (after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs) {
      return false
    }
    return readFile(path) === content
  } catch {
    // 文件在窗口里消失/变得不可 stat/读不出来：同样不再动它。
    return false
  }
}

/**
 * 把一次回收结果渲染成**必须留痕**的日志行（调用方加自己的前缀后逐行落盘）。
 *
 * 三类都要上报：①回收成功 = 这次启动之前该文档的写入一直在超时失败（现场事故的
 * 形态）；②属主存活 = 我们**不**替人删活锁，但要把 PID 与 mtime 交给运维按证据处理；
 * ③保留（kept）= 没能证明是孤儿或删不掉——包括"太新""读不出来""存活未知"。
 * @param report - {@link reclaimOrphanedDocumentLocks} 的结果。
 * @returns 日志行（顺序：回收 → 存活 → 保留；空结果返回空数组）。
 */
export function documentLockRecoveryLogLines(report: DocumentLockRecoveryReport): string[] {
  const lines: string[] = []
  for (const lock of report.reclaimed) {
    lines.push(
      `reclaimed an orphaned ${lock.document} write lock (${lock.reason}`
      + `${lock.pid === undefined ? '' : `, owner pid ${String(lock.pid)}`}`
      + `${lock.modifiedAt === undefined ? '' : `, mtime ${lock.modifiedAt}`}`
      + `${lock.note === undefined ? '' : `, ${lock.note}`}); writes to that document were timing out until now`,
    )
  }
  for (const lock of report.held) {
    lines.push(
      `${lock.document} write lock is held by live pid ${String(lock.pid)};`
      + ` writes to that document keep timing out until that process exits or ${lock.path} is removed`,
    )
  }
  for (const lock of report.kept) {
    lines.push(`left ${lock.path} in place (${lock.reason}): ${lock.message}`)
  }
  return lines
}

/**
 * 回收两个受管文档的孤儿写锁。
 *
 * 单条候选的任何失败都记进 `kept`，启动流程不因为一个锁文件中止（`home` 必须按类型
 * 传入：`DocumentLockRecoveryOptions.home` 是 `string`，类型面已保证）。
 * @param options - 数据根与可注入的存活探测/删除实现。
 * @returns 回收/存活/保留三组结果（保留组含"拒绝删除"与"删除失败"两类，由 `reason` 区分）。
 */
export function reclaimOrphanedDocumentLocks(options: DocumentLockRecoveryOptions): DocumentLockRecoveryReport {
  const probeOwner = options.probeOwner ?? probeOwnerLiveness
  const removeFile = options.removeFile ?? unlinkSync
  const readFile = options.readFile ?? ((path: string): string => readFileSync(path, 'utf8'))
  const report: DocumentLockRecoveryReport = { reclaimed: [], held: [], kept: [] }
  const now = Date.now()
  for (const document of GUARDED_DOCUMENTS) {
    const path = join(options.home, `${document}.lock`)
    const snapshot: CandidateSnapshot = {}
    let verdict: CandidateVerdict
    try {
      verdict = inspectCandidate(path, probeOwner, now, snapshot, readFile)
    } catch (error) {
      report.kept.push({ document, path, reason: 'inspect-failed', message: describeError(error) })
      continue
    }
    if (verdict.kind === 'absent') continue
    if (verdict.kind === 'held') {
      report.held.push({ document, path, pid: verdict.pid })
      continue
    }
    if (verdict.kind === 'kept') {
      report.kept.push({ document, path, reason: verdict.reason, message: verdict.message })
      continue
    }
    const { stats, content } = snapshot
    if (stats === undefined || content === undefined
      || !unchangedSinceInspection(path, stats, content, readFile)) {
      report.kept.push({
        document,
        path,
        reason: 'changed-since-inspection',
        message: 'the lock file changed between inspection and removal; left in place',
      })
      continue
    }
    let vanished = false
    try {
      removeFile(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        report.kept.push({ document, path, reason: 'remove-failed', message: describeError(error) })
        continue
      }
      // 复检之后别人把锁删掉了：锁已经不在了 = 目标达成。上报成 reclaimed，但用 note
      // 说明不是我们删的（否则"已经没了"会被写成"删不掉"，把排查带偏）。
      vanished = true
    }
    report.reclaimed.push({
      document,
      path,
      reason: verdict.reason,
      ...verdict.pid === undefined ? {} : { pid: verdict.pid },
      ...verdict.modifiedAt === undefined ? {} : { modifiedAt: verdict.modifiedAt },
      ...!vanished ? {} : { note: 'the lock disappeared between the identity re-check and removal' },
    })
  }
  return report
}
