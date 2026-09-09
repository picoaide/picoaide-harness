/** Child process: run approvePendingSkill against the fault-injected fs.
 * Prints one JSON line describing the outcome + destination contents.
 * SKILLS_MODULE env selects which skills.js to import (repo or a copy). */
import { createRequire } from 'node:module'
globalThis.__realFs = createRequire(import.meta.url)('node:fs')
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } = globalThis.__realFs
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { approvePendingSkill } = await import(process.env.SKILLS_MODULE)

const dir = mkdtempSync(join(tmpdir(), 'fault-'))
const pendingDir = join(dir, 'pending-skills')
const skillDir = join(dir, 'skills')
mkdirSync(join(pendingDir, 'demo-skill'), { recursive: true })
writeFileSync(join(pendingDir, 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: d\n---\n# x\n')
mkdirSync(join(skillDir, 'demo-skill'), { recursive: true })
writeFileSync(join(skillDir, 'demo-skill', 'notes.md'), 'USER DATA')

const outcome = approvePendingSkill(pendingDir, skillDir, 'demo-skill')
console.log(JSON.stringify({
  outcome,
  notesSurvived: existsSync(join(skillDir, 'demo-skill', 'notes.md')),
  skillLanded: existsSync(join(skillDir, 'demo-skill', 'SKILL.md')),
}))
