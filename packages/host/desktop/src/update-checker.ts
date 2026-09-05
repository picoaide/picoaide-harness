/** Headless version checks against the public GitHub Releases API. */

/** GitHub repository owning public client releases. */
export const DESKTOP_RELEASE_REPOSITORY = 'picoaide/picoaide-harness'

/** Public endpoint returning the latest stable PicoAide Harness release. */
export const DESKTOP_VERSION_ENDPOINT =
  `https://api.github.com/repos/${DESKTOP_RELEASE_REPOSITORY}/releases/latest`

/**
 * Public endpoint listing recent published releases (newest first) for the
 * test channel. The test channel compares every published release — stable
 * and prerelease — and offers the SemVer-maximum one, so a prerelease build
 * tracks newer prereleases of the same line and any newer stable release.
 */
export const DESKTOP_RELEASES_LIST_ENDPOINT =
  `https://api.github.com/repos/${DESKTOP_RELEASE_REPOSITORY}/releases?per_page=30`

/** Maximum response body bytes accepted from the release service. */
export const MAX_VERSION_RESPONSE_BYTES = 256 * 1024

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

/** Fetch-compatible request function used by the headless checker. */
export type UpdateRequest = (url: string, init: RequestInit) => Promise<Response>

/** Inputs for one channel version check. */
export interface UpdateCheckOptions {
  /** Installed application version, expressed as canonical SemVer. */
  readonly currentVersion: string
  /** Caller-owned cancellation signal; the checker does not create its own timeout. */
  readonly signal?: AbortSignal
  /** Optional fetch implementation for a host adapter or test. */
  readonly request?: UpdateRequest
}

/** Successful comparison returned by the channel version service. */
export type UpdateCheckResult = {
  /** Whether the service reports a version newer than the installed application. */
  readonly status: 'up-to-date' | 'update-available'
  /** Canonical installed version. */
  readonly currentVersion: string
  /** Canonical newest version reported by the selected channel service. */
  readonly latestVersion: string
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
 * Check the fixed GitHub Releases endpoint for a newer stable release.
 * @param options - installed version, caller-owned signal, and optional request adapter.
 * @returns a successful comparison, or null when any request or validation step fails.
 */
export async function checkForStableUpdate(
  options: UpdateCheckOptions,
): Promise<UpdateCheckResult | null> {
  const current = parseCanonicalStableVersion(options.currentVersion)
  if (current === null) return null
  const latest = await fetchLatestReleasedVersion(
    DESKTOP_VERSION_ENDPOINT,
    options.request ?? defaultRequest,
    options.signal,
    parseStableReleaseTag,
  )
  if (latest === null) return null
  return {
    status: compareParsedSemVer(latest, current) > 0 ? 'update-available' : 'up-to-date',
    currentVersion: current.version,
    latestVersion: latest.version,
  }
}

/**
 * Check the update channel implied by the installed version: stable builds
 * query the latest-stable endpoint (prerelease releases are never offered),
 * while prerelease builds query the published-release list and are offered
 * the SemVer-maximum release — newer prereleases of the same line first, and
 * a newer stable release once one ships.
 * @param options - installed version, caller-owned signal, and optional request adapter.
 * @returns a successful channel comparison, or null when any step fails.
 */
export async function checkForChannelUpdate(
  options: UpdateCheckOptions,
): Promise<UpdateCheckResult | null> {
  const parsed = parseSemVer(options.currentVersion)
  if (parsed === null || parsed.version !== options.currentVersion) return null
  return parsed.prerelease.length > 0
    ? checkForTestChannelUpdate(options)
    : checkForStableUpdate(options)
}

/**
 * Check the test channel: the newest published release of any kind
 * (prerelease or stable) that outranks the installed prerelease version.
 * @param options - installed prerelease version, caller-owned signal, and optional request adapter.
 * @returns a successful comparison, or null when any request or validation step fails.
 */
export async function checkForTestChannelUpdate(
  options: UpdateCheckOptions,
): Promise<UpdateCheckResult | null> {
  const current = parseSemVer(options.currentVersion)
  if (current === null || current.version !== options.currentVersion || current.prerelease.length === 0) {
    return null
  }
  const latest = await fetchLatestReleasedVersion(
    DESKTOP_RELEASES_LIST_ENDPOINT,
    options.request ?? defaultRequest,
    options.signal,
    parseReleaseListBestTag,
  )
  if (latest === null) return null
  return {
    status: compareParsedSemVer(latest, current) > 0 ? 'update-available' : 'up-to-date',
    currentVersion: current.version,
    latestVersion: latest.version,
  }
}

/**
 * Request one version document and select its newest released version.
 * @param url - fixed endpoint returning one release object or a release array.
 * @param request - fetch-compatible boundary.
 * @param signal - caller-owned cancellation.
 * @param select - parser turning the bounded response body into the newest version.
 * @returns the newest released version, or null on any request/validation failure.
 */
async function fetchLatestReleasedVersion(
  url: string,
  request: UpdateRequest,
  signal: AbortSignal | undefined,
  select: (body: string) => ParsedSemVer | null,
): Promise<ParsedSemVer | null> {
  const init: RequestInit = {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    redirect: 'error',
    ...(signal === undefined ? {} : { signal }),
  }

  let response: Response
  try {
    response = await request(url, init)
  } catch {
    return null
  }
  if (response.status !== 200) return null

  let body: string
  try {
    body = await readLimitedBody(response)
  } catch {
    return null
  }
  return select(body)
}

async function defaultRequest(url: string, init: RequestInit): Promise<Response> {
  return globalThis.fetch(url, init)
}

async function readLimitedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null
    && /^[0-9]+$/u.test(declaredLength)
    && BigInt(declaredLength) > BigInt(MAX_VERSION_RESPONSE_BYTES)) {
    throw new Error('version response is too large')
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
      if (bytesRead > MAX_VERSION_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('version response is too large')
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    return body + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function parseStableReleaseTag(body: string): ParsedSemVer | null {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  // GitHub's release payload exposes the canonical version as a `v`-prefixed
  // tag while drafts and prereleases are strictly excluded by the latest
  // endpoint. The tag prefix is stripped before strict SemVer validation.
  if (!isRecord(value) || typeof value.tag_name !== 'string') return null
  return parseCanonicalStableVersion(value.tag_name.replace(/^v/u, ''))
}

/**
 * Select the SemVer-maximum published release from a release-list response.
 * Drafts never count; entries whose tag is absent or not strict SemVer are
 * ignored. Equal tags collapse to the first occurrence.
 * @param body - JSON release-list response body.
 * @returns the newest released version, or null when no entry qualifies.
 */
function parseReleaseListBestTag(body: string): ParsedSemVer | null {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    return null
  }
  if (!Array.isArray(value)) return null

  let best: ParsedSemVer | null = null
  const seenTags = new Set<string>()
  for (const entry of value) {
    if (!isRecord(entry) || entry.draft === true || typeof entry.tag_name !== 'string') continue
    const tag = entry.tag_name.replace(/^v/u, '')
    if (seenTags.has(tag)) continue
    seenTags.add(tag)
    const parsed = parseSemVer(tag)
    if (parsed === null || parsed.version !== tag) continue
    if (best === null || compareParsedSemVer(parsed, best) > 0) best = parsed
  }
  return best
}

function parseCanonicalStableVersion(input: string): ParsedSemVer | null {
  const parsed = parseSemVer(input)
  return parsed !== null && parsed.prerelease.length === 0 && parsed.version === input
    ? parsed
    : null
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
