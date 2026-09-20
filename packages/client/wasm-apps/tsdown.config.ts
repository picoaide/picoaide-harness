import { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS } from '../../../scripts/platform-modules.mjs'
import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@picoaide/dsh-wasm-apps'

export default defineConfig([
  {
    name: PACKAGE_NAME,
    entry: {
      index: 'src/index.ts',
      invariant: 'src/invariant.ts',
    },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: true,
    sourcemap: true,
    external: [
      '@deepseek-ai/cordis',
    ],
  },
  {
    name: `${PACKAGE_NAME}/client`,
    entry: { client: 'src/client/index.ts' },
    tsconfig: 'tsconfig.client.json',
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    // `@picoaide/dsh-panel-surface` 必须**内联**进本客户端产物，因此它在
    // package.json 里登记为 **devDependency**（2026-09-20）：tsdown 会把
    // `dependencies` 自动当 external，而它不在平台模块表里 —— 外置会让浏览器里的
    // 模块加载器 `require()` 一个不存在的模块，四个面板整个挂不上。
    // 内联是预期语义：它只提供中列装载器与共享视觉语言，跨插件共享的状态只有
    // `document.documentElement` 上的激活态属性，那本来就是全局的。
    sourcemap: true,
    // 平台模块表是单一真源（scripts/platform-modules.mjs，与上游 PLATFORM_MODULES 对拍）：
    // shell 的冻结模块表在运行时解析这些 specifier，打成内联会把 react 装进第二份。
    external: [
      ...PLATFORM_MODULES,
      ...PRELOADED_CLIENT_EXTERNALS,
      '@deepseek-ai/dsh-client-ui-sidebar/client',
    ],
    // Inlined libraries (react/react-dom read process.env.NODE_ENV in their
    // dev branches) need the build-time substitution, like the upstream
    // clientBundle preset — otherwise the browser bundle throws
    // "process is not defined" at factory execution.
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
