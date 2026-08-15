/** Headless update checks against the stable DSH Desktop GitHub release. */

/** GitHub endpoint that resolves only the repository's latest non-prerelease release. */
export const STABLE_RELEASE_ENDPOINT =
  'https://api.github.com/repos/anywhere-labs/deepseek-harness-desktop/releases/latest'

/** Maximum response body bytes accepted from GitHub. */
export const MAX_RELEASE_RESPONSE_BYTES = 64 * 1024

/** Why an update check was initiated. */
export type UpdateCheckTrigger = 'background' | 'manual'

/** Stable error categories exposed to update-check callers. */
export type UpdateCheckErrorCode =
  | 'aborted'
  | 'http-status'
  | 'invalid-current-version'
  | 'invalid-response'
  | 'network'
  | 'response-too-large'
  | 'unstable-release'

/** Strictly parsed SemVer components. Numeric components remain strings to avoid overflow. */
export interface ParsedSemVer {
  /** Canonical version without the optional leading `v`. */
  readonly version: string
  /** Major numeric identifier. */
  readonly major: string
  /** Minor numeric identifier. */
  readonly minor: string
  /** Patch numeric identifier. */
  readonly patch: string
  /** Ordered prerelease identifiers, or an empty list for a stable version. */
  readonly prerelease: readonly string[]
  /** Build identifiers, ignored for version precedence. */
  readonly build: readonly string[]
}

/** Validated stable release fields returned by GitHub. */
export interface StableRelease {
  /** Exact Git tag returned by GitHub. */
  readonly tagName: string
  /** Canonical SemVer without the optional leading `v`. */
  readonly version: string
  /** Exact repository release page for `tagName`. */
  readonly htmlUrl: string
}

/** Fetch-compatible request function used by the headless checker. */
export type UpdateRequest = (url: string, init: RequestInit) => Promise<Response>

/** Inputs for one stable release check. */
export interface UpdateCheckOptions {
  /** Installed application version, expressed as strict SemVer. */
  readonly currentVersion: string
  /** Whether the caller is an interactive or scheduled check. */
  readonly trigger: UpdateCheckTrigger
  /** Cached GitHub ETag sent through `If-None-Match`. */
  readonly etag?: string
  /** Caller-owned cancellation signal; the checker does not create its own timeout. */
  readonly signal?: AbortSignal
  /** Optional fetch implementation for a host adapter or test. */
  readonly request?: UpdateRequest
}

/** Result of a stable release check. */
export type UpdateCheckResult =
  | {
    readonly status: 'not-modified'
    readonly etag?: string
  }
  | {
    readonly status: 'up-to-date' | 'update-available'
    readonly currentVersion: string
    readonly release: StableRelease
    readonly etag?: string
  }

/** Typed update failure carrying enough context for manual and background handling. */
export class UpdateCheckError extends Error {
  /** Stable programmatic failure category. */
  readonly code: UpdateCheckErrorCode
  /** Trigger retained so scheduled checks can remain non-disruptive. */
  readonly trigger: UpdateCheckTrigger
  /** HTTP status for `http-status`, otherwise undefined. */
  readonly status: number | undefined
  /** Whether an interactive caller should present the failure to the user. */
  readonly shouldNotifyUser: boolean

  /**
   * Create a typed update-check failure.
   * @param code - stable failure category.
   * @param trigger - initiating check kind.
   * @param message - safe diagnostic text.
   * @param options - optional HTTP status and underlying failure.
   */
  constructor(
    code: UpdateCheckErrorCode,
    trigger: UpdateCheckTrigger,
    message: string,
    options: { readonly status?: number; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'UpdateCheckError'
    this.code = code
    this.trigger = trigger
    this.status = options.status
    this.shouldNotifyUser = trigger === 'manual'
  }
}

const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u

/**
 * Parse strict SemVer with an optional lowercase `v` prefix.
 * @param input - complete version or release tag.
 * @returns parsed identifiers, or null when the input is not valid SemVer.
 */
export function parseSemVer(input: string): ParsedSemVer | null {
  const version = input.startsWith('v') ? input.slice(1) : input
  const match = SEMVER_PATTERN.exec(version)
  if (match === null) return null

  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some(identifier => isNumeric(identifier) && hasLeadingZero(identifier))) return null

  return {
    version,
    major: match[1]!,
    minor: match[2]!,
    patch: match[3]!,
    prerelease,
    build: match[5]?.split('.') ?? [],
  }
}

/**
 * Validate a stable release tag and its exact fixed-repository page.
 * @param tagName - Git tag with optional lowercase `v` SemVer prefix.
 * @param htmlUrl - exact GitHub release page for `tagName`.
 * @returns normalized stable release, or null for an invalid, prerelease, or foreign URL.
 */
export function parseStableRelease(tagName: string, htmlUrl: string): StableRelease | null {
  const version = parseSemVer(tagName)
  if (version === null || version.prerelease.length > 0) return null
  const expectedUrl =
    `https://github.com/anywhere-labs/deepseek-harness-desktop/releases/tag/${encodeURIComponent(tagName)}`
  if (htmlUrl !== expectedUrl) return null
  return { tagName, version: version.version, htmlUrl }
}

/**
 * Compare two strict SemVer strings without numeric overflow.
 * @param left - first strict SemVer value.
 * @param right - second strict SemVer value.
 * @returns negative, zero, or positive precedence, or null when either value is invalid.
 */
export function compareSemVerVersions(left: string, right: string): number | null {
  const leftVersion = parseSemVer(left)
  const rightVersion = parseSemVer(right)
  if (leftVersion === null || rightVersion === null) return null
  return compareParsedSemVer(leftVersion, rightVersion)
}

/**
 * Check the fixed DSH Desktop GitHub endpoint for a newer stable release.
 * @param options - installed version, trigger, cache token, and caller-owned signal.
 * @returns cache status or the validated stable release comparison.
 * @throws {UpdateCheckError} for transport, HTTP, size, or response validation failures.
 */
export async function checkForStableUpdate(options: UpdateCheckOptions): Promise<UpdateCheckResult> {
  const current = parseSemVer(options.currentVersion)
  if (current === null) {
    throw new UpdateCheckError(
      'invalid-current-version',
      options.trigger,
      'The installed application version is not valid SemVer.',
    )
  }

  const headers = new Headers({
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  })
  if (options.etag !== undefined) headers.set('If-None-Match', options.etag)

  const init: RequestInit = {
    method: 'GET',
    headers,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  const request = options.request ?? defaultRequest

  let response: Response
  try {
    response = await request(STABLE_RELEASE_ENDPOINT, init)
  } catch (cause) {
    const aborted = options.signal?.aborted === true || isAbortFailure(cause)
    throw new UpdateCheckError(
      aborted ? 'aborted' : 'network',
      options.trigger,
      aborted ? 'The update check was cancelled.' : 'The update service could not be reached.',
      { cause },
    )
  }

  if (response.status === 304) {
    const etag = response.headers.get('etag') ?? options.etag
    return etag === undefined ? { status: 'not-modified' } : { status: 'not-modified', etag }
  }
  if (response.status !== 200) {
    throw new UpdateCheckError(
      'http-status',
      options.trigger,
      `The update service returned HTTP ${response.status}.`,
      { status: response.status },
    )
  }

  let body: string
  try {
    body = await readLimitedBody(response, options.trigger)
  } catch (cause) {
    if (cause instanceof UpdateCheckError) throw cause
    const aborted = options.signal?.aborted === true || isAbortFailure(cause)
    throw new UpdateCheckError(
      aborted ? 'aborted' : 'invalid-response',
      options.trigger,
      aborted ? 'The update check was cancelled.' : 'The update response body could not be read.',
      { cause },
    )
  }

  const release = parseLatestReleaseResponse(body, options.trigger)
  const latest = parseSemVer(release.tagName)!
  const status = compareParsedSemVer(latest, current) > 0 ? 'update-available' : 'up-to-date'
  const result = {
    status,
    currentVersion: current.version,
    release,
  } as const
  const etag = response.headers.get('etag')
  return etag === null ? result : { ...result, etag }
}

async function defaultRequest(url: string, init: RequestInit): Promise<Response> {
  return globalThis.fetch(url, init)
}

async function readLimitedBody(response: Response, trigger: UpdateCheckTrigger): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null
    && /^[0-9]+$/u.test(declaredLength)
    && BigInt(declaredLength) > BigInt(MAX_RELEASE_RESPONSE_BYTES)) {
    throw responseTooLarge(trigger)
  }

  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytesRead = 0
  let body = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytesRead += chunk.value.byteLength
      if (bytesRead > MAX_RELEASE_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw responseTooLarge(trigger)
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    return body + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function parseLatestReleaseResponse(body: string, trigger: UpdateCheckTrigger): StableRelease {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch (cause) {
    throw new UpdateCheckError(
      'invalid-response',
      trigger,
      'The update response is not valid JSON.',
      { cause },
    )
  }

  if (!isRecord(value)
    || typeof value.tag_name !== 'string'
    || typeof value.draft !== 'boolean'
    || typeof value.prerelease !== 'boolean'
    || typeof value.html_url !== 'string') {
    throw new UpdateCheckError(
      'invalid-response',
      trigger,
      'The update response does not contain the required GitHub release fields.',
    )
  }
  if (value.draft || value.prerelease) {
    throw new UpdateCheckError(
      'unstable-release',
      trigger,
      'The GitHub latest endpoint returned a draft or prerelease.',
    )
  }

  const version = parseSemVer(value.tag_name)
  if (version === null) {
    throw new UpdateCheckError(
      'invalid-response',
      trigger,
      'The GitHub release tag is not valid SemVer.',
    )
  }
  if (version.prerelease.length > 0) {
    throw new UpdateCheckError(
      'unstable-release',
      trigger,
      'The GitHub latest endpoint returned a prerelease tag.',
    )
  }

  const release = parseStableRelease(value.tag_name, value.html_url)
  if (release === null) {
    throw new UpdateCheckError(
      'invalid-response',
      trigger,
      'The GitHub release URL does not match the fixed DSH Desktop repository and tag.',
    )
  }

  return release
}

function compareParsedSemVer(left: ParsedSemVer, right: ParsedSemVer): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    const comparison = compareNumeric(left[key], right[key])
    if (comparison !== 0) return comparison
  }
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1
  if (right.prerelease.length === 0) return -1

  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index]
    const rightIdentifier = right.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1
    if (leftIdentifier === rightIdentifier) continue

    const leftNumeric = isNumeric(leftIdentifier)
    const rightNumeric = isNumeric(rightIdentifier)
    if (leftNumeric && rightNumeric) return compareNumeric(leftIdentifier, rightIdentifier)
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

function compareNumeric(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

function isNumeric(identifier: string): boolean {
  return /^[0-9]+$/u.test(identifier)
}

function hasLeadingZero(identifier: string): boolean {
  return identifier.length > 1 && identifier.startsWith('0')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAbortFailure(value: unknown): boolean {
  return isRecord(value) && value.name === 'AbortError'
}

function responseTooLarge(trigger: UpdateCheckTrigger): UpdateCheckError {
  return new UpdateCheckError(
    'response-too-large',
    trigger,
    `The update response exceeds ${MAX_RELEASE_RESPONSE_BYTES} bytes.`,
  )
}
