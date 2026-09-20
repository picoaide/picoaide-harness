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
 *   body {install_id, public_key, nonce, ts, signature, app_id}
 *   signature = Ed25519.sign(installMessage(install_id, nonce, ts, serverURL))
 *   → {proof, expires_at}
 * ```
 *
 * ## 线格式的真源在服务端（**2026-09-20 血案，别再漂移**）
 *
 * 上面那行 body 与 `installMessage` 的**字节**不是本模块的自由选择：它们是冻结的
 * 跨端线格式，真源 = `server/internal/wasmapp/appproof/proof.go` 的
 * `InstallMessage`（五段 `"\n"` 连接、末尾无换行）与
 * `server/internal/wasmapp/api/proof.go` 的 `appProofIssue`（`DisallowUnknownFields`
 * 的解码结构体）。四条曾经**同时**漂移、导致真实客户端 100% 打不开任何应用：
 *
 *  1. body 里多带 `server_url` ⇒ 未知字段 ⇒ 400 `VALIDATION`（decode_failed）；
 *  2. body 里少 `app_id` ⇒ 400 `INVALID_APP_ID`（它是 proof 绑定的输入，**必填**）；
 *  3. 签名覆盖的是"键排序的 JSON"而不是五段消息 ⇒ 401 `proof_mismatch`
 *     （`signature_invalid`）；
 *  4. `public_key` 发的是 SPKI DER（44 字节）而不是**原始 32 字节** Ed25519 ⇒ 同样
 *     落到 `signature_invalid`（服务端 `decodePublicKey` 只收 32 字节）。
 *
 * 后果不是"少一个功能"：签发永远失败 ⇒ 请求上没有 `X-Pico-App-Proof` ⇒ 平台对
 * `open`/`request` 回 401 `proof_required`。判据见 `app-proof.spec.ts` 的跨端对拍
 * （直接读 Go 源码的 `InstallMessage` 拼装）与 `installMessageBytes()` 的逐字节断言。
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

/**
 * 内存里同时保留的 proof 张数上限（按 app_id 分格，界内 LRU）。
 *
 * 每格是一条 15 min 的凭据；应用数量没有上限，界存在的意义与宿主令牌表
 * （`HOST_PROOF_MAX_PENDING`）相同：把"逛遍应用中心"的内存占用钉成常数。
 */
const APP_PROOF_CACHE_MAX = 64

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
 * 安装签名**待签消息**的前缀（与 Go `appproof.InstallMessagePrefix` **逐字**一致）。
 *
 * 它是线格式的一部分（改它 = 让所有在手客户端签不出有效证明），跨端对拍用例
 * 直接读 Go 源码的常量来钉住它。
 */
export const INSTALL_MESSAGE_PREFIX = 'appproof-install-v1'

/** 安装签名待签消息的输入（四段 + 固定前缀 = 五段）。 */
export interface InstallMessageInput {
  /** 稳定安装标识。 */
  installId: string
  /** 一次性 nonce（base64/hex 均可，服务端只要求 ≤128 字节的非空串）。 */
  nonce: string
  /** **unix 秒**（不是毫秒：服务端按 `time.Unix(ts, 0)` 做 ±5 min 漂移判定）。 */
  ts: number
  /** 规范服务端地址（见 {@link proofServerURL}）。 */
  serverURL: string
}

/**
 * 拼装安装签名的待签**字节**（跨端线格式的**唯一**实现）。
 *
 * 与服务端 `appproof.InstallMessage` 逐字节相同：五段用 `"\n"` 连接、**末尾无换行**。
 * 写成数组 join 而不是模板串，是为了让"少一段/多一个尾换行"这种漂移在测试里逐字节
 * 可见（服务端验签失败只回一个笼统的 `signature_invalid`，真机极难定位）。
 * @param input - 四段载荷。
 * @returns 待签字节。
 */
export function installMessageBytes(input: InstallMessageInput): Buffer {
  return Buffer.from([
    INSTALL_MESSAGE_PREFIX,
    input.installId,
    input.nonce,
    String(input.ts),
    input.serverURL,
  ].join('\n'), 'utf8')
}

/**
 * 把会话里的服务端地址归一成**服务端自己算出的那个绑定值**。
 *
 * 服务端的绑定值来自 `appproof.ServerURL(r)` = `edge.NormalizeOrigin(scheme://r.Host)`
 * —— 小写 scheme、主机小写、**默认端口省略**、无路径、无尾斜杠。客户端必须签同一个
 * 字符串，否则签名与绑定都对不上（而且失败信息只有 `signature_invalid`）。
 *
 * 归一化前客户端签的是"用户输入原文"：`https://host/` 这样的地址会直接签出无效证明
 * （服务端算出来是 `https://host`）。`new URL().origin` 与 Go 的 `originHostPort`
 * 同口径（默认端口省略、非法形态返回空串）。
 * @param serverURL - 会话里的服务端地址（未归一）。
 * @returns 规范 origin；不是 http(s) 或无法解析 ⇒ `''`（调用方按"拿不到 proof"处理）。
 */
export function proofServerURL(serverURL: string): string {
  try {
    const url = new URL(serverURL.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.origin
  } catch {
    return ''
  }
}

/**
 * 对"安装签发载荷"签名（§23.1：`{nonce, ts, serverURL, install_id}`）。
 *
 * 覆盖的字节由 {@link installMessageBytes} 决定（**不是** JSON）——服务端用同一份
 * 拼装验签，两边各写一份会让所有客户端静默签不出有效证明。
 * @param privateKeyPem - 安装私钥（PKCS#8 PEM）。
 * @param payload - 四段载荷。
 * @returns base64 签名。
 */
export function signInstallPayload(
  privateKeyPem: string,
  payload: InstallMessageInput,
): string {
  return edSign(null, installMessageBytes(payload), createPrivateKey(privateKeyPem)).toString('base64')
}

/** 由私钥推出公钥（SPKI DER base64）——用来校验落盘文件自洽（自检，§23.1）。 */
export function publicKeyOf(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'der' }).toString('base64')
}

/**
 * 由私钥推出**线上形态**的公钥：原始 32 字节 Ed25519，base64（标准字母表、带 padding）。
 *
 * 为什么不是 {@link publicKeyOf}（SPKI DER，44 字节）：服务端 `decodePublicKey` 只接受
 * `len(b) == ed25519.PublicKeySize`（32）。发 SPKI 会被判"长度 44，want 32"并**误报**成
 * `signature_invalid`（`ErrMalformed` 落到 `proofIssueError` 的 default 分支），真机只看到
 * "安装签名校验失败"，完全指不到公钥编码。
 *
 * 落盘的密钥文件仍然存 SPKI（{@link StoredInstallKey.publicKey}，自检用），线格式在这里
 * 现推 —— 换编码不改密钥文件 schema，老机器的密钥文件不用重建。
 * @param privateKeyPem - 安装私钥（PKCS#8 PEM）。
 * @returns base64（32 字节原始公钥）。
 */
export function rawPublicKeyOf(privateKeyPem: string): string {
  const jwk = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: 'jwk' }) as { x?: unknown }
  const x = jwk.x
  if (typeof x !== 'string' || x === '') throw new Error('app-proof: the install key has no Ed25519 public component')
  const raw = Buffer.from(x, 'base64url')
  if (raw.byteLength !== 32) throw new Error(`app-proof: the install public key is ${String(raw.byteLength)} bytes, want 32`)
  return raw.toString('base64')
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

/**
 * 签发一次 proof 的请求体（**线格式**：字段集与 `server/internal/wasmapp/api/proof.go`
 * 的 `appProofIssue` 解码结构体逐字一致）。
 *
 * 该端点是 `DisallowUnknownFields` 解码：**多一个字段就 400**（曾经的 `server_url`
 * 就是这么挂掉的），**少 `app_id` 也 400**（它必填，且是 proof 绑定的输入）。
 */
export interface AppProofRequest {
  install_id: string
  /** **原始 32 字节** Ed25519 公钥的 base64（见 {@link rawPublicKeyOf}；不是 SPKI）。 */
  public_key: string
  nonce: string
  /** unix **秒**（服务端按秒做 ±5 min 漂移判定）。 */
  ts: number
  signature: string
  /** proof 绑定的应用（服务端把它写进 Claims.App；跨应用使用会被判 proof_mismatch）。 */
  app_id: string
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
   * 取一个可用于 `appId` 的 proof（未登录 ⇒ null；签发失败 ⇒ null 并记 warn，调用方按
   * "没有 proof"处理，**不**把失败变成异常打断应用页面）。
   *
   * `appId` 是**必填**参数而不是可选项：服务端把 proof 绑到 app_id 上（R2S-2/N2），
   * 一张 proof 只能用于那一个应用。签名必须覆盖 `app_id`，缓存也必须按 app_id 分格
   * —— 共用一张会让第二个应用的请求必吃 401 `proof_mismatch`。
   * @param appId - 本次调用要访问的应用。
   * @param force - true 时忽略缓存（401 重签用）。
   */
  get(appId: string, force?: boolean): Promise<string | null>
  /** 丢弃内存里的全部 proof（401 / 切换账号 / 切服务端时调用）。 */
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
  /**
   * 内存里的 current proof，**按 app_id 分格**（**只有内存**，§20.1：不落盘）。
   *
   * 为什么必须分格：服务端把 proof 绑到 `app_id`（`Claims.App`），跨应用使用被判
   * `proof_mismatch`。共用一张 = 第二个应用必然 401。
   * 为什么有界：应用数量没有上限，而每格是一条 15 min 的凭据 —— 界内 LRU 保证
   * "逛遍整个应用中心"不会把内存变成一张无界的凭据表。
   */
  const cached = new Map<string, { proof: string, expiresAt: number, token: string, serverURL: string }>()
  /** 并发单飞：同一 app 同一时刻只发一次签发请求（首个应用请求常有多条并行子资源）。 */
  const inFlight = new Map<string, Promise<string | null>>()
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

  /**
   * 签发一张绑定 `appId` 的 proof（缓存命中直接返回）。
   * @param appId - 目标应用（服务端按它绑定；不能再共用）。
   * @param force - true 时忽略缓存（401 重签）。
   * @returns proof，或 null（未登录/地址不可归一/签发失败，原因见 warn）。
   */
  const issue = async (appId: string, force: boolean): Promise<string | null> => {
    const session = deps.session()
    if (session === null) return null
    // 绑定值必须与**服务端算出来的那个字符串**逐字相同（见 proofServerURL）。
    const serverURL = proofServerURL(session.serverURL)
    if (serverURL === '') {
      warn('pico-wasm-apps-host: the configured server address is not a usable http(s) origin; no app proof can be issued')
      return null
    }
    const instant = now()
    const hit = cached.get(appId)
    if (!force
      && hit !== undefined
      && hit.token === session.token
      && hit.serverURL === serverURL
      && usable(hit.expiresAt, instant)) {
      return hit.proof
    }
    const key = await loadKey()
    // **unix 秒**：服务端按 `time.Unix(ts, 0)` 判 ±5 min 漂移，发毫秒会被判
    // proof_expired（差值 1000 倍，且提示只会说"时钟漂移"）。
    const ts = Math.floor(instant / 1000)
    // nonce 只取一次，签名与请求体共用它：两处各取一次随机数会让签名与载荷
    // 不一致（服务端 100% 拒签，且症状极难查）。
    const oneTimeNonce = nonce()
    const signature = signInstallPayload(key.privateKeyPem, {
      nonce: oneTimeNonce,
      ts,
      serverURL,
      installId: key.installId,
    })
    const request: AppProofRequest = {
      install_id: key.installId,
      // 线上形态是**原始 32 字节**公钥（不是落盘的 SPKI）。
      public_key: rawPublicKeyOf(key.privateKeyPem),
      nonce: oneTimeNonce,
      ts,
      signature,
      app_id: appId,
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
      // 400 是最常见的一种（body 形状与 `appProofIssue` 的解码结构体不一致）——
      // 这条 warn 是那次漂移唯一的现场，别把它降级成 debug。
      warn(`pico-wasm-apps-host: the platform refused to issue an app proof (${String(response.status)})`)
      return null
    }
    const parsed = parseProofResponse(await response.json().catch(() => undefined), instant)
    if (parsed === null) {
      warn('pico-wasm-apps-host: the app proof response was malformed')
      return null
    }
    // 界内 LRU：先删后写让"刚用过的那格"排到队尾（Map 的 set 对已存在的键**不**改插入序），
    // 超上限时淘汰队首（与 host-request 的令牌表同一口径）。先删再判上限，避免
    // "重签的正是最旧那一格"时把自己淘汰掉、白丢一张刚签好的证明。
    cached.delete(appId)
    while (cached.size >= APP_PROOF_CACHE_MAX) {
      const oldest = cached.keys().next()
      if (oldest.done === true) break
      cached.delete(oldest.value)
    }
    cached.set(appId, { proof: parsed.proof, expiresAt: parsed.expiresAt, token: session.token, serverURL })
    return parsed.proof
  }

  return {
    async get(appId, force = false) {
      const pending = inFlight.get(appId)
      if (pending !== undefined && !force) return await pending
      const task = issue(appId, force).finally(() => {
        if (inFlight.get(appId) === task) inFlight.delete(appId)
      })
      inFlight.set(appId, task)
      return await task
    },
    invalidate() {
      cached.clear()
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
