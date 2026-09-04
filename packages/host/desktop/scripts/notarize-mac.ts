/** Resilient App Store Connect notarization for one macOS app bundle.
 *
 * electron-builder's inline `notarize` runs `xcrun notarytool ... --wait`,
 * which keeps one long-lived connection open until Apple reports the
 * submission result. GitHub-hosted macOS runners have proven to drop that
 * connection inside the wait (NSURLError -1009/-1005 after ~20-30 min, with
 * the submission itself already accepted by Apple), turning a transient
 * network blip into a failed build and a full re-run of the gate.
 *
 * This module redoes the same flow with the resilient shape: submit WITHOUT
 * --wait (one short request), then poll submission status with short
 * per-request calls that each carry their own retries. A dropped polling
 * request costs seconds instead of a full rebuild.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 新式 notarytool(Xcode 15+)输出 "Submission ID received" 后跟一行
// "  id: <uuid>";旧式输出单行 "Submission ID: <uuid>"。两种都要认。
const SUBMISSION_ID_RE = /(?:Submission ID|id):\s*([0-9a-fA-F-]+)/u
const STATUS_RE = /Status:\s*([A-Za-z][A-Za-z ]*)/iu

export interface NotarizeMacOptions {
  /** Application bundle to notarize and staple. */
  readonly appPath: string
  /** Environment supplying APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER
   * (or the Apple ID trio / APPLE_KEYCHAIN_PROFILE). */
  readonly env: NodeJS.ProcessEnv
  /** Poll interval between status checks. */
  readonly pollIntervalMs: number
  /** Hard deadline for the whole submit+poll+staple sequence. */
  readonly deadlineMs: number
  /** Per-command retries for transient failures (network, Apple 5xx). */
  readonly retries: number
  /** Backoff between per-command retries. */
  readonly backoffMs: number
  /** Execute one command; returns stdout, throws on non-zero. */
  readonly run: (command: string, args: readonly string[], cwd?: string) => string
  /** Injectable sleep for tests and between polls. */
  readonly sleep: (ms: number) => Promise<void>
  /** Report one non-secret progress line. */
  readonly log: (message: string) => void
}

export interface NotarizeMacResult {
  readonly appPath: string
  readonly submissionId: string
  readonly status: string
}

function credentialArgumentGroup(env: NodeJS.ProcessEnv): string[] {
  const apiKey = env.APPLE_API_KEY?.trim()
  const apiKeyId = env.APPLE_API_KEY_ID?.trim()
  const issuer = env.APPLE_API_ISSUER?.trim()
  if (apiKey !== undefined && apiKey !== '') {
    if (apiKeyId === undefined || apiKeyId === '' || issuer === undefined || issuer === '') {
      throw new Error('Incomplete API-key notarization credentials: missing APPLE_API_KEY_ID or APPLE_API_ISSUER')
    }
    return ['--key', apiKey, '--key-id', apiKeyId, '--issuer', issuer]
  }
  const appleId = env.APPLE_ID?.trim()
  const password = env.APPLE_APP_SPECIFIC_PASSWORD?.trim()
  const teamId = env.APPLE_TEAM_ID?.trim()
  if (appleId !== undefined && appleId !== '') {
    if (password === undefined || password === '' || teamId === undefined || teamId === '') {
      throw new Error('Incomplete Apple ID notarization credentials: missing APPLE_APP_SPECIFIC_PASSWORD or APPLE_TEAM_ID')
    }
    return ['--apple-id', appleId, '--password', password, '--team-id', teamId]
  }
  const keychainProfile = env.APPLE_KEYCHAIN_PROFILE?.trim()
  if (keychainProfile !== undefined && keychainProfile !== '') {
    return ['--keychain-profile', keychainProfile]
  }
  throw new Error(
    'macOS notarization credentials are required: set APPLE_KEYCHAIN_PROFILE, the Apple ID trio, or the App Store Connect API key trio',
  )
}

/**
 * Submit an application for notarization and wait for the result using short,
 * individually retried poll requests; staple the ticket into the app.
 * @param options - Process and timing boundaries.
 */
export async function notarizeMacApp(options: NotarizeMacOptions): Promise<NotarizeMacResult> {
  const authArgs = credentialArgumentGroup(options.env)
  const deadlineAt = Date.now() + options.deadlineMs

  // 0) notarytool only accepts zip/pkg/dmg archives — zip the app bundle first
  // (mirrors @electron/notarize: ditto -c -k --sequesterRsrc --keepParent).
  const workingDir = mkdtempSync(join(tmpdir(), 'dsh-notary-'))
  const zipPath = join(workingDir, `${basename(options.appPath)}.zip`)
  try {
    options.run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', basename(options.appPath), zipPath], dirname(options.appPath))
    options.log(`notarization payload prepared: ${zipPath}`)

    // 1) Submit without --wait: one short request, individually retried.
    let submissionId = ''
    {
      let attempt = 0
      let stdout = ''
      while (attempt <= options.retries) {
        attempt += 1
        try {
          stdout = options.run('xcrun', ['notarytool', 'submit', zipPath, ...authArgs])
          submissionId = SUBMISSION_ID_RE.exec(stdout)?.[1] ?? ''
          if (submissionId !== '') break
          // 输出已确认上传成功但解析不出 id:这是确定性缺陷,重试只会重复提交
          // 同样的包产生多余 submission;立即 fail-loud。
          if (/Successfully uploaded file/u.test(stdout)) {
            throw new Error(`could not parse Submission ID from notarytool output:\n${stdout.slice(0, 400)}`)
          }
          throw new Error(`notarytool submit produced no Submission ID:\n${stdout.slice(0, 300)}`)
        } catch (error) {
          if (attempt > options.retries) throw error
          options.log(`notarytool submit failed (attempt ${attempt}); retrying in ${options.backoffMs}ms`)
          await options.sleep(options.backoffMs)
        }
      }
    }
    options.log(`notarytool submission ${submissionId} accepted`)

  // 2) Short-poll the submission status; each call carries its own retries.
  // A poll that keeps failing (network drop, unparseable output) is treated as
  // transient: log it and keep polling until the deadline — the deadline itself
  // is the fail-loud boundary, not any single dropped connection.
  let status = ''
  while (Date.now() < deadlineAt) {
    let attempt = 0
    let lastFailure = ''
    while (attempt <= options.retries) {
      attempt += 1
      try {
        const stdout = options.run('xcrun', ['notarytool', 'info', submissionId, ...authArgs])
        const parsed = STATUS_RE.exec(stdout)?.[1]?.trim() ?? ''
        if (parsed !== '') {
          status = parsed
          break
        }
        lastFailure = 'could not parse Status from notarytool info output'
        throw new Error(lastFailure)
      } catch (error) {
        if (attempt > options.retries) break
        lastFailure = error instanceof Error ? error.message : String(error)
        options.log(`notarytool info poll failed (attempt ${attempt}); retrying in ${options.backoffMs}ms`)
        await options.sleep(options.backoffMs)
      }
    }
    if (status === '') {
      options.log(`notarytool info poll gave up: ${lastFailure}; polling again in ${options.pollIntervalMs}ms`)
      await options.sleep(options.pollIntervalMs)
      continue
    }
    if (status === 'Accepted') break
    if (status === 'Invalid') {
      let detail = ''
      try {
        detail = options.run('xcrun', ['notarytool', 'log', submissionId, ...authArgs])
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error)
      }
      throw new Error(`notarization submission ${submissionId} was rejected by Apple\n${detail.slice(0, 2000)}`)
    }
    options.log(`submission ${submissionId} ${status === '' ? 'unknown status' : status}; polling again in ${options.pollIntervalMs}ms`)
    await options.sleep(options.pollIntervalMs)
  }
  if (status !== 'Accepted') {
    throw new Error(`notarization submission ${submissionId} did not reach Accepted within ${options.deadlineMs}ms (last status: ${status || 'unknown'})`)
  }

  // 3) Staple the ticket into the app bundle and validate it.
  options.run('xcrun', ['stapler', 'staple', options.appPath])
  options.run('xcrun', ['stapler', 'validate', options.appPath])
  return { appPath: options.appPath, submissionId, status }
  } finally {
    rmSync(workingDir, { recursive: true, force: true })
  }
}

function defaultRun(command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd?: string): string {
  const result = spawnSync(command, args, { env, encoding: 'utf8', cwd })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const stderr = (result.stderr ?? result.stdout ?? '').toString().trim()
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}${stderr.length > 0 ? `\n${stderr.slice(0, 2000)}` : ''}`)
  }
  return String(result.stdout ?? '')
}

function defaultOptions(): NotarizeMacOptions {
  const appPath = process.argv[2]
  if (appPath === undefined || appPath === '') {
    throw new Error('usage: notarize-mac.ts <application.app>')
  }
  return {
    appPath: resolve(appPath),
    env: process.env,
    pollIntervalMs: 60_000,
    deadlineMs: 100 * 60_000,
    retries: 8,
    backoffMs: 10_000,
    run: (command, args, cwd) => defaultRun(command, args, process.env, cwd),
    sleep: ms => new Promise(resolveTimer => setTimeout(resolveTimer, ms)),
    log: message => console.log(message),
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  notarizeMacApp(defaultOptions())
    .then(result => console.log(`notarization passed: ${result.appPath} (${result.submissionId}, ${result.status})`))
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
