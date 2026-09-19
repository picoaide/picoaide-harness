/**
 * `dsh-plugin-desktop/desktop-home` 的**兼容面**契约（2026-09-20 构建环修复，
 * 路线 A 扩展）。
 *
 * 为什么这条断言必须单独存在：`desktop-home` 的实现已迁到零依赖叶子包
 * `@picoaide/dsh-host-home`（`packages/host/host-home`），desktop 这边只剩一行
 * `export *`。语义判据全部随实现迁走且**逐字保留**（叶子包
 * `tests/desktop-home.spec.ts`，25 例），所以本文件刻意**不重复**那些用例 ——
 * 它钉的是另一件事：`enterprise`（5 个文件）与 `cron` 仍然 import
 * `dsh-plugin-desktop/desktop-home`，这条对外子路径必须继续**真的可用**：
 * 值导出在运行期解析到叶子包的实现，函数签名在类型层面原样可见。
 *
 * 三层判据各由不同门禁覆盖，合起来才是完整的 API 面：
 *   1. 语义 —— 叶子包自己的 spec（迁走的那 25 例）；
 *   2. 子路径 → 产物（`lib/desktop-home.js` / `lib/types/desktop-home.d.ts` 真的
 *      存在）—— `verify:closure` 第 1 段逐条断言 package.json exports 的每个目标，
 *      `tests/package.spec.ts` 另有 `./desktop-home` 条目断言；
 *   3. 本文件 —— re-export 链在运行期与类型层面都通（含 workspace 解析）。
 * 类型层面的失败由 `yarn run typecheck:tests`（本包 check 的一环）抓住。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  DEFAULT_DSH_HOME_DISPLAY,
  DSH_HOME_ENV,
  PRODUCT_DSH_HOME_DIR,
  channelDshHomeDir,
  dshHomeSafe,
  isSafeDshHomeDirName,
  isSystemWorkingDirectory,
  resolveDshHome,
} from '../src/desktop-home.ts'

describe('dsh-plugin-desktop/desktop-home 仍然是对外可用的兼容面', () => {
  it('值导出经 re-export 解析到叶子包的实现（不是本地空壳）', () => {
    expect(PRODUCT_DSH_HOME_DIR).toBe('.picoaide-harness')
    expect(DEFAULT_DSH_HOME_DISPLAY).toBe('~/.picoaide-harness')
    expect(DSH_HOME_ENV).toBe('DSH_HOME')
    // 取值链与渠道派生仍是同一份语义（含"派生不得撞官方目录"这条）。
    expect(resolveDshHome(undefined, {}, '/home/user')).toBe(join('/home/user', PRODUCT_DSH_HOME_DIR))
    expect(resolveDshHome(undefined, { [DSH_HOME_ENV]: '/custom/home' }, '/home/user')).toBe('/custom/home')
    expect(channelDshHomeDir('official')).toBe(PRODUCT_DSH_HOME_DIR)
    expect(channelDshHomeDir('acme', { slug: 'Acme-Harness' })).toBe('.acme-harness')
    expect(isSafeDshHomeDirName('.acme-harness')).toBe(true)
    expect(isSafeDshHomeDirName('plain')).toBe(false)
    expect(isSystemWorkingDirectory('/usr/bin')).toBe(true)
    expect(() => dshHomeSafe({ configured: '/' })).toThrow(/unsafe DSH_HOME/u)
  })

  it('类型导出/函数签名原样可见（typecheck:tests 是这条判据的一部分）', () => {
    // 手写签名的赋值（刻意不用 `typeof resolveDshHome` —— 那是自指的，改坏参数
    // 表也照样通过）。`export *` 若丢了这条导出、或签名被改窄，本行编译失败。
    const resolve: (
      configured?: string,
      env?: Record<string, string | undefined>,
      home?: string,
      productDir?: string,
    ) => string = resolveDshHome
    expect(resolve(undefined, {}, '/home/user', '.acme-harness')).toBe(join('/home/user', '.acme-harness'))
    // 类型谓词也必须穿过 re-export（`value is string` 是类型层面的承诺）。
    const narrow: (value: unknown) => value is string = isSafeDshHomeDirName
    expect(narrow('.acme-harness')).toBe(true)
  })
})
