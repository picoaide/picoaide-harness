# PicoAide Harness Plugin Development

> **Do not confuse current APIs with a Draft:** this guide describes working DSH/Cordis and Desktop contracts. The manifest, capability, and unified event model in `dsh-community-fabric` remains a [community RFC Draft](../community/fabric/README.md) and cannot yet be used as a dependency or release target.

## Understand the two plugin layers

A normal DSH plugin can provide Host services, commands, routes, bundles, or a Web Client. It should depend on upstream DSH contracts whenever possible so the same package can work in the CLI, an ordinary Web profile, and PicoAide Harness.

The Desktop side exposes only two supported contracts (see [plugin-services.md](../packages/host/desktop/docs/plugin-services.md)):

- `desktopRuntime.registerTrayItem`: contributes an effect-scoped native tray item (for example the `tools` or `status` group); the tray menu rebuilds automatically when observable state changes.
- `desktopActions` (declared through the `dsh-plugin-desktop` root entry): a generation-scoped Host service exposing only the restart operation, for explicit user actions.

Both live in the Host Cordis generation in Electron's main process. The renderer cannot read them directly; a plugin with browser UI should continue to use ordinary DSH Web routes, RPC, client metadata, services, and slots.

The complete types, lifecycle, and failure semantics are in [`dsh-plugin-desktop/docs/plugin-services.md`](../packages/host/desktop/docs/plugin-services.md). This page focuses on selection and the minimum safe patterns.

## Desktop-only plugins

If a plugin only makes sense in Desktop, declare `desktopRuntime` as a required injection (Cordis keeps the plugin pending while the provider is unavailable):

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
      invoke: () => { /* explicit user action */ },
    })
    return () => { registration.dispose() }
  }, 'dsh-plugin-desktop: example tray command')
}
```

Production code should trigger tray actions from explicit user actions, handle async failures inside `invoke()` (the tray adapter logs them), and set its own timeout. `registerTrayItem` returns a refreshable registration handle (`refresh`/`dispose`); do not retain it beyond the owning effect's lifetime.

## Plugins that work in Desktop and ordinary DSH

When the same package must also run under ordinary `dsh web`, do not put Desktop services in the top-level required `inject` list. Inject ordinary dependencies first and dynamically detect Desktop:

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

The ordinary DSH fallback remains the plugin's authoritative implementation. The application runs a fixed `desktop` profile; do not infer the profile from `process.argv`, `ctx.baseUrl`, settings, or `$DSH_HOME`.

## Plugin management (official CLI semantics)

The application runs the fixed `desktop` profile; manage plugins with the official DSH CLI from a system shell:

```sh
dsh plugin --profile desktop add <plugin>
dsh plugin --profile desktop remove <plugin>
dsh plugin --profile desktop update
```

An explicit `--profile <name>` always wins; restart the application after plugin changes so the bundle enters the next Loader composition. Desktop does not bundle a pnpm management service and does not export `dsh-plugin-desktop/pnpm` or `profile-service` subpaths — those internal services were removed together with the profile switcher and bundled terminal.

## APIs not to depend on

The `desktopRuntime` window/tray internals, `desktopPlugins` (profile-bundle disable capability), Electron `BrowserWindow`, the tray registry, private Node helpers, `ELECTRON_RUN_AS_NODE`, and generated shims are Desktop internals. Their presence in declarations or runtime context does not make them third-party compatibility contracts; only the registration contract and the `desktopActions` restart capability declared in plugin-services.md are supported.

## Testing and release checks

At minimum, a plugin should cover:

- Loading under ordinary DSH without Desktop services, or staying pending by design.
- Tray-item lifetime: effect disposal synchronously releases the registration with no reachable leak.
- Async invoke failures, repeated triggers, and generation teardown.
- Restarting after a plugin change and seeing the bundle in the next Loader composition.

Read the [architecture](architecture.en.md) next, then use the package-level [service contract](../packages/host/desktop/docs/plugin-services.md) as the API reference.

## Ecosystem vision: keep the plugin ecosystem composable

The DSH plugin ecosystem is growing quickly. The more plugins there are, the more their ability to work together matters — if every plugin assumes or overrides another plugin's internals, installing a few plugins starts to conflict and the ecosystem fragments.

We advocate a browser-plugin style of development: everyone extends the same platform against the same conventions, instead of each maintaining a modified runtime of their own. PicoAide Harness is the first practitioner of this approach — the desktop shell itself is an ordinary plugin on the same composition path as official and third-party plugins, with no special privileges.

To that end we are starting a development-conventions initiative and hope it becomes a de facto standard through community adoption:

- **Composition first**: compose capabilities through official slots, services, and patches; do not assume or override other plugins' internals.
- **Declare clearly**: state the services and slots you depend on; do not rely on runtime coincidences.
- **Compatibility first**: keep upgrades backward-compatible so existing compositions do not break.

The manifesto is a living document that changes with ecosystem practice and accepts community discussion and revision. Once the plugin marketplace is live, plugins following these conventions will be easier to discover, install, and reason about, making standard-conforming development beneficial for every author. See the full vision in [Plugin ecosystem manifesto](plugin-ecosystem.en.md); future interoperability contracts are discussed in [DSH Community Fabric](../community/fabric/README.md).
