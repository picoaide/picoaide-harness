# DSH Desktop

English | [中文](README.zh.md)

`dsh-plugin-desktop` runs DSH in Electron while remaining part of the ordinary Cordis composition. The installed application is named **DSH Desktop**. The package provides the `dsh-plugin-desktop` executable and the `dsh-desktop` alias; the registered npm package name is the reliable `npx` entry.

## Architecture

The Electron executable is minimal bootstrap code. It acquires the single-instance lock, prepares the persistent `desktop` profile, provides the native runtime capability, and boots the Host Cordis root in the Electron main process. The `desktop-shell` Host plugin owns the `BrowserWindow`, tray, navigation policy, settings namespace, and close-versus-quit lifecycle through Cordis effects.

Both presentation modes reuse the existing loopback Web carrier. The profile mounts the ordinary `dsh-base` and `dsh-web-app` bundles, the Host binds its HTTP and WebSocket surface to `127.0.0.1` on an ephemeral port, and Electron loads that same-origin page in a sandboxed renderer. There is no Electron-owned plugin roster, preload bridge, or raw Electron API in the renderer.

The desktop package has normal Host and Web Client faces. Its Client face validates the Host-supplied mode and platform markers in both modes. Compatibility then returns without registering services, slots, styles, or presentation; advanced mode installs the desktop layout service and root/sidebar presentation described below. Third-party Web clients continue to use the ordinary DSH module graph in both modes.

The launcher repairs only its installation-owned profile prefix. A profile changed by `dsh plugin --profile desktop add third-party-plugin` contains `dsh-base`, `dsh-web-app`, then the same third-party bundles in their previous relative order. The launcher inserts its own desktop layer after `dsh-web-app`; it does not persist itself in the user-managed bundle list.

Bare Cordis plugin imports resolve from the persistent profile. A narrow Node resolve hook applies only to imports issued by `@deepseek-ai/cordis-plugin-loader`, so profile-local third-party packages and the healed launcher fallback use the same resolution path even when packaged Electron does not expose Node's internal ESM loader.

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

The desktop Client module validates the mode and platform markers, then has no compatibility-mode effects. It does not provide or replace the `layout` service, register a `root` or `sidebar` occupant, install styles, or change the official conversation surface. The final profile keeps the official `ui-layout`, `ui-sidebar`, and `ui-conversation` rows enabled.

The Cordis row registers native window values during profile activation. The launcher creates the window only after `app-boot` settles and audits the complete profile, so the first renderer manifest includes the active official, desktop, and third-party client plugins without a Loader-wide wait inside the plugin itself.

On Windows, the launcher pins the existing browse directory-picker backend and client surface instead of the adaptive native chooser. Workspace selection therefore remains inside the Web UI and never loads the native N-API dialog worker in the Electron main process. macOS and Linux retain the upstream adaptive chooser.

## Advanced mode

Advanced mode is an explicitly composed desktop presentation for macOS and Windows. After all user patches have been read, the launcher disables the official `ui-layout` and `ui-sidebar` Loader rows, keeps `ui-conversation` enabled, and applies the selected mode to `desktop-shell`.

The desktop Client then provides the `layout` service for its own Cordis-fiber lifetime and registers the `root` and `sidebar` slot occupants. Its root declares seats for the unchanged upstream conversation, details, and overlay contributions. Its sidebar declares seats for the unchanged upstream workspace browser, settings shell, and additive footer actions. This preserves feature ownership: the desktop package owns only frame and sidebar chrome, while official and third-party plugins continue to own their feature surfaces.

The advanced theme presenter projects the active upstream theme snapshot onto the document, including color scheme, resolved token values, dark-mode marker, and theme-color metadata. It subscribes to ordinary theme changes and removes only its own projected state when the generation disposes.

The workspace seat makes the upstream session-list edge fade transparent, so its opaque Web-sidebar fill does not paint a dark strip over the native material.

On macOS the advanced window uses a transparent hidden-inset title bar, positioned traffic lights, and native `sidebar` vibrancy. On Windows it uses a hidden title bar with native window controls, transparent overlay, acrylic background material, shadow, rounded corners, and a thick resizable frame. A desktop-owned 48 CSS-pixel caption row spans the Windows conversation and details columns; the complete upstream slot surfaces start below that row, so official and third-party header contributions keep their ordinary relative layout without element-specific caption offsets. Linux rejects advanced mode rather than silently falling back to a presentation different from the persisted setting.

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

Manage the persistent profile with the ordinary DSH command:

```sh
dsh plugin --profile desktop add third-party-plugin
dsh plugin --profile desktop remove third-party-plugin
```

The package can then be launched from npm with:

```sh
npx dsh-plugin-desktop
```

A third-party Host plugin only needs its normal `dsh.bundle` patch. A plugin with browser UI also publishes the normal `dsh.client` metadata with `platform: "web"` and an exported `./client` artifact. The upstream Web client module graph discovers it in both modes; Electron does not require a separate client build or a desktop-specific registration API. Advanced-mode contributions must target services and slots that exist in that explicit composition rather than assuming the official layout or sidebar occupant owns them.

## Native lifecycle

Closing the window hides it while the Host Cordis tree continues running. The tray reopens the window, changes mode through the standard settings namespace, or requests an explicit quit. Native quit, `SIGINT`, and `SIGTERM` all request Cordis disposal before Electron exits; a five-second deadline or a repeated request forces the final exit. Navigation and redirects remain on the exact loopback origin; external HTTP, HTTPS, and mail links open in the operating system, while the renderer uses `contextIsolation`, the Chromium sandbox, and no Node integration.

## Packaging

`yarn package:dir` creates an unpacked directory for the current host platform. `build/app-icon.png` is the unmodified iOS Default application icon on macOS, Windows, and Linux. `build/tray-icon.svg` is the brand-blue tray source: the build derives a macOS template image that the system colors automatically and fixed brand-blue Windows and Linux tray images. Signed installers, notarization, packaged dependency-closure verification, and target-platform CI remain separate release work.

## Model Experience

None. The desktop package changes application composition and native presentation; it does not add model-visible instructions, tools, events, or request fields.

#### KV Cache effect

None. The same DSH Host and client feature plugins assemble model requests.

## Known Limitations and Deferred Work

- Adding or removing a profile bundle requires restarting DSH Desktop; the launcher does not watch the profile manifest.
- Switching compatibility/advanced mode always restarts the application by design; a live generation never hot-swaps Loader rows, slot ownership, or native materials.
- Advanced mode is unavailable on Linux. Linux continues to use the compatibility presentation.
- The upstream `dsh plugin` command is a pnpm forwarder and currently requires a separately installed `dsh` CLI and pnpm. This runtime requirement is independent of DSH Desktop using Yarn for its own workspace. An installer must expose or bundle that management path before installer-only users can add packages.
- The shared carrier is loopback HTTP and WebSocket, not Electron IPC. Replacing it requires transport extension points in upstream DSH and is outside this standalone package.
- This project currently pins the published DSH `0.1.0-rc.6` family, while the sibling `deepseek-harness/` source checkout predates that release. Tests therefore validate the published package interfaces rather than unpublished upstream sources.
- `package:dir` is an unpacked smoke artifact, not a distributable installer. The source installation's assembled runtime closure is verified headlessly; packaged closure, signing, notarization, Windows Authenticode, installation behavior, and native-material appearance on every target machine remain unverified.
