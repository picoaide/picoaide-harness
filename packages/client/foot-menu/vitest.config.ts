import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * 默认 `node`（服务契约与纯函数用例足够）；**挂载类**用例（「更多」行与浮层）在文件头
 * 用 `// @vitest-environment jsdom` 单独切换 —— 与 `@picoaide/dsh-wasm-apps` 同一取舍。
 *
 * `resolve.alias`：`@picoaide/dsh-panel-surface/client` 指向**源码**而不是 `lib/`。
 *
 * 为什么（2026-09-25 审计 FIX-29 P2）：`panel-focus-handoff.spec.tsx` 要同时跑真装载器
 * 与真浮层，而判据必须咬住**源码** —— 指向 `lib/` 时，"删掉 `container.focus()`"或
 * "关闭时不归还焦点"这类变异会被构建产物里那份旧代码挡住，用例照样绿（假绿），
 * 且本地 `vitest run` 的结果取决于上一次构建的时间。删掉这个 alias 即可回到按包名
 * 解析（`lib/client.js`）的旧行为。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@picoaide/dsh-panel-surface/client': fileURLToPath(
        new URL('../panel-surface/src/client/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    testTimeout: 15_000,
  },
})
