/**
 * Cron plugin settings card (settings.plugin.item, key 'cron') plus its
 * tiny controller: a staged form over the `cron` settings namespace. The
 * namespace itself is registered by the Host half; the card only edits it.
 * The injected face is plain data + callbacks (JSON-compatible), per the
 * client discipline.
 */
import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { styles } from './styles.ts'
import { t } from './locales.ts'

export interface CronSettings {
  enabled?: boolean
  announceToAgent?: boolean
  catchUpMissed?: boolean
}

type CronSettingsSnapshot = SettingsScopeSnapshot<CronSettings>

/** The registration-side face the card's slot entry injects (plain data + callbacks). */
export interface CronSettingsCardFace {
  getSnapshot(): CronSettingsSnapshot
  subscribe(listener: () => void): () => void
  set: (field: keyof CronSettings, value: boolean) => void
}

export class CronSettingsCardController {
  constructor(private readonly scope: SettingsScope<CronSettings>) {}

  getSnapshot(): CronSettingsSnapshot {
    return this.scope.getSnapshot()
  }

  subscribe(listener: () => void): () => void {
    return this.scope.subscribe(listener)
  }

  set(field: keyof CronSettings, value: boolean): void {
    void this.scope.set(field, value)
  }

  inject(): CronSettingsCardFace {
    return {
      getSnapshot: () => this.getSnapshot(),
      subscribe: listener => this.subscribe(listener),
      set: (field, value) => this.set(field, value),
    }
  }
}

function ToggleRow({ label, desc, checked, onChange }: {
  label: string
  desc: string
  checked: boolean
  onChange: (value: boolean) => void
}): JSX.Element {
  return (
    <div style={styles.row}>
      <div>
        <div>{label}</div>
        <div style={styles.rowDesc}>{desc}</div>
      </div>
      <label style={styles.switch}>
        <input type="checkbox" checked={checked} onChange={(event) => { onChange(event.target.checked) }} />
      </label>
    </div>
  )
}

export function CronSettingsCard(props: PropsRuntime<'settings.plugin.item'> & CronSettingsCardFace): JSX.Element {
  const { getSnapshot, subscribe, set } = props
  const [snapshot, setSnapshot] = useState<CronSettingsSnapshot>(() => getSnapshot())
  useEffect(
    () => subscribe(() => setSnapshot(getSnapshot())),
    [getSnapshot, subscribe],
  )
  const value = snapshot.status === 'ready' ? snapshot.value ?? {} : {}
  return (
    <div style={styles.card} data-dsh-plugin="cron">
      <ToggleRow
        label={t('settings.enabled')}
        desc={t('settings.enabledDesc')}
        checked={value.enabled ?? true}
        onChange={(enabled) => { set('enabled', enabled) }}
      />
      <ToggleRow
        label={t('settings.announce')}
        desc={t('settings.announceDesc')}
        checked={value.announceToAgent ?? true}
        onChange={(announceToAgent) => { set('announceToAgent', announceToAgent) }}
      />
      <ToggleRow
        label={t('settings.catchUp')}
        desc={t('settings.catchUpDesc')}
        checked={value.catchUpMissed ?? false}
        onChange={(catchUpMissed) => { set('catchUpMissed', catchUpMissed) }}
      />
    </div>
  )
}
