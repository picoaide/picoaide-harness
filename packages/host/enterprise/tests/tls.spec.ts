import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installCertificateVerification, sha256Fingerprint } from '../src/server-connector/tls.ts'

/** Minimal Electron-session-like shim with a controllable verify proc. */
function mockSession() {
  let proc: ((request: unknown, callback: (result: number) => void) => void) | null = null
  return {
    setCertificateVerifyProc(fn: (request: unknown, callback: (result: number) => void) => void) {
      proc = fn
    },
    invoke(request: unknown, callback: (result: number) => void) {
      if (!proc) throw new Error('verify proc not installed')
      proc(request, callback)
    },
  }
}

/** DER bytes for a self-signed-looking cert (any stable buffer works for hashing). */
function fakeCert(bytes: number[] = [0x30, 0x82, 0x01, 0x03, 1, 2, 3, 4]): { data: string } {
  return { data: Buffer.from(bytes).toString('base64') }
}

function tmpStore(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pico-tls-'))
  return join(dir, 'fingerprints.json')
}

describe('installCertificateVerification (TOFU hardening, P1-3)', () => {
  it('rejects an UNKNOWN fingerprint (fail closed) and does not persist it', async () => {
    const store = tmpStore()
    const session = mockSession()
    const unknown: string[] = []
    await installCertificateVerification(store, {
      getSession: () => session,
      onUnknownFingerprint: (host, fp) => { unknown.push(`${host}:${fp.slice(0, 8)}`) },
    })
    let result: number | null = null
    session.invoke({ hostname: 'pico.example.com', port: 443, certificate: fakeCert() }, (r) => { result = r })
    expect(result).toBe(-2) // rejected
    expect(unknown.length).toBe(1) // surfaced for human approval
    // nothing persisted: a second connect is still unknown → still rejected
    let second: number | null = null
    session.invoke({ hostname: 'pico.example.com', port: 443, certificate: fakeCert() }, (r) => { second = r })
    expect(second).toBe(-2)
  })

  it('accepts a TRUSTED fingerprint', async () => {
    const store = tmpStore()
    const cert = fakeCert()
    const fp = sha256Fingerprint(Buffer.from(cert.data, 'base64'))
    // Seed the store as if previously approved.
    writeFileSync(store, JSON.stringify({ fingerprints: { 'pico.example.com:443': fp } }, null, 2), { mode: 0o600 })
    const session = mockSession()
    await installCertificateVerification(store, { getSession: () => session })
    let result: number | null = null
    session.invoke({ hostname: 'pico.example.com', port: 443, certificate: cert }, (r) => { result = r })
    expect(result).toBe(0)
  })

  it('rejects a MISMATCHED fingerprint (pinned cert changed)', async () => {
    const store = tmpStore()
    const oldFp = sha256Fingerprint(Buffer.from([1, 2, 3]))
    writeFileSync(store, JSON.stringify({ fingerprints: { 'pico.example.com:443': oldFp } }, null, 2), { mode: 0o600 })
    const session = mockSession()
    const mismatches: string[] = []
    await installCertificateVerification(store, {
      getSession: () => session,
      onMismatchFingerprint: (host) => { mismatches.push(host) },
    })
    let result: number | null = null
    // A different certificate than the pinned one.
    session.invoke({ hostname: 'pico.example.com', port: 443, certificate: fakeCert([9, 9, 9]) }, (r) => { result = r })
    expect(result).toBe(-2)
    expect(mismatches.length).toBe(1)
  })

  it('rejects when hostname or fingerprint is unavailable', async () => {
    const session = mockSession()
    await installCertificateVerification('/nonexistent/store.json', { getSession: () => session })
    let result: number | null = null
    session.invoke({ hostname: '', port: 443, certificate: fakeCert() }, (r) => { result = r })
    expect(result).toBe(-2)
  })
})
