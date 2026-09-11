import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CHANNEL_ENV,
  OFFICIAL_BUILD_DEFAULTS,
  channelArtifactName,
  prepareChannelBuilderOverrides,
  readChannelDesktopBranding,
  resolveBuildChannelId,
  resolveChannelBuildContext,
  stageChannelProfile,
} from '../scripts/channel-build.ts'
import { PRODUCT_DSH_HOME_DIR } from '../src/desktop-home.ts'

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
    files: unknown[]
    asar: unknown
  }
}).build

/** 解析生成的 electron-builder 配置文件(去掉注释行与 module.exports 前缀)。 */
function readGeneratedConfig(path: string): Record<string, any> {
  return JSON.parse(
    readFileSync(path, 'utf8')
      .replace(/^\/\/[^\n]*\n/u, '')
      .replace(/^module\.exports = /u, ''),
  ) as Record<string, any>
}

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
      deep_link_scheme: 'acmeai',
      deep_link_name: 'Acme AI Link',
      home_dir: '.acme-harness',
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
    // 官方数据目录逐字节不变（存量用户数据不搬家）
    expect(context.homeDir).toBe(PRODUCT_DSH_HOME_DIR)
    // 空数组 = 产物与渠道化改造前逐字节一致。
    expect(prepareChannelBuilderOverrides(context, mkdtempSync(join(tmpdir(), 'dsh-off-')))).toEqual([])
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
  it('derives a channel-only data directory when the package omits one', () => {
    // 渠道包没写 desktop.home_dir（CI 对品牌渠道硬性要求，这里是本地/漏配路径）：
    // 由 slug 小写派生；没有 slug（如 beta）则退到 `.picoaide-harness-<渠道 id>`。
    // 两种都**不回落官方目录** —— 共用数据根会跨渠道共享登录态/会话。
    const withSlug = resolveChannelBuildContext({
      env: { [CHANNEL_ENV]: 'acme' },
      repoRoot: channelRepo('acme', { schema: 1, channel_id: 'acme', desktop: { slug: 'Acme-Harness' } }),
    })
    expect(withSlug.homeDir).toBe('.acme-harness')

    const withoutSlug = resolveChannelBuildContext({
      env: { [CHANNEL_ENV]: 'acme' },
      repoRoot: channelRepo('acme', { schema: 1, channel_id: 'acme', identity: { display_name: 'Acme AI' } }),
    })
    expect(withoutSlug.homeDir).toBe(`${PRODUCT_DSH_HOME_DIR}-acme`)
  })

  it('turns a channel package into electron-builder overrides', () => {
    const root = channelRepo('acme', acmeChannel())
    const context = resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot: root })

    expect(context.official).toBe(false)
    expect(context.productName).toBe('Acme AI 助手')
    expect(context.appId).toBe('com.acme.ai')
    // 数据目录随渠道（账户 token/settings/会话都在里面，绝不与官方共用）
    expect(context.homeDir).toBe('.acme-harness')
    expect(context.brandDir).toBe(join(root, 'channels', 'acme'))
    expect(channelArtifactName(context, 'nsis', { version: '2.7.0', arch: 'x64', ext: 'exe' }))
      .toBe('Acme-AI-2.7.0-x64-Setup.exe')

    // 覆盖走**生成的配置文件**,而不是 `--config.x=y` 命令行开关:
    // electron-builder 的 CLI 点号覆盖不支持数组下标(protocols),实测直接以
    // "unknown property 'protocols[0]'" 拒绝整次构建。
    const workDir = mkdtempSync(join(tmpdir(), 'dsh-channel-cfg-'))
    const args = prepareChannelBuilderOverrides(context, workDir)
    expect(args[0]).toBe('--config')
    const config = readGeneratedConfig(args[1]!)
    expect(config.productName).toBe('Acme AI 助手')
    expect(config.appId).toBe('com.acme.ai')
    expect(config.nsis.shortcutName).toBe('Acme AI 助手')
    expect(config.nsis.artifactName).toBe('Acme-AI-${version}-${arch}-Setup.${ext}')
    expect(config.linux.maintainer).toBe('acme')
    // OS 级协议注册必须跟着渠道:浏览器回调靠它跳回客户端,
    // 确认框里的 scheme 就是渠道客户会看到的东西。
    expect(config.protocols).toEqual([{ name: 'Acme AI Link', schemes: ['acmeai'] }])
    // 生成的配置必须**完整继承** package.json 的 build 块(无论 electron-builder
    // 把 --config 当替换还是合并,结果都要一致)。
    expect(config.files).toEqual(build.files)
    expect(config.asar).toEqual(build.asar)
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
    expect(prepareChannelBuilderOverrides(context, mkdtempSync(join(tmpdir(), 'dsh-fb-')))).not.toEqual([])
  })

  it('uses identity.display_name when the channel omits a desktop section', () => {
    const root = channelRepo('acme', { schema: 1, channel_id: 'acme', identity: { display_name: 'Acme' } })
    const context = resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot: root })
    expect(context.productName).toBe('Acme')
    expect(context.shortcutName).toBe('Acme')
  })
})

describe('deep link scheme', () => {
  it('defaults to the official scheme and emits no override at all for official', () => {
    const context = resolveChannelBuildContext({ env: {}, repoRoot })
    expect(context.deepLinkScheme).toBe('picoaide')
    // 官方渠道连配置文件都不生成 —— 产物与改造前一致。
    expect(prepareChannelBuilderOverrides(context, mkdtempSync(join(tmpdir(), 'dsh-none-')))).toEqual([])
  })

  it('uses the channel scheme and registers it with the OS', () => {
    const root = channelRepo('acme', acmeChannel())
    const context = resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot: root })
    expect(context.deepLinkScheme).toBe('acmeai')
    const workDir = mkdtempSync(join(tmpdir(), 'dsh-scheme-'))
    const args = prepareChannelBuilderOverrides(context, workDir)
    expect(readGeneratedConfig(args[1]!).protocols).toEqual([{ name: 'Acme AI Link', schemes: ['acmeai'] }])
  })

  it('fails the build on a malformed channel scheme', () => {
    // 构建期 fail-loud:畸形 scheme 会让浏览器回调打不开客户端,这种包不该产出。
    // (运行期 desktop-channel.ts 则回落官方值 —— 那里没有"拒绝构建"这个选项。)
    const root = channelRepo('acme', { schema: 1, channel_id: 'acme', desktop: { deep_link_scheme: 'ACME AI' } })
    expect(() => resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot: root }))
      .toThrow(/deep_link_scheme/u)
  })

  it('rejects a malformed official default (template drift guard)', () => {
    expect(OFFICIAL_BUILD_DEFAULTS.deepLinkScheme).toBe('picoaide')
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

  it('rejects a malformed data directory name', () => {
    // 数据目录名会被拼进 `~` 下的路径:畸形值(分隔符/绝对路径/大写)必须构建期拦,
    // 而不是等到装到客户机器上才发现数据落到了别处。
    for (const homeDir of ['../escape', '/abs', '.UPPER', '.']) {
      const root = channelRepo('acme', { schema: 1, channel_id: 'acme', desktop: { home_dir: homeDir } })
      expect(() => resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot: root }))
        .toThrow(/home_dir/u)
    }
  })

  it('rejects a channel package that is not valid JSON', () => {
    const root = channelRepo('acme', '{ not json')
    expect(() => readChannelDesktopBranding(join(root, 'channels', 'acme'))).toThrow(/不是合法 JSON/u)
  })
})

/**
 * 运行期渠道包的就位（`build/channel.json`）。
 *
 * 这是"渠道客户端直连自家域名 / 登录页显示渠道品牌"的**唯一来源**：
 * `src/desktop-channel.ts` 在运行时读的就是这个文件。2026-09-10 实测发现整个
 * 仓库此前没有任何地方写它 —— 客户端渠道化在这一环是断的（与
 * `CLIENT-RELEASE.json` 放错目录同类：链路缺一环但不报错）。这些测试钉住
 * 两个方向：**渠道构建必须写**、**官方构建必须清**（残留会把渠道品牌带给
 * 下一次本地/官方构建，比"没生效"更糟）。
 */
describe('stageChannelProfile', () => {
  function channelDir(manifest: unknown): { repoRoot: string, buildDir: string, channelDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'channel-build-stage-'))
    const dir = join(root, 'channels', 'acme')
    const buildDir = join(root, 'packages', 'host', 'desktop', 'build')
    mkdirSync(dir, { recursive: true })
    mkdirSync(buildDir, { recursive: true })
    if (manifest !== undefined) {
      writeFileSync(join(dir, 'channel.json'),
        typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
    }
    return { repoRoot: root, buildDir, channelDir: dir }
  }

  it('stages the channel package so the runtime can read it', () => {
    const { repoRoot, buildDir } = channelDir({
      channel_id: 'acme',
      identity: { display_name: 'Acme AI' },
      defaults: { server_url: 'https://ai.acme.example.com' },
      desktop: { deep_link_scheme: 'acmeai' },
    })
    const context = resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot })
    const target = stageChannelProfile(context, buildDir)
    expect(target).toBe(join(buildDir, 'channel.json'))
    // 原样复制：运行期解析器与构建期读的是**同一份**字节。
    expect(JSON.parse(readFileSync(join(buildDir, 'channel.json'), 'utf8'))).toMatchObject({
      channel_id: 'acme',
      defaults: { server_url: 'https://ai.acme.example.com' },
      desktop: { deep_link_scheme: 'acmeai' },
    })
  })

  it('把渠道 logo 内联进随包配置（服务端不可达时也能显示客户标识）', () => {
    const { repoRoot, buildDir, channelDir: dir } = channelDir({
      channel_id: 'acme',
      identity: { display_name: 'Acme AI' },
      assets: { logo: 'logo.svg', logo_dark: 'logo-dark.svg' },
      desktop: { deep_link_scheme: 'acmeai' },
    })
    writeFileSync(join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8" fill="#106040"/></svg>')
    writeFileSync(join(dir, 'logo-dark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8" fill="#FFFFFF"/></svg>')
    const context = resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot })
    stageChannelProfile(context, buildDir)

    const staged = JSON.parse(readFileSync(join(buildDir, 'channel.json'), 'utf8')) as {
      assets: Record<string, string>
      channel_id?: string
    }
    // 私有仓原文不动（`logo` 仍是文件名），内联值另开两个键。
    expect(staged.assets.logo).toBe('logo.svg')
    expect(staged.assets.logo_inline).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(staged.assets.logo_dark_inline).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(Buffer.from(String(staged.assets.logo_inline).split(',')[1]!, 'base64').toString('utf8'))
      .toContain('fill="#106040"')
    // 其余字段照旧（内联只加键，不改内容）。
    expect(staged.channel_id).toBe('acme')
    // 源文件（私有仓里那份）没有被改写。
    expect(JSON.parse(readFileSync(join(dir, 'channel.json'), 'utf8'))).not.toHaveProperty('assets.logo_inline')
  })

  it('素材缺失或不是单段文件名时不内联（不影响其余字段）', () => {
    const { repoRoot, buildDir } = channelDir({
      channel_id: 'acme',
      identity: { display_name: 'Acme AI' },
      assets: { logo: 'missing.svg', logo_dark: '../escape.svg' },
      desktop: { deep_link_scheme: 'acmeai' },
    })
    const context = resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot })
    stageChannelProfile(context, buildDir)
    const staged = JSON.parse(readFileSync(join(buildDir, 'channel.json'), 'utf8')) as { assets: Record<string, string> }
    expect(staged.assets).not.toHaveProperty('logo_inline')
    expect(staged.assets).not.toHaveProperty('logo_dark_inline')
  })

  it('deletes a stale package on an official build', () => {
    // 残留 = 下一次官方/本地构建继承别的渠道的品牌,必须清掉。
    const { repoRoot, buildDir } = channelDir({
      channel_id: 'acme',
      identity: { display_name: 'Acme AI', short_name: 'Acme' },
    })
    writeFileSync(join(buildDir, 'channel.json'), JSON.stringify({ channel_id: 'acme' }))
    const official = resolveChannelBuildContext({ env: {}, repoRoot })
    expect(stageChannelProfile(official, buildDir)).toBeUndefined()
    expect(existsSync(join(buildDir, 'channel.json'))).toBe(false)
  })

  it('deletes a stale package when the channel directory has no manifest', () => {
    // 本地开发(有渠道目录但没写 channel.json)同样不能留着上一次的。
    const { repoRoot, buildDir } = channelDir(undefined)
    writeFileSync(join(buildDir, 'channel.json'), '{"channel_id":"other"}')
    const context = resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot })
    expect(stageChannelProfile(context, buildDir)).toBeUndefined()
    expect(existsSync(join(buildDir, 'channel.json'))).toBe(false)
  })

  it('refuses a package whose channel_id disagrees with the build channel', () => {
    // 目录名与 channel_id 不一致 = 渠道包放错了位置:装出来的客户端会声称自己
    // 是另一个渠道(服务端镜像按 channel_id 对账,两边各说各话)。
    const { repoRoot, buildDir } = channelDir({ channel_id: 'other', identity: { display_name: 'Other' } })
    const context = resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot })
    expect(() => stageChannelProfile(context, buildDir)).toThrow(/channel_id/)
    expect(existsSync(join(buildDir, 'channel.json'))).toBe(false)
  })

  it('refuses malformed JSON and oversized manifests', () => {
    // 畸形内容在**解析构建上下文**时就该炸(比就位更早):一路 fail-loud。
    const broken = channelDir('{ not json')
    expect(() => resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot: broken.repoRoot }))
      .toThrow(/不是合法 JSON/u)

    const huge = channelDir({ channel_id: 'acme', pad: 'x'.repeat(70 * 1024) })
    // 运行期解析器对 >64KB 一律当"没有渠道包",构建期必须更早、更响地拦住。
    expect(() => resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot: huge.repoRoot }))
      .toThrow(/64KB/u)
  })

  it('guards malformed content again at staging time', () => {
    // 上下文解析被绕过时(手工构造 context / 未来新增入口)就位这一步仍须 fail-loud,
    // 而不是把一份坏包写进应用资源。
    const broken = channelDir('{ not json')
    const context = {
      ...resolveChannelBuildContext({ env: {}, repoRoot: broken.repoRoot }),
      channelId: 'acme',
      official: false,
      // 手工构造的上下文:就位这一步必须自己再校验一遍内容。
      channelDir: broken.channelDir,
    }
    expect(() => stageChannelProfile(context, broken.buildDir)).toThrow(/不是合法 JSON/u)
    expect(existsSync(join(broken.buildDir, 'channel.json'))).toBe(false)
  })

  it('is wired into every packaging path (prepareChannelBuilderOverrides)', () => {
    // 打包入口全部只经这一个函数拿渠道参数:就位动作挂在这里才不会漏。
    const { repoRoot, buildDir } = channelDir({ channel_id: 'acme', identity: { display_name: 'Acme AI' } })
    const context = resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot })
    prepareChannelBuilderOverrides(context, buildDir)
    expect(existsSync(join(buildDir, 'channel.json'))).toBe(true)
  })

  it('ships the staged file (electron-builder files list)', () => {
    // 就位了但没进 electron-builder 的 files = 还是白干:运行期读的是 asar 里的
    // 副本。2026-09-10 实测:条目此前只在 npm 的 files 里(electron-builder 用
    // build.files,两者不是一回事),渠道包因此从未进包。
    expect(build.files).toContain('build/channel.json')
  })
})
