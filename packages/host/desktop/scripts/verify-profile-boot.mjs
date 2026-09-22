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
import { parse as parseYaml } from 'yaml'
import { NO_OWNER_LOCK_MIN_AGE_MS, reclaimOrphanedDocumentLocks } from '../lib/document-lock-recovery.js'
import { installProfilePackageResolver } from '../lib/module-resolution.js'
import { prepareDesktopProfile, desktopProfileContext } from '../lib/profile.js'
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
      // 与 src/main.ts 用**同一个函数**（`lib/profile.js` 的 desktopProfileContext）：
      // 生产路径与门禁路径必须同源，否则冒烟测的就不是真实启动形态 —— 这正是本
      // 冒烟此前"恰好复刻 main.ts 的缺省行为"（也不 provide）却全绿的原因。
      host.provide('profileContext', desktopProfileContext(prepared))
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

  // ── P0（issue #130「创造模式」会话全部不可用）────────────────────────────────
  // 上游 base bundle 的 `plugin-manager` 行由 `disabled: !!js "!ctx.get('profileContext')"`
  // 控制（deepseek-harness/packages/bundle/base/cordis.patch.yml:20-22）：宿主不
  // provide profileContext 时该行被**静默** disable（上游对 disabled required 条目连
  // warn 都没有）⇒ `pluginManager` 服务不存在 ⇒ cordis preset 的行
  // `tool-plugin-manager`（inject: tools/pluginManager/sandboxPolicy）永远停在 PENDING
  // ⇒ 该 preset 的会话挂不起来。三条判据缺一不可：服务在**且**行是 enabled**且**
  // profileContext 真的发布了（最后一条是前两条的因）。
  if (ctx.get('profileContext') === undefined) {
    throw new Error(
      'assembled desktop profile did not publish profileContext (src/main.ts 的 provide 掉了？): '
      + 'the plugin-manager row is gated on it, so the pluginManager service never exists and every cordis-preset session fails to mount',
    )
  }
  const loaderRow = id => [...ctx.loader.entries()].find(entry => entry.options?.id === id)
  const pluginManagerRow = loaderRow('plugin-manager')
  if (pluginManagerRow === undefined) {
    throw new Error('assembled desktop profile has no plugin-manager row in the Loader tree')
  }
  if (pluginManagerRow.disabled === true) {
    throw new Error(
      'the plugin-manager row is disabled: this desktop generation booted without profileContext, '
      + 'so the pluginManager service never exists and every cordis-preset session stalls on "waiting for pluginManager"',
    )
  }
  if (ctx.get('pluginManager') === undefined) {
    throw new Error(
      'the plugin-manager row is enabled but the pluginManager service is absent: '
      + 'cordis-preset sessions would stall on "waiting for pluginManager"',
    )
  }
  // 提供 profileContext 的**代价**（反向判据）：上游 `hmr` 行共用同一个开关，它要求
  // 存在 `appReady` 服务，而 `appReady` 只有 `@deepseek-ai/dsh-cmdline` 会 provide
  // （deepseek-harness/packages/boot/hmr/src/index.ts:200-208）—— 桌面不走 cmdline，
  // 激活即让**整棵 profile 树**加载失败（"Profile HMR requires application readiness"），
  // 比原缺陷更严重。桌面因此在 cordis.patch.yml 里显式关闭它（我们的重载/写面在
  // DesktopPluginsService）。这条断言拦的是"以后有人顺手把那行删掉或改成 disabled: false"：
  // 真删了 boot 会先炸（冒烟红），真打开了这两条也会红。
  const hmrRow = loaderRow('hmr')
  if (hmrRow === undefined) {
    throw new Error('assembled desktop profile has no hmr row: the desktop patch must disable it explicitly')
  }
  if (hmrRow.disabled !== true) {
    throw new Error(
      'the hmr row must stay disabled on the desktop host: it requires the appReady service that only the CLI provides, '
      + 'so enabling it fails the whole profile tree with "Profile HMR requires application readiness"',
    )
  }
  if (ctx.get('hmr') !== undefined) {
    throw new Error('the hmr service is present although the desktop host provides no appReady')
  }

  // ---- 读面事实：`plugin_manager` 看不到的那一片（issue #130 的**登记残留**）-------
  // 为什么必须有一条"读面"判据：`desktopProfileContext.overlays` 只覆盖**启动器 pin
  // 层**，而桌面把 desktop/enterprise/account-card/wasm-apps/foot-menu/wasm-apps-host/
  // connectors/browser/memory-evolve/cron 十个包的 `cordis.patch.yml` 注入在 **bundle
  // 层**（`src/profile.ts:571-593`）—— 既不在 profile 的 `layers` 里，也不在
  // `context.patchPath` 指向的文件里。上游 `readProfilePatches`（= `plugin-manager`
  // 读面 listPlugins 的唯一来源）只重读 layers + patchPath + home 补丁 + overlays，
  // ⇒ 这十个包的行在创造模式里落成 `readOnlyReason: 'unaddressable'`，`set_plugin`
  // 直接抛 ManagementFailure。
  //
  // **这是有意的，本轮不修组合实现**（2026-09-23 主控裁决）：让 session 内的
  // `plugin_manager` 能改写 `picoaide-*`/`pico-*`/`dsh-memory-evolve` 这些行，等于把
  // "关掉企业面/渠道面/记忆面"的能力交给模型 —— 那不是在修 bug，是在扩权。所以改为把
  // 缺口**钉死**：行集差异与读面行集都必须**恰好等于**登记值，变大变小都红；
  // 将来组合实现真的改了（例如把注入层落进 profile 自己的 `cordis.patch.yml`），
  // 这条会红，届时按新事实更新登记即可 —— 但那时要同时想清楚"是否真的要让模型能改这些行"。
  const { composeEntries, readProfilePatches } = await import('@deepseek-ai/dsh-app-boot')
  /** `true`/`false` for real booleans, `undefined` for absent, `!!js` source otherwise. */
  const disabledToken = value => value === undefined
    ? 'undefined'
    : typeof value === 'boolean' ? String(value) : `<js:${String(value?.__jsExpr ?? '?')}>`
  const assembledIds = composeEntries([prepared.patches]).filter(row => typeof row.id === 'string')
  const readBackIds = composeEntries([readProfilePatches('dsh', desktopProfileContext(prepared), prepared.profile)])
    .filter(row => typeof row.id === 'string')
  const assembledById = new Map(assembledIds.map(row => [row.id, row]))
  const readBackById = new Map(readBackIds.map(row => [row.id, row]))
  // 登记 ①：重算路径**看不到**的行 —— 全部来自十个「包内 patch 注入在 bundle 层」的包
  // （desktop-* = 桌面包自己的 cordis.patch.yml；picoaide-*/pico-*/dsh-memory-evolve =
  // enterprise / account-card / wasm-apps / foot-menu / wasm-apps-host / connectors /
  // browser / memory-evolve / cron）。24 行，按来源包分组登记：
  const KNOWN_READBACK_MISSING = [
    // 桌面包 cordis.patch.yml（bundle 层插入）
    'desktop-shell', 'desktop-diagnostics', 'desktop-updates', 'desktop-loop-notify',
    'desktop-asar-fs', 'desktop-asar-guidance',
    // enterprise
    'picoaide-enterprise', 'picoaide-session', 'picoaide-gateway-model', 'picoaide-bootstrap',
    'picoaide-error-reporting', 'picoaide-skill-telemetry', 'picoaide-auth-gate',
    'picoaide-channel-sync', 'pico-skill-filesystem', 'pico-tool-skill',
    // account-card / wasm-apps / foot-menu / wasm-apps-host
    'picoaide-account-card', 'picoaide-wasm-apps', 'picoaide-foot-menu', 'pico-wasm-apps-host',
    // connectors / browser
    'pico-connectors', 'pico-browser',
    // memory-evolve / cron
    'dsh-memory-evolve', 'pico-cron',
  ].sort()
  // 登记 ②：两侧都看得到、但 `disabled` 取值不同的行（`assembled → readBack`）。
  // `fs-sandbox`/`office-to-pdf`/`session-log-deepseek`/`ui-plugin-manager`/
  // `ui-settings-models`/`ui-settings-plugins`/`ui-sidebar-browser` 的"关"由我们的
  // bundle 层补丁声明，重算路径看不到 ⇒ 回落成 `undefined`（未声明）；`hmr` 同理回落成
  // 上游 base bundle 的 `!!js` 开关；`tool-web` 反向：重算路径只看到上游缺省 `disabled: true`，
  // 而我们的 bundle 层补丁把它打开成 `false`。**这不是本 P0 的成因**：这些行在真实 boot
  // 的树上全部按组合生效（上面 (d)/(e) 已逐条判），差异只存在于"重算自述"里。
  const KNOWN_READBACK_DISABLED_DIFFERENCES = new Map([
    ['fs-sandbox', ['true', 'undefined']],
    ['hmr', ['true', "<js:!ctx.get('profileContext')>"]],
    ['office-to-pdf', ['true', 'undefined']],
    ['session-log-deepseek', ['true', 'undefined']],
    ['tool-web', ['false', 'true']],
    ['ui-plugin-manager', ['true', 'undefined']],
    ['ui-settings-models', ['true', 'undefined']],
    ['ui-settings-plugins', ['true', 'undefined']],
    ['ui-sidebar-browser', ['true', 'undefined']],
  ])
  const readBackMissing = [...assembledById.keys()].filter(id => !readBackById.has(id)).sort()
  const readBackExtra = [...readBackById.keys()].filter(id => !assembledById.has(id)).sort()
  const readBackDisabledDiff = [...assembledById.keys()]
    .filter(id => readBackById.has(id)
      && disabledToken(assembledById.get(id).disabled) !== disabledToken(readBackById.get(id).disabled))
    .sort()
  const registeredDisabledDiff = [...KNOWN_READBACK_DISABLED_DIFFERENCES.keys()].sort()
  if (JSON.stringify(readBackMissing) !== JSON.stringify(KNOWN_READBACK_MISSING)
    || readBackExtra.length > 0
    || JSON.stringify(readBackDisabledDiff) !== JSON.stringify(registeredDisabledDiff)
    || readBackDisabledDiff.some(id => {
      const [assembled, readBack] = KNOWN_READBACK_DISABLED_DIFFERENCES.get(id)
      return disabledToken(assembledById.get(id).disabled) !== assembled
        || disabledToken(readBackById.get(id).disabled) !== readBack
    })) {
    throw new Error(
      'readProfilePatches(desktopProfileContext) 与真实装配的行集差异与登记不一致 —— '
      + '「重算 ≠ 装配」是本轮**故意保留**的残留（包内 patch 注入在 bundle 层，重算路径看不到；'
      + '见本判据上方的裁决说明），但它必须**恰好**是登记的那一份，变大变小都要按新事实更新登记：\n'
      + `  missing  actual=${JSON.stringify(readBackMissing)}\n`
      + `  missing  registered=${JSON.stringify(KNOWN_READBACK_MISSING)}\n`
      + `  extra    actual=${JSON.stringify(readBackExtra)} (registered=[])\n`
      + `  disabled actual=${JSON.stringify(readBackDisabledDiff.map(id => `${id}:${disabledToken(assembledById.get(id)?.disabled)}->${disabledToken(readBackById.get(id)?.disabled)}`))}\n`
      + `  disabled registered=${JSON.stringify([...KNOWN_READBACK_DISABLED_DIFFERENCES].map(([id, pair]) => `${id}:${pair[0]}->${pair[1]}`))}`,
    )
  }

  // 读面事实：真实 boot 的树上 `pluginManager.listPlugins()` 的 `unaddressable` 行。
  // 上面那条判据证的是"重算能算出什么"，这条证的是"读面真的给出了什么"（同一个缺口的
  // 两个观测点：一个在数据层、一个在服务层）。防止缺口无声扩大 —— 例如某天新增一个
  // 自研包、或有人把 `readProfilePatches` 换成另一份实现。
  const pluginManager = ctx.get('pluginManager')
  if (pluginManager === undefined) {
    throw new Error('assembled desktop profile is missing the pluginManager service (issue #130 regressed)')
  }
  const unaddressable = (await pluginManager.listPlugins())
    .filter(row => row.readOnlyReason === 'unaddressable')
    .map(row => row.entryId)
    .sort()
  // 登记：26 条 —— 我们十个包的行（`include:<包名>` 形态）+ 本冒烟自己注入的夹具行 + 树根。
  const KNOWN_UNADDRESSABLE_ROWS = [
    // Loader 树的**根** include 行（没有包名、父节点不是 include ⇒ 天生不可寻址，不是插件行）
    'include',
    'include:desktop-shell', 'include:desktop-diagnostics', 'include:desktop-updates',
    'include:desktop-loop-notify', 'include:desktop-asar-fs', 'include:desktop-asar-guidance',
    'include:picoaide-enterprise', 'include:picoaide-session', 'include:picoaide-gateway-model',
    'include:picoaide-bootstrap', 'include:picoaide-error-reporting', 'include:picoaide-skill-telemetry',
    'include:picoaide-auth-gate', 'include:picoaide-channel-sync', 'include:pico-skill-filesystem',
    'include:pico-tool-skill', 'include:picoaide-account-card', 'include:picoaide-wasm-apps',
    'include:picoaide-foot-menu', 'include:pico-wasm-apps-host', 'include:pico-connectors',
    'include:pico-browser', 'include:dsh-memory-evolve', 'include:pico-cron',
    // 冒烟自己的宿主服务夹具行（`tests/fixtures/desktop-host-services-smoke-plugin/`）
    'include:desktop-host-services-smoke-plugin',
  ].sort()
  if (JSON.stringify(unaddressable) !== JSON.stringify(KNOWN_UNADDRESSABLE_ROWS)) {
    throw new Error(
      'pluginManager.listPlugins() 的 unaddressable 行集合与登记不一致 —— 这是 issue #130 的**已知能力缺口**'
      + '（创造模式里 set_plugin 改不了这些行，属故意保留），缺口扩大或缩小都必须按新事实更新登记：\n'
      + `  actual  =${JSON.stringify(unaddressable)}\n`
      + `  registered=${JSON.stringify(KNOWN_UNADDRESSABLE_ROWS)}`,
    )
  }

  // ---- 「整树被重算」回归判据（issue #130 的第二种失败形态）----------------------
  // 上游 profile HMR 的 reconcile 会用 `readProfilePatches(profileContext)` **重算**
  // 组合并覆盖运行中的 include；重算列表只有 bundle 层 + profile/home 补丁层 ——
  // 我们组装期注入的 desktop/enterprise/渠道/自研业务层（以及启动器的 pin 层）都不在
  // 其中，实测会把桌面刻意关掉的行重新打开（`session-log-deepseek` 一开就是会话正文
  // 出境 P0）。今天 `hmr` 是关的（上面那条），所以这里再钉一条**不变量**：
  // 运行时行集合必须覆盖完整桌面组合 `prepared.patches` 声明的每一行，且布尔型
  // `disabled` 两侧一致（`!!js` 表达式的行不参与比较，它们由上面 (a)/(c) 逐条判）。
  // 任何"树跑在另一份更短/不同的 patch 列表上"的形态都会在这里变红。
  //
  // **为什么必须是"相等"而不是"超集"**（2026-09-23 对抗审计 M9w 实测）：超集式比较
  // （只要求"组合关掉的行运行时也关掉"）会放过"组合说开着、运行时却关着"那一半，而这
  // 正是 profile-HMR reconcile 覆盖 include 之后的形态（M9：往 boot 列表尾部插一条
  // `{id:'tool-web',disabled:true}` ⇒ 组合 composed=false / 运行时 live=true）。这条
  // `disabled` 相等判据是**唯一**能抓"树跑在另一份 patch 列表上"的判据 —— 上面的
  // `missingRows` 只抓"少行"，抓不到"多关/改关"。不要把它弱化成超集。
  const liveRows = new Map([...ctx.loader.entries()]
    .filter(entry => typeof entry.options?.id === 'string')
    .map(entry => [entry.options.id, entry]))
  const expectedRows = composeEntries([prepared.patches]).filter(row => typeof row.id === 'string')
  const missingRows = expectedRows.filter(row => !liveRows.has(row.id)).map(row => row.id)
  if (missingRows.length > 0) {
    throw new Error(
      `the live Loader tree is missing ${String(missingRows.length)} row(s) the assembled composition declares `
      + `(a runtime rewrite such as profile-HMR reconcile?): ${missingRows.slice(0, 20).join(', ')}`,
    )
  }
  /** Rows whose boolean `disabled` differs between the composition and the live tree. */
  const disabledFlips = (expected, live) => expected
    .filter(row => typeof row.disabled === 'boolean' && live.get(row.id)?.disabled !== row.disabled)
    .map(row => `${row.id}: composed=${String(row.disabled)} live=${String(live.get(row.id)?.disabled)}`)
  // 空转护栏 + 判别力自检。① 没有任何布尔 `disabled` 行时，相等判据会恒真（等于没有判据）；
  // ② 合成一个 M9 形态的反例（组合 composed=false / 运行时 live=true）跑同一个比较函数，
  // 它必须报出来 —— 把比较弱化成"只查 composed=true 那一半"（M9w）会让这条自检先红。
  const booleanRows = expectedRows.filter(row => typeof row.disabled === 'boolean')
  if (booleanRows.length === 0) {
    throw new Error('the composition declares no boolean `disabled` row: the live-tree equality judge would be vacuous')
  }
  if (disabledFlips([{ id: '(judge self-check)', disabled: false }], new Map([['(judge self-check)', { disabled: true }]])).length === 0) {
    throw new Error(
      'the live-tree equality judge lost its discriminating power: a row the composition enables but the tree '
      + 'disables is no longer flagged (was it weakened to a superset check?)',
    )
  }
  const flipRows = disabledFlips(expectedRows, liveRows)
  if (flipRows.length > 0) {
    throw new Error(
      `the live Loader tree disagrees with the assembled composition on ${String(flipRows.length)} row(s) `
      + `(a runtime rewrite re-enabled or disabled them?): ${flipRows.slice(0, 20).join(' | ')}`,
    )
  }
  // 产品决策行必须仍然关着。上一条只保证"运行时 == 组合"，抓不到"组合本身被改"
  // （例如某天有人往 patch 里加一行把 P0 闸门重新打开）；这条把产品意图钉在这里，
  // 每条都写清理由，改动它必须同时改这条判据。
  //
  // **为什么名单必须与来源文件对拍**（2026-09-23 对抗审计 M10 实测）：原版只查
  // `liveRows.get(id)?.disabled !== true` —— 把名单里一行删掉、同时把
  // `cordis.patch.yml` 里对应那条闸门改成 `disabled: false`，冒烟 EXIT=0。裸名单是
  // "自证"：判据、被判断的数据、以及破坏者要改的两处都在同一个文件里。现在改成
  // 三面绑定：
  //   ① 来源文件：`cordis.patch.yml` 里 `disabled: true` 的 id 集合必须**恰好等于**
  //      这份名单（多一条、少一条都红）；
  //   ② 组合：`composeEntries(prepared.patches)` 里同一行也必须 `disabled === true`
  //      （"配置写了但没落到组合"这一层）；
  //   ③ 运行时：名单里每一行必须 `disabled === true`（行为面）。
  // 三面绑定能抓：只重开闸门（①③红）、只删名单项（①红）、直接删掉 patch 行（①③红）。
  // **它抓不到"同时删名单项 + 重开闸门"** —— 那时①的两侧一起缩小，仍然自洽。所以每条
  // 闸门还必须配一条**与名单无关的行为判据**（下文的「与名单无关的行为闸门」段）：行为
  // 判据观测的是"这一行真的生效了会造成的那个后果"，删名单/改名单都不影响它。
  // 已配行为判据的：
  //   · `session-log-deepseek` → `dsh_session_log` 请求字段是否已注册（会话正文出境）；
  //   · `office-to-pdf`        → `officeToPdf` 服务是否存在；
  //   · `hmr`                  → `hmr` 服务是否存在（见上文）；
  //   · `fs-sandbox`           → 它与桌面 asar 后端**提供同一个 `fs` 服务**，
  //                              重开即双向 provide ⇒ 整棵树挂不起来（既有行为面兜底）；
  //   · `ui-sidebar-browser` / `ui-plugin-manager` / `ui-settings-plugins`
  //                            → 客户端行，见文末 Web graph 的排除名单。
  // 范围说明：只对拍桌面包自己的 `cordis.patch.yml`（桌面产品闸门的唯一落点）；
  // enterprise/connectors 等包的 `cordis.patch.yml` 不在本判据内。
  const mustStayDisabled = [
    ['fs-sandbox', 'desktop 用 asar-aware 文件系统后端替换上游 fs-sandbox'],
    ['session-log-deepseek', '会话正文出境的 P0 闸门（0.1.6 起默认 true）'],
    ['ui-sidebar-browser', '窗口 CSP 无 frame-src，iframe 浏览器必然白屏'],
    ['ui-plugin-manager', 'P0-8：侧栏插件页与桌面自研面板的 DOM 接管不互通'],
    ['office-to-pdf', 'libreoffice-kit 引擎不在四张打包清单覆盖内 + macOS 签名'],
    ['ui-settings-plugins', '桌面隐藏「插件」设置选项卡（2026-09 产品决策）'],
    ['hmr', '与 plugin-manager 共用 profileContext 开关，但没有 CLI 专属的 appReady 会炸整棵树'],
  ]
  const declaredDisabled = (parseYaml(readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')))
    .filter(row => row?.disabled === true)
    .map(row => row.id)
    .filter(id => typeof id === 'string')
    .sort()
  const registeredDisabled = mustStayDisabled.map(([id]) => id).sort()
  if (JSON.stringify(declaredDisabled) !== JSON.stringify(registeredDisabled)) {
    throw new Error(
      'cordis.patch.yml 的 `disabled: true` 行集合与登记的产品决策行不一致 '
      + `(declared=${JSON.stringify(declaredDisabled)} registered=${JSON.stringify(registeredDisabled)}): `
      + '重开一条产品闸门、或新增/删除一条闸门，都必须同时更新必须保持关闭的名单与理由',
    )
  }
  const reenabled = mustStayDisabled
    .filter(([id]) => liveRows.get(id)?.disabled !== true || expectedRows.find(row => row.id === id)?.disabled !== true)
    .map(([id, why]) => `${id} (${why})`)
  if (reenabled.length > 0) {
    throw new Error(`product-decision rows are no longer disabled:\n${reenabled.map(line => `  - ${line}`).join('\n')}`)
  }

  // ---- 与名单无关的**行为**闸门 -------------------------------------------------
  // 每一条都直接观测"这一行生效后的后果"，因此把名单项删掉、把名单改短、甚至把整段
  // 名单删掉，都不会让它变绿。这是对"自证式判据"的正面回应。

  // `session-log-deepseek`：该行唯一的作用是向 `deepseekLlmApiExtensions` 注册
  // `dsh_session_log` 请求字段（会话正文/工具参数与结果/工作区路径随每个带 sessionId 的
  // 请求出境，而我们的网关逐字节转发给上游供应商）。上游 `register` 对同一个字段名
  // **只允许注册一次**，重复注册抛 `field "dsh_session_log" is already registered`。
  // 于是：该行关着 ⇒ 我们的探针注册成功（随即 dispose）；该行被打开 ⇒ 注册抛错 ⇒ 红。
  const extensionRegistry = ctx.get('deepseekLlmApiExtensions')
  if (extensionRegistry === undefined) {
    throw new Error('assembled desktop profile is missing the deepseekLlmApiExtensions service')
  }
  let sessionLogFieldTaken = false
  try {
    const releaseProbeField = extensionRegistry.register('dsh_session_log', { prepare: () => undefined })
    await releaseProbeField()
  } catch {
    sessionLogFieldTaken = true
  }
  if (sessionLogFieldTaken) {
    throw new Error(
      'session-log-deepseek is ACTIVE: the `dsh_session_log` request field is registered, so session content '
      + '(messages, tool arguments/results, workspace paths) would leave with every gateway request '
      + '(P0, 2026-09-20 升级审计)。cordis.patch.yml 必须保持该行 disabled: true',
    )
  }

  // `office-to-pdf`：该行提供 `officeToPdf` 服务（`@deepseek-ai/dsh-office-to-pdf` 的
  // `super(ctx, 'officeToPdf')`）。桌面的组合里不该有它 —— 它的引擎包不在四张打包清单
  // 覆盖内，且 macOS 侧是无扩展名可执行文件，打包后必然 spawn 失败。
  if (ctx.get('officeToPdf') !== undefined) {
    throw new Error(
      'office-to-pdf is ACTIVE: the officeToPdf service exists although the LibreOffice engine is outside every '
      + 'packaging manifest and cannot run from the signed macOS bundle。cordis.patch.yml 必须保持该行 disabled: true',
    )
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
  // **每个随包 preset 都真的 mount 一次**（issue #130 的正面判据，与上面三条互补）：
  // `list()` 只列 roster 里的文件，能不能用取决于它的行是否都能拿到服务。行等不到
  // 服务时 `standingKeyFor` 抛的错里逐行写着"哪个包在等哪个服务"，原样带进失败信息
  // ——这正是 issue #130 的报错形态（`tool-plugin-manager … waiting for pluginManager`）。
  // 遍历 roster **实际返回的集合**（Windows 上 `minimal` 被 windows-agent-presets 隐藏，
  // 见 src/windows-agent-presets.ts），不硬编码 preset 列表。
  const unmountablePresets = []
  for (const id of presetIds) {
    try {
      await agentPresets.standingKeyFor(id)
    } catch (error) {
      unmountablePresets.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (unmountablePresets.length > 0) {
    throw new Error(
      `assembled desktop profile cannot mount ${String(unmountablePresets.length)} of ${String(presetIds.length)} shipped agent presets (${presetIds.join(', ')}):\n`
      + unmountablePresets.map(line => `  - ${line}`).join('\n'),
    )
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
    // 与名单无关的**行为**闸门（2026-09-23 加固）：这三行是客户端行，被打开时它们的
    // client bundle 会出现在真实 Renderer 的模块图里 —— 这条断言观测的就是"图里有没有
    // 它们"，因此删掉 (d) 的名单项、把名单改短都不影响它。
    //   · ui-sidebar-browser → 窗口 CSP 无 frame-src，iframe 浏览器必然白屏；
    //   · ui-plugin-manager  → 侧栏插件页与桌面自研面板的 DOM 接管不互通（P0-8）。
    '@deepseek-ai/dsh-client-ui-sidebar-browser',
    '@deepseek-ai/dsh-client-ui-plugin-manager',
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
