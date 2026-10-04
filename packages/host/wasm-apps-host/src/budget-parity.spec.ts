/**
 * 超时预算序关系的跨包对拍（§13.2 判据①；台账 R1-L2-3）。
 *
 * 判据（2026-10-01 更新）：**客户端出站超时 > `RequestWallClock`（60 s，平台最外层，
 * 含排队）> `GuestBudget`（30 s）> `SQLStatementBudget`（5 s）> `AppDBBusyTimeout`（3 s）**。
 * 为什么是硬要求（§5.1）：任何平台侧超时都必须**先于**客户端超时发生，否则员工只会看到
 * "网络错误"，拿不到带 code/hints 的可读错误。
 *
 * 最外层为什么是 `request_wall_clock` 而不是 `guest_budget`：墙钟把**排队**也算在内，
 * 是"平台最晚什么时候一定给出结论"的那个数；只要求"大于 guest"会漏掉排队把请求拖过
 * 客户端预算的那条路径（服务端此刻返回的是 APP_QUEUE_FULL + Retry-After，照样是可读错误）。
 *
 * 数值**不在这里硬编码**：真源 = 服务端生成物
 * `server/internal/wasmapp/limits/limits.json`（`go generate ./internal/wasmapp/limits`）。
 * 本用例只断言"存在 + 单位 + 严格递减" —— 改任一侧的预算都会让它红。
 *
 * 变异验证（实跑）：
 *  - `guest_budget` 30 → 90 ⇒ 必红（guest 不再小于墙钟）；
 *  - `request_wall_clock` 60 → 90 ⇒ 必红（客户端 75 s 不再严格大于平台最外层）；
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
  it('客户端出站超时严格大于平台侧全部请求预算', () => {
    const wall = secondsOf('request_wall_clock')
    const guest = secondsOf('guest_budget')
    const sql = secondsOf('sql_statement_budget')
    const busy = secondsOf('app_db_busy_timeout')
    const client = APP_REQUEST_TIMEOUT_MS / 1000

    // 严格递减：75 > 60 > 30 > 5 > 3（数值全部来自真源，不写死）。
    expect(client, `客户端出站超时 ${String(client)}s 必须严格大于 request_wall_clock ${String(wall)}s（平台最外层预算，含排队）`).toBeGreaterThan(wall)
    expect(wall, `request_wall_clock ${String(wall)}s 必须严格大于 guest_budget ${String(guest)}s`).toBeGreaterThan(guest)
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

  /**
   * **发布链路**是另一条预算链（与应用请求链并列，审计 S4-06 / CTRL-01）：
   * publish/validate 在同一个 HTTP 请求里顺序做「编译 → 抽取 → 干跑」，三段
   * **共用**一个平台侧 deadline（`publish_total_budget`）。
   *
   * 数值全部来自同一份真源（`limits.json`），不在这里写死：客户端出站预算
   * （`client_upload_timeout`，90 s）必须严格大于平台侧总预算（75 s），而总预算又必须
   * 严格大于单次编译上限（`compile_timeout`，60 s）—— 最后这条保证控制台配的
   * `compile_timeout_seconds` 仍然**可达**（不会被总预算静默截断）。
   *
   * 变异验证：把 `publish_total_budget` 抬到 ≥ `client_upload_timeout` ⇒ 红；
   * 把 `compile_timeout` 抬到 ≥ `publish_total_budget` ⇒ 红；删掉任一条目 ⇒ 红（缺项即失败）。
   * 同一组关系在服务端侧另有一条判据（`limits_gen_test.go` 的 TestCriticalValuesAndOrdering）：
   * 两端各一条，任一端漂移都能被打坏。
   */
  it('发布链路的聚合序关系：客户端出站 > 平台侧总预算 > 单次编译上限（数值来自 limits.json）', () => {
    const client = secondsOf('client_upload_timeout')
    const total = secondsOf('publish_total_budget')
    const compile = secondsOf('compile_timeout')
    expect(
      total,
      `平台侧总预算 ${String(total)}s 必须严格小于客户端出站预算 ${String(client)}s` +
        '（否则平台会把结论给在客户端预算之外：员工看到网络错误而不是结构化错误）',
    ).toBeLessThan(client)
    expect(
      total,
      `平台侧总预算 ${String(total)}s 必须严格大于编译上限 ${String(compile)}s` +
        '（否则控制台配的 compile_timeout_seconds 不可达，是一项看不见的缩水）',
    ).toBeGreaterThan(compile)
  })
})
