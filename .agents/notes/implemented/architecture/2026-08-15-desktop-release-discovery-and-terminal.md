# Agent Note: Desktop release discovery and terminal environment

Status: implemented

English | [中文](2026-08-15-desktop-release-discovery-and-terminal.zh.md)

## Problem

DSH Desktop needs two native operations that do not belong in the upstream Web presentation. Users need to discover a newer stable desktop release without monitoring the repository, and installer-only users need a terminal where the ordinary `dsh --profile desktop` plugin workflow can run without a separately installed DSH CLI or pnpm.

These operations must preserve the product boundaries established by compatibility and advanced mode. The pinned upstream checkout stays unchanged, compatibility keeps the official Web client without overrides, and the sandboxed renderer receives no Electron, Node, filesystem, process, or terminal capability. The desktop package must also avoid changing the user's global `PATH` or shell startup files.

The release channel does not yet publish the complete signed installer metadata required for a safe cross-platform automatic updater. Release discovery therefore must not imply download, replacement, installation, or restart behavior.

## Decision

Desktop-native operations are separate Cordis Host contributions around one Electron adapter. The profile composes `desktop-shell`, `desktop-terminal`, and `desktop-updates` after the ordinary Web bundle. The Electron runtime owns the physical tray and exposes an ordered item registry; each Host plugin registers its command inside `ctx.effect()` and removes it when that generation disposes. The shell retains window and mode lifecycle, while the terminal and update plugins own only their respective command state.

This composition is identical in compatibility and advanced mode and does not add a Client face, preload bridge, Electron IPC method, or renderer-global API. Tray menu construction groups contributed commands without inspecting upstream or third-party Web elements. Linux disables the terminal row in the profile, and direct activation of that Host plugin on Linux fails rather than advertising a command that cannot launch.

## Stable release discovery

`desktop-updates` queries the fixed GitHub latest-release endpoint for `anywhere-labs/deepseek-harness-desktop`. Its explicit configuration defaults to enabled background checks, a 60-second initial delay, a six-hour interval measured after each completed attempt, and a 15-second request deadline. Automatic scheduling runs only when Electron reports a packaged application. Development and other unpackaged launches retain the manual tray command without initiating background network traffic.

Manual and scheduled work share one in-flight request. The checker accepts strict SemVer tags with an optional lowercase `v`, rejects draft or prerelease results, limits the response body to 64 KiB, and requires the returned release page to match the fixed repository and encoded tag exactly. Electron supplies `net.fetch`, native notifications, and default-browser release opening through the Host adapter. Only that validated release URL can reach `shell.openExternal()`.

The updater writes an atomic version-1 JSON document beneath the Electron user-data directory. The file is limited to 4 KiB and records only the installed version associated with a check, a bounded conditional-request ETag, the last notified stable version, and a validated cached available release. POSIX modes request a `0700` parent and `0600` file. Missing state starts empty; malformed, oversized, or unsafe state is warned about and reset rather than trusted. An installed-version change discards the conditional-request and available-release cache while retaining notification history.

The tray label reports idle, checking, or an available version. A manual check produces a native result or failure notification. Background failures are logged without interrupting the user, while a background update notification appears at most once for the same version across process restarts. Selecting an available version opens its validated GitHub release page.

This is release discovery, not automatic update installation. The plugin never downloads an asset, chooses an installer, verifies a code signature, replaces application files, invokes an installer, or requests an application restart. Those steps remain explicit user actions until every target publishes a signed update artifact and the required update metadata.

## Isolated terminal environment

The launcher configures the Electron adapter once with the resolved active profile directory and DSH home before Host plugins can contribute terminal commands. On macOS and Windows, `desktop-terminal` registers **Open DSH Terminal**. Each invocation regenerates private launch files below the application's user-data `cli` directory and opens an independent system terminal with the profile directory as its working directory.

The generated `bin` directory contains `dsh`, `pnpm`, and `node` shims. They reuse the packaged Electron executable in Node mode instead of depending on a system Node installation. Electron Builder emits the production dependency tree under `app.asar.unpacked`, and the desktop CLI and pnpm shims enter that physical tree; profile fallback symlinks therefore point to real package directories rather than virtual ASAR paths. The `dsh` shim starts Node mode with `--expose-internals`, which retains the internal ESM hooks required by ordinary profiles and HMR, then enters a desktop-owned bootstrap. Within this dedicated terminal, that bootstrap supplies the profile selected when the terminal opened only when an invocation has no profile selection, including bare `dsh`, `dsh --dump-config`, and plugin subcommands; an explicit `--profile` and the upstream `web` alias remain authoritative. It then removes every casing of `ELECTRON_RUN_AS_NODE` before importing the fixed unpacked `@deepseek-ai/dsh` CLI entry. The generic Node and pnpm shims enable Node mode only in their own child process trees. The pnpm shim additionally scopes `npm_config_runtime=electron`, the packaged Electron version, and the Electron headers URL so native dependencies installed into the selected profile target the running Electron ABI.

The terminal child starts with Electron Node mode removed, `DSH_HOME` fixed to the launcher's active home, the desktop profile as its working directory, and the generated `bin` directory prepended only to that child's `PATH`. The Electron main process environment, operating-system environment, and user shell files are not modified. The welcome text identifies the DSH Desktop version, profile, profile directory, and DSH home, then shows a configuration dump plus plugin add, remove, and update commands and the required application-restart reminder.

On macOS, LaunchServices opens a generated `welcome.command`. The controlled interactive zsh or bash startup reads the user's ordinary interactive rc file first, then removes Electron Node mode and restores the desktop-owned home and shim path so a user rc cannot accidentally discard them. On Windows, the launcher resolves PowerShell 7, Windows PowerShell, then Command Prompt and prefers a new Windows Terminal window to host the selected shell. If `wt.exe` is unavailable, a generated batch broker uses the built-in `start` command to allocate a visible console. Windows command files and the PowerShell welcome source contain ASCII only; localized profile names and paths cross into them through the Unicode child environment instead of depending on the active code page. The Electron process invokes every launcher with an executable plus argv and `shell: false`; synchronous launch failures, asynchronous spawn errors, and unsuccessful broker exits reach a native error dialog. The generated PowerShell or batch welcome file performs the final environment setup.

The system terminal is an explicit local-user capability, not a renderer or model capability. Web content cannot invoke the command through JavaScript, and no raw process handle or terminal stream crosses the loopback Web carrier. Plugin installation still executes with the local user's ordinary authority and changes the persistent desktop profile, so the welcome text requires a desktop restart before the active Cordis generation can use those changes.

## Verification

Headless update tests cover strict SemVer ordering, fixed-origin and stable-release validation, body limits, ETag behavior, private-state parsing, scheduled and manual request sharing, timeout cancellation, notification deduplication, dynamic tray labels, and effect disposal. Electron adapter tests cover native notification URL handling and the ordered, disposable tray contribution registry without opening a window.

Headless terminal tests inspect generated macOS and Windows files, quoting of spaces and shell metacharacters, ASCII Windows templates carrying localized paths through the child environment, private POSIX modes, `DSH_HOME` and `PATH` isolation, `--expose-internals`, default-desktop argument injection without overriding explicit profiles or the `web` alias, removal of inherited Electron Node mode, interactive shell startup, Windows Terminal selection, the visible-console broker, PowerShell and Command Prompt fallback, launcher error handling, and fail-loud rejection of unsupported platforms or unsafe generated-script values. The packaged-runtime gate requires the terminal and update modules plus desktop CLI bootstrap in `app.asar`, and requires the upstream DSH CLI, Web runtime sentinels, and bundled pnpm entry as physical files under `app.asar.unpacked` before signing.

The tests do not launch graphical terminals, display operating-system notifications, contact the live GitHub endpoint, install a third-party native package, or execute a signed installer. Those behaviors remain target-platform checks on packaged macOS and Windows artifacts.

## Alternatives considered

**Use `electron-updater` immediately.** Automatic download and installation require target-specific signed artifacts, update metadata, and end-to-end verification that the current release channel does not yet provide. A fixed, validated release-page handoff supplies useful discovery without overstating that delivery pipeline.

**Embed a terminal in the Web renderer.** An embedded terminal would require a renderer UI, preload and IPC protocol, pseudo-terminal ownership, process teardown, and a larger security surface. The requested plugin-management workflow needs only an explicit system terminal with a controlled environment.

**Spawn PowerShell or Command Prompt as a detached Electron child.** Electron's embedded Node process hides console children, while the Windows detached-process flag does not allocate a new console. That combination can leave an interactive shell running without a visible window. Windows Terminal is therefore the primary host, with a generated `cmd start` broker as the compatibility fallback.

**Modify the user's global `PATH` or shell rc.** Global mutation would outlive the application, create conflicts with other DSH or Node installations, and need an uninstall repair path. Private generated shims keep ownership and cleanup within DSH Desktop.

**Require system Node, DSH, and pnpm.** That would preserve the installer-only gap this feature is intended to close and make behavior depend on unrelated host versions. The packaged Electron Node mode and bundled CLI entries provide a version-matched environment.

**Hardcode every command in the Electron tray builder.** A monolithic native menu would couple unrelated operations and bypass Cordis disposal. Effect-scoped item registration preserves plugin ownership, deterministic ordering, and future Host composition.

## Consequences

Packaged DSH Desktop can announce a newer stable release and provide the ordinary desktop-profile plugin workflow without changing the upstream checkout or weakening renderer isolation. Release installation remains manual, and the generated CLI environment remains local to terminals opened from the tray.

GitHub stable release tags and exact release pages are now the discovery authority. The desktop package also owns the bundled pnpm version and generated shim behavior, which increases the packaged runtime closure and must remain aligned with Electron's ABI. Linux retains compatibility and update discovery but has no desktop terminal until a separate native-terminal design is implemented.
