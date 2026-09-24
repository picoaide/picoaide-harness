/**
 * R10 N6 regression — the MCP tool budget is ONE number, from ONE place.
 *
 * Before this criterion the same 120 s existed twice as a bare literal: the
 * fence's `OUTBOUND_ACTIVITY_MAX_MS` (the age after which a counted request
 * stops charging future rebuilds) and the registration's `toolCallTimeoutMs`
 * (the budget the bridge gives the call). Either side could be changed — per
 * endpoint, per transport — and nothing went red: the bookkeeping would then
 * describe a budget the call does not have (or vice versa), silently.
 *
 * Two witnesses, because either one alone is passable:
 *
 *  - **behavioural**: every registration the plugin hands to the bridge — stdio
 *    AND streamable-http — carries `toolCallTimeoutMs` equal to the exported
 *    constant, read off the captured config of a real `apply()`;
 *  - **static**: `src/index.ts` contains no numeric literal for that field
 *    anymore, so re-introducing a second value goes red even if it happens to
 *    equal today's constant (a copy is exactly how the two drift apart).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { MCP_TOOL_CALL_TIMEOUT_MS } from '../src/mcp-transport-fence.ts'
import { createHarness, FAKE_MCP_SERVER, seedCredential, waitFor } from './helpers/connector-harness.ts'
import type { ConnectorDef } from '../src/types.ts'

const harnesses: Array<{ dispose: () => void }> = []
afterEach(() => { while (harnesses.length) harnesses.pop()?.dispose() })

/** One connector with BOTH transports: the two registration sites of the budget. */
function def(id: string): ConnectorDef {
  return {
    id,
    name: 'Budget probe',
    description: 'r10 n6',
    authMode: 'token',
    tokenFields: [{ key: 'API_KEY', label: 'API key', type: 'password', required: true }],
    mcp: [
      {
        serverName: 'probe-stdio',
        transport: 'stdio',
        command: process.execPath,
        args: [FAKE_MCP_SERVER],
        env: {},
      },
      {
        serverName: 'probe-http',
        transport: 'streamable-http',
        url: 'https://harness.example.com/mcp',
        headers: {},
      },
    ],
  }
}

/** The captured configs' `toolCallTimeoutMs`, by server name. */
function budgets(h: ReturnType<typeof createHarness>): Record<string, unknown> {
  const found: Record<string, unknown> = {}
  for (const config of h.configs) {
    found[config.serverName] = (config as unknown as { toolCallTimeoutMs?: unknown }).toolCallTimeoutMs
  }
  return found
}

describe('R10 N6: the MCP tool budget has a single source', () => {
  it('every registration carries the fence\'s exported budget, not a copy of it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r10-n6-'))
    const h = createHarness([def('budget-probe')], dir, { requestApproval: () => true })
    harnesses.push(h)
    await seedCredential(dir, 'budget-probe', { accessToken: 'AT', fields: { API_KEY: 'k' } })
    h.emitSession({ username: 'user-a' })
    await waitFor(() => h.configs.length === 2, 10_000)

    const seen = budgets(h)
    expect(Object.keys(seen).sort(), '前置：两条注册都要拿到（stdio + streamable-http）')
      .toEqual(['probe-http', 'probe-stdio'])
    for (const [serverName, value] of Object.entries(seen)) {
      expect(value, `${serverName} 的 toolCallTimeoutMs 必须就是栅栏导出的那一个预算`).toBe(MCP_TOOL_CALL_TIMEOUT_MS)
    }
    // 预算本身必须是正数（配置写 0/NaN 会让闸门失去意义，而"同源"仍会满足）。
    expect(Number.isSafeInteger(MCP_TOOL_CALL_TIMEOUT_MS)).toBe(true)
    expect(MCP_TOOL_CALL_TIMEOUT_MS).toBeGreaterThan(0)
  }, 30_000)

  it('src/index.ts spells that field as the constant — no numeric literal can drift back in', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const literals = [...source.matchAll(/toolCallTimeoutMs:\s*([^,\n]+)/gu)].map(match => (match[1] ?? '').trim())
    expect(literals.length, '前置：注册处必须仍然显式给出该字段（否则这条判据空转）').toBeGreaterThanOrEqual(2)
    for (const value of literals) {
      expect(value, `toolCallTimeoutMs 又出现了字面量取值：${value}`).toBe('MCP_TOOL_CALL_TIMEOUT_MS')
    }
    // 文件里也不该再有裸的 120_000 / 120000（它是同一个预算的第二份真源）。
    expect(source, 'src/index.ts 里不得再出现裸的 120 秒预算字面量').not.toMatch(/120[_,]?000/u)
  })
})
