/**
 * tests/advisor-records-landing-symlink.test.js — RECHECK3 NF1-1 回归
 * （`lib/advisor/index.js:189` 的 `appendFile` 裸写）。
 *
 * 缺陷：`ReviewStore` 的追加落点 `<memoryDir>/advisor/records.jsonl` 在**受管
 * 记忆仓库内**，而生产装配把这台追加原语透传成 `node:fs/promises` 的
 * `appendFile(path, data)`（按路径、无任何落点断言）。共享记忆分支把
 * `advisor/`（一条 120000 目录条目）或 `records.jsonl`（一条 120000 文件条目）
 * 实体化成指向仓库外的链接后，评审终态记录会**整行追加到仓库外**，而 ring 里
 * 照样 publish —— 调用方无从感知。R2 新增的「按落点是否被断言」结构哨兵正则
 * 不含 `appendFile`，所以这个洞在哨兵全绿下依然存在（本轮已把哨兵扩到
 * `appendFile|appendFileSync|createWriteStream` 整族，见
 * coi-skill-landing-unasserted-write.test.js）。
 *
 * 本文件走**生产装配**（`installAdvisor` → `advisor/store.js` 的真实追加路径），
 * 并显式 `registerManagedRoot` 模拟真实插件的 `apply()`，覆盖三种落点形态：
 *   1) `records.jsonl` 是符号链接（文件级 120000）；
 *   2) `advisor/` 是符号链接（目录级 120000 —— 第三轮 NF-3 的形态）；
 *   3) 对照组：普通目录，记录必须真的落盘（证明用例不是"什么都没发生"）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installAdvisor } from '../lib/advisor/index.js'
import { registerManagedRoot, unregisterManagedRoot } from '../lib/sync/filesets.js'

const OUTSIDE_TEXT = 'ORIGINAL-OUTSIDE-CONTENT\n'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-advisor-landing-'))
}

/** 最小 agent/session 替身（会话事件流由 feed 驱动）。 */
function stubAgent(id) {
  const events = []
  const session = {
    id,
    header: { cwd: `/proj/${id}` },
    events,
    deriveMessages: () => {
      const out = []
      for (const e of events) {
        if (e.type === 'user/message') out.push(e.data)
        if (e.type === 'assistant/message') {
          if (e.data.message.content.length === 0) continue
          out.push(e.data.message)
        }
        if (e.type === 'tool/result') out.push(e.data.message)
      }
      return out
    },
  }
  const agent = {
    id,
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    session,
    steers: [],
    injects: [],
    steer: (message) => { agent.steers.push(message) },
    inject: (message) => { agent.injects.push(message) },
  }
  return { agent, session }
}

function stubLlm() {
  const llm = {
    calls: [],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }),
    stream(options) {
      llm.calls.push(options)
      const text = '{"note":"建议补单测","severity":"concern"}'
      return {
        [Symbol.asyncIterator]() {
          let done = false
          return {
            next: async () => {
              if (done) return { done: true, value: undefined }
              done = true
              return { done: false, value: { type: 'text-delta', text } }
            },
          }
        },
      }
    },
  }
  return llm
}

/** cordis 最小面（与 advisor-api.test.js 同款，断言只用到事件与 inject）。 */
function makeCtx() {
  const listeners = {}
  const agents = new Map()
  const llm = stubLlm()
  const ctx = {
    get: (key) => {
      if (key === 'agents') return { get: (id) => agents.get(id) }
      if (key === 'llm') return llm
      return undefined
    },
    root: undefined,
    llm,
    logger: () => console,
    on: (event, fn) => {
      ;(listeners[event] ??= []).push(fn)
      return () => { listeners[event] = listeners[event].filter((f) => f !== fn) }
    },
    emit: async (event, ...args) => {
      for (const fn of [...(listeners[event] ?? [])]) {
        if (fn.length > args.length) await fn(...args, () => {})
        else await fn(...args)
      }
    },
    inject: () => ({ dispose: () => {} }),
    commands: [],
    handler: null,
    effectDisposers: [],
    sessionTitle: { get: () => ({ title: '测试会话' }) },
  }
  return { ctx, agents, llm, listeners }
}

const ADVISOR_CONFIG = {
  advisorEnabled: true,
  advisorProvider: null,
  advisorModel: null,
  advisorSystemPrompt: '',
  advisorPanelEnabled: true,
  advisorImmuneTurns: 0,
  advisorSteerSeverities: ['nit', 'concern', 'blocker'],
  advisorMaxMessages: 60,
  advisorMaxQueued: 32,
  advisorCallTimeoutMs: 5000,
}

/**
 * 装配 advisor 并产生一条评审终态记录（review-finished）。
 * @param {string} dataDir - `<memoryDir>/advisor`。
 * @param {string} memoryDir - 受管记忆仓库根（注册进 MANAGED_ROOTS）。
 * @param {number} [waitMs=3000] - 等终态记录的上限（拒绝形态下记录不会出现，
 *   短等即可；对照组要给真实评审留足时间）。
 * @returns {Promise<{installed: object, dataDir: string}>}
 */
async function runOneReview(dataDir, memoryDir, waitMs = 3000) {
  registerManagedRoot(memoryDir)
  const { ctx, agents, listeners } = makeCtx()
  const installed = installAdvisor(ctx, { ...ADVISOR_CONFIG, advisorDataDir: dataDir }, {
    dataDir,
    sessionName: () => '测试会话',
    logger: { debug() {}, warn() {}, info() {} },
  })
  const sessionId = 'session-1'
  const { agent, session } = stubAgent(sessionId)
  agents.set(sessionId, agent)
  listeners['agent/created']?.[0]?.({ agent })
  installed.ctrl.setSessionOverride(sessionId, true)
  let seq = 0
  const feed = (type, data, surfaceOp) => {
    const event = { type, seq: seq++, data, surfaceOp }
    session.events.push(event)
    listeners['session/event']?.forEach((fn) => fn(session, event))
  }
  feed('user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: '帮我写个函数' }], source: { kind: 'user' } }, 'append')
  feed('step/start', { turn: 1 })
  feed('assistant/message', { message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '好的，我来写' }], source: { kind: 'model' } } }, 'append')
  feed('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const started = Date.now()
  while (installed.ctrl.queryRecords({ sessionId }).records.length < 1) {
    if (Date.now() - started > waitMs) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return { installed, dataDir }
}

/**
 * 落点被拒的**正面证据**：store 的 storage-error 事件里必须有这一条落点。
 *
 * 没有它，用例可能在"评审流程根本没走到追加"时也变绿（假绿）。error message
 * 由 `writeTargetRefusedError` 带上落点绝对路径。
 * @param {object} installed - installAdvisor 的返回值。
 * @param {string} needle - 落点路径片段（如 records.jsonl）。
 * @returns {boolean}
 */
function sawRefusedLanding(installed, needle) {
  const { events } = installed.ctrl.queryEvents('session-1', 0, 500)
  return events.some((event) => event.type === 'runtime-status'
    && event.phase === 'storage-error'
    && String(event.error?.message ?? '').includes(needle)
    && String(event.error?.message ?? '').includes('write refused'))
}

function fixture(t, layout) {
  const root = tempDir()
  const memoryDir = join(root, 'mem')
  const outside = join(root, 'outside')
  mkdirSync(memoryDir, { recursive: true })
  mkdirSync(outside, { recursive: true })
  layout({ memoryDir, outside })
  t.after(() => {
    unregisterManagedRoot(memoryDir)
    rmSync(root, { recursive: true, force: true })
  })
  return { memoryDir, outside, dataDir: join(memoryDir, 'advisor') }
}

test('advisor: a symlinked records.jsonl inside the managed root is refused (no append outside)', async (t) => {
  let victim
  const { memoryDir, outside, dataDir } = fixture(t, ({ memoryDir: mem, outside: out }) => {
    mkdirSync(join(mem, 'advisor'), { recursive: true })
    victim = join(out, 'records.jsonl')
    writeFileSync(victim, OUTSIDE_TEXT)
    symlinkSync(victim, join(mem, 'advisor', 'records.jsonl'))
  })
  const { installed } = await runOneReview(dataDir, memoryDir, 800)
  t.after(() => { try { installed.dispose() } catch { /* 已清理 */ } })

  assert.equal(readFileSync(victim, 'utf8'), OUTSIDE_TEXT, '评审记录被追加写到了仓库外的链接目标')
  assert.equal(sawRefusedLanding(installed, 'records.jsonl'), true, '没有看到 records.jsonl 落点被拒的 storage-error（用例可能在流程未触达时假绿）')
  assert.equal(installed.ctrl.queryRecords({ sessionId: 'session-1' }).records.length, 0, '落点被拒却把记录当成已持久化（ring 里 publish 了）')
})

test('advisor: a symlinked advisor/ directory inside the managed root is refused too (NF-3 form)', async (t) => {
  let victim
  const { memoryDir, outside, dataDir } = fixture(t, ({ memoryDir: mem, outside: out }) => {
    // 共享分支里 `<memoryDir>/advisor` = 120000 → ../outside/advisor
    const outDir = join(out, 'advisor')
    mkdirSync(outDir, { recursive: true })
    victim = join(outDir, 'records.jsonl')
    writeFileSync(victim, OUTSIDE_TEXT)
    symlinkSync(outDir, join(mem, 'advisor'))
  })
  const { installed } = await runOneReview(dataDir, memoryDir, 800)
  t.after(() => { try { installed.dispose() } catch { /* 已清理 */ } })

  assert.equal(readFileSync(victim, 'utf8'), OUTSIDE_TEXT, '目录级链接把评审记录带到了仓库外')
  assert.equal(installed.ctrl.queryRecords({ sessionId: 'session-1' }).records.length, 0)
})

test('advisor: a plain advisor/ directory still receives the record (control)', async (t) => {
  const { memoryDir, dataDir } = fixture(t, ({ memoryDir: mem }) => {
    mkdirSync(join(mem, 'advisor'), { recursive: true })
  })
  const { installed } = await runOneReview(dataDir, memoryDir)
  t.after(() => { try { installed.dispose() } catch { /* 已清理 */ } })

  const records = installed.ctrl.queryRecords({ sessionId: 'session-1' }).records
  assert.equal(records.length, 1, '对照组：普通目录下记录必须真的落盘')
  const text = readFileSync(join(dataDir, 'records.jsonl'), 'utf8')
  assert.match(text, /"type":"review-finished"/, 'records.jsonl 里没有评审终态记录')
})
