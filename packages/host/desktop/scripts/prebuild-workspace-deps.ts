/**
 * 打包前预构建 workspace 依赖包(跨平台,被 package-win.ts / package-mac.ts /
 * release-mac.ts 的真实 CLI 入口调用)。
 *
 * 背景:enterprise/account-card/branding 的 lib/ 未入库(fresh checkout 缺失),
 * 而 desktop 安装包运行时读取这些包的 lib/client.js(品牌 logo/版本标签等)。
 * 此前 dist:win/mac 未构建它们 → 安装包携带缺失/旧 bundle(品牌在但版本号
 * 不显示)。dist:linux 因前置 `yarn run build` 才碰巧完整。
 *
 * 顺序:desktop 自身 build 最先(产出 lib/types,enterprise 的 tsc 引用
 * dsh-plugin-desktop/desktop-home 的类型);随后 enterprise/account-card/
 * branding(它们 tsc 需 desktop 类型)。desktop build 不依赖 enterprise lib
 * (已验证),故无循环。
 */

import { spawnSync } from 'node:child_process'

/** 执行一个 yarn workspace 命令,失败即抛错。 */
function runWorkspace(workspace: string, cwd: string): void {
  // corepack yarn:仓库约定(包管理器经 corepack);shell: true 让 Windows
  // 也能解析 corepack 的可执行 shim(否则 spawnSync 找不到未入 PATH 的包装)。
  const result = spawnSync('corepack', ['yarn', 'workspace', workspace, 'build'], {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    throw new Error(`prebuildWorkspaceDeps: ${workspace} build failed (status ${result.status})`)
  }
}

/** 预构建 desktop 自身 + enterprise/account-card/branding。 */
export function prebuildWorkspaceDeps(workspaceRoot: string): void {
  // desktop 自身(tsdown + 类型)
  const self = spawnSync('corepack', ['yarn', 'run', 'build'], {
    cwd: workspaceRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (self.status !== 0) {
    throw new Error(`prebuildWorkspaceDeps: desktop build failed (status ${self.status})`)
  }
  // 依赖包(enterprise tsc 需 desktop lib/types,故在 desktop 之后)
  runWorkspace('@picoaide/dsh-enterprise', workspaceRoot)
  runWorkspace('@picoaide/dsh-account-card', workspaceRoot)
  runWorkspace('@picoaide/dsh-branding', workspaceRoot)
}
