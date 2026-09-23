/** Child process for the S13-3 regression: run a whole-directory built-in skill
 * sync where the source skill is newer than the installed one, under the fault
 * hook (when --import'ed). Prints one JSON line describing the outcome and the
 * destination directory contents, so the parent can assert that a mid-copy
 * failure left the previously installed skill intact.
 *
 * Env:
 *   SKILLS_SYNC_MODULE - absolute path of lib/coi/skills-sync.js to import
 *                        (lets a mutation run point at a modified copy).
 *   FAULT_ON/FAULT_CODE - see tests/fixtures/fs-write-fault-hook.mjs.
 */
import { createRequire } from 'node:module'
globalThis.__realFs = createRequire(import.meta.url)('node:fs')
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } =
  globalThis.__realFs
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { syncBuiltinSkills } = await import(process.env.SKILLS_SYNC_MODULE)

const NAME = 'kimi-cli-calling' // BUILTIN_SKILLS 里的一员（其余成员在夹具里必然 missing）
const dir = mkdtempSync(join(tmpdir(), 'skills-sync-fault-'))
const pluginSkills = join(dir, 'plugin-skills')
const userSkills = join(dir, 'skills')

// 源：插件包内技能（x-version 2），两个文件 → 覆盖需要写两次（SKILL.md + scripts/helper.mjs）
mkdirSync(join(pluginSkills, NAME, 'scripts'), { recursive: true })
writeFileSync(join(pluginSkills, NAME, 'SKILL.md'), `---\nname: ${NAME}\ndescription: d\nx-version: 2\n---\n# NEW-SOURCE\n`)
writeFileSync(join(pluginSkills, NAME, 'scripts', 'helper.mjs'), '// NEW-HELPER\n')

// 目标：**随包插件先前装好的旧版**（x-version 1，带 plugin 溯源 —— P1-1 的来源闸门
// 只允许整树换入"本插件自己的内容"，缺溯源的同名目录会被拒收）+ 用户自加文件
// （整目录语义下成功时会被替换，但**失败时**必须原样保留——这正是 S13-3 的断言面）
mkdirSync(join(userSkills, NAME, '.picoaide'), { recursive: true })
writeFileSync(join(userSkills, NAME, 'SKILL.md'), `---\nname: ${NAME}\ndescription: d\nx-version: 1\n---\n# OLD-INSTALLED\n`)
writeFileSync(
  join(userSkills, NAME, '.picoaide', 'release.json'),
  `${JSON.stringify({ appId: NAME, version: '1', channel: 'plugin', installedAt: '2026-09-01T00:00:00.000Z' }, null, 2)}\n`,
)
writeFileSync(join(userSkills, NAME, 'notes.md'), 'USER DATA\n')

const results = syncBuiltinSkills(pluginSkills, userSkills)
const destDir = join(userSkills, NAME)
// 换入临时目录的残留（S13-3 复核，2026-09-17）：`.staging-*` = 未就位的新副本，
// `.old-*` = 未删掉的旧副本。连同各自 SKILL.md 正文一起报出来，父进程才能断言
// "内容还在盘上（可人工恢复）"，而不是只看目录名。
// R4-B-2（2026-09-23 第四轮）：落点从技能库根改到**第二层**私有目录
// `.skill-tmp/`（运行时只认直接子目录），所以两处都要扫：只扫根会把"残留藏在
// 私有目录里"当成"没有残留"。返回的 key 以 `.skill-tmp/` 前缀区分落点。
const swapLeftovers = () => {
  const root = existsSync(userSkills)
    ? readdirSync(userSkills).filter((name) => name.includes('.staging-') || name.includes('.old-'))
    : []
  const tempDir = join(userSkills, '.skill-tmp')
  const temp = existsSync(tempDir)
    ? readdirSync(tempDir).filter((name) => name.includes('.staging-') || name.includes('.old-')).map((name) => `.skill-tmp/${name}`)
    : []
  return [...root, ...temp]
}
const leftovers = swapLeftovers()
console.log(JSON.stringify({
  entry: results.find((r) => r.name === NAME),
  destExists: existsSync(destDir),
  destSkill: existsSync(join(destDir, 'SKILL.md')) ? readFileSync(join(destDir, 'SKILL.md'), 'utf8') : null,
  destHelper: existsSync(join(destDir, 'scripts', 'helper.mjs')),
  notesIntact: existsSync(join(destDir, 'notes.md')),
  stagingLeftovers: leftovers.filter((name) => name.includes('.staging-')),
  leftovers,
  leftoverSkills: Object.fromEntries(leftovers.map((name) => [
    name,
    existsSync(join(userSkills, name, 'SKILL.md')) ? readFileSync(join(userSkills, name, 'SKILL.md'), 'utf8') : null,
  ])),
}))
