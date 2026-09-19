/**
 * `dsh-plugin-desktop/host-locale` 的**兼容面**契约（2026-09-20 构建环修复，路线 A）。
 *
 * 为什么这条断言必须单独存在：`host-locale` 的实现已迁到零依赖叶子包
 * `@picoaide/dsh-host-locale`（`packages/host/host-locale`），desktop 这边只剩一行
 * `export *`。语义判据全部随实现迁走且**逐字保留**（叶子包
 * `tests/host-locale.spec.ts`，14 例），所以本文件刻意**不重复**那些用例 ——
 * 它钉的是另一件事：`enterprise`（7 个文件）与 `cron` 仍然 import
 * `dsh-plugin-desktop/host-locale`，这条对外子路径必须继续**真的可用**
 * ——值导出能在运行期解析到实现、类型导出能被 tsc 看到，而不是"只剩类型能过"。
 *
 * 三层判据各由不同的门禁覆盖，合起来才是完整的 API 面：
 *   1. 语义 —— 叶子包自己的 spec（迁走的那 14 例）；
 *   2. 子路径 → 产物（`lib/host-locale.js` / `lib/types/host-locale.d.ts` 真的存在）
 *      —— `verify:closure` 第 1 段逐条断言 package.json exports 的每个目标；
 *   3. 本文件 —— re-export 链在运行期与类型层面都通（含 workspace 解析）。
 * 类型层面的失败由 `yarn run typecheck:tests`（本包 check 的一环）抓住，
 * 运行期解析失败则由下面这些断言抓住；两者都不是"存在性断言"。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOST_LOCALE,
  HOST_LOCALES,
  hostCopy,
  hostLocaleFrom,
  normalizeHostLocale,
  preferredLocaleFromAcceptLanguage,
  selectHostVariant,
  tryNormalizeHostLocale,
} from '../src/host-locale.ts'
import type { HostLocale, LocaleBearingRuntime } from '../src/host-locale.ts'

describe('dsh-plugin-desktop/host-locale 仍然是对外可用的兼容面', () => {
  it('值导出经 re-export 解析到叶子包的实现（不是本地空壳）', () => {
    expect(DEFAULT_HOST_LOCALE).toBe('zh')
    expect([...HOST_LOCALES]).toEqual(['zh', 'en'])
    expect(normalizeHostLocale('EN-us')).toBe('en')
    expect(tryNormalizeHostLocale('ja')).toBeUndefined()
    expect(preferredLocaleFromAcceptLanguage('en;q=0.3,zh;q=0.9')).toBe('zh')
    expect(hostCopy('en', '中文', 'English')).toBe('English')
    expect(selectHostVariant('zh', { zh: 1, en: 2 })).toBe(1)
  })

  it('类型导出也能被消费者取到（typecheck:tests 是这条判据的一部分）', () => {
    const runtime: LocaleBearingRuntime = { locale: 'en' }
    const resolved: HostLocale = hostLocaleFrom(runtime, 'zh-CN,zh;q=0.9')
    // 运行时的应用内选择必须压过请求头 —— 与叶子包的语义判据同一优先级。
    expect(resolved).toBe('en')
    expect(hostLocaleFrom(undefined, 'en-US,en;q=0.9')).toBe('en')
  })
})
