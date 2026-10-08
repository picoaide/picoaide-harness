/**
 * macOS `.app` 夹具（测试共用）。
 *
 * 存在的理由：包内一致性判据（`scripts/mac-bundle-consistency.ts`）上线后，
 * "结构对了"的假包不再够用 —— 夹具必须给出**真实可解析**的 `Info.plist`、真实的
 * `.icns`、以及一份**布局自洽**的 `app.asar`（头部摘要要与 `ElectronAsarIntegrity`
 * 一致）。三处用例（smoke / release / afterPack）都要这一份，所以只留一个实现。
 *
 * 归档布局与真实产物一致（本机对拍于 111 927 459 B 的真实 `app.asar`）：
 * `[u32=4][u32 payloadSize][u32 nestedSize][u32 jsonLen][json padded][data]`。
 *
 * @module tests/helpers/mac-bundle-fixture
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

/** 最小 asar 的字节与头部摘要。 */
export interface MinimalAsar {
  /** 归档字节。 */
  readonly bytes: Buffer
  /** 头部 JSON 的 SHA-256（= 写进 `ElectronAsarIntegrity` 的值）。 */
  readonly digest: string
}

/** 夹具**缺省写入**的 bundle id（= 官方身份，与 `packagedAppId()` 的缺省回落同值）。 */
export const MAC_BUNDLE_FIXTURE_IDENTIFIER = 'ai.deepseek.dsh.desktop'

/** `minimalAsar` 的可选项。 */
export interface MinimalAsarOptions {
  /**
   * 额外的**符号链接条目**（`[路径, 归档根相对目标]`）。
   *
   * 存在的理由（2026-09-26 复审 B-4/B-5）：自指 / 成环 / 悬空目标三类链接形态必须能被
   * 判据咬到，而 `@electron/asar#createPackage` 真能产出前两类 —— 夹具要能造出这三种头部。
   * 链接不占数据区（`insertLink` 不写 size/offset），所以铺满等式不受影响。
   */
  readonly links?: ReadonlyArray<readonly [string, string]>
}

/**
 * 造一份布局自洽的最小 asar（单个 `package.json` 条目，可选若干符号链接）。
 * @param data - 归档内唯一文件的字节（缺省 `{}`）。
 * @param options - 额外的链接条目。
 * @returns 归档字节与头部摘要。
 */
export function minimalAsar(data: Buffer = Buffer.from('{}'), options: MinimalAsarOptions = {}): MinimalAsar {
  const files: Record<string, unknown> = { 'package.json': { size: data.length, offset: '0' } }
  for (const [path, target] of options.links ?? []) files[path] = { link: target }
  const json = Buffer.from(JSON.stringify({ files }), 'utf8')
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4)
  json.copy(padded)
  const nested = 4 + padded.length
  const payloadSize = 4 + nested
  const head = Buffer.alloc(8)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(payloadSize, 4)
  const payload = Buffer.alloc(payloadSize)
  payload.writeUInt32LE(nested, 0)
  payload.writeUInt32LE(json.length, 4)
  padded.copy(payload, 8)
  return {
    bytes: Buffer.concat([head, payload, data]),
    digest: createHash('sha256').update(json).digest('hex'),
  }
}

/** `Info.plist` 需要的字段。 */
export interface MacBundleFixtureOptions {
  /** bundle id（缺省官方值）。 */
  readonly identifier?: string
  /** 主可执行文件名（缺省 `<productName>`）。 */
  readonly executable?: string
  /** `CFBundleIconFile`（缺省 `icon.icns`）。 */
  readonly iconFile?: string
  /** 是否写图标文件（缺省写；设为 false 用于"图标缺失"用例）。 */
  readonly writeIcon?: boolean
  /** 归档字节（缺省 {@link minimalAsar}）。 */
  readonly asar?: MinimalAsar
  /** 是否写 `Contents/Resources/app.asar`（缺省写）。 */
  readonly writeAsar?: boolean
}

/**
 * 往一个 `.app` 目录写最小但**自洽**的包内结构。
 *
 * 产出：`Contents/Info.plist`（含 `ElectronAsarIntegrity`）、`Contents/MacOS/<executable>`
 * （0755）、`Contents/Resources/icon.icns`（icns 魔数）、`Contents/Resources/app.asar`。
 * @param appPath - `.app` 目录绝对路径。
 * @param productName - 产品名（决定缺省可执行文件名与 `CFBundleName`）。
 * @param options - 覆盖项。
 * @returns 实际写入的归档（供用例改坏它）。
 */
export function writeValidMacBundle(
  appPath: string,
  productName: string,
  options: MacBundleFixtureOptions = {},
): MinimalAsar {
  const contents = join(appPath, 'Contents')
  const resources = join(contents, 'Resources')
  const macos = join(contents, 'MacOS')
  mkdirSync(resources, { recursive: true })
  mkdirSync(macos, { recursive: true })

  const asar = options.asar ?? minimalAsar()
  const executable = options.executable ?? productName
  const iconFile = options.iconFile ?? 'icon.icns'
  if (options.writeIcon !== false) {
    writeFileSync(join(resources, iconFile), Buffer.concat([Buffer.from('icns', 'latin1'), Buffer.alloc(32, 3)]))
  }
  if (options.writeAsar !== false) {
    writeFileSync(join(resources, 'app.asar'), asar.bytes)
  }
  const executablePath = join(macos, executable)
  writeFileSync(executablePath, 'binary')
  chmodSync(executablePath, 0o755)

  writeFileSync(
    join(contents, 'Info.plist'),
    // DOCTYPE 省略 SYSTEM 标识：判据只需要能跳过 DOCTYPE，而 Apple 的 DTD URL 属未登记域名。
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<plist version="1.0">\n<dict>\n'
    + `\t<key>CFBundleIdentifier</key>\n\t<string>${options.identifier ?? MAC_BUNDLE_FIXTURE_IDENTIFIER}</string>\n`
    + `\t<key>CFBundleExecutable</key>\n\t<string>${executable}</string>\n`
    + `\t<key>CFBundleIconFile</key>\n\t<string>${iconFile}</string>\n`
    + `\t<key>CFBundleName</key>\n\t<string>${productName}</string>\n`
    + '\t<key>ElectronAsarIntegrity</key>\n\t<dict>\n\t\t<key>Resources/app.asar</key>\n\t\t<dict>\n'
    + '\t\t\t<key>algorithm</key>\n\t\t\t<string>SHA256</string>\n'
    + `\t\t\t<key>hash</key>\n\t\t\t<string>${asar.digest}</string>\n`
    + '\t\t</dict>\n\t</dict>\n</dict>\n</plist>\n',
  )
  return asar
}

/** 夹具写入的随包运行时版本（形状与 `build/runtimes/manifest.json` 一致，具体取值无关紧要）。 */
export const MAC_BUNDLE_RUNTIME_VERSIONS = { node: '24.21.0', pnpm: '11.7.0', python: '3.12.15' } as const

/**
 * 夹具里"是真 Mach-O 的入口"写的前 4 字节（64 位小端 `MH_MAGIC_64`）。
 *
 * macOS 判据按魔数分流：Mach-O 必须逐个验签，脚本入口（`pnpm.mjs`）由 bundle 签名封存。
 * 写文本会让两条路径混成一条（要么脚本被送去验签=假红，要么 Mach-O 逃过验签=假绿）。
 */
export const MACH_O_FIXTURE_MAGIC = Buffer.from([0xcf, 0xfa, 0xed, 0xfe])

/** 随包运行时入口的键（= 清单 `commands` 的键）。 */
export type BundledRuntimeCommand = 'node' | 'pnpm' | 'python3'

/** `writeBundledRuntimesFixture` 的覆盖项（每个都对应一条负向判据）。 */
export interface BundledRuntimesFixtureOptions {
  /** 版本覆盖（缺省 {@link MAC_BUNDLE_RUNTIME_VERSIONS}）。 */
  readonly versions?: Partial<Record<'node' | 'pnpm' | 'python', string>>
  /** 清单 `schema` 覆盖值（缺省 1）。 */
  readonly schema?: number
  /** 清单里只声明前 N 个命令（缺省 3；用于"命令数不符"用例）。 */
  readonly commandCount?: number
  /** 根本不写清单（用于"本构建声明了运行时、包里却没有"用例）。 */
  readonly omitManifest?: boolean
  /** 不写某个入口载荷（用于"入口不在"用例）。 */
  readonly omitEntry?: BundledRuntimeCommand
  /** 不写某个 `bin/*` shim（用于"shim 不在"用例）。 */
  readonly omitShim?: BundledRuntimeCommand
  /**
   * 某个入口写"脚本"而不是 Mach-O（缺省三个都是 Mach-O）。
   *
   * 真载荷里 `pnpm` 就是脚本（`pnpm/bin/pnpm.mjs`）—— 2026-10-08 的 tag 因为对它也做
   * `codesign --verify` 而停下；这条覆盖项让"脚本入口不验签、但必须真跑"两侧都有用例。
   */
  readonly entryKinds?: Partial<Record<BundledRuntimeCommand, 'mach-o' | 'script'>>
}

/**
 * 往 `.app` 写一份最小随包运行时载荷（清单 + 三个入口 + 三个 shim）。
 *
 * 存在的理由：macOS 发布判据（`scripts/verify-mac-release.ts` 的
 * `assertBundledRuntimesSigned`）把"验签 + 真跑 + 版本逐字比对"绑在发布路径上，
 * 于是"结构对了"的假包对它不再够用。载荷本身可以是**假字节**（命令执行是注入的
 * 接缝），但**目录形状与清单字段必须真的可解析**，否则用例测的不是判据。
 * @param appPath - `.app` 目录绝对路径。
 * @param options - 覆盖项（每个都是某个负向用例的构造手段）。
 */
export function writeBundledRuntimesFixture(
  appPath: string,
  options: BundledRuntimesFixtureOptions = {},
): void {
  const root = join(appPath, 'Contents', 'Resources', 'runtimes')
  mkdirSync(join(root, 'bin'), { recursive: true })
  if (options.omitManifest === true) return

  const commands: Readonly<Record<BundledRuntimeCommand, string>> = {
    node: 'node/bin/node',
    pnpm: 'pnpm/bin/pnpm.mjs',
    python3: 'python/bin/python3',
  }
  const declared = (Object.keys(commands) as BundledRuntimeCommand[])
    .slice(0, options.commandCount ?? 3)

  for (const [command, relative] of Object.entries(commands)) {
    if (command === options.omitEntry) continue
    const target = join(root, relative)
    mkdirSync(dirname(target), { recursive: true })
    if (options.entryKinds?.[command as BundledRuntimeCommand] === 'script') {
      writeFileSync(target, '#!/usr/bin/env node\n// 脚本入口（真载荷里 pnpm 就是这个形状）\n')
      chmodSync(target, 0o755)
    } else {
      writeFileSync(target, MACH_O_FIXTURE_MAGIC)
    }
  }

  for (const command of declared) {
    if (command === options.omitShim) continue
    const shim = join(root, 'bin', command)
    writeFileSync(shim, 'shim')
    chmodSync(shim, 0o755)
  }

  const manifest = {
    schema: options.schema ?? 1,
    target: 'darwin-arm64',
    platform: 'darwin',
    arch: 'arm64',
    versions: { ...MAC_BUNDLE_RUNTIME_VERSIONS, ...options.versions },
    commands: Object.fromEntries(declared.map(command => [command, commands[command]])),
    shims: declared.map(command => `bin/${command}`),
    tree: { files: 4, bytes: 4, digest: '0'.repeat(64) },
  }
  writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}
