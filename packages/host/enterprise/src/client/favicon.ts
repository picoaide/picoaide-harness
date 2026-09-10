/**
 * Desktop favicon replacement: the exact brand mark (`brands/official/logo.svg` —
 * black rounded square, white brace mark, uniformly enlarged 1.25×; single
 * brand authority), inlined as a data URI so no server static override is
 * needed — the upstream
 * `/favicon.svg` (DeepSeek fish) is served by dsh-web-frontend and cannot be
 * patched from the desktop profile layer.
 *
 * The desktop assembly does not include `@picoaide/dsh-branding` (web-only),
 * so this module carries the favicon surface for the desktop client.
 */

import { brandTileSvg } from '../channel-geometry.ts'

const FAVICON_SVG = brandTileSvg()

/** Replace the upstream fish favicon with the brace mark. */
export function installFavicon(): void {
  const href = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')) {
    link.href = href
  }
  // Some shells read the manifest icon; keep the touch-icon path simple.
  const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
  if (manifest !== null) {
    fetch(manifest.href)
      .then(res => res.json())
      .then((data: { icons?: { src?: string }[] }) => {
        if (Array.isArray(data.icons)) data.icons.forEach(icon => { icon.src = href })
      })
      .catch(() => { /* favicon replacement is best-effort */ })
  }
}
