/**
 * `build.electronLanguages` 的平台拼写守卫（2026-09-16）。
 *
 * 背景（一条"静默 + 单平台"的 P0）：electron-builder 用这个列表**裁剪** Electron 的
 * 本地化资源，而两边的目录名拼写不同：
 *   - Linux / Windows：Chromium 的 locale id，**连字符** —— `zh-CN.pak` / `en-US.pak`；
 *   - macOS：bundle 里的 `.lproj` 目录，**下划线** —— `zh_CN.lproj` / `en.lproj`。
 * 反向匹配规则（electron-builder 侧）= `wanted === base` 或 `wanted.startsWith(base + '-' | '_')`。
 *
 * 于是：
 *   - `["zh-CN", "en-US"]` ⇒ macOS 只剩 `en.lproj`（`en-US` 命中 base `en`），中文界面没了；
 *   - `["en-US", "zh_CN"]` ⇒ Linux/Windows 只剩 `en-US.pak`（`zh_CN` 谁也不命中），
 *     实测打包后 `locales/` 只有 `en-US.pak`、界面整体回落英文。
 * **两边都要写**：`["zh-CN", "zh_CN", "en-US"]`（`en-US` 同时覆盖 macOS 的 `en.lproj`）。
 *
 * 为什么必须有这条测试：症状是"静默 + 仅某一个平台"，本地与 CI 都只跑单一平台，
 * 而且 `e2e:client` 恒定用 `--lang=zh-CN` 启动，一旦 .pak 缺失就会整片中文断言变红
 * 却被误判成功能回归。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageRoot = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8')) as {
  build?: { electronLanguages?: string[] }
}

/** electron-builder 的反向匹配：候选是否命中某个真实目录/文件基名。 */
function matches(wanted: string, base: string): boolean {
  return wanted === base || wanted.startsWith(`${base}-`) || wanted.startsWith(`${base}_`)
}

/** 两个平台各自的**本产品支持**的本地化资源基名（Linux/Win 的 .pak，macOS 的 .lproj）。 */
const PLATFORM_BASES = {
  'linux/win32 (.pak)': ['zh-CN', 'en-US'],
  'darwin (.lproj)': ['zh_CN', 'en'],
} as const

describe('build.electronLanguages 覆盖两个平台的拼写', () => {
  const configured = manifest.build?.electronLanguages ?? []

  it('列表非空且没有重复项', () => {
    expect(configured.length).toBeGreaterThan(0)
    expect(new Set(configured).size).toBe(configured.length)
  })

  it.each(Object.entries(PLATFORM_BASES))('%s 的每个真实资源基名都能被命中', (_platform, bases) => {
    const missed = bases.filter(base => !configured.some(wanted => matches(wanted, base)))
    expect(missed).toEqual([])
  })

  it('中文在两个平台都保留（连字符与下划线两种写法都在列表里）', () => {
    expect(configured).toContain('zh-CN')
    expect(configured).toContain('zh_CN')
  })
})
