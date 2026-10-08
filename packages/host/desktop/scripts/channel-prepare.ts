/**
 * 打包前的渠道化准备：**渠道客户端就位的唯一入口**。
 *
 * 渠道客户端有两份东西必须随包分发，缺一条就是"白标半成品"：
 *
 *   1. **位图素材**（`build/app-icon.png` / `build/app-icon-mac.png` /
 *      `build/tray-icon*.png` / `build/assistedMessages.yml`）——
 *      electron-builder 从 `directories.buildResources`（= `build/`）读它们，
 *      运行时托盘也从包内读。渠道目录里的 `logo.svg` / `app-icon.png` 必须由
 *      `brand-prepare.mjs` 按 `brands/official/` 的几何规则派生（AGENTS.md：
 *      品牌图形单一权威），**不能**直接拿渠道素材当最终图标；
 *   2. **渠道配置**（`build/channel.json`）—— 见 `stageChannelProfile()`。
 *
 * 2026-09-10 实测的两类事故都出在"没人调用"上：
 *   - `build/channel.json` 全仓无人生产（链断了，客户端回落厂商名）；
 *   - `brand-prepare` 只挂在 desktop 的 `build` 脚本里，而 CI 打包一律
 *     `--no-prebuild`（构建产物来自 gate job）→ **渠道包带着官方图标出厂**，
 *     本地打包（会经 prebuild 触发 brand-prepare）却看不出问题。
 *
 * 因此本模块的作用是：让"派生素材 + 就位渠道配置"成为打包脚本里**显式的一步**，
 * 官方渠道与渠道渠道走同一条代码路径（官方渠道 = 从 `brands/official/` 派生、
 * 并删掉上一次渠道构建留下的 `build/channel.json`）。
 *
 * @module dsh-plugin-desktop/scripts/channel-prepare
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareBrandAssets } from './brand-prepare.mjs'
import {
  resolveChannelBuildContext,
  stageChannelProfile,
  type ChannelBuildContext,
  type ChannelBuildOptions,
} from './channel-build.ts'
import { SPEECH_MODEL_PAYLOAD_DIR } from './verify-packaged-runtime.ts'
import { BUNDLED_RUNTIMES_PAYLOAD_DIR } from './verify-packaged-runtime.ts'

/** `prepareChannelPackaging()` 的可覆盖输入（测试用）。 */
export interface ChannelPrepareOptions extends ChannelBuildOptions {
  /** 应用资源目录（`build/`）；缺省为 desktop 包根的 `build/`。 */
  readonly appDir?: string
  /**
   * 随包语音模型的载荷读写（测试接缝；缺省 = `fetch-speech-model.mjs`）。
   *
   * 为什么需要接缝：真实现要联网拉 230MiB（缺省所有渠道都会走这条路），单测里
   * 既慢又依赖公网 —— 决策逻辑由 `resolveSpeechModelPayloadAction()` 纯函数与
   * `speech-model-bundle.spec.ts` 覆盖，这里只让"调用链真的通"。
   */
  readonly speechModel?: SpeechModelPayloadDeps
  /**
   * 随包 agent 运行时的载荷读写（测试接缝；缺省 = `fetch-bundled-runtimes.mjs`）。
   *
   * 同 `speechModel`：真实现要联网拉三套运行时（展开后 ~240MiB），单测传替身，
   * 只验证"这一步真的被调用、参数对"。
   */
  readonly runtimes?: BundledRuntimesPayloadDeps
  /**
   * 随包运行时的目标平台键（`linux-x64` / `win-x64` / `darwin-arm64`）。
   *
   * 缺省 = 宿主平台，与三个打包入口各自的目标一致（`package-win.ts` 还会自己断言
   * `process.platform === 'win32'`；`release-mac.ts` 固定 `--arm64`）。显式传参是给
   * 未来的交叉打包留的口子 —— 目标与载荷不一致时 `fetch-bundled-runtimes.mjs` 会拒。
   */
  readonly runtimeTarget?: string
}

/**
 * desktop 包根下的 `build/` 目录（electron-builder 的 buildResources）。
 * @returns 绝对路径。
 */
export function defaultChannelAppDir(): string {
  return join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'build')
}

/**
 * 打包前按渠道派生品牌素材并就位渠道配置。
 *
 * 幂等：重复调用只做同样的写操作；官方渠道会把渠道构建留下的
 * `build/channel.json` 删掉（残留比"没生效"更糟 —— 官方包会带上客户品牌）。
 * @param options - 环境、仓库根与应用资源目录（测试可覆盖）。
 * @returns 本次构建的渠道上下文（调用方继续用它生成 electron-builder 参数）。
 * @throws 渠道 id/slug/appId 非法、渠道包不可解析、或 `channel_id` 与所选渠道不一致。
 */
export async function prepareChannelPackaging(
  options: ChannelPrepareOptions = {},
): Promise<ChannelBuildContext> {
  const context = resolveChannelBuildContext(options)
  const appDir = options.appDir ?? defaultChannelAppDir()
  // 先校验并配置、后派生位图：渠道包非法（channel_id 与目录名不一致、JSON 坏）
  // 应当秒级失败，而不是先花两秒渲染图标再报错。两步都失败即抛错，不会有
  // "打包照常进行"的中间态。
  stageChannelProfile(context, appDir)
  await prepareBrandAssets({ context, outputDir: appDir })
  await prepareSpeechModelPayload(context, appDir, options.speechModel)
  await prepareBundledRuntimesPayload(appDir, options.runtimes, options.runtimeTarget)
  return context
}

/**
 * 随包 agent 运行时载荷（`build/runtimes/`）—— 打包输入的**唯一**就位点。
 *
 * 与语音模型载荷同一姿势（幂等 + 唯一入口），两点不同：
 *   · **所有渠道都要**（官方与品牌渠道的 agent 都需要 node/pnpm/python，没有渠道开关）；
 *   · 目标平台必须与本次打包目标一致（`--target`，缺省 = 宿主平台）：把 linux 载荷打进
 *     Windows 安装包是"客户端启动即没有运行时"的静默形态，因此由
 *     `fetch-bundled-runtimes.mjs` 与 afterPack 门禁两侧各自校验目标键。
 *
 * `deps` 是**测试接缝**（真实现要联网拉 ~90MiB 制品、展开后 ~240MiB）：单测传替身，
 * 生产不传。
 * @param appDir - `build/` 目录。
 * @param deps - 载荷读写实现（缺省 = `fetch-bundled-runtimes.mjs`）。
 * @param target - 目标平台键（缺省 = 宿主平台）。
 * @returns 载荷根目录与目标平台。
 */
export async function prepareBundledRuntimesPayload(
  appDir: string = defaultChannelAppDir(),
  deps?: BundledRuntimesPayloadDeps,
  target?: string,
): Promise<{ out: string, target: string }> {
  const { materializeBundledRuntimes } = deps ?? await import('./fetch-bundled-runtimes.mjs')
  const out = join(appDir, BUNDLED_RUNTIMES_PAYLOAD_DIR)
  const result = await materializeBundledRuntimes(target === undefined ? { out } : { out, target })
  console.log(
    `channel-prepare: 随包 agent 运行时已就位 → build/${BUNDLED_RUNTIMES_PAYLOAD_DIR}（${result.target}；`
    + `node ${result.manifest.versions.node} / pnpm ${result.manifest.versions.pnpm} / python ${result.manifest.versions.python}）`,
  )
  return { out: result.out, target: result.target }
}

/** `prepareBundledRuntimesPayload()` 的载荷读写面（与 `fetch-bundled-runtimes.mjs` 的导出同形）。 */
export interface BundledRuntimesPayloadDeps {
  /** 就位载荷（下载缺失制品 + 校验 + 解包 + 写 shim 与清单）。 */
  readonly materializeBundledRuntimes: (options?: { readonly out?: string, readonly target?: string }) => Promise<{
    readonly out: string
    readonly target: string
    readonly manifest: {
      readonly versions: { readonly node: string, readonly pnpm: string, readonly python: string }
    }
  }>
}

/**
 * 随包语音模型载荷（`build/speech-model/`）—— 打包输入的**唯一**就位点。
 *
 * 两个方向都必须走这里（与 `stageChannelProfile` 同一姿势）：
 *   · **缺省（所有渠道，含 official/beta）** ⇒ 拉取 + 按上游清单校验
 *     （`scripts/fetch-speech-model.mjs`，幂等；已就位的文件不重下）；
 *   · 渠道显式 `desktop.speech_bundle_model: false` ⇒ **清掉**载荷目录 —— 残留比
 *     "没生效"更糟：上一次构建留下的 230MiB 会被打进这一次的产物，而客户端只看
 *     载荷在不在。
 *
 * `deps` 是**测试接缝**（真实现要联网拉 230MiB）：单测传替身，生产不传。
 * @param context - 渠道上下文（`speechBundleModel` 是唯一判据）。
 * @param appDir - `build/` 目录。
 * @param deps - 载荷读写实现（缺省 = `fetch-speech-model.mjs`）。
 * @returns 载荷状态（`absent` = 本次产物不带模型）。
 */
export async function prepareSpeechModelPayload(
  context: ChannelBuildContext,
  appDir: string = defaultChannelAppDir(),
  deps?: SpeechModelPayloadDeps,
): Promise<'absent' | 'materialized'> {
  const { materializeSpeechModel, removeSpeechModel } = deps ?? await import('./fetch-speech-model.mjs')
  const out = join(appDir, SPEECH_MODEL_PAYLOAD_DIR)
  if (resolveSpeechModelPayloadAction(context) === 'clear') {
    removeSpeechModel(out)
    return 'absent'
  }
  const { status } = await materializeSpeechModel({ out })
  const summary = status.map(entry => `${entry.relative}=${entry.state}`).join(' ')
  console.log(`channel-prepare: 随包语音模型已就位（渠道 ${context.channelId}）→ build/${SPEECH_MODEL_PAYLOAD_DIR}\n  ${summary}`)
  return 'materialized'
}

/** `prepareSpeechModelPayload()` 的载荷读写面（与 `fetch-speech-model.mjs` 的导出同形）。 */
export interface SpeechModelPayloadDeps {
  /** 就位载荷（拉取缺失文件 + 校验 + 写清单）。 */
  readonly materializeSpeechModel: (options?: { readonly out?: string }) => Promise<{
    readonly out: string
    readonly status: readonly { readonly relative: string, readonly state: string }[]
  }>
  /** 清掉载荷目录。 */
  readonly removeSpeechModel: (out?: string) => void
}

/**
 * 本次打包对载荷的动作（**纯函数**：决策与 IO 分开，纯的那半由单测穷举）。
 * @param context - 渠道上下文。
 * @returns `materialize` = 拉取并随包（缺省）；`clear` = 清掉残留、不随包（显式关闭）。
 */
export function resolveSpeechModelPayloadAction(context: ChannelBuildContext): 'materialize' | 'clear' {
  return context.speechBundleModel ? 'materialize' : 'clear'
}
