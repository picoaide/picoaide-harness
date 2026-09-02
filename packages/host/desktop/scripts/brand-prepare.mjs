/**
 * Brand prepare: derive every desktop build icon from the single brand folder.
 *
 *   brands/official/ (authority, committed)
 *     ├─ logo.svg         → generate-tray-icons   → build/tray-icon*.png
 *     ├─ logo-dark.svg    → (dark theme surface; not rasterized here)
 *     ├─ app-icon.png     → build/app-icon.png (win/linux icon + mac pipeline)
 *     │                   → generate-mac-app-icon → build/app-icon-mac.png
 *     └─ brand.json       → validated; later consumed at runtime/build-config
 *
 * Output under packages/host/desktop/build/ is derived and never committed
 * (see root .gitignore). Run via `yarn workspace dsh-plugin-desktop build`.
 */

import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateMacAppIcon } from './generate-mac-app-icon.mjs'
import { generateTrayIcons } from './generate-tray-icons.mjs'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const repoRoot = resolve(packageRoot, '..', '..', '..')
const brandRoot = join(repoRoot, 'brands', 'official')
const buildRoot = join(packageRoot, 'build')

/** Brand folder entries that must exist before deriving. */
const REQUIRED_ASSETS = ['logo.svg', 'logo-dark.svg', 'app-icon.png', 'brand.json', 'assistedMessages.yml']

/**
 * Validate the brand folder, then derive every build-time icon.
 * @returns {Promise<string[]>} derived output files (relative to build/).
 */
export async function prepareBrandAssets({ brandDir = brandRoot, outputDir = buildRoot } = {}) {
  await mkdir(outputDir, { recursive: true })

  for (const asset of REQUIRED_ASSETS) {
    await readFile(join(brandDir, asset))
  }

  // brand.json must parse and carry the official schema marker.
  const brand = JSON.parse(await readFile(join(brandDir, 'brand.json'), 'utf8'))
  if (brand.schema !== 1 || !brand.channel_id || !brand.assets) {
    throw new Error('brand-prepare: brand.json schema 1 with channel_id/assets is required')
  }

  // Win/Linux application icon (also the mac icon pipeline source).
  await copyFile(join(brandDir, 'app-icon.png'), join(outputDir, 'app-icon.png'))

  // NSIS assisted installer messages (electron-builder reads buildResources).
  await copyFile(join(brandDir, 'assistedMessages.yml'), join(outputDir, 'assistedMessages.yml'))

  // macOS Dock icon (824/1024 safe-area), generated from the same app icon.
  await generateMacAppIcon(
    join(brandDir, 'app-icon.png'),
    join(outputDir, 'app-icon-mac.png'),
  )

  // Tray bitmaps (mac template + fixed-color windows/linux).
  const trayFiles = await generateTrayIcons({ source: join(brandDir, 'logo.svg'), buildRoot: outputDir })

  return ['app-icon.png', 'app-icon-mac.png', 'assistedMessages.yml', ...trayFiles]
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  const outputs = await prepareBrandAssets()
  console.log('brand-prepare: brand folder brands/official → build/')
  for (const file of outputs) console.log(`  ✓ ${file}`)
}
