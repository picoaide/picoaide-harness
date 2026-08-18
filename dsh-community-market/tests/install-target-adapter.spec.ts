import { describe, expect, it, vi } from 'vitest'
import {
  DSH_1024STORE_ADAPTER_ID,
  DSH_1024STORE_KEY,
  DSH_1024STORE_PROVIDER_ID,
  dsh1024StoreAdapter,
} from '../src/adapters/dsh-1024store.js'
import type { CatalogHttpClient, LocalSourceRecord } from '../src/contracts/index.js'

const source: LocalSourceRecord = {
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002',
  registrationKind: 'built-in',
  adapterId: DSH_1024STORE_ADAPTER_ID,
  providerId: DSH_1024STORE_PROVIDER_ID,
  builtInProviderKey: DSH_1024STORE_KEY,
  enabled: true,
  order: 0,
}

const baseItem = {
  id: 'omdsh-dev/DSH-better-sidebar',
  name: 'DSH Better Sidebar',
  owner: 'omdsh-dev',
  url: 'https://github.com/omdsh-dev/DSH-better-sidebar',
  category: 'ui',
  description: { en: 'A better sidebar.' },
}

async function adapt(installMethods: readonly unknown[]) {
  const http: CatalogHttpClient = {
    getJson: vi.fn(async () => ({
      value: {
        meta: { revision: 'sha256:fixture' },
        packages: [{ ...baseItem, installMethods }],
      },
      finalUrl: 'https://deepseek1024.com/api/v1/plugins',
    })),
  }
  return await dsh1024StoreAdapter.fetch({}, {
    source,
    signal: new AbortController().signal,
    http,
    media: { register: () => 'mktimg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
  })
}

describe('1024Store install target normalization', () => {
  it('projects one reviewed exact npm target without exposing the provider command', async () => {
    const snapshot = await adapt([{
      kind: 'npm',
      spec: 'dsh-better-sidebar',
      command: 'dsh plugin --profile web add attacker-controlled-text',
      verification: 'verified',
      code: 'repository_backlink',
      requiresBuildAllowance: false,
      revision: '0.12.3',
    }])

    expect(snapshot.items[0]).toMatchObject({
      latestVersion: '0.12.3',
      package: { registry: 'npm', name: 'dsh-better-sidebar' },
    })
    expect(JSON.stringify(snapshot)).not.toContain('attacker-controlled-text')
  })

  it.each([
    ['unverified', { verification: 'unverified' }],
    ['wrong verification code', { code: 'unlinked_package' }],
    ['build allowance required', { requiresBuildAllowance: true }],
    ['mutable GitHub target', { kind: 'github', spec: 'github:omdsh-dev/DSH-better-sidebar', revision: null }],
    ['prerelease version', { revision: '0.13.0-rc.1' }],
    ['tag instead of version', { revision: 'latest' }],
  ] as const)('does not expose an install identity for a %s method', async (_label, overrides) => {
    const snapshot = await adapt([{
      kind: 'npm',
      spec: 'dsh-better-sidebar',
      verification: 'verified',
      code: 'repository_backlink',
      requiresBuildAllowance: false,
      revision: '0.12.3',
      ...overrides,
    }])

    expect(snapshot.items[0]).not.toHaveProperty('package')
    expect(snapshot.items[0]).not.toHaveProperty('latestVersion')
  })

  it('rejects ambiguous reviewed npm targets instead of choosing one', async () => {
    const snapshot = await adapt([
      {
        kind: 'npm',
        spec: 'dsh-better-sidebar',
        verification: 'verified',
        code: 'repository_backlink',
        requiresBuildAllowance: false,
        revision: '0.12.3',
      },
      {
        kind: 'npm',
        spec: 'another-package',
        verification: 'verified',
        code: 'repository_backlink',
        requiresBuildAllowance: false,
        revision: '1.0.0',
      },
    ])

    expect(snapshot.items[0]).not.toHaveProperty('package')
    expect(snapshot.items[0]).not.toHaveProperty('latestVersion')
  })
})
