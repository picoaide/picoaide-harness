/** Cordis Host plugin for scheduled and interactive PicoAide Harness updates. */

import { open } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import z from '@deepseek-ai/schemastery'
import type { DesktopUpdateSource, UpdateDownloadProgressSnapshot } from './runtime.ts'
import { desktopTrayLabel } from './tray-locale.ts'
import type { DesktopUpdateErrorCategory } from './desktop-update-contract.ts'
import {
  CHANNEL_ID_PATTERN,
  serverChannelURL,
  serverManifestURL,
} from './desktop-release.ts'
import {
  checkForUpdate,
  parseSemVer,
  type UpdateCheckResult,
} from './update-checker.ts'

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

/** Download failure codes that survive to the UI unchanged (P2-63). */
const DOWNLOAD_ERROR_CATEGORIES: ReadonlySet<string> = new Set([
  'network',
  'release-missing',
  'checksum-mismatch',
  'invalid-artifact',
])

/** Map a thrown download failure to its user-visible category. The downloader
 * attaches a stable `code`; anything else (and an aborted download) reads as
 * `network`. */
function downloadErrorCategory(cause: unknown): DesktopUpdateErrorCategory {
  const code = (cause as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && DOWNLOAD_ERROR_CATEGORIES.has(code)
    ? code as DesktopUpdateErrorCategory
    : 'network'
}

/** Scheduled update policy. */
export interface Config {
  /** Enable background checks in packaged applications. */
  enabled: boolean
  /** Delay before the first background check after plugin activation. */
  initialDelayMs: number
  /** Delay between completion of one background check and the next attempt. */
  intervalMs: number
  /** Maximum duration of one version request before caller-owned cancellation. */
  requestTimeoutMs: number
}

/** Validated scheduled update policy. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  initialDelayMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(60_000),
  intervalMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(6 * 60 * 60 * 1000),
  requestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(15_000),
})

interface UpdateStateV2 {
  readonly version: 2
  readonly lastPromptedVersion?: string
}

const EMPTY_STATE: UpdateStateV2 = { version: 2 }

/**
 * 一次更新检查的结果。
 *
 * 用三态而不是 `UpdateCheckResult | null`:「未登录」与「检查失败」必须能被
 * UI 区分 —— 把两者都报成"网络不可达"会让人去查网络，而真因是还没登录
 * （审计 2026-09-10 点名的误导项）。
 */
type CheckOutcome =
  | { readonly kind: 'ok'; readonly result: UpdateCheckResult }
  | { readonly kind: 'failed'; readonly error: DesktopUpdateErrorCategory }

/**
 * Register effect-scoped update polling and its dynamic tray command.
 * @param ctx - Host context carrying the desktop native adapter.
 * @param config - validated polling and timeout values.
 */
export function apply(ctx: Context, config: Config): void {
  const adapter = ctx.desktopRuntime.updates
  ctx.effect(() => {
    let disposed = false
    let checking = false
    let availableVersion: string | undefined
    let downloadingVersion: string | undefined
    let downloadProgress: UpdateDownloadProgressSnapshot | undefined
    let lastError: DesktopUpdateErrorCategory | undefined
    let state: UpdateStateV2 = EMPTY_STATE
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let requestTimer: ReturnType<typeof setTimeout> | undefined
    let requestController: AbortController | undefined
    let channelController: AbortController | undefined
    let downloadController: AbortController | undefined
    let inFlight: Promise<CheckOutcome> | undefined
    let manualTask: Promise<void> | undefined
    let downloadTask: Promise<void> | undefined
    let refreshTray = (): void => {}

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
        serverURL = next
        expectedChannel = undefined
        channelResolved = false
        availableVersion = undefined
        lastError = undefined
        refreshTray()
        publishState()
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
      channelController = controller
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
          if (channelController === controller) channelController = undefined
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
          lastError,
        })
      } catch {
        // The badge bridge is optional; state transitions must never fail the update flow.
      }
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

    const rememberPrompt = async (version: string): Promise<void> => {
      await stateReady
      if (state.lastPromptedVersion === version) return
      state = { version: 2, lastPromptedVersion: version }
      await persistState()
    }

    const startCheck = (): Promise<CheckOutcome> => {
      if (inFlight !== undefined) return inFlight
      checking = true
      refreshTray()
      const controller = new AbortController()
      requestController = controller

      const task = (async (): Promise<CheckOutcome> => {
        requestTimer = setTimeout(() => { controller.abort() }, config.requestTimeoutMs)
        // 未登录 = 没有更新源。客户端只从它登录的那台服务端取更新
        // (2026-09-10 定案),所以这里不是失败而是"还没有可问的对象"。
        if (serverURL === null) return { kind: 'failed', error: 'not-signed-in' }
        const manifestURL = serverManifestURL(serverURL)
        try {
          // 清单请求先发:渠道探测只是可选对账,与它并行即可,绝不排在它前面
          // (排在前面会把探测的耗时算进本就很紧的请求超时预算)。
          const pending = checkForUpdate({
            currentVersion: adapter.currentVersion,
            manifestURL,
            signal: controller.signal,
            request: adapter.request,
            // 期望渠道用**当前已知**的值(探测结果从下一次检查开始生效)。
            ...(expectedChannel === undefined ? {} : { expectedChannel }),
          })
          startChannelProbe()
          const result = await pending
          return result === null
            ? { kind: 'failed', error: 'network' }
            : { kind: 'ok', result }
        } catch {
          return { kind: 'failed', error: 'network' }
        }
      })().finally(() => {
        if (requestTimer !== undefined) clearTimeout(requestTimer)
        requestTimer = undefined
        if (requestController === controller) requestController = undefined
        inFlight = undefined
        checking = false
        refreshTray()
      })
      inFlight = task
      return task
    }

    const observeResult = (outcome: CheckOutcome): string | undefined => {
      if (disposed) return undefined
      if (outcome.kind === 'failed') {
        // 检查失败(未登录/网络/超时):保留此前可用版本,但记录错误供 UI 提示。
        if (availableVersion === undefined) lastError = outcome.error
        refreshTray()
        publishState()
        return undefined
      }
      const result = outcome.result
      lastError = undefined
      availableVersion = result.status === 'update-available' && adapter.canDownload
        ? result.latestVersion
        : undefined
      refreshTray()
      publishState()
      return availableVersion
    }

    const startDownload = (version: string): Promise<void> => {
      if (downloadTask !== undefined) return downloadTask
      const task = (async () => {
        let confirmed: boolean
        try {
          confirmed = await adapter.confirmDownload(version)
        } catch {
          return
        }
        if (!confirmed || disposed) return

        // The user already confirmed exactly this version. Only skip when the
        // re-check proves the release story changed (rotated to a newer
        // release); a failed re-check must NOT silently cancel the download —
        // that turned "Download" into a no-op on flaky networks. The
        // downloader re-validates asset name + SHA-256 against the release.
        const confirmedVersion = observeResult(await startCheck())
        if (confirmedVersion !== undefined && confirmedVersion !== version) return
        if (disposed) return

        const controller = new AbortController()
        downloadController = controller
        downloadingVersion = version
        downloadProgress = undefined
        refreshTray()
        publishState()
        // 更新源在下载发生的这一刻重新取:会话可能已经变化(换服务端/登出)。
        const source = currentSource()
        if (source === null) {
          lastError = 'not-signed-in'
          refreshTray()
          publishState()
          return
        }
        try {
          await adapter.downloadAndOpen(version, source, controller.signal, (progress) => {
            downloadProgress = progress
            publishState()
          })
        } catch (cause) {
          // P2-63: keep the precise download cause (checksum mismatch/missing,
          // release-missing, invalid artifact) instead of collapsing every
          // failure into `network`, which hid actionable diagnostics.
          lastError = downloadErrorCategory(cause)
          refreshTray()
          publishState()
        } finally {
          if (downloadController === controller) downloadController = undefined
          downloadingVersion = undefined
          downloadProgress = undefined
          refreshTray()
          publishState()
        }
      })().finally(() => {
        if (downloadTask === task) downloadTask = undefined
      })
      downloadTask = task
      return task
    }

    const offerDownload = async (version: string, automatic: boolean): Promise<void> => {
      if (disposed || !adapter.canDownload) return
      await stateReady
      if (disposed || (automatic && state.lastPromptedVersion === version)) return
      await rememberPrompt(version)
      if (!disposed) await startDownload(version)
    }

    const runManualCheck = (): Promise<void> => {
      manualTask ??= (async () => {
        if (availableVersion !== undefined) {
          await offerDownload(availableVersion, false)
          return
        }
        const outcome = await startCheck()
        if (disposed) return
        const version = observeResult(outcome)
        if (version !== undefined) {
          await offerDownload(version, false)
          return
        }
        await adapter.showManualCheckResult(outcome.kind === 'ok' ? outcome.result : null)
      })().catch(() => undefined).finally(() => { manualTask = undefined })
      return manualTask
    }

    const runBackgroundCheck = async (): Promise<void> => {
      if (inFlight !== undefined || disposed) return
      try {
        const version = observeResult(await startCheck())
        if (version !== undefined) await offerDownload(version, true)
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
      label: () => downloadingVersion === undefined
        ? availableVersion === undefined
          ? desktopTrayLabel(ctx.desktopRuntime.locale, checking ? 'checkingForUpdates' : 'checkForUpdates')
          : desktopTrayLabel(ctx.desktopRuntime.locale, 'updateAvailable', availableVersion)
        : desktopTrayLabel(ctx.desktopRuntime.locale, 'downloadingUpdate', downloadingVersion),
      invoke: runManualCheck,
    })
    refreshTray = registration.refresh

    // Expose the renderer trigger after the state machine is fully installed.
    adapter.checkNow = () => {
      void runManualCheck()
    }
    // Publish the initial static facts so a renderer mounted later still has
    // a snapshot to render (availableVersion stays undefined until first check).
    publishState()

    if (adapter.isPackaged && config.enabled) scheduleBackgroundCheck(config.initialDelayMs)

    return async () => {
      disposed = true
      if (pollTimer !== undefined) clearTimeout(pollTimer)
      if (requestTimer !== undefined) clearTimeout(requestTimer)
      requestController?.abort()
      channelController?.abort()
      downloadController?.abort()
      registration.dispose()
      // Native dialogs are not cancellable. Await only file state and the abortable version request.
      const pending: Promise<unknown>[] = [stateReady]
      if (inFlight !== undefined) pending.push(inFlight)
      await Promise.allSettled(pending)
    }
  }, 'dsh-plugin-desktop: update polling, confirmation, and installer handoff')
}

function parseState(text: string): UpdateStateV2 {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)
    || value.version !== 2
    || (value.lastPromptedVersion !== undefined && !isCanonicalVersion(value.lastPromptedVersion))
    || Object.keys(value).some(key => !['version', 'lastPromptedVersion'].includes(key))) {
    throw new Error('invalid v2 update state')
  }
  return value.lastPromptedVersion === undefined
    ? EMPTY_STATE
    : { version: 2, lastPromptedVersion: value.lastPromptedVersion as string }
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
