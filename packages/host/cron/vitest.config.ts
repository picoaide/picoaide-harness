import { defineConfig } from 'vitest/config'

/**
 * 显式测试预算（R2-S-5）。
 *
 * 本包的「AND 分支扫描视野」用例要真跑 400 年格里高利周期的扫描（找到 10.5 年后
 * 的真实命中），单次预算本就接近 5 s；`yarn check` 并发 4 个包时（19 个任务）会
 * 超时 ⇒ 表现成 flake。这与本仓给 connectors 提预算（真实 socket/spawn 集成测试）
 * 是同一类处置：**不靠重跑**，把预算写进配置。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    testTimeout: 30_000,
  },
})
