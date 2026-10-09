---
title: Plugin Development
description: 'Write a DSH plugin from scratch: Cordis forms, host vs client face, the platform module table, local debugging, then shipping into the client or the server.'
---

Plugins are extension packages that add capabilities to DSH — models, tools, interfaces, and workflows can all become plugins. PicoAide Harness **does not fork or modify the upstream source**: the desktop shell itself is a legitimate DSH plugin on the same official Cordis composition path as third-party plugins. This page is for second-party developers and maintainers: it covers the whole path from "write a plugin" through local debugging to shipping it inside the desktop client or into the enterprise server, and where the boundaries are at each step.

## Design goal: why plugins instead of a fork

Of the three possible approaches, only one stays maintainable:

| Approach | Consequence |
|---|---|
| Modify the upstream source | Every upstream follow-up has to be redone, and upstream fixes and security updates can no longer be merged |
| Invent a separate renderer IPC plugin system | It runs in parallel with the official slot/service system, and ecosystem plugins can no longer be installed |
| **Add your own bundle layers at the composition level** | Upstream runs unchanged; product capabilities participate as plugins, with the same rights as third parties |

So the shape of this repository is: one fixed `desktop` profile plus ten product-owned composition layers (the patch in `packages/host/desktop/cordis.patch.yml` and one patch per product package), with a small number of upstream patches that each carry their own criteria (`patches/` and `docs/decisions/`). The desktop shell is not a privileged layer — the services and slots it registers are equally available to third-party plugins.

## Concepts and structure

The terms below are reused throughout this page:

| Term | Meaning | Source of truth |
|---|---|---|
| Cordis plugin | A module exporting `apply(ctx, config)` (or default-exporting a service class) | upstream `@deepseek-ai/cordis` |
| Bundle | A package declaring `dsh.bundle.patch` in `package.json`; the patch file inserts plugin rows into the composition | upstream `deepseek-harness/packages/boot/app-boot` |
| Patch layer | One `cordis.patch.yml`; layer order = each bundle layer → the profile's own layer → the user home layer → launcher overlays | upstream `deepseek-harness/vendor/include/src/index.ts` |
| Profile | The fixed `desktop` profile; no selector, no CLI entry point | `DESKTOP_PROFILE_NAME` in `packages/host/desktop/src/profile.ts` |
| Host face | The Node half running in the Electron main process: tools, HTTP routes, system prompt, subprocess, tray | each package's `src/index.ts` |
| Client face | The browser half running in the sandboxed renderer: slots, theme, locale, panels | each package's `src/client/index.ts` |
| Platform module table | The module set the shell shares with every client bundle (React and friends); it decides which imports must stay external | `scripts/platform-modules.mjs` |
| Slot | A named seat in the interface; a parent component declares children, plugins register components into the seat | upstream `@deepseek-ai/dsh-client-ui-slots` |

## Write a minimal plugin

A host-only plugin needs no build tooling — two files are enough. `package.json`:

```json
{
  "name": "@example/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`:

```yaml
- insert:
    - id: my-plugin
      name: '@example/my-plugin'
      config: {}
```

`index.js` must pick exactly one of the two export forms below, never a mix:

```ts
// Form one: a function plugin — named exports only, no default export
import z from '@deepseek-ai/schemastery'

export const name = 'my-plugin'
export const inject = ['tools']
export const Config = z.object({ /* … */ })

export function apply(ctx, config) {
  ctx.effect(() => {
    const dispose = ctx.tools.register(/* … */)
    return () => { dispose() }
  }, 'my-plugin: tools')
}
```

```ts
// Form two: a service-class package — default-export the class, others read it via ctx.get
export default class MyService extends Service {
  constructor(ctx) { super(ctx, 'myService') }
}
```

The conventions every product-owned package follows:

- Function plugins only have the named exports `name` / `inject` / `Config` / `apply`, **with no default export**; service-class packages default-export a service class;
- `Config` validates the row's `config` with a Schemastery schema; **a key absent from the row is a schema default**, so decide each key's default behaviour explicitly when writing the schema;
- Every side effect (tools, routes, listeners, timers, slots) is wrapped in `ctx.effect` and returns a cleanup function: plugin unload and generation rebuilds both rely on it to roll back;
- Each product package carries its own `./invariant` subpath (in-package invariant self-checks) and explicit `exports`.

Three patch semantics are worth memorising (implemented in upstream `deepseek-harness/vendor/include/src/index.ts`):

1. **`config` replaces whole keys**: the `config` you write in a patch replaces the entire configuration, it is not a deep merge. To override one key you must restate the other keys at that level.
2. **A missing row id only warns and is skipped** (`patch: entry "<id>" not found`); it does not fail startup — this is the number one reason a patch "looks written but has no effect".
3. A `name` that disagrees with the target row is skipped the same way (`patch: name mismatch`). So when patching an existing row, copy both `id` and `name` verbatim.

## Host face and client face

A plugin can have one half or both; the two halves are **not in the same process** and share no memory.

| Capability | Which face | Notes |
|---|---|---|
| Model tools, system prompt, HTTP routes, subprocess, filesystem, sandbox, settings namespaces | **Host face** | Anything needing Node capabilities or local resources can only live here |
| Tray items | Host face | Contributed only through `desktopRuntime.registerTrayItem` (see below) |
| Interface panels, slots, theme, locale dictionaries, client store, command palette | **Client face** | The renderer is a sandboxed web page with no Node access |
| Sessions, login state | One view on each face | The host face has `sessionController` and its own session services; the client face has the client-side `sessions` — two different services |

Between the two halves there is **exactly one channel: loopback HTTP and WebSocket**. The client face cannot read host services directly, and the product adds no preload or Electron IPC bridge for it. A plugin with a UI follows the ordinary DSH pattern — the host half registers same-origin HTTP routes (conventionally under `/api/pico/…`) and the client half consumes them with fetch; a write surface must attach its own proof of possession (same-origin checks) instead of assuming "a local request is trustworthy".

One concrete trap: `ctx.locale` is a **client-face-only** service and the host face cannot reach it. When the host side needs user-visible copy (injected HTML pages, window titles, tray labels, error payloads), use `@picoaide/dsh-host-locale` (`hostLocaleFrom(...)` plus `hostCopy(locale, zh, en)`) and **resolve it per request** — never freeze the language in a module-level constant.

### Why cross-package client imports are forbidden

A value import between client bundles breaks two invariants:

- **Module identity**: the shell puts React, cordis, the store, slots and friends into one frozen module table (the platform module table). Two packages each inlining their own React means two runtime instances, and hooks and context no longer line up.
- **Resolvability**: a specifier the module table cannot answer is a guaranteed runtime `require` throw in the browser. The artifact builds fine and breaks at runtime.

So there is a **purity gate** at build time: any value import of `@deepseek-ai/*` inside a client bundle is allowed only when it is in the platform module table, explicitly requested through `dsh.client.external`, or part of an inlinable pure contract layer. Everything else fails the build (type imports are erased and never reach the gate). The upstream implementation lives in `deepseek-harness/packages/client/tsdown.client.ts`.

**Cross-plugin collaboration has exactly two routes**: a Cordis service (preferred — for example panels register entries with the `ctx.picoFootMenu` service provided by `@picoaide/dsh-foot-menu`), or a shared slot contract.

### Slots: the correct way to inject and register

Slots are the "parent declares the seat, plugins put a component in it" mechanism. Two APIs:

```ts
ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
  name: 'sidebar.footer.action',
  id: 'my-entry',
  order: 5,
}, MyEntryComponent)), 'my-plugin: sidebar entry')
```

- `ctx.slots.register(options, component)` registers one occupant. **The slot must already be declared by some parent entry's children table**, otherwise it throws `slot "<name>" is not declared`; a duplicate occupancy of the same name at the same priority also throws — a different `priority` is what shadows (the lowest value renders).
- `ctx.slots.inject(key, callback)` runs the callback once the slot **is declared**, and disposes automatically when the declaration collapses; it is mandatory for parent plugins that have not mounted yet, because a direct `register` throws on an undeclared slot.
- Both calls belong inside `ctx.effect`, and the disposers are collected by the fiber's unload.

Do not read another plugin's DOM, stylesheets, or component source to guess placement: pick a slot that already allocates space (`conversation.composer.dock`, `sidebar.footer.action`, `shell.overlay`, `settings.section`, and so on). Every product panel is injected this way.

## The platform module table and external alignment

This line is a hard contract:

- **Platform module table (`PLATFORM_MODULES`)**: `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, `@deepseek-ai/dsh-client-ui-dockkit` — 9 entries; the single source of truth in this repository is `scripts/platform-modules.mjs`, mirrored entry by entry from the pinned upstream `deepseek-harness/packages/client/web/src/platform.ts`.

The alignment rules:

- The table's modules + upstream's `PRELOADED_CLIENT_EXTERNALS` + the specifiers you declare in `dsh.client.external` = **the set that must stay external**; everything else is inlined. That is exactly how the tsdown side decides (`neverBundle = isRequested`, `alwaysBundle = !isRequested`).
- Each product package spells its `external` list in its own `tsdown.config.ts` and imports `PLATFORM_MODULES` / `PRELOADED_CLIENT_EXTERNALS` from `scripts/platform-modules.mjs` (see `packages/host/connectors/tsdown.config.ts`) — **never copy the literal list into a package**.
- A client bundle must also define `process.env.NODE_ENV` (via `define`), otherwise an inlined library reading `process` throws `ReferenceError` in the browser.
- The artifact shape is fixed: `lib/client.js` contains one `window.__ModuleLoader__.load({ id: '<package name>', factory(require) { … } })`, and `require('react')` inside the factory resolves from the module table.
- Drift is gated: `node scripts/verify-inventories.mjs` diffs `scripts/platform-modules.mjs` against the upstream source of truth in the submodule entry by entry, and fails when upstream cannot be read (it does not "skip").

## Local debugging

| Command | What it does |
|---|---|
| `corepack yarn check` | The full gate: build + typecheck + tests + 17 root guards (parallel orchestration constrained by the build graph) |
| `yarn check:fast` | Only the packages this change touches (mapped from `git status`/`git diff`; a top-level file change escalates to the full run) |
| `yarn workspace <package> check` | One package: build + tests |
| `yarn workspace <package> typecheck` | One package's type check (**vitest does not do a full type check**, so new criteria must run tsc) |
| `yarn workspace dsh-plugin-desktop verify:profile` | Headless Loader smoke: assembles the fixed profile, compares the composed row set and `disabled` flags against the live tree, and pins the product-decision rows that must stay disabled |
| `yarn workspace dsh-plugin-desktop verify:loader` | Loader boot smoke (headless) |
| `yarn dev` | Launch the desktop app when a graphical session exists (builds first) |
| `yarn workspace dsh-plugin-desktop e2e:client` | Client end-to-end automation against a packaged build under Xvfb |

A headless environment is the norm: builds, type checks, unit tests, and Loader smokes must all run with no display. Application logs land in `logs/dsh-<date>.log` under Electron's userData directory (warnings and errors also go to `.error.log`); look there first when startup fails — `ctx.logger` warnings never appear on stderr.

## Ship inside the desktop client

### The fixed profile and the user patch layer

The application runs **exactly one profile**: `desktop`. The tray has no profile selector and the CLI refuses to manage it (`dsh --profile desktop` and `dsh plugin --profile desktop` both report "managed exclusively by the Electron application").

Third-party plugins have two landing paths:

| Path | How | When it takes effect |
|---|---|---|
| Runtime install | Edit `cordis.patch.yml` under the **current data root** and append a row using patch syntax; put the package itself into the profile's `node_modules` | **Restart the app** |
| Bundled distribution | Add the package to the profile's bundle list and the packaging manifests (see below) | With the next installed build |

The minimal patch for a runtime install:

```yaml
- insert:
    - id: my-plugin
      name: my-plugin-package
```

The data root differs per channel (channel content decides `home_dir`, and branded channels have independent directories); writing the patch into the wrong data root means the plugin never appears. **The profile has no HMR**: the `hmr` row is explicitly disabled in the desktop composition (it requires an `appReady` service the desktop does not provide), so "edit and restart" is the designed semantic, not a defect.

### Manifests to register for bundled distribution

To ship a package as a bundled desktop plugin, besides `dsh.bundle.patch` and `dsh.client` you must register it in the following places (miss one and you get either "green locally, red in CI" or "the packaged build fails at startup"):

- `scripts/check-workspaces.mjs`: the package table, path owners, and dependents;
- `packages/host/desktop/scripts/prebuild-workspace-deps.ts`: the build order (leaf packages → business packages → desktop);
- `scripts/verify-layout.mjs`: the package-name table;
- the CI workspace build artifact archive list;
- the required entries in `packages/host/desktop/scripts/verify-packaged-runtime.ts` (real asar / physical runtime entries).

The profile's bundle list is repaired by `desktopBundleList()`: required layers come first in a fixed order and third-party bundles follow in their previous order; **any skipped required layer is fail-loud** (silently losing one lets "recompute the composition when a setting is written" strip those rows out of the live tree).

### Bundled runtimes: so the agent can actually run things

The client ships three runtimes under `resources/runtimes/` (not inside the asar): Node.js 24, pnpm 11, and CPython 3.12. At startup it **prepends `<resources>/runtimes/bin` to the application's own PATH**, which only affects child processes the application derives (the agent's shell commands, MCP stdio servers, the pnpm used by `plugin_manager`) and never changes the system environment; `pip install` targets and `.pyc` caches are redirected into the application data root.

What this chain means for plugin authors:

- `plugin_manager`'s `install_bundle` / `remove_bundle` really work on the client (the package manager comes from the bundled pnpm);
- a plugin may assume that JS or Python the agent writes can simply be executed;
- outbound access still obeys client policy (no proxy by default), so **an offline environment can only install local bundles from the workspace**.

### Tray and desktop contract

The desktop opens exactly two surfaces to third parties; see [`packages/host/desktop/docs/plugin-services.md`](https://github.com/picoaide/picoaide-harness/tree/master/packages/host/desktop/docs):

```ts
export const inject = ['desktopRuntime']

export function apply(ctx) {
  ctx.effect(() => {
    const registration = ctx.desktopRuntime.registerTrayItem({
      group: 'tools',
      order: 30,
      label: () => 'Example Action',
      invoke: () => { /* explicit user action */ },
    })
    return () => { registration.dispose() }
  }, 'my-plugin: tray command')
}
```

The rules: tray contributions must live inside `ctx.effect` (they are removed on dispose); a `registration` must not outlive its effect; handle asynchronous failures inside `invoke()` yourself; and **do not assume the tray's label set** — the desktop's own items can change. `desktopActions` (restart only) currently describes a contract for the desktop shell but is not exposed to third parties; probe with `ctx.get('desktopActions')` before use and treat it as not guaranteed.

**Not third-party APIs**: `desktopRuntime`'s window/tray methods, launcher bootstrap values, generated shims, state-file formats, Loader row ordering, and Electron implementation details. Plugin authors should not read them, nor cache service references or window objects across generations.

## Adding capabilities to the enterprise server

The server is a Go program and **is not a Cordis host**: the runtime image has no Node, so DSH plugins cannot run server-side. Adding server capability means adding a Go module:

- Business packages live in `server/internal/<module>/` (`serverauth` / `llmgateway` / `marketplace` / `capabilities` / `serverstore` / `bootstrap` / `util`, and so on); the admin console is `server/webadmin/src/` (a go:embed-embedded SPA);
- **Routes are declared centrally** in `internal/router`: business packages must not call `r.Group()` to register production routes, and admin-surface routes must declare their permission points; API failure responses all use the `{"error":{"code","message"}}` envelope;
- Adding an API means keeping both ends in sync: the client (`packages/host/enterprise`) calls `/api/client/v2/*`, the admin console calls `/api/server/admin/*`.

### The boundary between build-time injection and runtime configuration

| Category | Examples | How it takes effect |
|---|---|---|
| **Build-time injection** (changing content = rebuilding the image) | Channel content: product name, tagline, welcome copy, logo, theme colour, data root, deep-link scheme, app origin scheme, built-in server URL | Injected into the image's `/opt/picoaide/channel/` at build time; the client writes it into the relevant rows' config **during assembly** via `channelProfilePatches()` |
| **Runtime configuration** (admin console / database / environment variables) | Model catalogue and pricing, rate limits and peak windows, balance-gate policy, connector catalogue and delivery switches, capability approval and authorization, audit retention days, app-centre limits | Saved in the admin console and effective immediately; a few items (such as an app's per-instance memory) need a server restart |

Why brand copy is not runtime-editable: it is a customer-visible deliverable that must be auditable and reproducible — the same configuration builds an image that renders identically on every machine. The client's bundled brand is a fallback (used when the server is unreachable); after login the channel content delivered by the server wins.

Channel values destined for the client **must be injected at assembly time**; a plugin must not read the bundled `channel.json` itself. A plugin's `lib/` is an inlined artifact, so `new URL('../build/channel.json', import.meta.url)` points at a nonexistent path inside the plugin package and silently falls back (reproduced on a real machine: a branded client's SSO callback was validated against the official scheme and dropped).

## Verification and gates

Every change must pass the gates; the commands and what each one judges:

| Command | What it judges |
|---|---|
| `corepack yarn check` | The single full entry point: parallel per-package `check` constrained by the build graph, plus the root guards |
| `node scripts/check-workspaces.mjs --list` | Prints the package table and guard list (the single source of truth) |
| `node scripts/verify-inventories.mjs` | Platform module table ↔ upstream; CI artifact archive list ↔ package table ↔ disk |
| `node scripts/package-dir.mjs` | Really packages and runs the afterPack required-entry smoke (the only criterion that catches "the package contents are wrong") |
| `node scripts/check-doc-claims.mjs` | Hard numbers and the module table in docs ↔ code sources |
| `node scripts/check-migration-range.mjs` | Migration ranges in docs ↔ the migrations directory |
| `node scripts/check-no-real-domains.mjs` | Public-surface discipline: no real domains, hostnames, or channel identities |

Common failure shapes, in the order you should check them:

| Symptom | Real cause | How to pin it down |
|---|---|---|
| The packaged build fails at startup with `ERR_MODULE_NOT_FOUND` | `exports` declares a subpath but the tsdown `entry` never listed it, so the artifact was never emitted; locally the tests run the source path and stay green | Compare `package.json`'s `exports` against the tsdown `entry`, then run the required-entry diff in `verify-packaged-runtime` |
| A patch is written but the row is unchanged | The row id is misspelled or `name` disagrees, and upstream only warns and skips | Search the startup log for `patch: entry "<id>" not found` / `patch: name mismatch` |
| Fields disappear after overriding config | A patch's `config` replaces whole keys | Restate the target row's other keys inside your patch |
| A row stays pending forever with no error | It `inject`s a service that does not exist, or it registers into an undeclared slot | Check whether the `inject` list has a provider in this composition; use `ctx.slots.inject` for slots |
| The client bundle build fails with a purity error | A cross-package value import | Move to a Cordis service or slot collaboration, or request the specifier in `dsh.client.external` |
| Green locally, red in CI | The local `lib/` artifacts already existed | Delete `lib/` and rerun (**do not delete `packages/vendor/memory-evolve/lib`** — that is vendored source) |

### What is rejected, and what is silently skipped

When debugging a plugin, first work out which class the failure belongs to — only the first one is loud:

- **Hard failures (fail-loud)**: a required bundle layer was skipped (`required profile bundles were skipped`); registering into an undeclared slot (`slot "<name>" is not declared`); a duplicate occupancy of the same slot at the same priority; a cross-package value import in a client bundle (a build-time purity error); a mismatch between the composed and live row set or their `disabled` flags (`verify:profile` goes red).
- **Warn and skip (you must go looking)**: a patch row id that does not exist (`patch: entry "<id>" not found`); a patch `name` that disagrees with the target row (`patch: name mismatch … skipping`); an optional client UI row requested by a user patch that this profile cannot resolve (the row is dropped with only a skipped record).
- **No reaction at all**: `inject`ing a service that has no provider in this composition leaves the whole fiber pending forever with no error — check whether the provider row is present first; asynchronous failures inside a tray item's `invoke()` only reach the log, where users cannot see them.

## Related

- [Plugin ecosystem](/en/plugin-ecosystem/) — the bundled plugin inventory, the four extension paths, and the boundaries
- [System architecture](/en/architecture/) — the three-layer topology and the boot sequence
- [Desktop client](/en/desktop/) — plugin management and bundled runtimes from the user's side
- [API reference](/en/api-reference/) — the server-side interface contract
- [Desktop plugin service contract (repo)](https://github.com/picoaide/picoaide-harness/tree/master/packages/host/desktop/docs/plugin-services.md) — types, lifecycle, and failure semantics
