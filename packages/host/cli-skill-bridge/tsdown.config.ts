import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@picoaide/dsh-cli-skill-bridge'

export default defineConfig([
  {
    name: PACKAGE_NAME,
    entry: { index: 'src/index.ts' },
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
      'node:child_process',
      'node:crypto',
      'node:fs',
      'node:os',
      'node:path',
    ],
  },
])
