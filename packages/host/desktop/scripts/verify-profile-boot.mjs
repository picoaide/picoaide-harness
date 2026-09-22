/** Headless smoke for the complete published PicoAide Harness profile and renderer manifest. */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import { DESKTOP_SETTINGS_NAMESPACE } from '../lib/index.js'
import { NO_OWNER_LOCK_MIN_AGE_MS, reclaimOrphanedDocumentLocks } from '../lib/document-lock-recovery.js'
import { installProfilePackageResolver } from '../lib/module-resolution.js'
import { prepareDesktopProfile } from '../lib/profile.js'
import { inactiveRequiredRows, FIBER_FAILED } from '../lib/startup-rows.js'

// 产物清理(2026-09): 依赖包 lib/ 不再入库, fresh checkout 下 profile smoke
// 需要先构建全部 workspace 依赖(cron/connectors/browser 等),
// 否则临时 profile 的 node_modules 里缺 lib/index.js —— CI yarn check 失败根因。
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const { prebuildWorkspaceDeps } = await import('./prebuild-workspace-deps.ts')
prebuildWorkspaceDeps(packageRoot)

const BIN_NAME = 'dsh-plugin-desktop-profile-smoke'
const HOST_SERVICE_PLUGIN_NAME = 'dsh-desktop-host-services-smoke-plugin'
const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-'))
// Isolate the product home for the whole boot: profile files live in the
// temporary home, and every plugin resolves its data dir through `$DSH_HOME`
// (`dshHome()`), so without this override the smoke would initialize real
// plugin storage (cron/task/memory) under the user's actual home.
const previousDshHome = process.env.DSH_HOME
process.env.DSH_HOME = home
let ctx
let releasePackageResolver
let mountedSpec
let nativeThemeSource = 'system'
const trayItems = []

try {
  writeFileSync(join(home, 'settings.yaml'), [
    'dsh-desktop:',
    '  mode: advanced',
    'agent-presets:',
    '  default: minimal',
    '',
  ].join('\n'))

  // ---- 孤儿写锁：能力判据（不是字符串判据）----------------------------------
  // 现场事故（2026-09-22，客户机）：数据根里一个 0 字节的 `settings.yaml.lock` 让
  // settings 的**每一次**写入都等 2s 后超时失败（被插件的 .catch 吞掉），于是
  // `llm-deepseek.protocol: chat-completions` 永远写不进去 —— 客户端升级到 0.1.6
  // 后每个模型请求都 401「缺少认证令牌」。这里用 settings provider 的**同一条写缝**
  // （`withFileLock` + `writeFileAtomic`）在真实 <home>/settings.yaml 上跑四段：
  //   ① 刚建的 0 字节锁（活写者的"已建锁未写 PID"窗口）⇒ 回收必须**保留**它；
  //   ② 把它拨老到门槛之外 ⇒ 同一条写缝必须超时失败（复现故障机制，反向对照）；
  //   ③ main.ts 的回收（同一份 lib 产物、同一个数据根）⇒ 锁没了且写缝恢复；
  //   ④ 活锁（属主不是本进程）⇒ **必须保留**并上报（我们绝不替人删活锁）。
  // 写回的内容是文件原字节，所以后面的断言看到的 settings 与之前完全一致。
  const settingsPath = join(home, 'settings.yaml')
  const settingsBytes = readFileSync(settingsPath, 'utf8')
  const writeThroughSettingsSeam = async () => withFileLock(settingsPath, async () => {
    await writeFileAtomic(settingsPath, readFileSync(settingsPath, 'utf8'), { mode: 0o600, dirMode: 0o700 })
  }, { waitMs: 250 })

  writeFileSync(`${settingsPath}.lock`, '')
  const freshLock = reclaimOrphanedDocumentLocks({ home })
  if (freshLock.reclaimed.length !== 0 || freshLock.kept.length !== 1 || !existsSync(`${settingsPath}.lock`)) {
    throw new Error(`a freshly created ownerless lock must be kept (live-writer window): ${JSON.stringify(freshLock)}`)
  }

  const staleSeconds = (Date.now() - NO_OWNER_LOCK_MIN_AGE_MS - 5_000) / 1000
  utimesSync(`${settingsPath}.lock`, staleSeconds, staleSeconds)
  let blockedByOrphan = false
  try {
    await writeThroughSettingsSeam()
  } catch {
    blockedByOrphan = true
  }
  if (!blockedByOrphan) {
    throw new Error('an orphaned settings.yaml.lock did NOT block the settings write seam (reverse control is broken)')
  }
  if (!existsSync(`${settingsPath}.lock`)) {
    throw new Error('the planted orphan lock vanished without recovery; the reverse control cannot be trusted')
  }

  const recovery = reclaimOrphanedDocumentLocks({ home })
  if (!recovery.reclaimed.some(lock => lock.document === 'settings.yaml')) {
    throw new Error(`document lock recovery did not reclaim the orphaned settings lock: ${JSON.stringify(recovery)}`)
  }
  if (existsSync(`${settingsPath}.lock`)) {
    throw new Error('document lock recovery reported the lock but left it on disk')
  }
  await writeThroughSettingsSeam()
  if (readFileSync(settingsPath, 'utf8') !== settingsBytes) {
    throw new Error('the settings write seam changed the document content unexpectedly')
  }
  if (existsSync(`${settingsPath}.lock`)) {
    throw new Error('a successful locked write must release the settings lock')
  }

  writeFileSync(`${settingsPath}.lock`, `${String(process.ppid)}\n`)
  const liveOwner = reclaimOrphanedDocumentLocks({ home })
  if (liveOwner.reclaimed.length !== 0 || liveOwner.held.length !== 1) {
    throw new Error(`document lock recovery must keep a lock held by another live process: ${JSON.stringify(liveOwner)}`)
  }
  rmSync(`${settingsPath}.lock`)

  const prepared = await prepareDesktopProfile('1', home, 'win32')
  const hostServicePluginDir = join(
    prepared.profile.dir,
    'node_modules',
    HOST_SERVICE_PLUGIN_NAME,
  )
  mkdirSync(join(prepared.profile.dir, 'node_modules'), { recursive: true })
  cpSync(
    fileURLToPath(new URL('../tests/fixtures/desktop-host-services-smoke-plugin/', import.meta.url)),
    hostServicePluginDir,
    { recursive: true, force: false, errorOnExist: true },
  )
  const patches = [
    {
      insert: [{
        id: 'desktop-host-services-smoke-plugin',
        name: HOST_SERVICE_PLUGIN_NAME,
      }],
    },
    ...prepared.patches,
  ]
  releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
  const runtime = {
    platform: 'win32',
    locale: 'en',
    updates: {
      isPackaged: false,
      canDownload: true,
      currentVersion: '2.0.0',
      statePath: join(home, 'update-state.json'),
      request: async () => { throw new Error('profile smoke must not perform update requests') },
      confirmDownload: async () => false,
      showManualCheckResult: async () => {},
      downloadAndOpen: async () => {},
      notify: () => {},
    },
    schedule(spec) {
      mountedSpec = spec
      return async () => {}
    },
    async mountScheduled() {
      if (mountedSpec === undefined) throw new Error('desktop shell was not registered')
      runtime.setLocalePreference(mountedSpec.readLocalePreference())
      nativeThemeSource = mountedSpec.readThemeSource()
    },
    show() {},
    registerTrayItem(item) {
      trayItems.push(item)
      return {
        refresh() {},
        dispose() {
          const index = trayItems.indexOf(item)
          if (index >= 0) trayItems.splice(index, 1)
        },
      }
    },
    setLocalePreference(preference) { runtime.locale = preference ?? 'en' },
    setThemeSource(source) { nativeThemeSource = source },
    async requestRestart() {},
    prepareToQuit() {},
    setDeepLinkHandler() {},
  }
  ctx = await boot(
    BIN_NAME,
    prepared.rootConfig,
    patches,
    async (host) => {
      host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]))
      host.provide('desktopRuntime', runtime)
      provideCmdline(host, {
        args: ['--host', '127.0.0.1', '--port', '0'],
        exit: () => {},
      })
    },
    prepared.bareModuleBaseUrl,
  )
  await runtime.mountScheduled()

  // P0-9（2026-09-20 升级审计）：这是**唯一**挂载完整桌面组合树的地方，所以
  // 「我方必需行真的活了」只能在这里端到端证明。上游 0.1.6 的
  // `auditStartupEntries` 只对 7 个全局 required id 抛错，我方 18 个
  // `desktop-*`/`picoaide-*`/`pico-*` 行失败只打 warn（"树上不存在"与"被 disabled"
  // 两类更是被它明确忽略）、启动照常成功；运行期由 src/main.ts 的
  // `assertRequiredRowsActive` 兜底，这里让它在 CI 上可判红。
  // 清单与断言都来自 `lib/startup-rows.js`（唯一真源，两处 import 同一份）。
  const inactiveRows = inactiveRequiredRows(ctx.loader.entries())
  if (inactiveRows.length > 0) {
    throw new Error(
      'assembled desktop profile has inactive required rows:\n'
      + inactiveRows.map(row => `  - ${row.id}: ${row.reason}`).join('\n'),
    )
  }
  // 更宽的一层：**任何**已启用行都不该是 FAILED（`apply` 或配置校验抛异常）。
  // 与"必需行必须 ACTIVE"分开：PENDING 在冒烟环境里可能是合法的（某个服务本来
  // 就不存在），FAILED 则任何环境都不合法。实测（2026-09-20）本组合树 189 行、
  // 非 ACTIVE 且未 disable 的行 **0** 条 —— 所以这条不是"理论上应该"，是现状。
  const failedRows = [...ctx.loader.entries()]
    .filter(entry => entry.disabled !== true && entry.fiber?.state === FIBER_FAILED)
    .map(entry => entry.options.id)
  if (failedRows.length > 0) {
    throw new Error(`assembled desktop profile has failed Loader rows: ${failedRows.join(', ')}`)
  }

  const agentPresets = ctx.get('agentPresets')
  if (agentPresets === undefined) {
    throw new Error('assembled Windows profile is missing the agent preset roster')
  }
  const presetIds = (await agentPresets.list()).map(preset => preset.id)
  if (presetIds.includes('minimal') || !presetIds.includes('standard')) {
    throw new Error(`assembled Windows profile exposes unexpected presets: ${presetIds.join(', ')}`)
  }
  if (agentPresets.defaultId !== 'standard') {
    throw new Error(`assembled Windows profile selected unsupported default ${agentPresets.defaultId}`)
  }
  const legacyPreset = await agentPresets.resolve('minimal')
  if (legacyPreset.id !== 'minimal') {
    throw new Error(`assembled Windows profile remapped legacy preset to ${legacyPreset.id}`)
  }

  const picker = ctx.directoryPicker.capability()
  if (picker.kind !== 'browse') {
    throw new Error(`assembled Windows profile selected ${picker.kind} directory picker`)
  }
  const listing = await picker.list(home)
  if (listing.path !== home) {
    throw new Error(`assembled Windows browse picker listed ${listing.path} instead of ${home}`)
  }

  const baseUrl = `http://127.0.0.1:${String(ctx.webServer.port)}/`
  // Clean renderer root carrying the desktop markers — the URL the
  // cookie-authenticated index fetch below reads.
  const expectedUrl = (() => {
    const url = new URL(baseUrl)
    url.searchParams.set('dsh-desktop-mode', 'advanced')
    url.searchParams.set('dsh-desktop-platform', 'win32')
    return url.href
  })()
  // The shell URL the desktop plugin mounts: the 0.1.2 process launch-token
  // exchange URL with the markers restored. authenticatedUrl wipes any
  // pre-existing query, so the plugin mints the token on the bare origin
  // first and only then appends mode/platform — mirror that assembly exactly
  // (desktopRendererUrlWithToken in ../src/index.ts).
  const expectedRendererUrl = (() => {
    const url = new URL(ctx.connection.authenticatedUrl(baseUrl))
    url.searchParams.set('dsh-desktop-mode', 'advanced')
    url.searchParams.set('dsh-desktop-platform', 'win32')
    return url.href
  })()
  if (mountedSpec?.url !== expectedRendererUrl) {
    throw new Error(`desktop plugin produced an unexpected renderer URL: ${String(mountedSpec?.url)}`)
  }
  if (mountedSpec?.mode !== 'advanced') {
    throw new Error(`desktop plugin produced an unexpected shell mode: ${String(mountedSpec?.mode)}`)
  }
  if (nativeThemeSource !== 'system') {
    throw new Error(`desktop plugin produced an unexpected native theme source: ${nativeThemeSource}`)
  }
  const desktopSettings = ctx.settings.get(DESKTOP_SETTINGS_NAMESPACE)
  if (desktopSettings?.mode !== 'advanced') {
    throw new Error('assembled Host settings are missing the advanced dsh-desktop mode')
  }
  // 网关协议（2026-09-22）：`ctx.settings.get` 读的就是 llm-deepseek 适配器读的那份
  // 解析值（schema 缺省 → 组装 base → user 层）。上游 0.1.6 的缺省是 `messages`，
  // 而 messages 适配器只发 `x-api-key`、不发 `Authorization`，我们的网关只认
  // `Authorization: Bearer` ⇒ 这个值不是"配置偏好"，是"每个模型请求是否 401"。
  // 组装期 pin 丢了（行改名/补丁被静默跳过/后续层整键替换）时这条会红。
  const deepSeekSection = ctx.settings.get('llm-deepseek')
  if (deepSeekSection === undefined) {
    throw new Error('assembled desktop profile has no llm-deepseek settings namespace')
  }
  if (deepSeekSection.protocol !== 'chat-completions') {
    throw new Error(`assembled desktop profile resolves llm-deepseek protocol=${String(deepSeekSection.protocol)} instead of chat-completions`)
  }
  // **现场形态**：事故机的 `llm-deepseek` 段由旧版（0.1.5 线）写入，只有
  // baseURL/apiKeyEnv/models、**没有 protocol**。这里在 user 层原样复刻它（无会话的
  // 启动会被 bootstrap/gateway-model 清空该段，所以只能在 boot 之后用 settings 写入）：
  // 缺这个键的 user 段**不得**盖掉组装期的 pin，其它键也必须原样保留。
  await ctx.settings.replace('llm-deepseek', {
    baseURL: 'https://harness.example.com/v1',
    apiKeyEnv: 'PICOAI_GATEWAY_TOKEN',
    models: [{ id: 'smoke-model', name: 'smoke-model', maxTokens: 4096, inputModalities: ['text'] }],
  })
  const fieldShaped = ctx.settings.get('llm-deepseek')
  if (fieldShaped.protocol !== 'chat-completions') {
    throw new Error(`a user llm-deepseek section without protocol shadowed the composition pin: protocol=${String(fieldShaped.protocol)}`)
  }
  if (fieldShaped.baseURL !== 'https://harness.example.com/v1' || fieldShaped.apiKeyEnv !== 'PICOAI_GATEWAY_TOKEN') {
    throw new Error(`the user llm-deepseek section lost fields: baseURL=${String(fieldShaped.baseURL)} apiKeyEnv=${String(fieldShaped.apiKeyEnv)}`)
  }
  if (fieldShaped.models?.[0]?.id !== 'smoke-model') {
    throw new Error(`the user llm-deepseek section lost its model catalog: ${JSON.stringify(fieldShaped.models)}`)
  }
  if (!trayItems.some(item => item.label() === 'Check for Updates…')) {
    throw new Error('assembled desktop profile is missing the update tray command')
  }
  if (trayItems.some(item => item.label().startsWith('Profile:'))) {
    throw new Error('assembled desktop profile unexpectedly includes the profile tray submenu')
  }
  if (trayItems.some(item => item.label() === 'Open DSH Terminal')) {
    throw new Error('assembled desktop profile unexpectedly includes the terminal tray command')
  }
  // The enterprise login gate serves its own page at the Web root while logged
  // out, so authenticate before verifying the assembled Web app root.
  ctx.picoSession.setSession({
    serverURL: 'http://127.0.0.1:1',
    username: 'profile-smoke',
    token: 'profile-smoke-token',
  })
  // Upstream 0.1.2: mint the launch-token URL, exchange it for the authority
  // cookie, then read the clean index bytes.
  const authUrl = ctx.connection.authenticatedUrl(expectedUrl)
  const exchange = await fetch(authUrl, { redirect: 'manual' })
  const cookie = exchange.headers.get('set-cookie')
  const response = await fetch(expectedUrl, { headers: cookie === null ? {} : { cookie } })
  const html = await response.text()
  if (response.status !== 200) {
    throw new Error(`assembled Web root returned HTTP ${String(response.status)}`)
  }
  // Upstream 0.1.1 wires the boot graph through the structured
  // `webserver/index-inject` table: a `global` row renders as
  // `globalThis["__DSH_BOOT__"] = {...}` (was `window.__DSH_BOOT__ = ...`).
  const bootMatch = html.match(/globalThis\["__DSH_BOOT__"\] = (\{.*?\})<\/script>/u)
  if (bootMatch?.[1] === undefined) {
    throw new Error('assembled Web root is missing window.__DSH_BOOT__')
  }
  const graph = JSON.parse(bootMatch[1])
  const ids = new Set(graph.entries.map(entry => entry.id))
  for (const id of [
    'dsh-plugin-desktop',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  ]) {
    if (!ids.has(id)) throw new Error(`assembled advanced Web graph is missing ${id}`)
  }
  for (const id of [
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-directory-picker-native',
    // Enterprise model governance: custom model providers are disabled from
    // the composition; models come from the gateway after login only.
    '@deepseek-ai/dsh-client-ui-settings-models',
    // 桌面隐藏「插件」设置选项卡(2026-09 产品决策,与 ui-settings-models
    // 同机制:desktop/cordis.patch.yml 同 id 覆盖行 disabled)。
    '@deepseek-ai/dsh-client-ui-settings-plugins',
  ]) {
    if (ids.has(id)) throw new Error(`assembled advanced Web graph unexpectedly includes ${id}`)
  }
} finally {
  await ctx?.fiber.dispose()
  releasePackageResolver?.()
  rmSync(home, { recursive: true, force: true })
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
}
