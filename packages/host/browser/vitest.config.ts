import { defineConfig } from 'vitest/config'

/**
 * 显式测试预算（R11-B-02）。
 *
 * 本包原先**没有** `testTimeout`：吃 vitest 缺省的 5s。用例观察的是 Electron 适配器
 * 替身与页面脚本之间的异步链（`window.open` → 标签视图 → 运行期 opLog），在 CI
 * （4 vCPU × 十来个包并发）上「慢」会被判成「失败」，形态与第十轮连接器/桌面两次
 * 同族处置一致：`Error: Test timed out in 5000ms`（还看不出挂在哪条断言上）。
 *
 * 两侧必须**同时**满足：`tests/**` 里的等待型断言已逐处给 `{ timeout: 10_000 }`
 * （进程内状态传播档），30s 是它们的可达上限（等待预算 > 用例预算时预算根本用不满）。
 * 代价只有「真挂了要等多久才报」，断言强度不变。
 *
 * 只加预算，**不动发现面**（第十一轮复审 J2-N1）：`include` 与 vitest 的缺省
 * （`vitest/config` 的 `defaultInclude` = `**\/*.{test,spec}.?(c|m)[jt]s?(x)`）不等价，
 * 声明它会静默排除 `tests/` 之外的测试文件。本仓已经踩过一次
 * （`enterprise/src/server-connector/connector.test.ts` 因此掉出门禁），所以四个
 * 宿主包统一不声明发现类字段；收窄会被
 * `packages/host/desktop/tests/wait-budget-contract.spec.ts` 的「测试发现面契约」判红。
 *
 * （块注释里写 glob 必须转义 `*\/`，否则 `*` + `/` 会提前闭合本注释。）
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
})
