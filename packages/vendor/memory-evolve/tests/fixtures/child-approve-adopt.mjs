/**
 * Child process for the A5/A10 regressions (tests/skills-landing-adopt-hardening.test.js).
 *
 * Exercises `approvePendingSkill` on the shapes that used to break it:
 *
 *   plain          - target directory absent → the rename fast path (control).
 *   blocked-target - the pending skill has a **subdirectory** (`scripts/`) while the
 *                    target holds a **regular file** at that relative path. Feeding
 *                    that to the old `cpSync(from, to, {recursive:true})` fallback made
 *                    libstdc++ throw an uncaught C++ exception
 *                    (`terminate called … cannot create directory: File exists`) →
 *                    the whole host process aborted with exit 134. The parent asserts
 *                    this child exits 0 with a readable refusal, and that a second
 *                    adoption (after the blocker is removed) succeeds.
 *   write-fault    - `--import` the fd-write fault hook (FAULT_ON=1) so the first
 *                    per-file write fails mid-copy: `SKILL.md` must NOT have landed
 *                    (it is written last), so a second adoption still succeeds
 *                    (otherwise the half-copied directory wedges adoption forever —
 *                    "already exists in the library").
 *
 * Setup writes go through `globalThis.__realFs` (createRequire), so the fault hook
 * only intercepts the production path, exactly like the S13-3 fixtures.
 *
 * Env:
 *   ADOPT_MODE    - plain | blocked-target | write-fault
 *   SKILLS_MODULE - absolute path of lib/skills.js (lets a mutation run point elsewhere)
 *   FAULT_ON/FAULT_CODE - see tests/fixtures/fs-write-fault-hook.mjs
 */
import { createRequire } from 'node:module'

globalThis.__realFs = createRequire(import.meta.url)('node:fs')
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } = globalThis.__realFs
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { approvePendingSkill } = await import(process.env.SKILLS_MODULE)

const NAME = 'adopt-probe'
const mode = process.env.ADOPT_MODE ?? 'plain'
const dir = mkdtempSync(join(tmpdir(), `skill-adopt-${mode}-`))
const pending = join(dir, 'pending')
const skills = join(dir, 'skills')

// 源：SKILL.md + scripts/helper.mjs（多文件技能 —— abort 形态的前提）
mkdirSync(join(pending, NAME, 'scripts'), { recursive: true })
writeFileSync(join(pending, NAME, 'SKILL.md'), `---\nname: ${NAME}\ndescription: d\n---\n# NEW-SOURCE\n`)
writeFileSync(join(pending, NAME, 'scripts', 'helper.mjs'), '// NEW-HELPER\n')

if (mode !== 'plain') {
  // 目标目录已存在（装着用户自加内容 ⇒ 走合并回落的形态）
  mkdirSync(join(skills, NAME), { recursive: true })
  writeFileSync(join(skills, NAME, 'notes.md'), 'USER NOTES\n')
}
if (mode === 'blocked-target') {
  // 源里 `scripts/` 是目录，目标同名处是**普通文件** —— cpSync abort 的触发器
  writeFileSync(join(skills, NAME, 'scripts'), 'BLOCKER\n')
}

/** 递归列出目标技能目录下的普通文件（相对路径），用于断言"没留下半成品"。 */
function listFilesRel(dir, prefix = '') {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...listFilesRel(join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out.sort()
}

const state = () => ({
  skillMd: existsSync(join(skills, NAME, 'SKILL.md')),
  helper: existsSync(join(skills, NAME, 'scripts', 'helper.mjs')),
  notes: existsSync(join(skills, NAME, 'notes.md'))
    ? readFileSync(join(skills, NAME, 'notes.md'), 'utf8')
    : null,
  pendingSkillMd: existsSync(join(pending, NAME, 'SKILL.md')),
  targetEntries: listFilesRel(join(skills, NAME)),
})

/** 调用一次采纳；异常（底层 I/O 错误）收敛成 {ok:false, message, threw:true}。 */
function adopt() {
  try {
    return { ...approvePendingSkill(pending, skills, NAME), threw: false }
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error), code: error?.code ?? null, threw: true }
  }
}

const first = adopt()
const afterFirst = state()

if (mode === 'blocked-target') {
  // 用户处理掉挡路的同名文件（这就是"可读错误 + 提示用户先处理"的出路）
  rmSync(join(skills, NAME, 'scripts'), { recursive: true, force: true })
}

const second = mode === 'plain' ? null : adopt()
const afterSecond = state()

console.log(JSON.stringify({
  mode,
  first,
  firstThrew: first.threw === true,
  skillMdAfterFirst: afterFirst.skillMd,
  targetEntriesAfterFirst: afterFirst.targetEntries,
  second,
  skillMdAfterSecond: afterSecond.skillMd,
  helperAfterSecond: afterSecond.helper,
  notesIntact: afterSecond.notes === 'USER NOTES\n',
  pendingDeleted: afterFirst.pendingSkillMd === false,
}))
