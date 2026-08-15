# DSH Desktop Plugin Development

## Understand the two plugin layers

A normal DSH plugin can provide Host services, commands, routes, bundles, or a Web Client. It should depend on upstream DSH contracts whenever possible so the same package can work in the CLI, an ordinary Web profile, and DSH Desktop.

Desktop adds two public Host services:

- `desktopProfiles`: reads the active profile, discovers selectable profiles, and requests a safe profile switch.
- `desktopPnpm`: runs pnpm in the active profile, or manages plugins through the official `dsh plugin` semantics.

These services live in the Host Cordis generation in Electron's main process. The renderer cannot read them directly; a plugin with browser UI should continue to use ordinary DSH Web routes, RPC, client metadata, services, and slots.

The complete types, lifecycle, and failure semantics are in [`dsh-plugin-desktop/docs/plugin-services.md`](../dsh-plugin-desktop/docs/plugin-services.md). This page focuses on selection and the minimum safe patterns.

## Desktop-only plugins

If a plugin only makes sense in Desktop, declare the services as required injections:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-plugin-desktop/profile-service'
import type { DesktopPnpmHandle } from 'dsh-plugin-desktop/pnpm'

export const name = 'example-desktop-plugin'
export const inject = ['desktopProfiles', 'desktopPnpm']

export function apply(ctx: Context): void {
  ctx.logger.info(`profile: ${ctx.desktopProfiles.current.name}`)
  let active: DesktopPnpmHandle | undefined

  // Connect this function to an explicit user action in the plugin UI.
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

Production code should invoke package operations from an explicit user action, validate the target, read stdout/stderr, set its own timeout, and check both `exitCode` and `signal`. A generation allows only one `desktopPnpm` package operation at a time; dispose must cancel and await it.

## Plugins that work in Desktop and ordinary DSH

When the same package must also run under ordinary `dsh web`, do not put Desktop services in the top-level required `inject` list. Inject ordinary dependencies first and dynamically detect Desktop:

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

The ordinary DSH fallback remains the plugin's authoritative implementation. Do not infer the Desktop profile from `process.argv`, `ctx.baseUrl`, settings, or `$DSH_HOME`; in Desktop, use `desktopProfiles.current`.

## `run()` versus `runPlugin()`

`desktopPnpm.run(args)` is a low-level pnpm operation with the active profile as its cwd. It does not promise DSH profile initialization, caller-relative `file:`/`link:` anchoring, or `dsh.profile.bundles` reconciliation.

`desktopPnpm.runPlugin(args, invokingDir)` runs packaged `dsh plugin --profile <active>` and preserves upstream plugin-management semantics. Use it for install, remove, update, and dependency repair:

```ts
desktopPnpm.runPlugin(['add', target], invokingDir, signal)
desktopPnpm.runPlugin(['remove', packageName], invokingDir, signal)
desktopPnpm.runPlugin(['update'], invokingDir, signal)
desktopPnpm.runPlugin(['install', '--no-frozen-lockfile'], invokingDir, signal)
```

Arguments are passed as argv. Do not concatenate shell strings or depend on Windows `.cmd` shims. The service settles only after the whole subprocess tree exits and terminates active operations during generation disposal.

## APIs not to depend on

`desktopRuntime`, `desktopPnpmBootstrap`, Electron `BrowserWindow`, the tray registry, private Node helpers, `ELECTRON_RUN_AS_NODE`, and generated shims are Desktop internals. Their presence in declarations or runtime context does not make them third-party compatibility contracts.

## Testing and release checks

At minimum, a plugin should cover:

- Loading under ordinary DSH without Desktop services, or staying pending by design.
- Matching the profile name and directory reported by Desktop to the user's actual selection.
- Cancellation, non-zero exit, spawn failure, and generation teardown for package operations.
- Restarting after a plugin change and seeing the bundle in the next Loader composition.

Read the [architecture](architecture.en.md) next, then use the package-level [service contract](../dsh-plugin-desktop/docs/plugin-services.md) as the API reference.
