/**
 * Host-side UI locale for the copy this plugin renders itself (the "please sign
 * in" / "app unavailable" pages and the local route errors).
 *
 * **权威 = `@picoaide/dsh-host-locale`**（零依赖叶子包 `packages/host/host-locale`，
 * 契约：宿主侧语言来源唯一）。本文件是它在**本包内的 re-export**。
 *
 * 2026-09-26（R21 F-01）：此前这里是叶子包的一份**手抄镜像**，模块头写的理由是
 * "跨包 import 会把构建顺序绑死"。该理由已被**同一个包**证伪：
 * `src/session.ts` 早就 import `@picoaide/dsh-host-locale/session-events`，
 * `package.json` 的 `dependencies` 与 `scripts/check-workspaces.mjs` 的 `needs`
 * 也都登记了这条边 —— 而镜像已经漂移（缺 `HOST_LOCALES` / `selectHostVariant`
 * 两个导出，且没有任何判据同时读两份）。抄第二份实现正是本仓记录过两次的 bug 类。
 *
 * 两条规则因此**只有一份实现**（叶子包 `src/index.ts`，语义判据在
 * `packages/host/host-locale/tests/host-locale.spec.ts`）：
 *
 *  1. 解析顺序 = 探测到的 `desktopRuntime.locale`（用户应用内选择，权威）
 *     → 请求的 `Accept-Language` → 产品默认 `zh`；
 *  2. **按调用解析，禁止模块级冻结**：语言可以在应用运行中改变，而已经打开的
 *     应用页面会被重新加载 —— 任何把首次解析结果钉进模块常量的写法都会让
 *     "切了语言但页面还是旧语言"（本仓已记录两次的 bug 类）。
 *
 * 导出面契约由 `src/locale-reexport.spec.ts` 钉住（逐符号对拍叶子包，而不是
 * "本文件里有哪些字面量"）。
 *
 * @module @picoaide/dsh-wasm-apps-host/locale
 */

export * from '@picoaide/dsh-host-locale'
