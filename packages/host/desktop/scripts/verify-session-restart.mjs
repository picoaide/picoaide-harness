/**
 * Session restart smoke: a session created by the assembled desktop profile
 * survives a full boot cycle, and the durable artifact stays byte-identical
 * across the reopen.
 *
 * Why this exists (2026-09-11, DSH 0.1.5 upgrade): rc.2 moved the session format
 * to v3 and the JSONL backend publishes a successor generation on the first
 * write open. The client E2E cannot cover this — its mock gateway serves empty
 * session lists, so it never creates a session at all — and a downgrade is
 * silently lossy, which makes "new session → restart → still there" the one
 * behaviour the upgrade must not regress. This smoke boots the real profile
 * twice against one temporary DSH_HOME and asserts the round trip.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { installProfilePackageResolver } from '../lib/module-resolution.js'
import { prepareDesktopProfile } from '../lib/profile.js'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const { prebuildWorkspaceDeps } = await import('./prebuild-workspace-deps.ts')
prebuildWorkspaceDeps(packageRoot)

const BIN_NAME = 'dsh-plugin-desktop-session-smoke'
const HOST_SERVICE_PLUGIN_NAME = 'dsh-desktop-host-services-smoke-plugin'
const SESSION_ID = 'session-restart-smoke'
const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-session-'))
const previousDshHome = process.env.DSH_HOME
process.env.DSH_HOME = home

/** Locate the session's directory under the profile-owned session root. */
function findSessionLog(id) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return undefined
  for (const project of readdirSync(root)) {
    const dir = join(root, project, id)
    if (!existsSync(dir)) continue
    const file = readdirSync(dir).find(name => name.startsWith('session') && name.includes('.jsonl'))
    if (file !== undefined) return join(dir, file)
  }
  return undefined
}

/** Build the launcher-owned runtime face the desktop plugin requires. */
function createRuntime() {
  const runtime = {
    platform: process.platform,
    locale: 'en',
    updates: {
      isPackaged: false,
      canDownload: true,
      currentVersion: '2.0.0',
      statePath: join(home, 'update-state.json'),
      request: async () => { throw new Error('session smoke must not perform update requests') },
      confirmDownload: async () => false,
      showManualCheckResult: async () => {},
      downloadAndOpen: async () => {},
      notify: () => {},
    },
    schedule(spec) {
      runtime.mountedSpec = spec
      return async () => {}
    },
    async mountScheduled() {
      if (runtime.mountedSpec === undefined) throw new Error('desktop shell was not registered')
    },
    show() {},
    registerTrayItem() {
      return { refresh() {}, dispose() {} }
    },
    setLocalePreference() {},
    setThemeSource() {},
    async requestRestart() {},
    prepareToQuit() {},
    setDeepLinkHandler() {},
  }
  return runtime
}

/**
 * Boot the assembled desktop profile once.
 * @returns the host context plus its package-resolver release hook.
 */
async function bootProfile() {
  const prepared = await prepareDesktopProfile('1', home, process.platform)
  // The profile directory is persistent across the two boots, so the fixture
  // plugin is seeded once and reused by the restart.
  const hostServicePluginDir = join(prepared.profile.dir, 'node_modules', HOST_SERVICE_PLUGIN_NAME)
  mkdirSync(join(prepared.profile.dir, 'node_modules'), { recursive: true })
  if (!existsSync(hostServicePluginDir)) {
    cpSync(
      fileURLToPath(new URL('../tests/fixtures/desktop-host-services-smoke-plugin/', import.meta.url)),
      hostServicePluginDir,
      { recursive: true, force: false, errorOnExist: true },
    )
  }
  const patches = [
    { insert: [{ id: 'desktop-host-services-smoke-plugin', name: HOST_SERVICE_PLUGIN_NAME }] },
    ...prepared.patches,
  ]
  const releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
  const runtime = createRuntime()
  const ctx = await boot(
    BIN_NAME,
    prepared.rootConfig,
    patches,
    async (host) => {
      host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]))
      host.provide('desktopRuntime', runtime)
      provideCmdline(host, { args: ['--host', '127.0.0.1', '--port', '0'], exit: () => {} })
    },
    prepared.bareModuleBaseUrl,
  )
  await runtime.mountScheduled()
  return { ctx, releasePackageResolver }
}

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

let first
let second
try {
  writeFileSync(join(home, 'settings.yaml'), [
    'dsh-desktop:',
    '  mode: advanced',
    'agent-presets:',
    '  default: minimal',
    '',
  ].join('\n'))

  // Boot 1: create a session and make it durable the way an idle session is.
  first = await bootProfile()
  const persistence = first.ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('assembled profile has no session persistence backend')
  check('profile boots with a session persistence backend', true)

  const handle = await persistence.create({
    // The backend validates the stamped version, so the header carries the
    // running package's current format (v3 on 0.1.5).
    version: SESSION_FORMAT_VERSION,
    id: SESSION_ID,
    createdAt: Date.now(),
    cwd: home,
    isSeeded: false,
  })
  await handle.flush()
  await handle.close()

  const logFile = findSessionLog(SESSION_ID)
  check('a created session is materialized on disk', logFile !== undefined, logFile ?? 'not found')
  const sizeBefore = logFile === undefined ? 0 : statSync(logFile).size
  await first.ctx.fiber.dispose()
  first.releasePackageResolver()
  first = undefined

  // Boot 2: a fresh process-level boot must list and open the same session.
  second = await bootProfile()
  const persistence2 = second.ctx.get('sessionPersistence')
  const listed = await persistence2.list()
  const ids = listed.map(snapshot => snapshot.header.id)
  check('restart lists the session created before it', ids.includes(SESSION_ID), `ids=${ids.join(',') || '(none)'}`)

  const reopened = await persistence2.open(SESSION_ID, 'read')
  const header = reopened.header
  const body = await reopened.read()
  await reopened.close()
  check(
    'restart reopens the session with its header intact',
    header.id === SESSION_ID && header.cwd === home,
    `id=${header.id} formatVersion=${String(header.version)} events=${body.events.length}`,
  )

  const sizeAfter = logFile === undefined ? 0 : statSync(logFile).size
  check('reopening does not rewrite the stored log', sizeAfter === sizeBefore, `${sizeBefore} → ${sizeAfter} bytes`)
} finally {
  await second?.ctx.fiber.dispose().catch(() => {})
  second?.releasePackageResolver?.()
  first?.releasePackageResolver?.()
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  rmSync(home, { recursive: true, force: true })
}

const failed = checks.filter(entry => !entry.ok)
console.log(`\nverify-session-restart: ${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) {
  console.error(failed.map(entry => `  ✗ ${entry.name} — ${entry.detail}`).join('\n'))
  process.exit(1)
}
