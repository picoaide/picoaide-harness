/**
 * 随包语音识别模型的**路径解析**（2026-09-29 定案：只走上游官方配置，不做释放/复制）。
 *
 * 形态：渠道构建可以把权重打进产物（electron-builder 的 `extraResources` →
 * `<resources>/speech-model/`，由 `scripts/fetch-speech-model.mjs` 就位并按上游清单校验，
 * 渠道包用 `desktop.speech_bundle_model: true` 开关）。客户端**在装配期**把上游
 * `speech-to-text-sensevoice` 行的官方配置项指到这些文件：
 *
 * ```
 * config.modelDirectory = <客户端目录>/speech-model/sensevoice-onnx
 * config.vadModelPath   = <客户端目录>/speech-model/silero/silero_vad.onnx
 * ```
 *
 * 为什么这是"官方方式"且不需要任何新机制：上游 Config 对这两项的语义就是
 * "Existing directory containing the selected ONNX model and tokens.txt; **omission
 * downloads** verified files"（`speech-to-text-sensevoice/src/config.ts`）—— 预置文件
 * 本来就是这个插件支持的部署形态；后端在 `runtime.ts` 里对显式来源只查**可访问性**
 * （不下载、也不做哈希），于是语音在**一次网络请求都不发**的情况下直接可用。
 * 我们这边只多一条**组装期 patch**（与 `picoaide-session`/`pico-wasm-apps-host` 同一种
 * 注入），没有释放器、没有标记文件、没有把 230MiB 往数据根再拷一份。
 *
 * 与"释放到数据根"相比的取舍（认账）：
 *   · 好处：零复制、零额外磁盘、零首次延迟；启动期也不必读 230MiB 算哈希
 *     （上游对显式来源不校验内容）；
 *   · 代价：这一行**关掉了下载**（上游语义：显式来源即最终来源），所以载荷损坏时没有
 *     自愈路径 —— 因此解析在**组装期就要求文件齐且大小对**（见 {@link resolveBundledSpeechModel}），
 *     任一不符就**不注入**、回落"从公网/渠道镜像下载"的既有路径；应用被换成不带载荷的
 *     构建时同理（下一次启动装配期就不再有这两项）。唯一剩下的硬故障形态是"装配时文件在、
 *     运行中被删/被改"，上游会明确报 `Speech model verification failed`（不静默）。
 *
 * @module dsh-plugin-desktop/speech-model-bundle
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 载荷目录名（源树 `build/` 下、产物 `resources/` 下同名，与 electron-builder 配置同源）。 */
export const SPEECH_MODEL_PAYLOAD_DIR = 'speech-model'

/** 载荷清单（打包期由 `fetch-speech-model.mjs` 写出）。 */
const PAYLOAD_MANIFEST = 'manifest.json'

/** 上游 `modelDirectory` 要的那两个文件所在的子目录。 */
const MODEL_SUBDIR = 'sensevoice-onnx'
/** 上游 `vadModelPath` 的文件在载荷里的相对路径。 */
const VAD_RELATIVE = 'silero/silero_vad.onnx'
/** 模型目录里必须有 `tokens.txt`（上游从 `modelDirectory` 读它）。 */
const TOKENS_FILE = 'tokens.txt'

/** 上游官方配置里要写的那两项（绝对路径）。 */
export interface BundledSpeechModelPaths {
  /** `config.modelDirectory`：含 int8 模型与 `tokens.txt` 的目录。 */
  readonly modelDirectory: string
  /** `config.vadModelPath`：Silero VAD 的 ONNX 文件。 */
  readonly vadPath: string
}

/** 解析时的可注入输入（测试接缝；生产只用 `resourcesPath`）。 */
export interface BundledSpeechModelOptions {
  /** Electron 的应用资源目录（生产 = `process.resourcesPath`；开发/无头运行为空）。 */
  readonly resourcesPath?: string | undefined
  /** 载荷目录的直接指定（测试接缝）：`<packageRoot>/build/speech-model`。 */
  readonly packageRoot?: string
}

/** 载荷清单形状（打包期写出的那份；字段与 `fetch-speech-model.d.mts` 同源）。 */
interface PayloadManifest {
  readonly files?: readonly { readonly path?: unknown, readonly bytes?: unknown }[]
}

/** 文件存在且大小与清单一致（装配期只做便宜的一跳：不做 230MiB 哈希）。 */
function matchesDeclaredSize(path: string, bytes: number): boolean {
  try {
    return existsSync(path) && statSync(path).size === bytes
  } catch {
    return false
  }
}

/**
 * 解析随包语音模型的官方配置项。
 *
 * 只在**载荷齐、大小对**时返回路径；否则返回 undefined（调用方不注入 —— 语音回落到
 * 上游的下载路径，而不是得到一个"配置指过去但文件不在"的硬故障）。
 *
 * 生产只认 `process.resourcesPath`（打包产物里的客户端目录）：**开发运行不读源树的
 * `build/speech-model`** —— 那会让"本机碰巧拉过载荷"改变装配结果（本地绿、CI 另一套），
 * 而开发期的语音本来就走下载路径。
 * @param options - 测试接缝（资源目录与载荷目录）。
 * @returns 官方配置项，或 undefined（本次装配不带随包模型）。
 */
export function resolveBundledSpeechModel(options: BundledSpeechModelOptions = {}): BundledSpeechModelPaths | undefined {
  const resourcesPath = options.resourcesPath ?? process.resourcesPath
  const packageRoot = options.packageRoot
  const candidates = [
    ...(resourcesPath === undefined || resourcesPath === '' ? [] : [join(resourcesPath, SPEECH_MODEL_PAYLOAD_DIR)]),
    ...(packageRoot === undefined ? [] : [join(packageRoot, 'build', SPEECH_MODEL_PAYLOAD_DIR)]),
  ]
  for (const dir of candidates) {
    const manifestPath = join(dir, PAYLOAD_MANIFEST)
    if (!existsSync(manifestPath)) continue
    let manifest: PayloadManifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PayloadManifest
    } catch {
      // 清单坏了 = 这份载荷不可信：不注入，回落下载（与"载荷缺失"同一处置）。
      continue
    }
    const declared = new Map<string, number>()
    for (const file of manifest.files ?? []) {
      if (typeof file.path === 'string' && typeof file.bytes === 'number') declared.set(file.path, file.bytes)
    }
    const modelDirectory = resolve(dir, MODEL_SUBDIR)
    const vadPath = resolve(dir, VAD_RELATIVE)
    const modelFile = [...declared.keys()].find(path => path.startsWith(`${MODEL_SUBDIR}/`) && path.endsWith('.onnx'))
    const modelBytes = modelFile === undefined ? undefined : declared.get(modelFile)
    const vadBytes = declared.get(VAD_RELATIVE)
    if (modelFile === undefined || modelBytes === undefined || vadBytes === undefined) continue
    if (!matchesDeclaredSize(join(dir, modelFile), modelBytes)) continue
    if (!matchesDeclaredSize(join(modelDirectory, TOKENS_FILE), declared.get(`${MODEL_SUBDIR}/${TOKENS_FILE}`) ?? -1)) continue
    if (!matchesDeclaredSize(vadPath, vadBytes)) continue
    return { modelDirectory, vadPath }
  }
  return undefined
}
