/**
 * macOS 原地自更新：用已下载、已按清单 SHA-256 校验过的 DMG 里的 `.app`，替换**正在运行的
 * 那一个**应用包，并在替换完成后把应用重新打开。
 *
 * ## 为什么要这一段
 *
 * 2026-10-09 之前 macOS 的交付口径只有"打开磁盘映像"：用户点「安装更新」后，DMG 挂上来，
 * 剩下的事只能自己做 —— 退出应用、把新版本拖进「应用程序」、覆盖旧版本、再打开。用户
 * 反馈的原话就是"每次更新都要手动退出并手动拖过去"。Windows 早就是"应用自己重启 →
 * 安装程序接管"，macOS 缺的正是这一步。
 *
 * ## 形状（三段时间线）
 *
 * ```
 * 宿主进程（正在运行的旧版本）                帮手进程（/bin/sh，detached）
 * ─────────────────────────────              ────────────────────────────────
 * 1. 便宜的前置判据（见 canInstallMacosInPlace）
 * 2. 挂上 DMG（只读）+ 核对身份/版本/TeamID
 * 3. 写帮手脚本、detached 起进程（等到 'spawn'）
 * 4. requestQuit(0) ─────────────────────▶  5. 等宿主 pid 退出（上限 120s）
 *                                            6. ditto 到暂存路径（与目标同卷）
 *                                            7. codesign --verify --strict 暂存件
 *                                            8. mv 旧包 → 备份；mv 暂存件 → 目标
 *                                            9. 卸载 DMG、重新打开应用
 *                                           10. 等新版写启动标记（上限 30s）
 *                                              等到 ⇒ 删备份（承认成功）
 *                                              等不到 ⇒ 回滚 + 重新打开旧版本
 * ```
 *
 * 判据一律**在动用户文件之前**：第 7 步不过就只有一个暂存目录被删掉，第 8 步失败会
 * 把备份改回原名。任何一步失败的结论都写进**结果文件**，宿主下次启动时读它决定要不要
 * 弹一次失败提示（见 {@link readMacosUpdateOutcome}）。
 *
 * ## 口径（不做的事）
 *
 * - **不弹管理员授权**：目标目录不可写（root 安装、只读宗卷、App Translocation）就整套
 *   回落成"打开磁盘映像让用户自己拖"——与改造前的行为逐字一致，只是多了一行日志。
 * - **不换载荷**：仍然只吃已公证的 DMG。不引入 ZIP/blockmap 第二条打包与发布路径
 *   （2026-09-12 的决定仍然成立，见 docs/decisions/2026-09-12-client-update-resilience.md）。
 * - **不做差分下载**、不碰服务端清单与 R2 布局。
 *
 * @module dsh-plugin-desktop/macos-update-install
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmdirSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { compareSemVerVersions } from './update-checker.ts'

/**
 * 同一个目标版本允许的**自动**原地安装失败次数上限（审计 A15）。
 *
 * 达到上限后不再走原地替换，而是回落成"打开磁盘映像"：用户仍能装上，但不会被
 * "点一次失败一次"的循环困住。取值与 Squirrel.Mac 的
 * `SQRLShipItMaximumInstallationAttempts` 一致（3 次里含首次尝试，这里按"已失败次数"计）。
 */
export const MACOS_UPDATE_FAILURE_LIMIT = 2

/** Mach-O 的 CPU 类型（`<mach/machine.h>`）→ 人类可读架构名。 */
const MACHO_CPU_TYPES: Readonly<Record<number, string>> = {
  7: 'i386',
  0x01000007: 'x86_64',
  12: 'arm',
  0x0100000c: 'arm64',
}

/** `process.arch` → Mach-O 架构名（判据两边的命名不同，必须显式映射）。 */
const PROCESS_ARCH_TO_MACHO: Readonly<Record<string, string>> = {
  arm64: 'arm64',
  x64: 'x86_64',
  ia32: 'i386',
}

/**
 * 命令执行边界：返回**合并后的 stdout + stderr**，非零退出抛错。
 *
 * 合并是必须的：`codesign -dv` 与 `codesign --verify` 的结论都写在 **stderr** 上，
 * 而 `plutil -convert json -o -` 的结论写在 stdout 上。分成两条流会让"读签名里的
 * TeamIdentifier"这类调用拿不到东西。
 */
export type MacosCommandRunner = (command: string, args: readonly string[]) => string

/**
 * 命令非零退出。
 *
 * 单独一个类型是因为有些判据必须区分"命令正常回答了没有"与"命令自己出问题了"——
 * 典型是 `pgrep`：退出码 1 = 没匹配（= 没人占用），其它失败不能当成"没人占用"
 * （审计 A10 的复核意见）。
 */
export class MacosCommandFailure extends Error {
  /** 进程退出码（`null` = 被信号打断 / 起不来）。 */
  readonly status: number | null

  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'MacosCommandFailure'
    this.status = status
  }
}

/** 生产用命令边界：`spawnSync` + 合并输出 + 非零即抛。 */
export const runMacosCommand: MacosCommandRunner = (command, args) => {
  const result = spawnSync(command, [...args], { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (result.status !== 0) {
    throw new MacosCommandFailure(
      `${command} ${args.join(' ')} exited with ${String(result.status)}: ${output.trim()}`,
      result.status,
    )
  }
  return output
}

/**
 * 「原地更新做不到」的原因。全部落在**回落**上（打开磁盘映像，用户自己拖），
 * 只有日志与失败提示会用到它 —— 因此这里不区分"哪种做不到"，只要求可诊断。
 */
export type MacosInPlaceFallbackReason =
  | 'unsupported-platform'
  | 'not-packaged'
  | 'unrecognized-bundle'
  | 'read-only-location'
  | 'unwritable-location'
  | 'insufficient-space'
  /**
   * 影像挂载点被占（上一次的挂载还在、或影像已被挂在别处），或 `hdiutil attach` 失败。
   *
   * 2026-10-12 审计 A13：这两条都是**环境**原因（同一份载荷换个时机就能装），
   * 改造前它们落在"抛错"桶里 ⇒ 用户看到 `invalid-artifact` 并被卡在点一次失败一次的循环里。
   */
  | 'image-busy'
  | 'image-unavailable'
  /** 该版本已经原地安装失败过 {@link MACOS_UPDATE_FAILURE_LIMIT} 次（审计 A15）。 */
  | 'too-many-failures'

/** 一次原地更新的执行计划：路径全部由宿主算好，帮手只按 argv 执行。 */
export interface MacosInPlaceUpdatePlan {
  /** 当前应用包（要被替换的那一个）。 */
  readonly bundlePath: string
  /** 磁盘映像挂载点（已挂上；帮手负责卸载）。 */
  readonly mountPoint: string
  /** 影像里那个新的应用包。 */
  readonly sourcePath: string
  /** 暂存路径（与 `bundlePath` 同目录 ⇒ 同卷 ⇒ `mv` 是原子 rename）。 */
  readonly stagingPath: string
  /** 旧包备份路径（替换失败或新版起不来时回滚到它）。 */
  readonly backupPath: string
  /** 随包身份（诊断用；替换前后必须一致的那一项）。 */
  readonly bundleIdentifier: string
}

/** 准备结论：要么给出计划，要么说明为什么只能回落。 */
export type MacosInPlacePreparation =
  | { readonly kind: 'prepared'; readonly plan: MacosInPlaceUpdatePlan }
  | { readonly kind: 'fallback'; readonly reason: MacosInPlaceFallbackReason }

/** {@link canInstallMacosInPlace} 的输入面（全部来自宿主进程，没有副作用）。 */
export interface MacosInPlacePrecondition {
  /** `process.platform`。 */
  readonly platform: NodeJS.Platform
  /** `app.isPackaged`。 */
  readonly isPackaged: boolean
  /** 当前进程的可执行文件绝对路径（`process.execPath`）。 */
  readonly executablePath: string
}

/** {@link prepareMacosInPlaceUpdate} 的输入面。 */
export interface MacosInPlacePrepareOptions extends MacosInPlacePrecondition {
  /** 已下载并校验过的 DMG 绝对路径。 */
  readonly installerPath: string
  /** 目标版本（可带前导 `v`）。 */
  readonly version: string
  /** 应用私有目录（挂载点、脚本、日志、结果文件都落在这里）。 */
  readonly userDataPath: string
  /** 命令执行边界；缺省 = 真实 `spawnSync`。 */
  readonly run?: MacosCommandRunner
  /** 追加一行诊断（默认丢弃）。 */
  readonly log?: (message: string) => void
  /**
   * 当前进程架构（审计 A8 的判据输入）；缺省 = `process.arch`。
   *
   * 单独开一个口子是因为架构判据必须能在 Linux 上跑判据 —— 否则它和 macOS 真机绑死，
   * 又会变成"CI 里没人看守"的那一类（见本轮审计的 P0）。
   */
  readonly arch?: string
}

/** 应用包的身份：替换前后必须一致的那几项。 */
export interface MacAppIdentity {
  /** `CFBundleIdentifier`。 */
  readonly identifier: string
  /** `CFBundleShortVersionString`。 */
  readonly version: string
  /** `CFBundleExecutable`。 */
  readonly executable: string
  /** 签名里的 TeamIdentifier；未签名/临时签名时为 undefined。 */
  readonly teamIdentifier: string | undefined
}

/** 帮手脚本 + 它的 argv（宿主 spawn 时逐项传入，脚本内不插值任何路径）。 */
export interface MacosUpdateHelper {
  /** 脚本落盘路径。 */
  readonly scriptPath: string
  /** 解释器（恒为 `/bin/sh`）。 */
  readonly command: string
  /** 传给解释器的完整 argv（含脚本路径与全部位置参数）。 */
  readonly args: readonly string[]
  /** 结果文件：帮手用它告诉下一次启动"成了没有、为什么没成"。 */
  readonly resultPath: string
  /** 日志文件：出问题时唯一的现场。 */
  readonly logPath: string
  /** 启动标记：新版启动时写，帮手等它来决定"成功"还是"回滚"。 */
  readonly bootMarkerPath: string
}

/** 结果文件里的一次更新尝试（`key=value` 行，见 {@link readMacosUpdateOutcome}）。 */
export interface MacosUpdateRecord {
  /** `ok` = 新版确认启动；`failed` = 未替换/已回滚；`running` = 帮手没写完就被杀。 */
  readonly status: 'ok' | 'failed' | 'running'
  /** 最后写入的阶段：`waiting`/`staging`/`verifying`/`swapping`/`done`/`rolling-back`。 */
  readonly phase: string
  /** 失败原因码（成功时空串）。 */
  readonly reason: string
  /** 更新前运行的版本。 */
  readonly fromVersion: string
  /** 尝试更新的目标版本。 */
  readonly toVersion: string
  /** 目标应用包路径。 */
  readonly targetPath: string
  /** 备份路径（回滚用）。 */
  readonly backupPath: string
  /** 日志路径。 */
  readonly logPath: string
}

/** 上一次更新尝试对**本次启动**的结论。 */
export type MacosUpdateOutcome =
  /** 目标版本就是当前运行的版本 ⇒ 更新已生效：删备份、清记录。 */
  | { readonly kind: 'applied'; readonly toVersion: string; readonly backupPath: string; readonly logPath: string }
  /** 目标版本不是当前版本，而记录说没成 ⇒ 报一次失败：清记录、留备份与日志。 */
  | { readonly kind: 'failed'; readonly record: MacosUpdateRecord }

/** 原地更新相关的全部落点（都在应用私有目录下，随渠道隔离）。 */
export interface MacosUpdatePaths {
  /**
   * 脚本目录里的**基准**名：真实脚本是 `<userData>/updates/macos/apply-update-<pid>.sh`。
   *
   * 2026-10-12 审计 N8：固定文件名 + 每次覆盖重写会让**上一条仍在运行的 `/bin/sh`**
   * 读到错位内容（bash 是按偏移增量读脚本的）。带 pid 的唯一名把这条路径彻底避开。
   */
  readonly scriptPath: string
  /** 日志：`<userData>/updates/macos/apply-update.log`。 */
  readonly logPath: string
  /** 结果：`<userData>/updates/macos/last-apply.txt`。 */
  readonly resultPath: string
  /** 启动标记：`<userData>/updates/macos/booted.txt`。 */
  readonly bootMarkerPath: string
  /**
   * 负向标记：`<userData>/updates/macos/boot-failed.txt`。
   *
   * 新版在"能写启动标记"之后、变成可用应用之前**致命失败**时写它（审计复核 P1：
   * 只有正标记会让"进程起来了但根本不是应用"被当成成功，于是不回滚还删掉唯一备份）。
   * 帮手在承认成功之前必须先看它。
   */
  readonly bootFailurePath: string
  /** 挂载点：`<userData>/updates/macos/image`。 */
  readonly mountPoint: string
  /** 失败账：`<userData>/updates/macos/failures.txt`（审计 A15）。 */
  readonly failuresPath: string
}

/**
 * 应用私有目录下的固定落点。
 * @param userDataPath - `app.getPath('userData')`。
 * @returns 六个绝对路径。
 */
export function macosUpdatePaths(userDataPath: string): MacosUpdatePaths {
  const root = join(userDataPath, 'updates', 'macos')
  return {
    scriptPath: join(root, 'apply-update.sh'),
    logPath: join(root, 'apply-update.log'),
    resultPath: join(root, 'last-apply.txt'),
    bootMarkerPath: join(root, 'booted.txt'),
    bootFailurePath: join(root, 'boot-failed.txt'),
    mountPoint: join(root, 'image'),
    failuresPath: join(root, 'failures.txt'),
  }
}

/**
 * 从可执行文件路径推出 `.app` 包根。
 *
 * 取**最外层**的 `.app` 段：Electron 的渲染/GPU 子进程跑在
 * `<X.app>/Contents/Frameworks/<X> Helper.app/…`，若取最内层会去替换那个 helper。
 * @param executablePath - 绝对路径（`process.execPath`）。
 * @returns `.app` 绝对路径；不是绝对路径或不含 `.app` 段时为 undefined。
 */
export function macAppBundlePath(executablePath: string): string | undefined {
  if (!executablePath.startsWith('/')) return undefined
  const parts = executablePath.split('/')
  const index = parts.findIndex(part => part.endsWith('.app'))
  // 段 0 恒为空串（绝对路径），因此 index ≤ 0 说明没有 `.app` 段。
  if (index <= 0) return undefined
  return parts.slice(0, index + 1).join('/')
}

/**
 * 便宜的**原地更新**前置判据：只看进程自身的事实，不碰磁盘、不跑命令。
 *
 * 与 {@link prepareMacosInPlaceUpdate} 分开是为了"问用户之前就知道能不能做"——
 * 做不到时说辞必须是旧的"磁盘映像已打开，请自己拖"，做到时才是新的
 * "会自动重启并替换"。判据在这里不成立时，准备阶段一定也不会成立（反之不然：
 * 挂载、身份、磁盘空间要挂了才知道）。
 * @param precondition - 平台 / 是否打包 / 可执行文件路径。
 * @returns 做不到的原因；undefined = 可以继续准备。
 */
export function canInstallMacosInPlace(
  precondition: MacosInPlacePrecondition,
): MacosInPlaceFallbackReason | undefined {
  if (precondition.platform !== 'darwin') return 'unsupported-platform'
  if (!precondition.isPackaged) return 'not-packaged'
  const bundlePath = macAppBundlePath(precondition.executablePath)
  if (bundlePath === undefined) return 'unrecognized-bundle'
  // App Translocation：从 DMG/下载目录直接运行的应用会被 Gatekeeper 拷到随机只读路径
  // 再启动（`/private/var/folders/…/AppTranslocation/<uuid>/d/X.app`）。那份副本的
  // 宗卷是只读的、且下一次运行就换路径 ⇒ 替换它没有任何意义。
  if (bundlePath.includes('/AppTranslocation/')) return 'read-only-location'
  if (!isWritableDirectory(dirname(bundlePath))) return 'unwritable-location'
  if (!isWritableDirectory(bundlePath)) return 'unwritable-location'
  return undefined
}

/**
 * 准备一次原地更新：挂上 DMG、核对影像里的应用就是"同一个应用的新版本"。
 *
 * 成功时**影像保持挂载**（帮手要用它，并在做完后卸载），计划里的路径全部算好。
 * 影像本身有问题（挂不上、里面没有应用、身份/版本/TeamID 对不上）**抛错**：那不是
 * "换一种交付方式"，而是"这份载荷不能用"，交由协调器变成用户可见的失败。
 * @param options - 见 {@link MacosInPlacePrepareOptions}。
 * @returns `prepared`（含计划）或 `fallback`（含原因）。
 */
export async function prepareMacosInPlaceUpdate(
  options: MacosInPlacePrepareOptions,
): Promise<MacosInPlacePreparation> {
  const run = options.run ?? runMacosCommand
  const log = options.log ?? (() => {})
  const blocker = canInstallMacosInPlace(options)
  if (blocker !== undefined) return { kind: 'fallback', reason: blocker }
  const bundlePath = macAppBundlePath(options.executablePath)
  if (bundlePath === undefined) return { kind: 'fallback', reason: 'unrecognized-bundle' }
  const version = normalizeVersion(options.version)
  const paths = macosUpdatePaths(options.userDataPath)
  const current = readMacAppIdentity(run, bundlePath)
  // 审计 A9：原先只判"相等"，于是**降级**也会被当成一次正常更新。客户端数据面是前向
  // only 的（会话格式跨代、迁移 0066 让存量会话失效），静默降级可能得到"旧 app + 新数据"。
  const order = compareSemVerVersions(version, current.version)
  if (order === 0) throw new Error(`dsh-plugin-desktop: ${version} is already installed`)
  if (order !== null && order < 0) {
    throw new Error(`dsh-plugin-desktop: refusing to replace ${current.version} with the older ${version}`)
  }
  if (order === null) {
    // 审计复核：与架构判据对齐，认不出大小关系时**留一行日志**再放行 ——
    // 静默放行会让"版本序判据"在异常输入下无声失效。
    log(`could not order ${version} against ${current.version}; continuing without the version order judgement`)
  }
  // 审计 A15：同一版本反复装不上就不再自动重试，回落成"打开磁盘映像"，用户仍有路可走。
  if (readMacosUpdateFailureCount(options.userDataPath, version) >= MACOS_UPDATE_FAILURE_LIMIT) {
    log(`${version} already failed ${String(MACOS_UPDATE_FAILURE_LIMIT)} times; falling back to opening the disk image`)
    return { kind: 'fallback', reason: 'too-many-failures' }
  }

  // 上一次留下的挂载点/暂存件先清干净：挂载点必须存在且为空，`hdiutil attach` 才肯用。
  clearMacosUpdateLeftovers(bundlePath, paths.mountPoint, run, log)
  // **只用 `rmdir`（空目录才行），绝不在挂载点路径上做递归删除**：万一上一次的影像
  // 还挂着（且卸载失败），递归删除会去删**卷里的内容**。卷是只读挂载所以它只会失败，
  // 但让"删不干净就报错"比"依赖卷是只读的"更结实。
  try {
    rmdirSync(paths.mountPoint)
  } catch {
    // 不存在（首次）或非空（残留挂载）：两种都继续往下走。
  }
  // 审计 A13：清理之后仍然非空 ⇒ 挂载点被占（陈旧挂载、或影像已被挂在别处）。
  // 这是**环境**原因而不是"这份载荷不能用"，因此回落而不是抛错。
  if (existsSync(paths.mountPoint) && readdirSync(paths.mountPoint).length > 0) {
    log(`${paths.mountPoint} is still occupied; falling back to opening the disk image`)
    return { kind: 'fallback', reason: 'image-busy' }
  }
  mkdirSync(paths.mountPoint, { recursive: true })

  let mounted = false
  try {
    try {
      run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noverify', '-mountpoint', paths.mountPoint, options.installerPath])
    } catch (cause) {
      // 审计 A13：挂不上同样是环境原因（镜像已挂载、被别的进程占着…）。
      log(`could not attach ${options.installerPath}: ${cause instanceof Error ? cause.message : String(cause)}`)
      return { kind: 'fallback', reason: 'image-unavailable' }
    }
    mounted = true
    if (listApplicationsInImage(paths.mountPoint).length === 0 && readdirSync(paths.mountPoint).length === 0) {
      // 挂上了、但卷根是空的：这是挂载问题（例如影像已被挂在别处），不是载荷问题。
      log(`${paths.mountPoint} mounted empty; falling back to opening the disk image`)
      detachImage(run, paths.mountPoint, log)
      mounted = false
      return { kind: 'fallback', reason: 'image-busy' }
    }
    const sourcePath = singleApplicationInImage(paths.mountPoint)
    const source = readMacAppIdentity(run, sourcePath)
    assertSameApplication(current, source, version)
    // 审计 A8：非本机架构的载荷装上去只会"换完起不来再回滚"，在这里就拒掉。
    assertImageSupportsCurrentArchitecture({
      sourcePath,
      executable: source.executable,
      currentArch: options.arch ?? process.arch,
      log,
    })
    // 空间判据在**挂载之后**（要先看到新副本有多大），但仍在**动用户文件之前**。
    if (!hasSpaceForUpdate(run, sourcePath, dirname(bundlePath))) {
      detachImage(run, paths.mountPoint, log)
      mounted = false
      return { kind: 'fallback', reason: 'insufficient-space' }
    }
    const sidecars = updateSidecarPaths(bundlePath, version)
    return {
      kind: 'prepared',
      plan: {
        bundlePath,
        mountPoint: paths.mountPoint,
        sourcePath,
        stagingPath: sidecars.stagingPath,
        backupPath: sidecars.backupPath,
        bundleIdentifier: current.identifier,
      },
    }
  } catch (cause) {
    if (mounted) detachImage(run, paths.mountPoint, log)
    try {
      rmdirSync(paths.mountPoint)
    } catch {
      // 同上：挂载点非空/仍挂着时不递归删。
    }
    throw cause
  }
}

/**
 * 把帮手脚本落盘并算出它的 argv。
 *
 * 脚本内容**不插值任何路径**（见 {@link macosUpdateHelperScript}）：路径一律走位置参数，
 * 于是 `/Applications/My App.app` 这类带空格、引号、`$` 的路径不需要转义，也不会被
 * shell 二次解释。这里只负责写文件与拼 argv。
 * @param options - 计划、私有目录、目标版本、宿主 pid，以及可选的等待/重启调参。
 * @returns 帮手脚本与 argv。
 */
export function writeMacosUpdateHelper(options: {
  readonly plan: MacosInPlaceUpdatePlan
  readonly userDataPath: string
  readonly version: string
  readonly pid: number
  readonly fromVersion: string
  /** 只在测试里用：见 {@link MacosUpdateHelperTuning}。生产一律用缺省。 */
  readonly tuning?: Partial<MacosUpdateHelperTuning>
}): MacosUpdateHelper {
  const paths = macosUpdatePaths(options.userDataPath)
  // 审计复核 F8：脚本名里带 pid（见下），所以 pid 必须是安全整数 —— 否则会拼出一个
  // 既逃过 `sweepMacosUpdateScripts`（只认 `\d+`）又不会被回收的文件名。
  if (!Number.isSafeInteger(options.pid) || options.pid <= 0) {
    throw new Error(`dsh-plugin-desktop: unsafe macOS update helper pid ${String(options.pid)}`)
  }
  mkdirSync(dirname(paths.scriptPath), { recursive: true })
  // 审计 N8：脚本名带 pid —— `/bin/sh`（bash 3.2）按偏移增量读脚本，固定名 + 覆盖重写
  // 会让**上一条仍在运行的**帮手读到错位内容或提前 EOF。唯一名把这条路径彻底避开。
  const scriptPath = join(dirname(paths.scriptPath), `apply-update-${String(options.pid)}.sh`)
  writeFileSync(scriptPath, macosUpdateHelperScript(options.tuning), { encoding: 'utf8', mode: 0o700 })
  return {
    scriptPath,
    command: '/bin/sh',
    args: [
      scriptPath,
      String(options.pid),
      options.plan.bundlePath,
      options.plan.sourcePath,
      options.plan.stagingPath,
      options.plan.backupPath,
      options.plan.mountPoint,
      paths.resultPath,
      paths.logPath,
      normalizeVersion(options.version),
      paths.bootMarkerPath,
      normalizeVersion(options.fromVersion),
      paths.bootFailurePath,
    ],
    resultPath: paths.resultPath,
    logPath: paths.logPath,
    bootMarkerPath: paths.bootMarkerPath,
  }
}

/**
 * detached 起帮手，并等到内核确认 spawn 成功。
 *
 * **必须等到 `spawn`**：宿主紧接着就要退出，若帮手还没起来就退出，用户会得到一个
 * "应用关了、什么都没发生、也没有重新打开"的现场。这正是 Windows 分支
 * （`launchWindowsUpdateInstaller`）已有的口径。
 * @param helper - {@link writeMacosUpdateHelper} 的返回值。
 * @param onLateError - spawn 成功**之后**的错误（比如刚起来就被杀）；只记日志。
 * @returns spawn 成功即 resolve。
 */
export async function spawnMacosUpdateHelper(
  helper: MacosUpdateHelper,
  onLateError: (error: Error) => void = () => {},
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(helper.command, [...helper.args], { detached: true, stdio: 'ignore', shell: false })
    } catch (cause) {
      reject(cause)
      return
    }
    const fail = (cause: Error): void => { reject(cause) }
    child.once('error', fail)
    child.once('spawn', () => {
      child.off('error', fail)
      child.once('error', onLateError)
      child.unref()
      resolve()
    })
  })
}

/**
 * 读应用包身份。
 * @param run - 命令边界。
 * @param bundlePath - `.app` 绝对路径。
 * @returns 身份四元组；`plutil` 读不到时抛错。
 */
export function readMacAppIdentity(run: MacosCommandRunner, bundlePath: string): MacAppIdentity {
  const raw = run('plutil', ['-convert', 'json', '-o', '-', join(bundlePath, 'Contents', 'Info.plist')])
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const identifier = typeof parsed.CFBundleIdentifier === 'string' ? parsed.CFBundleIdentifier : ''
  const version = typeof parsed.CFBundleShortVersionString === 'string' ? parsed.CFBundleShortVersionString : ''
  const executable = typeof parsed.CFBundleExecutable === 'string' ? parsed.CFBundleExecutable : ''
  if (identifier === '' || version === '' || executable === '') {
    throw new Error(`dsh-plugin-desktop: ${bundlePath} does not look like an application bundle`)
  }
  return { identifier, version, executable, teamIdentifier: readTeamIdentifier(run, bundlePath) }
}

/**
 * 读签名里的 TeamIdentifier。
 *
 * 未签名或临时签名（`codesign -s -`）会输出 `TeamIdentifier=not set`，命令也可能直接
 * 非零退出 —— 两种都返回 undefined，由调用方决定"没有 TeamID"算不算不合格
 * （见 {@link assertSameApplication}：只有**当前**应用有 TeamID 时才强制一致）。
 * @param run - 命令边界。
 * @param bundlePath - `.app` 绝对路径。
 * @returns TeamIdentifier，或 undefined。
 */
export function readTeamIdentifier(run: MacosCommandRunner, bundlePath: string): string | undefined {
  let output: string
  try {
    output = run('codesign', ['-dv', '--verbose=4', bundlePath])
  } catch {
    return undefined
  }
  const matched = /^TeamIdentifier=(.+)$/mu.exec(output)?.[1]?.trim()
  if (matched === undefined || matched === '' || matched === 'not set') return undefined
  return matched
}

/**
 * 从一个 Mach-O 文件头里读出它支持的架构（审计 A8）。
 *
 * 自己解析而不是调 `lipo`：`lipo` 属于 Xcode 命令行工具，**裸机 macOS 不保证有**
 * （docs/decisions 里已经为 `xcrun stapler` 记过同一类坑）。自己解析还带来一个好处 ——
 * 判据可以在 Linux 上喂合成文件头跑，不需要 mac 真机。
 * @param header - 文件开头若干字节（至少 8 字节；胖二进制需要覆盖各架构表项）。
 * @returns 架构名列表（`arm64` / `x86_64` / `i386` / `arm`）；认不出时为 undefined。
 */
export function machOArchitectures(header: Uint8Array): readonly string[] | undefined {
  if (header.byteLength < 8) return undefined
  const view = new DataView(header.buffer as ArrayBuffer, header.byteOffset, header.byteLength)
  const bigMagic = view.getUint32(0, false)
  const littleMagic = view.getUint32(0, true)
  // 胖（fat / universal）二进制：`0xcafebabe` 是大端写法，字段也按大端读；`0xbebafeca`
  // （FAT_CIGAM）是它的字节序镜像，字段按小端读。
  if (bigMagic === 0xcafebabe || bigMagic === 0xbebafeca) {
    const littleEndian = bigMagic === 0xbebafeca
    const count = view.getUint32(4, littleEndian)
    if (count > 64) return undefined
    const architectures: string[] = []
    for (let index = 0; index < count; index += 1) {
      const offset = 8 + index * 20
      if (offset + 4 > header.byteLength) break
      const name = MACHO_CPU_TYPES[view.getUint32(offset, littleEndian)]
      if (name !== undefined) architectures.push(name)
    }
    return architectures.length === 0 ? undefined : architectures
  }
  // 单架构（thin）二进制：magic 按文件自身字节序写，两种读法各命中一种。
  const littleEndian = littleMagic === 0xfeedfacf || littleMagic === 0xfeedface
  const bigEndian = bigMagic === 0xfeedfacf || bigMagic === 0xfeedface
  if (!littleEndian && !bigEndian) return undefined
  const name = MACHO_CPU_TYPES[view.getUint32(4, littleEndian)]
  return name === undefined ? undefined : [name]
}

/** 读一个可执行文件的架构；读不到/认不出时为 undefined。 */
export function readExecutableArchitectures(filename: string): readonly string[] | undefined {
  // 只读文件头（审计复核 P3）：`machOArchitectures` 最多需要 8 + 64×20 = 1288 字节，
  // 而 `readFileSync` 会把整个主可执行文件（Electron 上百 MB、且常在 DMG 冷缓存上）读进来。
  let handle: number | undefined
  try {
    handle = openSync(filename, 'r')
    const buffer = Buffer.alloc(4096)
    const read = readSync(handle, buffer, 0, buffer.byteLength, 0)
    return machOArchitectures(buffer.subarray(0, read))
  } catch {
    return undefined
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle)
      } catch {
        // 关不上没有后果：进程结束会回收。
      }
    }
  }
}

/**
 * 影像里的新版本必须支持**当前进程的架构**（审计 A8）。
 *
 * 判据取 `process.arch` 而不是 `uname -m`：后者在 Rosetta 下会报 `x86_64` 之外的东西，
 * 而真正决定"这份二进制能不能在这台机器上起来"的是当前进程的架构。
 * 读不出架构时**放行并记日志**：真正不兼容时随后的校验/启动会失败，而那条路径已经会回滚，
 * 拿不到架构就挡住更新反而是把可用用户关在门外。
 * @param options - 影像里的应用包、它的 `CFBundleExecutable`、当前进程架构、日志。
 */
export function assertImageSupportsCurrentArchitecture(options: {
  readonly sourcePath: string
  readonly executable: string
  readonly currentArch: string
  readonly log?: (message: string) => void
}): void {
  const log = options.log ?? (() => {})
  const expected = PROCESS_ARCH_TO_MACHO[options.currentArch]
  if (expected === undefined) return
  const filename = join(options.sourcePath, 'Contents', 'MacOS', options.executable)
  const architectures = readExecutableArchitectures(filename)
  if (architectures === undefined) {
    log(`could not read the architectures of ${filename}; skipping the architecture judgement`)
    return
  }
  if (!architectures.includes(expected)) {
    throw new Error(
      `dsh-plugin-desktop: the update image supports ${architectures.join(', ')}, not ${expected}`,
    )
  }
}

/**
 * 读"某版本原地安装失败过几次"（审计 A15）。
 * @param userDataPath - 应用私有目录。
 * @param version - 目标版本（已去 `v`）。
 * @returns 已失败次数；没有记录时为 0。
 */
export function readMacosUpdateFailureCount(userDataPath: string, version: string): number {
  const raw = readFailureLedger(userDataPath)
  const value = raw.get(normalizeVersion(version))
  return value === undefined || !Number.isFinite(value) ? 0 : value
}

/**
 * 记一次失败（审计 A15）。
 *
 * 刻意**不**在这里判上限，只记账：上限的判定在准备阶段（回落成"打开磁盘映像"），
 * 于是"记"与"判"各自只有一处，谁也不会漏。
 * @param userDataPath - 应用私有目录。
 * @param version - 目标版本（已去 `v`）。
 * @returns 记录后的失败次数。
 */
export function recordMacosUpdateFailure(userDataPath: string, version: string): number {
  const ledger = readFailureLedger(userDataPath)
  const key = normalizeVersion(version)
  const next = (ledger.get(key) ?? 0) + 1
  ledger.set(key, next)
  writeFailureLedger(userDataPath, ledger)
  return next
}

/**
 * 清掉某个版本的失败账（审计 A15）。
 *
 * 刻意**没有**"省略版本就清全账"的重载（审计复核 P3）：那种默认值一旦被漏传
 * （例如记录里少了 `toVersion`）就是**静默把退避机制删掉**。要清全账请显式调用
 * {@link clearAllMacosUpdateFailures}。
 * @param userDataPath - 应用私有目录。
 * @param version - 目标版本（已去 `v`）。
 */
export function clearMacosUpdateFailures(userDataPath: string, version: string): void {
  const ledger = readFailureLedger(userDataPath)
  ledger.delete(normalizeVersion(version))
  writeFailureLedger(userDataPath, ledger)
}

/** 清掉整本失败账（显式接口，见 {@link clearMacosUpdateFailures} 的说明）。 */
export function clearAllMacosUpdateFailures(userDataPath: string): void {
  writeFailureLedger(userDataPath, new Map())
}

/** 失败账本体：`<版本>=<次数>` 逐行（与结果文件同一种"人能看懂"的形态）。 */
function readFailureLedger(userDataPath: string): Map<string, number> {
  const ledger = new Map<string, number>()
  let raw: string
  try {
    raw = readFileSync(macosUpdatePaths(userDataPath).failuresPath, 'utf8')
  } catch {
    return ledger
  }
  for (const line of raw.split('\n')) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const value = Number.parseInt(line.slice(separator + 1), 10)
    if (!Number.isFinite(value) || value <= 0) continue
    ledger.set(line.slice(0, separator), value)
  }
  return ledger
}

/** 写失败账；写不了只记日志 —— 它是**诊断与退避**用的，不该成为更新的阻断点。 */
function writeFailureLedger(userDataPath: string, ledger: Map<string, number>): void {
  const path = macosUpdatePaths(userDataPath).failuresPath
  const body = [...ledger.entries()].map(([version, count]) => `${version}=${String(count)}`).join('\n')
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body === '' ? '' : `${body}\n`, 'utf8')
  } catch {
    // 见上：账本写不进去不影响这次更新。
  }
}

/**
 * 影像里的应用包：卷根下**有且只有一个** `.app`。
 *
 * electron-builder 的 DMG 卷根是 `<产品名>.app` + 指向 `/Applications` 的符号链接，
 * 因此必须用 `lstatSync` 判目录（`statSync` 会把那个符号链接也认成目录）。
 * @param mountPoint - 卷根绝对路径。
 * @returns 唯一的 `.app` 绝对路径。
 */
export function singleApplicationInImage(mountPoint: string): string {
  const applications = listApplicationsInImage(mountPoint)
  const only = applications[0]
  if (only === undefined) {
    throw new Error(`dsh-plugin-desktop: the update disk image contains no application bundle (${mountPoint})`)
  }
  if (applications.length > 1) {
    throw new Error(`dsh-plugin-desktop: the update disk image contains ${String(applications.length)} application bundles`)
  }
  return join(mountPoint, only)
}

/**
 * 卷根下的应用包名（**不抛错**的版本）。
 *
 * 分成两个函数是为了让调用方能区分"挂载有问题（卷根是空的）"与"载荷有问题
 * （有文件、但没有或有多个 `.app`）"—— 前者该回落，后者该拒（审计 A13）。
 * 必须用 `lstatSync` 判目录：`statSync` 会把 electron-builder 放在卷根的
 * 「指向 /Applications 的符号链接」也认成目录。
 * @param mountPoint - 卷根绝对路径。
 * @returns `.app` 目录名列表（不含路径前缀）。
 */
export function listApplicationsInImage(mountPoint: string): readonly string[] {
  const entries = readdirSync(mountPoint)
  return entries.filter((entry) => {
    if (!entry.endsWith('.app')) return false
    try {
      return lstatSync(join(mountPoint, entry)).isDirectory()
    } catch {
      return false
    }
  })
}

/**
 * 影像里的应用必须与当前应用**同身份、期待版本、同签名团队**。
 * @param current - 正在运行的应用包身份。
 * @param source - 影像里的应用包身份。
 * @param expectedVersion - 清单声明的目标版本（已去 `v`）。
 */
export function assertSameApplication(
  current: MacAppIdentity,
  source: MacAppIdentity,
  expectedVersion: string,
): void {
  if (source.identifier !== current.identifier) {
    throw new Error(
      `dsh-plugin-desktop: the update image holds ${source.identifier}, not ${current.identifier}`,
    )
  }
  if (source.version !== normalizeVersion(expectedVersion)) {
    throw new Error(
      `dsh-plugin-desktop: the update image holds ${source.version}, expected ${normalizeVersion(expectedVersion)}`,
    )
  }
  // TeamIdentifier 是这一层唯一真正的**来源**判据（codesign --verify 对自签/临时签名
  // 同样通过）。只有当前应用**有** TeamID 时才强制一致 —— 开发版/临时签名的应用
  // 本来就取不到 TeamID，不能因此把开发流程堵死。
  if (current.teamIdentifier !== undefined && source.teamIdentifier !== current.teamIdentifier) {
    throw new Error(
      `dsh-plugin-desktop: the update image is signed by ${source.teamIdentifier ?? 'no team'}, not ${current.teamIdentifier}`,
    )
  }
}

/**
 * 暂存/备份路径：与目标**同目录**，因此 `mv` 是同卷 rename（原子、瞬间完成）。
 *
 * 用点开头是为了不在「应用程序」里多出两个可见图标（替换过程中它们只存在几秒）。
 * @param bundlePath - 当前应用包绝对路径。
 * @param version - 目标版本（已去 `v`）。
 * @returns 暂存与备份路径。
 */
export function updateSidecarPaths(
  bundlePath: string,
  version: string,
): { readonly stagingPath: string; readonly backupPath: string } {
  const directory = dirname(bundlePath)
  const name = basename(bundlePath)
  return {
    stagingPath: join(directory, `.${name}.update-${normalizeVersion(version)}.app`),
    backupPath: join(directory, `.${name}.backup-${normalizeVersion(version)}.app`),
  }
}

/**
 * 清掉上一次留下的暂存件/备份/挂载点。
 *
 * 幂等、只碰**同目录下点开头的自家命名**，因此不会误删用户的任何东西。宿主启动时与
 * 准备阶段各调一次：崩在半路的更新不该在「应用程序」里留下永久垃圾，也不该让下一次
 * 挂载因为挂载点非空而失败。
 * @param bundlePath - 当前应用包绝对路径。
 * @param mountPoint - 影像挂载点（残留时先卸载）。
 * @param run - 命令边界（用于卸载残留挂载点）。
 * @param log - 诊断输出。
 */
export function clearMacosUpdateLeftovers(
  bundlePath: string,
  mountPoint: string,
  run: MacosCommandRunner,
  log: (message: string) => void = () => {},
  options: { readonly keep?: string; readonly scriptDirectory?: string } = {},
): void {
  // 挂载点不存在 ⇒ 上一次根本没有挂过影像：不要每次启动都去 spawn 一个 `hdiutil`
  // 并记一行"卸载失败"的假错误（这条路径在每个 macOS 进程的启动路径上）。
  if (existsSync(mountPoint)) detachImage(run, mountPoint, log)
  const directory = dirname(bundlePath)
  const prefix = `.${basename(bundlePath)}.`
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    // 只删「本应用的暂存/备份」这一种形状：
    //   .<名字>.update-<版本>.app / .<名字>.backup-<版本>.app
    // 以及回滚失败时留下的 `…update-<版本>.app.broken`（审计 A4：原先的正则要求以 `.app`
    // **结尾**，于是 `.broken` 那种残留永远不会被清掉，会一直占着 ~400MB 留在「应用程序」里）。
    if (!/\.(?:update|backup)-[^/]+\.app(?:\.broken)?$/u.test(entry)) continue
    const absolute = join(directory, entry)
    // 审计 A2：上一次失败要报给用户的那个备份必须留下 —— 通报里点名了它的路径。
    if (options.keep !== undefined && absolute === options.keep) {
      log(`kept the backup ${entry} for the pending failure report`)
      continue
    }
    // 占用判据**只有这一处**（审计复核 P1）：备份件上还有进程在跑就不删。
    // 原来只有 `removeMacosUpdateBackup` 里查占用，而清理发生在那之前 ——
    // 于是"帮手故意留下备份"（多用户/多实例）在下一次启动就被这里无条件删掉，
    // 保护等于没有。`.update-*` / `.broken` 是纯垃圾，不查占用。
    if (/\.backup-/u.test(entry) && isBundleInUse(run, absolute)) {
      log(`kept the backup ${entry}: a process is still running from it`)
      continue
    }
    try {
      rmSync(absolute, { recursive: true, force: true })
      log(`removed leftover ${entry}`)
    } catch {
      // 删不掉不是错误：它只占空间，不影响这次更新。
    }
  }
  sweepMacosUpdateScripts(options.scriptDirectory, log)
}

/**
 * 清掉历次留下的帮手脚本（审计 N8 的配套）。
 *
 * 脚本名现在带 pid（`apply-update-<pid>.sh`），因此每次更新都会多一个小文件。
 * 在这里回收：删掉正在运行的脚本也不会打断它（POSIX 下 unlink 只摘目录项，
 * 已打开的 inode 继续有效），所以这条清理对"上一条帮手还在跑"同样安全。
 * @param scriptDirectory - 脚本所在目录；未给时跳过。
 * @param log - 诊断输出。
 */
export function sweepMacosUpdateScripts(scriptDirectory: string | undefined, log: (message: string) => void = () => {}): void {
  if (scriptDirectory === undefined) return
  let entries: string[]
  try {
    entries = readdirSync(scriptDirectory)
  } catch {
    return
  }
  for (const entry of entries) {
    // 带 pid 的新名（`apply-update-<pid>.sh`）与改造前的固定名（`apply-update.sh`）都收：
    // 固定名是旧版本留下的，不一起清就会一直躺在用户的更新目录里。
    if (!/^apply-update(?:-\d+)?\.sh$/u.test(entry)) continue
    try {
      unlinkSync(join(scriptDirectory, entry))
      log(`removed stale helper script ${entry}`)
    } catch {
      // 同上：删不掉不影响这次更新。
    }
  }
}

/**
 * 尽力卸载影像（失败只记日志：残留挂载点会被下一次准备阶段清掉）。
 *
 * 挂载点**根本不存在**时直接跳过：这不是"卸载失败"。真机上就有这一条噪声路径 ——
 * 准备阶段在 `assertSameApplication` 上拒掉一个版本不符的安装包时先抛错，`finally`
 * 里的清理再去 detach 那个已经被 `hdiutil attach` 自己回收掉（或压根没建起来）的挂载点，
 * 日志里就会多出一行 `hdiutil: detach failed - 无此文件或目录`，看起来像更新坏了。
 */
export function detachImage(run: MacosCommandRunner, mountPoint: string, log: (message: string) => void = () => {}): void {
  if (!existsSync(mountPoint)) return
  try {
    run('hdiutil', ['detach', mountPoint])
  } catch (cause) {
    // 竞态下"刚好被别人卸载掉"同样不是错误：判据是挂载点还在不在，不是 detach 的退出码。
    if (!existsSync(mountPoint)) return
    log(`could not detach ${mountPoint}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/**
 * 写启动标记：新版启动时**第一件事**。
 *
 * 帮手脚本在替换完成后等这个文件（并核对里面的版本号）才承认"更新成功"，等不到就回滚。
 * 标记必须在新版进程的启动路径上尽早写：越晚写，帮手等待窗口越可能误判成"没起来"。
 * @param userDataPath - `app.getPath('userData')`。
 * @param version - 当前运行版本。
 * @param stamp - 时间戳（便于诊断）。
 */
export function writeMacosUpdateBootMarker(userDataPath: string, version: string, bundlePath: string, stamp: string): string | undefined {
  const paths = macosUpdatePaths(userDataPath)
  // 审计复核：标记里必须带 `bundle=`。只认版本号的话，**同版本的另一份副本**
  // （DMG 里那份、下载目录里的拷贝）或 `yarn dev` 都能写出一条"看起来对"的标记；
  // 带上 bundle 路径并要求帮手比对，才把"是**这一份**应用起来了"钉住。
  return writeUpdateMarker(paths.bootMarkerPath, [
    `version=${normalizeVersion(version)}`,
    `bundle=${bundlePath}`,
    `at=${stamp}`,
  ])
}

/**
 * 写**负向**标记：新版在启动路径上致命失败时调用（审计复核 P1）。
 *
 * 与 {@link writeMacosUpdateBootMarker} 同一形状（版本 + bundle + 时间），但语义相反：
 * 帮手看到"版本与 bundle 都命中"的负向标记时**不承认成功**，走回滚。
 * 写失败同样只返回原因（这条路径本身已经在处理致命错误，不能再抛）。
 * @param userDataPath - 应用私有目录。
 * @param version - 当前运行版本。
 * @param bundlePath - 当前应用包路径（不是 `.app` 时为 `''`）。
 * @param stamp - 时间戳（诊断用）。
 * @returns 出错原因；成功时 undefined。
 */
export function writeMacosUpdateBootFailureMarker(
  userDataPath: string,
  version: string,
  bundlePath: string,
  stamp: string,
): string | undefined {
  const paths = macosUpdatePaths(userDataPath)
  return writeUpdateMarker(paths.bootFailurePath, [
    `version=${normalizeVersion(version)}`,
    `bundle=${bundlePath}`,
    `at=${stamp}`,
  ])
}

/** 写一个 `key=value` 标记文件；写不成返回原因（两个标记共用）。 */
function writeUpdateMarker(path: string, lines: readonly string[]): string | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
    return undefined
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
}

/**
 * 读结果文件。
 * @param userDataPath - `app.getPath('userData')`。
 * @returns 记录；没有文件或文件损坏时为 undefined。
 */
export function readMacosUpdateRecord(userDataPath: string): MacosUpdateRecord | undefined {
  const paths = macosUpdatePaths(userDataPath)
  let raw: string
  try {
    raw = readFileSync(paths.resultPath, 'utf8')
  } catch {
    return undefined
  }
  const fields = new Map<string, string>()
  for (const line of raw.split('\n')) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    fields.set(line.slice(0, separator), line.slice(separator + 1))
  }
  const status = fields.get('status')
  const version = fields.get('version')
  if (status !== 'ok' && status !== 'failed' && status !== 'running') return undefined
  if (version === undefined || version === '') return undefined
  return {
    status,
    phase: fields.get('phase') ?? '',
    reason: fields.get('reason') ?? '',
    fromVersion: fields.get('from') ?? '',
    toVersion: version,
    targetPath: fields.get('target') ?? '',
    backupPath: fields.get('backup') ?? '',
    logPath: fields.get('log') ?? '',
  }
}

/** 删掉结果文件（一次更新只提示一次）。 */
export function clearMacosUpdateRecord(userDataPath: string): void {
  try {
    unlinkSync(macosUpdatePaths(userDataPath).resultPath)
  } catch {
    // 已经不在（或没有权限）都没关系：提示一次就够，重复提示才是问题。
  }
}

/**
 * 把结果文件翻译成**本次启动**该做的事。
 *
 * 判据是"记录的**目标版本**是不是就是当前运行的版本"，而不是记录里的状态码：
 * - 目标是当前版本 ⇒ 更新已经生效（无论帮手有没有走到最后一步）⇒ 删备份、清记录；
 * - 目标不是当前版本、记录说 `failed`/`running` ⇒ 没生效（回滚了或帮手被杀了）
 *   ⇒ 报一次失败、清记录、**保留备份**（用户/支持还可以手工换回去）；
 * - 目标不是当前版本、记录说 `ok` ⇒ 换过一次又被人手动降级，静默清记录。
 * @param userDataPath - `app.getPath('userData')`。
 * @param currentVersion - 当前运行版本。
 * @returns 结论；没有记录时为 undefined。
 */
export function readMacosUpdateOutcome(
  userDataPath: string,
  currentVersion: string,
): MacosUpdateOutcome | undefined {
  const record = readMacosUpdateRecord(userDataPath)
  if (record === undefined) return undefined
  const current = normalizeVersion(currentVersion)
  if (record.toVersion === current) {
    return { kind: 'applied', toVersion: record.toVersion, backupPath: record.backupPath, logPath: record.logPath }
  }
  if (record.status === 'failed' || record.status === 'running') return { kind: 'failed', record }
  return { kind: 'applied', toVersion: record.toVersion, backupPath: '', logPath: record.logPath }
}

/**
 * 删掉备份目录（更新被当前版本确认之后才调用）。
 *
 * 审计 A10：**删除前先看有没有进程还在备份件上跑**。多用户 Mac 上另一个账号可能正跑着
 * 被换下来的那一份（单实例锁是按 userData 隔离的，挡不住跨账号实例），删掉正在使用的
 * bundle 会让那个进程变成"文件已删"的幽灵。有占用就留给下次启动的清理再收。
 * @param backupPath - 备份目录绝对路径。
 * @param log - 诊断输出。
 * @param run - 命令边界（`pgrep`）；缺省 = 真实 `spawnSync`。
 */
export function removeMacosUpdateBackup(
  backupPath: string,
  log: (message: string) => void = () => {},
  run: MacosCommandRunner = runMacosCommand,
): void {
  if (backupPath === '') return
  if (isBundleInUse(run, backupPath)) {
    log(`kept the backup ${backupPath}: a process is still running from it`)
    return
  }
  try {
    rmSync(backupPath, { recursive: true, force: true })
  } catch (cause) {
    log(`could not remove the update backup ${backupPath}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/**
 * 有没有进程正在从某个 bundle 里跑。
 *
 * 用 `pgrep -f "<bundle>/Contents/MacOS/"` 取"命令行里提到这个 bundle 的主程序目录"的进程。
 * `Contents/MacOS/` 前缀足够精确 —— Electron 的 helper 子进程跑在 `Contents/Frameworks/…`
 * 下，不会误命中。
 *
 * 两条口径（都是审计复核定的）：
 * - **模式要转义**：`pgrep -f` 收的是 ERE，而 bundle 路径里可能出现 `.`、`(`、`[` 这类
 *   元字符（应用名来自渠道配置，本仓管不到）。不转义时 `.` 会通配（把
 *   `…backup-2X8X3.app` 判成本 bundle），未配对的括号更会让 `pgrep` 以退出码 2 失败。
 * - **方向 fail-closed**：只有 `pgrep` 明确回答"没匹配"（退出码 1）才算没人占用；
 *   其它失败（`pgrep` 不存在、非法模式、被信号打断）一律按**占用**处理 —— 删掉正在运行的
 *   bundle 会让那个进程变成"文件已删"的幽灵，而留着备份只是多占一点磁盘。
 * @param run - 命令边界。
 * @param bundlePath - 应用包绝对路径。
 * @returns 是否有进程在跑。
 */
export function isBundleInUse(run: MacosCommandRunner, bundlePath: string): boolean {
  try {
    run('pgrep', ['-f', escapeForPgrep(`${bundlePath}/Contents/MacOS/`)])
    return true
  } catch (cause) {
    return !(cause instanceof MacosCommandFailure && cause.status === 1)
  }
}

/** 把一段字面文本转成 `pgrep -f`（ERE）里的字面模式。 */
export function escapeForPgrep(literal: string): string {
  return literal.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')
}

/** 去掉前导 `v`（清单里的版本两种形态都出现过）。 */
export function normalizeVersion(version: string): string {
  return version.replace(/^v/u, '')
}

/** 目录可写判据（不存在或不可写都算"不能动"）。 */
function isWritableDirectory(path: string): boolean {
  try {
    accessSync(path, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 目标卷剩余空间是否够放"新的一份应用"。
 *
 * 换掉旧包**之前**必须先有这个新副本，所以判据是"剩余 ≥ 新副本大小"，不是"剩余 ≥ 增量"。
 * 算不出来（`du`/`statfs` 形态意外）时**放行**：宁可让 `ditto` 用真实的 ENOSPC 失败
 * （那条路径会回滚并留日志），也不要因为解析不到数字就把原本能更新的用户挡在门外。
 * @param run - 命令边界。
 * @param sourcePath - 影像里的应用包。
 * @param targetDirectory - 目标所在目录（暂存件也落在这里）。
 * @returns 余量是否够。
 */
export function hasSpaceForUpdate(
  run: MacosCommandRunner,
  sourcePath: string,
  targetDirectory: string,
): boolean {
  const used = parseKilobytes(run('du', ['-sk', sourcePath]))
  if (used === undefined) return true
  let available: number | undefined
  try {
    const stats = statfsSync(targetDirectory)
    available = (stats.bavail * stats.bsize) / 1024
  } catch {
    available = undefined
  }
  if (available === undefined) return true
  // 5% 余量给 ditto 的元数据/资源叉，另加 64 MiB 防止把卷写到满。
  return available >= used * 1.05 + 65_536
}

/** `du -sk` 输出首列的 KB 数。 */
function parseKilobytes(output: string): number | undefined {
  const first = output.trim().split(/\s+/u)[0]
  if (first === undefined) return undefined
  const value = Number.parseInt(first, 10)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * 帮手脚本的调参面。
 *
 * 三项都是**进程外部边界**，生产恒取下面的三个缺省常量；只有测试会传别的值，
 * 目的是让整条替换流程能在"不真的启动一个应用、不等满 30 秒"的前提下跑完
 * （`tests/macos-update-helper.integration.spec.ts`）。
 */
export interface MacosUpdateHelperTuning {
  /** 替换完成后重新打开应用用的命令（绝对路径）。 */
  readonly relaunchCommand: string
  /** 等宿主退出的滴答数（1 滴答 = 0.5s）。 */
  readonly exitWaitTicks: number
  /** 等新版本写启动标记的滴答数（1 滴答 = 0.5s）。 */
  readonly bootWaitTicks: number
}

/**
 * 帮手脚本本体：**路径零插值**，只有三个调参走白名单校验后的逐字替换。
 *
 * 位置参数（宿主按此顺序以 argv 传入）：
 * ```
 * $1  宿主 pid（等它退出，上限见 `exitWaitTicks`）
 * $2  当前应用包（要被替换的那一个）
 * $3  影像里的新应用包
 * $4  暂存路径（与 $2 同目录 ⇒ 同卷 ⇒ mv 是原子 rename）
 * $5  旧包备份路径（与 $2 同目录）
 * $6  影像挂载点
 * $7  结果文件
 * $8  日志文件
 * $9  目标版本
 * $10 启动标记文件
 * $11 更新前版本
 * $12 负向标记文件（新版报告致命启动失败时写；帮手先看它再决定承不承认成功）
 * ```
 *
 * 规矩：外部命令一律写绝对路径（帮手继承的环境不保证 PATH 完好）；每一步失败都先
 * "把用户的东西恢复原状"再写结果；**不动用户文件之前先校验签名**。
 * @param tuning - 调参（缺省 = 生产值）。
 * @returns 可直接落盘的 `/bin/sh` 脚本全文。
 */
export function macosUpdateHelperScript(tuning: Partial<MacosUpdateHelperTuning> = {}): string {
  const relaunch = tuning.relaunchCommand ?? DEFAULT_RELAUNCH_COMMAND
  const exitTicks = tuning.exitWaitTicks ?? DEFAULT_EXIT_WAIT_TICKS
  const bootTicks = tuning.bootWaitTicks ?? DEFAULT_BOOT_WAIT_TICKS
  // 这三项会**逐字进脚本**（其余路径都走位置参数），因此先按白名单校验：命令必须是
  // 绝对路径且只含安全字符，两个等待必须是正整数。校验失败即抛 —— 生产用的是下面
  // 三个常量，只有测试会传值，所以这条断言实际上是"测不了坏的脚本"的保证。
  if (!/^\/[A-Za-z0-9._/-]+$/u.test(relaunch)) {
    throw new Error(`dsh-plugin-desktop: unsafe macOS update relaunch command ${relaunch}`)
  }
  if (!Number.isInteger(exitTicks) || exitTicks <= 0 || !Number.isInteger(bootTicks) || bootTicks <= 0) {
    throw new Error('dsh-plugin-desktop: macOS update wait budgets must be positive integers')
  }
  const script = HELPER_TEMPLATE
    .replaceAll('@@RELAUNCH@@', relaunch)
    .replaceAll('@@EXIT_WAIT_TICKS@@', String(exitTicks))
    .replaceAll('@@EXIT_WAIT_SECONDS@@', String(Math.round(exitTicks / 2)))
    .replaceAll('@@BOOT_WAIT_TICKS@@', String(bootTicks))
    .replaceAll('@@BOOT_WAIT_SECONDS@@', String(Math.round(bootTicks / 2)))
  // fail-closed：模板里新增占位符却忘了替换 ⇒ 脚本里会留下 `@@…@@`。宁可在生成处当场
  // 抛错，也不要落一个半成品脚本到用户的更新目录里（`replaceAll` 漏一个就是这种形态）。
  if (script.includes('@@')) throw new Error('dsh-plugin-desktop: the macOS update helper template has an unreplaced placeholder')
  return script
}

/** 生产的重启命令（`open <app>` 交给 LaunchServices，能处理已经运行/已注册的情形）。 */
export const DEFAULT_RELAUNCH_COMMAND = '/usr/bin/open'

/** 等宿主退出的上限（单位 = 0.5s 滴答，240 ⇒ 120s）。 */
export const DEFAULT_EXIT_WAIT_TICKS = 240

/** 等新版本写启动标记的上限（单位 = 0.5s 滴答，60 ⇒ 30s）。 */
export const DEFAULT_BOOT_WAIT_TICKS = 60

const HELPER_TEMPLATE = `#!/bin/sh
# PicoAide Harness macOS 原地更新帮手。
# 由宿主在退出前用 detached 方式拉起（/bin/sh <脚本> <参数…>），宿主退出后由 launchd 收留。
# 参数见宿主侧 macosUpdateHelperScript 的文档；脚本内**不插值任何路径**。
# 退出码：0 = 已替换并确认启动；1 = 未替换（旧版本已重新打开或仍在运行）。
set -u

PID="$1"
TARGET="$2"
SOURCE="$3"
STAGING="$4"
BACKUP="$5"
MOUNT="$6"
RESULT="$7"
LOG_FILE="$8"
VERSION="$9"
BOOT_FILE="\${10}"
FROM_VERSION="\${11}"
BOOT_FAIL_FILE="\${12}"

log() { /usr/bin/printf '%s %s\\n' "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG_FILE" 2>/dev/null || true; }
record() {
  # $1=status $2=phase $3=reason
  /usr/bin/printf 'status=%s\\nphase=%s\\nreason=%s\\nversion=%s\\nfrom=%s\\ntarget=%s\\nbackup=%s\\nlog=%s\\n' \\
    "$1" "$2" "$3" "$VERSION" "$FROM_VERSION" "$TARGET" "$BACKUP" "$LOG_FILE" > "$RESULT" 2>/dev/null || true
}
relaunch() { @@RELAUNCH@@ "$1" >/dev/null 2>&1 || true; }

# 正标记是否**同时**命中版本与 bundle（审计复核 P1：只认版本号会被同版本的另一份
# 副本或 yarn dev 伪造；bundle= 那一行把"是这一份应用起来了"钉住）。
# 两条 grep 都是 -qxF（整行、定串）：审计 A1 —— 子串匹配会被版本号前缀吃掉
# （目标 2.8.3 命中标记里的 2.8.3-beta.1 / 2.8.3-beta.10），于是"别的版本的标记"
# 被当成新版起来了，备份随即被删、回滚能力一起消失。
boot_marker_confirms() {
  [ -f "$BOOT_FILE" ] || return 1
  /usr/bin/grep -qxF "version=$VERSION" "$BOOT_FILE" 2>/dev/null || return 1
  /usr/bin/grep -qxF "bundle=$TARGET" "$BOOT_FILE" 2>/dev/null || return 1
  return 0
}
# 新版**自己报告**了致命启动失败（审计复核 P1）：命中的话立刻回滚，绝不承认成功 ——
# 否则"进程起来了但根本不是可用应用"会被当成更新成功，还会删掉唯一的备份。
boot_failed() {
  [ -f "$BOOT_FAIL_FILE" ] || return 1
  /usr/bin/grep -qxF "version=$VERSION" "$BOOT_FAIL_FILE" 2>/dev/null || return 1
  /usr/bin/grep -qxF "bundle=$TARGET" "$BOOT_FAIL_FILE" 2>/dev/null || return 1
  return 0
}

# 收尾：任何出口都 (1) 补回缺失的目标（两次 mv 之间被杀）(2) 卸载影像（审计 A5/A6）。
# SIGKILL 与断电不在此列 —— 那条路径没有可靠的自救手段，已在决策文档的"认账"里写明。
cleanup() {
  if [ ! -e "$TARGET" ] && [ -e "$BACKUP" ]; then
    /bin/mv "$BACKUP" "$TARGET" 2>/dev/null || true
  fi
  /usr/bin/hdiutil detach "$MOUNT" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP

record running waiting ""
log "helper start: pid=$PID version=$VERSION target=$TARGET"

# 1) 等宿主退出。@@EXIT_WAIT_TICKS@@ × 0.5s = @@EXIT_WAIT_SECONDS@@s 上限：超时就什么都不动
# （应用还在跑，替换它会把正在运行的那个换瘸）。
waited=0
while /bin/kill -0 "$PID" 2>/dev/null; do
  if [ "$waited" -ge @@EXIT_WAIT_TICKS@@ ]; then
    log "host $PID did not exit within @@EXIT_WAIT_SECONDS@@s; giving up without touching any file"
    record failed waiting application-still-running
    exit 1
  fi
  /bin/sleep 0.5
  waited=$((waited + 1))
done
log "host exited after \${waited} x 0.5s"

# 2) 复制新版本到暂存路径（与目标同目录 ⇒ 之后是原子 rename）。
record running staging ""
/bin/rm -rf "$STAGING" "$BACKUP" >>"$LOG_FILE" 2>&1 || true
if ! /usr/bin/ditto --noqtn "$SOURCE" "$STAGING" >>"$LOG_FILE" 2>&1; then
  log "copy failed: $SOURCE -> $STAGING"
  /bin/rm -rf "$STAGING" >>"$LOG_FILE" 2>&1 || true
  record failed staging copy-failed
  relaunch "$TARGET"
  exit 1
fi

# 3) 校验暂存件（主程序 + 密封资源）。这一步不过，绝不动用户正在用的那个包。
record running verifying ""
if ! /usr/bin/codesign --verify --strict "$STAGING" >>"$LOG_FILE" 2>&1; then
  log "staged bundle failed code signature verification"
  /bin/rm -rf "$STAGING" >>"$LOG_FILE" 2>&1 || true
  record failed verifying verification-failed
  relaunch "$TARGET"
  exit 1
fi

# 4) 落位：旧包改名成备份（可回滚），暂存件原子改名成应用。
record running swapping ""
if ! /bin/mv "$TARGET" "$BACKUP" >>"$LOG_FILE" 2>&1; then
  log "could not move the current bundle aside"
  /bin/rm -rf "$STAGING" >>"$LOG_FILE" 2>&1 || true
  record failed swapping swap-failed
  relaunch "$TARGET"
  exit 1
fi
if ! /bin/mv "$STAGING" "$TARGET" >>"$LOG_FILE" 2>&1; then
  log "could not move the new bundle into place; restoring the backup"
  /bin/mv "$BACKUP" "$TARGET" >>"$LOG_FILE" 2>&1 || true
  /bin/rm -rf "$STAGING" >>"$LOG_FILE" 2>&1 || true
  record failed swapping rollback-restored
  relaunch "$TARGET"
  exit 1
fi
log "replaced $TARGET"
/usr/bin/xattr -dr com.apple.quarantine "$TARGET" >>"$LOG_FILE" 2>&1 || true
# 两个标记都在**重开应用之前**删掉：这样"等到的标记"只可能是本次启动写的，
# 上一次留下的（正的或负的）都骗不过这一次（审计复核 P1）。
/bin/rm -f "$BOOT_FILE" "$BOOT_FAIL_FILE" >>"$LOG_FILE" 2>&1 || true

# 5) 先把新版本打开，再收尾（卸载影像）。顺序有讲究：卸载影像可能是秒级，而用户此刻
#    正盯着"应用已经关了"的空白期 —— 让他先看到图标在跳，而不是白等。
relaunch "$TARGET"
# LaunchServices 的注册是**异步**的（审计 N1），显式重注册一次。放在 relaunch **之后**：
# 它是同步阻塞的（审计复核 F6），排在前面会把"重新打开应用"推迟。跳过与失败都记一行日志
# （与 A14 的"不再静默"同口径）。
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -f "$TARGET" >>"$LOG_FILE" 2>&1 || log "lsregister failed for $TARGET (the app was already reopened)"
else
  log "lsregister is not available at $LSREGISTER; relying on open to register $TARGET"
fi
/usr/bin/hdiutil detach "$MOUNT" >>"$LOG_FILE" 2>&1 || true
waited=0
confirmed=0
while [ "$waited" -lt @@BOOT_WAIT_TICKS@@ ]; do
  # 负向标记优先，而且**不等满窗口**：新版自己说了"我起不来"就立刻回滚。
  if boot_failed; then
    log "the new version reported a fatal startup failure; rolling back"
    break
  fi
  if boot_marker_confirms; then
    confirmed=1
    log "boot marker confirms version $VERSION"
    break
  fi
  /bin/sleep 0.5
  waited=$((waited + 1))
done

if [ "$confirmed" -eq 1 ]; then
  # **不在这里删备份**（审计复核 P1）：pgrep 只是命令行文本匹配 —— 把 TARGET 改名成
  # BACKUP 之后，一个**旧实例**的 argv 仍然是 TARGET/Contents/MacOS/…，脚本侧的占用判据
  # （无论怎么写）都可能把它判成"没人占用"，于是删掉的正是那个正在运行的实例的文件。
  # 删除点收敛到**宿主侧唯一一处**：settleMacosUpdate 的 removeMacosUpdateBackup
  # （fail-closed 的 isBundleInUse，且能对模式做转义）。
  record ok done ""
  log "version $VERSION confirmed running; the backup is left for the host to reclaim"
  exit 0
fi

# 6) 新版没起来（标记没有、目标下的主程序也没在跑）：把新包挪开、备份换回原位、重开旧版本。
log "version $VERSION did not start within @@BOOT_WAIT_SECONDS@@s; rolling back"
BROKEN="$STAGING.broken"
if /bin/mv "$TARGET" "$BROKEN" >>"$LOG_FILE" 2>&1 && /bin/mv "$BACKUP" "$TARGET" >>"$LOG_FILE" 2>&1; then
  /bin/rm -rf "$BROKEN" >>"$LOG_FILE" 2>&1 || true
  record failed rolling-back application-did-not-start
  relaunch "$TARGET"
  exit 1
fi
# 走到这里说明两次 mv 里至少有一次没成：目标可能已经不在原位，备份仍在 $BACKUP。
log "rollback failed: $TARGET is missing or the backup could not be moved back (backup kept at $BACKUP)"
record failed rolling-back rollback-failed
exit 1
`

/** 生产脚本（缺省调参下的 {@link macosUpdateHelperScript} 结果）。 */
export const MACOS_UPDATE_HELPER_SOURCE = macosUpdateHelperScript()
