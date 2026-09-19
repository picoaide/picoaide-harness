import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@picoaide/dsh-host-home'

/**
 * 零依赖叶子库，单入口。
 *
 * 与 `@picoaide/dsh-host-locale` 同形、同理：它是宿主侧共享工具的第二个叶子。
 * **必须保持没有 `dependencies`** —— `desktop-home` 原本住在桌面包里，而
 * `@picoaide/dsh-connectors` 读它 ⇒ 构成
 * `desktop → wasm-apps-host → browser → connectors → desktop` 那段环。抽成叶子后
 * connectors 不再依赖桌面包，环断开；只要它自己再引入任何构建期依赖，环就会以
 * 新的形状绕回来。
 *
 * 同样刻意**不是** Cordis 插件：没有 `cordis.patch.yml` / `dsh.bundle` /
 * `./invariant` 入口，不会出现在任何 profile 组合里。
 */
export default defineConfig({
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
})
