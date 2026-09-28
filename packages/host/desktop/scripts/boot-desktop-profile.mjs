/**
 * 挂载「已装配的桌面 profile」的**唯一**实现（三个 boot 站点共用）。
 *
 * ## 为什么必须只有一份
 *
 * 上游 0.1.7 把「profile 目录里能不能解析出一个 bare specifier」从**物化的
 * `profiles/node_modules` 闭包**（旧的 `healProfilesModuleFallback`）换成了**进程内拦截**
 * （`PluginPackages` 服务 + `createRuntimeResolution()`）。于是任何 `boot(...)` 调用点
 * 都必须自己接上它 —— 漏接的症状**不是**报"缺依赖"，而是 `failed to import` 满天飞
 * （实测：`verify:profile` 169 条、`verify:session` 163 条，且 required 行整片不激活）。
 * 两个脚本各自手写这段接线时，`verify-session-restart.mjs` 就漏了它（2026-09-28 主控
 * 实测），而且它是**静默**的：脚本照旧"能跑"，只是每个插件都 import 不进来。
 *
 * 因此：**装配好的 profile 只允许经本函数 boot**。`tests/boot-wiring.spec.ts` 用一条
 * 静态判据守住这一点（任何 `boot(` + `prepared.patches` 的脚本都必须走这里），并对
 * "把接线删掉"做了反向对照。
 *
 * ## 五个必备接线（顺序与生产 `src/main.ts` 同源）
 *
 * 1. `DSH_LAUNCH_ENVIRONMENT_KEY` —— 启动环境快照（插件读 launch env 的唯一来源）；
 * 2. `desktopRuntime` —— 原生壳适配器（缺席时 `desktop-shell` 会**静默早退**，
 *    窗口规格永远不会被 `schedule()`，症状 = `desktop shell was not registered`）；
 * 3. `profileContext` —— profile 自述（上游 base bundle 的 `plugin-manager`
 *    与 `hmr` 共用 `disabled: !!js "!ctx.get('profileContext')"` 这个开关；桌面必须
 *    provide 它才能拿到 `pluginManager`，同时 `cordis.patch.yml` 里显式关掉 `hmr`）；
 * 4. `PluginPackages` + `prepared.resolution` —— 0.1.7 的 bare-specifier 解析拦截；
 * 5. `provideCmdline` —— `appExit` 服务（`desktop-shell` 的 `inject` 里有它，
 *    缺席则整行停在 PENDING）。
 *
 * @module dsh-plugin-desktop/boot-desktop-profile
 */

import { boot, PluginPackages } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import { installProfilePackageResolver } from '../lib/module-resolution.js'
import { desktopProfileContext } from '../lib/profile.js'

/**
 * Boot the assembled desktop profile headlessly with every mandatory wiring.
 *
 * @param options - boot inputs.
 * @param options.binName - Loader diagnostic prefix (the smoke's own name).
 * @param options.prepared - `prepareDesktopProfile(...)` result for this generation.
 * @param options.patches - the caller's patch list: normally
 *   `[<fixture row>, ...prepared.patches]`.
 * @param options.runtime - the native-shell adapter stub (`desktopRuntime`).
 * @param options.port - Web port the launcher would bind; smokes use `0`.
 * @returns the booted context plus the package-resolver release hook the caller
 *   must run in its `finally` block.
 */
export async function bootDesktopProfile({
  binName,
  prepared,
  patches,
  runtime,
  port = 0,
}) {
  const releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
  try {
    const ctx = await boot(
      binName,
      prepared.rootConfig,
      patches,
      async (host) => {
        host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]))
        host.provide('desktopRuntime', runtime)
        host.provide('profileContext', desktopProfileContext(prepared))
        // MUST be awaited before the config tree mounts: this is the in-process
        // replacement for the materialized `profiles/node_modules` closure.
        await host.plugin(PluginPackages, { resolution: prepared.resolution })
        provideCmdline(host, {
          args: ['--host', '127.0.0.1', '--port', String(port)],
          exit: () => {},
        })
      },
      prepared.bareModuleBaseUrl,
    )
    await runtime.mountScheduled()
    return { ctx, releasePackageResolver }
  } catch (error) {
    releasePackageResolver()
    throw error
  }
}
