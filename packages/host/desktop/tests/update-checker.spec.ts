import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_RELEASES_LIST_ENDPOINT,
  DESKTOP_VERSION_ENDPOINT,
  MAX_VERSION_RESPONSE_BYTES,
  checkForChannelUpdate,
  checkForStableUpdate,
  checkForTestChannelUpdate,
  compareSemVerVersions,
  parseSemVer,
  type UpdateRequest,
} from '../src/update-checker.ts'

function releaseResponse(tagName: unknown, init: ResponseInit = {}): Response {
  return Response.json({ tag_name: tagName, draft: false, prerelease: false }, init)
}

function releaseListResponse(
  entries: ReadonlyArray<{ readonly tag: string; readonly draft?: boolean }>,
): Response {
  return Response.json(entries.map(entry => ({
    tag_name: entry.tag,
    draft: entry.draft === true,
    prerelease: entry.tag.includes('-'),
  })))
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

describe('public Desktop version check', () => {
  it('uses only the fixed GitHub Releases endpoint and reports a newer stable version', async () => {
    const controller = new AbortController()
    const calls: Array<{ url: string, init: RequestInit }> = []
    const request: UpdateRequest = async (url, init) => {
      calls.push({ url, init })
      return releaseResponse('v2.10.0')
    }

    await expect(checkForStableUpdate({
      currentVersion: '2.9.9',
      signal: controller.signal,
      request,
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.9.9',
      latestVersion: '2.10.0',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(DESKTOP_VERSION_ENDPOINT)
    expect(calls[0]?.url).not.toContain('/api/downloads/')
    expect(calls[0]?.init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    })
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.has('if-none-match')).toBe(false)
    expect(headers.has('x-github-api-version')).toBe(false)
  })

  it.each([
    ['2.0.0', '2.0.0'],
    ['2.0.1', '2.0.0'],
    ['2.0.0+installed', '2.0.0+release'],
  ])('reports no update for installed %s and service %s', async (currentVersion, latestVersion) => {
    await expect(checkForStableUpdate({
      currentVersion,
      request: async () => releaseResponse(`v${latestVersion}`),
    })).resolves.toEqual({
      status: 'up-to-date',
      currentVersion,
      latestVersion,
    })
  })

  it('compares service versions without overflowing JavaScript numbers', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '9007199254740992.0.0',
      request: async () => releaseResponse('v10000000000000000.0.0'),
    })).resolves.toMatchObject({ status: 'update-available' })
  })

  it.each([
    ['prerelease tag', { tag_name: 'v2.1.0-rc.1' }],
    ['invalid SemVer tag', { tag_name: 'v2.01.0' }],
    ['missing tag_name', {}],
    ['non-string tag_name', { tag_name: 2 }],
    ['array response', ['2.1.0']],
  ])('silently ignores a release response with %s', async (_case, value) => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => Response.json(value),
    })).resolves.toBeNull()
  })

  it('accepts a v-prefixed stable tag as the latest version', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => releaseResponse('v2.1.0'),
    })).resolves.toMatchObject({ status: 'update-available', latestVersion: '2.1.0' })
  })

  it('silently ignores malformed JSON and non-200 statuses', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('{'),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('unavailable', { status: 503 }),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response(null, { status: 304 }),
    })).resolves.toBeNull()
  })

  it('silently ignores network failure and caller cancellation', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => { throw new TypeError('offline') },
    })).resolves.toBeNull()

    const controller = new AbortController()
    controller.abort()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      signal: controller.signal,
      request: async () => { throw new DOMException('cancelled', 'AbortError') },
    })).resolves.toBeNull()
  })

  it('silently ignores declared and streamed oversized responses', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('{}', {
        headers: { 'content-length': String(MAX_VERSION_RESPONSE_BYTES + 1) },
      }),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('x'.repeat(MAX_VERSION_RESPONSE_BYTES + 1)),
    })).resolves.toBeNull()
  })

  it.each(['2.0', 'v2.0.0', '2.0.0-rc.1'])('skips invalid installed version %s before requesting', async currentVersion => {
    const request = vi.fn(async () => releaseResponse('v2.1.0'))

    await expect(checkForStableUpdate({ currentVersion, request })).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
})


describe('release-list test channel check', () => {
  it('picks the SemVer-maximum published release for an installed prerelease', async () => {
    const calls: string[] = []
    const request: UpdateRequest = async (url) => {
      calls.push(String(url))
      return releaseListResponse([
        { tag: 'v2.7.0-rc.2' },
        { tag: 'v2.7.0-rc.1' },
        { tag: 'v2.6.6' },
      ])
    }

    await expect(checkForTestChannelUpdate({
      currentVersion: '2.7.0-rc.1',
      request,
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.7.0-rc.1',
      latestVersion: '2.7.0-rc.2',
    })
    expect(calls).toEqual([DESKTOP_RELEASES_LIST_ENDPOINT])
  })

  it('offers a stable release once it outranks every published prerelease', async () => {
    await expect(checkForTestChannelUpdate({
      currentVersion: '2.7.0-rc.2',
      request: async () => releaseListResponse([
        { tag: 'v2.7.0' },
        { tag: 'v2.7.0-rc.1' },
      ]),
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.7.0-rc.2',
      latestVersion: '2.7.0',
    })
  })

  it('reports up-to-date while the newest release is the installed prerelease', async () => {
    await expect(checkForTestChannelUpdate({
      currentVersion: '2.7.0-rc.2',
      request: async () => releaseListResponse([
        { tag: 'v2.7.0-rc.2' },
        { tag: 'v2.6.6' },
      ]),
    })).resolves.toEqual({
      status: 'up-to-date',
      currentVersion: '2.7.0-rc.2',
      latestVersion: '2.7.0-rc.2',
    })
  })

  it('ignores drafts, duplicate tags, and malformed entries in the list', async () => {
    const request: UpdateRequest = async () => releaseListResponse([
      { tag: 'v2.7.0-rc.2', draft: true },
      { tag: 'v2.7.0-rc.1' },
      { tag: 'v2.7.0-rc.1' },
      { tag: 'not-a-version' },
    ])
    // The draft rc.2 and the duplicate rc.1 never count: rc.1 stays newest.
    await expect(checkForTestChannelUpdate({
      currentVersion: '2.7.0-rc.1',
      request,
    })).resolves.toMatchObject({ status: 'up-to-date', latestVersion: '2.7.0-rc.1' })
  })

  it.each([
    ['a non-array body', Response.json({ tag_name: 'v2.8.0-rc.1' })],
    ['non-200 status', new Response('', { status: 500 })],
  ])('silently ignores %s from the release list endpoint', async (_case, response) => {
    await expect(checkForTestChannelUpdate({
      currentVersion: '2.7.0-rc.1',
      request: async () => response,
    })).resolves.toBeNull()
  })

  it('requires the installed version itself to be a prerelease', async () => {
    await expect(checkForTestChannelUpdate({
      currentVersion: '2.7.0',
      request: async () => releaseListResponse([{ tag: 'v2.7.1' }]),
    })).resolves.toBeNull()
  })
})

describe('channel dispatch by installed version', () => {
  it('routes stable installs to the latest-stable endpoint', async () => {
    const calls: string[] = []
    const request: UpdateRequest = async (url) => {
      calls.push(String(url))
      return url === DESKTOP_VERSION_ENDPOINT
        ? releaseResponse('v2.10.0')
        : releaseListResponse([{ tag: 'v2.10.1' }])
    }

    await expect(checkForChannelUpdate({
      currentVersion: '2.9.9',
      request,
    })).resolves.toMatchObject({ status: 'update-available', latestVersion: '2.10.0' })
    expect(calls).toEqual([DESKTOP_VERSION_ENDPOINT])
  })

  it('routes prerelease installs to the release-list endpoint', async () => {
    const calls: string[] = []
    const request: UpdateRequest = async (url) => {
      calls.push(String(url))
      return url === DESKTOP_VERSION_ENDPOINT
        ? releaseResponse('v2.10.0')
        : releaseListResponse([{ tag: 'v2.10.0-rc.2' }])
    }

    await expect(checkForChannelUpdate({
      currentVersion: '2.10.0-rc.1',
      request,
    })).resolves.toMatchObject({ status: 'update-available', latestVersion: '2.10.0-rc.2' })
    expect(calls).toEqual([DESKTOP_RELEASES_LIST_ENDPOINT])
  })

  it('silently ignores malformed installed versions', async () => {
    await expect(checkForChannelUpdate({
      currentVersion: 'v2.0.0',
      request: async () => releaseResponse('v2.1.0'),
    })).resolves.toBeNull()
  })
})
