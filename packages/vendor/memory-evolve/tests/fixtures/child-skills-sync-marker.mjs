/**
 * Child process for the F2 (marker gate) regression：造一份"已装插件版"的同名技能，
 * 把安装器标记（`.picoaide/release.json`）换成各种**不是小普通文件**的形态，跑一次
 * `syncBuiltinSkills`，打印落点事实一行 JSON。
 *
 * 为什么要在子进程里跑：修复前 `.picoaide/release.json` 是 **FIFO** 时，
 * `readFileSync` 的 `open(O_RDONLY)` 会**永久阻塞**（复审 r3 实测 12s 未返回）。
 * 若在测试进程里直接跑那种形态，整个套件会挂住 —— 所以父用例用
 * `spawnSync(..., { timeout })` 把它变成"**有界**的失败"，而不是无界挂起。
 *
 * Env：
 *   SKILLS_SYNC_MODULE - 被测模块绝对路径。
 *   MARKER_MODE        - normal | fifo | big | dir | symlink（缺省 normal）。
 */
import { createRequire } from 'node:module'

globalThis.__realFs = createRequire(import.meta.url)('node:fs')
const { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } = globalThis.__realFs
const { spawnSync } = await import('node:child_process')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { syncBuiltinSkills } = await import(process.env.SKILLS_SYNC_MODULE)

const NAME = 'kimi-cli-calling'
const mode = process.env.MARKER_MODE ?? 'normal'
const dir = mkdtempSync(join(tmpdir(), `skills-sync-marker-${mode}-`))
const pluginSkills = join(dir, 'plugin-skills')
const userSkills = join(dir, 'skills')
const dest = join(userSkills, NAME)
const marker = join(dest, '.picoaide', 'release.json')

// 随包技能（x-version 2 ⇒ 比已装的 1 新，若放行就会整树换入）。
mkdirSync(join(pluginSkills, NAME, 'scripts'), { recursive: true })
writeFileSync(join(pluginSkills, NAME, 'SKILL.md'), `---\nname: ${NAME}\ndescription: d\nx-version: 2\n---\n# BUNDLED\n`)
writeFileSync(join(pluginSkills, NAME, 'scripts', 'helper.mjs'), '// HELPER\n')

// 已装副本（x-version 1，正文里留下可核对的标记）。
mkdirSync(join(dest, '.picoaide'), { recursive: true })
writeFileSync(join(dest, 'SKILL.md'), `---\nname: ${NAME}\ndescription: installed\nx-version: 1\n---\n# INSTALLED-OLD\n`)

const validProvenance = `${JSON.stringify({ appId: NAME, version: '1', channel: 'plugin', installedAt: '2026-09-01T00:00:00.000Z' }, null, 2)}\n`
/** 内容**完全合法**、只是超过体积上限的标记（修复前会被整份读入并按 plugin 放行）。 */
const bigProvenance = `${JSON.stringify({ appId: NAME, version: '1', channel: 'plugin', installedAt: '', pad: 'x'.repeat(70 * 1024) })}\n`

let setupError = null
if (mode === 'normal') {
  writeFileSync(marker, validProvenance)
} else if (mode === 'big') {
  writeFileSync(marker, bigProvenance)
} else if (mode === 'dir') {
  mkdirSync(marker, { recursive: true })
  writeFileSync(join(marker, 'inner.txt'), 'not a marker\n')
} else if (mode === 'symlink') {
  // 指向技能库外（这里是技能库根）的一份**合法**溯源：不跟随符号链接的闸门必须拒收。
  const realFile = join(userSkills, 'real-provenance.json')
  writeFileSync(realFile, validProvenance)
  symlinkSync(realFile, marker)
} else if (mode === 'fifo') {
  const made = spawnSync('mkfifo', [marker], { encoding: 'utf8' })
  if (made.status !== 0) setupError = `mkfifo failed: ${made.stderr || made.error?.message}`
} else {
  setupError = `unknown MARKER_MODE ${mode}`
}

const results = setupError === null ? syncBuiltinSkills(pluginSkills, userSkills) : []
const markerStat = (() => {
  try {
    const st = lstatSync(marker)
    return { kind: st.isFile() ? 'file' : st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : st.isFIFO() ? 'fifo' : 'other', size: st.size }
  } catch {
    return null
  }
})()

console.log(JSON.stringify({
  setupError,
  entry: results.find((r) => r.name === NAME),
  skill: existsSync(join(dest, 'SKILL.md')) ? readFileSync(join(dest, 'SKILL.md'), 'utf8') : null,
  marker: markerStat,
  markerBody: markerStat?.kind === 'file' ? readFileSync(marker, 'utf8') : null,
  destEntries: existsSync(dest) ? readdirSync(dest).sort() : [],
}))
