/** Environment variable that overrides the product home. */
export declare const DSH_HOME_ENV = "DSH_HOME";
/** Directory name of the product default Harness home under the OS home. */
export declare const PRODUCT_DSH_HOME_DIR = ".picoaide-harness";
/** Expand a leading ~ (or ~user) in a path, platform-style. */
export declare function expandHomePath(path: string, home?: string): string;
/**
 * Resolve the single-root product Harness home.
 *
 * Precedence, highest first: an explicit configured path, `$DSH_HOME`, then
 * `~/.picoaide-harness`. Mirrors `dsh-plugin-desktop/desktop-home`
 * (duplicated here to keep this module dependency-free for consumers that
 * must not pull the desktop package at runtime).
 */
export declare function resolveDshHome(configured?: string, env?: Record<string, string | undefined>, home?: string): string;
/** Join path segments onto the resolved product Harness home. */
export declare function dshHomePath(...segments: string[]): string;
/** Resolve the product home from the live environment. */
export declare function dshHome(): string;
/**
 * Filesystem-safe encoding of a username for a directory segment. Hex-encodes
 * every byte outside [A-Za-z0-9_-]: dots are encoded too, so the result can
 * never be `.`, `..`, empty, hidden, or contain a separator — it always
 * resolves inside the users root even for hostile (or non-ASCII) account
 * names. The `~` escape introducer is unambiguous because `~` itself is
 * encoded (`~7E~`), so the output is injective (no two inputs collide).
 *
 * CROSS-PACKAGE CONSTRAINT (2026-08-22): `@picoaide/dsh-browser`
 * `encodePartitionSegment` (electron-adapter.ts) mirrors this encoding
 * byte-for-byte (kept separate because cross-package runtime imports are
 * forbidden). Never diverge; the empty-string fallback differs on purpose
 * (`~<uuid>~` here, `anonymous` there) and cannot collide because a
 * directory segment with `~` is never equal to the literal `anonymous`.
 */
export declare function encodeSegment(segment: string): string;
/**
 * Per-user scope path under the DSH home: `<dshHome>/users/<encoded-user>`.
 * A `null`/empty username yields `users/<encoded-anonymous>` so unauthenticated
 * state never collides with a real user's directory.
 */
export declare function userScopePath(username: string | null | undefined, env?: NodeJS.ProcessEnv): string;
