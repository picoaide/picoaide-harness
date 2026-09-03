import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  // 品牌资产从仓库根 brands/official/ 编译期注入(单一权威源)。
  // dev 模式文件服务需放行仓库根(默认只允许项目根内文件)。
  server: {
    fs: {
      allow: [fileURLToPath(new URL('../..', import.meta.url))],
    },
  },
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
