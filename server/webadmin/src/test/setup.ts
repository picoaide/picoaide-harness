import { vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'

// findBy*/waitFor 的默认预算 1000ms 在 CI / 4 路并行负载下不够（2026-09-17 独立
// 审计实测多处：三段链式请求的页面约 1.2s、懒 chunk 场景 1.2~2s 才就绪）。
// 全局提到 5s —— 判据不变，只是"等多久才算失败"；用例级 { timeout } 仍可覆盖。
configure({ asyncUtilTimeout: 5000 })

afterEach(() => cleanup())

// jsdom 缺失 ResizeObserver;recharts/VChart 依赖它做容器测量。
// 测试只需无操作桩(图表内部渲染不在组件测试断言范围内)。
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!(globalThis as any).ResizeObserver) {
  ;(globalThis as any).ResizeObserver = RO
}

// Radix Select 依赖 pointer capture;jsdom 未实现(审计2026-E2)
if (typeof Element !== 'undefined' && !Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
}

// 页面级测试统一 mock 网络层(src/api.ts request):接口行为已由 Go 侧
// 测试与 E2E 覆盖,组件测试只验证 UI 渲染与交互驱动。
// 注意: 常量(ADMIN_API/CLIENT_API)必须与 lib/api-paths.ts 真源一致,
// 页面从 ../api re-export 读取,测试端 mock 未提供会报「No export defined」。
vi.mock('../api', () => ({
  request: vi.fn(),
  setCsrf: vi.fn(),
  setOnUnauthorized: vi.fn(),
  login: vi.fn(),
  loginMFA: vi.fn(),
  me: vi.fn(),
  logout: vi.fn(),
  ADMIN_API: '/api/server/admin',
  CLIENT_API: '/api/client/v2',
  ApiError: class extends Error {
    code: string
    status: number
    // 2026-09-16:真实 ApiError 增加了可选 detail 段(错误上报测试事件的
    // DNS/CONNECT/TLS/TIMEOUT/HTTP_4XX/HTTP_5XX 分类放在这里)。替身必须与
    // 真源同形,否则页面里 `err.detail.kind` 永远 undefined,失败分类静默丢失。
    detail?: Record<string, unknown>
    constructor(status = 0, code = 'INTERNAL', message = '', detail?: Record<string, unknown>) {
      super(message)
      this.status = status
      this.code = code
      this.detail = detail
    }
  },
}))
