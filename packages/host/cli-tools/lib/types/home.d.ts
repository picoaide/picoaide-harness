/** Environment variable that overrides the product home. */
export declare const DSH_HOME_ENV = "DSH_HOME";
/** Directory name of the product default Harness home under the OS home. */
export declare const PRODUCT_DSH_HOME_DIR = ".picoaide-harness";
/** Resolve the product home (same precedence as desktop-home). */
export declare function resolveDshHome(env?: NodeJS.ProcessEnv, home?: string): string;
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
export declare function dwsEnv(env?: NodeJS.ProcessEnv): Record<string, string>;
