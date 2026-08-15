/** Isolated command-line environment launched from the DSH Desktop tray. */

import type { ChildProcess, SpawnOptions } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join, win32 } from 'node:path'
import { assertDesktopProfileName } from './profile-manager.ts'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const DEFAULT_PROFILE = 'DSH_DESKTOP_DEFAULT_PROFILE'
const DSH_HOME = 'DSH_HOME'
const PATH = 'PATH'
const STATE_DIRECTORY_MODE = 0o700
const EXECUTABLE_FILE_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const WINDOWS_SHELL_COMMANDS = ['pwsh.exe', 'powershell.exe', 'cmd.exe'] as const
const ELECTRON_HEADERS_URL = 'https://electronjs.org/headers'

/** Platforms with a native terminal launch contract owned by DSH Desktop. */
export type DesktopTerminalPlatform = 'darwin' | 'win32'

/** Process launcher injected by the Electron adapter. */
export type DesktopTerminalSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

/** Filesystem probe used while resolving a Windows terminal shell. */
export type DesktopTerminalExecutableExists = (filename: string) => boolean

/** Resolver used to locate one Windows terminal shell without a command interpreter. */
export type DesktopTerminalExecutableResolver = (
  command: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  exists: DesktopTerminalExecutableExists,
) => string | undefined

/** Optional Windows terminal accepting a selected shell command after its argument prefix. */
export interface WindowsTerminalLauncher {
  /** Terminal executable, for example `wt.exe`. */
  executable: string
  /** Arguments placed before the selected shell child command. */
  arguments?: readonly string[]
}

/** Inputs for one isolated desktop terminal launch. */
export interface DesktopTerminalOptions {
  /** Host platform selecting the generated scripts and native launcher. */
  platform: NodeJS.Platform
  /** Electron executable reused as Node by command shims. */
  appExecutable: string
  /** Desktop-owned bootstrap that clears Node mode before importing the `dsh` CLI. */
  dshBootstrapPath: string
  /** Packaged JavaScript entry for the `pnpm` CLI. */
  pnpmBinPath: string
  /** Electron version used by pnpm native dependency installation. */
  electronVersion: string
  /** DSH profile selected by the desktop application. */
  profileName: string
  /** Product version displayed in the welcome message. */
  productVersion: string
  /** Absolute working directory of the selected profile. */
  profileDir: string
  /** Harness home exported as `DSH_HOME` inside the terminal. */
  homeDir: string
  /** Private directory receiving the generated terminal files. */
  stateDir: string
  /** Process launcher; production passes `node:child_process.spawn`. */
  spawn: DesktopTerminalSpawn
  /** Environment copied into the terminal child; defaults to `process.env`. */
  environment?: NodeJS.ProcessEnv
  /** Optional Windows terminal wrapper. Without one, the selected shell gets its own console. */
  windowsTerminal?: WindowsTerminalLauncher
  /** Windows executable existence probe; defaults to `existsSync`. */
  windowsExecutableExists?: DesktopTerminalExecutableExists
  /** Windows executable resolver; defaults to a trusted PATH/SystemRoot lookup. */
  windowsExecutableResolver?: DesktopTerminalExecutableResolver
  /** Reporter attached before a detached child can emit an asynchronous launch error. */
  onLaunchError?: (cause: Error) => void
}

/** Files and process created for one desktop terminal launch. */
export interface DesktopTerminalLaunch {
  /** Private directory prepended to this terminal's `PATH`. */
  shimDir: string
  /** Generated platform-specific `dsh` shim. */
  dshShimPath: string
  /** Generated platform-specific `pnpm` shim. */
  pnpmShimPath: string
  /** Generated platform-specific `node` shim backed by Electron's Node mode. */
  nodeShimPath: string
  /** Generated script that configures and welcomes the interactive shell. */
  welcomePath: string
  /** Detached launcher process; callers may observe its asynchronous `error` event. */
  child: ChildProcess
}

/**
 * Keep generated command shims stable for one selected profile.
 * @param userDataDir - Electron-owned persistent data directory.
 * @param profileName - profile embedded in the generated DSH shim.
 * @returns private per-profile terminal state directory.
 */
export function desktopTerminalStateDirectory(userDataDir: string, profileName: string): string {
  assertScriptValue('user data directory', userDataDir)
  assertDesktopProfileName(profileName)
  const identity = createHash('sha256').update(profileName, 'utf8').digest('hex')
  return join(userDataDir, 'cli', identity)
}

interface DesktopTerminalFiles {
  shimDir: string
  dshShimPath: string
  pnpmShimPath: string
  nodeShimPath: string
  welcomePath: string
  windowsCmdWelcomePath?: string
}

/** Reject values that cannot be represented safely in generated command files. */
function assertScriptValue(label: string, value: string): void {
  if (value.length === 0) throw new Error(`dsh-plugin-desktop: terminal ${label} must not be empty`)
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`dsh-plugin-desktop: terminal ${label} must not contain NUL or newlines`)
  }
}

/** Quote one arbitrary value as a POSIX shell word. */
function quoteSh(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** Quote one arbitrary value as a PowerShell single-quoted literal. */
function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** Quote a Windows executable path used directly by a batch file. */
function quoteBatchExecutable(value: string): string {
  if (/["\r\n]/.test(value)) {
    throw new Error('dsh-plugin-desktop: terminal Windows executable paths must not contain quotes or newlines')
  }
  return `"${value.replaceAll('%', '%%')}"`
}

/** Escape printable text following an `echo(` batch builtin. */
function escapeBatchText(value: string): string {
  if (/\r|\n/.test(value)) {
    throw new Error('dsh-plugin-desktop: terminal Windows welcome text must not contain newlines')
  }
  return value
    .replaceAll('^', '^^')
    .replaceAll('%', '%%')
    .replaceAll('&', '^&')
    .replaceAll('|', '^|')
    .replaceAll('<', '^<')
    .replaceAll('>', '^>')
    .replaceAll('(', '^(')
    .replaceAll(')', '^)')
}

/** Escape a value inside the quoted right-hand side of a batch `set` command. */
function escapeBatchSetValue(value: string): string {
  if (/\r|\n|"/.test(value)) {
    throw new Error('dsh-plugin-desktop: terminal Windows environment values must not contain quotes or newlines')
  }
  return value.replaceAll('%', '%%')
}

/** Remove a temporary file while preserving every error except absence. */
function unlinkTemporaryFile(filename: string): void {
  try {
    unlinkSync(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
}

/** Replace one generated file without following a pre-existing target symlink. */
function replacePrivateFile(filename: string, contents: string, mode: number): void {
  const temporary = join(dirname(filename), `.${basename(filename)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode })
    chmodSync(temporary, mode)
    renameSync(temporary, filename)
  } finally {
    unlinkTemporaryFile(temporary)
  }
}

/** Create and verify the private directory holding terminal launch files. */
function prepareStateDirectory(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: STATE_DIRECTORY_MODE })
  const stat = lstatSync(stateDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`dsh-plugin-desktop: terminal state path is not a private directory: ${stateDir}`)
  }
  chmodSync(stateDir, STATE_DIRECTORY_MODE)
}

/** Build a command shim that enables Electron's Node mode only for its child. */
function macShim(appExecutable: string, binPath?: string): string {
  const entry = binPath === undefined ? '' : ` ${quoteSh(binPath)}`
  return [
    '#!/bin/sh',
    `${RUN_AS_NODE}=1 exec ${quoteSh(appExecutable)}${entry} "$@"`,
    '',
  ].join('\n')
}

/** Build a command shim that enables Electron's Node mode only for its child. */
function windowsShim(appExecutable: string, binPath?: string): string {
  const entry = binPath === undefined ? '' : ` ${quoteBatchExecutable(binPath)}`
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `set "${RUN_AS_NODE}=1"`,
    `${quoteBatchExecutable(appExecutable)}${entry} %*`,
    'exit /b %errorlevel%',
    '',
  ].join('\r\n')
}

/** Build the DSH shim with Loader internals and one process-local default profile. */
function macDshShim(options: DesktopTerminalOptions): string {
  return [
    '#!/bin/sh',
    [
      `${DEFAULT_PROFILE}=${quoteSh(options.profileName)}`,
      `${RUN_AS_NODE}=1`,
      `exec ${quoteSh(options.appExecutable)} --expose-internals ${quoteSh(options.dshBootstrapPath)} "$@"`,
    ].join(' '),
    '',
  ].join('\n')
}

/** Build the Windows DSH shim with Loader internals and one local default profile. */
function windowsDshShim(options: DesktopTerminalOptions): string {
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `set "${DEFAULT_PROFILE}=${escapeBatchSetValue(options.profileName)}"`,
    `set "${RUN_AS_NODE}=1"`,
    `${quoteBatchExecutable(options.appExecutable)} --expose-internals ${quoteBatchExecutable(options.dshBootstrapPath)} %*`,
    'exit /b %errorlevel%',
    '',
  ].join('\r\n')
}

/** Build a pnpm shim with Electron native-module settings scoped to its process tree. */
function macPnpmShim(options: DesktopTerminalOptions): string {
  return [
    '#!/bin/sh',
    [
      `${RUN_AS_NODE}=1`,
      'npm_config_runtime=electron',
      `npm_config_target=${quoteSh(options.electronVersion)}`,
      `npm_config_disturl=${quoteSh(ELECTRON_HEADERS_URL)}`,
      `exec ${quoteSh(options.appExecutable)} ${quoteSh(options.pnpmBinPath)} "$@"`,
    ].join(' '),
    '',
  ].join('\n')
}

/** Build a pnpm batch shim with Electron settings local to its `setlocal` child tree. */
function windowsPnpmShim(options: DesktopTerminalOptions): string {
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `set "${RUN_AS_NODE}=1"`,
    'set "npm_config_runtime=electron"',
    `set "npm_config_target=${escapeBatchSetValue(options.electronVersion)}"`,
    `set "npm_config_disturl=${ELECTRON_HEADERS_URL}"`,
    `${quoteBatchExecutable(options.appExecutable)} ${quoteBatchExecutable(options.pnpmBinPath)} %*`,
    'exit /b %errorlevel%',
    '',
  ].join('\r\n')
}

/** Build a zsh startup file that preserves the user's rc and then restores desktop variables. */
function macZshRc(options: DesktopTerminalOptions, shimDir: string): string {
  return [
    'if [[ -n "${DSH_DESKTOP_USER_ZDOTDIR:-}" && -r "${DSH_DESKTOP_USER_ZDOTDIR}/.zshrc" ]]; then',
    '  ZDOTDIR="${DSH_DESKTOP_USER_ZDOTDIR}"',
    '  source "${DSH_DESKTOP_USER_ZDOTDIR}/.zshrc"',
    'fi',
    `unset ${RUN_AS_NODE}`,
    `export ${DSH_HOME}=${quoteSh(options.homeDir)}`,
    'typeset -U path',
    `path=(${quoteSh(shimDir)} $path)`,
    'export PATH',
    `unset DSH_DESKTOP_USER_ZDOTDIR`,
    '',
  ].join('\n')
}

/** Build a bash startup file that preserves the user's rc and then restores desktop variables. */
function macBashRc(options: DesktopTerminalOptions, shimDir: string): string {
  return [
    'if [ -n "${DSH_DESKTOP_USER_BASHRC:-}" ] && [ -r "${DSH_DESKTOP_USER_BASHRC}" ]; then',
    '  . "${DSH_DESKTOP_USER_BASHRC}"',
    'fi',
    `unset ${RUN_AS_NODE}`,
    `export ${DSH_HOME}=${quoteSh(options.homeDir)}`,
    'case ":${PATH:-}:" in',
    `  *:${quoteSh(shimDir)}:*) ;;`,
    `  *) export PATH=${quoteSh(shimDir)}:"\${PATH:-}" ;;`,
    'esac',
    'unset DSH_DESKTOP_USER_BASHRC',
    '',
  ].join('\n')
}

/** Build the macOS script opened by LaunchServices in the user's terminal. */
function macWelcome(
  options: DesktopTerminalOptions,
  shimDir: string,
  bashRcPath: string,
): string {
  const commandHelp = 'dsh --dump-config'
  const pluginAdd = 'dsh plugin add <third-party-plugin>'
  const pluginRemove = 'dsh plugin remove <third-party-plugin>'
  const pluginUpdate = 'dsh plugin update'
  return [
    '#!/bin/sh',
    `unset ${RUN_AS_NODE}`,
    `export ${DSH_HOME}=${quoteSh(options.homeDir)}`,
    `export PATH=${quoteSh(shimDir)}:"\${PATH:-}"`,
    `cd ${quoteSh(options.profileDir)}`,
    "printf '\\033[2J\\033[3J\\033[H'",
    `printf '%s\\n' ${quoteSh(`DSH Desktop ${options.productVersion} terminal`)}`,
    `printf '%s\\n' ${quoteSh(`Profile: ${options.profileName}`)}`,
    `printf '%s\\n' ${quoteSh(`Profile directory: ${options.profileDir}`)}`,
    `printf '%s\\n' ${quoteSh(`Harness home: ${options.homeDir}`)}`,
    `printf '%s\\n' ${quoteSh(`Plugin commands without --profile modify the ${options.profileName} profile.`)}`,
    `printf '%s\\n' ${quoteSh('Commands:')}`,
    `printf '  %s\\n' ${quoteSh(commandHelp)}`,
    `printf '  %s\\n' ${quoteSh(pluginAdd)}`,
    `printf '  %s\\n' ${quoteSh(pluginRemove)}`,
    `printf '  %s\\n' ${quoteSh(pluginUpdate)}`,
    `printf '%s\\n' ${quoteSh('Restart DSH Desktop after plugin changes.')}`,
    'case "${SHELL:-/bin/zsh}" in',
    '  */bash)',
    '    export DSH_DESKTOP_USER_BASHRC="${HOME:-}/.bashrc"',
    `    exec "\${SHELL}" --noprofile --rcfile ${quoteSh(bashRcPath)} -i`,
    '    ;;',
    '  */zsh)',
    '    export DSH_DESKTOP_USER_ZDOTDIR="${ZDOTDIR:-${HOME:-}}"',
    `    export ZDOTDIR=${quoteSh(options.stateDir)}`,
    '    exec "${SHELL}" -i',
    '    ;;',
    '  *)',
    '    export DSH_DESKTOP_USER_ZDOTDIR="${ZDOTDIR:-${HOME:-}}"',
    `    export ZDOTDIR=${quoteSh(options.stateDir)}`,
    '    exec /bin/zsh -i',
    '    ;;',
    'esac',
    '',
  ].join('\n')
}

/** Build the PowerShell script that remains active in the new console. */
function windowsWelcome(options: DesktopTerminalOptions, shimDir: string): string {
  const commandHelp = 'dsh --dump-config'
  const pluginAdd = 'dsh plugin add <third-party-plugin>'
  const pluginRemove = 'dsh plugin remove <third-party-plugin>'
  const pluginUpdate = 'dsh plugin update'
  return [
    `Remove-Item Env:${RUN_AS_NODE} -ErrorAction SilentlyContinue`,
    `$env:${DSH_HOME} = ${quotePowerShell(options.homeDir)}`,
    `$dshDesktopShimDir = ${quotePowerShell(shimDir)}`,
    `$dshDesktopPath = @($env:${PATH} -split ';' | Where-Object { -not [string]::Equals($_, $dshDesktopShimDir, [StringComparison]::OrdinalIgnoreCase) })`,
    `$env:${PATH} = (@($dshDesktopShimDir) + $dshDesktopPath) -join ';'`,
    `Set-Location -LiteralPath ${quotePowerShell(options.profileDir)}`,
    `Write-Host ${quotePowerShell(`DSH Desktop ${options.productVersion} terminal`)}`,
    `Write-Host ${quotePowerShell(`Profile: ${options.profileName}`)}`,
    `Write-Host ${quotePowerShell(`Profile directory: ${options.profileDir}`)}`,
    `Write-Host ${quotePowerShell(`Harness home: ${options.homeDir}`)}`,
    `Write-Host ${quotePowerShell(`Plugin commands without --profile modify the ${options.profileName} profile.`)}`,
    `Write-Host ${quotePowerShell('Commands:')}`,
    `Write-Host ${quotePowerShell(`  ${commandHelp}`)}`,
    `Write-Host ${quotePowerShell(`  ${pluginAdd}`)}`,
    `Write-Host ${quotePowerShell(`  ${pluginRemove}`)}`,
    `Write-Host ${quotePowerShell(`  ${pluginUpdate}`)}`,
    `Write-Host ${quotePowerShell('Restart DSH Desktop after plugin changes.')}`,
    '',
  ].join('\r\n')
}

/** Build the fallback batch welcome script used when neither PowerShell is installed. */
function windowsCmdWelcome(options: DesktopTerminalOptions): string {
  const commandHelp = 'dsh --dump-config'
  const pluginAdd = 'dsh plugin add <third-party-plugin>'
  const pluginRemove = 'dsh plugin remove <third-party-plugin>'
  const pluginUpdate = 'dsh plugin update'
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `set "${RUN_AS_NODE}="`,
    `set "${DSH_HOME}=${escapeBatchSetValue(options.homeDir)}"`,
    `cd /d ${quoteBatchExecutable(options.profileDir)}`,
    `echo(${escapeBatchText(`DSH Desktop ${options.productVersion} terminal`)}`,
    `echo(${escapeBatchText(`Profile: ${options.profileName}`)}`,
    `echo(${escapeBatchText(`Profile directory: ${options.profileDir}`)}`,
    `echo(${escapeBatchText(`Harness home: ${options.homeDir}`)}`,
    `echo(${escapeBatchText(`Plugin commands without --profile modify the ${options.profileName} profile.`)}`,
    'echo(Commands:',
    `echo(  ${escapeBatchText(commandHelp)}`,
    `echo(  ${escapeBatchText(pluginAdd)}`,
    `echo(  ${escapeBatchText(pluginRemove)}`,
    `echo(  ${escapeBatchText(pluginUpdate)}`,
    `echo(${escapeBatchText('Restart DSH Desktop after plugin changes.')}`,
    'endlocal & set "ELECTRON_RUN_AS_NODE="',
    '',
  ].join('\r\n')
}

/** Create command shims and the interactive welcome script. */
function prepareDesktopTerminalFiles(options: DesktopTerminalOptions): DesktopTerminalFiles {
  if (options.platform !== 'darwin' && options.platform !== 'win32') {
    throw new Error(`dsh-plugin-desktop: terminal is unsupported on ${options.platform}`)
  }
  assertDesktopProfileName(options.profileName)
  for (const [label, value] of [
    ['application executable', options.appExecutable],
    ['dsh bootstrap', options.dshBootstrapPath],
    ['pnpm entry', options.pnpmBinPath],
    ['Electron version', options.electronVersion],
    ['profile directory', options.profileDir],
    ['Harness home', options.homeDir],
    ['state directory', options.stateDir],
    ['product version', options.productVersion],
  ] as const) assertScriptValue(label, value)

  prepareStateDirectory(options.stateDir)
  const shimDir = join(options.stateDir, 'bin')
  prepareStateDirectory(shimDir)
  if (options.platform === 'darwin') {
    const files: DesktopTerminalFiles = {
      shimDir,
      dshShimPath: join(shimDir, 'dsh'),
      pnpmShimPath: join(shimDir, 'pnpm'),
      nodeShimPath: join(shimDir, 'node'),
      welcomePath: join(options.stateDir, 'welcome.command'),
    }
    const bashRcPath = join(options.stateDir, 'bashrc')
    replacePrivateFile(files.dshShimPath, macDshShim(options), EXECUTABLE_FILE_MODE)
    replacePrivateFile(files.pnpmShimPath, macPnpmShim(options), EXECUTABLE_FILE_MODE)
    replacePrivateFile(files.nodeShimPath, macShim(options.appExecutable), EXECUTABLE_FILE_MODE)
    replacePrivateFile(join(options.stateDir, '.zshrc'), macZshRc(options, shimDir), PRIVATE_FILE_MODE)
    replacePrivateFile(bashRcPath, macBashRc(options, shimDir), PRIVATE_FILE_MODE)
    replacePrivateFile(files.welcomePath, macWelcome(options, shimDir, bashRcPath), EXECUTABLE_FILE_MODE)
    return files
  }
  if (options.platform === 'win32') {
    const windowsCmdWelcomePath = join(options.stateDir, 'welcome.cmd')
    const files: DesktopTerminalFiles = {
      shimDir,
      dshShimPath: join(shimDir, 'dsh.cmd'),
      pnpmShimPath: join(shimDir, 'pnpm.cmd'),
      nodeShimPath: join(shimDir, 'node.cmd'),
      welcomePath: join(options.stateDir, 'welcome.ps1'),
      windowsCmdWelcomePath,
    }
    replacePrivateFile(files.dshShimPath, windowsDshShim(options), PRIVATE_FILE_MODE)
    replacePrivateFile(files.pnpmShimPath, windowsPnpmShim(options), PRIVATE_FILE_MODE)
    replacePrivateFile(files.nodeShimPath, windowsShim(options.appExecutable), PRIVATE_FILE_MODE)
    replacePrivateFile(files.welcomePath, windowsWelcome(options, shimDir), PRIVATE_FILE_MODE)
    replacePrivateFile(windowsCmdWelcomePath, windowsCmdWelcome(options), PRIVATE_FILE_MODE)
    return files
  }
  throw new Error(`dsh-plugin-desktop: terminal is unsupported on ${options.platform}`)
}

/** Copy the Host environment and scope desktop command discovery to one terminal child. */
function terminalEnvironment(options: DesktopTerminalOptions, shimDir: string): NodeJS.ProcessEnv {
  const source = options.environment ?? process.env
  const env: NodeJS.ProcessEnv = {}
  let inheritedPath: string | undefined
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toUpperCase()
    if (normalized === RUN_AS_NODE || normalized === DSH_HOME) continue
    if (normalized === PATH) {
      inheritedPath ??= value
      continue
    }
    env[key] = value
  }
  const delimiter = options.platform === 'win32' ? ';' : ':'
  env[PATH] = inheritedPath === undefined || inheritedPath.length === 0
    ? shimDir
    : `${shimDir}${delimiter}${inheritedPath}`
  env[DSH_HOME] = options.homeDir
  return env
}

/** Read one Windows environment value without trusting its key casing. */
function windowsEnvironmentValue(environment: Readonly<NodeJS.ProcessEnv>, name: string): string | undefined {
  const normalized = name.toUpperCase()
  for (const [key, value] of Object.entries(environment)) {
    if (key.toUpperCase() === normalized) return value
  }
  return undefined
}

/** Resolve known Windows shells from explicit system paths and then the inherited PATH. */
function defaultWindowsExecutableResolver(
  command: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  exists: DesktopTerminalExecutableExists,
): string | undefined {
  const candidates: string[] = []
  const systemRoot = windowsEnvironmentValue(environment, 'SystemRoot')
  if (command.toLowerCase() === 'powershell.exe' && systemRoot !== undefined) {
    candidates.push(win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  }
  if (command.toLowerCase() === 'cmd.exe') {
    const comSpec = windowsEnvironmentValue(environment, 'ComSpec')
    if (comSpec !== undefined) candidates.push(comSpec)
    if (systemRoot !== undefined) candidates.push(win32.join(systemRoot, 'System32', 'cmd.exe'))
  }
  const inheritedPath = windowsEnvironmentValue(environment, PATH)
  if (inheritedPath !== undefined) {
    for (const rawDir of inheritedPath.split(';')) {
      const dir = rawDir.startsWith('"') && rawDir.endsWith('"') ? rawDir.slice(1, -1) : rawDir
      if (dir.length > 0) candidates.push(win32.join(dir, command))
    }
  }
  return candidates.find(candidate => exists(candidate))
}

interface ResolvedWindowsShell {
  kind: 'powershell' | 'cmd'
  executable: string
}

/** Select PowerShell 7, Windows PowerShell, or the built-in command prompt. */
function resolveWindowsShell(
  options: DesktopTerminalOptions,
  environment: Readonly<NodeJS.ProcessEnv>,
): ResolvedWindowsShell {
  const exists = options.windowsExecutableExists ?? existsSync
  const resolveExecutable = options.windowsExecutableResolver ?? defaultWindowsExecutableResolver
  for (const command of WINDOWS_SHELL_COMMANDS) {
    const executable = resolveExecutable(command, environment, exists)
    if (executable === undefined) continue
    assertScriptValue(`${command} executable`, executable)
    return {
      kind: command === 'cmd.exe' ? 'cmd' : 'powershell',
      executable,
    }
  }
  throw new Error('dsh-plugin-desktop: terminal requires pwsh.exe, powershell.exe, or cmd.exe on Windows')
}

/** Convert one selected Windows shell into an argv-only launch. */
function windowsShellArgv(
  shell: ResolvedWindowsShell,
  files: DesktopTerminalFiles,
): string[] {
  if (shell.kind === 'cmd') {
    const welcome = files.windowsCmdWelcomePath
    if (welcome === undefined) {
      throw new Error('dsh-plugin-desktop: terminal did not generate the Windows command prompt welcome script')
    }
    return ['/D', '/K', 'call', welcome]
  }
  return [
    '-NoLogo',
    '-NoExit',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    files.welcomePath,
  ]
}

/** Report a detached launch error without leaving an unhandled EventEmitter error. */
function reportLaunchError(options: DesktopTerminalOptions, cause: Error): void {
  if (options.onLaunchError !== undefined) {
    try {
      options.onLaunchError(cause)
      return
    } catch (reportCause) {
      const detail = reportCause instanceof Error ? reportCause.message : String(reportCause)
      process.stderr.write(`dsh-plugin-desktop: terminal error reporter failed: ${detail}\n`)
      return
    }
  }
  process.stderr.write(`dsh-plugin-desktop: failed to open terminal: ${cause.message}\n`)
}

/**
 * Generate a private desktop CLI environment and open it in a native terminal.
 * @param options - packaged CLI paths, profile identity, private state, and process adapter.
 * @returns generated file paths and the detached launcher process.
 */
export function openDesktopTerminal(options: DesktopTerminalOptions): DesktopTerminalLaunch {
  const files = prepareDesktopTerminalFiles(options)
  const env = terminalEnvironment(options, files.shimDir)
  const spawnOptions: SpawnOptions = {
    cwd: options.profileDir,
    detached: true,
    env,
    shell: false,
    stdio: 'ignore',
    windowsHide: false,
  }
  let command: string
  let args: string[]
  if (options.platform === 'darwin') {
    command = '/usr/bin/open'
    args = ['-a', 'Terminal', files.welcomePath]
  } else {
    const shell = resolveWindowsShell(options, env)
    const shellArgs = windowsShellArgv(shell, files)
    command = options.windowsTerminal?.executable ?? shell.executable
    args = options.windowsTerminal === undefined
      ? shellArgs
      : [...(options.windowsTerminal.arguments ?? []), shell.executable, ...shellArgs]
  }
  const child = options.spawn(command, args, spawnOptions)
  child.once('error', cause => { reportLaunchError(options, cause) })
  child.unref()
  return {
    shimDir: files.shimDir,
    dshShimPath: files.dshShimPath,
    pnpmShimPath: files.pnpmShimPath,
    nodeShimPath: files.nodeShimPath,
    welcomePath: files.welcomePath,
    child,
  }
}
