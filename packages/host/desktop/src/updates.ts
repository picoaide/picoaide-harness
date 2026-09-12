/** Cordis Host plugin for scheduled and interactive PicoAide Harness updates. */

import { open } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import z from '@deepseek-ai/schemastery'
import type { DesktopUpdateSource, UpdateDownloadProgressSnapshot } from './runtime.ts'
import { desktopTrayLabel } from './tray-locale.ts'
import {
  updateRetryDelayMs,
  type DesktopUpdateErrorCategory,
  type UpdateRetryPolicy,
} from './desktop-update-contract.ts'
import {
  CHANNEL_ID_PATTERN,
  serverChannelURL,
  serverManifestURL,
  type DesktopReleaseManifest,
} from './desktop-release.ts'
import {
  fetchReleaseManifestDetailed,
  isRetriableManifestOutcome,
  parseSemVer,
  type UpdateCheckResult,
} from './update-checker.ts'
import {
  resolveUpdateInstaller,
  UpdateDownloadError,
} from './update-download.ts'

/**
 * 会话变化事件（由 `@picoaide/dsh-enterprise` 的 session-service 发出）。
 *
 * 这里自行声明而不是 import enterprise 的类型:本包的 tsconfig 只包含
 * `src/*.ts`，不引入 enterprise 的类型，因此同名增强不会冲突；运行时契约
 * 靠事件名字符串，与 `packages/host/cron/src/index.ts` 的既有做法同源。
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'pico/session-changed'(session: { serverURL?: string } | null): void
  }
}

/** Stable Cordis plugin name. */
export const name = 'desktop-updates'

/** Native adapter required for network, tray, confirmation, and installer access. */
export const inject = ['desktopRuntime']

const MAX_TIMER_DELAY_MS = 2_147_483_647
const MAX_STATE_BYTES = 4 * 1024

/**
 * 一次检查(清单请求)的缺省重试节奏:三次尝试共约 1.2 分钟。
 *
 * 足以吞掉一次网络抖动或服务端重启,又不会让"检查更新"卡到用户以为程序没反应。
 * 清单请求本身另有 `requestTimeoutMs` 的单次超时。
 */
const DEFAULT_CHECK_RETRY_DELAYS_MS: number[] = [2_000, 8_000, 20_000]

/**
 * 一次安装包传输的缺省重试节奏:五次尝试、更长的退避。
 *
 * 安装包是几百 MB 的长传输,比清单更容易被中途切断。重试是**续传**而不是从零
 * 开始(见 `update-download.ts`),因此失败一次不会浪费已经下到的字节。
 */
const DEFAULT_TRANSFER_RETRY_DELAYS_MS: number[] = [2_000, 8_000, 20_000, 30_000, 30_000]

/** 退避抖动比例的缺省值:确定性抖动,只用于避免所有客户端同一毫秒重试。 */
const DEFAULT_RETRY_JITTER_RATIO = 0.25

/** Download failure codes that survive to the UI unchanged (P2-63). */
const DOWNLOAD_ERROR_CATEGORIES: ReadonlySet<string> = new Set([
  'network',
  'release-missing',
  'checksum-mismatch',
  'invalid-artifact',
])

/** Scheduled update policy. */
export interface Config {
  /** Enable background checks in packaged applications. */
  enabled: boolean
  /** Download a discovered update in the background before asking the user anything. */
  backgroundDownload: boolean
  /** Delay before the first background check after plugin activation. */
  initialDelayMs: number
  /** Delay between completion of one background check and the next attempt. */
  intervalMs: number
  /** Maximum duration of one version request before caller-owned cancellation. */
  requestTimeoutMs: number
  /**
   * Backoff before each manifest-check retry, in milliseconds (index 0 = after the
   * first failure). The list length also sets the attempt budget: one initial
   * attempt plus one retry per entry.
   */
  checkRetryDelaysMs: number[]
  /** Backoff before each installer-transfer retry; the list length is the retry budget. */
  transferRetryDelaysMs: number[]
  /** Deterministic jitter per retry, as a fraction of that retry's delay (0–1). */
  retryJitterRatio: number
}

/** Validated scheduled update policy. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  // 缺省后台静默下载:用户只在下完之后被问一次"现在装还是稍后"(见 apply)。
  backgroundDownload: z.boolean().default(true),
  initialDelayMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(60_000),
  intervalMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(6 * 60 * 60 * 1000),
  requestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(15_000),
  checkRetryDelaysMs: z.array(z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS))
    .default([...DEFAULT_CHECK_RETRY_DELAYS_MS]),
  transferRetryDelaysMs: z.array(z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS))
    .default([...DEFAULT_TRANSFER_RETRY_DELAYS_MS]),
  retryJitterRatio: z.number().min(0).max(1).default(DEFAULT_RETRY_JITTER_RATIO),
})

interface UpdateStateV2 {
  readonly version: 2
  readonly lastPromptedVersion?: string
  /** 已下载并通过校验、等待安装的版本与其绝对路径。 */
  readonly downloadedVersion?: string
  readonly downloadedPath?: string
}

const EMPTY_STATE: UpdateStateV2 = { version: 2 }

/**
 * 一次更新检查的结果。
 *
 * 用三态而不是 `UpdateCheckResult | null`:「未登录」「检查失败」「清单非法」
 * 必须能被 UI 与重试逻辑区分 —— 把前两者都报成"网络不可达"会让人去查网络,
 * 而真因可能是还没登录(审计 2026-09-10);把清单非法当成网络故障则会白白重试。
 */
type CheckOutcome =
  | { readonly kind: 'ok'; readonly result: UpdateCheckResult }
  | { readonly kind: 'failed'; readonly error: DesktopUpdateErrorCategory }
  /** 清单拿到了但不合约定(版本号非法/结构不符):重试没有意义。 */
  | { readonly kind: 'invalid' }

/** 下载失败归类:精确类别优先,其余(含取消)读作网络故障。 */
function downloadErrorCategory(cause: unknown): DesktopUpdateErrorCategory {
  const code = cause instanceof UpdateDownloadError
    ? cause.code
    : (cause as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && DOWNLOAD_ERROR_CATEGORIES.has(code)
    ? code as DesktopUpdateErrorCategory
    : 'network'
}

/** 一次安装包传输失败是否值得重试(取消与 4xx/格式错误不重试)。 */
function isRetriableDownloadFailure(cause: unknown): boolean {
  if (cause instanceof UpdateDownloadError) return cause.retriable
  // 适配器包装过一层时按错误码判断;未知错误按网络故障重试。
  return downloadErrorCategory(cause) === 'network'
}

/**
 * Register effect-scoped update polling and its dynamic tray command.
 *
 * 流程(2026-09-12 定案):检查 → **后台静默下载** → 下载完成后才提示安装。
 * 检查与传输各自带**有界退避重试**,失败不再静默消失;已下载完成的安装包在
 * 重启/换源后直接复用(`state.json` 的记录 + 目录里现成的完成件双重兜底),
 * 不会重复下载。
 * @param ctx - Host context carrying the desktop native adapter.
 * @param config - validated polling and timeout values.
 */
export function apply(ctx: Context, config: Config): void {
  const adapter = ctx.desktopRuntime.updates
  // 重试预算 = 首次尝试 + 每个延迟项一次重试(见 Config 的字段说明)。
  const checkRetry: UpdateRetryPolicy = {
    maxAttempts: config.checkRetryDelaysMs.length + 1,
    delaysMs: config.checkRetryDelaysMs,
    jitterRatio: config.retryJitterRatio,
  }
  const transferRetry: UpdateRetryPolicy = {
    maxAttempts: config.transferRetryDelaysMs.length + 1,
    delaysMs: config.transferRetryDelaysMs,
    jitterRatio: config.retryJitterRatio,
  }
  ctx.effect(() => {
    let disposed = false
    let checking = false
    let availableVersion: string | undefined
    let downloadingVersion: string | undefined
    let downloadProgress: UpdateDownloadProgressSnapshot | undefined
    let readyVersion: string | undefined
    let readyPath: string | undefined
    let retryAttempt = 0
    let retryDelayMs = 0
    let lastError: DesktopUpdateErrorCategory | undefined
    let state: UpdateStateV2 = EMPTY_STATE
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let requestTimer: ReturnType<typeof setTimeout> | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let requestController: AbortController | undefined
    let downloadController: AbortController | undefined
    let inFlight: Promise<CheckOutcome> | undefined
    let manualTask: Promise<void> | undefined
    let downloadTask: Promise<void> | undefined
    let refreshTray = (): void => {}

    /** 清单请求的单次超时(每次重试各自计时)。 */
    const beginRequestTimer = (controller: AbortController): void => {
      if (requestTimer !== undefined) clearTimeout(requestTimer)
      requestTimer = setTimeout(() => { controller.abort() }, config.requestTimeoutMs)
    }
    const endRequestTimer = (): void => {
      if (requestTimer !== undefined) clearTimeout(requestTimer)
      requestTimer = undefined
    }

    /** 等待一次退避;返回 false 表示等待期间被销毁(调用方必须停止)。 */
    const waitBeforeRetry = async (delayMs: number): Promise<boolean> => {
      return await new Promise<boolean>((resolve) => {
        retryTimer = setTimeout(() => {
          retryTimer = undefined
          resolve(!disposed)
        }, delayMs)
      })
    }

    /**
     * 当前登录的服务端地址（`null` = 未登录）。
     *
     * 更新源随会话变化:登录/切换服务端/登出都必须让缓存失效，否则会把
     * 上一台服务端的版本当成这一台的。
     */
    let serverURL: string | null = null
    /** 服务端自报的渠道 id（`GET /api/client/v2/channel`），每次会话变化重取。 */
    let expectedChannel: string | undefined
    /** 渠道内容是否已为本会话取过（失败也标记，避免每次检查都重试）。 */
    let channelResolved = false

    /** 从会话载荷里取服务端地址（防御式:事件来自别的包，字段可能缺失）。 */
    const serverURLOf = (session: unknown): string | null => {
      if (typeof session !== 'object' || session === null) return null
      const value = (session as { serverURL?: unknown }).serverURL
      return typeof value === 'string' && value !== '' ? value : null
    }

    const persistState = async (): Promise<void> => {
      try {
        await writeFileAtomic(adapter.statePath, renderState(state), {
          mode: 0o600,
          dirMode: 0o700,
        })
      } catch {
        // Update state is optional; failures must not affect application startup or user activity.
      }
    }

    const stateReady = (async () => {
      try {
        state = parseState(await readState(adapter.statePath))
      } catch (cause) {
        if (isEnoent(cause)) return
        state = EMPTY_STATE
        if (!disposed) await persistState()
      }
    })()

    /**
     * 会话变化：重置更新状态并重新解析渠道。
     *
     * 换服务端等于换更新源 —— 上一台的"有新版本"必须清掉，否则会把 A 服务端
     * 的版本提示成 B 服务端可升级。
     */
    const onSessionChanged = (session: unknown): void => {
      // 事件监听器里的异常会冒泡进 Cordis 的事件派发,而桌面壳把它当致命错误
      // (整树重启/应用退出)。更新状态只是展示层,绝不该因为会话切换而拖垮宿主。
      try {
        const next = serverURLOf(session)
        if (next === serverURL) return
        // 会话身份变了 ⇒ 之前"已下载好"的安装包同样作废(可能来自另一台服务端)。
        releaseReady()
        serverURL = next
        expectedChannel = undefined
        channelResolved = false
        availableVersion = undefined
        lastError = undefined
        refreshTray()
        publishState()
        // 换源后立刻为这一台服务端做一次复用检查,别等下一次轮询。
        void reuseDownloadedInstaller()
      } catch {
        // 会话切换时的状态重置失败不影响宿主;下一次检查会重新推导更新源。
      }
    }

    /**
     * 取服务端自报的渠道 id（公开端点，无需令牌）。
     *
     * 这是**可选的对账**,不是检查的前置条件:
     *   - 必须与清单请求**并行**,绝不阻塞它 —— 否则一次慢探测会吃掉整个
     *     请求超时预算,把"检查更新"拖成"检查更新失败";
     *   - 失败不影响更新检查:拿不到就省略渠道比对(清单自带非空
     *     `channel_id` 仍是硬要求)。取到了则用于校验清单声明的渠道与服务端
     *     对外宣称的渠道一致 —— 服务端配置出错(镜像里的渠道内容与声明的
     *     渠道对不上)时立即暴露,而不是静默放行。
     */
    const startChannelProbe = (): void => {
      if (channelResolved || serverURL === null || disposed) return
      // 每个会话只探一次:拿不到就算了,不为此反复发请求。
      channelResolved = true
      const target = serverURL
      const controller = new AbortController()
      requestController = controller
      void (async () => {
        try {
          const response = await adapter.request(serverChannelURL(target), {
            method: 'GET',
            headers: { Accept: 'application/json' },
            cache: 'no-store',
            redirect: 'error',
            signal: controller.signal,
          })
          if (response.status !== 200) return
          const payload: unknown = await response.json()
          if (typeof payload !== 'object' || payload === null) return
          const id = (payload as { channel_id?: unknown }).channel_id
          // 取回期间会话可能已经切换:过期的结果必须丢弃。
          if (typeof id === 'string' && CHANNEL_ID_PATTERN.test(id) && serverURL === target) {
            expectedChannel = id
          }
        } catch {
          // 渠道内容取不到不是失败:省略比对即可。
        } finally {
          if (requestController === controller) requestController = undefined
        }
      })()
    }

    /** 当前更新源;未登录时为 null（没有可问的服务端就没有更新源）。 */
    const currentSource = (): DesktopUpdateSource | null => serverURL === null
      ? null
      : { manifestURL: serverManifestURL(serverURL), expectedChannel }

    /** Push the current observable update state to the renderer bridge. */
    const publishState = (): void => {
      try {
        adapter.publishState?.({
          availableVersion,
          downloadingVersion,
          isPackaged: adapter.isPackaged,
          canDownload: adapter.canDownload,
          currentVersion: adapter.currentVersion,
          downloadProgress,
          readyVersion,
          readyPath,
          retryAttempt,
          retryMaxAttempts: transferRetry.maxAttempts,
          retryDelayMs,
          lastError,
        })
      } catch {
        // The badge bridge is optional; state transitions must never fail the update flow.
      }
    }

    /** 清掉"已下载待安装"状态并通知一次(渲染层与托盘都要跟着变)。 */
    const releaseReady = (): void => {
      if (readyVersion === undefined && readyPath === undefined) return
      readyVersion = undefined
      readyPath = undefined
      refreshTray()
      publishState()
    }

    // 更新源随会话变化:登录后才有服务端可问,登出/切换服务端必须让缓存失效。
    // `picoSession` 由 enterprise 的 session-service 提供;这里防御式读取 ——
    // 没有会话服务的组装(纯桌面冒烟)等同于"未登录",而不是崩溃。
    const sessionService = ctx.get('picoSession') as
      | { getSession?: () => unknown }
      | undefined
    try {
      onSessionChanged(sessionService?.getSession?.() ?? null)
    } catch {
      onSessionChanged(null)
    }
    ctx.on('pico/session-changed', onSessionChanged)

    /** 记住"这一版已经提示过用户"（自动下载路径只提示一次）。 */
    const rememberPrompt = async (version: string): Promise<void> => {
      await stateReady
      state = { ...state, lastPromptedVersion: version }
      await persistState()
    }

    /** 记住"这一版已经下载并通过校验",下次启动直接复用。 */
    const rememberDownload = async (version: string, path: string): Promise<void> => {
      await stateReady
      state = { ...state, downloadedVersion: version, downloadedPath: path }
      await persistState()
    }

    /** 取一份清单用于复用校验;失败返回 null(复用是可选优化,不能因此报错)。 */
    const fetchReusableManifest = async (): Promise<DesktopReleaseManifest | null> => {
      const source = currentSource()
      if (source === null) return null
      const controller = new AbortController()
      beginRequestTimer(controller)
      try {
        const outcome = await fetchReleaseManifestDetailed({
          manifestURL: source.manifestURL,
          request: adapter.request,
          signal: controller.signal,
          ...(source.expectedChannel === undefined ? {} : { expectedChannel: source.expectedChannel }),
        })
        return outcome.kind === 'manifest' ? outcome.manifest : null
      } catch {
        return null
      } finally {
        endRequestTimer()
      }
    }

    /**
     * 校验一份已下载的安装包是否就是这一版,并把它接回"可安装"状态。
     * @param version - 记录里等待安装的版本。
     * @param manifest - 该版本最新的清单(调用方已取到)。
     * @returns 校验通过并已置位 ready 状态时为 true。
     */
    const reinstateDownloaded = async (
      version: string,
      manifest: DesktopReleaseManifest,
    ): Promise<boolean> => {
      const source = currentSource()
      if (source === null) return false
      try {
        const installed = await resolveUpdateInstaller({
          platform: downloadPlatform(),
          version,
          userDataPath: adapter.userDataPath,
          request: adapter.request,
          manifest,
          manifestURL: source.manifestURL,
        })
        // 目录里没有通过校验的完成件:不置位 —— 记录可能是上次失败留下的。
        if (!installed.complete) return false
        if (state.downloadedPath !== installed.path) {
          state = { ...state, downloadedVersion: version, downloadedPath: installed.path }
          await persistState()
        }
        readyVersion = version
        readyPath = installed.path
        refreshTray()
        publishState()
        return true
      } catch {
        // 复用的任何一步失败都只是"这次没省下流量",不是错误。
        return false
      }
    }

    /**
     * 该版本已有下好并校验通过的安装包时,直接进入"可安装"。
     * @param version - 本次检查发现可用的版本。
     * @returns 已经置位 ready 时为 true(调用方不应再传输)。
     */
    const reinstateRecordedVersion = async (version: string): Promise<boolean> => {
      await stateReady
      if (disposed) return true
      if (state.downloadedVersion === undefined) return false
      if (state.downloadedVersion.replace(/^v/u, '') !== version.replace(/^v/u, '')) return false
      const manifest = await fetchReusableManifest()
      if (disposed || manifest === null) return false
      return await reinstateDownloaded(version, manifest)
    }

    /**
     * 启动/换源时把"上次已经下载好的安装包"接回来。
     *
     * 覆盖两种情形:`state.json` 记着下载记录(重启),以及会话刚变化(可能在另
     * 一台服务端上下过)。复用前按清单的 SHA-256 与平台魔数验一遍 —— 只认
     * "清单说它是这一版"的文件。
     */
    const reuseDownloadedInstaller = async (): Promise<void> => {
      if (disposed || !adapter.canDownload || serverURL === null) return
      if (downloadingVersion !== undefined || downloadTask !== undefined) return
      await stateReady
      if (disposed) return
      const recorded = state.downloadedVersion
      if (recorded === undefined) return
      if (compareVersions(recorded, adapter.currentVersion) <= 0) {
        // 记录指向的是已经装上(或更旧)的版本:清掉,别拿它去提示升级。
        state = { version: 2, ...(state.lastPromptedVersion === undefined
          ? {}
          : { lastPromptedVersion: state.lastPromptedVersion }) }
        await persistState()
        return
      }
      const manifest = await fetchReusableManifest()
      if (disposed || manifest === null) return
      if (manifest.clientVersion.replace(/^v/u, '') !== recorded.replace(/^v/u, '')) return
      availableVersion = recorded
      lastError = undefined
      await reinstateDownloaded(recorded, manifest)
    }

    /**
     * 跑一次版本清单检查。
     * @param retryTransient - 传输类瞬时故障是否按退避重试。后台自动检查重试
     *   (没人盯着,重试一次就能吞掉抖动);用户手动点的那次不重试 —— 让用户
     *   对着"正在检查更新…"等一分半比直接告诉他"失败了,再点一次"更糟。
     */
    const startCheck = (retryTransient: boolean): Promise<CheckOutcome> => {
      if (inFlight !== undefined) return inFlight
      checking = true
      refreshTray()

      const task = (async (): Promise<CheckOutcome> => {
        // 未登录 = 没有更新源。客户端只从它登录的那台服务端取更新
        // (2026-09-10 定案),所以这里不是失败而是"还没有可问的对象"。
        const source = currentSource()
        if (source === null) return { kind: 'failed', error: 'not-signed-in' }

        for (let attempt = 1; attempt <= checkRetry.maxAttempts; attempt += 1) {
          if (disposed) return { kind: 'failed', error: 'network' }
          const controller = new AbortController()
          requestController = controller
          beginRequestTimer(controller)
          let retriable = false
          try {
            // 清单请求先发:渠道探测只是可选对账,与它并行即可,绝不排在它前面
            // (排在前面会把探测的耗时算进本就很紧的请求超时预算)。
            const pending = fetchReleaseManifestDetailed({
              manifestURL: source.manifestURL,
              request: adapter.request,
              signal: controller.signal,
              // 期望渠道用**当前已知**的值(探测结果从下一次检查开始生效)。
              ...(source.expectedChannel === undefined ? {} : { expectedChannel: source.expectedChannel }),
            })
            startChannelProbe()
            const outcome = await pending
            if (outcome.kind === 'manifest') {
              const compared = compareManifest(outcome.manifest)
              if (compared.kind !== 'failed' || compared.error !== 'network') return compared
              retriable = true
            } else if (outcome.kind === 'unavailable') {
              // 服务端能连上、清单也拿到了,只是它给不出安全的下载地址(部署没配
              // 对外 https 地址)——必须与"网络不可达""已是最新"区分开,否则界面
              // 显示"已是最新"而升级链路其实是断的(2026-09-10 审计)。
              return { kind: 'failed', error: 'server-unavailable' }
            } else if (isRetriableManifestOutcome(outcome)) {
              retriable = true
            } else {
              // 结构/渠道不符:重试改变不了结果。
              return { kind: 'invalid' }
            }
          } catch {
            retriable = true
          } finally {
            endRequestTimer()
            if (requestController === controller) requestController = undefined
          }
          if (!retryTransient || !retriable || attempt >= checkRetry.maxAttempts) break
          const delayMs = updateRetryDelayMs(checkRetry, attempt, 'check')
          if (!await waitBeforeRetry(delayMs)) break
        }
        return { kind: 'failed', error: 'network' }
      })().finally(() => {
        endRequestTimer()
        inFlight = undefined
        checking = false
        refreshTray()
      })
      inFlight = task
      return task
    }

    /**
     * 把清单变成检查结论。
     * @param manifest - 已通过结构校验的清单。
     * @returns 比较结果;版本号非法时返回不可重试的 network 失败(占位,调用方按 invalid 处理)。
     */
    const compareManifest = (manifest: DesktopReleaseManifest): CheckOutcome => {
      const current = parseSemVer(adapter.currentVersion)
      const latest = parseSemVer(manifest.clientVersion)
      if (current === null || current.version !== adapter.currentVersion || latest === null) {
        return { kind: 'invalid' }
      }
      return {
        kind: 'ok',
        result: {
          status: compareVersionStrings(latest.version, current.version) > 0 ? 'update-available' : 'up-to-date',
          currentVersion: current.version,
          latestVersion: latest.version,
        },
      }
    }

    const observeResult = (outcome: CheckOutcome): string | undefined => {
      if (disposed) return undefined
      if (outcome.kind !== 'ok') {
        // 检查失败(未登录/网络/超时/清单非法):保留此前可用版本,但记录错误供 UI 提示。
        if (availableVersion === undefined) {
          lastError = outcome.kind === 'failed' ? outcome.error : 'network'
        }
        refreshTray()
        publishState()
        return undefined
      }
      const result = outcome.result
      lastError = undefined
      availableVersion = result.status === 'update-available' && adapter.canDownload
        ? result.latestVersion
        : undefined
      // 这一版已不是目标(装上了/服务端回退了):之前的"待安装"作废。
      if (availableVersion !== readyVersion) releaseReady()
      refreshTray()
      publishState()
      return availableVersion
    }

    /**
     * 记录"这一版已经提示过"并返回是否继续。
     * @param version - 可用版本。
     * @param automatic - 后台自动流程(同一版本只自动处理一次)。
     * @returns 可以继续下载时为 true。
     */
    const admitDownload = async (version: string, automatic: boolean): Promise<boolean> => {
      if (disposed || !adapter.canDownload) return false
      await stateReady
      if (disposed) return false
      if (automatic && state.lastPromptedVersion === version) return false
      await rememberPrompt(version)
      return !disposed
    }

    /**
     * 后台静默下载:拿到可用版本后直接开始传输,失败按 TRANSFER_RETRY 退避重试
     * (**续传**),完成后一次性提示"可安装"。整个过程不打断用户。
     * @param version - 要下载的版本。
     * @param automatic - 后台自动流程(去重键是"这一版是否已自动处理过")。
     */
    const startDownload = (version: string, automatic: boolean): Promise<void> => {
      if (downloadTask !== undefined) return downloadTask
      // 这一版已经在待安装位:什么都不用做(也不该再去问一次清单)。
      if (readyVersion !== undefined && readyVersion === version) return Promise.resolve()
      const task = (async () => {
        // 先看这一版是不是**已经下好了**:是(上次启动下完/上次重启前下完)就直接
        // 接回"可安装",连"自动流程只处理一次"的去重都不该拦住它 —— 去重是为了
        // 不重复打扰用户,不是为了把已经拿到的安装包藏起来。
        if (await reinstateRecordedVersion(version)) return
        if (!await admitDownload(version, automatic)) return
        if (disposed) return

        let lastFailure: unknown
        for (let attempt = 1; attempt <= transferRetry.maxAttempts; attempt += 1) {
          if (disposed) return
          const source = currentSource()
          if (source === null) {
            lastError = 'not-signed-in'
            refreshTray()
            publishState()
            return
          }
          const controller = new AbortController()
          downloadController = controller
          downloadingVersion = version
          downloadProgress = undefined
          retryAttempt = attempt
          retryDelayMs = 0
          // 重试中不再保留上一次的错误:UI 显示"第 n 次尝试/进度"而不是失败。
          lastError = undefined
          refreshTray()
          publishState()
          try {
            const path = await adapter.downloadUpdate(version, source, controller.signal, (progress) => {
              downloadProgress = progress
              publishState()
            })
            if (disposed) return
            // 下载完成 → 记住它(重启后直接复用)并提示一次。
            await rememberDownload(version, path)
            downloadingVersion = undefined
            downloadProgress = undefined
            retryAttempt = 0
            retryDelayMs = 0
            readyVersion = version
            readyPath = path
            lastError = undefined
            refreshTray()
            publishState()
            await announceReady(version, path)
            return
          } catch (cause) {
            lastFailure = cause
            downloadingVersion = undefined
            downloadProgress = undefined
            if (disposed) return
            if (!isRetriableDownloadFailure(cause) || attempt >= transferRetry.maxAttempts) break
            // 退避等待:进度清掉,但 UI 能看到"第 n 次重试 + 倒计时"。
            retryDelayMs = updateRetryDelayMs(transferRetry, attempt, version)
            publishState()
            if (!await waitBeforeRetry(retryDelayMs)) return
          } finally {
            if (downloadController === controller) downloadController = undefined
          }
        }

        // 重试用尽(或不可重试):把精确原因交给 UI,不再静默。
        lastError = downloadErrorCategory(lastFailure)
        downloadingVersion = undefined
        downloadProgress = undefined
        retryAttempt = 0
        retryDelayMs = 0
        refreshTray()
        publishState()
      })().finally(() => {
        if (downloadTask === task) downloadTask = undefined
      })
      downloadTask = task
      return task
    }

    /** 下载完成后的一次性提示(平台自己决定文案;不安装任何东西)。 */
    const announceReady = async (version: string, path: string): Promise<void> => {
      try {
        await adapter.announceUpdateReady(version, path)
      } catch {
        // 提示失败不影响"已下载待安装"这一状态本身(UI 里仍可安装)。
      }
    }

    /** 把已下载的安装包交给平台安装流程。 */
    const installReady = async (): Promise<void> => {
      const version = readyVersion
      const path = readyPath
      if (disposed || version === undefined || path === undefined) return
      try {
        await adapter.installUpdate(version, path)
      } catch {
        lastError = 'invalid-artifact'
        refreshTray()
        publishState()
      }
    }

    const runManualCheck = (): Promise<void> => {
      manualTask ??= (async () => {
        // 已经下载好了:用户点"检查更新"的实际意图就是把它装上。
        if (readyVersion !== undefined) {
          await installReady()
          return
        }
        const outcome = await startCheck(false)
        if (disposed) return
        const version = observeResult(outcome)
        if (version !== undefined) {
          // 手动检查同样走静默下载(下载完再提示),失败按退避重试;
          // 手动路径不做"同一版只处理一次"的去重 —— 用户点一次就该试一次。
          await startDownload(version, false)
          return
        }
        // 手动检查必须给出结论:失败(网络/未登录/服务端不可用)也要让用户看到。
        await adapter.showManualCheckResult(
          outcome.kind === 'ok' ? outcome.result : null,
        ).catch(() => undefined)
      })().catch(() => undefined).finally(() => { manualTask = undefined })
      return manualTask
    }

    const runBackgroundCheck = async (): Promise<void> => {
      if (inFlight !== undefined || downloadTask !== undefined || disposed) return
      try {
        const version = observeResult(await startCheck(true))
        if (version === undefined || disposed) return
        if (!config.backgroundDownload) {
          // 关掉后台静默下载:托盘照旧显示"有新版本",点它走手动路径下载。
          // 这里不再重复"已提示过"的记账 —— 提示只发生在真正开始下载时。
          return
        }
        // 静默下载:不弹任何对话框,失败按退避重试,完成才提示。
        await startDownload(version, true)
      } catch {
        // Scheduled checks never surface failures to the user or the application log.
      }
    }

    const scheduleBackgroundCheck = (delayMs: number): void => {
      pollTimer = setTimeout(() => {
        pollTimer = undefined
        void runBackgroundCheck().finally(() => {
          if (!disposed) scheduleBackgroundCheck(config.intervalMs)
        })
      }, delayMs)
    }

    const registration = ctx.desktopRuntime.registerTrayItem({
      group: 'status',
      order: 10,
      label: () => readyVersion !== undefined
        ? desktopTrayLabel(ctx.desktopRuntime.locale, 'updateReady', readyVersion, ctx.desktopRuntime.productName)
        : downloadingVersion === undefined
          ? availableVersion === undefined
            ? desktopTrayLabel(ctx.desktopRuntime.locale, checking ? 'checkingForUpdates' : 'checkForUpdates')
            : desktopTrayLabel(
              ctx.desktopRuntime.locale, 'updateAvailable', availableVersion, ctx.desktopRuntime.productName,
            )
          // 渠道构建下托盘里显示的必须是渠道名:产品名经 runtime 面取,不硬编码。
          : desktopTrayLabel(
            ctx.desktopRuntime.locale, 'downloadingUpdate', downloadingVersion, ctx.desktopRuntime.productName,
          ),
      invoke: runManualCheck,
      // 「安装更新」只在真的下载好之后出现:入口与状态同源,不会给用户一个
      // 点了没反应的菜单项(下载完的通报见 announceUpdateReady)。
      submenu: () => readyVersion === undefined
        ? []
        : [{
            label: () => desktopTrayLabel(
              ctx.desktopRuntime.locale, 'installUpdate', readyVersion!, ctx.desktopRuntime.productName,
            ),
            invoke: installReady,
          }],
    })
    refreshTray = registration.refresh

    // Expose the renderer triggers after the state machine is fully installed.
    // `checkNow` 覆盖"检查/下载/安装"三态:UI 上就是同一个动作按钮。
    adapter.checkNow = () => {
      void runManualCheck()
    }
    adapter.installNow = () => {
      void installReady()
    }
    // Publish the initial static facts so a renderer mounted later still has
    // a snapshot to render (availableVersion stays undefined until first check).
    publishState()
    // 启动时先看有没有上次已经下载好的安装包:有就直接进入"可安装",不重下。
    void reuseDownloadedInstaller()

    if (adapter.isPackaged && config.enabled) scheduleBackgroundCheck(config.initialDelayMs)

    return async () => {
      disposed = true
      if (pollTimer !== undefined) clearTimeout(pollTimer)
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      requestController?.abort()
      downloadController?.abort()
      registration.dispose()
      // Native dialogs are not cancellable. Await only file state and the abortable requests.
      const pending: Promise<unknown>[] = [stateReady]
      if (inFlight !== undefined) pending.push(inFlight)
      if (downloadTask !== undefined) pending.push(downloadTask)
      await Promise.allSettled(pending)
    }
  }, 'dsh-plugin-desktop: update polling, confirmation, and installer handoff')
}

/** 本进程所属平台;更新只在三平台上有安装包约定(见 desktop-release.ts)。 */
function downloadPlatform(): 'darwin' | 'win32' | 'linux' {
  return process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'
}

/** 严格 SemVer 比较(任一非法 ⇒ 0,调用方据此不做"可复用"判断)。 */
function compareVersions(left: string, right: string): number {
  const parsedLeft = parseSemVer(left)
  const parsedRight = parseSemVer(right)
  if (parsedLeft === null || parsedRight === null) return 0
  return compareVersionStrings(parsedLeft.version, parsedRight.version)
}

/**
 * 比较两个**规范**版本号(先各自解析;非法值按相等处理)。
 * @param left - canonical version.
 * @param right - canonical version.
 * @returns 负数/零/正数表示先后。
 */
function compareVersionStrings(left: string, right: string): number {
  const parsedLeft = parseSemVer(left)
  const parsedRight = parseSemVer(right)
  if (parsedLeft === null || parsedRight === null) return 0
  const numeric = (value: string): number => Number(value)
  for (const key of ['major', 'minor', 'patch'] as const) {
    const difference = numeric(parsedLeft[key]) - numeric(parsedRight[key])
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  if (parsedLeft.prerelease.length === 0) return parsedRight.prerelease.length === 0 ? 0 : 1
  if (parsedRight.prerelease.length === 0) return -1
  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const a = parsedLeft.prerelease[index]
    const b = parsedRight.prerelease[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumeric = /^[0-9]+$/u.test(a)
    const bNumeric = /^[0-9]+$/u.test(b)
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1
    if (aNumeric) return -1
    if (bNumeric) return 1
    return a < b ? -1 : 1
  }
  return 0
}

function parseState(text: string): UpdateStateV2 {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)
    || value.version !== 2
    || (value.lastPromptedVersion !== undefined && !isCanonicalVersion(value.lastPromptedVersion))
    || (value.downloadedVersion !== undefined && !isCanonicalVersion(value.downloadedVersion))
    || (value.downloadedPath !== undefined
      && (typeof value.downloadedPath !== 'string' || value.downloadedPath === ''))
    || Object.keys(value).some(key => ![
      'version',
      'lastPromptedVersion',
      'downloadedVersion',
      'downloadedPath',
    ].includes(key))) {
    throw new Error('invalid v2 update state')
  }
  return {
    version: 2,
    ...(value.lastPromptedVersion === undefined
      ? {}
      : { lastPromptedVersion: value.lastPromptedVersion as string }),
    ...(value.downloadedVersion === undefined
      ? {}
      : { downloadedVersion: value.downloadedVersion as string }),
    ...(value.downloadedPath === undefined
      ? {}
      : { downloadedPath: value.downloadedPath as string }),
  }
}

async function readState(filename: string): Promise<string> {
  const handle = await open(filename, 'r')
  try {
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)
    if (bytesRead > MAX_STATE_BYTES) throw new Error(`update state exceeds ${MAX_STATE_BYTES} bytes`)
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

function renderState(state: UpdateStateV2): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

function isCanonicalVersion(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = parseSemVer(value)
  // 提示历史接受任一规范 SemVer:稳定通道只写稳定版本,测试通道(已装版本
  // 带 prerelease 段)会写入 rc 版本,跨重启同样只提示一次。
  return parsed !== null && parsed.version === value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnoent(value: unknown): boolean {
  return isRecord(value) && value.code === 'ENOENT'
}
