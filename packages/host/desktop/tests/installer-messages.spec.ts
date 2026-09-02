import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

describe('Windows assisted installer messages', () => {
  it('sets a clearer message for the slow install stage', () => {
    const messages = parse(readFileSync(new URL('../../../../brands/official/assistedMessages.yml', import.meta.url), 'utf8')) as {
      installing?: Record<string, string>
    }

    expect(messages.installing?.zh_CN).toBe('PicoAide Harness 正在安装，可能需要几分钟；请保持此窗口打开。')
    expect(messages.installing?.en).toContain('This may take several minutes')
  })
})
