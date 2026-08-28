import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PLATFORM_MODULES, PRELOADED_CLIENT_EXTERNALS } from '../../../scripts/platform-modules.mjs'
import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@picoaide/dsh-branding'

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
    // 品牌名旁的产品版本标签(见 src/client/Brand.tsx BrandName)
    define: {
      'process.env.PICOAI_PRODUCT_VERSION': JSON.stringify(PRODUCT_VERSION),
    },
    external: [
      ...PLATFORM_MODULES,
      ...PRELOADED_CLIENT_EXTERNALS,
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
