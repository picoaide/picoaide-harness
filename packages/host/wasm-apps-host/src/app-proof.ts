/**
 * 客户端持有性证明 A′（安装密钥绑定）—— **客户端侧**（设计总纲 §23.1，替代 §20.1 的
 * 签发与校验部分）。
 *
 * 为什么需要：R2 安全复验证明 §20.1 的原设计回答不了 RED-6 —— 签发端点只要求
 * BearerAuth，任何拿到 bearer 的人都能自助签发，proof 只多一次往返；且 proof 不绑
 * `app_id`、无 nonce，15 min 内可跨应用重放。A′ 把证明绑到**安装密钥**上：
 *
 * ```
 * 首次运行：生成 Ed25519 密钥对（install_id 与它同生）
 *   私钥 → Electron safeStorage（有钥匙串 ⇒ 加密；无钥匙串 ⇒ 0600 文件 + warn，§17 认账）
 *   公钥 → 首次签发时注册到服务端（绑 user_id + install_id）
 *
 * 每次签发（Bearer + 安装签名）：
 *   POST /api/client/v2/apps/wasm/proof
 *   body {install_id, public_key, nonce, ts, server_url, signature}
 *   signature = Ed25519.sign(canonicalJson({nonce, ts, server_url, install_id}))
 *   → {proof, expires_at}
 * ```
 *
 * 本模块**只做客户端该做的一半**：密钥的生成/存放/读取、惰性签发、缓存、失效与
 * 切换账号时的清理。服务端的公钥注册与验签在 `server/internal/wasmapp`（L1）。
 *
 * 三条冻结口径（写错就是安全缺陷）：
 *  1. **惰性签发**（§23.1）：不在"登录事件"上签发 —— 恢复型启动（带有效 bearer 重启）
 *     也要能用，否则每次重启后的首个应用请求必 401；
 *  2. **proof 只在内存**（§20.1/§20.3）：不落盘、不进日志、不进错误上报（R2S-17）；
 *     安装密钥**不是** proof，它按 §23.1 落盘（safeStorage / 0600）；
 *  3. **切换必清**（§23.1）：切账号/切渠道/切服务端 ⇒ 清内存 proof 并重新签发；
 *     安装密钥与账号无关，不随切换销毁。
 *
 * @module @picoaide/dsh-wasm-apps-host/app-proof
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
// 原子替换走上游 `@deepseek-ai/dsh-atomic-write`（2026-09-20 W6/W7 切换，见设计总纲 §16.1）：
// 包内不再有本地助手；权限位由调用点逐处声明（上游 API 的 mode 必填就是这个用意）。
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** 平台签发端点（§23.1 冻结路径）。 */
export const APP_PROOF_PATH = '/api/client/v2/apps/wasm/proof'

/** 携带 proof 的请求头（§20.1/§23.1 冻结；`open` 与 `request` 都带）。 */
export const APP_PROOF_HEADER = 'X-Pico-App-Proof'

/** 安装密钥文件的默认文件名（落在 userData 下，**不是** proof）。 */
export const INSTALL_KEY_FILE = 'wasm-apps-install-key.json'

/** proof 缺省有效期（秒，服务端为准；客户端只用它做提前续签的保守估计）。 */
const ASSUMED_PROOF_TTL_MS = 15 * 60_000

/** 提前续签窗口：剩余寿命少于它就先续（避免"刚好在请求中途过期"）。 */
const RENEW_BEFORE_MS = 60_000

/** 安装密钥文件的版本（将来换形态时用来拒绝旧文件，而不是猜）。 */
const INSTALL_KEY_VERSION = 1

/**
 * Electron `safeStorage` 的最小结构面（**不是** import electron：本包在纯 Node 下
 * 必须可加载，真实实现由桌面壳经适配器注入）。
 */
export interface SafeStorageLike {
  /** 本机是否有可用的钥匙串（false ⇒ 只能明文 0600 + warn）。 */
  isEncryptionAvailable(): boolean
  /** 加密一个 UTF-8 字符串（返回二进制）。 */
  encryptString(plainText: string): Buffer
  /** 解密 `encryptString` 的输出。 */
  decryptString(encrypted: Buffer): string
}

/** 落盘的安装密钥（**私钥**；只在需要签名时读进内存）。 */
export interface StoredInstallKey {
  /** 稳定标识（服务端按 `user_id + install_id` 注册公钥）。 */
  readonly installId: string
  /** 私钥（PKCS#8 PEM）。**绝不进日志/上报。** */
  readonly privateKeyPem: string
  /** 公钥（SPKI DER base64；签发时随请求体上报给服务端注册）。 */
  readonly publicKey: string
  /** 私钥是否由 safeStorage 加密（false = 无钥匙串的 0600 明文，§17 认账）。 */
  readonly encrypted: boolean
}

/** 安装密钥的读取/写入（注入：单测用内存实现，生产用文件 + safeStorage）。 */
export interface InstallKeyStore {
  /** 读取；不存在/损坏 ⇒ null（调用方生成新的一对）。 */
  load(): Promise<StoredInstallKey | null>
  /** 写入（原子替换；调用方保证目录已按 0700 建好）。 */
  save(key: StoredInstallKey): Promise<void>
}

/** 生成一对新的安装密钥（Ed25519，PKCS#8 + SPKI/DER base64）。 */
export function generateInstallKey(): { installId: string, privateKeyPem: string, publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    installId: randomBytes(16).toString('hex'),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  }
}

/**
 * 对"签发载荷"签名（§23.1：`{nonce, ts, serverURL, install_id}`）。
 *
 * 规范化 JSON 是**跨端契约的一部分**：键按字典序、无空格，服务端必须用同一条
 * 规则重建字节串再验签（两端各有一份实现，`app-proof.spec.ts` 钉住形状）。
 * @param privateKeyPem - 安装私钥（PKCS#8 PEM）。
 * @param payload - 四个字段（`serverURL` 是服务端地址原文，不做归一化）。
 * @returns base64 签名。
 */
export function signInstallPayload(
  privateKeyPem: string,
  payload: { nonce: string, ts: number, serverURL: string, installId: string },
): string {
  const canonical = JSON.stringify({
    install_id: payload.installId,
    nonce: payload.nonce,
    server_url: payload.serverURL,
    ts: payload.ts,
  })
  return edSign(null, Buffer.from(canonical, 'utf8'), createPrivateKey(privateKeyPem)).toString('base64')
}

/** 由私钥推出公钥（SPKI DER base64）——用来校验落盘文件自洽（自检，§23.1）。 */
export function publicKeyOf(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'der' }).toString('base64')
}

/** 安装密钥是否自洽（私钥可读且公钥对得上）。 */
export function isSelfConsistent(key: Pick<StoredInstallKey, 'privateKeyPem' | 'publicKey'>): boolean {
  try {
    return publicKeyOf(key.privateKeyPem) === key.publicKey
  } catch {
    return false
  }
}

/** 文件型安装密钥仓库的构造参数。 */
export interface InstallKeyStoreOptions {
  /** 存放目录（`<userData>`）。 */
  dir: string
  /** safeStorage（缺席 ⇒ 明文 0600 + warn）。 */
  safeStorage?: SafeStorageLike | undefined
  /** 诊断出口（缺省丢弃）。**绝不接受私钥内容。** */
  warn?: ((message: string) => void) | undefined
}

/** 文件型安装密钥仓库（safeStorage 加密优先，0600 明文兜底）。 */
export function createInstallKeyStore(options: InstallKeyStoreOptions): InstallKeyStore {
  const file = join(options.dir, INSTALL_KEY_FILE)
  const warn = options.warn ?? ((): void => {})
  return {
    async load() {
      let raw: string
      try {
        raw = await readFile(file, 'utf8')
      } catch {
        return null
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        warn('pico-wasm-apps-host: the install key file is not valid JSON; a new key will be generated')
        return null
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
      const record = parsed as Record<string, unknown>
      if (record.version !== INSTALL_KEY_VERSION) return null
      const installId = record.install_id
      const privateKey = record.private_key
      const publicKey = record.public_key
      if (typeof installId !== 'string' || typeof privateKey !== 'string' || typeof publicKey !== 'string') return null
      const encrypted = record.encrypted === true
      if (!encrypted) return { installId, privateKeyPem: privateKey, publicKey, encrypted: false }
      const storage = options.safeStorage
      if (storage === undefined || !storage.isEncryptionAvailable()) {
        // 加密过、但本机现在没有钥匙串（换机器/换用户配置目录）：无法解密，
        // 只能重新生成一对并让服务端重新注册 —— 明确记一条，不静默降级成明文。
        warn('pico-wasm-apps-host: the stored install key is encrypted but no keyring is available; a new key will be generated')
        return null
      }
      try {
        return { installId, privateKeyPem: storage.decryptString(Buffer.from(privateKey, 'base64')), publicKey, encrypted: true }
      } catch {
        warn('pico-wasm-apps-host: decrypting the install key failed; a new key will be generated')
        return null
      }
    },
    async save(key) {
      const storage = options.safeStorage
      const encrypt = storage !== undefined && storage.isEncryptionAvailable()
      if (!encrypt) {
        warn('pico-wasm-apps-host: no OS keyring is available; the application install key is stored as a 0600 file (see the design ledger §17)')
      }
      const body = JSON.stringify({
        version: INSTALL_KEY_VERSION,
        install_id: key.installId,
        public_key: key.publicKey,
        encrypted: encrypt,
        private_key: encrypt ? storage.encryptString(key.privateKeyPem).toString('base64') : key.privateKeyPem,
      })
      // 原子替换 + 0600/0700（上游 `writeFileAtomic`：`wx` 临时兄弟 + rename）：
      // 半写的密钥文件比没有密钥更糟（启动自检会把它当损坏，用户表现为"应用功能不可用"）。
      await writeFileAtomic(file, body, { mode: 0o600, dirMode: 0o700 })
    },
  }
}

/** 签发一次 proof 的载荷（客户端生成 nonce：一次性、绑本次签发请求）。 */
export interface AppProofRequest {
  install_id: string
  public_key: string
  nonce: string
  ts: number
  server_url: string
  signature: string
}

/** 签发结果（服务端响应；未知字段在这里被收紧）。 */
export interface AppProofResponse {
  proof: string
  /** 过期时刻（毫秒）。服务端给 `expires_at`（秒或 ISO），两种都收。 */
  expiresAt: number
}

/** proof 提供者的依赖（全部注入，便于单测）。 */
export interface AppProofProviderDeps {
  /** 安装密钥仓库。 */
  store: InstallKeyStore
  /** 出站（Chromium 栈由桌面适配器给；单测给假实现）。 */
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** 当前会话（未登录 ⇒ 不签发）。 */
  session: () => { readonly token: string, readonly serverURL: string } | null
  /** 诊断出口（**绝不接受 token/proof/私钥**）。 */
  warn?: ((message: string) => void) | undefined
  /** 可注入时钟（测试用）。 */
  now?: (() => number) | undefined
  /** 可注入随机源（测试用）。 */
  randomNonce?: (() => string) | undefined
}

/** proof 提供者：惰性签发 + 内存缓存 + 失效重签。 */
export interface AppProofProvider {
  /**
   * 取一个可用的 proof（未登录 ⇒ null；签发失败 ⇒ null 并记 warn，调用方按
   * "没有 proof"处理，**不**把失败变成异常打断应用页面）。
   * @param force - true 时忽略缓存（401 重签用）。
   */
  get(force?: boolean): Promise<string | null>
  /** 丢弃内存里的 proof（401 / 切换账号 / 切服务端时调用）。 */
  invalidate(): void
  /** 启动期自检：私钥可读 + 公钥自洽（§23.1；失败 ⇒ 应用功能不可用并给可读原因）。 */
  selfCheck(): Promise<{ ok: true } | { ok: false, reason: string }>
}

/** proof 是否还在有效期内（保守估计：提前 {@link RENEW_BEFORE_MS} 视为过期）。 */
function usable(expiresAt: number, now: number): boolean {
  return expiresAt - RENEW_BEFORE_MS > now
}

/**
 * 解析服务端的签发响应（`{proof, expires_at}`；`expires_at` 收秒/毫秒/ISO 三种）。
 * @param value - `JSON.parse` 之后的值。
 * @param now - 当前时刻（缺省时兜底 assume TTL）。
 * @returns 解析结果或 null（形状不符）。
 */
export function parseProofResponse(value: unknown, now: number): AppProofResponse | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const proof = record.proof
  if (typeof proof !== 'string' || proof === '') return null
  const raw = record.expires_at ?? record.expiresAt
  let expiresAt = now + ASSUMED_PROOF_TTL_MS
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // 秒与毫秒都收：< 10^11 视为秒（2026 年的毫秒时间戳是 13 位）。
    expiresAt = raw < 1e11 ? raw * 1000 : raw
  } else if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) expiresAt = parsed
  }
  return { proof, expiresAt }
}

/**
 * 构造 proof 提供者。
 * @param deps - 密钥仓库/出站/会话/时钟。
 * @returns 惰性签发的 proof 提供者。
 */
export function createAppProofProvider(deps: AppProofProviderDeps): AppProofProvider {
  const now = deps.now ?? ((): number => Date.now())
  const warn = deps.warn ?? ((): void => {})
  const nonce = deps.randomNonce ?? ((): string => randomBytes(32).toString('hex'))
  /** 内存里的 current proof（**只有内存**，§20.1：不落盘）。 */
  let cached: AppProofResponse | null = null
  /** 缓存对应的 (token, serverURL)：切换账号/服务端即失效（§23.1 切换口径）。 */
  let cachedFor: { token: string, serverURL: string } | null = null
  /** 并发单飞：同一时刻只发一次签发请求（首个应用请求常有多条并行子资源）。 */
  let inFlight: Promise<string | null> | null = null
  let cachedKey: StoredInstallKey | null = null

  const loadKey = async (): Promise<StoredInstallKey> => {
    if (cachedKey !== null) return cachedKey
    const existing = await deps.store.load()
    if (existing !== null && isSelfConsistent(existing)) {
      cachedKey = existing
      return existing
    }
    if (existing !== null) warn('pico-wasm-apps-host: the stored install key does not match its public key; generating a new one')
    const generated = generateInstallKey()
    const created: StoredInstallKey = { ...generated, encrypted: false }
    await deps.store.save(created)
    cachedKey = created
    return created
  }

  const issue = async (force: boolean): Promise<string | null> => {
    const session = deps.session()
    if (session === null) return null
    const instant = now()
    if (!force
      && cached !== null
      && cachedFor !== null
      && cachedFor.token === session.token
      && cachedFor.serverURL === session.serverURL
      && usable(cached.expiresAt, instant)) {
      return cached.proof
    }
    const key = await loadKey()
    const ts = instant
    // nonce 只取一次，签名与请求体共用它：两处各取一次随机数会让签名与载荷
    // 不一致（服务端 100% 拒签，且症状极难查）。
    const oneTimeNonce = nonce()
    const signature = signInstallPayload(key.privateKeyPem, {
      nonce: oneTimeNonce,
      ts,
      serverURL: session.serverURL,
      installId: key.installId,
    })
    const request: AppProofRequest = {
      install_id: key.installId,
      public_key: key.publicKey,
      nonce: oneTimeNonce,
      ts,
      server_url: session.serverURL,
      signature,
    }
    let response: Response
    try {
      response = await deps.fetch(`${session.serverURL.replace(/\/+$/u, '')}${APP_PROOF_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify(request),
      })
    } catch (cause) {
      warn(`pico-wasm-apps-host: requesting an app proof failed (${cause instanceof Error ? cause.message : String(cause)})`)
      return null
    }
    if (!response.ok) {
      // 只记状态码：响应体可能带服务端诊断，但这里**不记录**任何 token/proof。
      warn(`pico-wasm-apps-host: the platform refused to issue an app proof (${String(response.status)})`)
      return null
    }
    const parsed = parseProofResponse(await response.json().catch(() => undefined), instant)
    if (parsed === null) {
      warn('pico-wasm-apps-host: the app proof response was malformed')
      return null
    }
    cached = parsed
    cachedFor = { token: session.token, serverURL: session.serverURL }
    return parsed.proof
  }

  return {
    async get(force = false) {
      if (inFlight !== null && !force) return await inFlight
      const pending = issue(force).finally(() => {
        if (inFlight === pending) inFlight = null
      })
      inFlight = pending
      return await pending
    },
    invalidate() {
      cached = null
      cachedFor = null
    },
    async selfCheck() {
      try {
        const key = await loadKey()
        if (!isSelfConsistent(key)) return { ok: false, reason: 'install key is not self-consistent' }
        return { ok: true }
      } catch (cause) {
        return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) }
      }
    },
  }
}
