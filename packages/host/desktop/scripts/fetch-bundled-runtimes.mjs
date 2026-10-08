/**
 * 就位**随客户端的 agent 运行时载荷**（node + pnpm + python），供 agent 的 shell / MCP
 * 子进程直接使用，并让 `plugin_manager` 的包操作（`install_bundle` 等）真的能跑。
 *
 * 为什么有这一步（2026-10-08 产品决策）：桌面客户端此前**故意不带包管理器**
 * （随包无 pnpm、`ProfileContext.packageManager` 不提供），于是上游文档里的
 * "把能力打成 bundle 再 install" 这条作者化路径在客户端上必然 `ENOENT`；而 agent
 * 写代码/跑脚本时也常常需要 node 与 python。现在把三套**官方预编译**运行时随包分发：
 * 打包前就位到 `build/runtimes/`，electron-builder 用 `extraResources` 带进产物
 * （不进 asar，可执行），客户端启动时把 `<resources>/runtimes/bin` 前置到 PATH
 * （见 `src/bundled-runtimes.ts`）。
 *
 * **钉死的真源是 `runtimes.json`**：版本、制品名、字节数与 sha256（node 来自官方
 * `SHASUMS256.txt`，python 来自 GitHub release 的 digest，pnpm 另有 npm registry 的
 * SRI）。本脚本只按它下载与校验，不另抄一份数字；换版本改那一个文件。
 *
 * 用法：
 *   node scripts/fetch-bundled-runtimes.mjs [--out <dir>] [--cache <dir>] [--target <t>] [--check]
 *                                           [--node-origin <u>] [--python-origin <u>] [--pnpm-origin <u>]
 *     --out     目标目录，缺省 `packages/host/desktop/build/runtimes`
 *     --cache   制品缓存目录，缺省 `packages/host/desktop/build/runtimes-cache`
 *               （环境变量 `PICOAI_RUNTIME_CACHE` 可覆盖；CI 指向 actions/cache 的路径）
 *     --target  目标平台，缺省 `<process.platform>-<process.arch>`；必须是 runtimes.json
 *               的 `targets` 之一（未知目标 fail-loud，不猜）
 *     --check   只校验（不联网、不下载）：清单齐、树摘要对、关键可执行文件哈希对
 *     --*-origin  只换 scheme+host 的镜像源（路径沿用钉死的那条；摘要不变 ⇒ 镜像换不了内容）
 * 退出码：0 = 就绪；1 = 失败（下载/校验/解包/裁剪出错）；2 = 用法错误。
 *
 * 幂等：目标目录里已有一份**树摘要匹配**的载荷时不重新下载；制品缓存在
 * `build/runtimes-cache/`（**不能**放进 `build/runtimes/`，否则会被 extraResources 打进产物）。
 *
 * @module dsh-plugin-desktop/scripts/fetch-bundled-runtimes
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import AdmZip from 'adm-zip'
import { isDirectInvocation } from './direct-invocation.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..')
/** 钉死清单（版本/制品/字节/哈希的唯一真源）。 */
export const RUNTIME_PIN_FILE = join(PACKAGE_ROOT, 'runtimes.json')
/** 缺省目标目录（electron-builder 的 buildResources 下，随包分发）。 */
export const DEFAULT_RUNTIME_OUT = join(PACKAGE_ROOT, 'build', 'runtimes')
/** 下载缓存目录（**载荷目录之外**：放进去会被 extraResources 打进产物）。 */
export const DEFAULT_RUNTIME_CACHE = join(PACKAGE_ROOT, 'build', 'runtimes-cache')
/** 载荷清单文件名（客户端解析端与 afterPack 门禁都读它）。 */
export const RUNTIME_MANIFEST_FILE = 'manifest.json'
/** shim 目录名（PATH 只前置这一个目录）。 */
export const RUNTIME_SHIM_DIR = 'bin'
/** 载荷内每个运行时的目录名。 */
export const RUNTIME_DIRS = { node: 'node', pnpm: 'pnpm', python: 'python' }
/** shim 命令名（PATH 上的命令面固定，避免各处拼写漂移）。 */
export const RUNTIME_SHIM_COMMANDS = ['node', 'npm', 'npx', 'pnpm', 'python', 'python3', 'pip3']
/** tar 块大小。 */
const TAR_BLOCK = 512

/** 解包中间文件的序号（与 pid 一起构成唯一名，见 {@link extractTarGz}）。 */
let tarSequence = 0

/** 取下一个解包中间文件序号。 */
function nextTarSequence() {
  tarSequence += 1
  return tarSequence
}

/** 读钉死清单并做形状校验（读不懂就 fail-loud，绝不"跳过某个运行时"）。 */
export function readRuntimePin(pinFile = RUNTIME_PIN_FILE) {
  const pin = JSON.parse(readFileSync(pinFile, 'utf8'))
  if (pin?.schema !== 1) throw new Error(`${pinFile}: unsupported schema ${String(pin?.schema)}`)
  if (!Array.isArray(pin.targets) || pin.targets.length === 0) {
    throw new Error(`${pinFile}: targets must be a non-empty list`)
  }
  for (const key of Object.keys(RUNTIME_DIRS)) {
    const runtime = pin[key]
    if (runtime === undefined || typeof runtime !== 'object') throw new Error(`${pinFile}: missing runtime "${key}"`)
    if (typeof runtime.version !== 'string' || runtime.version === '') {
      throw new Error(`${pinFile}: ${key}.version is required`)
    }
    if (typeof runtime.base !== 'string') throw new Error(`${pinFile}: ${key}.base is required`)
    if (!Array.isArray(runtime.prune)) throw new Error(`${pinFile}: ${key}.prune must be a list`)
    for (const target of pin.targets) {
      const artifact = runtime.targets?.[target]
      if (artifact === undefined) throw new Error(`${pinFile}: ${key} has no artifact for target ${target}`)
      if (typeof artifact.asset !== 'string' || typeof artifact.bytes !== 'number' || typeof artifact.sha256 !== 'string') {
        throw new Error(`${pinFile}: ${key}.targets.${target} needs asset/bytes/sha256`)
      }
    }
  }
  if (typeof pin.pnpm.entry !== 'string') throw new Error(`${pinFile}: pnpm.entry is required`)
  // 体积预算（2026-10-08）：每个目标都必须有上限，**缺一条即拒** —— 否则"新加一个目标"
  // 或"升级运行时"可以绕过体积门禁（门禁只在有预算时才判 = 结构上可被静默关掉）。
  for (const target of pin.targets) {
    const budget = pin.budget?.targets?.[target]
    if (budget === undefined) throw new Error(`${pinFile}: budget.targets.${target} is required（新增目标必须显式给出体积上限）`)
    for (const field of ['bytes', 'files']) {
      const value = budget[field]
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${pinFile}: budget.targets.${target}.${field} must be a positive integer`)
      }
    }
  }
  return pin
}

/**
 * 取某个目标的载荷体积上限。
 * @param pin - 已校验的钉死清单。
 * @param target - 目标平台键。
 * @returns 该目标的 bytes/files 上限。
 */
export function runtimeBudget(pin, target) {
  const budget = pin?.budget?.targets?.[target]
  if (budget === undefined) throw new Error(`runtimes.json: 目标 ${target} 没有体积预算`)
  return budget
}

/**
 * Node 平台名 → 载荷键里的平台段。
 *
 * `process.platform` 在 Windows 上是 `win32`，而载荷键（`runtimes.json` 的 targets、
 * 发布清单的资产键、artifact 名）一律用 `win`。**这一条规则必须处处一致**：
 * 打包期（本脚本）与运行期（`src/bundled-runtimes.ts` 的 `bundledRuntimeTarget`）
 * 各有一处实现，两侧由 `tests/bundled-runtimes.spec.ts` 的矩阵用例对拍 —— 不一致的
 * 后果是 Windows 客户端的随包运行时被静默忽略（清单 target 对不上 ⇒ 当作没有运行时）。
 * @param platform - Node 平台名。
 * @returns 载荷键的平台段（`win32` → `win`，其余原样）。
 */
export function normalizeRuntimePlatform(platform) {
  return platform === 'win32' ? 'win' : platform
}

/**
 * 目标平台键（未知目标 fail-loud：宁可不产出，也不产出跑不起来的载荷）。
 *
 * 平台段先过 {@link normalizeRuntimePlatform}：不归一的话 Windows runner 上的默认目标
 * 算成 `win32-x64` ⇒ 声明表里没有 ⇒ 打包当场 fail-loud
 * （2026-10-08 CI 实测：`不支持的目标平台 win32-x64（runtimes.json 只声明了
 * linux-x64, darwin-arm64, win-x64）` —— Windows job 一分半即红，整条发布链卡在这里）。
 * @param platform - Node 平台名（缺省 `process.platform`）。
 * @param arch - 架构（缺省 `process.arch`）。
 * @param pin - 已校验的钉死清单。
 * @returns 载荷键，例如 `linux-x64` / `darwin-arm64` / `win-x64`。
 */
export function resolveRuntimeTarget(platform = process.platform, arch = process.arch, pin = readRuntimePin()) {
  const target = `${normalizeRuntimePlatform(platform)}-${arch}`
  if (!pin.targets.includes(target)) {
    throw new Error(`不支持的目标平台 ${target}（runtimes.json 只声明了 ${pin.targets.join(', ')}）`)
  }
  return target
}

/** 流式算一个文件的摘要（避免把 50MB 制品整个读进内存）。 */
async function hashFile(path, algorithm, encoding) {
  const digest = createHash(algorithm)
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest(encoding)
}

/** 校验一份制品：字节数 + sha256（+ 可选的 npm SRI）。 */
export async function verifyArtifact(path, artifact, integrity) {
  if (!existsSync(path)) return false
  if (statSync(path).size !== artifact.bytes) return false
  if (await hashFile(path, 'sha256', 'hex') !== artifact.sha256) return false
  if (integrity !== undefined) {
    const [algorithm, expected] = integrity.split('-', 2)
    if (algorithm !== 'sha512') throw new Error(`不支持的 SRI 算法 ${algorithm}`)
    if (await hashFile(path, 'sha512', 'base64') !== expected) return false
  }
  return true
}

/** 下载一个制品到 `destination`（`.part` → 校验 → 原子 rename）。 */
async function downloadArtifact(url, destination, artifact, integrity) {
  mkdirSync(dirname(destination), { recursive: true })
  const partial = `${destination}.${process.pid}.part`
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    throw new Error(`${url} → HTTP ${response.status}`)
  }
  try {
    await pipeline(response.body, createWriteStream(partial, { mode: 0o600 }))
    if (!await verifyArtifact(partial, artifact, integrity)) {
      throw new Error(`${url} 下载得到的制品与 runtimes.json 钉死的 bytes/sha256 不符`)
    }
    renameSync(partial, destination)
  } catch (error) {
    rmSync(partial, { force: true })
    throw error
  }
}

/** 把归档条目名变成载荷内相对路径（拒绝绝对路径与 `..`；按 `strip` 去前缀）。 */
function archiveEntryPath(raw, override, strip) {
  const value = override ?? raw
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw new Error(`归档条目是绝对路径：${value}`)
  const parts = value.split('/').filter(part => part !== '' && part !== '.')
  if (parts.some(part => part === '..')) throw new Error(`归档条目想逃出根目录：${value}`)
  return parts.slice(strip).join('/')
}

/** 读 pax 扩展头的 `path=` / `linkpath=`（长度前缀行格式）。 */
function parsePax(body) {
  const result = {}
  let offset = 0
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset)
    if (space < 0) break
    const length = Number(body.subarray(offset, space).toString('utf8'))
    if (!Number.isFinite(length) || length <= 0) break
    const record = body.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) result[record.slice(0, equals)] = record.slice(equals + 1)
    offset += length
  }
  return result
}

/** 符号链接目标必须在载荷根内（tar 里合法形态都是相对的）。 */
function assertLinkInsideRoot(root, entryPath, linkPath) {
  if (linkPath.startsWith('/') || /^[A-Za-z]:/.test(linkPath)) {
    throw new Error(`符号链接指向绝对路径：${entryPath} → ${linkPath}`)
  }
  const target = resolve(dirname(join(root, entryPath)), linkPath)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (target !== root && !target.startsWith(prefix)) {
    throw new Error(`符号链接想逃出载荷根：${entryPath} → ${linkPath}`)
  }
}

/**
 * 从一个 tar.gz 制品解包到 `destDir`（strip 前缀；类型白名单；符号链接留在载荷内）。
 *
 * 中间 `.tar` 用**唯一名字**（pid + 序号）：制品落在共享缓存目录里，两个并发调用
 * （例如并行跑的单测、或同机两次打包）用同一个中间文件时，后一个的清理会把前一个
 * 正在读的文件删掉，症状是 `ENOENT ... .tar`（本轮实测到）。
 * @param archive - 制品路径。
 * @param destDir - 目标目录（必须已存在）。
 * @param strip - 去掉的前导路径段数。
 */
export async function extractTarGz(archive, destDir, strip) {
  const tarFile = `${archive}.${String(process.pid)}.${String(nextTarSequence())}.tar`
  try {
    await pipeline(createReadStream(archive), createGunzip(), createWriteStream(tarFile, { mode: 0o600 }))
    const fd = openSync(tarFile, 'r')
    try {
      const block = Buffer.alloc(TAR_BLOCK)
      const hardLinks = []
      let pax
      for (;;) {
        if (readSync(fd, block, 0, TAR_BLOCK, -1) !== TAR_BLOCK) break
        if (block.every(byte => byte === 0)) break
        const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/su, '')
        const mode = Number.parseInt(block.subarray(100, 108).toString('utf8').replace(/\0.*$/su, '').trim() || '0', 8)
        const size = Number.parseInt(block.subarray(124, 136).toString('utf8').replace(/\0.*$/su, '').trim() || '0', 8)
        const type = String.fromCharCode(block[156] === 0 ? 0x30 : block[156])
        const linkName = block.subarray(157, 257).toString('utf8').replace(/\0.*$/su, '')
        const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/su, '')
        const body = Buffer.alloc(size)
        let filled = 0
        while (filled < size) {
          const got = readSync(fd, body, filled, size - filled, -1)
          if (got <= 0) throw new Error(`tar 在 ${name} 处被截断`)
          filled += got
        }
        const padding = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK - size
        if (padding > 0) {
          const scratch = Buffer.alloc(padding)
          if (readSync(fd, scratch, 0, padding, -1) !== padding) throw new Error('tar 尾部被截断')
        }
        if (type === 'x' || type === 'g') { pax = parsePax(body); continue }
        if (type === 'L') { pax = { ...(pax ?? {}), path: body.toString('utf8').replace(/\0.*$/su, '') }; continue }
        if (type === 'K') { pax = { ...(pax ?? {}), linkpath: body.toString('utf8').replace(/\0.*$/su, '') }; continue }
        const headerPath = prefix === '' ? name : `${prefix}/${name}`
        const entryPath = archiveEntryPath(headerPath, pax?.path, strip)
        const entryLink = pax?.linkpath ?? linkName
        pax = undefined
        if (entryPath === '') continue
        const destination = join(destDir, entryPath)
        if (type === '5') { mkdirSync(destination, { recursive: true, mode: 0o755 }); continue }
        if (type === '0' || type === '\0') {
          mkdirSync(dirname(destination), { recursive: true })
          writeFileSync(destination, body, { mode: (mode & 0o777) || 0o644 })
          continue
        }
        if (type === '2') {
          mkdirSync(dirname(destination), { recursive: true })
          assertLinkInsideRoot(destDir, entryPath, entryLink)
          rmSync(destination, { force: true })
          symlinkSync(entryLink, destination)
          continue
        }
        if (type === '1') { hardLinks.push({ entryPath, entryLink }); continue }
        // 设备/管道等类型绝不落盘：载荷里出现即视为制品异常。
        throw new Error(`tar 条目 ${entryPath} 的类型 ${type} 不受支持`)
      }
      for (const { entryPath, entryLink } of hardLinks) {
        const destination = join(destDir, entryPath)
        const source = join(destDir, archiveEntryPath(entryLink, undefined, strip))
        mkdirSync(dirname(destination), { recursive: true })
        if (!existsSync(source)) throw new Error(`硬链接目标缺失：${entryPath} → ${entryLink}`)
        rmSync(destination, { force: true })
        linkSync(source, destination)
      }
    } finally {
      closeSync(fd)
    }
  } finally {
    rmSync(tarFile, { force: true })
  }
}

/** 从一个 zip 制品解包到 `destDir`（strip 前缀；拒绝逃逸路径）。 */
export function extractZip(archive, destDir, strip) {
  for (const entry of new AdmZip(archive).getEntries()) {
    const entryPath = archiveEntryPath(entry.entryName, undefined, strip)
    if (entryPath === '') continue
    const destination = join(destDir, entryPath)
    if (entry.isDirectory) { mkdirSync(destination, { recursive: true, mode: 0o755 }); continue }
    mkdirSync(dirname(destination), { recursive: true })
    // zip 不携带 POSIX 模式；Windows 侧的 node 制品只需要可读可执行（`node.exe` 无 +x 语义）。
    writeFileSync(destination, entry.getData(), { mode: 0o755 })
  }
}

/** 按钉死清单裁剪载荷（缺项不算错：不同平台制品的内容本来就不完全一致）。 */
export function pruneRuntime(root, list, warn = console.warn) {
  for (const relativePath of list) {
    const target = join(root, relativePath)
    if (!existsSync(target)) continue
    rmSync(target, { recursive: true, force: true })
    warn(`fetch-bundled-runtimes: 已裁剪 ${relativePath}`)
  }
}

/**
 * 打包器**按名字跳过**的文件（`builder-util/out/fs.js:68`：`.DS_Store` 与 `.gitkeep`）。
 *
 * 它们留在载荷里只会制造"树摘要 vs 产物"的假不一致：`extraResources` 拷贝时被跳过，
 * afterPack 门禁于是判"拷贝截断"（本机 Linux 打包实测：pnpm 里的
 * `dist/node_modules/undici/lib/llhttp/.gitkeep` 就是唯一被丢的那一个文件）。
 * 这些文件对运行时没有任何作用（占位符/桌面元数据），所以**在载荷里删掉**是正解 ——
 * 反过来"让门禁容忍少文件"会同时放过真正的截断。
 */
export const PACKAGER_SKIPPED_NAMES = ['.DS_Store', '.gitkeep']

/**
 * 递归删掉打包器会跳过的文件。
 * @param root - 载荷根目录。
 * @param log - 日志出口。
 * @returns 删除的相对路径（相对 `root`）。
 */
export function prunePackagerSkippedNames(root, log = console.log) {
  const removed = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!PACKAGER_SKIPPED_NAMES.includes(entry.name)) continue
      rmSync(path, { force: true })
      removed.push(relative(root, path).split(sep).join('/'))
    }
  }
  walk(root)
  for (const path of removed) log(`fetch-bundled-runtimes: 已删除打包器会跳过的文件 ${path}`)
  return removed
}

/**
 * 载荷树的元信息：文件数、总字节、`(相对路径, 大小)` 列表的 sha256。
 *
 * 大小取 `lstatSync`（符号链接算它自己的几字节，**不跟随**）——跟随会把
 * `bin/node`/`bin/python3` 这类链接的目标再算一遍，摘要里就会出现"同一个二进制两份"。
 * @param root - 载荷根目录。
 * @param exclude - 不参与统计的绝对路径（清单自己：它记录摘要，不能被计入摘要）。
 * @returns 树摘要。
 */
export function runtimeTreeDigest(root, exclude = []) {
  const skipped = new Set(exclude.map(path => resolve(path)))
  const lines = []
  let files = 0
  let bytes = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(dir, entry.name)
      if (skipped.has(resolve(path))) continue
      if (entry.isDirectory()) { walk(path); continue }
      // 打包器按名字跳过的文件不计入摘要（它们本来就不会出现在产物里，见
      // PACKAGER_SKIPPED_NAMES）：两边用同一条规则，摘要才等于"实际随包的那棵树"。
      if (PACKAGER_SKIPPED_NAMES.includes(entry.name)) continue
      const size = lstatSync(path).size
      files += 1
      bytes += size
      lines.push(`${relative(root, path).split(sep).join('/')}\0${String(size)}\n`)
    }
  }
  walk(root)
  lines.sort()
  return { files, bytes, digest: createHash('sha256').update(lines.join('')).digest('hex') }
}

/** 一个 shim 的文件名与内容（POSIX shell 脚本 / Windows cmd；与载荷布局同源）。 */
function shim(command, target, pin) {
  const posix = target.startsWith('linux-') || target.startsWith('darwin-')
  const node = pin.node.commands
  const python = pin.python.commands
  const nodeBin = posix ? node.posix.node : node.win.node
  const npmBin = posix ? node.posix.npm : node.win.npm
  const npxBin = posix ? node.posix.npx : node.win.npx
  const pythonBin = posix ? python.posix.python : python.win.python
  const header = '# 由 scripts/fetch-bundled-runtimes.mjs 生成（随包运行时）。'
  if (posix) {
    const root = '$(cd "$(dirname "$0")" && pwd)/..'
    const invocations = {
      node: `exec "${root}/${RUNTIME_DIRS.node}/${nodeBin}" "$@"`,
      npm: `exec "${root}/${RUNTIME_DIRS.node}/${nodeBin}" "${root}/${RUNTIME_DIRS.node}/${npmBin}" "$@"`,
      npx: `exec "${root}/${RUNTIME_DIRS.node}/${nodeBin}" "${root}/${RUNTIME_DIRS.node}/${npxBin}" "$@"`,
      pnpm: `exec "${root}/${RUNTIME_DIRS.node}/${nodeBin}" "${root}/${RUNTIME_DIRS.pnpm}/${pin.pnpm.entry}" "$@"`,
      python: `exec "${root}/${RUNTIME_DIRS.python}/${pythonBin}" "$@"`,
      python3: `exec "${root}/${RUNTIME_DIRS.python}/${pythonBin}" "$@"`,
      pip3: `exec "${root}/${RUNTIME_DIRS.python}/${pythonBin}" -m pip "$@"`,
    }
    return { file: command, body: `#!/bin/sh\n${header}\n${invocations[command]}\n` }
  }
  const root = '%~dp0..'
  const invocations = {
    node: `"${root}\\${RUNTIME_DIRS.node}\\${nodeBin}" %*`,
    npm: `"${root}\\${RUNTIME_DIRS.node}\\${nodeBin}" "${root}\\${RUNTIME_DIRS.node}\\${npmBin}" %*`,
    npx: `"${root}\\${RUNTIME_DIRS.node}\\${nodeBin}" "${root}\\${RUNTIME_DIRS.node}\\${npxBin}" %*`,
    pnpm: `"${root}\\${RUNTIME_DIRS.node}\\${nodeBin}" "${root}\\${RUNTIME_DIRS.pnpm}\\${pin.pnpm.entry}" %*`,
    python: `"${root}\\${RUNTIME_DIRS.python}\\${pythonBin}" %*`,
    python3: `"${root}\\${RUNTIME_DIRS.python}\\${pythonBin}" %*`,
    pip3: `"${root}\\${RUNTIME_DIRS.python}\\${pythonBin}" -m pip %*`,
  }
  return { file: `${command}.cmd`, body: `@echo off\r\nrem ${header.slice(1)}\r\n${invocations[command]}\r\n` }
}

/** 写出全部 shim；返回相对载荷根的路径（供清单记录）。 */
export function writeRuntimeShims(out, target, pin) {
  const binDir = join(out, RUNTIME_SHIM_DIR)
  rmSync(binDir, { recursive: true, force: true })
  mkdirSync(binDir, { recursive: true, mode: 0o755 })
  const written = []
  for (const command of RUNTIME_SHIM_COMMANDS) {
    const { file, body } = shim(command, target, pin)
    const path = join(binDir, file)
    writeFileSync(path, body, { mode: 0o755 })
    chmodSync(path, 0o755)
    written.push(`${RUNTIME_SHIM_DIR}/${file}`)
  }
  return written
}

/**
 * 每个运行时里**必须随包**的许可文本（相对载荷根；任一找不到即 fail-loud）。
 *
 * 合规口径（2026-10-08）：三套运行时都是第三方制品，再分发必须带上它们自己的许可文本。
 * 路径逐平台不同（CPython 的 `LICENSE.txt` 在 POSIX 上是
 * `lib/python<X.Y>/LICENSE.txt`，Windows 上在安装根），所以按候选表找、找不到就拒 —— 
 * "悄悄少一份许可"比"打包失败"糟得多。真实文本不进本仓，由载荷携带。
 * @param key - 运行时键。
 * @param target - 目标平台键。
 * @returns 候选相对路径（按优先级）。
 */
export function runtimeLicenseCandidates(key, target) {
  if (key === 'node') return ['LICENSE', 'LICENSE.md']
  if (key === 'pnpm') return ['LICENSE', 'LICENSE.md']
  // CPython：Windows 在根，POSIX 在 lib/python<X.Y>/ 下；版本段不写死，用通配在解析时展开。
  return target.startsWith('win-') ? ['LICENSE.txt'] : ['lib/python*/LICENSE.txt', 'LICENSE.txt']
}

/**
 * 在运行时目录里解析许可文本；找不到返回 undefined。
 *
 * 支持**一层** `*` 且通配符落在**目录名的末尾**（`lib/python<X.Y>/LICENSE.txt` 的
 * 版本段不写死）：把通配符之前的路径拆成"父目录 + 名字前缀"，在父目录里按前缀找目录。
 * 第一版把整段 `lib/python` 当目录名去找，于是永远找不到 —— 打包当场红（见测试）。
 */
function resolveLicenseFile(runtimeDir, candidates) {
  for (const candidate of candidates) {
    if (!candidate.includes('*')) {
      const path = join(runtimeDir, candidate)
      if (existsSync(path) && statSync(path).isFile()) return candidate
      continue
    }
    const star = candidate.indexOf('*')
    const before = candidate.slice(0, star)
    const suffix = candidate.slice(star + 1)
    const parent = before.includes('/') ? before.slice(0, before.lastIndexOf('/')) : ''
    const namePrefix = before.slice(parent === '' ? 0 : parent.length + 1)
    const base = join(runtimeDir, parent)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !entry.name.startsWith(namePrefix)) continue
      const relative = parent === '' ? `${entry.name}${suffix}` : `${parent}/${entry.name}${suffix}`
      if (existsSync(join(runtimeDir, relative))) return relative
    }
  }
  return undefined
}

/** 关键可执行文件相对载荷根的路径（清单记哈希的那几个；客户端解析端也用它）。 */
export function runtimeCommands(target, pin) {
  const posix = target.startsWith('linux-') || target.startsWith('darwin-')
  const nodeCommand = posix ? pin.node.commands.posix.node : pin.node.commands.win.node
  const pythonCommand = posix ? pin.python.commands.posix.python : pin.python.commands.win.python
  return {
    node: `${RUNTIME_DIRS.node}/${nodeCommand}`,
    pnpm: `${RUNTIME_DIRS.pnpm}/${pin.pnpm.entry}`,
    python: `${RUNTIME_DIRS.python}/${pythonCommand}`,
  }
}

/** 读载荷清单（客户端解析端与门禁共用；读不懂即 fail-loud）。 */
export function readRuntimeManifest(root) {
  const path = join(root, RUNTIME_MANIFEST_FILE)
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (manifest?.schema !== 1) throw new Error(`${path}: unsupported schema ${String(manifest?.schema)}`)
  return manifest
}

/**
 * 体积预算门禁：载荷树**不得超过** `runtimes.json` 里记录的实测上限（棘轮）。
 *
 * 为什么要有这条：载荷是**每个平台的安装包都要背的固定成本**（未压缩 ≈240 MiB / 206 MiB /
 * 180 MiB，交付件按约 1/4.5 计），而"升级一次运行时"是低摩擦动作 —— 少了这条，Node 或
 * CPython 换代会让三平台安装包一起胖一圈而没有任何判据看得见。判据取 `≤`（不是相等）：
 * 变小是好事（记录值随下次显式更新收紧），变大必须由作者改这一处数字。
 * @param manifest - 载荷清单（`tree.files` / `tree.bytes`）。
 * @param pin - 已校验的钉死清单。
 * @throws 超出上限（点名 target、实测值与上限）。
 */
export function assertRuntimeBudget(manifest, pin = readRuntimePin()) {
  const target = manifest?.target
  const budget = runtimeBudget(pin, target)
  const tree = manifest?.tree ?? {}
  const over = []
  if (tree.bytes > budget.bytes) over.push(`bytes ${String(tree.bytes)} > ${String(budget.bytes)}`)
  if (tree.files > budget.files) over.push(`files ${String(tree.files)} > ${String(budget.files)}`)
  if (over.length === 0) return { bytes: tree.bytes, files: tree.files, budget }
  throw new Error(
    `随包运行时 ${String(target)} 载荷超出体积预算（${over.join('，')}）—— `
    + '这是每个平台安装包都要背的固定成本；确认要接受就更新 runtimes.json 的 budget.targets.'
    + `${String(target)}（并连带跑一次 fetch-bundled-runtimes.mjs --check 复核实测值）`,
  )
}

/**
 * 校验一份已就位的载荷：目标平台一致、树摘要一致、关键可执行文件哈希一致、体积在预算内。
 * @param out - 载荷根目录。
 * @param target - 期望的目标平台键。
 * @param pin - 已校验的钉死清单（缺省自己读一次）。
 * @returns 清单。
 * @throws 任一不符（不静默）。
 */
export async function verifyRuntimePayload(out, target, pin = readRuntimePin()) {
  const manifest = readRuntimeManifest(out)
  if (manifest.target !== target) {
    throw new Error(`随包运行时目标是 ${String(manifest.target)}，本次打包目标是 ${target}`)
  }
  const tree = runtimeTreeDigest(out, [join(out, RUNTIME_MANIFEST_FILE)])
  if (tree.files !== manifest.tree.files || tree.bytes !== manifest.tree.bytes || tree.digest !== manifest.tree.digest) {
    throw new Error(
      `随包运行时载荷与清单不一致（files ${String(tree.files)}/${String(manifest.tree.files)}，`
      + `bytes ${String(tree.bytes)}/${String(manifest.tree.bytes)}）—— 重新跑一次 scripts/fetch-bundled-runtimes.mjs`,
    )
  }
  for (const entry of manifest.critical ?? []) {
    const path = join(out, entry.path)
    if (!existsSync(path)) throw new Error(`随包运行时缺关键文件 ${entry.path}`)
    if (statSync(path).size !== entry.bytes) throw new Error(`随包运行时 ${entry.path} 字节数不符`)
    if (await hashFile(path, 'sha256', 'hex') !== entry.sha256) throw new Error(`随包运行时 ${entry.path} 的 sha256 不符`)
  }
  // 体积预算放在最后：先证明载荷是对的，再说它有多大（顺序不影响结论，只影响报错的可读性）。
  assertRuntimeBudget(manifest, pin)
  return manifest
}

/**
 * 就位随包运行时载荷（幂等）：载荷已校验通过时直接返回；否则下载缺失制品、解包、
 * 裁剪、写 shim 与清单，最后**再校验一次**（写坏了立即失败，绝不把坏载荷留给打包）。
 * @param options - 目标目录、缓存目录、目标平台、镜像源与"只校验"开关。
 * @returns 载荷根目录、目标平台、清单与每个运行时的状态。
 */
export async function materializeBundledRuntimes(options = {}) {
  const {
    out = DEFAULT_RUNTIME_OUT,
    cache = DEFAULT_RUNTIME_CACHE,
    target = resolveRuntimeTarget(),
    check = false,
    origins = {},
    pinFile = RUNTIME_PIN_FILE,
    log = console.log,
  } = options
  const pin = readRuntimePin(pinFile)
  if (!pin.targets.includes(target)) throw new Error(`不支持的目标平台 ${target}`)
  // 打包器会按名字跳过 `.DS_Store`/`.gitkeep`（builder-util/out/fs.js:68）：**复用已有
  // 载荷时也要清一次**，否则上一次构建留下的这类文件会让产物与摘要对不上（实测到）。
  // 幂等且与摘要无关（摘要本来就跳过它们），所以放在校验之前是安全的。
  if (existsSync(out)) prunePackagerSkippedNames(out, message => log(message))
  if (check) {
    const manifest = await verifyRuntimePayload(out, target, pin)
    return { out, target, manifest, status: { node: 'ready', pnpm: 'ready', python: 'ready' } }
  }
  try {
    const manifest = await verifyRuntimePayload(out, target, pin)
    log(`fetch-bundled-runtimes: 载荷已就位且校验通过 → ${out}（${target}）`)
    return { out, target, manifest, status: { node: 'ready', pnpm: 'ready', python: 'ready' } }
  } catch (error) {
    log(`fetch-bundled-runtimes: 需要重新就位（${error instanceof Error ? error.message : String(error)}）`)
  }
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true, mode: 0o755 })
  const status = {}
  for (const [key, dirName] of Object.entries(RUNTIME_DIRS)) {
    const artifact = pin[key].targets[target]
    const base = origins[key] ?? pin[key].base
    const url = new URL(artifact.asset, base).href
    const cached = join(cache, `${target}-${artifact.asset}`)
    if (!await verifyArtifact(cached, artifact, pin[key].integrity)) {
      log(`fetch-bundled-runtimes: 下载 ${key} ${pin[key].version}（${target}）← ${url}`)
      await downloadArtifact(url, cached, artifact, pin[key].integrity)
    }
    const runtimeDir = join(out, dirName)
    const staging = `${runtimeDir}.staging`
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true, mode: 0o755 })
    if (artifact.kind === 'zip') extractZip(cached, staging, 1)
    else await extractTarGz(cached, staging, 1)
    pruneRuntime(staging, pin[key].prune ?? [], message => log(message))
    rmSync(runtimeDir, { recursive: true, force: true })
    renameSync(staging, runtimeDir)
    status[key] = 'materialized'
  }
  // 新解出来的载荷也清一次（复用路径已在上面清过；幂等）。摘要本来就跳过它们，
  // 所以这一步只影响"磁盘上留下的东西"，不影响一致性判据。
  prunePackagerSkippedNames(out, message => log(message))
  const commands = runtimeCommands(target, pin)
  const critical = []
  for (const path of Object.values(commands)) {
    const absolute = join(out, path)
    if (!existsSync(absolute)) throw new Error(`载荷里缺关键可执行文件 ${path}（制品形态变了？）`)
    critical.push({ path, bytes: statSync(absolute).size, sha256: await hashFile(absolute, 'sha256', 'hex') })
  }
  const shims = writeRuntimeShims(out, target, pin)
  const pipConfig = writePipUserConfig(join(out, RUNTIME_DIRS.python), target)
  // 再分发的许可文本：三套都是第三方制品，缺一份即拒（见 runtimeLicenseCandidates）。
  const licenses = Object.entries(RUNTIME_DIRS).map(([key, dirName]) => {
    const relative = resolveLicenseFile(join(out, dirName), runtimeLicenseCandidates(key, target))
    if (relative === undefined) {
      throw new Error(`随包运行时 ${key} 里找不到许可文本（候选：${runtimeLicenseCandidates(key, target).join(', ')}）—— 再分发不能少了它`)
    }
    const path = `${dirName}/${relative}`
    return { runtime: key, path, bytes: statSync(join(out, path)).size }
  })
  const tree = runtimeTreeDigest(out, [join(out, RUNTIME_MANIFEST_FILE)])
  const manifest = {
    schema: 1,
    target,
    platform: target.slice(0, target.lastIndexOf('-')),
    arch: target.slice(target.lastIndexOf('-') + 1),
    versions: { node: pin.node.version, pnpm: pin.pnpm.version, python: pin.python.version },
    commands,
    shims,
    pipConfig,
    licenses,
    critical,
    tree,
  }
  writeFileSync(join(out, RUNTIME_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
  await verifyRuntimePayload(out, target, pin)
  log(
    `fetch-bundled-runtimes: 就位完成 → ${out}（${target}；node ${pin.node.version} / pnpm ${pin.pnpm.version} / `
    + `python ${pin.python.version}；${String(tree.files)} 个文件 ${(tree.bytes / 1024 / 1024).toFixed(1)} MiB）`,
  )
  return { out, target, manifest, status }
}

/**
 * 随包 python 的 pip 站点级配置：让 `pip install` 默认落到**用户目录**。
 *
 * 为什么必要：随包 python 在**已签名**的应用包内（macOS 上写它会破坏签名封装；
 * Windows 上安装目录可能只有管理员可写）。`user = yes` 让 pip 装到 `PYTHONUSERBASE`
 * 指向的位置（客户端把它指到数据根，见 `src/bundled-runtimes.ts`）。
 * @param runtimeDir - python 载荷目录。
 * @param target - 目标平台键。
 * @returns 写出的文件相对载荷根的路径。
 */
export function writePipUserConfig(runtimeDir, target) {
  const name = target.startsWith('win-') ? 'pip.ini' : 'pip.conf'
  writeFileSync(join(runtimeDir, name), '[global]\nuser = yes\n', { mode: 0o644 })
  return `${RUNTIME_DIRS.python}/${name}`
}

/**
 * 载荷是**只读交付物**：任何在打包机上运行它的路径都必须带 `PYTHONDONTWRITEBYTECODE=1`
 * （或在客户端由 `PYTHONPYCACHEPREFIX` 重定向），否则 CPython 会往 `__pycache__` 写
 * `.pyc` —— `.pyc` 内嵌源文件 mtime/size，字节数因此变化，下一次 `--check`/打包会判
 * "载荷与清单不一致"并整份重新解包（本轮实测到 123 字节的差异）。`verifyRuntimePayload`
 * 只读不跑命令，所以这条约束落在**调用运行时的那些人**身上（afterPack 门禁已照办）。
 */

/** 清掉载荷目录（构建前清理用；残留会被 extraResources 打进产物）。 */
export function removeBundledRuntimes(out = DEFAULT_RUNTIME_OUT) {
  rmSync(out, { recursive: true, force: true })
}

async function main(argv) {
  let out = DEFAULT_RUNTIME_OUT
  // 制品缓存目录可由环境变量指向别处（CI 把它挂到 actions/cache 的路径上，见
  // .github/workflows/ci.yml 三个 desktop job 的 "Cache bundled agent runtimes"）。
  let cache = process.env.PICOAI_RUNTIME_CACHE ?? DEFAULT_RUNTIME_CACHE
  let target
  let check = false
  const origins = {}
  const originFlags = { '--node-origin': 'node', '--python-origin': 'python', '--pnpm-origin': 'pnpm' }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--check') { check = true; continue }
    if (flag === '--cache' || flag === '--out' || flag === '--target' || flag in originFlags) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        console.error(`fetch-bundled-runtimes: ${flag} 需要取值`)
        return 2
      }
      index += 1
      if (flag === '--out') out = resolve(value)
      else if (flag === '--cache') cache = resolve(value)
      else if (flag === '--target') target = value
      else origins[originFlags[flag]] = value
      continue
    }
    console.error(`fetch-bundled-runtimes: 未知参数 ${flag}`)
    return 2
  }
  const result = await materializeBundledRuntimes({ out, cache, target: target ?? resolveRuntimeTarget(), check, origins })
  if (check) console.log(`fetch-bundled-runtimes: 校验通过 → ${result.out}（${result.target}）`)
  return 0
}

if (isDirectInvocation(import.meta)) {
  main(process.argv.slice(2)).then(code => process.exit(code), (error) => {
    console.error(`fetch-bundled-runtimes: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
