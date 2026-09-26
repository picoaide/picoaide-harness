/**
 * `mac-bundle-consistency` 的回归判据。
 *
 * 这套用例的存在理由是：macOS 现场反馈「图标变成问号，然后打不开」时，现有门禁
 * （native 二进制、asar 条目存在性、codesign/spctl/stapler）**一条都咬不到**包内
 * 「图标键 ↔ .icns」与「asar offset 表自洽性」。这里逐条钉住：
 *
 * - 正向：真实 `@electron/asar` 产物 + 与库自读的头部摘要对拍（证明字节级解析与
 *   Electron/electron-builder 的算法一致，而不是自说自话）；
 * - 反向：图标缺失/空/非 icns、资产目录缺失、二进制 plist、可执行文件缺失/不可执行、
 *   `ElectronAsarIntegrity` 不一致、asar 截断/重叠/越界/未铺满/头部损坏。
 *
 * 变异验证（拆掉守卫必须红）见 `temp/mac-icon-question/`。
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPackageWithOptions, getRawHeader } from '@electron/asar'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertAsarLayout,
  assertMacBundleConsistency,
  asarHeaderDigest,
  parseAsarHeader,
  parseXmlPlist,
} from '../scripts/mac-bundle-consistency.ts'

const temporaryRoots: string[] = []
const PRODUCT = 'PicoAide Harness'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mac-bundle-'))
  temporaryRoots.push(root)
  return root
}

/** 只含 plist 少数标签的 XML 写入器（够用即可，写法与 electron-builder 的 plist 库同形）。 */
function xmlPlist(entries: ReadonlyArray<readonly [string, string]>): string {
  const body = entries
    .map(([key, value]) => `\t<key>${key}</key>\n\t<string>${value}</string>`)
    .join('\n')
  // DOCTYPE 省略 SYSTEM 标识（真实 plist 会带 Apple 的 DTD URL，但判据只需要能跳过 DOCTYPE）。
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`
}

function asarIntegrityBlock(appAsarHash: string): string {
  return `\t<key>ElectronAsarIntegrity</key>\n\t<dict>\n\t\t<key>Resources/app.asar</key>\n\t\t<dict>\n\t\t\t<key>algorithm</key>\n\t\t\t<string>SHA256</string>\n\t\t\t<key>hash</key>\n\t\t\t<string>${appAsarHash}</string>\n\t\t</dict>\n\t</dict>`
}

interface BundleFixture {
  readonly appPath: string
  readonly asarPath: string
  readonly iconPath: string
  readonly executablePath: string
  readonly infoPlistPath: string
  /** 归档头部摘要（= 写进 ElectronAsarIntegrity 的值）。 */
  readonly asarDigest: string
}

/** 造一个真实可读的 `.app`：真 asar（含一个 unpacked 条目）+ 真 icns 魔数 + 可执行位。 */
async function buildBundle(options: { readonly iconBytes?: Buffer, readonly patchPlist?: (text: string) => string } = {}): Promise<BundleFixture> {
  const root = temporaryRoot()
  const appPath = join(root, `${PRODUCT}.app`)
  const contents = join(appPath, 'Contents')
  const resources = join(contents, 'Resources')
  mkdirSync(resources, { recursive: true })
  mkdirSync(join(contents, 'MacOS'), { recursive: true })

  const source = join(root, 'app-source')
  mkdirSync(join(source, 'nested'), { recursive: true })
  mkdirSync(join(source, 'native'), { recursive: true })
  writeFileSync(join(source, 'a.txt'), 'a'.repeat(1000))
  writeFileSync(join(source, 'c.bin'), Buffer.alloc(3, 7))
  writeFileSync(join(source, 'nested', 'b.json'), JSON.stringify({ hello: 'world' }))
  writeFileSync(join(source, 'native', 'x.node'), Buffer.alloc(64, 1))
  const asarPath = join(resources, 'app.asar')
  await createPackageWithOptions(source, asarPath, { unpack: '**/*.node' })

  const iconPath = join(resources, 'icon.icns')
  writeFileSync(iconPath, options.iconBytes ?? Buffer.concat([Buffer.from('icns', 'latin1'), Buffer.alloc(64, 2)]))

  const executablePath = join(contents, 'MacOS', PRODUCT)
  writeFileSync(executablePath, 'binary')
  chmodSync(executablePath, 0o755)

  const digest = asarHeaderDigest(readFileSync(asarPath), asarPath)
  const infoPlistPath = join(contents, 'Info.plist')
  const text = xmlPlist([
    ['CFBundleIdentifier', 'ai.deepseek.dsh.desktop'],
    ['CFBundleExecutable', PRODUCT],
    ['CFBundleIconFile', 'icon.icns'],
    ['CFBundleName', PRODUCT],
  ]).replace('</dict>\n</plist>', `${asarIntegrityBlock(digest)}\n</dict>\n</plist>`)
  writeFileSync(infoPlistPath, options.patchPlist === undefined ? text : options.patchPlist(text))
  return { appPath, asarPath, iconPath, executablePath, infoPlistPath, asarDigest: digest }
}

/** 按实测布局手写一个 asar（用于制造真实打包器不会产出的损坏形态）。 */
function syntheticAsar(header: object, data: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const paddedLength = Math.ceil(json.length / 4) * 4
  const padded = Buffer.alloc(paddedLength)
  json.copy(padded)
  const nested = 4 + paddedLength
  const payloadSize = 4 + nested
  const head = Buffer.alloc(8)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(payloadSize, 4)
  const payload = Buffer.alloc(payloadSize)
  payload.writeUInt32LE(nested, 0)
  payload.writeUInt32LE(json.length, 4)
  padded.copy(payload, 8)
  return Buffer.concat([head, payload, data])
}

function entry(size: number, offset?: number, unpacked = false): Record<string, unknown> {
  return {
    size,
    ...(offset === undefined ? {} : { offset: String(offset) }),
    ...(unpacked ? { unpacked: true } : {}),
  }
}

describe('parseXmlPlist', () => {
  it('reads nested dicts, numbers and booleans', () => {
    const parsed = parseXmlPlist(
      '<?xml version="1.0"?>\n<plist version="1.0"><dict>'
      + '<key>Name</key><string>A &amp; B</string>'
      + '<key>Count</key><integer>7</integer>'
      + '<key>Flag</key><true/>'
      + '<key>Nested</key><dict><key>inner</key><string>x</string></dict>'
      + '<key>List</key><array><string>a</string><string>b</string></array>'
      + '</dict></plist>',
      'fixture',
    )
    expect(parsed).toEqual({
      Name: 'A & B',
      Count: 7,
      Flag: true,
      Nested: { inner: 'x' },
      List: ['a', 'b'],
    })
  })

  it('rejects a binary plist instead of returning an empty object', () => {
    expect(() => parseXmlPlist('bplist00\u0001\u0002', 'fixture')).toThrow(/no XML plist tags/u)
  })

  it('rejects an unterminated element', () => {
    expect(() => parseXmlPlist('<plist><dict><key>a</key><string>b</dict></plist>', 'fixture'))
      .toThrow(/unterminated <string>/u)
  })
})

describe('assertAsarLayout', () => {
  it('accepts a synthetic archive whose entries exactly tile the data region', () => {
    const data = Buffer.alloc(30, 9)
    const archive = syntheticAsar({ files: { 'a.txt': entry(10, 0), 'b.txt': entry(20, 10) } }, data)
    const summary = assertAsarLayout(archive, 'fixture')
    expect(summary).toMatchObject({ entries: 2, packedEntries: 2, packedBytes: 30 })
    expect(summary.archiveBytes).toBe(archive.length)
  })

  it('rejects a truncated archive', () => {
    const data = Buffer.alloc(30, 9)
    const archive = syntheticAsar({ files: { 'a.txt': entry(10, 0), 'b.txt': entry(20, 10) } }, data)
    const truncated = archive.subarray(0, archive.length - 5)
    expect(() => assertAsarLayout(truncated, 'fixture')).toThrow(/outside the/u)
  })

  it('rejects overlapping entries (offset table shifted)', () => {
    const data = Buffer.alloc(30, 9)
    const archive = syntheticAsar({ files: { 'a.txt': entry(10, 0), 'b.txt': entry(20, 5) } }, data)
    expect(() => assertAsarLayout(archive, 'fixture')).toThrow(/overlap/u)
  })

  it('rejects a gap between the header and the data region', () => {
    const data = Buffer.alloc(30, 9)
    const archive = syntheticAsar({ files: { 'a.txt': entry(10, 0), 'b.txt': entry(10, 15) } }, data)
    expect(() => assertAsarLayout(archive, 'fixture')).toThrow(/does not tile/u)
  })

  it('rejects a packed entry without an offset', () => {
    const data = Buffer.alloc(10, 9)
    const archive = syntheticAsar({ files: { 'a.txt': entry(10) } }, data)
    expect(() => assertAsarLayout(archive, 'fixture')).toThrow(/no usable offset/u)
  })

  it('rejects a broken header pickle', () => {
    const data = Buffer.alloc(10, 9)
    const archive = syntheticAsar({ files: { 'a.txt': entry(10, 0) } }, data)
    archive.writeUInt32LE(archive.readUInt32LE(8) + 4, 8)
    expect(() => assertAsarLayout(archive, 'fixture')).toThrow(/inconsistent header pickle/u)
  })

  it('skips unpacked entries when tiling the data region', () => {
    const data = Buffer.alloc(10, 9)
    const archive = syntheticAsar({ files: { 'a.txt': entry(10, 0), 'x.node': entry(64, undefined, true) } }, data)
    expect(assertAsarLayout(archive, 'fixture').packedEntries).toBe(1)
  })
})

describe('assertMacBundleConsistency', () => {
  it('accepts a real bundle and cross-checks the header digest against @electron/asar itself', async () => {
    const bundle = await buildBundle()
    const summary = assertMacBundleConsistency(bundle.appPath)
    expect(summary.identifier).toBe('ai.deepseek.dsh.desktop')
    expect(summary.icon).toBe('icon.icns')
    expect(summary.asar?.packedEntries).toBeGreaterThan(0)
    expect(summary.asarIntegrity).toBe(bundle.asarDigest)

    // 与库自读的头部字符串对拍：digest 必须等于 sha256(库读出的 JSON 字符串)，
    // 也就是 electron-builder 写进 ElectronAsarIntegrity 的那个值。
    const raw = getRawHeader(bundle.asarPath)
    const libraryDigest = createHash('sha256').update(raw.headerString).digest('hex')
    expect(bundle.asarDigest).toBe(libraryDigest)
    // 数据区起点 = 库报告的 headerSize + 8（头部 pickle 自身占 8 字节）。
    expect(parseAsarHeader(readFileSync(bundle.asarPath), bundle.asarPath).dataStart).toBe(raw.headerSize + 8)
  })

  it('rejects a missing .icns referenced by CFBundleIconFile', async () => {
    const bundle = await buildBundle()
    rmSync(bundle.iconPath)
    expect(() => assertMacBundleConsistency(bundle.appPath)).toThrow(/CFBundleIconFile=icon\.icns but .*icon\.icns does not exist/u)
  })

  it('rejects an empty .icns', async () => {
    const bundle = await buildBundle({ iconBytes: Buffer.alloc(0) })
    expect(() => assertMacBundleConsistency(bundle.appPath)).toThrow(/not a non-empty file/u)
  })

  it('rejects a payload that is not an icns container', async () => {
    const bundle = await buildBundle({ iconBytes: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(32)]) })
    expect(() => assertMacBundleConsistency(bundle.appPath)).toThrow(/icns magic/u)
  })

  it('rejects CFBundleIconName without an Assets.car', async () => {
    const bundle = await buildBundle({
      patchPlist: text => text.replace('<key>CFBundleName</key>', '<key>CFBundleIconName</key>\n\t<string>Icon</string>\n\t<key>CFBundleName</key>'),
    })
    expect(() => assertMacBundleConsistency(bundle.appPath)).toThrow(/Assets\.car/u)
  })

  it('rejects a bundle without CFBundleIconFile at all', async () => {
    const bundle = await buildBundle({
      patchPlist: text => text.replace('\t<key>CFBundleIconFile</key>\n\t<string>icon.icns</string>\n', ''),
    })
    expect(() => assertMacBundleConsistency(bundle.appPath)).toThrow(/no non-empty <CFBundleIconFile>/u)
  })

  it('rejects a binary Info.plist', async () => {
    const bundle = await buildBundle()
    writeFileSync(bundle.infoPlistPath, Buffer.from('bplist00\u0001\u0002\u0003', 'latin1'))
    expect(() => assertMacBundleConsistency(bundle.appPath)).toThrow(/no XML plist tags/u)
  })

  it('rejects a missing or non-executable main executable', async () => {
    const missing = await buildBundle()
    rmSync(missing.executablePath)
    expect(() => assertMacBundleConsistency(missing.appPath)).toThrow(/CFBundleExecutable=.*does not exist/u)

    const notExecutable = await buildBundle()
    chmodSync(notExecutable.executablePath, 0o644)
    expect(() => assertMacBundleConsistency(notExecutable.appPath)).toThrow(/is not executable/u)
  })

  it('rejects an archive rewritten after ElectronAsarIntegrity was recorded', async () => {
    const bundle = await buildBundle({
      patchPlist: text => text.replace(bundleHashPlaceholder(text), 'f'.repeat(64)),
    })
    expect(() => assertMacBundleConsistency(bundle.appPath)).toThrow(/does not match .*ElectronAsarIntegrity/u)
  })

  it('rejects a missing ElectronAsarIntegrity table', async () => {
    const bundle = await buildBundle({
      patchPlist: text => text.replace(/<key>ElectronAsarIntegrity<\/key>[\s\S]*?<\/dict>\n\t<\/dict>/u, ''),
    })
    expect(() => assertMacBundleConsistency(bundle.appPath)).toThrow(/has no ElectronAsarIntegrity table/u)
  })

  it('rejects a truncated app.asar', async () => {
    const bundle = await buildBundle()
    const bytes = readFileSync(bundle.asarPath)
    writeFileSync(bundle.asarPath, bytes.subarray(0, bytes.length - 8))
    expect(() => assertMacBundleConsistency(bundle.appPath)).toThrow(/outside the|does not tile/u)
  })

  it('requires the guard to be wired into the mac verification and afterPack paths', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const scripts = join(here, '..', 'scripts')
    // 判据必须钉**调用点**（带括号）而不是标识符：只 import 不调用时，
    // "文件里出现名字"式的存在性断言是假绿（2026-09-25 变异 m5 实测）。
    const call = /assertMacBundleConsistency\(/u
    for (const name of ['verify-mac-smoke.ts', 'verify-mac-release.ts', 'verify-packaged-runtime.ts']) {
      const path = join(scripts, name)
      expect(existsSync(path), `${name} must exist`).toBe(true)
      expect(readFileSync(path, 'utf8'), `${name} must call the mac bundle consistency guard`).toMatch(call)
    }
  })
})

/** 取出现有 ElectronAsarIntegrity 的 hash 值（用于把它改坏）。 */
function bundleHashPlaceholder(text: string): string {
  const match = /<key>hash<\/key>\n\t+<string>([0-9a-f]{64})<\/string>/u.exec(text)
  if (match?.[1] === undefined) throw new Error('fixture plist has no integrity hash')
  return match[1]
}
