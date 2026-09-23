#!/usr/bin/env node
/**
 * 「补丁到底打在**哪一份副本**上」的**派生化**扫描面（2026-09-23 第五轮审计 R5-D-6）。
 *
 * 现场：`verify-patches.mjs` 与 `check-patch-pin.mjs` 判"安装树里该 pin 版本的**全部**副本
 * 必须逐字节等于 pristine + 补丁"，但两者的**核对面**都是一份**固定枚举**的根列表
 * （仓库根 + 各 workspace 的 `node_modules` + 组内一层嵌套）。把一份 **pristine** 副本
 * 放到"Node 解析优先、随包交付、但不在枚举里"的位置
 * （例如 `packages/host/desktop/lib/node_modules/@deepseek-ai/<pkg>/`）之后，两个守卫
 * **双双 EXIT=0** —— 被枚举的那份保持补丁后状态，影子副本悄悄成为随包交付的那一份。
 *
 * 处置（本模块是唯一实现，两个守卫共用）：
 *   1. **枚举根按打包白名单派生**：`packages/host/desktop/scripts/pack-app-root.mjs` 的
 *      `PACK_APP_ROOT_ENTRIES` 决定"应用根里哪些子树会进包" ⇒ 那些子树里的
 *      `node_modules` 也随包交付，必须进核对面（源码级读取 + 形状断言，改白名单即跟着变）。
 *   2. **解析面按 Node 解析顺序派生**：对"仓库根 / 各 workspace / 应用根 / 应用根下的随包
 *      目录（含其一层子目录）"逐个用 Node 的解析器（`createRequire().resolve()`）问
 *      "从这里 require 这个包会解析到哪一份"，得到**真正会生效**的副本路径。
 *   3. 守卫拿 ② 的结果去对拍 ① 的枚举集合：解析得到的副本不在枚举里 ⇒ **fail-loud 点名**
 *      影子副本（而不是"没枚举到就当不存在"）。
 *
 * 为什么不用"全仓递归找 node_modules"：实测 `find . -name node_modules -prune` 在本仓
 * 60s 都跑不完（node_modules 树太大）—— 一个会超时的判据等于没有判据。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'

/** 应用包相对仓库根的路径（打包白名单的宿主）。 */
const DESKTOP_PACKAGE = 'packages/host/desktop'

/**
 * 读 `pack-app-root.mjs` 的随包条目白名单（**源码级单一真源**）。
 *
 * 读不到/形状变了就**抛错**：宁可让守卫红，也不要静默退回一份过期的手写清单
 * （那正是"枚举根"退化的起点）。
 * @param root - 仓库根。
 * @returns 随包条目名数组（如 `['lib', 'build', 'cordis.patch.yml', 'package.json']`）。
 */
export function shippedAppRootEntries(root) {
  const file = join(root, DESKTOP_PACKAGE, 'scripts', 'pack-app-root.mjs')
  if (!existsSync(file)) {
    throw new Error(`patch-copy-scan: 找不到打包白名单 ${relative(root, file)}（枚举根必须由它派生）`)
  }
  const text = readFileSync(file, 'utf8')
  const match = /export const PACK_APP_ROOT_ENTRIES = \[([\s\S]*?)\]/u.exec(text)
  if (match === null) {
    throw new Error('patch-copy-scan: pack-app-root.mjs 里读不出 PACK_APP_ROOT_ENTRIES（形状变了？）')
  }
  const entries = [...match[1].matchAll(/'([^']+)'/gu)].map(hit => hit[1])
  if (entries.length === 0) {
    throw new Error('patch-copy-scan: PACK_APP_ROOT_ENTRIES 解析出 0 个条目（白名单被清空？）')
  }
  return entries
}

/**
 * workspace 目录（相对仓库根，POSIX 形状）—— 与 `check-patch-pin.workspaceDirs()` 同一口径。
 * @param root - 仓库根。
 * @returns 相对路径数组（如 `packages/host/desktop`）。
 */
export function workspaceDirs(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const out = []
  for (const pattern of manifest.workspaces ?? []) {
    let dirs = ['']
    for (const segment of pattern.split('/')) {
      const next = []
      for (const base of dirs) {
        if (segment !== '*') {
          next.push(base === '' ? segment : `${base}/${segment}`)
          continue
        }
        const baseDir = join(root, base === '' ? '.' : base)
        if (!existsSync(baseDir)) continue
        for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
          if (entry.isDirectory()) next.push(base === '' ? entry.name : `${base}/${entry.name}`)
        }
      }
      dirs = next
    }
    out.push(...dirs)
  }
  return out
}

/**
 * **枚举根**：所有可能装载该包的 `node_modules` 目录（绝对路径）。
 * 派生化规则：仓库根 + 各 workspace + 应用根下每个随包子树（含其一层子目录，因为
 * `lib/foo/node_modules` 同样随包交付且 Node 会优先看它）。
 * @param root - 仓库根。
 * @returns `{ dir, why }[]`。
 */
export function copyScanNodeModulesDirs(root) {
  const out = []
  const add = (dir, why) => {
    if (existsSync(dir)) out.push({ dir, why })
  }
  add(join(root, 'node_modules'), '仓库根')
  for (const ws of workspaceDirs(root)) add(join(root, ws, 'node_modules'), `workspace ${ws}`)
  const appRoot = join(root, DESKTOP_PACKAGE)
  let entries
  try {
    entries = shippedAppRootEntries(root)
  } catch (error) {
    // 白名单读不出来时**只退回应用根本身**并在 why 里写明（守卫侧另有 fail-loud 判据）：
    // 直接抛错会让两个守卫在"白名单被改名"时同时崩掉，排障信息反而更差。
    out.push({ dir: appRoot, why: `应用根（白名单读取失败：${error.message}）` })
    add(join(appRoot, 'node_modules'), '应用根')
    return out
  }
  add(join(appRoot, 'node_modules'), '应用根')
  for (const entry of entries) {
    const entryPath = join(appRoot, entry)
    if (!existsSync(entryPath)) continue
    add(join(entryPath, 'node_modules'), `随包条目 ${entry}`)
    let children = []
    try {
      children = readdirSync(entryPath, { withFileTypes: true })
    } catch {
      children = []
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      add(join(entryPath, child.name, 'node_modules'), `随包条目 ${entry}/${child.name}`)
    }
  }
  return out
}

/**
 * **解析面**：从"真正会被执行的入口目录"出发，问 Node"这个包会解析到哪一份"。
 * @param root - 仓库根。
 * @param name - 包名（可带 scope）。
 * @returns `{ from, resolved }[]`（`resolved` 为 null 表示该入口解析不到这个包，属正常）。
 */
export function resolutionProbes(root, name) {
  const probeDirs = new Set([root, join(root, DESKTOP_PACKAGE)])
  for (const ws of workspaceDirs(root)) probeDirs.add(join(root, ws))
  try {
    for (const entry of shippedAppRootEntries(root)) {
      const entryPath = join(root, DESKTOP_PACKAGE, entry)
      if (!existsSync(entryPath)) continue
      probeDirs.add(entryPath)
      let children = []
      try {
        children = readdirSync(entryPath, { withFileTypes: true })
      } catch {
        children = []
      }
      for (const child of children) {
        if (child.isDirectory()) probeDirs.add(join(entryPath, child.name))
      }
    }
  } catch {
    // 白名单读不出来时只探仓库根/workspace/应用根（守卫侧另有白名单 fail-loud 判据）。
  }
  const probes = []
  for (const dir of probeDirs) {
    let resolved = null
    try {
      const probe = createRequire(join(dir, '__patch-copy-probe__.cjs'))
      resolved = resolve(probe.resolve(name))
    } catch {
      resolved = null
    }
    probes.push({ from: deforoot(root, dir), resolved, resolvedRelative: resolved === null ? null : relative(root, resolved) })
  }
  return probes
}

/**
 * 相对化（用于输出）。
 * @param root - 仓库根。
 * @param target - 目标路径。
 * @returns 相对路径（root 之外则原样返回）。
 */
function deforoot(root, target) {
  const rel = relative(root, target)
  return rel === '' ? '.' : rel
}

/**
 * `git ls-files` 的便捷包装（供守卫做"影子副本是否已被跟踪"的补充说明）。
 * @param root - 仓库根。
 * @param args - git 参数。
 * @returns 输出行数组（失败返回空数组）。
 */
export function gitLines(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 })
      .split('\n')
      .filter(line => line !== '')
  } catch {
    return []
  }
}

export { dirname }
