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
    // 其余**已声明**的 exports 子路径也必须真的构建出来（2026-09-20 修）：
    // 此前 `package.json` 的 `exports` 声明了 ./app-proof·./windows·./host-request·./ai-chat
    // 四个子路径，而这里只构建 index/invariant/electron-adapter ⇒ 那四个 `lib/*.js`
    // **从未产出**。后果不是"少几个文件"，而是**打包版启动即挂**：desktop 的
    // `lib/main.js` 值导入 `@picoaide/dsh-wasm-apps-host/app-proof`（安装密钥仓库），
    // 在真实 app.asar 里报 ERR_MODULE_NOT_FOUND（Linux e2e 的
    // "app did not expose CDP within 30s" 就是它；本地单测因为走源码路径而全绿）。
    // 教训：**声明了的入口就必须构建**，否则"能 import"只是源码期的幻觉。
    'app-proof': 'src/app-proof.ts',
    windows: 'src/windows.ts',
    'host-request': 'src/host-request.ts',
    'ai-chat': 'src/ai-chat.ts',
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
