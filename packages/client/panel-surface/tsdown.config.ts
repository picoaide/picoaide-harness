import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@picoaide/dsh-panel-surface'

/**
 * 客户端面板的**共享叶子包**：中列整页切换的装载器 + 一套共享视觉语言。
 *
 * 为什么是独立包而不是各自复制一份：四个面板（定时任务 / 能力中心 / 连接器 /
 * 应用中心）此前各写各的（cron 自持 DOM 装载，其余三个是 `position:fixed` 模态），
 * 结果同一个产品里出现两套切换语义、三套卡片样式。装载器与视觉语言**只能有一份实现**。
 *
 * 为什么不做成 Cordis 客户端插件（没有 `cordis.patch.yml` / `dsh.bundle` / `./invariant`）：
 * 它不参与任何 profile 组合，只是被四个插件的 client bundle **内联**进产物的库
 * （与 `@picoaide/dsh-host-locale` / `@picoaide/dsh-host-home` 同形）。
 * 消费方**不要**把它写进 tsdown 的 `external` —— 内联是预期行为，而且它自己不持有
 * 任何跨插件共享的可变状态（激活态只落在 `document.documentElement` 的属性上，
 * 那本来就是全局的）。
 */
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
  },
  {
    name: `${PACKAGE_NAME}/client`,
    entry: { client: 'src/client/index.ts' },
    tsconfig: 'tsconfig.client.json',
    outDir: 'lib',
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: true,
    // React 在宿主里由平台模块表提供（消费方的 client bundle 同样把它列 external），
    // 这里保持 external 才不会在库里再造一个 React 实例。
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  },
])
