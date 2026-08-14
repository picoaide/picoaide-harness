# Agent Note: Desktop compatibility mode

Status: implemented

English | [中文](2026-08-15-desktop-compatibility-mode.zh.md)

## Problem

DSH Desktop needs native application lifecycle and an in-app mode selector without making compatibility mode an implicit fork of the official Web presentation. A desktop client that replaces root, layout, or sidebar in every launch would make the safe path depend on product-owned presentation code. A Host-only package, however, cannot contribute the standard Desktop settings page that lets a user inspect and change the mode through the same durable settings system as the rest of DSH.

## Decision

The `desktop-shell` Cordis row exposes `mode: compatibility | advanced`, and the standard `dsh-desktop` settings namespace defaults `mode` to `compatibility`. The desktop package declares both `dsh.bundle` and `dsh.client`; its Client face is loaded in both modes.

Compatibility mode gives that Client face one narrow responsibility: register the localized **Desktop App** page in the canonical `settings.section` slot. The page takes the current `compatibility`/`advanced` value from the validated renderer URL and submits only a new mode through the desktop-owned, same-origin, POST-only endpoint. Its styles are local to that page. Compatibility does not call the advanced-shell installer, provide or replace the `layout` service, register a `root` or `sidebar` occupant, or alter the conversation surface.

The final compatibility composition keeps the official `ui-layout`, `ui-sidebar`, and `ui-conversation` Loader rows enabled. The official `dsh-web-app` graph therefore owns root and presentation, including the settings shell that renders the desktop contribution. The renderer URL carries validated desktop mode and platform markers so the one Client artifact can choose its bounded behavior; those markers expose no Electron capability.

The persistent `desktop` profile still contains `dsh-base`, `dsh-web-app`, and user-installed bundles in their preserved order. Third-party client plugins use ordinary `dsh.client` metadata and are discovered by the official Web client module graph. Electron does not maintain a second plugin roster.

The launcher adds one platform safety overlay after user patches. On Windows it disables the adaptive directory-picker row and inserts the existing browse Host backend with the matching browse client surface. The native directory-picker package never activates in the Electron main process. macOS and Linux keep the upstream adaptive row.

The `desktop-shell` row registers a native shell specification while the profile is activating. It does not await global Loader settlement from inside its own Loader entry. The launcher mounts that registration only after `app-boot` returns, which preserves the activation audit and complete official, desktop, and third-party client manifest before the first renderer request.

## Settings and restart boundary

The DSH home `settings.yaml` document is the single durable source for `dsh-desktop.mode`. The launcher reads the file resolved by the active `dsh-settings-file` row before composition. The Host plugin registers the same namespace and schema with the standard settings service and declares `applies: restart`. There is no second value in the profile manifest.

The upstream settings description API exposes an allowlist and does not publish third-party namespaces, so the Client cannot read `dsh-desktop` through `ctx.settingsScope`. The renderer instead trusts only the mode already validated into its URL and posts to `/api/dsh-desktop/mode`. The Host refuses to register the route on a non-`127.0.0.1` Web server. Its handler requires the exact loopback Host and Origin, `POST`, `application/json`, at most 128 request bytes, and an object whose sole field is a supported `mode`. It delegates a valid value to the Host's registered settings scope and returns `204`; rejected updates return a bounded error without Host details. The route exposes no general settings mutation and the renderer never opens or rewrites `settings.yaml`.

The settings endpoint and tray command both update that registered namespace. A committed mode change asks the Electron runtime for one orderly restart. Cordis disposal releases the Client contributions, Host rows, tray, and window before the exit coordinator calls `app.relaunch()` for a successful zero-code shutdown. Compatibility never hot-replaces official slots inside a live generation.

## Native lifecycle and security

The compatibility adapter creates a normal `BrowserWindow` and omits custom-frame, title-bar, transparency, vibrancy, and native-material options. macOS suppresses visible page-title updates. Windows retains its native caption icon and fixed `DeepSeek Harness Desktop` caption while removing the window menu bar. The operating system owns native title-bar color and appearance.

The application uses the same iOS Default icon across supported platforms. The tray uses a macOS template derived from the brand SVG and fixed brand-blue images on Windows and Linux. Compatibility retains renderer isolation, the Chromium sandbox, disabled Node integration, exact-origin navigation, tray ownership, close-to-hide behavior, single-instance activation, and bounded Cordis disposal on explicit quit.

## Verification

Package tests require the `./client` export and ordinary `dsh.client` dependency edges. Profile tests verify that compatibility keeps the official layout, sidebar, and conversation rows enabled and that Windows composition contains the browse picker without native picker rows. Client tests validate the mode/platform marker, strict mode request, response handling, and desktop layout isolation. Host tests verify standard namespace registration, POST-only endpoint handling, a narrow `settings.update({ mode })` path, restart only after a changed value, and Linux validation before persistence.

Runtime tests verify that registration does not re-enter Loader settlement and that `BrowserWindow` construction starts only after the launcher mounts the registered generation. Window-option tests reject advanced-native options from the compatibility constructor. Headless Loader smokes activate the Host shell and a profile-local third-party plugin, then boot the published Web profile without importing Electron or opening a window.

The desktop deploy root directly supplies every required first-party peer in its production dependency graph. A closure check rejects missing declarations, while the complete-profile smoke verifies that the published profile reaches its HTTP root and client manifest without relying on another package manager's automatic peer installation.

## Alternatives considered

**Keep compatibility entirely Host-only.** This preserves the smallest possible client graph but cannot put mode selection in the canonical settings shell. Loading the desktop Client for one standard `settings.section` contribution and one narrow same-origin control route keeps the integration bounded without duplicating presentation.

**Let the desktop Client replace root or sidebar in both modes.** Shared presentation ownership would make compatibility depend on the advanced shell and reduce its value as the upstream-reference path. The advanced installer is therefore called only for an advanced generation.

**Patch the official UI to add the mode control.** An upstream patch would violate the pinned-submodule boundary and make browser DSH aware of Electron product policy. The standard settings slot exists specifically so the desktop package can own its page additively.

**Ship a copied Web frontend inside the Electron package.** A copied client roster would duplicate Cordis composition and require desktop releases to track every upstream client change. Compatibility instead loads the active profile's official Web surface.

**Open the window as soon as the Web server binds.** A bound socket supplies an authoritative port but does not prove that the frontend fallback, boot-manifest injection, or later client entries are active. The launcher therefore uses completed `app-boot` activation as the mount point.

**Hot-swap modes after a settings write.** The modes differ in Loader rows, service ownership, root slot declarations, and native `BrowserWindow` options. Restarting at the settings boundary gives one coherent generation instead of mutating those axes independently.

## Consequences

Compatibility mode remains the upstream-reference presentation while gaining one additive desktop settings page. It tracks official UI and third-party client behavior, keeps persistence and restart policy in the Host standard settings service, and provides native lifecycle without owning root, layout, sidebar, or conversation presentation.

The compatibility client graph is no longer literally identical to browser Web because it includes the desktop settings contribution and validated environment marker. That difference is intentionally narrow and testable. Frameless windows, translucent materials, desktop geometry, and renderer chrome remain exclusive to the separately documented [advanced shell](2026-08-15-desktop-advanced-shell.md).
