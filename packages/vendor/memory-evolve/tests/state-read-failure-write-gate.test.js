/**
 * tests/state-read-failure-write-gate.test.js — FIX-47① 判据（第三十二轮）：
 * `plugin-state.json` 的**装载期读失败**不得被"以空状态整文件回写"固化。
 *
 * ## 缺陷原形态（第三十一轮 AD1 Q1d，真 EACCES）
 *
 * `lib/index.js` 的 `loadState()` 对**非 ENOENT** 的读失败（EACCES/EIO/EISDIR…）
 * 只 `warn` 就 `return {}`，而**解析失败**分支反而会 `quarantineState()` 留档 ——
 * 这个**不对称**本身就是线索：读失败时 `updateRuntime()` 写的
 * `{...state, ...patch}` 以空对象为基线，于是
 *
 *   seed `{advisorEnabled,advisorModel,reviewEnabled,skillReviewEnabled}`
 *   → `POST /memory-evolve/api/config`（patch 只含 advisorModel）
 *   → **HTTP 200**，文件被换成 `{"advisorModel":"NEW-MODEL"}`，
 *     三个已持久化覆盖项静默消失，且**原字节当场被覆盖、不可恢复**。
 *
 * ## 口径（两条一起才闭环）
 *
 *  1. **留档对齐**：读失败与解析失败走同一条 `quarantineState()`（原字节改名保存 +
 *     写 `<stateFile>.quarantined.json` 标记 ⇒ 用户可感知）；
 *  2. **写前闸门**：本次运行的基线**未知** ⇒ `updateRuntime()` 抛错（HTTP 400、
 *     `applyRuntimePatch` 整批回滚），绝不"以空状态回写"。留档成功也不解除闸门：
 *     重启后文件已不存在（ENOENT）才会回到可写。
 *
 * ## 判据
 *
 *  A. 读失败 ⇒ 请求 **400**（不是 200）+ 盘上**没有**新写的状态文件 + 原字节进了留档件；
 *  B. 读失败 ⇒ 用户可见的留档标记（`.quarantined.json`）存在；
 *  C. 正向对照：ENOENT = 首次运行 ⇒ 照常 200 且文件被创建；
 *  D. 正向对照：健康文件 ⇒ 200 且**其它键全部保留**（防"无条件拒写"蒙混）；
 *  E. 解析失败（既有行为，不改）：照常 200 + 原字节留档 ⇒ 记住这两格的**有意差异**
 *     （半截 JSON 的字节已知不可解释、已留档并告知；读失败的字节**从未被看到**，
 *     所以只有它必须拒写）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { setLocale } from '../lib/i18n.js'

setLocale('zh')

const STATE = 'plugin-state.json'
const SEED = {
  advisorEnabled: true, advisorModel: 'seed-model', reviewEnabled: true, skillReviewEnabled: true,
}

const tempDir = () => mkdtempSync(join(tmpdir(), 'dsh-fix47-state-'))

/** 最小 fake ctx：`apply()` 到工具/快照/API 注册所需。 */
function fakeCtx() {
  const once = (fn) => { let active = true; return () => { if (!active) return; active = false; fn?.() } }
  const state = { tools: [], contexts: [], commands: [], routes: [] }
  const services = {
    tools: {
      register(def) {
        state.tools.push(def)
        return once(() => { const i = state.tools.indexOf(def); if (i >= 0) state.tools.splice(i, 1) })
      },
      get: () => undefined,
    },
    systemPrompt: { context: (def) => { state.contexts.push(def); return () => {} } },
    commands: { register: (def) => { state.commands.push(def); return () => {} } },
    webServer: {
      register(route) {
        state.routes.push(route)
        return once(() => { const i = state.routes.indexOf(route); if (i >= 0) state.routes.splice(i, 1) })
      },
    },
  }
  const settingsService = { get: (ns) => (ns === 'locale' ? { preference: 'zh' } : undefined) }
  const ctx = {
    state,
    tools: services.tools,
    systemPrompt: services.systemPrompt,
    commands: services.commands,
    webServer: services.webServer,
    on: () => () => {},
    // 与其它套件同形：回调拿到的是**同一个 ctx**（lib/index.js:2077 会用 webCtx.effect）。
    inject: (deps, callback) => (deps.every((d) => services[d] !== undefined)
      ? { dispose: callback(ctx) ?? (() => {}) }
      : { dispose: () => {} }),
    get: (key) => services[key] ?? (key === 'settings' ? settingsService : undefined),
    effect: (fn) => fn() ?? (() => {}),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  return ctx
}

/** 真 HTTP 上打一次面板保存（同源 Origin 是统一写守卫的硬要求）。 */
async function postConfig(memoryDir, patch) {
  const ctx = fakeCtx()
  assert.doesNotThrow(() => apply(ctx, { memoryDir }), '装载不得因状态文件不可读而失败')
  assert.ok(ctx.state.tools.some((t) => t.name === 'memory'), 'memory 工具必须照常注册')
  const route = ctx.state.routes.find((candidate) => candidate.path === '/memory-evolve')
  assert.ok(route, 'memory-evolve API 路由必须注册')
  const server = createServer((req, res) => route.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const response = await fetch(`${base}/memory-evolve/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ patch }),
    })
    return { status: response.status, body: await response.json() }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const backupsOf = (dir) => readdirSync(dir).filter((n) => n.startsWith(`${STATE}.corrupt-`) && n.endsWith('.bak'))

test('FIX-47① / plugin-state：读失败（ELOOP）⇒ 面板保存 400、盘上不产生新状态文件', async () => {
  const dir = tempDir()
  try {
    const file = join(dir, STATE)
    symlinkSync(`${file}.loop-b`, file)
    symlinkSync(file, `${file}.loop-b`)

    const result = await postConfig(dir, { advisorModel: 'NEW-MODEL' })
    assert.equal(result.status, 400, `读失败时必须拒写（修前：200 且文件被换成 {advisorModel}），实得 ${JSON.stringify(result)}`)
    assert.match(String(result.body?.error ?? ''), /不可读|拒绝写入/u, `错误信封必须可判别，实得 ${JSON.stringify(result.body)}`)
    assert.equal(existsSync(file), false, '拒写后不得在原位落一个新文件（那正是"以空状态回写"的固化）')
    assert.equal(backupsOf(dir).length, 1, `原文件必须留档，实得 ${JSON.stringify(readdirSync(dir))}`)
    assert.equal(existsSync(`${file}.quarantined.json`), true, '必须留下用户可见的留档标记')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FIX-47① / plugin-state：目录占位（EISDIR）⇒ 同样拒写，且留档件里的原字节仍在', async () => {
  const dir = tempDir()
  try {
    const file = join(dir, STATE)
    mkdirSync(file, { recursive: true })
    writeFileSync(join(file, 'user-bytes.json'), '{"advisorEnabled":true}')

    const result = await postConfig(dir, { advisorModel: 'NEW-MODEL' })
    assert.equal(result.status, 400, `读失败必须拒写，实得 ${JSON.stringify(result)}`)
    assert.equal(existsSync(file), false, '原路径不得留下"看起来正常"的新文件')
    const backups = backupsOf(dir)
    assert.equal(backups.length, 1, `原文件必须留档，实得 ${JSON.stringify(readdirSync(dir))}`)
    assert.equal(readFileSync(join(dir, backups[0], 'user-bytes.json'), 'utf8'), '{"advisorEnabled":true}',
      '留档件必须逐字节保留用户原来的内容')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FIX-47① / plugin-state（正向对照）：ENOENT = 首次运行 ⇒ 照常 200 并落盘', async () => {
  const dir = tempDir()
  try {
    const result = await postConfig(dir, { advisorModel: 'NEW-MODEL' })
    assert.equal(result.status, 200, `首次运行必须照常放行，实得 ${JSON.stringify(result)}`)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, STATE), 'utf8')), { advisorModel: 'NEW-MODEL' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FIX-47① / plugin-state（正向对照）：健康文件 ⇒ 200 且其它键全部保留', async () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, STATE), JSON.stringify(SEED))
    const result = await postConfig(dir, { advisorModel: 'NEW-MODEL' })
    assert.equal(result.status, 200, `健康基线必须照常放行，实得 ${JSON.stringify(result)}`)
    assert.deepEqual(JSON.parse(readFileSync(join(dir, STATE), 'utf8')), { ...SEED, advisorModel: 'NEW-MODEL' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FIX-47① / plugin-state（有意差异）：解析失败照常 200 + 原字节留档（读失败才拒写）', async () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, STATE), '{"advisorEnabled": tru')  // 半截写
    const result = await postConfig(dir, { advisorModel: 'NEW-MODEL' })
    assert.equal(result.status, 200, `解析失败是"字节已留档 + 已告知用户"的声明式重置，实得 ${JSON.stringify(result)}`)
    const backups = backupsOf(dir)
    assert.equal(backups.length, 1)
    assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), '{"advisorEnabled": tru', '损坏字节必须逐字留档')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
