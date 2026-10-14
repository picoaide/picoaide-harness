import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'
// 变体开关与构建链**同一份解析**（features.mjs）：测试里读到的开关必须逐位等于
// 构建时注入的那一份，否则"按变体给期望"的判据测的是一个不存在的产物。
// `FEATURES=none npm test` = 用全关变体的期望跑同一套用例（缺省全开）。
import { featureDefines, resolveFeaturesFromEnv } from './features.mjs'

const features = resolveFeaturesFromEnv(process.env)

// 这里**刻意不挂** @vitejs/plugin-react（vite.config.ts 的构建链仍然挂它）：
// vitest 4 自带 vite 8（rolldown/oxc），而 plugin-react@4 走 babel，会给 vite 塞
// `esbuild` 与 `optimizeDeps.esbuildOptions` —— vite 8 这两个选项都已废弃，于是每次
// 跑测试都在开头打两行 deprecation 警告，并明说 oxc 选项生效、esbuild 选项被忽略。
// 也就是说该插件在这里**已经是空转**：TSX 由 oxc 转换（jsx: automatic）。
// 去掉它等于让「实际生效的转换链」与「配置里声明的」一致，同时消掉那两行警告。
// 注意：构建链（vite 5 + plugin-react）一个字没动 —— 两者是各自的 vite 实例。
export default defineConfig({
  define: featureDefines(features),
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    css: false,
    // 用例级预算（2026-09-17 独立审计）：默认 5000ms 与"等待预算"同量级 ——
    // 在 waitFor/findBy 上写 `{ timeout: 5000 }` 等于没写：等待还没到点、用例先超时。
    // 与 packages/host/connectors/vitest.config.ts 同口径（那里是真实 socket 套件，
    // 取值 30_000）。放宽的是**失败判定时间**，不放宽任何断言口径。
    testTimeout: 30_000,
  },
})
