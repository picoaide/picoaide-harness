/**
 * 本机持有性证明（`X-Pico-Host-Proof` 请求头机制）的**纯语义**判据（R2-X-1，P0）。
 *
 * 覆盖四类容易写错、且错了会很贵的行为：
 *  1. **缓存与提前量**：有效期内复用、临期重取（不把"刚好过期"发出去）；
 *  2. **强制重取**：`force` 必须真的再取一枚（401 重放路径靠它）；
 *  3. **并发去重**：同一时刻只有一次引导请求（否则重试风暴）；
 *  4. **只在内存**：模块源码里不得出现任何存储/日志出口（令牌落盘就失去意义）。
 *
 * ---- 变异验证 ----
 *   - `hostProofToken` 去掉提前量（`expiresAt > now`）⇒「临期视为不可用」红；
 *   - `ensureHostProof` 忽略 `force` ⇒「force 再取一枚」红；
 *   - 去掉并发去重 ⇒「并发只发一次」红；
 *   - 把令牌写进 `localStorage`（或加一行 console.log）⇒「不落盘/不打印」红。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  HOST_PROOF_HEADER,
  HOST_PROOF_PATH,
  HOST_PROOF_SKEW_MS,
  PLATFORM_APP_FROZEN_REASON,
  PLATFORM_REFUSAL_CODE_PREFIX,
  clearHostProofToken,
  ensureHostProof,
  hostProofFailure,
  hostProofToken,
  isHostProofErrorCode,
  parseHostProof,
  readHostErrorCode,
  readHostPlatformReason,
  readHostPlatformRefusal,
  setHostProofToken,
} from './host-proof.ts'

/** 读仓库内文件；不存在返回 `null`（不 skip：调用方断言它必须存在）。 */
function readRepoFile(relative: string): string | null {
  try {
    return readFileSync(resolve(REPO_ROOT, relative), 'utf8')
  } catch {
    return null
  }
}

/** 引导响应。 */
const proofResponse = (token: string, ttlMs = 300_000): Response =>
  new Response(JSON.stringify({ proof: token, expires_at: Date.now() + ttlMs }), { status: 200, headers: { 'content-type': 'application/json' } })

/**
 * **跨端对拍**（R2-L3-11）：头名与引导路径必须与宿主 seam 的**源码字面量**一致。
 *
 * 为什么不能只断言本地常量：那正是 R2-X-1 那个 P0 的漂移模式 —— 两侧各钉自己的字面量，
 * 宿主改头名/路径时两边都绿，运行期才 401。这里读宿主的源码抽字面量来比
 * （先例：`packages/host/wasm-apps-host/src/header-spec-parity.spec.ts`、
 * `packages/host/desktop/tests/wasm-app-open-route-parity.spec.ts`）。
 *
 * **大小写口径**：HTTP 头名大小写不敏感，宿主声明的是小写 `x-pico-host-proof`，
 * 客户端按惯例写标准形态 `X-Pico-Host-Proof` ⇒ 比较前统一 `toLowerCase()`，
 * 并额外断言"宿主声明的是小写形态"（防止有人把宿主那份写成别的形态后这条对拍失去意义）。
 * 路径没有大小写问题，逐字比。
 */
const HOST_REQUEST_REPO_PATH = 'packages/host/wasm-apps-host/src/host-request.ts'
const HOST_INDEX_REPO_PATH = 'packages/host/wasm-apps-host/src/index.ts'

/** 仓库根：从本文件（`packages/client/wasm-apps/src/client/`）往上五级。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')

/**
 * 从宿主源码里抽出 {@link HOST_PROOF_HEADER} / {@link HOST_PROOF_PATH} 的对应值并比对。
 *
 * 抽法（任一处抽不到都算**问题**，不静默跳过）：
 *  - 头名：`export const HOST_PROOF_HEADER = '<字面量>'`；
 *  - 路径：`index.ts` 的 `WASM_APPS_LOCAL_PREFIX` + `host-request.ts` 的
 *    ``const proofRoute = `${options.prefix}<后缀>` `` ⇒ `<前缀><后缀>`。
 * @param hostRequestSource - `host-request.ts` 全文。
 * @param hostIndexSource - `index.ts` 全文。
 * @returns 抽到的值（抽不到为 `null`）与问题清单。
 */
export function hostProofParity(hostRequestSource: string, hostIndexSource: string): {
  header: string | null
  path: string | null
  problems: string[]
} {
  const problems: string[] = []
  const header = /export const HOST_PROOF_HEADER = '([^']+)'/u.exec(hostRequestSource)?.[1] ?? null
  if (header === null) {
    problems.push('host-request.ts 里找不到 HOST_PROOF_HEADER 的字面量（被改名/搬走了？）')
  } else {
    if (header !== header.toLowerCase()) problems.push(`宿主声明的头名不是小写形态：${header}`)
    if (header.toLowerCase() !== HOST_PROOF_HEADER.toLowerCase()) {
      problems.push(`头名不一致：宿主 ${header} vs 客户端 ${HOST_PROOF_HEADER}`)
    }
  }
  const prefix = /export const WASM_APPS_LOCAL_PREFIX = '([^']+)'/u.exec(hostIndexSource)?.[1] ?? null
  const suffix = /const proofRoute = `\$\{options\.prefix\}([^`]+)`/u.exec(hostRequestSource)?.[1] ?? null
  if (prefix === null) problems.push('index.ts 里找不到 WASM_APPS_LOCAL_PREFIX')
  if (suffix === null) problems.push('host-request.ts 里找不到 `${options.prefix}…` 形态的 proofRoute')
  const path = prefix !== null && suffix !== null ? `${prefix}${suffix}` : null
  if (path !== null && path !== HOST_PROOF_PATH) {
    problems.push(`引导路径不一致：宿主 ${path} vs 客户端 ${HOST_PROOF_PATH}`)
  }
  return { header, path, problems }
}

describe('跨端对拍：头名与引导路径 vs 宿主 seam 源码（R2-L3-11）', () => {
  it('头名（忽略大小写）与引导路径与宿主逐字一致', () => {
    const hostRequest = readRepoFile(HOST_REQUEST_REPO_PATH)
    const hostIndex = readRepoFile(HOST_INDEX_REPO_PATH)
    expect(hostRequest, `${HOST_REQUEST_REPO_PATH} 必须存在（跨端契约的真源）`).not.toBeNull()
    expect(hostIndex, `${HOST_INDEX_REPO_PATH} 必须存在（前缀真源）`).not.toBeNull()
    const parity = hostProofParity(hostRequest!, hostIndex!)
    expect(parity.problems).toEqual([])
    expect(parity.header).toBe('x-pico-host-proof')
    expect(parity.path).toBe(HOST_PROOF_PATH)
    // 客户端一侧的形态是标准写法（对拍按小写比较，见本节注释）。
    expect(HOST_PROOF_HEADER).toBe('X-Pico-Host-Proof')
  })

  /**
   * 自证：这条对拍**真的**会因为宿主改动而红（不接触宿主文件：在内存里改写读到的源码）。
   *
   * 为什么用内存改写而不是改磁盘：宿主此刻正被 L2 改（它会交 R2-X-3/4 的端到端判据），
   * 短暂写它的文件有并发覆盖风险；而断言消费的就是"读到的这段文本"，内存改写足以证明
   * 它非空洞（先例：`appcfg-contract.spec.ts` 的 `mutateCatalog` 自证）。
   */
  it('自证：宿主头名改一个字母 / 前缀改掉 ⇒ 对拍报错（判据非空洞）', () => {
    const hostRequest = readRepoFile(HOST_REQUEST_REPO_PATH)!
    const hostIndex = readRepoFile(HOST_INDEX_REPO_PATH)!
    expect(hostProofParity(hostRequest, hostIndex).problems).toEqual([])
    // ① 头名改一个字母。
    const typoHeader = hostRequest.replace("export const HOST_PROOF_HEADER = 'x-pico-host-proof'", "export const HOST_PROOF_HEADER = 'x-pico-host-prooof'")
    const headerProblems = hostProofParity(typoHeader, hostIndex).problems
    expect(headerProblems.some(problem => problem.includes('头名不一致'))).toBe(true)
    // ② 前缀改掉（路径随之变）。
    const typoPrefix = hostIndex.replace("export const WASM_APPS_LOCAL_PREFIX = '/api/pico/wasm-apps'", "export const WASM_APPS_LOCAL_PREFIX = '/api/pico/wasm-app'")
    const pathProblems = hostProofParity(hostRequest, typoPrefix).problems
    expect(pathProblems.some(problem => problem.includes('引导路径不一致'))).toBe(true)
    // ③ 宿主把 proofRoute 的后缀改名。
    const typoSuffix = hostRequest.replace('const proofRoute = `${options.prefix}/host-proof`', 'const proofRoute = `${options.prefix}/host-proofs`')
    expect(hostProofParity(typoSuffix, hostIndex).problems.some(problem => problem.includes('引导路径不一致'))).toBe(true)
    // ④ 抽不出来（函数被搬走）⇒ 也算问题，不静默跳过。
    expect(hostProofParity('', hostIndex).problems.length).toBeGreaterThan(0)
  })

  it('本地常量本身是冻结形态（宿主对拍见上一条）', () => {
    expect(HOST_PROOF_HEADER).toBe('X-Pico-Host-Proof')
    expect(HOST_PROOF_PATH).toBe('/api/pico/wasm-apps/host-proof')
  })

  it('响应解析：只有 {"proof","expires_at"} 齐全才算拿到', () => {
    expect(parseHostProof({ proof: 'tok', expires_at: 1 })).toEqual({ token: 'tok', expiresAt: 1 })
    for (const bad of [null, {}, { proof: 'x' }, { expires_at: 1 }, { proof: '', expires_at: 1 }, { proof: 'x', expires_at: 'soon' }, [1]]) {
      expect(parseHostProof(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('缓存与提前量', () => {
  it('有效期内复用；进入提前量窗口即视为不可用', () => {
    clearHostProofToken()
    setHostProofToken({ token: 'tok', expiresAt: 1_000_000 })
    expect(hostProofToken(1_000_000 - HOST_PROOF_SKEW_MS - 1)).toBe('tok')
    // 临期（只剩 < 提前量）⇒ 不再复用：宁可多取一枚，也不把"刚过期"发出去。
    expect(hostProofToken(1_000_000 - HOST_PROOF_SKEW_MS + 1)).toBeNull()
    expect(hostProofToken(1_000_000 + 1)).toBeNull()
    clearHostProofToken()
    expect(hostProofToken()).toBeNull()
  })

  it('缓存命中时不发请求；force 一定再取一枚', async () => {
    clearHostProofToken()
    let issued = 0
    const fetchImpl = (async () => { issued += 1; return proofResponse(`tok-${String(issued)}`) }) as unknown as typeof fetch
    const first = await ensureHostProof({ fetch: fetchImpl })
    expect(first?.token).toBe('tok-1')
    expect(issued).toBe(1)
    // 缓存命中：不再请求。
    const cached = await ensureHostProof({ fetch: fetchImpl })
    expect(cached?.token).toBe('tok-1')
    expect(issued).toBe(1)
    // 强制重取（401 重放路径）。
    const forced = await ensureHostProof({ fetch: fetchImpl, force: true })
    expect(forced?.token).toBe('tok-2')
    expect(issued).toBe(2)
  })

  it('并发引导只发一次请求（重试风暴防线）', async () => {
    clearHostProofToken()
    let issued = 0
    const fetchImpl = (async () => {
      issued += 1
      await new Promise(resolve => setTimeout(resolve, 5))
      return proofResponse('tok-concurrent')
    }) as unknown as typeof fetch
    const [a, b, c] = await Promise.all([
      ensureHostProof({ fetch: fetchImpl }),
      ensureHostProof({ fetch: fetchImpl }),
      ensureHostProof({ fetch: fetchImpl, force: true }),
    ])
    expect(issued).toBe(1)
    expect(a?.token).toBe('tok-concurrent')
    expect(b?.token).toBe('tok-concurrent')
    expect(c?.token).toBe('tok-concurrent')
  })
})

describe('失败分档（可辨原因，不抛穿）', () => {
  it('403 ⇒ refused（浏览器会话证明缺失）；503 ⇒ unavailable；非 JSON ⇒ malformed', async () => {
    clearHostProofToken()
    const cases: Array<[Response, string, number]> = [
      [new Response('{"error":"browser session proof required"}', { status: 403 }), 'refused', 403],
      [new Response('{"error":"browser session proof unavailable"}', { status: 503 }), 'unavailable', 503],
      [new Response('<html>nope</html>', { status: 200 }), 'malformed', 200],
    ]
    for (const [response, reason, status] of cases) {
      clearHostProofToken()
      const result = await ensureHostProof({ fetch: (async () => response.clone()) as unknown as typeof fetch })
      expect(result, reason).toBeNull()
      expect(hostProofFailure()?.reason, reason).toBe(reason)
      expect(hostProofFailure()?.status, reason).toBe(status)
    }
  })

  it('网络异常 ⇒ transport（status null）', async () => {
    clearHostProofToken()
    const result = await ensureHostProof({ fetch: (async () => { throw new TypeError('ECONNREFUSED') }) as unknown as typeof fetch })
    expect(result).toBeNull()
    expect(hostProofFailure()?.reason).toBe('transport')
    expect(hostProofFailure()?.status).toBeNull()
  })

  it('成功引导会清掉上一次的失败记录', async () => {
    clearHostProofToken()
    await ensureHostProof({ fetch: (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch })
    expect(hostProofFailure()).not.toBeNull()
    await ensureHostProof({ fetch: (async () => proofResponse('tok')) as unknown as typeof fetch, force: true })
    expect(hostProofFailure()).toBeNull()
  })
})

describe('错误码读取与分流', () => {
  it('两种信封形态都能读出码（字符串 error / 嵌套 code）', () => {
    expect(readHostErrorCode({ error: 'proof_required' })).toBe('proof_required')
    expect(readHostErrorCode({ error: { code: 'AUTH_REQUIRED' } })).toBe('AUTH_REQUIRED')
    expect(readHostErrorCode({ code: 'proof_expired' })).toBe('proof_expired')
    expect(readHostErrorCode({})).toBeNull()
    expect(readHostErrorCode(null)).toBeNull()
  })

  it('只有 proof_* 才算"值得重取令牌"（AUTH_REQUIRED 该去登录）', () => {
    expect(isHostProofErrorCode('proof_required')).toBe(true)
    expect(isHostProofErrorCode('proof_expired')).toBe(true)
    expect(isHostProofErrorCode('proof_mismatch')).toBe(true)
    expect(isHostProofErrorCode('AUTH_REQUIRED')).toBe(false)
    expect(isHostProofErrorCode(null)).toBe(false)
  })
})

/**
 * **平台拒绝**与**本机证明被拒**的分流（2026-09-20 真机 P0 的误归因现场）。
 *
 * 两层用同一个字面码 `proof_required`：

 *  - 本机证明闸（`host-request.ts`）：`{"error":"proof_required"}`（字符串形态）；
 *  - 平台拒绝经 open 路由（`index.ts`）：`{error:{code:"PLATFORM_PROOF_REQUIRED",
 *    platform_code:"proof_required"}}`。
 *
 * 客户端必须靠 `PLATFORM_` 前缀分流，否则会把"服务端拒绝了这次打开"显示成
 * "本页面无法证明自己属于这个客户端窗口（因此没有发出任何请求）"。
 *
 * ---- 变异验证 ----
 *  - 去掉前缀判定（`readHostPlatformRefusal` 恒返回 null）⇒「平台形态必须被认出来」红；
 *  - 把 `isHostProofErrorCode` 放宽成 `code.startsWith('proof_')` 的大小写不敏感匹配
 *    ⇒「平台码不落进本机那一支」红（`PLATFORM_PROOF_REQUIRED` 会被误判成本机码）。
 */
describe('平台拒绝 vs 本机证明被拒（跨端前缀契约）', () => {
  it('宿主源码声明的前缀与客户端逐字一致（跨端对拍，缺失即失败）', () => {
    const hostIndex = readRepoFile(HOST_INDEX_REPO_PATH)
    expect(hostIndex, `${HOST_INDEX_REPO_PATH} 必须存在（前缀真源）`).not.toBeNull()
    const declared = /export const PLATFORM_REFUSAL_CODE_PREFIX = '([^']+)'/u.exec(hostIndex!)?.[1] ?? null
    expect(declared).not.toBeNull()
    expect(declared).toBe(PLATFORM_REFUSAL_CODE_PREFIX)
    expect(PLATFORM_REFUSAL_CODE_PREFIX).toBe('PLATFORM_')
    // 自证：宿主把前缀改名 ⇒ 这条对拍必红（在内存里改写，不动磁盘）。
    const mutated = hostIndex!.replace("export const PLATFORM_REFUSAL_CODE_PREFIX = 'PLATFORM_'", "export const PLATFORM_REFUSAL_CODE_PREFIX = 'PLATFORM_ERR_'")
    expect(mutated).not.toBe(hostIndex)
    expect(/export const PLATFORM_REFUSAL_CODE_PREFIX = '([^']+)'/u.exec(mutated)?.[1]).not.toBe(PLATFORM_REFUSAL_CODE_PREFIX)
  })

  it('平台形态被认出来，本机形态不被误认（两种信封 + 只有原码的回落形态）', () => {
    expect(readHostPlatformRefusal({ error: { code: 'PLATFORM_PROOF_REQUIRED', platform_code: 'proof_required' } })).toBe('proof_required')
    // 只有前缀码时按"摘前缀小写"还原（宿主版本不同也不至于把平台拒绝当成未登录）。
    expect(readHostPlatformRefusal({ error: { code: 'PLATFORM_APP_NOT_FOUND' } })).toBe('app_not_found')
    // 本机证明闸的两种形态都**不是**平台拒绝。
    expect(readHostPlatformRefusal({ error: 'proof_required' })).toBeNull()
    expect(readHostPlatformRefusal({ error: { code: 'proof_required' } })).toBeNull()
    expect(readHostPlatformRefusal({ error: { code: 'AUTH_REQUIRED' } })).toBeNull()
    expect(readHostPlatformRefusal(null)).toBeNull()
    expect(readHostPlatformRefusal({})).toBeNull()
  })

  it('平台码不会落进"本机证明被拒"那一支（大小写/前缀都不能混）', () => {
    // 本机码判定是**精确匹配**：带前缀的码必须为 false，否则平台拒绝会被路由到本机文案。
    expect(isHostProofErrorCode('PLATFORM_PROOF_REQUIRED')).toBe(false)
    expect(isHostProofErrorCode(readHostErrorCode({ error: { code: 'PLATFORM_PROOF_REQUIRED', platform_code: 'proof_required' } }))).toBe(false)
  })

  it('platform_code 一律归一化为小写（宿主透传的是**混合大小写**的平台码表）', () => {
    // 真机形状：平台码 `NOT_FOUND` 大写、`proof_required` 小写，宿主原样放进
    // `platform_code` ⇒ 不归一化就会"同一个码按大小写分流"。
    expect(readHostPlatformRefusal({ error: { code: 'PLATFORM_NOT_FOUND', platform_code: 'NOT_FOUND' } })).toBe('not_found')
    expect(readHostPlatformRefusal({ error: { code: 'PLATFORM_PROOF_REQUIRED', platform_code: 'PROOF_REQUIRED' } })).toBe('proof_required')
    // 归一化后 `proof_` 前缀判定才对得上（否则 401 的平台拒绝会被显示成"未登录"）。
    expect(readHostPlatformRefusal({ error: { code: 'PLATFORM_PROOF_REQUIRED', platform_code: 'PROOF_REQUIRED' } })?.startsWith('proof_')).toBe(true)
  })
})

/**
 * **冻结 vs 不存在**：平台把两档放进**同一个 HTTP 404 + 同一个 `NOT_FOUND`**
 * （`server/internal/wasmapp/api/open.go:76-105`，不泄露存在性），唯一区分凭据就是
 * `details.reason` ⇒ 宿主信封的 `error.platform_reason`。
 *
 * 现场缺陷：客户端只读 `platform_code`，冻结（只读快照、数据保留）与"不存在"合流，
 * 用户打开一个**仅被冻结**的应用会被告知"应用不存在（可能已被删除或改名）"，
 * 于是去找发布者要一个根本不需要重发的应用、维护者也不会去看停用记录。
 *
 * ---- 变异验证 ----
 *  - 拆掉 `readHostPlatformReason`（恒返回 null）⇒ 下面「冻结被读出来」两条红
 *    （分流点回落 not-found，"冻结 ⇒ 冻结文案"那条判据直接红）；
 *  - 把 `PLATFORM_APP_FROZEN_REASON` 改成别的字面量 ⇒「与服务端真源逐字一致」红；
 *  - 把 `readHostPlatformReason` 的"必须是平台拒绝信封"闸门去掉 ⇒
 *    「非平台信封里的同名字段不认」红（本机信封能改写平台分流）。
 */
describe('平台原因（platform_reason）：冻结 vs 不存在', () => {
  /** 服务端 open 端点的 reason 真源（只读；跨端对拍用）。 */
  const OPEN_GO_REPO_PATH = 'server/internal/wasmapp/api/open.go'

  it('客户端认的冻结字面量与服务端真源一致（跨端对拍，避免各钉自己的字面量）', () => {
    const openGo = readRepoFile(OPEN_GO_REPO_PATH)
    expect(openGo, `${OPEN_GO_REPO_PATH} 必须存在（冻结 reason 的真源）`).not.toBeNull()
    expect(PLATFORM_APP_FROZEN_REASON).toBe('app_frozen')
    expect(openGo!).toMatch(/reason\s*=\s*"app_frozen"/u)
    // 自证：服务端给这一档改名 ⇒ 这条对拍必红（在内存里改写，不动磁盘）。
    const mutated = openGo!.replace('reason = "app_frozen"', 'reason = "app_suspended"')
    expect(mutated).not.toBe(openGo)
    expect(mutated).not.toMatch(/reason\s*=\s*"app_frozen"/u)
  })

  it('宿主必须**真的**下发 platform_reason / platform_code（否则本组判据是在自造信封上报绿）', () => {
    // 判据绑宿主真源：宿主哪天不再搬这两个字段，上面的信封就只是"客户端希望的形状"，
    // 这里必须红 —— 否则一次宿主侧删除会让整组冻结用例静默失去意义。
    const hostIndex = readRepoFile(HOST_INDEX_REPO_PATH)
    expect(hostIndex, `${HOST_INDEX_REPO_PATH} 必须存在（信封真源）`).not.toBeNull()
    expect(hostIndex!).toMatch(/platform_reason:\s*gate\.reason/u)
    expect(hostIndex!).toMatch(/platform_code:\s*gate\.code/u)
    // 自证：宿主删掉 reason 透传（或改名）⇒ 这条必红（内存改写，不动磁盘）。
    const stripped = hostIndex!.replace('platform_reason: gate.reason', 'reason_dropped: gate.reason')
    expect(stripped).not.toBe(hostIndex)
    expect(stripped).not.toMatch(/platform_reason:\s*gate\.reason/u)
  })

  it('宿主真实信封：读出 platform_reason；缺省 / 非平台信封 ⇒ null（确定性，不猜）', () => {
    // 宿主 index.ts 封装后的**逐字**形状（`platform_reason` 只在存在时出现）。
    expect(readHostPlatformReason({ error: { code: 'PLATFORM_NOT_FOUND', platform_code: 'NOT_FOUND', platform_reason: 'app_frozen' } })).toBe('app_frozen')
    // 同码同状态的另一档（软删 / 从未登记）。
    expect(readHostPlatformReason({ error: { code: 'PLATFORM_NOT_FOUND', platform_code: 'NOT_FOUND', platform_reason: 'app_not_found' } })).toBe('app_not_found')
    // 摘前缀形态（只有 `code`，旧宿主）同样容忍。
    expect(readHostPlatformReason({ error: { code: 'PLATFORM_NOT_FOUND', platform_reason: 'app_frozen' } })).toBe('app_frozen')
    // 归一化：任一侧大小写/空白漂移都不改变分流。
    expect(readHostPlatformReason({ error: { code: 'PLATFORM_NOT_FOUND', platform_code: 'NOT_FOUND', platform_reason: ' App_Frozen ' } })).toBe('app_frozen')
    // 缺原因（旧宿主 / 平台没下发）⇒ null：调用方按 not-found **确定性回落**，
    // 既不"未知即崩溃"也不"未知即静默成功"。
    expect(readHostPlatformReason({ error: { code: 'PLATFORM_NOT_FOUND', platform_code: 'NOT_FOUND' } })).toBeNull()
    expect(readHostPlatformReason({ error: { code: 'PLATFORM_NOT_FOUND', platform_code: 'NOT_FOUND', platform_reason: '' } })).toBeNull()
    expect(readHostPlatformReason({ error: { code: 'PLATFORM_NOT_FOUND', platform_code: 'NOT_FOUND', platform_reason: '   ' } })).toBeNull()
    // 非平台信封里的同名字段**不认**：理由字段与"是不是平台拒绝"必须出自同一判定。
    expect(readHostPlatformReason({ error: 'proof_required' })).toBeNull()
    expect(readHostPlatformReason({ error: { code: 'proof_required', platform_reason: 'app_frozen' } })).toBeNull()
    expect(readHostPlatformReason({ error: { code: 'AUTH_REQUIRED', platform_reason: 'app_frozen' } })).toBeNull()
    expect(readHostPlatformReason(null)).toBeNull()
    expect(readHostPlatformReason({})).toBeNull()
    expect(readHostPlatformReason({ error: null })).toBeNull()
  })
})

describe('令牌的存放边界（安全不变量）', () => {
  it('模块源码里没有任何存储/日志出口（只在内存）', () => {
    const source = readFileSync(new URL('./host-proof.ts', import.meta.url), 'utf8')
    for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB', 'console.log', 'console.info', 'console.warn']) {
      expect(source, `host-proof.ts 不得出现 ${forbidden}`).not.toContain(forbidden)
    }
  })
})
