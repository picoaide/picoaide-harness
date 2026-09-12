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
 *   `patch:@deepseek-ai/dsh-win32-process@npm%3A0.1.5-rc.2#./patches/dsh-win32-process@0.1.5-rc.2.patch`
 *
 * @module scripts/patch-targets
 */

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
 * 解析补丁文件里被改动的文件路径(`--- a/<path>` / `+++ b/<path>`)。
 * @param patchText - 补丁文件内容。
 * @returns 去重后的路径列表(仓库内使用正斜杠)。
 */
export function patchedFilePaths(patchText) {
  const paths = new Set()
  for (const line of patchText.split(/\r?\n/u)) {
    const match = /^(?:---|\+\+\+) [ab]\/(.+)$/u.exec(line)
    if (match === null) continue
    const path = match[1].trim()
    if (path === '/dev/null') continue
    paths.add(path)
  }
  return [...paths]
}
