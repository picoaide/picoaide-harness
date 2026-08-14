# Agent Note: Windows Electron ACL runner

Status: implemented

English | [中文](2026-08-15-windows-electron-acl-runner.zh.md)

## Problem

The upstream Windows sandbox composes the ACL runner argv as `[process.execPath, runner.js, ...]`. This is correct under the DSH CLI because `process.execPath` is Node. DSH Desktop boots the same Host plugins inside Electron, where the value is the Electron executable during development and the installed `DSH Desktop.exe` after packaging. Starting that executable with the runner path as an argument does not establish the plain-Node process expected by the upstream runner and can instead start another desktop application instance.

The Windows sandbox has no weaker automatic provider fallback. A broken runner therefore makes ordinary workspace-write PowerShell unavailable, while silently bypassing confinement would misrepresent the selected permission mode.

## Decision

The desktop package publishes `dsh-plugin-desktop/windows-pwsh-sandbox` as a Host subpath of the existing package. It is not a second npm package. The Windows desktop profile verifies that the `pwsh-sandbox` row still names the expected upstream provider, preserves its platform gate and configuration, disables that row, and inserts the desktop subpath. Compatibility and advanced presentation modes use the same Host profile and therefore receive the same execution adapter.

`DesktopWindowsPwshSandbox` extends the upstream `SandboxPwshExecutor` and uses its protected argv execution methods. It changes an invocation only when the platform is Windows, the Host is Electron, the executable equals `process.execPath`, and the next argument equals the resolved upstream Windows ACL runner. The rewritten argv inserts a private desktop trampoline between the executable and upstream runner. Direct PowerShell execution, including the explicit `danger-full-access` path, is passed through unchanged.

The adapted child receives a cloned environment with every case-insensitive `ELECTRON_RUN_AS_NODE` key removed and one `ELECTRON_RUN_AS_NODE=1` value added. The trampoline validates the exact upstream runner path, removes every form of that variable from its own environment, reconstructs the argv expected by the upstream module, and imports it. Restricted PowerShell and its descendants therefore do not inherit Electron's Node-mode switch.

The Electron build explicitly enables the `runAsNode` fuse because this child-launch protocol depends on it. The trampoline preserves the upstream `windows-acl-run` failure signature and exits with code 127 when its own validation or import fails, so the existing sandbox layer continues to classify runner startup failures as unavailable and fail closed.

## Verification

Unit tests cover the exact Windows Electron match, unchanged non-Windows, plain-Node, wrong-executable, wrong-runner, and direct-PowerShell invocations, case-insensitive environment removal, parent-environment isolation, trampoline rejection, public package exports, build entries, and the enabled fuse. Profile tests verify the Windows replacement, inherited configuration and gate, unchanged macOS and Linux composition, unchanged subprocess and sandbox services, and preservation of explicitly disabled or third-party providers.

The Host and Client compiler faces type-check independently. The package builds headlessly, the 197-node first-party runtime graph remains closed, and the Loader and complete-profile smokes pass. A headless Electron 43 Node-mode smoke executes the built trampoline and reaches the upstream ACL runner, which emits its signed missing-argument failure. Native Windows ACL confinement and the packaged `app.asar` path remain target-machine verification requirements.

## Alternatives considered

**Run the upstream argv unchanged.** The executable is the desktop application rather than Node, so the runner entry cannot rely on the CLI launch assumption.

**Set `ELECTRON_RUN_AS_NODE` globally.** Model tools, shells, and other subprocesses would inherit Electron-specific behavior. The variable is scoped to the one exact runner child and removed before restricted execution begins.

**Replace the Windows sandbox with local PowerShell.** This would make workspace-write execute without its declared ACL confinement. The adapter retains the upstream sandbox provider and its fail-closed behavior.

**Patch the upstream package or submodule.** The defect is specific to hosting the published provider inside Electron. A desktop-owned subclass and profile overlay keep the pinned upstream checkout unchanged while using the provider's protected argv seam.

**Use Electron `utilityProcess`.** The upstream sandbox API supplies an argv prefix to the ordinary subprocess provider, while utility processes use a separate lifecycle and stream interface. Adapting only the expected runner child is smaller and preserves the existing provider composition.

## Consequences

Both desktop presentation modes can use the ordinary upstream Windows PowerShell tool with its ACL confinement while the desktop remains an additive package. The adapter is intentionally narrow: changes to the upstream runner package, argv prefix, or provider identity fail closed instead of being guessed.

The installed executable intentionally retains Electron's RunAsNode capability for this internal child protocol. Windows release verification must execute a workspace-write PowerShell command from the packaged application and confirm the built trampoline, native ACL setup, output capture, and cleanup on the target operating system.
