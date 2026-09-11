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
  // 没有任何 pin 就**不安装**这个钩子(2026-09-11 用户定案:"TLS 用默认的就行,
  // 前面还套了一层 Caddy")。`setCertificateVerifyProc` 一旦安装就会接管**全部**
  // 证书校验,历史实现(按数字判断 verificationResult)因此把所有 HTTPS 判死;
  // 即便判定逻辑修对了,让应用在"没有任何 pin"的常规部署里保持 Electron 默认
  // 校验也是最稳的选择 —— 私人/自签名服务端才需要显式 pin。
  if (Object.keys(readStore(storePath)).length === 0) return

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
    // 平台信任判定(2026-09-11 修正):Electron 的 `request.verificationResult` 是
    // **字符串** —— 实测值为 `"net::OK"`(不信任时形如 `"net::CERT_AUTHORITY_INVALID"`),
    // 不是数字。F13 原先按 `typeof === 'number' && === 0` 判断,于是这条"系统已信任
    // 就放行"的快路径**从未命中**:所有 HTTPS 证书(公网 CA、以及客户前置 Caddy 发的
    // 正规证书)都掉进指纹库,未 pin 一律 `-2` 拒绝 —— 客户端连自家服务器都登不上,
    // 日志里连 Chromium 自己的 `redirector.gvt1.com` 都被判"不受信任"(v2.7.0 实测
    // 的登录 net::ERR_FAILED 就是这个)。保留数字 0 的兼容分支以防边界版本。
    const verdict = request?.verificationResult
    if (verdict === 'net::OK' || verdict === 'OK' || verdict === 0) {
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
      // 平台**不**信任且没有 pin:一律交回默认语义(Chromium 自己也会拒),
      // 本钩子只做"**额外放行**已 pin 的自签名/私有 CA 服务端",绝不比默认更严。
      // (2026-09-11 定案:用户明确"TLS 用默认的就行,前面还套了一层 Caddy" ——
      //  企业网络里的 MITM 根、系统信任但不在 Chrome Root Store 里的链都不该被
      //  这个钩子判死。)
      // P1-3 的 TOFU 语义仍然保留:未知指纹不写库、也不静默信任。
      opts.onUnknownFingerprint?.(hostKey, fingerprint)
      callback(-2)
    }
  })
}
