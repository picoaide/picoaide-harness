#!/usr/bin/env node
/**
 * CI 渠道脚本的回归门禁。
 *
 * 为什么值得单独测:`scripts/ci-channels.sh` 与 `scripts/ci-package-clients.sh`
 * 决定**发哪些渠道、发到哪、以及渠道信息会不会进公开日志**。这三件事出错都是
 * 静默的(发错镜像 / 漏发渠道 / 客户名进了公开 Actions 日志),而且它们在
 * GitHub Actions 里才真正运行 —— 本地没有门禁就只能靠发版时踩。
 *
 * 覆盖:
 *   1. tag → 渠道集策略(正式 tag 全发、beta tag 只发 beta、非 tag 只发 official)
 *   2. 渠道枚举的掩码与定序(official 置顶)、不合规目录被跳过且**不打印名字**
 *   3. 缺 token / 渠道仓结构不符 / 缺 channel.json → fail-loud
 *   4. 逐渠道打包:官方保留完整日志、渠道输出被抑制、失败只报中性信息
 *   5. 产物归集到 client-assets/<channel>/,没产出即失败
 *   6. 更新服务器(R2)发布:每渠道独立目录、清单内容、保留最近 3 版、
 *      缓存头(资产 immutable / 清单 no-cache)、清单最后写、缺 secrets 跳过、
 *      产物不全 fail-loud —— 这些出错都是静默的,只能在发版时才发现
 *
 * 用法:node scripts/verify-ci-scripts.mjs
 * 退出码:0 全部通过;1 有断言失败。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { crc32, deflateSync } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const channelsScript = join(root, 'scripts', 'ci-channels.sh')
const packageScript = join(root, 'scripts', 'ci-package-clients.sh')
const publishScript = join(root, 'scripts', 'ci-publish-update-server.sh')
const transferScript = join(root, 'scripts', 'ci-channel-transfer.sh')
const imagesScript = join(root, 'scripts', 'ci-build-channel-images.sh')
const failures = []
const scratch = []

function fail(message) {
  failures.push(message)
  process.stderr.write(`verify-ci-scripts: ${message}\n`)
}

function check(condition, message) {
  if (!condition) fail(message)
  return condition
}

/** 造一个临时目录(进程退出时清理)。 */
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/** PNG 块(长度 + 类型 + 数据 + CRC)。 */
function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])) >>> 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

/** 造一张最小 PNG(用于测构建期的图标几何校验,不引入 sharp 依赖)。 */
function tinyPng(width, height, bitDepth, colorType) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = bitDepth
  ihdr[9] = colorType
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.alloc(width * height * 4))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 造一个假的私有渠道仓:`<root>/channels/<id>/channel.json`。 */
function fakeChannelRepo(ids, options = {}) {
  const dir = tempDir('ci-channels-repo-')
  for (const id of ids) {
    mkdirSync(join(dir, 'channels', id), { recursive: true })
    // 品牌字段是**必需**的(ci-channels.sh 里 fail-loud):客户端在登录之前就要
    // 显示品牌,包里没写就回落中性占位。品牌渠道的编译期字段(slug/app_id/
    // deep_link_scheme/home_dir)同样必需 —— 缺 slug 安装包名回落厂商品牌、缺
    // app_id 两个渠道的客户端在系统里变成同一个 app、缺 home_dir 两个渠道共用
    // 一个数据根(跨渠道共享登录态/会话)。
    const publicChannel = id === 'official' || id === 'beta'
    writeFileSync(join(dir, 'channels', id, 'channel.json'), JSON.stringify({
      schema: 1,
      channel_id: id,
      identity: { display_name: `${id} AI`, short_name: id },
      // 私有仓的渠道包里真实存在这样的注解字段:校验必须忽略 `_` 前缀的键,
      // 否则整条发布会被一条注释拦下(2026-09-10 CI 实测)。
      assets: { _note: '注解:渠道素材说明,不是文件名/路径' },
      ...(publicChannel
        ? {}
        : {
            desktop: {
              product_name: `${id} AI`,
              slug: `${id}-AI`,
              app_id: `com.example.${id.replaceAll('-', '')}`,
              deep_link_scheme: `${id.replaceAll('-', '')}link`,
              home_dir: `.${id}-harness`,
            },
          }),
    }))
  }
  for (const extra of options.extraDirectories ?? []) {
    mkdirSync(join(dir, 'channels', extra), { recursive: true })
  }
  return dir
}

/** 跑 ci-channels.sh。 */
function runChannels({ source, refName = '', dest, list, env = {} }) {
  const cwd = tempDir('ci-channels-run-')
  const result = spawnSync('bash', [channelsScript, '--dest', dest, '--list', join(cwd, list)], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ...(source === undefined ? {} : { CI_CHANNELS_SOURCE: source }),
      GITHUB_REF_NAME: refName,
      ...env,
    },
  })
  const listPath = join(cwd, list)
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    selected: existsSync(listPath)
      ? readFileSync(listPath, 'utf8').split('\n').filter(line => line !== '')
      : [],
    listPath,
  }
}

// ---- 1. tag → 渠道集策略 ----
{
  const source = fakeChannelRepo(['official', 'beta', 'example-brand', 'zeta'])
  const repoTag = runChannels({ source, refName: 'v2.7.0', dest: 'channels', list: 'a.list' })
  check(repoTag.status === 0, '正式 tag 应成功')
  check(
    JSON.stringify(repoTag.selected) === JSON.stringify(['official', 'beta', 'example-brand', 'zeta']),
    `正式 tag 应发全部渠道且 official 置顶,实际 ${JSON.stringify(repoTag.selected)}`,
  )

  const betaTag = runChannels({ source, refName: 'v2.7.0-beta.3', dest: 'channels', list: 'b.list' })
  check(
    JSON.stringify(betaTag.selected) === JSON.stringify(['beta']),
    `beta tag 应只发 beta,实际 ${JSON.stringify(betaTag.selected)}`,
  )

  const branch = runChannels({ source, refName: '', dest: 'channels', list: 'c.list' })
  check(
    JSON.stringify(branch.selected) === JSON.stringify(['official']),
    `非 tag 应只发 official,实际 ${JSON.stringify(branch.selected)}`,
  )
}

// ---- 2. 掩码 / 跳过不合规目录 / 不回显名字 ----
{
  const source = fakeChannelRepo(['official', 'example-brand'], { extraDirectories: ['README', 'Bad_Name'] })
  const result = runChannels({ source, refName: 'v2.7.0', dest: 'channels', list: 'd.list' })
  check(result.status === 0, '含不合规目录时仍应成功(跳过而非失败)')
  check(result.stdout.includes('::add-mask::example-brand'), '每个渠道 id 都必须 add-mask')
  check(result.stdout.includes('::add-mask::official'), 'official 也必须 add-mask')
  check(!result.stdout.includes('README'), '被跳过的目录名不得出现在输出里')
  check(!result.stdout.includes('Bad_Name'), '不合规目录名不得出现在输出里')
  check(result.stderr.includes('已跳过'), '跳过不合规目录时应给出计数告警')
  check(
    JSON.stringify(result.selected) === JSON.stringify(['official', 'example-brand']),
    `不合规目录不得进入构建列表,实际 ${JSON.stringify(result.selected)}`,
  )
}

// ---- 3. fail-loud 分支 ----
{
  const noToken = runChannels({ source: undefined, refName: 'v2.7.0', dest: 'channels', list: 'e.list' })
  check(noToken.status !== 0, '没有渠道仓令牌时必须失败(不得静默按官方发)')
  check(noToken.stderr.includes('CHANNELS_REPO_TOKEN'), '失败信息应指明缺失的 secret')

  const wrongStructure = tempDir('ci-channels-bad-')
  mkdirSync(join(wrongStructure, 'not-channels'), { recursive: true })
  const bad = runChannels({ source: wrongStructure, refName: 'v2.7.0', dest: 'channels', list: 'f.list' })
  check(bad.status !== 0, '渠道仓结构不符时必须失败')

  // 正式 tag 选中的渠道在仓里缺 channel.json → 必须失败(不是"跳过")
  const missingConfig = tempDir('ci-channels-missing-')
  mkdirSync(join(missingConfig, 'channels', 'official'), { recursive: true })
  writeFileSync(join(missingConfig, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"Official","short_name":"Official"}}')
  mkdirSync(join(missingConfig, 'channels', 'beta'), { recursive: true }) // 无 channel.json
  const missing = runChannels({ source: missingConfig, refName: 'v2.7.0', dest: 'channels', list: 'g.list' })
  check(missing.status !== 0, '选中渠道缺 channel.json 时必须失败')

  // 渠道包缺品牌字段 → 必须**中止构建**:客户端登录页/侧边栏在服务端不可达时
  // 回落中性占位,交付出去就是观感事故,而这类事故只能在构建期拦。
  const branded = tempDir('ci-channels-brand-')
  mkdirSync(join(branded, 'channels', 'official'), { recursive: true })
  writeFileSync(join(branded, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"Official","short_name":"Official"}}')
  mkdirSync(join(branded, 'channels', 'example-brand'), { recursive: true })
  writeFileSync(join(branded, 'channels', 'example-brand', 'channel.json'), '{"schema":1,"channel_id":"example-brand"}')
  const noBrand = runChannels({ source: branded, refName: 'v2.7.0', dest: 'channels', list: 'h.list' })
  check(noBrand.status !== 0, '渠道包缺品牌字段时必须失败')
  check(noBrand.stderr.includes('品牌字段'), '失败信息应指明缺的是品牌字段')
  check(noBrand.stderr.includes('identity.display_name'), '失败信息应列出缺失的具体字段')
  check(!noBrand.stderr.includes('example-brand'), '品牌缺失的报错不得回显渠道名')

  // 只有 display_name、没有 short_name 也要中止(登录页名字的直接来源)
  const halfBranded = tempDir('ci-channels-brand-half-')
  mkdirSync(join(halfBranded, 'channels', 'official'), { recursive: true })
  writeFileSync(join(halfBranded, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"Official"}}')
  const half = runChannels({ source: halfBranded, refName: 'v2.7.0', dest: 'channels', list: 'i.list' })
  check(half.status !== 0, '只配 display_name 也必须失败')
  check(half.stderr.includes('identity.short_name'), '失败信息应点明缺 short_name')

  // 品牌渠道缺**编译期**字段 → 必须中止:缺 desktop.slug 时安装包名回落
  // `PicoAide-Harness-…`(交付物上的厂商品牌),缺 app_id 时 bundle id 回落厂商值
  // (两个渠道的客户端在系统里变成同一个 app)。
  const noCompile = tempDir('ci-channels-compile-')
  mkdirSync(join(noCompile, 'channels', 'official'), { recursive: true })
  writeFileSync(join(noCompile, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"Official","short_name":"Official"}}')
  mkdirSync(join(noCompile, 'channels', 'example-brand'), { recursive: true })
  writeFileSync(join(noCompile, 'channels', 'example-brand', 'channel.json'),
    '{"schema":1,"channel_id":"example-brand","identity":{"display_name":"Example","short_name":"Example"}}')
  const compile = runChannels({ source: noCompile, refName: 'v2.7.0', dest: 'channels', list: 'j.list' })
  check(compile.status !== 0, '品牌渠道缺编译期字段时必须失败')
  check(compile.stderr.includes('desktop.slug') && compile.stderr.includes('desktop.app_id'),
    '失败信息应列出缺的编译期字段')
  check(!compile.stderr.includes('example-brand'), '编译期字段报错不得回显渠道名')

  // channel.json 字段形状不对(slug 含空格、scheme 非法)→ 构建期拦
  const badShape = tempDir('ci-channels-shape-')
  mkdirSync(join(badShape, 'channels', 'official'), { recursive: true })
  writeFileSync(join(badShape, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"Official","short_name":"Official"}}')
  mkdirSync(join(badShape, 'channels', 'example-brand'), { recursive: true })
  writeFileSync(join(badShape, 'channels', 'example-brand', 'channel.json'), JSON.stringify({
    schema: 1,
    channel_id: 'example-brand',
    identity: { display_name: 'Example', short_name: 'Example' },
    desktop: { slug: 'Example AI', app_id: 'com.example.brand', deep_link_scheme: 'Example!' },
  }))
  const shape = runChannels({ source: badShape, refName: 'v2.7.0', dest: 'channels', list: 'k.list' })
  check(shape.status !== 0, '字段形状非法时必须失败')
  check(shape.stderr.includes('desktop.slug') && shape.stderr.includes('deep_link_scheme'),
    '失败信息应指出非法字段')

  // app-icon.png 不符合 mac 图标管线要求(1024×1024 RGBA16 + ICC)→ 构建期拦,
  // 而不是等到三平台打包时才炸(mac 图标由 sharp 派生,要求极严)。
  const badIcon = tempDir('ci-channels-icon-')
  mkdirSync(join(badIcon, 'channels', 'official'), { recursive: true })
  writeFileSync(join(badIcon, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"Official","short_name":"Official"}}')
  mkdirSync(join(badIcon, 'channels', 'example-brand'), { recursive: true })
  writeFileSync(join(badIcon, 'channels', 'example-brand', 'channel.json'), JSON.stringify({
    schema: 1,
    channel_id: 'example-brand',
    identity: { display_name: 'Example', short_name: 'Example' },
    desktop: { slug: 'Example-AI', app_id: 'com.example.brand', deep_link_scheme: 'examplebrand' },
  }))
  writeFileSync(join(badIcon, 'channels', 'example-brand', 'app-icon.png'), tinyPng(256, 256, 8, 6))
  const icon = runChannels({ source: badIcon, refName: 'v2.7.0', dest: 'channels', list: 'l.list' })
  check(icon.status !== 0, 'app-icon.png 尺寸不符时必须失败')
  check(icon.stderr.includes('app-icon.png'), '失败信息应点名 app-icon.png')

  // 未知素材字段(很可能是拼错)→ 只告警,不中止发布
  const unknownAsset = tempDir('ci-channels-unknown-asset-')
  mkdirSync(join(unknownAsset, 'channels', 'official'), { recursive: true })
  writeFileSync(join(unknownAsset, 'channels', 'official', 'channel.json'), JSON.stringify({
    schema: 1,
    channel_id: 'official',
    identity: { display_name: 'Official', short_name: 'Official' },
    assets: { _note: '注解', logoo: 'logo.svg' },
  }))
  const unknown = runChannels({ source: unknownAsset, refName: 'v2.7.0', dest: 'channels', list: 'n.list' })
  check(unknown.status === 0, '未知素材字段不应中止发布(只告警)')
  check(unknown.stderr.includes('logoo'), '未知素材字段应给出告警并点名')

  // 报错**不得回显品牌取值**:slug/app_id/scheme 的值就是客户品牌
  // (Acme-AI / com.acme.ai / acmeai),而这一步的输出去公开 Actions 日志。
  // 2026-09-10 审计当场发现早先版本把值拼进了错误信息 —— ::add-mask:: 只掩码
  // 渠道 id,掩不到这些值,所以必须由脚本自己保证。
  const leaky = tempDir('ci-channels-leak-')
  mkdirSync(join(leaky, 'channels', 'official'), { recursive: true })
  writeFileSync(join(leaky, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"Official","short_name":"Official"}}')
  mkdirSync(join(leaky, 'channels', 'example-brand'), { recursive: true })
  writeFileSync(join(leaky, 'channels', 'example-brand', 'channel.json'), JSON.stringify({
    schema: 1,
    channel_id: 'example-brand',
    identity: { display_name: 'Secret Brand', short_name: 'Secret' },
    // 三个字段都**非法**:非法值才是会被拼进早先版本错误信息的东西
    desktop: { slug: 'TOP SECRET BRAND', app_id: 'com.secret brand', deep_link_scheme: 'SECRET!' },
  }))
  const leak = runChannels({ source: leaky, refName: 'v2.7.0', dest: 'channels', list: 'o.list' })
  const leakOut = `${leak.stdout ?? ''}${leak.stderr ?? ''}`
  check(leak.status !== 0, '非法编译期字段必须中止构建')
  check(leak.stderr.includes('desktop.slug'), '失败信息仍须指明是哪个字段不合法')
  check(leak.stderr.includes('desktop.deep_link_scheme'), '失败信息应列出全部非法字段')
  check(!leakOut.includes('TOP SECRET BRAND'), '报错不得回显 slug 取值(那是客户品牌)')
  check(!leakOut.includes('com.secret brand'), '报错不得回显 app_id 取值')
  check(!leakOut.includes('SECRET!'), '报错不得回显 scheme 取值')

  // 声明的素材文件不存在 → 构建期拦(否则服务端不下发 URL、客户端拿到死链)
  const missingAsset = tempDir('ci-channels-asset-')
  mkdirSync(join(missingAsset, 'channels', 'official'), { recursive: true })
  writeFileSync(join(missingAsset, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"Official","short_name":"Official"}}')
  mkdirSync(join(missingAsset, 'channels', 'example-brand'), { recursive: true })
  writeFileSync(join(missingAsset, 'channels', 'example-brand', 'channel.json'), JSON.stringify({
    schema: 1,
    channel_id: 'example-brand',
    identity: { display_name: 'Example', short_name: 'Example' },
    desktop: { slug: 'Example-AI', app_id: 'com.example.brand', deep_link_scheme: 'examplebrand' },
    assets: { logo: 'logo.svg' },
  }))
  const asset = runChannels({ source: missingAsset, refName: 'v2.7.0', dest: 'channels', list: 'm.list' })
  check(asset.status !== 0, '声明的素材文件不存在时必须失败')
  check(asset.stderr.includes('assets.logo'), '失败信息应点名缺哪个素材')

  // 空白字符串不算配置(与客户端 nonEmpty 口径一致)
  const blank = tempDir('ci-channels-brand-blank-')
  mkdirSync(join(blank, 'channels', 'official'), { recursive: true })
  writeFileSync(join(blank, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"   ","short_name":"Official"}}')
  const blankRun = runChannels({ source: blank, refName: 'v2.7.0', dest: 'channels', list: 'j.list' })
  check(blankRun.status !== 0, '空白品牌名必须视为缺失')

  // 数据目录(desktop.home_dir):渠道客户端的数据根 —— 账户 token、settings、
  // 会话、连接器凭据都在里面。缺了/写错/写回官方目录都必须中止构建:
  // 装到客户机器上才发现就是"两个渠道共用一份登录态"(跨租户)。
  const brandOnly = (homeDirValue) => {
    const root = tempDir('ci-channels-home-')
    mkdirSync(join(root, 'channels', 'official'), { recursive: true })
    writeFileSync(join(root, 'channels', 'official', 'channel.json'),
      '{"schema":1,"channel_id":"official","identity":{"display_name":"Official","short_name":"Official"}}')
    mkdirSync(join(root, 'channels', 'example-brand'), { recursive: true })
    writeFileSync(join(root, 'channels', 'example-brand', 'channel.json'), JSON.stringify({
      schema: 1,
      channel_id: 'example-brand',
      identity: { display_name: 'Example', short_name: 'Example' },
      desktop: {
        slug: 'Example-AI',
        app_id: 'com.example.brand',
        deep_link_scheme: 'examplebrand',
        ...(homeDirValue === undefined ? {} : { home_dir: homeDirValue }),
      },
    }))
    return runChannels({ source: root, refName: 'v2.7.0', dest: 'channels', list: 'p.list' })
  }

  const noHome = brandOnly(undefined)
  check(noHome.status !== 0, '品牌渠道缺 desktop.home_dir 时必须失败')
  check(noHome.stderr.includes('desktop.home_dir'), '失败信息应点明缺 desktop.home_dir')

  const sharedHome = brandOnly('.picoaide-harness')
  check(sharedHome.status !== 0, '渠道数据目录写成官方目录时必须失败(那是共用数据根)')
  check(sharedHome.stderr.includes('desktop.home_dir'), '失败信息应点明是 desktop.home_dir 的问题')

  for (const [value, why] of [
    ['../escape', '带路径分隔符'],
    ['/abs', '绝对路径'],
    ['Acme-Harness', '缺前导点/含大写'],
    ['.', '只有一个点'],
    ['', '空串'],
  ]) {
    const bad = brandOnly(value)
    check(bad.status !== 0, `desktop.home_dir 是${why}时必须失败`)
    check(bad.stderr.includes('desktop.home_dir'), `desktop.home_dir(${why})的失败信息应点名该字段`)
  }

  // beta 复用官方品牌,但它是独立分发面 —— 数据目录也必须与官方不同
  const betaShared = tempDir('ci-channels-beta-home-')
  mkdirSync(join(betaShared, 'channels', 'beta'), { recursive: true })
  writeFileSync(join(betaShared, 'channels', 'beta', 'channel.json'), JSON.stringify({
    schema: 1,
    channel_id: 'beta',
    identity: { display_name: 'PicoAide Harness', short_name: 'PicoAide' },
    desktop: { home_dir: '.picoaide-harness' },
  }))
  const betaRun = runChannels({ source: betaShared, refName: 'v2.7.0-beta.3', dest: 'channels', list: 'q.list' })
  check(betaRun.status !== 0, 'beta 的数据目录等于官方目录时必须失败')
}

// ---- 4/5. 逐渠道打包:日志抑制、失败中性、产物归集 ----
{
  const runDir = tempDir('ci-package-run-')
  const stage = join(runDir, 'stage')
  const list = join(runDir, 'ch.list')
  // 产物目录落在 runDir 下,假打包器与脚本都不得碰仓库里真实的
  // packages/host/desktop/dist —— 脚本每个渠道开头就 `rm -rf "$DIST"`,缺省值是
  // **真实** dist,跑一次 `yarn check` 就会把刚打好的包删掉(2026-09-11 实测:
  // yarn check 后 dist/linux-unpacked 整个消失,后面的 E2E 报 app binary not found)。
  const distDir = join(runDir, 'dist')
  mkdirSync(distDir, { recursive: true })
  // 哨兵文件：下面几个用例都调 ci-package-clients.sh，而它每个渠道开头就
  // `rm -rf "$DIST"`，缺省的 DIST 是**仓库里真实的** packages/host/desktop/dist ——
  // 少传一次 `--dist` 就会把开发机/CI 刚打好的包删掉（2026-09-11 实测：
  // `yarn check` 之后 dist/ 变空，随后的 e2e 报 app binary not found）。
  // 用例跑完在这里断言哨兵还在，把"漏传 --dist"变成红灯而不是静默删产物。
  const realDist = join(root, 'packages', 'host', 'desktop', 'dist')
  const sentinel = join(realDist, '.verify-ci-scripts-sentinel')
  mkdirSync(realDist, { recursive: true })
  writeFileSync(sentinel, 'keep')
  writeFileSync(list, 'official\nexample-brand\n')

  // 假打包器:回显渠道名并产出两种文件;渠道名出现在**输出**里,
  // 真实 CI 中会被 ::add-mask:: 抹掉,这里只断言"渠道构建不输出"这一层。
  const stub = join(runDir, 'stub.sh')
  writeFileSync(stub, `#!/usr/bin/env bash
 echo "building for \${DSH_BUILD_CHANNEL}"
 mkdir -p "${distDir}"
 echo x > "${distDir}/App-\${DSH_BUILD_CHANNEL}.AppImage"
 echo y > "${distDir}/App-\${DSH_BUILD_CHANNEL}.deb"
`)
  execFileSync('chmod', ['+x', stub])

  // 白标门禁桩:真实脚本要读 build/ 与私有渠道仓,回归测试里换成"永远通过"的桩。
  // (桩自身也在测:门禁是**在打包之后、归集之前**被调用的。)
  const verifyStub = join(runDir, 'verify-ok.mjs')
  writeFileSync(verifyStub, `console.log(\`verify stub: \${process.env.DSH_BUILD_CHANNEL} \${process.argv.slice(2).join(' ')}\`)
`)

  // --dist：必须指到 runDir,否则脚本的缺省产物目录是**仓库里真实的**
  // packages/host/desktop/dist,而它每个渠道开头就 `rm -rf "$DIST"` ——
  // 跑一次 `yarn check` 就会把开发机/CI 上刚打好的包删掉(2026-09-11 实测踩到:
  // yarn check 之后 dist/linux-unpacked 整个消失,E2E 报"app binary not found")。
  const ok = spawnSync('bash', [
    packageScript, '--list', list, '--stage-dir', stage, '--dist', distDir,
    '--patterns', '*.AppImage *.deb', '--', stub,
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, CI_CHANNEL_VERIFY_SCRIPT: verifyStub } })
  check(ok.status === 0, `逐渠道打包应成功,实际退出 ${String(ok.status)}`)
  check((ok.stdout ?? '').includes('building for official'), '官方渠道必须保留完整日志(排障基准)')
  check(!(ok.stdout ?? '').includes('building for example-brand'), '渠道构建的输出不得出现在日志里')
  check(existsSync(join(stage, 'official', 'App-official.AppImage')), '官方产物应归集到 client-assets/<channel>/')
  check(existsSync(join(stage, 'example-brand', 'App-example-brand.deb')), '渠道产物应归集到自己的目录')
  check((ok.stdout ?? '').includes('verify stub: official'), '官方渠道必须跑白标门禁')
  check(!(ok.stdout ?? '').includes('verify stub: example-brand'), '渠道的白标门禁输出也必须被抑制')

  // 白标门禁失败 → 报中性信息(不回显渠道名/门禁输出),且不许把产物当成功归集
  const verifyFail = join(runDir, 'verify-fail.mjs')
  writeFileSync(verifyFail, `if (process.env.DSH_BUILD_CHANNEL !== 'official') {
  console.log('VERIFY-SECRET-DETAIL')
  process.exit(4)
}
`)
  const stageGate = join(runDir, 'stage-gate')
  const gate = spawnSync('bash', [
    packageScript, '--list', list, '--stage-dir', stageGate, '--dist', distDir,
    '--patterns', '*.AppImage *.deb', '--', stub,
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, CI_CHANNEL_VERIFY_SCRIPT: verifyFail } })
  check(gate.status !== 0, '渠道白标门禁失败必须让步骤失败')
  const gateLines = `${gate.stdout ?? ''}${gate.stderr ?? ''}`
    .split('\n')
    .filter(line => !line.startsWith('::add-mask::'))
    .join('\n')
  check(!gateLines.includes('VERIFY-SECRET-DETAIL'), '门禁失败不得回显门禁输出')
  check(!gateLines.includes('example-brand'), '门禁失败信息里不得出现渠道名')
  check(!existsSync(join(stageGate, 'example-brand')), '门禁失败的渠道不得被归集为可用产物')

  // 渠道构建失败 → 只报中性信息,不回显渠道名与命令输出
  // 秘密标记只在**渠道**那一轮打印:官方轮是允许输出日志的。
  const failStub = join(runDir, 'fail.sh')
  writeFileSync(failStub, `#!/usr/bin/env bash
if [ "\${DSH_BUILD_CHANNEL}" != "official" ]; then
  echo "SECRET-CHANNEL-DETAIL"
  echo "\${DSH_BUILD_CHANNEL}" >&2
  exit 3
fi
mkdir -p "${distDir}"
echo x > "${distDir}/App.AppImage"
`)
  execFileSync('chmod', ['+x', failStub])
  const stage2 = join(runDir, 'stage2')
  const failed = spawnSync('bash', [
    packageScript, '--list', list, '--stage-dir', stage2, '--dist', distDir,
    '--patterns', '*.AppImage', '--', failStub,
  ], { cwd: root, encoding: 'utf8' })
  check(failed.status !== 0, '渠道打包失败必须让步骤失败')
  // `::add-mask::<id>` 这一行本身含渠道 id —— 那是掩码指令(GitHub 不会把它
  // 回显进公开日志),比对时先剔除,只看真正的输出行。
  const failureLines = `${failed.stdout ?? ''}${failed.stderr ?? ''}`
    .split('\n')
    .filter(line => !line.startsWith('::add-mask::'))
    .join('\n')
  check(!failureLines.includes('SECRET-CHANNEL-DETAIL'), '失败时不得回显渠道构建的输出')
  check(!failureLines.includes('example-brand'), '失败信息里不得出现渠道名')
  check(failureLines.includes('官方构建'), '失败信息应指引去看官方构建的日志')

  // 三个打包用例都不许动仓库里真实的 dist/（哨兵法：被 `rm -rf "$DIST"` 连目录一起删掉）。
  check(existsSync(sentinel), '打包脚本用例不得删除仓库里真实的 packages/host/desktop/dist（漏传 --dist）')
  rmSync(sentinel, { force: true })
}

// ---- 6. 所有 CI shell 脚本必须能通过 bash -n ----
// 2026-09-10 的教训:两处未闭合引号让整个 release job 跑不起来,而 YAML 本身
// 完全合法 —— 只有 bash 解析整段脚本时才会发现。这里把 scripts/ 下的 shell
// 脚本全部过一遍,避免同类错误再次静默进入发布链。
{
  const scriptDir = join(root, 'scripts')
  const shells = readdirSync(scriptDir).filter(name => name.endsWith('.sh'))
  check(shells.length > 0, 'scripts/ 下应有 CI shell 脚本')
  for (const name of shells) {
    const result = spawnSync('bash', ['-n', join(scriptDir, name)], { encoding: 'utf8' })
    check(result.status === 0, `scripts/${name} 未通过 bash -n: ${(result.stderr ?? '').trim()}`)
  }
}

// ---- 6. 更新服务器(R2)发布:布局 / 清单 / 保留策略 / 缓存头 ----
{
  const work = tempDir('ci-publish-')
  const bundle = join(work, 'release-bundle')
  const list = join(work, 'channels.list')
  const store = join(work, 'store')
  writeFileSync(list, 'official\nbeta\nexample-brand\n')

  // 假 aws:把 s3 cp/ls/rm 变成对本地目录的操作,并把参数记进日志,便于断言。
  const log = join(work, 'aws.log')
  writeFileSync(log, '')
  const fakeAws = join(work, 'aws')
  writeFileSync(fakeAws, `#!/usr/bin/env bash
set -euo pipefail
log="${log}"
store="${store}"
record() { printf '%s\\n' "$*" >> "$log"; }
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --endpoint-url) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
cmd="\${args[0]:-} \${args[1]:-}"
case "$cmd" in
  "s3 cp")
    src="\${args[2]}"; dst="\${args[3]}"
    extra=("\${args[@]:4}")
    record "cp $src $dst \${extra[*]:-}"
    key="\${dst#s3://*/}"
    if [[ "$dst" == */ ]]; then
      # 目录目标:对象键 = 前缀 + 源文件名(与 aws s3 cp 语义一致)
      dest="$store/\${key}$(basename "$src")"
    else
      dest="$store/\${key}"
    fi
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    ;;
  "s3 ls")
    prefix="\${args[2]}"
    key="\${prefix#s3://*/}"
    record "ls $prefix"
    if [ -d "$store/$key" ]; then ls -d "$store/$key"*/ 2>/dev/null | while read -r d; do echo "PRE $(basename "$d")/"; done; fi
    ;;
  "s3 rm")
    target="\${args[2]}"
    key="\${target#s3://*/}"
    record "rm $target"
    rm -rf "$store/$key"
    ;;
  *) record "other $*" ;;
esac
`)
  execFileSync('chmod', ['+x', fakeAws])

  // 每个渠道造一份"已构建"的镜像包。
  for (const channel of ['official', 'beta', 'example-brand']) {
    mkdirSync(join(bundle, channel), { recursive: true })
    writeFileSync(join(bundle, channel, 'picoaide-server-2.7.0-amd64.zip'), `zip-${channel}`)
    writeFileSync(join(bundle, channel, 'SHA256SUMS'), `sum-${channel}`)
  }
  // 早于保留窗口的旧版本(应被清掉)与较新版本(应保留)。
  mkdirSync(join(store, 'official', 'releases', '2.5.0'), { recursive: true })
  mkdirSync(join(store, 'official', 'releases', '2.6.0'), { recursive: true })
  mkdirSync(join(store, 'official', 'releases', '2.6.1'), { recursive: true })

  const run = spawnSync('bash', [publishScript, '--list', list, '--bundle', bundle], {
    cwd: work,
    encoding: 'utf8',
    env: {
      PATH: `${work}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? '',
      R2_ACCOUNT_ID: 'test-account',
      R2_BUCKET: 'test-bucket',
      VERSION: 'v2.7.0',
    },
  })
  check(run.status === 0, `R2 发布应成功,实际退出 ${String(run.status)}: ${run.stderr ?? ''}`)
  check(run.stdout.includes('::add-mask::example-brand'), '发布步骤必须自己再掩码渠道 id')
  // 掩码行本身必然含渠道名(GitHub 从这一刻起把它抹成 ***);除此之外不得出现。
  const visible = run.stdout.split('\n').filter(line => !line.startsWith('::add-mask::')).join('\n')
  check(!visible.includes('example-brand'), '渠道名不得出现在发布日志里(掩码行除外)')

  // 每个渠道一套独立目录 + 版本化资产 + 清单。
  for (const channel of ['official', 'beta', 'example-brand']) {
    const dir = join(store, channel)
    check(existsSync(join(dir, 'releases', '2.7.0', 'picoaide-server-2.7.0-amd64.zip')), `${channel}: 应上传 zip`)
    check(existsSync(join(dir, 'releases', '2.7.0', 'SHA256SUMS')), `${channel}: 应上传 SHA256SUMS`)
    const manifestPath = join(dir, 'latest.json')
    check(existsSync(manifestPath), `${channel}: 应写 latest.json`)
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    check(manifest.channel_id === channel, `${channel}: 清单 channel_id 必须指向自己(渠道独立)`)
    check(manifest.server.version === '2.7.0' && manifest.server.image_tag === 'v2.7.0', `${channel}: 清单版本应为 2.7.0`)
    check(
      manifest.server.image_asset === `https://release.picoaide.com/${channel}/releases/2.7.0/picoaide-server-2.7.0-amd64.zip`,
      `${channel}: 清单里的下载地址必须指向**本渠道**目录,实际 ${manifest.server.image_asset}`,
    )
    check(typeof manifest.published_at === 'string' && manifest.published_at.endsWith('Z'), `${channel}: 清单需要 UTC 发布时间`)
  }

  // 保留策略:最近 3 个版本(2.6.0/2.6.1/2.7.0),最旧的 2.5.0 被清掉。
  check(!existsSync(join(store, 'official', 'releases', '2.5.0')), '超出保留窗口的旧版本应被清理')
  check(existsSync(join(store, 'official', 'releases', '2.6.0')), '保留窗口内的版本不得误删')
  check(existsSync(join(store, 'official', 'releases', '2.6.1')), '保留窗口内的版本不得误删')

  // 缓存头:资产不可变长缓存、指针 no-cache(否则新版本不生效)。
  const awsLog = readFileSync(log, 'utf8')
  if (process.env.DEBUG_PUBLISH === '1') process.stderr.write(`--- aws.log ---\n${awsLog}\n--- store ---\n${execFileSync('find', [store, '-type', 'f']).toString()}\n`)
  check(awsLog.includes('max-age=31536000, immutable'), '版本化资产必须带 immutable 长缓存')
  check(/latest\.json.*no-cache/.test(awsLog), 'latest.json 必须 no-cache(否则客户端拿不到新版本)')
  const lines = awsLog.split('\n').filter(line => line !== '')
  const firstAsset = lines.findIndex(line => line.includes('official/SHA256SUMS'))
  const firstManifest = lines.findIndex(line => line.includes('latest.json'))
  check(firstAsset !== -1 && firstManifest > firstAsset, '清单应在资产之后写入(避免指向空目录)')

  // 缺 R2 secrets 且**这次要发品牌渠道** → 必须失败(品牌渠道只有 R2 一个分发面,
  // 静默跳过 = 客户零交付而流水线全绿)。
  const brandNoCreds = spawnSync('bash', [publishScript, '--list', list, '--bundle', bundle], {
    cwd: work,
    encoding: 'utf8',
    env: { PATH: `${work}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '', VERSION: 'v2.7.0' },
  })
  check(brandNoCreds.status !== 0, '含品牌渠道时缺 R2 凭据必须失败')
  check(
    `${brandNoCreds.stderr ?? ''}`.includes('品牌渠道'),
    '失败信息应说明品牌渠道只经更新服务器分发',
  )

  // 只有官方/beta → 跳过而不是失败(GitHub Release 仍要可用)。
  const publicList = join(work, 'public-channels.list')
  writeFileSync(publicList, 'official\nbeta\n')
  const skipped = spawnSync('bash', [publishScript, '--list', publicList, '--bundle', bundle], {
    cwd: work,
    encoding: 'utf8',
    env: { PATH: `${work}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '', VERSION: 'v2.7.0' },
  })
  check(skipped.status === 0, 'R2 secrets 未配置时应跳过而非失败')
  check(`${skipped.stdout ?? ''}${skipped.stderr ?? ''}`.includes('跳过'), '跳过时应给出告警')

  // 产物缺失 → fail-loud(绝不发布不完整版本)。
  rmSync(join(bundle, 'beta', 'SHA256SUMS'))
  const incomplete = spawnSync('bash', [publishScript, '--list', list, '--bundle', bundle], {
    cwd: work,
    encoding: 'utf8',
    env: {
      PATH: `${work}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? '',
      R2_ACCOUNT_ID: 'test-account',
      R2_BUCKET: 'test-bucket',
      VERSION: 'v2.7.0',
    },
  })
  check(incomplete.status !== 0, '缺 SHA256SUMS 时必须失败')
  check((incomplete.stderr ?? '').includes('缺失'), '失败信息应说明缺什么')

  // 缺 VERSION → fail-loud。
  const noVersion = spawnSync('bash', [publishScript, '--list', list, '--bundle', bundle], {
    cwd: work,
    encoding: 'utf8',
    env: { PATH: `${work}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '', R2_ACCOUNT_ID: 'a', R2_BUCKET: 'b' },
  })
  check(noVersion.status !== 0, '缺 VERSION 时必须失败')
}

// ---- 7. 品牌渠道产物私密中转(不经公开 artifact) ----
{
  const work = tempDir('ci-transfer-')
  const stage = join(work, 'client-assets')
  const out = join(work, 'release-artifacts')
  const list = join(work, 'channels.list')
  const store = join(work, 'store')
  const log = join(work, 'aws.log')
  writeFileSync(log, '')
  writeFileSync(list, 'official\nbeta\nexample-brand\n')

  // 假 aws:recursive cp/rm 落到本地目录,并记录调用参数。
  const fakeAws = join(work, 'aws')
  writeFileSync(fakeAws, `#!/usr/bin/env bash
set -euo pipefail
log="${log}"
store="${store}"
record() { printf '%s\\n' "$*" >> "$log"; }
args=(); recursive=0
while [ $# -gt 0 ]; do
  case "$1" in
    --endpoint-url) shift 2 ;;
    --only-show-errors) shift ;;
    --recursive) recursive=1; shift ;;
    *) args+=("$1"); shift ;;
  esac
done
cmd="\${args[0]:-} \${args[1]:-}"
case "$cmd" in
  "s3 cp")
    src="\${args[2]}"; dst="\${args[3]}"
    record "cp $src $dst recursive=$recursive"
    if [ "$recursive" = 1 ]; then
      # 模拟真实 aws CLI 的前缀语义:s3 侧的路径就是**字面前缀**,尾斜杠即"目录"。
      # 刻意不特判 "/." —— 真实 CLI 不认它(当作字面前缀,匹配不到对象),
      # 桩要是把它"修正"了,就测不出那种路径形态的错误(2026-09-10 教训)。
      if [[ "$src" == s3://* ]]; then
        key="\${src#s3://*/}"; key="\${key%/}"
        mkdir -p "$dst"
        [ -d "$store/$key" ] && cp -a "$store/$key/." "$dst/"
      else
        key="\${dst#s3://*/}"; key="\${key%/}"
        mkdir -p "$store/$key"; cp -a "$src/." "$store/$key/"
      fi
    else
      key="\${dst#s3://*/}"
      mkdir -p "$(dirname "$store/$key")"; cp "$src" "$store/$key"
    fi
    ;;
  "s3 rm")
    prefix="\${args[2]}"; key="\${prefix#s3://*/}"
    record "rm $prefix"
    rm -rf "$store/$key"
    ;;
esac
`)
  execFileSync('chmod', ['+x', fakeAws])

  /** 跑一次中转脚本。 */
  const transfer = (mode, extra = [], env = {}) => spawnSync('bash', [transferScript, mode, '--list', list, ...extra], {
    cwd: work,
    encoding: 'utf8',
    env: {
      PATH: `${work}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? '',
      GITHUB_RUN_ID: '4242',
      GITHUB_RUN_ATTEMPT: '1',
      ...env,
    },
  })
  const r2 = { R2_ACCOUNT_ID: 'acct', R2_BUCKET: 'bucket', R2_SECRET_ACCESS_KEY: 'secret' }

  // 造三平台产物:官方/beta 留 artifact,品牌渠道必须被中转走并从暂存目录删除。
  for (const id of ['official', 'beta', 'example-brand']) {
    mkdirSync(join(stage, id), { recursive: true })
    writeFileSync(join(stage, id, `App-${id}.AppImage`), 'x')
  }
  const pushed = transfer('push', ['--stage', stage], r2)
  check(pushed.status === 0, `品牌渠道中转 push 应成功,实际退出 ${String(pushed.status)}`)
  check(existsSync(join(stage, 'official')), '官方产物必须留在公开 artifact 暂存目录里')
  check(existsSync(join(stage, 'beta')), 'beta 产物必须留在公开 artifact 暂存目录里')
  check(!existsSync(join(stage, 'example-brand')), '品牌渠道产物必须从公开 artifact 暂存目录里删除')

  const transferLog = readFileSync(log, 'utf8')
  check((transferLog.match(/recursive=1/g) ?? []).length === 1, '只应中转品牌渠道(官方/beta 不上传)')
  // S3 路径形态(2026-09-10 教训):s3 侧必须是**标准前缀**(尾斜杠),
  // 不能写成 `prefix/.` —— 真实 aws CLI 当字面前缀处理,匹配不到任何对象,
  // 而桩会"好心"修正它,于是本地全绿、正式发布时才炸。这里把形态钉死。
  const pushCp = transferLog.split('\n').find(line => line.startsWith('cp ')) ?? ''
  check(/^cp \S+ s3:\/\/\S+\/ch-3\/ recursive=1$/u.test(pushCp), `中转上传应是"目录源 → 前缀/"形态,实际:${pushCp}`)
  check(!transferLog.includes('/.'), '中转命令里不得出现 prefix/. 形态(真实 CLI 匹配不到对象)')
  const keys = readdirSync(join(store, '_transfer')).sort()
  check(keys.length === 1 && !keys[0].includes('example-brand'), '中转前缀不得含渠道 id')
  check(keys[0].startsWith('4242-1-'), '中转前缀应按 run 派生')
  const token = keys[0].replace(/^4242-1-/, '')
  check(token.length === 16 && /^[0-9a-f]{16}$/u.test(token), '前缀 token 应是 HMAC 派生(不可猜测)')
  check(
    existsSync(join(store, '_transfer', keys[0], 'ch-3', 'App-example-brand.AppImage')),
    '品牌渠道产物应落在 ch-<index> 目录(索引与渠道列表行号一致)',
  )

  // 公开日志(剔除 ::add-mask:: 指令行)里不得出现渠道名。
  const pushLines = `${pushed.stdout ?? ''}${pushed.stderr ?? ''}`
    .split('\n')
    .filter(line => !line.startsWith('::add-mask::'))
    .join('\n')
  check(!pushLines.includes('example-brand'), '中转的公开日志里不得出现渠道名')

  // 缺 R2 凭据 + 存在品牌渠道 → 必须失败(静默跳过 = 品牌渠道零交付)
  const noCreds = transfer('push', ['--stage', stage], { R2_ACCOUNT_ID: '', R2_BUCKET: '', R2_SECRET_ACCESS_KEY: '' })
  check(noCreds.status !== 0, '存在品牌渠道却没有 R2 凭据时必须失败')
  check((noCreds.stderr ?? '').includes('_transfer') || (noCreds.stderr ?? '').includes('不经过公开 artifact'),
    '失败信息应说明品牌渠道不经公开 artifact')

  // 只有公开渠道时不依赖 R2
  const publicOnly = join(work, 'public.list')
  writeFileSync(publicOnly, 'official\nbeta\n')
  const publicRun = spawnSync('bash', [transferScript, 'push', '--list', publicOnly, '--stage', stage], {
    cwd: work,
    encoding: 'utf8',
    env: { PATH: `${work}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '' },
  })
  check(publicRun.status === 0, '只有官方/beta 时不应要求 R2 凭据')

  // pull:release job 取回自己的品牌产物
  const pulled = transfer('pull', ['--to', out], r2)
  check(pulled.status === 0, `品牌渠道中转 pull 应成功,实际退出 ${String(pulled.status)}`)
  check(existsSync(join(out, 'example-brand', 'App-example-brand.AppImage')), 'pull 应把品牌产物还原到 release-artifacts/<channel>/')

  // clean:取回后立即销毁中转对象
  const cleaned = transfer('clean', [], r2)
  check(cleaned.status === 0, 'clean 应成功')
  check(!existsSync(join(store, '_transfer', keys[0], 'ch-3')), 'clean 必须删掉中转对象')
}

// ---- 8. 敏感路径不得入库(忽略规则是唯一防线,补一条硬守卫) ----
{
  const tracked = execFileSync('git', ['ls-files', '--full-name'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  for (const prefix of [
    'channels.list',
    'channels/',
    'channels-context/',
    'client-assets/',
    'release-artifacts/',
    'release-bundle/',
    'image.tar',
    'packages/host/desktop/build/channel.json',
    'packages/host/desktop/build/channel-electron-builder.cjs',
    'packages/host/desktop/e2e-results/',
  ]) {
    check(
      !tracked.some(file => (file === prefix || file.startsWith(prefix))
        && file !== 'channels/README.md'),
      `${prefix} 不得被 git 跟踪(渠道内容/打包产物只应留在本地,或经 R2 私密中转)`,
    )
  }
}

// ---- 9. 镜像装配:Linux 只放 AppImage、镜像双 tag、清单与产物中性 ----
{
  const work = tempDir('ci-images-')
  const list = join(work, 'channels.list')
  const artifacts = join(work, 'release-artifacts')
  const out = join(work, 'release-bundle')
  const log = join(work, 'docker.log')
  writeFileSync(log, '')
  writeFileSync(list, 'official\nbeta\n')
  for (const id of ['official', 'beta']) {
    mkdirSync(join(work, 'channels', id), { recursive: true })
    writeFileSync(join(work, 'channels', id, 'channel.json'), JSON.stringify({
      schema: 1, channel_id: id, identity: { display_name: `${id} AI`, short_name: id },
    }))
    // 三平台安装包:Linux 侧刻意同时给 AppImage 与 deb(镜像只该带走前者)
    mkdirSync(join(artifacts, id), { recursive: true })
    for (const name of ['App.AppImage', 'App.deb', 'App.dmg', 'App.exe']) {
      writeFileSync(join(artifacts, id, name), 'x')
    }
  }
  // 假 docker:只记录调用并按需造出 image.tar(镜像装配逻辑与 tag 形态是断言对象)
  const fakeDocker = join(work, 'docker')
  writeFileSync(fakeDocker, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${log}"
case "\${1:-}" in
  buildx) exit 0 ;;
  tag) exit 0 ;;
  save)
    prev=""
    for a in "$@"; do
      if [ "$prev" = "-o" ]; then : > "$a"; fi
      prev="$a"
    done
    exit 0 ;;
  run) exit 0 ;;
esac
exit 0
`)
  execFileSync('chmod', ['+x', fakeDocker])

  const run = spawnSync('bash', [
    imagesScript, '--list', list, '--artifacts', artifacts, '--out', out,
  ], {
    cwd: work,
    encoding: 'utf8',
    env: {
      PATH: `${work}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? '',
      CI_IMAGE_BUILD_ROOT: work,
      VERSION: 'v9.9.9',
    },
  })
  check(run.status === 0, `镜像装配应成功,实际退出 ${String(run.status)}: ${(run.stderr ?? '').slice(0, 300)}`)

  const clientDir = join(work, 'client-assets', 'client')
  check(existsSync(join(clientDir, 'App.AppImage')), '镜像应带 Linux AppImage')
  check(!existsSync(join(clientDir, 'App.deb')), 'Linux deb 不得进镜像(已定案:镜像只放 AppImage)')
  const manifest = JSON.parse(readFileSync(join(work, 'client-assets', 'CLIENT-RELEASE.json'), 'utf8'))
  check(manifest.client.assets['linux-x64'].file.endsWith('.AppImage'), '清单 linux-x64 必须指向 AppImage')
  check(!JSON.stringify(manifest).includes('.deb'), '清单里不得出现 deb')
  check(manifest.channel_id === 'beta' || manifest.channel_id === 'official', '清单须声明本渠道')

  const dockerLog = readFileSync(log, 'utf8')
  check(
    dockerLog.includes('tag picoaide-harness-server:v9.9.9 picoaide-harness-server:9.9.9'),
    '镜像必须同时带 vX.Y.Z 与 X.Y.Z 两个 tag(部署文档与 latest.json 用的形式不同)',
  )
  check(
    /save .*picoaide-harness-server:v9\.9\.9 .*picoaide-harness-server:9\.9\.9/u.test(dockerLog),
    'docker save 必须带上两个 tag(否则 docker load 后少一个)',
  )
  check(existsSync(join(out, 'official', 'picoaide-server-9.9.9-amd64.zip')), '产物名应中性(不含渠道 id)')
}

for (const dir of scratch) rmSync(dir, { recursive: true, force: true })

if (failures.length > 0) {
  process.stderr.write(`\nverify-ci-scripts: ${failures.length} 项断言失败\n`)
  process.exit(1)
}
process.stdout.write('verify-ci-scripts: OK — 渠道发现/掩码(取值不回显)/策略/品牌必填/日志抑制/白标门禁/产物归集/镜像装配(无 deb+双 tag)/R2 中转/R2 发布全部符合预期\n')
