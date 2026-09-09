/**
 * AC6: fault-injection coverage for the approvePendingSkill copy fallback.
 *
 * The pre-fix fallback ran `rmSync(to)` before copying, so a destination
 * directory holding user data (notes, attachments) was destroyed whenever
 * renameSync failed. These tests force renameSync to throw each degradable
 * errno in a CHILD process (the only way to swap a node:fs named import —
 * ESM bindings are fixed at instantiation, and test-runner module mocks do
 * not support builtin CJS interop), then assert the destination's
 * pre-existing files survive and the skill lands.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const register = join(here, 'fixtures', 'register.mjs')
const child = join(here, 'fixtures', 'child-approve.mjs')
const skillsModule = join(here, '..', 'lib', 'skills.js')

function runWithFault(code) {
  const result = spawnSync(process.execPath, ['--import', register, child], {
    env: { ...process.env, FAULT_CODE: code, SKILLS_MODULE: skillsModule },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `child failed for ${code}: ${result.stderr}`)
  return JSON.parse(result.stdout.trim())
}

for (const code of ['EBUSY', 'EPERM', 'EACCES', 'EXDEV']) {
  test(`AC6 ${code}: copy fallback adopts the skill and preserves existing target files`, () => {
    const r = runWithFault(code)
    assert.equal(r.outcome.ok, true, `expected adopt, got ${JSON.stringify(r.outcome)}`)
    assert.equal(r.notesSurvived, true, 'pre-existing notes.md must survive (no clobber)')
    assert.equal(r.skillLanded, true, 'SKILL.md must land')
  })
}

// Real cross-device move (no mock): pending on tmpfs, skills on the main fs.
// Skipped where /dev/shm is unavailable.
test('AC6 real EXDEV: cross-device fallback preserves existing target files', (t) => {
  if (!existsSync('/dev/shm')) return t.skip('/dev/shm unavailable')
  const pendingDir = mkdtempSync(join('/dev/shm', 'dsh-skill-exdev-'))
  const dir = mkdtempSync(join(tmpdir(), 'dsh-skill-exdev-'))
  const skillDir = join(dir, 'skills')
  const name = 'exdev-skill'
  mkdirSync(join(pendingDir, name), { recursive: true })
  writeFileSync(join(pendingDir, name, 'SKILL.md'), '---\nname: exdev-skill\ndescription: d\n---\n# x\n')
  mkdirSync(join(skillDir, name), { recursive: true })
  writeFileSync(join(skillDir, name, 'notes.md'), 'USER DATA')

  const result = spawnSync(
    process.execPath,
    ['-e', `
      const { approvePendingSkill } = await import(${JSON.stringify(skillsModule)})
      const outcome = approvePendingSkill(${JSON.stringify(pendingDir)}, ${JSON.stringify(skillDir)}, ${JSON.stringify(name)})
      console.log(JSON.stringify({ outcome }))
    `],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, `child failed: ${result.stderr}`)
  assert.equal(JSON.parse(result.stdout.trim()).outcome.ok, true)
  assert.equal(existsSync(join(skillDir, name, 'notes.md')), true, 'pre-existing notes.md must survive')
  assert.equal(readFileSync(join(skillDir, name, 'SKILL.md'), 'utf8').includes('exdev-skill'), true, 'SKILL.md must land')
  rmSync(pendingDir, { recursive: true, force: true })
  rmSync(dir, { recursive: true, force: true })
})
