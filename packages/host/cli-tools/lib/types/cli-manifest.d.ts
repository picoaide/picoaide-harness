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
export type CliPlatform = 'darwin-x64' | 'darwin-arm64' | 'linux-x64' | 'linux-arm64' | 'win32-x64' | 'win32-arm64';
/** Map a Node platform/arch pair to the manifest naming scheme. */
export declare function cliPlatformKey(platform: NodeJS.Platform, arch: string): CliPlatform | null;
export interface NpmPackageSource {
    kind: 'npm-package';
    /** npm package name whose tarball carries the platform archives. */
    packageName: string;
    packageVersion: string;
    /** Archive file name (e.g. `dws-linux-amd64.tar.gz`) for the platform. */
    asset: (platform: CliPlatform) => string | null;
    /** Entry path of the platform archive inside the npm tarball. */
    innerPath: (asset: string) => string;
    /** sha256 of each platform archive (from the package's assets/checksums.txt). */
    checksums: Record<string, string>;
    /** Registries tried in order. */
    registries: string[];
}
export interface DirectSource {
    kind: 'direct';
    /** Direct per-platform archive URL. */
    url: (platform: CliPlatform) => string | null;
    /** sha256 of each platform archive (from the vendor's checksums.txt). */
    checksums: Record<string, string>;
}
export interface CliBinaryManifest {
    /** Logical command name used in connector defs (e.g. 'dws'). */
    command: string;
    /** Pinned version; also the cache directory key. */
    version: string;
    /** Native binary file name inside the extracted archive (`.exe` appended on win32). */
    binaryName: string;
    /** Human-readable name for progress/error messages. */
    displayName: string;
    /** License identifier for provenance (THIRD_PARTY_NOTICES). */
    license: string;
    source: NpmPackageSource | DirectSource;
}
/** Built-in manifests keyed by command name. */
export declare const CLI_MANIFESTS: ReadonlyMap<string, CliBinaryManifest>;
