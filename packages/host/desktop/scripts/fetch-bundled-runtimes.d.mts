/**
 * `fetch-bundled-runtimes.mjs` 的类型声明。
 *
 * 该模块是纯 JS（打包前就位随包 agent 运行时：node + pnpm + python，见
 * `docs/decisions/2026-10-08-bundled-agent-runtimes.md`），但被 TS 侧两处以类型化方式
 * 使用 —— `scripts/channel-prepare.ts`（就位一步）与 `scripts/verify-packaged-runtime.ts`
 * （afterPack 门禁读同一份清单与树摘要）。没有这份声明，TS 在 strict 下会以 TS7016 拒绝编译。
 *
 * 声明与实现同源：改 `fetch-bundled-runtimes.mjs` 的导出签名必须同步改这里
 * （`tests/bundled-runtimes.spec.ts` 对拍两者的字段名与常量值）。
 */

/** 载荷里一个运行时的标识（node / pnpm / python）。 */
export type RuntimeKey = 'node' | 'pnpm' | 'python'

/** 一个目标平台上的制品声明（钉死的字节与 sha256）。 */
export interface RuntimeArtifact {
  readonly asset: string
  readonly kind: 'tar.gz' | 'zip'
  readonly bytes: number
  readonly sha256: string
}

/** `runtimes.json` 里一个运行时的形状。 */
export interface RuntimePinEntry {
  readonly version: string
  readonly base: string
  readonly integrity?: string
  readonly targets: Readonly<Record<string, RuntimeArtifact>>
  readonly prune: readonly string[]
}

/** 一个目标平台上的载荷体积上限（`runtimes.json` 的 `budget.targets[target]`）。 */
export interface RuntimeBudget {
  readonly bytes: number
  readonly files: number
}

/** `runtimes.json` 的形状。 */
export interface RuntimePin {
  readonly schema: number
  readonly targets: readonly string[]
  readonly budget: { readonly targets: Readonly<Record<string, RuntimeBudget>> }
  readonly node: RuntimePinEntry & { readonly commands: Readonly<Record<string, Readonly<Record<string, string>>>> }
  readonly pnpm: RuntimePinEntry & { readonly entry: string }
  readonly python: RuntimePinEntry & { readonly commands: Readonly<Record<string, Readonly<Record<string, string>>>> }
}

/** 载荷清单（`build/runtimes/manifest.json`，客户端与门禁共用）。 */
export interface RuntimeManifest {
  readonly schema: number
  readonly target: string
  readonly platform: string
  readonly arch: string
  readonly versions: { readonly node: string, readonly pnpm: string, readonly python: string }
  readonly commands: { readonly node: string, readonly pnpm: string, readonly python: string }
  readonly shims: readonly string[]
  readonly pipConfig?: string
  /** 三套运行时各自的许可文本（相对载荷根；再分发合规的随包凭据）。 */
  readonly licenses?: readonly { readonly runtime: string, readonly path: string, readonly bytes: number }[]
  readonly critical: readonly { readonly path: string, readonly bytes: number, readonly sha256: string }[]
  readonly tree: { readonly files: number, readonly bytes: number, readonly digest: string }
}

/** 树摘要（文件数、总字节、`(相对路径, 大小)` 列表的 sha256）。 */
export interface RuntimeTreeDigest {
  readonly files: number
  readonly bytes: number
  readonly digest: string
}

/** `materializeBundledRuntimes()` 的可覆盖输入。 */
export interface MaterializeBundledRuntimesOptions {
  /** 目标目录（缺省 `packages/host/desktop/build/runtimes`）。 */
  readonly out?: string
  /** 制品缓存目录（缺省 `packages/host/desktop/build/runtimes-cache`）。 */
  readonly cache?: string
  /** 目标平台键（缺省 = 宿主平台）。 */
  readonly target?: string
  /** 只校验不下载（门禁用）。 */
  readonly check?: boolean
  /** 只换 scheme+host 的镜像源（按运行时键）。 */
  readonly origins?: Readonly<Record<string, string>>
  /** 钉死清单路径（测试接缝）。 */
  readonly pinFile?: string
  /** 日志出口（测试接缝）。 */
  readonly log?: (message: string) => void
}

/** `materializeBundledRuntimes()` 的结果。 */
export interface MaterializeBundledRuntimesResult {
  readonly out: string
  readonly target: string
  readonly manifest: RuntimeManifest
  readonly status: Readonly<Record<string, string>>
}

/** 读钉死清单并做形状校验（读不懂即抛）。 */
export function readRuntimePin(pinFile?: string): RuntimePin

/** 宿主平台 + 架构 → 载荷目标键（未知目标抛错）。 */
export function resolveRuntimeTarget(platform?: NodeJS.Platform, arch?: string, pin?: RuntimePin): string

/**
 * Node 平台名 → 载荷键的平台段（`win32` → `win`，其余原样）。
 *
 * 入参刻意收 `string`（不是 `NodeJS.Platform`）：afterPack 门禁把 node **自报**的字符串
 * 按第一个 `-` 切开再归一，那一半在类型上只是普通字符串。
 */
export function normalizeRuntimePlatform(platform: string): string

/** 校验一份制品：字节数 + sha256（+ 可选的 npm SRI）。 */
export function verifyArtifact(path: string, artifact: RuntimeArtifact, integrity?: string): Promise<boolean>

/** 从一个 tar.gz 制品解包（strip 前缀；类型白名单；符号链接留在载荷内）。 */
export function extractTarGz(archive: string, destDir: string, strip: number): Promise<void>

/** 从一个 zip 制品解包（strip 前缀）。 */
export function extractZip(archive: string, destDir: string, strip: number): void

/** 按钉死清单裁剪载荷。 */
export function pruneRuntime(root: string, list: readonly string[], warn?: (message: string) => void): void

/** 载荷树的元信息（`exclude` 里的绝对路径不参与统计）。 */
export function runtimeTreeDigest(root: string, exclude?: readonly string[]): RuntimeTreeDigest

/** 写出全部 shim；返回相对载荷根的路径。 */
export function writeRuntimeShims(out: string, target: string, pin: RuntimePin): string[]

/** 关键可执行文件相对载荷根的路径。 */
export function runtimeCommands(target: string, pin: RuntimePin): Readonly<Record<RuntimeKey, string>>

/** 读载荷清单（读不懂即抛）。 */
export function readRuntimeManifest(root: string): RuntimeManifest

/** 校验一份已就位的载荷（目标平台 / 树摘要 / 关键文件哈希 / 体积预算）。 */
export function verifyRuntimePayload(out: string, target: string, pin?: RuntimePin): Promise<RuntimeManifest>

/** 取某个目标的载荷体积上限。 */
export function runtimeBudget(pin: RuntimePin, target: string): RuntimeBudget

/**
 * 体积预算门禁：载荷树不得超过 `runtimes.json` 记录的上限（棘轮）。
 * @returns 实测体积与所用预算（超限即抛）。
 */
export function assertRuntimeBudget(manifest: RuntimeManifest, pin?: RuntimePin): {
  readonly bytes: number
  readonly files: number
  readonly budget: RuntimeBudget
}

/** 就位随包运行时载荷（幂等）。 */
export function materializeBundledRuntimes(
  options?: MaterializeBundledRuntimesOptions,
): Promise<MaterializeBundledRuntimesResult>

/** 打包器按名字跳过的文件名（必须在载荷里删掉；见实现注释）。 */
export const PACKAGER_SKIPPED_NAMES: readonly string[]

/** 递归删掉打包器会跳过的文件；返回删除的相对路径。 */
export function prunePackagerSkippedNames(root: string, log?: (message: string) => void): readonly string[]

/** 清掉载荷目录。 */
export function removeBundledRuntimes(out?: string): void

/** 写随包 python 的 pip 站点配置（`user = yes`）；返回相对载荷根的路径。 */
export function writePipUserConfig(runtimeDir: string, target: string): string

/** 某个运行时里必须随包的许可文本候选（相对路径；找不到即拒包）。 */
export function runtimeLicenseCandidates(key: string, target: string): readonly string[]

/** 钉死清单文件路径。 */
export const RUNTIME_PIN_FILE: string
/** 缺省载荷目录。 */
export const DEFAULT_RUNTIME_OUT: string
/** 缺省制品缓存目录。 */
export const DEFAULT_RUNTIME_CACHE: string
/** 载荷清单文件名。 */
export const RUNTIME_MANIFEST_FILE: string
/** shim 目录名。 */
export const RUNTIME_SHIM_DIR: string
/** 载荷内每个运行时的目录名。 */
export const RUNTIME_DIRS: Readonly<Record<RuntimeKey, string>>
/** shim 命令名清单。 */
export const RUNTIME_SHIM_COMMANDS: readonly string[]
