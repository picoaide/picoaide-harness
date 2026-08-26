import { join, resolve } from "node:path";
import { homedir } from "node:os";
//#region src/home.ts
/**
* Product home resolution for CLI tooling (mirrors desktop-home's contract:
* `$DSH_HOME` first, then `~/.picoaide-harness`). Kept dependency-free so the
* package can be consumed by skill-side installers without pulling the
* desktop package.
*/
/** Environment variable that overrides the product home. */
const DSH_HOME_ENV = "DSH_HOME";
/** Directory name of the product default Harness home under the OS home. */
const PRODUCT_DSH_HOME_DIR = ".picoaide-harness";
/** Resolve the product home (same precedence as desktop-home). */
function resolveDshHome(env = process.env, home = homedir()) {
	const fromEnv = env[DSH_HOME_ENV];
	const selected = fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : join(home, PRODUCT_DSH_HOME_DIR);
	return resolve(selected.startsWith("~/") ? join(home, selected.slice(2)) : selected);
}
/**
* Environment for external CLI tools that persist credentials themselves
* (e.g. `dws` / `dingtalk-workspace-cli`).
*
* The dws CLI stores its runtime config in `~/.dws` and its encrypted
* keychain in `~/.local/share/dws-cli` by default. Both sit outside the
* product home. Override both to live under the product DSH home:
* `$DWS_CONFIG_DIR` -> `<dshHome>`, `$DWS_KEYCHAIN_DIR` ->
* `<dshHome>/dws/keychain`.
*/
function dwsEnv(env = process.env) {
	const home = resolveDshHome(env);
	return {
		DWS_CONFIG_DIR: home,
		DWS_KEYCHAIN_DIR: join(home, "dws", "keychain")
	};
}
//#endregion
export { DSH_HOME_ENV, PRODUCT_DSH_HOME_DIR, dwsEnv, resolveDshHome };

//# sourceMappingURL=home.js.map