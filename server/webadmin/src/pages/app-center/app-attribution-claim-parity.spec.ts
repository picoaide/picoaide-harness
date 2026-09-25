/**
 * 应用归因**口径 ↔ 代码判据**的逐条对拍（R14-K · D-04，第十四轮审计 lane D 的 D-04）。
 *
 * ## 为什么必须有这条用例
 *
 * `usage.app_id` 的值**完全来自客户端请求头**（隐藏会话 id 的 `app:` 前缀），服务端
 * 原先只做形状校验 ⇒ 任何持员工 Bearer 的调用方都能把用量记到任意 app_id（含平台上
 * 根本不存在的应用），而管理端 AI 用量面板"如实统计"并显示 `attribution_available=true`。
 * 这一条本身**不是资损、不是越权**（标签不参与计价/余额/路由），但它决定了面板能不能
 * 被当作对账依据 —— 所以修法有两半，缺一不可：
 *
 *   ① **代码**：写入前校验 app_id 指向一个**真实存在且未软删**的 wasm 应用
 *      （`serverstore.SetUsageAppIDVerified`，与 UPDATE 同一个已钉事务）；
 *   ② **口径**：面板文案必须如实说出"校验了什么 / 没校验什么"，不得让人读成"已校验"。
 *
 * 只在文案里写"参考口径"而代码没校验，或代码校验了而文案仍暗示可信，**两侧都算没修完**。
 * 本用例把这条一致性做成机械判据：每条声明都必须同时命中 **Go 侧证据**与 **文案证据**，
 * 任一侧缺证据即红。
 *
 * ## 判据怎么取（不用夹具，读真源）
 *
 *   - Go 侧「代码证据」：`server/internal/llmgateway/app_attribution.go` 与
 *     `server/internal/serverstore/wasm_app_opens.go` **去掉注释后**的源码
 *     —— 注释可能过期，动作面不会；
 *   - Go 侧「口径证据」：同一个文件**保留注释**的原文（口径本来就是散文）；
 *   - 前端侧：`opens-contract.ts` 的 `AI_ATTRIBUTION_NOTE`（面板渲染的就是它）。
 *
 * ## 变异验证（改坏任一侧都必红，均已实跑）
 *
 *   - 把 `SetUsageAppIDVerified(...)` 改回 `SetUsageAppID(...)`（去掉存在性校验）
 *     ⇒ 第 1/2 条红；
 *   - 把 `deleted_at IS NULL` 从校验 SQL 里删掉 ⇒ 第 2 条红；
 *   - 把 `AI_ATTRIBUTION_NOTE` 换回"按会话链路归因…计费不受影响"（不提校验范围）
 *     ⇒ 第 3/4/5 条红；
 *   - 在文案里写"可信 / 已校验 / 不可伪造" ⇒ 负面清单条红。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AI_ATTRIBUTION_NOTE, ATTRIBUTION_SESSION_HEADER, ATTRIBUTION_SESSION_PREFIX } from './opens-contract'

/** 服务端源码根（`server/`）。与 opens-contract-parity.spec.ts 同款定位法。 */
function findServerDir(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'internal', 'llmgateway', 'app_attribution.go'))) return dir
    if (existsSync(join(dir, 'server', 'internal', 'llmgateway', 'app_attribution.go'))) {
      return join(dir, 'server')
    }
    dir = resolve(dir, '..')
  }
  throw new Error(`找不到服务端源码根（cwd=${process.cwd()}）：本用例读 Go 源码对拍，找不到真源必须红`)
}

const SERVER_DIR = findServerDir()
const ATTRIBUTION_GO = join(SERVER_DIR, 'internal', 'llmgateway', 'app_attribution.go')
const SESSION_ID_GO = join(SERVER_DIR, 'internal', 'llmgateway', 'app_session_id.go')
const STORE_GO = join(SERVER_DIR, 'internal', 'serverstore', 'wasm_app_opens.go')

for (const f of [ATTRIBUTION_GO, SESSION_ID_GO, STORE_GO]) {
  if (!existsSync(f)) throw new Error(`对拍真源缺失：${f}（缺失是失败，不是跳过 —— 静默跳过等于把判据关掉）`)
}

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

/** 去掉 Go 的行注释与块注释（判"动作面"时必须用这份：注释可能过期）。 */
function stripGoComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const attributionText = read(ATTRIBUTION_GO)
const attributionCode = stripGoComments(attributionText)
const storeText = read(STORE_GO)
const storeCode = stripGoComments(storeText)
const sessionText = read(SESSION_ID_GO)
const note = AI_ATTRIBUTION_NOTE

/** 空白归一化：SQL 里的换行/缩进不该影响判据。 */
function squeeze(s: string): string {
  return s.replace(/\s+/g, ' ')
}

/**
 * 每条声明 = 一个三元组：
 *   go     —— 必须命中的 Go 侧证据（正则，作用于去注释源码或注释原文，见 on）
 *   note   —— 必须命中的文案证据（正则，作用于 AI_ATTRIBUTION_NOTE）
 *   on     —— 'code'（去注释）| 'text'（保留注释）
 */
type Claim = { what: string; go: RegExp; note: RegExp; on: 'code' | 'text' }

const CLAIMS: Claim[] = [
  {
    what: '网关调用的是**带存在性校验**的写入入口（不是只做形状收窄的那个）',
    go: /SetUsageAppIDVerified\s*\(/,
    note: /存在性/,
    on: 'code',
  },
  {
    what: '存在性校验真的落在 SQL 上：kind=wasm_app + 未软删 + 同 app_id',
    go: /FROM apps WHERE kind = \? AND app_id = \? AND deleted_at IS NULL/,
    note: /存在/,
    on: 'code',
  },
  {
    what: '形状校验来自权威解析实现（app_session_id 的唯一入口）',
    go: /AppIDFromSessionID\s*\(/,
    note: /形状/,
    on: 'code',
  },
  {
    what: '**不**校验调用方与该应用的关系（Go 口径与面板文案都必须明写）',
    go: /不校验[\s\S]{0,40}关系/,
    note: /不校验[\s\S]{0,40}关系/,
    on: 'text',
  },
  {
    what: '明确"不得用于对账 / 计费 / 授权"（参考口径而不是账）',
    go: /不得[\s\S]{0,30}(对账|计费|授权)/,
    note: /不得[\s\S]{0,30}(对账|计费|授权)/,
    on: 'text',
  },
  {
    what: '标签来源是**客户端请求头**（不是服务端可验证的事实）',
    go: /客户端请求头/,
    note: /客户端请求头/,
    on: 'text',
  },
]

describe('应用归因 · 口径与代码判据对拍（D-04）', () => {
  it('每条声明都必须同时有 Go 侧证据与文案证据（任一侧缺 ⇒ 红）', () => {
    expect(CLAIMS.length).toBeGreaterThanOrEqual(6)
    for (const c of CLAIMS) {
      const goSide = squeeze(c.on === 'code' ? attributionCode + '\n' + storeCode : attributionText + '\n' + storeText)
      expect(goSide, `Go 侧缺证据：${c.what}`).toMatch(c.go)
      expect(note, `面板文案缺证据：${c.what}`).toMatch(c.note)
    }
  })

  it('网关侧**不得**再调用不带校验的 SetUsageAppID（变异：改回去 ⇒ 红）', () => {
    // `SetUsageAppIDVerified(` 不会命中这个正则（Verified 在 `(` 之前）。
    expect(attributionCode).not.toMatch(/SetUsageAppID\s*\(/)
    // 反向自证：正则确实能命中裸调用形态（否则上面那条是恒真断言）。
    expect(stripGoComments('func f(db *sql.DB) { _ = serverstore.SetUsageAppID(db, 1, "x") }')).toMatch(
      /SetUsageAppID\s*\(/,
    )
  })

  it('文案不得出现"已可信 / 已校验 / 不可伪造"这类超出代码能力的说法', () => {
    for (const forbidden of ['可信', '已校验', '不可伪造', '无污染', '可校验的链路', '防伪造']) {
      expect(note, `文案出现超出代码能力措辞：${forbidden}`).not.toContain(forbidden)
    }
    // 也不得把归因说成 owner 校验（员工用他人应用是正常业务，owner 判据是错的）。
    expect(note.toLowerCase()).not.toContain('owner')
  })

  it('文案保留既有契约锚点（会话头名 / 前缀 / 计费归属）', () => {
    // 与 opens-contract.test.ts 的第 182 条同源：改文案不得把这三个锚点丢掉。
    expect(note).toContain(ATTRIBUTION_SESSION_HEADER)
    expect(note).toContain(ATTRIBUTION_SESSION_PREFIX)
    expect(note).toContain('计费')
    // 计费归属必须落在 user_id 一侧（唯一来自鉴权、不来自请求头的身份）。
    expect(note).toContain('user_id')
  })

  it('会话 id 模块的口径也已订正：前缀**不比自报头更可信**（不得再写"前缀有可校验的链路"）', () => {
    expect(sessionText).not.toContain('自报头没有可校验的链路，前缀有')
    expect(sessionText).toMatch(/不是\*{0,2}可信性|前缀并不比自报头/)
  })
})
