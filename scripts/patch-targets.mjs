/**
 * 共享解析:根 `package.json` 的 `resolutions` 里的 yarn patch 目标。
 *
 * 两个门禁都建立在同一份解析之上,避免"补丁键"与"补丁文件"两处各写一套正则而漂移:
 *   - `scripts/verify-patch-resolutions.mjs`:exact / `^` 键成对完备(补丁覆盖所有副本)
 *   - `scripts/verify-patches.mjs`          :在**仓库外**对 pristine tarball 做 patch dry-run
 *
 * resolution 取值的形状(yarn 4):
 *   `patch:<name>@npm%3A<version>#<patch 文件相对仓库根的路径>`
 * 例如:
 *   `patch:@deepseek-ai/dsh-win32-process@npm%3A0.1.5-rc.2#./patches/dsh-win32-process@<pin>.patch`
 *
 * @module scripts/patch-targets
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** patch resolution 的取值前缀。 */
const PATCH_PREFIX = 'patch:'
/** yarn 把 locator 里的 `:` 百分号编码成 `%3A`。 */
const NPM_DESCRIPTOR = '@npm%3A'

/**
 * 解析一条 resolution 取值。不是 patch 取值时返回 undefined。
 * @param value - resolution 取值(可能是普通版本号、patch 取值等)。
 * @returns 解析结果,或 undefined(该取值不是 patch)。
 */
export function parsePatchResolution(value) {
  if (typeof value !== 'string' || !value.startsWith(PATCH_PREFIX)) return undefined
  const body = value.slice(PATCH_PREFIX.length)
  const hash = body.indexOf('#')
  if (hash === -1) return undefined
  const locator = body.slice(0, hash)
  const marker = locator.indexOf(NPM_DESCRIPTOR)
  if (marker <= 0) return undefined
  const name = locator.slice(0, marker)
  const version = locator.slice(marker + NPM_DESCRIPTOR.length)
  if (name === '' || version === '') return undefined
  return {
    name,
    version,
    /** 仓库根相对路径(去掉 `./`)。 */
    patchPath: body.slice(hash + 1).replace(/^\.\//u, ''),
    /** 原始取值(错误信息里原样回显)。 */
    value,
  }
}

/**
 * 读取根 manifest 的 patch 目标,按 `<name>@<version>` 归并所有 resolution 键。
 * @param root - 仓库根绝对路径。
 * @returns `{ targets, failures }`;targets 的每一项含 name/version/patchPath/keys。
 */
export function readPatchTargets(root) {
  const manifestPath = join(root, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const resolutions = manifest.resolutions ?? {}
  const targets = new Map()
  const failures = []

  for (const [key, value] of Object.entries(resolutions)) {
    const parsed = parsePatchResolution(value)
    if (parsed === undefined) continue
    const id = `${parsed.name}@${parsed.version}`
    let target = targets.get(id)
    if (target === undefined) {
      target = {
        name: parsed.name,
        version: parsed.version,
        patchPath: parsed.patchPath,
        patchValue: parsed.value,
        keys: [],
      }
      targets.set(id, target)
    } else if (target.patchPath !== parsed.patchPath) {
      // 同一个包+版本映射到两个不同补丁 = 无法判断安装树里是哪一份。
      failures.push(
        `${id}: resolutions 里出现了两个不同的 patch 目标(${target.patchPath} 与 ${parsed.patchPath});`
        + '请让所有键指向同一个 patch 文件',
      )
    }
    target.keys.push({ key, descriptor: key.slice(parsed.name.length + 1) })
  }

  return { targets: [...targets.values()], resolutions, manifestPath, failures }
}

/**
 * 列出 `patches/` 下的补丁文件(仓库根相对路径,已排序)。
 * @param root - 仓库根绝对路径。
 * @returns 补丁文件相对路径列表;目录不存在时返回空数组。
 */
export function listPatchFiles(root) {
  const dir = join(root, 'patches')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name.endsWith('.patch'))
    .sort()
    .map(name => `patches/${name}`)
}

/**
 * 在 yarn 的 cacheFolder 里按包名+版本定位缓存 zip。
 *
 * 文件名形状:`<name 的 / 换成 ->-npm-<version>-<checksum>-<hash>.zip`;
 * 打补丁后的副本是 `<...>-patch-<checksum>-<hash>.zip` —— 两者都要,前者是
 * pristine(补丁 dry-run 的输入),后者是 yarn 落盘的封存副本(结果对拍)。
 * @param cacheDir - `.yarn/cache` 绝对路径。
 * @param name - 包名(可带 scope)。
 * @param version - 版本。
 * @returns `{ pristine, patched }` 两个文件名(可能为 undefined)。
 */
export function findCacheZips(cacheDir, name, version) {
  if (!existsSync(cacheDir)) return { pristine: undefined, patched: undefined, files: [] }
  const files = readdirSync(cacheDir).filter(file => file.endsWith('.zip'))
  const ident = name.replaceAll('/', '-')
  const patched = files.find(file => file.startsWith(`${ident}-patch-`))
  // 版本里可能含 `+`/`~` 等被 yarn 改写的字符,先按精确前缀找,退回"ident-npm-* 且含版本"。
  const pristine = files.find(file => file.startsWith(`${ident}-npm-${version}-`) && !file.includes('-patch-'))
    ?? files.find(file => file.startsWith(`${ident}-npm-`) && !file.includes('-patch-') && file.includes(`-${version}-`))
  return { pristine, patched, files }
}

/**
 * 归一化补丁头里的文件路径:`a/`|`b/` 前缀、GNU diff 的 `<tab>时间戳` 尾巴、
 * git 给含空格路径加的双引号。
 * @param raw - `--- `/`+++ ` 之后的原文。
 * @returns 归一化后的路径(`/dev/null` 原样保留)。
 */
function normalizePatchPath(raw) {
  let value = String(raw).replace(/\t.*$/u, '').trim()
  if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
  if (value === '/dev/null') return value
  if (value.startsWith('a/') || value.startsWith('b/')) value = value.slice(2)
  return value
}

/**
 * 把 unified diff 解析成**逐文件段**(2026-09-23 第三轮门禁审计 G-1/G-2)。
 *
 * 为什么需要它:此前 `verify-patches.mjs` 只从补丁文本里抽文件路径,于是
 *   ① 零字节补丁(或纯空白)抽出 0 个路径 ⇒ 逐字节对拍循环整体空转,却仍打印
 *      `0 file(s)` 与"与封存副本逐字节一致";
 *   ② 多文件补丁**丢掉一段**时,被丢的那段根本不参与任何判据 ⇒ 少打一个文件段
 *      无人发现。
 * 所以判据必须在"段"这一级:补丁体是否为空、每段是否有 hunk、hunk 正文与 `@@`
 * 声明是否自洽 —— 全部由本函数给出,由调用方决定如何判红。
 *
 * @param patchText - 补丁文件内容。
 * @returns `{ sections, problems }`。sections 每项含
 *   `{ path, oldPath, newPath, hunks, atLine }`(path 取 `+++` 侧,删除文件回退 `---` 侧),
 *   problems 是结构性缺陷(带行号的英文/中文说明)。
 */
export function parsePatchSections(patchText) {
  const text = String(patchText ?? '')
  const lines = text.split(/\r?\n/u)
  const sections = []
  const problems = []
  let current = null

  const closeCurrent = () => {
    if (current === null) return
    const path = current.newPath !== null && current.newPath !== '/dev/null'
      ? current.newPath
      : current.oldPath
    if (path === null || path === '/dev/null') {
      problems.push(`第 ${current.atLine} 行起的文件段两侧都是 /dev/null(无法确定目标文件)`)
    } else {
      sections.push({ ...current, path })
    }
    current = null
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('diff --git ')) {
      closeCurrent()
      // 路径含空格时 git 会加引号;取**最后**一个 ` b/` 之后的片段。
      const match = /^diff --git .* b\/(.+)$/u.exec(line)
      current = {
        oldPath: null,
        newPath: match === null ? null : normalizePatchPath(match[1]),
        hunks: [],
        atLine: i + 1,
        headerSeen: false,
      }
      i += 1
      continue
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? ''
      if (!next.startsWith('+++ ')) {
        problems.push(`第 ${i + 1} 行是 '--- ' 但下一行不是 '+++ '(文件段头被切断)`)
        i += 1
        continue
      }
      const oldPath = normalizePatchPath(line.slice(4))
      const newPath = normalizePatchPath(next.slice(4))
      if (current !== null && current.hunks.length > 0) closeCurrent()
      if (current === null) {
        current = { oldPath, newPath, hunks: [], atLine: i + 1, headerSeen: true }
      } else if (current.headerSeen) {
        // 同一段里出现第二对 `---`/`+++` 而中间一个 hunk 都没有 ⇒ 前一个文件段
        // 只有头没有体(它的 hunk 被删了),不能被后一段静默顶替。
        problems.push(`第 ${current.atLine} 行起的文件段只有 ---/+++ 头、没有任何 hunk(hunk 体已丢失)`)
        closeCurrent()
        current = { oldPath, newPath, hunks: [], atLine: i + 1, headerSeen: true }
      } else {
        // 紧跟 `diff --git` 的那对 `---`/`+++`:补全同一段的路径。
        current.oldPath = oldPath
        current.newPath = newPath
        current.headerSeen = true
      }
      i += 2
      continue
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line)
    if (header !== null) {
      if (current === null) {
        problems.push(`第 ${i + 1} 行的 hunk 出现在任何文件段之前`)
        i += 1
        continue
      }
      const oldNeed = header[2] === undefined ? 1 : Number(header[2])
      const newNeed = header[4] === undefined ? 1 : Number(header[4])
      let j = i + 1
      let oldSeen = 0
      let newSeen = 0
      let added = 0
      let removed = 0
      // 只吃到 `@@` 声明的行数为止,遇到结构行(下一段头/hunk 头/空行)立即停 ——
      // 否则"被截断的 hunk"会把下一段的 `--- a/x` 当成被删行吃掉,而两段的行数
      // 恰好凑够声明值时整条判据静默失效。
      while (j < lines.length && (oldSeen < oldNeed || newSeen < newNeed)) {
        const body = lines[j]
        if (body === '' || body.startsWith('diff --git ') || body.startsWith('@@ ')) break
        if (body.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break
        // `\ No newline at end of file` 不是内容行。
        if (body.startsWith('\\')) { j += 1; continue }
        if (body.startsWith(' ')) { oldSeen += 1; newSeen += 1; j += 1; continue }
        if (body.startsWith('-')) { oldSeen += 1; removed += 1; j += 1; continue }
        if (body.startsWith('+')) { newSeen += 1; added += 1; j += 1; continue }
        break
      }
      while (j < lines.length && lines[j].startsWith('\\')) j += 1
      if (oldSeen !== oldNeed || newSeen !== newNeed) {
        problems.push(
          `第 ${i + 1} 行的 hunk 正文与 @@ 声明不符(声明 -${oldNeed}/+${newNeed},`
          + `实际 -${oldSeen}/+${newSeen})—— hunk 体被截断或改坏`,
        )
      }
      current.hunks.push({ header: line, oldLines: oldNeed, newLines: newNeed, added, removed, atLine: i + 1 })
      i = j
      continue
    }
    i += 1
  }
  closeCurrent()

  if (text.trim() !== '' && sections.length === 0 && problems.length === 0) {
    problems.push('补丁非空,但解析不出任何文件段(没有 `---`/`+++` 也没有 `diff --git` 头)')
  }
  return { sections, problems }
}

/**
 * 解析补丁文件里被改动的文件路径(`--- a/<path>` / `+++ b/<path>`)。
 * @param patchText - 补丁文件内容。
 * @returns 去重后的路径列表(仓库内使用正斜杠)。
 */
export function patchedFilePaths(patchText) {
  return parsePatchSections(patchText).sections.map(section => section.path)
}

/**
 * 逐文件哈希一棵树(相对路径用正斜杠)。
 * @param dir - 目录绝对路径(不存在时返回空表)。
 * @returns `Map<相对路径, sha256>`。
 */
function hashTree(dir) {
  const out = new Map()
  if (!existsSync(dir)) return out
  const walk = (abs, rel) => {
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const childAbs = join(abs, entry.name)
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        walk(childAbs, childRel)
        continue
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      try {
        out.set(childRel, createHash('sha256').update(readFileSync(childAbs)).digest('hex'))
      } catch {
        out.set(childRel, 'unreadable')
      }
    }
  }
  walk(dir, '')
  return out
}

/**
 * 对拍两棵树,给出"右侧相对左侧"的变化集(2026-09-23 第三轮门禁审计 G-1/G-2)。
 *
 * `verify-patches.mjs` 用它把**判据的方向反过来**:不是"补丁文本里写了哪些文件就查哪些"
 * (那样丢一段无人发现),而是"封存副本相对 pristine 到底变了哪些文件",再要求补丁的
 * 文件段与之对齐 —— 零字节补丁与丢段补丁都会在这里失配。
 *
 * @param leftDir - 左侧(pristine tarball)目录。
 * @param rightDir - 右侧(封存副本/安装树副本)目录。
 * @returns `{ changed, added }`:changed = 左侧有、右侧改了或删了的相对路径;
 *   added = 只在右侧存在的相对路径。
 */
export function diffTrees(leftDir, rightDir) {
  const left = hashTree(leftDir)
  const right = hashTree(rightDir)
  const changed = []
  const added = []
  for (const [rel, hash] of left) {
    if (right.get(rel) !== hash) changed.push(rel)
  }
  for (const rel of right.keys()) {
    if (!left.has(rel)) added.push(rel)
  }
  return { changed: changed.sort(), added: added.sort() }
}
