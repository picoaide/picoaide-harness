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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPackageWithOptions, getRawHeader } from '@electron/asar'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import {
  asarLayoutLogLine,
  assertAsarLayout,
  assertMacBundleConsistency,
  asarHeaderDigest,
  parseAsarHeader,
  parseXmlPlist,
} from '../scripts/mac-bundle-consistency.ts'
import { writeValidMacBundle } from './helpers/mac-bundle-fixture.ts'

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

  // ── 符号链接条目（B1-01）───────────────────────────────────────────────────────
  // `@electron/asar` 的 `Filesystem#insertLink` 只写 `{"link": "…"}`（可选 `unpacked`），
  // **不写 `size`/`offset`**（`insertFile` 才写）。它们不在数据区里，所以既不进 ranges
  // 也不进铺满等式 —— 与 unpacked 同级。早先版本把它们当普通条目走 size 校验，
  // 于是合法归档被报成 `entry <path> has an invalid size NaN`（把"判据未建模"说成"归档损坏"）。
  it('accepts a legal link entry and keeps it out of the tiling equation', () => {
    const data = Buffer.alloc(10, 9)
    const archive = syntheticAsar({ files: { 'a.txt': entry(10, 0), link: { link: 'a.txt' } } }, data)
    const summary = assertAsarLayout(archive, 'fixture')
    expect(summary).toMatchObject({ entries: 2, packedEntries: 1, packedBytes: 10, linkEntries: 1 })
  })

  it('accepts a link entry that @electron/asar also marked unpacked', () => {
    const data = Buffer.alloc(10, 9)
    const archive = syntheticAsar({ files: { 'a.txt': entry(10, 0), link: { link: 'a.txt', unpacked: true } } }, data)
    expect(assertAsarLayout(archive, 'fixture').linkEntries).toBe(1)
  })

  it('still rejects a real corruption (declared size does not match the data region) next to a link', () => {
    // 反向对照：同样的 link 条目在场，但普通条目的 size 与实体不符 ⇒ 必须仍红。
    // 没有这条对照，"放过 link"可能变成"放过一切"。两个方向各一条：
    //  · 声明比实体**小** ⇒ 数据区没被铺满（does not tile）；
    //  · 声明比实体**大** ⇒ 条目越出归档（outside the archive）。
    const small = syntheticAsar({ files: { 'a.txt': entry(9, 0), link: { link: 'a.txt' } } }, Buffer.alloc(10, 9))
    expect(() => assertAsarLayout(small, 'fixture')).toThrow(/does not tile/u)
    const large = syntheticAsar({ files: { 'a.txt': entry(11, 0), link: { link: 'a.txt' } } }, Buffer.alloc(10, 9))
    expect(() => assertAsarLayout(large, 'fixture')).toThrow(/outside the/u)
  })

  it('rejects a malformed link target as corrupt (not as an unmodelled form)', () => {
    const data = Buffer.alloc(10, 9)
    const archive = syntheticAsar({ files: { 'a.txt': entry(10, 0), link: { link: 7 } } }, data)
    expect(() => assertAsarLayout(archive, 'fixture')).toThrow(/malformed link target/u)
  })

  // ── 链接图（B-4）──────────────────────────────────────────────────────────────
  // 只把 link 排除出字节账并不等于判据收口：`@electron/asar#createPackage` **自己就能产出**
  // 自指（x→x）与成环（a→b→a）的归档，而库的读侧 `getFile(path, followLinks: true)` 是
  // 递归解引用 ⇒ `RangeError: Maximum call stack size exceeded`；绝对/越界目标会被
  // `resolveLink()`（`path.join(parentPath, symlink)` 再 `path.relative(src, …)`）静默改写成
  // 包内不存在的相对目标。三类形态当时在布局判据下**全绿**。
  // 失败分类必须是"归档链接图不可解"（打包树里的符号链接形态问题），不是"归档损坏"。
  it('接受可解的链接链（link → file、link → link → file）', () => {
    const data = Buffer.alloc(4, 7)
    const chain = syntheticAsar(
      { files: { 'a.txt': entry(4, 0), one: { link: 'a.txt' }, two: { link: 'one' } } },
      data,
    )
    expect(assertAsarLayout(chain, 'fixture')).toMatchObject({ packedEntries: 1, linkEntries: 2 })
    // 指向**目录**也合法（读侧 `getNode` 会拼上子名再解析）。
    const toDirectory = syntheticAsar(
      { files: { dir: { files: { 'a.txt': entry(4, 0) } }, link: { link: 'dir' } } },
      data,
    )
    expect(assertAsarLayout(toDirectory, 'fixture').linkEntries).toBe(1)
  })

  it('自指链接（x → x）判为链接图不可解', () => {
    const data = Buffer.alloc(4, 7)
    const archive = syntheticAsar({ files: { 'a.txt': entry(4, 0), x: { link: 'x' } } }, data)
    expect(() => assertAsarLayout(archive, 'fixture')).toThrow(/links to itself/u)
    expect(() => assertAsarLayout(archive, 'fixture')).toThrow(/link graph is unresolvable/u)
  })

  it('成环链接（a → b → a）判为链接图不可解', () => {
    const data = Buffer.alloc(4, 7)
    const archive = syntheticAsar({ files: { 'a.txt': entry(4, 0), a: { link: 'b' }, b: { link: 'a' } } }, data)
    expect(() => assertAsarLayout(archive, 'fixture')).toThrow(/link cycle/u)
    expect(() => assertAsarLayout(archive, 'fixture')).toThrow(/link graph is unresolvable/u)
  })

  it('绝对目标与越界（`..`）目标判为链接图不可解', () => {
    const data = Buffer.alloc(4, 7)
    const absolute = syntheticAsar({ files: { 'a.txt': entry(4, 0), x: { link: '/etc/hostname' } } }, data)
    expect(() => assertAsarLayout(absolute, 'fixture')).toThrow(/absolute or escapes the archive root/u)
    const escaping = syntheticAsar({ files: { 'a.txt': entry(4, 0), x: { link: '../outside' } } }, data)
    expect(() => assertAsarLayout(escaping, 'fixture')).toThrow(/absolute or escapes the archive root/u)
  })

  it('目标在包内不存在时判为链接图不可解（asar 对绝对目标的实际改写形态）', () => {
    // 真机形态：源树里的 `/etc/hostname` 被 `resolveLink()` 改写成 `etc/hostname` 之类
    // **包内不存在**的相对目标 —— 头部看起来完全合法（不是绝对路径、不越界），读侧却永远
    // 找不到目标。这是 B-4 里"绝对路径指向包外、判据也绿"的那一条。
    const data = Buffer.alloc(4, 7)
    const archive = syntheticAsar({ files: { 'a.txt': entry(4, 0), x: { link: 'etc/hostname' } } }, data)
    expect(() => assertAsarLayout(archive, 'fixture')).toThrow(/does not exist inside the archive/u)
    expect(() => assertAsarLayout(archive, 'fixture')).toThrow(/link graph is unresolvable/u)
  })

  it('真 asar 打包器产出的自指/成环归档被拦下（判据与现实形态一致）', async () => {
    // 关键前提（V5 实测）：`createPackageWithOptions` **真的**能产出这两种归档，
    // 所以"不可能出现"不是不建模的理由。
    const root = temporaryRoot();
    for (const [name, links] of [['self', ['x']], ['cycle', ['a', 'b']]] as const) {
      const source = join(root, name)
      mkdirSync(source, { recursive: true })
      writeFileSync(join(source, 'a.txt'), 'a')
      if (links.length === 1) symlinkSync('x', join(source, 'x'))
      else {
        symlinkSync('b', join(source, 'a'))
        symlinkSync('a', join(source, 'b'))
      }
      const asarPath = join(root, `${name}.asar`)
      await createPackageWithOptions(source, asarPath, {})
      const archive = readFileSync(asarPath)
      // 打包成功（形态确实存在），而判据必须红。
      expect(() => assertAsarLayout(archive, asarPath)).toThrow(/link graph is unresolvable/u)
      expect(parseAsarHeader(archive, asarPath).entries.some(entry => entry.kind === 'link')).toBe(true)
    }
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

  // ── 产物身份（B1-02）───────────────────────────────────────────────────────────
  // macOS 上 bundle id 决定 LaunchServices 身份、SSO 回调注册与安装覆盖关系。此前这条判据
  // 只把 `CFBundleIdentifier` 解析进摘要、从不断言 ⇒ 渠道包回落/错配官方身份（B-09 族）
  // 在 mac 产物上零判据。
  it('accepts the declared identity and rejects any other one', async () => {
    const bundle = await buildBundle()

    // 命中：同一份包，期望值取自"本次构建声明"。
    expect(
      assertMacBundleConsistency(bundle.appPath, undefined, { expectedIdentifier: 'ai.deepseek.dsh.desktop' }).identifier,
    ).toBe('ai.deepseek.dsh.desktop')

    // 不传期望值 = 不判身份（上线时行为，避免调用方漏传就变假红）。
    expect(assertMacBundleConsistency(bundle.appPath).identifier).toBe('ai.deepseek.dsh.desktop')

    // 不命中：包声称的身份与本次构建声明的身份不同 ⇒ 必须红，且文案点出两个值。
    expect(() => assertMacBundleConsistency(bundle.appPath, undefined, {
      expectedIdentifier: 'com.example-vendor.harness',
    })).toThrow(
      /declares CFBundleIdentifier=ai\.deepseek\.dsh\.desktop but this build declares com\.example-vendor\.harness/u,
    )
  })

  it('含 link 条目的归档在 bundle 级通过（B1-01 的端到端形态）', () => {
    const header = { files: { 'a.txt': { size: 4, offset: '0' }, link: { link: 'a.txt' } } }
    const appPath = join(temporaryRoot(), 'Linked.app')
    writeValidMacBundle(appPath, PRODUCT, {
      asar: { bytes: syntheticAsar(header, Buffer.from('data')), digest: headerDigest(header) },
    })
    expect(assertMacBundleConsistency(appPath).asar).toMatchObject({ entries: 2, packedEntries: 1, linkEntries: 1 })
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

  it('三处调用点都必须把本次构建声明的身份传进判据（注释掉/换字面量即红）', () => {
    // 为什么是 AST 而不是 `toContain`：文本判据对"注释掉调用"与"换个字面量"两个方向都失效
    // （本仓 tests/profile-context-wiring.spec.ts 的模块头记录过同形事故）。这里直接找
    // `assertMacBundleConsistency(...)` 调用节点，并要求第 3 个实参里的 `expectedIdentifier`
    // 取到**本次构建声明的身份**。
    //
    // 2026-09-26 复审 B-3 修订：两条 mac 验证脚本的取值从内联 `packagedAppId()` 改成
    // **注入项** `options.expectedIdentifier`（缺省仍由 `defaultOptions()` 喂
    // `packagedAppId()`）—— 内联时这条判据不可注入，单测只能去读工作树里那份 gitignored 的
    // `build/channel.json`，一次渠道构建残留就让 mac 单测红 4 条且被说成"产物声称了另一个
    // 身份"。afterPack 那一处没有"单测注入"的问题（它的 context 由 electron-builder 给），
    // 继续直读 `packagedAppId()`。
    const here = dirname(fileURLToPath(import.meta.url))
    const expectedPerFile: Record<string, string> = {
      'verify-mac-smoke.ts': 'options.expectedIdentifier',
      'verify-mac-release.ts': 'options.expectedIdentifier',
      'verify-packaged-runtime.ts': 'packagedAppId()',
    }
    for (const [name, expression] of Object.entries(expectedPerFile)) {
      const source = readFileSync(join(here, '..', 'scripts', name), 'utf8')
      const expected = findExpectedIdentifierCalls(source, name)
      expect(expected, `${name} 必须恰好有一处 assertMacBundleConsistency 调用`).toHaveLength(1)
      expect(expected[0]?.factory, `${name} 必须传 { expectedIdentifier: ${expression} } —— 否则产物身份零判据（B1-02/B-3）`)
        .toBe(expression)
    }
    // 两条 mac 脚本的**缺省值**仍必须走 `packagedAppId()`（生产行为逐字不变）。
    for (const name of ['verify-mac-smoke.ts', 'verify-mac-release.ts']) {
      const source = readFileSync(join(here, '..', 'scripts', name), 'utf8')
      expect(source, `${name} 的缺省身份必须来自 packagedAppId()`).toContain('expectedIdentifier: packagedAppId(),')
    }

    // 自检：判据本身要能区分"注释掉"与"语义等价的换行"。
    const canonical = "assertMacBundleConsistency(appPath, undefined, { expectedIdentifier: packagedAppId() })\n"
    expect(findExpectedIdentifierCalls(canonical, 'x.ts')).toHaveLength(1)
    expect(findExpectedIdentifierCalls(canonical, 'x.ts')[0]?.factory).toBe('packagedAppId()')
    expect(findExpectedIdentifierCalls(
      "assertMacBundleConsistency(appPath, undefined, { expectedIdentifier: options.expectedIdentifier })\n",
      'x.ts',
    )[0]?.factory).toBe('options.expectedIdentifier')
    expect(findExpectedIdentifierCalls(`// ${canonical}`, 'x.ts')).toEqual([])
    expect(findExpectedIdentifierCalls("assertMacBundleConsistency(appPath)\n", 'x.ts'))
      .toEqual([{ factory: undefined }])
    expect(findExpectedIdentifierCalls(
      "assertMacBundleConsistency(\n  appPath,\n  undefined,\n  { expectedIdentifier: packagedAppId() },\n)\n",
      'x.ts',
    )).toHaveLength(1)
  })

  it('把 asar 布局摘要写成一行（链接条目数在日志里可见的理由，B-5）', () => {
    // `linkEntries` 单独计数的**唯一**理由是让"这份归档里有链接、判据没有建模它的字节账"
    // 在日志里可见；三个调用点曾经都丢弃返回值 ⇒ 那条承诺只在测试里兑现。
    // 这里钉住那行日志的内容（三个调用点各自"真的打了这行"由各自的 spec 断言）。
    const data = Buffer.alloc(4, 7)
    const archive = syntheticAsar(
      { files: { 'a.txt': entry(4, 0), link: { link: 'a.txt' } } },
      data,
    )
    const summary = assertAsarLayout(archive, '/tmp/app.asar')
    const line = asarLayoutLogLine('/tmp/app.asar', summary)
    expect(line).toContain('/tmp/app.asar')
    expect(line).toContain('2 entries')
    expect(line).toContain('1 packed')
    expect(line).toContain('1 link')
    expect(line.split('\n')).toHaveLength(1)
  })
})

/** 头部 JSON 的摘要（= 写进 `ElectronAsarIntegrity` 的值）。 */
function headerDigest(header: object): string {
  return createHash('sha256').update(JSON.stringify(header)).digest('hex')
}

/**
 * 每个 `assertMacBundleConsistency(...)` 调用点里 `expectedIdentifier` 的**取值表达式**。
 *
 * 在语法树上找（注释不是节点 ⇒ 注释掉的调用"不存在"；换行/折行不改变 AST ⇒ 等价改写仍能找到）。
 * @param source - TypeScript 源码。
 * @param fileName - 诊断与 ScriptKind 判定用。
 * @returns 每个调用点的取值表达式文本（没传/传了别的形态时为 undefined）。
 */
function findExpectedIdentifierCalls(source: string, fileName: string): Array<{ factory: string | undefined }> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const found: Array<{ factory: string | undefined }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'assertMacBundleConsistency') {
      let factory: string | undefined
      for (const argument of node.arguments) {
        if (!ts.isObjectLiteralExpression(argument)) continue
        for (const property of argument.properties) {
          if (!ts.isPropertyAssignment(property)) continue
          if (!ts.isIdentifier(property.name) || property.name.text !== 'expectedIdentifier') continue
          // 取值形态两种：调用（`packagedAppId()`）与点号访问（`options.expectedIdentifier`）。
          // 两者都用**源码文本**回报（注入项的引入见 B-3），字面量仍然回报 undefined。
          const initializer = property.initializer
          if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression)) {
            factory = `${initializer.expression.text}()`
          } else if (ts.isPropertyAccessExpression(initializer) && ts.isIdentifier(initializer.expression)) {
            factory = `${initializer.expression.text}.${initializer.name.text}`
          }
        }
      }
      found.push({ factory })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** 取出现有 ElectronAsarIntegrity 的 hash 值（用于把它改坏）。 */
function bundleHashPlaceholder(text: string): string {
  const match = /<key>hash<\/key>\n\t+<string>([0-9a-f]{64})<\/string>/u.exec(text)
  if (match?.[1] === undefined) throw new Error('fixture plist has no integrity hash')
  return match[1]
}
