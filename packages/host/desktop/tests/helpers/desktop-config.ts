/**
 * Test fixtures for the desktop-shell plugin's **resolved** configuration.
 *
 * Upstream 0.1.7 turned the desktop's own user settings into volatile config
 * fields, so the object a plugin receives at runtime is not the plain document
 * shape: `port` and `logLevel` arrive as `Volatile` references (that is what
 * lets the settings form edit them without remounting the row). Tests that call
 * `apply()` directly must therefore build the runtime view, not a plain object.
 *
 * @module tests/helpers/desktop-config
 */

import { createVolatile } from '@deepseek-ai/cosmokit'
import type { Config as DesktopConfig, DesktopShellConfigDocument } from '../../src/index.ts'

/** Every plain (document) field of the desktop-shell config with its schema default. */
export const DESKTOP_SHELL_DEFAULTS: DesktopShellConfigDocument = {
  productName: 'PicoAide Harness',
  windowTitle: 'PicoAide Harness',
  port: 0,
  width: 1280,
  height: 840,
  minWidth: 900,
  minHeight: 640,
  logLevel: 'info',
}

/**
 * Build the resolved runtime config the Loader hands to `apply()`.
 * @param overrides - plain document fields to replace the defaults with.
 * @returns config whose volatile fields are references over detached snapshots.
 */
export function resolvedDesktopConfig(overrides: Partial<DesktopShellConfigDocument> = {}): DesktopConfig {
  const plain: DesktopShellConfigDocument = { ...DESKTOP_SHELL_DEFAULTS, ...overrides }
  return {
    productName: plain.productName,
    windowTitle: plain.windowTitle,
    width: plain.width,
    height: plain.height,
    minWidth: plain.minWidth,
    minHeight: plain.minHeight,
    port: createVolatile(plain.port),
    logLevel: createVolatile(plain.logLevel),
  }
}
