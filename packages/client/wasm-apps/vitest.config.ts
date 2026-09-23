import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/** 本包自己的 React 安装副本（唯一实例的锚点，见下面两条 alias 的理由）。 */
const REACT = fileURLToPath(new URL('./node_modules/', import.meta.url))
/** 共享装载器包的**源码**根（不走 `lib/`，见下面 alias 的理由）。 */
const PANEL_SURFACE = fileURLToPath(new URL('../panel-surface/src/', import.meta.url))

/**
 * 默认 environment 是 `node`（纯逻辑用例足够）；**挂载类**用例（FIX-42：面板挂载后
 * 真的跑 `useEffect` 取数、真的写入 DOM）在文件头用
 * `// @vitest-environment jsdom` 单独切换 —— 一个包两个环境，靠注释而不是两套配置。
 *
 * ## 两条 alias（都是"测试必须跑源码 + 只能有一个 React"）
 *
 * 1. **`@picoaide/dsh-panel-surface/*` → 源码**。workspace 依赖默认经 `package.json`
 *    的 `exports` 解析到**已构建的 `lib/`**，于是"改装载器源码、忘了 build"时用例仍
 *    在跑旧产物（装载器与面板是两个包，正是审计 C-01 那类跨包缺陷最需要的回归面）。
 *    `yarn check` 先 build 所以 CI 看不出来，本地单跑就会假绿/假红。
 * 2. **react / react-dom → 本包的副本**。装载器与面板各自声明了 React devDependency，
 *    从 `../panel-surface/` 解析会命中**第二份** React 实例，症状是 hooks 全部读到
 *    `null`（`Cannot read properties of null (reading 'useState')`）—— 挂载类用例
 *    直接崩，与产品缺陷无关。
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^react$/, replacement: `${REACT}react/index.js` },
      { find: /^react\/jsx-runtime$/, replacement: `${REACT}react/jsx-runtime.js` },
      { find: /^react\/jsx-dev-runtime$/, replacement: `${REACT}react/jsx-dev-runtime.js` },
      { find: /^react-dom$/, replacement: `${REACT}react-dom/index.js` },
      { find: /^react-dom\/client$/, replacement: `${REACT}react-dom/client.js` },
      { find: /^react-dom\/test-utils$/, replacement: `${REACT}react-dom/test-utils.js` },
      { find: /^@picoaide\/dsh-panel-surface\/client$/, replacement: `${PANEL_SURFACE}client/index.ts` },
      { find: /^@picoaide\/dsh-panel-surface$/, replacement: `${PANEL_SURFACE}index.ts` },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
    // 这套用例里有**真的搬大载荷**的几条：1 MiB 逐字节 base64 往返（防
    // `String.fromCharCode(...bytes)` 爆栈）在空载下 ~2.4s、机器一忙就 4s+；
    // 而 vitest 默认 `testTimeout` 是 5s。2026-09-18 的 `yarn check` 上它真的
    // 撞过 5s 超时（同时段另外几个包在并发跑）——「慢」被判成「失败」，门禁随机红。
    // 放到 30s 只影响"真挂了要等多久才报"，不影响任何断言的强度。
    // 与 `@picoaide/dsh-connectors` 的同名取舍一致（那边是真实 socket/spawn）。
    testTimeout: 30_000,
  },
})
