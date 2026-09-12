/**
 * 补丁守卫：`@deepseek-ai/dsh-tool-fs-search` 的 **asar 路径重写**
 * （见 `patches/dsh-tool-fs-search@0.1.5-rc.2.patch`）。
 *
 * 背景（2026-09-12，真实故障）：`glob` / `grep` 在**打包版客户端**上全部失败，
 * 报的是 `… subprocess failed before reporting an outcome (ripgrep provider failure)`。
 *
 * 根因：`@vscode/ripgrep` 用 `require.resolve('@vscode/ripgrep-<平台>-<arch>/bin/rg[.exe]')`
 * 给出二进制路径；Electron 打包后这个路径落在 **`resources/app.asar` 内部**，而 asar 是
 * 一个**文件**不是目录 —— 原生二进制无法从里面 spawn（本地实测 `spawn` 该路径 → `ENOTDIR`，
 * 而同一二进制在 `app.asar.unpacked/` 下的那份可以正常执行）。
 *
 * 上游 `tool-fs-search` / `subprocess-*` **没有任何 asar 适配**（零命中），所以补丁在
 * `resolveRgPath()` 出口把归档内部路径重写到 `.asar.unpacked` 兄弟路径（仅当它确实存在）。
 * 注意这不是 Windows 专属问题：Windows / Linux / macOS 的打包版都受同一路径问题影响。
 *
 * 本 spec 直接对**行为**断言（补丁把 `unpackAsarPath` 一并导出，正是为了能这样测），
 * 并用打包产物里的真实布局做一次端到端核对。
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
const pkgDir = dirname(require_.resolve('@deepseek-ai/dsh-tool-fs-search/package.json'))

async function loadSearch(): Promise<Record<string, any>> {
  return await import(pathToFileURL(join(pkgDir, 'lib', 'index.js')).href) as Record<string, any>
}

describe('ripgrep 路径解析（补丁守卫）', () => {
  it('把 asar 归档内部路径重写到 unpacked 兄弟路径', async () => {
    const { unpackAsarPath } = await loadSearch()
    expect(typeof unpackAsarPath, '补丁未应用：unpackAsarPath 未导出').toBe('function')
    // 用打包产物里的真实布局（本机 Linux 包；unpacked 那份确实存在）
    const base = join(pkgDir, '..', '..', '..', '..', 'dist', 'linux-unpacked', 'resources')
    const bin = 'node_modules/@vscode/ripgrep-linux-x64/bin/rg'
    const inside = join(base, 'app.asar', bin)
    const unpacked = join(base, 'app.asar.unpacked', bin)
    if (!existsSync(unpacked)) return // 未打包时跳过（CI 的 gate 不产出 dist）
    expect(unpackAsarPath(inside)).toBe(unpacked)
  })

  it('打包目录不存在时保守返回原路径（不猜、不改）', async () => {
    const { unpackAsarPath } = await loadSearch()
    const missing = '/nonexistent/resources/app.asar/node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe'
    expect(unpackAsarPath(missing)).toBe(missing)
  })

  it('非打包路径（无 .asar 段）原样返回', async () => {
    const { unpackAsarPath } = await loadSearch()
    const plain = '/app/node_modules/@vscode/ripgrep-linux-x64/bin/rg'
    expect(unpackAsarPath(plain)).toBe(plain)
  })

  it('resolveRgPath 解析到的是可执行的真实文件（非归档内部路径）', async () => {
    const { resolveRgPath } = await loadSearch()
    const resolved = await resolveRgPath()
    expect(resolved.includes('.asar/'), `解析到归档内部路径: ${resolved}`).toBe(false)
    expect(existsSync(resolved)).toBe(true)
  })
})
