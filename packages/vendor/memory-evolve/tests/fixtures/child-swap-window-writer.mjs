/**
 * Child process for the C4-01 **swap-window replay** criterion（两阶段）。
 *
 * 复演的是 `syncSkillDirSafe` 的**真实**换入序列（不是手抄的两次 rename）：
 * 装配见 `tests/fixtures/fs-swap-window-hook.mjs` —— 它把 `node:fs` 的 `renameSync`
 * 包一层，在"旧目录旁置"（`.old-<name>-<pid>-<ts>`）真正落地**之后、暂存目录就位
 * 之前**调用 `globalThis.__swapWindowWriter()`。这正是审计探针手工复演的那个窗口，
 * 只是这里由真实同步器进入。
 *
 * 两阶段（"下一次开机"必须是**另一个进程**，否则 `sweepStaleSwapDirs` 会把旁置
 * 副本当成"活 pid + 新鲜时间戳 = 可能有并发同步"而刻意留着）：
 *
 *   PHASE=A（默认）：建一次性技能库 → 首次同步装上 → 随包升版 → 第二次同步
 *                   （hook 在窗口里调用写者）→ 打印事实。
 *   PHASE=B：同一个技能库（路径由 A 打印、父用例传回）再跑一次 `syncBuiltinSkills`
 *                   —— 这一次的 pid 与 A 不同、A 已退出 ⇒ 开头清扫按"陈旧"处理。
 *
 * Env：
 *   WINDOW_WRITER = coi → 窗口内调用**真的** `svc.writeSkill`（COI 适配器写者，C4-01 点名）
 *                   raw → 窗口内直接 `writeFileAtomicSafeAt` 写落点（**不取锁**的阳性对照：
 *                         用来证明"这个窗口真的能让换入与回滚双双 ENOTEMPTY"，
 *                         即本判据在本环境确实咬得到，不是空转）
 *   PHASE / USER_SKILLS / PKG_SKILLS / KEEP_TREE
 *
 * 每个阶段打印一行 JSON。
 */
import { createRequire } from 'node:module'

globalThis.__realFs = createRequire(import.meta.url)('node:fs')
const {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} = globalThis.__realFs
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const { syncBuiltinSkills } = await import(process.env.SKILLS_SYNC_MODULE)
const { setLocale } = await import(process.env.I18N_MODULE)
setLocale('zh')

const NAME = 'kimi-cli-calling' // 内置适配器 `kimi` 的 skillName ⇒ 落点与随包技能重合
const mode = process.env.WINDOW_WRITER ?? 'coi'
const phase = process.env.PHASE ?? 'A'

const skillText = (version, body) => `---\nname: ${NAME}\ndescription: swap-window replay\nx-version: ${version}\n---\n# ${body}\n`

/** B 阶段：同一个技能库再开一次机（不同 pid ⇒ 旁置副本按陈旧清扫）。 */
if (phase === 'B') {
  const userSkills = process.env.USER_SKILLS
  const pkgSkills = process.env.PKG_SKILLS
  const tmpDir = join(userSkills, '.skill-tmp')
  const destFile = join(userSkills, NAME, 'SKILL.md')
  const results = syncBuiltinSkills(pkgSkills, userSkills)
  console.log(JSON.stringify({
    phase: 'B',
    result: results.find((r) => r.name === NAME) ?? null,
    destSkill: existsSync(destFile) ? readFileSync(destFile, 'utf8') : null,
    tmpResidue: existsSync(tmpDir) ? readdirSync(tmpDir) : [],
    oldRecoverable: (existsSync(tmpDir) ? readdirSync(tmpDir) : []).some((n) => n.startsWith('.old-')),
  }))
  // 整个一次性树由 A 阶段建在同一层；B 阶段收尾把它一起清掉。
  rmSync(join(userSkills, '..'), { recursive: true, force: true })
  process.exit(0)
}

/** A 阶段：建树 → 装入 → 升版 → 换入窗口里跑写者 → 打印事实。 */
const dir = mkdtempSync(join(tmpdir(), `c4-swap-window-${mode}-`))
const pkgSkills = join(dir, 'pkg-skills')
const userSkills = join(dir, 'skills')
const destFile = join(userSkills, NAME, 'SKILL.md')
const tmpDir = join(userSkills, '.skill-tmp')

function fakeCtx() {
  return {
    tools: { register: () => () => {} },
    effect: (fn) => { const d = fn(); return d ?? (() => {}) },
    inject: (_n, cb) => cb({
      commands: { register: () => () => {} },
      webServer: { register: () => () => {} },
      effect: (fn) => { const d = fn(); return d ?? (() => {}) },
    }),
    emit: () => {}, on: () => () => {}, off: () => {}, get: () => undefined,
  }
}

const out = { phase: 'A', name: NAME, mode, userSkills, pkgSkills, windowFired: false, writerResult: null }
try {
  // 随包技能源（连 scripts/ 一起拷，保证与真实同步同样的整树形状）。
  mkdirSync(join(pkgSkills, NAME), { recursive: true })
  cpSync(join(process.env.PACKAGED_SKILLS_DIR, NAME), join(pkgSkills, NAME), { recursive: true })
  writeFileSync(join(pkgSkills, NAME, 'SKILL.md'), skillText(1, 'PACKAGED-V1'))

  out.first = syncBuiltinSkills(pkgSkills, userSkills).find((r) => r.name === NAME) ?? null

  // 随包升版 ⇒ 第二次同步会走整目录换入（`syncSkillDirSafe`）。
  writeFileSync(join(pkgSkills, NAME, 'SKILL.md'), skillText(2, 'PACKAGED-V2'))

  if (mode === 'coi') {
    const { installCoi } = await import(process.env.COI_MODULE)
    const { svc } = installCoi(fakeCtx(), {
      coiDataDir: join(dir, 'coi'),
      coiEnabled: true,
      coiSummaryEnabled: false,
      coiSyncSkills: false, // 本用例自己控制同步时机
      coiNotifyCommand: null,
      coiRetentionDays: 90,
      coiTaskTimeoutMs: 60000,
      coiMaxLogBytes: 65536,
      skillDir: userSkills,
    }, { memoryStore: { add: () => ({ ok: true }) }, resolveCwd: () => undefined })
    globalThis.__swapWindowWriter = () => svc.writeSkill('kimi', skillText(1, 'FOURTH-WRITER'))
  } else {
    // 阳性对照：同一个窗口、同一次写入，唯一区别是**不取锁**。
    const { writeFileAtomicSafeAt } = await import(process.env.FILESETS_MODULE)
    globalThis.__swapWindowWriter = () => {
      writeFileAtomicSafeAt(destFile, skillText(1, 'FOURTH-WRITER'), { anchorDir: userSkills, followFileSymlink: false })
      return { ok: true, unlocked: true }
    }
  }

  out.second = syncBuiltinSkills(pkgSkills, userSkills).find((r) => r.name === NAME) ?? null
  out.windowFired = globalThis.__swapWindowFired === true
  out.writerResult = globalThis.__swapWindowWriterResult ?? null
  out.destSkill = existsSync(destFile) ? readFileSync(destFile, 'utf8') : null
  out.tmpResidue = existsSync(tmpDir) ? readdirSync(tmpDir) : []
} catch (error) {
  out.fatal = String(error?.message ?? error)
} finally {
  // A 阶段必须把树留给 B 阶段（"下一次开机"）；致命错误时不留垃圾。
  if (out.fatal !== undefined) rmSync(dir, { recursive: true, force: true })
}
console.log(JSON.stringify(out))
