import { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS } from '../../../scripts/platform-modules.mjs'
import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@picoaide/dsh-cron'

export default defineConfig([
  {
    name: PACKAGE_NAME,
    entry: {
      index: 'src/index.ts',
      cron: 'src/cron.ts',
      jobs: 'src/jobs.ts',
      protocol: 'src/protocol.ts',
      'host-ledger': 'src/host-ledger.ts',
      'host-scheduler': 'src/host-scheduler.ts',
      'host-executor': 'src/host-executor.ts',
      'host-routes': 'src/host-routes.ts',
      service: 'src/service.ts',
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
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/schemastery',
      'node:crypto',
      'node:fs',
      'node:http',
      'node:os',
      'node:path',
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
    sourcemap: true,
    // `@picoaide/dsh-panel-surface` 必须**内联**进本客户端产物，因此它在
    // package.json 里登记为 **devDependency**（2026-09-20）：tsdown 会把
    // `dependencies` 自动当 external，而它不在平台模块表里 —— 外置会让浏览器里的
    // 模块加载器 `require()` 一个不存在的模块，四个面板整个挂不上（实测症状：
    // 侧边栏点了没反应、控制台一条 module-not-found）。
    // 内联是预期语义：它只提供中列装载器与共享视觉语言，跨插件共享的状态只有
    // `document.documentElement` 上的激活态属性，那本来就是全局的。
    // `@picoaide/dsh-panel-surface` 必须**内联**进本客户端产物，因此它在
    // package.json 里登记为 **devDependency**（2026-09-20）：tsdown 会把
    // `dependencies` 自动当 external，而它不在平台模块表里 —— 外置会让浏览器里的
    // 模块加载器 `require()` 一个不存在的模块，四个面板整个挂不上。
    // 内联是预期语义：它只提供中列装载器与共享视觉语言，跨插件共享的状态只有
    // `document.documentElement` 上的激活态属性，那本来就是全局的。
    // Platform module table (loader seed entries) plus every cross-package
    // client module this bundle imports. Anything else would be inlined and
    // split the runtime identity of the framework instance.
    external: [
      ...PLATFORM_MODULES,
      ...PRELOADED_CLIENT_EXTERNALS,
      '@deepseek-ai/dsh-client-ui-settings/client',
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
