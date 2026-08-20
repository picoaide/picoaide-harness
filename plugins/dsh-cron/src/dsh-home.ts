/**
 * Product DSH home resolution for the cron plugin's Host half.
 *
 * The single authoritative source of the product home is
 * `dsh-plugin-desktop/src/desktop-home.ts` (exported as
 * `dsh-plugin-desktop/desktop-home`); this file is only a thin re-export so
 * the plugin never copies the default-directory constant. The contract
 * mirrors the official `@deepseek-ai/dsh-home-paths`: configured path >
 * `DSH_HOME` > product default (`~/.picoaide-harness`). The desktop launcher
 * also writes the product home back into `DSH_HOME` at startup, so in the
 * real product the environment path is what lands here anyway.
 */
export {
  DSH_HOME_ENV,
  PRODUCT_DSH_HOME_DIR,
  DEFAULT_DSH_HOME_DISPLAY,
  expandHomePath,
  resolveDshHome,
  dshHome,
  dshHomePath,
} from 'dsh-plugin-desktop/desktop-home'
