/**
 * 客户端持有性证明 A′ 的判据（§23.1）。变异验证：把 `invalidate()` 改成 no-op ⇒
 * "401 后重签"用例必红；把 `loadKey` 的自洽校验去掉 ⇒ 损坏密钥用例必红。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APP_PROOF_HEADER,
  APP_PROOF_PATH,
  INSTALL_KEY_FILE,
  createAppProofProvider,
  createInstallKeyStore,
  generateInstallKey,
  isSelfConsistent,
  parseProofResponse,
  publicKeyOf,
  signInstallPayload,
  type InstallKeyStore,
  type SafeStorageLike,
  type StoredInstallKey,
} from './app-proof.ts'

const temporaryDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wasm-app-proof-'))
  temporaryDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})

/** 内存密钥仓库（单测用）。 */
function memoryStore(initial: StoredInstallKey | null = null): InstallKeyStore & { saved: StoredInstallKey[] } {
  const saved: StoredInstallKey[] = []
  let current = initial
  return {
    saved,
    async load() { return current },
    async save(key) { current = key; saved.push(key) },
  }
}

/** safeStorage 替身（"加密"就是加个前缀，够验证往返与分支）。 */
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: plain => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: encrypted => Buffer.from(encrypted).toString('utf8').replace(/^enc:/u, ''),
  }
}

describe('install key (Ed25519, §23.1)', () => {
  it('generates a self-consistent pair and signs only the frozen payload', () => {
    const key = generateInstallKey()
    expect(isSelfConsistent(key)).toBe(true)
    expect(publicKeyOf(key.privateKeyPem)).toBe(key.publicKey)
    const signature = signInstallPayload(key.privateKeyPem, {
      nonce: 'n1',
      ts: 1_700_000_000_000,
      serverURL: 'https://harness.example.com',
      installId: key.installId,
    })
    // 规范化 JSON 是跨端契约：键按字典序（install_id, nonce, server_url, ts）。
    const canonical = JSON.stringify({
      install_id: key.installId,
      nonce: 'n1',
      server_url: 'https://harness.example.com',
      ts: 1_700_000_000_000,
    })
    expect(JSON.stringify(JSON.parse(canonical))).toBe(canonical)
    expect(signature).toMatch(/^[A-Za-z0-9+/]+=*$/u)
    // 换一个 nonce 必须得到不同签名（防"签名与载荷不一致"这类实现错误）。
    const other = signInstallPayload(key.privateKeyPem, {
      nonce: 'n2', ts: 1_700_000_000_000, serverURL: 'https://harness.example.com', installId: key.installId,
    })
    expect(other).not.toBe(signature)
  })

  it('detects a tampered key file (public key mismatch)', () => {
    const key = generateInstallKey()
    expect(isSelfConsistent({ privateKeyPem: key.privateKeyPem, publicKey: 'AAAA' })).toBe(false)
    expect(isSelfConsistent({ privateKeyPem: 'not a key', publicKey: key.publicKey })).toBe(false)
  })

  it('round-trips through safeStorage (encrypted at rest) and falls back to a 0600 file', async () => {
    const dir = await tempDir()
    const store = createInstallKeyStore({ dir, safeStorage: fakeSafeStorage(true) })
    const key = generateInstallKey()
    await store.save({ ...key, encrypted: true })
    const raw = JSON.parse(await readFile(join(dir, INSTALL_KEY_FILE), 'utf8')) as Record<string, unknown>
    expect(raw.encrypted).toBe(true)
    expect(String(raw.private_key).startsWith('-----BEGIN')).toBe(false)
    const loaded = await store.load()
    expect(loaded?.installId).toBe(key.installId)
    expect(loaded?.privateKeyPem).toBe(key.privateKeyPem)

    // 无钥匙串：明文 0600 + 明确记一条 warn（认账 §17），绝不静默。
    const warn = vi.fn()
    const plainDir = await tempDir()
    const plainStore = createInstallKeyStore({ dir: plainDir, safeStorage: fakeSafeStorage(false), warn })
    await plainStore.save({ ...key, encrypted: false })
    expect((await plainStore.load())?.privateKeyPem).toBe(key.privateKeyPem)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('keyring'))
  })

  it('treats a corrupted or unreadable key file as "no key" instead of throwing', async () => {
    const dir = await tempDir()
    const store = createInstallKeyStore({ dir, safeStorage: fakeSafeStorage(true) })
    await writeFile(join(dir, INSTALL_KEY_FILE), '{ not json', { mode: 0o600 })
    expect(await store.load()).toBeNull()
    await writeFile(join(dir, INSTALL_KEY_FILE), JSON.stringify({ version: 99 }), { mode: 0o600 })
    expect(await store.load()).toBeNull()
  })
})

describe('app proof provider (lazy issuance, in-memory only)', () => {
  const session = { token: 'tok-1', serverURL: 'https://harness.example.com' }

  it('issues lazily on first use — not on a "login event" (§23.1 R2S-4)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ proof: 'p1', expires_at: Math.floor(Date.now() / 1000) + 900 }), { status: 200 }))
    const provider = createAppProofProvider({
      store: memoryStore(),
      fetch: fetchMock as unknown as (url: string, init: RequestInit) => Promise<Response>,
      session: () => session,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await provider.get()).toBe('p1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${session.serverURL}${APP_PROOF_PATH}`)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
  })

  it('caches the proof and re-issues only when forced (401 re-sign path)', async () => {
    let counter = 0
    const fetchMock = vi.fn(async () => {
      counter += 1
      return new Response(JSON.stringify({ proof: `p${String(counter)}`, expires_at: Math.floor(Date.now() / 1000) + 900 }), { status: 200 })
    })
    const provider = createAppProofProvider({
      store: memoryStore(),
      fetch: fetchMock as unknown as (url: string, init: RequestInit) => Promise<Response>,
      session: () => session,
    })
    expect(await provider.get()).toBe('p1')
    expect(await provider.get()).toBe('p1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await provider.get(true)).toBe('p2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    provider.invalidate()
    expect(await provider.get()).toBe('p3')
  })

  it('re-issues when the account or the server changes (切换必清, §23.1)', async () => {
    let current = session
    let counter = 0
    const fetchMock = vi.fn(async () => {
      counter += 1
      return new Response(JSON.stringify({ proof: `p${String(counter)}`, expires_at: Math.floor(Date.now() / 1000) + 900 }), { status: 200 })
    })
    const provider = createAppProofProvider({
      store: memoryStore(),
      fetch: fetchMock as unknown as (url: string, init: RequestInit) => Promise<Response>,
      session: () => current,
    })
    expect(await provider.get()).toBe('p1')
    current = { token: 'tok-2', serverURL: session.serverURL }
    expect(await provider.get()).toBe('p2')
    current = { token: 'tok-2', serverURL: 'https://other.example.com' }
    expect(await provider.get()).toBe('p3')
  })

  it('returns null (never throws) when not signed in or when issuance fails', async () => {
    const signedOut = createAppProofProvider({
      store: memoryStore(),
      fetch: (async () => new Response('{}', { status: 200 })) as unknown as (url: string, init: RequestInit) => Promise<Response>,
      session: () => null,
    })
    expect(await signedOut.get()).toBeNull()

    const warn = vi.fn()
    const failing = createAppProofProvider({
      store: memoryStore(),
      fetch: (async () => { throw new Error('network down') }) as unknown as (url: string, init: RequestInit) => Promise<Response>,
      session: () => session,
      warn,
    })
    expect(await failing.get()).toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it('single-flights concurrent issuance (sub-resources ask at once)', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetchMock = vi.fn(async () => {
      await gate
      return new Response(JSON.stringify({ proof: 'p1', expires_at: Math.floor(Date.now() / 1000) + 900 }), { status: 200 })
    })
    const provider = createAppProofProvider({
      store: memoryStore(),
      fetch: fetchMock as unknown as (url: string, init: RequestInit) => Promise<Response>,
      session: () => session,
    })
    const pending = [provider.get(), provider.get(), provider.get()]
    release?.()
    expect(await Promise.all(pending)).toEqual(['p1', 'p1', 'p1'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a readable self-check failure instead of silently degrading (§23.1 自检)', async () => {
    const ok = createAppProofProvider({
      store: memoryStore(),
      fetch: (async () => new Response('{}', { status: 200 })) as unknown as (url: string, init: RequestInit) => Promise<Response>,
      session: () => session,
    })
    expect(await ok.selfCheck()).toEqual({ ok: true })

    const broken: InstallKeyStore = {
      load: async () => null,
      save: async () => { throw new Error('EROFS: read-only file system') },
    }
    const failing = createAppProofProvider({
      store: broken,
      fetch: (async () => new Response('{}', { status: 200 })) as unknown as (url: string, init: RequestInit) => Promise<Response>,
      session: () => session,
    })
    const check = await failing.selfCheck()
    expect(check.ok).toBe(false)
    if (!check.ok) expect(check.reason).toContain('EROFS')
  })

  it('parses expires_at in seconds, milliseconds and ISO form', () => {
    const now = 1_700_000_000_000
    expect(parseProofResponse({ proof: 'x', expires_at: 1_700_000_900 }, now)?.expiresAt).toBe(1_700_000_900_000)
    expect(parseProofResponse({ proof: 'x', expires_at: 1_700_000_900_000 }, now)?.expiresAt).toBe(1_700_000_900_000)
    expect(parseProofResponse({ proof: 'x', expires_at: '2023-11-14T22:28:20.000Z' }, now)?.expiresAt).toBe(1_700_000_900_000)
    expect(parseProofResponse({ proof: 'x' }, now)?.expiresAt).toBe(now + 15 * 60_000)
    expect(parseProofResponse({ expires_at: 1 }, now)).toBeNull()
    expect(parseProofResponse(null, now)).toBeNull()
  })

  it('keeps the frozen header name (cross-package contract)', () => {
    expect(APP_PROOF_HEADER).toBe('X-Pico-App-Proof')
    expect(APP_PROOF_PATH).toBe('/api/client/v2/apps/wasm/proof')
  })
})
