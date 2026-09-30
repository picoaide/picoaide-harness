/**
 * 语音输入准备面（2026-09-29 默认开启）的判据。
 *
 * 三条互相独立的面：
 *   1. **装配契约**：桌面 profile 必须装配上游 voice-input-bundle，而 bundle 的四条行 id
 *      与本地提供者 id 是它的对外契约 —— 上游改名即红（我们不改上游，只能跟上）。
 *   2. **store 行为**：轮询、准备/取消、Remote 缺席的降级、关闭即停轮询。
 *   3. **pluginNavigation 补位**：语音 UI 插件 `inject` 它，我们禁用 ui-plugin-manager
 *      后必须自己 provide；`openBundle` 只认语音 bundle，其它 bundle 名不得静默打开任何面。
 *   4. **服务解析拓扑**（文件末一组）：用真 Cordis 搭"provider / mount / 消费者三棵兄弟
 *      fiber"的形态，钉住 `speechRemoteOf` 走 `ctx.get('remote.speech')`。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Context as ClientContext } from '@deepseek-ai/cordis'

// 平台模块在运行期由 shell 的冻结模块表提供（桌面客户端 bundle 里它是 external），
// vitest 环境里拿不到它的运行时依赖（clsx 等）。本 spec 只测 store/补位逻辑、不渲染，
// 因此替成品组件（与 account-card spec 同一姿势）。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: () => null,
  Modal: () => null,
}))
import { inject as desktopClientInject } from '../src/client/index.ts'
import {
  applyVoiceSetup,
  createVoiceSetupStore,
  formatVoiceBytes,
  selectVoiceProvider,
  speechRemoteOf,
  VOICE_INPUT_BUNDLE,
  VOICE_INT8_DOWNLOAD_BYTES,
  VOICE_LOCAL_PROVIDER_ID,
  voiceFailureDetail,
  voicePhaseKey,
  type SpeechRemoteLike,
  type VoiceCatalogView,
  type VoiceSetupStore,
} from '../src/client/voice-setup.tsx'
import { en, zh } from '../src/client/locales.ts'

const bundleRoot = new URL('../node_modules/@deepseek-ai/dsh-experimental-voice-input-bundle/', import.meta.url)

/** 一份"未准备"的 catalog（形状取自上游 SpeechCatalog）。 */
function catalogWith(phase: string): VoiceCatalogView {
  return {
    providers: [{
      id: VOICE_LOCAL_PROVIDER_ID,
      name: 'SenseVoiceSmall (INT8)',
      location: 'host-local',
      languages: ['zh', 'en'],
      setupEstimate: { recommendedDiskBytes: 239_233_841, minimumMinutes: 5, maximumMinutes: 30 },
      preparation: { phase: phase as VoiceCatalogView['providers'][number]['preparation']['phase'] },
    }],
    selection: { providerId: VOICE_LOCAL_PROVIDER_ID, language: 'zh' },
    maxAudioBytes: 4 * 1024 * 1024,
    maxDurationSeconds: 120,
  }
}

/**
 * Remote 替身（三个方法都是 `RemoteResult`）。
 *
 * `prepare` 额外做一件事：**按真实 typert 语义校验入参个数**（可选参数也算），
 * 少传一个就返回失败 —— 真实现会抛 `client api: speech/prepare expected 2
 * argument(s), got 1`（打包版实测），替身不校验就会让"少传一个参数"再次假绿。
 */
function fakeRemote(catalog: VoiceCatalogView = catalogWith('unprepared')): SpeechRemoteLike & {
  catalog: ReturnType<typeof vi.fn>
  prepare: ReturnType<typeof vi.fn>
  cancelPreparation: ReturnType<typeof vi.fn>
} {
  return {
    catalog: vi.fn(async () => ({ ok: true as const, value: catalog })),
    prepare: vi.fn(async (...args: unknown[]) => (args.length === 2
      ? { ok: true as const, value: undefined }
      : { ok: false as const, error: new Error(`client api: speech/prepare expected 2 argument(s), got ${String(args.length)}`) })),
    cancelPreparation: vi.fn(async () => ({ ok: true as const, value: undefined })),
  }
}

/**
 * 最小 client 上下文替身：只实现 applyVoiceSetup 用到的那几面。
 *
 * **speech Remote 必须经 `get('remote.speech')` 提供**，不能挂成 `ctx.remote`
 * 属性 —— 后者在真实 Cordis 里不存在（属性代理只在 inject 了 `remote` 的 fiber
 * 里成立），替身照抄属性会让用例假绿。真实拓扑判据见本文件末尾
 * `real Cordis topology` 一组。
 */
function fakeClientContext(speech?: SpeechRemoteLike): {
  ctx: ClientContext
  provided: Map<string, unknown>
  registrations: { name: string, id?: string }[]
} {
  const provided = new Map<string, unknown>()
  if (speech !== undefined) provided.set('remote.speech', speech)
  const registrations: { name: string, id?: string }[] = []
  const ctx = {
    effect(factory: () => unknown) {
      const product = factory()
      return typeof product === 'function' ? product : () => {}
    },
    // 两处都按服务名取：`pluginNavigation`（上游管理页在不在场）与
    // `remote.speech`（语音准备面）。
    get(name: string) { return provided.get(name) },
    reflect: {
      provide(name: string, value: unknown) {
        provided.set(name, value)
        return () => { provided.delete(name) }
      },
    },
    slots: {
      inject(_name: string, callback: () => unknown) { return callback() },
      register(options: { name: string, id?: string }) {
        registrations.push(options.id === undefined
          ? { name: options.name }
          : { name: options.name, id: options.id })
        return () => {}
      },
    },
  }
  return { ctx: ctx as unknown as ClientContext, provided, registrations }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('voice input assembly contract (upstream bundle)', () => {
  it('keeps the four bundle rows and the local provider id the desktop relies on', () => {
    const patch = readFileSync(new URL('cordis.patch.yml', bundleRoot), 'utf8')
    for (const row of ['speech-to-text', 'speech-to-text-sensevoice', 'api-speech-to-text', 'ui-voice-input']) {
      expect(patch, `voice-input-bundle 少了 ${row} 行`).toContain(`id: ${row}`)
    }
    // bundle 的缺省提供者就是我们在 UI 里准备的那个；上游改名即红。
    expect(patch).toContain(`defaultProvider: ${VOICE_LOCAL_PROVIDER_ID}`)
  })

  it('uses Remote method names that still exist in the pinned api package', () => {
    const clientTypes = readFileSync(
      new URL('../node_modules/@deepseek-ai/dsh-experimental-api-speech-to-text/lib/typert.remote-client.d.ts', import.meta.url),
      'utf8',
    )
    for (const method of ['catalog:', 'prepare:', 'cancelPreparation:']) {
      expect(clientTypes, `remote.speech 少了 ${method}`).toContain(method)
    }
  })

  it('states the real int8 download size, not upstream\'s disk reservation number', () => {
    // 界面里"下载约 X / 占盘约 Y"必须是两个数：上游 `recommendedDiskBytes` 是**预留**建议
    // （int8 恒 1e9 字节 = 954MiB），拿它当下载量会把 228MB 说成 954MB（打包版实测）。
    // 这里对着随包 assets.json 对拍 —— 上游换模型即红。
    const assets = JSON.parse(readFileSync(
      new URL('../node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/runtime/assets.json', import.meta.url),
      'utf8',
    )) as { models: { int8: { bytes: number } }, tokens: { bytes: number }, vad: { bytes: number } }
    expect(assets.models.int8.bytes).toBe(VOICE_INT8_DOWNLOAD_BYTES)
    // 与上游进度条同口径：准备面的 `totalBytes` 就是 int8 这一个文件（真机实测
    // "94.9 MB / 228 MB" → "228 MB / 228 MB"），tokens 与 VAD（约 2MB）另计。
    expect(formatVoiceBytes(VOICE_INT8_DOWNLOAD_BYTES)).toBe('228 MB')
    expect(assets.tokens.bytes + assets.vad.bytes).toBeLessThan(4 * 1024 * 1024)
    // 文案必须同时带 `{download}` 与 `{disk}` 两个占位符（少一个就有数字被吞掉）。
    for (const copy of [zh['voice.estimate'], en['voice.estimate']]) {
      expect(copy).toContain('{download}')
      expect(copy).toContain('{disk}')
    }
  })
})

describe('voice setup helpers', () => {
  it('prefers the selected provider, then the local one, then the first', () => {
    const local = catalogWith('unprepared')
    expect(selectVoiceProvider(local)?.id).toBe(VOICE_LOCAL_PROVIDER_ID)
    const other: VoiceCatalogView = {
      ...local,
      providers: [
        { ...local.providers[0]!, id: 'cloud-x', name: 'Cloud X' },
        { ...local.providers[0]!, id: 'host-y', name: 'Host Y' },
      ],
      selection: { providerId: 'host-y' },
    }
    expect(selectVoiceProvider(other)?.id).toBe('host-y')
    expect(selectVoiceProvider({ ...other, selection: { providerId: 'missing' } })?.id).toBe('cloud-x')
    expect(selectVoiceProvider(null)).toBeUndefined()
  })

  it('maps every preparation phase to a localized line, defaulting to ready', () => {
    expect(voicePhaseKey('unprepared')).toBe('voice.phase.unprepared')
    expect(voicePhaseKey('downloading')).toBe('voice.phase.downloading')
    expect(voicePhaseKey('failed')).toBe('voice.phase.failed')
    expect(voicePhaseKey(undefined)).toBe('voice.phase.ready')
    // 文案必须真的存在（zh 是 key 源，en 由类型镜像）。
    for (const phase of ['unprepared', 'downloading', 'checking', 'loading', 'waking', 'cancelling', 'failed', 'cancelled', null] as const) {
      expect(zh[voicePhaseKey(phase ?? undefined)]).toBeTruthy()
    }
  })

  it('composes a searchable failure line and formats download sizes', () => {
    expect(voiceFailureDetail({ reason: 'network', code: 'ETIMEDOUT', status: 504 }, 'download failed'))
      .toBe('download failed — network/ETIMEDOUT/504')
    expect(voiceFailureDetail({ reason: 'dns' })).toBe('dns')
    expect(voiceFailureDetail(undefined, '   ')).toBeUndefined()
    expect(voiceFailureDetail(undefined)).toBeUndefined()
    expect(formatVoiceBytes(239_233_841)).toBe('228 MB')
    expect(formatVoiceBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatVoiceBytes(0)).toBeUndefined()
    expect(formatVoiceBytes(undefined)).toBeUndefined()
  })
})

describe('voice setup store', () => {
  it('follows preparation state by polling while the dialog is open', async () => {
    vi.useFakeTimers()
    const remote = fakeRemote(catalogWith('unprepared'))
    const store = createVoiceSetupStore(() => remote)
    const seen: boolean[] = []
    const unsubscribe = store.subscribe(() => seen.push(store.snapshot().open))
    store.open()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.snapshot()).toMatchObject({ open: true, connected: true, error: null })
    expect(selectVoiceProvider(store.snapshot().catalog)?.preparation.phase).toBe('unprepared')
    const first = remote.catalog.mock.calls.length
    remote.catalog.mockImplementation(async () => ({ ok: true as const, value: catalogWith('downloading') }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(remote.catalog.mock.calls.length).toBeGreaterThan(first)
    expect(selectVoiceProvider(store.snapshot().catalog)?.preparation.phase).toBe('downloading')
    // 关闭即停轮询（准备任务本身归 Host，不取消）。
    store.close()
    const afterClose = remote.catalog.mock.calls.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(remote.catalog.mock.calls.length).toBe(afterClose)
    expect(store.snapshot().open).toBe(false)
    expect(seen.length).toBeGreaterThan(0)
    unsubscribe()
    store.dispose()
  })

  it('prepares and cancels through the Remote with the local provider id', async () => {
    const remote = fakeRemote()
    const store = createVoiceSetupStore(() => remote)
    store.open()
    await store.refresh()
    await store.prepare()
    // **两个参数**：typert Remote 严格校验入参个数，第二个（可选的 options）也必须占位；
    // 少传就是 `expected 2 argument(s), got 1`，替身会把它变成 actionError。
    expect(remote.prepare.mock.calls[0]).toHaveLength(2)
    expect(remote.prepare).toHaveBeenCalledWith(VOICE_LOCAL_PROVIDER_ID, undefined)
    expect(store.snapshot().actionError).toBeNull()
    expect(store.snapshot().pending).toBeNull()
    await store.cancel()
    expect(remote.cancelPreparation).toHaveBeenCalledWith(VOICE_LOCAL_PROVIDER_ID)
    store.dispose()
  })

  it('surfaces a failed prepare and keeps the dialog usable', async () => {
    const remote = fakeRemote()
    remote.prepare.mockResolvedValueOnce({ ok: false as const, error: new Error('download blocked by policy') })
    const store = createVoiceSetupStore(() => remote)
    store.open()
    await store.refresh()
    await store.prepare()
    expect(store.snapshot().actionError).toBe('download blocked by policy')
    expect(store.snapshot().pending).toBeNull()
    store.dispose()
  })

  it('degrades to "not connected" when the speech Remote is absent (bundle not mounted)', async () => {
    const store = createVoiceSetupStore(() => undefined)
    store.open()
    await store.refresh()
    expect(store.snapshot()).toMatchObject({ open: true, connected: false, catalog: null })
    // 缺 Remote 时两个动作都不得抛（按钮仍可点，只是没有可做的事）。
    await expect(store.prepare()).resolves.toBeUndefined()
    await expect(store.cancel()).resolves.toBeUndefined()
    expect(store.snapshot().connected).toBe(false)
    store.dispose()
  })

  it('reports a catalog failure instead of silently showing stale state', async () => {
    const remote = fakeRemote()
    const store = createVoiceSetupStore(() => remote)
    remote.catalog.mockResolvedValueOnce({ ok: false as const, error: { code: 'speech/unavailable' } })
    await store.refresh()
    expect(store.snapshot().connected).toBe(true)
    expect(store.snapshot().error).toBe('speech/unavailable')
    // 下一轮成功刷新清掉连接错误；动作错误另有一格（见上一条用例）。
    await store.refresh()
    expect(store.snapshot().error).toBeNull()
    store.dispose()
  })

  it('surfaces a throwing resolver instead of reporting "not ready"', async () => {
    // 2026-09-29 实测形态：取服务的那一步抛错（`cannot get property "remote"
    // without inject`）被 `void refresh()` 吞掉，界面只剩"未装配或正在启动"。
    const store = createVoiceSetupStore(() => {
      throw new Error('cannot get property "remote" without inject')
    })
    store.open()
    await store.refresh()
    expect(store.snapshot().connected).toBe(false)
    expect(store.snapshot().error).toBe('cannot get property "remote" without inject')
    await store.prepare()
    expect(store.snapshot().error).toBe('cannot get property "remote" without inject')
    store.dispose()
  })
})

describe('pluginNavigation provider', () => {
  it('provides pluginNavigation and registers the setup overlay on shell.overlay', () => {
    const harness = fakeClientContext()
    const store: VoiceSetupStore = applyVoiceSetup(harness.ctx)
    expect(harness.provided.has('pluginNavigation')).toBe(true)
    expect(harness.registrations).toEqual([{ name: 'shell.overlay', id: 'desktop-voice-setup' }])
    expect(store.snapshot().open).toBe(false)
  })

  it('opens the setup surface for the voice bundle only', () => {
    const harness = fakeClientContext()
    const store = applyVoiceSetup(harness.ctx)
    const navigation = harness.provided.get('pluginNavigation') as { openBundle: (name: string) => void }
    // 别的 bundle（上游其它可选 bundle）不得静默打开我们的面。
    navigation.openBundle('@deepseek-ai/dsh-experimental-agent-team-profile')
    expect(store.snapshot().open).toBe(false)
    navigation.openBundle(VOICE_INPUT_BUNDLE)
    expect(store.snapshot().open).toBe(true)
    store.close()
    expect(store.snapshot().open).toBe(false)
  })

  it('reads the live speech Remote through the client context', async () => {
    const remote = fakeRemote()
    const harness = fakeClientContext(remote)
    const store = applyVoiceSetup(harness.ctx)
    store.open()
    await store.refresh()
    expect(store.snapshot().connected).toBe(true)
    expect(remote.catalog).toHaveBeenCalled()
    store.dispose()
  })
})

/**
 * 真实 Cordis 拓扑下的判据（2026-09-29 定案）。
 *
 * 背景：`remote.speech` 由 api-gateway client 在 `$mount` 时 `provide`，而
 * **属性代理 `ctx.remote.speech` 只在 inject 了 `remote` 的 fiber 里成立** ——
 * 桌面 client 插件没有（也不该有）这条硬依赖，属性读法会抛
 * `cannot get property "remote" without inject`。本组用真框架搭出
 * "provider / mount / 消费者是三棵兄弟 fiber"的形态，钉住 `speechRemoteOf`
 * 必须走 `ctx.get('remote.speech')`：把实现改回属性读法即红（抛错或取不到）。
 */
describe('speech Remote resolution (real Cordis topology)', () => {
  it('reaches remote.speech from the desktop client fiber without injecting remote', async () => {
    const root = new Context()
    const speech = fakeRemote()
    // ① `remote` 服务本身（api-gateway client 的角色）与桌面插件声明的其余注入。
    await root.plugin({
      name: 'client-services',
      apply(ctx: ClientContext) {
        ctx.provide('remote', {})
        for (const name of desktopClientInject) {
          if (name !== 'remote') ctx.provide(name, {})
        }
      },
    })
    // ② 命名空间服务由 `remote` 的持有者挂载（`$mount` 的角色）。
    await root.plugin({
      name: 'voice-mount',
      inject: ['remote'],
      apply(ctx: ClientContext) { ctx.provide('remote.speech', speech) },
    })
    // ③ 桌面 client 插件用**真实 inject 列表**启动，只跑解析这一步。
    let resolved: SpeechRemoteLike | undefined
    await root.plugin({
      name: 'desktop-client',
      inject: [...desktopClientInject],
      apply(ctx: ClientContext) { resolved = speechRemoteOf(ctx) },
    })
    expect(resolved).toBeDefined()
    expect(typeof resolved!.catalog).toBe('function')
    await expect(resolved!.catalog()).resolves.toMatchObject({ ok: true })
  })
})

/** 确保 spec 里引用的路径解析与运行时一致（打包态由 `verify:closure` 兜底）。 */
it('resolves the bundle patch from the installed package', () => {
  expect(fileURLToPath(bundleRoot).endsWith('dsh-experimental-voice-input-bundle/')).toBe(true)
})
