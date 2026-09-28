/**
 * 旧目录式智能体预设 → 0.1.7 声明行的判据（UPG-6）。
 *
 * ## 为什么需要这一层
 *
 * 上游 0.1.7 删掉了 `$DSH_HOME/.agent-presets/<id>/` 的读取路径
 * （`@deepseek-ai/dsh-agent-preset` 的 `editing-cordis-compositions` 技能逐字：
 * "Nothing reads that directory any more."），而企业「共享智能体」的**安装格式
 * 保持目录式不变**。于是"上游会读这个目录"这层语义由桌面**组装期**收回：
 * `src/profile.ts` 的 `materializeLegacyAgentPresets` 把每个可用目录物化成一条
 * `preset-<id>` 声明行（`config.plugins` = `agent.cordis.yml` 逐字）。
 *
 * 没有这一层，链路是**静默失效**：安装返回成功、面板列得出条目，roster 里永远
 * 不出现、会话也永远选不到。
 *
 * ## 两条判据，一条都不能省
 *
 * 1. **真 Cordis 端到端**（{@link describe} 的第二个块）：造一个真目录 →
 *    `prepareDesktopProfile` → 真 `boot()` → 断言 roster 里出现该预设、
 *    Loader 里那行真的 ACTIVE、**而且它声明的插件真的跑过**（探针插件写了标记
 *    文件）。第三条是关键：只断言"roster 里有这个 id"咬不到"plugins 被掏空"。
 *    同一棵树里另有反向对照：**没有目录的那个 id 不得出现**。
 * 2. **跨包格式对拍**：桌面包在构建上**不能** import `@picoaide/dsh-enterprise`
 *    （enterprise 已依赖 `dsh-plugin-desktop`，反向 import 成环，
 *    `scripts/check-workspaces.mjs` 与 `temp/wasm-client-only/cycle-check.mjs`
 *    都会判红），所以格式常量是镜像的一份 —— 必须由**读对方源码**的对拍判据钉住，
 *    否则两侧漂移时谁都不会红。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Fiber } from '@deepseek-ai/cordis'
import { livePresetMounts } from '@deepseek-ai/dsh-agent-preset-registry'
import { desktopRuntimeStub } from './helpers/desktop-runtime-stub.ts'
import { FIBER_ACTIVE } from '../src/startup-rows.ts'
import {
  LEGACY_PRESET_COMPOSITION_FILE,
  LEGACY_PRESET_DECLARATION_PACKAGE,
  LEGACY_PRESET_DIR_NAME,
  LEGACY_PRESET_ID_PATTERN,
  LEGACY_PRESET_META_MAX_LENGTH,
  LEGACY_PRESET_METADATA_FILE,
  LEGACY_PRESET_ROW_ID_PREFIX,
  legacyAgentPresetLogLine,
  materializeLegacyAgentPresets,
  prepareDesktopProfile,
} from '../src/profile.ts'

const PACKAGE_ROOT = join(__dirname, '..')
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..', '..')
const PROBE_PACKAGE = 'legacy-preset-probe-plugin'
const PROBE_FIXTURE = join(PACKAGE_ROOT, 'tests', 'fixtures', PROBE_PACKAGE)

/**
 * 夹具里的三个字面量 = **上游/安装器的存储格式**，**故意不引用 `src/profile.ts` 的常量**。
 *
 * 引用常量会让判据恒真：常量一改，夹具跟着改到新名字，读的写的永远一致 —— 变异
 * ②（把声明行 id 前缀改掉）第一次跑就是这么**没被咬到**的（EXIT=0）。格式是契约，
 * 判据必须钉契约的字面量，代码才去用常量。
 */
const FORMAT_DIR = '.agent-presets'
const FORMAT_COMPOSITION = 'agent.cordis.yml'
const FORMAT_METADATA = 'preset.yml'
/** 上游契约形状的声明行 id（`@deepseek-ai/dsh-web-app` 的 `presets/standard.patch.yml`）。 */
const FORMAT_ROW_ID = 'preset-standard'

/**
 * 装配组合的**唯一** boot 实现（`scripts/boot-desktop-profile.mjs`；
 * `tests/boot-wiring.spec.ts` 守住"任何挂载已装配组合的站点都不得绕过它"）。
 *
 * 为什么经 `createRequire` 取而不是 `import`：那个 helper 是 `.mjs`，本仓给它加类型的
 * 惯例是同级放一份 `.d.mts`（`scripts/` 下已有 6 份），而**它没有** —— 在本次之前只有
 * `.mjs` 脚本引用它，脚本不进 `tsc` 的判据面。`scripts/**` 不在本泳道允许改的路径里
 * （那里同时有别的泳道在写），所以这里把 specifier 交给 `createRequire`：它只是字符串
 * 参数，`tsc` 不解析它，类型由下面这一份**本地契约**负责（与本仓"不 import 对方类型、
 * 自己声明结构契约"的惯例一致）。
 */
const { bootDesktopProfile } = createRequire(import.meta.url)('../scripts/boot-desktop-profile.mjs') as {
  bootDesktopProfile: (options: {
    binName: string
    prepared: Awaited<ReturnType<typeof prepareDesktopProfile>>
    patches: readonly unknown[]
    runtime: unknown
    port?: number
  }) => Promise<{ ctx: BootedDesktopContext, releasePackageResolver: () => void }>
}

/** 本用例真正读到的已装配上下文（结构契约，见上）。 */
interface BootedDesktopContext {
  readonly loader: {
    entries(): Iterable<{ options: { id?: string, name?: string }, fiber?: { state: number } }>
  }
  readonly agentPresets: {
    list(): Promise<Array<{ id: string, name?: string, description?: string, order?: number, broken?: string }>>
  }
  readonly fiber: Fiber
}

/** 每个用例自己的临时数据根，`afterEach` 统一清掉。 */
const homes: string[] = []

/** 建一个临时 home 并登记清理。 */
function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-legacy-presets-'))
  homes.push(home)
  return home
}

/** 写一个旧格式预设目录（文件名用格式字面量，见上）。 */
function writeLegacyPreset(
  home: string,
  id: string,
  composition: string,
  metadata?: string,
): string {
  const dir = join(home, FORMAT_DIR, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, FORMAT_COMPOSITION), composition)
  if (metadata !== undefined) writeFileSync(join(dir, FORMAT_METADATA), metadata)
  return dir
}

/** 一条最简可用的组合文件。 */
const MINIMAL_COMPOSITION = [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '',
].join('\n')

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('legacy agent preset composition contract', () => {
  it('materializes a valid preset directory into one declaration row', () => {
    const home = temporaryHome()
    writeLegacyPreset(
      home,
      'shared-alpha',
      [
        '# 组合里的注释必须原样保留到声明行的 plugins 里',
        '- id: persona',
        "  name: '@deepseek-ai/dsh-persona'",
        '  config:',
        '    suffix: from the shared preset',
        '',
      ].join('\n'),
      ['name: Shared Alpha', 'description: the shared preset', 'order: 3', ''].join('\n'),
    )

    const { patches, diagnostics } = materializeLegacyAgentPresets(home)

    expect(diagnostics).toEqual([])
    expect(patches).toHaveLength(1)
    expect(patches[0]?.insert?.[0]).toEqual({
      // 行 id 用**契约字面量**（不是导入的常量）：常量一改，判据必须红。
      id: 'preset-shared-alpha',
      name: '@deepseek-ai/dsh-agent-preset',
      config: {
        id: 'shared-alpha',
        order: 3,
        name: 'Shared Alpha',
        description: 'the shared preset',
        plugins: [{
          id: 'persona',
          name: '@deepseek-ai/dsh-persona',
          config: { suffix: 'from the shared preset' },
        }],
      },
    })
  })

  it('anchors a relative plugin name to the preset directory, not the profile directory', () => {
    // `mountPreset` 挂载时的 `baseUrl` 是**声明方**（profile 目录）的，所以相对名
    // 必须在这里就锚定成绝对 file URL —— 否则 `./probe.mjs` 会去 profile 目录里找。
    const home = temporaryHome()
    const dir = writeLegacyPreset(home, 'relative-probe', '- name: ./probe.mjs\n')

    const { patches } = materializeLegacyAgentPresets(home)

    expect(patches[0]?.insert?.[0]?.config).toMatchObject({
      id: 'relative-probe',
      plugins: [{ name: pathToFileURL(join(dir, 'probe.mjs')).href }],
    })
  })

  it('keeps -- and surfaces -- every directory that cannot become a row', () => {
    const home = temporaryHome()
    const root = join(home, FORMAT_DIR)
    mkdirSync(root, { recursive: true })
    // 合法目录，但组合文件缺失 / 非法 YAML / 不是顶层列表。
    mkdirSync(join(root, 'no-composition'), { recursive: true })
    writeLegacyPreset(home, 'bad-yaml', '- id: broken\n  name: [unclosed\n')
    writeLegacyPreset(home, 'not-a-list', 'id: persona\nname: whatever\n')
    // 目录名不合预设 id 形状。
    mkdirSync(join(root, 'Not_A_Preset'), { recursive: true })
    writeFileSync(join(root, 'Not_A_Preset', FORMAT_COMPOSITION), MINIMAL_COMPOSITION)
    // 我们自己的 staging / 点目录：不点名（不是用户预设）。
    mkdirSync(join(root, '.install-shared-beta-abc123'), { recursive: true })
    // 普通文件：不是预设，和面板的列表面同口径。
    writeFileSync(join(root, 'stray.txt'), 'not a preset\n')
    // 一棵可用的 + 一棵元数据坏掉的。
    writeLegacyPreset(home, 'good-one', MINIMAL_COMPOSITION, 'name: Good One\n')
    writeLegacyPreset(home, 'bad-meta', MINIMAL_COMPOSITION, '- just\n- a\n- list\n')

    const { patches, diagnostics } = materializeLegacyAgentPresets(home)

    expect(patches.map(patch => patch.insert?.[0]?.id)).toEqual([
      'preset-bad-meta',
      'preset-good-one',
    ])
    expect(diagnostics.map(entry => [entry.preset, entry.problem])).toEqual([
      ['Not_A_Preset', 'invalid-id'],
      ['bad-meta', 'invalid-metadata'],
      ['bad-yaml', 'unusable-composition'],
      ['no-composition', 'unusable-composition'],
      ['not-a-list', 'unusable-composition'],
    ])
    // 每一条诊断都必须**点名预设与原因**（"不许静默丢弃"的可读面）：判据看的正是
    // 装配期真正写进启动日志的那一行（同一个格式化函数，不是判据自己拼的）。
    for (const entry of diagnostics) {
      const line = legacyAgentPresetLogLine(entry)
      expect(line).toContain(entry.preset)
      expect(line.length).toBeGreaterThan(entry.preset.length + entry.problem.length)
    }
    // 元数据坏掉**不连累**预设本身：声明行照插，只是没有展示字段。
    expect(patches[0]?.insert?.[0]?.config).toMatchObject({ id: 'bad-meta' })
    expect(patches[0]?.insert?.[0]?.config).not.toHaveProperty('name')
  })

  it('drops a non-numeric order instead of letting it fail the row config schema', () => {
    // `order` 在上游 Config 里是 `z.number()`：把 `order: "3"` 传进去会让整行配置校验
    // 失败 ⇒ 声明行永远不注册 ⇒ 预设**彻底消失**。所以只丢字段、不丢预设。
    const home = temporaryHome()
    writeLegacyPreset(home, 'string-order', MINIMAL_COMPOSITION, 'name: String Order\norder: "3"\n')

    const { patches, diagnostics } = materializeLegacyAgentPresets(home)

    expect(diagnostics.map(entry => entry.problem)).toEqual(['invalid-metadata'])
    expect(patches[0]?.insert?.[0]?.config).not.toHaveProperty('order')
    expect(patches[0]?.insert?.[0]?.config).toMatchObject({ id: 'string-order', name: 'String Order' })
  })

  it('never emits a duplicate loader row id', () => {
    // 重复 id 会让 `assertUniqueEntryIds` 直接抛错 —— 整个应用起不来。
    const home = temporaryHome()
    writeLegacyPreset(home, 'standard', MINIMAL_COMPOSITION)

    const { patches, diagnostics } = materializeLegacyAgentPresets(
      home,
      new Set(['preset-standard']),
    )

    expect(patches).toEqual([])
    expect(diagnostics.map(entry => [entry.preset, entry.problem])).toEqual([['standard', 'shadowed-row']])
  })

  it('is silent when the machine has never installed a shared preset', () => {
    const home = temporaryHome()

    expect(materializeLegacyAgentPresets(home)).toEqual({ patches: [], diagnostics: [] })
  })

  it('refuses to declare rows when the composition provides no preset registry', async () => {
    // 没有 `agentPresets` 提供者时插入 `preset-<id>` 只会得到**永远 PENDING** 的行：
    // 上游的 required-id 审计不罩它们、桌面的 `assertRequiredRowsActive` 也不罩它们
    // —— 那正是"看起来装好了、实际什么都没有"的形态。所以宁可不插，但必须点名。
    const home = temporaryHome()
    writeLegacyPreset(home, 'orphan-preset', MINIMAL_COMPOSITION)
    writeFileSync(join(home, 'cordis.patch.yml'), '- id: agent-preset-registry\n  disabled: true\n')

    const prepared = await prepareDesktopProfile(undefined, home, process.platform)

    expect(prepared.patches.some(patch => patch.insert?.[0]?.id === 'preset-orphan-preset'))
      .toBe(false)
    expect(prepared.presetDiagnostics.map(entry => entry.problem)).toEqual(['no-preset-registry'])
    expect(legacyAgentPresetLogLine(prepared.presetDiagnostics[0]!)).toContain('orphan-preset')
  })

  it('mirrors the enterprise format constants instead of letting them drift', () => {
    // 两侧一致由**读对方源码**的对拍判据钉住：桌面包在构建上不能 import
    // `@picoaide/dsh-enterprise`（反向 import 会与 enterprise → desktop 成环）。
    const enterprise = readFileSync(
      join(REPO_ROOT, 'packages', 'host', 'enterprise', 'src', 'agent-preset-install.ts'),
      'utf8',
    )
    const exported = (name: string): string | undefined =>
      new RegExp(`^export const ${name}[^=]*= (.+)$`, 'mu').exec(enterprise)?.[1]?.replace(/\s*\/\/.*$/u, '').trim()

    expect(exported('COMPOSITION_FILE')).toBe(`'${LEGACY_PRESET_COMPOSITION_FILE}'`)
    expect(exported('METADATA_FILE')).toBe(`'${LEGACY_PRESET_METADATA_FILE}'`)
    expect(exported('MAX_PRESET_META_LEN')).toBe(String(LEGACY_PRESET_META_MAX_LENGTH))
    expect(exported('PRESET_ID_PATTERN')).toBe(`/${LEGACY_PRESET_ID_PATTERN.source}/${LEGACY_PRESET_ID_PATTERN.flags}`)
    // 预设根目录名也在对侧（`resolvePresetsDir()` 的字面量）—— 它同样只能有一份口径。
    expect(enterprise).toContain(`join(dshHomeSafe({ env }), '${LEGACY_PRESET_DIR_NAME}')`)

    // 文件头那段"让上游 roster 以 user preset 发现它"的旧机制说明必须已经改掉
    // （0.1.7 逐字："Nothing reads that directory any more."）。
    expect(enterprise).not.toContain('roster discovers it as a `user` preset')
    expect(enterprise).toContain('Nothing reads that directory any more.')
  })

  it('uses the upstream declaration-row shape instead of inventing its own', () => {
    // 声明行的 id/包名不是自选动作：上游随包预设就是 `preset-<id>` +
    // `@deepseek-ai/dsh-agent-preset`（`@deepseek-ai/dsh-web-app` 的 `presets/*.patch.yml`，
    // 由该 bundle 的 `dsh.bundle.patch` 列出）。**读上游真文件取字面量**再与我们的常量对拍，
    // 所以把前缀改掉、或把声明包名改掉，这条判据都会红（不是"各钉自己的常量"）。
    const webAppDir = dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-web-app/package.json'))
    const upstream = readFileSync(join(webAppDir, 'presets', 'standard.patch.yml'), 'utf8')
    const rowId = /^\s*-\s*id:\s*(\S+)\s*$/mu.exec(upstream)?.[1]
    const rowPackage = /^\s*name:\s*'([^']+)'\s*$/mu.exec(upstream)?.[1]
    expect(rowId, '上游 standard.patch.yml 的声明行形状变了，判据要跟着改').toBe(FORMAT_ROW_ID)
    expect(rowPackage, '上游 standard.patch.yml 的声明包名变了，判据要跟着改')
      .toBe('@deepseek-ai/dsh-agent-preset')
    expect(`${LEGACY_PRESET_ROW_ID_PREFIX}standard`).toBe(FORMAT_ROW_ID)
    expect(LEGACY_PRESET_DECLARATION_PACKAGE).toBe(rowPackage)
  })
})

describe('legacy agent presets on the real desktop profile', () => {
  // 这条用例要挂载**完整**桌面组合树（200+ 行、真实 Cordis、真实 profile 目录），
  // 空闲机实测 2.4s；显式 60s 是给 CI（4 vCPU × 13 包并发）的量级声明，
  // 不是"平时多快"（包级缺省 30s 已有 12× 余量，这里只再留一层）。
  it('declares the installed directory as a live preset and mounts its plugins', async () => {
    const home = temporaryHome()
    const marker = join(home, 'probe-marker.txt')
    // 探针插件走**裸包名**（与真实旧预设引用插件的方式一致）：装进 profile 的
    // node_modules，由 Loader 的 profile 解析面找到它。
    writeLegacyPreset(
      home,
      'legacy-shared',
      [
        '- id: probe',
        `  name: ${PROBE_PACKAGE}`,
        '  config:',
        `    marker: ${JSON.stringify(marker)}`,
        '    label: legacy-preset-probe-ran',
        '',
      ].join('\n'),
      ['name: Legacy Shared Preset', 'description: installed by the shared-agent store', 'order: 7', ''].join('\n'),
    )

    const prepared = await prepareDesktopProfile(undefined, home, process.platform)
    expect(prepared.presetDiagnostics).toEqual([])
    mkdirSync(join(prepared.profile.dir, 'node_modules'), { recursive: true })
    cpSync(PROBE_FIXTURE, join(prepared.profile.dir, 'node_modules', PROBE_PACKAGE), { recursive: true })

    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    let ctx: BootedDesktopContext | undefined
    let releasePackageResolver = (): void => {}
    try {
      // `boot-desktop-profile.mjs`（装配组合的**唯一** boot 实现，`tests/boot-wiring.spec.ts`
      // 守住"不得绕过它"）import 的是**产物** `../lib/*.js` —— 与 `verify:profile` 同一条
      // 前置（`yarn check` 先 build 再 test）。缺产物时给一句人话，不要留 ENOENT。
      expect(
        existsSync(join(PACKAGE_ROOT, 'lib', 'module-resolution.js')),
        '桌面产物缺失：先跑 `yarn workspace dsh-plugin-desktop build`（或整包 `yarn check`）',
      ).toBe(true)
      const booted = await bootDesktopProfile({
        binName: 'dsh-legacy-agent-presets',
        prepared,
        patches: prepared.patches,
        runtime: desktopRuntimeStub(),
      })
      ctx = booted.ctx
      releasePackageResolver = booted.releasePackageResolver

      // ① roster：预设真的被声明了，展示字段逐字来自 `preset.yml`。
      const roster = await ctx.agentPresets.list()
      const declared = roster.find(preset => preset.id === 'legacy-shared')
      expect(declared).toMatchObject({
        id: 'legacy-shared',
        name: 'Legacy Shared Preset',
        description: 'installed by the shared-agent store',
        order: 7,
      })
      expect(declared?.broken).toBeUndefined()

      // ② Loader：声明行的 id 就是上游契约形状 `preset-<id>`，而且它真的 ACTIVE。
      const row = [...ctx.loader.entries()]
        .find(entry => entry.options.id === 'preset-legacy-shared')
      expect(row?.options.name).toBe('@deepseek-ai/dsh-agent-preset')
      expect(row?.fiber?.state).toBe(FIBER_ACTIVE)

      // ③ 能力面：它声明的 plugins **真的挂上了**（插件跑过 → 标记文件存在）。
      //    这一条是唯一能咬到"plugins 被掏空"的判据：空 plugins 的声明行在 roster
      //    上照样"可用"（`entryListProblem([])` 合法、空树挂载成功），只有副作用会说话。
      expect(existsSync(marker)).toBe(true)
      expect(readFileSync(marker, 'utf8')).toBe('legacy-preset-probe-ran\n')

      // ④ 预设真的进了这次组合的挂载集合（同一个真 Cordis 运行期）。
      const mounts = livePresetMounts(ctx.fiber).map(mount => mount.presetId)
      expect(mounts).toContain('legacy-shared')

      // 反向对照（防"判据恒真"）：没有目录的那个 id 一个面都不得出现。
      expect(roster.map(preset => preset.id)).not.toContain('never-installed')
      expect([...ctx.loader.entries()].map(entry => entry.options.id))
        .not.toContain('preset-never-installed')

      // 同一棵真 Cordis 树上，0.1.7 **随包**预设也必须是活的（目录式只增不减）。
      const shipped = roster.map(preset => preset.id)
      for (const id of ['standard', 'ptc', 'cordis'] as const) expect(shipped).toContain(id)
      expect(roster.filter(preset => preset.broken !== undefined).map(preset => preset.id)).toEqual([])
    } finally {
      process.env.DSH_HOME = previousHome
      releasePackageResolver()
      // 收尾失败不得掩盖真正的断言失败（`finally` 里的异常会把它顶掉）。
      await ctx?.fiber.dispose().catch(() => undefined)
    }
  }, 60_000)
})

/**
 * 原生壳适配器桩见 `tests/helpers/desktop-runtime-stub.ts`（与 `verify:profile` 的
 * 端到端冒烟同一份方法表）。
 */
