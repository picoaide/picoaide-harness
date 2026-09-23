/**
 * Child process for the P1-1 兼容路径 regression (adoption 的 fail-loud 面)：
 * 造一份"内容与随包技能逐字相同、但没有 `.picoaide` 溯源"的历史副本，跑一次
 * `syncBuiltinSkills`，把结果打印成一行 JSON。
 *
 * 用法：`node --import tests/fixtures/register-write-fault.mjs <this>`
 *   - 无故障（对照组）⇒ `entry.action === 'adopted'`，`.picoaide` 被补上；
 *   - `FAULT_ON=1 FAULT_CODE=ENOSPC` ⇒ 补写溯源这一步的 fd 写失败 ⇒ 必须
 *     `refused` + `code: 'SKILL_ADOPT_FAILED'`，且**内容一字未动、没有半个标记**
 *     （绝不允许"内容按 plugin 更新了、溯源没写"）。
 *
 * Env: SKILLS_SYNC_MODULE（被测模块绝对路径）、FAULT_ON / FAULT_CODE（见
 * tests/fixtures/fs-write-fault-hook.mjs）。
 */
import { createRequire } from 'node:module'

// 真实 fs 必须先于 loader 垫片拿到（垫片会改写本进程里所有 `node:fs` import）。
globalThis.__realFs = createRequire(import.meta.url)('node:fs')
const { cpSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } = globalThis.__realFs
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { syncBuiltinSkills } = await import(process.env.SKILLS_SYNC_MODULE)

const NAME = 'kimi-cli-calling'
const dir = mkdtempSync(join(tmpdir(), 'skills-sync-adopt-'))
const pluginSkills = join(dir, 'plugin-skills')
const userSkills = join(dir, 'skills')

// 随包技能（x-version 2，带辅助文件）。
mkdirSync(join(pluginSkills, NAME, 'scripts'), { recursive: true })
writeFileSync(join(pluginSkills, NAME, 'SKILL.md'), `---\nname: ${NAME}\ndescription: d\nx-version: 2\n---\n# BUNDLED\n`)
writeFileSync(join(pluginSkills, NAME, 'scripts', 'helper.mjs'), '// HELPER\n')

// 历史副本：**逐字复制**，不带任何溯源（旧版插件同步落下的形态）。
mkdirSync(userSkills, { recursive: true })
cpSync(join(pluginSkills, NAME), join(userSkills, NAME), { recursive: true, preserveTimestamps: true })

const results = syncBuiltinSkills(pluginSkills, userSkills)
const dest = join(userSkills, NAME)
const readIf = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null)

console.log(JSON.stringify({
  entry: results.find((r) => r.name === NAME),
  skill: readIf(join(dest, 'SKILL.md')),
  helper: readIf(join(dest, 'scripts', 'helper.mjs')),
  provenance: readIf(join(dest, '.picoaide', 'release.json')),
  installVersion: readIf(join(dest, '.install-version')),
  destEntries: existsSync(dest) ? readdirSync(dest).sort() : [],
}))
