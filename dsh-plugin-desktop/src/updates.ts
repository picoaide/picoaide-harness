/** Cordis Host plugin for scheduled and interactive DSH Desktop update checks. */

import { open } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import z from '@deepseek-ai/schemastery'
import type {} from './runtime.ts'
import {
  UpdateCheckError,
  checkForStableUpdate,
  compareSemVerVersions,
  parseSemVer,
  parseStableRelease,
  type StableRelease,
  type UpdateCheckResult,
} from './update-checker.ts'

/** Stable Cordis plugin name. */
export const name = 'desktop-updates'

/** Native adapter required for network, tray, notification, and browser access. */
export const inject = ['desktopRuntime']

const MAX_TIMER_DELAY_MS = 2_147_483_647
const MAX_STATE_BYTES = 4 * 1024
const MAX_ETAG_LENGTH = 1024

/** Scheduled update policy. */
export interface Config {
  /** Enable background checks in packaged applications. */
  enabled: boolean
  /** Delay before the first background check after plugin activation. */
  initialDelayMs: number
  /** Delay between completion of one background check and the next attempt. */
  intervalMs: number
  /** Maximum duration of one GitHub request before caller-owned cancellation. */
  requestTimeoutMs: number
}

/** Validated scheduled update policy. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  initialDelayMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(60_000),
  intervalMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(6 * 60 * 60 * 1000),
  requestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(15_000),
})

interface UpdateStateV1 {
  readonly version: 1
  readonly checkedVersion?: string
  readonly etag?: string
  readonly lastNotifiedVersion?: string
  readonly availableRelease?: StableRelease
}

const EMPTY_STATE: UpdateStateV1 = { version: 1 }

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
    let availableRelease: StableRelease | undefined
    let state: UpdateStateV1 = EMPTY_STATE
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let requestTimer: ReturnType<typeof setTimeout> | undefined
    let requestController: AbortController | undefined
    let inFlight: Promise<UpdateCheckResult> | undefined
    let manualTask: Promise<void> | undefined
    const notifiedThisProcess = new Set<string>()
    let refreshTray = (): void => {}

    const persistState = async (): Promise<void> => {
      try {
        await writeFileAtomic(adapter.statePath, renderState(state), {
          mode: 0o600,
          dirMode: 0o700,
        })
      } catch (cause) {
        if (!disposed) ctx.logger.warn(`dsh-plugin-desktop: failed to persist update state: ${formatCause(cause)}`)
      }
    }

    const stateReady = (async () => {
      try {
        state = parseState(await readState(adapter.statePath))
        if (state.checkedVersion !== undefined && state.checkedVersion !== adapter.currentVersion) {
          state = withStateValues(undefined, state.lastNotifiedVersion, undefined, undefined)
          await persistState()
        }
      } catch (cause) {
        if (isEnoent(cause)) return
        state = EMPTY_STATE
        if (!disposed) {
          ctx.logger.warn(`dsh-plugin-desktop: update state was reset: ${formatCause(cause)}`)
          await persistState()
        }
      }
      if (state.lastNotifiedVersion !== undefined) {
        notifiedThisProcess.add(state.lastNotifiedVersion)
      }
    })()

    const applySuccessfulResult = async (result: UpdateCheckResult): Promise<UpdateCheckResult> => {
      let checkedVersion = state.checkedVersion
      let cachedRelease = state.availableRelease
      if (result.status === 'update-available') {
        checkedVersion = adapter.currentVersion
        cachedRelease = result.release
      } else if (result.status === 'up-to-date') {
        checkedVersion = adapter.currentVersion
        cachedRelease = undefined
      }

      const etag = checkedVersion === undefined || !isSafeEtag(result.etag)
        ? undefined
        : result.etag
      const nextState = withStateValues(etag, state.lastNotifiedVersion, checkedVersion, cachedRelease)
      if (renderState(nextState) !== renderState(state)) {
        state = nextState
        await persistState()
      }
      availableRelease = cachedRelease

      if (result.status !== 'not-modified' || cachedRelease === undefined) return result
      const currentVersion = parseSemVer(adapter.currentVersion)!.version
      return {
        status: 'update-available',
        currentVersion,
        release: cachedRelease,
        ...(result.etag === undefined ? {} : { etag: result.etag }),
      }
    }

    const startCheck = (trigger: 'background' | 'manual'): Promise<UpdateCheckResult> => {
      if (inFlight !== undefined) return inFlight
      checking = true
      refreshTray()
      const controller = new AbortController()
      requestController = controller

      const task = (async () => {
        await stateReady
        if (disposed) throw new DOMException('Update plugin disposed.', 'AbortError')
        requestTimer = setTimeout(() => { controller.abort() }, config.requestTimeoutMs)
        const result = await checkForStableUpdate({
          currentVersion: adapter.currentVersion,
          trigger,
          ...(state.etag === undefined ? {} : { etag: state.etag }),
          signal: controller.signal,
          request: adapter.request,
        })
        return disposed ? result : applySuccessfulResult(result)
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

    const notify = (title: string, body: string, openUrl?: string): void => {
      try {
        adapter.notify({ title, body, ...(openUrl === undefined ? {} : { openUrl }) })
      } catch (cause) {
        if (!disposed) ctx.logger.warn(`dsh-plugin-desktop: failed to show update notification: ${formatCause(cause)}`)
      }
    }

    const notifyManualResult = (result: UpdateCheckResult): void => {
      if (disposed) return
      if (result.status === 'update-available') {
        notify(
          'DSH Desktop Update Available',
          `Version ${result.release.version} is available.`,
          result.release.htmlUrl,
        )
      } else if (result.status === 'up-to-date') {
        notify(
          'DSH Desktop is Up to Date',
          `Version ${result.currentVersion} is the latest stable release.`,
        )
      } else {
        notify('Update Check Complete', 'Release information has not changed.')
      }
    }

    const runManualCheck = (): Promise<void> => {
      manualTask ??= startCheck('manual')
        .then(notifyManualResult)
        .catch((cause: unknown) => {
          if (!disposed) notify('Unable to Check for Updates', formatCause(cause))
        })
        .finally(() => { manualTask = undefined })
      return manualTask
    }

    const openAvailableRelease = async (release: StableRelease): Promise<void> => {
      try {
        await adapter.openRelease(release.htmlUrl)
      } catch (cause) {
        if (!disposed) notify('Unable to Open Update', formatCause(cause))
      }
    }

    const runBackgroundCheck = async (): Promise<void> => {
      if (inFlight !== undefined || disposed) return
      try {
        const result = await startCheck('background')
        if (disposed || result.status !== 'update-available') return
        const version = result.release.version
        if (notifiedThisProcess.has(version) || state.lastNotifiedVersion === version) return
        notifiedThisProcess.add(version)
        notify(
          'DSH Desktop Update Available',
          `Version ${version} is available.`,
          result.release.htmlUrl,
        )
        state = withStateValues(
          state.etag,
          version,
          state.checkedVersion,
          state.availableRelease,
        )
        await persistState()
      } catch (cause) {
        if (!disposed) {
          const category = cause instanceof UpdateCheckError ? cause.code : 'unexpected'
          ctx.logger.warn(
            `dsh-plugin-desktop: background update check failed (${category}): ${formatCause(cause)}`,
          )
        }
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
      label: () => availableRelease === undefined
        ? checking ? 'Checking for Updates…' : 'Check for Updates…'
        : `DSH Desktop ${availableRelease.version} Available`,
      invoke: () => availableRelease === undefined
        ? runManualCheck()
        : openAvailableRelease(availableRelease),
    })
    refreshTray = registration.refresh

    if (adapter.isPackaged && config.enabled) scheduleBackgroundCheck(config.initialDelayMs)

    return () => {
      disposed = true
      if (pollTimer !== undefined) clearTimeout(pollTimer)
      if (requestTimer !== undefined) clearTimeout(requestTimer)
      requestController?.abort()
      registration.dispose()
    }
  }, 'dsh-plugin-desktop: update polling and tray command')
}

function parseState(text: string): UpdateStateV1 {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)
    || value.version !== 1
    || (value.checkedVersion !== undefined && !isVersion(value.checkedVersion))
    || (value.etag !== undefined && !isSafeEtag(value.etag))
    || (value.lastNotifiedVersion !== undefined && !isStableVersion(value.lastNotifiedVersion))
    || Object.keys(value).some(key => ![
      'version',
      'checkedVersion',
      'etag',
      'lastNotifiedVersion',
      'availableRelease',
    ].includes(key))) {
    throw new Error('invalid v1 update state')
  }
  const checkedVersion = value.checkedVersion as string | undefined
  const availableRelease = parseCachedRelease(value.availableRelease)
  if ((value.etag !== undefined || availableRelease !== undefined) && checkedVersion === undefined) {
    throw new Error('invalid v1 update state')
  }
  if (availableRelease !== undefined
    && compareSemVerVersions(availableRelease.version, checkedVersion!)! <= 0) {
    throw new Error('invalid v1 update state')
  }
  return withStateValues(
    value.etag as string | undefined,
    value.lastNotifiedVersion as string | undefined,
    checkedVersion,
    availableRelease,
  )
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

function renderState(state: UpdateStateV1): string {
  return `${JSON.stringify(state, null, 2)}\n`
}

function withStateValues(
  etag: string | undefined,
  lastNotifiedVersion: string | undefined,
  checkedVersion: string | undefined,
  availableRelease: StableRelease | undefined,
): UpdateStateV1 {
  return {
    version: 1,
    ...(checkedVersion === undefined ? {} : { checkedVersion }),
    ...(etag === undefined ? {} : { etag }),
    ...(lastNotifiedVersion === undefined ? {} : { lastNotifiedVersion }),
    ...(availableRelease === undefined ? {} : { availableRelease }),
  }
}

function parseCachedRelease(value: unknown): StableRelease | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)
    || typeof value.tagName !== 'string'
    || typeof value.version !== 'string'
    || typeof value.htmlUrl !== 'string'
    || Object.keys(value).some(key => !['tagName', 'version', 'htmlUrl'].includes(key))) {
    throw new Error('invalid v1 update state')
  }
  const release = parseStableRelease(value.tagName, value.htmlUrl)
  if (release === null || release.version !== value.version) throw new Error('invalid v1 update state')
  return release
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && parseSemVer(value) !== null
}

function isStableVersion(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = parseSemVer(value)
  return parsed !== null && parsed.prerelease.length === 0 && parsed.version === value
}

function isSafeEtag(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ETAG_LENGTH
    && !/[\r\n]/u.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEnoent(value: unknown): boolean {
  return isRecord(value) && value.code === 'ENOENT'
}

function formatCause(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
