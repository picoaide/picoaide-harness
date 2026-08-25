/** Desktop update badge: polls the Host update snapshot and fills the session-header utilities seat. */

import { useEffect, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  DESKTOP_UPDATE_PATH,
  DESKTOP_UPDATE_CHECK_PATH,
  type DesktopUpdateStateResponse,
} from '../desktop-update-contract.ts'

/** Poll interval for the Host update snapshot, ms. */
const UPDATE_POLL_MS = 30_000

/** Runtime `fetch`-compatible request boundary (test seam). */
export type UpdateBadgeRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Fetch the live Host update snapshot. */
export async function fetchDesktopUpdateState(
  request: UpdateBadgeRequest = window.fetch.bind(window),
): Promise<DesktopUpdateStateResponse | null> {
  try {
    const response = await request(DESKTOP_UPDATE_PATH, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    if (!response.ok) return null
    const value: unknown = await response.json()
    return isUpdateState(value) ? value : null
  } catch {
    return null
  }
}

function isUpdateState(value: unknown): value is DesktopUpdateStateResponse {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.isPackaged === 'boolean'
    && typeof record.canDownload === 'boolean'
    && typeof record.currentVersion === 'string'
    && (record.availableVersion === undefined || typeof record.availableVersion === 'string')
    && (record.downloadingVersion === undefined || typeof record.downloadingVersion === 'string')
}

/**
 * Register the session-header update badge (right-aligned utilities seat).
 * The badge appears only when an update is available or downloading; it hides
 * itself when the Host reports no pending update.
 */
export function applyUpdateBadge(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.slots.inject(
      'conversation.session.header.utilities',
      () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'desktop-update-badge',
        order: 10,
      }, DesktopUpdateBadge),
    ),
    'desktop: session-header update badge',
  )
}

/** Full utilities seat props (owner passes nothing; the badge is self-sufficient). */
export type DesktopUpdateBadgeProps = PropsRuntime<'conversation.session.header.utilities'>

/** Ask the Host to run the user-visible manual check (same flow as the tray command). */
export async function triggerDesktopUpdateCheck(
  request: UpdateBadgeRequest = window.fetch.bind(window),
): Promise<boolean> {
  try {
    const response = await request(DESKTOP_UPDATE_CHECK_PATH, {
      method: 'POST',
      headers: { accept: 'application/json' },
    })
    return response.ok
  } catch {
    return false
  }
}

/** Right-aligned badge with a blue dot and "vX available" label while an update is pending. */
export function DesktopUpdateBadge({ request }: DesktopUpdateBadgeProps & {
  request?: UpdateBadgeRequest
}): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<DesktopUpdateStateResponse | null>(null)

  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      const next = await fetchDesktopUpdateState(request)
      if (!cancelled) setSnapshot(next)
    }
    void poll()
    const timer = window.setInterval(() => { void poll() }, UPDATE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [request])

  if (snapshot === null) return null
  const available = snapshot.availableVersion
  const downloading = snapshot.downloadingVersion
  if (available === undefined && downloading === undefined) return null
  if (!snapshot.canDownload) return null

  return (
    <button
      type="button"
      className="dshDesktopUpdateBadge"
      data-state={downloading !== undefined ? 'downloading' : 'available'}
      title={downloading !== undefined
        ? `Downloading ${downloading}…`
        : `Version ${available} available — click to check`}
      onClick={() => { void triggerDesktopUpdateCheck(request) }}
    >
      <span className="dshDesktopUpdateBadgeDot" aria-hidden="true" />
      {downloading !== undefined ? downloading : available}
    </button>
  )
}
