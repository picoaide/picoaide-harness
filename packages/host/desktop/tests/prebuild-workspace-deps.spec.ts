/**
 * 增量预构建判定（`scripts/prebuild-workspace-deps.ts`）的门禁。
 *
 * 为什么这些用例必须存在（2026-09-23 门禁红 458s 的现场）：
 * `isUpToDate()` 此前只比较 mtime（`oldestMtime(outputs) >= newestInput`），
 * **完全不校验声明的产物是否真的存在**。而本仓是多会话共享工作目录，`yarn check`
 * 的包任务会并发跑 tsdown（`clean: true` ⇒ 日志里能看到 `Cleaning N files`）。
 * 当 `lib/` 被并发清空时，`outputFiles()` 只会列出**残留**文件，mtime 判定照样
 * 通过 ⇒ 本函数跳过重建 ⇒ 下游 tsc 报
 * `TS7016: Could not find a declaration file for module '@picoaide/dsh-wasm-apps-host'`
 * （实测 dsh-plugin-desktop 因此红 458s，并级联跳过 enterprise/cron/account-card）。
 *
 * 这里钉住三件事：
 *   1. 产物齐全且比输入新 ⇒ 判定 up-to-date（增量化本身不能退化）；
 *   2. **少一份声明产物 ⇒ 必须判需要重建**（mtime 说"最新"也不行）——这条就是
 *      本缺陷的原始症状，也是变异验证的目标；
 *   3. 依赖包产物更新 ⇒ 需要重建（既有语义不回归）。
 *
 * 用例走**夹具仓库**（mkdtemp + 显式 mtime），不碰真实工作区：真实 `lib/` 在 CI 里
 * 正被并发构建，任何"扫真实 lib/ 再断言齐备"的用例都会把那条竞态写成 flaky 测试。
 * 真实声明面另由最后一组**静态**用例对拍（只读 package.json / tsdown.config.ts）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  declaredExportArtifacts,
  isUpToDate,
  missingDeclaredArtifacts,
  stalenessReason,
  tsdownEntryKeys,
  WORKSPACE_PACKAGES,
  type WorkspacePackage,
} from '../scripts/prebuild-workspace-deps.ts'

const desktopRoot = fileURLToPath(new URL('../', import.meta.url))
const repoRoot = resolve(desktopRoot, '..', '..', '..')

/** 夹具仓库根：用例结束后统一清理。 */
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 固定时钟基准：不用 sleep，也不依赖文件系统对超大时间戳的夹取行为。 */
const BASE = Date.now() - 600_000

/** 写入一个文件并把 mtime 钉死在 `ageSeconds` 秒前（越大越旧）。 */
function write(path: string, content: string, ageSeconds = 0): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  const at = (BASE - ageSeconds * 1000) / 1000
  utimesSync(path, at, at)
}

/** 把已存在的文件重新钉到某个时间点（模拟"依赖包刚被重建"）。 */
function retime(path: string, ageSeconds: number): void {
  const at = (BASE - ageSeconds * 1000) / 1000
  utimesSync(path, at, at)
}

interface FixturePackage {
  readonly dir: string
  readonly workspace: string
  readonly exports?: unknown
  /** `tsdown.config.ts` 的正文；null = 该包没有 tsdown 配置。 */
  readonly tsdown?: string | null
  /** 相对包根的产物路径（父目录自动创建）。 */
  readonly artifacts?: readonly string[]
  /** 相对包根的源文件路径（构建输入）。 */
  readonly sources?: readonly string[]
  /** 与其它夹具包的依赖边（值为对方的 dir）。 */
  readonly deps?: readonly string[]
}

/** 造一个夹具仓库：目录形状与真实包一致，产物/输入的 mtime 由调用方指定。 */
function fixture(packages: readonly FixturePackage[]): {
  root: string
  pkg: (dir: string) => WorkspacePackage
  registry: ReadonlyMap<string, WorkspacePackage>
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-prebuild-'))
  roots.push(root)
  const table = new Map<string, WorkspacePackage>()
  for (const spec of packages) {
    const packageRoot = join(root, spec.dir)
    mkdirSync(packageRoot, { recursive: true })
    write(
      join(packageRoot, 'package.json'),
      `${JSON.stringify({ name: spec.workspace, version: '0.0.0', type: 'module', exports: spec.exports }, null, 2)}\n`,
      900,
    )
    if (spec.tsdown !== null && spec.tsdown !== undefined) {
      write(join(packageRoot, 'tsdown.config.ts'), spec.tsdown, 900)
    }
    for (const source of spec.sources ?? ['src/index.ts']) write(join(packageRoot, source), 'export const x = 1\n', 800)
    for (const artifact of spec.artifacts ?? []) write(join(packageRoot, artifact), '// built\n', 300)
    table.set(spec.dir, { workspace: spec.workspace, dir: spec.dir, deps: spec.deps ?? [] })
  }
  return {
    root,
    pkg: dir => {
      const found = table.get(dir)
      if (found === undefined) throw new Error(`fixture package not found: ${dir}`)
      return found
    },
    registry: table,
  }
}

/** 该包一个完整、自洽的声明面（exports 两份 + tsdown index 入口）。 */
const COMPLETE_EXPORTS = {
  '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
  './client': { types: './lib/types/client/index.d.ts', default: './lib/client.js' },
  './package.json': './package.json',
}
const COMPLETE_TSDOWN = `import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: { index: 'src/index.ts', client: 'src/client/index.ts' },
  outDir: 'lib',
  clean: true,
})
`
const COMPLETE_ARTIFACTS = [
  'lib/index.js',
  'lib/client.js',
  'lib/types/index.d.ts',
  'lib/types/client/index.d.ts',
] as const

/** 真实世界同形的"mtime 也认为最新"的最小判据（只用于证明本缺陷的形态）。 */
function mtimeSaysUpToDate(packageRoot: string): boolean {
  const collect = (dir: string, out: string[] = []): string[] => {
    if (!existsSync(dir)) return out
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) collect(join(dir, entry.name), out)
      else if (entry.isFile()) out.push(join(dir, entry.name))
    }
    return out
  }
  const outputs = ['lib', 'build'].flatMap(dir => collect(join(packageRoot, dir)))
  const inputs = [
    ...collect(join(packageRoot, 'src')),
    join(packageRoot, 'package.json'),
    join(packageRoot, 'tsdown.config.ts'),
  ].filter(existsSync)
  const newestInput = Math.max(0, ...inputs.map(file => statSync(file).mtimeMs))
  const oldestOutput = Math.min(...outputs.map(file => statSync(file).mtimeMs))
  return oldestOutput >= newestInput
}

describe('prebuild 增量判定：声明的产物必须真的存在', () => {
  it('产物齐全且比输入新 ⇒ up-to-date（增量化不退化）', () => {
    const { root, pkg, registry } = fixture([
      { dir: 'packages/host/fixture-a', workspace: '@picoaide/fixture-a', exports: COMPLETE_EXPORTS, tsdown: COMPLETE_TSDOWN, artifacts: COMPLETE_ARTIFACTS },
    ])
    const a = pkg('packages/host/fixture-a')
    expect(missingDeclaredArtifacts(root, a)).toEqual([])
    expect(stalenessReason(root, a, registry)).toBeNull()
    expect(isUpToDate(root, a, registry)).toBe(true)
  })

  it('删掉一个必需产物（lib/types/index.d.ts）⇒ 必须判需要重建，绝不静默跳过', () => {
    const { root, pkg, registry } = fixture([
      { dir: 'packages/host/fixture-a', workspace: '@picoaide/fixture-a', exports: COMPLETE_EXPORTS, tsdown: COMPLETE_TSDOWN, artifacts: COMPLETE_ARTIFACTS },
    ])
    const a = pkg('packages/host/fixture-a')
    const packageRoot = join(root, a.dir)
    // 前置：此刻判定为最新。
    expect(isUpToDate(root, a, registry)).toBe(true)
    // 模拟并发 tsdown 的 `Cleaning N files`：删掉 exports["."].types 的目标。
    rmSync(join(packageRoot, 'lib', 'types', 'index.d.ts'))
    // 这正是本缺陷：mtime 判据照样通过（残留产物都比输入新）。
    expect(mtimeSaysUpToDate(packageRoot)).toBe(true)
    // 而新判据必须判"需要重建"。
    expect(missingDeclaredArtifacts(root, a)).toEqual(['lib/types/index.d.ts'])
    expect(stalenessReason(root, a, registry)).toBe('missing 1 declared artifact(s): lib/types/index.d.ts')
    expect(isUpToDate(root, a, registry)).toBe(false)
  })

  it('整目录被清空（残留文件全没）仍然判需要重建', () => {
    const { root, pkg, registry } = fixture([
      { dir: 'packages/host/fixture-a', workspace: '@picoaide/fixture-a', exports: COMPLETE_EXPORTS, tsdown: COMPLETE_TSDOWN, artifacts: COMPLETE_ARTIFACTS },
    ])
    const a = pkg('packages/host/fixture-a')
    rmSync(join(root, a.dir, 'lib'), { recursive: true, force: true })
    expect(isUpToDate(root, a, registry)).toBe(false)
    expect(stalenessReason(root, a, registry)).toBe('no build output')
  })

  it('依赖包产物更新 ⇒ 需要重建（既有语义不回归）', () => {
    const { root, pkg, registry } = fixture([
      {
        dir: 'packages/host/fixture-a',
        workspace: '@picoaide/fixture-a',
        exports: COMPLETE_EXPORTS,
        tsdown: COMPLETE_TSDOWN,
        artifacts: COMPLETE_ARTIFACTS,
      },
      {
        dir: 'packages/host/fixture-b',
        workspace: '@picoaide/fixture-b',
        exports: COMPLETE_EXPORTS,
        tsdown: COMPLETE_TSDOWN,
        artifacts: COMPLETE_ARTIFACTS,
        deps: ['packages/host/fixture-a'],
      },
    ])
    const a = pkg('packages/host/fixture-a')
    const b = pkg('packages/host/fixture-b')
    // 布局：A 产物 -300s、B 产物 -100s ⇒ B 比 A 新，两边都最新。
    for (const artifact of COMPLETE_ARTIFACTS) retime(join(root, b.dir, artifact), 100)
    expect(isUpToDate(root, a, registry)).toBe(true)
    expect(isUpToDate(root, b, registry)).toBe(true)
    // A 被重建（产物变新）⇒ 依赖它的 B 必须重建。
    for (const artifact of COMPLETE_ARTIFACTS) retime(join(root, a.dir, artifact), 0)
    expect(isUpToDate(root, a, registry)).toBe(true)
    expect(stalenessReason(root, b, registry)).toBe('inputs newer than oldest output')
    expect(isUpToDate(root, b, registry)).toBe(false)
  })
})

describe('prebuild 声明面解析：哪些目标算产物', () => {
  it('嵌套条件（import/require/数组）逐层展开，任一份缺失都判重建', () => {
    const { root, pkg, registry } = fixture([
      {
        dir: 'packages/host/fixture-a',
        workspace: '@picoaide/fixture-a',
        exports: {
          '.': {
            import: { types: './lib/types/index.d.ts', default: './lib/index.js' },
            require: './lib/index.cjs',
          },
          './extra': [{ types: './lib/types/extra.d.ts', default: './lib/extra.js' }],
        },
        tsdown: null,
        artifacts: ['lib/index.js', 'lib/index.cjs', 'lib/types/index.d.ts', 'lib/extra.js', 'lib/types/extra.d.ts'],
      },
    ])
    const a = pkg('packages/host/fixture-a')
    expect(declaredExportArtifacts(join(root, a.dir))).toEqual([
      'lib/extra.js',
      'lib/index.cjs',
      'lib/index.js',
      'lib/types/extra.d.ts',
      'lib/types/index.d.ts',
    ])
    expect(isUpToDate(root, a, registry)).toBe(true)
    rmSync(join(root, a.dir, 'lib', 'index.cjs'))
    expect(missingDeclaredArtifacts(root, a)).toEqual(['lib/index.cjs'])
    expect(isUpToDate(root, a, registry)).toBe(false)
  })

  it('包自引用与源码通配不是产物（否则门禁永远红）', () => {
    const { root, pkg } = fixture([
      {
        dir: 'packages/host/fixture-a',
        workspace: '@picoaide/fixture-a',
        exports: {
          '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
          './package.json': './package.json',
          './src/*': './src/*',
          './cordis.patch.yml': './cordis.patch.yml',
        },
        tsdown: null,
        artifacts: ['lib/index.js', 'lib/types/index.d.ts'],
      },
    ])
    const a = pkg('packages/host/fixture-a')
    // 只留下真正的构建产物；`./package.json`（文件确实存在）与 `./src/*`（通配）
    // 都不能进判据 —— 通配被当成"某一份产物"会让这个包永远重建。
    expect(declaredExportArtifacts(join(root, a.dir))).toEqual(['lib/index.js', 'lib/types/index.d.ts'])
    expect(missingDeclaredArtifacts(root, a)).toEqual([])
  })

  it('tsdown 的 entry 产物同样算声明产物（含不经 exports 的入口与 .cjs 扩展名）', () => {
    const { root, pkg, registry } = fixture([
      {
        dir: 'packages/host/fixture-a',
        workspace: '@picoaide/fixture-a',
        exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' } },
        tsdown: `import { defineConfig } from 'tsdown'
// entry 里出现花括号与逗号（注释/字符串）不能影响扫描：{ a: 1, b: 2 }
export default defineConfig({
  entry: { index: 'src/index.ts', bin: 'src/bin.ts', 'preload/renderer-error': 'src/preload/renderer-error.ts' },
  outDir: 'lib',
  clean: true,
  outputOptions: { entryFileNames: 'preload/renderer-error.cjs', banner: \`x({ id: 'y' })\` },
})
`,
        artifacts: [
          'lib/index.js',
          'lib/types/index.d.ts',
          'lib/bin.js',
          // 同上：同目录下还有一个 .cjs 入口（desktop 的 preload 就是这一形态）。
          'lib/preload/renderer-error.cjs',
        ],
      },
    ])
    const a = pkg('packages/host/fixture-a')
    expect(tsdownEntryKeys(join(root, a.dir))).toEqual(['bin', 'index', 'preload/renderer-error'])
    expect(missingDeclaredArtifacts(root, a)).toEqual([])
    expect(isUpToDate(root, a, registry)).toBe(true)
    // 不经 exports 的入口（打包版 CLI 就是它）缺失 = 判重建。
    rmSync(join(root, a.dir, 'lib', 'bin.js'))
    expect(missingDeclaredArtifacts(root, a)).toEqual(['lib/bin{.js,.mjs,.cjs}'])
    expect(isUpToDate(root, a, registry)).toBe(false)
  })

  it('package.json 缺失/不是 JSON 时不产生幻影要求（也不抛错）', () => {
    const { root, pkg } = fixture([
      {
        dir: 'packages/host/fixture-a',
        workspace: '@picoaide/fixture-a',
        exports: COMPLETE_EXPORTS,
        tsdown: null,
        artifacts: [],
      },
    ])
    const packageRoot = join(root, 'packages/host/fixture-a')
    write(join(packageRoot, 'package.json'), '{ this is not json\n', 100)
    expect(declaredExportArtifacts(packageRoot)).toEqual([])
    rmSync(join(packageRoot, 'package.json'))
    expect(declaredExportArtifacts(packageRoot)).toEqual([])
    expect(missingDeclaredArtifacts(root, pkg('packages/host/fixture-a'))).toEqual([])
  })

  it('没有 exports / 没有 tsdown 配置的包不产生要求（判定仍由 mtime 决定）', () => {
    const { root, pkg, registry } = fixture([
      {
        dir: 'packages/host/fixture-a',
        workspace: '@picoaide/fixture-a',
        tsdown: null,
        artifacts: ['lib/index.js'],
      },
    ])
    const a = pkg('packages/host/fixture-a')
    expect(declaredExportArtifacts(join(root, a.dir))).toEqual([])
    expect(tsdownEntryKeys(join(root, a.dir))).toEqual([])
    expect(missingDeclaredArtifacts(root, a)).toEqual([])
    expect(isUpToDate(root, a, registry)).toBe(true)
  })
})

describe('真实工作区的声明面对拍（静态读取，不扫 lib/）', () => {
  it('每个 workspace 包都能读出声明产物（否则该包会静默退回纯 mtime 判定）', () => {
    expect(WORKSPACE_PACKAGES.length).toBeGreaterThanOrEqual(13)
    for (const pkg of WORKSPACE_PACKAGES) {
      const packageRoot = join(repoRoot, pkg.dir)
      const declared = [...declaredExportArtifacts(packageRoot), ...tsdownEntryKeys(packageRoot)]
      expect(declared.length, `${pkg.dir} 读不出任何声明产物`).toBeGreaterThan(0)
    }
  })

  it('本缺陷的现场声明被真的读进判据（wasm-apps-host 的 types/default 目标）', () => {
    const packageRoot = join(repoRoot, 'packages/host/wasm-apps-host')
    const declared = declaredExportArtifacts(packageRoot)
    // 2026-09-23 现场：`exports["."].types = ./lib/types/index.d.ts`（该文件被并发
    // clean 删掉后下游报 TS7016），以及每个子路径的 default 目标。
    expect(declared).toContain('lib/types/index.d.ts')
    expect(declared).toContain('lib/index.js')
    expect(declared).toContain('lib/app-proof.js') // 曾漏构建的那个子路径
    expect(declared).not.toContain('package.json')
    expect(declared.every(artifact => artifact.startsWith('lib/'))).toBe(true)
  })

  it('tsdown 入口解析覆盖不经 exports 的产物（desktop 的 main/bin/preload）', () => {
    const entries = tsdownEntryKeys(join(repoRoot, 'packages/host/desktop'))
    expect(entries).toContain('main')
    expect(entries).toContain('bin')
    expect(entries).toContain('preload/renderer-error')
    expect(entries).toContain('client')
    // 单行对象字面量的 entry（host-locale 的 index/loopback/session-events）同样要读出来。
    // 2026-09-24：新增 `session-events`（`pico/session-changed` 订阅契约的唯一实现），
    // 它**必须**同时出现在 exports 子路径与 tsdown entry 里（"声明了的入口就必须构建"）。
    expect(tsdownEntryKeys(join(repoRoot, 'packages/host/host-locale'))).toEqual(['index', 'loopback', 'session-events'])
  })

  it('cron 的 ./src/* 通配不进判据（进则永远重建）', () => {
    const declared = declaredExportArtifacts(join(repoRoot, 'packages/host/cron'))
    expect(declared.length).toBeGreaterThan(0)
    expect(declared.some(artifact => artifact.startsWith('src/'))).toBe(false)
  })

  it('真实声明面 + 合成产物 ⇒ 判最新；删掉现场那一份 ⇒ 判重建', () => {
    // 读**真实**的 package.json / tsdown.config.ts，产物用合成树补齐：既证判据接线在
    // 真声明面上，又不去扫真实 lib/（CI 里正被并发构建，扫了必成 flaky 用例）。
    const source = join(repoRoot, 'packages/host/wasm-apps-host')
    const dir = 'packages/host/wasm-apps-host'
    const declared = [...declaredExportArtifacts(source), ...tsdownEntryKeys(source)]
    const { root, pkg, registry } = fixture([
      {
        dir,
        workspace: '@picoaide/dsh-wasm-apps-host',
        exports: JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).exports,
        tsdown: readFileSync(join(source, 'tsdown.config.ts'), 'utf8'),
        sources: ['src/index.ts'],
        // tsdown 入口产物按真配置补齐（扩展名取 .js；preload 那类 .cjs 已经由
        // 上面的真实解析用例覆盖）。
        artifacts: [
          ...declaredExportArtifacts(source),
          ...tsdownEntryKeys(source).map(entry => `lib/${entry}.js`),
        ],
      },
    ])
    const a = pkg(dir)
    expect(declared.length).toBeGreaterThan(0)
    expect(missingDeclaredArtifacts(root, a)).toEqual([])
    expect(isUpToDate(root, a, registry)).toBe(true)
    rmSync(join(root, dir, 'lib', 'types', 'index.d.ts'))
    expect(isUpToDate(root, a, registry)).toBe(false)
    expect(stalenessReason(root, a, registry)).toContain('missing 1 declared artifact(s): lib/types/index.d.ts')
  })

  it('声明面自检：脚本里读到的 exports 与 package.json 逐字一致（不另抄一份表）', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'packages/host/wasm-apps-host/package.json'), 'utf8')) as {
      exports: Record<string, { types?: string; default?: string }>
    }
    const declared = declaredExportArtifacts(join(repoRoot, 'packages/host/wasm-apps-host'))
    const expected = Object.values(manifest.exports)
      .flatMap(entry => [entry.types, entry.default])
      .filter((target): target is string => typeof target === 'string' && target.startsWith('./lib/'))
      .map(target => target.slice(2))
      .sort()
    expect([...new Set(expected)]).toEqual(declared)
  })
})
