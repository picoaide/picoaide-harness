/**
 * Desktop-owned sidebar composition policy.
 *
 * dsh-better-sidebar is a vendored third-party plugin whose iframe browser
 * tab (address bar + nav buttons squeezed into the 448px right panel) is
 * redundant with — and visually inferior to — the product's own embedded
 * browser modal (full-screen, toolbar on top, multi-tab, takeover, op log).
 * Per the vendored-plugin rule (no in-tree edits; customize from the
 * composition layer), this module disables the better-sidebar browser tab by
 * writing the plugin's own settings (`tabsEnabled.browser = false`) once at
 * boot, and only when the user has not explicitly configured the switch
 * themselves. The product browser stays reachable from the sidebar footer
 * 「浏览器」 action.
 */

/** The /sidebar API wire (see dsh-better-sidebar client api.ts). */
interface SidebarSettingsResponse {
  ok?: boolean
  value?: {
    value?: { tabsEnabled?: Record<string, boolean | undefined> }
    revision?: number
  }
}

const SETTINGS_GET = '/sidebar/api/settings.get'
const SETTINGS_UPDATE = '/sidebar/api/settings.update'

async function sidebarSettingsGet(): Promise<SidebarSettingsResponse | null> {
  try {
    const res = await fetch(SETTINGS_GET, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (!res.ok) return null
    return (await res.json()) as SidebarSettingsResponse
  } catch {
    return null
  }
}

async function sidebarSettingsUpdate(patch: Record<string, unknown>, expectedRevision: number): Promise<boolean> {
  try {
    const res = await fetch(SETTINGS_UPDATE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch, expectedRevision }),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { ok?: boolean }
    return data.ok === true
  } catch {
    return false
  }
}

/**
 * Disable the vendored sidebar's iframe browser tab unless the user chose
 * otherwise. Idempotent: no-op when the setting is already present (true or
 * false), and silent when the sidebar plugin is absent (routes 404).
 */
export function applySidebarBrowserPolicy(): void {
  void (async () => {
    const current = await sidebarSettingsGet()
    if (current === null) return
    const tabsEnabled = current.value?.value?.tabsEnabled
    if (tabsEnabled === undefined) return
    if (tabsEnabled.browser !== undefined) return
    const revision = current.value?.revision ?? 0
    await sidebarSettingsUpdate({ tabsEnabled: { browser: false } }, revision)
  })()
}
