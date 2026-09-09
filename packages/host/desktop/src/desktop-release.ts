/**
 * Single authority for the public GitHub release surface (P2-64).
 *
 * `update-checker.ts` and `update-download.ts` used to declare their own
 * `DESKTOP_RELEASE_REPOSITORY` / endpoint constants; two copies meant a
 * repository move could silently leave one path pointing at the old owner.
 * Both modules re-export `DESKTOP_RELEASE_REPOSITORY` from here so existing
 * importers keep working.
 * @module dsh-plugin-desktop/desktop-release
 */

/** GitHub repository owning public client releases. */
export const DESKTOP_RELEASE_REPOSITORY = 'picoaide/picoaide-harness'

/** Public endpoint returning the latest stable PicoAide Harness release. */
export const DESKTOP_RELEASE_LATEST_API =
  `https://api.github.com/repos/${DESKTOP_RELEASE_REPOSITORY}/releases/latest`

/** Public endpoint listing recent published releases (newest first). */
export const DESKTOP_RELEASE_LIST_API =
  `https://api.github.com/repos/${DESKTOP_RELEASE_REPOSITORY}/releases?per_page=30`

/** Prefix of the by-tag release endpoint used for prerelease installers. */
export const DESKTOP_RELEASE_TAG_API =
  `https://api.github.com/repos/${DESKTOP_RELEASE_REPOSITORY}/releases/tags/`
