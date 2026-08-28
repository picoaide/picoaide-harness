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
      'gateway-model': 'src/gateway-model.ts',
      'error-reporting': 'src/error-reporting.ts',
      'skill-telemetry': 'src/skill-telemetry.ts',
      bootstrap: 'src/bootstrap.ts',
      'session-service': 'src/session-service.ts',
      // Shared subpath exports consumed by sibling plugins (dsh-account-card):
      // the gateway fetch helper + auth error taxonomy, the loopback trust
      // fence, and the persisted session/config types.
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
      // 品牌名旁的产品版本标签(见 src/client/Brand.tsx BrandName)
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
