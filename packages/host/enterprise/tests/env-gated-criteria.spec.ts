/**
 * `tests/helpers/env-gated-criteria.ts`（环境受限判据的**登记表**）的判据。
 *
 * ## 它防的是什么
 *
 * 无特权环境里，需要 `mount --bind` 的判据会**自跳**，而自跳与通过同为绿 ⇒
 * "CI 全绿"被读成"挂载点判据通过"（2026-10-13 独立审计记下的形态）。登记表把这件事
 * 变成**数据**，本文件把它变成**机检**：
 *   1. 登记项必须指到真实文件与**逐字还在**的用例名（判据被删/改名 ⇒ 红）；
 *   2. spec 里 `judgeMountGate` 的调用点数必须等于登记条数（**新加一条未登记的受限判据**
 *      就红 —— "绕过登记"与"忘了登记"是同一个口子）；
 *   3. 自跳必须打登记的标记 + 真实原因（`MOUNT_SKIP_MARKER` 与 `attempt.reason`）；
 *   4. 闸门三档语义有**行为**夹具（缺能力=如实自跳；声明"必须提供"=硬红）；
 *   5. 本文件的探针会在 CI 日志里打一行**覆盖声明**：本环境的 `mount --bind` 到底能不能用、
 *      因此这几条判据是"真的执行"还是"自跳"。
 *
 * 第 5 条是给人看的（CI 绿的含义），第 1–4 条是给门禁咬的。**本条判据自身不受环境限制**：
 * 探针失败也照样把语义判完（不许把"本判据跳过了"写成绿）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ENV_GATED_CRITERIA,
  judgeMountGate,
  MOUNT_PRECONDITION,
  MOUNT_REQUIRED_ENV,
  MOUNT_REQUIRED_VALUE,
  MOUNT_SKIP_MARKER,
} from './helpers/env-gated-criteria.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 真跑一次 `mount --bind`（与判据里的探针**同一个 syscall**，不是"猜环境"）。
 *
 * 失败时把**真实** stderr 带回来；不管成败都把挂载点卸掉再删目录（卸载失败用 `-l` 兜底，
 * 免得留一个指向已删目录的挂载）。
 * @returns 探针结果（`ok` 为 false 时 `reason` 是真实原因）。
 */
function probeBindMount(): { ok: boolean, reason: string } {
  const base = mkdtempSync(join(tmpdir(), 'env-gated-mount-'))
  const source = join(base, 'source')
  const target = join(base, 'target')
  mkdirSync(source)
  mkdirSync(target)
  let mounted = false
  try {
    try {
      execFileSync('mount', ['--bind', source, target], { stdio: 'pipe' })
      mounted = true
    } catch (cause) {
      const stderr = (cause as { stderr?: Buffer | string }).stderr
      const line = (stderr === undefined ? '' : stderr.toString()).trim().split('\n')[0]
      const reason = line === undefined || line === '' ? (cause as Error).message : line
      return { ok: false, reason }
    }
    return { ok: true, reason: '' }
  } finally {
    if (mounted) {
      try {
        execFileSync('umount', [target], { stdio: 'ignore' })
      } catch {
        try { execFileSync('umount', ['-l', target], { stdio: 'ignore' }) } catch { /* 已经卸掉 */ }
      }
    }
    rmSync(base, { recursive: true, force: true })
  }
}

describe('环境受限判据的登记表：自跳不得是静默的一条路', () => {
  it('登记表形态：每条都指到真实文件、逐字存在的用例名，且调用点数与登记条数一致', () => {
    expect(ENV_GATED_CRITERIA.length, '登记表不得为空（本包确实有环境受限判据）').toBeGreaterThan(0)
    const seen = new Set<string>()
    for (const entry of ENV_GATED_CRITERIA) {
      expect(entry.id, '登记项缺 id').not.toBe('')
      expect(seen.has(entry.id), `登记项 id 重复：${entry.id}`).toBe(false)
      seen.add(entry.id)
      for (const field of ['spec', 'precondition', 'requiredEnv', 'reasonToken', 'why', 'privilegedCommand'] as const) {
        expect(String(entry[field]).trim(), `${entry.id} 的 ${field} 不得为空`).not.toBe('')
      }
      // 有权限的环境怎么跑：命令必须指名这条 spec（否则"登记了跑法"却跑的是别的判据）。
      expect(entry.privilegedCommand, `${entry.id} 的 privilegedCommand 必须指名 ${entry.spec}`)
        .toContain(entry.spec)
      const specPath = join(HERE, entry.spec)
      expect(existsSync(specPath), `${entry.id} 指向的 spec 不存在：${entry.spec}`).toBe(true)
      const text = readFileSync(specPath, 'utf8')
      expect(entry.titles.length, `${entry.id} 没有登记任何用例名 ⇒ 本判据对它零约束`).toBeGreaterThan(0)
      for (const title of entry.titles) {
        expect(text, `${entry.id} 登记的用例「${title}」在 ${entry.spec} 里找不到了（判据被删/改名？）`)
          .toContain(title)
      }
      // **调用点数 = 登记条数**：多一处未登记的受限判据、或少一处（登记项过期）都红。
      const callSites = text.split('judgeMountGate(').length - 1
      expect(
        callSites,
        `${entry.spec} 里 judgeMountGate 的调用点有 ${callSites} 处，登记的用例有 ${entry.titles.length} 条`
        + ' —— 环境受限判据必须逐条登记（新增/删除都要同步 tests/helpers/env-gated-criteria.ts）',
      ).toBe(entry.titles.length)
      // 自跳必须打登记的覆盖声明标记，且必须带上**真实原因**（不是"跳过"两个字）。
      expect(text, `${entry.spec} 必须打登记的 ${MOUNT_SKIP_MARKER}（自跳要在 CI 日志里可检索）`)
        .toContain('MOUNT_SKIP_MARKER')
      expect(text, `${entry.spec} 的自跳必须带上真实原因（${entry.reasonToken}）`).toContain(entry.reasonToken)
    }
  })

  it('闸门三档语义（行为夹具）：可用=照跑、不可用+未声明=如实自跳、不可用+声明必须提供=硬红', () => {
    const ok = { ok: true, reason: '' }
    const broken = { ok: false, reason: 'mount: permission denied' }
    // ① 能力可用 ⇒ 走真实路径；登记了"必须提供"也只是不再需要自跳。
    expect(judgeMountGate(ok, {})).toEqual({ mounted: true, required: false })
    expect(judgeMountGate(ok, { [MOUNT_REQUIRED_ENV]: MOUNT_REQUIRED_VALUE }))
      .toEqual({ mounted: true, required: true })
    // ② 能力不可用 + 未声明 ⇒ **无** hardFailure（调用方必须自己打覆盖声明）。
    expect(judgeMountGate(broken, {})).toEqual({ mounted: false, required: false })
    // 其它取值不算声明（只有登记的那个取值算）—— 免得 `PICOAI_MOUNT_TESTS=0` 被当成"必须"。
    expect(judgeMountGate(broken, { [MOUNT_REQUIRED_ENV]: 'optional' }).hardFailure).toBeUndefined()
    // ③ 能力不可用 + 声明必须提供 ⇒ 硬红，且理由里要有**真实原因**与前置条件（可排查）。
    const armed = judgeMountGate(broken, { [MOUNT_REQUIRED_ENV]: MOUNT_REQUIRED_VALUE })
    expect(armed.mounted).toBe(false)
    expect(armed.hardFailure, '声明"必须提供"时缺能力必须硬红（否则"在测"与"跳过"不可区分）')
      .toBeDefined()
    expect(String(armed.hardFailure)).toContain(broken.reason)
    expect(String(armed.hardFailure)).toContain(MOUNT_PRECONDITION)
  })

  it('覆盖声明：本环境的 mount 能力与本登记表一致（CI 绿的含义写进日志）', () => {
    const probe = probeBindMount()
    const gated = ENV_GATED_CRITERIA.filter(entry => entry.requiredEnv === MOUNT_REQUIRED_ENV)
    expect(gated.length, '挂载点判据的登记项一条都没有 ⇒ 本文件对它的覆盖声明是空话').toBeGreaterThan(0)
    console.log(
      `[env-gated] mount --bind 可用 = ${probe.ok}${probe.ok ? '' : ` | 原因 = ${probe.reason}`}`
      + ` ⇒ ${gated.length} 条判据（${gated.map(entry => entry.id).join(', ')}）在本环境`
      + (probe.ok
        ? '**真的执行**（覆盖成立）。'
        : `**自跳**（${MOUNT_SKIP_MARKER}）—— 本次门禁绿**不代表**这几条通过。`),
    )
    // 两种世界都必须与登记表一致：能力可用 ⇒ 登记的前置成立、判据真跑；
    // 能力不可用 ⇒ 自跳路径已武装（未声明=如实自跳，声明=硬红）。
    const verdict = judgeMountGate(probe, {})
    expect(verdict.mounted, '闸门判定必须与本环境的真实能力一致').toBe(probe.ok)
    if (!probe.ok) {
      expect(verdict.hardFailure, '缺省形态是"如实自跳"，不是硬红').toBeUndefined()
      expect(judgeMountGate(probe, { [MOUNT_REQUIRED_ENV]: MOUNT_REQUIRED_VALUE }).hardFailure)
        .toBeDefined()
    }
  })
})
