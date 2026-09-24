import { defineConfig } from 'vitest/config'

/**
 * 显式测试预算（R11-B-02）。
 *
 * 本包原先**没有** `vitest.config.ts`：与桌面/连接器/定时任务三个包不同，它吃
 * vitest 缺省的 5s `testTimeout`，而 `tests/**` 里的等待型断言也全吃缺省的 1s
 * `timeout`。这些用例观察的是会话服务/深链待办/网关模型同步的异步链（事件派发 →
 * settings 写入 → 凭据落盘），在 CI（4 vCPU × 十来个包并发）上「慢」会被判成
 * 「失败」，形态与本仓已登记两次的同族假红一致（`Error: Test timed out in 5000ms`，
 * 且报错看不出挂在哪条断言上）。
 *
 * 两侧一起给：等待型断言逐处显式 `{ timeout: 10_000 }`（进程内状态传播档），
 * 包级 30s 保证那个预算**可达**（等待预算 > 用例预算时预算用不满）。
 *
 * **这里只加预算，不动发现面**（第十一轮复审 J2-N1，P2）：本文件的第一版同时写了
 * `include: ['tests/**\/*.spec.ts']`，而 vitest 的缺省发现面是
 * `**\/*.{test,spec}.?(c|m)[jt]s?(x)`（`vitest/config` 的 `defaultInclude`）——
 * 于是 `src/server-connector/connector.test.ts`（`validateBootstrap` /
 * `sha256Fingerprint` / `checkFingerprint` / `saveFingerprint` 四条断言）**从门禁里
 * 静默消失**：整包从 62 个文件掉到 61 个，而当时没有任何判据会咬到它。
 *
 * （块注释里写 glob 必须转义 `*\/`，否则 `*` + `/` 会提前闭合本注释 —— 本仓已登记
 * 过同族事故。）
 *
 * 所以本文件**不声明** `include` / `exclude` / `environment`（缺省即发现面）。
 * 「配置有没有偷偷把某个文件排除掉」由
 * `packages/host/desktop/tests/wait-budget-contract.spec.ts` 的**测试发现面契约**
 * 守住：`vitest list --filesOnly` 的实际发现集合 vs 文件系统上按缺省 include 语义
 * 走出来的集合，逐包对拍；任何收窄都必须在契约的豁免表里显式登记理由。
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
})
