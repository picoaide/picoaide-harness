/**
 * 服务端地址的**本地归一**（去掉首尾空白 + 去掉尾部斜杠）。
 *
 * 2026-09-23：本模块是本包（`@picoaide/dsh-wasm-apps-host`）的**唯一实现** ——
 * `handler.ts` / `open-gate.ts` / `window-catalog.ts` 原先各持一份**逐字节相同**的
 * 私有副本（三处注释还互相指认「与 X 同口径」），三份独立实现的代价是：任何一次
 * 收紧/放宽（例如要不要 trim、要不要保留 `//` 之后的部分）只会改到一处，而三处分别
 * 服务于本机请求路由、开屏检查与目录兜底三条互不相干的链路。
 *
 * 语义（有意保持不变，逐字对齐原三份）：
 *  - `String.prototype.trim()` 去掉首尾空白 —— 环境变量/配置里手抄的地址常带尾空格；
 *  - 循环剥掉**所有**尾部 `/`（不是正则：`/[\\/]+$/` 这类回溯正则会触发 CodeQL 的
 *    多项式回溯告警，见 `enterprise/src/server-connector/auth.ts` 的同一处注释）；
 *  - `length > 0` 守卫让**全斜杠**输入（`"/"`、`"//"`）退化成空串而不是死循环。
 *
 * 不在本模块的范围内：`packages/host/desktop/src/desktop-release.ts` 的
 * `trimTrailingSlashes` **故意**少一次 `.trim()`（它的入参是已归一的服务端地址），
 * 不要并进来。
 */

/** 去掉首尾空白与所有尾部斜杠（`//`、`/` 都归一到无尾斜杠形态）。 */
export function normalizeServerURL(input: string): string {
  let value = input.trim()
  while (value.length > 0 && value.endsWith('/')) value = value.slice(0, -1)
  return value
}
