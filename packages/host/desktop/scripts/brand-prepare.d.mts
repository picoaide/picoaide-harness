/**
 * `brand-prepare.mjs` 的类型声明。
 *
 * 该模块是纯 JS（它按 `brands/official/` 的几何规则派生位图，见 AGENTS.md），
 * 但被 `channel-prepare.ts` 以类型化方式调用 —— 没有这份声明，TS 在
 * `strict` 下会以 TS7016 拒绝编译（tsconfig.tests.json 覆盖 scripts 下的 .ts）。
 *
 * 声明与实现同源：改 `prepareBrandAssets()` 的签名必须同步改这里。
 */

import type { ChannelBuildContext } from './channel-build.ts'

/** `prepareBrandAssets()` 的结果：派生出的文件名（相对输出目录）。 */
export interface BrandAssetResult {
  /** 本次派生产生的渠道 id（官方渠道即 `official`）。 */
  readonly channelId: string
  /** 写进输出目录的素材文件名。 */
  readonly files: readonly string[]
}

/** `prepareBrandAssets()` 的可覆盖输入。 */
export interface BrandPrepareOptions {
  /** 渠道上下文（缺省按 `DSH_BUILD_CHANNEL` 解析）。 */
  readonly context?: ChannelBuildContext
  /** 品牌素材目录（缺省取上下文的 `brandDir`）。 */
  readonly brandDir?: string
  /** 输出目录（缺省 `packages/host/desktop/build`）。 */
  readonly outputDir?: string
}

/**
 * 校验品牌目录并派生打包用的全部图标。
 * @param options - 品牌目录与输出目录。
 * @returns 渠道 id 与派生出的文件。
 */
export function prepareBrandAssets(options?: BrandPrepareOptions): Promise<BrandAssetResult>
