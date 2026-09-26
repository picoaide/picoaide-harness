/**
 * R21 F-01：宿主语言解析的**导出面契约**（本包不再持有第二份实现）。
 *
 * 缺陷形态（修前）：`src/locale.ts` 是零依赖叶子包 `@picoaide/dsh-host-locale` 的
 * 一份**手抄镜像**，理由写的是"跨包 import 会把构建顺序绑死" —— 而同一个包的
 * `src/session.ts` 早就在 import `@picoaide/dsh-host-locale/session-events`，
 * `package.json` 与 `scripts/check-workspaces.mjs` 也都登记了这条依赖边。镜像因此
 * 已经漂移：真源导出 `HOST_LOCALES` / `selectHostVariant`，镜像没有，而**全仓没有
 * 任何判据同时读这两份**（`src/locale.spec.ts` 只 `from './locale.ts'` 自测）。
 *
 * 现在的判据是**运行期逐符号对拍**：
 *
 *  1. 本模块的每个导出都必须与叶子包**同一个值**（同一个函数对象 / 同一个常量）——
 *     镜像只要少一个符号、或某个符号的实现分叉，这条就红；
 *  2. 叶子包有的导出，本模块必须有（集合相等，双向）—— 防止"再抄一份缺符号的镜像"；
 *  3. 语义仍由叶子包自己的 spec 钉（`packages/host/host-locale/tests/host-locale.spec.ts`），
 *     本文件刻意**不重复**那些用例：重复的语义断言会让"两份实现各自自洽"重新变成可能。
 *
 * 类型层面的缺失由 `yarn workspace @picoaide/dsh-wasm-apps-host typecheck` 抓（消费方
 * 从 `./locale.ts` 取 `HostLocale` 等类型）；本文件管运行期值面。两者互补，都不是
 * "文件里有没有那段字面量"式的断言。
 */
import { describe, expect, it } from 'vitest'
import * as leaf from '@picoaide/dsh-host-locale'
import * as local from './locale.ts'

/** 只比较**值导出**（类型导出在运行期不存在，由 tsc 负责）。 */
const valueExports = (module: Record<string, unknown>): string[] =>
  Object.keys(module).filter(name => name !== 'default').sort()

describe('wasm-apps-host 的宿主语言解析只有一份实现（re-export 叶子包）', () => {
  it('导出面集合相等（缺符号 = 已经漂移，多符号 = 又抄了一份）', () => {
    expect(valueExports(local)).toEqual(valueExports(leaf))
    // 叶子包的导出面本身不为空（防止"两边都是空对象"这种恒真对拍）。
    expect(valueExports(leaf).length).toBeGreaterThanOrEqual(8)
  })

  it('逐符号恒等：本模块的导出就是叶子包的导出（不是同名的新实现）', () => {
    for (const name of valueExports(leaf)) {
      expect(local[name as keyof typeof local], name).toBe(leaf[name as keyof typeof leaf])
    }
  })

  it('消费方真正用到的那几个符号行为一致（能力断言，不是存在性断言）', () => {
    expect(local.hostLocaleFrom({ locale: 'en' }, 'zh-CN,zh;q=0.9')).toBe('en')
    expect(local.hostLocaleFrom(undefined, 'en-US,en;q=0.9')).toBe('en')
    expect(local.hostLocaleFrom(undefined, undefined)).toBe('zh')
    expect(local.hostCopy('en', '中文', 'English')).toBe('English')
    // 此前镜像缺的两个符号必须在（它们就是漂移的证据）。
    expect([...local.HOST_LOCALES]).toEqual(['zh', 'en'])
    expect(local.selectHostVariant('en', { zh: '中', en: 'EN' })).toBe('EN')
  })

  it('按调用解析（叶子包语义）：同一模块实例先 zh 后 en 都正确', () => {
    const runtime: { locale?: unknown } = { locale: 'zh' }
    expect(local.hostLocaleFrom(runtime)).toBe('zh')
    runtime.locale = 'en'
    expect(local.hostLocaleFrom(runtime)).toBe('en')
  })
})
