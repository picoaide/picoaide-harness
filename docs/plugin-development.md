# PicoAide Harness 插件开发

> **当前接口与 Draft 请勿混淆：** 本文介绍现在可用的 DSH/Cordis 与 Desktop contract。`dsh-community-fabric` 中的 manifest、capability 和统一事件模型仍处于[社区 RFC Draft](../community/fabric/README.zh.md)，尚不能作为依赖或发布目标。

## 先理解两层插件

一个普通 DSH 插件可以提供 Host service、命令、路由、bundle 或 Web Client。它应该尽量只依赖官方 DSH contract，因此可以在命令行、普通 Web profile 和 PicoAide Harness 中复用。

Desktop 侧公开的契约只有两个（见 [plugin-services.md](../packages/host/desktop/docs/plugin-services.md)）：

- `desktopRuntime.registerTrayItem`：向原生托盘贡献一个 effect 作用域内的菜单项（如 `tools`/`status` 分组），菜单在 observable 状态变化时自动重建。
- `desktopActions`（通过 `dsh-plugin-desktop` 根入口类型声明）：generation 作用域的 Host service，只暴露重启操作，仅供显式用户动作使用。

它们属于 Electron main 进程中的 Host Cordis generation。Renderer 不能直接读取它们；有浏览器界面的插件仍应使用普通 DSH Web routes、RPC、client metadata、service 和 slot。

完整类型、生命周期和失败语义见 [`dsh-plugin-desktop/docs/plugin-services.md`](../packages/host/desktop/docs/plugin-services.md)。下面只给出选择方式和最小原则。

## Desktop 专用插件

如果插件只应该在 Desktop 中运行，可以把 `desktopRuntime` 声明为 required injection（Cordis 会在该 provider 不可用时保持插件 pending）：

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-plugin-desktop'

export const name = 'example-desktop-plugin'
export const inject = ['desktopRuntime']

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const registration = ctx.desktopRuntime.registerTrayItem({
      group: 'tools',
      order: 30,
      label: () => 'Example Action',
      invoke: () => { /* 显式用户动作 */ },
    })
    return () => { registration.dispose() }
  }, 'dsh-plugin-desktop: example tray command')
}
```

实际项目应该把托盘动作放在明确的用户动作中，自行处理异步失败（托盘 adapter 会记录错误），并在 `invoke()` 内设置自己的超时。`registerTrayItem` 返回可刷新的注册句柄（`refresh`/`dispose`），不要保留到所属 effect 生命周期之外。

## 兼容 Desktop 和普通 DSH

如果同一个插件也要在普通 `dsh web` 中运行，不要把 Desktop service 放进顶层 required `inject`。先注入普通依赖，再在 callback 中动态探测：

```ts
export const inject = ['webServer', 'loader']

export function apply(ctx: Context, config: { profile?: string }): void {
  const runtime = ctx.get('desktopRuntime')
  if (runtime === undefined) {
    mountOrdinaryDshManager(ctx, config.profile ?? 'web')
    return
  }
  mountDesktopTrayAction(ctx, runtime)
}
```

普通 DSH 的 fallback 仍然是插件自己的权威实现。应用固定运行 `desktop` profile；不要从 `process.argv`、`ctx.baseUrl`、settings 或 `$DSH_HOME` 推断 profile。

## 插件管理（官方 CLI 语义）

应用固定运行 `desktop` profile，从系统 shell 用官方 DSH CLI 管理插件：

```sh
dsh plugin --profile desktop add <plugin>
dsh plugin --profile desktop remove <plugin>
dsh plugin --profile desktop update
```

`--profile <name>` 始终优先；插件变更后需重启应用才进入下一次 Loader 组合。Desktp 不内置 pnpm 管理 service，也不提供 `dsh-plugin-desktop/pnpm` 或 `profile-service` 子路径——这类旧的内部 service 已随 profile 切换/终端功能移除。

## 不要依赖的接口

`desktopRuntime` 的窗口/托盘方法、`desktopPlugins`（profile bundle 禁用能力）、Electron `BrowserWindow`、托盘注册表、private Node helper、`ELECTRON_RUN_AS_NODE` 和生成的 shim 都是 Desktop 内部实现。即使它们出现在 declaration 或运行时上下文中，也不属于第三方兼容 contract；只有 plugin-services.md 声明的注册契约与 `desktopActions` 重启能力是受支持面。

## 测试与发布检查

插件至少应覆盖：

- 在普通 DSH 中没有 Desktop service 时仍能加载，或按产品定义保持 pending。
- 托盘项的生命周期：effect dispose 后注册句柄同步释放，无可达泄漏。
- 异步 invoke 失败、重复触发和 generation teardown。
- 插件变更后重新启动，bundle 能进入下一次 Loader 组合。

开发者可以先阅读 [架构说明](architecture.md)，再使用包级 [service contract](../packages/host/desktop/docs/plugin-services.md)。

## 生态愿景：保持插件生态可组合

DSH 的插件生态正在快速增长。插件越多，它们能否协同工作就越重要——如果每个插件都假设或覆盖其他插件的内部实现，装几个插件就会开始冲突，生态会逐渐碎片化。

我们倡导像浏览器插件一样的开发方式：大家在同一个平台上、按同一套约定扩展，而不是各自维护一份改过的运行时。PicoAide Harness 是这套方式的第一个实践者——桌面壳本身就是一个普通插件，与官方、第三方插件走同一条组合路径，没有任何特权。

为此我们发起一项开发规范倡议，希望它通过社区的采纳成为事实标准：

- **组合优先**：通过官方 slot、service 和 patch 组合能力，不要假设或覆盖其他插件的内部实现。
- **声明清晰**：明确声明依赖的 service 和 slot，不依赖运行时巧合。
- **兼容优先**：升级保持向后兼容，不破坏已有组合。

倡议是活文档，随生态实践更新，接受社区讨论和修订。插件市场上线后，遵循共同约定的插件将更容易被发现、安装和判断兼容性，让"按规范开发"成为对每个作者都有利的选择。完整愿景见 [DSH 插件生态倡议书](plugin-ecosystem.md)；未来互操作 contract 的讨论见 [DSH Community Fabric](../community/fabric/README.zh.md)。
