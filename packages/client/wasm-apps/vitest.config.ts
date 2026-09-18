import { defineConfig } from 'vitest/config'

/**
 * 默认 environment 是 `node`（纯逻辑用例足够）；**挂载类**用例（FIX-42：面板挂载后
 * 真的跑 `useEffect` 取数、真的写入 DOM）在文件头用
 * `// @vitest-environment jsdom` 单独切换 —— 一个包两个环境，靠注释而不是两套配置。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    // 这套用例里有**真的搬大载荷**的几条：1 MiB 逐字节 base64 往返（防
    // `String.fromCharCode(...bytes)` 爆栈）在空载下 ~2.4s、机器一忙就 4s+；
    // 而 vitest 默认 `testTimeout` 是 5s。2026-09-18 的 `yarn check` 上它真的
    // 撞过 5s 超时（同时段另外几个包在并发跑）——「慢」被判成「失败」，门禁随机红。
    // 放到 30s 只影响"真挂了要等多久才报"，不影响任何断言的强度。
    // 与 `@picoaide/dsh-connectors` 的同名取舍一致（那边是真实 socket/spawn）。
    testTimeout: 30_000,
  },
})
