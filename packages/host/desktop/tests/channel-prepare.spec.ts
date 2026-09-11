/**
 * `prepareChannelPackaging()`：渠道客户端打包前的**唯一**就位入口。
 *
 * 这一组用例锁的是 2026-09-10 那次"整条客户端白标链是断的"的回归面：
 *   - 渠道包必须随包带上自己的 `build/channel.json`（否则客户端回落厂商名）；
 *   - 图标必须按渠道派生（否则渠道包带官方 app 图标/托盘图标出厂）；
 *   - 官方渠道必须清掉上一次渠道构建留下的 `build/channel.json`（残留会反过来
 *     把客户品牌染进官方包）。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { prepareChannelPackaging } from '../scripts/channel-prepare.ts'
import { generateTrayIcons } from '../scripts/generate-tray-icons.mjs'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopRoot, '..', '..', '..')
const officialLogo = join(repoRoot, 'brands', 'official', 'logo.svg')
const officialIcon = join(repoRoot, 'brands', 'official', 'app-icon.png')

/** 文件内容的 sha256（比对"是否同一份素材"）。 */
function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 一次性的临时目录。 */
function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * 造一个临时渠道仓：`<root>/channels/<id>/{channel.json,logo.svg,app-icon.png}`。
 * @param options - 渠道 id、channel.json 内容与素材开关。
 * @returns 仓库根目录。
 */
async function channelRepo(options: {
  channelId: string
  channel: unknown
  withAssets?: boolean
}): Promise<string> {
  const root = tempDir('dsh-channel-prepare-')
  const dir = join(root, 'channels', options.channelId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'channel.json'),
    typeof options.channel === 'string' ? options.channel : JSON.stringify(options.channel),
  )
  if (options.withAssets !== false) {
    // 渠道 logo：官方几何 + 一个额外节点（合法但**与官方不同**，用来证明图标
    // 确实是按渠道素材派生的）。
    const logo = readFileSync(officialLogo, 'utf8').replace(
      '</svg>',
      '<circle cx="200" cy="200" r="60" fill="#000000"/></svg>',
    )
    writeFileSync(join(dir, 'logo.svg'), logo)
    await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 12, g: 34, b: 156, alpha: 1 } } })
      .toColourspace('rgb16')
      .withMetadata({ icc: 'srgb' })
      .png()
      .toFile(join(dir, 'app-icon.png'))
  }
  return root
}

/** 一个字段齐全的品牌渠道配置。 */
function brandChannel(channelId: string): Record<string, unknown> {
  return {
    schema: 1,
    channel_id: channelId,
    identity: { display_name: 'Example Brand', short_name: 'Example' },
    desktop: {
      product_name: 'Example Brand',
      slug: 'Example-Brand',
      app_id: 'com.example.brand',
      deep_link_scheme: 'examplebrand',
    },
  }
}

describe('prepareChannelPackaging', () => {
  it('渠道构建:按渠道派生图标,并把随包 channel.json 就位', async () => {
    const repo = await channelRepo({ channelId: 'example-brand', channel: brandChannel('example-brand') })
    const appDir = tempDir('dsh-app-')

    const context = await prepareChannelPackaging({
      env: { DSH_BUILD_CHANNEL: 'example-brand' },
      repoRoot: repo,
      appDir,
    })

    expect(context.channelId).toBe('example-brand')
    // 1) 随包渠道配置：运行期 desktop-channel.ts 读的就是它。
    const staged = JSON.parse(readFileSync(join(appDir, 'channel.json'), 'utf8')) as { channel_id: string }
    expect(staged.channel_id).toBe('example-brand')
    // 2) app 图标来自**渠道素材**（不是 brands/official）。
    expect(sha256(join(appDir, 'app-icon.png'))).toBe(sha256(join(repo, 'channels', 'example-brand', 'app-icon.png')))
    expect(sha256(join(appDir, 'app-icon.png'))).not.toBe(sha256(officialIcon))
    // 3) 托盘位图按渠道 logo 重新派生（与单独渲染同一份 logo 的结果逐字节一致）。
    const expected = tempDir('dsh-tray-')
    await generateTrayIcons({ source: join(repo, 'channels', 'example-brand', 'logo.svg'), buildRoot: expected })
    for (const name of ['tray-iconTemplate.png', 'tray-icon-blue.png', 'tray-icon-blue@2x.png']) {
      expect(sha256(join(appDir, name))).toBe(sha256(join(expected, name)))
    }
    // 4) 渠道没给的素材逐文件回落官方。
    expect(existsSync(join(appDir, 'assistedMessages.yml'))).toBe(true)
  })

  it('官方构建:清掉上一次渠道构建残留的 channel.json,图标回到官方', async () => {
    const repo = await channelRepo({ channelId: 'example-brand', channel: brandChannel('example-brand') })
    const appDir = tempDir('dsh-app-')

    await prepareChannelPackaging({ env: { DSH_BUILD_CHANNEL: 'example-brand' }, repoRoot: repo, appDir })
    expect(existsSync(join(appDir, 'channel.json'))).toBe(true)

    const context = await prepareChannelPackaging({ env: {}, repoRoot: repo, appDir })

    expect(context.channelId).toBe('official')
    expect(existsSync(join(appDir, 'channel.json'))).toBe(false)
    expect(sha256(join(appDir, 'app-icon.png'))).toBe(sha256(officialIcon))
  })

  it('渠道包的 channel_id 与目录名不一致时 fail-loud,且不产出任何素材', async () => {
    const repo = await channelRepo({
      channelId: 'example-brand',
      channel: { ...brandChannel('example-brand'), channel_id: 'someone-else' },
    })
    const appDir = tempDir('dsh-app-')

    await expect(
      prepareChannelPackaging({ env: { DSH_BUILD_CHANNEL: 'example-brand' }, repoRoot: repo, appDir }),
    ).rejects.toThrow(/channel_id/u)
    // 校验在派生素材之前：失败时连图标都不该写出来。
    expect(existsSync(join(appDir, 'channel.json'))).toBe(false)
    expect(existsSync(join(appDir, 'app-icon.png'))).toBe(false)
  })

  it('渠道包非法 JSON 直接失败（不静默回落官方）', async () => {
    const repo = await channelRepo({ channelId: 'example-brand', channel: '{ not json' })
    const appDir = tempDir('dsh-app-')

    await expect(
      prepareChannelPackaging({ env: { DSH_BUILD_CHANNEL: 'example-brand' }, repoRoot: repo, appDir }),
    ).rejects.toThrow(/JSON/u)
  })

  it('渠道缺 logo.svg 时图标回落 brands/official（不是构建失败）', async () => {
    const repo = await channelRepo({ channelId: 'example-brand', channel: brandChannel('example-brand'), withAssets: false })
    // 只补 app-icon，logo 留给回落逻辑。
    copyFileSync(officialIcon, join(repo, 'channels', 'example-brand', 'app-icon.png'))
    const appDir = tempDir('dsh-app-')

    await prepareChannelPackaging({ env: { DSH_BUILD_CHANNEL: 'example-brand' }, repoRoot: repo, appDir })

    const official = tempDir('dsh-official-tray-')
    await generateTrayIcons({ source: officialLogo, buildRoot: official })
    expect(sha256(join(appDir, 'tray-icon-blue.png'))).toBe(sha256(join(official, 'tray-icon-blue.png')))
  })
})

describe('generateTrayIcons', () => {
  /** 一份"渠道用自己的品牌色"的 logo：平坦 #006AFF 方块 + 白 mark。 */
  function brandColorLogo(color = '#006AFF'): string {
    const path = join(tempDir('dsh-tray-src-'), 'logo.svg')
    writeFileSync(path, `<svg xmlns="http://www.w3.org/2000/svg" width="1254" height="1254" viewBox="0 0 1254 1254">`
      + `<rect width="1254" height="1254" rx="180" fill="${color}"/>`
      + '<path d="M300 900 L500 300 L627 700 L754 300 L954 900 Z" fill="#FFFFFF"/></svg>')
    return path
  }

  it('渠道用自己的品牌色画 logo 也能派生托盘位图（不再硬要求 #000000）', async () => {
    // 2026-09-11 实测：托盘派生此前硬性要求源文件里出现 fill="#000000"，
    // 于是"渠道 logo 用客户的品牌色"直接打包失败，报错还只说"必须用 #000000"。
    const out = tempDir('dsh-tray-out-')
    await generateTrayIcons({ source: brandColorLogo(), buildRoot: out })

    const meta = await sharp(join(out, 'tray-icon-blue@2x.png')).metadata()
    expect(meta.width).toBe(32)
    // 方块被换成托盘变体色（固定黑），mark 仍是白色 —— 证明替换的是方块自身颜色。
    const { data, info } = await sharp(join(out, 'tray-icon-blue@2x.png')).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    let dark = 0
    let white = 0
    for (let i = 0; i < data.length; i += info.channels) {
      const [r, g, b, a] = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!]
      if (a < 40) continue
      if (r < 60 && g < 60 && b < 60) dark += 1
      if (r > 200 && g > 200 && b > 200) white += 1
    }
    expect(dark).toBeGreaterThan(500)
    expect(white).toBeGreaterThan(0)
  })

  it('官方 logo 的产物与"替换 #000000"的旧行为逐字节一致', async () => {
    // 改造只放宽了输入约束，官方路径的产物不能变一丝一毫。
    const out = tempDir('dsh-tray-official-')
    await generateTrayIcons({ source: officialLogo, buildRoot: out })
    const source = readFileSync(officialLogo, 'utf8')
    for (const [file, size] of [['tray-iconTemplate.png', 16], ['tray-icon-blue@2x.png', 32]] as const) {
      const legacy = await sharp(Buffer.from(source.replaceAll('#000000', '#000000')))
        .resize({ width: size, height: size, fit: 'contain' })
        .png({ compressionLevel: 9 })
        .toBuffer()
      expect(readFileSync(join(out, file)).equals(legacy)).toBe(true)
    }
  })

  it('没有平坦方块（渐变/样式表）时给出可读的失败', async () => {
    const gradient = join(tempDir('dsh-tray-bad-'), 'logo.svg')
    writeFileSync(gradient, '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">'
      + '<defs><linearGradient id="g"><stop offset="0" stop-color="#006AFF"/></linearGradient></defs>'
      + '<rect width="24" height="24" fill="url(#g)"/></svg>')
    await expect(generateTrayIcons({ source: gradient, buildRoot: tempDir('dsh-tray-bad-out-') }))
      .rejects.toThrow(/flat|rect/iu)

    const styled = join(tempDir('dsh-tray-bad2-'), 'logo.svg')
    writeFileSync(styled, '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><style>.t{fill:#000000}</style>'
      + '<rect class="t" width="24" height="24"/></svg>')
    await expect(generateTrayIcons({ source: styled, buildRoot: tempDir('dsh-tray-bad2-out-') }))
      .rejects.toThrow(/style/iu)
  })
})
