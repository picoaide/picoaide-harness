/**
 * Desktop voice-input support surface (2026-09-29, 产品决策：默认开启语音输入)。
 *
 * 上游 `@deepseek-ai/dsh-experimental-voice-input-bundle` 装配后做两件事：
 *   · 宿主侧注册 `speech-to-text` / `speech-to-text-sensevoice` /
 *     `api-speech-to-text` 三行（本地 SenseVoice + Silero VAD，音频不出机器）；
 *   · 浏览器侧 `ui-voice-input` 行在输入框放麦克风按钮，并**要求两个前置条件**：
 *     ① `ctx.pluginNavigation` 服务（`inject` 它，缺了整条 client fiber 永久
 *        pending，按钮根本不出现）——它的唯一提供者是 `ui-plugin-manager`，
 *        而那行被我们禁用（占 `main`+`panellist`，与自研面板接管不互通），
 *        所以这里补一个最小实现；
 *     ② 模型准备面：上游的准备/进度卡片挂在 `plugins.bundle.activation|config`
 *        槽位（同样属 ui-plugin-manager），我们提供自己的等价面 —— 未准备时
 *        麦克风按钮的「查看详情」经 `pluginNavigation.openBundle(...)` 打开它。
 *
 * 为什么不用 typert 的 stream 面：本模块只在对话框打开时以 1s 间隔轮询
 * `remote.speech.catalog()`（准备进度就在 catalog 里），与桌面其它轮询面
 * （更新徽标 / loop-notify）同一姿势；打开前的热路径零请求。
 *
 * 已知边界（照上游语义如实呈现，不做假承诺）：
 *   · 下载源不做选择器（用 provider 默认策略；上游卡片里的"手动选择镜像"未搬）；
 *   · 准备任务归 Host 所有：关闭对话框不取消下载，重开继续看进度。
 *
 * @module dsh-plugin-desktop/voice-setup-client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { useEffect, useState, type ReactElement } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { t } from './locales.ts'

/** 语音输入 bundle 的包名（`pluginNavigation.openBundle` 的入参，也是 profile 行来源）。 */
export const VOICE_INPUT_BUNDLE = '@deepseek-ai/dsh-experimental-voice-input-bundle'

/** 轮询间隔：准备进度是"秒级"信息，1s 足够且不打扰宿主。 */
export const VOICE_SETUP_POLL_MS = 1_000

/** 本地识别提供者的 id（与 bundle 的 `defaultProvider` 配置一致）。 */
export const VOICE_LOCAL_PROVIDER_ID = 'sensevoice-local'

/**
 * int8 模型的**实际下载量**（上游 `…-speech-to-text-sensevoice/runtime/assets.json`
 * 的 `models.int8.bytes`；`tokens.txt` 与 `silero_vad.onnx` 另计约 2MB）。
 *
 * 与上游 `setupEstimate.recommendedDiskBytes` **不是一回事**：后者是预留磁盘建议，
 * int8 恒为 1e9 字节（954MiB，见 `speech-to-text-sensevoice/src/index.ts:26` 附近的
 * `estimatedBytes`），拿它当"要下载多少"会把 228MB 说成 954MB（打包版实测：准备面
 * 初版就显示了 954MB）。真机下载进度同口径 —— 实测 "94.9 MB / 228 MB" → "228 MB /
 * 228 MB" → 已就绪（约 30 秒，231MB 落盘）。
 *
 * 本常量由 `tests/voice-setup.spec.ts` 对着随包 assets.json 对拍：上游换模型即红。
 */
export const VOICE_INT8_DOWNLOAD_BYTES = 239_233_841

/** 准备阶段（上游 `SpeechPreparationState` 的判别联合，跨 RPC 后是纯 JSON）。 */
export type VoicePreparationPhase =
  | 'unprepared' | 'downloading' | 'checking' | 'loading' | 'waking'
  | 'cancelling' | 'ready' | 'standby' | 'cancelled' | 'failed'

/** 一个提供者视图（只取本面渲染需要的字段）。 */
export interface VoiceProviderView {
  readonly id: string
  readonly name: string
  readonly location?: string
  readonly languages?: readonly string[]
  readonly setupEstimate?: {
    readonly recommendedDiskBytes?: number
    readonly minimumMinutes?: number
    readonly maximumMinutes?: number
  }
  readonly preparation: {
    readonly phase: VoicePreparationPhase
    readonly completedBytes?: number
    readonly totalBytes?: number
    readonly message?: string
    readonly download?: {
      readonly reason?: string
      readonly code?: string
      readonly status?: number
      readonly source?: string
    }
  }
}

/** `remote.speech.catalog()` 的有效载荷（选择器 + 限制 + 提供者状态）。 */
export interface VoiceCatalogView {
  readonly providers: readonly VoiceProviderView[]
  readonly selection?: { readonly providerId?: string, readonly language?: string }
  readonly maxAudioBytes?: number
  readonly maxDurationSeconds?: number
}

/** `RemoteResult<T>` 的结构形状（成功/失败判别在 `ok`）。 */
export type VoiceRemoteResult<T> =
  | { readonly ok: true, readonly value: T }
  | { readonly ok: false, readonly error: unknown }

/** `remote.speech.prepare` 的可选入参（缺省时用提供者自己的下载源策略）。 */
export interface VoicePrepareOptions {
  /** 指定下载源（上游 `downloadSources` 里的一个）；本面不提供选择器，恒不传。 */
  readonly downloadSource?: string
}

/** 本模块用到的那一面 `remote.speech`（typert Remote；上游 owner 是 api-speech-to-text）。 */
export interface SpeechRemoteLike {
  catalog: () => Promise<VoiceRemoteResult<VoiceCatalogView>>
  /**
   * 第二个参数**必须占位**：typert Remote 的入参个数是**严格校验**的（可选参数也计入），
   * `prepare(id)` 会抛 `client api: speech/prepare expected 2 argument(s), got 1`
   * （打包版实测，2026-09-29）。所以这里把它写成必填、值可以是 `undefined`，
   * 让类型替运行期挡住这类"少传一个可选参数"。
   */
  prepare: (providerId: string, options: VoicePrepareOptions | undefined) => Promise<VoiceRemoteResult<void>>
  cancelPreparation: (providerId: string) => Promise<VoiceRemoteResult<void>>
}

/**
 * 解析当前 client 上下文里的 speech Remote（未挂载时返回 undefined）。
 *
 * **必须走 `ctx.get()`，不能用属性代理 `ctx.remote.speech`**：命名空间服务
 * `remote.speech` 由 `remote` 服务的持有者（api-gateway client 在 `$mount` 时）
 * `provide`，而属性代理只在**自己 `inject` 了 `remote`** 的 fiber 里成立 ——
 * 否则第一跳就抛 `cannot get property "remote" without inject`（本包 `inject`
 * 列表没有它，也不该为一个可选能力加一条硬依赖；属性代理读的是本 fiber 的注入
 * 表，`ctx.get` 读的是全局服务表，见 `packages/AGENTS.md` 的"可选服务用
 * `ctx.get(name)`"）。这一条是实测结论：属性代理在读法下抛出，而抛出被
 * `refresh()` 的 `void` 吞掉，界面只剩"未装配或正在启动"，把装配缺陷伪装成"再等等"。
 *
 * @param ctx - 浏览器侧 Cordis 上下文。
 * @returns speech Remote 的最小面；该命名空间未挂载或形状不符时 undefined。
 */
export function speechRemoteOf(ctx: ClientContext): SpeechRemoteLike | undefined {
  const speech = ctx.get('remote.speech') as SpeechRemoteLike | undefined
  if (speech === undefined || typeof speech.catalog !== 'function') return undefined
  return speech
}

/** Store 快照（React 侧只读它）。 */
export interface VoiceSetupSnapshot {
  /** 对话框是否打开。 */
  readonly open: boolean
  /** speech Remote 是否可达（未装配 / 未挂载时为 false）。 */
  readonly connected: boolean
  /** 最近一次 catalog / 连接失败的文案。 */
  readonly error: string | null
  /**
   * 最近一次**用户动作**（准备 / 取消）失败的文案，与 `error` 分开：
   * 轮询成功会把 `error` 清掉，而动作失败必须留在界面上直到下一次动作。
   */
  readonly actionError: string | null
  /** 最近一次成功的 catalog。 */
  readonly catalog: VoiceCatalogView | null
  /** 正在执行的用户动作（按钮禁用用）。 */
  readonly pending: 'prepare' | 'cancel' | null
}

/** 语音设置面的最小 store（无框架依赖，便于单测）。 */
export interface VoiceSetupStore {
  snapshot: () => VoiceSetupSnapshot
  subscribe: (listener: () => void) => () => void
  open: () => void
  close: () => void
  refresh: () => Promise<void>
  prepare: () => Promise<void>
  cancel: () => Promise<void>
  dispose: () => void
}

/** 选中要展示的提供者：优先 selection，其次本地提供者，最后第一个。 */
export function selectVoiceProvider(catalog: VoiceCatalogView | null): VoiceProviderView | undefined {
  const providers = catalog?.providers ?? []
  const selected = catalog?.selection?.providerId
  if (typeof selected === 'string') {
    const match = providers.find(provider => provider.id === selected)
    if (match !== undefined) return match
  }
  return providers.find(provider => provider.id === VOICE_LOCAL_PROVIDER_ID) ?? providers[0]
}

/** 人类可读的字节数（MB，保留一位小数；0 与未知分别显示）。 */
export function formatVoiceBytes(bytes: number | undefined): string | undefined {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return undefined
  const megabytes = bytes / (1024 * 1024)
  return megabytes >= 100 ? `${Math.round(megabytes)} MB` : `${megabytes.toFixed(1)} MB`
}

/**
 * 一个阶段的展示文案键（`locales.ts` 的 key）。
 * @param phase - 准备阶段。
 * @returns 文案键（未知/缺省阶段按"已就绪"处理，与上游 `preparation ?? {phase:'ready'}` 同口径）。
 */
export function voicePhaseKey(phase: VoicePreparationPhase | undefined): Parameters<typeof t>[0] {
  switch (phase) {
    case 'unprepared': return 'voice.phase.unprepared'
    case 'downloading': return 'voice.phase.downloading'
    case 'checking': return 'voice.phase.checking'
    case 'loading': return 'voice.phase.loading'
    case 'waking': return 'voice.phase.waking'
    case 'cancelling': return 'voice.phase.cancelling'
    case 'failed': return 'voice.phase.failed'
    case 'cancelled': return 'voice.phase.cancelled'
    default: return 'voice.phase.ready'
  }
}

/** 失败原因的可检索文案（`reason`/`code`/HTTP 状态；没有就给 undefined）。 */
export function voiceFailureDetail(
  download: VoiceProviderView['preparation']['download'],
  message?: string,
): string | undefined {
  const parts: string[] = []
  if (typeof message === 'string' && message.trim().length > 0) parts.push(message.trim())
  if (download !== undefined) {
    const reason = typeof download.reason === 'string' && download.reason.length > 0 ? download.reason : undefined
    if (reason !== undefined) {
      const code = typeof download.code === 'string' && download.code.length > 0 ? download.code : undefined
      const status = typeof download.status === 'number' ? String(download.status) : undefined
      parts.push([reason, code, status].filter(part => part !== undefined).join('/'))
    }
  }
  return parts.length > 0 ? parts.join(' — ') : undefined
}

/** 构造 store；`resolveRemote` 每次调用重新解析（Remote 随 fiber 存活，不能缓存句柄）。 */
export function createVoiceSetupStore(resolveRemote: () => SpeechRemoteLike | undefined): VoiceSetupStore {
  let snapshot: VoiceSetupSnapshot = {
    open: false, connected: false, error: null, actionError: null, catalog: null, pending: null,
  }
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setInterval> | undefined
  let disposed = false

  const publish = (patch: Partial<VoiceSetupSnapshot>): void => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of [...listeners]) listener()
  }
  const stopPolling = (): void => {
    if (timer !== undefined) { clearInterval(timer); timer = undefined }
  }
  /**
   * 取 Remote；**取服务本身抛错**（拓扑/装配缺陷）时把原因带出来。
   * 与"服务缺席"分开：缺席由 `voice.unavailable` 文案覆盖，抛错必须可见，
   * 否则界面把配置错误显示成"再等等"（2026-09-29 实测：属性代理读法抛
   * `cannot get property "remote" without inject`，被 `void refresh()` 吞掉）。
   */
  const resolveRemoteOrReport = (): { remote: SpeechRemoteLike | undefined, failure: string | null } => {
    try {
      return { remote: resolveRemote(), failure: null }
    } catch (cause) {
      return { remote: undefined, failure: describeRemoteFailure(cause) }
    }
  }

  const refresh = async (): Promise<void> => {
    const { remote, failure } = resolveRemoteOrReport()
    if (remote === undefined) {
      publish({ connected: false, error: failure })
      return
    }
    try {
      const result = await remote.catalog()
      if (disposed) return
      if (result.ok) publish({ connected: true, catalog: result.value, error: null })
      else publish({ connected: true, error: describeRemoteFailure(result.error) })
    } catch (cause) {
      if (!disposed) publish({ connected: true, error: describeRemoteFailure(cause) })
    }
  }

  const runAction = async (kind: 'prepare' | 'cancel'): Promise<void> => {
    const { remote, failure } = resolveRemoteOrReport()
    if (remote === undefined) {
      publish({ connected: false, error: failure })
      return
    }
    publish({ pending: kind, actionError: null })
    try {
      const provider = selectVoiceProvider(snapshot.catalog)
      const providerId = provider?.id ?? VOICE_LOCAL_PROVIDER_ID
      const result = kind === 'prepare'
        // 第二参数必须显式占位：typert Remote 严格校验入参个数（见 SpeechRemoteLike.prepare）。
        ? await remote.prepare(providerId, undefined)
        : await remote.cancelPreparation(providerId)
      if (disposed) return
      publish({ pending: null, actionError: result.ok ? null : describeRemoteFailure(result.error) })
    } catch (cause) {
      if (!disposed) publish({ pending: null, actionError: describeRemoteFailure(cause) })
    }
    // 刷新的是 catalog（进度）；动作失败留在 actionError，不被这次成功覆盖。
    await refresh()
  }

  return {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open() {
      publish({ open: true, actionError: null })
      void refresh()
      // 准备任务归 Host：对话框开着就持续跟随进度。
      stopPolling()
      timer = setInterval(() => { void refresh() }, VOICE_SETUP_POLL_MS)
    },
    close() {
      stopPolling()
      publish({ open: false, pending: null })
    },
    refresh,
    prepare: () => runAction('prepare'),
    cancel: () => runAction('cancel'),
    dispose() {
      disposed = true
      stopPolling()
      listeners.clear()
    },
  }
}

/** `RemoteFailure` / 任意异常 → 一行可读文案。 */
function describeRemoteFailure(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  if (typeof error === 'object' && error !== null) {
    const record = error as { message?: unknown, code?: unknown }
    if (typeof record.message === 'string' && record.message.length > 0) return record.message
    if (typeof record.code === 'string' && record.code.length > 0) return record.code
    try { return JSON.stringify(error) } catch { return 'unknown error' }
  }
  return 'unknown error'
}

/**
 * 在桌面 client face 里补 `pluginNavigation`（语音 UI 插件 inject 它）并把
 * 语音准备面挂到 `shell.overlay`。
 * @param ctx - 浏览器侧 Cordis 上下文。
 * @returns 本面持有的 store（测试/诊断用；生命周期由 `ctx.effect` 管理）。
 */
export function applyVoiceSetup(ctx: ClientContext): VoiceSetupStore {
  const store = createVoiceSetupStore(() => speechRemoteOf(ctx))
  setVoiceSetupOverlayStore(store)
  ctx.effect(() => {
    // 我们禁用 `ui-plugin-manager`（见 `cordis.patch.yml`），所以 `pluginNavigation`
    // 没有正主、必须由桌面补位；但**一旦它被渠道覆盖层或上游默认变化重新启用**，
    // 提供权归它 —— 重复 provide 会让整棵树 fail-loud，代价远大于少一个麦克风详情面。
    if (ctx.get('pluginNavigation') !== undefined) return () => store.dispose()
    let dispose: (() => void) | undefined
    try {
      dispose = ctx.reflect.provide('pluginNavigation', {
        // 只有语音 bundle 有我们自己的详情面；别的 bundle 名（上游其它可选 bundle）
        // 不静默打开任何东西 —— 我们禁用了插件管理页，假装能打开才是更坏的行为。
        openBundle: (packageName: string): void => {
          if (packageName === VOICE_INPUT_BUNDLE) store.open()
        },
      })
    } catch (cause) {
      // 补位失败只影响"模型准备详情面"这一条入口（麦克风按钮照常出现），
      // 不能让整个 client face 因为一个可选服务挂掉。
      console.warn('[desktop] pluginNavigation 补位失败，语音准备面不可达：', cause)
      return () => store.dispose()
    }
    return () => {
      store.dispose()
      void dispose()
    }
  }, 'desktop: pluginNavigation + voice setup surface')
  ctx.effect(
    () => ctx.slots.inject(
      'shell.overlay',
      () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'desktop-voice-setup',
        order: 30,
      }, VoiceSetupOverlay),
    ),
    'desktop: voice setup overlay',
  )
  return store
}

/** 覆盖层组件的 props：槽位不给参数，组件自己订阅 store（与更新徽标同一姿势）。 */
export interface VoiceSetupOverlayProps {
  /** 测试注入：替身 store。 */
  readonly store?: VoiceSetupStore
}

/** 覆盖层组件。 */
export function VoiceSetupOverlay({ store }: VoiceSetupOverlayProps = {}): ReactElement | null {
  const active = store ?? overlayStore
  const [state, setState] = useState<VoiceSetupSnapshot>(() => active.snapshot())
  useEffect(() => active.subscribe(() => setState(active.snapshot())), [active])
  if (!state.open) return null
  return <VoiceSetupDialog store={active} state={state} />
}

/** 对话框（与覆盖层分开，便于快照测试）。 */
export function VoiceSetupDialog({ store, state }: {
  readonly store: VoiceSetupStore
  readonly state: VoiceSetupSnapshot
}): ReactElement {
  const provider = selectVoiceProvider(state.catalog)
  const phase = provider?.preparation.phase
  const downloading = phase === 'downloading'
  const busy = state.pending !== null || phase === 'checking' || phase === 'loading' || phase === 'cancelling'
  const detail = voiceFailureDetail(provider?.preparation.download, phase === 'failed' ? provider?.preparation.message : undefined)
  const estimate = provider?.setupEstimate
  const disk = formatVoiceBytes(estimate?.recommendedDiskBytes)
  const download = formatVoiceBytes(VOICE_INT8_DOWNLOAD_BYTES)
  const progress = downloading
    ? [formatVoiceBytes(provider?.preparation.completedBytes), formatVoiceBytes(provider?.preparation.totalBytes)]
      .filter((part): part is string => part !== undefined).join(' / ')
    : undefined
  const lines: string[] = []
  if (!state.connected) lines.push(t('voice.unavailable'))
  else if (provider === undefined) lines.push(t('voice.noProvider'))
  else {
    lines.push(`${provider.name} — ${t(voicePhaseKey(phase))}`)
    if (progress !== undefined && progress.length > 0) lines.push(progress)
    if (detail !== undefined) lines.push(detail)
    if (phase === 'unprepared' && disk !== undefined) {
      lines.push(t('voice.estimate', { download: download ?? '—', disk }))
    }
  }
  if (state.error !== null) lines.push(state.error)
  if (state.actionError !== null) lines.push(state.actionError)
  const canPrepare = state.connected && provider !== undefined
    && (phase === 'unprepared' || phase === 'cancelled' || phase === 'failed')
  const canCancel = state.connected && provider !== undefined && (phase === 'downloading' || phase === 'checking' || phase === 'loading')
  return (
    <Modal
      open
      title={t('voice.title')}
      closeLabel={t('voice.close')}
      onClose={() => store.close()}
      footer={(
        <>
          {canCancel
            ? <Button variant="ghost" disabled={state.pending !== null} onClick={() => { void store.cancel() }}>{t('voice.cancel')}</Button>
            : null}
          {canPrepare
            ? <Button variant="primary" data-modal-autofocus disabled={busy} onClick={() => { void store.prepare() }}>
              {phase === 'failed' || phase === 'cancelled' ? t('voice.retry') : t('voice.download')}
            </Button>
            : null}
          <Button variant="ghost" onClick={() => store.close()}>{t('voice.close')}</Button>
        </>
      )}
    >
      <div className="dshDesktopVoiceSetup">
        <p>{t('voice.intro')}</p>
        {lines.map((line, index) => <p key={`${index}-${line}`} className="dshDesktopVoiceState">{line}</p>)}
        <p className="dshDesktopVoicePrivacy">{t('voice.privacy')}</p>
      </div>
    </Modal>
  )
}

/** 最近一次 `applyVoiceSetup` 注册的 store（槽位组件拿不到 ctx，用它取值）。 */
let overlayStore: VoiceSetupStore = createVoiceSetupStore(() => undefined)

/** 仅供测试：替换覆盖层读的 store。 */
export function setVoiceSetupOverlayStore(store: VoiceSetupStore): void {
  overlayStore = store
}
