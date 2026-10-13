import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FEATURE_ENABLED, FEATURE_MODULES, FEATURES_VARIANT, isFeatureEnabled, type FeatureModule } from './features'

// ---------------------------------------------------------------------------
// P3 变体（2026-10-14）：开关表自洽 + **守卫形态自证**
//
// 契约：docs/decisions/2026-10-14-webadmin-feature-variant.md
//
// 这个文件判两件事（都不依赖产物，毫秒级；产物级的那条在
// `scripts/check-feature-chunks.mjs`，它真跑两次 `vite build` 再断言 chunk 的有无）：
//
//   ① 开关表自洽：`FEATURES_VARIANT`（注入的变体标识）与 `FEATURE_ENABLED`（逐模块布尔）
//      必须来自同一份解析 —— 一个是"3 个布尔按顺序拼回去"，另一个是 3 个布尔本身；
//      两处漂移（例如有人手改 define）在这里红。
//   ② 守卫形态：模块页的 `import()` **必须**写在 `__FEATURE_<MODULE>__ ? lazy(…) : …`
//      里。这条是产物级判据的**前置条件**：打包器只折叠字面量条件，一旦有人改成
//      `isFeatureEnabled('x') ? lazy(…) : …`，产物判据会红，但那条红跑一次要几十秒；
//      这里先把形态本身钉住，失败信息也直接指向"该怎么写"。
// ---------------------------------------------------------------------------

/**
 * 定位 `src/App.tsx`。
 *
 * 与 `routes.test.ts` / `nav.test.ts` 同款：不用 `import.meta.url`（jsdom 下它是
 * `http://localhost/...`），从 cwd 向上找前端源码标记；找不到必须 throw
 * （静默跳过 = 关掉判据）。
 * @returns App.tsx 的绝对路径。
 */
function findAppTsx(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'src', 'App.tsx'))) return join(dir, 'src', 'App.tsx')
    if (existsSync(join(dir, 'webadmin', 'src', 'App.tsx'))) return join(dir, 'webadmin', 'src', 'App.tsx')
    dir = resolve(dir, '..')
  }
  throw new Error(`找不到 App.tsx（cwd=${process.cwd()}）：守卫形态判据必须可读真源`)
}

const APP_PATH = findAppTsx()
const APP_SRC = readFileSync(APP_PATH, 'utf8')

/**
 * **期望**：每个模块的页面模块说明符（相对 App.tsx）。
 *
 * 手写而不是从别处派生 —— 这条判据要独立说出"哪些页面属于哪个模块"，再由 App.tsx 的
 * 守卫形态去对拍。改模块边界（把某页挪到别的模块、或新增模块页）必须同时改这里。
 */
const MODULE_PAGE_IMPORTS: Readonly<Record<FeatureModule, readonly string[]>> = {
  skills: ['./pages/CapabilityCenter'],
  apps: [
    './pages/app-center/AppCenterLayout',
    './pages/app-center/Apps',
    './pages/app-center/OpensBoard',
    './pages/app-center/Limits',
  ],
  connectors: ['./pages/Connectors'],
}

/** `__FEATURE_<MODULE>__ ? lazy(() => import('<spec>')) : …` 的全部匹配（含区间）。 */
function scanGuardedLazyImports(src: string): Array<{ module: FeatureModule; spec: string }> {
  const out: Array<{ module: FeatureModule; spec: string }> = []
  const re = /__FEATURE_([A-Z]+)__\s*\?\s*lazy\(\s*\(\s*\)\s*=>\s*import\(\s*'([^']+)'\s*\)\s*\)/gu
  for (const m of src.matchAll(re)) out.push({ module: m[1]!.toLowerCase() as FeatureModule, spec: m[2]! })
  return out
}

/** 源码里 `import('<spec>')` 的全部出现次数（含被守卫与未被守卫的）。 */
function countDynamicImports(src: string, spec: string): number {
  return [...src.matchAll(new RegExp(`import\\(\\s*'${spec.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}'\\s*\\)`, 'gu'))].length
}

describe('变体开关表（P3 · 构建期 define 注入）', () => {
  it('模块名字面量与顺序是契约（与 Go internal/features、渠道 features 逐字一致）', () => {
    // 改名 = 换契约（Go 侧 `features_test.go` 逐字钉同样三个串；渠道配置的 features 键、
    // `-tags` 列表都是它）。写成数组而不是 Set：**顺序**也是契约（变体标识按它拼）。
    expect([...FEATURE_MODULES]).toEqual(['skills', 'apps', 'connectors'])
  })

  it('开关表三个键全在、值都是布尔（缺键会让 isFeatureEnabled 返回 undefined 而静默失守）', () => {
    expect(Object.keys(FEATURE_ENABLED).sort()).toEqual([...FEATURE_MODULES].sort())
    for (const module of FEATURE_MODULES) {
      expect(typeof FEATURE_ENABLED[module], `${module} 的开关值不是布尔：${String(FEATURE_ENABLED[module])}`).toBe('boolean')
      expect(isFeatureEnabled(module)).toBe(FEATURE_ENABLED[module])
    }
  })

  it('变体标识 ⟺ 逐模块布尔（两处必须来自同一份解析，漂移即红）', () => {
    const enabled = FEATURE_MODULES.filter((m) => FEATURE_ENABLED[m])
    const expectedVariant = enabled.length === 0 ? 'none' : enabled.join(',')
    expect(
      FEATURES_VARIANT,
      `注入的变体标识 ${JSON.stringify(FEATURES_VARIANT)} 与逐模块开关 ${JSON.stringify(FEATURE_ENABLED)} 不一致：`
        + '两者必须由同一份解析（server/webadmin/features.mjs）派生，不得各写一份',
    ).toBe(expectedVariant)
    // 变体标识的形态自证：`none` 或逗号分隔，且不含空格（Go `-tags` 的编码约束）。
    expect(FEATURES_VARIANT === 'none' || /^[a-z]+(?:,[a-z]+)*$/u.test(FEATURES_VARIANT)).toBe(true)
  })
})

describe('模块页守卫形态（产物级判据的前置条件）', () => {
  it('每个模块页的 import() 都必须写在 `__FEATURE_<MODULE>__ ? lazy(…) : …` 里（形态错 ⇒ 产物里的 chunk 不会被折掉）', () => {
    const guarded = scanGuardedLazyImports(APP_SRC)
    // 逆映射：说明符 → 该守卫声明的模块（同一说明符重复出现即视为漂移，下面判）。
    const guardModuleOf = new Map<string, string[]>()
    for (const entry of guarded) {
      guardModuleOf.set(entry.spec, [...(guardModuleOf.get(entry.spec) ?? []), entry.module])
    }

    const problems: string[] = []
    let declaredTotal = 0
    for (const module of FEATURE_MODULES) {
      const specs = MODULE_PAGE_IMPORTS[module]
      expect(specs.length, `模块 ${module} 的期望页面清单是空的（判据自己的表塌了）`).toBeGreaterThan(0)
      declaredTotal += specs.length
      for (const spec of specs) {
        const occurrences = countDynamicImports(APP_SRC, spec)
        if (occurrences !== 1) {
          problems.push(`${spec} 在 App.tsx 里出现 ${occurrences} 次动态 import（必须恰好 1 次，且在被守卫的懒加载里）`)
          continue
        }
        const modules = guardModuleOf.get(spec) ?? []
        if (modules.length !== 1 || modules[0] !== module) {
          problems.push(
            `${spec} 的守卫形态不对：期望 \`__FEATURE_${module.toUpperCase()}__ ? lazy(() => import('${spec}')) : …\`，`
              + `实际捕获到 ${modules.length === 0 ? '（没有守卫）' : modules.join(' / ')}`,
          )
        }
        if (new RegExp(`from\\s+'${spec.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}'`, 'u').test(APP_SRC)) {
          problems.push(`${spec} 还被**静态** import 了一份（静态引用会把页面代码无条件拉进产物，守卫形同虚设）`)
        }
      }
    }
    // 反向：App.tsx 里被守卫的懒加载不得有"期望表之外"的（新增模块页忘了登记 ⇒ 红）。
    const unexpected = [...guardModuleOf.keys()].filter(
      (spec) => !FEATURE_MODULES.some((m) => MODULE_PAGE_IMPORTS[m].includes(spec)),
    ).sort()
    if (unexpected.length > 0) problems.push(`App.tsx 里出现了期望表之外的守卫懒加载：${unexpected.join(', ')}`)

    expect(
      problems,
      '模块页的守卫形态不对（打包器只折叠**字面量**条件；走 isFeatureEnabled() 之类的函数调用时，'
        + '被关闭模块的页面 chunk 照样进 dist）：\n' + problems.map((p) => `  · ${p}`).join('\n'),
    ).toEqual([])

    // 非空自证：守卫扫描必须真的扫到东西（正则退化时"零命中"不许全绿）。
    expect(guarded.length, `App.tsx 里扫不到任何被守卫的懒加载（扫描器退化？路径=${APP_PATH}）`).toBe(declaredTotal)
  })
})
