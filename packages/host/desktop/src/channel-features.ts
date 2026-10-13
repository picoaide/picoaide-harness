/**
 * **功能模块变体裁剪的唯一声明**：某个模块被渠道关掉时，产物里要少掉哪些包、
 * 哪些 profile 行、哪些仓库目录。
 *
 * ## 为什么需要它
 *
 * 2026-10-13 的实测结论（见 `docs/decisions/2026-10-13-module-host-face-ownership.md` §2）：
 * `app.asar` 里 `@picoaide/*` 的集合**恰好等于** `packages/host/desktop/package.json`
 * 的 `dependencies` 集合 —— 把模块行从 profile 的 bundle 层摘掉只是"不加载"，
 * **文件照样进包**。所以"关掉一个模块"是**两件事同时做**：
 *
 *   1. **依赖清单**（真开关）：staging 的 `package.json` 里去掉它的包 ⇒ 包不进 asar；
 *   2. **装配面**：profile 的 bundle 层与必需行清单里去掉它的条目 ⇒ 客户端不会去
 *      加载一个已经不存在的包（不清就会 ERR_MODULE_NOT_FOUND / 必需行断言抛错）。
 *
 * 两件事必须由**同一份声明**驱动。分成两份（构建侧一份、运行期一份）就是本仓
 * 记录过的"同一读取面两套并存的真源分裂"。
 *
 * ## 为什么这张表在 `src/` 而不是 `scripts/`
 *
 * 消费方横跨两侧：`scripts/channel-variant.ts`（构建期写变体清单）与
 * `src/{profile,startup-rows}.ts`（运行期过滤 bundle 层 / 必需行）。而
 * `packages/host/desktop/tsconfig.json` 的 `rootDir: "src"` 让 **`src/` 不能
 * import `scripts/`**（TS6059：文件不在 rootDir 下）。所以声明只能落在 `src/`，
 * 由 `scripts/` 反向 import —— 这与 `scripts/channel-build.ts` import
 * `../src/desktop-home.ts` 是同一条既有方向。
 *
 * ## 模块名与 `FEATURE_MODULES` 的关系（**判据钉住，不是约定**）
 *
 * 模块名的唯一真源是 `scripts/channel-constants.ts` 的 `FEATURE_MODULES`；本文件
 * 为了不违反 `rootDir` 约束而**逐字重列**了这三个名字。两份清单的一致性由
 * `scripts/channel-variant.ts` 的 `moduleSurfaceCoverage()`（构建期，两侧都能 import）
 * 逐键对拍，并由 `tests/channel-features.spec.ts` 断言 —— 少一个键 / 多一个键 /
 * 顺序不同都会红。这不是"再抄一份清单"，而是"抄了一份、且有不许漂移的判据"。
 *
 * @module dsh-plugin-desktop/channel-features
 */

/**
 * 一个功能模块在产物里的**摘除面**。
 *
 * 三个列表的分工：
 *   - `packages`：npm 包名（`@scope/name`）。它们同时是 **staging `package.json`
 *     的 `dependencies` 键**、**profile 的 bundle 层名**与**产物缺席判据的主体**
 *     —— 三处逐字同一个字符串，所以只有一份列表；
 *   - `rows`：profile 的**行 id**（`src/startup-rows.ts` 的必需行清单）。
 *     包没了但行还在 ⇒ boot 后的必需行断言抛错（这是**有意的** fail-loud）；
 *   - `directories`：仓库相对目录（prebuild 包表 / CI `workspace-build` 归档清单
 *     的键），构建期用来跳过"被裁掉的包"。
 */
export interface FeatureModuleSurface {
  /** 模块名（= `scripts/channel-constants.ts` 的 `FEATURE_MODULES` 成员，逐字）。 */
  readonly module: string
  /** 该模块随包的 npm 包名（同时是依赖键、bundle 层名）。 */
  readonly packages: readonly string[]
  /** 该模块承载的 profile 行 id。 */
  readonly rows: readonly string[]
  /** 该模块的仓库相对目录（构建期输入表的键）。 */
  readonly directories: readonly string[]
  /**
   * 非空 = 这个模块**今天还不能**被真正裁剪掉，值是原因（构建期 fail-loud）。
   *
   * 为什么留这个字段而不是"支持不了就悄悄不裁"：静默不裁的产物看起来成功了，
   * 但客户拿到的是"声明关了、东西还在"的包 —— 正是本仓最贵的失败形态。
   */
  readonly blockedReason?: string
}

/**
 * 三个功能模块的摘除面 —— 顺序与 `FEATURE_MODULES` 一致（顺序是契约的一部分，
 * 见 `channel-constants.ts` 的 `channelFeaturesVariant()`）。
 *
 * `packages` 与 `rows` 的取值依据（逐条实测/对拍过，不凭记忆写）：
 *   - `packages`：`packages/host/desktop/package.json` 的 `dependencies` 里
 *     `@picoaide/dsh-{capability-center,wasm-apps,wasm-apps-host,connectors}` 四条，
 *     以及 `src/profile.ts` 的 `REQUIRED_BUNDLES` 里的同名字符串；
 *   - `rows`：`src/startup-rows.ts` 的 `REQUIRED_DESKTOP_ROWS` 里与各模块对应的行，
 *     以及各模块自己的 `cordis.patch.yml` 的 `- insert:` 行 id
 *     （`capability-center/cordis.patch.yml` 插 `picoaide-capability-center` 与
 *     `picoaide-skill-telemetry`；`connectors/cordis.patch.yml` 插 `pico-connectors`；
 *     `wasm-apps-host/cordis.patch.yml` 插 `pico-wasm-apps-host`）。
 */
export const FEATURE_MODULE_SURFACES: readonly FeatureModuleSurface[] = [
  {
    module: 'skills',
    packages: ['@picoaide/dsh-capability-center'],
    rows: ['picoaide-capability-center', 'picoaide-skill-telemetry'],
    directories: ['packages/host/capability-center'],
  },
  {
    module: 'apps',
    packages: ['@picoaide/dsh-wasm-apps', '@picoaide/dsh-wasm-apps-host'],
    rows: ['pico-wasm-apps-host'],
    directories: ['packages/client/wasm-apps', 'packages/host/wasm-apps-host'],
    // 2026-10-13（P2）：桌面壳自身**静态 import** 这个模块的宿主包 ——
    // `src/main.ts`（`electron-adapter` / `app-proof` / 两个服务常量）、
    // `src/app-ai-runner.ts`（`ai-chat` + `WASM_APPS_AI_RUNNER_SERVICE`）、
    // `src/wasm-apps-windows.ts`（`WASM_APPS_WINDOW_ADAPTER_SERVICE`）。
    // tsdown 把 `dependencies` 当 external ⇒ 这三个 import 是**启动期**解析，
    // 依赖清单里摘掉它 = `lib/main.js` 起来即 ERR_MODULE_NOT_FOUND（整个客户端
    // 打不开），而不是"少一个面板"。所以本轮**拒绝**构建 apps 关闭的变体，
    // 而不是产出一个起不来的包。要真正支持它，先把这三处改成"模块不在时不接线"
    // （P0-b 决策记录 §6.2 第 4 条登记的就是这三处）。
    blockedReason:
      'packages/host/desktop/src/{main,app-ai-runner,wasm-apps-windows}.ts 仍静态 import '
      + '@picoaide/dsh-wasm-apps-host（依赖清单摘掉它 = 启动期 ERR_MODULE_NOT_FOUND）。'
      + '先把这三处改成"模块不在时不接线"，再从本字段移除本条。',
  },
  {
    module: 'connectors',
    packages: ['@picoaide/dsh-connectors'],
    rows: ['pico-connectors'],
    directories: ['packages/host/connectors'],
  },
] as const

/** `FEATURE_MODULE_SURFACES` 的模块名（顺序 = 契约顺序）。 */
export const FEATURE_MODULE_NAMES: readonly string[] =
  FEATURE_MODULE_SURFACES.map(surface => surface.module)

/**
 * 随包可选模块的**全部** bundle 层包名（不论开关）。
 *
 * 用途只有一处但是承重的：`profile.ts` 的 `desktopBundleList()` 把"不在必需清单里
 * 的名字"当成**第三方 bundle 保留下来**（用户自己装的插件不能被冲掉）。若只把
 * 关闭的模块从必需清单里去掉，它就会从 `$DSH_HOME` 里那份**跨版本保留**的
 * `dsh.profile.bundles` 里被当成第三方**原样加回来** ⇒ 升级到变体版之后客户端
 * 去加载一个已经不随包的模块，启动即失败。所以这一集必须**恒**参与过滤。
 */
export const FEATURE_MODULE_BUNDLES: ReadonlySet<string> =
  new Set(FEATURE_MODULE_SURFACES.flatMap(surface => [...surface.packages]))

/**
 * 渠道声明里 `features` 的最小形状（与 `scripts/channel-constants.ts` 的
 * `ChannelFeatures` 结构相同；刻意不 import 那个类型，理由见文件头）。
 */
export type FeatureSwitches = Readonly<Record<string, boolean | undefined>>

/** 三个模块**全开**（= 官方渠道与"没写 `features`"的渠道）。 */
export const FULL_FEATURE_SWITCHES: FeatureSwitches =
  Object.fromEntries(FEATURE_MODULE_NAMES.map(name => [name, true]))

/**
 * 把渠道声明里的 `features` 规范化成"本文件认识的三个键"，缺省**全开**。
 *
 * **不做形状校验、不抛错**：形状合法性的唯一判据是
 * `scripts/channel-constants.ts` 的 `normalizeChannelFeatures()`（构建期 fail-loud）。
 * 运行期这里只需要回答"我认识的模块里哪些被显式关掉了"，遇到不认识/畸形的取值
 * 一律按"开着"处理 —— 保守方向（多加载一个模块）在这里是**安全**的：真被裁掉的
 * 模块由 `blockedReason` 在构建期拒绝，产物里不会出现"清单说关了、包却不在"的组合。
 * 反过来把畸形值当"关"才是危险的（会导致去加载一个不存在的 bundle）。
 * @param features - 随包渠道配置里的 `features`（不可信输入）。
 * @returns 三个键全在的布尔表。
 */
export function normalizeFeatureSwitches(features: FeatureSwitches | undefined): FeatureSwitches {
  return Object.fromEntries(
    FEATURE_MODULE_NAMES.map(name => [name, features?.[name] !== false]),
  )
}

/**
 * 被显式关掉的模块名（顺序 = {@link FEATURE_MODULE_SURFACES} 的顺序）。
 * @param features - 随包渠道配置里的 `features`（`undefined` = 全开）。
 * @returns 关闭的模块名列表（全开时为空数组）。
 */
export function closedFeatureModules(features: FeatureSwitches | undefined): string[] {
  const switches = normalizeFeatureSwitches(features)
  return FEATURE_MODULE_SURFACES
    .filter(surface => switches[surface.module] === false)
    .map(surface => surface.module)
}

/**
 * 关闭的模块对应的**摘除面**（供构建期派生清单）。
 * @param features - 随包渠道配置里的 `features`。
 * @returns 关闭模块的 surface 列表（全开时为空）。
 */
export function closedFeatureSurfaces(features: FeatureSwitches | undefined): FeatureModuleSurface[] {
  const closed = new Set(closedFeatureModules(features))
  return FEATURE_MODULE_SURFACES.filter(surface => closed.has(surface.module))
}

/**
 * 关闭的模块要摘掉的 bundle 层包名（去重、保持声明顺序）。
 * @param features - 随包渠道配置里的 `features`。
 * @returns 包名列表。
 */
export function prunedFeatureBundles(features: FeatureSwitches | undefined): string[] {
  return [...new Set(closedFeatureSurfaces(features).flatMap(surface => [...surface.packages]))]
}

/**
 * 关闭的模块要摘掉的 profile 行 id（去重、保持声明顺序）。
 * @param features - 随包渠道配置里的 `features`。
 * @returns 行 id 列表。
 */
export function prunedFeatureRows(features: FeatureSwitches | undefined): string[] {
  return [...new Set(closedFeatureSurfaces(features).flatMap(surface => [...surface.rows]))]
}

/**
 * 关闭的模块里**今天还不支持**裁剪的那些（`blockedReason` 非空）。
 * @param features - 随包渠道配置里的 `features`。
 * @returns `{ module, reason }` 列表（全开或全都支持时为空）。
 */
export function blockedFeatureModules(
  features: FeatureSwitches | undefined,
): Array<{ readonly module: string, readonly reason: string }> {
  return closedFeatureSurfaces(features)
    .filter(surface => surface.blockedReason !== undefined)
    .map(surface => ({ module: surface.module, reason: surface.blockedReason as string }))
}
