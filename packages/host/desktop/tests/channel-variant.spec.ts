import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHANNEL_VARIANT_SCHEMA,
  applyChannelVariant,
  assertChannelVariantSupported,
  assertModuleSurfaceCoverage,
  manifestFor,
  readChannelVariantManifest,
  type ChannelVariantSource,
} from '../scripts/channel-variant.ts'
import { FEATURE_MODULES, channelFeaturesVariant, normalizeChannelFeatures } from '../scripts/channel-constants.ts'
import {
  FEATURE_MODULE_NAMES,
  FEATURE_MODULE_SURFACES,
  closedFeatureModules,
  prunedFeatureBundles,
  prunedFeatureRows,
} from '../src/channel-features.ts'
import { prunedDesktopBundles, requiredDesktopBundles } from '../src/profile.ts'
import { REQUIRED_DESKTOP_ROWS, prunedDesktopRows, requiredDesktopRows } from '../src/startup-rows.ts'

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 临时落点（每次一个新目录：清单是"上一次构建的残留"这条判据的载体）。 */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

/** 造一个渠道上下文（只填变体裁剪用得到的字段）。 */
function source(closed: readonly string[]): ChannelVariantSource {
  const features = normalizeChannelFeatures(
    closed.length === 0 ? undefined : Object.fromEntries(closed.map(name => [name, false])),
  )
  return {
    channelId: 'fixture',
    features,
    featuresVariant: channelFeaturesVariant(features),
    official: false,
  }
}

describe('功能模块摘除面是变体裁剪的唯一声明', () => {
  it('模块名与 FEATURE_MODULES 逐字同源（顺序也是契约）', () => {
    // 这条判据是"两份清单"得以存在的前提：`src/` 不能 import `scripts/`
    // （tsconfig rootDir=src），所以模块名被逐字重列了一份；漂移必须当场红。
    expect(FEATURE_MODULE_NAMES).toEqual([...FEATURE_MODULES])
    expect(() => assertModuleSurfaceCoverage(FEATURE_MODULES)).not.toThrow()
  })

  it('少一个键 / 多一个键 / 顺序不同都判红（拿真清单做变异体）', () => {
    const [first, second, third] = FEATURE_MODULES
    expect(() => assertModuleSurfaceCoverage([first, second])).toThrow(/漂移/u)
    expect(() => assertModuleSurfaceCoverage([first, second, third, 'extra'])).toThrow(/漂移/u)
    expect(() => assertModuleSurfaceCoverage([second, first, third])).toThrow(/漂移/u)
  })

  it('每个模块的行 id 都在必需行清单里（否则"摘行"是空操作、行会留着）', () => {
    // 反方向也要判：`rows` 写了清单里没有的 id 就是一条永远不生效的声明 ——
    // 与"登记了却不在"同族。
    for (const surface of FEATURE_MODULE_SURFACES) {
      for (const id of surface.rows) expect(REQUIRED_DESKTOP_ROWS).toContain(id)
    }
    expect(REQUIRED_DESKTOP_ROWS).toContain('picoaide-skill-telemetry')
  })

  it('每个模块的包名都在 profile 的 bundle 层清单里（否则摘依赖只是"不加载"）', () => {
    // 行为口径而不是读清单字面量：全开时逐字等于 `REQUIRED_BUNDLES`；关掉某模块时
    // **恰好**少了它的包（少一个 = 有包留在组合里；多一个 = 摘到了别的模块头上）。
    const all = requiredDesktopBundles({ skills: true, apps: true, connectors: true })
    for (const surface of FEATURE_MODULE_SURFACES) {
      for (const pkg of surface.packages) expect(all).toContain(pkg)
      const closed = requiredDesktopBundles({ ...Object.fromEntries(
        FEATURE_MODULE_NAMES.map(name => [name, true]),
      ), [surface.module]: false })
      expect(all.filter(name => !closed.includes(name))).toEqual([...surface.packages])
    }
    // 全开时返回的**就是**那张表（逐元素相同，不是副本过滤后的等价物）。
    expect(requiredDesktopBundles({ skills: true, apps: true, connectors: true })).toEqual(all)
  })

  it('摘除面三列都非空，且 packages 的并集**恰好**等于登记目录里那些包的包名', () => {
    // 为什么必须钉这一条（2026-10-14 R2 审计 P2-3）：上面那条"恰好少了它的包"在
    // `packages: []` 时是**同义反复**（两侧都是 `[]`），`rows: []` / `directories: []`
    // 同理 —— 新登记一个模块、摘除面留空且不写 `blockedReason` 时全部门禁仍绿，而
    // `manifestFor()` 会产出一份空清单 ⇒ `"声明关了、东西还在"` 的静默交付。
    //
    // 真源**不是**这份表自己，而是**模块自己的 `package.json`**：登记目录里的每个包
    // 都必须在某个 surface 的 `packages` 里（反之亦然）—— 集合相等，不是自比。
    // 目录/行/包三列任一为空都在这里当场红。
    const declaredDirs = FEATURE_MODULE_SURFACES.flatMap(surface => [...surface.directories])
    expect(declaredDirs.length).toBeGreaterThan(0)
    const packageNames = new Set(FEATURE_MODULE_SURFACES.flatMap(surface => [...surface.packages]))
    const namesOnDisk = new Set(declaredDirs.map((dir) => {
      const manifest = JSON.parse(
        readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', dir, 'package.json'), 'utf8'),
      ) as { name?: unknown }
      expect(typeof manifest.name, `${dir}/package.json 必须有 name`).toBe('string')
      return manifest.name as string
    }))
    expect([...packageNames].sort()).toEqual([...namesOnDisk].sort())
    for (const surface of FEATURE_MODULE_SURFACES) {
      expect(surface.packages.length, `${surface.module}.packages 不能为空`).toBeGreaterThan(0)
      expect(surface.rows.length, `${surface.module}.rows 不能为空`).toBeGreaterThan(0)
      expect(surface.directories.length, `${surface.module}.directories 不能为空`).toBeGreaterThan(0)
      // 同一列在两个 surface 里重复出现 ⇒ 关掉 A 会连带摘掉 B 的包/行（静默跨模块裁剪）。
      for (const other of FEATURE_MODULE_SURFACES) {
        if (other.module === surface.module) continue
        for (const pkg of surface.packages) expect(other.packages).not.toContain(pkg)
        for (const id of surface.rows) expect(other.rows).not.toContain(id)
      }
    }
  })

  it('必需行清单的折叠同样只做减法：全开逐字相同、关闭恰好少那几行', () => {
    const all = requiredDesktopRows({ skills: true, apps: true, connectors: true })
    expect(all).toEqual([...REQUIRED_DESKTOP_ROWS])
    const closed = requiredDesktopRows({ skills: false, apps: true, connectors: true })
    expect(all.filter(id => !closed.includes(id)))
      .toEqual(['picoaide-capability-center', 'picoaide-skill-telemetry'])
    expect(requiredDesktopRows({ skills: false })).toEqual(closed)
  })

  it('全开与逐模块关闭的推导', () => {
    expect(closedFeatureModules(undefined)).toEqual([])
    expect(prunedFeatureBundles(undefined)).toEqual([])
    expect(prunedFeatureRows(undefined)).toEqual([])
    expect(closedFeatureModules({ skills: false })).toEqual(['skills'])
    expect(prunedFeatureBundles({ skills: false })).toEqual(['@picoaide/dsh-capability-center'])
    expect(prunedFeatureRows({ skills: false }))
      .toEqual(['picoaide-capability-center', 'picoaide-skill-telemetry'])
    expect(prunedFeatureRows({ connectors: false })).toEqual(['pico-connectors'])
    // 畸形取值方向必须是"开着"：把 `'false'` 当关会去加载一个不在包里的模块。
    expect(closedFeatureModules({ skills: 'false' as unknown as boolean })).toEqual([])
  })
})

describe('变体清单（temp/channel-variant.json）', () => {
  it('全开变体不产清单（官方/全开 = 逐字节等价于改造前的落点）', () => {
    expect(manifestFor(source([]))).toBeUndefined()
    const dir = tempDir('pico-variant-full-')
    expect(applyChannelVariant(source([]), dir)).toBeUndefined()
    expect(existsSync(join(dir, 'channel-variant.json'))).toBe(false)
  })

  it('全开构建会删掉上一次变体留下的清单（残留比"没生效"更糟）', () => {
    const dir = tempDir('pico-variant-stale-')
    const written = applyChannelVariant(source(['skills']), dir)
    expect(written?.variant).toBe('apps,connectors')
    expect(readChannelVariantManifest(dir)).toBeDefined()
    // 同一次构建序列里的全开渠道：清单必须消失，否则产物会"少模块却没声明"。
    expect(applyChannelVariant(source([]), dir)).toBeUndefined()
    expect(readChannelVariantManifest(dir)).toBeUndefined()
  })

  it('关闭 skills 时的清单内容（包 / bundle / 行 / 目录逐条）', () => {
    const dir = tempDir('pico-variant-skills-')
    const manifest = applyChannelVariant(source(['skills']), dir)
    expect(manifest).toEqual({
      schema: CHANNEL_VARIANT_SCHEMA,
      variant: 'apps,connectors',
      modules: ['skills'],
      packages: ['@picoaide/dsh-capability-center'],
      bundles: ['@picoaide/dsh-capability-center'],
      rows: ['picoaide-capability-center', 'picoaide-skill-telemetry'],
      directories: ['packages/host/capability-center'],
    })
    expect(readChannelVariantManifest(dir)).toEqual(manifest)
  })

  it('schema / 形状不认识的清单一律读成"没有清单"（不猜、不裁）', () => {
    const dir = tempDir('pico-variant-schema-')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'channel-variant.json')
    writeFileSync(file, '{ not json')
    expect(readChannelVariantManifest(dir)).toBeUndefined()
    writeFileSync(file, JSON.stringify({ schema: 'other.v9', packages: [] }))
    expect(readChannelVariantManifest(dir)).toBeUndefined()
    writeFileSync(file, JSON.stringify({ schema: CHANNEL_VARIANT_SCHEMA, variant: 'skills' }))
    expect(readChannelVariantManifest(dir)).toBeUndefined()
    writeFileSync(file, JSON.stringify({
      schema: CHANNEL_VARIANT_SCHEMA,
      variant: 'skills',
      modules: ['skills'],
      packages: ['@picoaide/dsh-capability-center'],
      bundles: ['@picoaide/dsh-capability-center'],
      rows: ['picoaide-capability-center'],
      directories: ['packages/host/capability-center'],
    }))
    expect(readChannelVariantManifest(dir)?.variant).toBe('skills')
  })
})

describe('今天裁剪不了的模块必须拒建，而不是"照常构建"', () => {
  it('apps 关闭时点名三处静态接线并拒建（不产出包）', () => {
    const closed = source(['apps'])
    expect(() => assertChannelVariantSupported(closed)).toThrow(/features\.apps=false/u)
    expect(() => assertChannelVariantSupported(closed)).toThrow(/main,app-ai-runner,wasm-apps-windows/u)
    const dir = tempDir('pico-variant-blocked-')
    expect(() => applyChannelVariant(closed, dir)).toThrow(/不支持被真正裁出产物/u)
    // 拒建时**不**留下清单：半份清单会让下游按"要裁 apps"折表，而包其实还在。
    expect(existsSync(join(dir, 'channel-variant.json'))).toBe(false)
  })

  it('skills / connectors 今天可以裁，connectors 的包名与行 id 都不为空', () => {
    expect(() => assertChannelVariantSupported(source(['skills']))).not.toThrow()
    expect(() => assertChannelVariantSupported(source(['connectors']))).not.toThrow()
    expect(() => assertChannelVariantSupported(source(['skills', 'connectors']))).not.toThrow()
    const manifest = manifestFor(source(['skills', 'connectors']))
    expect(manifest?.variant).toBe('apps')
    expect(manifest?.directories).toEqual(['packages/host/capability-center', 'packages/host/connectors'])
    expect(manifest?.rows).toEqual([
      'picoaide-capability-center',
      'picoaide-skill-telemetry',
      'pico-connectors',
    ])
  })
})

describe('构建侧清单 ↔ 运行期过滤器必须给出同一个答案（一处声明、两侧派生）', () => {
  it('清单里的 bundles / rows 就是运行期实际会摘掉的那些', () => {
    // 这条是"关掉一个模块"两侧的接缝判据：
    //   构建侧 = `temp/channel-variant.json`（裁依赖 / 裁三张必需表）
    //   运行期 = `build/channel.json` 的 `features` → profile 的 bundle 层 / startup-rows 的必需行
    // 两侧各派生一次是**有意**的（运行期不能读 `temp/`，那是打包工具目录、不进包），
    // 所以必须有一条判据钉住"它们对同一个开关给出同一个答案" —— 否则出现"包被裁了、
    // 运行期仍去装配它"（启动期 ERR_MODULE_NOT_FOUND）或反过来的半通状态。
    for (const closed of [['skills'], ['connectors'], ['skills', 'connectors']]) {
      const manifest = manifestFor(source(closed))
      expect(manifest, `${closed.join('+')} 应当产出清单`).toBeDefined()
      const switches = Object.fromEntries(
        FEATURE_MODULE_NAMES.map(name => [name, !closed.includes(name)]),
      )
      expect(requiredDesktopBundles(switches), `${closed.join('+')} 的 bundle 层两侧不一致`)
        .not.toContain(manifest?.bundles[0])
      expect(prunedDesktopBundles(switches)).toEqual(manifest?.bundles)
      expect(prunedDesktopRows(switches)).toEqual(manifest?.rows)
    }
  })
})

describe('打包输入侧：staging package.json 的裁剪', () => {
  /**
   * 造一个最小桌面包根：白名单四项齐备 + 一份带 `@picoaide/*` 依赖的 manifest。
   * 用例只驱动 `stagePackAppRoot()` 的清单折叠那一段，不需要真实产物。
   */
  function fakePackageRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'pico-pack-root-'))
    created.push(root)
    for (const dir of ['lib', 'build']) mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, 'lib', 'index.js'), 'export {}\n')
    writeFileSync(join(root, 'cordis.patch.yml'), '- id: desktop-shell\n')
    writeFileSync(join(root, 'package.json'), `${JSON.stringify({
      name: 'dsh-plugin-desktop',
      version: '0.0.0',
      main: 'lib/index.js',
      dependencies: {
        '@deepseek-ai/dsh-base': '0.2.0-rc.2',
        '@picoaide/dsh-capability-center': 'workspace:*',
        '@picoaide/dsh-connectors': 'workspace:*',
        '@picoaide/dsh-enterprise': 'workspace:*',
      },
      build: { appId: 'ai.deepseek.dsh.desktop' },
      scripts: { build: 'tsdown' },
    }, null, 2)}\n`)
    return root
  }

  it('无清单时 staged package.json 与改造前逐字相同（只删那六个键）', async () => {
    const { stagePackAppRoot } = await import('../scripts/pack-app-root.mjs')
    const root = fakePackageRoot()
    const { stageRoot, cleanup } = stagePackAppRoot(root, 'dist')
    try {
      const staged = JSON.parse(readFileSync(join(stageRoot, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>
        build?: unknown
        scripts?: unknown
      }
      expect(staged.build).toBeUndefined()
      expect(staged.scripts).toBeUndefined()
      expect(Object.keys(staged.dependencies)).toEqual([
        '@deepseek-ai/dsh-base',
        '@picoaide/dsh-capability-center',
        '@picoaide/dsh-connectors',
        '@picoaide/dsh-enterprise',
      ])
    } finally {
      cleanup()
    }
  })

  it('有清单时逐条摘掉被关闭模块的依赖，并**点名**摘了哪些', async () => {
    const { stagePackAppRoot } = await import('../scripts/pack-app-root.mjs')
    const root = fakePackageRoot()
    applyChannelVariant(source(['skills']), join(root, 'temp'))
    const { stageRoot, cleanup } = stagePackAppRoot(root, 'dist')
    try {
      const staged = JSON.parse(readFileSync(join(stageRoot, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>
      }
      expect(Object.keys(staged.dependencies)).toEqual([
        '@deepseek-ai/dsh-base',
        '@picoaide/dsh-connectors',
        '@picoaide/dsh-enterprise',
      ])
    } finally {
      cleanup()
    }
  })

  it('清单要求摘的包在 dependencies 里找不到时拒建（清单与依赖清单漂移）', async () => {
    const { stagePackAppRoot } = await import('../scripts/pack-app-root.mjs')
    const root = fakePackageRoot()
    // 手工写一份"要求摘一个不存在的包"的清单：真清单由 applyChannelVariant 产出、
    // 必然与表一致，这里驱动的是**漂移检测**本身。
    const dir = join(root, 'temp')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'channel-variant.json'), JSON.stringify({
      schema: CHANNEL_VARIANT_SCHEMA,
      variant: 'none',
      modules: ['skills'],
      packages: ['@picoaide/dsh-does-not-exist'],
      bundles: [],
      rows: [],
      directories: [],
    }))
    expect(() => stagePackAppRoot(root, 'dist')).toThrow(/漂移/u)
  })
})
