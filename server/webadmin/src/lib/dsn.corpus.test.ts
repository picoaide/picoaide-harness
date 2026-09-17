import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildStoreEndpoint,
  DSN_MAX_LENGTH,
  DSN_PROJECT_QUERY_MESSAGE,
  inspectErrorReportingDsn,
  validateErrorReportingDsn,
} from './dsn'

/**
 * 跨语言对拍测试的 **webadmin 侧一半**。
 *
 * 语料真源 = `server/internal/llmgateway/testdata/dsn_corpus.json`
 * (Go 侧 `dsn_parity_test.go` 的 `TestDSNCorpus` 读**同一份**文件)。
 * 任一侧规则漂移(为 loopback 放行、改了中文文案、动了私网判定)都会让对侧变红
 * —— 这是 P0-1(服务端权威)与 P0-2(webadmin 前置校验)"逐字一致"的机械化保证,
 * 范式同 `server/internal/serverstore/audit_r4_url_parity_test.go` 的
 * `TestConnectorBlockedNetworksMatchClientOutbound`。
 */

interface CorpusCase {
  dsn: string
  verdict: 'accept' | 'warn' | 'reject'
  message: string
  note?: string
  /**
   * 可选**逐字**锚点(2026-09-17,S10-2 修复轮 3/r3v 复核):项目 ID 与 store 端点。
   *
   * 只钉 verdict+message 抓不到"同一串两侧记不同项目 ID/端点"这类分歧 ——
   * `https://key@host/1?x=/2` 曾让服务端报项目 1 而客户端 SDK 把事件发往项目 2
   * (两边 message 都是空串,原语料完全看不见)。缺省 = 该行不锚。
   */
  project_id?: string
  store_endpoint?: string
}

// src/lib → src → webadmin → server,再进 internal/llmgateway/testdata。
const CORPUS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../internal/llmgateway/testdata/dsn_corpus.json',
)

function loadCorpus(): CorpusCase[] {
  const parsed = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as { cases: CorpusCase[] }
  return parsed.cases
}

const cases = loadCorpus()

describe('错误上报 DSN 跨语言对拍(Go dsn.go ↔ webadmin dsn.ts)', () => {
  it('语料三类齐全(accept/warn/reject 都有)', () => {
    const verdicts = new Set(cases.map((c) => c.verdict))
    expect(verdicts).toEqual(new Set(['accept', 'warn', 'reject']))
    expect(cases.length).toBeGreaterThanOrEqual(20)
  })

  it.each(cases.map((c) => [c.dsn === '' ? '<empty>' : c.dsn, c] as const))(
    '结论与文案逐字一致: %s',
    (_label, testCase) => {
      const got = inspectErrorReportingDsn(testCase.dsn)
      expect(got.verdict).toBe(testCase.verdict)
      expect(got.message).toBe(testCase.message)
      // 可选逐字锚点(项目 ID / store 端点):留空 = 该行不锚。
      if (testCase.project_id !== undefined) expect(got.projectId).toBe(testCase.project_id)
      if (testCase.store_endpoint !== undefined) expect(got.storeEndpoint).toBe(testCase.store_endpoint)

      // validateErrorReportingDsn 是页面用的薄封装,结论必须与 inspect 一致。
      const validated = validateErrorReportingDsn(testCase.dsn)
      if (testCase.verdict === 'reject') {
        expect(validated.ok).toBe(false)
        if (!validated.ok) expect(validated.message).toBe(testCase.message)
      } else {
        expect(validated.ok).toBe(true)
      }
    },
  )

  it('推导出的 store 端点不含公钥,且与 Go 侧同形', () => {
    // 2026-09-17(S10-2 修复轮 2):公钥必须是 SDK 正则的 `\w+`,所以夹具里不能用
    // `my-public-key`(含 '-' ⇒ 现在会被新规则拒,断言会全落空)。
    const got = inspectErrorReportingDsn('https://my_public_key@glitchtip.example.com:8443/sentry/7')
    expect(got.storeEndpoint).toBe('https://glitchtip.example.com:8443/sentry/api/7/store/')
    expect(got.storeEndpoint).not.toContain('my_public_key')
    expect(got.host).toBe('glitchtip.example.com')
    expect(got.projectId).toBe('7')
  })

  // 新发现 P3(StoreEndpoint 前缀,2026-09-17 修复轮 2):路径前缀取**原文** ——
  // 客户端 SDK 的 `path` 来自原始串,所以 `/%2e%2e/1` 的 ingest 端点是
  // `/%2e%2e/api/1/store/`(不是 Go 侧解码后的 `/../api/1/store/`,那会被 HTTP
  // 客户端规范化、与实际出站不一致)。与 Go 侧同名断言逐字对齐。
  it('路径前缀保持原文转义(%2e%2e 不变成 ../)', () => {
    const got = inspectErrorReportingDsn('https://key@host.example/%2e%2e/1')
    expect(got.verdict).toBe('accept')
    expect(got.projectId).toBe('1')
    expect(got.storeEndpoint).toBe('https://host.example/%2e%2e/api/1/store/')
    expect(got.storeEndpoint).not.toContain('../')
    // 普通前缀不受影响。
    expect(inspectErrorReportingDsn('https://key@host.example/sentry/7').storeEndpoint).toBe(
      'https://host.example/sentry/api/7/store/',
    )
  })

  // 项目 ID 的前导数字语义 + int64 上界(2026-09-17 修复轮 2,P3):SDK 的
  // `projectId.match(/^\d+/)` 只取前导数字,而 Go 用 `strconv.ParseInt(…, 64)`;
  // TS 必须用 BigInt 精确对齐 —— `Number.isSafeInteger`(2^53)会在 16~19 位区间
  // 误拒服务端接受的 ID,`Number() > 0` 则会在 22 位以上误收。
  it('项目 ID 取前导数字,并严格对齐 int64 上界', () => {
    const leading = inspectErrorReportingDsn('https://key@host.example/1%2F2')
    expect(leading.verdict).toBe('accept')
    expect(leading.projectId).toBe('1')
    expect(leading.storeEndpoint).toBe('https://host.example/api/1/store/')

    // 9223372036854775807 = int64 最大值:收(Number 无法精确表示,BigInt 才行)。
    const max = inspectErrorReportingDsn('https://key@host.example/9223372036854775807')
    expect(max.verdict).toBe('accept')
    expect(max.projectId).toBe('9223372036854775807')

    // 2^53+1(`Number.isSafeInteger` 为假但仍在 int64 内):必须收 —— 这条正是
    // 不能用 Number/safe-integer 近似的理由。
    const overSafeInteger = inspectErrorReportingDsn('https://key@host.example/9007199254740993')
    expect(overSafeInteger.verdict).toBe('accept')

    // 上界 +1 与更长的数字都是溢出拒绝。
    for (const overflowing of ['9223372036854775808', '9'.repeat(22), '1'.repeat(1900)]) {
      const got = inspectErrorReportingDsn(`https://key@host.example/${overflowing}`)
      expect(got.verdict).toBe('reject')
      expect(got.message).toContain('项目 ID')
    }
  })

  // S10-3(2026-09-17):`u.Hostname()` 会剥掉字面 IPv6 的方括号,拼端点时必须补回,
  // 否则连 Go 自己的 `http.NewRequest` 都构造失败(与 Go 侧同名单测逐条对齐)。
  it('推导 store 端点时补回字面 IPv6 的方括号', () => {
    expect(buildStoreEndpoint('https', '2001:db8::1', '', '', '1')).toBe('https://[2001:db8::1]/api/1/store/')
    expect(buildStoreEndpoint('http', '2001:db8::1', '8080', 'sentry', '7')).toBe(
      'http://[2001:db8::1]:8080/sentry/api/7/store/',
    )
    expect(buildStoreEndpoint('https', '::1', '', '', '1')).toBe('https://[::1]/api/1/store/')
    // 域名/IPv4 逐字不变(不引入多余方括号)。
    expect(buildStoreEndpoint('https', 'glitchtip.example.com', '', '', '1')).toBe(
      'https://glitchtip.example.com/api/1/store/',
    )
    expect(buildStoreEndpoint('http', '10.0.0.5', '', '', '1')).toBe('http://10.0.0.5/api/1/store/')
  })

  // 上限按 **UTF-8 字节** 计(与 Go `len(raw)` 同):2166 字节的长 IDN 必须先报"过长",
  // 而不是落到"SDK 解析不了 IDN"的文案 —— 按 UTF-16 长度判会在这里分叉。
  it('长度上限按 UTF-8 字节计(与 Go len() 同口径)', () => {
    expect(DSN_MAX_LENGTH).toBe(2048)
    const longIdn = `https://key@${'中'.repeat(700)}.example/1`
    expect(longIdn.length).toBeLessThan(DSN_MAX_LENGTH)
    const got = inspectErrorReportingDsn(longIdn)
    expect(got.verdict).toBe('reject')
    expect(got.message).toContain('过长')
  })

  // S10-2 修复轮 5(2026-09-17,r4v 复核):接受面从「SDK 解析得了」收紧为
  // 「SDK 真发得出去」—— 首个 `?`/`#` 出现在最后一个 '/' 之前(即落在路径前缀里)
  // 的 DSN 一律拒。这类串的 makeDsn 能成功,但 @sentry/node 的 transports/http.js
  // 对新 URL 取 `pathname+search` 发请求,pathname 里已不含 /api/<项目ID>/envelope/。
  // 与 Go 侧 TestErrorReportingDSNRejectsQueryOrFragmentInPathPrefix 逐条同构。
  it('路径前缀里的 ? / # 一律拒(否则 envelope 路径被吞掉)', () => {
    const reject = [
      'https://key@host.example/1?x=/2',
      'https://key@host.example/1#/2',
      'https://key@host.example/1?x=http://y',
      'https://key@host.example/1?a=b/c',
      'https://key@host.example/1#/a',
      'https://key@host.example/1/?x=/2',
      'https://key@host.example/?x=/2',
      'https://key@host.example/?q=1/2',
      'https://key@host.example/sentry/1?x=/2',
      'https://key@host.example/sentry/1#/2',
      'https://key@host.example//1?x=/2',
      'https://key@host.example/%2e%2e/1?x=/2',
    ]
    for (const dsn of reject) {
      const got = inspectErrorReportingDsn(dsn)
      expect(got.verdict, dsn).toBe('reject')
      expect(got.message, dsn).toBe(DSN_PROJECT_QUERY_MESSAGE)
      // 被拒的 DSN 不得留下可供"发送测试事件"出站的端点。
      expect(got.storeEndpoint, dsn).toBe('')
      const validated = validateErrorReportingDsn(dsn)
      expect(validated.ok, dsn).toBe(false)
      if (!validated.ok) expect(validated.message, dsn).toBe(DSN_PROJECT_QUERY_MESSAGE)
    }

    // `?`/`#` 只落在**项目 ID 段**里(前缀为空)不受影响:SDK 的 path 为空,
    // envelope URL 仍是干净的 /api/<项目ID>/envelope/。
    const accept: Array<[string, string, string]> = [
      ['https://key@host.example/1?x=2', '1', 'https://host.example/api/1/store/'],
      ['https://key@host.example/1#x', '1', 'https://host.example/api/1/store/'],
      ['https://key@host.example/1?', '1', 'https://host.example/api/1/store/'],
      ['https://key@host.example/1#', '1', 'https://host.example/api/1/store/'],
      ['https://key@host.example/1?x=2#y', '1', 'https://host.example/api/1/store/'],
      ['https://key@host.example/sentry/1#x', '1', 'https://host.example/sentry/api/1/store/'],
      ['https://key@host.example//1?x=2', '1', 'https://host.example/api/1/store/'],
      ['https://key@host.example/a%3Fb/1', '1', 'https://host.example/a%3Fb/api/1/store/'],
      ['https://key@host.example/a%23b/1', '1', 'https://host.example/a%23b/api/1/store/'],
    ]
    for (const [dsn, projectId, endpoint] of accept) {
      const got = inspectErrorReportingDsn(dsn)
      expect(got.verdict, dsn).toBe('accept')
      expect(got.projectId, dsn).toBe(projectId)
      expect(got.storeEndpoint, dsn).toBe(endpoint)
    }
  })

  // 投递面不变量(与 r4v 的 SDK 判据同构,Go 侧同名断言在 dsn_test.go):
  // 全部**已接受**语料行的端点,其 `new URL(...).pathname` 必须仍以
  // `/api/<项目ID>/store/` 结尾 —— 即 `?`/`#` 没有把 API 段吞进 query/fragment。
  // 客户端那半句是 `new URL(getEnvelopeEndpointWithUrlEncodedAuth(makeDsn(d))).pathname`
  // 必须含 /api/<项目ID>/envelope/(@sentry/node transports/http.js 发的就是 pathname+search)。
  it('全部已接受语料行的端点路径都保留 /api/<项目ID>/store/', () => {
    let checked = 0
    for (const testCase of cases) {
      const got = inspectErrorReportingDsn(testCase.dsn)
      if (got.verdict === 'reject') {
        expect(got.storeEndpoint, testCase.dsn).toBe('')
        continue
      }
      if (testCase.dsn.trim() === '') continue // 空串 = 未启用,没有投递面
      expect(got.storeEndpoint, testCase.dsn).not.toBe('')
      const path = new URL(got.storeEndpoint).pathname
      expect(path.endsWith(`/api/${got.projectId}/store/`), `${testCase.dsn} => ${path}`).toBe(true)
      checked += 1
    }
    expect(checked).toBeGreaterThanOrEqual(20)
  })
})
