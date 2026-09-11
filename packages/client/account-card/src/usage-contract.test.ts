/**
 * 契约回归(2026-09-11):`/auth/usage` 的形状此前没有真源也没有校验。
 * 这里钉住三件事:
 *   1. 合法载荷被解析并归一化(只取已知键,忽略服务端新增字段);
 *   2. 缺字段/类型不符一律返回 null(而不是把 undefined 漏进渲染层);
 *   3. 键集合与服务端 Go handler 完全一致(由服务端测试反向对拍同一常量)。
 */
import { describe, expect, it } from 'vitest'
import { parseUsagePayload, USAGE_PAYLOAD_KEYS, type UsagePayload } from './usage-contract.ts'

const VALID: UsagePayload = {
  balance_money: 88.5,
  balance_activated: true,
  balance_enabled: true,
  balance_monthly: 100,
  balance_mode: 'add',
  is_admin: false,
  monthly_usage: 120_000,
  monthly_cost: 9.2,
  today_usage: 4_000,
  today_cost: 0.35,
  yesterday_usage: 10_000,
  yesterday_cost: 0.8,
  total_usage: 500_000,
  total_cost: 40.1,
}

describe('usage contract', () => {
  it('parses a valid payload and drops unknown server fields', () => {
    const out = parseUsagePayload({ ...VALID, some_future_field: 'x' })
    expect(out).toStrictEqual(VALID)
    expect(out).not.toBeNull()
    expect(Object.keys(out!)).toHaveLength(USAGE_PAYLOAD_KEYS.length)
  })

  it('rejects non-objects', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      expect(parseUsagePayload(bad)).toBeNull()
    }
  })

  it('rejects missing numbers and wrong types instead of leaking undefined', () => {
    const { balance_money: _drop, ...missing } = VALID
    expect(parseUsagePayload(missing)).toBeNull()
    expect(parseUsagePayload({ ...VALID, balance_money: '88.5' })).toBeNull()
    expect(parseUsagePayload({ ...VALID, balance_money: Number.NaN })).toBeNull()
    expect(parseUsagePayload({ ...VALID, balance_activated: 'yes' })).toBeNull()
    expect(parseUsagePayload({ ...VALID, balance_mode: 1 })).toBeNull()
  })

  it('accepts the not-activated shape (balance 0, no monthly grant)', () => {
    const out = parseUsagePayload({
      ...VALID, balance_money: 0, balance_activated: false, balance_enabled: false, balance_monthly: 0,
    })
    expect(out).not.toBeNull()
    expect(out!.balance_activated).toBe(false)
  })

  it('USAGE_PAYLOAD_KEYS 覆盖全部字段(与服务端 handler 的键集合对齐)', () => {
    expect([...USAGE_PAYLOAD_KEYS].sort()).toStrictEqual(Object.keys(VALID).sort())
  })
})
