import { defineConfig } from 'vitest/config'

/**
 * 显式测试预算（与 enterprise / foot-menu 同宽）。
 *
 * **这里只加预算，不动发现面**（与 `@picoaide/dsh-enterprise` 的 vitest 配置同一
 * 口径）：本文件**不声明** `include` / `exclude` / `environment`，缺省即发现面 ——
 * 「配置有没有偷偷把某个文件排除掉」由 `packages/host/desktop/tests/wait-budget-contract.spec.ts`
 * 的**测试发现面契约**守住（`vitest list --filesOnly` 的实际发现集合 vs 文件系统上按
 * 缺省 include 语义走出来的集合，逐包对拍）。
 *
 * 本包用例是纯函数/接线断言（DOM 替身不是 jsdom，见 `tests/client-plugin.spec.ts`），
 * 15s 是给 CI（4 vCPU × 十余个包并发）的量级声明，不是等待预算。
 */
export default defineConfig({
  test: {
    testTimeout: 15_000,
  },
})
