import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
//#region src/user-scope.ts
/**
* Per-user scope resolution for the connectors plugin.
*
* The enterprise session is the product's single source of truth for "who is
* logged in" (`picoSession` service + `pico/session-changed` event).
* Connector credentials, CLI caches, and browser persistent partitions are
* scoped per logged-in user so A's tokens never leak into B's session.
*
* Namespace layout (everything under the DSH home):
*
*   <dshHome>/users/<encoded-username>/connectors/   credentials + cli cache
*
* The username segment is filesystem-safe encoded — a gateway account name
* may contain `/`, `..`, or OS-reserved characters, so it is never used raw.
*/
/** Environment variable that overrides the product home. */
const DSH_HOME_ENV = "DSH_HOME";
/** Directory name of the product default Harness home under the OS home. */
const PRODUCT_DSH_HOME_DIR = ".picoaide-harness";
/** Expand a leading ~ (or ~user) in a path, platform-style. */
function expandHomePath(path, home = homedir()) {
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
	return path;
}
/**
* Resolve the single-root product Harness home.
*
* Precedence, highest first: an explicit configured path, `$DSH_HOME`, then
* `~/.picoaide-harness`. Mirrors `dsh-plugin-desktop/desktop-home`
* (duplicated here to keep this module dependency-free for consumers that
* must not pull the desktop package at runtime).
*/
function resolveDshHome(configured, env = process.env, home = homedir()) {
	const fromEnv = env[DSH_HOME_ENV];
	return resolve(expandHomePath(configured ?? (fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : join(home, ".picoaide-harness")), home));
}
/** Join path segments onto the resolved product Harness home. */
function dshHomePath(...segments) {
	return join(resolveDshHome(), ...segments);
}
/** Resolve the product home from the live environment. */
function dshHome() {
	return resolveDshHome();
}
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
function encodeSegment(segment) {
	let out = "";
	for (const char of segment) {
		const code = char.codePointAt(0);
		if (code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || char === "-" || char === "_") out += char;
		else out += `~${code.toString(16).toUpperCase()}~`;
	}
	if (out.length === 0) return `~${randomUUID()}~`;
	return out;
}
/**
* Per-user scope path under the DSH home: `<dshHome>/users/<encoded-user>`.
* A `null`/empty username yields `users/<encoded-anonymous>` so unauthenticated
* state never collides with a real user's directory.
*/
function userScopePath(username, env = process.env) {
	const key = username !== void 0 && username !== null && username.length > 0 ? username : "anonymous";
	return join(resolveDshHome(void 0, env), "users", encodeSegment(key));
}
/**
* Environment for external CLI tools that persist credentials themselves
* (e.g. `dws` / `dingtalk-workspace-cli`).
*
* The dws CLI stores its runtime config in `~/.dws` and its encrypted
* keychain in `~/.local/share/dws-cli` by default. Both sit outside the
* product home, which (a) leaks auth state across products and (b) breaks in
* read-only / sandboxed homes where those directories cannot be created
* (the token write fails -> every `dws mcp url get` returns
* `business error: success=false`).
*
* Override both to live under the product DSH home (same resolver as every
* other product data directory): `$DWS_CONFIG_DIR` -> `<dshHome>` and
* `$DWS_KEYCHAIN_DIR` -> `<dshHome>/dws/keychain`.
*
* NOTE: `DWS_KEYCHAIN_DIR` is an undocumented dws knob (present in the dws
* binary; not listed by `dws config list`). It is set for completeness —
* dws falls back to `~/.local/share/dws-cli` on Linux without it — and is
* harmless when the CLI ignores it. Verify against the pinned binary in
* cli-manifest.ts (wiring lives in the connector defs).
*/
function dwsEnv(env = process.env) {
	const home = resolveDshHome(void 0, env);
	return {
		DWS_CONFIG_DIR: home,
		DWS_KEYCHAIN_DIR: join(home, "dws", "keychain")
	};
}
//#endregion
export { DSH_HOME_ENV, PRODUCT_DSH_HOME_DIR, dshHome, dshHomePath, dwsEnv, encodeSegment, expandHomePath, resolveDshHome, userScopePath };

//# sourceMappingURL=user-scope.js.map