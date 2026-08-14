import { useState, type ReactNode } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { DesktopClientEnvironment, DesktopClientMode } from './environment.ts'

/** Locale namespace for the desktop settings page. */
export const DESKTOP_SETTINGS_LOCALE_NAMESPACE = 'settings.desktop'

/** Persisted settings exposed by the desktop Host namespace. */
export interface DesktopSettings {
  /** Native shell selected for the next renderer generation. */
  mode: DesktopClientMode
}

const zh = {
  nav: '桌面程序',
  title: '桌面程序',
  description: '选择 DSH Desktop 使用的界面模式。更改后应用会安全重启。',
  current: '当前模式',
  compatibility: '兼容模式',
  compatibilityDescription: '使用上游默认界面，仅由 Electron 提供原生窗口。',
  advanced: '高级模式',
  advancedDescription: '使用桌面程序提供的原生布局与材质效果。',
  advancedUnavailable: '当前平台暂不支持',
  selected: '当前',
  restarting: '已保存，正在安全重启……',
  writeFailed: '未能保存模式，请重试。',
} as const

type DesktopSettingsLocaleKey = keyof typeof zh

const en: Record<DesktopSettingsLocaleKey, string> = {
  nav: 'Desktop App',
  title: 'Desktop App',
  description: 'Choose the interface DSH Desktop uses. The app safely relaunches after a change.',
  current: 'Current mode',
  compatibility: 'Compatibility mode',
  compatibilityDescription: 'Use the unchanged upstream interface inside the native Electron window.',
  advanced: 'Advanced mode',
  advancedDescription: 'Use the desktop-owned native layout and material effects.',
  advancedUnavailable: 'Not available on this platform',
  selected: 'Current',
  restarting: 'Saved. Safely relaunching…',
  writeFailed: 'The mode could not be saved. Please try again.',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the DSH Desktop settings section. */
    'settings.desktop': DesktopSettingsLocaleKey
  }
}

/** Registration-side capabilities passed to the desktop settings section. */
export interface DesktopSettingsInjected {
  hooks: {
    /** Current mode fixed for this BrowserWindow generation. */
    desktopSettings: HostObservable<DesktopSettings>
  }
  /** Persist a new mode; true means the Host accepted the value. */
  setMode: (mode: DesktopClientMode) => Promise<boolean>
  /** Whether this native platform can construct the advanced shell window. */
  advancedAvailable: boolean
}

/** Full props assembled by the settings section slot. */
export type DesktopSettingsSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.desktop'>
  & InjectFace<DesktopSettingsInjected>

/**
 * Request one mode change through the desktop-owned same-origin endpoint.
 * @param mode - target shell mode.
 * @param request - fetch-compatible request function, injectable for tests.
 * @returns whether the Host accepted the write before relaunch.
 */
export async function setDesktopMode(
  mode: DesktopClientMode,
  request: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await request('/api/dsh-desktop/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    })
    return response.status === 204
  } catch {
    return false
  }
}

/** Desktop-owned settings page rendered inside the upstream settings shell. */
export function DesktopSettingsSection({
  t,
  useDesktopSettings,
  setMode,
  advancedAvailable,
}: DesktopSettingsSectionProps): ReactNode {
  const snapshot = useDesktopSettings(value => value)
  const [pending, setPending] = useState<DesktopClientMode | undefined>()
  const [writeFailed, setWriteFailed] = useState(false)
  const current = snapshot.mode

  const choose = async (mode: DesktopClientMode): Promise<void> => {
    if (pending !== undefined || mode === current) return
    setWriteFailed(false)
    setPending(mode)
    if (await setMode(mode)) return
    setPending(undefined)
    setWriteFailed(true)
  }

  return (
    <section className="dshDesktopSettings">
      <header className="dshDesktopSettingsHeader">
        <h2>{t('title')}</h2>
        <p>{t('description')}</p>
      </header>

      <p className="dshDesktopSettingsCurrent">
        {t('current')}: <code>{current}</code>
      </p>

      <div className="dshDesktopSettingsModes" role="group" aria-label={t('current')}>
        <ModeChoice
          mode="compatibility"
          title={t('compatibility')}
          description={t('compatibilityDescription')}
          selectedLabel={t('selected')}
          selected={current === 'compatibility'}
          disabled={pending !== undefined}
          unavailableLabel={undefined}
          onSelect={(mode) => { void choose(mode) }}
        />
        <ModeChoice
          mode="advanced"
          title={t('advanced')}
          description={t('advancedDescription')}
          selectedLabel={t('selected')}
          selected={current === 'advanced'}
          disabled={!advancedAvailable || pending !== undefined}
          unavailableLabel={advancedAvailable ? undefined : t('advancedUnavailable')}
          onSelect={(mode) => { void choose(mode) }}
        />
      </div>

      <DesktopSettingsStatus pending={pending} writeFailed={writeFailed} t={t} />
    </section>
  )
}

function ModeChoice(props: {
  mode: DesktopClientMode
  title: string
  description: string
  selectedLabel: string
  selected: boolean
  disabled: boolean
  unavailableLabel: string | undefined
  onSelect: (mode: DesktopClientMode) => void
}): ReactNode {
  return (
    <button
      type="button"
      className="dshDesktopSettingsMode"
      data-selected={props.selected || undefined}
      aria-pressed={props.selected}
      disabled={props.disabled || props.selected}
      onClick={() => { props.onSelect(props.mode) }}
    >
      <span className="dshDesktopSettingsModeHeading">
        <span>{props.title}</span>
        {props.selected && <span className="dshDesktopSettingsBadge">{props.selectedLabel}</span>}
      </span>
      <code>{props.mode}</code>
      <span className="dshDesktopSettingsModeDescription">{props.description}</span>
      {props.unavailableLabel !== undefined && (
        <span className="dshDesktopSettingsUnavailable">{props.unavailableLabel}</span>
      )}
    </button>
  )
}

function DesktopSettingsStatus(props: {
  pending: DesktopClientMode | undefined
  writeFailed: boolean
  t: DesktopSettingsSectionProps['t']
}): ReactNode {
  if (props.writeFailed) return <p className="dshDesktopSettingsError" role="alert">{props.t('writeFailed')}</p>
  if (props.pending !== undefined) return <p className="dshDesktopSettingsStatus" role="status">{props.t('restarting')}</p>
  return null
}

const DESKTOP_SETTINGS_STYLES = `
.dshDesktopSettings { display: flex; flex-direction: column; gap: 18px; max-width: 720px; color: var(--dsw-alias-label-primary); }
.dshDesktopSettingsHeader { display: flex; flex-direction: column; gap: 6px; }
.dshDesktopSettingsHeader h2 { margin: 0; font-size: 18px; font-weight: 600; }
.dshDesktopSettingsHeader p, .dshDesktopSettingsCurrent, .dshDesktopSettingsStatus, .dshDesktopSettingsError { margin: 0; font-size: 13px; line-height: 1.55; }
.dshDesktopSettingsHeader p, .dshDesktopSettingsStatus { color: var(--dsw-alias-label-tertiary); }
.dshDesktopSettingsCurrent { color: var(--dsw-alias-label-secondary); }
.dshDesktopSettingsCurrent code, .dshDesktopSettingsMode code { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.dshDesktopSettingsModes { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.dshDesktopSettingsMode { appearance: none; display: flex; flex-direction: column; gap: 8px; min-height: 142px; padding: 16px; color: inherit; font: inherit; text-align: left; cursor: pointer; background: var(--dsw-alias-bg-layer-3); border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; transition: border-color .16s, background .16s; }
.dshDesktopSettingsMode:hover:not(:disabled) { border-color: var(--dsw-alias-label-dimmed); background: var(--dsw-alias-bg-layer-2); }
.dshDesktopSettingsMode:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dshDesktopSettingsMode[data-selected] { cursor: default; background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-label-primary); }
.dshDesktopSettingsMode:disabled:not([data-selected]) { cursor: default; opacity: .55; }
.dshDesktopSettingsModeHeading { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 15px; font-weight: 600; }
.dshDesktopSettingsMode code { color: var(--dsw-alias-label-dimmed); font-size: 11px; }
.dshDesktopSettingsModeDescription { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.55; }
.dshDesktopSettingsUnavailable { color: var(--dsw-alias-label-tertiary); font-size: 12px; font-weight: 500; }
.dshDesktopSettingsBadge { margin-left: auto; padding: 1px 8px; color: var(--dsw-alias-bg-layer-3); font-size: 11px; font-weight: 500; line-height: 17px; white-space: nowrap; background: var(--dsw-alias-label-primary); border-radius: 999px; }
.dshDesktopSettingsError { color: var(--dsw-alias-state-error-primary); }
`

/** Install desktop settings styles without adding a browser CSS sidecar. */
function installDesktopSettingsStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-plugin-desktop'
  style.dataset.pluginCss = 'dsh-plugin-desktop/settings'
  style.textContent = DESKTOP_SETTINGS_STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}

/** Register the Desktop App page in the canonical settings section slot. */
export function registerDesktopSettings(ctx: ClientContext, environment: DesktopClientEnvironment): void {
  const current: HostObservable<DesktopSettings> = {
    getSnapshot: () => ({ mode: environment.mode }),
    subscribe: () => () => {},
  }
  ctx.effect(
    () => ctx.locale.register(DESKTOP_SETTINGS_LOCALE_NAMESPACE, { zh, en }),
    'desktop: settings dictionaries',
  )
  ctx.effect(installDesktopSettingsStyles, 'desktop: settings styles')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'desktop',
    order: 30,
    label: () => ctx.locale.bind(DESKTOP_SETTINGS_LOCALE_NAMESPACE)('nav'),
    locale: DESKTOP_SETTINGS_LOCALE_NAMESPACE,
    inject: () => ({
      hooks: { desktopSettings: current },
      setMode: (mode: DesktopClientMode) => setDesktopMode(mode),
      advancedAvailable: environment.platform !== 'linux',
    }),
  }, DesktopSettingsSection))
}
