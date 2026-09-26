/**
 * 生产装配形态下的更新重试预算（2026-09-26，⑦）。
 *
 * ## 缺陷形态（同一 bug 类，本轮浏览器侧刚修掉一个 P0）
 *
 * Schemastery 会把**缺键的数组**物化成 `[]`（不是 undefined），而消费方用
 * `config.checkRetryDelaysMs.length + 1` 当尝试次数 ⇒ 只要 `z.array(...)` 少了
 * `.default(...)`，"生产里没有配置这份表"就会被静默读成"显式关闭重试"：
 * `maxAttempts = 1`，**一次尝试、零重试**，且全程没有任何报错或日志。
 *
 * `packages/host/desktop/cordis.patch.yml` 的 `desktop-updates` 行**没有 `config`**
 * （本轮实测：`grep -n "desktop-updates" -A2` 只有 `id` 与 `name`），所以生产形态就是
 * `Config({})`。这条判据把它钉死：
 *
 *  1. 从**真实装配文件**读出那一行（有 `config` 就一起喂进 schema，不让判据与装配漂移）；
 *  2. 走**真 schema** `Config(...)` 归一化；
 *  3. 用**生产同一个换算点** `retryPoliciesFromConfig()` 算尝试次数 —— 判据不自己重写
 *     `length + 1` 这个公式（两侧各写一份就等于两侧可以各自漂移）；
 *  4. 反向对照：显式 `[]` 仍然必须是"不重试"（1 次尝试）—— 这是有意保留的正当配置，
 *     不能靠"把空数组也填成缺省表"来换绿。
 *
 * 变异验证：把 `updates.ts` 里任一 `.default([...DEFAULT_*_RETRY_DELAYS_MS])` 去掉
 * ⇒ 第 1 条用例红（`expected [] to deeply equal [ 2000, 8000, 20000 ]`）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  Config,
  DEFAULT_UPDATE_RETRY_DELAYS_MS,
  retryPoliciesFromConfig,
  type Config as UpdateConfig,
} from '../src/updates.ts'

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

interface PatchRow {
  readonly id?: unknown
  readonly name?: unknown
  readonly config?: unknown
}

/**
 * 从真实的 `cordis.patch.yml` 里读出 `desktop-updates` 那一行。
 *
 * 只认 `insert:`（本文件里所有行都在那一层）；找不到即 throw —— 行被改名/挪走时
 * 判据必须响亮地失败，而不是对着一份不存在的配置断言（假绿）。
 * @returns 该行的 `id`/`name`/`config` 投影。
 */
function updatesRowFromAssembly(): PatchRow {
  const text = readFileSync(join(desktopRoot, 'cordis.patch.yml'), 'utf8')
  const parsed = parseYaml(text) as Array<{ insert?: unknown }> | undefined
  const rows: PatchRow[] = []
  for (const entry of parsed ?? []) {
    if (!Array.isArray(entry?.insert)) continue
    for (const row of entry.insert as PatchRow[]) {
      if (row?.id === 'desktop-updates') rows.push(row)
    }
  }
  expect(rows, "cordis.patch.yml 里必须恰好有一行 id: desktop-updates（判据的装配真源）").toHaveLength(1)
  return rows[0]!
}

describe('更新重试预算 · 生产装配形态（⑦）', () => {
  it('desktop-updates 行走真 schema 之后必须有重试：缺键 ⇒ 缺省表，不是空表', () => {
    const row = updatesRowFromAssembly()
    expect(row.name, '那一行必须挂的是 updates 插件').toBe('dsh-plugin-desktop/updates')

    // 生产形态：装配行没有 config ⇒ 插件拿到 schema 缺省值。将来那一行若加了 config，
    // 同一条判据必须一起把它喂进来（否则判据会与装配漂移）。
    const raw = (row.config ?? {}) as UpdateConfig
    const parsed = Config(raw)

    expect(
      parsed.checkRetryDelaysMs,
      '缺键时 checkRetryDelaysMs 被物化成空表 ⇒ 生产 maxAttempts=1、零重试（缺 .default()）',
    ).toEqual([...DEFAULT_UPDATE_RETRY_DELAYS_MS.check])
    expect(
      parsed.transferRetryDelaysMs,
      '缺键时 transferRetryDelaysMs 被物化成空表 ⇒ 安装包传输零重试（缺 .default()）',
    ).toEqual([...DEFAULT_UPDATE_RETRY_DELAYS_MS.transfer])

    // 判据的核心口径：**尝试次数**（判据与 apply 共用这一个换算点）。
    const policies = retryPoliciesFromConfig(parsed)
    expect(policies.check.maxAttempts, '清单检查必须"1 次首发 + 每个延迟项 1 次重试"').toBe(4)
    expect(policies.transfer.maxAttempts, '安装包传输必须"1 次首发 + 每个延迟项 1 次重试"').toBe(6)
    expect(policies.check.delaysMs.length, '重试预算不得为空').toBeGreaterThan(0)
    expect(policies.transfer.delaysMs.length, '重试预算不得为空').toBeGreaterThan(0)
    // 抖动比例也必须落到缺省值（否则重试节奏会全部同相）。
    expect(policies.check.jitterRatio).toBeGreaterThan(0)
  })

  it('显式 [] 是"不重试"的正当语义（与"缺键回落缺省表"区分开）', () => {
    const parsed = Config({ checkRetryDelaysMs: [], transferRetryDelaysMs: [] } as unknown as UpdateConfig)
    expect(parsed.checkRetryDelaysMs).toEqual([])
    expect(parsed.transferRetryDelaysMs).toEqual([])
    const policies = retryPoliciesFromConfig(parsed)
    expect(policies.check.maxAttempts, '显式空表 = 只尝试一次、不重试（有意保留的配置）').toBe(1)
    expect(policies.transfer.maxAttempts).toBe(1)
  })

  it('自定义表仍然照办（缺省值不得覆盖调用方显式给的表）', () => {
    const parsed = Config({ checkRetryDelaysMs: [1, 2], retryJitterRatio: 0.5 } as UpdateConfig)
    const policies = retryPoliciesFromConfig(parsed)
    expect(policies.check.maxAttempts).toBe(3)
    expect(policies.check.delaysMs).toEqual([1, 2])
    expect(policies.check.jitterRatio).toBe(0.5)
    // 未给的那一条仍然走缺省表。
    expect(policies.transfer.maxAttempts).toBe(DEFAULT_UPDATE_RETRY_DELAYS_MS.transfer.length + 1)
  })
})
