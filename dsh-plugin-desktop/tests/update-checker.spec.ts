import { describe, expect, it } from 'vitest'
import {
  MAX_RELEASE_RESPONSE_BYTES,
  STABLE_RELEASE_ENDPOINT,
  UpdateCheckError,
  checkForStableUpdate,
  compareSemVerVersions,
  parseSemVer,
  parseStableRelease,
  type UpdateRequest,
} from '../src/update-checker.ts'

const releaseUrl = (tag: string): string =>
  `https://github.com/anywhere-labs/deepseek-harness-desktop/releases/tag/${encodeURIComponent(tag)}`

function releaseResponse(
  tag: string,
  overrides: Record<string, unknown> = {},
  headers: HeadersInit = {},
): Response {
  return Response.json({
    tag_name: tag,
    draft: false,
    prerelease: false,
    html_url: releaseUrl(tag),
    ...overrides,
  }, { headers })
}

async function expectFailure(
  promise: Promise<unknown>,
  code: UpdateCheckError['code'],
): Promise<UpdateCheckError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(UpdateCheckError)
    expect(error).toMatchObject({ code })
    return error as UpdateCheckError
  }
  throw new Error('Expected update check to fail.')
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

  it('shares strict precedence and stable release URL validation with cache consumers', () => {
    expect(compareSemVerVersions('2.1.0', '2.0.9')).toBeGreaterThan(0)
    expect(compareSemVerVersions('2.0.0-rc.1', '2.0.0')).toBeLessThan(0)
    expect(compareSemVerVersions('2.0', '2.0.0')).toBeNull()
    expect(parseStableRelease('v2.1.0', releaseUrl('v2.1.0'))).toEqual({
      tagName: 'v2.1.0',
      version: '2.1.0',
      htmlUrl: releaseUrl('v2.1.0'),
    })
    expect(parseStableRelease('v2.1.0-rc.1', releaseUrl('v2.1.0-rc.1'))).toBeNull()
    expect(parseStableRelease('v2.1.0', 'https://example.com/releases/v2.1.0')).toBeNull()
  })
})

describe('stable GitHub update check', () => {
  it('uses the fixed endpoint, conditional ETag, caller signal, and reports an update', async () => {
    const controller = new AbortController()
    const calls: Array<{ url: string; init: RequestInit }> = []
    const request: UpdateRequest = async (url, init) => {
      calls.push({ url, init })
      return releaseResponse('v2.10.0', {}, { etag: '"release-2.10.0"' })
    }

    await expect(checkForStableUpdate({
      currentVersion: '2.9.9',
      trigger: 'manual',
      etag: 'W/"previous"',
      signal: controller.signal,
      request,
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.9.9',
      release: {
        tagName: 'v2.10.0',
        version: '2.10.0',
        htmlUrl: releaseUrl('v2.10.0'),
      },
      etag: '"release-2.10.0"',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(STABLE_RELEASE_ENDPOINT)
    expect(calls[0]?.init.method).toBe('GET')
    expect(calls[0]?.init.signal).toBe(controller.signal)
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('accept')).toBe('application/vnd.github+json')
    expect(headers.get('x-github-api-version')).toBe('2022-11-28')
    expect(headers.get('if-none-match')).toBe('W/"previous"')
  })

  it.each([
    ['2.0.0', 'v2.0.0'],
    ['2.0.1', 'v2.0.0'],
    ['2.0.0+installed', 'v2.0.0+release'],
  ])('reports %s as current for latest %s', async (currentVersion, tag) => {
    await expect(checkForStableUpdate({
      currentVersion,
      trigger: 'background',
      request: async () => releaseResponse(tag),
    })).resolves.toMatchObject({
      status: 'up-to-date',
      currentVersion,
      release: { tagName: tag },
    })
  })

  it('compares versions without overflowing JavaScript numbers', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '9007199254740992.0.0',
      trigger: 'background',
      request: async () => releaseResponse('v10000000000000000.0.0'),
    })).resolves.toMatchObject({ status: 'update-available' })
  })

  it('accepts 304 without reading a body and preserves the cached ETag', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      trigger: 'background',
      etag: '"cached"',
      request: async () => new Response(null, { status: 304 }),
    })).resolves.toEqual({ status: 'not-modified', etag: '"cached"' })
  })

  it('prefers a replacement ETag on 304', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      trigger: 'background',
      etag: '"cached"',
      request: async () => new Response(null, { status: 304, headers: { etag: '"new"' } }),
    })).resolves.toEqual({ status: 'not-modified', etag: '"new"' })
  })

  it.each([
    [{ draft: true }, 'unstable-release'],
    [{ prerelease: true }, 'unstable-release'],
    [{ tag_name: 'v2.1.0-rc.1', html_url: releaseUrl('v2.1.0-rc.1') }, 'unstable-release'],
    [{ tag_name: '2.01.0', html_url: releaseUrl('2.01.0') }, 'invalid-response'],
    [{ html_url: 'https://github.com/other/project/releases/tag/v2.1.0' }, 'invalid-response'],
    [{ html_url: `${releaseUrl('v2.1.0')}/` }, 'invalid-response'],
    [{ draft: 'false' }, 'invalid-response'],
  ] as const)('rejects an invalid or unstable latest release %#', async (overrides, code) => {
    await expectFailure(checkForStableUpdate({
      currentVersion: '2.0.0',
      trigger: 'background',
      request: async () => releaseResponse('v2.1.0', overrides),
    }), code)
  })

  it('requires an exact encoded tag URL', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      trigger: 'manual',
      request: async () => releaseResponse('v2.1.0+desktop.1'),
    })).resolves.toMatchObject({
      release: { htmlUrl: releaseUrl('v2.1.0+desktop.1') },
    })
  })

  it('rejects non-200 statuses without reading their body', async () => {
    const error = await expectFailure(checkForStableUpdate({
      currentVersion: '2.0.0',
      trigger: 'manual',
      request: async () => new Response('ignored', { status: 503 }),
    }), 'http-status')

    expect(error).toMatchObject({ status: 503, trigger: 'manual', shouldNotifyUser: true })
  })

  it('enforces the declared response size limit', async () => {
    const error = await expectFailure(checkForStableUpdate({
      currentVersion: '2.0.0',
      trigger: 'background',
      request: async () => new Response('{}', {
        headers: { 'content-length': String(MAX_RELEASE_RESPONSE_BYTES + 1) },
      }),
    }), 'response-too-large')

    expect(error).toMatchObject({ trigger: 'background', shouldNotifyUser: false })
  })

  it('enforces the streamed response size limit when Content-Length is absent', async () => {
    await expectFailure(checkForStableUpdate({
      currentVersion: '2.0.0',
      trigger: 'background',
      request: async () => new Response('x'.repeat(MAX_RELEASE_RESPONSE_BYTES + 1)),
    }), 'response-too-large')
  })

  it('rejects malformed JSON and missing fixed response fields', async () => {
    await expectFailure(checkForStableUpdate({
      currentVersion: '2.0.0',
      trigger: 'manual',
      request: async () => new Response('{'),
    }), 'invalid-response')
    await expectFailure(checkForStableUpdate({
      currentVersion: '2.0.0',
      trigger: 'manual',
      request: async () => Response.json({ tag_name: 'v2.1.0' }),
    }), 'invalid-response')
  })

  it('classifies caller cancellation separately from network failure', async () => {
    const controller = new AbortController()
    controller.abort()
    const abortError = await expectFailure(checkForStableUpdate({
      currentVersion: '2.0.0',
      trigger: 'background',
      signal: controller.signal,
      request: async () => {
        throw new DOMException('cancelled', 'AbortError')
      },
    }), 'aborted')
    const networkError = await expectFailure(checkForStableUpdate({
      currentVersion: '2.0.0',
      trigger: 'manual',
      request: async () => {
        throw new TypeError('offline')
      },
    }), 'network')

    expect(abortError).toMatchObject({ trigger: 'background', shouldNotifyUser: false })
    expect(networkError).toMatchObject({ trigger: 'manual', shouldNotifyUser: true })
  })

  it('rejects an invalid installed version before making a request', async () => {
    let requested = false
    const error = await expectFailure(checkForStableUpdate({
      currentVersion: '2.0',
      trigger: 'manual',
      request: async () => {
        requested = true
        return releaseResponse('v2.1.0')
      },
    }), 'invalid-current-version')

    expect(requested).toBe(false)
    expect(error.shouldNotifyUser).toBe(true)
  })
})
