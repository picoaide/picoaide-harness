/// <reference types="node" />
/**
 * **随包产物断言**：真正发给客户端的那份 bundle（`lib/client.js`）里是 access 三模式，
 * 而不是旧的 `visible` / `login_required`。
 *
 * 为什么单独立一条（与本包其余用例的分工）：其余用例跑的是 `src/**` 的源码，
 * 而客户端拿到的是 tsdown 打出来的 CJS bundle。源码改对、产物没重建（或构建配置漏了
 * 新模块）时，源码用例全绿而线上依旧是旧界面 —— 这是本仓记录过的"存在性断言=假绿"
 * 的同族形态。这条用例把"发出去的那份字节"也钉住。
 *
 * 断言口径刻意选**只有新实现才能产生**的字面量，避开两种会误判的词：
 *   - `REMOVED_APP_CONFIG_FIELDS` 里**故意**留着 `'visible'` / `'login_required'`
 *     两个字符串（字段集合断言要用）⇒ 不能断言"产物里没有这两个词"；
 *   - `resolveAccess` 的**过渡兼容**分支会读 `row.login_required` ⇒ 同理。
 * 因此这里查的是**旧 UI 专有的类名与文案**：旧复选框的 `pico-app-center-visible` /
 * `pico-app-center-login-required` 类名、「在应用中心可见」/「需要登录」/「Login required」
 * 这些只有被删掉的那两个勾选框才会产生。它们缺席 = 旧控件真的没了。
 *
 * **陈旧产物闸**：产物比 `src/**` 旧就直接红（提示先 `yarn build`），
 * 否则"改了源码没重建"会被这条用例误判为通过。
 *
 * ---- 变异验证 ----
 *   - 把 `PublishForm.tsx` 的访问级别三选一改回 `visible` + `login_required` 勾选框并重建
 *     ⇒ 「旧控件专有类名/文案缺席」红；
 *   - 删掉 `lib/client.js`（或构建配置漏了 client 入口）⇒ 「产物存在」红；
 *   - 改源码后不重建就跑 `vitest`（不跑 `check`）⇒ 「产物不旧于源码」红。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** 包根：从本文件（`src/client/`）往上两级。 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BUNDLE_PATH = join(PACKAGE_ROOT, 'lib', 'client.js')

/** 递归收集目录下所有文件的 mtime 最大值（毫秒）。 */
function newestMtimeMs(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestMtimeMs(full))
    else if (entry.isFile()) newest = Math.max(newest, statSync(full).mtimeMs)
  }
  return newest
}

/**
 * 读产物。**不存在就抛**（不 skip）：`check` 的次序是 build → test，
 * 产物缺席说明构建真的坏了，必须有人看见。
 * @returns bundle 文本。
 */
function readBundle(): string {
  try {
    return readFileSync(BUNDLE_PATH, 'utf8')
  } catch (cause) {
    throw new Error(`读不到 ${BUNDLE_PATH}（${cause instanceof Error ? cause.message : String(cause)}）。先跑 \`corepack yarn workspace @picoaide/dsh-wasm-apps build\`。`)
  }
}

const bundle = readBundle()

describe('随包产物：发给客户端的 bundle 里是 access 三模式', () => {
  it('产物不旧于源码（改了源码没重建 ⇒ 红，而不是拿旧产物报绿）', () => {
    const srcNewest = newestMtimeMs(join(PACKAGE_ROOT, 'src'))
    const bundleMtime = statSync(BUNDLE_PATH).mtimeMs
    expect(
      bundleMtime,
      `lib/client.js 比 src/** 旧（产物 ${new Date(bundleMtime).toISOString()} < 源码 ${new Date(srcNewest).toISOString()}）：先重建再跑用例`,
    ).toBeGreaterThanOrEqual(srcNewest)
  })

  it('新的三选一访问级别控件在产物里（单选组的类名前缀 + 三种模式的选项文案）', () => {
    // 类名是模板拼出来的（`pico-app-center-access-${mode}`），因此查前缀。
    expect(bundle).toContain('pico-app-center-access-')
    // 三个选项的 zh 文案（`access` 三模式）必须都在。
    expect(bundle).toContain('公开（无需登录）')
    expect(bundle).toContain('登录后使用（默认全员）')
    expect(bundle).toContain('仅白名单用户')
    // 帮助文字里"平台不比对名单"这句在产物里（R24 的用户可见面）。
    expect(bundle).toContain('不比对名单')
  })

  it('旧控件的专有类名与文案在产物里彻底消失（visible 勾选 / login_required 勾选）', () => {
    // 旧复选框的类名（旧实现里是字面量，新实现不可能产生）。
    expect(bundle).not.toContain('pico-app-center-visible')
    expect(bundle).not.toContain('pico-app-center-login-required')
    // 旧控件的中英文案。
    expect(bundle).not.toContain('在应用中心可见')
    expect(bundle).not.toContain('Visible in the App Center')
    expect(bundle).not.toContain('Login required')
    expect(bundle).not.toContain('需要登录')
  })

  it('产物里的访问级别文案是 access 三模式（不是 login_required 语义）', () => {
    expect(bundle).toContain('Public (no sign-in)')
    expect(bundle).toContain('Signed-in users (everyone by default)')
    expect(bundle).toContain('Whitelist only')
    // 目录条目的访问级别徽标与「已下架」状态也在产物里。
    expect(bundle).toContain('已下架')
    expect(bundle).toContain('data-access')
  })
})
