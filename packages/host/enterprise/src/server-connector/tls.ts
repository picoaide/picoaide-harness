import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadElectronModule } from './electron.ts'
import { dshHomeSafe } from 'dsh-plugin-desktop/desktop-home'

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

export interface InstallCertOptions {
  onUnknownFingerprint?: (host: string, fingerprint: string) => void
  onMismatchFingerprint?: (host: string, fingerprint: string) => void
  getSession?: () => unknown
}

/** 默认指纹库位置:$DSH_HOME/tls-fingerprints.json(0600;数据根随渠道)。 */
export function defaultTlsStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHomeSafe({ env }), 'tls-fingerprints.json')
}

/**
 * 从 PICOAI_TLS_PINS 环境变量导入预置指纹(F13):
 *   PICOAI_TLS_PINS="host:443=hex,other.example=hex"
 * 适用于自签名/私有 CA 的内网服务端:在 Electron 无法走系统信任时,
 * 管理员用带外渠道分发指纹,启动时固定。
 */
export function applyPinnedFingerprintsFromEnv(storePath: string, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PICOAI_TLS_PINS?.trim()
  if (!raw) return 0
  let applied = 0
  for (const entry of raw.split(',')) {
    const [host, fp] = entry.split('=')
    const hostKey = host?.trim()
    const fingerprint = fp?.trim().toLowerCase()
    if (!hostKey || !fingerprint) continue
    if (fingerprint.length < 32) continue // 明显不是 sha256
    saveFingerprint(storePath, hostKey, fingerprint)
    applied++
  }
  return applied
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
    // F13(审计 2026-09-11):先放行**系统 CA 已信任**的证书。
    // setCertificateVerifyProc 一旦安装会接管全部证书校验;若对所有请求
    // 都只查 TOFU 指纹库(初始为空),会让所有正常 HTTPS(含官方 CA)失败。
    // Chromium 的 verificationResult===0 表示系统链验证通过。
    const systemResult = request?.verificationResult
    if (typeof systemResult === 'number' && systemResult === 0) {
      callback(0)
      return
    }
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
