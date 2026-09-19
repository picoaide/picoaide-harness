/**
 * Host-side UI locale — **compatibility re-export** of the leaf package.
 *
 * 2026-09-20（构建环修复，路线 A）：实现迁到零依赖叶子包
 * `@picoaide/dsh-host-locale`（`packages/host/host-locale`，语义真源
 * = `src/index.ts`，逐字迁移）。
 *
 * 为什么必须留这一层：`@picoaide/dsh-browser` 曾静态 import 本子路径，而
 * `desktop → wasm-apps-host → browser → dsh-plugin-desktop/host-locale → desktop`
 * 是**真实构建环** —— 不存在任何构建顺序能产出全部产物（CI 的 Gate 在
 * `browser/src/shell-pages.ts` 与 `desktop/src/main.ts` 上必然 TS2307）。
 * 现在 browser 与 connectors 直接依赖叶子包，环断开。
 *
 * 保留本文件是为了**不破坏对外 API 面**：desktop 自己的内部 import
 * （`main.ts` 的 `./host-locale.ts`）以及 enterprise/cron 的
 * `dsh-plugin-desktop/host-locale` 继续从这里取，导出面与语义一字不改。
 * 子路径契约由 `tests/host-locale-reexport.spec.ts` 钉住（含运行期解析，
 * 不只是类型层面）。
 *
 * **新增消费方请直接依赖 `@picoaide/dsh-host-locale`** —— 走 desktop 只会在
 * 构建图上多绕一跳。
 *
 * @module dsh-plugin-desktop/host-locale
 */

export * from '@picoaide/dsh-host-locale'
