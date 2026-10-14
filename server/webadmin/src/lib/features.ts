/**
 * 前端侧的**变体视图**（只读）：构建期由 `define` 注入，运行期不得改写。
 *
 * 契约见 `docs/decisions/2026-10-14-webadmin-feature-variant.md`。三件事写死在这里：
 *
 *   1. **模块名与顺序是契约**（`skills` / `apps` / `connectors`）：与 Go 侧
 *      `internal/features` 的常量、渠道配置的 `features` 键、Go 的 `-tags` 逐字一致。
 *      `features.test.ts` 钉住这三个字面量（改名 = 换契约，不是重构）。
 *   2. **开关的判定用 `isFeatureEnabled()`**（数据面：侧栏条目、路由登记表）。
 *      但**懒加载与路由分支必须直接写 `__FEATURE_X__` 全局**——打包器只折叠字面量
 *      条件，`isFeatureEnabled('x')` 是函数调用，折不掉 ⇒ 被关闭模块的页面 chunk
 *      照样进 dist（实测：见 `server/webadmin/features.mjs` 的 `featureGlobalName`）。
 *      这条形态由 `features.test.ts` 的"守卫形态自证"钉住。
 *   3. `FEATURES_VARIANT` 是 P0 §5 的**变体标识**（`skills,apps,connectors` / `none` …），
 *      与 Go 的 `-tags`、镜像构建的 `--build-arg FEATURES=` 是同一个串。
 *
 * @module webadmin/lib/features
 */

/** 模块清单 —— **顺序是契约的一部分**（Go `internal/features.AllModules()` 同一顺序）。 */
export const FEATURE_MODULES = ['skills', 'apps', 'connectors'] as const

/** 一个功能模块名。 */
export type FeatureModule = (typeof FEATURE_MODULES)[number]

/**
 * 本产物的**变体标识**（构建期注入）。
 *
 * 用途是把"这份管理端是哪个变体"变成一个可观测的事实（排障/联调时能一眼看出
 * 页面与接口是不是同一个变体）；**不要**拿它去现拼逐模块判定 —— 逐模块判定读
 * {@link FEATURE_ENABLED}（同一份解析的投影）。
 */
export const FEATURES_VARIANT: string = __FEATURES__

/**
 * 逐模块布尔表（三个键**全在**，与构建期 `features.mjs` 的解析结果逐位一致）。
 *
 * 值来自 `define` 注入的字面量；这里的对象是**读**面，改动它不改变产物内容。
 */
export const FEATURE_ENABLED: Readonly<Record<FeatureModule, boolean>> = {
  skills: __FEATURE_SKILLS__,
  apps: __FEATURE_APPS__,
  connectors: __FEATURE_CONNECTORS__,
}

/**
 * 模块是否开启（数据面判定：侧栏条目、路由登记表用它过滤）。
 *
 * ⚠️ **不要**用它守懒加载/路由分支 —— 那是函数调用，打包器折不掉，被关闭模块的
 * 页面代码仍会进 dist。守分支请直接写 `__FEATURE_<MODULE>__`（见模块头注释第 2 条）。
 * @param module - 模块名。
 * @returns 是否开启。
 */
export function isFeatureEnabled(module: FeatureModule): boolean {
  return FEATURE_ENABLED[module]
}
