/**
 * `pack-app-root.mjs` 的类型声明。
 *
 * 与 `brand-prepare.d.mts` / `generate-tray-icons.d.mts` 同款：`.mjs` 工具由
 * `.ts` 打包脚本 import，需要显式声明面，否则 `tsconfig.tests.json` 报 TS7016。
 */

/** 随包发布的应用根白名单条目（运行期需要的）。 */
export declare const PACK_APP_ROOT_ENTRIES: readonly string[]

/** 应用根里绝不进包的开发期条目（排障展示用）。 */
export declare const PACK_APP_ROOT_EXCLUDED: readonly string[]

/** 暂存结果。 */
export interface StagedPackAppRoot {
  /** 暂存应用根绝对路径。 */
  readonly stageRoot: string
  /** 删除暂存目录；调用方必须用 try/finally 保证执行。 */
  readonly cleanup: () => void
}

/** 暂存结果 + 追加到 electron-builder CLI 的参数。 */
export interface StagedPackAppRootArgs extends StagedPackAppRoot {
  /** `['--config.directories.app=<stageRoot>']`。 */
  readonly args: string[]
}

/**
 * 在 dist 下准备只含运行期条目的应用根副本。
 * @param packageRoot - 桌面包的绝对路径。
 * @param outDir - 本次打包的输出目录名（相对 packageRoot），默认 `dist`。
 */
export declare function stagePackAppRoot(packageRoot: string, outDir?: string): StagedPackAppRoot

/**
 * 四个打包脚本共用的接线入口：暂存应用根并把 `directories.app` 指向它。
 * @param packageRoot - 桌面包的绝对路径。
 * @param outputDir - 本次打包的输出目录（相对 packageRoot）。
 */
export declare function withStagedPackAppRoot(
  packageRoot: string,
  outputDir: string,
): StagedPackAppRootArgs

/** 列出暂存根的直接子项（排障 / 测试断言用）。 */
export declare function listStageEntries(stageRoot: string): string[]

/** 自检暂存根是真实目录而不是符号链接。 */
export declare function assertStageRootIsRealDirectory(stageRoot: string): boolean
