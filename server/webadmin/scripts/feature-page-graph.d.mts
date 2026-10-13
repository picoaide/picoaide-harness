/**
 * `scripts/feature-page-graph.mjs` 的类型面。
 *
 * 为什么需要这个文件：`src/lib/features.test.ts` 要 import 那份实现（同一份图判据既跑在
 * 毫秒级的单测链里、也跑在产物判据的前置检查里），而 `npm run build` 是 `tsc -b`（`strict`
 * 打开 ⇒ `noImplicitAny`），跟到一个没有声明的 `.mjs` 会报 TS7016。
 *
 * 声明与实现同步的纪律：两边的**导出名**必须逐字一致 —— 少一个导出时 `tsc -b` 会红
 * （测试里 import 不到），改签名时测试与 `check-feature-chunks.mjs` 一起红，
 * 不会出现"判据悄悄用不上"的形态。
 */

/** 一条 import 边。 */
export type ImportEdge = {
  /** 目标文件的绝对路径。 */
  to: string
  /** 源码里写的说明符。 */
  spec: string
  /** 是否 `import()`（false = 静态 import/export）。 */
  dynamic: boolean
  /** 该边是否就是 `App.tsx` 里某个 `__FEATURE_*__` 守卫的 `import()`；是则给出模块名。 */
  guardedModule: string | null
}

/** `__FEATURE_<MODULE>__ ? lazy(() => import('<spec>'))` 的一次出现。 */
export type GuardedImport = {
  /** 模块名（已小写）。 */
  module: string
  /** import() 的说明符。 */
  spec: string
  /** 匹配起始位置。 */
  start: number
  /** 匹配结束位置。 */
  end: number
}

/** 模块 → 页面源文件（相对 webadmin 包根的 POSIX 路径）。 */
export type ModulePages = Readonly<Record<string, readonly string[]>>

/** 模块 → 哨兵串。 */
export type ModuleSentinels = Readonly<Record<string, string>>

/** 前端源码根（相对 webadmin 包根）。 */
export const SOURCE_ROOT: string
/** 构建入口（`index.html` 的 module script）。 */
export const ENTRY_FILE: string
/** 变体入口（守卫写在这里）。 */
export const APP_FILE: string

/**
 * 抽出 `App.tsx` 里被 `__FEATURE_*__` 守卫的懒加载 import()。
 * @param appSource - `App.tsx` 源码。
 * @returns 守卫清单。
 */
export function parseGuardedImports(appSource: string): GuardedImport[]

/**
 * 说明符 → 目标文件（相对说明符与 `@/` 别名；其余返回 null）。
 * @param fromFile - 发起 import 的文件（绝对路径）。
 * @param spec - 说明符。
 * @param packageRoot - webadmin 包根（绝对路径）。
 * @returns 目标文件绝对路径或 null。
 */
export function resolveSpecifier(fromFile: string, spec: string, packageRoot: string): string | null

/**
 * 页表双向对拍（守卫 ⟺ 页表）。
 * @param options - 包根与页表。
 * @returns 问题清单（空 = 一致）。
 */
export function findRegistryProblems(options: { packageRoot: string, modulePages: ModulePages }): string[]

/**
 * 切面判据：模块页/模块私有代码的每一条入边都必须是守卫那条 import()。
 * @param options - 包根与页表。
 * @returns 问题清单（空 = 切干净了）。
 */
export function findCutProblems(options: { packageRoot: string, modulePages: ModulePages }): string[]

/**
 * 每个声明页都必须自带本模块哨兵并在 JSX 里渲染它。
 * @param options - 包根、页表与哨兵表。
 * @returns 问题清单（空 = 量具齐备）。
 */
export function findSentinelProblems(options: {
  packageRoot: string
  modulePages: ModulePages
  moduleSentinels: ModuleSentinels
}): string[]
