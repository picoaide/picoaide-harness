import { defineConfig } from 'vitest/config'

/**
 * 默认 `node`（服务契约与纯函数用例足够）；**挂载类**用例（「更多」行与浮层）在文件头
 * 用 `// @vitest-environment jsdom` 单独切换 —— 与 `@picoaide/dsh-wasm-apps` 同一取舍。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    testTimeout: 15_000,
  },
})
