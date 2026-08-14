# DSH Desktop

English | [中文](README.zh.md)

`dsh-plugin-desktop` runs DSH in Electron while remaining part of the ordinary Cordis composition. The installed application is named **DSH Desktop**. The package provides the `dsh-plugin-desktop` executable and the `dsh-desktop` alias; the registered npm package name is the reliable `npx` entry.

## Architecture

The Electron executable is minimal bootstrap code. It acquires the single-instance lock, prepares the persistent `desktop` profile, provides the native runtime capability, and boots the Host Cordis root in the Electron main process. The `desktop-shell` Host plugin owns the `BrowserWindow`, tray, navigation policy, and close-versus-quit lifecycle through one Cordis effect.

The first additive release deliberately reuses the current loopback Web carrier. The profile mounts the ordinary `dsh-base` and `dsh-web-app` bundles, the Host binds its HTTP and WebSocket surface to `127.0.0.1` on an ephemeral port, and Electron loads that same-origin page in a sandboxed renderer. There is no Electron-owned plugin roster and no raw Electron API in the renderer.

The launcher repairs only its installation-owned profile prefix. A profile created by `dsh plugin --profile desktop add third-party-plugin` becomes `dsh-base`, `dsh-web-app`, then the same third-party bundles in their previous relative order. The launcher inserts its own desktop layer after `dsh-web-app`; it does not persist itself in the user-managed bundle list.

Bare Cordis plugin imports resolve from the persistent profile. A narrow Node resolve hook applies only to imports issued by `@deepseek-ai/cordis-plugin-loader`, so profile-local third-party packages and the healed launcher fallback use the same resolution path even when packaged Electron does not expose Node's internal ESM loader.

## Compatibility mode

`desktop-shell.mode` defaults to `compatibility`. This mode creates a normal operating-system window with its native frame and loads the unmodified Web root from the active DSH profile. macOS suppresses the visible page title. Windows retains the native caption icon and displays `DeepSeek Harness Desktop`, but removes the window menu bar. The operating system owns native title-bar color and appearance; exact sidebar-token color belongs to the advanced client shell because it requires a custom title bar. The desktop package exports no client artifact, contributes no DOM marker or stylesheet, replaces no slot or service, and leaves the official `ui-layout`, `ui-sidebar`, and `ui-conversation` rows active.

The Cordis row registers the native window values during profile activation. The launcher creates the window only after `app-boot` settles and audits the complete profile, so the first renderer manifest includes the active official and third-party client plugins without a Loader-wide wait inside the plugin itself.

On Windows, the launcher pins the existing browse directory-picker backend and client surface instead of the adaptive native chooser. Workspace selection therefore remains inside the Web UI and never loads the native N-API dialog worker in the Electron main process. macOS and Linux retain the upstream adaptive chooser.

The package reserves the `advanced` mode name for a separately composed desktop client shell. Selecting it currently fails before a native window is scheduled; it never falls back to compatibility mode silently.

## Development

This package is managed by the Yarn workspace at the repository root. The sibling `deepseek-harness/` checkout remains an independent upstream pnpm project and is not part of the Yarn workspace. Install and verify DSH Desktop from the repository root:

```sh
yarn install
yarn check
```

The check verifies that every required first-party peer in the 197-package production graph is declared by the desktop deploy root. A built, headless Loader smoke activates both the launcher-owned desktop row and a profile-local third-party row by package name. A second headless smoke boots the complete published Web profile, requests its loopback root, and verifies the official layout, sidebar, and conversation entries in the injected client manifest.

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

Manage the persistent profile with the ordinary DSH command:

```sh
dsh plugin --profile desktop add third-party-plugin
dsh plugin --profile desktop remove third-party-plugin
```

The package can then be launched from npm with:

```sh
npx dsh-plugin-desktop
```

A third-party Host plugin only needs its normal `dsh.bundle` patch. A plugin with browser UI also publishes the normal `dsh.client` metadata with `platform: "web"` and an exported `./client` artifact. The upstream Web client module graph discovers it in compatibility mode; Electron does not require a separate client build or a desktop-specific registration API.

## Native lifecycle

Closing the window hides it while the Host Cordis tree continues running. The tray reopens the window or requests an explicit quit. Native quit, `SIGINT`, and `SIGTERM` all request Cordis disposal before Electron exits; a five-second deadline or a repeated request forces the final exit. Navigation and redirects remain on the exact loopback origin; external HTTP, HTTPS, and mail links open in the operating system, while the renderer uses `contextIsolation`, the Chromium sandbox, and no Node integration.

## Packaging

`yarn package:dir` creates an unpacked directory for the current host platform. `build/app-icon.png` is the unmodified iOS Default application icon on macOS, Windows, and Linux. `build/tray-icon.svg` is the brand-blue tray source: the build derives a macOS template image that the system colors automatically and fixed brand-blue Windows and Linux tray images. Signed installers, notarization, packaged dependency-closure verification, and target-platform CI are separate release work and are not claimed by this first checkpoint.

## Model Experience

None. The desktop package changes application composition and native presentation; it does not add model-visible instructions, tools, events, or request fields.

#### KV Cache effect

None. The same DSH Host and client plugin graph assemble model requests.

## Known Limitations and Deferred Work

- Adding or removing a profile bundle requires restarting DSH Desktop; the first release does not watch the profile manifest.
- Compatibility mode does not provide a frameless window, translucent sidebar, desktop-specific layout, or other renderer presentation overrides. Those features require the separately composed advanced client shell.
- The upstream `dsh plugin` command is a pnpm forwarder and currently requires a separately installed `dsh` CLI and pnpm. This runtime requirement is independent of DSH Desktop using Yarn for its own workspace. An installer must expose or bundle that management path before installer-only users can add packages.
- The additive transport is loopback HTTP and WebSocket, not Electron IPC. Replacing the carrier requires transport extension points in upstream DSH and is outside this standalone package.
- This project currently pins the published DSH `0.1.0-rc.6` family, while the sibling `deepseek-harness/` source checkout predates that release. Tests therefore validate the published package interfaces rather than unpublished upstream sources.
- `package:dir` is an unpacked smoke artifact, not a distributable installer. The source installation's assembled runtime closure is verified headlessly; packaged closure, signing, notarization, Windows Authenticode, and installation behavior remain unverified.
