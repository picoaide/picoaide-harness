import { describe, expect, it, vi } from 'vitest'
import {
  BETA_CHANNEL,
  CHANNEL_ID_PATTERN,
  DESKTOP_UPDATE_BASE_URL,
  OFFICIAL_CHANNEL,
  channelBaseURL,
  parseReleaseManifest,
  releaseAssetFor,
  updateManifestURL,
  type DesktopReleaseManifest,
} from '../src/desktop-release.ts'
import {
  MAX_VERSION_RESPONSE_BYTES,
  checkForUpdate,
  compareSemVerVersions,
  fetchReleaseManifest,
  parseSemVer,
  type UpdateRequest,
} from '../src/update-checker.ts'

// 测试统一用官方渠道;渠道隔离本身由桌面 src 与服务端 updatecheck 单测覆盖
const CHANNEL = 'official'


const RELEASE_SHA256 = 'a'.repeat(64)

/** 官方渠道清单里的三平台安装包(地址与哈希都是合法形态)。 */
function platformAssets(version: string): Record<string, { url: string, sha256: string, size: number }> {
  const releases = `${DESKTOP_UPDATE_BASE_URL}/releases/${version}`
  return {
    'mac-universal': {
      url: `${releases}/PicoAide-Harness-${version}-mac.dmg`,
      sha256: RELEASE_SHA256,
      size: 12_345,
    },
    'win-x64': {
      url: `${releases}/PicoAide-Harness-${version}-x64-Setup.exe`,
      sha256: RELEASE_SHA256,
      size: 0,
    },
    'linux-x64': {
      url: `${releases}/PicoAide-Harness-${version}-x86_64.AppImage`,
      sha256: RELEASE_SHA256,
      size: 0,
    },
  }
}

/** 完整清单对象(未序列化),供成功路径与拒绝路径共用。 */
function manifestValue(version: string): unknown {
  return {
    schema: 1,
    channel_id: 'official',
    server: { version, image_tag: `v${version}` },
    client: { version, assets: platformAssets(version) },
  }
}

function manifestResponse(version: string): Response {
  return Response.json(manifestValue(version))
}

/** 解析成功后的清单;拒绝路径返回 null 时在这里立刻失败,避免非空断言。 */
function requireManifest(value: DesktopReleaseManifest | null): DesktopReleaseManifest {
  if (value === null) throw new Error('Expected the release manifest to parse.')
  return value
}

describe('strict SemVer parsing', () => {
  it('accepts a three-part version, optional lowercase v, prerelease, and build metadata', () => {
    expect(parseSemVer('v2.10.3-alpha.1+mac.arm64')).toEqual({
      version: '2.10.3-alpha.1+mac.arm64',
      major: '2',
      minor: '10',
      patch: '3',
      prerelease: ['alpha', '1'],
      build: ['mac', 'arm64'],
    })
    expect(parseSemVer('0.0.0')).not.toBeNull()
  })

  it.each([
    '1',
    '1.2',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3-alpha..1',
    '1.2.3+',
    'V1.2.3',
    ' 1.2.3',
  ])('rejects invalid SemVer %s', version => {
    expect(parseSemVer(version)).toBeNull()
  })

  it('compares strict versions without numeric overflow', () => {
    expect(compareSemVerVersions('2.1.0', '2.0.9')).toBeGreaterThan(0)
    expect(compareSemVerVersions('2.0.0-rc.1', '2.0.0')).toBeLessThan(0)
    expect(compareSemVerVersions('2.0', '2.0.0')).toBeNull()
    expect(compareSemVerVersions(
      '10000000000000000.0.0',
      '9007199254740992.0.0',
    )).toBeGreaterThan(0)
  })
})

describe('release manifest parsing', () => {
  it('parses the three published platform assets from an official manifest', () => {
    expect(parseReleaseManifest(manifestValue('2.7.0'))).toEqual({
      schema: 1,
      channelId: 'official',
      clientVersion: '2.7.0',
      assets: platformAssets('2.7.0'),
    })
  })

  it('rejects a manifest without a channel id, and defaults a missing asset size', () => {
    // channel_id 缺失 = 渠道未知:绝不能当作"默认官方"放行(渠道隔离)
    expect(parseReleaseManifest({
      schema: 1,
      client: {
        version: '2.7.0',
        assets: { 'mac-universal': { url: 'https://release.picoaide.com/mac.dmg', sha256: RELEASE_SHA256 } },
      },
    })).toBeNull()

    // 带 channel_id 时,缺失 size 回落为 0
    const manifest = requireManifest(parseReleaseManifest({
      schema: 1,
      channel_id: 'official',
      client: {
        version: '2.7.0',
        assets: { 'mac-universal': { url: 'https://release.picoaide.com/mac.dmg', sha256: RELEASE_SHA256 } },
      },
    }))
    expect(manifest.channelId).toBe('official')
    expect(manifest.assets['mac-universal']).toEqual({
      url: 'https://release.picoaide.com/mac.dmg',
      sha256: RELEASE_SHA256,
      size: 0,
    })
  })

  it('maps platforms onto the manifest asset keys', () => {
    const manifest = requireManifest(parseReleaseManifest(manifestValue('2.7.0')))

    expect(releaseAssetFor(manifest, 'darwin')?.url).toBe(
      `${DESKTOP_UPDATE_BASE_URL}/releases/2.7.0/PicoAide-Harness-2.7.0-mac.dmg`,
    )
    expect(releaseAssetFor(manifest, 'win32')?.url).toContain('-x64-Setup.exe')
    expect(releaseAssetFor(manifest, 'linux')?.url).toContain('-x86_64.AppImage')
  })

  it.each([
    ['a missing schema', { client: { version: '2.7.0', assets: platformAssets('2.7.0') } }],
    ['schema 0', { ...asRecord(manifestValue('2.7.0')), schema: 0 }],
    ['schema 2', { ...asRecord(manifestValue('2.7.0')), schema: 2 }],
    ['a string schema', { ...asRecord(manifestValue('2.7.0')), schema: '1' }],
  ])('rejects a manifest with %s', (_case, value) => {
    expect(parseReleaseManifest(value)).toBeNull()
  })

  it.each([
    ['a missing client', { schema: 1, channel_id: 'official' }],
    ['an array client', { schema: 1, client: [] }],
    ['an empty client version', { schema: 1, client: { version: '', assets: platformAssets('2.7.0') } }],
    ['a numeric client version', { schema: 1, client: { version: 2.7, assets: platformAssets('2.7.0') } }],
    ['a missing assets object', { schema: 1, client: { version: '2.7.0' } }],
    ['an empty assets object', { schema: 1, client: { version: '2.7.0', assets: {} } }],
    ['an array assets object', { schema: 1, client: { version: '2.7.0', assets: [] } }],
    ['only unknown asset keys', {
      schema: 1,
      client: {
        version: '2.7.0',
        assets: { 'mac-x64': { url: 'https://release.picoaide.com/mac.dmg', sha256: RELEASE_SHA256 } },
      },
    }],
    ['a non-record asset entry', {
      schema: 1,
      client: { version: '2.7.0', assets: { 'mac-universal': 'https://release.picoaide.com/mac.dmg' } },
    }],
  ])('rejects a manifest with %s', (_case, value) => {
    expect(parseReleaseManifest(value)).toBeNull()
  })

  it.each([
    ['a plain http url', { url: 'http://release.picoaide.com/PicoAide.dmg', sha256: RELEASE_SHA256 }],
    ['a protocol-relative url', { url: '//release.picoaide.com/PicoAide.dmg', sha256: RELEASE_SHA256 }],
    ['a relative url', { url: 'releases/2.7.0/PicoAide.dmg', sha256: RELEASE_SHA256 }],
    ['a non-string url', { url: 42, sha256: RELEASE_SHA256 }],
    ['a missing url', { sha256: RELEASE_SHA256 }],
  ])('rejects an asset with %s', (_case, asset) => {
    // 清单是安全边界:拼接式下载地址一律拒绝,绝不猜测绝对地址。
    expect(parseReleaseManifest({
      schema: 1,
      client: { version: '2.7.0', assets: { 'mac-universal': asset } },
    })).toBeNull()
  })

  it.each([
    ['an uppercase digest', RELEASE_SHA256.toUpperCase()],
    ['a short digest', RELEASE_SHA256.slice(0, 63)],
    ['a long digest', `${RELEASE_SHA256}a`],
    ['a non-hex digest', 'g'.repeat(64)],
    ['a prefixed digest', `sha256:${RELEASE_SHA256}`],
    ['a missing digest', undefined],
  ])('rejects an asset with %s', (_case, sha256) => {
    expect(parseReleaseManifest({
      schema: 1,
      client: {
        version: '2.7.0',
        assets: { 'mac-universal': { url: 'https://release.picoaide.com/PicoAide.dmg', sha256 } },
      },
    })).toBeNull()
  })

  it.each([
    ['a negative size', -1],
    ['a fractional size', 1.5],
    ['a string size', '12345'],
    ['an unsafe integer size', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects an asset with %s', (_case, size) => {
    expect(parseReleaseManifest({
      schema: 1,
      client: {
        version: '2.7.0',
        assets: {
          'mac-universal': { url: 'https://release.picoaide.com/PicoAide.dmg', sha256: RELEASE_SHA256, size },
        },
      },
    })).toBeNull()
  })

  it.each([
    ['null', null],
    ['a string', '{"schema":1}'],
    ['an array', [manifestValue('2.7.0')]],
    ['a number', 1],
  ])('rejects %s as the manifest root', (_case, value) => {
    expect(parseReleaseManifest(value)).toBeNull()
  })
})

describe('public Desktop version check', () => {
  it('requests the official manifest and reports a newer client version', async () => {
    const controller = new AbortController()
    const calls: Array<{ url: string, init: RequestInit }> = []
    const request: UpdateRequest = async (url, init) => {
      calls.push({ url, init })
      return manifestResponse('2.10.0')
    }

    await expect(checkForUpdate({ channel: CHANNEL,
      currentVersion: '2.9.9',
      signal: controller.signal,
      request,
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.9.9',
      latestVersion: '2.10.0',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${DESKTOP_UPDATE_BASE_URL}/latest.json`)
    expect(calls[0]?.url).toBe('https://release.picoaide.com/official/latest.json')
    expect(calls[0]?.url).not.toContain('api.github.com')
    expect(calls[0]?.init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    })
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.has('if-none-match')).toBe(false)
  })

  it.each([
    ['https://enterprise.test/updates', 'https://enterprise.test/updates/latest.json'],
    ['https://enterprise.test/updates/', 'https://enterprise.test/updates/latest.json'],
    ['https://enterprise.test/updates///', 'https://enterprise.test/updates/latest.json'],
  ])('requests the manifest of channel base %s', async (baseURL, expectedURL) => {
    // 企业渠道只换 base,协议与文件名不变(构建期注入渠道更新面)。
    const calls: string[] = []
    const request: UpdateRequest = async (url) => {
      calls.push(String(url))
      return manifestResponse('2.1.0')
    }

    await expect(checkForUpdate({ channel: CHANNEL,
      currentVersion: '2.0.0',
      baseURL,
      request,
    })).resolves.toMatchObject({ status: 'update-available', latestVersion: '2.1.0' })
    expect(calls).toEqual([expectedURL])
  })

  it('builds the manifest URL from the shared release authority', () => {
    expect(updateManifestURL()).toBe('https://release.picoaide.com/official/latest.json')
    expect(updateManifestURL('https://enterprise.test/updates/')).toBe(
      'https://enterprise.test/updates/latest.json',
    )
  })

  it.each([
    ['2.0.0', '2.0.0'],
    ['2.0.1', '2.0.0'],
    ['2.0.0+installed', '2.0.0+release'],
  ])('reports no update for installed %s and manifest %s', async (currentVersion, latestVersion) => {
    await expect(checkForUpdate({ channel: CHANNEL,
      currentVersion,
      request: async () => manifestResponse(latestVersion),
    })).resolves.toEqual({
      status: 'up-to-date',
      currentVersion,
      latestVersion,
    })
  })

  it('compares manifest versions without overflowing JavaScript numbers', async () => {
    await expect(checkForUpdate({ channel: CHANNEL,
      currentVersion: '9007199254740992.0.0',
      request: async () => manifestResponse('10000000000000000.0.0'),
    })).resolves.toMatchObject({ status: 'update-available' })
  })

  it.each([
    ['2.7.0-rc.1', '2.7.0-rc.2', 'update-available'],
    ['2.7.0-rc.2', '2.7.0', 'update-available'],
    ['2.7.0-rc.2', '2.7.0-rc.2', 'up-to-date'],
    ['2.7.0', '2.7.0-rc.2', 'up-to-date'],
  ])('compares installed %s with manifest %s as %s', async (currentVersion, latestVersion, status) => {
    // 渠道由清单内容决定:预发布版本写进清单就是预发布渠道,客户端不再分流。
    await expect(checkForUpdate({ channel: CHANNEL,
      currentVersion,
      request: async () => manifestResponse(latestVersion),
    })).resolves.toMatchObject({ status, currentVersion, latestVersion })
  })

  it.each([
    ['a non-canonical version', '2.01.0'],
    ['a v-prefixed version', 'v2.1.0'],
    ['a non-string version', 2],
  ])('silently ignores a manifest reporting %s', async (_case, version) => {
    await expect(checkForUpdate({
      channel: CHANNEL,
      currentVersion: '2.0.0',
      request: async () => Response.json({
        schema: 1,
        channel_id: 'official',
        client: { version, assets: platformAssets('2.1.0') },
      }),
    })).resolves.toBeNull()
  })

  it.each([
    ['an unknown schema', { ...asRecord(manifestValue('2.1.0')), schema: 2 }],
    ['a plain http asset url', {
      schema: 1,
      client: {
        version: '2.1.0',
        assets: { 'mac-universal': { url: 'http://release.picoaide.com/mac.dmg', sha256: RELEASE_SHA256 } },
      },
    }],
    ['an invalid asset digest', {
      schema: 1,
      client: {
        version: '2.1.0',
        assets: { 'mac-universal': { url: 'https://release.picoaide.com/mac.dmg', sha256: 'nope' } },
      },
    }],
  ])('silently ignores a manifest with %s', async (_case, value) => {
    await expect(checkForUpdate({ channel: CHANNEL,
      currentVersion: '2.0.0',
      request: async () => Response.json(value),
    })).resolves.toBeNull()
  })

  it('silently ignores 404, non-JSON bodies, and non-200 statuses', async () => {
    await expect(checkForUpdate({ channel: CHANNEL,
      currentVersion: '2.0.0',
      request: async () => new Response('not found', { status: 404 }),
    })).resolves.toBeNull()
    await expect(checkForUpdate({ channel: CHANNEL,
      currentVersion: '2.0.0',
      request: async () => new Response('{'),
    })).resolves.toBeNull()
    await expect(checkForUpdate({ channel: CHANNEL,
      currentVersion: '2.0.0',
      request: async () => new Response('<html>maintenance</html>', {
        headers: { 'content-type': 'text/html' },
      }),
    })).resolves.toBeNull()
    await expect(checkForUpdate({ channel: CHANNEL,
      currentVersion: '2.0.0',
      request: async () => new Response('unavailable', { status: 503 }),
    })).resolves.toBeNull()
    await expect(checkForUpdate({ channel: CHANNEL,
      currentVersion: '2.0.0',
      request: async () => new Response(null, { status: 304 }),
    })).resolves.toBeNull()
  })

  it('refuses to follow a manifest redirect instead of silently reporting no update', async () => {
    // `redirect: 'error'` 让跳转成为硬失败:更新服务器前面有任何跳转都必须
    // 显式暴露,而不是把"通道断了"伪装成"没有新版本"。
    const calls: Array<{ url: string, init: RequestInit }> = []
    const request: UpdateRequest = async (url, init) => {
      calls.push({ url, init })
      // fetch 在 redirect: 'error' 遇到 3xx 时以 TypeError 拒绝。
      throw new TypeError('Failed to fetch')
    }

    await expect(checkForUpdate({ channel: CHANNEL, currentVersion: '2.0.0', request })).resolves.toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.init).toMatchObject({ redirect: 'error' })
  })

  it('silently ignores network failure', async () => {
    await expect(checkForUpdate({ channel: CHANNEL,
      currentVersion: '2.0.0',
      request: async () => { throw new TypeError('offline') },
    })).resolves.toBeNull()
  })

  // 取消必须向上传播,不能静默变成"无更新"或"网络错误":
  // 否则用户点了取消会看到错误提示,而调用方也无法区分取消与故障。
  it('propagates caller cancellation instead of reporting no update', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(checkForUpdate({ channel: CHANNEL,
      currentVersion: '2.0.0',
      signal: controller.signal,
      request: async () => { throw new DOMException('cancelled', 'AbortError') },
    })).rejects.toMatchObject({ name: 'AbortError' })

    // 请求进行中被取消(信号未预先 abort)同样要传播
    const live = new AbortController()
    const promise = checkForUpdate({ channel: CHANNEL,
      currentVersion: '2.0.0',
      signal: live.signal,
      request: async () => {
        live.abort()
        throw new DOMException('cancelled', 'AbortError')
      },
    })
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('silently ignores declared and streamed oversized responses', async () => {
    await expect(checkForUpdate({ channel: CHANNEL,
      currentVersion: '2.0.0',
      request: async () => new Response('{}', {
        headers: { 'content-length': String(MAX_VERSION_RESPONSE_BYTES + 1) },
      }),
    })).resolves.toBeNull()
    await expect(checkForUpdate({ channel: CHANNEL,
      currentVersion: '2.0.0',
      request: async () => new Response('x'.repeat(MAX_VERSION_RESPONSE_BYTES + 1)),
    })).resolves.toBeNull()
  })

  it.each([
    ['a two-part version', '2.0'],
    ['a v-prefixed version', 'v2.0.0'],
    ['a local build', 'dev'],
    ['an empty version', ''],
  ])(
    'skips installed %s before requesting',
    async (_case, currentVersion) => {
      // 本地构建(如 "dev")不是合法 SemVer:不提示更新,也不发请求。
      const request = vi.fn(async () => manifestResponse('2.1.0'))

      await expect(checkForUpdate({ channel: CHANNEL, currentVersion, request })).resolves.toBeNull()
      expect(request).not.toHaveBeenCalled()
    },
  )
})

describe('fetchReleaseManifest', () => {
  it('returns the parsed manifest from the channel base', async () => {
    const calls: string[] = []
    const request: UpdateRequest = async (url) => {
      calls.push(String(url))
      return manifestResponse('2.7.0')
    }

    const manifest = requireManifest(await fetchReleaseManifest({ channel: CHANNEL,
      baseURL: 'https://enterprise.test/updates',
      request,
    }))

    expect(calls).toEqual(['https://enterprise.test/updates/latest.json'])
    expect(manifest).toEqual({
      schema: 1,
      channelId: 'official',
      clientVersion: '2.7.0',
      assets: platformAssets('2.7.0'),
    })
  })

  it('returns null for unreachable, non-200, and invalid manifests', async () => {
    await expect(fetchReleaseManifest({ channel: CHANNEL, request: async () => { throw new TypeError('offline') } }))
      .resolves.toBeNull()
    await expect(fetchReleaseManifest({ channel: CHANNEL, request: async () => new Response('', { status: 500 }) }))
      .resolves.toBeNull()
    await expect(fetchReleaseManifest({ channel: CHANNEL, request: async () => Response.json({ schema: 1 }) }))
      .resolves.toBeNull()
  })

  it('passes the caller signal through to the manifest request', async () => {
    const controller = new AbortController()
    const signals: Array<AbortSignal | null | undefined> = []
    await fetchReleaseManifest({ channel: CHANNEL,
      signal: controller.signal,
      request: async (_url, init) => {
        signals.push(init.signal)
        return manifestResponse('2.7.0')
      },
    })

    expect(signals).toEqual([controller.signal])
  })
})

/** 把构造出的清单对象当作记录处理,便于在拒绝用例里覆盖单个字段。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}


// ---- 渠道隔离(2026-09-10):beta / official / 品牌三渠道互不升级 ----
//
// 混渠道的后果是最严重的一类:品牌客户端接受官方清单 → 升级后品牌被"洗掉";
// 官方客户端接受品牌清单 → 装到别人的定制版。因此清单的 channel_id 必须与
// 本安装所属渠道**精确相等**,任何缺失或不匹配都必须被拒绝。

describe('channel isolation', () => {
  it('rejects a manifest from a foreign channel', () => {
    const foreign = {
      schema: 1,
      channel_id: 'official',
      client: { version: '9.9.9', assets: { 'mac-universal': { url: 'https://release.picoaide.com/mac.dmg', sha256: RELEASE_SHA256 } } },
    }
    // 不校验渠道时结构本身是合法的
    expect(parseReleaseManifest(foreign)).not.toBeNull()
    // 品牌渠道必须拒绝官方清单
    expect(parseReleaseManifest(foreign, 'acme')).toBeNull()
    // 官方渠道也必须拒绝品牌清单(反向串渠道)
    expect(parseReleaseManifest({ ...foreign, channel_id: 'acme' }, 'official')).toBeNull()
    // 同渠道放行
    expect(parseReleaseManifest(foreign, 'official')).not.toBeNull()
  })

  it('rejects a manifest without a channel id even when no channel is expected', () => {
    expect(parseReleaseManifest({
      schema: 1,
      client: { version: '2.7.0', assets: { 'mac-universal': { url: 'https://release.picoaide.com/mac.dmg', sha256: RELEASE_SHA256 } } },
    })).toBeNull()
    expect(parseReleaseManifest({
      schema: 1,
      channel_id: '',
      client: { version: '2.7.0', assets: { 'mac-universal': { url: 'https://release.picoaide.com/mac.dmg', sha256: RELEASE_SHA256 } } },
    })).toBeNull()
  })

  it('checks the manifest of the installed channel by default', async () => {
    const calls: string[] = []
    const request: UpdateRequest = async url => {
      calls.push(url)
      return Response.json({
        schema: 1,
        channel_id: BETA_CHANNEL,
        client: { version: '2.8.0', assets: { 'mac-universal': { url: 'https://release.picoaide.com/mac.dmg', sha256: RELEASE_SHA256 } } },
      })
    }

    await expect(checkForUpdate({ channel: BETA_CHANNEL, currentVersion: '2.7.0', request }))
      .resolves.toMatchObject({ status: 'update-available', latestVersion: '2.8.0' })
    // 默认 base 由渠道推导,而不是写死官方目录
    expect(calls).toEqual([`${channelBaseURL(BETA_CHANNEL)}/latest.json`])
    expect(calls[0]).toContain('/beta/')
  })

  it('reports no update (not a cross-channel upgrade) when the manifest channel differs', async () => {
    const request: UpdateRequest = async () => Response.json({
      schema: 1,
      channel_id: OFFICIAL_CHANNEL,
      client: { version: '9.9.9', assets: { 'mac-universal': { url: 'https://release.picoaide.com/mac.dmg', sha256: RELEASE_SHA256 } } },
    })

    // 品牌构建遇到官方清单:必须"无更新",绝不提示跨渠道升级
    await expect(checkForUpdate({ channel: 'acme', currentVersion: '1.0.0', request })).resolves.toBeNull()
  })

  it('builds channel base URLs and rejects malformed channel ids', () => {
    expect(channelBaseURL()).toBe(DESKTOP_UPDATE_BASE_URL)
    expect(channelBaseURL(OFFICIAL_CHANNEL)).toBe('https://release.picoaide.com/official')
    expect(channelBaseURL(BETA_CHANNEL)).toBe('https://release.picoaide.com/beta')
    expect(channelBaseURL('acme-corp')).toBe('https://release.picoaide.com/acme-corp')
    // 非法渠道回落到官方目录,不会拼出畸形 URL
    expect(channelBaseURL('Acme!')).toBe('https://release.picoaide.com/official')
    expect(channelBaseURL('')).toBe('https://release.picoaide.com/official')

    expect(CHANNEL_ID_PATTERN.test('official')).toBe(true)
    expect(CHANNEL_ID_PATTERN.test('beta')).toBe(true)
    expect(CHANNEL_ID_PATTERN.test('acme-corp')).toBe(true)
    expect(CHANNEL_ID_PATTERN.test('Official')).toBe(false)
    expect(CHANNEL_ID_PATTERN.test('-acme')).toBe(false)
    expect(CHANNEL_ID_PATTERN.test('acme_')).toBe(false)
    expect(CHANNEL_ID_PATTERN.test('a'.repeat(33))).toBe(false)
  })
})
