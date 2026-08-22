import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadElectronModule } from './electron.ts'

export function sha256Fingerprint(cert: Buffer | string): string {
  const der = typeof cert === 'string' ? pemToDer(cert) : cert
  return createHash('sha256').update(der).digest('hex')
}

function pemToDer(pem: string): Buffer {
  const body = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '')
  return Buffer.from(body, 'base64')
}

function readStore(storePath: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as { fingerprints?: Record<string, string> }
    return parsed.fingerprints ?? {}
  } catch {
    return {}
  }
}

function writeStore(storePath: string, fingerprints: Record<string, string>): void {
  mkdirSync(dirname(storePath), { recursive: true })
  writeFileSync(storePath, JSON.stringify({ fingerprints }, null, 2), { mode: 0o600 })
}

export function loadFingerprints(storePath: string): Record<string, string> {
  return readStore(storePath)
}

export function saveFingerprint(storePath: string, serverHost: string, fingerprint: string): void {
  const map = readStore(storePath)
  map[serverHost] = fingerprint
  writeStore(storePath, map)
}

export function checkFingerprint(storePath: string, serverHost: string, fingerprint: string): 'trusted' | 'unknown' | 'mismatch' {
  const known = readStore(storePath)[serverHost]
  if (known === undefined) return 'unknown'
  return known === fingerprint ? 'trusted' : 'mismatch'
}

export function clearFingerprints(storePath: string): void {
  rmSync(storePath, { force: true })
}

export interface InstallCertOptions {
  onUnknownFingerprint?: (host: string, fingerprint: string) => void
  onMismatchFingerprint?: (host: string, fingerprint: string) => void
  getSession?: () => unknown
}

export async function installCertificateVerification(storePath: string, opts: InstallCertOptions = {}): Promise<void> {
  let session: any = null
  try {
    if (opts.getSession) {
      session = opts.getSession()
    } else {
      const mod = await loadElectronModule()
      session = mod?.session?.defaultSession
    }
  } catch {
    return
  }
  if (!session || typeof session.setCertificateVerifyProc !== 'function') return

  session.setCertificateVerifyProc((request: any, callback: (verificationResult: number) => void) => {
    const host: string = request?.hostname ?? ''
    const port: number | undefined = request?.port
    const hostKey = port ? `${host}:${port}` : host
    const cert = request?.certificate
    let fingerprint = ''
    try {
      if (cert?.data) fingerprint = sha256Fingerprint(cert.data)
    } catch {
      fingerprint = ''
    }
    if (!host || !fingerprint) {
      callback(-2)
      return
    }
    const status = checkFingerprint(storePath, hostKey, fingerprint)
    if (status === 'trusted') {
      callback(0)
    } else if (status === 'mismatch') {
      opts.onMismatchFingerprint?.(hostKey, fingerprint)
      callback(-2)
    } else {
      // P1-3 fix: an UNKNOWN fingerprint is no longer auto-trusted (TOFU by
      // quiet acceptance let a MITM's certificate be pinned on first connect).
      // Reject the verification and surface the fingerprint to the caller so
      // a human can explicitly approve it (then save + reconnect). Until an
      // approval flow exists, unknown servers simply fail closed.
      opts.onUnknownFingerprint?.(hostKey, fingerprint)
      callback(-2)
    }
  })
}
