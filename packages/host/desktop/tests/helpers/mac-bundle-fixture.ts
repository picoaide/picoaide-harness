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
import { join } from 'node:path'

/** 最小 asar 的字节与头部摘要。 */
export interface MinimalAsar {
  /** 归档字节。 */
  readonly bytes: Buffer
  /** 头部 JSON 的 SHA-256（= 写进 `ElectronAsarIntegrity` 的值）。 */
  readonly digest: string
}

/**
 * 造一份布局自洽的最小 asar（单个 `package.json` 条目）。
 * @param data - 归档内唯一文件的字节（缺省 `{}`）。
 * @returns 归档字节与头部摘要。
 */
export function minimalAsar(data: Buffer = Buffer.from('{}')): MinimalAsar {
  const json = Buffer.from(JSON.stringify({ files: { 'package.json': { size: data.length, offset: '0' } } }), 'utf8')
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
    + `\t<key>CFBundleIdentifier</key>\n\t<string>${options.identifier ?? 'ai.deepseek.dsh.desktop'}</string>\n`
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
