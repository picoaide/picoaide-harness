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
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { styles } from './styles.ts'
import { t } from './locales.ts'

export interface CronSettings {
  enabled?: boolean
  announceToAgent?: boolean
  catchUpMissed?: boolean
}

type CronSettingsSnapshot = ConfigFormSnapshot<CronSettings>

/** The registration-side face the card's slot entry injects (plain data + callbacks). */
export interface CronSettingsCardFace {
  getSnapshot(): CronSettingsSnapshot
  subscribe(listener: () => void): () => void
  set: (field: keyof CronSettings, value: boolean) => void
  /** 最近一次保存失败的原因（成功后清空）；`undefined` = 没有失败。 */
  getError(): string | undefined
}

export class CronSettingsCardController {
  /** 自己的一份订阅者：保存失败也要能通知界面（scope 只在它自己的状态变化时通知）。 */
  private readonly listeners = new Set<() => void>()
  private error: string | undefined

  constructor(private readonly form: ConfigForm<CronSettings>) {}

  getSnapshot(): CronSettingsSnapshot {
    return this.form.getSnapshot()
  }

  subscribe(listener: () => void): () => void {
    const off = this.form.subscribe(listener)
    this.listeners.add(listener)
    return () => {
      off()
      this.listeners.delete(listener)
    }
  }

  getError(): string | undefined {
    return this.error
  }

  set(field: keyof CronSettings, value: boolean): void {
    // 失败必须有人接住（2026-09-21 审计，0.1.7 起有**两种**失败形态）：
    // `ConfigForm.set` 拒绝时 reject，**被宿主拒绝或跳过时 resolve(false)** ——
    // 只接 rejection 会把 `false` 当成保存成功，而界面已经乐观地翻了开关
    // （静默弹回旧值 + 零解释）。两种都要记原因并通知界面。
    void Promise.resolve(this.form.set(field, value)).then(
      (accepted: boolean) => { this.publishError(accepted ? undefined : t('settings.rejected')) },
      (cause: unknown) => { this.publishError(cause instanceof Error ? cause.message : String(cause)) },
    )
  }

  private publishError(message: string | undefined): void {
    if (this.error === message) return
    this.error = message
    for (const listener of this.listeners) listener()
  }

  inject(): CronSettingsCardFace {
    return {
      getSnapshot: () => this.getSnapshot(),
      subscribe: listener => this.subscribe(listener),
      set: (field, value) => this.set(field, value),
      getError: () => this.getError(),
    }
  }
}

function ToggleRow({ id, label, desc, checked, disabled, onChange }: {
  id: string
  label: string
  desc: string
  checked: boolean
  disabled?: boolean | undefined
  onChange: (value: boolean) => void
}): JSX.Element {
  return (
    <div style={styles.row}>
      <div style={{ minWidth: 0 }}>
        {/* 文案与控件必须真的关联：只把 <input> 包进空 <label> 时，读屏念的是"未命名复选框"。 */}
        <label htmlFor={id}>{label}</label>
        <div style={styles.rowDesc}>{desc}</div>
      </div>
      <label style={{ ...styles.switch, ...(disabled === true ? { opacity: 0.5 } : {}) }}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled === true}
          onChange={(event) => { onChange(event.target.checked) }}
        />
      </label>
    </div>
  )
}

export function CronSettingsCard(props: PropsRuntime<'plugins.item'> & CronSettingsCardFace): JSX.Element {
  const { getSnapshot, subscribe, set, getError } = props
  const [snapshot, setSnapshot] = useState<CronSettingsSnapshot>(() => getSnapshot())
  const [error, setError] = useState<string | undefined>(() => getError())
  useEffect(
    () => subscribe(() => {
      setSnapshot(getSnapshot())
      setError(getError())
    }),
    [getSnapshot, subscribe, getError],
  )
  // `summary` 是页面在标题下放的一行说明，不是表单的紧凑版 —— 页面自己画标题与
  // 面包屑，这里只回一行文字。
  if (props.view === 'summary') return <>{t('settings.summary')}</>
  // 状态没到 `ready` 之前，`value` 是空对象 ⇒ 三个开关渲染的是**默认值**而不是落库值。
  // 此时必须禁用：否则用户在这一窗口里拨动开关，写入的是"默认值语义"的结果（看起来
  // 像没反应，或者正好写反）。
  const ready = snapshot.status === 'ready'
  const value = ready ? snapshot.value ?? {} : {}
  return (
    <div style={styles.card} data-dsh-plugin="cron">
      {ready ? null : <div style={styles.rowDesc} role="status">{t('settings.loading')}</div>}
      <ToggleRow
        id="cron-setting-enabled"
        label={t('settings.enabled')}
        desc={t('settings.enabledDesc')}
        checked={value.enabled ?? true}
        disabled={!ready}
        onChange={(enabled) => { set('enabled', enabled) }}
      />
      <ToggleRow
        id="cron-setting-announce"
        label={t('settings.announce')}
        desc={t('settings.announceDesc')}
        checked={value.announceToAgent ?? true}
        disabled={!ready}
        onChange={(announceToAgent) => { set('announceToAgent', announceToAgent) }}
      />
      <ToggleRow
        id="cron-setting-catch-up"
        label={t('settings.catchUp')}
        desc={t('settings.catchUpDesc')}
        checked={value.catchUpMissed ?? false}
        disabled={!ready}
        onChange={(catchUpMissed) => { set('catchUpMissed', catchUpMissed) }}
      />
      {error === undefined ? null : <div style={styles.error} role="alert">{t('settings.saveFailed', { error })}</div>}
    </div>
  )
}
