/**
 * 打包输入暂存层（`scripts/pack-app-root.mjs`）的门禁。
 *
 * 为什么这些用例必须存在（2026-09-22 泄漏事故）：
 * 11 个已发布的正式/预发包都夹带了桌面包自身的 `src/tests/scripts`、各
 * `@picoaide/dsh-*` 的源码目录、33 个内嵌原始 TypeScript 的 sourcemap、
 * 以及 263 MiB 的 `temp/`（含两个 156/119 MiB 的 squashfs 试验件）。根因是
 * **electron-builder 26 不把 `build.files` 用在应用根目录内容上**，所以
 * `files` 里那些排除规则全是声明而非证据。修复改成"进包前先把应用根暂存成
 * 白名单副本"，这里钉住三件事：
 *   1. 暂存内容**只有**运行期白名单（多一个都要红）；
 *   2. sourcemap 在进包前就被丢掉（不是靠打包后删）；
 *   3. 四个打包脚本都真的接了这个机制（源码级接线守卫）。
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  assertStageRootIsRealDirectory,
  listStageEntries,
  PACK_APP_ROOT_ENTRIES,
  PACK_APP_ROOT_FORBIDDEN_ENTRIES,
  stagePackAppRoot,
  withStagedPackAppRoot,
} from '../scripts/pack-app-root.mjs'
import { CHANNEL_ENV, prepareChannelBuilderOverrides, resolveChannelBuildContext, stageChannelProfile } from '../scripts/channel-build.ts'
import { packageDir } from '../scripts/package-dir.mjs'
import { packageLinux } from '../scripts/package-linux.mjs'
import { packageMacSmoke } from '../scripts/package-mac.ts'
import { packageWindowsArtifact } from '../scripts/package-win.ts'
import { packMacApp } from '../scripts/release-mac.ts'

const desktopRoot = fileURLToPath(new URL('../', import.meta.url))

/** 造一个最小但结构正确的假包根，避免用例依赖真实构建产物。 */
function fakePackageRoot(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pack-root-'))
  mkdirSync(join(root, 'lib', 'preload'), { recursive: true })
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, 'lib', 'main.js'), 'export {}\n')
  writeFileSync(join(root, 'lib', 'main.js.map'), '{"sourcesContent":["SECRET"]}\n')
  writeFileSync(join(root, 'lib', 'preload', 'renderer-error.cjs'), '// p\n')
  writeFileSync(join(root, 'build', 'app-icon.png'), 'png\n')
  writeFileSync(join(root, 'cordis.patch.yml'), 'rows: []\n')
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: 'dsh-plugin-desktop',
    version: '1.2.3',
    main: 'lib/main.js',
    build: { files: ['lib/**'] },
    devDependencies: { vitest: '4.1.8' },
    scripts: { test: 'vitest' },
    peerDependencies: { electron: '44.4.3' },
    resolutions: { x: 'y' },
    files: ['lib/**/*.js'],
  }, null, 2)}\n`)
  // 开发期条目：任何一个被暂存都算回归。
  mkdirSync(join(root, 'src', 'client'), { recursive: true })
  writeFileSync(join(root, 'src', 'client', 'AdvancedFrame.tsx'), 'export const x = 1\n')
  mkdirSync(join(root, 'tests'), { recursive: true })
  writeFileSync(join(root, 'tests', 'package.spec.ts'), 'it("x", () => {})\n')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'scripts', 'notarize-mac.ts'), 'export {}\n')
  mkdirSync(join(root, 'temp'), { recursive: true })
  writeFileSync(join(root, 'temp', 'squash-xz.squashfs'), 'BIG\n')
  mkdirSync(join(root, '.e2e-shots'), { recursive: true })
  writeFileSync(join(root, '.e2e-shots', 'shot.png'), 'img\n')
  mkdirSync(join(root, '.real-env-shots'), { recursive: true })
  writeFileSync(join(root, '.real-env-shots', 'shot.png'), 'img\n')
  writeFileSync(join(root, 'tsdown.config.ts'), 'export default {}\n')
  writeFileSync(join(root, 'COVERAGE-MATRIX.md'), '# m\n')
  for (const [rel, content] of Object.entries(extra) as Array<[string, string]>) {
    writeFileSync(join(root, rel), content)
  }
  return root
}

describe('打包输入暂存层（应用根白名单）', () => {
  it('暂存的直接子项恰好等于运行期白名单', () => {
    const root = fakePackageRoot()
    const staged = stagePackAppRoot(root, 'dist')
    try {
      // 正向：白名单条目必须在。
      expect(listStageEntries(staged.stageRoot).sort()).toEqual([...PACK_APP_ROOT_ENTRIES].sort())
      // 反例：每个开发期条目都不得出现（逐条判，不靠"至少没全在"）。
      for (const forbidden of [
        'src', 'tests', 'scripts', 'temp', '.e2e-shots', '.real-env-shots',
        'tsdown.config.ts', 'COVERAGE-MATRIX.md',
      ]) {
        expect(existsSync(join(staged.stageRoot, forbidden)), forbidden).toBe(false)
      }
    } finally {
      staged.cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('sourcemap 在进包前就丢掉（sourcesContent 内嵌原始 TS，删晚了等于已泄露）', () => {
    const root = fakePackageRoot()
    const staged = stagePackAppRoot(root, 'dist')
    try {
      // 前置断言：源目录里确实有 map，否则判据空转。
      expect(existsSync(join(root, 'lib', 'main.js.map'))).toBe(true)
      expect(existsSync(join(staged.stageRoot, 'lib', 'main.js.map'))).toBe(false)
      expect(existsSync(join(staged.stageRoot, 'lib', 'main.js'))).toBe(true)
      expect(existsSync(join(staged.stageRoot, 'lib', 'preload', 'renderer-error.cjs'))).toBe(true)
    } finally {
      staged.cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('暂存的 package.json 去掉 build/开发专用键，保留运行期解析要用的字段', () => {
    const root = fakePackageRoot()
    const staged = stagePackAppRoot(root, 'dist')
    try {
      const manifest = JSON.parse(readFileSync(join(staged.stageRoot, 'package.json'), 'utf8'))
      // electron-builder 3.0 起禁止应用包声明构建配置（会直接拒包）。
      for (const key of ['build', 'devDependencies', 'scripts', 'peerDependencies', 'resolutions', 'files']) {
        expect(manifest, key).not.toHaveProperty(key)
      }
      // 运行期与打包元数据必须原样保留。
      expect(manifest.name).toBe('dsh-plugin-desktop')
      expect(manifest.main).toBe('lib/main.js')
      expect(manifest.version).toBe('1.2.3')
    } finally {
      staged.cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('缺运行期条目时 fail-loud（不能"少一个也照打"）', () => {
    const root = fakePackageRoot()
    rmSync(join(root, 'cordis.patch.yml'))
    expect(() => stagePackAppRoot(root, 'dist')).toThrow(/运行期条目缺失/u)
    rmSync(root, { recursive: true, force: true })
  })

  it('暂存根必须是真实目录（符号链接会被 electron-builder 展开成真实内容）', () => {
    const root = fakePackageRoot()
    const staged = stagePackAppRoot(root, 'dist')
    try {
      expect(assertStageRootIsRealDirectory(staged.stageRoot)).toBe(true)
    } finally {
      staged.cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('withStagedPackAppRoot 产出 directions.app 参数且可清理', () => {
    const root = fakePackageRoot()
    const staged = withStagedPackAppRoot(root, 'dist')
    try {
      expect(staged.args).toEqual([`--config.directories.app=${staged.stageRoot}`])
      expect(staged.stageRoot).toContain(join('dist', '.pack-root'))
      staged.cleanup()
      expect(existsSync(staged.stageRoot)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('同时最多只有一个暂存根：重跑先清旧的（否则旧内容被当输入收编）', () => {
    const root = fakePackageRoot()
    const first = stagePackAppRoot(root, 'dist')
    // 手工塞一个"上次残留"的文件进暂存根。
    writeFileSync(join(first.stageRoot, 'leftover-from-previous-run.js'), 'x\n')
    const second = stagePackAppRoot(root, 'dist')
    try {
      expect(existsSync(join(second.stageRoot, 'leftover-from-previous-run.js'))).toBe(false)
      expect(listStageEntries(second.stageRoot).sort()).toEqual([...PACK_APP_ROOT_ENTRIES].sort())
    } finally {
      second.cleanup()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('打包脚本必须真的接上暂存层（源码级接线守卫）', () => {
  // 只测辅助模块本身会漏掉"没被调用"——本轮变异验证实测过这个缺口：
  // 把接线那一行删掉，辅助模块的用例全绿而产物照旧泄漏。
  //
  // ⚠️ 这一组是**存在性**判据（"标识符在源码里"），它拦不住"保留标识符 + 换实现"
  // （第三轮审计 P-2 的 M1a/M2 两种注入）。能力级判据在下一组。
  const scripts = [
    'scripts/package-dir.mjs',
    'scripts/package-linux.mjs',
    'scripts/package-mac.ts',
    'scripts/package-win.ts',
    'scripts/release-mac.ts',
  ]

  it.each(scripts)('%s 调用暂存层并把 args 传给 electron-builder', (relative) => {
    const source = readFileSync(join(desktopRoot, relative), 'utf8')
    // 允许可注入形式（`options.stagePackAppRoot ?? withStagedPackAppRoot`）：
    // 打包脚本的用例用假路径驱动命令边界，必须能替掉真实现；生产调用一律缺省真实现。
    expect(source).toMatch(/withStagedPackAppRoot/u)
    expect(source).toMatch(/\.\.\.staged\.args/u)
  })

  it.each(scripts)('%s 用 finally 保证暂存目录被清掉', (relative) => {
    const source = readFileSync(join(desktopRoot, relative), 'utf8')
    // 暂存目录留在 dist/ 里 = 下一次打包把它当输入收编（报告里 3514.6 MB 产物的场景）。
    expect(source).toMatch(/\} finally \{[\s\S]{0,200}?staged\.cleanup\(\)/u)
  })
})

describe('五个打包脚本的缺省路径就是真暂存（能力级接线判据，第三轮审计 P-2）', () => {
  // 为什么必须存在（2026-09-23 第三轮审计 P-2 实测）：
  //   * M1a —— 把 `const staged = withStagedPackAppRoot(...)` 换成
  //     `const staged = { stageRoot: packageRoot, cleanup() {}, args: [] }`：
  //     上一组源码守卫**全绿**（17 passed），因为 `withStagedPackAppRoot` 仍出现在
  //     import 行里；
  //   * M2 —— 五个脚本同时"保留标识符 + 换实现"：4 个 spec / 34 用例全绿。
  // 所以"被调用过"必须由**行为**证明：不注入 `stagePackAppRoot`、给一个**真实存在**
  // 的包根，看 electron-builder 到底收到了什么 argv、那一刻暂存目录里有什么。

  /** 一次 builder 调用时对暂存目录的现场观测。 */
  interface StageObservation {
    /** electron-builder 收到的 argv。 */
    readonly args: readonly string[]
    /** 暂存根是不是真实目录（不存在 / 是符号链接 ⇒ false）。 */
    readonly isRealDirectory: boolean
    /** 暂存根的直接子项（读不到 = null）。 */
    readonly entries: readonly string[] | null
  }

  /** 在 `<desktopRoot>/dist/.pack-root` 上做一次现场观测（**在 builder 调用那一刻**）。 */
  function observeStage(desktopRoot: string): Omit<StageObservation, 'args'> {
    const stageRoot = join(desktopRoot, 'dist', '.pack-root')
    try {
      const stat = statSync(stageRoot)
      return { isRealDirectory: stat.isDirectory(), entries: readdirSync(stageRoot).sort() }
    } catch {
      return { isRealDirectory: false, entries: null }
    }
  }

  /** 记录 argv + 现场观测的 `run` 注入替身。 */
  function recordingRun(desktopRoot: string, calls: StageObservation[]) {
    return (command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): void => {
      // 只记"打包命令"（脚本还会跑 check/verifier 之类的别的命令）。
      if (args.some(arg => arg.includes('electron-builder') || arg === '--dir' || arg === '--mac' || arg === '--win')) {
        calls.push({ args: [...args], ...observeStage(desktopRoot) })
      }
      void command
      void cwd
      void env
    }
  }

  /**
   * 核心判据：暂存根**真实存在**、只有白名单条目、`--config.directories.app` 指向它，
   * 并且调用结束后它被清掉了。任何一条不成立都说明"接线没接上或缺省被换成了替身"。
   */
  function assertStageWasReal(label: string, desktopRoot: string, calls: readonly StageObservation[]): void {
    const stageRoot = join(desktopRoot, 'dist', '.pack-root')
    expect(calls.length, `${label}: 没有观测到任何打包命令`).toBeGreaterThan(0)
    const builderCall = calls[calls.length - 1]!
    const appArg = builderCall.args.find(arg => arg.startsWith('--config.directories.app='))
    expect(appArg, `${label}: electron-builder 没收到 --config.directories.app（args=${builderCall.args.join(' ')}）`)
      .toBe(`--config.directories.app=${stageRoot}`)
    expect(builderCall.isRealDirectory, `${label}: 打包那一刻 ${stageRoot} 不是真实目录`).toBe(true)
    expect(builderCall.entries, `${label}: 打包那一刻暂存根为空/读不到`).toEqual([...PACK_APP_ROOT_ENTRIES].sort())
    // finally 里的 cleanup 真的执行了（留着会被下一次打包当输入收编）。
    expect(existsSync(stageRoot), `${label}: 打包结束后暂存根没有清掉`).toBe(false)
  }

  it('withStagedPackAppRoot 的缺省行为：真产出白名单副本，args 指向它，cleanup 后目录消失', () => {
    const root = fakePackageRoot()
    const staged = withStagedPackAppRoot(root, 'dist')
    try {
      // 前置：源目录里**确实有**开发期条目，否则"只有白名单"是空转判据。
      expect(existsSync(join(root, 'src', 'client', 'AdvancedFrame.tsx'))).toBe(true)
      expect(statSync(staged.stageRoot).isDirectory()).toBe(true)
      expect(readdirSync(staged.stageRoot).sort()).toEqual([...PACK_APP_ROOT_ENTRIES].sort())
      expect(staged.args).toEqual([`--config.directories.app=${staged.stageRoot}`])
      // args 指的那个目录必须**真的存在**（字符串相等不算）。
      const fromArgs = staged.args[0]!.slice('--config.directories.app='.length)
      expect(existsSync(fromArgs)).toBe(true)
      expect(readdirSync(fromArgs).sort()).toEqual([...PACK_APP_ROOT_ENTRIES].sort())
    } finally {
      staged.cleanup()
      expect(existsSync(staged.stageRoot)).toBe(false)
      rmSync(root, { recursive: true, force: true })
    }
  })

  const commandCalls: Array<{
    label: string
    run: (desktopRoot: string, calls: StageObservation[]) => void | Promise<void>
  }> = [
    {
      label: 'package-dir.mjs',
      run: (desktopRoot, calls) => {
        packageDir({
          desktopRoot,
          builderCli: join(desktopRoot, 'fake-electron-builder-cli.js'),
          channelConfigArgs: () => [],
          run: recordingRun(desktopRoot, calls),
        })
      },
    },
    {
      label: 'package-linux.mjs',
      run: (desktopRoot, calls) => {
        packageLinux({
          desktopRoot,
          builderCli: join(desktopRoot, 'fake-electron-builder-cli.js'),
          channelConfigArgs: () => [],
          channelId: 'official',
          run: recordingRun(desktopRoot, calls),
          log: () => undefined,
        })
      },
    },
    {
      label: 'package-mac.ts',
      run: (desktopRoot, calls) => {
        packageMacSmoke({
          env: {},
          platform: 'darwin',
          arch: 'arm64',
          nodeVersion: '22.23.2',
          workspaceRoot: dirname(desktopRoot),
          desktopRoot,
          outputDir: join(desktopRoot, 'dist', 'mac-smoke'),
          resetOutput: () => undefined,
          prepareRuntime: () => undefined,
          builderCli: join(desktopRoot, 'fake-electron-builder-cli.js'),
          verifier: join(desktopRoot, 'fake-verifier.ts'),
          nodeExecutable: process.execPath,
          channelConfigArgs: () => [],
          run: recordingRun(desktopRoot, calls),
          log: () => undefined,
        }, { skipGates: true })
      },
    },
    {
      label: 'package-win.ts',
      run: (desktopRoot, calls) => {
        packageWindowsArtifact({
          env: {},
          platform: 'win32',
          arch: 'x64',
          nodeVersion: '22.23.2',
          workspaceRoot: dirname(desktopRoot),
          desktopRoot,
          commandShell: 'cmd.exe',
          builderCli: join(desktopRoot, 'fake-electron-builder-cli.js'),
          verifier: join(desktopRoot, 'fake-verifier.ts'),
          nodeExecutable: process.execPath,
          channelConfigArgs: () => [],
          channelId: 'official',
          run: recordingRun(desktopRoot, calls),
          log: () => undefined,
        }, 'nsis', 'installer', { skipGates: true })
      },
    },
    {
      label: 'release-mac.ts',
      run: async (desktopRoot, calls) => {
        await packMacApp({
          env: {},
          platform: 'darwin',
          desktopRoot,
          outputDir: join(desktopRoot, 'dist', 'mac-release'),
          productName: 'PicoAide Harness',
          channelConfigArgs: () => [],
          resetOutput: () => undefined,
          listCodeSigningIdentities: () => '  1) 0123456789ABCDEF "Developer ID Application: Release Signer (TEAM123456)"\n',
          run: recordingRun(desktopRoot, calls),
          notarize: async () => undefined,
          log: () => undefined,
          prepareRuntime: () => undefined,
        }, { skipGates: true, signOnly: true })
      },
    },
  ]

  it.each(commandCalls)('$label 不注入 stagePackAppRoot 时真的暂存了应用根', async ({ label, run }) => {
    const desktopRoot = fakePackageRoot()
    const calls: StageObservation[] = []
    try {
      await run(desktopRoot, calls)
      assertStageWasReal(label, desktopRoot, calls)
    } finally {
      rmSync(desktopRoot, { recursive: true, force: true })
    }
  })
})

/**
 * 渠道覆盖文件不得进入打包输入（2026-09-23 独立复审 N-1）。
 *
 * 机制：`build` 是暂存白名单条目，`stagePackAppRoot()` 会把它**整目录**复制 ⇒ 任何
 * 写在 `build/` 里的打包工具中间产物都会进 `app.asar`。渠道构建生成的
 * electron-builder 配置（含渠道 productName/appId/深链 scheme/产物名模板）曾经就写在
 * `build/` 里、且生成时机早于暂存 ⇒ **beta 与各品牌渠道的 asar 都多出这个文件**；
 * 官方渠道不生成它，所以本机跑官方 `package-dir.mjs` 看不见。这里用**生产缺省路径**
 * （真暂存 + 真渠道上下文 + 记录 argv 的 run）在进程内复刻复审的假 builder 端到端。
 */
describe('渠道覆盖文件不得进入暂存输入（N-1）', () => {
  /** 造一个只含 channel.json 的最小渠道仓。 */
  function channelRepo(): string {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pack-channel-'))
    const dir = join(root, 'channels', 'acme')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'channel.json'), `${JSON.stringify({
      schema: 1,
      channel_id: 'acme',
      identity: { display_name: 'Acme AI' },
      desktop: { slug: 'Acme-AI', app_id: 'com.acme.ai', deep_link_scheme: 'acmeai' },
    }, null, 2)}\n`)
    return root
  }

  it('渠道构建：打包那一刻暂存 build/ 里只有随包 channel.json，覆盖文件落在暂存之外', async () => {
    const root = fakePackageRoot()
    const channelRoot = channelRepo()
    const context = resolveChannelBuildContext({ env: { [CHANNEL_ENV]: 'acme' }, repoRoot: channelRoot })
    const calls: Array<{ args: readonly string[], stageBuild: readonly string[] | null }> = []
    try {
      // 生产顺序：**先**就位随包渠道配置（直接执行分支里的 prepareChannelPackaging），
      // 再进打包函数（暂存发生在这里面）。
      stageChannelProfile(context, join(root, 'build'))
      await packageLinux({
        desktopRoot: root,
        builderCli: join(root, 'fake-electron-builder-cli.js'),
        // 生产缺省的惰性求值：配置在暂存之后生成（见各打包脚本的 channelConfigArgs）。
        channelConfigArgs: () => prepareChannelBuilderOverrides(context, {
          buildDir: join(root, 'build'),
          configDir: join(root, 'temp'),
        }),
        channelId: 'acme',
        run: (_command, args) => {
          if (!args.includes('--linux')) return
          const stagedBuild = join(root, 'dist', '.pack-root', 'build')
          calls.push({
            args: [...args],
            stageBuild: existsSync(stagedBuild) ? readdirSync(stagedBuild).sort() : null,
          })
        },
        log: () => undefined,
      })

      expect(calls, '没有观测到打包命令').toHaveLength(1)
      const call = calls[0]!
      // 正向：随包渠道配置必须在暂存里（运行期读的就是 asar 里的这一份）。
      expect(call.stageBuild).toContain('channel.json')
      // 反例：打包工具中间产物不得在暂存里（整目录复制会把它带进 asar）。
      expect(call.stageBuild).not.toContain('channel-electron-builder.cjs')
      // 它确实生成了，只是落在**暂存目录之外**，并且真的传给了 electron-builder。
      const configIndex = call.args.indexOf('--config')
      expect(configIndex).toBeGreaterThan(-1)
      const configPath = call.args[configIndex + 1]!
      expect(existsSync(configPath)).toBe(true)
      expect(configPath.startsWith(join(root, 'dist', '.pack-root'))).toBe(false)
      // 源包根的 build/ 里也不该留（旧形态留下的残留在暂存前会被清掉）。
      expect(existsSync(join(root, 'build', 'channel-electron-builder.cjs'))).toBe(false)
      // 暂存目录已被清掉（try/finally 生效）。
      expect(existsSync(join(root, 'dist', '.pack-root'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(channelRoot, { recursive: true, force: true })
    }
  })

  it('源包根里残留打包配置时，暂存当场拒包（把修法拆回旧顺序 = 红）', () => {
    const root = fakePackageRoot()
    try {
      // 前置：这个文件确实会被"整目录复制"带上（它是白名单条目 build/ 里的文件）。
      expect(PACK_APP_ROOT_ENTRIES).toContain('build')
      writeFileSync(join(root, 'build', 'channel-electron-builder.cjs'), 'module.exports = {}\n')
      expect(() => stagePackAppRoot(root, 'dist')).toThrow(/打包工具中间产物/u)
      // 禁止形态表里有它（这条判据不是写死的字面量，而是与产物侧同名的清单）。
      expect(PACK_APP_ROOT_FORBIDDEN_ENTRIES).toContain('build/channel-electron-builder.cjs')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
