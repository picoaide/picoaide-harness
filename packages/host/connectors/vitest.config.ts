import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // 这套用例是**真实 socket / 真实 spawn** 的集成测试：单条用例内部的等待预算
    // 常到 5–8s（等后台轮询、等子进程回传）。vitest 默认的 5s `testTimeout` 比
    // 用例自己的预算还短，于是在 CI（4 vCPU + 13 个包并发）上会把「慢」判成「失败」：
    // 2026-09-15 实测 `audit-connectors` PROBE A 平时 ~500ms，负载下撞 5s 超时，
    // 导致 tag/PR 门禁随机红灯。放到 30s 只影响「真挂了要等多久才报」，不影响断言强度。
    testTimeout: 30_000,
  },
})
