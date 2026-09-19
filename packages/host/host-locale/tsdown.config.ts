import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@picoaide/dsh-host-locale'

/**
 * 零依赖叶子库，单入口。
 *
 * **这个包必须保持没有 `dependencies`**（连 `@picoaide/*` 也不能有）：它存在的
 * 唯一目的就是断掉真实构建环
 * `desktop → wasm-apps-host → browser → dsh-plugin-desktop/host-locale → desktop`
 * —— 只要它自己再引入任何构建期依赖，环就会以新的形状绕回来。同理，它刻意
 * **不是** Cordis 插件：没有 `cordis.patch.yml` / `dsh.bundle` / `./invariant`
 * 入口，也就不会出现在任何 profile 组合里。
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
