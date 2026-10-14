/**
 * `tests/helpers/env-gated-criteria.ts`（环境受限判据的**登记表**）的判据。
 *
 * ## 它防的是什么
 *
 * 无特权环境里，需要 `mount --bind` 的判据会**自跳**，而自跳与通过同为绿 ⇒
 * "CI 全绿"被读成"挂载点判据通过"（2026-10-13 独立审计记下的形态）。登记表把这件事
 * 变成**数据**，本文件把它变成**机检**：
 *   1. **对账面是整仓 `packages/`**（递归全扫）：任何 spec 里出现真跑 `mount --bind`、
 *      或用了挂载闸门，就必须逐条登记 —— 未登记即红；
 *   2. 登记项必须指到真实文件与**逐字还在**的用例名（判据被删/改名 ⇒ 红）；
 *   3. 每个 spec 里 `judgeMountGate` 与 `consumeMountGate` 的调用点数都必须等于该 spec
 *      的登记条数（**新加一条未登记的受限判据**、或把闸门摘掉，都红）；
 *   4. 闸门三档语义与**两个消费点**都有**行为**夹具：缺能力+未声明 ⇒ 如实自跳并打出
 *      可检索的覆盖声明（含真实原因与跑法）；缺能力+声明"必须提供" ⇒ 抛错硬红；
 *      探针失败却没原因 ⇒ 也抛错（不许退回静默）；
 *   5. 本文件的探针会在 CI 日志里打一行**覆盖声明**：本环境的 `mount --bind` 到底能不能用、
 *      因此这几条判据是"真的执行"还是"自跳"。
 *
 * 第 5 条是给人看的（CI 绿的含义），第 1–4 条是给门禁咬的。**本条判据自身不受环境限制**：
 * 探针失败也照样把语义判完（不许把"本判据跳过了"写成绿）。
 *
 * ## 两处口径变更的理由（2026-10-13 审计 P1/P2-2）
 *
 *   · **扫描面**：此前是"取登记项自己指名的那个 spec 的文本"，于是同包第三条真 mount
 *     判据（`audit-r20-skill-library.spec.ts` 的 K-08）既不在面内、整块删掉也不红。
 *     现在扫的是 `tests/**` 下**全部** spec，豁免只有 {@link REGISTRY_SELF_SPEC} 这一个
 *     具名常量（它是量具，不是受限判据）。
 *   · **消费点**：`hardFailure` ⇒ 硬红、缺省 ⇒ 打覆盖声明，这两行以前散在各个 spec 里、
 *     判据侧只能用 `toContain` 数文本 ⇒ 整段删掉照样绿。现在它们是
 *     `consumeMountGate` 一处实现，被真实 spec 调用、也被下面的行为夹具判决。
 *     这两条变更都是**收紧**：删断言/放宽守卫一个都没有。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  consumeMountGate,
  ENV_GATED_CRITERIA,
  judgeMountGate,
  MOUNT_PRECONDITION,
  MOUNT_REQUIRED_ENV,
  MOUNT_REQUIRED_VALUE,
  MOUNT_SKIP_MARKER,
  REGISTRY_SELF_SPEC,
} from './helpers/env-gated-criteria.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 真跑一次 `mount --bind` 的形态（与引号/参数表写法无关；命中 ⇒ 必须登记）。 */
const MOUNT_PROBE_RE = /execFileSync\([^)]*['"]mount['"][\s\S]{0,120}?['"]--bind['"]/u

/** 用了挂载闸门的形态（登记过的 spec 把闸门摘掉是另一侧的失配）。 */
const GATE_USE_RE = /judgeMountGate\(|consumeMountGate\(/u

/** 扫描面下限：整仓 `packages/` 下的 spec 数远大于它 ⇒ 跌到这么多说明"没扫到文件"而非"零命中"。 */
const MINIMUM_SCANNED_SPECS = 100

/** 扫描时剪掉的目录（产物/依赖；里面不可能有判据的**真源**）。 */
const PRUNED_DIRS = new Set(['node_modules', 'lib', 'dist', 'build', 'coverage', '.yarn', '.git', 'temp'])

/**
 * 仓库根 = 向上第一个含 `yarn.lock` 的目录。
 *
 * 找不到就**抛错**（不得静默缩面：那样"零命中"与"没扫到"又不可区分了，正是本文件
 * 存在的理由）。真实仓库里 `packages/host/enterprise/tests` 之上只有根有 `yarn.lock`。
 * @returns 仓库根的绝对路径。
 */
function repositoryRoot(): string {
  let dir = HERE
  for (;;) {
    if (existsSync(join(dir, 'yarn.lock'))) return dir
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(
        '找不到仓库根（从 tests/ 向上到文件系统根都没有 yarn.lock）⇒ 本判据的扫描面无法确定。'
        + ' 不得静默缩面：请在有仓库根的树里跑，或显式改这里的扫描面定义。',
      )
    }
    dir = parent
  }
}

/**
 * 递归列出 `<仓库根>/packages/` 下的全部 spec（绝对路径，升序）。
 *
 * 扫描面是**整仓 `packages/`**——这是本文件存在的理由（审计 P1：对账面曾缩到"登记项
 * 指名的那个文件"，同包第三条真 mount 判据因此完全不在面内）。判据真源在
 * `packages/<组>/<包>/{tests,src}` 两处，所以两个都扫。
 * @returns 绝对路径列表。
 */
function specFiles(): string[] {
  const root = join(repositoryRoot(), 'packages')
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (PRUNED_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name))
        continue
      }
      if (entry.name.endsWith('.spec.ts')) out.push(join(dir, entry.name))
    }
  }
  walk(root)
  return out
}

/** 读一个 spec 的文本。 */
function readSpec(abs: string): string {
  return readFileSync(abs, 'utf8')
}

/** 相对仓库根展示（消息里用；POSIX 分隔符）。 */
function display(abs: string): string {
  return abs.slice(repositoryRoot().length + 1).split('\\').join('/')
}

/** 某个字面量在文本里出现的次数（调用点数对账用）。 */
function countOf(text: string, token: string): number {
  return text.split(token).length - 1
}

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
  it('对账面 = 整仓 packages/：真跑 mount --bind 或用了挂载闸门的 spec 都必须逐条登记', () => {
    const files = specFiles()
    // 扫描面本身不得退化：零命中必须能区分于"没扫到文件"（否则本条判据空转还报绿）。
    expect(
      files.length,
      `整仓 packages/ 下只扫到 ${files.length} 个 spec ⇒ 扫描面塌了（本条判据会变成空转）`,
    ).toBeGreaterThan(MINIMUM_SCANNED_SPECS)
    const probing = files.filter(abs => MOUNT_PROBE_RE.test(readSpec(abs)))
    const usingGate = files.filter(abs => GATE_USE_RE.test(readSpec(abs)))
    // 登记项的 `spec` 相对**本包 tests/** 解析；跨包判据可用 `../` 相对路径登记
    // （对账按绝对路径做，所以两种写法都在面内）。
    const registered = new Set(ENV_GATED_CRITERIA.map(entry => resolve(HERE, entry.spec)))
    const self = resolve(HERE, REGISTRY_SELF_SPEC)

    // ① 真跑 `mount --bind` 却没登记 —— 无特权环境里它会自跳，而自跳与通过同为绿。
    expect(
      probing.filter(abs => abs !== self && !registered.has(abs)).map(display),
      '这些 spec 真的在跑 `mount --bind` 却没有登记进 tests/helpers/env-gated-criteria.ts'
      + ' ⇒ 无特权环境里它们自跳而门禁照绿，"绿"会被读成"通过"。环境受限判据必须逐条登记。',
    ).toEqual([])

    // ② 用了挂载闸门却没登记 —— "闸门"与"登记"必须成对，漏一边就回到隐式自跳。
    expect(
      usingGate.filter(abs => abs !== self && !registered.has(abs)).map(display),
      '这些 spec 用了挂载闸门却没有登记（闸门与登记必须成对，见 tests/helpers/env-gated-criteria.ts）',
    ).toEqual([])

    // ③ 反向：登记项指名的 spec 必须真的还在探针面上 —— 整块删掉判据（登记项还在）
    //    也是"判据消失"，与"忘了登记"一样红。
    for (const abs of registered) {
      expect(
        probing,
        `${display(abs)} 被登记为环境受限判据，但它里面已经没有 \`mount --bind\` 探针 ——`
        + ' 判据被整块删掉了？（登记项过期与判据消失必须同时红，否则删判据是静默的）',
      ).toContain(abs)
    }
  })

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
      // 真跑的形态还必须带"声明必须提供"那个环境变量 —— 否则跑法与闸门对不上，
      // 命令跑完了照样是自跳（这正是"跑法只是文档"的形态）。
      expect(entry.privilegedCommand, `${entry.id} 的 privilegedCommand 必须置 ${entry.requiredEnv}=${MOUNT_REQUIRED_VALUE}`)
        .toContain(`${entry.requiredEnv}=${MOUNT_REQUIRED_VALUE}`)
      const specPath = join(HERE, entry.spec)
      expect(existsSync(specPath), `${entry.id} 指向的 spec 不存在：${entry.spec}`).toBe(true)
      const text = readFileSync(specPath, 'utf8')
      expect(entry.titles.length, `${entry.id} 没有登记任何用例名 ⇒ 本判据对它零约束`).toBeGreaterThan(0)
      for (const title of entry.titles) {
        expect(text, `${entry.id} 登记的用例「${title}」在 ${entry.spec} 里找不到了（判据被删/改名？）`)
          .toContain(title)
      }
      // 自跳要把**真实原因**带出来：spec 侧必须读子进程 stderr（原因怎么用由
      // `consumeMountGate` 一处实现，真实原因确实进了日志由行为夹具判）。
      expect(text, `${entry.spec} 必须把探针的真实 stderr 读出来（${entry.reasonToken}），不得只写一句"跳过"`)
        .toContain(entry.reasonToken)
    }

    // **调用点数 = 该 spec 的登记条数**：多一处未登记的受限判据、少一处（登记项过期）、
    // 或把闸门/消费点摘掉，都红。两处调用点都要数：
    //   · `judgeMountGate(` —— 判据必须过闸门（否则就是隐式自跳）；
    //   · `consumeMountGate(` —— 判定必须被**消费**（否则 `hardFailure` 与覆盖声明
    //     都只是没人看的字段，删掉照样绿 —— 审计 P2-2 的形态）。
    const registered = new Set(ENV_GATED_CRITERIA.map(entry => entry.spec))
    for (const spec of registered) {
      const text = readSpec(resolve(HERE, spec))
      const titles = ENV_GATED_CRITERIA.filter(entry => entry.spec === spec).flatMap(entry => entry.titles)
      for (const token of ['judgeMountGate(', 'consumeMountGate('] as const) {
        const callSites = countOf(text, token)
        expect(
          callSites,
          `${spec} 里 ${token} 的调用点有 ${callSites} 处，该 spec 登记的用例有 ${titles.length} 条`
          + ' —— 环境受限判据必须**逐条**过闸门并被消费（新增/删除都要同步'
          + ' tests/helpers/env-gated-criteria.ts）；少一处就等于有一条在静默自跳。',
        ).toBe(titles.length)
      }
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

  it('两个消费点（行为夹具）：声明必须提供 ⇒ 抛错硬红；缺省 ⇒ 打出带原因与跑法的覆盖声明', () => {
    const ok = { ok: true, reason: '' }
    const broken = { ok: false, reason: 'mount: permission denied' }
    // ① 缺省档：**必须**打一行覆盖声明（标记 + 真实原因 + 怎么真跑），且如实返回"没执行"。
    const softLines: string[] = []
    const soft = consumeMountGate(judgeMountGate(broken, {}), broken, 'G1 换入自愈', line => { softLines.push(line) })
    expect(soft.mounted, '缺能力时消费点不得报"已执行"').toBe(false)
    expect(softLines, '自跳必须打**恰好一行**覆盖声明（多了少了都是日志面失控）').toHaveLength(1)
    expect(softLines[0]).toContain(MOUNT_SKIP_MARKER)
    expect(softLines[0], '覆盖声明必须带探针的真实原因').toContain(broken.reason)
    expect(softLines[0], '覆盖声明必须带"有权限时怎么真跑"').toContain(`${MOUNT_REQUIRED_ENV}=${MOUNT_REQUIRED_VALUE}`)
    expect(soft.skipLine, '返回的 skipLine 必须就是打进日志的那一行（可判）').toBe(softLines[0])
    // ② 声明必须提供档：**抛错**（不是返回一个没人看的 `hardFailure` 字段）。
    expect(() => consumeMountGate(
      judgeMountGate(broken, { [MOUNT_REQUIRED_ENV]: MOUNT_REQUIRED_VALUE }), broken, 'G1 换入自愈', () => {},
    )).toThrow(new RegExp(broken.reason, 'u'))
    // ③ 探针失败却给不出原因 ⇒ 也抛错：否则"跳过"又退回静默那条路。
    expect(() => consumeMountGate(
      judgeMountGate({ ok: false, reason: '   ' }, {}), { ok: false, reason: '   ' }, 'G1 换入自愈', () => {},
    )).toThrow(/真实原因/u)
    // ④ 能力可用 ⇒ 不打任何标记、不抛错。
    const okLines: string[] = []
    expect(consumeMountGate(judgeMountGate(ok, {}), ok, 'G1 换入自愈', line => { okLines.push(line) }).mounted)
      .toBe(true)
    expect(okLines, '能力可用时不得打覆盖声明').toEqual([])
    // ⑤ 闸门与消费点是**同一个判定**：不能出现"闸门说没执行、消费点说执行"。
    for (const [attempt, env] of [[broken, {}], [broken, { [MOUNT_REQUIRED_ENV]: 'optional' }]] as const) {
      const verdict = judgeMountGate(attempt, env)
      const logged: string[] = []
      const used = consumeMountGate(verdict, attempt, 'probe', line => { logged.push(line) })
      expect(used.mounted).toBe(verdict.mounted)
      expect(logged.length, '判定为"未执行"却既不打标记也不抛错 ⇒ 静默自跳').toBe(1)
    }
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
        : `**自跳**（${MOUNT_SKIP_MARKER}）—— 本次门禁绿**不代表**这几条通过；`
          + `真跑：${[...new Set(gated.map(entry => entry.privilegedCommand))].join(' / ')}`),
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
