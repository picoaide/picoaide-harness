/**
 * Pinned download manifests for connector CLI tools (download-on-demand).
 *
 * The connector framework never ships third-party binaries in the repo.
 * Instead, when a `cli` connector is first connected and its command is not
 * already on PATH, the runtime fetches the official platform archive, verifies
 * it against the sha256 pinned here, extracts the native binary into the user
 * cache dir and spawns it. The archives are therefore NOT executed directly
 * from the network — only their verified contents ever run.
 *
 * Sources are the official npm registry / vendor CDN only. For the dws npm
 * tarball the registry can be mirrored (see `PICOAIDE_CONNECTORS_NPM_MIRROR`);
 * the inner platform archive is still checksum-pinned, so a tampered mirror
 * cannot smuggle a different binary.
 *
 * Version bumps require updating the checksums below from the vendor's
 * checksums.txt — a mismatch is a hard failure at runtime, by design.
 */

export type CliPlatform = 'darwin-x64' | 'darwin-arm64' | 'linux-x64' | 'linux-arm64' | 'win32-x64' | 'win32-arm64'

/** Map a Node platform/arch pair to the manifest naming scheme. */
export function cliPlatformKey(platform: NodeJS.Platform, arch: string): CliPlatform | null {
  switch (`${platform}-${arch}`) {
    case 'darwin-x64': return 'darwin-x64'
    case 'darwin-arm64': return 'darwin-arm64'
    case 'linux-x64': return 'linux-x64'
    case 'linux-arm64': return 'linux-arm64'
    case 'win32-x64': return 'win32-x64'
    case 'win32-arm64': return 'win32-arm64'
    default: return null
  }
}

export interface NpmPackageSource {
  kind: 'npm-package'
  /** npm package name whose tarball carries the platform archives. */
  packageName: string
  packageVersion: string
  /** Archive file name (e.g. `dws-linux-amd64.tar.gz`) for the platform. */
  asset: (platform: CliPlatform) => string | null
  /** Entry path of the platform archive inside the npm tarball. */
  innerPath: (asset: string) => string
  /** sha256 of each platform archive (from the package's assets/checksums.txt). */
  checksums: Record<string, string>
  /** Registries tried in order. */
  registries: string[]
}

export interface DirectSource {
  kind: 'direct'
  /** Direct per-platform archive URL. */
  url: (platform: CliPlatform) => string | null
  /** sha256 of each platform archive (from the vendor's checksums.txt). */
  checksums: Record<string, string>
}

export interface CliBinaryManifest {
  /** Logical command name used in connector defs (e.g. 'dws'). */
  command: string
  /** Pinned version; also the cache directory key. */
  version: string
  /** Native binary file name inside the extracted archive (`.exe` appended on win32). */
  binaryName: string
  /** Human-readable name for progress/error messages. */
  displayName: string
  /** License identifier for provenance (THIRD_PARTY_NOTICES). */
  license: string
  source: NpmPackageSource | DirectSource
}

/** sha256 of dws platform archives, from dingtalk-workspace-cli@1.0.59 `assets/checksums.txt`. */
const DWS_CHECKSUMS: Record<string, string> = {
  'dws-linux-amd64.tar.gz': 'be1eb9a1f8fc5048e578b5b0bde212fc90baca0f289236c7c333d824bd869cf3',
  'dws-linux-arm64.tar.gz': '5bfe9ac7d1798b028f0fad579bbdffec5898e2fb16ee36f5766ab58e208abd50',
  'dws-windows-amd64.zip': '5393a0d5e00c70b58833c60610ad3a772926ca5e4eb38c360928e3d2552451bc',
  'dws-windows-arm64.zip': '8c1a8eaa527a56197fd1a26d21b0f6c8b8b0e2270d1ad4c1d97519f4cab0f094',
  'dws-darwin-amd64.tar.gz': 'fd14b0b1a1475891fb243bf6453857a1044ab5a40bcf7dc1c7c795f57e5b03ba',
  'dws-darwin-arm64.tar.gz': '61135a2a9286204ce060847e653c63c1e9784a0fa631bb7e0563b90628762a35',
}

const DWS_PLATFORM_ASSET: Record<CliPlatform, string> = {
  'darwin-x64': 'dws-darwin-amd64.tar.gz',
  'darwin-arm64': 'dws-darwin-arm64.tar.gz',
  'linux-x64': 'dws-linux-amd64.tar.gz',
  'linux-arm64': 'dws-linux-arm64.tar.gz',
  'win32-x64': 'dws-windows-amd64.zip',
  'win32-arm64': 'dws-windows-arm64.zip',
}

/** sha256 of beisen platform archives, from beisen-cli@1.0.5 `checksums.txt`. */
const BEISEN_CHECKSUMS: Record<string, string> = {
  'beisen-cli-v1.0.5-linux-amd64.tar.gz': '60c14546901dac928ffb278f4ff54803634d360cd21a1814c87b213ac8918277',
  'beisen-cli-v1.0.5-linux-arm64.tar.gz': '035539a6a62a82b4ad260e4321320239562d461d77cd70cf2a20ebe223f74d66',
  'beisen-cli-v1.0.5-windows-amd64.zip': '55bb67e429fd1f22b7299846d6f9d0698dcaad4e339c892c76e09965b97fa80d',
  'beisen-cli-v1.0.5-windows-arm64.zip': 'd1543df15296cab6b640d7a528c6597271e8b4be9fd309e983e91c1065ccace2',
  'beisen-cli-v1.0.5-darwin-amd64.tar.gz': 'db623686476cc7273fa40126c89002a35a4b2e2d93e102195e6b65a1e851df7b',
  'beisen-cli-v1.0.5-darwin-arm64.tar.gz': '1a909801814be54f581bcc737bff62189c340f4eac97b3fb7ad52398765d7a71',
}

const BEISEN_PLATFORM_URL: Record<CliPlatform, string> = {
  'darwin-x64': 'https://senclaw-cdn.italent.cn/cli/beisen-cli-v1.0.5-darwin-amd64.tar.gz',
  'darwin-arm64': 'https://senclaw-cdn.italent.cn/cli/beisen-cli-v1.0.5-darwin-arm64.tar.gz',
  'linux-x64': 'https://senclaw-cdn.italent.cn/cli/beisen-cli-v1.0.5-linux-amd64.tar.gz',
  'linux-arm64': 'https://senclaw-cdn.italent.cn/cli/beisen-cli-v1.0.5-linux-arm64.tar.gz',
  'win32-x64': 'https://senclaw-cdn.italent.cn/cli/beisen-cli-v1.0.5-windows-amd64.zip',
  'win32-arm64': 'https://senclaw-cdn.italent.cn/cli/beisen-cli-v1.0.5-windows-arm64.zip',
}

/**
 * dingtalk-workspace-cli ships every platform binary inside its npm tarball
 * (`assets/dws-<platform>-<arch>.tar.gz|zip`); the `dws` launcher script and
 * its skills installer are intentionally NOT used (see README of the package:
 * `dws skill setup` installs agent skills on demand and is a separate,
 * opt-in workflow — the connector auth/MCP path only needs the binary).
 */
const DWS_MANIFEST: CliBinaryManifest = {
  command: 'dws',
  version: '1.0.59',
  binaryName: 'dws',
  displayName: '钉钉 dws（DingTalk Workspace CLI）',
  license: 'Apache-2.0',
  source: {
    kind: 'npm-package',
    packageName: 'dingtalk-workspace-cli',
    packageVersion: '1.0.59',
    asset: (platform) => DWS_PLATFORM_ASSET[platform] ?? null,
    innerPath: (asset) => `package/assets/${asset}`,
    checksums: DWS_CHECKSUMS,
    // npmmirror first (fast in CN enterprise networks), official registry as
    // fallback; overridable for air-gapped/mirror deployments. Integrity is
    // still guaranteed by the pinned sha256 of the inner platform archive.
    registries: [
      process.env.PICOAIDE_CONNECTORS_NPM_MIRROR?.trim() || 'https://registry.npmmirror.com',
      'https://registry.npmjs.org',
    ],
  },
}

/**
 * beisen-cli's npm package downloads the native binary at install time from
 * the vendor CDN; the connector runtime does the same fetch itself, pinned to
 * the checksums published in the package's `checksums.txt`.
 * NOTE: the package declares `UNLICENSED` — redistributing the fetched binary
 * follows the enterprise agreement with Beisen; see THIRD_PARTY_NOTICES.md.
 */
const BEISEN_MANIFEST: CliBinaryManifest = {
  command: 'beisen-cli',
  version: '1.0.5',
  binaryName: 'beisen-cli',
  displayName: '北森 beisen-cli（北森AI · HR专家）',
  license: 'UNLICENSED',
  source: {
    kind: 'direct',
    url: (platform) => BEISEN_PLATFORM_URL[platform] ?? null,
    checksums: BEISEN_CHECKSUMS,
  },
}

/** Built-in manifests keyed by command name. */
export const CLI_MANIFESTS: ReadonlyMap<string, CliBinaryManifest> = new Map([
  [DWS_MANIFEST.command, DWS_MANIFEST],
  [BEISEN_MANIFEST.command, BEISEN_MANIFEST],
])
