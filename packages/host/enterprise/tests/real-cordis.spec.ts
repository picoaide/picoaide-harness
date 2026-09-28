/**
 * 「创造模式」preset 在 0.1.7 上的**真实落点**（UPG-6 重写）。
 *
 * ## 为什么必须重写这个文件
 *
 * 0.1.5 线里创造模式是**一个目录**：
 * `deepseek-harness/packages/preset/agent-presets/presets/cordis/`
 * （`agent.cordis.yml` + `preset.yml` + `skills/`）。0.1.7 把那个包整个拆了 ——
 * `preset/agent-presets` → `preset/agent-preset` + `preset/agent-preset-registry`，
 * 而 `presets/` 搬到了 `packages/bundle/web-app/presets/`，目录读取路径按上游逐字
 * "Nothing reads that directory any more." 删除。旧断言读的就是那个不存在的目录 ⇒
 * `ENOENT … presets/cordis`：与本次改动无关，是**升级留下的既有红**。
 *
 * ## 判据不许退化成"某个路径还在不在"
 *
 * 0.1.7 的真实布局是：创造模式 = web 组合里的一条**声明行**
 * （`preset-cordis`，包 `@deepseek-ai/dsh-agent-preset`），而它的技能随
 * **`@deepseek-ai/dsh-agent-preset` 包自己的 `skills/`** 分发（声明行里的
 * `skill-filesystem` 行用 `createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')`
 * 算出那个目录）。所以这里断言的是三件**真事**：
 *  1. 随包清单真的列了那条声明文件，声明文件里的行 id / 包名 / 技能目录表达式逐字对得上；
 *  2. **真 Cordis**（完整桌面 profile）起来的 roster 里 `cordis`、`standard` 真的在，
 *     对应 Loader 行 ACTIVE、没有 `broken`；
 *  3. 该预设的技能**真的进了技能目录**：`ctx.skills.list()` 里能看到创造模式的三个技能
 *     （它们不再来自任何"预设目录"，只来自于那个包）。
 *
 * 第 3 条是原用例 "ships skills/ with the composition" 在 0.1.7 上的等价物 ——
 * 断的是能力（技能真的被发现），不是路径存在性。
 *
 * 为什么企业包的用例会挂**桌面** profile：0.1.7 起这条 preset 的落点就在桌面组合里
 * （声明行由 `@deepseek-ai/dsh-web-app` 这个 bundle 层提供），而"真 Cordis"只有把
 * 装配好的组合挂起来才存在。boot 走 `scripts/boot-desktop-profile.mjs`
 * （装配组合的唯一 boot 实现，`tests/boot-wiring.spec.ts` 守住"不得绕过它"），
 * 它 import 的是桌面包的**产物** `lib/*.js` —— 与本包既有的
 * `import { parseDesktopChannelProfile } from 'dsh-plugin-desktop/desktop-channel'`
 * 同一条前置（`yarn check` 先 build 再 test）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { bootDesktopProfile } from '../../desktop/scripts/boot-desktop-profile.mjs'
import { desktopRuntimeStub } from '../../desktop/tests/helpers/desktop-runtime-stub.ts'
import { FIBER_ACTIVE } from '../../desktop/src/startup-rows.ts'
import { prepareDesktopProfile } from '../../desktop/src/profile.ts'

/** 0.1.7 的创造模式声明文件（bundle 清单里的相对路径）。 */
const CORDIS_PATCH_FILE = './presets/cordis.patch.yml'
/** 声明行的 Loader id 与包名（上游契约形状）。 */
const CORDIS_ROW_ID = 'preset-cordis'
const DECLARATION_PACKAGE = '@deepseek-ai/dsh-agent-preset'
/** 随 `@deepseek-ai/dsh-agent-preset` 分发的创造模式技能。 */
const CREATOR_SKILLS = [
  'cordis-composition-reference',
  'cordis-plugin-development',
  'editing-cordis-compositions',
] as const

/** 上游包在本仓的解析锚点（企业包自己不依赖它们，须经桌面包的清单转一手）。 */
const desktopRequire = createRequire(createRequire(import.meta.url).resolve('dsh-plugin-desktop/package.json'))
/** 桌面包根：`boot-desktop-profile.mjs` 的产物前置在这里。 */
const DESKTOP_PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'desktop')
/**
 * 预设挂载记录的读取面。**必须经桌面包的解析锚点**取 ——
 * `@deepseek-ai/dsh-agent-preset-registry` 是桌面包的依赖，企业包自己解析不到它
 * （`createRequire(import.meta.url).resolve` 会 MODULE_NOT_FOUND）。`require(esm)`
 * 与 Loader 自己的 `import()` 落在**同一个** ESM 模块实例上，所以模块级的挂载集合
 * 互通（挂载记录读不到时下面的断言会直接点名，不会静默变成"没有挂载"）。
 */
const { livePresetMounts } = desktopRequire('@deepseek-ai/dsh-agent-preset-registry') as {
  livePresetMounts: (within?: unknown) => Array<{ presetId: string, key?: unknown }>
}

/** 每个用例自己的临时数据根。 */
const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('real 创造模式 preset on 0.1.7', () => {
  it('ships its skills from the agent-preset package and lands on the live roster', async () => {
    // ① 真实布局：bundle 清单 → 声明文件 → 声明行。
    const webAppDir = dirname(desktopRequire.resolve('@deepseek-ai/dsh-web-app/package.json'))
    const manifest = JSON.parse(readFileSync(join(webAppDir, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string | string[] } }
    }
    const declared = manifest.dsh?.bundle?.patch
    const patchFiles = typeof declared === 'string' ? [declared] : declared ?? []
    expect(patchFiles).toContain(CORDIS_PATCH_FILE)

    const patchSource = readFileSync(join(webAppDir, 'presets', 'cordis.patch.yml'), 'utf8')
    expect(patchSource).toContain(`id: ${CORDIS_ROW_ID}`)
    expect(patchSource).toContain(`name: '${DECLARATION_PACKAGE}'`)
    // 技能目录由**真包**的绝对位置算出（不是随包目录，也不是写死的相对路径）。
    expect(patchSource).toContain(`resolve('${DECLARATION_PACKAGE}/package.json')`)
    expect(patchSource).toContain("'skills'")

    // ② 那个"真包"里确实有创造模式的技能（真解析 + 真文件）。
    const skillsDir = join(dirname(desktopRequire.resolve(`${DECLARATION_PACKAGE}/package.json`)), 'skills')
    for (const skill of CREATOR_SKILLS) {
      expect(existsSync(join(skillsDir, skill, 'SKILL.md')), `${skill}/SKILL.md 不在 ${skillsDir}`).toBe(true)
    }

    // ③ 真 Cordis：完整桌面 profile 起得来，创造模式真的在花名册上、行真的 ACTIVE。
    const home = mkdtempSync(join(tmpdir(), 'dsh-real-preset-'))
    homes.push(home)
    expect(
      existsSync(join(DESKTOP_PACKAGE_ROOT, 'lib', 'module-resolution.js')),
      '桌面产物缺失：先跑 `yarn workspace dsh-plugin-desktop build`（或整包 `yarn check`）',
    ).toBe(true)
    const prepared = await prepareDesktopProfile(undefined, home, process.platform)
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    let ctx
    let releasePackageResolver = (): void => {}
    try {
      const booted = await bootDesktopProfile({
        binName: 'dsh-enterprise-real-preset',
        prepared,
        patches: prepared.patches,
        runtime: desktopRuntimeStub(),
      })
      ctx = booted.ctx
      releasePackageResolver = booted.releasePackageResolver

      const roster = await ctx.agentPresets.list()
      const creator = roster.find(preset => preset.id === 'cordis')
      expect(creator, `roster 里没有 cordis：${roster.map(preset => preset.id).join(', ')}`).toBeDefined()
      expect(creator?.broken).toBeUndefined()
      expect(roster.map(preset => preset.id)).toContain('standard')

      const row = [...ctx.loader.entries()].find(entry => entry.options.id === CORDIS_ROW_ID)
      expect(row?.options.name).toBe(DECLARATION_PACKAGE)
      expect(row?.fiber?.state).toBe(FIBER_ACTIVE)

      // ④ 技能真的被发现（原用例 "ships skills/ with the composition" 的 0.1.7 等价物）。
      //    技能注册是**分层**的：`skill-filesystem` 行挂在 preset 的 standing composition 里，
      //    它的 provider 落进该 preset 的 scope 层，读取时"全局层 + 观察者 scope 链"合并。
      //    所以这里成对断言：全局层**看不到**它们（说明它们确实由这条预设贡献，而不是
      //    别的行顺带装的），preset 作用域里**看得到**（说明组合真的把它们接上了）。
      const globalNames = (await ctx.skills.list()).map(skill => skill.name)
      const mount = livePresetMounts(ctx.fiber).find(candidate => candidate.presetId === 'cordis')
      expect(mount, '创造模式的挂载记录不在 livePresetMounts 里').toBeDefined()
      const scoped = await ctx.skills.list({ scope: mount?.key })
      const scopedNames = scoped.map(skill => skill.name)
      for (const skill of CREATOR_SKILLS) {
        expect(globalNames, `${skill} 不该出现在全局技能层`).not.toContain(skill)
        expect(scopedNames, `创造模式的技能层里没有 ${skill}`).toContain(skill)
      }
      // 而且它们来自**那个包**（真路径），不是任何"预设目录"。
      const shipped = scoped.find(skill => skill.name === 'editing-cordis-compositions')
      if (shipped?.path !== undefined) {
        expect(shipped.path.startsWith(join(skillsDir, 'editing-cordis-compositions'))).toBe(true)
      } else {
        expect(shipped?.resourceBase, '技能既没有 path 也没有 resourceBase，来源不可判').toBeDefined()
      }
    } finally {
      process.env.DSH_HOME = previousHome
      releasePackageResolver()
      // 收尾失败不得掩盖真正的断言失败。
      await ctx?.fiber.dispose().catch(() => undefined)
    }
  }, 60_000)
})
