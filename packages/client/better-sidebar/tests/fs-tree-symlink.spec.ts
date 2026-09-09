/**
 * P2-25 regression: the sidebar's path fence must resolve symlinks. A link
 * inside the workspace pointing outside it used to pass the lexical
 * `isWithin` check, letting the read/write/media routes touch files outside
 * the session working directory.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isWithin, isWithinReal } from '../src/fs-tree.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function workspace(): Promise<{ root: string; outside: string }> {
  const base = await mkdtemp(join(tmpdir(), 'sidebar-scope-'))
  cleanups.push(async () => { await rm(base, { recursive: true, force: true }) })
  const root = join(base, 'workspace')
  const outside = join(base, 'outside')
  await mkdir(root, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'secret.txt'), 'top secret\n')
  return { root, outside }
}

describe('isWithinReal (P2-25 symlink escape)', () => {
  it('keeps accepting real files inside the workspace', async () => {
    const { root } = await workspace()
    const file = join(root, 'notes.txt')
    await writeFile(file, 'hello\n')
    expect(await isWithinReal(root, file)).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('hello\n')
  })

  it('rejects a symlink pointing outside the workspace (lexical check passes)', async () => {
    const { root, outside } = await workspace()
    const link = join(root, 'escape.txt')
    await symlink(join(outside, 'secret.txt'), link)
    // The pre-fix fence only compared path strings, so it accepted this.
    expect(isWithin(root, link)).toBe(true)
    expect(await isWithinReal(root, link)).toBe(false)
  })

  it('rejects a new file created through a symlinked directory', async () => {
    const { root, outside } = await workspace()
    await symlink(outside, join(root, 'linked-dir'))
    const target = join(root, 'linked-dir', 'new.txt')
    expect(isWithin(root, target)).toBe(true)
    expect(await isWithinReal(root, target)).toBe(false)
  })

  it('refuses a final symlink for writes even when it stays inside', async () => {
    const { root } = await workspace()
    const real = join(root, 'real.txt')
    await writeFile(real, 'x\n')
    const link = join(root, 'alias.txt')
    await symlink(real, link)
    expect(await isWithinReal(root, link)).toBe(true)
    expect(await isWithinReal(root, link, { rejectSymlink: true })).toBe(false)
  })

  it('resolves a symlinked workspace root before comparing', async () => {
    const { root } = await workspace()
    const alias = `${root}-alias`
    await symlink(root, alias)
    cleanups.push(async () => { await rm(alias, { force: true }) })
    await writeFile(join(root, 'inside.txt'), 'ok\n')
    expect(await isWithinReal(alias, join(root, 'inside.txt'))).toBe(true)
  })
})
