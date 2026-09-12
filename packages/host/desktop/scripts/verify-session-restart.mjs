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
 *
 * Why it also covers v0 → v3 (2026-09-12, P1-13): the round trip above only
 * proved "created as v3 stays v3", never the migration path our users actually
 * take — every pre-upgrade session is a released-v0 `session.jsonl.zstd`. The
 * second half of this script plants one such v0 log next to the created
 * session and asserts the copy-on-write migration: read open migrates in
 * memory only (no successor, source byte-identical), write open publishes
 * `session.v3.jsonl.zstd` in the same directory while the v0 source stays
 * byte-identical, and the reopened session reads back the migrated content.
 *
 * Fixture note: the pinned upstream's only released-v0 fixture
 * (`deepseek-harness/packages/session/session-persistence-jsonl/tests/fixtures/
 * released-v0-real-shapes.jsonl`) is the *refusal* fixture — it is frozen
 * precisely because its surface events precede the first step, so both read and
 * write open reject it. A migrating v0 log is therefore synthesized here with
 * the same physical shape as the live corpus (one zstd frame per write batch,
 * first frame = header only) and payload members taken from the frozen
 * released-v0 dispositions.
 */

import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { constants, zstdCompressSync } from 'node:zlib'
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
const MIGRATION_SESSION_ID = 'session-v0-migration-smoke'
const V0_LOG_NAME = 'session.jsonl.zstd'
const V3_LOG_NAME = 'session.v3.jsonl.zstd'
const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-session-'))
const previousDshHome = process.env.DSH_HOME
process.env.DSH_HOME = home

/** Canonical generation file names at or below v3 (v0 is untagged). */
const GENERATION_FILE = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/u

/** Locate the session's directory under the profile-owned session root. */
function findSessionDir(id) {
  const root = join(home, 'sessions')
  if (!existsSync(root)) return undefined
  for (const project of readdirSync(root)) {
    const dir = join(root, project, id)
    if (existsSync(dir)) return dir
  }
  return undefined
}

/** List the generation files of one session directory, sorted by name. */
function generationFiles(dir) {
  if (dir === undefined || !existsSync(dir)) return []
  return readdirSync(dir).filter(name => GENERATION_FILE.test(name)).sort()
}

/**
 * Write one released-v0 session log the way the 0.1.2-rc.1 line wrote it: one
 * zstd frame per write batch, header frame first, no generation tag in the
 * file name. Payload members come from the frozen released-v0 dispositions
 * (required ∪ optional), mirroring `released-v0-real-shapes.jsonl` but with
 * the surface event inside the first step, which is the migratable shape.
 * @param projectDir - the session root's project directory for this cwd.
 * @returns the absolute path of the planted v0 log.
 */
function writeV0Session(projectDir) {
  const dir = join(projectDir, MIGRATION_SESSION_ID)
  mkdirSync(dir, { recursive: true })
  const time = Date.now()
  const header = {
    type: 'session', version: 0, id: MIGRATION_SESSION_ID, createdAt: time, cwd: home, delegationDepth: 0,
  }
  const events = [
    { type: 'turn/start', seq: 0, time: time + 1, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: time + 2, data: { turn: 1, step: 1 } },
    {
      type: 'user/message',
      seq: 2,
      time: time + 3,
      data: {
        id: 'v0-migration-user',
        role: 'user',
        content: [{ type: 'text', text: 'released v0 session' }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    },
    { type: 'step/end', seq: 3, time: time + 4, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 4, time: time + 5, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const frames = [JSON.stringify(header), ...events.map(event => JSON.stringify(event))]
    .map(line => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'), {
      params: { [constants.ZSTD_c_checksumFlag]: 1 },
    }))
  const path = join(dir, V0_LOG_NAME)
  writeFileSync(path, Buffer.concat(frames))
  return path
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

  // Boot 1: create a session and make it durable the way an idle session is,
  // then plant a released-v0 session in the same project directory.
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

  const sessionDir = findSessionDir(SESSION_ID)
  check('a created session is materialized on disk', sessionDir !== undefined, sessionDir ?? 'not found')
  if (sessionDir === undefined) throw new Error('cannot plant the v0 fixture without a project directory')
  const createdFiles = generationFiles(sessionDir)
  check(
    'the created session uses the current v3 generation file name',
    createdFiles.includes(V3_LOG_NAME),
    `files=${createdFiles.join(',') || '(none)'}`,
  )
  const sizeBefore = statSync(join(sessionDir, V3_LOG_NAME)).size
  const projectDir = dirname(sessionDir)
  await first.ctx.fiber.dispose()
  first.releasePackageResolver()
  first = undefined

  // Plant the released-v0 session only after boot 1 is gone, so the running
  // backend never observes (or leases) a directory it does not own.
  const v0Path = writeV0Session(projectDir)
  const v0Before = readFileSync(v0Path)
  check('a released-v0 session log is planted next to it', v0Before.length > 0,
    `${v0Path} (${String(v0Before.length)} bytes)`)

  // Boot 2: a fresh process-level boot must list and open both sessions, and
  // the v0 one must migrate exactly once, on write open.
  second = await bootProfile()
  const persistence2 = second.ctx.get('sessionPersistence')
  const listed = await persistence2.list()
  const ids = listed.map(snapshot => snapshot.header.id)
  check('restart lists the session created before it', ids.includes(SESSION_ID), `ids=${ids.join(',') || '(none)'}`)
  check('restart lists the planted v0 session', ids.includes(MIGRATION_SESSION_ID), `ids=${ids.join(',') || '(none)'}`)

  const reopened = await persistence2.open(SESSION_ID, 'read')
  const header = reopened.header
  const body = await reopened.read()
  await reopened.close()
  check(
    'restart reopens the session with its header intact',
    header.id === SESSION_ID && header.cwd === home,
    `id=${header.id} formatVersion=${String(header.version)} events=${body.events.length}`,
  )

  const sizeAfter = statSync(join(sessionDir, V3_LOG_NAME)).size
  check('reopening does not rewrite the stored log', sizeAfter === sizeBefore, `${sizeBefore} → ${sizeAfter} bytes`)

  // v0 → v3 migration path (P1-13).
  const previewed = await persistence2.open(MIGRATION_SESSION_ID, 'read')
  const previewHeader = previewed.header
  const previewBody = await previewed.read()
  await previewed.close()
  check(
    'read open of a v0 session migrates in memory',
    previewHeader.id === MIGRATION_SESSION_ID && previewBody.events.length > 0,
    `formatVersion=${String(previewHeader.version)} events=${previewBody.events.length}`,
  )
  check(
    'read open publishes no successor generation',
    !existsSync(join(dirname(v0Path), V3_LOG_NAME)),
    `files=${generationFiles(dirname(v0Path)).join(',') || '(none)'}`,
  )
  check('read open leaves the v0 log byte-identical', readFileSync(v0Path).equals(v0Before))

  const resumed = await persistence2.open(MIGRATION_SESSION_ID, 'write')
  check(
    'write open of a v0 session is accepted',
    resumed.header.id === MIGRATION_SESSION_ID,
    `formatVersion=${String(resumed.header.version)}`,
  )
  await resumed.close()

  const migratedFiles = generationFiles(dirname(v0Path))
  check(
    'write open publishes the v3 generation in the same directory',
    migratedFiles.includes(V3_LOG_NAME),
    `files=${migratedFiles.join(',') || '(none)'}`,
  )
  check('write open leaves the v0 source byte-identical', readFileSync(v0Path).equals(v0Before))

  const after = await persistence2.open(MIGRATION_SESSION_ID, 'read')
  const afterHeader = after.header
  const afterBody = await after.read()
  await after.close()
  check(
    'the migrated session reopens from the successor with the same content',
    afterHeader.version === SESSION_FORMAT_VERSION && afterBody.events.length === previewBody.events.length,
    `formatVersion=${String(afterHeader.version)} events=${afterBody.events.length} (v0: ${previewBody.events.length})`,
  )
  check(
    'the v0 source is preserved beside its successor',
    migratedFiles.includes(V0_LOG_NAME) && readFileSync(v0Path).equals(v0Before),
    `files=${migratedFiles.join(',') || '(none)'}`,
  )
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
