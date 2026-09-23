import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/** 本包的 React 安装副本（跨包源码用例必须共用同一个 React 实例）。 */
const REACT = fileURLToPath(new URL('./node_modules/', import.meta.url))

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
  resolve: {
    alias: [
      { find: /^react$/, replacement: `${REACT}react/index.js` },
      { find: /^react\/jsx-runtime$/, replacement: `${REACT}react/jsx-runtime.js` },
      { find: /^react\/jsx-dev-runtime$/, replacement: `${REACT}react/jsx-dev-runtime.js` },
      { find: /^react-dom$/, replacement: `${REACT}react-dom/index.js` },
      { find: /^react-dom\/client$/, replacement: `${REACT}react-dom/client.js` },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}'],
    testTimeout: 15_000,
  },
})
