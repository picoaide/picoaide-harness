import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@picoaide/dsh-wasm-apps-host'

export default defineConfig({
  name: PACKAGE_NAME,
  entry: {
    index: 'src/index.ts',
    invariant: 'src/invariant.ts',
    // The Electron seam is its own entry on purpose: `src/index.ts` must stay
    // loadable under plain Node (unit tests + the profile boot smoke), while
    // this module statically imports `electron` and may only be loaded by the
    // Electron main process (desktop main.ts).
    'electron-adapter': 'src/electron-adapter.ts',
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
    '@deepseek-ai/schemastery',
    'electron',
  ],
})
