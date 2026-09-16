import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { inspectErrorReportingDsn, validateErrorReportingDsn } from './dsn'

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
    const got = inspectErrorReportingDsn('https://my-public-key@glitchtip.example.com:8443/sentry/7')
    expect(got.storeEndpoint).toBe('https://glitchtip.example.com:8443/sentry/api/7/store/')
    expect(got.storeEndpoint).not.toContain('my-public-key')
    expect(got.host).toBe('glitchtip.example.com')
    expect(got.projectId).toBe('7')
  })
})
