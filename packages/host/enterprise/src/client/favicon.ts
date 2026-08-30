/**
 * Desktop favicon replacement: the exact tray/app icon SVG
 * (`packages/host/desktop/build/tray-icon.svg` — black rounded square, white
 * brace mark, uniformly enlarged 1.25×; authority: repo-root `logo.svg`),
 * inlined as a data URI so no server static override is needed — the upstream
 * `/favicon.svg` (DeepSeek fish) is served by dsh-web-frontend and cannot be
 * patched from the desktop profile layer.
 *
 * The desktop assembly does not include `@picoaide/dsh-branding` (web-only),
 * so this module carries the favicon surface for the desktop client.
 */

const FAVICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1254" height="1254" viewBox="0 0 1254 1254">
  <rect x="0" y="0" width="1254" height="1254" rx="180" fill="#000000"/>
  <g transform="translate(627 627) scale(1.25) translate(-627 -627)">
    <path d="M 334 409 C 300 409 273 431 273 466 V 548 C 273 582 254 607 220 620 C 254 633 273 658 273 692 V 775 C 273 810 300 843 334 843" fill="none" stroke="#FFFFFF" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M 920 409 C 954 409 981 431 981 466 V 548 C 981 582 1000 607 1034 620 C 1000 633 981 658 981 692 V 775 C 981 810 954 843 920 843" fill="none" stroke="#FFFFFF" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>
    <line x1="435" y1="627" x2="817" y2="627" stroke="#FFFFFF" stroke-width="20" stroke-linecap="round"/>
    <circle cx="435" cy="627" r="65" fill="#FFFFFF"/>
    <circle cx="817" cy="627" r="65" fill="#FFFFFF"/>
  </g>
</svg>`

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
