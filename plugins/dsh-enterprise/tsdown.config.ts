import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@picoaide/dsh-enterprise'

export default defineConfig({
  name: PACKAGE_NAME,
  entry: {
    index: 'src/index.ts',
    'auth-gate': 'src/auth-gate.ts',
    'gateway-model': 'src/gateway-model.ts',
    bootstrap: 'src/bootstrap.ts',
    'session-service': 'src/session-service.ts',
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
    '@deepseek-ai/dsh-agent-default-model',
    'electron',
  ],
})
