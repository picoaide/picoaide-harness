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
//#endregion
export { DSH_HOME_ENV, PRODUCT_DSH_HOME_DIR, dshHome, dshHomePath, encodeSegment, expandHomePath, resolveDshHome, userScopePath };

//# sourceMappingURL=user-scope.js.map