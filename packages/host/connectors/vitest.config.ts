import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 只加预算，**不动发现面**（第十一轮复审 J2-N1）：`include` 与 vitest 缺省的
    // `defaultInclude`（`**/*.{test,spec}.?(c|m)[jt]s?(x)`）不等价，声明它会静默排除
    // `tests/**` 之外的测试文件。本仓已经踩过一次（enterprise 因此掉了一个文件四个
    // 用例），所以四个宿主包统一不声明发现类字段；收窄会被
    // `packages/host/desktop/tests/wait-budget-contract.spec.ts` 的发现面契约判红。
    // 这套用例是**真实 socket / 真实 spawn** 的集成测试：单条用例内部的等待预算
    // 常到 5–8s（等后台轮询、等子进程回传）。vitest 默认的 5s `testTimeout` 比
    // 用例自己的预算还短，于是在 CI（4 vCPU + 13 个包并发）上会把「慢」判成「失败」：
    // 2026-09-15 实测 `audit-connectors` PROBE A 平时 ~500ms，负载下撞 5s 超时，
    // 导致 tag/PR 门禁随机红灯。放到 30s 只影响「真挂了要等多久才报」，不影响断言强度。
    testTimeout: 30_000,
  },
})
