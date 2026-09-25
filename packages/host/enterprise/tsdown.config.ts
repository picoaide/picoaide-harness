import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS } from '../../../scripts/platform-modules.mjs'
import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@picoaide/dsh-enterprise'

// 产品版本号:构建时从仓库根 package.json 读取,经 define 注入 client bundle,
// 供 BrandName 在侧边栏品牌名旁渲染 vX.Y.Z 标签(与安装包/更新检查同源)。
const PRODUCT_VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
).version as string

export default defineConfig([
  {
    name: PACKAGE_NAME,
    entry: {
      index: 'src/index.ts',
      invariant: 'src/invariant.ts',
      'auth-gate': 'src/auth-gate.ts',
      'channel-sync': 'src/channel-sync.ts',
      'gateway-model': 'src/gateway-model.ts',
      'error-reporting': 'src/error-reporting.ts',
      'skill-telemetry': 'src/skill-telemetry.ts',
      bootstrap: 'src/bootstrap.ts',
      'session-service': 'src/session-service.ts',
      // Shared subpath exports consumed by sibling plugins (dsh-account-card):
      // the gateway fetch helper + auth error taxonomy, the loopback trust
      // fence, the persisted session/config types, and the ONE session-identity
      // criterion (`session-identity.ts`) — account-card stamps its usage
      // snapshot with it so a balance can never be rendered under a different
      // account than the one it was fetched for (R16B-01).
      'session-identity': 'src/session-identity.ts',
      'server-connector/auth': 'src/server-connector/auth.ts',
      loopback: 'src/loopback.ts',
      'server-connector/config': 'src/server-connector/config.ts',
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
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-credentials',
      '@sentry/node',
      '@sentry/core',
      '@sentry/utils',
      '@sentry/types',
      'electron',
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
    external: [
      ...PLATFORM_MODULES,
      ...PRELOADED_CLIENT_EXTERNALS,
      '@deepseek-ai/dsh-client-ui-settings/client',
      '@deepseek-ai/dsh-client-ui-layout/client',
      '@deepseek-ai/dsh-client-ui-sidebar/client',
      '@deepseek-ai/dsh-client-ui-conversation/client',
    ],
    // Inlined libraries (react/react-dom read process.env.NODE_ENV in their
    // dev branches) need the substitution at build time, exactly like the
    // upstream clientBundle preset — otherwise the browser bundle throws
    // "process is not defined" at factory execution.
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      // 品牌名旁的产品版本标签(见 src/client/Channel.tsx BrandName)
      'process.env.PICOAI_PRODUCT_VERSION': JSON.stringify(PRODUCT_VERSION),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
