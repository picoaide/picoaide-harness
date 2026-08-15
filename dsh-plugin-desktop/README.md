# DSH Desktop

English | [中文](README.zh.md)

`dsh-plugin-desktop` runs DSH in Electron while remaining part of the ordinary Cordis composition. The installed application is named **DSH Desktop**. The package provides the `dsh-plugin-desktop` executable and the `dsh-desktop` alias; the registered npm package name is the reliable `npx` entry.

## Architecture

The Electron executable is minimal bootstrap code. It acquires the single-instance lock, resolves the selected DSH profile, provides the native runtime capability, and boots the Host Cordis root in the Electron main process. The `desktop-shell` Host plugin owns the `BrowserWindow`, navigation policy, settings namespace, and close-versus-quit lifecycle through Cordis effects. The native runtime owns the physical tray, while `desktop-shell`, `desktop-profiles`, `desktop-terminal`, and `desktop-updates` contribute effect-scoped commands through its ordered item registry.

Both presentation modes reuse the existing loopback Web carrier. The profile mounts the ordinary `dsh-base` and `dsh-web-app` bundles, the Host binds its HTTP and WebSocket surface to `127.0.0.1` on an ephemeral port, and Electron loads that same-origin page in a sandboxed renderer. There is no Electron-owned plugin roster, preload bridge, or raw Electron API in the renderer.

The desktop package has normal Host and Web Client faces. Its Client face validates the Host-supplied mode and platform markers in both modes. Compatibility then returns without registering services, slots, styles, or presentation; advanced mode installs the desktop layout service and root presentation described below. Third-party Web clients continue to use the ordinary DSH module graph in both modes.

The tray profile selector lists existing profiles and the lazily available `desktop` and `web` defaults. A selectable profile directly composes `dsh-base` before `dsh-web-app`; headless, malformed, or already desktop-embedded profiles remain visible but disabled. `desktop` is the only launcher-managed profile: its installation-owned prefix is repaired while third-party bundle order is preserved. Every other selected profile keeps its manifest, user patch, and dependencies unchanged. The launcher inserts its own desktop layer after `dsh-web-app` for the active generation and never persists that layer in the selected bundle list.

Profile selection is desktop-owned state under Electron user data, not another field inside a selected profile. A switch is recorded as pending and takes effect through an orderly restart. The new profile becomes last-known-good only after the Cordis tree and native window mount successfully; the tray is created after the Web surface loads, and that state commit completes synchronously before tray commands can run. A failed pending generation is rolled back and relaunched once. Official profiles use the same DSH home for sessions, settings, and storage by default, so switching does not copy or migrate records. A custom profile patch may deliberately redirect one of those persistence roots.

Bare Cordis plugin imports resolve from the persistent profile. A narrow Node resolve hook applies only to imports issued by `@deepseek-ai/cordis-plugin-loader`, so profile-local third-party packages and the healed launcher fallback use the same resolution path even when packaged Electron does not expose Node's internal ESM loader.

Before profile preparation and Cordis boot, the launcher prepends a private command directory containing only the pinned bundled `pnpm` command to the current Electron main process `PATH`. Host and third-party plugins can therefore discover that package manager from startup, including through ordinary DSH subprocess providers, without requiring a system Node.js installation. The public runtime path does not expose `node` or `dsh`; its private Electron-backed Node helper and the `ELECTRON_RUN_AS_NODE` and npm ABI variables exist only inside the pnpm subprocess tree. The launcher does not modify the system `PATH`, shell startup files, profile configuration, or `.env` documents.

## Mode setting and restart boundary

The `dsh-desktop.mode` field in the DSH home `settings.yaml` document is the single source of truth:

```yaml
dsh-desktop:
  mode: compatibility # or advanced
```

The launcher reads the same file resolved by the active `@deepseek-ai/dsh-settings-file` row before composing a generation. The Host registers the `dsh-desktop` namespace with the standard settings service. There is no parallel mode value in the profile manifest.

Users can select the other mode from the tray or edit the DSH home `settings.yaml` document by hand. The tray updates the registered `dsh-desktop` settings namespace, while a manual edit changes the same file observed by the settings provider. A committed change requests one orderly restart: the current Cordis tree disposes first, then Electron relaunches only after a successful zero-code shutdown. The application never hot-swaps root slots, native window materials, or Loader rows inside a live renderer generation.

Linux supports compatibility mode only. Its tray mode command is disabled, and an advanced value is rejected rather than silently falling back.

## Compatibility mode

`dsh-desktop.mode` defaults to `compatibility`. This mode creates a normal operating-system window with its native frame and loads the official Web surface from the active DSH profile. macOS suppresses the visible page title. Windows retains the native caption icon and displays `DeepSeek Harness Desktop`, but removes the window menu bar. The operating system owns native title-bar color and appearance.

The desktop Client module validates the mode and platform markers, then has no compatibility-mode effects. It does not provide or replace the `layout` service, register a `root` or `sidebar` occupant, install styles, or change the conversation surface. Compatibility mode preserves the selected profile's own layout, sidebar, and conversation composition; the ordinary `desktop` and `web` profiles therefore keep the official rows unchanged.

The Cordis row registers native window values during profile activation. The launcher creates the window only after `app-boot` settles and audits the complete profile, so the first renderer manifest includes the active official, desktop, and third-party client plugins without a Loader-wide wait inside the plugin itself.

On Windows, the launcher pins the existing browse directory-picker backend and client surface instead of the adaptive native chooser. Workspace selection therefore remains inside the Web UI and never loads the native N-API dialog worker in the Electron main process. macOS and Linux retain the upstream adaptive chooser.

Windows PowerShell keeps the upstream `pwsh-sandbox` behavior and Windows ACL confinement in both presentation modes. The launcher generation replaces only that Host provider with the `dsh-plugin-desktop/windows-pwsh-sandbox` subpath from this same package. For the exact upstream ACL-runner argv, the adapter launches the packaged Electron executable in Node mode through a private trampoline, removes the Node-mode variable before the restricted PowerShell process is created, and delegates all policy and failure handling back to the upstream runner. Direct `danger-full-access` PowerShell, macOS, and Linux execution are unchanged; there is no automatic unrestricted fallback when Windows confinement fails.

## Advanced mode

Advanced mode is an explicitly composed desktop presentation for macOS and Windows. After all user patches have been read, the launcher disables the official `ui-layout` Loader row, keeps the official `ui-sidebar` and `ui-conversation` rows enabled, and applies the selected mode to `desktop-shell`.

The desktop Client then provides the `layout` service for its own Cordis-fiber lifetime and registers only the `root` slot occupant. Its root declares seats for the unchanged upstream sidebar, conversation, details, and overlay contributions. The official sidebar remains the `sidebar` occupant and continues to declare the workspace browser, settings shell, and additive footer-action seats. This preserves its component behavior, collapse animation, and third-party extension points while the desktop package owns only frame geometry and native material.

The advanced theme presenter projects the active upstream theme snapshot onto the document, including color scheme, resolved token values, dark-mode marker, and theme-color metadata. It subscribes to ordinary theme changes and removes only its own projected state when the generation disposes.

The desktop sidebar surface scopes the upstream sidebar-fill token to transparent, so the official sidebar and session-list fade reveal the native material without changing their component styles.

On macOS the advanced window uses a transparent hidden-inset title bar, positioned traffic lights, and native `sidebar` vibrancy. Its 90 CSS-pixel collapsed column centers the official 56-pixel rail below a desktop-owned traffic-light inset. The complete upstream sidebar is excluded from the native window drag region; only the empty title-bar strip to the right of the traffic lights drags the window, so official and third-party sidebar interactions remain clickable. A separate 32 CSS-pixel caption row above the complete conversation and details surfaces provides a stable Session-window drag target without selecting or covering feature-owned Header nodes. On Windows the official sidebar keeps compatibility geometry: 56 pixels collapsed, 280 pixels by default when expanded, and the same upstream transition behavior, while its transparent surface reveals Mica. The window uses a hidden title bar with native controls, transparent overlay, Mica background material, shadow, rounded corners, and a thick resizable frame. Electron exposes the system-drawn Mica material on Windows 11 22H2 and later. A desktop-owned 48 CSS-pixel caption row spans the Windows conversation and details columns; the complete upstream slot surfaces start below that row, so official and third-party header contributions keep their ordinary relative layout without element-specific caption offsets. Linux rejects advanced mode rather than silently falling back to a presentation different from the persisted setting.

## Development

This package is managed by the Yarn workspace at the repository root. The sibling `deepseek-harness/` checkout remains an independent upstream pnpm project and is not part of the Yarn workspace. Install and verify DSH Desktop from the repository root:

```sh
yarn install
yarn check
```

The check verifies that every required first-party peer in the production graph is declared by the desktop deploy root. Headless Loader smokes activate the launcher-owned desktop row and a profile-local third-party row, then boot the published Web profile and inspect its loopback root and client manifest. Unit and type tests cover both profile compositions, restart fencing, client environment validation, desktop layout state, and platform-native window options.

Start the desktop application explicitly when a graphical session is available:

```sh
yarn dev
```

`dev` builds before launching. It does not require a separate manual build.

The headless-safe launcher surfaces can be exercised without importing or starting Electron:

```sh
node lib/bin.js --help
node lib/bin.js --version
```

## Plugin workflow

Manage any profile with the ordinary DSH command:

```sh
dsh plugin --profile desktop add third-party-plugin
dsh plugin --profile desktop remove third-party-plugin
dsh plugin --profile desktop update
```

The application starts with `desktop` by default. Choose another Web-capable profile from the tray's **Profile** submenu; switching profiles restarts the application. The generated DSH terminal defaults bare commands to the currently active profile, so the shorter forms below modify that profile directly:

```sh
dsh plugin add third-party-plugin
dsh plugin remove third-party-plugin
dsh plugin update
```

An explicit `--profile <name>` remains authoritative and is useful for preparing another profile before selecting it.

The package can then be launched from npm with:

```sh
npx dsh-plugin-desktop
```

A third-party Host plugin only needs its normal `dsh.bundle` patch. A plugin with browser UI also publishes the normal `dsh.client` metadata with `platform: "web"` and an exported `./client` artifact. The upstream Web client module graph discovers it in both modes; Electron does not require a separate client build or a desktop-specific registration API. Advanced-mode contributions must target services and slots that exist in that explicit composition rather than assuming the official layout or sidebar occupant owns them.

## Desktop operations

Packaged applications check the fixed DSH Desktop GitHub repository for its latest stable release 60 seconds after startup and every six hours after a completed check. Each request has a 15-second deadline, shares one in-flight operation with manual checks, and uses a private conditional-request cache. Development and other unpackaged launches do not schedule network requests, but the tray always offers **Check for Updates…**, and a manual check reports its result through a native notification. A newer validated stable version changes that command into a release link; background discovery automatically notifies at most once per version. DSH Desktop only discovers the release and opens its exact GitHub page in the default browser; it does not download, install, replace, or restart the application.

On macOS and Windows, **Open DSH Terminal** opens a system terminal rooted at the active profile. Its welcome text identifies the application version, active profile, profile directory, and DSH home, then lists configuration and plugin-management commands. Inside this terminal, bare `dsh`, `dsh --dump-config`, and plugin subcommands without a profile selection default to that active profile; an explicit `--profile` and the upstream `web` alias keep their original meaning. DSH Desktop generates private per-profile `dsh`, `pnpm`, and `node` shims under its user-data directory, sets `DSH_HOME`, uses the active profile as the working directory, and prepends the shim directory only to that terminal's `PATH`. A later profile switch therefore does not change commands in an already open terminal. It does not edit the global environment or shell startup files. The macOS launcher preserves the user's interactive zsh or bash setup before restoring the desktop-owned values; Windows selects PowerShell 7, Windows PowerShell, or Command Prompt in that order. Linux does not compose the terminal command.

## Native lifecycle

Closing the window hides it while the Host Cordis tree continues running. The tray reopens the window, selects the active profile, opens the isolated DSH terminal, checks for a stable release, changes mode through the standard settings namespace, or requests an explicit quit. Profile and mode changes both dispose the current Cordis tree before Electron relaunches. Native quit, `SIGINT`, and `SIGTERM` also request disposal before exit; a five-second deadline or a repeated request forces the final exit. Navigation and redirects remain on the exact loopback origin; external HTTP, HTTPS, and mail links open in the operating system, while the renderer uses `contextIsolation`, the Chromium sandbox, and no Node integration.

## Packaging

`yarn package:dir` creates an unpacked directory for the current host platform. The packaged-runtime gate rejects an application archive that omits the desktop update and terminal modules, the DSH CLI bootstrap, or the bundled pnpm entry. Electron Builder emits the complete dependency tree under `app.asar.unpacked`, and the CLI bootstrap enters that physical tree so DSH profile-fallback symlinks never target a virtual ASAR directory. `build/app-icon.png` is the unmodified iOS Default application icon on macOS, Windows, and Linux. `build/tray-icon.svg` is the brand-blue tray source: the build derives a macOS template image that the system colors automatically and fixed brand-blue Windows and Linux tray images. Signed installers, notarization, and target-platform CI remain separate release work.

## Model Experience

None. The desktop package changes application composition and native presentation; it does not add model-visible instructions, tools, events, or request fields.

#### KV Cache effect

None. The same DSH Host and client feature plugins assemble model requests.

## Known Limitations and Deferred Work

- Adding or removing a profile bundle requires restarting DSH Desktop; the launcher does not watch profile manifests. Selecting another profile from the tray performs that restart automatically.
- Switching compatibility/advanced mode always restarts the application by design; a live generation never hot-swaps Loader rows, slot ownership, or native materials.
- Advanced mode is unavailable on Linux. Linux continues to use the compatibility presentation.
- The macOS and Windows tray terminal exposes private `dsh`, `pnpm`, and `node` shims. Separately, the Host runtime exposes only the bundled `pnpm` command on the current Electron process `PATH`; none of these commands are added to the system `PATH`, and Linux currently has no desktop terminal command.
- On Windows, `pnpm` is a `.cmd` shim. Upstream `dsh plugin`, PowerShell, and Command Prompt use a command interpreter and can resolve it, but a third-party plugin that calls Node `spawn('pnpm', { shell: false })` cannot execute that batch shim reliably. A lifecycle script that directly executes its `.cmd` `npm_node_execpath` with `shell: false` has the same restriction. Supporting those non-portable calls requires a native signed launcher.
- Release checks discover and announce stable versions but do not download or apply them. Installing a discovered release remains an explicit user action on the validated GitHub release page.
- The shared carrier is loopback HTTP and WebSocket, not Electron IPC. Replacing it requires transport extension points in upstream DSH and is outside this standalone package.
- This project currently pins the published DSH `0.1.0-rc.6` family, while the sibling `deepseek-harness/` source checkout predates that release. Tests therefore validate the published package interfaces rather than unpublished upstream sources.
- `package:dir` is an unpacked smoke artifact, not a distributable installer. The source dependency graph and required packaged archive entries are verified headlessly; signing, notarization, Windows Authenticode, installation behavior, native notifications and terminals, and native-material appearance on every target machine remain target-platform verification boundaries.
