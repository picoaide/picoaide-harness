/** Electron adapter for the upstream Windows ACL PowerShell executor. */

import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import type { ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import type { Config as PwshConfig } from '@deepseek-ai/dsh-pwsh-local'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const UPSTREAM_RUNNER = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))
const DESKTOP_TRAMPOLINE = fileURLToPath(new URL('./windows-acl-runner.js', import.meta.url))

/** Inputs controlling one exact ACL-runner argv rewrite. */
export interface WindowsAclAdaptation {
  /** Host platform; only Windows is adapted. */
  platform: NodeJS.Platform
  /** Whether the current Host executable is Electron. */
  electron: boolean
  /** Current Electron executable path. */
  execPath: string
  /** Resolved upstream ACL runner path. */
  upstreamRunner: string
  /** Desktop-owned Node-mode trampoline path. */
  trampoline: string
}

/** Adapted execution inputs passed to the ordinary local executor. */
export interface AdaptedWindowsAclExecution {
  /** Spec carrying the runner-only Electron environment. */
  spec: ShellExecSpec
  /** Exact argv, with the desktop trampoline inserted when required. */
  argv: readonly string[]
}

/** Windows PowerShell paths that do not depend on PATH-provided portable runtimes. Built with win32 semantics on every host so results are deterministic off Windows. */
export function desktopWindowsPwshPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (platform !== 'win32') return undefined
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const systemRoot = env.SystemRoot ?? 'C:\\Windows'
  const candidates = [
    win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]
  return candidates.find(candidate => exists(candidate))
}

/**
 * Keep explicit user config, otherwise avoid PATH-resolved portable pwsh in the Windows ACL sandbox.
 *
 * Upstream 0.1.7 made `pwshPath` a **volatile** config reference, so the default
 * is written *through* the loader-owned reference (`updateVolatile`) instead of
 * substituting a detached config object: a copy would freeze the value at
 * construction time and silently ignore a `pwshPath` the user later saves in
 * the settings form.
 * @param config - resolved pwsh executor config (its `pwshPath` reference is seeded in place).
 * @param env - process environment consulted for the well-known install roots.
 * @param platform - host platform; non-Windows hosts keep the config untouched.
 * @param exists - executable probe, injectable for deterministic tests.
 * @returns the same config instance, with the Windows default seeded when absent.
 */
export function desktopWindowsPwshConfig(
  config: PwshConfig,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean = existsSync,
): PwshConfig {
  const declared = config.pwshPath.get()
  if (declared !== undefined && declared.length > 0) return config
  const pwshPath = desktopWindowsPwshPath(env, platform, exists)
  if (pwshPath === undefined) return config
  updateVolatile(config.pwshPath, createVolatile(pwshPath))
  return config
}

/**
 * Insert the desktop Node-mode trampoline for the exact upstream ACL runner.
 * @param spec - resolved PowerShell execution spec.
 * @param argv - argv after the upstream sandbox provider has confined it.
 * @param adaptation - executable and runner identities for this Host.
 * @returns unchanged inputs for every non-runner call, otherwise the isolated runner launch.
 */
export function adaptWindowsAclExecution(
  spec: ShellExecSpec,
  argv: readonly string[],
  adaptation: WindowsAclAdaptation,
): AdaptedWindowsAclExecution {
  const [program, runner, ...args] = argv
  if (adaptation.platform !== 'win32'
    || !adaptation.electron
    || program !== adaptation.execPath
    || runner !== adaptation.upstreamRunner) {
    return { spec, argv }
  }

  const env = { ...spec.env }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === RUN_AS_NODE) delete env[key]
  }
  env[RUN_AS_NODE] = '1'
  return {
    spec: { ...spec, env },
    argv: [adaptation.execPath, adaptation.trampoline, adaptation.upstreamRunner, ...args],
  }
}

/** PowerShell sandbox provider that repairs only Electron-hosted Windows ACL launches. */
export class DesktopWindowsPwshSandbox extends SandboxPwshExecutor {
  constructor(ctx: ConstructorParameters<typeof SandboxPwshExecutor>[0], config: PwshConfig) {
    super(ctx, desktopWindowsPwshConfig(config, process.env, process.platform))
  }

  private adapt(spec: ShellExecSpec, argv: readonly string[]): AdaptedWindowsAclExecution {
    return adaptWindowsAclExecution(spec, argv, {
      platform: process.platform,
      electron: process.versions.electron !== undefined,
      execPath: process.execPath,
      upstreamRunner: UPSTREAM_RUNNER,
      trampoline: DESKTOP_TRAMPOLINE,
    })
  }

  /**
   * Adapt one argv **and** keep the spec object identity the base class will spawn with.
   *
   * `adaptWindowsAclExecution` returns a *new* spec carrying the runner-only
   * `ELECTRON_RUN_AS_NODE`, but the base class builds the child environment from
   * the spec instance it was handed — substituting our copy would silently drop
   * that variable and relaunch the trampoline in GUI mode (the exact failure this
   * adapter exists to prevent). Copying the adapted fields back onto the original
   * object is the only way to keep the runner env on the object the base spawns
   * with. Non-runner calls return the same spec instance and are left untouched.
   * @param spec - spec the base class will spawn with.
   * @param argv - argv to adapt.
   * @returns argv to spawn with.
   */
  private adaptInPlace(spec: ShellExecSpec, argv: readonly string[]): readonly string[] {
    const adapted = this.adapt(spec, argv)
    if (adapted.spec !== spec) Object.assign(spec, adapted.spec)
    return adapted.argv
  }

  /**
   * Upstream 0.1.7 renamed this seam (`runArgv`/`startArgv` → a single
   * `executeArgv` that both the foreground and the background path go through)
   * and returns the live {@link ShellExecution} handle instead of a bare
   * `{ result, spawnRequested }`. The shape that matters is unchanged: the
   * second parameter is `argv | (signal) => Promise<argv>` — the sandbox
   * subclass passes the function form, because ACL confinement must run under
   * the same foreground deadline as the spawn — so adapting inside the callback
   * keeps the upstream deadline authoritative for confinement. Resolving the
   * callback ourselves would re-implement that deadline. The `onStarted`
   * callback is forwarded untouched: the sandbox subclass installs per-process
   * facts in it, and dropping it would silently remove denial classification.
   * @param spec - resolved execution settings.
   * @param argvOrPrepare - exact argv, or preparation cancelled by the same deadline as execution.
   * @param onStarted - hook the upstream sandbox uses to attach per-process facts.
   * @returns the live execution handle.
   */
  protected override async executeArgv(
    spec: ShellExecSpec,
    argvOrPrepare: readonly string[] | ((signal: AbortSignal) => Promise<readonly string[]>),
    onStarted?: (process: ShellExecution) => void,
  ): Promise<ShellExecution> {
    if (typeof argvOrPrepare === 'function') {
      return await super.executeArgv(spec, async signal => this.adaptInPlace(spec, await argvOrPrepare(signal)), onStarted)
    }
    return await super.executeArgv(spec, this.adaptInPlace(spec, argvOrPrepare), onStarted)
  }
}

export default DesktopWindowsPwshSandbox
