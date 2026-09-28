/**
 * FIX-45③（第三十轮审计，2026-09-29）回归：`lib/advisor/` 的三处持久化**不得把
 * "读失败"降级成"空状态"再由写路径固化**。
 *
 * ## 现场（真跑见 temp/r21/fix-45/probe/ 的两个探针）
 *
 * `lib/advisor/index.js` 注入的三个 reader 修前是**裸 catch**：`readFile → ''`、
 * `readConversation → null`，把 EACCES/EMFILE/EIO 与"文件不存在"压成同一个值。
 * `ScopeStore.setProject` / `setConversation`、`InstructionQueue.add`、
 * `AdvisorConversation.persist` 全是 read-modify-write，于是**一次瞬时读失败**就：
 *   · 抹掉 project-scopes.json 里**其它所有项目**的约束文本；
 *   · 把评审会话文件的 `epoch` 从 7 掉回 1、`messages` 清空（整段评审历史）；
 *   · 抹掉该会话**全部待处理指令**；
 * 且 HTTP 回 `200 {ok:true}`、**零告警**。
 *
 * ## 口径（与 `lib/skills.js`（AB2-04）/`lib/coi/index.js` 同形，不自创第三种）
 *
 * **只有 ENOENT 算"不存在"**；其余读失败 ⇒ 记标记 + 可检索日志 + **fail-closed 拒写**。
 * 真的"文件不存在（首次使用）"必须**照常放行**（下面每组都配了正向对照，防
 * "无条件拒写"蒙混过关）。
 *
 * ## 判据
 *
 * 每组三条，缺一不可：
 *   ① 该动作**抛出**（可判别结果，不是静默 200）；
 *   ② **一次写都没发生**（`writeFile`/`writeConversation`/`save` 调用计数为 0）；
 *   ③ 留了一条**可检索**的日志（含 `refuse`）；
 * 外加 ④ 正向：把读失败换成 ENOENT ⇒ 同一个动作**必须成功落盘**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdvisorConversation } from '../lib/advisor/conversation.js'
import { InstructionQueue } from '../lib/advisor/instructions.js'
import { ScopeStore } from '../lib/advisor/scopes.js'

/** 造一个带 errno 的读错误。 */
const readError = (code) => Object.assign(new Error(`${code}: permission denied`), { code })

/** 记日志的桩（可检索面 = 含 `refuse` 的行数）。 */
function makeLogger() {
  const lines = []
  return {
    lines,
    warn: (...args) => lines.push(args.map(String).join(' ')),
    refusals: () => lines.filter((line) => line.includes('refuse')).length,
  }
}

/** 一次性临时数据目录（测试自己清理）。 */
const tempDir = () => mkdtempSync(join(tmpdir(), 'dsh-fix45-advisor-'))

const SEED = JSON.stringify({ '/proj/A': 'A 的规则', '/proj/B': 'B 的规则', '/proj/C': 'C 的规则' })

/** 造一个 ScopeStore（写面全部计数）。 */
function makeStore(readFile) {
  const writes = []
  const conversations = []
  const store = new ScopeStore({
    writeFile: (rel, data) => writes.push({ rel, data }),
    readFile,
    conversationFileOf: (sessionId) => `conversations/${sessionId}.json`,
    writeConversation: (rel, data) => conversations.push({ rel, data }),
  })
  return { store, writes, conversations }
}

// ---------------------------------------------------------------------------
// ① 项目约束：读失败 ⇒ 拒写（否则抹掉**别的项目**）
// ---------------------------------------------------------------------------

test('FIX-45③ / 项目约束：读失败（EACCES）⇒ setProject 拒写且一次都没落盘', () => {
  const logger = makeLogger()
  const { store, writes } = makeStore(() => { throw readError('EACCES') })
  assert.equal(store.projectOf('/proj/A', logger), '')     // 读面降级（评审不阻断）…
  assert.throws(() => store.setProject('/proj/A', 'A 的新规则', logger), /拒绝写入/u)
  assert.equal(writes.length, 0, '读失败时写路径必须一次都不落盘（否则整文件被空基线覆盖）')
  assert.ok(logger.refusals() >= 1, `日志里必须留下可检索的拒写原因，实得 ${JSON.stringify(logger.lines)}`)
})

test('FIX-45③ / 项目约束：**内容不可解析**与读失败同判（半截写 / git 冲突标记）', () => {
  const logger = makeLogger()
  const { store, writes } = makeStore(() => '<<<<<<< HEAD\n{}')
  assert.throws(() => store.setProject('/proj/A', 'A 的新规则', logger), /拒绝写入/u)
  assert.equal(writes.length, 0)
})

test('FIX-45③ / 项目约束（正向）：ENOENT = 首次使用 ⇒ 照常落盘，其它项目不受影响', () => {
  const logger = makeLogger()
  const { store, writes } = makeStore(() => { throw readError('ENOENT') })
  assert.equal(store.setProject('/proj/A', 'A 的新规则', logger), 'A 的新规则')
  assert.equal(writes.length, 1)
  assert.deepEqual(JSON.parse(writes[0].data), { '/proj/A': 'A 的新规则' })
})

test('FIX-45③ / 项目约束（正向）：读成功时合并写**保留**其它项目', () => {
  const logger = makeLogger()
  const { store, writes } = makeStore(() => SEED)
  store.setProject('/proj/A', 'A 的新规则', logger)
  assert.equal(writes.length, 1)
  assert.deepEqual(JSON.parse(writes[0].data), {
    '/proj/A': 'A 的新规则', '/proj/B': 'B 的规则', '/proj/C': 'C 的规则',
  })
})

// ---------------------------------------------------------------------------
// ② 评审会话：读失败 ⇒ 拒写（否则抹掉评审员整段历史 + epoch）
// ---------------------------------------------------------------------------

const CONV_SEED = JSON.stringify({
  epoch: 7,
  messages: [{ role: 'user', text: '第1条' }, { role: 'assistant', text: '第2条' }],
})

test('FIX-45③ / 评审会话：读失败（EACCES）⇒ setConversation 拒写且不覆盖 messages/epoch', () => {
  const logger = makeLogger()
  const { store, conversations } = makeStore(() => { throw readError('EACCES') })
  assert.throws(() => store.setConversation('session-1', '这次重点看并发', logger), /拒绝写入/u)
  assert.equal(conversations.length, 0, '读失败时不得回写 conversation 文件')
  assert.ok(logger.refusals() >= 1)
})

test('FIX-45③ / 评审会话（正向）：读成功时**保留** messages/epoch，只改 scopeText', () => {
  const logger = makeLogger()
  const { store, conversations } = makeStore(() => CONV_SEED)
  store.setConversation('session-1', '这次重点看并发', logger)
  assert.equal(conversations.length, 1)
  const written = JSON.parse(conversations[0].data)
  assert.equal(written.epoch, 7)
  assert.equal(written.messages.length, 2)
  assert.equal(written.scopeText, '这次重点看并发')
})

test('FIX-45③ / 评审会话（正向）：ENOENT = 首次使用 ⇒ 建新会话文件', () => {
  const logger = makeLogger()
  const { store, conversations } = makeStore(() => { throw readError('ENOENT') })
  store.setConversation('session-1', '这次重点看并发', logger)
  assert.equal(conversations.length, 1)
  assert.deepEqual(JSON.parse(conversations[0].data), {
    epoch: 1, messages: [], scopeText: '这次重点看并发',
  })
})

// ---------------------------------------------------------------------------
// ③ 指令队列：读失败 ⇒ 拒写（否则抹掉该会话全部待处理指令）
// ---------------------------------------------------------------------------

/** 造一个 InstructionQueue（写面计数）。 */
function makeQueue(readFile) {
  const writes = []
  const queue = new InstructionQueue({
    writeFile: (path, data) => writes.push({ path, data }),
    fileFor: (sessionId) => `/data/instructions/${sessionId}.json`,
    readFile,
    now: () => 1,
  })
  return { queue, writes }
}

const INSTR_SEED = JSON.stringify([
  { id: 'i-1', createdAt: 1, text: '重点检查安全漏洞', state: 'pending' },
  { id: 'i-2', createdAt: 2, text: '关注并发', state: 'pending' },
])

test('FIX-45③ / 指令队列：读失败（EACCES）⇒ add 拒写且既有指令不被覆盖', () => {
  const logger = makeLogger()
  const { queue, writes } = makeQueue(() => { throw readError('EACCES') })
  assert.deepEqual(queue.pending('session-1'), [])            // 读面降级…
  assert.throws(() => queue.add('session-1', '第三条指令', logger), /拒绝写入/u)
  assert.equal(writes.length, 0, '读失败时不得回写队列文件')
  assert.ok(logger.refusals() >= 1)
})

test('FIX-45③ / 指令队列（正向）：ENOENT = 首次使用 ⇒ 照常落盘', () => {
  const logger = makeLogger()
  const { queue, writes } = makeQueue(() => { throw readError('ENOENT') })
  const item = queue.add('session-1', '第一条指令', logger)
  assert.equal(item.text, '第一条指令')
  assert.equal(writes.length, 1)
  assert.deepEqual(JSON.parse(writes[0].data).map((row) => row.text), ['第一条指令'])
})

test('FIX-45③ / 指令队列：闸门在**唯一写入口** persist 上，不是只在 add 一处', () => {
  // 变异验证（M4）暴露过这一格：把 persist 里的闸门删掉，`add()` 自己那道闸门会把
  // 结果遮住 —— 于是 reserve / clearPending / persistAll 与将来新增的调用点全部裸奔。
  // 判据钉在**写入口**：loadFailed 置位后直接调 persist 必须抛，且一次都不落盘。
  const logger = makeLogger()
  const { queue, writes } = makeQueue(() => { throw readError('ENOENT') })
  queue.load('session-1', logger)            // ENOENT ⇒ 空队列（正常首次使用）
  queue.loadFailed.add('session-1')          // 模拟"这个会话的基线这一次读不出来"
  assert.throws(() => queue.persist('session-1'), /拒绝写入/u)
  assert.equal(writes.length, 0, 'persist 是唯一写入口，闸门必须在这里也在')
})

test('FIX-45③ / 指令队列（正向）：读成功时追加**不丢**既有 pending', () => {
  const logger = makeLogger()
  const { queue, writes } = makeQueue(() => INSTR_SEED)
  queue.add('session-1', '第三条指令', logger)
  assert.deepEqual(JSON.parse(writes[0].data).map((row) => row.text),
    ['重点检查安全漏洞', '关注并发', '第三条指令'])
})

// ---------------------------------------------------------------------------
// ④ 评审会话对象：读失败 ⇒ 拒写（否则 append/reset 把空基线固化）
// ---------------------------------------------------------------------------

test('FIX-45③ / AdvisorConversation：读失败 ⇒ persist 拒写，reset 抛出（不覆盖 epoch/历史）', () => {
  const saved = []
  const conversation = new AdvisorConversation({
    load: () => { throw readError('EACCES') },
    save: (...args) => saved.push(args),
  })
  assert.equal(conversation.length, 0)                 // 读面降级（评审不阻断）
  assert.throws(() => conversation.reset(), /拒绝新建评审会话/u)
  assert.equal(saved.length, 0, '读失败时 persist 必须不落盘')
  conversation.appendUser('**user**: 你好')             // 内存照常推进…
  assert.equal(saved.length, 0, '…但一次都不许回写')
  assert.equal(conversation.persist(), false)
})

test('FIX-45③ / AdvisorConversation（正向）：读成功 ⇒ append/reset 照常落盘', () => {
  const saved = []
  let epoch = 7
  const conversation = new AdvisorConversation({
    load: () => ({ epoch: 7, messages: [{ role: 'user', text: '第1条' }] }),
    save: (nextEpoch, messages) => { epoch = nextEpoch; saved.push([nextEpoch, messages.length]) },
  })
  assert.equal(conversation.length, 1)
  conversation.appendAssistant('[nit] 建议补单测')
  assert.deepEqual(saved.at(-1), [7, 2])
  assert.equal(conversation.reset(), 8)
  assert.equal(epoch, 8)
})

test('FIX-45③ / AdvisorConversation（正向）：没有写通道 ⇒ 不抛也不写', () => {
  const conversation = new AdvisorConversation({ load: () => null })
  assert.equal(conversation.persist(), false)
  assert.equal(conversation.length, 0)
})

// ---------------------------------------------------------------------------
// ⑤ 生产接线：**驱动真实 `installAdvisor`**（不是只测三个类）
//
// 为什么必须有这一组：上面四组把抛错的 reader 直接注进类里，测的是**类的契约**；
// 而缺陷的入口还有一半在 `lib/advisor/index.js` 的三个注入 reader（修前是裸 `catch`）。
// 只把类改好、reader 仍是裸 catch，线上照样抹数据。这里用**确定性**的读失败形态：
// 把目标路径造成**目录** ⇒ `readFileSync` 抛 `EISDIR`（不是 ENOENT），
// root 下也能复现（不需要 setpriv）。
// 端到端形态（真 EACCES + setpriv 到 nobody）见 temp/r21/fix-45/probe/。
// ---------------------------------------------------------------------------

const installAdvisorDeps = async () => {
  const { installAdvisor } = await import('../lib/advisor/index.js')
  const { validateRuntimePatch } = await import('../lib/index.js')
  return { installAdvisor, validateRuntimePatch }
}

/** 真装 advisor（真实 readFile/writeFile 接线），返回 `{ ctrl, dispose, dir }`。 */
async function installReal(dir) {
  const { installAdvisor, validateRuntimePatch } = await installAdvisorDeps()
  const agents = new Map()
  const warnings = []
  const logger = {
    debug() {}, info() {},
    warn: (...args) => warnings.push(args.map(String).join(' ')),
    error() {},
  }
  const ctx = {
    logger: () => logger,
    get: (name) => (name === 'agents' ? { get: (id) => agents.get(id) } : undefined),
    on: () => () => {},
    emit: async () => {},
    inject: (keys, cb) => cb({
      commands: { register: () => () => {} },
      webServer: { register: () => () => {} },
      effect: (fn) => { const d = fn(); return () => { try { d?.() } catch { /* noop */ } } },
    }),
  }
  agents.set('session-1', {
    id: 'session-1', options: {}, session: { id: 'session-1', header: { cwd: '/proj/A' }, events: [] },
  })
  const config = {
    advisorEnabled: true, advisorDataDir: dir, advisorProvider: null, advisorModel: null,
    advisorSystemPrompt: '', advisorPanelEnabled: true, advisorImmuneTurns: 0,
    advisorSteerSeverities: ['nit', 'concern', 'blocker'], advisorMaxMessages: 60,
    advisorMaxQueued: 32, advisorCallTimeoutMs: 5000,
  }
  const installed = installAdvisor(ctx, config, {
    dataDir: dir, sessionName: () => 's', logger, validatePatch: validateRuntimePatch,
  })
  return { ...installed, warnings, logger }
}

test('FIX-45③ / 生产接线：目标路径是**目录**（EISDIR，不是 ENOENT）⇒ 三处都必须拒写且不落盘', async () => {
  const dir = tempDir()
  try {
    // 三个"基线文件"都造成目录 ⇒ readFileSync 抛 EISDIR。
    mkdirSync(join(dir, 'project-scopes.json'))
    mkdirSync(join(dir, 'instructions'), { recursive: true })
    mkdirSync(join(dir, 'instructions', 'session-1.json'))
    mkdirSync(join(dir, 'conversations'), { recursive: true })
    mkdirSync(join(dir, 'conversations', 'session-1.json'))
    const { ctrl, dispose, warnings } = await installReal(dir)
    assert.throws(() => ctrl.saveScope('session-1', 'project', 'A 的新规则'), /拒绝写入|读失败|不可解析/u)
    assert.throws(() => ctrl.saveScope('session-1', 'conversation', '这次重点看并发'), /拒绝写入|读失败|不可解析/u)
    assert.throws(() => ctrl.tell('session-1', '第三条指令'), /拒绝写入/u)
    // 三个落点仍然是目录（一次都没被写成文件）。
    assert.ok(statSync(join(dir, 'project-scopes.json')).isDirectory())
    assert.ok(statSync(join(dir, 'instructions', 'session-1.json')).isDirectory())
    assert.ok(statSync(join(dir, 'conversations', 'session-1.json')).isDirectory())
    assert.ok(warnings.filter((line) => line.includes('refuse')).length >= 3,
      `读失败必须留可检索的拒写日志，实得 ${JSON.stringify(warnings)}`)
    dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FIX-45③ / 生产接线（正向）：三个落点都不存在（首次使用）⇒ 三处都必须照常落盘', async () => {
  const dir = tempDir()
  try {
    const { ctrl, dispose } = await installReal(dir)
    ctrl.saveScope('session-1', 'project', '首次项目约束')
    ctrl.saveScope('session-1', 'conversation', '首次评审约束')
    ctrl.tell('session-1', '首次指令')
    assert.ok(readFileSync(join(dir, 'project-scopes.json'), 'utf8').includes('首次项目约束'))
    assert.ok(readFileSync(join(dir, 'conversations', 'session-1.json'), 'utf8').includes('首次评审约束'))
    assert.ok(readFileSync(join(dir, 'instructions', 'session-1.json'), 'utf8').includes('首次指令'))
    dispose()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
