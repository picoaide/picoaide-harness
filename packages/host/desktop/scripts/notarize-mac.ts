/** Resilient App Store Connect notarization for one macOS app bundle.
 *
 * electron-builder's inline `notarize` runs `xcrun notarytool ... --wait`,
 * which keeps one long-lived connection open until Apple reports the
 * submission result. GitHub-hosted macOS runners keep dropping that
 * connection mid-wait (verified -1005 then -1009 'offline', on both arm64
 * and Intel runners, with the submission itself already accepted), turning
 * a transient network blip into a failed build and a full re-run.
 *
 * This module uses the official resilient shape instead:
 *
 * - `notarytool submit` WITHOUT `--wait` (one short request, own retries) —
 *   Apple keeps processing the submission after any disconnect;
 * - `notarytool wait <id> --timeout <n>` short bounded polls — a dropped
 *   poll costs seconds, and the same submission id is resumed by re-running
 *   this module (the id is persisted to `resumeFilePath`), so neither the
 *   build nor the Apple queue position is lost;
 * - `stapler staple` + `validate` on success (both official xcrun commands).
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 新式 notarytool(Xcode 15+)输出 "Submission ID received" 后跟一行
// "  id: <uuid>";旧式输出单行 "Submission ID: <uuid>"。两种都要认。
const SUBMISSION_ID_RE = /(?:Submission ID|id):\s*([0-9a-fA-F-]+)/u
// wait/info 输出状态行;不同 Xcode 版本出现过 "Status: ..." 与 "Finished: ..."。
const STATUS_LINE_RE = /(?:Status|Finished):\s*([A-Za-z][A-Za-z ]*)/iu

export interface NotarizeMacOptions {
  /** Application bundle to notarize and staple. */
  readonly appPath: string
  /** Environment supplying APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER
   * (or the Apple ID trio / APPLE_KEYCHAIN_PROFILE). */
  readonly env: NodeJS.ProcessEnv
  /** Bounded wait call length: each `notarytool wait` exits after this. */
  readonly waitTimeoutMs: number
  /** Idle interval between bounded wait calls while the status is still
   * "In Progress" (the wait call already consumed waitTimeoutMs). */
  readonly pollIntervalMs: number
  /** Hard deadline for the whole submit+wait+staple sequence. */
  readonly deadlineMs: number
  /** Per-command retries for transient failures (network, Apple 5xx). */
  readonly retries: number
  /** Backoff between per-command retries. */
  readonly backoffMs: number
  /** Optional file persisting the in-flight submission id so a later run
   * resumes the same submission instead of submitting again. */
  readonly resumeFilePath?: string
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

function readPersistedSubmission(
  resumeFilePath: string,
  appPath: string,
): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(resumeFilePath, 'utf8'))
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    if (record.appPath !== appPath || typeof record.submissionId !== 'string') return undefined
    const match = /^[0-9a-fA-F-]{8,}$/u.exec(record.submissionId)
    return match === null ? undefined : record.submissionId
  } catch {
    return undefined
  }
}

function persistSubmission(resumeFilePath: string, appPath: string, submissionId: string): void {
  writeFileSync(resumeFilePath, `${JSON.stringify({ appPath, submissionId }, null, 2)}\n`, { mode: 0o600 })
}

/** Parse the status out of a wait/info stdout block (Xcode-version tolerant). */
function parseWaitStatus(stdout: string): string {
  const line = STATUS_LINE_RE.exec(stdout)?.[1]?.trim() ?? ''
  if (line !== '') return line
  if (/\bAccepted\b/u.test(stdout)) return 'Accepted'
  if (/\bInvalid\b/u.test(stdout)) return 'Invalid'
  return ''
}

/**
 * Submit an application for notarization (unless a persisted submission
 * exists) and wait for the result with short bounded polls; staple the
 * ticket into the app. Re-running with the same `resumeFilePath` continues
 * waiting on the SAME submission after any transient failure.
 * @param options - Process and timing boundaries.
 */
export async function notarizeMacApp(options: NotarizeMacOptions): Promise<NotarizeMacResult> {
  const authArgs = credentialArgumentGroup(options.env)
  const deadlineAt = Date.now() + options.deadlineMs

  // 0) Resume support: the previous run already submitted this build and
  // persisted its id — Apple keeps processing regardless of our connectivity,
  // so continue polling the same submission instead of queuing another one.
  let submissionId = options.resumeFilePath === undefined
    ? ''
    : readPersistedSubmission(options.resumeFilePath, options.appPath) ?? ''
  if (submissionId !== '') {
    options.log(`resuming notarization submission ${submissionId} from ${options.resumeFilePath}`)
  }

  // notarytool only accepts zip/pkg/dmg archives — zip the app bundle first
  // (mirrors @electron/notarize: ditto -c -k --sequesterRsrc --keepParent).
  const workingDir = mkdtempSync(join(tmpdir(), 'dsh-notary-'))
  const zipPath = join(workingDir, `${basename(options.appPath)}.zip`)
  try {
    if (submissionId === '') {
      options.run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', basename(options.appPath), zipPath], dirname(options.appPath))
      options.log(`notarization payload prepared: ${zipPath}`)

      // 1) Submit without --wait: one short request, individually retried.
      const submitAttempts = options.retries
      let attempt = 0
      let stdout = ''
      while (attempt <= submitAttempts) {
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
          if (attempt > submitAttempts) throw error
          options.log(`notarytool submit failed (attempt ${attempt}); retrying in ${options.backoffMs}ms`)
          await options.sleep(options.backoffMs)
        }
      }
      if (options.resumeFilePath !== undefined) {
        persistSubmission(options.resumeFilePath, options.appPath, submissionId)
      }
    }
    options.log(`notarytool submission ${submissionId} submitted`)

    // 2) Bounded official wait polls; each call carries its own retries. A
    // poll that keeps failing (network drop, unparseable output) is treated
    // as transient: log it and keep polling until the deadline — the deadline
    // itself is the fail-loud boundary, not any single dropped connection.
    // The wait call exits non-zero on connection drops (Apple keeps working)
    // and exits 0 after --timeout with the status logged; both are safe.
    let status = ''
    while (Date.now() < deadlineAt) {
      let attempt = 0
      let lastFailure = ''
      while (attempt <= options.retries) {
        attempt += 1
        try {
          const seconds = Math.max(30, Math.round(options.waitTimeoutMs / 1000))
          const stdout = options.run('xcrun', [
            'notarytool', 'wait', submissionId, ...authArgs, '--timeout', String(seconds),
          ])
          status = parseWaitStatus(stdout)
          if (status !== '') break
          lastFailure = 'could not parse status from notarytool wait output'
          throw new Error(lastFailure)
        } catch (error) {
          if (attempt > options.retries) break
          lastFailure = error instanceof Error ? error.message : String(error)
          options.log(`notarytool wait failed (attempt ${attempt}); retrying in ${options.backoffMs}ms`)
          await options.sleep(options.backoffMs)
        }
      }
      if (status === '') {
        options.log(`notarytool wait gave up: ${lastFailure}; polling again in ${options.pollIntervalMs}ms`)
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
      // 保留 resume 文件:同 id 续等仍可能成功(Apple 队列慢/网络抖动)。
      throw new Error(`notarization submission ${submissionId} did not reach Accepted within ${options.deadlineMs}ms (last status: ${status || 'unknown'})`)
    }

    // 3) Staple the ticket into the app bundle and validate it. The resume
    // file is intentionally kept: downstream steps (DMG build + release
    // verification) may still fail, and the retry must resume this already
    // accepted submission instead of submitting the same build again. The
    // caller deletes the state file once the whole release is verified.
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
  const args = process.argv.slice(2)
  const appPath = args[0]
  if (appPath === undefined || appPath === '') {
    throw new Error('usage: notarize-mac.ts <application.app> [--resume-file <path>]')
  }
  const resumeArg = args.indexOf('--resume-file')
  return {
    appPath: resolve(appPath),
    env: process.env,
    waitTimeoutMs: 15 * 60_000,
    pollIntervalMs: 15_000,
    deadlineMs: 240 * 60_000,
    retries: 8,
    backoffMs: 10_000,
    ...(resumeArg === -1
      ? {}
      : { resumeFilePath: resolve(args[resumeArg + 1] ?? '') }),
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
