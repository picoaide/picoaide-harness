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
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    testTimeout: 30_000,
  },
})
