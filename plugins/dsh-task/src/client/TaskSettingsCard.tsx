/**
 * Task plugin settings card (settings.plugin.item, key 'task'): a staged
 * form over the `task` settings namespace. The injected face is plain data
 * + callbacks, per the client discipline.
 */
import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { styles } from './styles.ts'
import { t } from './locales.ts'

export interface TaskSettings {
  enabled?: boolean
  announceToAgent?: boolean
}

type TaskSettingsSnapshot = SettingsScopeSnapshot<TaskSettings>

/** The registration-side face the card's slot entry injects. */
export interface TaskSettingsCardFace {
  getSnapshot(): TaskSettingsSnapshot
  subscribe(listener: () => void): () => void
  set: (field: keyof TaskSettings, value: boolean) => void
}

export class TaskSettingsCardController {
  constructor(private readonly scope: SettingsScope<TaskSettings>) {}

  getSnapshot(): TaskSettingsSnapshot {
    return this.scope.getSnapshot()
  }

  subscribe(listener: () => void): () => void {
    return this.scope.subscribe(listener)
  }

  set(field: keyof TaskSettings, value: boolean): void {
    void this.scope.set(field, value)
  }

  inject(): TaskSettingsCardFace {
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

export function TaskSettingsCard(props: PropsRuntime<'settings.plugin.item'> & TaskSettingsCardFace): JSX.Element {
  const { getSnapshot, subscribe, set } = props
  const [snapshot, setSnapshot] = useState<TaskSettingsSnapshot>(() => getSnapshot())
  useEffect(
    () => subscribe(() => setSnapshot(getSnapshot())),
    [getSnapshot, subscribe],
  )
  const value = snapshot.status === 'ready' ? snapshot.value ?? {} : {}
  return (
    <div style={styles.card} data-dsh-plugin="task">
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
    </div>
  )
}
