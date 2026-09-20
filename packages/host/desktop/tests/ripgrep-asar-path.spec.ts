/**
 * 守卫：`@deepseek-ai/dsh-tool-fs-search` 的 **asar 路径重写**。
 *
 * 背景（2026-09-12，真实故障）：`glob` / `grep` 在**打包版客户端**上全部失败，
 * 报的是 `… subprocess failed before reporting an outcome (ripgrep provider failure)`。
 *
 * 根因：`@vscode/ripgrep` 用 `require.resolve('@vscode/ripgrep-<平台>-<arch>/bin/rg[.exe]')`
 * 给出二进制路径；Electron 打包后这个路径落在 **`resources/app.asar` 内部**，而 asar 是
 * 一个**文件**不是目录 —— 原生二进制无法从里面 spawn（实测 `spawn` → `ENOTDIR`，
 * 而同一二进制在 `app.asar.unpacked/` 下的那份可以正常执行）。
 *
 * 历史：0.1.5 时代上游**没有**这层适配，我们为此维护
 * `patches/dsh-tool-fs-search@<pin>.patch`（在 `resolveRgPath()` 出口重写并
 * 导出 `unpackAsarPath` 以便直接做行为断言）。
 * **0.1.6-alpha.2 已原生包含该修复**（`resolveRgPath()` 内联
 * `process.versions.electron === void 0 ? dependency : dependency.replace(/\.asar(?=[\\/])/u, ".asar.unpacked")`），
 * 我们据此删除了补丁 —— 于是本守卫也换了判据：不再断言"我们的补丁在"，而是
 * 断言**上游原生的行为**（解析出的路径是归档外的真实文件）+ **上游确实保留了
 * 那层 Electron 重写**（字符串判据，回退即红）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
const pkgDir = dirname(require_.resolve('@deepseek-ai/dsh-tool-fs-search/package.json'))

async function loadSearch(): Promise<Record<string, any>> {
  return await import(pathToFileURL(join(pkgDir, 'lib', 'index.js')).href) as Record<string, any>
}

describe('ripgrep 路径解析（上游原生 asar 适配守卫）', () => {
  it('上游仍保留 Electron 下的 .asar → .asar.unpacked 重写', () => {
    const source = readFileSync(join(pkgDir, 'lib', 'index.js'), 'utf8')
    // 判据绑在**能力**上：既要有 Electron 分支，也要有目标替换串。
    // 上游若把这层适配删掉或改名，这里先红，而不是等打包版搜索全废。
    expect(source).toContain('process.versions.electron')
    expect(source).toMatch(/replace\(\/\\\.asar\(\?=\[\\\\\/\]\)\/u,\s*"\.asar\.unpacked"\)/)
  })

  it('resolveRgPath 解析到的是可执行的真实文件（非归档内部路径）', async () => {
    const { resolveRgPath } = await loadSearch()
    const resolved = await resolveRgPath()
    expect(resolved.includes('.asar/'), `解析到归档内部路径: ${resolved}`).toBe(false)
    expect(existsSync(resolved)).toBe(true)
  })

  it('resolveRgPath 在纯 Node（非 Electron）下同样可用', async () => {
    // 本测试进程不是 Electron，走的正是"未打包"分支；这条与上一条一起覆盖
    // 两个分支各自的期望结果（Electron 分支的重写由第一条的源码判据守住）。
    expect(process.versions.electron).toBeUndefined()
    const { resolveRgPath } = await loadSearch()
    const resolved = await resolveRgPath()
    expect(existsSync(resolved)).toBe(true)
  })
})
