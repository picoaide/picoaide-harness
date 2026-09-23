/**
 * Child process for the A9 marker-preservation regression
 * (tests/coi-skills-sync-provenance-and-staging.test.js).
 *
 * Builds a plugin skill (x-version 2) and an already-installed copy that looks like a
 * **market install** (`.picoaide/release.json` with channel 'market' + `.install-version`
 * '9.9.9' + a user-added notes.md), then runs one `syncBuiltinSkills` pass and prints
 * the resulting directory state.
 *
 * Run with `--import tests/fixtures/register-swap-fault.mjs` (+ SWAP_FAULT_CODE=EPERM)
 * to exercise the failed-swap rollback: the installer markers were moved into the
 * staging directory before the swap, so the rollback path must move them **back** —
 * otherwise tidying up the staging copy silently destroys the user's provenance.
 *
 * Env: SKILLS_SYNC_MODULE - absolute path of lib/coi/skills-sync.js.
 */
import { createRequire } from 'node:module'

globalThis.__realFs = createRequire(import.meta.url)('node:fs')
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } = globalThis.__realFs
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { syncBuiltinSkills } = await import(process.env.SKILLS_SYNC_MODULE)

const NAME = 'kimi-cli-calling'
const dir = mkdtempSync(join(tmpdir(), 'skills-sync-markers-'))
const pluginSkills = join(dir, 'plugin-skills')
const userSkills = join(dir, 'skills')

// 插件源（x-version 2 > 已装 1 ⇒ 触发整目录换入）
mkdirSync(join(pluginSkills, NAME), { recursive: true })
writeFileSync(join(pluginSkills, NAME, 'SKILL.md'), `---\nname: ${NAME}\ndescription: d\nx-version: 2\n---\n# NEW-SOURCE\n`)

// 已装副本 = 市场安装形态
mkdirSync(join(userSkills, NAME, '.picoaide'), { recursive: true })
writeFileSync(join(userSkills, NAME, 'SKILL.md'), `---\nname: ${NAME}\ndescription: d\nx-version: 1\n---\n# OLD-INSTALLED\n`)
writeFileSync(
  join(userSkills, NAME, '.picoaide', 'release.json'),
  `${JSON.stringify({ appId: NAME, version: '9.9.9', channel: 'market', installedAt: '2026-09-01T00:00:00.000Z' }, null, 2)}\n`,
)
writeFileSync(join(userSkills, NAME, '.install-version'), '9.9.9')
writeFileSync(join(userSkills, NAME, 'notes.md'), 'USER DATA\n')

const results = syncBuiltinSkills(pluginSkills, userSkills)
const dest = join(userSkills, NAME)
const readIf = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null)

console.log(JSON.stringify({
  entry: results.find((r) => r.name === NAME),
  destSkill: readIf(join(dest, 'SKILL.md')),
  provenance: readIf(join(dest, '.picoaide', 'release.json')),
  installVersion: readIf(join(dest, '.install-version')),
  leftovers: existsSync(userSkills)
    ? readdirSync(userSkills).filter((n) => n.includes('.staging-') || n.includes('.old-'))
    : [],
}))
