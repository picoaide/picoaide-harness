import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CHANNEL_VARIANT_SCHEMA,
  type ChannelVariantManifest,
} from '../scripts/channel-variant.ts'
import {
  assertFeatureModuleDirs,
  assertFeatureModulePresence,
  assertRequiredEntriesCoverWorkspaceSurface,
  assertVariantDeclarationConsistency,
  assertWorkspacePackageCoverage,
  declaredFeaturePrune,
  effectiveVariantEntries,
  effectivePackagedRuntimeEntries,
  packagedRuntimeVariantView,
  REQUIRED_ASAR_EXPORTS,
  REQUIRED_PACKAGED_RUNTIME_ENTRIES,
  REQUIRED_PROFILE_PATCH_ANCHORS,
  REQUIRED_WORKSPACE_PACKAGE_COVERAGE,
  REQUIRED_WORKSPACE_PACKAGE_COVERAGE_MANIFEST_FLOOR,
  verifyPackagedRuntime,
  type ArchiveLister,
  type PackageEntryReader,
} from '../scripts/verify-packaged-runtime.ts'
import type { PackagedRuntimeContext } from '../scripts/verify-packaged-runtime.ts'
import { FEATURE_MODULE_SURFACES } from '../src/channel-features.ts'

/** 造一份变体清单（形状与 `applyChannelVariant()` 的产物同形）。 */
function manifest(modules: readonly string[], packages: readonly string[]): ChannelVariantManifest {
  return {
    schema: CHANNEL_VARIANT_SCHEMA,
    variant: modules.join(','),
    modules,
    packages,
    bundles: packages,
    rows: [],
    directories: [],
  }
}

const SKILLS_PACKAGE = '@picoaide/dsh-capability-center'
const CONNECTORS_PACKAGE = '@picoaide/dsh-connectors'

const skillsClosed = manifest(['skills'], [SKILLS_PACKAGE])
const connectorsClosed = manifest(['connectors'], [CONNECTORS_PACKAGE])
const bothClosed = manifest(['skills', 'connectors'], [SKILLS_PACKAGE, CONNECTORS_PACKAGE])

/** 一个包在某个归档里的全部条目（前缀匹配，边界是 `/`）。 */
function entriesOf(entries: Iterable<string>, pkg: string): string[] {
  const prefix = `node_modules/${pkg}/`
  return [...entries].filter(entry => entry.startsWith(prefix))
}

/**
 * 随包声明（`build/channel.json`）的就位 / 还原。
 *
 * 2026-10-14 R2 审计 S3 起，`verifyPackagedRuntime()` 的缺席判据以**随包声明**为
 * 权威（`resolveVariantManifestUnderDeclaration()`）：只写 `temp/channel-variant.json`
 * 而不写随包 `channel.json` 是"声明全开 + 清单仍在"的漂移态 —— 那也是正确的红，
 * 但不是这些用例要测的那条判据（它们要测"关闭的模块仍在产物里 ⇒ 拒包"）。所以用例
 * 必须把两侧就位成**一致**的形态。
 * @param features - 随包声明的 features（必须与 `applyChannelVariant()` 的开关一致）。
 * @param body - 声明就位期间执行的用例体。
 * @returns 用例体的返回值。
 */
function withPackagedDeclaration<T>(features: Record<string, boolean>, body: () => T): T {
  const file = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'build', 'channel.json')
  const had = existsSync(file)
  const backup = had ? readFileSync(file, 'utf8') : undefined
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({
    channel_id: 'fixture',
    desktop: { app_origin_scheme: 'fixture-app' },
    features,
  }, null, 2)}\n`)
  try {
    return body()
  } finally {
    if (backup === undefined) rmSync(file, { force: true })
    else writeFileSync(file, backup)
  }
}

describe('变体视图：全开构建逐元素等于裸表（官方/全开零影响）', () => {
  it('没有清单时三张表 + 下限 + 剪枝集全部原样', () => {
    const view = packagedRuntimeVariantView(null)
    expect(view.manifest).toBeUndefined()
    expect(view.prunedPackages).toEqual([])
    expect(view.flat).toBe(REQUIRED_PACKAGED_RUNTIME_ENTRIES)
    expect(view.asarExports).toBe(REQUIRED_ASAR_EXPORTS)
    expect(view.anchors).toBe(REQUIRED_PROFILE_PATCH_ANCHORS)
    expect(view.floors).toBe(REQUIRED_WORKSPACE_PACKAGE_COVERAGE)
    expect(view.manifestFloor).toBe(REQUIRED_WORKSPACE_PACKAGE_COVERAGE_MANIFEST_FLOOR)
    expect(effectiveVariantEntries(view)).toEqual(effectivePackagedRuntimeEntries())
    expect(effectiveVariantEntries(view).length).toBe(REQUIRED_WORKSPACE_PACKAGE_COVERAGE_MANIFEST_FLOOR)
  })
})

describe('变体视图：按声明折叠（少一条就少一道门，所以逐条点名）', () => {
  it('关闭 skills：扁平表 −5、锚点表 −2、导出表不变、总下限 138 → 133', () => {
    const view = packagedRuntimeVariantView(skillsClosed)
    expect(view.flat).toEqual(REQUIRED_PACKAGED_RUNTIME_ENTRIES.filter(entry => !entry.includes(SKILLS_PACKAGE)))
    expect(view.flat.length).toBe(REQUIRED_PACKAGED_RUNTIME_ENTRIES.length - 5)
    expect(view.asarExports).toEqual(REQUIRED_ASAR_EXPORTS)
    expect(view.anchors.length).toBe(REQUIRED_PROFILE_PATCH_ANCHORS.length - 2)
    expect(view.floors.map(floor => floor.package)).not.toContain('dsh-capability-center')
    expect(view.manifestFloor).toBe(REQUIRED_WORKSPACE_PACKAGE_COVERAGE_MANIFEST_FLOOR - 5)
    expect(effectiveVariantEntries(view).length).toBe(view.manifestFloor)
  })

  it('关闭 connectors：扁平表不变、导出表 −6、锚点表 −2、总下限 138 → 131', () => {
    const view = packagedRuntimeVariantView(connectorsClosed)
    // connectors 的扁平条目**本来**就是 0 条（全部在导出映射表里）—— 这一条专门钉住
    // "按并集削减"：按单张表削减会把 connectors 的削减量算成 0，于是总下限维持 138
    // 而生效清单只有 131 条 ⇒ 变体构建**假红**。
    expect(view.flat).toEqual(REQUIRED_PACKAGED_RUNTIME_ENTRIES)
    expect(view.asarExports.length).toBe(REQUIRED_ASAR_EXPORTS.length - 6)
    expect(view.anchors.length).toBe(REQUIRED_PROFILE_PATCH_ANCHORS.length - 2)
    expect(view.floors.map(floor => floor.package)).not.toContain('dsh-connectors')
    expect(view.manifestFloor).toBe(REQUIRED_WORKSPACE_PACKAGE_COVERAGE_MANIFEST_FLOOR - 7)
    expect(effectiveVariantEntries(view).length).toBe(view.manifestFloor)
  })

  it('两个模块同时关闭：总下限 138 → 126（削减量按三张表的并集算，重复只算一次）', () => {
    const view = packagedRuntimeVariantView(bothClosed)
    expect(view.manifestFloor).toBe(REQUIRED_WORKSPACE_PACKAGE_COVERAGE_MANIFEST_FLOOR - 12)
    expect(effectiveVariantEntries(view).length).toBe(view.manifestFloor)
    expect(view.prunedPackages).toEqual([SKILLS_PACKAGE, CONNECTORS_PACKAGE])
  })

  it('折叠后的视图能过它自己的两条棘轮（下限与视图同源，不是"永远放宽"）', () => {
    for (const closed of [skillsClosed, connectorsClosed, bothClosed]) {
      const view = packagedRuntimeVariantView(closed)
      expect(() => assertWorkspacePackageCoverage(
        effectiveVariantEntries(view), view.floors, view.manifestFloor,
      )).not.toThrow()
    }
  })

  it('砍掉超过声明量的条目照样红（折叠只削减被关闭模块那几条，不是把整条判据关掉）', () => {
    const view = packagedRuntimeVariantView(skillsClosed)
    const without = effectiveVariantEntries(view).filter(entry => !entry.endsWith('/lib/client.js'))
    expect(() => assertWorkspacePackageCoverage(
      without, view.floors, view.manifestFloor,
    )).toThrow(/覆盖计数低于棘轮下限/u)
  })

  it('用**全量**下限去判折叠后的清单必须红 —— 证明折叠是承重的、不是装饰', () => {
    const view = packagedRuntimeVariantView(skillsClosed)
    expect(() => assertWorkspacePackageCoverage(
      effectiveVariantEntries(view),
      REQUIRED_WORKSPACE_PACKAGE_COVERAGE,
      REQUIRED_WORKSPACE_PACKAGE_COVERAGE_MANIFEST_FLOOR,
    )).toThrow(/覆盖计数低于棘轮下限/u)
  })
})

describe('缺席判据（承重）：关闭的模块整包不在产物里 + 全开变体看得见每一个模块', () => {
  /** 全开变体的"归档条目集"：生效清单 + 六个模块包各一条 manifest（足够了）。 */
  function fullEntries(): Set<string> {
    const entries = new Set(effectivePackagedRuntimeEntries())
    for (const surface of FEATURE_MODULE_SURFACES) {
      for (const pkg of surface.packages) entries.add(`node_modules/${pkg}/package.json`)
    }
    return entries
  }

  it('全开变体：六个模块包都在 → 通过（量具自检的正面）', () => {
    expect(() => assertFeatureModulePresence(fullEntries(), 'fixture.asar', null)).not.toThrow()
  })

  it('全开变体：少了任何一个模块包都红（量具自检的负面 —— 否则"关闭变体里没有"恒真）', () => {
    for (const surface of FEATURE_MODULE_SURFACES) {
      for (const pkg of surface.packages) {
        const entries = fullEntries()
        for (const entry of entriesOf(entries, pkg)) entries.delete(entry)
        expect(
          () => assertFeatureModulePresence(entries, 'fixture.asar', null),
          `${pkg} 缺席时量具自检没有红 —— 那条判据会退化成恒真`,
        ).toThrow(/量具自检失败/u)
      }
    }
  })

  it('关闭 skills：包不在 → 通过；包还在 → 红（承重的那个方向）', () => {
    const without = fullEntries()
    for (const entry of entriesOf(without, SKILLS_PACKAGE)) without.delete(entry)
    expect(() => assertFeatureModulePresence(without, 'fixture.asar', skillsClosed)).not.toThrow()
    // 变异体：把包加回来 = "声明关了、代码还在"（依赖清单没摘干净）。
    expect(() => assertFeatureModulePresence(fullEntries(), 'fixture.asar', skillsClosed))
      .toThrow(/仍随包/u)
    // 一条残留也算（不是只看目录级 manifest）。
    const residue = new Set(without)
    residue.add(`node_modules/${SKILLS_PACKAGE}/lib/client.js`)
    expect(() => assertFeatureModulePresence(residue, 'fixture.asar', skillsClosed))
      .toThrow(/仍随包/u)
  })

  it('关闭 connectors 时，只看同前缀的另一个包不算数（dsh-wasm-apps vs dsh-wasm-apps-host 边界）', () => {
    const entries = fullEntries()
    for (const entry of entriesOf(entries, CONNECTORS_PACKAGE)) entries.delete(entry)
    expect(() => assertFeatureModulePresence(entries, 'fixture.asar', connectorsClosed)).not.toThrow()
    // 前缀必须带 `/` 边界：把 `dsh-wasm-apps` 当成 `dsh-wasm-apps-host` 的残留，
    // 或反过来漏判，都会让这条判据失去意义。
    const wasmOnly = new Set([`node_modules/@picoaide/dsh-wasm-apps/package.json`])
    expect(() => assertFeatureModulePresence(wasmOnly, 'fixture.asar', null))
      .toThrow(/dsh-wasm-apps-host/u)
  })

  it('接线守卫：afterPack 的归档分支必须真的调用这条判据（辅助函数测得到 ≠ 被调用）', async () => {
    // 与既有的两条接线判据同形。**驱动真实现**而不是读源码字面量：给一个"声明关了
    // skills、归档里 skills 还在"的合成 asar，`verifyPackagedRuntime()` 必须拒。
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'pico-variant-afterpack-'))
    const resources = join(root, 'resources')
    mkdirSync(join(resources, 'app.asar.unpacked'), { recursive: true })
    // 归档条目取自**全开**清单（再补齐六个模块包的 manifest）：这样前面那些"缺条目"
    // 的判据不会先红，唯一能让这次验证抛错的就只剩缺席判据本身 —— 它证明这条判据
    // 真的挂在归档分支上，而不是只写在那里。
    const entries = [...effectivePackagedRuntimeEntries()]
    for (const surface of FEATURE_MODULE_SURFACES) {
      for (const pkg of surface.packages) entries.push(`node_modules/${pkg}/package.json`)
    }
    const list: ArchiveLister = () => entries
    const readEntry: PackageEntryReader = () => ''
    writeFileSync(join(resources, 'app.asar'), 'fixture')
    const context = {
      appOutDir: root,
      electronPlatformName: 'linux',
      packager: { appInfo: { productFilename: 'fixture', id: 'ai.deepseek.dsh.desktop' } },
    } as unknown as PackagedRuntimeContext
    // 用真实清单文件驱动：写进 `temp/`（`packagedRuntimeVariantView()` 的缺省读取点）。
    const { applyChannelVariant } = await import('../scripts/channel-variant.ts')
    const { defaultChannelVariantDir } = await import('../scripts/channel-variant.ts')
    const { readFileSync: read, rmSync, existsSync } = await import('node:fs')
    const manifestPath = join(defaultChannelVariantDir(), 'channel-variant.json')
    const hadManifest = existsSync(manifestPath)
    const backup = hadManifest ? read(manifestPath, 'utf8') : undefined
    try {
      // 随包声明与临时清单**两侧一致**地就位（声明是权威，只写清单 = 漂移态）。
      withPackagedDeclaration({ skills: false, apps: true, connectors: true }, () => {
        applyChannelVariant({
          channelId: 'fixture',
          features: { skills: false, apps: true, connectors: true },
          featuresVariant: 'apps,connectors',
          official: false,
        })
        expect(() => verifyPackagedRuntime(context, list, () => true, readEntry))
          .toThrow(/feature-module presence check failed/u)
      })
    } finally {
      if (backup === undefined) rmSync(manifestPath, { force: true })
      else writeFileSync(manifestPath, backup)
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('反向 oracle 的变体面：被裁掉的包不能要求登记', () => {
  it('全开变体：默认参数等于裸表（既有判据逐条不变）', () => {
    // 不带参数调用（生产接线形态）在**没有清单**的树上必须与改造前一致。
    expect(() => assertWorkspacePackageCoverage()).not.toThrow()
    expect(() => assertRequiredEntriesCoverWorkspaceSurface()).not.toThrow()
  })
})

describe('缺席判据在两套布局上都成立（物理布局 = 目录形态）', () => {
  it('声明关闭 skills、物理树上却还有那个包目录 ⇒ 红', async () => {
    const { defaultChannelVariantDir, applyChannelVariant } = await import('../scripts/channel-variant.ts')
    const { existsSync, rmSync, readFileSync, writeFileSync, mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const manifestPath = join(defaultChannelVariantDir(), 'channel-variant.json')
    const had = existsSync(manifestPath)
    const backup = had ? readFileSync(manifestPath, 'utf8') : undefined
    const root = mkdtempSync(join(tmpdir(), 'pico-variant-physical-'))
    const previous = process.env.PACKAGED_RUNTIME_LAYOUT
    try {
      // 随包声明与临时清单**两侧一致**地就位（见 withPackagedDeclaration 的说明）。
      withPackagedDeclaration({ skills: false, apps: true, connectors: true }, () => {
        applyChannelVariant({
          channelId: 'fixture',
          features: { skills: false, apps: true, connectors: true },
          featuresVariant: 'apps,connectors',
          official: false,
        })
        process.env.PACKAGED_RUNTIME_LAYOUT = 'physical'
        const context = {
          appOutDir: root,
          electronPlatformName: 'linux',
          packager: { appInfo: { productFilename: 'fixture', id: 'ai.deepseek.dsh.desktop' } },
        } as unknown as PackagedRuntimeContext
        // 探针一律说"在"：前面几条断言全过，唯一能红的就只剩缺席判据。
        expect(() => verifyPackagedRuntime(context, () => [], () => true, () => ''))
          .toThrow(/feature-module presence check failed/u)
      })
    } finally {
      if (previous === undefined) delete process.env.PACKAGED_RUNTIME_LAYOUT
      else process.env.PACKAGED_RUNTIME_LAYOUT = previous
      if (backup === undefined) rmSync(manifestPath, { force: true })
      else writeFileSync(manifestPath, backup)
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('直接调用 assertFeatureModuleDirs()：两条臂都可达（2026-10-14 R2 审计 P2-1）', () => {
    // 为什么必须**直接调用**：在 `verifyPackagedRuntime()` 的物理分支上，"未被关闭的
    // 模块必须存在"那一臂**不可达** —— 四个模块包全都被更早的必需项 / 必需导出判据
    // 先接住（实测：`packaged runtime … is missing required entries/exports`）。
    // 也就是说留在 `verifyPackagedRuntime()` 里的那个自检臂等于一条永不执行的断言；
    // 直接调用是它唯一可达的接线面。
    const appRoot = '/fixture/physical/app'
    const present = new Set(FEATURE_MODULE_SURFACES.flatMap(surface => surface.packages)
      .map(pkg => join(appRoot, 'node_modules', ...pkg.split('/'))))
    const probe = (path: string): boolean => present.has(path)

    // 承重臂：声明关闭 skills，物理树上还有那个包目录 ⇒ 红。
    expect(() => assertFeatureModuleDirs(appRoot, probe, packagedRuntimeVariantView(skillsClosed)))
      .toThrow(new RegExp(`${SKILLS_PACKAGE} 仍随包`, 'u'))
    // 量具自检臂：没有任何变体关闭它、物理树上却看不到 ⇒ 红（该臂在
    // `verifyPackagedRuntime()` 里被前置判据遮蔽，只有直接调用才打得到）。
    const everythingButCapability = new Set([...present]
      .filter(path => !path.includes('dsh-capability-center')))
    expect(() => assertFeatureModuleDirs(
      appRoot, path => everythingButCapability.has(path), packagedRuntimeVariantView(null),
    )).toThrow(/量具自检失败/u)
    // 正例：全开变体 + 四个模块包都在 ⇒ 不抛。
    expect(() => assertFeatureModuleDirs(appRoot, probe, packagedRuntimeVariantView(null))).not.toThrow()
  })
})

describe('随包声明是裁剪面的权威（2026-10-14 R2 审计 S3）', () => {
  // 直接调用这两个导出（不走磁盘）：三态与"权威是声明而不是临时清单"这两件事
  // 在 `verifyPackagedRuntime()` 里被前后判据裹着，只有直接调用才看得清是哪一态红的。
  const declaredConnectorsOff = { closedModules: [], packages: [], rows: [], directories: [] }

  it('declaredFeaturePrune() 从随包 features 派生关闭面（畸形/缺失一律按全开）', () => {
    expect(declaredFeaturePrune({ features: { connectors: false } } as never)).toEqual({
      closedModules: ['connectors'],
      packages: [CONNECTORS_PACKAGE],
      rows: ['pico-connectors'],
      directories: ['packages/host/connectors'],
    })
    // 没有渠道包（官方/未渠道化构建）= 全开：一个包都不摘。
    expect(declaredFeaturePrune(undefined)).toEqual(declaredConnectorsOff)
    // 畸形取值方向必须"开着"（把 'false' 当关会去加载一个不在包里的模块）。
    expect(declaredFeaturePrune({ features: { connectors: 'false' } } as never).closedModules)
      .toEqual([])
  })

  it('声明有关闭 + 清单缺失 ⇒ 红（不得降级成"全开即通过"）', () => {
    expect(() => assertVariantDeclarationConsistency(
      declaredFeaturePrune({ features: { connectors: false } } as never),
      undefined,
      '/fixture/temp/channel-variant.json',
    )).toThrow(/临时清单缺失/u)
  })

  it('声明与清单不一致（modules / packages / rows 任一）⇒ 红，且两侧都点名', () => {
    const declared = declaredFeaturePrune({ features: { connectors: false } } as never)
    expect(() => assertVariantDeclarationConsistency(declared, skillsClosed, '/fixture/temp/channel-variant.json'))
      .toThrow(/漂移/u)
    expect(() => assertVariantDeclarationConsistency(
      declared,
      { ...connectorsClosed, packages: [], rows: [] },
      '/fixture/temp/channel-variant.json',
    )).toThrow(/packages: 随包声明=\[@picoaide\/dsh-connectors\] vs 临时清单=\[\]/u)
    expect(() => assertVariantDeclarationConsistency(
      declared, { ...connectorsClosed, rows: [] }, '/fixture/temp/channel-variant.json',
    )).toThrow(/rows:/u)
  })

  it('声明全开 + 残留临时清单 ⇒ 红（残留会让产物少掉声明仍打开的模块）', () => {
    const allOpen = declaredFeaturePrune({ features: { skills: true, apps: true, connectors: true } } as never)
    expect(allOpen).toEqual(declaredConnectorsOff)
    expect(() => assertVariantDeclarationConsistency(allOpen, connectorsClosed, '/fixture/temp/channel-variant.json'))
      .toThrow(/features 全开，但构建机临时清单仍在/u)
    // 一致（全开 + 无清单 / 关闭 + 一致清单）⇒ 不抛。
    expect(() => assertVariantDeclarationConsistency(allOpen, undefined, '/fixture/x.json')).not.toThrow()
    const declared = declaredFeaturePrune({ features: { connectors: false } } as never)
    // 一致形态：spec 的 `manifest()` 夹具不写 rows/directories，这里补齐成与声明同源的那份。
    const consistent = {
      ...connectorsClosed,
      rows: ['pico-connectors'],
      directories: ['packages/host/connectors'],
    }
    expect(() => assertVariantDeclarationConsistency(declared, consistent, '/fixture/x.json')).not.toThrow()
    // 目录不一致同样必须红（prebuild 的输入表键）。
    expect(() => assertVariantDeclarationConsistency(
      declared, { ...consistent, directories: [] }, '/fixture/x.json',
    )).toThrow(/directories: 随包声明=\[packages\/host\/connectors\] vs 临时清单=\[\]/u)
  })
})

describe('三份静态清单**不随变体收窄**（口径钉死，不是"忘了改"）', () => {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const repoRoot = resolve(desktopRoot, '..', '..', '..')

  /** 变体清单允许摘掉的仓库目录（= 三个模块的目录）。 */
  const prunedDirs = new Set(FEATURE_MODULE_SURFACES.flatMap(surface => [...surface.directories]))

  it('prebuild 包表 / ci.yml 的 workspace-build 归档 / check-workspaces 的 PACKAGES 都仍是全量', () => {
    // 为什么**不**按变体删这三份清单（任务书点名的那三处）：
    //   · 它们描述的是**仓库**（磁盘上有哪些包、谁依赖谁），不是某一次渠道构建的产物；
    //   · `scripts/verify-inventories.mjs` 用它们与磁盘逐一互拍（少一行就红）；
    //   · CI 的 `gate` job 只构建**一次**、产出**一份** `workspace-build.tgz` 给整条渠道
    //     矩阵复用 ⇒ 按某一个渠道收窄它会让同一次 CI 里其它渠道的打包 job 缺产物；
    //   · 真正让模块不进产物的是 staging `package.json` 的依赖裁剪
    //     （`pack-app-root.mjs`），与这三份清单无关。
    // 变体只允许**从这些清单里挑选**（`variantPrunedDirs()`），不允许改写它们。
    const prebuild = readFileSync(join(desktopRoot, 'scripts', 'prebuild-workspace-deps.ts'), 'utf8')
    const workspace = readFileSync(join(repoRoot, 'scripts', 'check-workspaces.mjs'), 'utf8')
    const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
    for (const dir of prunedDirs) {
      expect(prebuild, `prebuild 包表缺 ${dir}`).toContain(`dir: '${dir}'`)
      expect(workspace, `check-workspaces 包表缺 ${dir}`).toContain(`dir: '${dir}'`)
      expect(workflow, `ci.yml 归档清单缺 ${dir}/lib`).toContain(`${dir}/lib`)
    }
  })

  it('清单里没有任何"按变体条件删行"的分支（否则就不是全量口径了）', () => {
    const prebuild = readFileSync(join(desktopRoot, 'scripts', 'prebuild-workspace-deps.ts'), 'utf8')
    // `variantPrunedDirs()` 是**读取侧**的挑选；包表本身必须还是那个字面量数组。
    expect(prebuild).toContain('export const WORKSPACE_PACKAGES: readonly WorkspacePackage[] = [')
    expect(prebuild).not.toMatch(/WORKSPACE_PACKAGES\s*=\s*WORKSPACE_PACKAGES\.filter/u)
  })
})
