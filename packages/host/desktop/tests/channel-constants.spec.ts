/**
 * 守卫：`channel-constants.ts` 必须**零 import**，且三个 shell 侧探针必须指向它。
 *
 * 为什么（2026-09-28 一次真实 tag 事故）：`CLIENT_PLATFORM_ASSETS` 与
 * `CHANNEL_ASSET_FILES` 原先写在 `channel-build.ts` 里，而那个模块顶端 import
 * `../src/desktop-home.ts`（后者 `export * from '@picoaide/dsh-host-home'`）⇒
 * 用 `import(file://…/channel-build.ts)` 读常量的三个探针只能在
 * "装了 node_modules 且工作区已构建"的环境里跑。Gate 与三个打包 job 都是那种环境，
 * 所以分支/PR CI 全绿；**release job 只 checkout、不 install 也不 build**
 * ⇒ `v2.8.2-beta.2` 的 tag 流水线红在 "Fetch channel packages"：
 * `Cannot find package '@picoaide/dsh-host-home' imported from …/src/desktop-home.ts`。
 * tag 之前没有任何 CI 能看到这一格（release job 只在 tag 上跑）。
 *
 * 本文件钉住两件事（缺任一条，同一个事故会以同样方式复发）：
 *   ①常量模块自身零 import（连相对 import 都不行 —— 相对 import 一样会把
 *     依赖树/构建产物拉回来）；
 *   ②三个探针真的 import 的是这个模块（改回 `channel-build.ts` 即红）。
 *
 * **能力的真判据在 `scripts/verify-ci-scripts.mjs`**：它在"没有 node_modules 的
 * 隔离副本"里实跑这三个探针的取常量那一段（存在性/文本断言都只是它的补充）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  CHANNEL_TEMPLATE_KEYS,
  FEATURE_MODULES,
  FEATURE_SENTINELS,
  channelFeaturesVariant,
  channelFeaturesVariantAssignment,
  featureSentinel,
  normalizeChannelFeatures,
} from '../scripts/channel-constants.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CONSTANTS = `${REPO_ROOT}/packages/host/desktop/scripts/channel-constants.ts`

/** 三个在 release job（无依赖、无构建产物）里跑的探针。 */
const PROBES = [
  'scripts/ci-channels.sh',
  'scripts/ci-channel-transfer.sh',
  'scripts/ci-build-channel-images.sh',
] as const

const read = (path: string): string => readFileSync(path, 'utf8')

describe('渠道常量模块的零依赖不变量（tag 发布链的基石）', () => {
  it('channel-constants.ts 不含任何 import（含动态 import / require）', () => {
    const source = read(CONSTANTS)
    // 形式判据：任何 `import`/`require(` 出现都算（注释里提到 import 是允许的，
    // 所以先剥注释再判 —— 但**不剥字符串**：这里没有字符串会含这些词）。
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/(^|[^:])\/\/[^\n]*/gu, '$1')
    const hits = [...withoutComments.matchAll(/\b(?:import|require)\b/gu)].map(match => match.index ?? -1)
    expect(
      hits,
      'channel-constants.ts 必须零 import：它是"任何环境都能读到这两份清单"的基石，'
      + '一旦引入 import，release job（不 install 也不 build）会重新报 '
      + 'Cannot find package … ⇒ 整条 tag 发布链红。',
    ).toEqual([])
  })

  it('channel-constants.ts 真的导出这两份清单，且 channel-build.ts 仍然 re-export', () => {
    const constants = read(CONSTANTS)
    expect(constants).toMatch(/export const CLIENT_PLATFORM_ASSETS\s*=/u)
    expect(constants).toMatch(/export const CHANNEL_ASSET_FILES\s*=/u)
    // 打包链路的既有 import 面必须保持不变（十几个调用点直接从 channel-build.ts 取）。
    const build = read(`${REPO_ROOT}/packages/host/desktop/scripts/channel-build.ts`)
    expect(build).toMatch(
      /export \{ CHANNEL_ASSET_FILES, CLIENT_PLATFORM_ASSETS \} from '\.\/channel-constants\.ts'/u,
    )
    expect(build, 'channel-build.ts 不得再自己定义这两份清单（会变成第二个真源）')
      .not.toMatch(/export const (?:CLIENT_PLATFORM_ASSETS|CHANNEL_ASSET_FILES)\b/u)
  })

  it('三个 release-path 探针都 import 零依赖模块，且不再碰 channel-build.ts', () => {
    for (const probe of PROBES) {
      const source = read(`${REPO_ROOT}/${probe}`)
      expect(source, `${probe} 必须指向 channel-constants.ts（零依赖）`)
        .toContain('packages/host/desktop/scripts/channel-constants.ts')
      expect(source, `${probe} 不得再 import channel-build.ts（它依赖工作区包 ⇒ release job 必红）`)
        .not.toContain('packages/host/desktop/scripts/channel-build.ts')
    }
  })
})

/**
 * 渠道功能模块（`features`）的**唯一真源**在单元层的最小判据（2026-10-13）。
 *
 * 完整判据（真跑 `ci-channels.sh` 的正/负例、官方模板键、变异证明）在
 * `scripts/verify-ci-scripts.mjs` 第 3c 节；这里钉住的是**语义本身**，让
 * `yarn check` 在不开根守卫的场合也能拦住"缺省全开 → 缺省全关"这一类改动。
 * 契约见 `docs/decisions/2026-10-13-channel-feature-modules.md`。
 */
describe('渠道功能模块清单与规范化（features 的唯一真源）', () => {
  it('缺省全开，且写与不写等价', () => {
    const all = Object.fromEntries(FEATURE_MODULES.map(module => [module, true]))
    expect(normalizeChannelFeatures(undefined)).toEqual(all)
    expect(normalizeChannelFeatures(all)).toEqual(all)
    expect(channelFeaturesVariant(normalizeChannelFeatures(undefined))).toBe(FEATURE_MODULES.join(','))
    expect(channelFeaturesVariantAssignment(normalizeChannelFeatures(undefined))).toBe(`FEATURES=${FEATURE_MODULES.join(',')}`)
  })

  it('显式关闭只影响被声明的模块；全关 = none', () => {
    expect(normalizeChannelFeatures({ [FEATURE_MODULES[0]]: false }))
      .toEqual(Object.fromEntries(FEATURE_MODULES.map((module, index) => [module, index !== 0])))
    const allOff = normalizeChannelFeatures(Object.fromEntries(FEATURE_MODULES.map(module => [module, false])))
    expect(channelFeaturesVariant(allOff)).toBe('none')
    expect(channelFeaturesVariantAssignment(allOff)).toBe('FEATURES=none')
  })

  it('未知模块名 / 非布尔 / 不是对象一律抛错（不静默吞掉）', () => {
    for (const raw of [
      { unknownModule: true },
      { [FEATURE_MODULES[0]]: 'false' },
      { [FEATURE_MODULES[0]]: 0 },
      [FEATURE_MODULES[0]],
      FEATURE_MODULES[0],
      null,
    ]) {
      expect(() => normalizeChannelFeatures(raw), `应拒绝 ${JSON.stringify(raw)}`).toThrow(/features/u)
    }
  })

  it('哨兵串命名从模块清单派生，且官方模板键逐模块列出 features.<module>', () => {
    for (const module of FEATURE_MODULES) {
      expect(featureSentinel(module)).toBe(`picoaide.feature.${module}.v1`)
      expect(FEATURE_SENTINELS[module]).toBe(featureSentinel(module))
      // 官方渠道 = 新增渠道的模板：少一行，拷贝模板的渠道就看不到有哪几个模块可关。
      expect(CHANNEL_TEMPLATE_KEYS).toContain(`features.${module}`)
    }
  })
})
