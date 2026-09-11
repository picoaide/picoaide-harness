import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPinnedFingerprintsFromEnv, installCertificateVerification, sha256Fingerprint } from '../src/server-connector/tls.ts'

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
  it('平台不信任 + 未 pin → 拒绝（= Chromium 默认语义）且不写库', async () => {
    const store = tmpStore()
    // 至少有一个 pin，钩子才会安装（无 pin 时走纯默认校验，见下一组用例）
    writeFileSync(store, JSON.stringify({ fingerprints: { 'other.example.com:443': sha256Fingerprint(Buffer.from([3, 3])) } }), { mode: 0o600 })
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
    const store = tmpStore()
    writeFileSync(store, JSON.stringify({ fingerprints: { 'pinned.example.com:443': sha256Fingerprint(Buffer.from([3, 3])) } }), { mode: 0o600 })
    const session = mockSession()
    await installCertificateVerification(store, { getSession: () => session })
    let result: number | null = null
    session.invoke({ hostname: '', port: 443, certificate: fakeCert() }, (r) => { result = r })
    expect(result).toBe(-2)
  })
})


describe('无 pin 时不干预 TLS（2026-09-11 定案：默认校验优先）', () => {
  it('指纹库为空时完全不安装校验钩子（保持 Electron 默认行为）', async () => {
    // 线上事故的另一半：钩子一旦安装就接管全部证书校验，历史实现又判错类型，
    // 于是所有 HTTPS 被拒。常规部署（前置 Caddy 发正规证书）根本不需要它。
    const store = tmpStore() // 空库
    const session = mockSession()
    await installCertificateVerification(store, { getSession: () => session })
    expect(() => session.invoke({ hostname: 'x.example.com', port: 443, certificate: fakeCert() }, () => {}))
      .toThrow(/verify proc not installed/u)
  })

  it('有 pin（env 预置）时才安装，且仍放行平台已信任的证书', async () => {
    const store = tmpStore()
    applyPinnedFingerprintsFromEnv(store, { PICOAI_TLS_PINS: `self.example.com:8443=${sha256Fingerprint(Buffer.from([5, 5, 5]))}` } as NodeJS.ProcessEnv)
    const session = mockSession()
    await installCertificateVerification(store, { getSession: () => session })
    let result: number | null = null
    session.invoke(
      { hostname: 'harness.example.com', port: 443, certificate: fakeCert(), verificationResult: 'net::OK' },
      (r) => { result = r },
    )
    expect(result).toBe(0)
  })
})

describe('TLS 接线复核 (F13)', () => {
  it("Electron 实测的 verificationResult 是字符串 'net::OK' —— 必须直接放行（回归）", async () => {
    // 2026-09-11 v2.7.0 线上事故:实现按数字判断(typeof === 'number' && === 0),
    // 而真实值是 'net::OK',于是所有 HTTPS(含客户前置 Caddy 的正规证书)都掉进
    // 指纹库被拒,渠道客户端登录直接 net::ERR_FAILED。这条断言把真实形状钉死。
    const store = tmpStore()
    writeFileSync(store, JSON.stringify({ fingerprints: { 'pinned.example.com:443': sha256Fingerprint(Buffer.from([3, 3])) } }), { mode: 0o600 })
    const session = mockSession()
    const unknown: string[] = []
    await installCertificateVerification(store, {
      getSession: () => session,
      onUnknownFingerprint: (host) => { unknown.push(host) },
    })
    for (const verdict of ['net::OK', 'OK', 0]) {
      let result: number | null = null
      session.invoke(
        { hostname: 'harness.example.com', port: 443, certificate: fakeCert(), verificationResult: verdict, isIssuedByKnownRoot: true },
        (r) => { result = r },
      )
      expect(result, `verificationResult=${JSON.stringify(verdict)} 应直接放行`).toBe(0)
    }
    expect(unknown).toHaveLength(0)
    // 平台不信任(net::CERT_*)时不得放行,且不写库
    let untrusted: number | null = null
    session.invoke(
      { hostname: 'harness.example.com', port: 443, certificate: fakeCert([7, 7]), verificationResult: 'net::CERT_AUTHORITY_INVALID' },
      (r) => { untrusted = r },
    )
    expect(untrusted).toBe(-2)
  })

  it('系统 CA 验证通过(verificationResult=0,数字兼容分支)直接放行,不查指纹库', async () => {
    const store = tmpStore()
    writeFileSync(store, JSON.stringify({ fingerprints: { 'pinned.example.com:443': sha256Fingerprint(Buffer.from([3, 3])) } }), { mode: 0o600 })
    const session = mockSession()
    const unknown: string[] = []
    await installCertificateVerification(store, {
      getSession: () => session,
      onUnknownFingerprint: (host) => { unknown.push(host) },
    })
    let result: number | null = null
    session.invoke(
      { hostname: 'official.example.com', port: 443, certificate: fakeCert(), verificationResult: 0 },
      (r) => { result = r },
    )
    expect(result).toBe(0)
    expect(unknown).toHaveLength(0)
  })

  it('PICOAI_TLS_PINS 预置指纹后,自签名证书按 pin 放行', async () => {
    const store = tmpStore()
    const cert = fakeCert()
    const fp = sha256Fingerprint(Buffer.from(cert.data, 'base64'))
    const applied = applyPinnedFingerprintsFromEnv(store, {
      PICOAI_TLS_PINS: `self.example.com:8443=${fp}`,
    } as NodeJS.ProcessEnv)
    expect(applied).toBe(1)
    const session = mockSession()
    await installCertificateVerification(store, { getSession: () => session })
    let result: number | null = null
    session.invoke({ hostname: 'self.example.com', port: 8443, certificate: cert }, (r) => { result = r })
    expect(result).toBe(0)
  })

  it('畸形/过短的 PICOAI_TLS_PINS 被忽略', () => {
    const store = tmpStore()
    const applied = applyPinnedFingerprintsFromEnv(store, {
      PICOAI_TLS_PINS: 'host-only, bad=xyz, =nofp',
    } as NodeJS.ProcessEnv)
    expect(applied).toBe(0)
  })
})
