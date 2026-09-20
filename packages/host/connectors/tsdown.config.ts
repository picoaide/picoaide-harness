import { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS } from '../../../scripts/platform-modules.mjs'
import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@picoaide/dsh-connectors'

export default defineConfig([
  {
    name: PACKAGE_NAME,
    entry: {
      index: 'src/index.ts',
      store: 'src/store.ts',
      invariant: 'src/invariant.ts',
      'user-scope': 'src/user-scope.ts',
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
      '@deepseek-ai/dsh-mcp-client',
      // Audit R4/N3: the redirect fence patches
      // `StreamableHTTPClientTransport.prototype`. `dsh-mcp-client` is external
      // and constructs that transport from ITS OWN import of this package, so
      // inlining a second copy here would create a class object the fence never
      // touches — the fix would silently disappear in the packaged app while
      // every src-level test still passed.
      '@modelcontextprotocol/sdk',
      'node:child_process',
      'node:crypto',
      'node:fs',
      'node:http',
      'node:net',
      'node:os',
      'node:path',
      'node:url',
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
    // Platform module table (loader seed entries) plus every cross-package
    // client module this bundle imports. Anything else would be inlined and
    // split the runtime identity of the framework instance.
    external: [
      ...PLATFORM_MODULES,
      ...PRELOADED_CLIENT_EXTERNALS,
      '@deepseek-ai/dsh-client-ui-commands/client',
      '@deepseek-ai/dsh-client-ui-input-trigger/client',
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
