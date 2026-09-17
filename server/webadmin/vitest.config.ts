import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
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
