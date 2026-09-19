/**
 * 超时预算序关系的跨包对拍（§13.2 判据①；台账 R1-L2-3）。
 *
 * 判据原文：**客户端出站超时（30 s）> `GuestBudget`（10 s）> `SQLStatementBudget`（5 s）>
 * `AppDBBusyTimeout`（3 s）**。为什么是硬要求（§5.1）：任何平台侧超时都必须**先于**客户端
 * 超时发生，否则员工只会看到"网络错误"，拿不到带 code/hints 的可读错误。
 *
 * 数值**不在这里硬编码**：真源 = 服务端生成物
 * `server/internal/wasmapp/limits/limits.json`（`go generate ./internal/wasmapp/limits`）。
 * 本用例只断言"存在 + 单位 + 严格递减" —— 改任一侧的预算都会让它红。
 *
 * 变异验证（实跑）：
 *  - `guest_budget` 10 → 60 ⇒ 必红（客户端 30 s 不再严格大于平台侧）；
 *  - `APP_REQUEST_TIMEOUT_MS` 30_000 → 5_000 ⇒ 必红。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_REQUEST_TIMEOUT_MS } from './app-protocol.ts'

const REPO = join(__dirname, '../../../..')

/** 一条 limits 项（生成物的 `items` 数组元素）。 */
interface LimitsItem {
  Key: string
  Value: string
  Unit: string
  Section: string
  Note?: string
}

/** 读生成物并按 `Key` 取一条（**缺项即失败**，不跳过 —— 静默跳过等于把判据关掉）。 */
function limitsItem(key: string): LimitsItem {
  const raw = readFileSync(join(REPO, 'server/internal/wasmapp/limits/limits.json'), 'utf8')
  const parsed = JSON.parse(raw) as { items?: LimitsItem[] }
  expect(Array.isArray(parsed.items), 'limits.json 必须有 items 数组').toBe(true)
  const item = parsed.items?.find(candidate => candidate.Key === key)
  expect(item, `limits.json 缺少 ${key}（平台侧预算改名/删除 ⇒ 本判据失效，必须来对齐）`).toBeDefined()
  return item as LimitsItem
}

/** 取秒值（单位必须是 seconds；别的单位说明生成物换了口径）。 */
function secondsOf(key: string): number {
  const item = limitsItem(key)
  expect(item.Unit, `${key} 的单位应为 seconds`).toBe('seconds')
  const value = Number(item.Value)
  expect(Number.isFinite(value), `${key} 的取值必须是数字（现在 ${item.Value}）`).toBe(true)
  return value
}

describe('超时预算序关系：客户端出站 > 平台侧全部预算（§13.2 ① / §5.1）', () => {
  it('客户端出站超时严格大于 guest / SQL / busy 三个平台预算', () => {
    const guest = secondsOf('guest_budget')
    const sql = secondsOf('sql_statement_budget')
    const busy = secondsOf('app_db_busy_timeout')
    const client = APP_REQUEST_TIMEOUT_MS / 1000

    // 严格递减：30 > 10 > 5 > 3（数值全部来自真源，不写死）。
    expect(client, `客户端出站超时 ${String(client)}s 必须严格大于 guest_budget ${String(guest)}s`).toBeGreaterThan(guest)
    expect(guest, `guest_budget ${String(guest)}s 必须严格大于 sql_statement_budget ${String(sql)}s`).toBeGreaterThan(sql)
    expect(sql, `sql_statement_budget ${String(sql)}s 必须严格大于 app_db_busy_timeout ${String(busy)}s`).toBeGreaterThan(busy)
  })

  it('平台侧预算条目本身自述的序关系与之一致（app_db_busy_timeout 的 Note 明写要小于 SQL 预算）', () => {
    const busy = limitsItem('app_db_busy_timeout')
    expect(busy.Note).toContain('sql_statement_budget')
    const guest = limitsItem('guest_budget')
    expect(guest.Section).toBe('§4.6')
    expect(limitsItem('sql_statement_budget').Section).toBe('§4.5')
  })

  it('客户端出站预算是个可解释的量级（不是 0、不是无穷）', () => {
    // 这一条防"把常量改成 0/Infinity 让上面的不等式继续成立"的假绿。
    expect(Number.isFinite(APP_REQUEST_TIMEOUT_MS)).toBe(true)
    expect(APP_REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
    expect(APP_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(120_000)
  })
})
