---
title: Plugin Ecosystem
description: How the upstream ecosystem relates to this product, the bundled plugin inventory, the four extension paths, and what plugins cannot do.
---

PicoAide Harness's plugin ecosystem is not a marketplace — it is **a set of composition conventions plus one bundled inventory**: upstream provides the framework and the module table, this product composes its capabilities in as plugins, and third-party authors take the same path. This page answers three questions: which plugins are installed right now, which of the four extension paths a new capability should take, and what plugins cannot do.

## How the upstream ecosystem relates to this product

Upstream is DeepSeek Harness (`deepseek-ai/deepseek-harness`), and this product runs it **unchanged at a fixed version**: the current pin is `dsh-v0.2.0-rc.2`, with `upstream.json` at the repository root as the source of truth. The split is clear:

| | Upstream | This product |
|---|---|---|
| What it provides | The Cordis plugin framework, core capabilities (agent, session, tools, sandbox), the Web UI, the `@deepseek-ai/dsh-*` package family with its official bundles (`dsh-base`, `dsh-web-app`, and the presets), and the plugin-authoring skills the agent reads | The desktop shell and three platform clients, the enterprise server (auth / gateway / metering / capability hub / audit), channel white-labelling, ten product-owned composition layers, and a small number of upstream patches that each carry criteria |
| How plugins are installed | Loader composition: bundle layers → profile layer → user layer → overlays; packages come from npm into the profile | The same Loader semantics; additionally one fixed `desktop` profile and a narrowed interface to raw Electron capabilities |
| Ecosystem shape | **No plugin marketplace**; the install path is "author a bundle, install it into the profile with a package manager" | No marketplace either. Two routes for third-party plugins: the user patch layer (takes effect on restart) or bundled distribution (see [Plugin Development](/en/plugin-development/)) |

Three things worth knowing:

- **An upstream upgrade is an external dependency change, not an internal refactor.** Every upgrade brings new rows and new defaults (a new optional bundle, a new telemetry row, a new authentication adapter row). This product disposes of each one explicitly — enable, disable, or take over — and writes the reason next to that row in `packages/host/desktop/cordis.patch.yml`. The criterion is a product decision (does session content leave the customer environment, does it conflict with our own panels, does it need platform-native engines), never "upstream defaults it on, so we do too".
- **Upstream ships interfaces, not promises.** Row ids, Config defaults, client CSS class names, and the internal composition of optional bundles all change; authors and maintainers should depend on contracts rather than implementations.
- **Community interoperability standardisation is still a draft.** `community/fabric/` in this repository is the **documentation** of the DSH community interoperability RFC (Manifest, Capability, Host Descriptor, events): no runtime, no released schema, no installer, and working plugins still use the existing DSH/Cordis interfaces. It states one safety boundary explicitly — **same-process JavaScript must never be disguised as a security sandbox**; only a host with real isolation evidence may claim that permissions are technically enforced.

## What rules the ecosystem runs on

The three rules are both requirements for plugin authors and the rules this product follows itself:

1. **Composition first**: compose capabilities through official bundle layers, services, slots, and patches; never assume or override another plugin's internals. The desktop shell is the example — it is ten patch layers plus one `desktopRuntime` registration contract, with no privileges.
2. **Declare clearly**: state the services and slots you depend on, and state your external module requests explicitly; do not rely on runtime coincidences (such as "some slot has probably been declared by now").
3. **Compatibility first**: prefer upstream's stable seams (services, slots, config schemas) over row ordering, DOM structure, or internal fields.

The gates land on exactly these rules: module-table drift, manifest drift, a profile that will not assemble, a packaged artifact missing required entries, and cross-package value imports in client bundles are all build-time red lights rather than runtime surprises.

## The bundled plugin inventory

Every plugin the desktop client assembles is listed below. The **Face** column says whether a package provides a host face (Node, inside the Electron main process), a client face (the sandboxed renderer), or both; the **Rows** column names the Loader row ids it mounts.

| Package | Capability it provides | Face | Main rows |
|---|---|---|---|
| `dsh-plugin-desktop` | The desktop shell: window and navigation policy, tray, update checks and install handoff, diagnostics export, completion/question/approval notifications, the asar filesystem and its read guidance, and the advanced presentation's layout and theme projection | both | `desktop-shell`, `desktop-diagnostics`, `desktop-updates`, `desktop-loop-notify`, `desktop-asar-fs` |
| `@picoaide/dsh-enterprise` | The enterprise login gate (pre-auth page, server URL, login methods), sessions and tokens, gateway model catalogue wiring, bootstrapping, error reporting, skill telemetry, channel content sync, and the capability hub entry | both | `picoaide-auth-gate`, `picoaide-session`, `picoaide-gateway-llm`, `picoaide-bootstrap`, `picoaide-channel-sync` |
| `@picoaide/dsh-connectors` | The connector framework (MCP registration, authentication, credential storage and renewal), the connector centre panel, and one slash command per connected connector | both | `pico-connectors` |
| `@picoaide/dsh-cron` | Scheduled jobs: the job ledger, five model tools (`cron_create` / `cron_list` / `cron_set_enabled` / `cron_run` / `cron_remove`), execution history, and the panel | both | `pico-cron` |
| `@picoaide/dsh-browser` | The built-in browser: a separate window (`WebContentsView` + CDP), the control-handover model, the op log, the `browser_*` tool group, and the sidebar entry with its status hints | both | `pico-browser` |
| `@picoaide/dsh-wasm-apps-host` | The host side of app windows: the custom protocol handler, request forwarding to the platform, and window lifecycle and partitioning | host | `pico-wasm-apps-host` |
| `@picoaide/dsh-wasm-apps` | The app centre panel: the catalogue, opening an app, and the publish entry | client | `picoaide-wasm-apps` |
| `@picoaide/dsh-foot-menu` | The sidebar's bottom "⋯ More" row and the popover host (the single carrying row for all five panel entries) | client | `picoaide-foot-menu` |
| `@picoaide/dsh-account-card` | The bottom sidebar account card: username, logout, and gateway usage balance | client | `picoaide-account-card` |
| `dsh-memory-evolve` | Five-track memory (user profile / global facts / project key memory / project log / daily log) plus four todo tracks and skill self-evolution; a **vendored community plugin**, upgraded by three-way merge | both | `dsh-memory-evolve` |
| `@deepseek-ai/dsh-experimental-voice-input-bundle` | Voice input: SenseVoiceSmall plus Silero VAD in a local child process, with audio never leaving the machine; an upstream optional bundle that this product assembles by default | both | the four rows that upstream bundle inserts |
| `@picoaide/dsh-host-locale`, `@picoaide/dsh-host-home` | Host-side locale resolution and data-root derivation; **zero-dependency leaf packages** (Node built-ins only), libraries rather than rows | host | none (imported by other packages) |
| `@picoaide/dsh-panel-surface` | The centre-column full-page panel container and shared visual language (two plugins mount panels with it) | client | none (imported by other packages) |
| `@picoaide/dsh-branding` | Brand mark, favicon, and theme injection; **web assembly only — the desktop composition does not mount it** (the enterprise client face owns the desktop favicon) | client | none (absent from the desktop profile) |

What is *not* in the inventory matters just as much: there is **no plugin marketplace** (no market page, no installer, no reviewed catalogue), and the **upstream UI plugin-manager page is not mounted** (that row is explicitly disabled — the panel seats it occupies do not interoperate with our own four panels' DOM takeover).

## The four extension paths

Before adding a capability, decide which class it belongs to. The four paths do not replace each other:

| | Plugin | Connector (MCP) | Skill (SKILL.md) | App (WASM) |
|---|---|---|---|---|
| **What you write** | An npm package: `dsh.bundle.patch` plus an optional `dsh.client` browser bundle | One standard MCP config (`type` + `url`, or `command`/`args`/`env`) with a title, and no code | A directory with a `SKILL.md` carrying frontmatter | A static front end, a `wasm32-wasip1` module, and `picoaide.app.json` |
| **Where it runs** | The employee machine: the DSH Host inside the Electron main process plus the sandboxed renderer | The MCP server's own machine; the client connects as an MCP client | Nowhere; the model reads the file and then calls **existing** tools | The server's wazero sandbox; the employee opens it in a separate client window |
| **What it can do** | Register model tools and system-prompt text, add same-origin HTTP routes, add interface panels and slots, reach local capabilities (subprocess / files / tray), and provide Cordis services other plugins reuse | Give the model an external system's capabilities as tools; authentication is decided automatically (tokenFields → static token, streamable-http → OAuth with dynamic registration, otherwise credential-free) with automatic renewal | Fix processes, conventions, wording, and checklists into reusable guidance; project-level and user-level skill roots are all scanned; upload, review, and per-department authorization via the capability hub | Give a business colleague a self-built tool: one app database, one bundled static asset tree, host calls (read assets / log / SQL), plus the client AI loop |
| **What it cannot do** | Cross-package client value imports; widening its own privileges; bypassing server authentication or metering; shipping an unregistered native dependency | Only offer what the MCP server already implements; the client applies hard policy to its outbound traffic and credentials (denied environment-variable keys, governed address ranges) | A skill adds no capability by itself: no new tools, no permission changes, no dependency installs | No outbound network requests, no file access, no threads or timers; data inside one app is shared by every user; changing the access list means publishing a new release |
| **How it takes effect** | Runtime install: edit the patch layer and **restart the app**; bundled distribution: with the version | An administrator maintains the catalogue and delivery switches; employees connect and use it | Drop it into a skill root and it is discovered | The author publishes → the platform validates and compiles → the employee opens it from the app centre |

Choosing, from lightest to heaviest:

- You only need the model to **follow your rules** (process, conventions, templates, checklists) → **skill**. Zero code, fastest to change.
- The capability **already exists elsewhere** (your own service, a third-party SaaS, an MCP server someone provides) → **connector**. Do not write a plugin just to reach one HTTP endpoint.
- You need a **product-level capability**: a new tool, panel, service, or local resource → **plugin**. It is the only path into the host face and the interface composition.
- You want to give a business colleague a **self-built tool** (a register, a checklist, a calculator) → **app**. It runs in the server sandbox and the employee opens it in a separate client window, with no public entry point or certificate needed.

## Boundaries: what plugins cannot do

This list is deliberate — do not expect a plugin to work around any of these six.

1. **A plugin cannot isolate itself or anyone else.** Every plugin runs in the same process as the host, and the community interoperability draft states plainly that same-process JavaScript is not a security sandbox. File-effect confinement comes from the upstream sandbox providers (Linux: bwrap then Landlock; macOS: Seatbelt; Windows: restricted token plus ACL) and its tier is chosen by the session's permission mode — a plugin can neither change it nor lock another plugin inside it. Real isolation only comes from **capabilities that do not exist**: the WASM app runtime mounts WASI only, with zero preopens and no args or env, so it has no sockets, no spawn, and no filesystem.
2. **A plugin that needs native binaries must clear four packaging manifests.** `asarUnpack`, `REQUIRED_PACKAGED_RUNTIME_ENTRIES`, `REQUIRED_UNPACKED_RUNTIME_ENTRIES`, and `MACOS_ARM64_NATIVE_ENTRIES` are declared entry by entry; an unregistered native dependency stays inside `app.asar` and can never be spawned, and **zero coverage in those four manifests raises no gate at all** (the Office-to-PDF row is disabled precisely because it pulls in five platform engine packages that none of the four lists cover). Third-party plugins installed at runtime are outside this guarantee entirely.
3. **Server-side authority cannot be bypassed by a client plugin.** Upstream API keys live only on the server (AES-GCM encrypted, with an independent master key file), the account balance is the only billing gate, and permission points, approvals, and auditing all live on the server. A client plugin changing local code can at most fool itself: the server still refuses. Adding server capability means adding a Go module (see [Plugin Development](/en/plugin-development/)).
4. **A packaged build cannot read ordinary file paths inside the asar.** The host process's own file reads can open the archive, but shell commands, the search tools (which run a native ripgrep process), `node`, and package managers cannot. Read bundled assets through the host file API.
5. **An app (WASM) is not a general execution environment.** No network, no files, no threads or timers; one database per app (100 MB size cap), 64 MiB per instance, a 10-second guest budget per call; the officially supported language is Go only (Rust and Zig work but are not promised); data inside one app is shared by all users, so "each user sees only their own" needs your own column and your own check; changing the access list equals publishing a new release.
6. **Upstream contracts change.** Row ids, Config defaults, client CSS class names, and the composition of optional bundles are external dependencies; upgrades require reviewing each disposition row by row, and the client-bundle module boundary (cross-package value imports are rejected at build time) is a hard constraint rather than advice.

## Related

- [Plugin Development](/en/plugin-development/) — write a plugin from scratch, debug it locally, ship it into the client or the server
- [System architecture](/en/architecture/) — the three-layer topology and the boot sequence
- [Desktop client](/en/desktop/) — plugin management, bundled runtimes, and outbound policy from the user's side
- [Community Fabric (RFC drafts, repo)](https://github.com/picoaide/picoaide-harness/tree/master/community/fabric) — draft plugin Manifest, Capability, Host Descriptor, and events
