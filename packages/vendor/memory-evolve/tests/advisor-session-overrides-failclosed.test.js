/**
 * tests/advisor-session-overrides-failclosed.test.js — FIX-47① 判据（第三十二轮）：
 * `session-overrides.json` 的**装载期读失败**不得被"整表回写"固化成一次静默丢状态。
 *
 * ## 缺陷原形态（第三十一轮 AD1，P1；**上一轮已逐字登记却漏派**）
 *
 * `lib/advisor/index.js` 装载 override 时是**裸 `catch {}`**（EACCES/EIO/EISDIR 与
 * "文件不存在"被压成同一个值 ⇒ 从空 Map 起步），而 `persistOverrides()` 是
 * **整张 Map 回写**。真 EACCES（setpriv 到 nobody）实测：
 *
 *   seed `{"session-0":true,"session-9":true}` → 一次 `POST /toggle`
 *   （**HTTP 200 `ok:true`**）→ 文件变 `{"session-1":true}`；
 *   装载期可读的对照组里三条都在。
 *
 * 这与 FIX-45③ 收口的六处是**同一形态**（读失败降级成空基线 ⇒ 被写路径固化），
 * 而且与 `temp/r21/fix-44/REPORT.md:397-401` 逐字登记过的"一次瞬时 EACCES 清空
 * 全部会话级开关"是同一件事。
 *
 * ## 口径（与 FIX-45③ 的 `ScopeStore.readBaseline` 完全同形，不自创第三种）
 *
 * **只有 ENOENT（以及空文件）算"没有基线"**；其余读失败 / 内容不可解析 /
 * 顶层不是对象 ⇒ 记标记（可检索日志含 `refuse`）+ **写前闸门拒写**。
 * 闸门在**改内存之前**：否则界面显示"开了"、盘上没有，刷新即静默回退。
 * 恢复可读后自愈：重试读成功 ⇒ **先把盘上基线并回内存再放行**（否则自愈后的
 * 第一次写仍会以空 Map 回写，等于把同一个缺陷推迟到下一次调用）。
 *
 * ## 判据（每格都要有，缺任何一条都有假绿空间）
 *
 *  A. 读失败 ⇒ `setSessionOverride` **抛出**（可判别，不是静默 200）；
 *  B. 读失败 ⇒ 盘上**一次写都没发生**（文件逐字节不变）；
 *  C. 读失败 ⇒ 日志里留下**可检索**的拒写原因（含 `refuse`）；
 *  D. 正向对照：ENOENT = 首次使用 ⇒ **照常落盘**；
 *  E. 正向对照：**内容不可解析**与读失败同判（半截写 / git 冲突标记）；
 *  F. 自愈：读失败后文件恢复可读 ⇒ 同一实例的下一次 toggle 成功，且**盘上原有
 *     的其它会话开关仍在**（证明自愈不是"以空 Map 放行"）。
 *
 * ## 真 EACCES（跨 uid）证据不在本文件
 *
 * 本套件跑在 root 下（`chmod 000` 对 root 无效），所以用**符号链接自环**（ELOOP）
 * 造一个真实的非 ENOENT 读错误。真 EACCES 的端到端两格（修前红 / 修后绿）在
 * `temp/r21/fix-47/probe/` 的 `run-q1.sh`（`setpriv --reuid=65534`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installAdvisor } from '../lib/advisor/index.js'
import { validateRuntimePatch } from '../lib/index.js'
import { setLocale } from '../lib/i18n.js'

setLocale('zh')

const OVERRIDES = 'session-overrides.json'
const SEED = JSON.stringify({ 'session-0': true, 'session-9': true })
const OTHER_KEYS = ['session-0', 'session-9']

const tempDir = () => mkdtempSync(join(tmpdir(), 'dsh-fix47-overrides-'))

/** 让 `path` 变成读一次必 ELOOP 的符号链接自环。 */
function makeUnreadable(path) {
  symlinkSync(`${path}.loop-b`, path)
  symlinkSync(path, `${path}.loop-b`)
}

/** 撤掉自环，换回一份可读的 seed（模拟"权限/占用恢复"）。 */
function restoreReadable(path, content = SEED) {
  rmSync(path, { force: true })
  rmSync(`${path}.loop-b`, { force: true })
  writeFileSync(path, content)
}

/** 造一条真 `installAdvisor` 实例（真装配，不是桩）。 */
function install(dir) {
  const warnings = []
  const logger = {
    debug() {}, info() {},
    warn: (...args) => warnings.push(args.map(String).join(' ')),
    error: (...args) => warnings.push(args.map(String).join(' ')),
  }
  const agents = new Map()
  for (const id of ['session-0', 'session-1', 'session-9']) {
    agents.set(id, { id, options: {}, session: { id, header: { cwd: '/proj/A' }, events: [] } })
  }
  const ctx = {
    get: (name) => (name === 'agents' ? { get: (id) => agents.get(id) } : undefined),
    logger: () => logger,
    on: () => () => {},
    emit: async () => {},
    inject: (keys, cb) => cb({
      commands: { register: () => () => {} },
      webServer: { register: () => () => {} },
      effect: (fn) => { const d = fn(); return () => { try { d?.() } catch { /* noop */ } } },
    }),
  }
  const installed = installAdvisor(ctx, {
    advisorEnabled: true, advisorDataDir: dir, advisorProvider: null, advisorModel: null,
    advisorSystemPrompt: '', advisorPanelEnabled: true, advisorImmuneTurns: 0,
    advisorSteerSeverities: ['nit', 'concern', 'blocker'], advisorMaxMessages: 60,
    advisorMaxQueued: 32, advisorCallTimeoutMs: 5000,
  }, { dataDir: dir, sessionName: () => 's', logger, validatePatch: validateRuntimePatch })
  return { ...installed, warnings, refusals: () => warnings.filter((l) => l.includes('refuse')).length }
}

/** `installAdvisor` 的 single-reviewer claim 是进程级：拿不到会返回 `ctrl: null`。 */
function assertSingleReviewer(inst) {
  assert.ok(inst.ctrl, 'installAdvisor 必须拿到 reviewer claim（同一进程内上一个实例要先 dispose）')
}

const attempt = (fn) => {
  try { return { threw: false, value: fn() } } catch (error) { return { threw: true, message: String(error?.message ?? error) } }
}

test('FIX-47① / session-overrides：装载期读失败（ELOOP）⇒ toggle 抛出、盘上零改动、日志含 refuse', () => {
  const dir = tempDir()
  try {
    const file = join(dir, OVERRIDES)
    makeUnreadable(file)
    const inst = install(dir)
    try {
      assertSingleReviewer(inst)
      const result = attempt(() => inst.ctrl.setSessionOverride('session-1', true))
      assert.equal(result.threw, true, '基线不可读时必须**拒写并抛出**（修前：HTTP 200 静默把整表换成 {session-1}）')
      assert.match(result.message, /拒绝写入/u, `抛出的文案必须可判别，实得 ${JSON.stringify(result.message)}`)
      assert.ok(inst.refusals() >= 1, `日志里必须留下可检索的拒写原因，实得 ${JSON.stringify(inst.warnings)}`)

      // 盘上零改动：自环还在（没被原子写替换成一个新文件）。
      const after = attempt(() => readFileSync(file, 'utf8'))
      assert.equal(after.threw, true, '拒写后不得出现一个"看起来正常"的新文件')
      assert.equal(after.message.includes('ELOOP'), true, `自环必须原样保留，实得 ${after.message}`)
    } finally { inst.dispose() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FIX-47① / session-overrides（正向对照）：ENOENT = 首次使用 ⇒ 照常落盘', () => {
  const dir = tempDir()
  try {
    const inst = install(dir)
    try {
      const result = attempt(() => inst.ctrl.setSessionOverride('session-1', true))
      assert.equal(result.threw, false, `首次使用必须照常放行，实得 ${JSON.stringify(result.message)}`)
      assert.deepEqual(JSON.parse(readFileSync(join(dir, OVERRIDES), 'utf8')), { 'session-1': true })
    } finally { inst.dispose() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FIX-47① / session-overrides（正向对照）：内容不可解析与读失败同判', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, OVERRIDES), '{"session-0":true,"session-9":tru')  // 半截写
    const inst = install(dir)
    try {
      const result = attempt(() => inst.ctrl.setSessionOverride('session-1', true))
      assert.equal(result.threw, true, '半截 JSON 不得被当成"空基线"再回写')
      assert.equal(readFileSync(join(dir, OVERRIDES), 'utf8'), '{"session-0":true,"session-9":tru',
        '被拒的写入不得改动原字节')
    } finally { inst.dispose() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FIX-47① / session-overrides（自愈）：读失败后恢复可读 ⇒ 下一次 toggle 成功且其它会话开关仍在', () => {
  const dir = tempDir()
  try {
    const file = join(dir, OVERRIDES)
    makeUnreadable(file)
    const inst = install(dir)
    try {
      assert.equal(attempt(() => inst.ctrl.setSessionOverride('session-1', true)).threw, true, '先决条件：此刻是拒写态')

      restoreReadable(file, SEED)  // 恢复可读（失败原因消失）

      const result = attempt(() => inst.ctrl.setSessionOverride('session-2', true))
      assert.equal(result.threw, false, `恢复可读后必须自愈放行，实得 ${JSON.stringify(result.message)}`)
      const written = JSON.parse(readFileSync(file, 'utf8'))
      assert.equal(written['session-2'], true, '本次 toggle 必须落盘')
      for (const key of OTHER_KEYS) {
        assert.equal(written[key], true, `自愈放行不得以空基线回写（${key} 被抹掉了）：${JSON.stringify(written)}`)
      }
    } finally { inst.dispose() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FIX-47① / session-overrides（对照）：装载期可读 ⇒ 同一个动作保留其它会话', () => {
  const dir = tempDir()
  try {
    const file = join(dir, OVERRIDES)
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, SEED)
    const inst = install(dir)
    try {
      const result = attempt(() => inst.ctrl.setSessionOverride('session-1', true))
      assert.equal(result.threw, false)
      const written = JSON.parse(readFileSync(file, 'utf8'))
      assert.deepEqual(Object.keys(written).sort(), ['session-0', 'session-1', 'session-9'])
    } finally { inst.dispose() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
