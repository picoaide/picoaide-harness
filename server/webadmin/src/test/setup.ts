import { vi, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'

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
    constructor(status = 0, code = 'INTERNAL', message = '') {
      super(message)
      this.status = status
      this.code = code
    }
  },
}))
