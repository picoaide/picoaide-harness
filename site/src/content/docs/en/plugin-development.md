---
title: Plugin Development
description: 'How to develop plugins for PicoAide Harness: everything is a plugin, the two client-side/server-side forms, slot composition and constraints.'
---

Plugins are extension packages that add capabilities to DSH — models, tools, interfaces, and workflows can all be made into plugins. **PicoAide Harness does not fork or modify the upstream source; everything is a plugin composition**: the desktop shell itself (window, tray, updates, the fixed `desktop` profile) is a legitimate DSH plugin, taking the same official Cordis composition path as third-party plugins.

## Plugin Mechanism Overview

- **Upstream Holder**: official capabilities such as agent, model, tool, session, settings, webServer, and subprocess run as-is at a pinned version;
- **Desktop Host Services**: window, tray, and updates; the third-party contract is documented in the repository at `packages/host/desktop/docs/plugin-services.md` ([link](https://github.com/picoaide/picoaide-harness/tree/master/packages/host/desktop/docs)) — the `dsh-plugin-desktop` root entry plus subpaths such as `./desktop-home`, `./diagnostics`, `./updates`, and the `desktopRuntime.registerTrayItem` tray registration;
- **Web Client**: the official Web UI plus third-party browser interfaces, working through the loopback carrier and not calling Electron directly;
- **Native runtime**: Electron BrowserWindow, system tray, and file/network/installer adapters — `desktopRuntime` is for use only by Desktop's own rows, **not a third-party API**.

## Two Plugin Forms

| Form | Convention |
|---|---|
| **Service-class packages** | default-export a service class (e.g. `SessionService` / `HostCronService`) and provide it via `ctx.get`; example: `dsh-enterprise/session-service` |
| **Function plugins** | only named exports `name` / `inject` / `Config` / `apply`, **no default export**; `Config` is validated with a Schemastery schema; all side effects are wrapped inside `ctx.effect` (rollback on HMR/unload); examples: `pico-cron`, `pico-connectors`, `pico-browser` |

## Client Plugins

Client plugins are built with the **`clientBundle` preset** (tsdown), aligning external dependencies with the platform module table (`PLATFORM_MODULES` — react-dom, react-dom/client, `@deepseek-ai/dsh-client-web-react`, `dsh-client-ui-primitives`, `dsh-client-ui-attachment`, `dsh-client-ui-schema-form`) and the **client packages actually imported**.

- **Client-side cross-package imports are forbidden**: the source package injects via `ctx.slots.inject` inside `ctx.effect`, and the target package registers via `ctx.slots.register` in its own client;
- The type-check `tsconfig.client.json` needs `skipLibCheck: true` (to avoid internal type errors in the upstream `dsh-client-ui-sidebar` d.ts);
- **`immediately: true` is limited to stage-one-prefetch infrastructure plugins**; regular plugins omit it;
- Each package carries its own `./invariant` subpath and explicit exports such as `./index`.

### UI Extension Points (slot)

Every functional panel of the product UI is injected through a slot (e.g. `sidebar.footer.action`). Example (connector):

```ts
ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
  name: 'sidebar.footer.action',
  // …panel identifier, open/close events, icon and copy
}))
```

The same pattern is used for: the capability center entry (`sidebar.footer.action` id=`capability-center`), the scheduled tasks Tab, the browser entry, settings sections (`settings.section`), and branding areas (`sidebar.brand.mark` / `conversation` hero mark), among others.

## Server (Host) Plugins

- Service-class packages default-export a service class; function plugins only have named exports `name` / `inject` / `Config` / `apply`;
- Host plugins provide capabilities through official services such as `webServer` / `apiProxy` / `tools` / `systemPrompt`;
- **Loopback API pattern** (the common approach for connectors/scheduled tasks/browser): the plugin registers same-origin HTTP APIs (`/api/pico/...`), which the client UI consumes via fetch; `isLoopbackRequest` / `browserSameOriginMarker` validate that the request comes from a same-origin client;
- **Model tool registration**: `ctx.tools.register(defineTool({...}))` — scheduled tasks expose `cron_create`/`cron_list`/`cron_set_enabled`/`cron_run`; the browser exposes the `browser_*` tool group; tools are registered inside `ctx.effect` so they can be unloaded;
- **Cross-plugin events**: types are only declared (`declare module '@deepseek-ai/cordis'`); runtime events are emitted by their owner — e.g. `pico/session-changed` (owned by enterprise, only consumed by connectors/cron/browser).

## Common Constraints Checklist

- Service-class packages default-export a service class; function plugins have no default export;
- Each package carries its own `./invariant` subpath;
- `ctx.slots.inject` is wrapped inside `ctx.effect`; client-side cross-package imports are not supported;
- Password/secret fields use SecretInput for show/hide toggling; upload/download bodies have limits (e.g. 24MB uploads, 100MB browser downloads);
- Archive safety (skill/preset packaging and unpacking) is validated on both sides (`assertArchiveSafe` in `archive-util` is made shared);
- Directory/file path permissions: credentials are written atomically with 0600/0700, symlinks are prevented; DSH_HOME is validated for safety (rejecting critical system directories).

## Enterprise Server (Go) Development

The server is modularized under `server/internal/` (serverauth / llmgateway / marketplace / sharedskills / agentshare / capabilities / serverstore / bootstrap / util), and the admin console is `server/webadmin/src/` (a shadcn React SPA embedded via go:embed). See the repository `server/docs/` and `AGENTS.md` for developer conventions.

## More Resources

- [Repository: full plugin development doc](../docs/plugin-development.md) (repo docs/)
- [Plugin ecosystem manifesto](./plugin-ecosystem)
- [Desktop plugin service contract (repo)](https://github.com/picoaide/picoaide-harness/tree/master/packages/host/desktop/docs/plugin-services.md)
- [Community Fabric RFC (repo)](https://github.com/picoaide/picoaide-harness/tree/master/community/fabric/README.md)
- [System Architecture](./architecture)
- [Architecture overview](../docs/architecture.md)
- [Community Fabric (community interoperability RFC)](../community/fabric/README.zh.md)
