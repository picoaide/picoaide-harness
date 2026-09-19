/**
 * Product home resolution — **compatibility re-export** of the leaf package.
 *
 * 2026-09-20（构建环修复，路线 A 扩展）：实现迁到零依赖叶子包
 * `@picoaide/dsh-host-home`（`packages/host/host-home`，语义真源
 * = `src/index.ts`，逐字迁移；25 条判据一并迁走）。
 *
 * 为什么必须留这一层：`@picoaide/dsh-connectors` 曾 import 本子路径，而
 * `desktop → wasm-apps-host → browser → connectors → desktop` 是**真实构建环**
 * —— 没有任何构建顺序能产出全部产物。现在 connectors 直接依赖叶子包，
 * 环断开；enterprise（5 处）与 cron 仍从这里取（它们不在环上），
 * desktop 自己的内部 import（`main.ts`/`profile.ts`/`desktop-channel.ts`/
 * `diagnostic-export.ts`/`scripts/*` 的 `./desktop-home.ts`）继续走这里 ——
 * 对外 API 面与语义一字不改。
 *
 * 子路径契约由 `tests/desktop-home-reexport.spec.ts` 钉住（含运行期解析，
 * 不只是类型层面；`tests/package.spec.ts` 另有 exports 条目断言）。
 *
 * **新增消费方请直接依赖 `@picoaide/dsh-host-home`** —— 走 desktop 只会在
 * 构建图上多绕一跳。
 *
 * @module dsh-plugin-desktop/desktop-home
 */

export * from '@picoaide/dsh-host-home'
