# Agent Note: Desktop compatibility mode

Status: implemented

English | [中文](2026-08-15-desktop-compatibility-mode.zh.md)

## Problem

DSH Desktop needs native application lifecycle without making the Electron package an implicit fork of the official Web client. Loading a desktop renderer module in every launch changes the client graph even when that module only marks the DOM, and it couples the compatibility path to presentation code that users did not select.

## Decision

The `desktop-shell` Cordis row exposes `mode: compatibility | advanced` and defaults to `compatibility`. Compatibility mode is the only implemented presentation mode. Selecting `advanced` fails before `BrowserWindow` construction, so an unavailable presentation never falls back silently.

Compatibility mode is a Host-only overlay. `dsh-plugin-desktop` declares `dsh.bundle` but does not declare `dsh.client` or export a client artifact. Its renderer URL is the unmodified loopback Web root without desktop query parameters. The official `dsh-web-app` client roster, including `ui-layout`, `ui-sidebar`, and `ui-conversation`, remains active and owns the rendered application.

The persistent `desktop` profile still contains `dsh-base`, `dsh-web-app`, and user-installed bundles in their preserved order. Third-party client plugins use their ordinary `dsh.client` metadata and are discovered by the official Web client module graph. Electron does not maintain a second plugin roster.

## Native lifecycle and security

The compatibility adapter creates a normal `BrowserWindow` and omits custom-frame, title-bar, transparency, vibrancy, and native-material options. It retains renderer isolation, the Chromium sandbox, disabled Node integration, exact-origin navigation, tray ownership, close-to-hide behavior, single-instance activation, and bounded Cordis disposal on explicit quit.

An advanced presentation requires a desktop-owned client plugin that is added only by advanced profile composition. It may replace documented slots or services, but it is not present in the compatibility client graph.

## Verification

Package tests reject a compatibility package that exports `./client` or declares `dsh.client`. Profile tests verify that the official layout, sidebar, and conversation rows remain enabled. Window-option tests reject advanced-native options from the compatibility constructor, and the built Loader smoke activates the Host shell and a profile-local third-party plugin without importing Electron or opening a window.

## Alternatives considered

**Load a no-op desktop client in compatibility mode.** Even a DOM marker changes the client graph, bundle manifest, and renderer lifecycle. Compatibility therefore contains no desktop client artifact.

**Patch the official UI for both modes.** Shared DOM and CSS changes make upstream upgrades and browser behavior depend on the desktop product. Presentation changes belong to explicit advanced composition.

**Ship a copied Web frontend inside the Electron package.** A copied client roster would duplicate Cordis composition and require desktop releases to track every upstream client change. Compatibility instead loads the active profile's official Web surface.

**Treat an unavailable advanced mode as compatibility.** Silent fallback makes native window options and renderer composition disagree with the selected configuration. Advanced fails before native mount until both halves exist.

## Consequences

Compatibility mode tracks upstream UI and third-party client behavior with the smallest desktop-owned runtime. It provides native application lifecycle but intentionally gives up frameless windows, translucent materials, desktop-specific geometry, and renderer chrome. Advanced presentation requires a separate client contribution and explicit composition rather than changes to the compatibility path.
