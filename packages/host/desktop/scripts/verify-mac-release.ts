/** Verify the signed application sealed inside one macOS release DMG. */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MACOS_ARM64_NATIVE_ENTRIES, resolveNativeEntry } from './mac-runtime.ts'
import { asarLayoutLogLine, assertMacBundleConsistency } from './mac-bundle-consistency.ts'
import { packagedAppId, packagedProductName } from './channel-build.ts'
import { isDirectInvocation } from './direct-invocation.mjs'

/** Injectable filesystem and command boundaries for release verification. */
export interface MacReleaseVerificationOptions {
  /** Directory containing exactly one release DMG. */
  readonly distDir: string
  /** Installed application name inside the mounted image. */
  readonly productName: string
  /**
   * 期望的 `CFBundleIdentifier` = "本次构建声明的身份"（与 `productName` 同形，**必填**）。
   *
   * 见 `verify-mac-smoke.ts` 的同名字段（2026-09-26 复审 B-3）：内联 `packagedAppId()` 时
   * 这条判据不可注入，单测只能读工作树里那份 gitignored 的 `build/channel.json`，
   * 工作树残留一次渠道构建就让 mac 单测红，且被说成"产物声称了另一个身份"。
   */
  readonly expectedIdentifier: string
  /** True (default) when the app is notarized and stapled — spctl/stapler
   * checks apply. Pre-release sign-only builds pass false so verification
   * checks codesign/deep/strict only (a signed-but-unnotarized app is
   * rejected by spctl and has no stapled ticket). */
  readonly notarized?: boolean
  /** Return regular DMG files in the distribution directory. */
  readonly listDmgs: (distDir: string) => readonly string[]
  /** Create a private empty mount point. */
  readonly makeMountPoint: () => string
  /** Execute one macOS verification command. */
  readonly run: (command: string, args: readonly string[]) => void
  /**
   * 执行一条命令并**取回输出**（随包运行时的版本判据要读 stdout）。
   *
   * 可选：缺省 = 真实 spawnSync（utf8）。单测注入替身即可，不必起进程。
   */
  readonly capture?: ((command: string, args: readonly string[]) => string) | undefined
  /** Remove the detached empty mount point. */
  readonly removeMountPoint: (mountPoint: string) => void
}

function listDmgs(distDir: string): readonly string[] {
  return readdirSync(distDir)
    .filter(name => name.endsWith('.dmg'))
    .map(name => join(distDir, name))
    .filter(path => statSync(path).isFile())
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

/** 默认的"取回输出"实现（生产路径；单测注入替身）。 */
function captureOutput(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}: ${output}`)
  }
  return output
}

function defaultOptions(): MacReleaseVerificationOptions {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  // 审计 2026-08-25 C-05:此前硬编码厂商名——品牌改名即验证失效/误报。
  // 2026-09-10:改为读**本次构建声明的**产品名(随包 channel.json → 渠道名;
  // 官方/本地 → 官方默认)。只读 package.json 在渠道构建下会去找错名字的 .app。
  // 产品名对齐**本次构建声明的渠道内容**(随包 build/channel.json;渠道构建下
  // 即渠道名)。此前只读 package.json:官方名对,渠道构建会去找错名字的 .app
  // —— 渠道矩阵的 mac 验证要么误报要么卡死(2026-09-10)。
  const productName = packagedProductName()
  return {
    distDir: process.argv[2] === undefined
      ? join(packageRoot, 'dist', 'mac-release')
      : resolve(process.argv[2]),
    productName,
    // 身份与产品名同源（都在随包 build/channel.json 里）；生产路径在这里读一次，
    // 单测显式注入自己的期望值（B-3）。
    expectedIdentifier: packagedAppId(),
    notarized: !process.argv.includes('--unnotarized'),
    listDmgs,
    makeMountPoint: () => mkdtempSync(join(tmpdir(), 'dsh-desktop-dmg-')),
    run,
    capture: captureOutput,
    removeMountPoint: mountPoint => rmdirSync(mountPoint),
  }
}

/** 随包 agent 运行时清单里本判据要用的字段。 */
interface BundledRuntimesManifestShape {
  readonly schema?: unknown
  readonly versions?: { readonly node?: unknown, readonly pnpm?: unknown, readonly python?: unknown }
  readonly commands?: Readonly<Record<string, unknown>>
}

/**
 * 随包 agent 运行时的**签名与可执行性**判据（2026-10-08，macOS 侧）。
 *
 * 为什么这条不能只靠 `codesign --verify --deep --strict <app>`：`--deep` 验的是 bundle 的
 * 密封与顶层签名链，**不保证** `Contents/Resources` 下的嵌套 Mach-O 都被 Developer ID 重签
 * 过（python-build-standalone 出厂只有 **ad-hoc** 签名 + 无 CMS/entitlements，而 Apple
 * 公证逐字排除 ad hoc 证书），也不保证它们真能执行（丢可执行位、被 Gatekeeper 拦下都不会
 * 让 `--deep` 变红）。这两类缺陷的表现都是"员工点一下创造模式就报 ENOENT / 被系统拒绝"。
 *
 * 判据三条，缺一不可：① 三个入口逐个 `codesign --verify --strict`；② 三个 shim **真跑
 * 一次**并逐字比对清单里的版本；③ 载荷清单必须在（与 afterPack 同口径：本构建声明了
 * 运行时就必须在）。
 * @param appPath - 已挂载的 `.app` 路径。
 * @param run - 命令执行（非零退出即抛）。
 * @param capture - 取回输出的执行（版本判据读 stdout）。
 * @throws 载荷缺失、入口不在、验签失败、或版本不符。
 */
export function assertBundledRuntimesSigned(
  appPath: string,
  run: (command: string, args: readonly string[]) => void,
  capture: (command: string, args: readonly string[]) => string,
): void {
  const runtimeRoot = join(appPath, 'Contents', 'Resources', 'runtimes')
  const manifestPath = join(runtimeRoot, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(
      `macOS release verification: ${manifestPath} is missing — this build declares bundled agent `
      + 'runtimes (node/pnpm/python) but the application carries none; package through '
      + 'scripts/release-mac.ts (it runs prepareChannelPackaging → fetch-bundled-runtimes.mjs)',
    )
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BundledRuntimesManifestShape
  if (manifest.schema !== 1) {
    throw new Error(`macOS release verification: ${manifestPath} declares schema ${String(manifest.schema)}`)
  }
  const commands = manifest.commands ?? {}
  const entries = Object.entries(commands)
  if (entries.length !== 3) {
    throw new Error(`macOS release verification: ${manifestPath} declares ${String(entries.length)} runtime commands, expected 3`)
  }
  for (const [key, relative] of entries) {
    if (typeof relative !== 'string') throw new Error(`macOS release verification: ${key} has no command path`)
    const target = join(runtimeRoot, relative)
    if (!existsSync(target)) throw new Error(`macOS release verification: bundled runtime ${key} is missing at ${target}`)
    // 逐个 Mach-O 严格验签（`codesign --verify` 会跟随 `bin/python3` 这类符号链接）。
    run('codesign', ['--verify', '--strict', '--verbose=2', target])
  }
  const versions = manifest.versions ?? {}
  const expectations: readonly [string, readonly string[], string][] = [
    ['node', ['-v'], `v${String(versions.node)}`],
    ['pnpm', ['-v'], String(versions.pnpm)],
    ['python3', ['-V'], String(versions.python)],
  ]
  for (const [command, args, expected] of expectations) {
    const shim = join(runtimeRoot, 'bin', command)
    if (!existsSync(shim)) throw new Error(`macOS release verification: bundled runtime shim ${shim} is missing`)
    const output = capture(shim, args)
    if (!output.includes(expected)) {
      throw new Error(
        `macOS release verification: bundled ${command} reported ${JSON.stringify(output)}, the payload pins ${expected}`,
      )
    }
  }
  console.log(
    `dsh-plugin-desktop: bundled agent runtimes signed and runnable (node ${String(versions.node)} / `
    + `pnpm ${String(versions.pnpm)} / python ${String(versions.python)})`,
  )
}

/**
 * Mount and verify the application contained in the unique release DMG.
 * @param options - Filesystem and command boundaries.
 * @returns The verified DMG and application paths.
 */
export function verifyMacRelease(
  options: MacReleaseVerificationOptions = defaultOptions(),
): { readonly appPath: string; readonly dmgPath: string } {
  const dmgs = options.listDmgs(options.distDir)
  if (dmgs.length !== 1) {
    throw new Error(
      `macOS release verification requires exactly one DMG in ${options.distDir}; found ${String(dmgs.length)}`,
    )
  }

  const dmgPath = dmgs[0]!
  const mountPoint = options.makeMountPoint()
  const appPath = join(mountPoint, `${options.productName}.app`)
  let mounted = false
  let failure: unknown

  try {
    options.run('hdiutil', ['attach', dmgPath, '-mountpoint', mountPoint, '-nobrowse', '-readonly'])
    mounted = true
    const executablePath = join(appPath, 'Contents', 'MacOS', options.productName)
    options.run('lipo', [executablePath, '-verify_arch', 'arm64'])
    const asarPath = join(appPath, 'Contents', 'Resources', 'app.asar')
    const unpackedRoot = existsSync(asarPath)
      ? join(appPath, 'Contents', 'Resources', 'app.asar.unpacked')
      : join(appPath, 'Contents', 'Resources', 'app')
    for (const entry of MACOS_ARM64_NATIVE_ENTRIES) {
      options.run('lipo', [resolveNativeEntry(unpackedRoot, entry), '-verify_arch', entry.arch])
    }
    options.run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
    // spctl/stapler 只对已公证+staple 的产物有意义;预发只签名不公证传
    // notarized: false 跳过(未公证 app 会被 spctl 拒绝,且无 stapled ticket)。
    if (options.notarized !== false) {
      options.run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath])
      options.run('xcrun', ['stapler', 'validate', appPath])
    }
    // 签名/公证都通过，也不代表包内自洽：`CFBundleIconFile` 可能指向不存在的 `.icns`，
    // `app.asar` 的 offset 表可能与实体不符，`CFBundleIdentifier` 可能不是本次构建声明的
    // 身份（渠道包回落官方身份 ⇒ 与官方版抢 LaunchServices 身份/SSO 回调/安装覆盖）。
    // 这三类缺陷在双击之后才暴露，且 `codesign --verify` 与 `stapler validate` 都不会报
    // （见 mac-bundle-consistency.ts）。
    // 只在挂载点真的存在时判（真实发布一定成立；单测用注入替身 + 伪路径驱动命令边界）。
    if (existsSync(appPath)) {
      // 随包运行时（2026-10-08）：嵌套二进制的验签与可执行性（见该函数注释）。
      assertBundledRuntimesSigned(appPath, options.run, options.capture ?? captureOutput)
      const bundle = assertMacBundleConsistency(appPath, undefined, {
        expectedIdentifier: options.expectedIdentifier,
      })
      // 归档布局摘要进日志（B-5）：`linkEntries` 存在的理由正是让"归档里有链接、
      // 判据没有建模它的字节账"在日志里可见，而这里此前丢弃了返回值。
      if (bundle.asar !== undefined) console.log(asarLayoutLogLine(`${appPath}/Contents/Resources/app.asar`, bundle.asar))
    }
  } catch (cause) {
    failure = cause
  }

  const cleanupFailures: unknown[] = []
  if (mounted) {
    try {
      options.run('hdiutil', ['detach', mountPoint])
    } catch (cause) {
      cleanupFailures.push(cause)
    }
  }
  try {
    options.removeMountPoint(mountPoint)
  } catch (cause) {
    cleanupFailures.push(cause)
  }

  if (failure !== undefined || cleanupFailures.length > 0) {
    const failures = failure === undefined ? cleanupFailures : [failure, ...cleanupFailures]
    throw new AggregateError(failures, `failed to verify macOS release DMG ${basename(dmgPath)}`)
  }
  return { appPath, dmgPath }
}

if (isDirectInvocation(import.meta)) {
  try {
    const verified = verifyMacRelease()
    console.log(`macOS release verification passed: ${verified.dmgPath}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
