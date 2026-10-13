import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
// 变体（功能模块开关）的**构建期唯一真源**：`FEATURES=<变体标识>`（缺省全开）。
// 解析实现在 features.mjs —— 构建链与测试链共用同一份，契约见
// docs/decisions/2026-10-14-webadmin-feature-variant.md。
import { featureDefines, resolveFeaturesFromEnv } from './features.mjs'

const features = resolveFeaturesFromEnv(process.env)

export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  // 逐模块**布尔字面量**（`__FEATURE_SKILLS__` 等）：被关闭模块的路由与懒加载写成
  // `__FEATURE_X__ ? … : …` 时打包器会折叠整个分支 ⇒ 该页面的 chunk 不进 dist。
  // 写成"变体串 + `.includes()`"**不会**被折叠（chunk 照样产出）—— 实测见
  // features.mjs 的 featureGlobalName，产物判据 scripts/check-feature-chunks.mjs。
  define: featureDefines(features),
  build: {
    outDir: 'dist',
    // vendor 分包(性能优化 2026-P):react/react-router 等依赖拆成独立
    // vendor chunk,与业务代码分离。业务代码更新时 vendor 内容不变,
    // 文件名哈希不变 → 浏览器 1 年 immutable 缓存长期命中,回访/发版
    // 只重新下载业务 chunk(通常几 KB~几十 KB)。
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
})
