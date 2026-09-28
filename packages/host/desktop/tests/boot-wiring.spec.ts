/**
 * 「桌面 profile 的 boot 站点必须接全五个必备接线」的静态判据。
 *
 * ## 为什么必须有这条用例（2026-09-28，主控实测）
 *
 * 上游 0.1.7 把「profile 目录里能不能解析出 bare specifier」从物化的
 * `profiles/node_modules` 闭包换成了**进程内拦截**（`PluginPackages` +
 * `createRuntimeResolution()`）。于是**每一个** `boot(...)` 调用点都得自己接上它，
 * 而漏接是**静默**的：脚本照旧"能跑起来"，只是每个插件都 import 不进来 ——
 * `verify-session-restart.mjs` 就是这么漏的（163 个条目 `failed to import`、
 * 4 个 required 插件不激活；`verify:profile` 在修好之前是 169 条）。
 * 这类缺陷的特征是"**新增一个 boot 冒烟就静默漏接线**"，所以判据必须覆盖**所有**站点。
 *
 * ## 三条口径（缺一不可）
 *
 * 1. **唯一实现**：真正调用上游 `boot(` 的文件只有两个 —— 共享 helper
 *    `scripts/boot-desktop-profile.mjs` 与生产启动器 `src/main.ts`；两者都必须点名
 *    `PluginPackages`。任何**新增**的直接 `boot(` 站点都会让这条红。
 * 2. **挂载已装配组合的脚本必须走 helper**：引用 `prepared.patches` 的脚本要么 import
 *    helper，要么自己接线。`scripts/verify-loader-boot.mjs` 刻意不在范围内：它挂的是
 *    手写的 3 行夹具组合（而且要断"包解析失败"那条路径），**不引用 `prepared.patches`**。
 * 3. **反向对照（正控）**：把接线从 helper 里逐条删掉、或把某个站点改回"自己 boot 且不接
 *    PluginPackages"的形态，同一条判据必须报出来 —— 防的是"判据恒真"。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const PACKAGE_ROOT = join(__dirname, '..')
const SCRIPTS_DIR = join(PACKAGE_ROOT, 'scripts')
const HELPER = 'boot-desktop-profile.mjs'

/** 真的在调用上游 `boot(`（不是 `bootProfile(` 之类）。 */
const BOOT_CALL = /(?:^|[^\w.])boot\(/mu
/** 挂载**已装配组合**的标志。 */
const ASSEMBLED_COMPOSITION = /prepared\.patches/u
/** 0.1.7 的 bare-specifier 进程内拦截接线。 */
const RESOLVER_WIRING = /PluginPackages/u

/** helper 里必须逐条点名的五件事。 */
const REQUIRED_WIRINGS: readonly (readonly [string, RegExp])[] = [
  ['launch environment snapshot', /DSH_LAUNCH_ENVIRONMENT_KEY/u],
  ['native shell adapter', /host\.provide\('desktopRuntime'/u],
  ['profile context', /host\.provide\('profileContext', desktopProfileContext\(prepared\)\)/u],
  ['in-process package resolution', /host\.plugin\(PluginPackages, \{ resolution: prepared\.resolution \}\)/u],
  ['cmdline appExit', /provideCmdline\(/u],
]

interface Source {
  /** Package-relative path, for failure messages. */
  readonly path: string
  /** File source. */
  readonly source: string
}

/** Every candidate file: the headless smoke scripts plus the Electron launcher. */
function candidateFiles(): Source[] {
  const scripts = readdirSync(SCRIPTS_DIR)
    .filter(name => name.endsWith('.mjs'))
    .sort()
    .map(name => ({ path: `scripts/${name}`, source: readFileSync(join(SCRIPTS_DIR, name), 'utf8') }))
  return [...scripts, { path: 'src/main.ts', source: readFileSync(join(PACKAGE_ROOT, 'src/main.ts'), 'utf8') }]
}

/** Files that call upstream `boot(` directly. */
function bootSites(files: readonly Source[] = candidateFiles()): Source[] {
  return files.filter(file => BOOT_CALL.test(file.source))
}

/**
 * Boot sites that deliberately mount a **hand-written fixture** composition instead of the
 * assembled profile. `verify-loader-boot.mjs` asserts the profile-local third-party plugin
 * path with a 3-row fixture and clears `host.loader.internal` on purpose, so it neither
 * needs nor may use the shared helper. Registered explicitly: a **new** fixture site must be
 * added here (with its reason), never silently.
 */
const FIXTURE_BOOT_SITES = new Set(['scripts/verify-loader-boot.mjs'])

/** Files that mount the assembled desktop composition (the helper itself is the mount point). */
function assembledMounts(files: readonly Source[] = candidateFiles()): Source[] {
  return files
    .filter(file => ASSEMBLED_COMPOSITION.test(file.source))
    .filter(file => file.path !== `scripts/${HELPER}`)
}

/** Mount sites that neither use the shared helper nor wire the resolver themselves. */
function wiringViolations(files: readonly Source[] = candidateFiles()): string[] {
  return bootSites(files)
    .filter(file => ASSEMBLED_COMPOSITION.test(file.source))
    .filter(file => !file.source.includes(HELPER) && !RESOLVER_WIRING.test(file.source))
    .map(file => file.path)
    .concat(
      assembledMounts(files)
        .filter(file => !BOOT_CALL.test(file.source))
        .filter(file => !file.source.includes(HELPER))
        .map(file => `${file.path} (mounts the assembled composition without the shared helper)`),
    )
    .sort()
}

describe('desktop profile boot wiring', () => {
  it('has exactly the registered direct boot sites, and every assembled one wires the resolver', () => {
    const sites = bootSites()
    expect(sites.map(file => file.path).sort()).toEqual([
      `scripts/${HELPER}`,
      'scripts/verify-loader-boot.mjs',
      'src/main.ts',
    ])
    for (const site of sites) {
      const fixture = FIXTURE_BOOT_SITES.has(site.path)
      expect(
        ASSEMBLED_COMPOSITION.test(site.source),
        `${site.path} 既没有登记为夹具站点、也不挂载已装配组合 —— 判据的覆盖面需要更新`,
      ).toBe(!fixture)
      if (fixture) continue
      expect(RESOLVER_WIRING.test(site.source), `${site.path} 没有接 PluginPackages`).toBe(true)
    }
  })

  it('covers every script that mounts the assembled composition (the rule is not vacuous)', () => {
    const mounts = assembledMounts().map(file => file.path).sort()
    expect(mounts).toEqual([
      'scripts/verify-profile-boot.mjs',
      'scripts/verify-session-restart.mjs',
      'src/main.ts',
    ])
    // 夹具站点必须**仍在**夹具形态（不引用 `prepared.patches`），否则它就该走 helper。
    for (const path of FIXTURE_BOOT_SITES) {
      const file = candidateFiles().find(candidate => candidate.path === path)
      expect(BOOT_CALL.test(file?.source ?? ''), `${path} 不再调用 boot( 了吗？`).toBe(true)
      expect(ASSEMBLED_COMPOSITION.test(file?.source ?? ''), `${path} 改为挂载已装配组合了`).toBe(false)
    }
  })

  it('routes every assembled-composition boot site through the shared helper or an explicit wiring', () => {
    expect(wiringViolations()).toEqual([])
  })

  it('keeps all five mandatory wirings inside the single shared helper', () => {
    const helper = readFileSync(join(SCRIPTS_DIR, HELPER), 'utf8')
    for (const [label, pattern] of REQUIRED_WIRINGS) {
      expect(pattern.test(helper), `${HELPER} 缺接线：${label}`).toBe(true)
    }
  })

  it('反向对照：删掉接线后同一条判据必须报出来', () => {
    // ① 站点自己 boot 且不接 PluginPackages —— 用 `verify-session-restart.mjs`
    //    修好**之前**的源码形态当样本。
    const unwired: Source = {
      path: 'scripts/verify-session-restart.mjs',
      source: [
        "import { boot } from '@deepseek-ai/dsh-app-boot'",
        'const patches = [...prepared.patches]',
        'const ctx = await boot(BIN_NAME, prepared.rootConfig, patches, async (host) => {',
        "  host.provide('desktopRuntime', runtime)",
        '}, prepared.bareModuleBaseUrl)',
      ].join('\n'),
    }
    expect(bootSites([unwired]).map(file => file.path)).toEqual(['scripts/verify-session-restart.mjs'])
    expect(wiringViolations([unwired])).toEqual(['scripts/verify-session-restart.mjs'])

    // ② 挂载组合却绕过 helper（既不 boot 也不 import helper）。
    const bypass: Source = {
      path: 'scripts/verify-session-restart.mjs',
      source: 'const patches = [...prepared.patches]\n',
    }
    expect(wiringViolations([bypass])).toEqual([
      'scripts/verify-session-restart.mjs (mounts the assembled composition without the shared helper)',
    ])

    // ③ helper 里的五件事逐个删掉都要被发现（判据真的在数它们，不是恒真）。
    //    必须替换**全部**出现处：`DSH_LAUNCH_ENVIRONMENT_KEY` 同时在 import 与
    //    provide 行里，只换第一处会让反向对照假通过。
    const helper = readFileSync(join(SCRIPTS_DIR, HELPER), 'utf8')
    for (const [label, pattern] of REQUIRED_WIRINGS) {
      const mutated = helper.replace(new RegExp(pattern.source, 'gu'), '/* removed by the negative control */')
      expect(mutated, `反向对照没能从 helper 里删掉：${label}`).not.toBe(helper)
      expect(pattern.test(mutated), `删掉接线后判据仍然放行：${label}`).toBe(false)
    }
  })
})
