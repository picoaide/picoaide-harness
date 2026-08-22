import { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS } from '../../../scripts/platform-modules.mjs'
import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@picoaide/dsh-enterprise'

export default defineConfig([
  {
    name: PACKAGE_NAME,
    entry: {
      index: 'src/index.ts',
      invariant: 'src/invariant.ts',
      'auth-gate': 'src/auth-gate.ts',
      'gateway-model': 'src/gateway-model.ts',
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
      '@deepseek-ai/dsh-client-ui-attachment',
      '@deepseek-ai/dsh-client-ui-settings/client',
      '@deepseek-ai/dsh-client-ui-layout/client',
      '@deepseek-ai/dsh-client-ui-sidebar/client',
      '@deepseek-ai/dsh-client-ui-conversation/client',
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
