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

/** `prepareChannelPackaging()` 的可覆盖输入（测试用）。 */
export interface ChannelPrepareOptions extends ChannelBuildOptions {
  /** 应用资源目录（`build/`）；缺省为 desktop 包根的 `build/`。 */
  readonly appDir?: string
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
  return context
}
