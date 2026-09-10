import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CHANNEL_ENV,
  OFFICIAL_BUILD_DEFAULTS,
  channelArtifactName,
  channelBuilderConfigArgs,
  readChannelDesktopBranding,
  resolveBuildChannelId,
  resolveChannelBuildContext,
} from '../scripts/channel-build.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopRoot, '..', '..')

/** package.json 的 build 块：官方编译期品牌的**真源**。 */
const build = (JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as {
  build: {
    productName: string
    appId: string
    mac: { artifactName: string }
    win: { artifactName: string }
    nsis: { artifactName: string, shortcutName: string }
    linux: { artifactName: string, maintainer: string, synopsis: string }
  }
}).build

/** 造一个只含 channel.json 的临时渠道仓。 */
function channelRepo(channelId: string, channel: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-channel-'))
  mkdirSync(join(root, 'channels', channelId), { recursive: true })
  writeFileSync(
    join(root, 'channels', channelId, 'channel.json'),
    typeof channel === 'string' ? channel : JSON.stringify(channel),
  )
  return root
}

function acmeChannel(): Record<string, unknown> {
  return {
    schema: 1,
    channel_id: 'acme',
    identity: { display_name: 'Acme AI' },
    desktop: {
      product_name: 'Acme AI 助手',
      slug: 'Acme-AI',
      app_id: 'com.acme.ai',
      maintainer: 'acme',
      synopsis: 'Acme 企业内部助手',
    },
  }
}

describe('channel build defaults (drift guard)', () => {
  // 官方默认值在 channel-build.ts 里是一份常量，package.json 的 build 块是另一份。
  // 两者漂移会让"官方渠道不做任何覆盖"这条保证失效（覆盖参数按渠道默认值算，
  // 而打包实际读 package.json），所以在此把它们钉死。
  it('official defaults mirror the committed package.json build block', () => {
    expect(OFFICIAL_BUILD_DEFAULTS.productName).toBe(build.productName)
    expect(OFFICIAL_BUILD_DEFAULTS.appId).toBe(build.appId)
    expect(OFFICIAL_BUILD_DEFAULTS.shortcutName).toBe(build.nsis.shortcutName)
    expect(OFFICIAL_BUILD_DEFAULTS.linuxMaintainer).toBe(build.linux.maintainer)
    expect(OFFICIAL_BUILD_DEFAULTS.linuxSynopsis).toBe(build.linux.synopsis)
  })

  it('official artifact templates mirror the committed package.json build block', () => {
    const context = resolveChannelBuildContext({ env: {}, repoRoot })
    expect(context.artifactNames.mac).toBe(build.mac.artifactName)
    expect(context.artifactNames.win).toBe(build.win.artifactName)
    expect(context.artifactNames.nsis).toBe(build.nsis.artifactName)
    expect(context.artifactNames.linux).toBe(build.linux.artifactName)
  })
})

describe('official channel is a no-op', () => {
  it('emits no electron-builder overrides at all', () => {
    const context = resolveChannelBuildContext({ env: {}, repoRoot })
    expect(context.official).toBe(true)
    expect(context.channelId).toBe('official')
    expect(context.brandDir).toBe(join(repoRoot, 'brands', 'official'))
    // 空数组 = 产物与渠道化改造前逐字节一致。
    expect(channelBuilderConfigArgs(context)).toEqual([])
  })

  it('expands the official artifact names as before', () => {
    const context = resolveChannelBuildContext({ env: {}, repoRoot })
    expect(channelArtifactName(context, 'mac', { version: '2.7.0', arch: 'arm64', ext: 'dmg' }))
      .toBe('PicoAide-Harness-2.7.0-mac.dmg')
    expect(channelArtifactName(context, 'nsis', { version: '2.7.0', arch: 'x64', ext: 'exe' }))
      .toBe('PicoAide-Harness-2.7.0-x64-Setup.exe')
  })
})

describe('channel build context', () => {
  it('turns a channel package into electron-builder overrides', () => {
    const root = channelRepo('acme', acmeChannel())
    const context = resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot: root })

    expect(context.official).toBe(false)
    expect(context.productName).toBe('Acme AI 助手')
    expect(context.appId).toBe('com.acme.ai')
    expect(context.brandDir).toBe(join(root, 'channels', 'acme'))
    expect(channelArtifactName(context, 'nsis', { version: '2.7.0', arch: 'x64', ext: 'exe' }))
      .toBe('Acme-AI-2.7.0-x64-Setup.exe')

    const args = channelBuilderConfigArgs(context)
    expect(args).toContain('--config.productName=Acme AI 助手')
    expect(args).toContain('--config.appId=com.acme.ai')
    expect(args).toContain('--config.nsis.shortcutName=Acme AI 助手')
    expect(args).toContain('--config.linux.maintainer=acme')
    // 每一个覆盖项都必须是 --config. 形式（否则会被 electron-builder 当子命令）
    expect(args.every(arg => arg.startsWith('--config.'))).toBe(true)
  })

  it('falls back to the official brand folder when the channel ships no assets', () => {
    // 渠道仓里只有 channel.json（本地/最小渠道包）→ 图标仍从官方目录派生。
    const root = channelRepo('acme', acmeChannel())
    const context = resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot: root })
    // brandDir 指向渠道目录（brand-prepare 会逐文件回落官方）。
    expect(context.brandDir).toBe(join(root, 'channels', 'acme'))
  })

  it('falls back to official branding when the channel package is absent', () => {
    // 设了渠道但没有 channels/<id>/channel.json（本地开发）→ 用官方素材，
    // 而不是构建失败：渠道化是增量能力。
    const context = resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot })
    expect(context.productName).toBe(OFFICIAL_BUILD_DEFAULTS.productName)
    expect(context.brandDir).toBe(join(repoRoot, 'brands', 'official'))
    // 仍然带上覆盖参数（appId/productName 用官方值），产物可复现。
    expect(channelBuilderConfigArgs(context)).not.toEqual([])
  })

  it('uses identity.display_name when the channel omits a desktop section', () => {
    const root = channelRepo('acme', { schema: 1, channel_id: 'acme', identity: { display_name: 'Acme' } })
    const context = resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot: root })
    expect(context.productName).toBe('Acme')
    expect(context.shortcutName).toBe('Acme')
  })
})

describe('channel build validation (fail loud)', () => {
  it('rejects a malformed channel id', () => {
    expect(() => resolveBuildChannelId({ [CHANNEL_ENV]: 'Acme Corp' })).toThrow(/不是合法渠道 id/u)
  })

  it('rejects a non-ASCII slug (it becomes installer and executable names)', () => {
    const root = channelRepo('acme', { schema: 1, channel_id: 'acme', desktop: { slug: 'Acme AI 助手' } })
    expect(() => resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot: root }))
      .toThrow(/slug/u)
  })

  it('rejects a malformed app id', () => {
    const root = channelRepo('acme', { schema: 1, channel_id: 'acme', desktop: { app_id: 'com acme ai' } })
    expect(() => resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot: root }))
      .toThrow(/app_id/u)
  })

  it('rejects a channel package that is not valid JSON', () => {
    const root = channelRepo('acme', '{ not json')
    expect(() => readChannelDesktopBranding(join(root, 'channels', 'acme'))).toThrow(/不是合法 JSON/u)
  })
})
