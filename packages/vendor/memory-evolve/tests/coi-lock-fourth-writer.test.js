/**
 * C4-01（2026-10-04 回归审计 · 泳道 C4）：per-name 技能落点锁的
 * **第四、五、六个写者**收口（vendored 分叉）。
 *
 * ## 缺陷形态
 *
 * `<技能库>/<name>/SKILL.md` 有多个写者，而 `<技能库>/.skill-locks/<name>.lock`
 * 只被其中一部分取。R18B-03（`tests/skills-landing-lock.test.js`）只收口了
 * `lib/skills.js` 的三条活落点写入，审计实测仍有三个写者完全不参与协议：
 *
 *   1. `lib/coi/index.js` 的 `svc.writeSkill`（COI 适配器「AI 使用指南」编辑器）——
 *      内置适配器的 `skillName` 默认就是 `BUILTIN_SKILLS` 里的名字（`kimi-cli-calling` 等）
 *      ⇒ 落点与随包同步的**整目录换入**逐字相同；
 *   2. `lib/coi/api.js` 的「技能文件不存在就自动建」——**换入窗口里那正是"不存在"的形态**；
 *   3. `lib/skills-manager.js` 的 `applyDisableFlagToFile`（面板开关 + 自动投影
 *      `projectDisableFlags`，目录变化后 500ms 防抖、不需要用户动作）。
 *
 * 终态（审计探针逐字复演 + 本文件 `raw` 阳性对照实测）：第四个写者在
 * `renameSync(destDir, asideDir)` 之后把落点重新建出来 ⇒ 换入 rename 与回滚 rename
 * 双双 **ENOTEMPTY** ⇒ `SkillSwapRecoveryError`（需人工恢复）；下一次开机的
 * `sweepStaleSwapDirs` 看到真目录存在 ⇒ `.old-*` 与 `.staging-*` 两份副本一起被清掉
 * ⇒ **旧内容不可找回**，且活落点没有 `release.json` ⇒ 该随包技能永久
 * `refused`/`SKILL_LOCAL_CONTENT`。
 *
 * ## 判据（能力级：断言可观察后果，不是"源码里调了 withLock"）
 *
 * 1. **交错**：持锁期间四个写者全部必须被拒、落点零变化；释放后同一发调用必须成功
 *    （对照腿 —— 证明判据不是"把写面整体关掉"）。
 * 2. **换入窗口复演**：用真实 `syncBuiltinSkills`（真锁、真换入序列）+ loader hook
 *    在**旧目录旁置之后、暂存目录就位之前**调用**真的** `svc.writeSkill`，断言
 *    "要么被锁挡住、要么换入不产生 ENOTEMPTY"：写者 `ok:false`、同步 `synced`、
 *    活落点是新随包内容、无 `ENOTEMPTY`/`SKILL_SWAP_RECOVERY_FAILED`、无残留，
 *    且下一次开机**不再** refused（不出现"永久 refused"）。
 *    另有 `raw` **阳性对照**：同一个窗口、同一次写入、唯一区别是**不取锁** ⇒ 必须
 *    复现双 ENOTEMPTY + 旧内容不可找回（证明这个窗口在本环境真的咬得到）。
 * 3. **清单（辅助/前向网）**：技能落点写者清单双向登记，且每个写者模块必须真的
 *    参与协议、其覆盖用例必须存在（新增写者不登记即红）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installCoi } from '../lib/coi/index.js'
import { installCoiApi } from '../lib/coi/api.js'
import { installSkillsManager } from '../lib/skills-manager.js'
import { skillManageTool } from '../lib/skills.js'
import { setLocale } from '../lib/i18n.js'

setLocale('zh')

const here = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = dirname(here)

/** COI 内置适配器 `kimi` 的 skillName —— 与随包技能同名（落点重合是本缺陷的前提）。 */
const COI_NAME = 'kimi-cli-calling'
/** 面板侧（skills-manager）技能名，与 COI 名字错开，避免两套判据互相踩锁。 */
const PANEL_NAME = 'lock-panel-skill'

const coiBody = (body) => `---\nname: ${COI_NAME}\ndescription: 原始\nx-version: 1\n---\n# ${body}\n`
const panelBody = (disabled) => `---\nname: ${PANEL_NAME}\ndescription: 面板技能\n${disabled ? 'disable-model-invocation: true\n' : ''}---\nBody text\n`

/* ------------------------------------------------------------------ *
 * 夹具：真技能库 + 真 COI svc/HTTP + 真 skills-manager HTTP
 * ------------------------------------------------------------------ */

/** 建一次性技能库（realpath 基准，`.skill-locks` 与各写者看到的是同一个根）。 */
function tempTree() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-c4-lock-')))
  const skills = join(dir, 'skills')
  mkdirSync(join(skills, COI_NAME), { recursive: true })
  mkdirSync(join(skills, PANEL_NAME), { recursive: true })
  writeFileSync(join(skills, COI_NAME, 'SKILL.md'), coiBody('ORIGINAL'))
  writeFileSync(join(skills, PANEL_NAME, 'SKILL.md'), panelBody(false))
  return { dir, skills }
}

/**
 * 按协议自造一把"活着的"锁：持锁 pid = **本进程**（`kill(pid,0)` 必然成功 ⇒
 * 任何参与者都判"仍被持有"）。判的是"写者是否参与协议"，与持锁者在哪个进程无关
 * （跨进程形态见 `tests/coi-skills-sync-name-lock.test.js`）。
 * @returns {string} 锁文件路径。
 */
function holdLock(skillsDir, name) {
  const lockDir = join(skillsDir, '.skill-locks')
  mkdirSync(lockDir, { recursive: true })
  const lockPath = join(lockDir, `${name}.lock`)
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' })
  return lockPath
}

function releaseLock(lockPath) {
  rmSync(lockPath, { force: true })
}

/** 真 HTTP 面：拿注册出来的 handler 起一个本地 server（真 fetch、真路由）。 */
async function serveHandler(handler) {
  assert.equal(typeof handler, 'function', 'handler 没注册出来（夹具坏了）')
  const server = createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const request = async (method, path, { body, json } = {}) => {
    const res = await fetch(origin + path, {
      method,
      headers: {
        origin,
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(typeof body === 'string' ? { 'content-type': 'text/plain' } : {}),
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      ...(typeof body === 'string' ? { body } : {}),
    })
    return { status: res.status, data: await res.json().catch(() => ({})) }
  }
  return { origin, request, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** 真 COI：svc（`svc.writeSkill` 就是被审计的第四个写者）+ 它的 HTTP 面。 */
async function bootCoi(dir, skills) {
  const ctx = {
    tools: { register: () => () => {} },
    effect: (fn) => { const d = fn(); return d ?? (() => {}) },
    inject: (_n, cb) => cb({
      commands: { register: () => () => {} },
      webServer: { register: ({ handler }) => { ctx.handler = handler; return () => {} } },
      effect: (fn) => { const d = fn(); return d ?? (() => {}) },
    }),
    emit: () => {}, on: () => () => {}, off: () => {}, get: () => undefined,
  }
  const { svc } = installCoi(ctx, {
    coiDataDir: join(dir, 'coi'),
    coiEnabled: true,
    coiSummaryEnabled: false,
    coiSyncSkills: false, // 本用例自己控制同步/写盘时机
    coiNotifyCommand: null,
    coiRetentionDays: 90,
    coiTaskTimeoutMs: 60000,
    coiMaxLogBytes: 65536,
    skillDir: skills,
  }, { memoryStore: { add: () => ({ ok: true }) }, resolveCwd: () => undefined })
  const server = await serveHandler(ctx.handler)
  return { svc, server }
}

/** 真 skills-manager：catalog 里只有 PANEL_NAME 一个可写技能，落在同一个技能库。 */
async function bootSkillsManager(dir, skills) {
  const stateFile = join(dir, 'skills-state.json')
  const catalog = new Map([[PANEL_NAME, {
    name: PANEL_NAME,
    description: 'panel skill',
    whenToUse: PANEL_NAME,
    source: 'user-dsh',
    provider: 'test',
    invocation: { modelInvocable: true, userInvocable: true },
    resourceBase: { kind: 'directory', path: join(skills, PANEL_NAME) },
    path: join(skills, PANEL_NAME, 'SKILL.md'),
    content: '',
  }]])
  const ctx = {
    skills: {
      list: async () => [...catalog.values()],
      get: async (name) => catalog.get(name),
      register: () => () => {},
      registerProvider: () => () => {},
    },
    agentPresets: { standingKeyFor: async () => ({ agentPreset: 'standard' }) },
    get(name) { return ctx[name] },
    webServer: { register: ({ handler }) => { ctx.handler = handler; return () => {} } },
    workspaceRegistry: { list: () => [] },
    logger: { warn: () => {} },
    inject(deps, cb) { const d = cb(ctx); void d },
    on() {},
    effect(fn) { fn() },
  }
  installSkillsManager(ctx, { stateFile, legacyStateFile: join(dir, 'no-legacy.json') })
  return serveHandler(ctx.handler)
}

/* ------------------------------------------------------------------ *
 * 1. 交错：持锁期间四个写者全部被拒；释放后必须成功（对照腿）
 * ------------------------------------------------------------------ */

test('C4-01：持锁期间 COI svc.writeSkill 必须被拒（与 skill_manage patch 同形），释放后照常写入', async () => {
  const { dir, skills } = tempTree()
  try {
    const { svc, server } = await bootCoi(dir, skills)
    try {
      const lockPath = holdLock(skills, COI_NAME)
      const landing = join(skills, COI_NAME, 'SKILL.md')
      const before = readFileSync(landing, 'utf8')

      // 对照腿：R18B-03 已收口的写者（skill_manage patch）在同一个锁下也必须被拒
      // —— 两条断言同形，证明"同一条判据、同一把锁"。
      const tool = skillManageTool({ get: () => undefined }, {
        skillDir: skills,
        memoryDir: join(dir, 'memories'),
        skillMaxBytes: 65536,
        skillReviewEnabled: true,
        skillManageToolName: 'skill_manage',
      })
      const patched = await tool.execute(
        { action: 'patch', name: COI_NAME, body: coiBody('MODEL') },
        {
          agent: {
            session: {
              ownEvents: () => [{
                type: 'tool/call',
                data: { name: 'skill_manage', arguments: JSON.stringify({ action: 'read', name: COI_NAME }) },
              }],
            },
          },
        },
      )
      assert.equal(patched?.ok, false, '对照腿失败：skill_manage patch 没被锁拦住')

      const refused = svc.writeSkill('kimi', coiBody('FOURTH-WRITER'))
      assert.equal(refused?.ok, false, 'COI svc.writeSkill 不受 per-name 锁约束（第四个写者）')
      assert.match(String(refused?.message), /锁|lock/i, '拒收文案必须点名锁（fail-loud，不静默降级）')
      assert.equal(readFileSync(landing, 'utf8'), before, '被拒的写者不得改动落点一个字节')

      // 对照腿 2：释放锁后同一发调用必须成功 —— 判据不是"把写面整体关掉"。
      releaseLock(lockPath)
      const ok = svc.writeSkill('kimi', coiBody('AFTER-RELEASE'))
      assert.equal(ok?.ok, true, `释放锁后必须照常可写（实得 ${JSON.stringify(ok)}）`)
      assert.match(readFileSync(landing, 'utf8'), /AFTER-RELEASE/)
      assert.equal(existsSync(lockPath), false, '写完必须把自己的锁删掉（不留残留）')
    } finally {
      await server.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('C4-01：持锁期间 COI 自动建技能路由不得建出落点（换入窗口里那正是"不存在"的形态）', async () => {
  const { dir, skills } = tempTree()
  try {
    const { server } = await bootCoi(dir, skills)
    try {
      const landing = join(skills, COI_NAME, 'SKILL.md')
      rmSync(landing) // 落点不存在 ⇒ 走"文件不存在就自动建"分支
      const def = {
        id: 'kimi', name: 'Kimi', type: 'ai-cli', binary: 'true', args: ['-p', '{task}'],
        resume: { kind: 'flag', flag: '-S' }, skillName: COI_NAME,
      }
      const post = (content) => server.request('POST', '/memory-evolve/api/coi/adapters', {
        json: { def, skillContent: content },
      })

      const lockPath = holdLock(skills, COI_NAME)
      const held = await post(coiBody('AUTO-CREATE'))
      assert.equal(held.status, 200)
      assert.match(String(held.data.skillMessage ?? ''), /失败|failed/i, '持锁时必须如实报失败，不得静默建出落点')
      assert.equal(existsSync(landing), false, '持锁期间自动建技能把落点建出来了（换入窗口的 ENOTEMPTY 就是这么来的）')

      // 对照腿：释放锁后同一发请求必须真的建出来。
      releaseLock(lockPath)
      const released = await post(coiBody('AUTO-CREATE'))
      assert.equal(released.status, 200)
      assert.match(String(released.data.skillMessage ?? ''), /已自动创建|auto-created/i, `释放锁后必须自动建技能（实得 ${JSON.stringify(released.data.skillMessage)}）`)
      assert.match(readFileSync(landing, 'utf8'), /AUTO-CREATE/)
    } finally {
      await server.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('C4-01：持锁期间面板的禁用落地（含自动投影写者）必须被拒且文件一字未改', async () => {
  const { dir, skills } = tempTree()
  try {
    const sm = await bootSkillsManager(dir, skills)
    try {
      const landing = join(skills, PANEL_NAME, 'SKILL.md')
      const before = readFileSync(landing, 'utf8')
      const lockPath = holdLock(skills, PANEL_NAME)

      const held = await sm.request('POST', '/skills-manager/api/skills/disable', { json: { name: PANEL_NAME } })
      assert.notEqual(held.status, 200, `持锁时禁用必须失败（实得 ${held.status} ${JSON.stringify(held.data)}）`)
      assert.match(String(held.data.error ?? ''), /锁|lock/i, '拒收原因必须点名锁')
      assert.equal(readFileSync(landing, 'utf8'), before, '被拒的禁用落地不得改动 SKILL.md（也不得部分成功）')
      assert.doesNotMatch(readFileSync(landing, 'utf8'), /disable-model-invocation/)

      // 对照腿：释放锁后必须真的写进 frontmatter 标记。
      releaseLock(lockPath)
      const ok = await sm.request('POST', '/skills-manager/api/skills/disable', { json: { name: PANEL_NAME } })
      assert.equal(ok.status, 200, `释放锁后禁用必须成功（实得 ${ok.status} ${JSON.stringify(ok.data)}）`)
      assert.match(readFileSync(landing, 'utf8'), /^disable-model-invocation: true$/m)
    } finally {
      await sm.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('C4-01：持锁期间 PUT /api/write 打向 SKILL.md 必须被拒（403）且文件一字未改', async () => {
  const { dir, skills } = tempTree()
  try {
    const sm = await bootSkillsManager(dir, skills)
    try {
      const landing = join(skills, PANEL_NAME, 'SKILL.md')
      const before = readFileSync(landing, 'utf8')
      const path = `/skills-manager/api/write?path=${encodeURIComponent(landing)}`
      const lockPath = holdLock(skills, PANEL_NAME)

      const held = await sm.request('PUT', path, { body: panelBody(true) })
      assert.equal(held.status, 403, `持锁时写面必须 403（实得 ${held.status} ${JSON.stringify(held.data)}）`)
      assert.match(String(held.data.error ?? ''), /锁|lock/i, '拒收原因必须点名锁')
      assert.equal(readFileSync(landing, 'utf8'), before, '被拒的写面不得改动 SKILL.md')

      // 对照腿：释放锁后同一发 PUT 必须 200 且内容落地。
      releaseLock(lockPath)
      const ok = await sm.request('PUT', path, { body: panelBody(true) })
      assert.equal(ok.status, 200, `释放锁后写面必须成功（实得 ${ok.status} ${JSON.stringify(ok.data)}）`)
      assert.match(readFileSync(landing, 'utf8'), /^disable-model-invocation: true$/m)
    } finally {
      await sm.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * 2. 换入窗口复演（真同步器 + 真写者）
 * ------------------------------------------------------------------ */

const windowChild = join(here, 'fixtures', 'child-swap-window-writer.mjs')
const windowRegister = join(here, 'fixtures', 'register-swap-window.mjs')

/**
 * 换入窗口复演：A 阶段（真 `syncBuiltinSkills` + loader hook 在窗口里调用写者）
 * 之后再跑 B 阶段 —— **另一个进程**的"下一次开机"（pid 与 A 不同、A 已退出 ⇒
 * 开头的 `sweepStaleSwapDirs` 不再把旁置副本当成"可能有并发同步"而留着）。
 * @returns {{a: object, b: object}} 两个阶段的事实。
 */
function runWindowReplay(writer) {
  const baseEnv = {
    ...process.env,
    WINDOW_WRITER: writer,
    SKILLS_SYNC_MODULE: join(PACKAGE_ROOT, 'lib', 'coi', 'skills-sync.js'),
    COI_MODULE: join(PACKAGE_ROOT, 'lib', 'coi', 'index.js'),
    FILESETS_MODULE: join(PACKAGE_ROOT, 'lib', 'sync', 'filesets.js'),
    I18N_MODULE: join(PACKAGE_ROOT, 'lib', 'i18n.js'),
    PACKAGED_SKILLS_DIR: join(PACKAGE_ROOT, 'skills'),
  }
  const run = (env) => {
    const result = spawnSync(process.execPath, ['--import', windowRegister, windowChild], {
      env: { ...baseEnv, ...env },
      encoding: 'utf8',
      timeout: 120_000,
    })
    assert.equal(result.status, 0, `child failed: ${result.stderr}`)
    const parsed = JSON.parse(String(result.stdout).trim().split('\n').pop())
    assert.equal(parsed.fatal, undefined, `child fatal: ${parsed.fatal}`)
    return parsed
  }
  const a = run({ PHASE: 'A' })
  try {
    const b = run({ PHASE: 'B', USER_SKILLS: a.userSkills, PKG_SKILLS: a.pkgSkills })
    return { a, b }
  } finally {
    rmSync(join(a.userSkills, '..'), { recursive: true, force: true })
  }
}

test('C4-01 阳性对照：不取锁的写者落进换入窗口 ⇒ 双 ENOTEMPTY + 旧内容不可找回（判据在本环境咬得到）', () => {
  const { a, b } = runWindowReplay('raw')
  assert.equal(a.windowFired, true, '换入窗口没被触发 ⇒ 复演是空转，下面的断言全是假绿')
  assert.equal(a.first?.action, 'synced', '前置：首次同步必须先装上')
  assert.equal(a.writerResult?.ok, true, '阳性对照的写者本来就不该被拦')
  assert.equal(a.second?.action, 'refused', '不取锁的写者必须真的把换入打断')
  assert.equal(a.second?.code, 'SKILL_SWAP_RECOVERY_FAILED', '打断形态必须是"换入+回滚双失败，需人工恢复"')
  assert.match(String(a.destSkill), /FOURTH-WRITER/, '活落点被第四个写者占据')
  assert.ok(a.tmpResidue.some((n) => n.startsWith('.old-')), '旧内容此刻只剩旁置副本这一份')
  // 下一次开机（另一个进程）：两份副本一起被清掉 ⇒ 旧内容不可找回 + 永久拒收。
  assert.equal(b.oldRecoverable, false, '下一次开机会把 .old-*/.staging-* 一起清掉 ⇒ 旧内容不可找回')
  assert.deepEqual(b.tmpResidue, [], '清扫必须把换入残留收干（否则会以幽灵技能候选活到下次启动）')
  assert.equal(b.result?.action, 'refused', '此后该技能被永久拒收')
  assert.equal(b.result?.code, 'SKILL_LOCAL_CONTENT', '永久拒收的形态是 SKILL_LOCAL_CONTENT')
})

test('C4-01 修后：同一个窗口里真实的 COI 写者被锁挡住 ⇒ 换入成功、无 ENOTEMPTY、无永久拒收', () => {
  const { a, b } = runWindowReplay('coi')
  assert.equal(a.windowFired, true, '换入窗口没被触发 ⇒ 复演是空转，下面的断言全是假绿')
  assert.equal(a.first?.action, 'synced', '前置：首次同步必须先装上（此时锁由同步器持有并正常释放）')
  assert.ok(a.writerResult, '窗口里的写者没有被调用（夹具坏了）')
  assert.equal(a.writerResult.ok, false, '持锁期间 COI 写者必须被拒 —— 它一个字都不许写')
  assert.match(String(a.writerResult.message), /锁|lock/i, '拒收文案必须点名锁')
  assert.equal(a.second?.action, 'synced', `换入必须成功（实得 ${JSON.stringify(a.second)}）`)
  assert.equal(a.second?.code, undefined, '不得出现 SKILL_SWAP_RECOVERY_FAILED/SKILL_LOCAL_CONTENT 一类终态')
  assert.match(String(a.destSkill), /PACKAGED-V2/, '活落点必须是新随包内容')
  assert.doesNotMatch(String(a.destSkill), /FOURTH-WRITER/, '第四个写者的内容一个字节都不许落盘')
  assert.deepEqual(a.tmpResidue, [], '换入成功后不得留下 .staging-*/.old-*（也就没有"旧内容不可找回"的第三态）')
  // 下一次开机（另一个进程）：不得永久拒收，技能仍在正常轨道上。
  assert.notEqual(b.result?.action, 'refused', `下一次开机不得永久拒收（实得 ${JSON.stringify(b.result)}）`)
  assert.equal(b.result?.code, undefined)
  assert.match(String(b.destSkill), /PACKAGED-V2/, '下一次开机看到的仍是新随包内容')
})

/* ------------------------------------------------------------------ *
 * 3. 辅助判据（前向网）：落点写者清单双向登记 + 每个写者模块真的参与协议
 * ------------------------------------------------------------------ */

/**
 * 登记表：`<lib 相对路径>` → 这个模块里的**落点写者**与覆盖它的用例。
 *
 * `coveredBy` 会被断言"文件存在且用例名逐字出现" —— 只登记不给判据不算登记
 * （本仓登记表的反面模式：登记表变成免检区）。
 */
const LOCK_PARTICIPANTS = new Map([
  ['skills.js', { writer: 'skill_manage create/patch 直写 + approvePendingSkill 采纳（R18B-03 已收口）', coveredBy: { file: 'tests/skills-landing-lock.test.js', test: 'R18B-03：持锁期间 skill_manage patch 同样不写' } }],
  ['coi/skills-sync.js', { writer: 'syncSkillDirSafe 整目录换入（锁协议实现方/持有者）', coveredBy: { file: 'tests/coi-skills-sync-name-lock.test.js', test: 'F3 安装器持锁（活 pid）时同步 refused + SKILL_LOCKED' } }],
  ['coi/index.js', { writer: 'svc.writeSkill（COI 适配器「AI 使用指南」编辑器）', coveredBy: { file: 'tests/coi-lock-fourth-writer.test.js', test: 'C4-01：持锁期间 COI svc.writeSkill 必须被拒' } }],
  ['coi/api.js', { writer: 'POST /coi/adapters 的自动建技能', coveredBy: { file: 'tests/coi-lock-fourth-writer.test.js', test: 'C4-01：持锁期间 COI 自动建技能路由不得建出落点' } }],
  ['skills-manager.js', { writer: 'applyDisableFlagToFile（面板开关 + 自动投影）与 PUT /skills-manager/api/write', coveredBy: { file: 'tests/coi-lock-fourth-writer.test.js', test: 'C4-01：持锁期间 PUT /api/write 打向 SKILL.md 必须被拒' } }],
])

/** 去注释（判据扫的是代码；散文里出现过同一个函数名）。 */
function blankComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

/** 取所有 `writeFileAtomicSafeAt[Async](...)` 调用（括号配对切出实参文本）。 */
function writeSites(source) {
  const out = []
  const re = /\bwriteFileAtomicSafeAt(?:Async)?\s*\(/g
  let match
  while ((match = re.exec(source)) !== null) {
    let depth = 0
    let k = match.index + match[0].length - 1
    for (; k < source.length; k += 1) {
      const ch = source[k]
      if (ch === '(') depth += 1
      else if (ch === ')') { depth -= 1; if (depth === 0) break }
    }
    out.push({
      line: source.slice(0, match.index).split('\n').length,
      text: source.slice(match.index, k + 1),
      target: source.slice(match.index + match[0].length, k).split(',')[0].trim(),
    })
  }
  return out
}

/** 递归列出 `lib/` 下全部 `.js`（相对 lib，`/` 分隔）。 */
function listLibModules() {
  const out = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) { walk(join(dir, entry.name), rel); continue }
      if (entry.name.endsWith('.js')) out.push(rel)
    }
  }
  walk(join(PACKAGE_ROOT, 'lib'), '')
  return out.sort()
}

/**
 * **角色取面**（与 `tests/anchor-dir-invariant.test.js` 的 C 块同一口径）：一个模块
 * 参与"技能落点写入"的判据 —— 用了唯一落点解析实现、或某个原子写调用带
 * `anchorDir`（正在按库根写技能）、或写入目标文本里出现 `SKILL.md`。
 * @returns {boolean} 是否属于技能落点写者面。
 */
function isLandingWriterModule(source, sites) {
  if (/\bresolveSkillLanding\b/.test(source)) return true
  if (sites.some((site) => /anchorDir/.test(site.text))) return true
  if (sites.some((site) => /SKILL\.md/.test(site.target))) return true
  return false
}

test('C4-01（前向网）：落点写者清单双向登记，且每个写者模块真的取 per-name 锁', () => {
  const found = []
  let sites = 0
  for (const rel of listLibModules()) {
    const source = blankComments(readFileSync(join(PACKAGE_ROOT, 'lib', rel), 'utf8'))
    const calls = writeSites(source)
    if (!isLandingWriterModule(source, calls)) continue
    sites += calls.length
    if (!/acquireSkillDirLock/.test(source)) {
      found.push(`${rel}: 属于技能落点写者面，但整个模块里没有 acquireSkillDirLock`)
      continue
    }
    found.push(rel)
  }
  assert.deepEqual(found.filter((x) => x.includes('没有')), [],
    '这些模块写技能落点却不参与 per-name 锁协议（新增写者请接线到 coi/skills-sync.js 的 acquireSkillDirLock）')
  assert.ok(sites >= 10, `落点写者面的写入调用点至少 10 个（实得 ${sites}）—— 扫描面塌了会让判据空转`)
  // 双向：面内的模块必须登记，登记项也必须在面内（死条目同样红）。
  assert.deepEqual([...found].sort(), [...LOCK_PARTICIPANTS.keys()].sort(),
    '登记表与实测写者面不一致（多一个/少一个都说明清单漂了）')
})

test('C4-01（前向网）：登记项必须带真实存在的覆盖用例（不许"只登记不给判据"）', () => {
  for (const [rel, entry] of LOCK_PARTICIPANTS) {
    const testFile = join(PACKAGE_ROOT, entry.coveredBy.file)
    assert.equal(existsSync(testFile), true, `${rel} 登记的覆盖文件不存在：${entry.coveredBy.file}`)
    assert.match(readFileSync(testFile, 'utf8'), new RegExp(entry.coveredBy.test.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${rel} 登记的覆盖用例在 ${entry.coveredBy.file} 里找不到：${entry.coveredBy.test}`)
  }
})

test('C4-01（前向网）自检：扫描器对"带锁/无锁/非写者"三种形态判定不同', () => {
  const sample = (body) => blankComments(`function f() {\n${body}\n}`)
  const locked = sample('  acquireSkillDirLock(root, name)\n  writeFileAtomicSafeAt(file, text, { anchorDir: root })')
  const unlocked = sample('  writeFileAtomicSafeAt(file, text, { anchorDir: root })')
  const notWriter = sample('  writeFileAtomicSafeAt(stateFile, text)')
  assert.equal(isLandingWriterModule(locked, writeSites(locked)), true)
  assert.equal(/acquireSkillDirLock/.test(locked), true)
  assert.equal(isLandingWriterModule(unlocked, writeSites(unlocked)), true)
  assert.equal(/acquireSkillDirLock/.test(unlocked), false, '无锁形态必须被判为无锁（否则本条是空断言）')
  assert.equal(isLandingWriterModule(notWriter, writeSites(notWriter)), false, '非技能写者不得被卷入面内（否则登记表变噪音）')
  // 注释里的同名调用不算（`lib/skills.js` 的散文里真的有）。
  assert.equal(writeSites(blankComments('// writeFileAtomicSafeAt(a, b, {})\n')).length, 0)
})
