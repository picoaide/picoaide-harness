# Agent Note: Desktop advanced shell

Status: implemented

English | [中文](2026-08-15-desktop-advanced-shell.zh.md)

## Problem

DSH Desktop needs a native-material presentation on macOS and Windows without editing the pinned upstream checkout or copying the official Web application. The presentation changes several axes together: native window construction, root/sidebar slot ownership, the `layout` service, and document-level theme projection. Applying only part of that set, or changing it inside a running renderer, would leave Host composition and Client presentation inconsistent.

Mode selection also needs two user entry points—the application tray and the standard Settings UI—without allowing each entry point to invent its own persistence or restart behavior.

## Decision

Advanced mode is a complete desktop-owned generation selected by `dsh-desktop.mode: advanced`. It remains on the upstream loopback Web carrier and ordinary Client module loader; only explicitly owned presentation and native-window seams change.

### One settings source and two entry points

The DSH home `settings.yaml` document is the single source of truth. The launcher resolves it through the active `@deepseek-ai/dsh-settings-file` row and reads `dsh-desktop.mode` before it produces the final Loader patches. It does not persist a parallel mode in the profile manifest, Electron preferences, command-line flags, or another desktop file.

The `desktop-shell` Host plugin registers `settingsNamespace('dsh-desktop')` with a schema containing `mode: compatibility | advanced` and `applies: restart`. The tray calls that registered scope's narrow `settings.update({ mode })` path.

The upstream settings description API exposes a fixed allowlist and does not publish third-party namespaces, so the desktop Client cannot bind `dsh-desktop` through `ctx.settingsScope`. It reads the active mode only from the Host-validated renderer URL, registers the localized `settings.section` page, and posts a new value to `/api/dsh-desktop/mode` on the same loopback Web origin. The route exists only when the Web server is bound to `127.0.0.1`; its handler requires exact Host and Origin headers, `POST`, JSON media type, a body no larger than 128 bytes, and an object containing only one supported `mode`. It delegates a valid request to the Host's registered settings scope and returns `204`. Neither user entry point writes `settings.yaml` directly and the endpoint exposes no general settings mutation or Host error details.

Linux validation rejects `advanced` before persistence. The Client disables and labels the advanced Settings choice on Linux, and the tray disables its mode command there.

### Restart is the composition boundary

A settings watcher compares the committed mode with the active generation and requests one Electron restart when they differ. The restart coordinator marks the exit for relaunch, then routes through the ordinary bounded shutdown path. Cordis disposal first releases Client effects, Host rows, the tray, and the `BrowserWindow`; `app.relaunch()` is invoked only when that generation completes a zero-code final exit. A failed generation exits without relaunch, repeated restart requests are idempotent, and the existing forced-shutdown deadline still bounds disposal.

The application never hot-swaps mode. Native material options are fixed at `BrowserWindow` construction, and the active Client graph must agree with the Loader rows and root slot declarations selected before boot.

### Advanced Client composition

After bundle, profile, and home patches are composed, the launcher verifies the expected official row identities. Its final advanced overlay disables the official `ui-layout` and `ui-sidebar` rows and explicitly keeps `ui-conversation` enabled. Compatibility performs the inverse for the two presentation rows and also keeps conversation enabled.

The desktop Client validates the Host-supplied mode and platform URL markers before installing advanced effects. For one plugin-fiber lifetime it provides the `layout` service through Cordis reflection, backed by `DesktopLayoutState`. That service owns sidebar toggle and details open/close transitions and disappears with the same effect that installed it.

The Client registers the `root` occupant and declares child seats for `sidebar`, `conversation`, `details`, and additive `shell.overlay` entries. It separately registers the `sidebar` occupant and declares seats for the upstream workspace browser, standard settings shell, and additive footer actions. The unchanged `ui-conversation` plugin continues to own the conversation and details surfaces; upstream workspace and settings features continue to own their corresponding sidebar surfaces. Third-party features can contribute to the documented seats present in this composition.

The desktop frame owns only geometry and chrome: a collapsible sidebar rail, a center floor, an optional details column, resize handles, native drag regions, and the desktop sidebar controls. It does not copy session, workspace, conversation, settings, or feature state.

### Theme projection

Disabling official layout removes the presentation layer that normally projects the active theme onto the document. Advanced mode therefore includes a narrow `DesktopThemePresenter`. It reads the ordinary upstream theme service, applies its resolved color scheme and token values to the document, maintains the dark-theme marker and `theme-color` metadata, and subscribes to standard `theme/change` events. Disposal removes only the attributes, tokens, and metadata owned by that presenter.

### Native materials

On macOS the advanced `BrowserWindow` uses `titleBarStyle: hiddenInset`, positioned traffic lights, a transparent background, `vibrancy: sidebar`, and `visualEffectState: followWindow`. The renderer keeps a transparent sidebar surface over the native vibrancy while the conversation surface uses resolved DSH theme tokens.

On Windows the advanced window uses a hidden title bar with native title-bar overlay controls, a transparent background, `backgroundMaterial: acrylic`, native shadow, rounded corners, and a thick resizable frame. The renderer reserves the drag region and marks controls, inputs, dialogs, and interactive content as non-draggable.

Advanced mode is unsupported on Linux. The Host schema, settings page, tray, and native window constructor all enforce the same boundary instead of silently falling back.

## Security and carrier boundary

Advanced mode does not add a preload script, Electron IPC transport, or Node capability to the renderer. It retains `contextIsolation`, the Chromium sandbox, disabled Node integration, exact-loopback-origin navigation, and external-link delegation to the operating system. The HTTP/WebSocket carrier and third-party package discovery remain the same as compatibility mode.

## Verification

Profile tests write `dsh-desktop.mode: advanced` to a temporary `settings.yaml` and verify projection into `desktop-shell`, disabled official layout/sidebar rows, and enabled conversation. Host tests cover the shared settings namespace, POST-only endpoint, strict payload validation, changed-value restart, tray update path, and pre-persistence Linux rejection. Client tests cover environment validation, scoped layout-service disposal, responsive column rules, narrow mode submission, and response handling. Type checking validates the desktop declarations, including platform-gated UI, against the published rc.6 slot and service contracts.

Window-option and Electron-runtime tests verify macOS hidden-inset vibrancy, Windows acrylic/native controls, Linux rejection, and the tray's opposite-mode update. Shutdown tests verify relaunch only after successful zero-code disposal and no relaunch for a failed generation. Client and Host bundles build headlessly; graphical native-material appearance remains a target-machine verification boundary.

## Alternatives considered

**Patch the official layout and sidebar in place.** This would modify upstream-owned implementation or make browser DSH depend on Electron presentation rules. Disabling the two official presentation rows and adding desktop-owned occupants preserves a mechanical ownership boundary.

**Keep official layout active and shadow only its root occupant.** The official plugin would still provide the `layout` service and own child declarations, creating split ownership and ambiguous disposal. Advanced mode replaces the service and the corresponding root/sidebar declarations as one generation.

**Copy conversation, workspace, or settings UI into the desktop package.** Those are feature surfaces, not desktop chrome. Keeping their official plugins active avoids duplicated state and lets upstream and third-party improvements flow into the desktop composition.

**Write a separate Electron preference from the tray.** Two stores could disagree. Both controls therefore converge on the Host's registered `dsh-desktop` namespace: the tray calls it directly, while the renderer reaches only its narrow same-origin endpoint.

**Hot-reload the Client shell after changing mode.** This cannot atomically reconstruct native window materials, Loader rows, service ownership, and root declarations. A bounded relaunch is the smallest coherent transition.

**Offer advanced mode on Linux without native materials.** Persisting one mode name with materially different platform semantics would make configuration misleading. Linux exposes compatibility only until an explicit Linux advanced design exists.

## Consequences

DSH Desktop gains a native-material macOS and Windows presentation without modifying the upstream submodule, copying the Web application, or introducing a second plugin or transport system. Settings and tray controls converge on one durable value, and a restart creates a coherent Host, Client, and native-window generation.

The desktop package now owns real Client presentation code and must track the published slot, theme, and service contracts it uses. Advanced mode deliberately has a different presentation-row composition from browser Web and compatibility mode. Native appearance also depends on operating-system support and must be verified on real target machines; Linux remains compatibility-only.
