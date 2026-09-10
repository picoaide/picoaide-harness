/**
 * 渠道包验证门禁：**渠道客户端的白标不变量**。
 *
 * 2026-09-10 的两类事故都是"链路缺一环但不报错"：
 *   - `build/channel.json` 无人生产 → 客户端回落厂商名（登录前尤其明显）；
 *   - `brand-prepare` 不在打包路径上（CI 走 `--no-prebuild`）→ 渠道包带着
 *     **官方图标**出厂。
 * 修完之后必须有一条门禁把它们钉死，否则下次回归依旧是静默的。
 *
 * 断言三层：
 *   1. `build/` 与本次渠道自洽 —— 渠道构建必须有 `channel.json` 且 `channel_id`
 *      等于所选渠道；官方构建**必须没有**（残留会把客户品牌染进官方包）；
 *   2. 位图确实是按**本次渠道**派生的 —— 现场重新派生到临时目录逐字节比对
 *      （`app-icon.png` / `app-icon-mac.png` / 托盘位图）。比对的是"与渠道自洽"，
 *      而不是某个具体品牌，因此官方与渠道共用同一条门禁；
 *   3. 给了 `--app-dir <unpacked>` 时再拆开 `app.asar`，确认包内真的带着同一份
 *      `channel.json` 与同一批图标 —— 这是"随包分发"的端到端证据。
 *
 * 用法：
 *   node scripts/verify-channel-package.ts                      # 校验 build/（官方或 DSH_BUILD_CHANNEL）
 *   node scripts/verify-channel-package.ts --app-dir dist/linux-unpacked
 *
 * @module dsh-plugin-desktop/scripts/verify-channel-package
 */

import { extractFile, listPackage } from '@electron/asar'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareBrandAssets } from './brand-prepare.mjs'
import { defaultChannelAppDir } from './channel-prepare.ts'
import { resolveChannelBuildContext } from './channel-build.ts'

/** 必须逐字节与"按本渠道重新派生"一致的文件。 */
const DERIVED_ASSETS = [
  'app-icon.png',
  'app-icon-mac.png',
  'tray-iconTemplate.png',
  'tray-icon-blue.png',
] as const

/** 校验失败：与自洽性断言一起抛出，CLI 统一转 exit 1。 */
class ChannelPackageError extends Error {}

/** 文件 sha256（读不到即算不符，由调用方给出可读信息）。 */
function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 断言，失败即抛（自带上下文，便于 CI 一眼定位）。 */
function assert(condition: boolean, message: string): void {
  if (!condition) throw new ChannelPackageError(message)
}

/** 解析 CLI 参数。 */
function parseArgs(argv: readonly string[]): { appDir?: string, buildDir?: string, channel?: string } {
  const result: { appDir?: string, buildDir?: string, channel?: string } = {}
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--app-dir' && value !== undefined) {
      result.appDir = resolve(value)
      index += 1
    } else if (flag === '--build-dir' && value !== undefined) {
      result.buildDir = resolve(value)
      index += 1
    } else if (flag === '--channel' && value !== undefined) {
      result.channel = value
      index += 1
    } else if (flag !== undefined) {
      throw new ChannelPackageError(`verify-channel-package: 未知参数 ${flag}`)
    }
  }
  return result
}

/**
 * 校验 `build/`（以及可选的已打包应用）与本次渠道是否自洽。
 * @param options - 应用资源目录、已解包应用目录与渠道覆盖（测试可覆盖）。
 * @returns 校验通过的渠道 id 与被校验的文件清单。
 * @throws `ChannelPackageError` 任一不变量被破坏。
 */
export async function verifyChannelPackage(options: {
  readonly appDir?: string
  readonly buildDir?: string
  readonly env?: NodeJS.ProcessEnv
  readonly repoRoot?: string
} = {}): Promise<{ channelId: string, checked: string[] }> {
  const context = resolveChannelBuildContext(
    options.env === undefined
      ? (options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot })
      : { env: options.env, ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }) },
  )
  const buildDir = options.buildDir ?? defaultChannelAppDir()
  const stagedPath = join(buildDir, 'channel.json')
  const checked: string[] = []

  // 1) 渠道包就位状态
  if (context.official) {
    assert(
      !existsSync(stagedPath),
      `官方构建的 ${stagedPath} 不该存在 —— 这是上一次渠道构建的残留，`
      + '它会让官方客户端显示客户品牌。删掉它，或改用 prepareChannelPackaging() 打包。',
    )
  } else {
    assert(
      existsSync(stagedPath),
      `渠道 ${context.channelId} 缺少随包渠道配置 ${stagedPath} —— `
      + '客户端登录前拿不到品牌/默认域名（这正是 2026-09-10 那次事故的形态）。',
    )
    const staged = JSON.parse(readFileSync(stagedPath, 'utf8')) as { channel_id?: unknown }
    assert(
      staged.channel_id === context.channelId,
      `${stagedPath} 的 channel_id=${JSON.stringify(staged.channel_id)} 与构建渠道 ${context.channelId} 不一致`,
    )
    checked.push('build/channel.json')
  }

  // 2) 位图必须与"按本次渠道重新派生"的结果逐字节一致
  const expectedDir = mkdtempSync(join(tmpdir(), 'dsh-verify-channel-'))
  try {
    await prepareBrandAssets({ context, outputDir: expectedDir })
    for (const name of DERIVED_ASSETS) {
      const actual = join(buildDir, name)
      const expected = join(expectedDir, name)
      assert(existsSync(actual), `渠道 ${context.channelId} 的 ${actual} 不存在（打包前没派生品牌素材？）`)
      assert(
        sha256(actual) === sha256(expected),
        `${actual} 与渠道 ${context.channelId} 的派生结果不一致 —— `
        + `图标不是按本次渠道派生的（渠道包带着别的品牌的图标出厂）。`
        + `修法：打包前调用 prepareChannelPackaging()（见 scripts/channel-prepare.ts）。`,
      )
      checked.push(`build/${name}`)
    }

    // 3) 端到端：包内（app.asar）必须带着同一份渠道配置与同一批图标
    if (options.appDir !== undefined) {
      const asarPath = join(options.appDir, 'resources', 'app.asar')
      assert(existsSync(asarPath), `找不到 ${asarPath}（--app-dir 应指向解包后的应用目录）`)
      // electron-builder 把包根打进 asar 根 → 包内路径即 `/build/<name>`。
      // 注意 `listPackage` 回报带前导斜杠、`extractFile` 要求不带（@electron/asar v3 实测）。
      const listed = new Set(listPackage(asarPath, { isPack: false }))
      const listEntry = (name: string): string => `/build/${name}`
      const readEntry = (name: string): string => `build/${name}`
      if (context.official) {
        assert(
          !listed.has(listEntry('channel.json')),
          `${asarPath} 内不该有 ${listEntry('channel.json')}（官方包带上了渠道配置）`,
        )
      } else {
        assert(
          listed.has(listEntry('channel.json')),
          `${asarPath} 内缺少 ${listEntry('channel.json')} —— 随包渠道配置没有真的进包`
          + '（electron-builder 的 build.files 必须含 build/channel.json）。',
        )
        const packed = extractFile(asarPath, readEntry('channel.json')).toString('utf8')
        const declared = (JSON.parse(packed) as { channel_id?: unknown }).channel_id
        assert(
          declared === context.channelId,
          `${asarPath} 内的 channel_id=${JSON.stringify(declared)} 与构建渠道 ${context.channelId} 不一致`,
        )
        checked.push(`app.asar${listEntry('channel.json')}`)
      }
      for (const name of ['app-icon.png', 'tray-icon-blue.png']) {
        assert(listed.has(listEntry(name)), `${asarPath} 内缺少 ${listEntry(name)}`)
        const packedHash = createHash('sha256').update(extractFile(asarPath, readEntry(name))).digest('hex')
        assert(
          packedHash === sha256(join(buildDir, name)),
          `${asarPath} 内的 ${name} 与 build/ 不一致`,
        )
        checked.push(`app.asar${listEntry(name)}`)
      }
    }
  } finally {
    rmSync(expectedDir, { recursive: true, force: true })
  }

  return { channelId: context.channelId, checked }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const env = args.channel === undefined ? process.env : { ...process.env, DSH_BUILD_CHANNEL: args.channel }
    const result = await verifyChannelPackage({
      env,
      ...(args.appDir === undefined ? {} : { appDir: args.appDir }),
      ...(args.buildDir === undefined ? {} : { buildDir: args.buildDir }),
    })
    console.log(
      `verify-channel-package: OK — 渠道 ${result.channelId}，校验 ${result.checked.length} 项`
      + `（${result.checked.join(', ')}）`,
    )
  } catch (error) {
    console.error(`verify-channel-package: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
