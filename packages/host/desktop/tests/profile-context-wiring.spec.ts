/**
 * issue #130 的**接线**判据：`profileContext` 必须在生产路径上发布，且 `hmr` 行必须在
 * 桌面组合里显式关闭。
 *
 * 为什么除了 `scripts/verify-profile-boot.mjs` 还需要这一层：那份冒烟**自己** provide
 * `profileContext`（它复刻的就是 main.ts 的启动形态），所以只把 main.ts 里那一行删掉时，
 * 冒烟仍然全绿 —— 本仓吃过一次同形的亏（`provide(WASM_APPS_AI_RUNNER_SERVICE, …)` 当时
 * 没有任何判据，删掉后门禁全绿而生产静默 503，见 tests/app-ai-runner.spec.ts 第 2 条用例）。
 * 分工：冒烟证**行为**（真挂载整棵树 + 逐个 preset mount），这里证**接线**（两处调用点
 * 仍在、且 hmr 行仍是关的）。两处都必须能被打坏，否则判据是空转的。
 * @module dsh-plugin-desktop/tests/profile-context-wiring
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { desktopProfileContext, prepareDesktopProfile } from '../src/profile.ts'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const homes: string[] = []

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-context-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('desktop profileContext wiring (issue #130)', () => {
  it('main.ts 经 desktopProfileContext 发布 profileContext（内联字面量会让冒烟测的不是生产路径）', () => {
    const main = readFileSync(join(packageRoot, 'src', 'main.ts'), 'utf8')
    expect(main).toContain('desktopProfileContext,')
    expect(main).toContain("hostCtx.provide('profileContext', desktopProfileContext(prepared))")
    // 反向：不得内联字面量对象（构造必须只有 profile.ts 一份）。
    expect(main).not.toMatch(/hostCtx\.provide\(\s*'profileContext',\s*\{/u)
  })

  it('cordis.patch.yml 显式关闭 hmr 行（打开它需要 CLI 专属的 appReady 服务）', () => {
    const patch = join(packageRoot, 'cordis.patch.yml')
    const rows = parseYaml(readFileSync(patch, 'utf8')) as Array<{ id?: unknown; disabled?: unknown }>
    const hmr = rows.find(row => row?.id === 'hmr')
    expect(hmr, 'cordis.patch.yml 必须显式列出 hmr 行').toBeDefined()
    expect(hmr?.disabled, 'hmr 行必须是 disabled: true（提供 profileContext 会让它激活并炸掉整棵树）').toBe(true)
  })

  it('desktopProfileContext 的每个字段都来自本次真实装配', async () => {
    const home = temporaryHome()
    const prepared = await prepareDesktopProfile('1', home, 'linux')
    const context = desktopProfileContext(prepared)

    expect(context.name).toBe('desktop')
    expect(context.dir).toBe(prepared.profile.dir)
    expect(context.patchPath).toBe(prepared.profile.patchPath)
    expect(context.home).toBe(home)
    expect(context.cwd).toBe(process.cwd())
    expect(context.startedBundles).toEqual(prepared.profile.layers.map(layer => layer.packageName))
    // 装配入参的透传：必须用装配时那个值，而不是在这里重读 process.env
    // （冒烟/嵌入式调用会显式传值，重读会让"组合期 A、自述 B"分叉）。
    expect(context.telemetryDisabledEnv).toBe('1')

    // `plugin-manager` 的 `listBundles()` 会把 installAnchor 当 **JSON 文件**读
    // （`JSON.parse(readFileSync(this.profile.installAnchor))`）—— 给目录会在第一条
    // 管理动作上炸，所以这里按"它真能读"判据，而不是只比字符串。
    expect(context.installAnchor).toBe(prepared.installAnchor)
    expect(existsSync(context.installAnchor)).toBe(true)
    expect(JSON.parse(readFileSync(context.installAnchor, 'utf8'))).toMatchObject({ name: 'dsh-plugin-desktop' })

    // overlays = patches 的**尾段**（启动器自己的 pin 层，应用在 profile 自有层与 home
    // 层之上）：既是真实来源，也保证"自述的组合"与"真正 boot 的组合"是同一份。
    expect(prepared.overlays.length).toBeGreaterThan(0)
    expect(prepared.patches.slice(prepared.patches.length - prepared.overlays.length)).toEqual(prepared.overlays)
    expect(context.overlays).toEqual(prepared.overlays)
  })
})
