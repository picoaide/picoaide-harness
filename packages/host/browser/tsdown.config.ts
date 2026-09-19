import { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS } from '../../../scripts/platform-modules.mjs'
import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@picoaide/dsh-browser'

export default defineConfig([
  {
    name: PACKAGE_NAME,
    entry: {
      index: 'src/index.ts',
      invariant: 'src/invariant.ts',
      // surface seam（§16.1）：`@picoaide/dsh-wasm-apps-host` 反向依赖它注册/取得
      // 应用窗口 surface —— 单独一个入口，避免整个 runtime 被拖进那个包。
      surface: 'src/surface.ts',
      // 权限守卫 + 应用 scheme 请求闸门（§16.1）：应用窗口宿主经
      // `@picoaide/dsh-browser/guard` 复用**同一份**实现（浏览器与应用窗口共用）。
      guard: 'src/guard.ts',
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
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-user-approval',
      '@picoaide/dsh-connectors/store',
      'electron',
      'node:crypto',
      'node:fs',
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
