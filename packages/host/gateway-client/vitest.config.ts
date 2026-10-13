import { defineConfig } from 'vitest/config'

/**
 * 只给预算，**不声明 `include` / `exclude` / `environment`**。
 *
 * 缺省发现面（`**\/*.{test,spec}.?(c|m)[jt]s?(x)`）就是本包的发现面：任何收窄都会让
 * `packages/host/desktop/tests/wait-budget-contract.spec.ts` 的**测试发现面契约**判红
 * —— 那里登记的是"形态"，不是"豁免"（本仓已记录过一次同族事故：`enterprise` 曾用
 * `include: ['tests/**\/*.spec.ts']` 把 `src/` 下的一条 `.test.ts` 静默掉出门禁）。
 * 要么不写，要么在契约里逐字登记丢失清单与理由。
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
})
