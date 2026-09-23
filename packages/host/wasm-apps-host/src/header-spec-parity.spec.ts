/**
 * 头白名单的**跨包对拍**（R1-CLI-5 / 接缝 J5）：真源 = 服务端 Go 生成物
 * `server/internal/wasmapp/api/wasm-app-headers.json`（由
 * `go generate ./internal/wasmapp/api` 从 `headerspec.go` 生成，客户端不得手改）。
 *
 * 为什么必须有这条用例：客户端曾经是**短黑名单**（"除这些之外全放"），而 Chromium 每个
 * 请求都自带 `sec-ch-ua*`/`priority`/`accept-encoding` —— 黑名单永远列不全 ⇒ 多出来的头
 * 被塞进信封 ⇒ 服务端按白名单拒 ⇒ **整次导航 400**（本地开发很难撞上，真机必现）。
 * L1 提交那份生成物的唯一目的就是让这条对拍成立（其注释明写"不提交就有意的红"）。
 *
 * 变异验证：把 {@link FORWARDED_REQUEST_HEADERS} 里任一项删掉、或加一项 ⇒ 必红。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_REQUEST_BODY_MAX_BYTES,
  APP_RESPONSE_BODY_GUARANTEED_BYTES,
  FORWARDED_REQUEST_HEADERS,
  REQUEST_HEADER_COUNT_MAX,
  REQUEST_HEADER_VALUE_MAX_BYTES,
  forwardableRequestHeaders,
} from './app-protocol.ts'

const REPO = join(__dirname, '../../../..')

/** 生成物（**必须存在**：缺失是失败，不是跳过 —— 静默跳过等于把这条判据关掉）。 */
function headerSpec(): {
  schema: string
  request_headers: string[]
  limits: Record<string, number>
  platform_headers: Record<string, string>
} {
  const raw = readFileSync(join(REPO, 'server/internal/wasmapp/api/wasm-app-headers.json'), 'utf8')
  const parsed = JSON.parse(raw) as { schema?: unknown }
  // schema 不匹配 ⇒ 显式失败（生成物换了版本就说明契约变了，必须有人来对齐）。
  expect(parsed.schema).toBe('picoaide-wasm-app-headers/1')
  return parsed as ReturnType<typeof headerSpec>
}

describe('请求头白名单：与服务端生成物逐字对拍（CLI-5 / J5）', () => {
  it('客户端转发的头集合逐字等于 request_headers（顺序与大小写都不许漂移）', () => {
    const spec = headerSpec()
    expect([...FORWARDED_REQUEST_HEADERS]).toEqual(spec.request_headers)
  })

  it('条数与单值闸门等于服务端 limits（24 / 8192）', () => {
    const limits = headerSpec().limits
    expect(REQUEST_HEADER_COUNT_MAX).toBe(limits.header_count_max)
    expect(REQUEST_HEADER_VALUE_MAX_BYTES).toBe(limits.header_value_bytes_max)
  })

  // A-7（2026-09-23 R3-A 审计，P2）：**体积两个数此前从不跨端对拍** —— 服务端
  // `response_body_bytes_max` 已经改成"保证可交付"的 168 KiB，而客户端仍写着 8 MiB，
  // 两端永远不会因为漂移变红。这条把两个方向都钉住（请求体 + 响应体）。
  it('体积闸门（请求体 / 保证可交付响应体）与服务端生成物逐字一致', () => {
    const limits = headerSpec().limits
    expect(APP_REQUEST_BODY_MAX_BYTES).toBe(limits.request_body_bytes_max)
    expect(APP_RESPONSE_BODY_GUARANTEED_BYTES).toBe(limits.response_body_bytes_max)
  })

  it('身份/凭据/浏览器内部头永远不进信封（正负对照）', () => {
    const headers = new Headers({
      authorization: 'Bearer x',
      cookie: 'a=1',
      host: 'evil.example',
      referer: 'https://evil.example/',
      'accept-encoding': 'gzip',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'sec-fetch-user': '?1',
      'sec-ch-ua': '"Chromium"',
      priority: 'u=0',
      accept: 'application/json',
      'user-agent': 'probe/1',
    })
    const forwarded = forwardableRequestHeaders(headers)
    for (const forbidden of [
      'authorization', 'cookie', 'host', 'referer', 'accept-encoding',
      'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
      'sec-ch-ua', 'priority',
    ]) {
      expect(forwarded, forbidden).not.toHaveProperty(forbidden)
    }
    // 正向对照（防假绿）：白名单里的头确实被转发。
    expect(forwarded).toEqual({
      accept: 'application/json',
      'user-agent': 'probe/1',
      ...(forwarded.origin === undefined ? {} : { origin: forwarded.origin }),
    })
  })

  it('平台头（app-proof / 版本头）由平台侧定义，不进应用请求头白名单', () => {
    const spec = headerSpec()
    // 这两个是**宿主→平台**的头（§5.1/§20），应用请求信封里绝不能出现。
    expect(spec.platform_headers.proof_request).toBe('X-Pico-App-Proof')
    expect(spec.platform_headers.app_version_response).toBe('X-PicoAide-App-Version')
    for (const platformHeader of Object.values(spec.platform_headers)) {
      expect(FORWARDED_REQUEST_HEADERS).not.toContain(platformHeader.toLowerCase())
    }
  })
})
