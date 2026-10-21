import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@picoaide/dsh-gateway-client'

/**
 * 宿主侧**网关客户端**的共享叶子包（`auth` / `config` / `electron` 三个子路径）。
 *
 * 实现自 `packages/host/enterprise/src/server-connector/{auth,config,electron}.ts`
 * 逐字迁入，`@picoaide/dsh-enterprise` 保留同名 re-export（对外子路径与导出面不变）
 * —— 与 2026-09-23 的 `loopback.ts` 四份合一同一姿势。
 *
 * **为什么必须是叶子**：功能模块包（`@picoaide/dsh-capability-center`、
 * `@picoaide/dsh-wasm-apps-host`）的本机路由要真的调网关。它们**不能** import
 * `@picoaide/dsh-enterprise`：enterprise 的 tsc 读 `dsh-plugin-desktop/desktop-channel`
 * （⇒ 边 enterprise → desktop），而 desktop 的 tsdown 把 `@picoaide/*` 内联
 * （⇒ 边 desktop → wasm-apps-host）—— 模块包指向 enterprise 就闭合出
 * `desktop → wasm-apps-host → enterprise → desktop` 这个环。让共享实现落在一个
 * **没有任何 `@picoaide/*` 出边通往功能模块**的叶子上，环才断得干净。
 *
 * 与本包同样刻意**不是** Cordis 插件：没有 `cordis.patch.yml` / `dsh.bundle` /
 * `./invariant` 入口，不会出现在任何 profile 组合里。
 */
export default defineConfig({
  name: PACKAGE_NAME,
  entry: {
    index: 'src/index.ts',
    auth: 'src/auth.ts',
    config: 'src/config.ts',
    electron: 'src/electron.ts',
  },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  sourcemap: true,
  // `electron` 必须 external：它是 **devDependency**（真实宿主运行时由 Electron
  // 进程提供），而 tsdown 只会自动外置 dependencies。一旦被内联，产物里进的是
  // npm 包里那份 index.js —— 在普通 Node 里它只返回可执行文件路径，在打包产物
  // 里连 node_modules/electron 都没有，`require` 会抛 "Electron failed to install
  // correctly"。于是 `loadElectronModule()` 在 main 进程拿不到 `safeStorage`：
  // 会话令牌解不出来（每次启动都当未登录），而且读取失败后会以 0600 明文重写
  // 令牌。enterprise / browser / wasm-apps-host / desktop 的 tsdown 配置都已显式
  // 外置 `electron`，本包是同一组件的共享叶子包，口径必须一致。
  // 2026-10-20 回归：漏了这一条，beta.6/beta.7 每次启动都被踢回登录页。
  external: ['electron'],
})
