# DSH Desktop 插件开发

## 先理解两层插件

一个普通 DSH 插件可以提供 Host service、命令、路由、bundle 或 Web Client。它应该尽量只依赖官方 DSH contract，因此可以在命令行、普通 Web profile 和 DSH Desktop 中复用。

Desktop 另外提供两个公开的 Host service：

- `desktopProfiles`：读取当前 profile、发现可选 profile，并请求安全的 profile 切换。
- `desktopPnpm`：在当前 profile 中执行 pnpm，或通过官方 `dsh plugin` 语义管理插件。

它们属于 Electron main 进程中的 Host Cordis generation。Renderer 不能直接读取它们；有浏览器界面的插件仍应使用普通 DSH Web routes、RPC、client metadata、service 和 slot。

完整类型、生命周期和失败语义见 [`dsh-plugin-desktop/docs/plugin-services.md`](../dsh-plugin-desktop/docs/plugin-services.md)。下面只给出选择方式和最小原则。

## Desktop 专用插件

如果插件只应该在 Desktop 中运行，可以把服务声明为 required injection：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-plugin-desktop/profile-service'
import type { DesktopPnpmHandle } from 'dsh-plugin-desktop/pnpm'

export const name = 'example-desktop-plugin'
export const inject = ['desktopProfiles', 'desktopPnpm']

export function apply(ctx: Context): void {
  ctx.logger.info(`profile: ${ctx.desktopProfiles.current.name}`)
  let active: DesktopPnpmHandle | undefined

  // 将这个函数连接到插件界面的明确用户操作。
  async function installExample(): Promise<void> {
    active = ctx.desktopPnpm.runPlugin(
      ['add', 'example-plugin'],
      process.cwd(),
    )
    await active.done
  }

  ctx.effect(() => {
    return async () => {
      active?.cancel()
      await active?.done.catch(() => {})
    }
  }, 'example plugin operation')
}
```

实际项目应该把 package operation 放在明确的用户动作中，校验目标来源，读取 stdout/stderr，设置自己的 timeout，并同时检查 `exitCode` 和 `signal`。一个 generation 同时只允许一个 `desktopPnpm` package operation；插件卸载时必须取消并等待它结束。

## 兼容 Desktop 和普通 DSH

如果同一个插件也要在普通 `dsh web` 中运行，不要把 Desktop service 放进顶层 required `inject`。先注入普通依赖，再在 callback 中动态探测：

```ts
export const inject = ['webServer', 'loader']

export function apply(ctx: Context, config: { profile?: string }): void {
  const profiles = ctx.get('desktopProfiles')
  if (profiles === undefined) {
    mountOrdinaryDshManager(ctx, config.profile ?? 'web')
    return
  }

  ctx.inject(['desktopPnpm'], (desktopPnpm) => {
    mountManager(ctx, {
      profile: profiles.current.name,
      profileDir: profiles.current.dir,
      runPlugin: (args, cwd, signal) => desktopPnpm.runPlugin(args, cwd, signal),
    })
  })
}
```

普通 DSH 的 fallback 仍然是插件自己的权威实现。不要从 `process.argv`、`ctx.baseUrl`、settings 或 `$DSH_HOME` 推断 Desktop profile；在 Desktop 中以 `desktopProfiles.current` 为准。

## `run()` 和 `runPlugin()` 的区别

`desktopPnpm.run(args)` 是低层 pnpm operation，cwd 是当前 profile。它不保证 DSH 的 profile 初始化、调用方相对 `file:`/`link:` source 锚定或 `dsh.profile.bundles` reconcile。

`desktopPnpm.runPlugin(args, invokingDir)` 执行打包的 `dsh plugin --profile <active>`，保留上游插件管理语义。安装、卸载、更新和依赖修复应使用它，例如：

```ts
desktopPnpm.runPlugin(['add', target], invokingDir, signal)
desktopPnpm.runPlugin(['remove', packageName], invokingDir, signal)
desktopPnpm.runPlugin(['update'], invokingDir, signal)
desktopPnpm.runPlugin(['install', '--no-frozen-lockfile'], invokingDir, signal)
```

参数始终作为 argv 传递；不要拼接 shell 字符串，也不要依赖 Windows `.cmd` shim。服务会在完整子进程树退出后 settle，并在 generation dispose 时终止仍在运行的 operation。

## 不要依赖的接口

`desktopRuntime`、`desktopPnpmBootstrap`、Electron `BrowserWindow`、托盘注册表、private Node helper、`ELECTRON_RUN_AS_NODE` 和生成的 shim 都是 Desktop 内部实现。即使它们出现在 declaration 或运行时上下文中，也不属于第三方兼容 contract。

## 测试与发布检查

插件至少应覆盖：

- 在普通 DSH 中没有 Desktop service 时仍能加载，或按产品定义保持 pending。
- Desktop 中读取的 profile name/dir 与用户实际选择一致。
- package operation 的取消、非零退出、spawn failure 和 generation teardown。
- 插件变更后重新启动，bundle 能进入下一次 Loader 组合。

开发者可以先阅读 [架构说明](architecture.md)，再使用包级 [service contract](../dsh-plugin-desktop/docs/plugin-services.md)。
