/**
 * `verify-channel-package`：把"渠道客户端必须自洽"钉成门禁。
 *
 * 覆盖三类真实事故形态（2026-09-10 审计发现）：
 *   - 渠道构建没有随包 `channel.json`（客户端回落厂商名）；
 *   - 渠道包带着**别的品牌**的图标（brand-prepare 没在打包路径上跑）；
 *   - 官方包的 `build/` 里残留上一次渠道构建的 `channel.json`（染客户品牌）。
 */
import { createPackage } from '@electron/asar'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { prepareChannelPackaging } from '../scripts/channel-prepare.ts'
import { verifyChannelPackage } from '../scripts/verify-channel-package.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopRoot, '..', '..', '..')
const officialLogo = join(repoRoot, 'brands', 'official', 'logo.svg')
const officialIcon = join(repoRoot, 'brands', 'official', 'app-icon.png')
const CHANNEL = 'example-brand'

/** 临时目录。 */
function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 造一个字段齐全的临时渠道仓。 */
async function channelRepo(): Promise<string> {
  const root = tempDir('dsh-verify-channel-repo-')
  const dir = join(root, 'channels', CHANNEL)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'logo.svg'), readFileSync(officialLogo, 'utf8'))
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 8, g: 120, b: 72, alpha: 1 } } })
    .toColourspace('rgb16')
    .withMetadata({ icc: 'srgb' })
    .png()
    .toFile(join(dir, 'app-icon.png'))
  writeFileSync(join(dir, 'channel.json'), JSON.stringify({
    schema: 1,
    channel_id: CHANNEL,
    identity: { display_name: 'Example Brand', short_name: 'Example' },
    desktop: {
      product_name: 'Example Brand',
      slug: 'Example-Brand',
      app_id: 'com.example.brand',
      deep_link_scheme: 'examplebrand',
    },
  }))
  return root
}

/** 用渠道上下文把 build/ 就位到临时目录。 */
async function stagedChannelBuild(): Promise<{ repo: string, appDir: string }> {
  const repo = await channelRepo()
  const appDir = tempDir('dsh-verify-build-')
  await prepareChannelPackaging({ env: { DSH_BUILD_CHANNEL: CHANNEL }, repoRoot: repo, appDir })
  return { repo, appDir }
}

describe('verifyChannelPackage', () => {
  it('渠道构建自洽时通过（含逐字节重派生的位图比对）', async () => {
    const { repo, appDir } = await stagedChannelBuild()
    const result = await verifyChannelPackage({
      env: { DSH_BUILD_CHANNEL: CHANNEL },
      repoRoot: repo,
      buildDir: appDir,
    })
    expect(result.channelId).toBe(CHANNEL)
    expect(result.checked).toContain('build/channel.json')
  })

  it('渠道包缺少随包 channel.json 时失败（客户端会回落厂商名的形态）', async () => {
    const { repo, appDir } = await stagedChannelBuild()
    // 模拟"打包路径没跑 stageChannelProfile"。
    writeFileSync(join(appDir, 'channel.json'), '')
    const empty = tempDir('dsh-verify-empty-')
    await expect(
      verifyChannelPackage({ env: { DSH_BUILD_CHANNEL: CHANNEL }, repoRoot: repo, buildDir: empty }),
    ).rejects.toThrow(/缺少随包渠道配置/u)
  })

  it('图标不是按本渠道派生时失败（渠道包带官方图标的形态）', async () => {
    const { repo, appDir } = await stagedChannelBuild()
    copyFileSync(officialIcon, join(appDir, 'app-icon.png'))
    await expect(
      verifyChannelPackage({ env: { DSH_BUILD_CHANNEL: CHANNEL }, repoRoot: repo, buildDir: appDir }),
    ).rejects.toThrow(/图标不是按本次渠道派生的/u)
  })

  it('官方构建残留渠道 channel.json 时失败（会染客户品牌）', async () => {
    const { appDir } = await stagedChannelBuild()
    await expect(
      verifyChannelPackage({ env: {}, buildDir: appDir }),
    ).rejects.toThrow(/不该存在/u)
  })

  it('官方构建的 build/ 干净时通过', async () => {
    const appDir = tempDir('dsh-verify-official-')
    await prepareChannelPackaging({ env: {}, appDir })
    const result = await verifyChannelPackage({ env: {}, buildDir: appDir })
    expect(result.channelId).toBe('official')
  })

  it('端到端：app.asar 内必须带同一份 channel.json 与图标', async () => {
    const { repo, appDir } = await stagedChannelBuild()
    const packed = tempDir('dsh-verify-packed-')
    mkdirSync(join(packed, 'resources'), { recursive: true })
    // 包根 = 应用目录 → build/ 原样进 asar 根（与 electron-builder 的 files 布局一致）
    mkdirSync(join(packed, 'src', 'build'), { recursive: true })
    copyFileSync(join(appDir, 'channel.json'), join(packed, 'src', 'build', 'channel.json'))
    copyFileSync(join(appDir, 'app-icon.png'), join(packed, 'src', 'build', 'app-icon.png'))
    copyFileSync(join(appDir, 'tray-icon-blue.png'), join(packed, 'src', 'build', 'tray-icon-blue.png'))
    await createPackage(join(packed, 'src'), join(packed, 'resources', 'app.asar'))

    const result = await verifyChannelPackage({
      env: { DSH_BUILD_CHANNEL: CHANNEL },
      repoRoot: repo,
      buildDir: appDir,
      appDir: packed,
    })
    expect(result.checked).toContain('app.asar/build/channel.json')
  })

  it('端到端：包内缺 channel.json 时失败（随包分发没生效）', async () => {
    const { repo, appDir } = await stagedChannelBuild()
    const packed = tempDir('dsh-verify-packed2-')
    mkdirSync(join(packed, 'resources'), { recursive: true })
    mkdirSync(join(packed, 'src'), { recursive: true })
    writeFileSync(join(packed, 'src', 'index.js'), '// 空壳\n')
    await createPackage(join(packed, 'src'), join(packed, 'resources', 'app.asar'))

    await expect(
      verifyChannelPackage({
        env: { DSH_BUILD_CHANNEL: CHANNEL },
        repoRoot: repo,
        buildDir: appDir,
        appDir: packed,
      }),
    ).rejects.toThrow(/随包渠道配置没有真的进包/u)
  })
})
