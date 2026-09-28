/**
 * tests/auth-401-classification.spec.ts — R21-A2-01（客户端一半）的仓内回归判据。
 *
 * ## 缺陷原形态
 *
 * `fetchJSON` 此前把**任何** 401（或任何带 `AUTH_REQUIRED`/`AUTH_FAILED` 码的响应）
 * 都翻成 `AuthError('auth_expired')`，而 auth-gate 有 13 处
 * `cause.kind === 'auth_expired' ⇒ ctx.picoSession.clear()`，`clear()` 会**删掉磁盘上的
 * `$DSH_HOME/session.json`**。两类误判的后果都不是"多一条错误提示"：
 *
 *  - **401 的其它码**（例：`AUDITOR_NOT_ALLOWED` = 账号类型被拒，凭据本身没问题）：
 *    本该只回一条"请用管理后台"的错误，却把用户登出并抹掉本机令牌；
 *  - **5xx 带 `AUTH_FAILED`/`AUTH_REQUIRED` 码**（服务端那一半由 FIX-2 改成"存储故障回
 *    500"）：一次认证存储抖动就让全体在线员工的客户端删掉令牌（LDAP/OIDC 还要重走 IdP）。
 *
 * ## 判据
 *
 *  1. 只有 **401 + "令牌无效"形状**（`AUTH_FAILED` / `AUTH_REQUIRED`，或服务端没给码的
 *     老形态）才是 `auth_expired`（正向对照：真的令牌失效仍会登出）；
 *  2. 401 的其它码（`AUDITOR_NOT_ALLOWED`）与非 401 状态（500/503，即使带着这两个码）
 *     一律是普通 `ApiError` —— 不触发登出、不删令牌；
 *     （登录面另有一条专门路径：`login()` 自己按 `AUDITOR_NOT_ALLOWED` 给"请用管理后台"
 *     的文案，不经过 `fetchJSON` —— 本次改动不影响它。）
 *  3. 既有契约不被破坏：403 `PASSWORD_CHANGE_REQUIRED` 仍按码透出（auth-gate 靠它把
 *     用户送回改密页）。
 *
 * ## 变异验证
 *
 * 把 `tokenInvalid` 换回 `res.status === 401 || code === 'AUTH_REQUIRED' || code === 'AUTH_FAILED'`
 * ⇒ 第 2 组红；只留 `res.status === 401`（不看码）⇒ `AUDITOR_NOT_ALLOWED` 用例红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, AuthError, fetchJSON, PASSWORD_CHANGE_REQUIRED_CODE } from '../src/server-connector/auth.ts'

const SERVER = 'https://harness.example'

/** 让网关返回一个固定响应（不出网）。 */
function stubResponse(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })))
}

async function call(server = SERVER): Promise<unknown> {
  return await fetchJSON(server, '/api/client/v2/capabilities?source=market', { token: 'TOKEN' })
    .then(() => undefined, (error: unknown) => error)
}

afterEach(() => { vi.unstubAllGlobals() })

describe('R21-A2-01 401 分类：只有"令牌无效"才清会话（其余不得登出）', () => {
  it('正向对照：401 AUTH_FAILED / AUTH_REQUIRED / 老形态无码 ⇒ auth_expired（仍会登出）', async () => {
    for (const [label, body] of [
      ['AUTH_FAILED', { error: { code: 'AUTH_FAILED', message: '会话无效或已过期' } }],
      ['AUTH_REQUIRED', { error: { code: 'AUTH_REQUIRED', message: '未登录' } }],
      ['无码（老服务端）', { error: { message: 'unauthorized' } }],
    ] as ReadonlyArray<readonly [string, unknown]>) {
      stubResponse(401, body)
      const error = await call()
      expect(error, label).toBeInstanceOf(AuthError)
      expect((error as AuthError).kind, label).toBe('auth_expired')
    }
  })

  it('其它 401 码（例：AUDITOR_NOT_ALLOWED = 账号类型被拒）⇒ 普通 ApiError（不许登出并删令牌）', async () => {
    stubResponse(401, { error: { code: 'AUDITOR_NOT_ALLOWED', message: 'auditor cannot modify' } })
    const error = await call()
    expect(error, '账号类型被拒 ≠ 令牌无效（凭据本身有效）').toBeInstanceOf(ApiError)
    expect((error as AuthError).kind).toBeUndefined()
    expect((error as ApiError).code).toBe('AUDITOR_NOT_ALLOWED')
    expect((error as ApiError).status).toBe(401)
  })

  it('非 401 状态（500/503）即使带 AUTH_FAILED/AUTH_REQUIRED 码也不得当成 auth_expired', async () => {
    for (const [status, code] of [[500, 'AUTH_FAILED'], [500, 'AUTH_REQUIRED'], [503, 'AUTH_FAILED']] as ReadonlyArray<readonly [number, string]>) {
      stubResponse(status, { error: { code, message: '认证存储不可用' } })
      const error = await call()
      expect(error, `${status} ${code} 是服务端故障，不是令牌无效`).toBeInstanceOf(ApiError)
      expect((error as ApiError).code).toBe(code)
      expect((error as ApiError).status).toBe(status)
    }
  })

  it('既有契约不退化：403 PASSWORD_CHANGE_REQUIRED 仍按码透出（auth-gate 靠它送回改密页）', async () => {
    stubResponse(403, { error: { code: PASSWORD_CHANGE_REQUIRED_CODE, message: '请先修改密码' } })
    const error = await call()
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe(PASSWORD_CHANGE_REQUIRED_CODE)
  })
})
