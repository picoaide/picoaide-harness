import { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS } from '../../../scripts/platform-modules.mjs'
import { defineConfig } from 'tsdown'

const PACKAGE_NAME = 'dsh-plugin-desktop'

export default defineConfig([
  {
    name: PACKAGE_NAME,
    entry: {
      index: 'src/index.ts',
      'module-resolution': 'src/module-resolution.ts',
      'asar-spawn': 'src/asar-spawn.ts',
      'asar-file-system': 'src/asar-file-system.ts',
      'asar-guidance': 'src/asar-guidance.ts',
      'desktop-home': 'src/desktop-home.ts',
      profile: 'src/profile.ts',
      'desktop-plugins': 'src/desktop-plugins.ts',
      diagnostics: 'src/diagnostics.ts',
      'diagnostic-export-worker': 'src/diagnostic-export-worker.ts',
      runtime: 'src/runtime.ts',
      'electron-runtime': 'src/electron-runtime.ts',
      'update-checker': 'src/update-checker.ts',
      'update-download': 'src/update-download.ts',
      updates: 'src/updates.ts',
      'windows-agent-presets': 'src/windows-agent-presets.ts',
      'windows-pwsh-sandbox': 'src/windows-pwsh-sandbox.ts',
      'windows-acl-runner': 'src/windows-acl-runner.ts',
      main: 'src/main.ts',
    },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
  },
  {
    name: `${PACKAGE_NAME}/bin`,
    entry: { bin: 'src/bin.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    outputOptions: {
      banner: '#!/usr/bin/env node',
    },
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
    ],
    // tsdown external matching is a specifier prefix; the platform table
    // entries ('react', 'react-dom', 'react/jsx-runtime') are exact strings,
    // so match the same prefixes tsdown would. Non-platform values inline.
    noExternal: (id: string) => id.startsWith('@deepseek-ai/') || id === 'react' || id.startsWith('react/') || id === 'react-dom' || id.startsWith('react-dom/') ? undefined : true,
    // Inlined libraries (react/react-dom read process.env.NODE_ENV in their
    // dev branches) need the substitution at build time, exactly like the
    // upstream clientBundle preset — otherwise the browser bundle throws
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
