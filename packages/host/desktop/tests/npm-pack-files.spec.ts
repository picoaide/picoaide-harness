/**
 * B-05（2026-09-23 独立审计 P2）：npm 分发包的 `files` 白名单漏掉 `.cjs`。
 *
 * `lib/preload/renderer-error.cjs` 是 tsdown 独立 preload 配置的产物
 * （`entryFileNames: 'preload/renderer-error.cjs'`），也是 `lib/` 下**唯一**的
 * 非 `.js` 运行期产物；只写 `lib` 下的 `.js` 模式匹配不到它。electron-builder
 * 产物走 `build.files` 的整目录白名单（不受影响），但 `src/bin.ts` 明确把
 * `npm install -g dsh-plugin-desktop` 当受支持的启动方式 —— 走 npm 的安装面里
 * preload 缺席 ⇒ 渲染进程错误采集整条链路静默失效（窗口照常，一条都收不到）。
 *
 * 判据用 Node 自带的 glob 引擎跑**真实的 patterns × 真实的产物树**，并带一条
 * 反向对照（去掉 `.cjs` 模式后必须匹配不到），避免判据空转。
 */
import { existsSync, globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const PRELOAD = 'lib/preload/renderer-error.cjs'

const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { files?: string[] }
const files = manifest.files ?? []

/** 用 Node 的 glob 语义把一组 `files` 模式展开成实际会命中的相对路径。 */
function matchedBy(patterns: readonly string[]): Set<string> {
  const matched = new Set<string>()
  for (const pattern of patterns) {
    for (const hit of globSync(pattern, { cwd: packageRoot })) matched.add(hit.replaceAll('\\', '/'))
  }
  return matched
}

describe('npm 分发包清单覆盖 lib/preload/renderer-error.cjs（B-05）', () => {
  it('白名单里有匹配该 .cjs 产物的模式', () => {
    expect(
      files.some(pattern => pattern.startsWith('lib/') && pattern.endsWith('.cjs')),
      `lib 白名单里没有任何 .cjs 模式：${files.filter(p => p.startsWith('lib/')).join(', ')}`,
    ).toBe(true)
    expect(matchedBy(files).has(PRELOAD), `${PRELOAD} 仍不被任何 files 模式覆盖`).toBe(true)
  })

  it('反向对照：去掉 .cjs 模式后匹配不到它（判据不是恒真）', () => {
    const withoutCjs = files.filter(pattern => !pattern.endsWith('.cjs'))
    expect(matchedBy(withoutCjs).has(PRELOAD), '去掉 .cjs 模式后必须匹配不到，否则这条判据测不出回归').toBe(false)
  })

  it('产物真的在磁盘上（判据不空转；需要先 build）', () => {
    expect(
      existsSync(join(packageRoot, PRELOAD)),
      `${PRELOAD} 不存在：先跑 yarn build（或 desktop 的 build 脚本）再跑本用例`,
    ).toBe(true)
  })

  it('紧邻的 .js 模式仍在（改坏另一边同样会漏运行期代码）', () => {
    expect(matchedBy(files).has('lib/main.js')).toBe(true)
  })
})
