import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@picoaide/dsh-cli-tools'

export default defineConfig([
  {
    name: PACKAGE_NAME,
    entry: {
      index: 'src/index.ts',
      'cli-manifest': 'src/cli-manifest.ts',
      archive: 'src/archive.ts',
      home: 'src/home.ts',
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
      'node:child_process',
      'node:crypto',
      'node:fs',
      'node:os',
      'node:path',
      'node:url',
    ],
  },
])
