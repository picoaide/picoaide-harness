import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@picoaide/dsh-host-locale'

/**
 * 零依赖叶子库。
 *
 * **这个包必须保持没有 `dependencies`**（连 `@picoaide/*` 也不能有）：它存在的
 * 唯一目的就是断掉真实构建环
 * `desktop → wasm-apps-host → browser → dsh-plugin-desktop/host-locale → desktop`
 * —— 只要它自己再引入任何构建期依赖，环就会以新的形状绕回来。同理，它刻意
 * **不是** Cordis 插件：没有 `cordis.patch.yml` / `dsh.bundle` / `./invariant`
 * 入口，也就不会出现在任何 profile 组合里。
 *
 * 2026-09-23：新增第二个入口 `loopback`（宿主本机路由的回环信任边界的唯一实现），
 * 由 connectors / enterprise / browser / cron 四个包各自的 `src/loopback.ts`
 * re-export 消费。它只 import `node:http` 的**类型**，零依赖不变量不受影响；
 * 只作为**子路径**导出，不并进 `index` —— 否则 `dsh-plugin-desktop/host-locale`
 * 的 `export *` 会把 `isLoopback*` 一并搬到桌面包的对外面上。
 */
export default defineConfig({
  name: PACKAGE_NAME,
  entry: { index: 'src/index.ts', loopback: 'src/loopback.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  sourcemap: true,
})
