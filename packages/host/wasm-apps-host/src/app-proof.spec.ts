/**
 * 客户端持有性证明 A′ 的判据（§23.1）。变异验证：把 `invalidate()` 改成 no-op ⇒
 * "401 后重签"用例必红；把 `loadKey` 的自洽校验去掉 ⇒ 损坏密钥用例必红。
 *
 * ---- 2026-09-20：签发请求的**线格式**判据（真机 P0 的回归） ----
 *
 * 本文件曾经只钉自己的字面量（"规范化 JSON 是跨端契约"），而服务端实现的是另一套
 * （`appproof-install-v1` 五段消息 + `DisallowUnknownFields` 的解码结构体）——
 * 两侧全绿、真机上每次打开应用都 401 `proof_required`。现在这四条判据直接读
 * **Go 源码**做对拍，任何一侧漂移都会红：
 *
 *  1. 待签消息：前缀常量 + 五段字段顺序（vs `appproof/proof.go` 的 `InstallMessage`）；
 *  2. 请求体字段集：逐字等于 `api/proof.go` 里 `appProofIssue` 的解码结构体 tag
 *     （多一个字段就是 400 `decode_failed`，少 `app_id` 就是 400 `INVALID_APP_ID`）；
 *  3. 公钥形态：原始 32 字节（vs 服务端 `decodePublicKey` 的 `ed25519.PublicKeySize`）；
 *  4. `ts` 是 **unix 秒**（服务端按秒判 ±5 min 漂移）。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createPublicKey, verify as edVerify } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APP_PROOF_HEADER,
  APP_PROOF_PATH,
  INSTALL_MESSAGE_PREFIX,
  INSTALL_KEY_FILE,
  createAppProofProvider,
  createInstallKeyStore,
  generateInstallKey,
  installMessageBytes,
  isSelfConsistent,
  parseProofResponse,
  proofServerURL,
  publicKeyOf,
  rawPublicKeyOf,
  signInstallPayload,
  type InstallKeyStore,
  type SafeStorageLike,
  type StoredInstallKey,
} from './app-proof.ts'

/** 仓库根：从本文件（`packages/host/wasm-apps-host/src/`）往上四级。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
/** 待签消息的真源（L1）。 */
const GO_PROOF_SRC = 'server/internal/wasmapp/appproof/proof.go'
/** 签发端点（请求体形态）的真源（L1）。 */
const GO_API_SRC = 'server/internal/wasmapp/api/proof.go'

/** 读仓库内文件；读不到 ⇒ 直接失败（跨端契约缺失不是"跳过"）。 */
function repoFile(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), 'utf8')
}

/** 落盘/线格式里存的是 SPKI DER 的 base64 ⇒ 验签前要转成 KeyObject。 */
function spkiKeyObject(spkiBase64: string): ReturnType<typeof createPublicKey> {
  return createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' })
}

/**
 * 按括号深度 0 的逗号切分实参列表（`strconv.FormatInt(ts, 10)` 内部的逗号不算分隔符）。
 * @param body - `[]string{…}` 的花括号内容。
 * @returns 逐个实参（已去空白、丢空段）。
 */
function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of body) {
    if (char === '(' || char === '{' || char === '[') depth += 1
    if (char === ')' || char === '}' || char === ']') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.map(part => part.trim()).filter(part => part !== '')
}

/**
 * 从 Go 源码里抽出待签消息的**前缀**与**字段顺序**。
 *
 * 抽法（任一处抽不到都算问题，不静默跳过）：
 *  - 前缀：`InstallMessagePrefix = "<字面量>"`；
 *  - 字段顺序：`strings.Join([]string{...}, "\n")` 的花括号内容，按 `,` 切开后
 *    归一成可比较的记号（`InstallMessagePrefix` / `installID` / `nonce` /
 *    `strconv.FormatInt(ts, 10)` / `serverURL`）。
 * @param source - `appproof/proof.go` 全文。
 * @returns 前缀、字段顺序与问题清单。
 */
export function goInstallMessageSpec(source: string): { prefix: string | null, fields: string[] | null, problems: string[] } {
  const problems: string[] = []
  const prefix = /InstallMessagePrefix\s*=\s*"([^"]+)"/u.exec(source)?.[1] ?? null
  if (prefix === null) problems.push('proof.go 里找不到 InstallMessagePrefix 的字面量（被改名/搬走了？）')
  const body = /strings\.Join\(\[\]string\{([\s\S]*?)\},\s*"\\n"\)/u.exec(source)?.[1] ?? null
  if (body === null) {
    problems.push('proof.go 里找不到 strings.Join([]string{…}, "\\n") 形态的 InstallMessage')
    return { prefix, fields: null, problems }
  }
  // 逗号要按**括号深度 0** 切：`strconv.FormatInt(ts, 10)` 自己带一个逗号，
  // 朴素 split(',') 会把它切成两段，于是这条对拍会对一个正确的实现报错。
  const fields = splitTopLevel(body)
  const normalized = fields.map(field => field.replace(/\s+/gu, ''))
  if (normalized.join('|') !== 'InstallMessagePrefix|installID|nonce|strconv.FormatInt(ts,10)|serverURL') {
    problems.push(`待签消息的字段顺序与客户端期望不同：${normalized.join('|')}`)
  }
  return { prefix, fields: normalized, problems }
}

/**
 * 从 `api/proof.go` 里抽出 `appProofIssue` 解码结构体的 JSON tag 集合。
 *
 * 该端点是 `DisallowUnknownFields`：**字段集必须逐字相等**（多一个 400、少一个也可能
 * 400/校验失败），所以这里做集合对拍而不是"包含"。
 * @param source - `api/proof.go` 全文。
 * @returns tag 集合与问题清单。
 */
export function goIssueBodyFields(source: string): { fields: string[] | null, problems: string[] } {
  const problems: string[] = []
  const block = /var body struct \{([\s\S]*?)\n\t\}/u.exec(source)?.[1] ?? null
  if (block === null) {
    problems.push('api/proof.go 里找不到 appProofIssue 的 `var body struct {…}`')
    return { fields: null, problems }
  }
  const fields = [...block.matchAll(/json:"([^"]+)"/gu)].map(match => match[1]!)
  if (fields.length === 0) problems.push('解码结构体里一个 json tag 都没抽到')
  return { fields, problems }
}

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
      ts: 1_700_000_000,
      serverURL: 'https://harness.example.com',
      installId: key.installId,
    })
    expect(signature).toMatch(/^[A-Za-z0-9+/]+=*$/u)
    // 换一个 nonce 必须得到不同签名（防"签名与载荷不一致"这类实现错误）。
    const other = signInstallPayload(key.privateKeyPem, {
      nonce: 'n2', ts: 1_700_000_000, serverURL: 'https://harness.example.com', installId: key.installId,
    })
    expect(other).not.toBe(signature)
  })

  /**
   * 待签消息的**逐字节**判据（2026-09-20 真机 P0 的回归）。
   *
   * 断言的是**验证**而不是形状：用私钥对应的公钥真的验一次签名，并且验的是
   * **按 Go 语义拼出来的那段字节**（不是"我们自己的实现再算一遍"——那还是各钉自己的
   * 字面量）。任何一段漂移（前缀、顺序、分隔符、尾换行、ts 单位）都会让验签失败。
   */
  it('待签消息逐字节等于服务端语义（五段 \\n 连接、末尾无换行、ts 是秒）', () => {
    const key = generateInstallKey()
    const payload = { nonce: 'n1', ts: 1_700_000_000, serverURL: 'https://harness.example.com', installId: key.installId }
    const bytes = installMessageBytes(payload)
    // ① 逐字节：五段，用 \n 连接，**末尾没有换行**。
    expect(bytes.toString('utf8')).toBe(
      `appproof-install-v1\n${key.installId}\nn1\n1700000000\nhttps://harness.example.com`,
    )
    expect(bytes.toString('utf8').endsWith('\n')).toBe(false)
    expect(bytes.toString('utf8').split('\n')).toHaveLength(5)
    // ② 真验签（用 SPKI 公钥验 Go 语义的那段字节）。
    const signature = Buffer.from(signInstallPayload(key.privateKeyPem, payload), 'base64')
    const verifier = spkiKeyObject(key.publicKey)
    expect(edVerify(null, bytes, verifier, signature)).toBe(true)
    // 反向对照：把任意一段改掉，签名就不再成立（判据非空洞）。
    expect(edVerify(null, installMessageBytes({ ...payload, nonce: 'n2' }), verifier, signature)).toBe(false)
    expect(edVerify(null, installMessageBytes({ ...payload, ts: 1_700_000_001 }), verifier, signature)).toBe(false)
    expect(edVerify(null, installMessageBytes({ ...payload, serverURL: 'https://other.example.com' }), verifier, signature)).toBe(false)
    // ③ 环境里真的能拿到一个能用的 SPKI 公钥（`key.publicKey` 是 SPKI base64）。
    expect(publicKeyOf(key.privateKeyPem)).toBe(key.publicKey)
  })

  it('跨端对拍：待签消息的前缀与字段顺序逐字等于 Go 源码（L1 真源）', () => {
    const spec = goInstallMessageSpec(repoFile(GO_PROOF_SRC))
    expect(spec.problems).toEqual([])
    expect(spec.prefix).toBe(INSTALL_MESSAGE_PREFIX)
    // 自证：Go 侧改前缀 / 改字段顺序 ⇒ 对拍必红（在内存里改写，不动磁盘）。
    const source = repoFile(GO_PROOF_SRC)
    // 改的是**常量那一行**（文件里前缀还出现在注释里，朴素 replace 会命中注释 ⇒ 假绿）。
    expect(goInstallMessageSpec(source.replace('InstallMessagePrefix = "appproof-install-v1"', 'InstallMessagePrefix = "appproof-install-v2"')).prefix).not.toBe(INSTALL_MESSAGE_PREFIX)
    expect(goInstallMessageSpec(source.replace('installID, nonce,', 'nonce, installID,')).problems.length).toBeGreaterThan(0)
    expect(goInstallMessageSpec('').problems.length).toBeGreaterThan(0)
  })

  /**
   * 公钥的**线上形态**：原始 32 字节（不是 SPKI DER）。
   *
   * 发 SPKI 时服务端 `decodePublicKey` 会判"长度 44，want 32"并落到 `ErrMalformed`，
   * 对外显示成 `signature_invalid`（"安装签名校验失败"）—— 真机完全指不到公钥编码。
   */
  it('线上公钥是原始 32 字节（服务端只认 PublicKeySize），落盘仍是自洽的 SPKI', () => {
    const key = generateInstallKey()
    const raw = Buffer.from(rawPublicKeyOf(key.privateKeyPem), 'base64')
    expect(raw.byteLength).toBe(32)
    // 与 SPKI 的尾部 32 字节一致（同一把密钥、两种编码）。
    const spki = Buffer.from(publicKeyOf(key.privateKeyPem), 'base64')
    expect(spki.subarray(spki.length - 32).equals(raw)).toBe(true)
    // SPKI 是 44 字节：两种形态**不同**（这条防"忘了转换"的变异）。
    expect(spki.byteLength).toBe(44)
    expect(rawPublicKeyOf(key.privateKeyPem)).not.toBe(key.publicKey)
    // 服务端只认 32：真源是 Go 的 ed25519.PublicKeySize 判据。
    expect(repoFile(GO_PROOF_SRC)).toContain('len(b) != ed25519.PublicKeySize')
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

describe('proofServerURL（签名里的 serverURL 必须等于服务端算出来的绑定值）', () => {
  it('归一成 scheme://host[:port]：小写、去路径、去尾斜杠、默认端口省略', () => {
    expect(proofServerURL('https://harness.example.com')).toBe('https://harness.example.com')
    expect(proofServerURL('https://harness.example.com/')).toBe('https://harness.example.com')
    expect(proofServerURL('HTTPS://Harness.Example.COM')).toBe('https://harness.example.com')
    expect(proofServerURL('https://harness.example.com:443')).toBe('https://harness.example.com')
    expect(proofServerURL('http://harness.example.com:80')).toBe('http://harness.example.com')
    expect(proofServerURL('https://harness.example.com:8443')).toBe('https://harness.example.com:8443')
    // 配置里带路径时服务端算出来的也是"源"（`edge.NormalizeOrigin` 丢弃路径）。
    expect(proofServerURL('https://harness.example.com/base')).toBe('https://harness.example.com')
    // 不是 http(s) / 解析不了 ⇒ ''（调用方按"拿不到 proof"处理，绝不签一个猜的值）。
    expect(proofServerURL('ftp://harness.example.com')).toBe('')
    expect(proofServerURL('not a url')).toBe('')
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
    expect(await provider.get('demo')).toBe('p1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${session.serverURL}${APP_PROOF_PATH}`)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1')
  })

  /**
   * 请求体**字段集**逐字对拍（真机 400 的回归）。
   *
   * 服务端是 `DisallowUnknownFields` 解码：多一个字段（曾经的 `server_url`）⇒ 400
   * `VALIDATION decode_failed`；少 `app_id` ⇒ 400 `INVALID_APP_ID`。两条都只在真机
   * 上表现为"打开应用必失败"，所以字段集必须与服务端结构体逐字相等（集合相等，不是包含）。
   */
  it('请求体字段集逐字等于服务端解码结构体（不得多 server_url、不得少 app_id）', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ proof: 'p1', expires_at: Math.floor(Date.now() / 1000) + 900 }), { status: 200 }))
    const provider = createAppProofProvider({
      store: memoryStore(),
      fetch: fetchMock as unknown as (url: string, init: RequestInit) => Promise<Response>,
      session: () => session,
    })
    expect(await provider.get('demo-login')).toBe('p1')
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['app_id', 'install_id', 'nonce', 'public_key', 'signature', 'ts'])
    expect(body.app_id).toBe('demo-login')
    // 曾经的漂移字段：它会被服务端的 DisallowUnknownFields 直接 400。
    expect(body.server_url).toBeUndefined()
    // 公钥是原始 32 字节、ts 是**秒**。
    expect(Buffer.from(String(body.public_key), 'base64').byteLength).toBe(32)
    expect(Math.abs(Number(body.ts) - Math.floor(Date.now() / 1000))).toBeLessThan(5)

    // 跨端对拍：字段集与服务端 `appProofIssue` 的解码结构体逐字相等。
    expect(goIssueBodyFields(repoFile(GO_API_SRC)).problems).toEqual([])
    expect(Object.keys(body).sort()).toEqual([...goIssueBodyFields(repoFile(GO_API_SRC)).fields!].sort())
    // 自证：Go 侧多加一个字段 ⇒ 对拍必红（在内存里改写，不动磁盘）。
    const source = repoFile(GO_API_SRC)
    const mutated = source.replace('AppID     string `json:"app_id"`', 'AppID     string `json:"app_id"`\n\t\tExtra     string `json:"server_url"`')
    expect(mutated).not.toBe(source)
    expect([...goIssueBodyFields(mutated).fields!].sort()).not.toEqual(Object.keys(body).sort())
  })

  it('签名覆盖的 serverURL 是**归一化**后的值（配置带尾斜杠也签得对）', async () => {
    const keyStore = memoryStore()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ proof: 'p1', expires_at: Math.floor(Date.now() / 1000) + 900 }), { status: 200 }))
    const provider = createAppProofProvider({
      store: keyStore,
      fetch: fetchMock as unknown as (url: string, init: RequestInit) => Promise<Response>,
      session: () => ({ token: 'tok-1', serverURL: 'https://harness.example.com/' }),
    })
    expect(await provider.get('demo')).toBe('p1')
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, string | number>
    const saved = keyStore.saved[0]!
    const ok = edVerify(
      null,
      installMessageBytes({
        installId: String(body.install_id),
        nonce: String(body.nonce),
        ts: Number(body.ts),
        // 服务端算出来的绑定值（`edge.NormalizeOrigin`）：没有尾斜杠。
        serverURL: 'https://harness.example.com',
      }),
      spkiKeyObject(saved.publicKey),
      Buffer.from(String(body.signature), 'base64'),
    )
    expect(ok).toBe(true)
  })

  /**
   * proof 绑 `app_id` ⇒ 缓存必须**按应用分格**、请求体必须带对应用。
   *
   * 共用一张的后果是可预测的：第二个应用必吃 401 `proof_mismatch`（服务端
   * `Claims.App` 绑定不符）。判据同时钉住"每格一次签发"与"格子里没有别人的 proof"。
   */
  it('按 app_id 分格缓存：同一应用复用、不同应用各签一次、绝不复用别人的 proof', async () => {
    let counter = 0
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      counter += 1
      const requested = (JSON.parse(String(init.body)) as { app_id: string }).app_id
      return new Response(JSON.stringify({ proof: `p-${requested}-${String(counter)}`, expires_at: Math.floor(Date.now() / 1000) + 900 }), { status: 200 })
    })
    const provider = createAppProofProvider({
      store: memoryStore(),
      fetch: fetchMock as unknown as (url: string, init: RequestInit) => Promise<Response>,
      session: () => session,
    })
    expect(await provider.get('alpha')).toBe('p-alpha-1')
    expect(await provider.get('alpha')).toBe('p-alpha-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await provider.get('beta')).toBe('p-beta-2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // 每个请求体都带着**它自己**的 app_id（缓存分格与请求体必须同源）。
    const requested = fetchMock.mock.calls.map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { app_id: string }).app_id)
    expect(requested).toEqual(['alpha', 'beta'])
    // 回到 alpha 仍命中它自己那一格（不是 beta 的）。
    expect(await provider.get('alpha')).toBe('p-alpha-1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
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
    expect(await provider.get('demo')).toBe('p1')
    expect(await provider.get('demo')).toBe('p1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await provider.get('demo', true)).toBe('p2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    provider.invalidate()
    expect(await provider.get('demo')).toBe('p3')
  })

  it('invalidate() 清掉**全部**应用的格子（切账号/切服务端必清，§23.1）', async () => {
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
    expect(await provider.get('alpha')).toBe('p1')
    expect(await provider.get('beta')).toBe('p2')
    provider.invalidate()
    expect(await provider.get('alpha')).toBe('p3')
    expect(await provider.get('beta')).toBe('p4')
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
    expect(await provider.get('demo')).toBe('p1')
    current = { token: 'tok-2', serverURL: session.serverURL }
    expect(await provider.get('demo')).toBe('p2')
    current = { token: 'tok-2', serverURL: 'https://other.example.com' }
    expect(await provider.get('demo')).toBe('p3')
  })

  it('returns null (never throws) when not signed in or when issuance fails', async () => {
    const signedOut = createAppProofProvider({
      store: memoryStore(),
      fetch: (async () => new Response('{}', { status: 200 })) as unknown as (url: string, init: RequestInit) => Promise<Response>,
      session: () => null,
    })
    expect(await signedOut.get('demo')).toBeNull()

    const warn = vi.fn()
    const failing = createAppProofProvider({
      store: memoryStore(),
      fetch: (async () => { throw new Error('network down') }) as unknown as (url: string, init: RequestInit) => Promise<Response>,
      session: () => session,
      warn,
    })
    expect(await failing.get('demo')).toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it('平台 400（body 形状不符）⇒ null + 一条含状态码的 warn（真机唯一的现场，不得静默）', async () => {
    const warn = vi.fn()
    const provider = createAppProofProvider({
      store: memoryStore(),
      fetch: (async () => new Response(JSON.stringify({ error: { code: 'VALIDATION' } }), { status: 400 })) as unknown as (url: string, init: RequestInit) => Promise<Response>,
      session: () => session,
      warn,
    })
    expect(await provider.get('demo')).toBeNull()
    expect(warn.mock.calls.map(call => String(call[0])).join('\n')).toContain('refused to issue an app proof (400)')
  })

  it('serverURL 归一化不了 ⇒ 不签发（绝不猜一个绑定值）', async () => {
    const fetchMock = vi.fn()
    const warn = vi.fn()
    const provider = createAppProofProvider({
      store: memoryStore(),
      fetch: fetchMock as unknown as (url: string, init: RequestInit) => Promise<Response>,
      session: () => ({ token: 'tok-1', serverURL: 'not a url' }),
      warn,
    })
    expect(await provider.get('demo')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(warn.mock.calls.map(call => String(call[0])).join('\n')).toContain('not a usable http(s) origin')
  })

  it('single-flights concurrent issuance per app (sub-resources ask at once)', async () => {
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
    const pending = [provider.get('demo'), provider.get('demo'), provider.get('demo')]
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
