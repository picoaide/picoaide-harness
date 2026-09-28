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
 * 111 927 459 B / 12 338 条目 / 14 个 unpacked 条目 / **0 个 link 条目**）：
 *
 * ```text
 * fileSize = dataStart + Σ(packed 条目 size)     // delta = 0，且 0 重叠、0 越界
 * dataStart = 8 + u32@4                          // header 区 = [0, dataStart)
 * header pickle = payload[0..4]=nested、payload[4..8]=jsonLen、json = payload[8..8+jsonLen]
 * sha256(json) === Info.plist 的 ElectronAsarIntegrity["Resources/app.asar"].hash
 * ```
 *
 * **符号链接条目（`{"link": "…"}`）不参与铺满等式**：`@electron/asar` 的
 * `Filesystem#insertLink` 只写 `link`（不写 `size`/`offset`），所以它们既不是"打包内容"
 * 也不是"损坏" —— 与 `unpacked` 同级，单独计数（{@link AsarLayoutSummary.linkEntries}）。
 * 2026-09-25 审计 B1-01：早先版本把它们当普通条目走 size/offset 校验，于是合法归档被报成
 * `entry <path> has an invalid size NaN`（把"判据未建模这种形态"说成"归档损坏"，排障方向
 * 被引到打包中断）。**当前真实产物 0 条**，所以那时不触发；形态一旦出现（某个依赖带进
 * 符号链接）就会同时红掉 afterPack / DMG 冒烟 / DMG 发布三条路径。
 *
 * **链接图必须可解**（2026-09-26 复审 B-4）：只把 `link` 排除出字节账并不等于判据收口 ——
 * `@electron/asar#createPackage` **自己就能产出**自指（`x → x`）与成环（`a → b → a`）的
 * 归档，而库的读侧 `getFile(path, followLinks: true)` 会递归解引用 ⇒ `RangeError: Maximum
 * call stack size exceeded`；绝对路径/越界目标的符号链接会被 asar 的 `resolveLink`
 * （`path.join(parentPath, symlink)` 再 `path.relative(src, …)`）**静默改写成包内不存在的
 * 相对目标**。这两类形态在当时的判据下**全绿**。现在 {@link assertAsarLayout} 会按
 * {@link AsarLinkEntry.link}（**归档根相对**路径）验证：目标不得为绝对路径/不得越出归档、
 * 必须命中归档内真实存在的条目或目录、且链接图不得有自指或环 —— 失败一律归类为
 * "**归档链接图不可解**"，而不是笼统的"归档损坏"。
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

/**
 * 一个归档条目（目录已展开）。
 *
 * 两种形态的字段集**不同**（用 `kind` 区分，而不是给 link 条目编一个假的 `size`）：
 * 只有普通文件条目才参与 size/offset 铺满等式。
 */
export type AsarEntry = AsarFileEntry | AsarLinkEntry

/** 打包进归档（或解包到 `app.asar.unpacked`）的普通文件条目。 */
export interface AsarFileEntry {
  /** 归档内 POSIX 路径。 */
  readonly path: string
  /** 条目形态判别。 */
  readonly kind: 'file'
  /** 声明的字节数。 */
  readonly size: number
  /** 相对数据区的偏移（unpacked 条目没有）。 */
  readonly offset: number | undefined
  /** 是否被解包到 `app.asar.unpacked`。 */
  readonly unpacked: boolean
}

/**
 * 符号链接条目（`@electron/asar` 的 `Filesystem#insertLink` 只写 `link`）。
 *
 * 它没有 `size`/`offset`：链接目标以文本形式记在头部，数据区里没有它的字节。
 */
export interface AsarLinkEntry {
  /** 归档内 POSIX 路径。 */
  readonly path: string
  /** 条目形态判别。 */
  readonly kind: 'link'
  /**
   * 链接目标 —— **归档根相对**路径（不是相对链接所在目录）。
   *
   * `@electron/asar` 的 `resolveLink()` 用 `path.relative(src, path.join(parentPath, symlink))`
   * 算它，读侧 `getFile(info.link, followLinks)` / `getNode(path.join(node.link, name))`
   * 也按归档根解析。绝对目标会被 `path.join` 静默"接"到链接所在目录之下，于是链接指向一个
   * 包内不存在的路径（{@link assertAsarLayout} 的链接图判据会拦下这种形态）。
   */
  readonly link: string
  /** 是否被解包到 `app.asar.unpacked`（链接指向包外时也置位）。 */
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
      // 符号链接条目：与 `unpacked` 同级的"不参与铺满等式"形态（见模块头注释）。
      // 只在这里分类，**不**给它编造 size/offset —— 编造出来的 NaN 会把合法归档
      // 报成"size 非法"（B1-01）。目标的可解性/无环性由 `assertAsarLinkGraph` 判（B-4）。
      const rawLink = record['link']
      if (rawLink !== undefined) {
        if (typeof rawLink !== 'string') {
          throw new Error(
            `mac-bundle-consistency: ${where} entry ${path} has a malformed link target ${JSON.stringify(rawLink)}`
            + '（`link` 必须是字符串；这不是"未建模的形态"，是头部损坏）',
          )
        }
        entries.push({
          path,
          kind: 'link',
          link: rawLink,
          unpacked: record['unpacked'] === true,
        })
        continue
      }
      const rawSize = record['size']
      const rawOffset = record['offset']
      entries.push({
        path,
        kind: 'file',
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

/**
 * 符号链接条目数（合法形态，**不参与**铺满等式：它没有 size/offset）。
 *
 * 单独计数的理由是让"这份归档里有链接、判据没有建模它的**字节账**"在日志里可见，
 * 而不是让它静默消失或变成一句"size 非法"。图面（目标存在性 / 自指 / 成环 / 越界）由
 * {@link assertAsarLayout} 的链接图判据负责，字节账仍然不建模 —— 三个调用点用
 * {@link asarLayoutLogLine} 把这一行打进日志（2026-09-26 复审 B-5：此前三个调用点
 * 都丢弃返回值，这条承诺只在测试里兑现）。
 */
export interface AsarLayoutSummary {
  /** 归档字节数。 */
  readonly archiveBytes: number
  /** 条目总数。 */
  readonly entries: number
  /** 打包进归档（非 unpacked）的条目数。 */
  readonly packedEntries: number
  /** 打包进归档的字节合计。 */
  readonly packedBytes: number
  /** 符号链接条目数（见接口说明）。 */
  readonly linkEntries: number
}

/**
 * 把一个链接目标解析成规范的归档根相对路径。
 *
 * asar 的 `link` 已经是归档根相对路径，这里只做规范化与越界判定：
 *   * 绝对路径（`/…`）⇒ 不可解：`@electron/asar` 的 `resolveLink()` 会把它 `path.join`
 *     到链接所在目录之下再取相对，于是头部里留下的是一个**永远不会被写出来**的目标；
 *   * `..` 走到根之上 ⇒ 不可解（库在写入期就拒收 `..`，但头部可以是手写/被改写的）；
 *   * 空目标 / 只剩 `.` ⇒ 不可解。
 * @param target - 头部里的 `link` 原文。
 * @returns 规范路径，或 undefined（不可解）。
 */
function resolveAsarLinkTarget(target: string): string | undefined {
  if (target === '' || target.startsWith('/') || target.startsWith('\\')) return undefined
  const segments: string[] = []
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (segments.length === 0) return undefined
      segments.pop()
      continue
    }
    segments.push(part)
  }
  return segments.length === 0 ? undefined : segments.join('/')
}

/**
 * 断言归档的**链接图**可解：目标在包内、命中真实条目或目录、且没有自指/环。
 *
 * 为什么必须单独判（2026-09-26 复审 B-4）：`@electron/asar#createPackage` 自己就能产出
 * 自指与成环的归档，而库的读侧 `getFile(path, followLinks: true)` 是递归解引用 ⇒
 * `RangeError: Maximum call stack size exceeded`；绝对/越界目标则被静默改写成包内不存在的
 * 相对路径。三类形态当时在布局判据下**全绿**。这里的失败文案一律点名"链接图不可解"
 * （不是"归档损坏"）—— 排障方向完全不同：前者是打包树的符号链接形态问题，后者是归档字节问题。
 * @param entries - 已展开的条目表。
 * @param where - 诊断用的来源描述。
 * @throws 目标不可解 / 悬空 / 自指 / 成环时抛错。
 */
function assertAsarLinkGraph(entries: readonly AsarEntry[], where: string): void {
  const present = new Set<string>()
  const links = new Map<string, string>()
  for (const entry of entries) {
    if (entry.kind === 'link') links.set(entry.path, entry.link)
    else present.add(entry.path)
    // 目录也算"存在"：链接可以指向目录（读侧 `getNode` 会拼上子名再解析）。
    for (let at = entry.path.indexOf('/'); at !== -1; at = entry.path.indexOf('/', at + 1)) {
      present.add(entry.path.slice(0, at))
    }
  }
  // 失败分类 = "归档链接图不可解"（不是"归档损坏"）：失败文案由这一处构造，避免四处漂移。
  const unresolvable = (path: string, detail: string): Error => new Error(
    `mac-bundle-consistency: ${where} entry ${path} ${detail} — the archive link graph is unresolvable `
    + '(asar writes such links as an in-package path that does not exist, and follows self-referential or '
    + 'cyclic links recursively until the reader overflows its stack)',
  )
  const resolved = new Map<string, string>()
  for (const [path, raw] of links) {
    const target = resolveAsarLinkTarget(raw)
    if (target === undefined) {
      throw unresolvable(path, `links to ${JSON.stringify(raw)}, which is absolute or escapes the archive root`)
    }
    if (target === path) throw unresolvable(path, `links to itself (${JSON.stringify(raw)})`)
    if (!present.has(target) && !links.has(target)) {
      throw unresolvable(path, `links to ${JSON.stringify(raw)} (= ${target}), which does not exist inside the archive`)
    }
    resolved.set(path, target)
  }
  for (const start of links.keys()) {
    const seen = new Set<string>([start])
    let cursor = resolved.get(start)
    while (cursor !== undefined) {
      if (cursor === start) throw unresolvable(start, `participates in a link cycle (${[...seen, cursor].join(' → ')})`)
      if (seen.has(cursor)) break
      seen.add(cursor)
      cursor = resolved.get(cursor)
    }
  }
}

/**
 * 把一次 asar 布局自检的结论写成一行可检索的日志。
 *
 * `linkEntries` 单独计数的理由就是让"这份归档里有链接、判据没有建模它的**字节账**"在
 * **日志里可见**；三个调用点（DMG 冒烟 / DMG 发布 / afterPack）此前都丢弃了
 * `assertMacBundleConsistency` 的返回值，于是那条承诺只在测试里兑现（2026-09-26 复审 B-5）。
 * 现在三处都把这行打出来，唯一实现留在这里（两处各写一份拼接就会漂移）。
 * @param where - 被检查的归档路径。
 * @param summary - {@link assertAsarLayout} 的结论。
 * @returns 单行正文（不含换行）。
 */
export function asarLayoutLogLine(where: string, summary: AsarLayoutSummary): string {
  return `mac bundle asar layout ${where}: ${String(summary.entries)} entries, `
    + `${String(summary.packedEntries)} packed (${String(summary.packedBytes)} B tiled), `
    + `${String(summary.linkEntries)} link, ${String(summary.archiveBytes)} B total`
}

/**
 * 断言 asar 的内部布局自洽：条目 offset/size 合法、区间不重叠、数据区恰好被铺满。
 *
 * 这三条合起来把「offset 表指向错误位置」逼到无处可藏：任何平移都会造成重叠或空隙，
 * 任何截断都会越界，任何 size 与实体不符都会破坏铺满等式。
 *
 * **符号链接条目（`kind === 'link'`）与 `unpacked` 条目都不进这三条等式**（前者的字节
 * 不在数据区里，后者在 `app.asar.unpacked` 里）—— 但它们仍然进 `entries` 总数，
 * 并由 {@link AsarLayoutSummary.linkEntries} 如实报出；链接条目的**图面**（目标存在性、
 * 自指、成环、绝对/越界目标）另由 {@link assertAsarLinkGraph} 判（B-4）。
 * @param archive - 整个 `app.asar` 的字节。
 * @param where - 诊断用的来源描述。
 * @returns 布局统计（供调用方用 {@link asarLayoutLogLine} 打日志）。
 */
export function assertAsarLayout(archive: Buffer, where: string): AsarLayoutSummary {
  const { entries, dataStart } = parseAsarHeader(archive, where)
  let packedBytes = 0
  let packedEntries = 0
  let linkEntries = 0
  const ranges: Array<{ readonly start: number, readonly end: number, readonly path: string }> = []
  for (const entry of entries) {
    if (entry.kind === 'link') {
      linkEntries += 1
      continue
    }
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
  // 布局自洽之后再看链接图：目标必须在包内命中、且不得自指/成环（B-4）。
  assertAsarLinkGraph(entries, where)
  return { archiveBytes: archive.length, entries: entries.length, packedEntries, packedBytes, linkEntries }
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

/**
 * 本次构建**声明**的产物身份（调用方从构建期真源算出来传进来）。
 *
 * 为什么必须由调用方传：本模块是纯读取判据，不该自己去猜"这次构建是哪个渠道"。
 * mac 侧的真源是 `scripts/channel-build.ts` 的 `packagedAppId()`
 * （随包 `build/channel.json` 的 `desktop.app_id`；官方构建回落官方默认值）。
 */
export interface MacBundleExpectations {
  /**
   * 期望的 `CFBundleIdentifier`（逐字相等）。
   *
   * 不传 = 不判身份（保持本判据上线时的行为）。传了就必须命中：macOS 上 bundle id 决定
   * LaunchServices 身份、SSO 回调注册与安装覆盖关系 —— 渠道包回落官方身份是已登记的
   * B-09 族出口（app origin / 数据根 / userData 都有判据，身份此前零判据）。
   */
  readonly expectedIdentifier?: string
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
 * @param expectations - 本次构建声明的期望值（见 {@link MacBundleExpectations}）。
 * @returns 结论摘要。
 * @throws 任一条不一致时抛错（错误文案点名包内路径与判据）。
 */
export function assertMacBundleConsistency(
  appPath: string,
  io: MacBundleFileSystem = NATIVE_FILE_SYSTEM,
  expectations: MacBundleExpectations = {},
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

  // 0) 产物身份：bundle id 必须逐字等于**本次构建声明的**应用 id。
  //    不判它的后果是"包看起来是对的、装上去才发现身份不对"：macOS 用 bundle id 做
  //    LaunchServices 身份、SSO 回调注册与安装覆盖，渠道包回落官方 id 就会与官方版
  //    互相覆盖/抢回调（B-09 族的第四条出口）。
  const expected = expectations.expectedIdentifier
  if (expected !== undefined && identifier !== expected) {
    throw new Error(
      `mac-bundle-consistency: ${infoPlistPath} declares ${MAC_BUNDLE_IDENTIFIER_KEY}=${identifier} but this build declares ${expected}`
      + ' — the packaged application would claim another identity (LaunchServices / SSO callback / install override)',
    )
  }

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
