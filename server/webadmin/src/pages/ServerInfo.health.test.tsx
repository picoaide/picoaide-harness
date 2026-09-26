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
})
