# PicoAide Harness

English | [中文](README.zh.md)

`dsh-plugin-desktop` runs DSH in Electron while remaining part of the ordinary Cordis composition. The installed application is named **PicoAide Harness**. The package provides the `dsh-plugin-desktop` executable and the `dsh-desktop` alias; the registered npm package name is the reliable `npx` entry.

## Architecture

The Electron executable is minimal bootstrap code. It acquires the single-instance lock, loads the fixed `desktop` profile, provides the native runtime capability, and boots the Host Cordis root in the Electron main process. The `desktop-shell` Host plugin owns the `BrowserWindow`, navigation policy, settings namespace, and close-versus-quit lifecycle through Cordis effects. The native runtime owns the physical tray, while `desktop-shell`, `desktop-diagnostics`, and `desktop-updates` contribute effect-scoped commands through its ordered item registry.

The product runs the fixed advanced presentation over the existing loopback Web carrier. The profile mounts the ordinary `dsh-base` and `dsh-web-app` bundles, the Host binds its HTTP and WebSocket surface to `127.0.0.1` on an ephemeral port, and Electron loads that same-origin page in a sandboxed renderer. There is no Electron-owned plugin roster, preload bridge, or raw Electron API in the renderer.

The desktop package has normal Host and Web Client faces. Its Client face validates the Host-supplied platform markers and installs the advanced layout service and root presentation described below. Third-party Web clients continue to use the ordinary DSH module graph.

The launcher manages exactly one profile, `desktop`. Its installation-owned prefix is repaired while third-party bundle order is preserved. The launcher inserts its own desktop layer after `dsh-web-app` for the active generation and never persists that layer in the bundle list. There is no profile selector in the tray and no `web` profile default; bundled third-party plugins run against the fixed `desktop` profile.

Bare Cordis plugin imports resolve from the persistent profile. A narrow Node resolve hook applies only to imports issued by `@deepseek-ai/cordis-plugin-loader`, so profile-local third-party packages and the healed launcher fallback use the same resolution path even when packaged Electron does not expose Node's internal ESM loader.

Before profile preparation and Cordis boot, a packaged macOS or Linux launch runs the configured account shell in interactive login mode and recovers its exported `PATH`. This repairs the minimal `PATH` commonly supplied by Finder, LaunchServices, and other graphical launchers. It also fills only missing locale, toolchain, package-manager, and virtual-environment exports from a fixed allowlist; `PATH` alone always uses the shell value. Recovery supports absolute `zsh`, `bash`, and `fish` paths. Bash follows its standard login behavior, so `.bashrc` contributes only when a login profile sources it. Windows and unpackaged or development launches skip recovery. An unavailable or unsupported shell, timeout, capture failure, or missing `PATH` silently retains the inherited process environment.

The capture starts from `@deepseek-ai/dsh-subprocess`'s `scrubbedParentEnv()`, and captured names pass the same `SENSITIVE_ENV_PATTERN` and `DSH_ENV_PREFIX` checks before the fixed allowlist is applied. Credentials, `DSH_*` values, proxy and SSH-agent settings, and process startup hooks learned only from shell rc files are therefore not imported into Electron. This recovery does not erase values already present in Electron's explicit launch environment. Ordinary DSH subprocesses apply the official scrub again; an explicit child environment may still deliberately add a value.

Plugin authors should use the supported contract imports, lifecycle rules, and adaptation patterns in the [Desktop plugin service architecture](docs/plugin-services.md).

## Mode setting and restart boundary

`dsh-desktop.mode` is fixed to `advanced`; the setting is accepted for backward compatibility and always reports `advanced`. The launcher reads the same file resolved by the active `@deepseek-ai/dsh-settings-file` row before composing a generation. The Host registers the `dsh-desktop` namespace with the standard settings service. There is no parallel mode value in the profile manifest and no mode switch in the tray.

A committed `dsh-desktop.port` change requests one orderly restart: the current Cordis tree disposes first, then Electron relaunches only after a successful zero-code shutdown. The application never hot-swaps root slots, native window materials, or Loader rows inside a live renderer generation.

## Advanced mode (fixed presentation)

The desktop shell always uses the advanced presentation on every supported platform. After all user patches have been read, the launcher disables the official `ui-layout` Loader row, keeps the official `ui-sidebar` and `ui-conversation` rows enabled, and applies `advanced` to `desktop-shell`.

The Cordis row registers native window values during profile activation. The launcher creates the window only after `app-boot` settles and audits the complete profile, so the first renderer manifest includes the active official, desktop, and third-party client plugins without a Loader-wide wait inside the plugin itself.

On Windows, the launcher pins the browse directory-picker backend and keeps the full in-app directory panel. The desktop build patches that panel with a small system-folder icon whose same-origin route calls Electron's `dialog.showOpenDialog`; a selected path returns to the panel's existing workspace-adoption flow, while cancellation leaves the panel open. Ordinary browser and remote launches do not receive the desktop bridge. macOS and Linux retain the upstream adaptive chooser.

Windows PowerShell keeps the upstream `pwsh-sandbox` behavior and Windows ACL confinement in both presentation modes. The launcher generation replaces only that Host provider with the `dsh-plugin-desktop/windows-pwsh-sandbox` subpath from this same package. For the exact upstream ACL-runner argv, the adapter launches the packaged Electron executable in Node mode through a private trampoline, removes the Node-mode variable before the restricted PowerShell process is created, and delegates all policy and failure handling back to the upstream runner. The desktop deploy root also pins a Yarn patch that combines `STARTF_USESHOWWINDOW` with the existing `STARTF_USESTDHANDLES` and `SW_HIDE` on both native restricted-process paths. This preserves captured stdio without suppressing console allocation and requests a hidden initial show state when Windows creates the GUI-hosted PowerShell process's first console window. It does not use the upstream-incompatible `CREATE_NO_WINDOW` or `CREATE_NEW_CONSOLE` flags. Direct `danger-full-access` PowerShell, macOS, and Linux execution are unchanged; there is no automatic unrestricted fallback when Windows confinement fails.

## Advanced mode details

Advanced mode is the fixed desktop presentation for macOS and Windows. After all user patches have been read, the launcher disables the official `ui-layout` Loader row, keeps the official `ui-sidebar` and `ui-conversation` rows enabled, and applies `advanced` to `desktop-shell`.

The desktop Client then provides the `layout` service for its own Cordis-fiber lifetime and registers only the `root` slot occupant. Its root declares seats for the unchanged upstream sidebar, conversation, details, and overlay contributions. The official sidebar remains the `sidebar` occupant and continues to declare the workspace browser, settings shell, and additive footer-action seats. This preserves its component behavior, collapse animation, and third-party extension points while the desktop package owns only frame geometry and native material.

The advanced theme presenter projects the active upstream theme snapshot onto the document, including color scheme, resolved token values, dark-mode marker, and theme-color metadata. It subscribes to ordinary theme changes and removes only its own projected state when the generation disposes.

For an advanced generation, the Electron adapter also reads the registered `ui-theme.preference` after Host boot and mirrors its built-in `light`, `dark`, or `system` value into Electron's native appearance before constructing the window. Committed preference changes update the native material while the window is active, and disposal restores the preceding Electron appearance. Client-only third-party theme ids do not change this Host preference.

The desktop sidebar surface scopes the upstream sidebar-fill token to transparent, so the official sidebar and session-list fade reveal the native material without changing their component styles.

On macOS the advanced window uses a transparent hidden-inset title bar, positioned traffic lights, and native `sidebar` vibrancy. Its 90 CSS-pixel collapsed column centers the official 56-pixel rail below a desktop-owned traffic-light inset. The sidebar surface itself is non-draggable; a desktop-owned transparent 32 CSS-pixel strip to the right of the traffic lights supplies its window drag target. A separate caption row reserves 20 CSS pixels above the complete conversation and details surfaces while exposing another transparent 32 CSS-pixel drag target. Buttons, links, inputs, dialogs, and contributions that explicitly declare `app-region: no-drag` remain interactive; a custom pointer target placed within the top 32 pixels must declare the same exclusion. On Windows the official sidebar keeps compatibility geometry: 56 pixels collapsed, 280 pixels by default when expanded, and the same upstream transition behavior, while its transparent surface reveals Mica. The window uses a hidden title bar with native controls, transparent overlay, Mica background material, shadow, rounded corners, and a thick resizable frame. Electron exposes the system-drawn Mica material on Windows 11 22H2 and later. A desktop-owned 32 CSS-pixel caption row spans the Windows conversation and details columns; the complete upstream slot surfaces start below that row, so official and third-party header contributions keep their ordinary relative layout without element-specific caption offsets. On Linux the same advanced client layout runs, but the window uses the standard system frame because there is no platform-native Mica or hidden-inset chrome.

## Development

This package is managed by the Yarn workspace at the repository root. The sibling `deepseek-harness/` checkout remains an independent upstream pnpm project and is not part of the Yarn workspace. Install and verify PicoAide Harness from the repository root:

```sh
yarn install
yarn check
```

The check verifies that every required first-party peer in the production graph is declared by the desktop deploy root. Headless Loader smokes activate the launcher-owned desktop row and a profile-local third-party row, then boot the published Web profile and inspect its loopback root and client manifest. Unit and type tests cover the fixed desktop composition, restart fencing, client environment validation, desktop layout state, and platform-native window options.

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

The application runs the fixed `desktop` profile. There is no profile selector in the tray, so the forms below always target that profile; an explicit `--profile <name>` remains authoritative when invoking `dsh` from an external shell.

`dshmarket@1.2.3` is not preinstalled and is not a dependency of PicoAide Harness. That release still resolves a profile from config/argv and starts `dsh plugin` through private child-process code; its package exports no runner injection seam. A later compatible release must retain its existing CLI fallback under ordinary DSH. In addition, the `1.2.3` source repository and npm tarball contain no complete MIT license text or copyright notice, so that version does not pass the bundled-redistribution gate. User-directed installation of a third-party package is separate from Desktop embedding it in the application archive or installer.

See [Plugin services for authors](docs/plugin-services.md) for required injection, optional Desktop adaptation, TypeScript examples, cancellation, and fallback guidance.

The package can then be launched from npm with:

```sh
npx dsh-plugin-desktop
```

## Launching from the command line

The package installs two equivalent commands, `dsh-desktop` and `dsh-plugin-desktop`. Both launch the packaged Electron launcher (`lib/main.js`) when invoked without arguments.

- **Global install** — `npm install -g dsh-plugin-desktop` installs the `electron` peer automatically, and `dsh-desktop` then starts the application against the default DSH home:
  ```sh
  dsh-desktop
  ```
- **Inside a profile** — after `dsh plugin --profile <name> add dsh-plugin-desktop`, the command lives in the profile's `node_modules/.bin`. pnpm does not install the `electron` peer automatically; add it when you want the command to launch:
  ```sh
  dsh plugin --profile <name> add electron
  ```
  Native build approvals (node-pty, koffi, electron, and others) follow pnpm's usual `allowBuilds` rules.
- **Electron missing** — the command prints a short installation guide instead of failing with a module error.

Booting a profile that is composed with the desktop shell under an ordinary `dsh` invocation (without the launcher's `desktopRuntime` service) prints a reminder telling you to start it with `dsh-desktop` or from the packaged application; the shell registers nothing in that case.

A third-party Host plugin only needs its normal `dsh.bundle` patch. A plugin with browser UI also publishes the normal `dsh.client` metadata with `platform: "web"` and an exported `./client` artifact. The upstream Web client module graph discovers it; Electron does not require a separate client build or a desktop-specific registration API. Advanced-mode contributions must target services and slots that exist in that explicit composition rather than assuming the official layout or sidebar occupant owns them.

## Desktop operations

Packaged macOS and Windows applications query the GitHub Releases API 60 seconds after startup and every six hours after a completed check. Each no-cache request has a 15-second deadline and shares one in-flight operation with the **Check for Updates…** tray command. The response is accepted only when it contains canonical stable Semantic Versioning. Background network, HTTP, timeout, invalid-response, equal-version, and older-version outcomes are silent. A manual check always opens a native result dialog: equal or older results report the installed version, failures ask the user to retry, and a strictly newer version uses the **Download** or **Later** prompt. Automatic update prompts are remembered per version, while the tray can retry explicitly. Development, unpackaged, and Linux launches do not download an installer.

Choosing **Download** first rechecks that the advertised version is unchanged, then makes the first request to the platform's fixed counted download endpoint. PicoAide Harness follows the service redirect through Electron networking, streams at most 1 GiB into a private versioned user-data directory, and rejects an incomplete DMG or Windows PE before exposing it. On macOS it opens the downloaded DMG and tells the user to replace the application in `Applications` and reopen it. On Windows it asks again after the NSIS installer is ready; **Restart and Install** launches that installer and requests orderly Cordis teardown before the current process exits. Download, filesystem, and installer-opening failures remain silent and leave the available-version tray action retryable.

Release operators must publish both platform artifacts before making a version discoverable. After the artifacts and download redirects are ready, the latest `picoaide/picoaide-harness` GitHub Release is the release-version authority; tag `v<version>` and published assets make the release immediately discoverable, while missing or invalid releases produce no Desktop prompt.

## Logs and diagnostics

PicoAide Harness writes UTF-8 logs under Electron's user-data directory: `%APPDATA%\PicoAide Harness\logs` on Windows and `~/Library/Application Support/PicoAide Harness/logs` on macOS. Full logs use `dsh-YYYY-MM-DD.log`; warnings and errors are also written to `dsh-YYYY-MM-DD.error.log`. Files rotate at 10 MiB, files older than seven days are removed at startup, and the directory is kept below 200 MiB. The `dsh-desktop.logLevel` setting controls verbosity and defaults to `info`.

On macOS and Windows, choose **Export Diagnostics…** from the tray to create a ZIP under the sibling `diagnostics` directory and reveal it in the system file manager. Export runs outside Electron's main thread, includes at most the newest 50 MiB of owned logs plus `system-info.txt`, and retains the three newest ZIP files. The confirmation dialog explains the privacy boundary before any archive is created. Recognized credentials are masked, but logs can still contain local paths, workspace IDs, session IDs, prompts, tool output, or third-party plugin messages. Review the ZIP before sharing it, especially before uploading it publicly.

## Native lifecycle

Closing the window hides it while the Host Cordis tree continues running. The tray reopens the window, exposes the diagnostics and update commands, or requests an explicit quit. A committed `dsh-desktop.port` change disposes the current Cordis tree before Electron relaunches; mode is fixed to `advanced` and there is no mode switch. Native quit, `SIGINT`, and `SIGTERM` also request disposal before exit; a five-second deadline or a repeated request forces the final exit. Navigation and redirects remain on the exact loopback origin; external HTTP, HTTPS, and mail links open in the operating system, while the renderer uses `contextIsolation`, the Chromium sandbox, and no Node integration.

## Packaging

`yarn package:dir` creates an unpacked directory for the current host platform. The packaged-runtime gate rejects an application archive that omits the desktop update and diagnostics modules, the DSH CLI bootstrap, the bundled Node runtime entry, or the physical deployment package. Electron Builder emits the root manifest, desktop runtime, and complete dependency tree under `app.asar.unpacked`; both Host profile boot and the CLI bootstrap use this physical tree so DSH profile-fallback symlinks never target a virtual ASAR directory. `build/app-icon.png` is the official product mark (repo root `logo.svg`: black rounded square with the white brace/connector artwork) and the Windows/Linux application icon. The build runs `scripts/generate-mac-app-icon.mjs` to center that artwork at 824 by 824 pixels on a transparent 1024 by 1024 canvas; macOS packaging and the live Dock both use the generated `build/app-icon-mac.png`. `build/tray-icon.svg` is the product-mark tray source (identical artwork to `logo.svg`): the build derives a macOS template image that the system colors automatically and fixed black Windows and Linux tray images.

### WSL Linux headless checks

WSL2 is suitable for Linux headless build, typecheck, and unit-test coverage from a Windows workstation. Use a Linux Node.js installation inside WSL, not the Windows Node.js or Corepack shims that WSL can inherit through the mounted Windows `PATH`. When using `nvm`, start each shell with `source ~/.nvm/nvm.sh` before running Corepack commands:

```bash
source ~/.nvm/nvm.sh
git submodule update --init --recursive
corepack yarn install --immutable
corepack yarn workspace dsh-plugin-desktop typecheck
corepack yarn workspace dsh-plugin-desktop test
corepack yarn build
```

Commands run from `/mnt/<drive>` are valid but slower than a checkout stored on WSL's native ext4 filesystem. WSL does not replace a real Linux desktop session for tray, window-manager, `.desktop` integration, or installed-package smoke tests.

### Local Windows x64 installer

Use a native Windows x64 machine with Git and x64 Node `24` (the release used by CI). The packaging command accepts Node `22.19+` and `24.x`, whose official distributions include the required Corepack command. From PowerShell in a fresh `v2` checkout, run:

```powershell
git submodule update --init --recursive
corepack.cmd yarn install --immutable
corepack.cmd yarn dist:win
```

Python and Visual Studio C++ Build Tools are not required. The Windows command uses `node-pty`'s bundled x64 Node-API binaries instead of asking Electron Builder to rebuild them from source, and the packaged-runtime gate rejects an installer staging tree that omits those binaries.

`dist:win` refuses non-Windows and non-x64 hosts, runs a Windows-safe gate containing the build, all TypeScript compiler faces, packaging and native-shell focused tests, and the runtime-closure verifier, then builds an assisted NSIS installer and verifies both generated PE files. The full cross-platform suite remains CI-owned because some POSIX execution tests are not Windows programs. The installer allows a per-user or elevated all-users installation, permits changing the installation directory, creates Start Menu and desktop shortcuts, and preserves DSH user data when the application is uninstalled. The current version is written to `dsh-plugin-desktop\dist\PicoAide-Harness-<version>-x64-Setup.exe`; the unpacked application remains at `dsh-plugin-desktop\dist\win-unpacked\PicoAide Harness.exe` for smoke testing.

This local command deliberately strips Windows certificate variables and sets `signExecutable=false`. Its output is installable for testing but has no Authenticode publisher, so Windows can display an Unknown publisher or SmartScreen warning. A signed Windows release, certificate verification, installer upgrade/uninstall testing, and native UI/sandbox smoke remain separate release gates.

### Windows x64 portable ZIP

Use `yarn dist:win-portable` on a native Windows x64 machine to create an unsigned portable ZIP:

```powershell
corepack.cmd yarn dist:win-portable
```

The output is `dsh-plugin-desktop\\dist\\PicoAide-Harness-<version>-x64-Portable.zip`. Extract it to any writable directory and launch `PicoAide Harness.exe` without an installer, administrator access, Start Menu registration, or uninstall step. The application still keeps its profiles, logs, and caches in the normal Windows user-data directory, so this is portable distribution rather than a self-contained data sandbox. Portable archives are not handed to the NSIS updater and must be replaced manually when a new version is released. Local builds are unsigned and may trigger an Unknown publisher or SmartScreen warning; signed portable artifacts remain a release gate.

### macOS DMG smoke

`yarn dist:mac-smoke` builds one unsigned universal DMG on a native macOS host. The same package runs natively on Intel and Apple Silicon Macs. The command refuses non-macOS hosts and runs the complete product gate before packaging: repository layout and community-contract checks, the Market build and check, then the Desktop build, every TypeScript compiler face, the full unit-test suite, runtime-closure verification, CLI/Loader/profile headless smokes, and the license audit. This includes the real login-shell tests for each supported shell installed on the macOS runner. It then packages without code-signing material, mounts the DMG, and verifies the property list, executable bit, both `x86_64` and `arm64` slices, and `app.asar`. It mirrors `dist:win`'s secret discipline by stripping every Electron Builder macOS signing and notarization variable, sets `CSC_IDENTITY_AUTO_DISCOVERY=false`, disables notarization, and never publishes. The artifact has no Developer ID signature, so Gatekeeper will block it on other machines; it exists so packaging regressions fail in CI before a manual release. The signed and notarized universal release remains `yarn dist:mac` on a credentialed macOS machine and writes its artifact to `dsh-plugin-desktop/dist/mac-release/`.

## Model Experience

None. The desktop package changes application composition and native presentation; it does not add model-visible instructions, tools, events, or request fields.

#### KV Cache effect

None. The same DSH Host and client feature plugins assemble model requests.

## Known Limitations and Deferred Work

- Adding or removing a profile bundle requires restarting PicoAide Harness; the launcher does not watch profile manifests. The tray has no profile selector.
- Linux runs the same advanced client layout with the standard native window frame (no platform-native Mica or hidden-inset chrome).
- `dshmarket@1.2.3` remains an optional user-installed third-party package, not a bundled marketplace. Preinstallation is deferred until an audited release consumes the optional Desktop services while preserving ordinary DSH fallback and includes the complete license notice required for redistribution.
- The update handoff validates the download container, not publisher identity. macOS still requires the user to replace the application from the opened DMG; Windows runs the downloaded NSIS installer but the local `dist:win` artifact is unsigned. Signed artifacts, Authenticode/publisher verification, SmartScreen reputation, and native upgrade testing remain release gates.
- The shared carrier is loopback HTTP and WebSocket, not Electron IPC. Replacing it requires transport extension points in upstream DSH and is outside this standalone package.
- This project pins both the published DSH `0.1.1-rc.2` family and the corresponding official `deepseek-harness/` release source. Product builds still resolve published package interfaces rather than linking the source checkout.
- `package:dir` is an unpacked smoke artifact. `dist:win` adds an unsigned NSIS test installer but does not establish Authenticode identity or SmartScreen reputation. Installation and upgrade behavior, native notifications, the Windows ACL sandbox, and native-material appearance remain target-platform verification boundaries.
