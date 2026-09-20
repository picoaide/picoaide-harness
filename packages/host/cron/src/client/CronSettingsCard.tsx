/**
 * Cron plugin configuration card (`plugins.item`, id 'cron') plus its tiny
 * controller: a form over the `cron` settings namespace. The namespace itself
 * is registered by the Host half; the card only edits it.
 *
 * Upstream 0.1.6-alpha.2 把承接面从「设置→插件 里一个 keyed 卡」改成
 * 「插件页 `plugins.item` 列表项」，并把 owner 契约变成两视图：`summary` 渲染
 * 标题下的一行说明，`page` 渲染带自己保存控件的表单（本表单是即时保存的开关，
 * 不需要额外的保存按钮）。旧槽 `settings.plugin.item` 已从 SlotMap 删除，
 * 继续按它注册会类型报错、运行时静默不渲染。
 * The injected face is plain data + callbacks (JSON-compatible), per the
 * client discipline.
 */
import { useEffect, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
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

export function CronSettingsCard(props: PropsRuntime<'plugins.item'> & CronSettingsCardFace): JSX.Element {
  const { getSnapshot, subscribe, set } = props
  const [snapshot, setSnapshot] = useState<CronSettingsSnapshot>(() => getSnapshot())
  useEffect(
    () => subscribe(() => setSnapshot(getSnapshot())),
    [getSnapshot, subscribe],
  )
  // `summary` 是页面在标题下放的一行说明，不是表单的紧凑版 —— 页面自己画标题与
  // 面包屑，这里只回一行文字。
  if (props.view === 'summary') return <>{t('settings.summary')}</>
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
