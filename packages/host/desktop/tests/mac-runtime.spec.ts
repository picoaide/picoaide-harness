import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  MACOS_ARM64_NATIVE_ENTRIES,
  prepareMacArm64Runtime,
} from '../scripts/mac-runtime.ts'

describe('arm64 macOS native runtime preparation', () => {
  it('requires every arm64 native file and repairs the node-pty helper', () => {
    const chmod = vi.fn()
    const desktopRoot = resolve('/desktop')

    prepareMacArm64Runtime({ desktopRoot, exists: () => true, chmod })

    expect(chmod.mock.calls).toEqual([
      [join(desktopRoot, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper'), 0o755],
    ])
  })

  it('fails before changing permissions when one native file is missing', () => {
    const chmod = vi.fn()
    const desktopRoot = resolve('/desktop')
    const missing = MACOS_ARM64_NATIVE_ENTRIES.at(-1)!.path

    expect(() => prepareMacArm64Runtime({
      desktopRoot,
      exists: path => path !== join(desktopRoot, missing),
      chmod,
    })).toThrow(join(desktopRoot, missing))
    expect(chmod).not.toHaveBeenCalled()
  })
})
