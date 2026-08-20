import { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS } from '../../scripts/platform-modules.mjs'
import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@picoaide/dsh-task'

export default defineConfig([
  {
    name: PACKAGE_NAME,
    entry: {
      index: 'src/index.ts',
      tasks: 'src/tasks.ts',
      protocol: 'src/protocol.ts',
      'host-ledger': 'src/host-ledger.ts',
      'host-runner': 'src/host-runner.ts',
      'host-service': 'src/host-service.ts',
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
    // Platform module table (loader seed entries) plus every cross-package
    // client module this bundle imports.
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
