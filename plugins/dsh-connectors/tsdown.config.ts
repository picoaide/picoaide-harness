import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@picoaide/dsh-connectors'

export default defineConfig([
  {
    name: PACKAGE_NAME,
    entry: {
      index: 'src/index.ts',
      store: 'src/store.ts',
      invariant: 'src/invariant.ts',
      'sales-easy': 'src/sales-easy.ts',
      dingtalk: 'src/dingtalk.ts',
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
    sourcemap: true,
    // Platform module table (loader seed entries) plus every cross-package
    // client module this bundle imports. Anything else would be inlined and
    // split the runtime identity of the framework instance.
    external: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-runtime/client',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-web-react',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-attachment',
      '@deepseek-ai/dsh-client-schema-form',
      '@deepseek-ai/dsh-client-ui-commands/client',
      '@deepseek-ai/dsh-client-ui-input-trigger/client',
      '@deepseek-ai/dsh-client-ui-sidebar/client',
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
