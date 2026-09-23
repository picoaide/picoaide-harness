/**
 * Child process for the F1 (TOCTOU) regression：造一份"内容与随包技能逐字相同、
 * 没有 `.picoaide` 溯源"的历史副本（= 会走"内容同一性采纳"分支的形态），跑一次
 * `syncBuiltinSkills`，把落点事实打印成一行 JSON。
 *
 * 用法：
 *   - 对照组：`node <this>` ⇒ `entry.action === 'adopted'`；
 *   - 注入组：`node --import tests/fixtures/register-toctou.mjs <this>` 并给
 *     `TOCTOU_ARM=1` ⇒ 垫片在采纳分支写溯源的那一次 fd 写**之后**立刻往目标技能
 *     目录塞一个用户文件（复审 r3 的 F1 窗口）。注入落点由本文件在算出 mkdtemp
 *     路径之后通过 `TOCTOU_FILE` 交给垫片（垫片在读 env 时取值，见 hook 的头注释）。
 *
 * 判据（修复后）：写入窗口里出现的用户字节必须让采纳**失败**（`refused` +
 * `SKILL_LOCAL_CONTENT`），且自己刚写的溯源标记被收回、用户文件一字不动。
 * 修复前：报 `adopted` 并把 `channel: 'plugin'` 盖在含用户字节的目录上
 * ⇒ 下一次随包升 `x-version` 时整树换入会把用户文件静默删掉（复审实测）。
 *
 * Env: SKILLS_SYNC_MODULE（被测模块绝对路径）、TOCTOU_ARM / TOCTOU_BODY / TOCTOU_ON
 * （见 tests/fixtures/fs-toctou-hook.mjs）。
 */
import { createRequire } from 'node:module'

// 真实 fs 必须先于 loader 垫片拿到（垫片会改写本进程里所有 `node:fs` import）。
globalThis.__realFs = createRequire(import.meta.url)('node:fs')
const { cpSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } = globalThis.__realFs
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { syncBuiltinSkills } = await import(process.env.SKILLS_SYNC_MODULE)

const NAME = 'kimi-cli-calling'
const dir = mkdtempSync(join(tmpdir(), 'skills-sync-toctou-'))
const pluginSkills = join(dir, 'plugin-skills')
const userSkills = join(dir, 'skills')

// 随包技能（x-version 2，带辅助文件）。
mkdirSync(join(pluginSkills, NAME, 'scripts'), { recursive: true })
writeFileSync(join(pluginSkills, NAME, 'SKILL.md'), `---\nname: ${NAME}\ndescription: d\nx-version: 2\n---\n# BUNDLED\n`)
writeFileSync(join(pluginSkills, NAME, 'scripts', 'helper.mjs'), '// HELPER\n')

// 历史副本：**逐字复制**、不带任何溯源（旧版插件同步落下的形态）⇒ 走采纳分支。
mkdirSync(userSkills, { recursive: true })
cpSync(join(pluginSkills, NAME), join(userSkills, NAME), { recursive: true, preserveTimestamps: true })

const dest = join(userSkills, NAME)
// 注入落点只有这里算得出来（mkdtemp）；垫片在**注入那一刻**读 env，所以这里设置有效。
if (process.env.TOCTOU_ARM === '1') process.env.TOCTOU_FILE = join(dest, 'MY-NOTES.md')

const results = syncBuiltinSkills(pluginSkills, userSkills)
const readIf = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null)

console.log(JSON.stringify({
  entry: results.find((r) => r.name === NAME),
  skill: readIf(join(dest, 'SKILL.md')),
  notes: readIf(join(dest, 'MY-NOTES.md')),
  provenance: readIf(join(dest, '.picoaide', 'release.json')),
  installVersion: readIf(join(dest, '.install-version')),
  destEntries: existsSync(dest) ? readdirSync(dest).sort() : [],
  rootEntries: readdirSync(userSkills).sort(),
}))
