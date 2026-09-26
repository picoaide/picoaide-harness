import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import ServerInfo from './ServerInfo'
import { request } from '../api'

// ---------------------------------------------------------------------------
// F-03（审计 2026-09-26，P2）：`/api/server/admin/server-info` 的 `balance` / `audit`
// 健康面在 webadmin 侧**零消费方**。
//
// 缺陷形态：服务端 `internal/serverauth/sysinfo.go` 把两块健康面挂在这里，注释写明
// 是 R16C-02（余额准入拒绝证据）与 R16C-03/C-05（审计链新鲜度、审计写入缺口）三条
// P1/P2 修复**自己声明的可视化出口**（"让谁在被拒、依据是什么、差多少钱可检索"），
// 而修前 `ServerInfo.tsx` 既不声明字段也不渲染 —— 承诺零消费方，管理员在界面上
// 永远看不到有人被余额闸门挡住、也看不出审计链结论已经过期。
//
// 判据（两层）：
//   ① 本文件的**渲染级**断言：每个字段都必须真的出现在 DOM 上（值用互不相同的
//      哨兵数字/字符串，避免"匹配到别的字段"）；
//   ② `server-info-health-contract.test.ts` 的**字段级对拍**：读 Go 源
//      （sysinfo.go + serverstore 的两个结构体）的 json tag，逐个要求在 TS 接口里
//      出现 —— 单边改名即红。
//
// 变异（必须变红）：删掉 ServerInfo.tsx 里"余额闸门准入"或"审计健康"卡片
// ⇒ 对应用例红；删掉 TS 接口里的字段 ⇒ 对拍用例红。

const mockRequest = vi.mocked(request)

const baseInfo = {
  uptime_sec: 3600,
  uptime_human: '1时0分',
  go_version: 'go1.26.6',
  num_cpu: 4,
  gomaxprocs: 4,
  goroutines: 10,
  mem: { allocated_mb: 10, total_system_mb: 20, system_memory_mb: 8192 },
  load_avg: [0.1, 0.2, 0.3] as [number, number, number],
  disk: { data_path: '/data', total_gb: 100, used_gb: 20, free_gb: 80, used_pct: 20 },
  db: { driver: 'pg', tables: { users: 2 }, total_rows: 2, disk_bytes: 1024, disk_human: '1KB', schema_migrations: 48 },
  version: '2.8.2',
  update_check: null,
}

describe('ServerInfo · 余额闸门与审计健康的可视化出口(F-03)', () => {
  beforeEach(() => {
    mockRequest.mockReset()
    mockRequest.mockImplementation(async (path: string) => {
      if (path.endsWith('/concurrency')) return { checked_at: '2026-09-26T02:00:00Z', models: [] }
      return baseInfo
    })
  })

  afterEach(() => { vi.restoreAllMocks() })

  it('渲染余额准入拒绝的计数与最近一条的形状(依据/金额/账号)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.endsWith('/concurrency')) return { checked_at: '2026-09-26T02:00:00Z', models: [] }
      return {
        ...baseInfo,
        balance: {
          admission_rejections: 4242,
          last_rejection: {
            user_id: 7, username: 'zhangsan-哨兵', endpoint: 'chat', model: 'model-x',
            reason: 'min_billable', required_money: 0.03, balance_money: 0.01,
            at: '2026-09-26T01:02:03Z',
          },
        },
      }
    })
    render(<ServerInfo />)

    expect(await screen.findByText('余额闸门准入')).toBeInTheDocument()
    // 累计计数（哨兵数字）
    expect(screen.getByText('4,242')).toBeInTheDocument()
    // 最近一条的形状：账号 / 端点·模型 / 依据 / 金额 / 时刻
    expect(screen.getByText('zhangsan-哨兵')).toBeInTheDocument()
    expect(screen.getByText('chat · model-x')).toBeInTheDocument()
    expect(screen.getByText('min_billable')).toBeInTheDocument()
    expect(screen.getByText('0.03 / 0.01 元')).toBeInTheDocument()
    expect(screen.getByText('2026-09-26T01:02:03Z')).toBeInTheDocument()
  })

  it('渲染审计链的新鲜度/执行者与写入缺口(过期结论不得看着像实时结论)', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.endsWith('/concurrency')) return { checked_at: '2026-09-26T02:00:00Z', models: [] }
      return {
        ...baseInfo,
        audit: {
          chain_checked: true, chain_intact: true, chain_broken_id: 0,
          chain_checked_at: '2026-09-23T00:00:00Z',
          chain_age_seconds: 259200, chain_stale: true, chain_source: 'startup',
          chain_checks: 3, chain_rows: 5150, chain_duration_ms: 42,
          write_failures: 7, dropped_entries: 3, retries: 11,
          last_failure: {
            reason: 'entry dropped after retries', action: 'report_subscription_update',
            username: 'admin', cause: 'connection refused', cause_class: 'sqlstate:08006',
            at: '2026-09-26T00:30:00Z',
          },
        },
      }
    })
    render(<ServerInfo />)

    expect(await screen.findByText('审计健康')).toBeInTheDocument()
    expect(screen.getByText('已过期（259200 秒前）')).toBeInTheDocument()
    expect(screen.getByText('startup · 3 次 · 扫描 5150 行')).toBeInTheDocument()
    // 写入失败 / 丢弃条目（哨兵数字）
    expect(screen.getByText('7 / 3（重试 11）')).toBeInTheDocument()
    expect(screen.getByText('report_subscription_update · sqlstate:08006')).toBeInTheDocument()
  })

  it('缺字段时降级为「—」,不把"读不到"画成 0', async () => {
    render(<ServerInfo />)
    expect(await screen.findByText('余额闸门准入')).toBeInTheDocument()
    expect(screen.getByText('累计拒绝次数')).toBeInTheDocument()
    // 服务端没给 balance/audit（旧服务端）⇒ 计数列显示 —，绝不显示 0。
    const row = screen.getByText('累计拒绝次数').closest('div') as HTMLElement
    expect(row.textContent).toContain('—')
    expect(screen.getByText('链校验结论')).toBeInTheDocument()
  })

  // -------------------------------------------------------------------------
  // 第二十二轮复审 V2-B4（P3）：上面第三条只删**整块**，咬不到"块在、个别字段缺"
  // 这两种形态 —— 而它们各自是一个真实缺陷：
  //   ① `chain_stale` 缺 ⇒ 修前渲染「有效（999999 秒前）」（fail-open：读不到的结论
  //      被画成"有效"，而兄弟字段 `chain_intact` 缺时走的是"断链" fail-closed）；
  //   ② `balance` 块在但 `admission_rejections` 缺 ⇒ 修前 `undefined.toLocaleString()`
  //      ⇒ **整页 TypeError**。
  // 修后统一按"未知"渲染（本页约定 = `—`），既不说"有效"也不崩。
  // 变异（必须变红）：把 `chainFreshnessText` 退回 `audit.chain_stale ? … : '有效（…）'`
  // ⇒ ①红；把 `numOrDash(info.balance?.admission_rejections)` 退回
  // `info.balance ? info.balance.admission_rejections.toLocaleString() : '—'` ⇒ ②红。
  // -------------------------------------------------------------------------

  it('chain_stale 缺失 ⇒ 新鲜度渲染"未知"，绝不画成"有效"', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.endsWith('/concurrency')) return { checked_at: '2026-09-26T02:00:00Z', models: [] }
      return {
        ...baseInfo,
        audit: {
          // 块在、结论也在，**只缺** `chain_stale`（字段改名 / 老服务端 / 部分部署）。
          chain_checked: true, chain_intact: true, chain_broken_id: 0,
          chain_age_seconds: 999999, chain_source: 'periodic',
          chain_checks: 3, chain_rows: 5150, chain_duration_ms: 42,
          write_failures: 0, dropped_entries: 0, retries: 0,
        },
      }
    })
    render(<ServerInfo />)

    expect(await screen.findByText('审计健康')).toBeInTheDocument()
    // 兄弟字段仍然照旧渲染（证明这是"部分缺失"而不是整块缺失）。
    expect(screen.getByText('完整')).toBeInTheDocument()
    const row = screen.getByText('结论新鲜度').closest('div') as HTMLElement
    expect(row.textContent).toContain('—')
    expect(row.textContent).not.toContain('有效')
    expect(row.textContent).not.toContain('已过期')
  })

  it('balance 块在但 admission_rejections 缺失 ⇒ 不崩、渲染"未知"', async () => {
    mockRequest.mockImplementation(async (path: string) => {
      if (path.endsWith('/concurrency')) return { checked_at: '2026-09-26T02:00:00Z', models: [] }
      return {
        ...baseInfo,
        balance: {
          // 缺 `admission_rejections`；`last_rejection` 在（证明是部分缺失）。
          last_rejection: {
            user_id: 7, username: 'zhangsan-哨兵', endpoint: 'chat', model: 'model-x',
            reason: 'min_billable', required_money: 0.03, balance_money: 0.01,
            at: '2026-09-26T01:02:03Z',
          },
        },
        audit: {
          chain_checked: true, chain_intact: true, chain_broken_id: 0,
          chain_age_seconds: 12, chain_stale: false, chain_source: 'startup',
          // 审计计数同样缺失：不得把 `undefined` 渲染进 DOM。
        },
      }
    })
    render(<ServerInfo />)

    expect(await screen.findByText('余额闸门准入')).toBeInTheDocument()
    // 页面没有崩（能渲染出块内其它内容）。
    expect(screen.getByText('zhangsan-哨兵')).toBeInTheDocument()
    const row = screen.getByText('累计拒绝次数').closest('div') as HTMLElement
    expect(row.textContent).toContain('—')
    // 整页不得出现 `undefined`（缺失字段一律走"未知"档）。
    expect(document.body.textContent).not.toContain('undefined')
  })
})
