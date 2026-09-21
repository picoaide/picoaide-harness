import { defineConfig } from 'vitest/config'

/**
 * 默认 `node`（宿主半边与纯函数用例足够）；**挂载类**用例（账户行/浮层的真
 * DOM 行为）在文件头用 `// @vitest-environment jsdom` 单独切换 —— 与
 * `@picoaide/dsh-wasm-apps` / `@picoaide/dsh-panel-surface` 同一取舍。
 *
 * `include` 写成"两种目录 × 两种后缀 × ts/tsx"的全集：默认 include 同时收
 * `.spec.*` 与 `.test.*`，只列其中一个会把 `usage-service.test.ts` /
 * `usage-contract.test.ts` 静默漏掉（2026-09-21 审计：未来的 `tests/` 或
 * `.tsx` 用例也不该因为漏列而悄悄不跑）。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}'],
    testTimeout: 15_000,
  },
})
