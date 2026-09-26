/**
 * macOS `.app` 包内一致性判据（宿主无关，可在 Linux 上跑）。
 *
 * 为什么需要它：2026-09 的现场反馈是「macOS 下很小概率：应用图标变成问号，然后打不开」。
 * 现有门禁覆盖了 native 二进制、asar 条目存在性、codesign/spctl/stapler（仅 mac），
 * 但**没有任何一条判据把 `Info.plist` 的图标键与磁盘上真实的 `.icns` 绑起来**，
 * 也没有一条判据检查 asar 的**内部布局**（条目 offset 表是否自洽）。两者都属于
 * 「包看起来是对的、双击之后才发现不对」的形态：
 *
 * - `CFBundleIconFile` 指向的 `.icns` 缺失/为空/不是 icns ⇒ Finder/Dock 只能回落到通用
 *   图标（用户口中的「问号/白图标」）；
 * - asar 条目 offset 表错乱 ⇒ Electron 打开任意一个 json 时报
 *   `Invalid package config …/xxx/package.json`（本项目登记过的本地偶发，未根因）；
 * - asar 在 `Info.plist` 写下 `ElectronAsarIntegrity` 之后被改写 ⇒ macOS 上 Electron
 *   的嵌入式 asar 完整性校验会直接拒绝启动（`header integrity doesn't match`）。
 *
 * 三条判据都是**纯读取**，不修改产物，因此可以安全地放在 `afterPack`（签名之前）与
 * mac 的 DMG 验证里。
 *
 * 不变量（在本机实测于真实产物 `dist/linux-unpacked/resources/app.asar`，
 * 111 927 459 B / 12 338 条目 / 14 个 unpacked 条目）：
 *
 * ```text
 * fileSize = dataStart + Σ(packed 条目 size)     // delta = 0，且 0 重叠、0 越界
 * dataStart = 8 + u32@4                          // header 区 = [0, dataStart)
 * header pickle = payload[0..4]=nested、payload[4..8]=jsonLen、json = payload[8..8+jsonLen]
 * sha256(json) === Info.plist 的 ElectronAsarIntegrity["Resources/app.asar"].hash
 * ```
 *
 * @module dsh-plugin-desktop/mac-bundle-consistency
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** `.app` 包内文件的最小 stat 投影。 */
export interface MacBundleFileStat {
  /** 是否为普通文件。 */
  isFile(): boolean
  /** 字节数。 */
  readonly size: number
  /** POSIX 权限位（用于判定可执行位）。 */
  readonly mode: number
}

/** 文件系统接缝（测试注入替身；生产用 `node:fs`）。 */
export interface MacBundleFileSystem {
  /** 路径是否存在。 */
  exists(path: string): boolean
  /** 读取整个文件。 */
  readFile(path: string): Buffer
  /** 读取文件元数据。 */
  stat(path: string): MacBundleFileStat
}

const NATIVE_FILE_SYSTEM: MacBundleFileSystem = {
  exists: path => existsSync(path),
  readFile: path => readFileSync(path),
  stat: path => statSync(path),
}

/** `Info.plist` 里必须存在的图标键。 */
export const MAC_BUNDLE_ICON_KEY = 'CFBundleIconFile'
/** `Info.plist` 里可能出现的资产目录图标名（Icon Composer 产物）。 */
export const MAC_BUNDLE_ICON_NAME_KEY = 'CFBundleIconName'
/** 主可执行文件的 plist 键。 */
export const MAC_BUNDLE_EXECUTABLE_KEY = 'CFBundleExecutable'
/** bundle id 的 plist 键（渠道包各不相同，是「同名多份 .app」排查的锚点）。 */
export const MAC_BUNDLE_IDENTIFIER_KEY = 'CFBundleIdentifier'
/** Electron 写入的 asar 完整性表所在的 plist 键。 */
export const MAC_ASAR_INTEGRITY_KEY = 'ElectronAsarIntegrity'
/** `ElectronAsarIntegrity` 里 app.asar 的归档内路径键（electron-builder 的写法）。 */
export const MAC_ASAR_INTEGRITY_ENTRY = 'Resources/app.asar'
/** `.icns` 的魔数。 */
export const ICNS_MAGIC = 'icns'

interface XmlToken {
  readonly kind: 'open' | 'close' | 'leaf'
  readonly name: string
  /** leaf 标签的文本内容（open/close 为空串）。 */
  readonly text: string
}

/** 非容器型（自闭合/文本型）plist 标签。 */
const PLIST_LEAF_TAGS: ReadonlySet<string> = new Set([
  'key', 'string', 'integer', 'real', 'date', 'data', 'true', 'false',
])

function unescapeXmlText(text: string): string {
  return text
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/gu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gu, '&')
}

/**
 * 把 XML plist 切成结构 token（跳过声明/注释/DOCTYPE）。
 *
 * 只认 plist 的标签集；出现未知标签即失败——`Info.plist` 是**二进制 plist** 或
 * 结构漂移时必须响亮地报错，而不是返回一个空对象让下游判据变成假绿。
 * @param text - plist 文本。
 * @param where - 诊断用的来源描述。
 * @returns token 列表。
 */
function tokenizeXmlPlist(text: string, where: string): XmlToken[] {
  const tokens: XmlToken[] = []
  const pattern = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/([A-Za-z][\w.-]*)\s*>|<([A-Za-z][\w.-]*)(\/?)>/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const closeName = match[1]
    const openName = match[2]
    if (closeName !== undefined) {
      tokens.push({ kind: 'close', name: closeName, text: '' })
      continue
    }
    if (openName === undefined) continue
    if (match[3] === '/') {
      // <true/>、<false/> 这类自闭合 leaf
      tokens.push({ kind: 'leaf', name: openName, text: '' })
      continue
    }
    if (!PLIST_LEAF_TAGS.has(openName)) {
      tokens.push({ kind: 'open', name: openName, text: '' })
      continue
    }
    // 文本型 leaf：内容在开标签与闭合标签之间，闭合标签必须一并吃掉，
    // 否则它会在解析器里变成悬空的 </string>。
    const contentStart = match.index + match[0].length
    const closeTag = `</${openName}>`
    const closeAt = text.indexOf(closeTag, contentStart)
    if (closeAt === -1) {
      throw new Error(`mac-bundle-consistency: ${where} has an unterminated <${openName}> element`)
    }
    tokens.push({ kind: 'leaf', name: openName, text: unescapeXmlText(text.slice(contentStart, closeAt).trim()) })
    pattern.lastIndex = closeAt + closeTag.length
  }
  if (tokens.length === 0) {
    throw new Error(
      `mac-bundle-consistency: ${where} has no XML plist tags — a binary plist or a non-plist file cannot be checked`,
    )
  }
  return tokens
}

/**
 * 解析 XML plist 为 JS 值（只支持 plist 的标签集）。
 * @param text - plist 文本。
 * @param where - 诊断用的来源描述。
 * @returns 顶层 plist 对象。
 * @throws 结构漂移（二进制 plist、未知标签、悬空闭合）时抛错。
 */
export function parseXmlPlist(text: string, where: string): Record<string, unknown> {
  const tokens = tokenizeXmlPlist(text, where)
  let index = 0

  const parseValue = (): unknown => {
    const token = tokens[index]
    if (token === undefined) {
      throw new Error(`mac-bundle-consistency: ${where} ended before its plist value was complete`)
    }
    index += 1
    if (token.kind === 'close') {
      throw new Error(`mac-bundle-consistency: ${where} has an unexpected closing tag </${token.name}>`)
    }
    switch (token.name) {
      case 'dict': {
        const result: Record<string, unknown> = {}
        for (;;) {
          const key = tokens[index]
          if (key === undefined) {
            throw new Error(`mac-bundle-consistency: ${where} has an unterminated <dict>`)
          }
          if (key.kind === 'close' && key.name === 'dict') {
            index += 1
            return result
          }
          if (key.kind !== 'leaf' || key.name !== 'key') {
            throw new Error(`mac-bundle-consistency: ${where} expects <key> inside <dict>, saw <${key.name}>`)
          }
          index += 1
          result[key.text] = parseValue()
        }
      }
      case 'array': {
        const result: unknown[] = []
        for (;;) {
          const next = tokens[index]
          if (next === undefined) {
            throw new Error(`mac-bundle-consistency: ${where} has an unterminated <array>`)
          }
          if (next.kind === 'close' && next.name === 'array') {
            index += 1
            return result
          }
          result.push(parseValue())
        }
      }
      case 'string':
      case 'key':
      case 'date':
      case 'data':
        return token.text
      case 'integer':
      case 'real':
        return Number(token.text)
      case 'true':
        return true
      case 'false':
        return false
      default:
        throw new Error(`mac-bundle-consistency: ${where} contains an unsupported plist tag <${token.name}>`)
    }
  }

  const root = parseValue()
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new Error(`mac-bundle-consistency: ${where} does not contain a plist <dict> root`)
  }
  return root as Record<string, unknown>
}

/** asar 头部解析结果。 */
export interface AsarHeaderLayout {
  /** 头部 JSON 的原始字节（Electron 与 electron-builder 计算哈希的那一段）。 */
  readonly json: Buffer
  /** 文件数据区起点 = `8 + u32@4`。 */
  readonly dataStart: number
  /** 归档内全部文件条目（含 unpacked）。 */
  readonly entries: readonly AsarEntry[]
}

/** 一个归档条目（目录已展开）。 */
export interface AsarEntry {
  /** 归档内 POSIX 路径。 */
  readonly path: string
  /** 声明的字节数。 */
  readonly size: number
  /** 相对数据区的偏移（unpacked 条目没有）。 */
  readonly offset: number | undefined
  /** 是否被解包到 `app.asar.unpacked`。 */
  readonly unpacked: boolean
}

/**
 * 读取 asar 头部的数值字段。
 *
 * `size` 在头部是数字，而 `offset` 是**十进制字符串**（`@electron/asar` 的写法，
 * 实测于真实产物）；两种形态都接受，其余一律 NaN —— 由调用方按"非法"处理。
 * @param value - 头部字段的原始值。
 * @returns 数值，或 NaN。
 */
function numericField(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^\d+$/u.test(value)) return Number(value)
  return Number.NaN
}

/**
 * 解析 asar 头部（与 `@electron/asar` 的 `readAsarHeader` 逐字节等价）。
 *
 * 布局：`[u32=4][u32 payloadSize][u32 nestedSize][u32 jsonLen][json][padding]`，
 * 数据区从 `8 + payloadSize` 开始。任何一步不自洽都抛错——这正是要抓的
 * 「entry offset 错乱」形态。
 * @param archive - 整个 `app.asar` 的字节。
 * @param where - 诊断用的来源描述。
 * @returns 头部 JSON、数据区起点与条目表。
 */
export function parseAsarHeader(archive: Buffer, where: string): AsarHeaderLayout {
  if (archive.length < 16) {
    throw new Error(`mac-bundle-consistency: ${where} is too small to be an asar archive (${String(archive.length)} B)`)
  }
  const payloadSize = archive.readUInt32LE(4)
  if (payloadSize <= 8 || 8 + payloadSize > archive.length) {
    throw new Error(
      `mac-bundle-consistency: ${where} declares a ${String(payloadSize)} B header in a ${String(archive.length)} B file`,
    )
  }
  const payload = archive.subarray(8, 8 + payloadSize)
  const nestedSize = payload.readUInt32LE(0)
  if (nestedSize + 4 !== payloadSize) {
    throw new Error(
      `mac-bundle-consistency: ${where} has an inconsistent header pickle (nested ${String(nestedSize)} + 4 ≠ ${String(payloadSize)})`,
    )
  }
  const jsonLength = payload.readUInt32LE(4)
  if (jsonLength <= 0 || 8 + jsonLength > payloadSize) {
    throw new Error(
      `mac-bundle-consistency: ${where} declares a ${String(jsonLength)} B header JSON inside a ${String(payloadSize)} B header`,
    )
  }
  const json = payload.subarray(8, 8 + jsonLength)
  let parsed: unknown
  try {
    parsed = JSON.parse(json.toString('utf8'))
  } catch (cause) {
    throw new Error(
      `mac-bundle-consistency: ${where} header is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`mac-bundle-consistency: ${where} header JSON is not an object`)
  }
  const entries: AsarEntry[] = []
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    const files = node['files']
    if (typeof files !== 'object' || files === null) return
    for (const [name, child] of Object.entries(files as Record<string, unknown>)) {
      if (typeof child !== 'object' || child === null) continue
      const record = child as Record<string, unknown>
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (record['files'] !== undefined) {
        walk(record, path)
        continue
      }
      const rawSize = record['size']
      const rawOffset = record['offset']
      entries.push({
        path,
        size: numericField(rawSize),
        offset: numericField(rawOffset),
        unpacked: record['unpacked'] === true,
      })
    }
  }
  walk(parsed as Record<string, unknown>, '')
  if (entries.length === 0) {
    throw new Error(`mac-bundle-consistency: ${where} lists no files`)
  }
  return { json, dataStart: 8 + payloadSize, entries }
}

/**
 * asar 头部 JSON 的 SHA-256 —— 与 Electron 的 `ElectronAsarIntegrity` /
 * electron-builder 的 `hashHeader()` 同一算法（已在本机对真实产物逐字节对拍）。
 * @param archive - 整个 `app.asar` 的字节。
 * @param where - 诊断用的来源描述。
 * @returns 十六进制摘要。
 */
export function asarHeaderDigest(archive: Buffer, where: string): string {
  return createHash('sha256').update(parseAsarHeader(archive, where).json).digest('hex')
}

/** asar 布局自检结论。 */
export interface AsarLayoutSummary {
  /** 归档字节数。 */
  readonly archiveBytes: number
  /** 条目总数。 */
  readonly entries: number
  /** 打包进归档（非 unpacked）的条目数。 */
  readonly packedEntries: number
  /** 打包进归档的字节合计。 */
  readonly packedBytes: number
}

/**
 * 断言 asar 的内部布局自洽：条目 offset/size 合法、区间不重叠、数据区恰好被铺满。
 *
 * 这三条合起来把「offset 表指向错误位置」逼到无处可藏：任何平移都会造成重叠或空隙，
 * 任何截断都会越界，任何 size 与实体不符都会破坏铺满等式。
 * @param archive - 整个 `app.asar` 的字节。
 * @param where - 诊断用的来源描述。
 * @returns 布局统计（供调用方打日志）。
 */
export function assertAsarLayout(archive: Buffer, where: string): AsarLayoutSummary {
  const { entries, dataStart } = parseAsarHeader(archive, where)
  let packedBytes = 0
  let packedEntries = 0
  const ranges: Array<{ readonly start: number, readonly end: number, readonly path: string }> = []
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`mac-bundle-consistency: ${where} entry ${entry.path} has an invalid size ${String(entry.size)}`)
    }
    if (entry.unpacked) continue
    if (entry.offset === undefined || !Number.isSafeInteger(entry.offset) || entry.offset < 0) {
      throw new Error(
        `mac-bundle-consistency: ${where} entry ${entry.path} is packed but has no usable offset (${String(entry.offset)})`,
      )
    }
    packedEntries += 1
    packedBytes += entry.size
    const start = dataStart + entry.offset
    const end = start + entry.size
    if (start < dataStart || end > archive.length) {
      throw new Error(
        `mac-bundle-consistency: ${where} entry ${entry.path} spans ${String(start)}..${String(end)} outside the ${String(archive.length)} B archive`,
      )
    }
    ranges.push({ start, end, path: entry.path })
  }
  ranges.sort((left, right) => left.start - right.start)
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1]!
    const current = ranges[index]!
    if (current.start < previous.end) {
      throw new Error(
        `mac-bundle-consistency: ${where} entries overlap: ${previous.path} ends at ${String(previous.end)} but ${current.path} starts at ${String(current.start)}`,
      )
    }
  }
  const tiled = dataStart + packedBytes
  if (tiled !== archive.length) {
    throw new Error(
      `mac-bundle-consistency: ${where} does not tile its data region: header ends at ${String(dataStart)} + ${String(packedBytes)} B of entries = ${String(tiled)}, archive is ${String(archive.length)} B (delta ${String(archive.length - tiled)})`,
    )
  }
  return { archiveBytes: archive.length, entries: entries.length, packedEntries, packedBytes }
}

/** 一致性检查结论（供调用方打日志）。 */
export interface MacBundleSummary {
  /** `CFBundleIdentifier`。 */
  readonly identifier: string
  /** 实际存在的图标文件名。 */
  readonly icon: string
  /** 图标字节数。 */
  readonly iconBytes: number
  /** 主可执行文件名。 */
  readonly executable: string
  /** `app.asar` 的布局统计（没有 asar 时为 undefined）。 */
  readonly asar: AsarLayoutSummary | undefined
  /** `ElectronAsarIntegrity` 里记录的 app.asar 头部摘要（有 asar 时必有）。 */
  readonly asarIntegrity: string
}

function stringField(plist: Record<string, unknown>, key: string, where: string): string {
  const value = plist[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`mac-bundle-consistency: ${where} has no non-empty <${key}>`)
  }
  return value.trim()
}

/** 读取嵌套字典（`ElectronAsarIntegrity` → `Resources/app.asar`）。 */
function nestedRecord(value: unknown, key: string, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`mac-bundle-consistency: ${where} is not a plist <dict>`)
  }
  const nested = (value as Record<string, unknown>)[key]
  if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) {
    throw new Error(`mac-bundle-consistency: ${where} has no <dict> entry for ${key}`)
  }
  return nested as Record<string, unknown>
}

/**
 * 断言一个 macOS `.app` 包的内部一致性：图标键 ↔ 真实 `.icns`、主可执行文件、
 * 以及（存在时）`app.asar` 的布局与 `ElectronAsarIntegrity` 指纹。
 * @param appPath - `.app` 包目录的绝对路径。
 * @param io - 文件系统接缝（缺省 `node:fs`）。
 * @returns 结论摘要。
 * @throws 任一条不一致时抛错（错误文案点名包内路径与判据）。
 */
export function assertMacBundleConsistency(
  appPath: string,
  io: MacBundleFileSystem = NATIVE_FILE_SYSTEM,
): MacBundleSummary {
  const contents = join(appPath, 'Contents')
  const resources = join(contents, 'Resources')
  const infoPlistPath = join(contents, 'Info.plist')
  if (!io.exists(infoPlistPath)) {
    throw new Error(`mac-bundle-consistency: ${appPath} has no Contents/Info.plist`)
  }
  const plist = parseXmlPlist(io.readFile(infoPlistPath).toString('utf8'), infoPlistPath)

  const identifier = stringField(plist, MAC_BUNDLE_IDENTIFIER_KEY, infoPlistPath)
  const iconName = stringField(plist, MAC_BUNDLE_ICON_KEY, infoPlistPath)
  const executableName = stringField(plist, MAC_BUNDLE_EXECUTABLE_KEY, infoPlistPath)

  // 1) 图标：键必须指向包内真实存在、非空、且以 icns 魔数开头的文件。
  //    缺这一条时 Finder/Dock 只能回落通用图标（「图标变成问号」的第一形态）。
  const iconPath = join(resources, iconName)
  if (!io.exists(iconPath)) {
    throw new Error(
      `mac-bundle-consistency: ${infoPlistPath} declares ${MAC_BUNDLE_ICON_KEY}=${iconName} but ${iconPath} does not exist`,
    )
  }
  const iconStat = io.stat(iconPath)
  if (!iconStat.isFile() || iconStat.size <= 0) {
    throw new Error(`mac-bundle-consistency: ${iconPath} is not a non-empty file`)
  }
  const iconBytes = io.readFile(iconPath)
  if (iconBytes.subarray(0, ICNS_MAGIC.length).toString('latin1') !== ICNS_MAGIC) {
    throw new Error(
      `mac-bundle-consistency: ${iconPath} does not start with the ${ICNS_MAGIC} magic (got ${JSON.stringify(iconBytes.subarray(0, 4).toString('latin1'))})`,
    )
  }

  // 2) Icon Composer（Assets.car）路径：声明了 CFBundleIconName 就必须有资产目录。
  const assetCatalogName = plist[MAC_BUNDLE_ICON_NAME_KEY]
  if (typeof assetCatalogName === 'string' && assetCatalogName.trim() !== '') {
    const catalogPath = join(resources, 'Assets.car')
    if (!io.exists(catalogPath) || io.stat(catalogPath).size <= 0) {
      throw new Error(
        `mac-bundle-consistency: ${infoPlistPath} declares ${MAC_BUNDLE_ICON_NAME_KEY}=${assetCatalogName} but ${catalogPath} is missing or empty`,
      )
    }
  }

  // 3) 主可执行文件：plist 名 ↔ Contents/MacOS 下真实文件 + 可执行位。
  const executablePath = join(contents, 'MacOS', executableName)
  if (!io.exists(executablePath)) {
    throw new Error(
      `mac-bundle-consistency: ${infoPlistPath} declares ${MAC_BUNDLE_EXECUTABLE_KEY}=${executableName} but ${executablePath} does not exist`,
    )
  }
  const executableStat = io.stat(executablePath)
  if (!executableStat.isFile() || executableStat.size <= 0) {
    throw new Error(`mac-bundle-consistency: ${executablePath} is not a non-empty file`)
  }
  if ((executableStat.mode & 0o111) === 0) {
    throw new Error(`mac-bundle-consistency: ${executablePath} is not executable (mode 0o${executableStat.mode.toString(8)})`)
  }

  // 4) app.asar：布局自检 + 与 Info.plist 里 ElectronAsarIntegrity 的头部摘要对拍。
  //    macOS 上 Electron 会用后者做嵌入式完整性校验：asar 被改写而 plist 未同步
  //    ⇒ 启动即被拒（"header integrity doesn't match"），这正是「打不开」的第二形态。
  const asarPath = join(resources, 'app.asar')
  let asar: AsarLayoutSummary | undefined
  let asarIntegrity = ''
  if (io.exists(asarPath)) {
    const archive = io.readFile(asarPath)
    asar = assertAsarLayout(archive, asarPath)
    if (plist[MAC_ASAR_INTEGRITY_KEY] === undefined) {
      throw new Error(
        `mac-bundle-consistency: ${infoPlistPath} has no ${MAC_ASAR_INTEGRITY_KEY} table for ${MAC_ASAR_INTEGRITY_ENTRY} — `
        + 'a macOS build without it loses the startup integrity check that catches an app.asar rewritten after packing',
      )
    }
    const expected = nestedRecord(plist[MAC_ASAR_INTEGRITY_KEY], MAC_ASAR_INTEGRITY_ENTRY, `${infoPlistPath} ${MAC_ASAR_INTEGRITY_KEY}`)
    const algorithm = expected['algorithm']
    const hash = expected['hash']
    if (algorithm !== 'SHA256' || typeof hash !== 'string' || !/^[0-9a-f]{64}$/iu.test(hash)) {
      throw new Error(
        `mac-bundle-consistency: ${infoPlistPath} ${MAC_ASAR_INTEGRITY_KEY}[${MAC_ASAR_INTEGRITY_ENTRY}] is not a SHA-256 record (${JSON.stringify({ algorithm, hash })})`,
      )
    }
    asarIntegrity = asarHeaderDigest(archive, asarPath)
    if (asarIntegrity !== hash.toLowerCase()) {
      throw new Error(
        `mac-bundle-consistency: ${asarPath} header digest ${asarIntegrity} does not match ${infoPlistPath} ${MAC_ASAR_INTEGRITY_KEY}[${MAC_ASAR_INTEGRITY_ENTRY}].hash ${hash.toLowerCase()} — the archive was rewritten after the integrity table was recorded`,
      )
    }
  }

  return {
    identifier,
    icon: iconName,
    iconBytes: iconStat.size,
    executable: executableName,
    asar,
    asarIntegrity,
  }
}
