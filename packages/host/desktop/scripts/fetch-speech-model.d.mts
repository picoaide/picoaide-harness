/**
 * `fetch-speech-model.mjs` 的类型声明。
 *
 * 该模块是纯 JS（打包前就位随包语音模型的载荷，见 `docs/decisions/2026-09-29-voice-input-default-on.md`），
 * 但被 `channel-prepare.ts` 以类型化方式调用 —— 没有这份声明，TS 在 strict 下会以
 * TS7016 拒绝编译。
 *
 * 声明与实现同源：改 `fetch-speech-model.mjs` 的导出签名必须同步改这里
 * （`tests/speech-model-payload.spec.ts` 对拍两者的字段名）。
 */

/** 载荷里一条文件的状态。 */
export interface SpeechModelMaterializeEntry {
  /** 相对载荷根的文件路径（如 `sensevoice-onnx/model.int8.onnx`）。 */
  readonly relative: string
  /** `ready` = 已就绪（校验通过，未下载）；`downloaded` = 本次下载并校验通过。 */
  readonly state: 'ready' | 'downloaded'
}

/** `materializeSpeechModel()` 的结果。 */
export interface SpeechModelMaterializeResult {
  /** 载荷根目录。 */
  readonly out: string
  readonly status: readonly SpeechModelMaterializeEntry[]
}

/** `materializeSpeechModel()` 的可覆盖输入。 */
export interface SpeechModelMaterializeOptions {
  /** 目标目录（缺省 `packages/host/desktop/build/speech-model`）。 */
  readonly out?: string
  /** 下载源（HuggingFace 兼容，只换 scheme+host）；缺省依次试官方源与镜像。 */
  readonly origins?: readonly string[]
  /** 只校验不下载（缺失/大小/哈希不符即抛）。 */
  readonly check?: boolean
}

/**
 * 就位随包语音模型（下载缺失文件、逐条校验大小与 sha256、最后写清单）。
 * @param options - 目标目录、源列表与是否只校验。
 * @returns 每个文件的最终状态。
 */
export function materializeSpeechModel(options?: SpeechModelMaterializeOptions): Promise<SpeechModelMaterializeResult>

/**
 * 清掉载荷目录（渠道未开启随包模型时必须调用：残留会被打进下一个产物）。
 * @param out - 载荷目录。
 */
export function removeSpeechModel(out?: string): void

/** 载荷清单文件名。 */
export const SPEECH_MODEL_MANIFEST_FILE: string

/** 载荷内的相对布局（与上游运行期缺省路径同形）。 */
export const SPEECH_MODEL_LAYOUT: { readonly model: string; readonly tokens: string; readonly vad: string }
