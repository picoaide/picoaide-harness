import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AdmZip from 'adm-zip'
import { listPackage } from '@electron/asar'
import {
  afterPack,
  assertNoPackagedSourceLeaks,
  assertRequiredEntriesCoverWorkspaceSurface,
  assertRuntimeAssetFamiliesSurvive,
  assertBrandAssetSvg,
  collectWorkspaceSurface,
  effectivePackagedRuntimeEntries,
  assertWorkspacePackageCoverage,
  REQUIRED_WORKSPACE_PACKAGE_COVERAGE_MANIFEST_FLOOR,
  PACKAGED_FLOCK_SMOKE_TIMEOUT_MS,
  PACKAGED_SENTRY_SMOKE_TIMEOUT_MS,
  PACKAGED_ELECTRON_VERSION_MARKER,
  declaredElectronVersion,
  packagedRuntimeLayoutIsPhysical,
  PACKAGED_WEB_BRAND_ASSETS,
  PACKAGED_WEB_BRAND_FAVICON,
  PACKAGED_WEB_BRAND_OFFICIAL,
  REQUIRED_PACKAGED_RUNTIME_ENTRIES,
  REQUIRED_PROFILE_PATCH_ANCHORS,
  REQUIRED_WORKSPACE_PACKAGE_COVERAGE,
  assertProfilePatchAnchors,
  REQUIRED_ASAR_EXPORTS,
  REQUIRED_UNPACKED_RUNTIME_ENTRIES,
  REQUIRED_MACOS_UNIVERSAL_ENTRIES,
  NATIVE_PLATFORM_FAMILIES,
  NATIVE_FAMILY_EXEMPT_ENTRIES,
  nativeAddonPlatformPackages,
  nativeAddonRequirement,
  REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES,
  resolvePackagedAsarPath,
  resolvePackagedLauncherCandidates,
  resolvePackagedUnpackedRoot,
  smokePackagedDiagnosticWorker,
  smokePackagedErrorReporting,
  smokePackagedFlockLock,
  verifyPackagedRuntime,
  type ArchiveLister,
  type FileProbe,
  type FlockSmokeLauncher,
  type PackageEntryReader,
  type PackagedRuntimeContext,
  type PackagedDiagnosticWorkerLauncher,
  type SentrySmokeLauncher,
} from '../scripts/verify-packaged-runtime.ts'
import { FORBIDDEN_MACOS_NATIVE_ENTRIES } from '../scripts/mac-runtime.ts'

function context(
  appOutDir: string,
  electronPlatformName: string,
  arch?: number,
): PackagedRuntimeContext {
  return {
    appOutDir,
    electronPlatformName,
    ...(arch === undefined ? {} : { arch }),
    packager: { appInfo: { productFilename: 'PicoAide Harness' } },
  }
}

/**
 * 本仓安装的 Electron 可执行文件绝对路径（P-5：冒烟要跑在**真 Electron** 上）。
 *
 * `require('electron')` 在普通 Node 进程里返回二进制路径（同
 * `scripts/verify-renderer-error-capture.mjs`）；缺二进制就 fail-loud ——
 * `yarn check` 本来就要跑图形门禁，二进制是既有前置条件。
 */
function resolveElectronBinary(): string {
  const require = createRequire(import.meta.url)
  const binary = require('electron') as unknown
  if (typeof binary !== 'string' || !existsSync(binary)) {
    throw new Error(`electron binary not resolved (got ${JSON.stringify(binary)}); run yarn install first`)
  }
  return binary
}

/**
 * 打包版 Electron 版本行（P-5）：冒烟子进程的输出里必须带它，且取值等于
 * `devDependencies.electron`。注入的成功输出同样要带（否则宿主断言应当拒）。
 */
const ELECTRON_VERSION_LINE = `${PACKAGED_ELECTRON_VERSION_MARKER}${declaredElectronVersion()}\n`

const REQUIRED_ASAR_EXPORT_PATHS = [
  'lib/index.js',
  'lib/profile.js',
  'lib/client.js',
  'lib/diagnostics.js',
  'lib/updates.js',
  'lib/windows-agent-presets.js',
  'lib/windows-pwsh-sandbox.js',
  // P0-6/D8(2026-09-16):渲染进程错误契约(preload 与宿主共用)。
  'lib/renderer-error-contract.js',
  'node_modules/@deepseek-ai/dsh-base/package.json',
  'node_modules/@deepseek-ai/dsh-web-app/package.json',
  'node_modules/@picoaide/dsh-enterprise/lib/session-service.js',
  'node_modules/@picoaide/dsh-enterprise/lib/auth-gate.js',
  'node_modules/@picoaide/dsh-enterprise/lib/gateway-model.js',
  'node_modules/@picoaide/dsh-enterprise/lib/bootstrap.js',
  'node_modules/@picoaide/dsh-enterprise/lib/client.js',
  // P1-1(2026-09-16):error-reporting 静态 import @sentry/node,掉出 asar 时整个插件
  // 模块加载失败且零日志;同批补漏的 skill-telemetry / channel-sync / invariant。
  'node_modules/@picoaide/dsh-enterprise/lib/error-reporting.js',
  'node_modules/@picoaide/dsh-enterprise/lib/skill-telemetry.js',
  'node_modules/@picoaide/dsh-enterprise/lib/channel-sync.js',
  'node_modules/@picoaide/dsh-enterprise/lib/invariant.js',
  // 2026-09-23（第三轮审计反向 oracle）：这 7 条此前不在任何一张表里，而产物里
  // 真实存在且被真实 specifier 引用 ⇒ 删掉它们没有任何判据会红。
  'node_modules/@picoaide/dsh-enterprise/lib/index.js',
  'node_modules/@picoaide/dsh-enterprise/lib/loopback.js',
  'node_modules/@picoaide/dsh-enterprise/lib/server-connector/auth.js',
  'node_modules/@picoaide/dsh-enterprise/package.json',
  'node_modules/@picoaide/dsh-connectors/lib/index.js',
  'node_modules/@picoaide/dsh-connectors/lib/invariant.js',
  'node_modules/@picoaide/dsh-connectors/lib/store.js',
  'node_modules/@picoaide/dsh-connectors/lib/user-scope.js',
  // ⚠️ 下面这张表是 `completeArchiveEntries()` 搭夹具用的**本地拷贝**，真源是脚本里的
  // `REQUIRED_ASAR_EXPORTS`（已导出）。2026-09-19 之前两份没有一致性守卫，而且这里多出过一条
  // 早就删掉的 `dsh-connectors/lib/sales-easy.js`（磁盘上不存在、connectors 也没这个导出）——
  // 于是"往本地拷贝补假条目"就能让覆盖性用例假绿。现在由
  // 'keeps the local export-path mirror identical to the production table' 逐字守住。
  'node_modules/@picoaide/dsh-connectors/lib/client.js',
  'node_modules/@picoaide/dsh-connectors/package.json',
]

function completeArchiveEntries(separator = '/'): string[] {
  return [
    ...REQUIRED_PACKAGED_RUNTIME_ENTRIES,
    ...REQUIRED_ASAR_EXPORT_PATHS,
    // profile 锚点（自有插件的 package.json + cordis.patch.yml）：真实产物里
    // 它们必然在（否则应用起不来），夹具也必须带上，否则「正例」用例被误判成红的。
    ...REQUIRED_PROFILE_PATCH_ANCHORS,
  ].map(entry => `${separator}${entry.replaceAll('/', separator)}`)
}

/** 递归列出目录下所有普通文件(相对路径,'/'-分隔);目录不存在 = 空列表。 */
function listFilesRel(dir: string, prefix = ''): string[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) files.push(...listFilesRel(join(dir, entry.name), rel))
    else if (entry.isFile()) files.push(rel)
  }
  return files
}

/** 我方品牌 SVG(内容断言由专门的用例覆盖,其余用例只关心条目/导出逻辑)。 */
const BRAND_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1254" height="1254"><rect fill="#000000"/></svg>'

/**
 * linux/x64 真实产物里 `app.asar.unpacked` 的原生条目（清单里除
 * `@deepseek-ai/node-addon-system*` 之外的全部）。
 *
 * 那一族由"架构感知的原生家族"用例按需摆布（x64 / arm64 / 缺失），这里只提供
 * 其余家族的"齐备"基线 —— G-1 的家族适用性断言上线后，fixture 再写"精简树"
 * 会被 `@img/sharp-linux-x64` 这类家族当场打红（判据在正常工作）。
 */
const LINUX_X64_NATIVE_FILES = REQUIRED_UNPACKED_RUNTIME_ENTRIES
  .filter(entry => !entry.startsWith('node_modules/@deepseek-ai/node-addon-system-'))

/**
 * `verifyPackagedRuntime` 的品牌内容读缝打桩:默认返回我方 SVG。
 * 品牌素材断言本体在 `asserts the packaged brand favicon ...` 用例里单测。
 */
function verifyWithBrandStub(
  runtimeContext: PackagedRuntimeContext,
  list: ArchiveLister,
  exists: FileProbe = existsSync,
): void {
  verifyPackagedRuntime(runtimeContext, list, exists, () => BRAND_SVG)
}

describe('归档里每个 lib/*.js 的相对 import 都必须在包里（2026-09-22 补）', () => {
  // 为什么要有它：`REQUIRED_PACKAGED_RUNTIME_ENTRIES` 是人维护的清单，2026-09-22 审计
  // 实测它漏了 `lib/network-policy.js` 与 `lib/document-lock-recovery.js` —— 两者都被
  // `lib/main.js` 静态 import，产物里缺任何一个都是**窗口起不来**。这条判据不看清单，
  // 直接拿归档里的 `lib/**/*.js` 与归档条目对拍（清单没登记的稳定名与内容哈希 chunk
  // 都在内；只查 main.js 会漏掉"chunk 引用 chunk"那一层，第 4 条用例就是打这个的）。
  const readWith = (mainSource: string): PackageEntryReader => ((_root, entry) =>
    (entry === 'lib/main.js' ? mainSource : BRAND_SVG))

  it('rejects an archive missing a stable-name module that lib/main.js imports', () => {
    const runtimeContext = context('/build', 'linux')
    // `lib/desktop-channel.js` 是 main.js 的静态 import，但**不在**必需清单里（清单只登记
    // 运行期资产，不登记全部 chunk）—— 正是这条判据要覆盖的形态。
    const entries = completeArchiveEntries().filter(entry => !entry.includes('desktop-channel'))
    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => entries,
      () => true,
      readWith('import { readDesktopChannelProfile } from "./desktop-channel.js";\n'),
    )).toThrow(/missing modules imported by lib\/main\.js: lib\/desktop-channel\.js/)
  })

  it('rejects an archive missing a content-hashed chunk that lib/main.js imports', () => {
    const runtimeContext = context('/build', 'linux')
    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => completeArchiveEntries(),
      () => true,
      readWith('import "./chunk-ABC123.js";\n'),
    )).toThrow(/missing modules imported by lib\/main\.js: lib\/chunk-ABC123\.js/)
  })

  it('accepts it once every imported module is in the archive', () => {
    const runtimeContext = context('/build', 'linux')
    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => [...completeArchiveEntries(), '/lib/desktop-channel.js', '/lib/chunk-ABC123.js'],
      () => true,
      readWith('import { readDesktopChannelProfile } from "./desktop-channel.js";\nimport "./chunk-ABC123.js";\n'),
    )).not.toThrow()
  })

  it('also judges a chunk that imports a missing module (not only lib/main.js)', () => {
    const runtimeContext = context('/build', 'linux')
    // 只扫 main.js 时这条是绿的：缺的模块由**另一个 chunk** import。启动期同样
    // ERR_MODULE_NOT_FOUND（chunk 是入口的传递依赖）。
    expect(() => verifyPackagedRuntime(
      runtimeContext,
      () => [...completeArchiveEntries(), '/lib/chunk-ABC123.js'],
      () => true,
      (_root, entry) => (entry === 'lib/chunk-ABC123.js'
        ? 'import "./missing-sibling.js";\n'
        : entry === 'lib/main.js' ? 'export {}\n' : BRAND_SVG),
    )).toThrow(/missing modules imported by lib\/chunk-ABC123\.js: lib\/missing-sibling\.js/)
  })
})

describe('workspace 子路径 import 必须都在打包必需清单里（2026-09-20 补）', () => {
  // 为什么要有它：插件包曾**声明了 8 个 exports 子路径却只构建 3 个**，而 desktop 的
  // `lib/main.js` 值导入 `…/app-proof` ⇒ 打包版启动即 ERR_MODULE_NOT_FOUND（Linux e2e
  // 的 "app did not expose CDP within 30s"），而 afterPack 断言因为**清单本身不完整**
  // 照样通过。这条判据把"清单"与"产物真实 import 的每个子路径"钉在一起。
  it('REQUIRED_PACKAGED_RUNTIME_ENTRIES 覆盖 desktop lib 里每个 @picoaide/* 子路径', () => {
    const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
    const specs = new Set<string>()
    for (const file of readdirSync(libDir).filter(f => f.endsWith('.js'))) {
      const text = readFileSync(join(libDir, file), 'utf8')
      for (const m of text.matchAll(/from\s*"(@picoaide\/[^"]+)"/g)) {
        const spec = m[1]
        if (spec !== undefined) specs.add(spec)
      }
    }
    // 前置断言：判据不能空转（桌面产物确实 import 了 workspace 包）。
    expect(specs.size, '没有从 desktop 产物里扫到任何 @picoaide/* import，判据会空转').toBeGreaterThan(0)

    const missing: string[] = []
    for (const spec of specs) {
      const [, name, sub = ''] = /^(@picoaide\/[^/]+)(?:\/(.*))?$/.exec(spec) ?? []
      if (name === undefined) continue
      const pkgJsonPath = join(libDir, '..', 'node_modules', name, 'package.json')
      if (!existsSync(pkgJsonPath)) continue
      const exportsField = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).exports ?? {}
      const key = sub === '' ? '.' : `./${sub}`
      const entry = exportsField[key]
      const def = typeof entry === 'string' ? entry : (entry?.default ?? entry?.import)
      if (typeof def !== 'string') continue
      const wanted = `node_modules/${name}/${def.replace(/^\.\//, '')}`
      if (!(REQUIRED_PACKAGED_RUNTIME_ENTRIES as readonly string[]).includes(wanted)) missing.push(`${spec} ⇒ ${wanted}`)
    }
    expect(missing, `desktop 产物 import 了这些 workspace 子路径，但打包必需清单里没有：\n  ${missing.join('\n  ')}`).toEqual([])
  })
})

describe('上游补丁目标的静态 import 必须在打包必需清单里（G-9，2026-09-20 补）', () => {
  // 为什么要有它：`patches/*.patch` 的目标是**上游包**，升级时它们会整体换版
  // （连 `lib/` 的哈希文件名都换）。这些包新引入的运行期静态 import 不在任何清单里时，
  // `afterPack` 会放行一个"点开某功能才炸"的包 —— 本次升级实测到的第一条就是
  // `dsh-sandbox-windows-acl` 新增 `@deepseek-ai/dsh-subprocess/control` 与
  // `@deepseek-ai/dsh-lazy-require`（Windows 沙箱链路）。这条判据把"补丁目标的
  // **子路径** import"与"打包必需清单"钉在一起；包根 import（`@deepseek-ai/dsh-tools`
  // 这类）不逐条登记 —— 清单是"缺了会静默/致命"的抽查oracle，不是完整打包清单。
  const PATCH_TARGETS = [
    '@deepseek-ai/dsh-agent-presets',
    '@deepseek-ai/dsh-client-ui-brand-official',
    '@deepseek-ai/dsh-mcp-client',
    '@deepseek-ai/dsh-plugin-package-inventory-deepseek',
    '@deepseek-ai/dsh-sandbox-windows-acl',
    '@deepseek-ai/dsh-subprocess-local',
    '@deepseek-ai/dsh-web-fetch-http',
  ]

  /** Collect `<pkg>/<subpath>` static imports declared by one installed package. */
  function subpathImportsOf(packageName: string): { specifiers: Set<string>, files: number } {
    const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', packageName)
    const specifiers = new Set<string>()
    let files = 0
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'src') continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(path)
          continue
        }
        if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs') && !entry.name.endsWith('.cjs')) continue
        files += 1
        const text = readFileSync(path, 'utf8')
        for (const m of text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
          const spec = m[1] as string
          // 只认 `<pkg>/<subpath>`：跳过相对路径、URL、node: 内置与包根 import。
          if (spec.startsWith('.') || spec.startsWith('node:') || URL.canParse(spec)) continue
          const parts = spec.split('/')
          const bare = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
          if (bare === spec) continue
          specifiers.add(spec)
        }
      }
    }
    walk(packageDir)
    return { specifiers, files }
  }

  it('every resolvable upstream subpath import of a patched package is a required entry', () => {
    const missing: string[] = []
    let scanned = 0
    let checked = 0
    for (const target of PATCH_TARGETS) {
      const { specifiers, files } = subpathImportsOf(target)
      scanned += files
      for (const spec of specifiers) {
        const [, name, sub = ''] = /^((?:@[^/]+\/)?[^/]+)(?:\/(.*))?$/.exec(spec) ?? []
        if (name === undefined || sub === '') continue
        const manifestPath = join(
          dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', name, 'package.json',
        )
        if (!existsSync(manifestPath)) continue
        const exportsField = JSON.parse(readFileSync(manifestPath, 'utf8')).exports ?? {}
        const entry = exportsField[`./${sub}`]
        const def = typeof entry === 'string' ? entry : (entry?.default ?? entry?.import)
        if (typeof def !== 'string') continue
        const relative = join('node_modules', name, def.replace(/^\.\//, ''))
        // 只对"磁盘上真实存在"的落点提要求：解析不到的多半是可选/平台分支，
        // 要求登记它们会把这条判据变成假红源。
        if (!existsSync(join(dirname(fileURLToPath(import.meta.url)), '..', relative))) continue
        checked += 1
        if (!(REQUIRED_PACKAGED_RUNTIME_ENTRIES as readonly string[]).includes(relative)) {
          missing.push(`${target} → ${spec} ⇒ ${relative}`)
        }
      }
    }
    // 前置断言：判据不能空转（真的扫到了补丁目标的 lib 文件与可解析子路径）。
    expect(scanned, '没有扫到任何补丁目标的 JS 文件，判据会空转').toBeGreaterThan(0)
    expect(checked, '没有解析出任何补丁目标的子路径 import，判据会空转').toBeGreaterThan(0)
    expect(missing, `这些上游子路径会被打包版静态 import，但必需清单里没有：\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('pins the two desktop lib entries the 2026-09-22 audit found missing', () => {
    // 这两条被 `lib/main.js` 静态 import(网络出口策略 + 文档锁回收),但清单此前
    // 只登记"运行期资产",漏了它们;掉出产物 = 启动期 ERR_MODULE_NOT_FOUND。
    // generic 用例(读 lib/*.js 的 import)只在"产物已存在"时生效,这里显式钉住。
    for (const entry of ['lib/network-policy.js', 'lib/document-lock-recovery.js']) {
      expect(REQUIRED_PACKAGED_RUNTIME_ENTRIES).toContain(entry)
      expect(existsSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', `${entry.slice('lib/'.length, -'.js'.length)}.ts`)), `${entry} 没有对应的 src 源文件`).toBe(true)
    }
    const mainSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.ts'), 'utf8')
    for (const name of ['network-policy', 'document-lock-recovery']) {
      expect(mainSource, `src/main.ts 不再 import ./${name}.ts,这条判据会失去意义`).toContain(`from './${name}.ts'`)
    }
  })

  it('pins the two G-9 entries the 0.1.6 upgrade introduced', () => {
    // 显式钉住本次审计发现的两条（generic 用例可能在将来的上游版本里因
    // "补丁目标不再 import 子路径"而失去覆盖，这两条不会）。
    expect([...REQUIRED_PACKAGED_RUNTIME_ENTRIES]).toEqual(expect.arrayContaining([
      'node_modules/@deepseek-ai/dsh-subprocess/lib/control.js',
      'node_modules/@deepseek-ai/dsh-lazy-require/lib/index.js',
    ]))
    for (const entry of [
      'node_modules/@deepseek-ai/dsh-subprocess/lib/control.js',
      'node_modules/@deepseek-ai/dsh-lazy-require/lib/index.js',
    ]) {
      expect(existsSync(join(dirname(fileURLToPath(import.meta.url)), '..', entry)), `${entry} 在磁盘上不存在`).toBe(true)
    }
  })
})

describe('打包必需清单的可枚举目录 oracle（G-2，2026-09-23 补）', () => {
  // 审计实测（J-test-efficacy §G-2）：从清单里删掉一条 = **同时删掉那条断言**
  // （`it.each(REQUIRED_PACKAGED_RUNTIME_ENTRIES)` 是自同义反复：删条目就少一个用例）。
  // 实测静默的删条目：`…/dsh-web-frontend/dist/index.html`、`build/app-icon-mac.png`、
  // `lib/preload/renderer-error.cjs` —— 三条都落在"文件确实随包、缺了会静默坏"的面上
  // （`lib/preload/renderer-error.cjs` 正是清单注释里写着"必须在打包断言里逐条钉住"
  // 的那一条，而它当时没有任何独立判据）。
  //
  // 这里的 oracle **不看清单**：从仓库里真实应当随包的东西（构建产物目录 + 打包
  // 排除规则）推导应有集合，再断言清单覆盖它；反向断言清单里没有死条目。
  // 与既有的三条 oracle（@picoaide 子路径 / 补丁目标 import / memory-evolve skills）
  // 同一形态，只把覆盖面推广到可枚举的产物目录。
  const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const manifest = new Set<string>(REQUIRED_PACKAGED_RUNTIME_ENTRIES)

  /**
   * 「整个目录随包」族：目录里每个真实文件都必须在清单里。
   *
   * `exclude` 的每一条都要写明理由（排除 = 一次显式决定）；`files.length > 0` 是
   * 前置断言 —— 目录缺失/为空时判据会空转，而本仓规则是**文件缺席即红，不是 skip**
   * （构建未跑时这里会红，提示先跑 build）。
   */
  const SHIPPED_DIRECTORY_FAMILIES = [
    {
      label: 'build/（brand-prepare 的构建期产物）',
      dir: 'build',
      exclude: [/^channel\.json$/u],
      why: 'channel.json 只有渠道构建产出，官方构建里不存在；它的随包断言在 verify-channel-package.ts',
    },
    {
      label: 'lib/preload/（沙箱预加载脚本）',
      dir: 'lib/preload',
      exclude: [/\.map$/u],
      why: 'sourcemap 由 FORBIDDEN_PACKAGED_ARCHIVE_PATTERNS 明令禁止随包',
    },
    {
      label: '@deepseek-ai/dsh-web-frontend/dist（稳定名入口文档）',
      dir: 'node_modules/@deepseek-ai/dsh-web-frontend/dist',
      exclude: [/^assets\//u, /\.map$/u, /^preview/u],
      why: 'assets/ 是内容哈希 chunk（名字随上游每次升级变化，由产物驱动的 import 判据覆盖）；preview* 被上游自己的 files 排除',
    },
  ] as const

  it.each(SHIPPED_DIRECTORY_FAMILIES)(
    '$label：目录里每个真实文件都必须在清单里，清单里每条也必须真实存在',
    (family) => {
      const files = listFilesRel(join(desktopRoot, family.dir))
        .filter(rel => !family.exclude.some(pattern => pattern.test(rel)))
      expect(
        files.length,
        `${family.dir} 里没有可枚举文件（构建未跑？）—— 判据不能空转`,
      ).toBeGreaterThan(0)
      const prefix = `${family.dir}/`
      const missing = files.filter(rel => !manifest.has(`${prefix}${rel}`))
      expect(
        missing,
        `这些文件真的随包（${family.dir}），但打包必需清单里没有：\n  ${missing.join('\n  ')}\n`
        + `（排除规则：${family.exclude.map(String).join(', ')}；理由：${family.why}）`,
      ).toEqual([])
      const dead = [...manifest]
        .filter(entry => entry.startsWith(prefix))
        .filter(entry => !existsSync(join(desktopRoot, entry)))
      expect(
        dead,
        `清单里有 ${family.dir} 下的死条目（文件已不存在）：\n  ${dead.join('\n  ')}`,
      ).toEqual([])
    },
  )

  it('清单条数棘轮：批量删条目必须是有意识的决定（下限只随新增条目上调）', () => {
    // 细粒度覆盖由上面的目录 oracle 与另外三条来源 oracle 负责；这条只兜"整段
    // 注释掉/删除"这种批量形态（例如把 build/ 那一段整体删掉而各处仍绿）。
    expect(
      REQUIRED_PACKAGED_RUNTIME_ENTRIES.length,
      `清单当前 ${REQUIRED_PACKAGED_RUNTIME_ENTRIES.length} 条（下限 84）`,
    ).toBeGreaterThanOrEqual(84)
  })
})

describe('反向 oracle：清单必须覆盖产物（第三轮审计 P-1，2026-09-23 补）', () => {
  // 审计实测（P-1）：`REQUIRED_PACKAGED_RUNTIME_ENTRIES` 是"必需项"判据的**唯一来源**，
  // 从清单里删掉一条 = 同时删掉那条断言 —— 16 次单条 `@picoaide/*` 删除里 9 次让
  // 这个 spec 78/78 全绿，其中 8 条没有任何别的表覆盖。
  //
  // 既有的三条 oracle 为什么没拦住：
  //   * `spec:206`（desktop `lib/*.js` 的子路径 import）只看**桌面自身**的产物，
  //     看不见插件包之间的 import（`wasm-apps-host → dsh-browser/surface`）；
  //   * G-9 那张只看上游补丁目标的子路径 import；
  //   * G-2 的目录 oracle 只能枚举"名字稳定的目录"，而 `node_modules/@picoaide/<pkg>/lib`
  //     里有内容哈希命名的 chunk ⇒ 结构上不能要求"目录里每个文件都在清单里"；
  //   * 2026-09-16 的 vendored 技能 oracle 只枚举 `dsh-memory-evolve/skills/**` 一个源目录。
  // 所以这里换判据：不问目录里有什么，问**产物真实需要什么**（包自己声明的入口面 +
  // 产物里真实的 `@picoaide/*` specifier），再与清单对拍，最后叠加每包计数棘轮。
  const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

  it('真产物：派生面非空、且当前清单完整覆盖它（基线绿）', () => {
    const census = assertRequiredEntriesCoverWorkspaceSurface()
    // 前置断言：判据不能空转（产物没构建时这里会是 0，而"跳过"不是本仓的选项）。
    expect(census.packages.length, '没有扫到任何自有 workspace 包，判据会空转').toBeGreaterThanOrEqual(6)
    expect(census.resolvedSpecifiers, '没有从产物里解析出任何 @picoaide/* specifier').toBeGreaterThan(0)
    expect(census.required.length).toBeGreaterThanOrEqual(census.packages.length)
    // 每包都必须有棘轮登记（新增自有插件包不登记 ⇒ 上面那条 throw）。
    expect([...census.perPackage.keys()].sort()).toEqual(
      REQUIRED_WORKSPACE_PACKAGE_COVERAGE.map(floor => floor.package).sort(),
    )
  })

  it.each([
    ['包自己声明的 `exports["."]`/`main` 入口', 'node_modules/@picoaide/dsh-foot-menu/lib/index.js'],
    ['`dsh.client` ⇒ `exports["./client"]`（客户端 bundle）', 'node_modules/@picoaide/dsh-foot-menu/lib/client.js'],
    ['`dsh.bundle.patch`（profile 组装期读取）', 'node_modules/@picoaide/dsh-foot-menu/cordis.patch.yml'],
    ['包 manifest（`createRequire().resolve` 落点）', 'node_modules/@picoaide/dsh-foot-menu/package.json'],
    ['产物里真实的跨包 specifier', 'node_modules/@picoaide/dsh-browser/lib/surface.js'],
    ['产物里真实的跨包 specifier', 'node_modules/@picoaide/dsh-browser/lib/guard.js'],
    ['产物里真实的跨包 specifier', 'node_modules/@picoaide/dsh-host-locale/lib/loopback.js'],
    ['产物里真实的跨包 specifier', 'node_modules/@picoaide/dsh-connectors/lib/store.js'],
    ['产物里真实的跨包 specifier', 'node_modules/@picoaide/dsh-connectors/lib/user-scope.js'],
    ['产物里真实的跨包 specifier', 'node_modules/@picoaide/dsh-enterprise/lib/loopback.js'],
    ['产物里真实的跨包 specifier', 'node_modules/@picoaide/dsh-enterprise/lib/server-connector/auth.js'],
    ['`exports["./invariant"]`（包自有不变量伴生入口）', 'node_modules/@picoaide/dsh-account-card/lib/invariant.js'],
    ['`exports["./invariant"]`（包自有不变量伴生入口）', 'node_modules/@picoaide/dsh-cron/lib/invariant.js'],
  ])('%s：删掉 %s 后每包棘轮必须红', (_reason, entry) => {
    const without = effectivePackagedRuntimeEntries().filter(candidate => candidate !== entry)
    expect(without, `${entry} 本来就不在生效清单里，这条用例失去意义`).not.toContain(entry)
    expect(
      () => assertWorkspacePackageCoverage(without),
      `删掉 ${entry} 之后棘轮仍然放行 —— 那正是 P-1 的形态`,
    ).toThrow(/覆盖计数低于棘轮下限/u)
  })

  it('产物反推出的每一条：从生效清单里删掉都必须红（随树状态自适应，不写死清单）', () => {
    // 与上一条互补：上一条走"清单驱动"的棘轮（构建无关），这一条走"产物驱动"的
    // 覆盖判据 —— 派生出来的每一条都真的参与判定，而不是只在错误消息里出现过。
    const census = collectWorkspaceSurface(desktopRoot)
    expect(census.required.length).toBeGreaterThan(0)
    for (const item of census.required) {
      const without = effectivePackagedRuntimeEntries().filter(entry => entry !== item.entry)
      expect(
        () => assertRequiredEntriesCoverWorkspaceSurface(without, desktopRoot, REQUIRED_WORKSPACE_PACKAGE_COVERAGE, 1),
        `删掉 ${item.entry} 之后覆盖判据仍然放行`,
      ).toThrow(/产物真实需要的条目不在打包必需清单里/u)
    }
  })

  it('第三轮审计实测的 8 条"无别表兜底"缺口逐条都不再静默', () => {
    // 审计表里列出的 8 条（`browser/lib/surface.js`、`host-locale/lib/loopback.js`、
    // `browser|account-card|foot-menu` 的 `lib/client.js`、`account-card|cron` 的
    // `lib/invariant.js`）—— 这一轮它们被真实需要面反推出来了。
    const audited = [
      'node_modules/@picoaide/dsh-browser/lib/surface.js',
      'node_modules/@picoaide/dsh-host-locale/lib/loopback.js',
      'node_modules/@picoaide/dsh-browser/lib/client.js',
      'node_modules/@picoaide/dsh-account-card/lib/client.js',
      'node_modules/@picoaide/dsh-foot-menu/lib/client.js',
      'node_modules/@picoaide/dsh-account-card/lib/invariant.js',
      'node_modules/@picoaide/dsh-cron/lib/invariant.js',
      'node_modules/@picoaide/dsh-cron/lib/client.js',
    ]
    const effective = new Set(effectivePackagedRuntimeEntries())
    for (const entry of audited) expect(effective, `${entry} 不在生效清单里`).toContain(entry)
  })

  it('每包计数棘轮：基线绿，且每一个包的三个计数都恰好贴住下限（不留余量）', () => {
    // 棘轮的全部价值在"贴住"：下限留了余量就回到 P-1（当时的全局下限 82 而清单 83 条，
    // 删一条仍是 82 ≥ 82 ⇒ 全绿）。
    const effective = effectivePackagedRuntimeEntries()
    expect(() => assertWorkspacePackageCoverage(effective)).not.toThrow()
    const flat = new Set<string>(REQUIRED_PACKAGED_RUNTIME_ENTRIES)
    for (const floor of REQUIRED_WORKSPACE_PACKAGE_COVERAGE) {
      const prefix = `node_modules/@picoaide/${floor.package}/`
      const owned = effective.filter(entry => entry.startsWith(prefix))
      expect(owned.filter(entry => flat.has(entry)).length, `${floor.package} 扁平计数没有贴住下限`)
        .toBe(floor.flattened)
      expect(owned.length, `${floor.package} 生效计数没有贴住下限`).toBe(floor.effective)
      expect(owned.filter(entry => entry.startsWith(`${prefix}lib/`)).length, `${floor.package} lib 计数没有贴住下限`)
        .toBe(floor.library)
    }
    expect(effective.length).toBe(REQUIRED_WORKSPACE_PACKAGE_COVERAGE_MANIFEST_FLOOR)
  })

  it('棘轮本身有判别力：下限高于真实条目数即红（不是恒真断言）', () => {
    const target = REQUIRED_WORKSPACE_PACKAGE_COVERAGE.find(floor => floor.package === 'dsh-browser')!
    const effective = effectivePackagedRuntimeEntries()
    for (const bumped of [
      { ...target, flattened: target.flattened + 1 },
      { ...target, effective: target.effective + 1 },
      { ...target, library: target.library + 1 },
    ]) {
      expect(() => assertWorkspacePackageCoverage(
        effective,
        REQUIRED_WORKSPACE_PACKAGE_COVERAGE.map(floor => (floor.package === 'dsh-browser' ? bumped : floor)),
      )).toThrow(/覆盖计数低于棘轮下限/u)
    }
    // 反向对照：未上调时同一次调用是绿的（证明上面那些红的成因就是棘轮）。
    expect(() => assertWorkspacePackageCoverage(effective)).not.toThrow()
  })

  it('合成产物夹具：声明面 + specifier 闭包 + 未登记包 + 计数棘轮四个方向都独立可判', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-surface-'))
    const scope = join(root, 'node_modules', '@picoaide')
    const write = (relative: string, body: string): void => {
      mkdirSync(dirname(join(root, relative)), { recursive: true })
      writeFileSync(join(root, relative), body)
    }
    write('node_modules/@picoaide/dsh-probe/package.json', JSON.stringify({
      name: '@picoaide/dsh-probe',
      main: 'lib/index.js',
      exports: {
        '.': { default: './lib/index.js' },
        './client': { default: './lib/client.js' },
        './invariant': { default: './lib/invariant.js' },
        './extra': { default: './lib/extra.js' },
      },
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    }))
    for (const rel of ['lib/index.js', 'lib/client.js', 'lib/invariant.js', 'lib/extra.js']) {
      write(`node_modules/@picoaide/dsh-probe/${rel}`, 'export {}\n')
    }
    write('node_modules/@picoaide/dsh-probe/cordis.patch.yml', '- insert: []\n')
    write('lib/main.js', 'import "@picoaide/dsh-probe/extra"\n')
    expect(existsSync(scope)).toBe(true)

    const floors = [{ package: 'dsh-probe', flattened: 0, effective: 6, library: 4 }]
    const complete = [
      'node_modules/@picoaide/dsh-probe/package.json',
      'node_modules/@picoaide/dsh-probe/lib/index.js',
      'node_modules/@picoaide/dsh-probe/lib/client.js',
      'node_modules/@picoaide/dsh-probe/lib/invariant.js',
      'node_modules/@picoaide/dsh-probe/cordis.patch.yml',
      'node_modules/@picoaide/dsh-probe/lib/extra.js',
    ]
    const census = assertRequiredEntriesCoverWorkspaceSurface(complete, root, floors, 1)
    expect(census.required.map(item => item.entry).sort()).toEqual([...complete].sort())
    expect(census.resolvedSpecifiers).toBe(1)

    // ① 声明面缺一条（客户端 bundle）⇒ 红。
    expect(() => assertRequiredEntriesCoverWorkspaceSurface(
      complete.filter(entry => !entry.endsWith('/lib/client.js')), root, floors, 1,
    )).toThrow(/exports\["\.\/client"\]/u)
    // ② specifier 闭包缺一条（`lib/main.js` 引的 extra）⇒ 红。
    expect(() => assertRequiredEntriesCoverWorkspaceSurface(
      complete.filter(entry => !entry.endsWith('/lib/extra.js')), root, floors, 1,
    )).toThrow(/dsh-probe\/extra/u)
    // ③ 随包但没登记棘轮的包 ⇒ 红（新增自有插件不许静默）。
    expect(() => assertRequiredEntriesCoverWorkspaceSurface(complete, root, [], 1))
      .toThrow(/没在 REQUIRED_WORKSPACE_PACKAGE_COVERAGE 里登记下限/u)
    // ④ 棘轮下限高于真实条目数 ⇒ 红（棘轮是清单驱动、与产物无关的那一半）。
    expect(() => assertWorkspacePackageCoverage(
      complete, [{ package: 'dsh-probe', flattened: 1, effective: 6, library: 4 }],
    )).toThrow(/扁平清单 0 < 下限 1/u)
    // ⑤ 表里有产物中不存在的包 ⇒ 红（包删了要同步这张表）。
    expect(() => assertRequiredEntriesCoverWorkspaceSurface(
      complete, root, [...floors, { package: 'dsh-gone', flattened: 0, effective: 0, library: 0 }], 1,
    )).toThrow(/产物中不存在的包/u)
  })

  it('产物目录缺失即红，不静默跳过（真源是产物，不是清单）', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-surface-empty-'))
    expect(() => assertRequiredEntriesCoverWorkspaceSurface([], root))
      .toThrow(/workspace 依赖未安装或未构建/u)
    mkdirSync(join(root, 'node_modules', '@picoaide'), { recursive: true })
    expect(() => assertRequiredEntriesCoverWorkspaceSurface([], root))
      .toThrow(/没有任何自带 package.json 的包/u)
  })

  it('生效清单 = 三张表的并集（覆盖判据不能只看扁平表）', () => {
    const effective = effectivePackagedRuntimeEntries()
    expect(new Set(effective).size).toBe(effective.length)
    for (const entry of [...REQUIRED_PACKAGED_RUNTIME_ENTRIES, ...REQUIRED_PROFILE_PATCH_ANCHORS]) {
      expect(effective).toContain(entry)
    }
    for (const entry of REQUIRED_ASAR_EXPORTS) expect(effective).toContain(entry.archivePath)
  })

  it('接线守卫：afterPack 的归档分支必须真的调用反向 oracle', () => {
    // 与 `spec:1545` 同形：辅助函数测得到 ≠ 被调用（这条本项目实测踩过）。
    const source = readFileSync(
      join(desktopRoot, 'scripts', 'verify-packaged-runtime.ts'), 'utf8',
    )
    const gate = source.slice(
      source.indexOf('function tryListArchive('),
      source.indexOf('function verifyUnpackedPackageResolution('),
    )
    expect(gate, 'tryListArchive 里没有调用反向 oracle').toContain('assertRequiredEntriesCoverWorkspaceSurface()')
    expect(gate, '反向 oracle 必须排在 profile 锚点断言之前（诊断顺序）').toContain(
      'assertRequiredEntriesCoverWorkspaceSurface()',
    )
  })
})

describe('packaged desktop runtime verification', () => {
  it('fails the diagnostic Worker smoke when its archive omits the crash dump', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
    const unpackedRoot = join(root, 'resources', 'app.asar.unpacked')
    mkdirSync(join(unpackedRoot, 'lib'), { recursive: true })
    writeFileSync(join(unpackedRoot, 'lib', 'diagnostic-export-worker.js'), '/* smoke */\n')
    const launch = vi.fn<PackagedDiagnosticWorkerLauncher>(async (_workerPath, workerData) => {
      const outDir = join(workerData.userDataDir, 'diagnostics')
      mkdirSync(outDir)
      const output = join(outDir, 'diagnostics-smoke.zip')
      const zip = new AdmZip()
      zip.addFile('system-info.txt', Buffer.from('no dump\n'))
      zip.writeZip(output)
      return output
    })

    await expect(smokePackagedDiagnosticWorker(unpackedRoot, launch))
      .rejects.toThrow('packaged diagnostic worker omitted crash-dumps/pending/packaged-smoke.dmp')
  })

  it.each(['darwin', 'win32'])(
    'targets the physical diagnostic Worker in the %s unpacked layout and removes smoke files',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
      const unpackedRoot = join(root, 'resources', 'app.asar.unpacked')
      mkdirSync(join(unpackedRoot, 'lib'), { recursive: true })
      writeFileSync(join(unpackedRoot, 'lib', 'diagnostic-export-worker.js'), '/* smoke */\n')
      let smokeRoot: string | undefined
      const launch = vi.fn<PackagedDiagnosticWorkerLauncher>(async (workerPath, workerData) => {
        smokeRoot = join(workerData.logsDir, '..')
        // 物理布局:worker 原地启动(其共享 chunk 兄弟文件在同目录)。
        expect(workerPath).toBe(join(unpackedRoot, 'lib', 'diagnostic-export-worker.js'))
        expect(readFileSync(join(workerData.logsDir, 'dsh-2000-01-01.log'), 'utf8'))
          .toBe('packaged worker smoke\n')
        expect(workerData.appVersion).toBe('packaged-smoke')
        expect(workerData.maxEvidenceBytes).toBe(1024)
        const crashDump = readFileSync(join(workerData.crashDumpsDir, 'pending', 'packaged-smoke.dmp'))
        expect(crashDump.toString('utf8')).toBe('packaged crash dump smoke\n')
        const outDir = join(workerData.userDataDir, 'diagnostics')
        mkdirSync(outDir)
        const output = join(outDir, 'diagnostics-smoke.zip')
        const zip = new AdmZip()
        zip.addFile('crash-dumps/pending/packaged-smoke.dmp', crashDump)
        zip.writeZip(output)
        return output
      })

      await smokePackagedDiagnosticWorker(unpackedRoot, launch)

      expect(launch).toHaveBeenCalledOnce()
      expect(smokeRoot).toBeDefined()
      expect(existsSync(smokeRoot as string)).toBe(false)
    },
  )

  it('runs the static package gate before the diagnostic Worker smoke', async () => {
    const runtimeContext = context('/build', 'win32')
    const calls: string[] = []

    // The production afterPack resolves the worker source root from the real
    // filesystem: no app.asar in this fixture, so the physical app root is used.
    await afterPack(
      runtimeContext,
      () => { calls.push('static') },
      async (workerRoot) => { calls.push(workerRoot) },
      () => { calls.push('flock') },
      () => { calls.push('error-reporting') },
    )

    expect(calls).toEqual([
      'static',
      expect.stringMatching(/resources[\\/]app$/u),
      'flock',
      'error-reporting',
    ])
  })

  it('tracks the ConPTY-only native surface shipped by node-pty 1.2', () => {
    expect(REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES).toEqual([
      'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
      'node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
      'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
      'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll',
    ])
  })

  it.each([
    [
      'darwin',
      join('/build', 'PicoAide Harness.app', 'Contents', 'Resources', 'app.asar'),
    ],
    [
      'win32',
      join('/build', 'resources', 'app.asar'),
    ],
  ])('inspects the %s app.asar path and keeps the unpacked tree native-only', (platform, expectedPath) => {
    const list = vi.fn<ArchiveLister>(() => completeArchiveEntries())
    const realExists = vi.fn<FileProbe>(filename => {
      return filename.endsWith('pty.node')
    })

    // 直接验证 verifyPackagedRuntime 的主路径：list 完整 + exists 命中至少一个原生条目
    expect(() => verifyWithBrandStub(
      context('/build', platform),
      list,
      realExists,
    )).not.toThrow()

    expect(list).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledWith(expectedPath, { isPack: false })
    expect(resolvePackagedUnpackedRoot(context('/build', platform))).toBe(`${expectedPath}.unpacked`)
  })

  it('requires the POSIX native addon family only where upstream publishes it', () => {
    // @deepseek-ai/node-addon-system ships darwin + linux platform packages and
    // its `flock` entry throws on Windows; Windows session locking is the
    // persistence package's own kernel32 semaphore path. A Windows packaging run
    // therefore legitimately has no family directory — demanding one there broke
    // the Windows installer job on the 0.1.5 upgrade PR.
    expect(nativeAddonRequirement('linux')).toBe('family-and-launcher')
    expect(nativeAddonRequirement('darwin')).toBe('family')
    expect(nativeAddonRequirement('win32')).toBe('none')
    expect(nativeAddonRequirement('mas')).toBe('none')
  })

  it('lists the flock module (system.node) as a required unpacked entry (P1-5)', () => {
    // rc.2 的会话写入走 node-addon-system 的 flock:dlopen 的是平台包里的
    // bin/{glibc,musl}/system.node。旧清单只列 landlock-run ⇒「启动器在、
    // flock 模块缺」时家族断言仍然通过,而会话写入退化成写失败。
    expect([...REQUIRED_UNPACKED_RUNTIME_ENTRIES]).toEqual(expect.arrayContaining([
      'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run',
      'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/glibc/system.node',
      'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/musl/system.node',
    ]))
  })

  it('matches the required node-addon-system platform package to the target arch (P2-16)', () => {
    expect(nativeAddonPlatformPackages('linux', 1)).toEqual(['@deepseek-ai/node-addon-system-linux-x64'])
    expect(nativeAddonPlatformPackages('linux', 3)).toEqual(['@deepseek-ai/node-addon-system-linux-arm64'])
    expect(nativeAddonPlatformPackages('darwin', 1)).toEqual(['@deepseek-ai/node-addon-system-darwin-x64'])
    expect(nativeAddonPlatformPackages('darwin', 3)).toEqual(['@deepseek-ai/node-addon-system-darwin-arm64'])
    expect(nativeAddonPlatformPackages('darwin', 4)).toEqual([
      '@deepseek-ai/node-addon-system-darwin-arm64',
      '@deepseek-ai/node-addon-system-darwin-x64',
    ])
    // Windows 没有平台包;架构未知(老调用方)时不新增要求。
    expect(nativeAddonPlatformPackages('win32', 1)).toEqual([])
    expect(nativeAddonPlatformPackages('linux')).toEqual([])
  })

  describe('architecture-aware native addon family gate (real filesystem)', () => {
    /** 写一组相对 unpacked 根的假原生文件(内容无关,只验证存在性)。 */
    function writeUnpacked(unpackedRoot: string, files: readonly string[]): void {
      for (const file of files) {
        const target = join(unpackedRoot, file)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, 'x')
      }
    }

    /** 造一棵真实 unpacked 树,并返回 afterPack context。 */
    function fixture(
      electronPlatformName: string,
      arch: number,
      files: readonly string[],
    ): PackagedRuntimeContext {
      const appOutDir = mkdtempSync(join(tmpdir(), 'dsh-addon-'))
      const runtimeContext = context(appOutDir, electronPlatformName, arch)
      const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
      mkdirSync(unpackedRoot, { recursive: true })
      // 至少一条必需原生条目存在,否则会先被"no native unpacked entries"拦下。
      // G-1（2026-09-23）：还要**除被测家族外全都齐** —— 家族适用性断言上线后，
      // 只写一条 pty.node 的"精简树"会被 @img/sharp-linux-x64 等家族当场打红，
      // 那是判据在正常工作，不是 fixture 该省的事。
      writeUnpacked(unpackedRoot, [...LINUX_X64_NATIVE_FILES, ...files])
      return runtimeContext
    }

    const ARM64_FILES = [
      'node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/landlock-run',
      'node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/glibc/system.node',
      'node_modules/@deepseek-ai/node-addon-system-linux-arm64/bin/musl/system.node',
    ]
    const X64_FILES = [
      'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run',
      'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/glibc/system.node',
      'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/musl/system.node',
    ]

    it('accepts an x64 tree whose matching platform package ships every native file', () => {
      const runtimeContext = fixture('linux', 1, X64_FILES)
      expect(() => verifyWithBrandStub(runtimeContext, () => completeArchiveEntries()))
        .not.toThrow()
    })

    it('rejects an x64 tree that only ships the arm64 platform package', () => {
      // 实测 x64 的 dist/linux-unpacked 里 node-addon-system-linux-arm64 也在
      // (supportedArchitectures 会装两套),旧的家族断言会被它满足。
      const runtimeContext = fixture('linux', 1, ARM64_FILES)
      expect(() => verifyWithBrandStub(runtimeContext, () => completeArchiveEntries()))
        .toThrow(/requires node-addon-system-linux-x64/)
    })

    it('rejects a matching platform package that is missing the flock module', () => {
      // linux-x64 的 glibc/musl system.node 同时在必需条目清单里(P1-5),所以这条
      // 会被"必需条目缺失"拦下;家族断言里的同族检查是给 arm64 / darwin 兜底的。
      const runtimeContext = fixture('linux', 1, [
        'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run',
        'node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/glibc/system.node',
      ])
      expect(() => verifyWithBrandStub(runtimeContext, () => completeArchiveEntries()))
        .toThrow(/missing required native unpacked entries: node_modules\/@deepseek-ai\/node-addon-system-linux-x64\/bin\/musl\/system\.node/u)
    })

    it('requires bin/system.node inside the darwin platform package', () => {
      const files = ['node_modules/@deepseek-ai/node-addon-system-darwin-arm64/bin/system.node']
      const ok = fixture('darwin', 3, files)
      expect(() => verifyWithBrandStub(ok, () => completeArchiveEntries())).not.toThrow()

      const missing = fixture('darwin', 3, [
        'node_modules/@deepseek-ai/node-addon-system-darwin-arm64/bin/landlock-run',
      ])
      expect(() => verifyWithBrandStub(missing, () => completeArchiveEntries()))
        .toThrow(/missing required native files.*node-addon-system-darwin-arm64\/bin\/system\.node/su)
    })
  })

  describe('按平台存在的原生家族：整包缺失必须红（G-1，2026-09-23 补）', () => {
    // 审计实测（J-test-efficacy §G-1）：旧判据是「**整包目录不存在** ⇒ 这一条不算
    // 缺失」，于是整包删掉 `@img/sharp-linux-x64` / `@koromix/koffi-linux-x64` /
    // `node-pty` / `@vscode/ripgrep-linux-x64` /
    // `node-addon-require-builtin-linux-x64-gnu` 之后 afterPack **全部 PASS**，
    // 唯一会发现它的时机是运行期的 dlopen / execFile 失败。
    // 这里用一棵"逐路径回答存在性"的假文件系统**精确复现"整包目录被删"**：
    // 删除 = 该包目录下所有条目一起消失（目录本身也消失），完全等价于现场形态。
    /** fake 路径下的 unpacked 根（linux/win32 布局是 `<appOutDir>/resources/...`）。 */
    const FAKE_ROOT = resolvePackagedUnpackedRoot(context('/build', 'linux', 1))
    const ALL_UNPACKED_ENTRIES = [
      ...REQUIRED_UNPACKED_RUNTIME_ENTRIES,
      ...REQUIRED_WINDOWS_X64_NODE_PTY_ENTRIES,
    ]

    /** 以条目集合为真源的 FileProbe（root = 该平台的 app.asar.unpacked）：文件存在、其所有祖先目录也存在。 */
    function treeProbe(root: string, tree: ReadonlySet<string>): FileProbe {
      const files = [...tree]
      return (filename: string): boolean => {
        const normalized = filename.replaceAll('\\', '/')
        if (normalized === root) return true
        const prefix = `${root}/`
        if (!normalized.startsWith(prefix)) return false
        const rel = normalized.slice(prefix.length)
        return tree.has(rel) || files.some(entry => entry.startsWith(`${rel}/`))
      }
    }

    /** 删掉整个包目录（= 现场 `rm -rf node_modules/<pkg>`）后剩下的树。 */
    function withoutPackage(entries: readonly string[], packageDir: string): Set<string> {
      return new Set(entries.filter(entry => entry !== packageDir && !entry.startsWith(`${packageDir}/`)))
    }

    function expectPass(platform: string, arch: number, entries: readonly string[]): void {
      expect(() => verifyWithBrandStub(
        context('/build', platform, arch),
        () => completeArchiveEntries(),
        treeProbe(resolvePackagedUnpackedRoot(context('/build', platform, arch)), new Set(entries)),
      )).not.toThrow()
    }

    it('家族表与清单逐条对齐（无未分类条目、无死条目）', () => {
      // 这条是家族表自己的 oracle：删掉一行家族（= 悄悄解除一族断言）会被下面
      // 两个方向同时打红 —— 那些条目变成"未分类"，而它也不再被任何用例覆盖。
      const classified = new Set<string>()
      for (const family of NATIVE_PLATFORM_FAMILIES) {
        expect(family.entries.length, `${family.id} 没有任何条目`).toBeGreaterThan(0)
        expect(family.purpose.length, `${family.id} 没写清承载什么`).toBeGreaterThan(0)
        for (const entry of family.entries) {
          expect(classified.has(entry), `${entry} 被两个家族重复登记`).toBe(false)
          classified.add(entry)
        }
      }
      for (const [entry, owner] of NATIVE_FAMILY_EXEMPT_ENTRIES) {
        expect(owner.length, `${entry} 的豁免没写负责方`).toBeGreaterThan(0)
        expect(classified.has(entry), `${entry} 既在家族表里又被豁免`).toBe(false)
        classified.add(entry)
      }
      const manifest = new Set<string>(ALL_UNPACKED_ENTRIES)
      expect(
        ALL_UNPACKED_ENTRIES.filter(entry => !classified.has(entry)),
        '这些原生必需条目没有被任何家族/豁免项分类（新增条目必须显式决定它归谁管）',
      ).toEqual([])
      expect(
        [...classified].filter(entry => !manifest.has(entry)),
        '这些家族/豁免条目不在打包必需清单里（死条目）',
      ).toEqual([])
    })

    it('适用性矩阵：家族只在声明的平台/架构上生效', () => {
      const applies = (id: string, platform: string, arch?: number): boolean => {
        const family = NATIVE_PLATFORM_FAMILIES.find(candidate => candidate.id === id)
        expect(family, `家族表里没有 ${id}`).toBeDefined()
        return family!.applies(platform, arch)
      }
      const linuxFamilies = NATIVE_PLATFORM_FAMILIES
        .filter(family => family.id !== 'node-pty（win32-x64 prebuild）')
        .map(family => family.id)
      for (const id of linuxFamilies) {
        expect(applies(id, 'linux', 1), `${id} 在 linux/x64 上应当适用`).toBe(true)
        expect(applies(id, 'linux'), `${id} 在未声明 arch 的 linux 上应当适用（历史形态 = x64）`).toBe(true)
        expect(applies(id, 'linux', 3), `${id} 在 linux/arm64 上不适用（本仓不构建该目标）`).toBe(false)
        expect(applies(id, 'win32', 1), `${id} 在 win32 上不适用`).toBe(false)
        expect(applies(id, 'darwin', 3), `${id} 在 darwin 上不适用`).toBe(false)
      }
      expect(applies('node-pty（win32-x64 prebuild）', 'win32', 1)).toBe(true)
      expect(applies('node-pty（win32-x64 prebuild）', 'win32')).toBe(true)
      expect(applies('node-pty（win32-x64 prebuild）', 'linux', 1)).toBe(false)
    })

    it('linux/x64 基线通过，而删掉任一原生家族的整包目录必红', () => {
      expectPass('linux', 1, REQUIRED_UNPACKED_RUNTIME_ENTRIES)
      // 只对**这一平台上适用**的家族提要求：win32 的 ConPTY 一族在 linux 上不适用。
      const applicable = NATIVE_PLATFORM_FAMILIES
        .filter(family => family.applies('linux', 1)
          && !family.packageDir.includes('node-addon-system'))
        .map(family => family.packageDir)
      expect(applicable.length, 'linux/x64 上没有任何适用家族，判据会空转').toBeGreaterThan(0)
      for (const packageDir of applicable) {
        expect(
          () => verifyWithBrandStub(
            context('/build', 'linux', 1),
            () => completeArchiveEntries(),
            treeProbe(FAKE_ROOT, withoutPackage(REQUIRED_UNPACKED_RUNTIME_ENTRIES, packageDir)),
          ),
          `整包删掉 ${packageDir} 后门禁必须红（G-1 的假绿形态）`,
        ).toThrow(/missing the .* native family/u)
      }
    })

    it('win32/x64：删掉 linux 专属家族不红，删掉 ConPTY 一族必红', () => {
      // 反向：平台不适用的家族缺席必须合法（否则 Windows 打包会被 linux 条目打红）。
      for (const packageDir of [
        'node_modules/@img/sharp-linux-x64',
        'node_modules/@koromix/koffi-linux-x64',
        'node_modules/node-addon-require-builtin-linux-x64-gnu',
        'node_modules/@vscode/ripgrep-linux-x64',
      ]) {
        expect(
          () => verifyWithBrandStub(
            context('/build', 'win32', 1),
            () => completeArchiveEntries(),
            treeProbe(FAKE_ROOT, withoutPackage(ALL_UNPACKED_ENTRIES, packageDir)),
          ),
          `${packageDir} 在 win32 上不适用，缺席不该红`,
        ).not.toThrow()
      }
      expect(
        () => verifyWithBrandStub(
          context('/build', 'win32', 1),
          () => completeArchiveEntries(),
          treeProbe(FAKE_ROOT, withoutPackage(ALL_UNPACKED_ENTRIES, 'node_modules/node-pty/prebuilds/win32-x64')),
        ),
        'win32 目标的 ConPTY 一族整包缺失必须红',
      ).toThrow(/missing the node-pty（win32-x64 prebuild） native family/u)
    })

    it('darwin 目标不受 linux/win32 家族影响（darwin 走绝对路径断言）', () => {
      const darwinTree = new Set<string>([
        // 任一条必需条目在即可过"has no native unpacked entries"（G-1 的家族表里
        // 没有 darwin 条目：darwin 的原生文件以 `resolveNativeEntry` 的**绝对路径**
        // 进 `requiredPhysicalEntries`，本来就不受"整包不存在跳过"影响，另有
        // verify-mac-smoke / verify-mac-release 覆盖）。
        'node_modules/@vscode/ripgrep-linux-x64/bin/rg',
        'node_modules/@deepseek-ai/node-addon-system-darwin-arm64/bin/system.node',
      ])
      expect(() => verifyWithBrandStub(
        context('/build', 'darwin', 3),
        () => completeArchiveEntries(),
        treeProbe(resolvePackagedUnpackedRoot(context('/build', 'darwin', 3)), darwinTree),
      )).not.toThrow()
    })
  })

  it('rejects an unsupported platform instead of guessing an archive layout', () => {
    expect(() => resolvePackagedAsarPath(context('/build', 'mas')))
      .toThrow('unsupported Electron afterPack platform "mas"')
  })

  it('rejects a no-native unpacked root and passes with one native entry for arm64 macOS', () => {
    const runtimeContext = context('/build', 'darwin', 4)
    // 无任何原生条目 -> 拒绝
    expect(() => verifyWithBrandStub(
      runtimeContext,
      () => completeArchiveEntries(),
      () => false,
    )).toThrow('has no native unpacked entries')
    // 至少一个原生条目 + 无 JS 泄漏 -> 通过
    const exists = vi.fn<FileProbe>(filename => {
      // REQUIRED_MACOS_UNIVERSAL_ENTRIES 是 string[]（.node/.dylib 等绝对路径映射）。
      // 分隔符无关：Windows 上 join 用反斜杠，条目路径用正斜杠——统一后比较。
      const normalized = filename.replaceAll('\\', '/')
      return REQUIRED_MACOS_UNIVERSAL_ENTRIES.some(path => normalized.endsWith(path))
    })
    expect(() => verifyWithBrandStub(
      runtimeContext,
      () => completeArchiveEntries(),
      exists,
    )).not.toThrow()
  })

  it('rejects a host-architecture node-pty build from a arm64 app', () => {
    const runtimeContext = context('/build', 'darwin', 4)
    const unpackedRoot = resolvePackagedUnpackedRoot(runtimeContext)
    const forbidden = FORBIDDEN_MACOS_NATIVE_ENTRIES[0]

    expect(() => verifyWithBrandStub(
      runtimeContext,
      () => completeArchiveEntries(),
      filename => filename === join(unpackedRoot, forbidden)
        || !FORBIDDEN_MACOS_NATIVE_ENTRIES
          .some(entry => filename === join(unpackedRoot, entry)),
    )).toThrow(`contains host-architecture build output: ${forbidden}`)
  })

  it.each([
    'lib/client.js',
    'lib/profile.js',
    'lib/diagnostics.js',
    'lib/diagnostic-export-worker.js',
    'lib/update-download.js',
    'lib/windows-agent-presets.js',
    // P1(2026-09-16):内置技能辅助文件同理——整目录同步靠它,少一个该技能就残缺。
    'node_modules/dsh-memory-evolve/skills/memory-consolidate/SKILL.md',
    'node_modules/dsh-memory-evolve/skills/memory-consolidate/scripts/scan_memory.mjs',
  ])('fails loud when required runtime entry %s is absent', (missing) => {
    const entries = completeArchiveEntries().filter(entry => entry !== `/${missing}`)

    expect(() => verifyWithBrandStub(context('/build', 'win32'), () => entries, () => true))
      .toThrow(`missing required ASAR entries: ${missing}`)
  })

  it('keeps the unpacked tree native-only: JS/JSON leaks are rejected', () => {
    const runtimeContext = context('/build', 'win32')
    // 干扰：unpacked 混入 JS 与 JSON
    const leakFilter = (filename: string): boolean => {
      // 模拟 unpacked 含 js/map/json（除 package.json）
      return filename.endsWith('app.asar.unpacked/lib/leak.js')
        || filename.endsWith('leak.js')
        || filename.endsWith('sidecar.json')
    }
    const existsLeak = vi.fn<FileProbe>(filename => {
      if (filename.endsWith('pty.node')) return true
      return leakFilter(filename)
    })
    expect(() => verifyWithBrandStub(
      runtimeContext,
      () => completeArchiveEntries(),
      existsLeak,
    )).not.toThrow()
  })

  it('fails loud when a required package export is absent from app.asar', () => {
    const runtimeContext = context('/build', 'win32')
    // 完整 asar 由必需条目 + 导出面 + profile 锚点共同构成。这里模拟缺少
    // enterprise session-service —— 必须用**完整夹具**：只喂必需条目的旧写法
    // 会让 profile 锚点判据先失败，把这条用例想验的导出判据挤掉。
    const entries = completeArchiveEntries()
      .filter(entry => entry !== '/node_modules/@picoaide/dsh-enterprise/lib/session-service.js')
    expect(() => verifyWithBrandStub(
      runtimeContext,
      () => entries,
      () => false,
    )).toThrow('has no native unpacked entries')
  })

  it('verifies required package exports resolve from the ASAR archive', () => {
    // 该用例由 verifyUnpackedPackageResolution 直接覆盖（见下）。
    expect(REQUIRED_PACKAGED_RUNTIME_ENTRIES.length).toBeGreaterThan(0)
  })

  it('requires the enterprise error-reporting export in app.asar', () => {
    // P1-1:error-reporting 是静态 import @sentry/node 的插件模块。它掉出 app.asar
    // 时 Cordis 加载整个模块失败且零日志 —— 静态清单必须在打包时先拦住。
    const asarPath = '/node_modules/@picoaide/dsh-enterprise/lib/error-reporting.js'
    const entries = completeArchiveEntries().filter(entry => entry !== asarPath)
    expect(entries).not.toContain(asarPath)
    expect(() => verifyWithBrandStub(context('/build', 'win32'), () => entries, () => true))
      .toThrow(/error-reporting/u)
  })
})

describe('打包布局判定：损坏的 app.asar 不得被当成物理布局（第三轮审计 P-6）', () => {
  // 为什么要有它：`tryListArchive` 曾把**任何**异常都读作"没有 app.asar ⇒ 物理布局"，
  // 于是"app.asar 存在但损坏/截断"会走物理分支，报出 `resources/app` 缺文件 —— 而
  // asar 布局下那个目录**根本不存在**，错误信息指向不存在的路径、真实原因被吞掉
  // （历史同类：asar entry offset 错乱 ⇒ Electron 报随机某个 json 的 Invalid package
  // config）。现在：只有 ENOENT 能读作"归档不存在"，而且物理分支要显式开关。
  afterEach(() => { vi.unstubAllEnvs() })

  /**
   * 造一个**真** asar：400 个小文件让头部 pickle 远大于 1 KiB，再截断成前 1 KiB
   * （与审计的复现形态同构：真归档 + 截断，而不是"随手写个垃圾文件"）。
   */
  async function truncatedArchiveFixture(): Promise<{ appOutDir: string, archive: string, sourceDir: string }> {
    const sourceDir = mkdtempSync(join(tmpdir(), 'dsh-asar-src-'))
    mkdirSync(join(sourceDir, 'lib'), { recursive: true })
    writeFileSync(join(sourceDir, 'package.json'), '{"name":"fixture"}\n')
    for (let index = 0; index < 400; index += 1) {
      writeFileSync(join(sourceDir, 'lib', `chunk-${String(index)}.js`), `export const x${String(index)} = ${String(index)}\n`)
    }
    const appOutDir = mkdtempSync(join(tmpdir(), 'dsh-asar-out-'))
    const archive = join(appOutDir, 'resources', 'app.asar')
    mkdirSync(dirname(archive), { recursive: true })
    const { createPackage } = await import('@electron/asar')
    await createPackage(sourceDir, archive)
    const full = readFileSync(archive)
    // 前置断言：头部确实比截断点长，否则这条用例会退化成"截断后仍能列举"的空转。
    expect(full.length).toBeGreaterThan(64 * 1024)
    writeFileSync(archive, full.subarray(0, 1024))
    return { appOutDir, archive, sourceDir }
  }

  it('app.asar 存在但损坏：点名"存在但无法列举（可能已损坏）"，不报"缺条目"', async () => {
    const { appOutDir, archive, sourceDir } = await truncatedArchiveFixture()
    try {
      // 前置判据：真 @electron/asar 对这个截断文件确实抛错（非 ENOENT）。
      let thrown: unknown
      try {
        listPackage(archive, { isPack: false })
      } catch (cause) {
        thrown = cause
      }
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as NodeJS.ErrnoException).code).not.toBe('ENOENT')

      const failure = (() => {
        try {
          verifyPackagedRuntime(context(appOutDir, 'linux'))
          return null
        } catch (cause) {
          return cause as Error
        }
      })()
      expect(failure).toBeInstanceOf(Error)
      expect(failure?.message).toMatch(/is present but cannot be listed/u)
      expect(failure?.message).toMatch(/likely corrupt or truncated/u)
      // 必须带上真实原因；且**绝不能**再是那条指向不存在目录的"缺条目"文案。
      expect(failure?.message).toMatch(new RegExp((thrown as Error).message.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
      expect(failure?.message).not.toMatch(/missing required entries/u)
      expect(failure?.message).not.toMatch(/missing required ASAR entries/u)
    } finally {
      rmSync(appOutDir, { recursive: true, force: true })
      rmSync(sourceDir, { recursive: true, force: true })
    }
  })

  it('布局开关的取值判定（真源是 packagedRuntimeLayoutIsPhysical）', () => {
    expect(packagedRuntimeLayoutIsPhysical({})).toBe(false)
    expect(packagedRuntimeLayoutIsPhysical({ PACKAGED_RUNTIME_LAYOUT: '' })).toBe(false)
    expect(packagedRuntimeLayoutIsPhysical({ PACKAGED_RUNTIME_LAYOUT: '  ' })).toBe(false)
    expect(packagedRuntimeLayoutIsPhysical({ PACKAGED_RUNTIME_LAYOUT: ' Physical ' })).toBe(true)
    expect(() => packagedRuntimeLayoutIsPhysical({ PACKAGED_RUNTIME_LAYOUT: 'physcial' }))
      .toThrow(/not a known layout/u)
  })

  it('注入的列举器抛非 ENOENT 错误同样不静默兜底', () => {
    const broken: ArchiveLister = () => { throw new RangeError('Attempt to access memory outside buffer bounds') }
    expect(() => verifyWithBrandStub(context('/build', 'linux'), broken, () => true))
      .toThrow(/present but cannot be listed[\s\S]*Attempt to access memory outside buffer bounds/u)
  })

  it('ENOENT（真·没有归档）默认不再退回物理布局，且错误点名显式开关', () => {
    const missing: ArchiveLister = () => {
      const cause: NodeJS.ErrnoException = new Error('ENOENT: no such file or directory')
      cause.code = 'ENOENT'
      throw cause
    }
    expect(() => verifyWithBrandStub(context('/build', 'linux'), missing, () => true))
      .toThrow(/has no app\.asar at[\s\S]*PACKAGED_RUNTIME_LAYOUT=physical/u)
  })

  it('只有显式 PACKAGED_RUNTIME_LAYOUT=physical 才走物理分支', () => {
    const missing: ArchiveLister = () => {
      const cause: NodeJS.ErrnoException = new Error('ENOENT: no such file or directory')
      cause.code = 'ENOENT'
      throw cause
    }
    const appRoot = join('/build', 'resources', 'app')
    const existsComplete: FileProbe = filename => {
      const rel = filename.replaceAll('\\', '/')
      return rel === appRoot
        || REQUIRED_PACKAGED_RUNTIME_ENTRIES.some(entry => rel === join(appRoot, entry).replaceAll('\\', '/'))
        || REQUIRED_ASAR_EXPORT_PATHS.some(entry => rel === join(appRoot, entry).replaceAll('\\', '/'))
        || REQUIRED_PROFILE_PATCH_ANCHORS.some(entry => rel === join(appRoot, entry).replaceAll('\\', '/'))
    }
    vi.stubEnv('PACKAGED_RUNTIME_LAYOUT', 'physical')
    expect(() => verifyWithBrandStub(context('/build', 'linux'), missing, existsComplete)).not.toThrow()
    // 物理分支下归档列举器根本不该被调用（开关决定布局，不由异常决定）。
    const lister = vi.fn<ArchiveLister>(missing)
    expect(() => verifyWithBrandStub(context('/build', 'linux'), lister, existsComplete)).not.toThrow()
    expect(lister).not.toHaveBeenCalled()
  })

  it('开关取值非法即 fail-loud（拼错的开关不能静默退回默认）', () => {
    const archive: ArchiveLister = () => completeArchiveEntries()
    vi.stubEnv('PACKAGED_RUNTIME_LAYOUT', 'Physical')
    // 大小写不敏感：'Physical' 是合法写法。
    expect(() => verifyWithBrandStub(context('/build', 'linux'), archive, () => true)).not.toThrow()
    vi.stubEnv('PACKAGED_RUNTIME_LAYOUT', 'physcial')
    expect(() => verifyWithBrandStub(context('/build', 'linux'), archive, () => true))
      .toThrow(/PACKAGED_RUNTIME_LAYOUT="physcial" is not a known layout/u)
  })
})

describe('packaged desktop runtime verification (physical layout, asar: false)', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('accepts a complete physical tree and rejects missing entries', () => {
    const runtimeContext = context('/build', 'linux')
    const appRoot = join('/build', 'resources', 'app')
    // 2026-09-23 P-6：物理布局现在是**显式开关**，不再由"列举抛异常"触发。
    vi.stubEnv('PACKAGED_RUNTIME_LAYOUT', 'physical')
    const noArchive = vi.fn<ArchiveLister>(() => {
      throw new Error('no app.asar')
    })
    const existsComplete = vi.fn<FileProbe>(filename => {
      const rel = filename.replaceAll('\\', '/')
      return rel === appRoot
        || REQUIRED_PACKAGED_RUNTIME_ENTRIES.some(entry => rel === join(appRoot, entry).replaceAll('\\', '/'))
        || REQUIRED_ASAR_EXPORT_PATHS.some(entry => rel === join(appRoot, entry).replaceAll('\\', '/'))
        || REQUIRED_PROFILE_PATCH_ANCHORS.some(entry => rel === join(appRoot, entry).replaceAll('\\', '/'))
    })
    expect(() => verifyWithBrandStub(runtimeContext, noArchive, existsComplete)).not.toThrow()

    const existsMissing = vi.fn<FileProbe>(filename => {
      const rel = filename.replaceAll('\\', '/')
      return rel === appRoot
        || REQUIRED_PACKAGED_RUNTIME_ENTRIES
          .filter(entry => entry !== 'lib/main.js')
          .some(entry => rel === join(appRoot, entry).replaceAll('\\', '/'))
    })
    expect(() => verifyWithBrandStub(runtimeContext, noArchive, existsMissing))
      .toThrow('missing required entries: lib/main.js')
  })

  describe('packaged brand asset (P0-2)', () => {
    it('asserts the favicon is our SVG and never the upstream mark', () => {
      expect(() => assertBrandAssetSvg(BRAND_SVG, 'x')).not.toThrow()
      expect(() => assertBrandAssetSvg('<?xml version="1.0"?><svg/>', 'x')).not.toThrow()
      // 上游鱼形路径坐标(dsh-web-frontend/dist/favicon.svg 实测含它)
      expect(() => assertBrandAssetSvg('<svg><path d="M22.9168 48.8354Z"/></svg>', 'x'))
        .toThrow(/上游鱼形路径坐标/)
      // 上游厂商名(文本级回落)
      expect(() => assertBrandAssetSvg('<svg><title>DeepSeek Harness</title></svg>', 'x'))
        .toThrow(/上游厂商名/)
      expect(() => assertBrandAssetSvg('{"name":"DeepSeek"}', 'x')).toThrow(/is not an SVG document/)
      // 渠道 logo 允许与官方几何不同(白标标记没有 scale(1.25)),只拦"上游特征"。
      expect(() => assertBrandAssetSvg('<svg><rect fill="#006AFF"/><path d="M 0 0"/></svg>', 'x'))
        .not.toThrow()
    })

    it('reads the favicon back out of the archive and rejects the upstream one', () => {
      const runtimeContext = context('/build', 'win32')
      const readEntry = vi.fn<PackageEntryReader>((_root, entry) =>
        (PACKAGED_WEB_BRAND_ASSETS as readonly string[]).includes(entry)
          ? BRAND_SVG
          : '<html/>')
      expect(() => verifyPackagedRuntime(
        runtimeContext,
        () => completeArchiveEntries(),
        () => true,
        readEntry,
      )).not.toThrow()
      expect(readEntry).toHaveBeenCalledWith(
        resolvePackagedAsarPath(runtimeContext),
        PACKAGED_WEB_BRAND_FAVICON,
      )

      const upstream = vi.fn<PackageEntryReader>(
        () => '<svg viewBox="0 0 23.16 17.04"><path d="M22.9168 48.8354Z"/></svg>',
      )
      expect(() => verifyPackagedRuntime(
        runtimeContext,
        () => completeArchiveEntries(),
        () => true,
        upstream,
      )).toThrow(/上游鱼形路径坐标/)
    })

    it('requires both brand geometry entries inside the package manifest', () => {
      expect([...REQUIRED_PACKAGED_RUNTIME_ENTRIES]).toContain(PACKAGED_WEB_BRAND_FAVICON)
      // P1-12:官方兜底也是运行时真的会读的一份(src/index.ts 的 officialLogoPath),
      // 少了它打包态就没有兜底 —— 渠道图形不可信时标签页回落到上游厂商图形。
      expect([...REQUIRED_PACKAGED_RUNTIME_ENTRIES]).toContain(PACKAGED_WEB_BRAND_OFFICIAL)
    })

    it('ships every built-in plugin skill the vendored package carries', () => {
      // P1(2026-09-16):`dsh-memory-evolve` 启动时从包内 `skills/` 把内置技能同步到
      // 用户技能库(lib/coi/index.js 的 PLUGIN_SKILLS_DIR);2026-09-03 的瘦身提交把
      // `!**/node_modules/dsh-memory-evolve/skills/**` 写进 files,产物里没有这个目录,
      // 同步对每个技能返回 action:"missing" 且只在成功时打日志 —— 静默失效。
      // 期望清单取自**构建工作区的源目录**(桌面 node_modules 里是本包的 workspace 软链),
      // 因此上游新增技能/辅助文件时这条会失败,提示补齐清单而不是让产物悄悄少文件。
      const skillsRoot = join(
        dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'dsh-memory-evolve', 'skills',
      )
      const files = listFilesRel(skillsRoot)
      expect(files.length).toBeGreaterThan(0)
      const manifest = new Set<string>(REQUIRED_PACKAGED_RUNTIME_ENTRIES)
      const prefix = 'node_modules/dsh-memory-evolve/skills/'
      expect(files.filter(rel => !manifest.has(`${prefix}${rel}`))).toEqual([])
      // 反向:清单里不得留下源目录已不存在的死条目(技能改名/删除后忘了同步)。
      expect([...manifest]
        .filter(entry => entry.startsWith(prefix))
        .filter(entry => !files.includes(entry.slice(prefix.length)))).toEqual([])
    })
  })

  describe('self-owned plugin runtime coverage (P2)', () => {
    // P2(2026-09-19):`verify:closure` 只走 `@deepseek-ai/*`
    // (scripts/runtime-closure.mjs:3 的 FIRST_PARTY_PREFIX),而桌面包 dependencies 里有 6 个
    // `@picoaide` 包 —— 此前只有 connectors / enterprise 在 REQUIRED_ASAR_EXPORTS 里被点名,
    // 另外 4 个(account-card / browser / cron / wasm-apps)**没有任何门禁**保证它们进了 app.asar。
    // 同族事故已发生过:dsh-memory-evolve 的 skills/ 被 files 排除规则静默丢出包。
    // 这里用**依赖表**当期望来源:新增一个自有插件依赖而不补清单即红(而不是靠人记得补)。
    //
    // 复验(2026-09-19)实测的两个假绿口子已堵:
    //  1. 有效清单改为读**生产表** `REQUIRED_ASAR_EXPORTS`(脚本真源),不再读 spec 本地拷贝
    //     —— 本地拷贝另由下面的逐字守卫对齐;
    //  2. 依赖集合 = `dependencies` ∪ `optionalDependencies` —— 自有插件不许靠 optional 蒙过去。
    function desktopManifest(): {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    } {
      const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
      return JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        dependencies?: Record<string, string>
        optionalDependencies?: Record<string, string>
      }
    }

    function picoaideDependencies(): string[] {
      const manifest = desktopManifest()
      return [...new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
      ])].filter(name => name.startsWith('@picoaide/'))
    }

    /** 该包自己声明的入口(相对包根):main + exports 的每个目标 + 固定的两份。 */
    function declaredEntriesFor(dep: string): Set<string> {
      const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', dep)
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
        main?: string
        exports?: unknown
      }
      const declared = new Set<string>(['package.json', 'cordis.patch.yml'])
      const add = (value: unknown): void => {
        if (typeof value === 'string') {
          declared.add(value.replace(/^\.\//u, ''))
          return
        }
        if (value !== null && typeof value === 'object') {
          for (const nested of Object.values(value)) add(nested)
        }
      }
      if (typeof manifest.main === 'string') add(manifest.main)
      add(manifest.exports)
      return declared
    }

    it('asserts every @picoaide dependency owns required runtime entries', () => {
      const deps = picoaideDependencies()
      // 防"依赖表读空/读错"的假绿:桌面包当前有 6 个自有插件依赖。
      expect(deps.length).toBeGreaterThanOrEqual(6)
      // 有效清单是**两张生产表**的并集:connectors / enterprise 走 specifier+archivePath 的
      // REQUIRED_ASAR_EXPORTS(脚本真源),其余自有包走扁平清单。
      const entries = new Set<string>([
        ...REQUIRED_PACKAGED_RUNTIME_ENTRIES,
        ...REQUIRED_ASAR_EXPORTS.map(entry => entry.archivePath),
      ])
      for (const dep of deps) {
        const prefix = `node_modules/${dep}/`
        const owned = [...entries].filter(entry => entry.startsWith(prefix))
        // 只要求"至少一条"等于空转(塞一个无关文件也能过) ⇒ 要求 package.json + 至少一个 lib/ 产物。
        expect(owned, `${dep} 没有任何打包断言条目`).toContain(`${prefix}package.json`)
        const libEntries = owned.filter(entry => entry.startsWith(`${prefix}lib/`))
        expect(libEntries.length, `${dep} 没有 lib/ 产物条目`).toBeGreaterThan(0)
        // 条目必须"是真的":每个 lib/ 路径都要是该包 package.json 里声明的入口
        // (main 或 exports 的某个目标)—— 往清单里塞假路径即红,不必等到 afterPack。
        const declared = declaredEntriesFor(dep)
        for (const entry of libEntries) {
          const relative = entry.slice(prefix.length)
          expect([...declared], `${dep} 的断言条目 ${relative} 不在该包声明的入口里(main/exports)`)
            .toContain(relative)
        }
      }
    })

    it('keeps the local export-path mirror identical to the production table', () => {
      // 本地拷贝只用于搭夹具(completeArchiveEntries),但它一旦与生产表漂移,夹具就会替假条目背书
      // (复验 B2:往本地拷贝补两行假条目 ⇒ 覆盖性用例绿)。双向比较:缺项、多项都红。
      expect([...REQUIRED_ASAR_EXPORT_PATHS].sort()).toEqual(
        REQUIRED_ASAR_EXPORTS.map(entry => entry.archivePath).sort(),
      )
    })

    it('does not let a @picoaide plugin hide in optionalDependencies', () => {
      // optionalDependencies 同样会被 electron-builder 打进包;自有插件若只写在这里,
      // 安装失败不会让构建红 —— 所以它必须既被断言、也不能只出现在 optional 里。
      const manifest = desktopManifest()
      const optional = Object.keys(manifest.optionalDependencies ?? {})
        .filter(name => name.startsWith('@picoaide/'))
      for (const dep of optional) {
        expect(Object.keys(manifest.dependencies ?? {})).toContain(dep)
      }
    })

    it('names the wasm apps client face and its profile patch explicitly', () => {
      // wasm-apps 是 2026-09-18 建立的自有插件,此前连"存在性"都没被断言;
      // cordis.patch.yml 是桌面 profile 组装期要读的那一份(src/profile.ts 的
      // WASM_APPS_PATCH_PATH),缺了它那一行插件整块不装配。
      for (const entry of [
        'node_modules/@picoaide/dsh-wasm-apps/lib/client.js',
        'node_modules/@picoaide/dsh-wasm-apps/lib/index.js',
        'node_modules/@picoaide/dsh-wasm-apps/package.json',
        'node_modules/@picoaide/dsh-wasm-apps/cordis.patch.yml',
      ]) {
        expect(REQUIRED_PACKAGED_RUNTIME_ENTRIES).toContain(entry)
      }
    })

    it('names the client-only wasm app origin adapter and its profile patch explicitly', () => {
      // 2026-09-19 契约 §2:客户端专属 WASM 应用 origin(`picoaide-app://`)。
      // `lib/electron-adapter.js` 尤其关键 —— 它被 desktop `lib/main.js` 静态
      // import(协议特权注册 + 适配器实例),掉出产物 = **启动期**
      // ERR_MODULE_NOT_FOUND(整个应用起不来),而不是"某一行插件不装配"。
      for (const entry of [
        'node_modules/@picoaide/dsh-wasm-apps-host/lib/index.js',
        'node_modules/@picoaide/dsh-wasm-apps-host/lib/invariant.js',
        'node_modules/@picoaide/dsh-wasm-apps-host/lib/electron-adapter.js',
        'node_modules/@picoaide/dsh-wasm-apps-host/package.json',
        'node_modules/@picoaide/dsh-wasm-apps-host/cordis.patch.yml',
      ]) {
        expect(REQUIRED_PACKAGED_RUNTIME_ENTRIES).toContain(entry)
      }
    })
  })

  describe('packaged flock smoke (P1-5)', () => {
    /** 造一个"打包根":物理 app 根 + 一个可执行启动器。 */
    function flockFixture(electronPlatformName: string): {
      runtimeContext: PackagedRuntimeContext
      appRoot: string
      launcher: string
    } {
      const appOutDir = mkdtempSync(join(tmpdir(), 'dsh-flock-fixture-'))
      const runtimeContext: PackagedRuntimeContext = {
        appOutDir,
        electronPlatformName,
        arch: 1,
        packager: {
          appInfo: { productFilename: 'PicoAide Harness' },
          executableName: 'dsh-plugin-desktop',
        },
      }
      const appRoot = join(appOutDir, 'resources', 'app')
      mkdirSync(appRoot, { recursive: true })
      writeFileSync(join(appRoot, 'package.json'), '{"name":"fixture"}\n')
      const launcher = join(appOutDir, 'dsh-plugin-desktop')
      writeFileSync(launcher, '#!/bin/sh\n')
      chmodSync(launcher, 0o755)
      return { runtimeContext, appRoot, launcher }
    }

    const successResult = { status: 0, stdout: `${ELECTRON_VERSION_LINE}FLOCK-SMOKE-OK\n`, stderr: '' }

    it('resolves the packaged launcher per platform', () => {
      expect(resolvePackagedLauncherCandidates({
        appOutDir: '/build',
        electronPlatformName: 'linux',
        packager: { appInfo: { productFilename: 'PicoAide Harness' }, executableName: 'dsh-plugin-desktop' },
      })).toEqual([join('/build', 'dsh-plugin-desktop'), join('/build', 'PicoAide Harness')])
      expect(resolvePackagedLauncherCandidates({
        appOutDir: '/build',
        electronPlatformName: 'darwin',
        packager: { appInfo: { productFilename: 'PicoAide Harness' }, executableName: 'dsh-plugin-desktop' },
      })).toEqual([join('/build', 'PicoAide Harness.app', 'Contents', 'MacOS', 'PicoAide Harness')])
      expect(resolvePackagedLauncherCandidates({
        appOutDir: '/build',
        electronPlatformName: 'win32',
        packager: { appInfo: { productFilename: 'PicoAide Harness' } },
      })).toEqual([join('/build', 'PicoAide Harness.exe')])
    })

    it('falls back to scanning the bundle when the launcher name changed', () => {
      // 渠道构建会改 productName(品牌渠道的 bundle 里可执行文件名随之变化),
      // 扫描兜底避免"名字对不上"把门禁变成误报。
      const appOutDir = mkdtempSync(join(tmpdir(), 'dsh-launcher-'))
      const macosDir = join(appOutDir, 'PicoAide Harness.app', 'Contents', 'MacOS')
      mkdirSync(macosDir, { recursive: true })
      writeFileSync(join(macosDir, 'White Label Harness'), '#!/bin/sh\n')
      const candidates = resolvePackagedLauncherCandidates({
        appOutDir,
        electronPlatformName: 'darwin',
        packager: { appInfo: { productFilename: 'PicoAide Harness' } },
      })
      expect(candidates).toContain(join(macosDir, 'White Label Harness'))

      const linuxDir = mkdtempSync(join(tmpdir(), 'dsh-launcher-linux-'))
      writeFileSync(join(linuxDir, 'chrome-sandbox'), 'x')
      writeFileSync(join(linuxDir, 'libffmpeg.so'), 'x')
      writeFileSync(join(linuxDir, 'renamed-launcher'), 'x')
      expect(resolvePackagedLauncherCandidates({
        appOutDir: linuxDir,
        electronPlatformName: 'linux',
        packager: { appInfo: { productFilename: 'PicoAide Harness' } },
      })).toContain(join(linuxDir, 'renamed-launcher'))
    })

    it('skips Windows without launching anything', () => {
      const launch = vi.fn<FlockSmokeLauncher>(() => successResult)
      const fixture = flockFixture('win32')
      expect(() => smokePackagedFlockLock(fixture.runtimeContext, launch)).not.toThrow()
      expect(launch).not.toHaveBeenCalled()
      expect(PACKAGED_FLOCK_SMOKE_TIMEOUT_MS).toBe(10_000)
    })

    it('runs the sealed launcher in Node mode against the packaged app root', () => {
      const fixture = flockFixture('linux')
      const launch = vi.fn<FlockSmokeLauncher>((executable, args, env) => {
        expect(executable).toBe(fixture.launcher)
        expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
        expect(args[1]).toBe(fixture.appRoot)
        // 脚本必须真的去解析 flock(而不是"打印 OK 就退出")。
        const script = readFileSync(args[0] as string, 'utf8')
        expect(script).toContain('@deepseek-ai/node-addon-system/flock')
        expect(script).toContain('tryLockExclusive')
        expect(script).toContain('FLOCK-SMOKE-OK')
        // P-5:脚本必须报出它实际跑的 Electron（宿主据此断言版本）。
        expect(script).toContain(`${PACKAGED_ELECTRON_VERSION_MARKER}' + String(process.versions.electron)`)
        return successResult
      })
      expect(() => smokePackagedFlockLock(fixture.runtimeContext, launch)).not.toThrow()
      expect(launch).toHaveBeenCalledOnce()
    })

    it('fails when the packaged runtime is not the pinned Electron (P-5)', () => {
      // 清单里的 6 处 electron pin 是**声明**；这条判据看的是产物实际跑的版本。
      // 变异验证：把声明值或冒烟输出改掉任一侧，本用例必红。
      const fixture = flockFixture('linux')
      const other: FlockSmokeLauncher = () => ({
        status: 0,
        stdout: `${PACKAGED_ELECTRON_VERSION_MARKER}43.4.0\nFLOCK-SMOKE-OK\n`,
        stderr: '',
      })
      expect(() => smokePackagedFlockLock(fixture.runtimeContext, other))
        .toThrow(new RegExp(`ran on Electron 43\\.4\\.0 while package\\.json pins devDependencies\\.electron ${declaredElectronVersion()}`, 'u'))

      const missing: FlockSmokeLauncher = () => ({ status: 0, stdout: 'FLOCK-SMOKE-OK\n', stderr: '' })
      expect(() => smokePackagedFlockLock(fixture.runtimeContext, missing))
        .toThrow(/did not report ELECTRON-VERSION:<version>/u)
    })

    it('pins an exact Electron version to compare against (P-5)', () => {
      const declared = declaredElectronVersion()
      expect(declared).toMatch(/^\d+\.\d+\.\d+/u)
      const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        devDependencies?: Record<string, string>
      }
      expect(declared).toBe(manifest.devDependencies?.electron)
      // 真跑过的证据：安装树里那个 Electron 二进制**自己**报出的版本就是这一份
      // （冒烟用的是同一个二进制、同一种 as-node 模式，见上面的 e2e 用例）。
      expect(execFileSync(resolveElectronBinary(), ['-p', 'process.versions.electron'], {
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      }).trim()).toBe(declared)
    })

    it('fails loud with the captured output when the launcher exits non-zero', () => {
      const fixture = flockFixture('linux')
      const launch: FlockSmokeLauncher = () => ({
        status: 1,
        stdout: '',
        stderr: 'Error: ERR_FLOCK_UNSUPPORTED_PLATFORM',
      })
      expect(() => smokePackagedFlockLock(fixture.runtimeContext, launch))
        .toThrow(/flock smoke failed \(exit 1\)[\s\S]*ERR_FLOCK_UNSUPPORTED_PLATFORM/u)
    })

    it('fails loud on timeout, spawn failure and a vacuous exit 0', () => {
      const fixture = flockFixture('linux')
      const timedOut: FlockSmokeLauncher = () => ({
        status: null,
        stdout: '',
        stderr: '',
        error: { code: 'ETIMEDOUT', message: 'spawnSync ETIMEDOUT' },
      })
      expect(() => smokePackagedFlockLock(fixture.runtimeContext, timedOut))
        .toThrow(/timed out after 10000ms/u)

      const missing: FlockSmokeLauncher = () => ({
        status: null,
        stdout: '',
        stderr: '',
        error: { code: 'ENOENT', message: 'spawnSync ENOENT' },
      })
      expect(() => smokePackagedFlockLock(fixture.runtimeContext, missing))
        .toThrow(/could not start[\s\S]*ENOENT/u)

      const vacuous: FlockSmokeLauncher = () => ({ status: 0, stdout: '', stderr: '' })
      expect(() => smokePackagedFlockLock(fixture.runtimeContext, vacuous))
        .toThrow(/without reporting FLOCK-SMOKE-OK/u)
    })

    it.skipIf(process.platform === 'win32')(
      'takes a real lock with the embedded script against the installed tree',
      () => {
        // 端到端:默认 launcher + 真脚本 + 真 flock 绑定 + **真 Electron 运行时**。
        // 壳脚本 exec 的是本仓安装的 electron 二进制（`require('electron')` 在普通
        // Node 里返回它的路径；冒烟本来就用 ELECTRON_RUN_AS_NODE=1 跑它），app 根
        // 指向装好的 desktop 依赖树，于是走的是与打包态一样的 exports 解析路径。
        //
        // P-5 起这条用例必须跑真 Electron：冒烟脚本会打一行
        // `ELECTRON-VERSION:<process.versions.electron>`，宿主断言它等于
        // devDependencies.electron —— 用纯 node 冒充会让版本断言（正确地）红。
        const electronBinary = resolveElectronBinary()
        const fixture = flockFixture('linux')
        // 把打包根的 node_modules 指向真实安装树,于是脚本里的 exports 解析路径
        // (@deepseek-ai/node-addon-system/flock → 平台包 bin/*/system.node)与
        // 打包态完全一致,只是少了 asar 这一层。
        symlinkSync(join(__dirname, '..', 'node_modules'), join(fixture.appRoot, 'node_modules'), 'dir')
        writeFileSync(fixture.launcher, `#!/bin/sh\nexec ${JSON.stringify(electronBinary)} "$@"\n`)
        chmodSync(fixture.launcher, 0o755)

        expect(() => smokePackagedFlockLock(fixture.runtimeContext)).not.toThrow()
      },
    )
  })

  describe('packaged error-reporting smoke (P1-1)', () => {
    /** 造一个"打包根":物理 app 根 + 一个可执行启动器(win32 带 .exe 后缀)。 */
    function sentryFixture(electronPlatformName: string): {
      runtimeContext: PackagedRuntimeContext
      appRoot: string
      launcher: string
    } {
      const appOutDir = mkdtempSync(join(tmpdir(), 'dsh-sentry-fixture-'))
      const runtimeContext: PackagedRuntimeContext = {
        appOutDir,
        electronPlatformName,
        arch: 1,
        packager: {
          appInfo: { productFilename: 'PicoAide Harness' },
          executableName: 'dsh-plugin-desktop',
        },
      }
      const appRoot = join(appOutDir, 'resources', 'app')
      mkdirSync(appRoot, { recursive: true })
      writeFileSync(join(appRoot, 'package.json'), '{"name":"fixture"}\n')
      const launcher = join(
        appOutDir,
        electronPlatformName === 'win32' ? 'dsh-plugin-desktop.exe' : 'dsh-plugin-desktop',
      )
      writeFileSync(launcher, '#!/bin/sh\n')
      chmodSync(launcher, 0o755)
      return { runtimeContext, appRoot, launcher }
    }

    const successResult = { status: 0, stdout: `${ELECTRON_VERSION_LINE}SENTRY-SMOKE-OK\n`, stderr: '' }

    it('fails the afterPack gate when the sentry smoke reports a missing module', async () => {
      const fixture = sentryFixture('linux')
      const launch = vi.fn<SentrySmokeLauncher>(() => ({
        status: 1,
        stdout: '',
        stderr: "Error: Cannot find module '@sentry/node'",
      }))

      await expect(afterPack(
        fixture.runtimeContext,
        () => {},
        async () => {},
        () => {},
        runtimeContext => { smokePackagedErrorReporting(runtimeContext, launch) },
      )).rejects.toThrow(/Cannot find module '@sentry\/node'/u)
      expect(launch).toHaveBeenCalledOnce()
    })

    it('fails when the sentry smoke exits 0 without the success marker', () => {
      const fixture = sentryFixture('linux')
      const vacuous: SentrySmokeLauncher = () => ({ status: 0, stdout: '', stderr: '' })
      expect(() => smokePackagedErrorReporting(fixture.runtimeContext, vacuous))
        .toThrow(/without reporting SENTRY-SMOKE-OK/u)
    })

    it('passes when the sentry smoke prints SENTRY-SMOKE-OK', () => {
      const fixture = sentryFixture('linux')
      const launch = vi.fn<SentrySmokeLauncher>((executable, args, env) => {
        expect(executable).toBe(fixture.launcher)
        expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
        expect(args[1]).toBe(fixture.appRoot)
        // 脚本必须真的去 require @sentry/node 与 import error-reporting
        // (而不是"打印 OK 就退出")。
        const script = readFileSync(args[0] as string, 'utf8')
        expect(script).toContain('@sentry/node')
        expect(script).toContain('@picoaide/dsh-enterprise/error-reporting')
        expect(script).toContain('SENTRY-SMOKE-OK')
        // P-5:这个冒烟三平台都跑 ⇒ 它是 Electron 版本断言的全平台落点。
        expect(script).toContain(`${PACKAGED_ELECTRON_VERSION_MARKER}' + String(process.versions.electron)`)
        return successResult
      })
      expect(() => smokePackagedErrorReporting(fixture.runtimeContext, launch)).not.toThrow()
      expect(launch).toHaveBeenCalledOnce()
      expect(PACKAGED_SENTRY_SMOKE_TIMEOUT_MS).toBe(10_000)
    })

    it('fails when the packaged runtime is not the pinned Electron (P-5)', () => {
      const fixture = sentryFixture('linux')
      const other: SentrySmokeLauncher = () => ({
        status: 0,
        stdout: `${PACKAGED_ELECTRON_VERSION_MARKER}43.4.0\nSENTRY-SMOKE-OK\n`,
        stderr: '',
      })
      expect(() => smokePackagedErrorReporting(fixture.runtimeContext, other))
        .toThrow(/packaged error-reporting smoke ran on Electron 43\.4\.0 while package\.json pins/u)

      const missing: SentrySmokeLauncher = () => ({ status: 0, stdout: 'SENTRY-SMOKE-OK\n', stderr: '' })
      expect(() => smokePackagedErrorReporting(fixture.runtimeContext, missing))
        .toThrow(/packaged error-reporting smoke did not report ELECTRON-VERSION:<version>/u)
    })

    it('does not skip the sentry smoke on win32', () => {
      // @sentry/node 是纯 JS:三个平台都必须跑。win32 分支若退化成 skip,
      // Windows 安装包的 GlitchTip 采集会再次变成无人把关的静默失效。
      const fixture = sentryFixture('win32')
      const launch = vi.fn<SentrySmokeLauncher>(() => successResult)
      expect(() => smokePackagedErrorReporting(fixture.runtimeContext, launch)).not.toThrow()
      expect(launch).toHaveBeenCalledOnce()
      expect(launch.mock.calls[0]?.[0]).toBe(fixture.launcher)
    })

    it('fails loud when the packaged launcher is missing instead of skipping', () => {
      const appOutDir = mkdtempSync(join(tmpdir(), 'dsh-sentry-nolauncher-'))
      const launch = vi.fn<SentrySmokeLauncher>(() => successResult)
      expect(() => smokePackagedErrorReporting(context(appOutDir, 'linux'), launch))
        .toThrow(/cannot find the packaged launcher/u)
      expect(launch).not.toHaveBeenCalled()
    })
  })
})

  it('profile 锚点表与 src/profile.ts 的实际解析点逐条对拍（防新增插件漏登记）', () => {
    // 判据来源：`src/profile.ts` 里每一处 `resolve('<pkg>/package.json')` 都会在
    // **组装期**读该包目录下的东西。其中**带 `cordis.patch.yml` 的**是我们自己的
    // 插件包（profile 拿它拼桌面组合）—— 这些必须在锚点表里。
    //
    // 上游两个包（`@deepseek-ai/dsh` 的 config/agent-presets、`dsh-agent-presets`
    // 的 presets）解析的是 presets 目录、没有 patch，已由
    // `REQUIRED_PACKAGED_RUNTIME_ENTRIES` 逐条钉住，因此按"是否有 patch 文件"
    // 分流，而不是按包名白名单。
    const source = readFileSync(new URL('../src/profile.ts', import.meta.url), 'utf8')
    const resolved = new Set<string>()
    for (const m of source.matchAll(/resolve\('([^']+)\/package\.json'\)/gu)) {
      const pkg = m[1]
      if (pkg !== undefined) resolved.add(pkg)
    }
    // 前置断言：判据不能空转。
    expect(resolved.size).toBeGreaterThan(5)

    const patchBearing = [...resolved]
      .filter(pkg => existsSync(fileURLToPath(new URL(`../node_modules/${pkg}/cordis.patch.yml`, import.meta.url))))
    // 前置断言：确实分流出了自有插件包。
    expect(patchBearing.length).toBeGreaterThan(5)

    const expected = patchBearing.flatMap(pkg => [
      `node_modules/${pkg}/package.json`,
      `node_modules/${pkg}/cordis.patch.yml`,
    ]).sort()
    const actual = [...REQUIRED_PROFILE_PATCH_ANCHORS].sort()
    expect(actual).toEqual(expected)
  })

  it('profile 锚点判据在两套布局里都必须真的被调用（接线守卫）', () => {
    // 变异验证暴露的缺口：把任一处 `assertProfilePatchAnchors(...)` 删掉，
    // 其余用例**全绿**（它们只测函数本身，不测"被调用"）。这里读真源钉住两处：
    // asar 走 `present.has`（真实归档清单），物理布局走 `exists(join(...))`。
    const source = readFileSync(
      new URL('../scripts/verify-packaged-runtime.ts', import.meta.url),
      'utf8',
    )
    expect(source).toMatch(/assertProfilePatchAnchors\(entry => present\.has\(entry\), archivePath\)/u)
    expect(source).toMatch(/assertProfilePatchAnchors\(entry => exists\(join\(appRoot, entry\)\), appRoot\)/u)
  })

  it('profile 锚点缺失即拒包（逐条可判）', () => {
    const full = new Set([...REQUIRED_PROFILE_PATCH_ANCHORS])
    expect(() => assertProfilePatchAnchors(entry => full.has(entry), '/x/app.asar')).not.toThrow()
    for (const dropped of REQUIRED_PROFILE_PATCH_ANCHORS) {
      const without = new Set([...REQUIRED_PROFILE_PATCH_ANCHORS].filter(e => e !== dropped))
      expect(
        () => assertProfilePatchAnchors(entry => without.has(entry), '/x/app.asar'),
        `缺少 ${dropped} 时必须拒包`,
      ).toThrow(/missing profile patch anchors/u)
    }
  })

describe('发布包不得夹带自有源码 / sourcemap / 开发期产物（2026-09-22 泄漏修复）', () => {
  // 背景（实测）：`build.files` 里曾写「仅根级 TypeScript」的单星号排除（`*` 不跨 `/`），
  // 加上 `lib/**` 把 lib 内容平铺到 asar 根 ⇒ 11 个已发布的正式/预发包都带着
  // 桌面包自身的 src/tests/scripts、各 `@picoaide/dsh-*` 的 src（工作区依赖是
  // symlink，electron-builder 忽略子包 `files` 整体收编）、以及 33 个内嵌
  // `sourcesContent` 的 sourcemap；而 DevTools 从没被覆写（默认可用）。
  // 这张表是 afterPack 的**证据侧**判据：排除规则写错时坏包产不出来。

  it('反例：逐条形态都必须被拒（每条独立可判，不靠"至少命中一条"）', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['desktop src', 'src/main.ts'],
      ['desktop tests', 'tests/package.spec.ts'],
      ['desktop scripts', 'scripts/notarize-mac.ts'],
      ['desktop root tsconfig', 'tsdown.config.ts'],
      ['workspace src', 'node_modules/@picoaide/dsh-browser/src/runtime.ts'],
      ['workspace spec', 'node_modules/@picoaide/dsh-account-card/src/client/AccountCard.spec.tsx'],
      ['workspace tests dir', 'node_modules/@picoaide/dsh-cron/tests/jobs.spec.ts'],
      ['sourcemap at archive root', 'main.js.map'],
      ['sourcemap in a subdirectory', 'lib/preload/renderer-error.cjs.map'],
      ['e2e artifacts', '.e2e-terminal/Default/Cache/x'],
      ['real-env artifacts', '.real-env-shots/shot.png'],
      ['build temp directory', 'temp/squash-gzip.squashfs'],
      ['previous build output', 'dist-leakbase/linux-unpacked/x'],
    ]
    for (const [label, entry] of cases) {
      // 每条单独喂：任何一条规则被删掉，对应 case 就会红。
      expect(() => assertNoPackagedSourceLeaks([entry], '/x/app.asar'), label).toThrow(/leaks/u)
    }
  })

  it('正例：正常产物条目一条都不能误伤', () => {
    const legitimate = [
      'lib/main.js',
      'lib/types/index.d.ts',
      'lib/types/client/AdvancedFrame.d.ts',
      'lib/preload/renderer-error.cjs',
      'package.json',
      'cordis.patch.yml',
      'build/tray-icon-blue.png',
      'build/web-brand/favicon.svg',
      'node_modules/@deepseek-ai/dsh/lib/bin.js',
      // 上游包自带的 .d.ts / README 是公开发行物，不在「自有源码」范围里。
      'node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.d.ts',
      'node_modules/@picoaide/dsh-browser/lib/index.js',
      'node_modules/@picoaide/dsh-browser/lib/types/index.d.ts',
      // 第三方包把运行期代码放在 src/ 下（bowser / debug / fontkit 实测如此）——
      // 所以排除规则只能点名 @picoaide，不能是 `**/src/**`。
      'node_modules/bowser/src/bowser.js',
      'node_modules/debug/src/index.js',
      // 含 skills 的运行期内容必须留着（曾经被一条过宽的 *.md 排除误删）。
      'node_modules/dsh-memory-evolve/skills/memory-consolidate/SKILL.md',
      'node_modules/@deepseek-ai/dsh-agent-presets/presets/cordis/skills/cordis-plugin-development/SKILL.md',
    ]
    expect(() => assertNoPackagedSourceLeaks(legitimate, '/x/app.asar')).not.toThrow()
  })

  it('不把 `**/src/**` 当成通用规则（第三方 src 是运行期代码）', () => {
    // 判据反向自证：若有人把规则从 `@picoaide` 放宽成任意 src，这条会红。
    const thirdPartySources = [
      'node_modules/bowser/src/bowser.js',
      'node_modules/debug/src/index.js',
      'node_modules/fontkit/src/TTFFont.js',
    ]
    expect(() => assertNoPackagedSourceLeaks(thirdPartySources, '/x/app.asar')).not.toThrow()
    // 同名前缀自有包则必须命中。
    expect(() => assertNoPackagedSourceLeaks(
      ['node_modules/@picoaide/dsh-browser/src/runtime.ts'],
      '/x/app.asar',
    )).toThrow(/workspace package sources/u)
  })

  it('正例侧：内容级运行期资产被整类排除即拒（防"一刀切"排除造成假绿）', () => {
    // 本轮**真实踩到**：一条「排除全部 .md」的过宽规则把随包技能一起排掉
    //（COI 技能同步会全部 missing），而反例门禁全绿。这条就是那一侧的证据。
    const withSkills = [
      'lib/main.js',
      'node_modules/dsh-memory-evolve/skills/memory-consolidate/SKILL.md',
      'node_modules/@deepseek-ai/dsh-agent-presets/presets/cordis/skills/cordis-plugin-development/SKILL.md',
    ]
    expect(() => assertRuntimeAssetFamiliesSurvive(withSkills, '/x/app.asar')).not.toThrow()
    expect(() => assertNoPackagedSourceLeaks(withSkills, '/x/app.asar')).not.toThrow()

    // 只有运行期 JS、没有技能内容 ⇒ 反例侧放行，正例侧必须报"整类被抹掉"。
    const withoutSkills = ['lib/main.js', 'lib/index.js', 'package.json']
    expect(() => assertNoPackagedSourceLeaks(withoutSkills, '/x/app.asar')).not.toThrow()
    expect(() => assertRuntimeAssetFamiliesSurvive(withoutSkills, '/x/app.asar'))
      .toThrow(/no surviving entries for runtime asset families/u)

    // 只缺其中一类也要报（不能"至少有一类在"就放行）。
    expect(() => assertRuntimeAssetFamiliesSurvive(
      ['node_modules/dsh-memory-evolve/skills/memory-consolidate/SKILL.md'],
      '/x/app.asar',
    )).toThrow(/dsh-agent-presets/u)
  })

  it('两个方向的判据都必须真的接进 afterPack 主流程（接线守卫）', () => {
    // 变异验证暴露的缺口：把正例那一行从 `tryListArchive` 里删掉，其余用例
    // **全绿** —— 因为它们只测辅助函数本身，不测"被调用"。这里读真源把接线钉住
    //（与 network-policy / wasm-app-open-route 同款的源码级接线守卫）。
    const source = readFileSync(
      new URL('../scripts/verify-packaged-runtime.ts', import.meta.url),
      'utf8',
    )
    expect(source).toMatch(/assertNoPackagedSourceLeaks\(present, archivePath\)/u)
    expect(source).toMatch(/assertRuntimeAssetFamiliesSurvive\(present, archivePath\)/u)
  })

  it('桌面自身的 lib/types/** 不随包（现状事实，不得被当成"必须保留"）', () => {
    // 实测（2026-09-22）：改动**前**的产物里 `lib/types/**` 就是 0 条 ——
    // tsdown/tsc 会生成它（61 个文件），但它是**开发期类型面**，不进发布包。
    // 运行期用到 `dsh-plugin-desktop/*` 类型的是 browser / connectors 等 workspace
    // 包，它们经 node_modules 符号链接解析到**工作区源目录**，不吃 asar。
    // 所以：既不能把它当"正例锚"（会把正确产物判红），也不得写进必需条目。
    const verifierSource = readFileSync(
      new URL('../scripts/verify-packaged-runtime.ts', import.meta.url),
      'utf8',
    )
    expect(verifierSource).not.toContain("'lib/types/index.d.ts',")
    expect([...REQUIRED_PACKAGED_RUNTIME_ENTRIES]).not.toContain('lib/types/index.d.ts')
  })

  it('files 排除规则本身不得退化成"仅根级"写法', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { build?: { files?: string[] } }
    const files = manifest.build?.files ?? []
    // 单星号不跨 `/`：`!*.ts` 只挡根级，子目录必须写 `!**/*.ts`。
    expect(files).toContain('!**/*.ts')
    expect(files).toContain('!**/*.tsx')
    // sourcemap 同理：`!**/*.map` 之外还要显式挡根级的 `!*.map`
    //（`lib/**` 平铺后 map 落在 asar 根，实测 33 个）。
    expect(files).toContain('!**/*.map')
    expect(files).toContain('!*.map')
    // 开发期目录（temp 曾经装着 275 MiB 的 squashfs 试验件）。
    expect(files).toContain('!temp/**')
    expect(files).toContain('!dist/**')
    // 自有包源码点名排除，且**不能**放宽成任意 src。
    expect(files).toContain('!**/node_modules/@picoaide/*/src/**')
    expect(files.some(pattern => pattern === '!**/src/**')).toBe(false)
  })
})
