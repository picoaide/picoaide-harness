/**
 * P1-A（2026-09-16）：`plugin-state.json` 损坏不得阻断插件装载。
 *
 * 症状（修复前，启动级）：`loadState()` 只容忍 ENOENT，JSON 解析失败 / 0 字节 /
 * 目录占位（EISDIR）一律 rethrow → `apply()` 抛 → cordis 报
 * `plugin tree failed to load: failed to apply loader entry dsh-memory-evolve`
 * → 宿主 `shutdown.request(1)`：**整个桌面应用起不来**，用户看不到任何界面，
 * 只能手删 `~/.picoaide-harness/memories/plugin-state.json` 自救。
 *
 * 本文件钉住三件事：
 *   1. 各种损坏形态下 `apply()` **不抛**，工具/快照照常注册；
 *   2. 损坏文件**改名留档**（`.corrupt-<ts>.bak`），不静默丢用户覆盖项；
 *   3. 真正"健康但内容合法"的状态文件仍然照常生效（防修过头）。
 *
 * 读取失败用「父路径是普通文件」制造：`mkdirSync` 报 ENOTDIR、`readFileSync`
 * 报 ENOTDIR，与只读 home 同类（且对 root 同样生效，不受 DAC 绕过影响）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-state-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** Minimal context: only what `apply()` needs to reach tool registration. */
function fakeCtx() {
  const state = { tools: [], contexts: [], commands: [], routes: [], warnings: [] }
  const services = {
    tools: { register: (def) => { state.tools.push(def); return () => {} }, get: () => undefined },
    systemPrompt: { context: (def) => { state.contexts.push(def); return () => {} } },
    commands: { register: (def) => { state.commands.push(def); return () => {} } },
    webServer: { register: (route) => { state.routes.push(route); return () => {} } },
  }
  const settingsService = { get: (ns) => (ns === 'locale' ? { preference: 'zh' } : undefined) }
  const ctx = {
    state,
    tools: services.tools,
    systemPrompt: services.systemPrompt,
    commands: services.commands,
    webServer: services.webServer,
    on: () => () => {},
    inject: (deps, callback) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return { dispose: () => {} }
      return { dispose: callback(ctx) ?? (() => {}) }
    },
    effect: (fn) => fn() ?? (() => {}),
    get: (key) => services[key] ?? (key === 'settings' ? settingsService : undefined),
    logger: {
      warn: (...args) => { state.warnings.push(args) },
      info: () => {},
      error: () => {},
    },
  }
  return ctx
}

/** Every corruption shape that used to kill the whole application. */
const CORRUPTIONS = [
  ['截断的 JSON（真实事故形态）', 'plugin-state.json', '{ "injectMemory": tru'],
  ['0 字节文件', 'plugin-state.json', ''],
  ['顶层是数组', 'plugin-state.json', '[1, 2, 3]'],
  ['顶层是 null', 'plugin-state.json', 'null'],
  ['顶层是标量', 'plugin-state.json', '"just a string"'],
]

for (const [label, name, content] of CORRUPTIONS) {
  test(`P1-A ${label}：apply 不抛、工具仍注册、损坏文件留档`, () => {
    const dir = tempDir()
    try {
      writeFileSync(join(dir, name), content)
      const ctx = fakeCtx()
      assert.doesNotThrow(() => apply(ctx, { memoryDir: dir }), '装载不得因状态文件损坏而失败')
      assert.ok(ctx.state.tools.some((t) => t.name === 'memory'), 'memory 工具必须照常注册')
      assert.ok(ctx.state.contexts.some((c) => c.name === 'memory:snapshot'), '快照上下文必须照常注册')
      // 留档：原文件被改名，用户字节仍可找回
      const backups = readdirSync(dir).filter((f) => f.startsWith(`${name}.corrupt-`) && f.endsWith('.bak'))
      assert.equal(backups.length, 1, `应留档一份损坏文件，实际 ${JSON.stringify(readdirSync(dir))}`)
      assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), content, '留档内容必须逐字节等于原文')
      assert.ok(!readdirSync(dir).includes(name), '损坏文件不得留在原位（下次 saveState 才干净）')
    } finally {
      clean(dir)
    }
  })
}

test('P1-A 状态路径不可读（ENOTDIR/EISDIR 同族）：apply 不抛且不留伪造备份', () => {
  const root = tempDir()
  try {
    // memoryDir 本身是一条普通文件 → mkdir/readFile 都报 ENOTDIR
    const memoryDir = join(root, 'memories-as-file')
    writeFileSync(memoryDir, 'not a directory')
    const ctx = fakeCtx()
    assert.doesNotThrow(() => apply(ctx, { memoryDir: join(memoryDir, 'inner') }))
    assert.ok(ctx.state.tools.some((t) => t.name === 'memory'))
    assert.equal(statSync(memoryDir).isFile(), true, '不得动到那个占位文件')
  } finally {
    clean(root)
  }
})

test('P1-A 目录占位状态文件（EISDIR）：apply 不抛', () => {
  const dir = tempDir()
  try {
    mkdirSync(join(dir, 'plugin-state.json'), { recursive: true })
    const ctx = fakeCtx()
    assert.doesNotThrow(() => apply(ctx, { memoryDir: dir }))
    assert.ok(ctx.state.tools.some((t) => t.name === 'memory'))
  } finally {
    clean(dir)
  }
})

test('A1 标记被消费且只告知一次（快照注入 → 二次启动不再重复）', async () => {
  // 对抗复核 A1（2026-09-16）：只留一个 .bak + console.warn，用户看不出
  // "我的设置被重置了"。改为写 <stateFile>.quarantined.json，apply() 启动时
  // **读一次即删**并注入快照（模型据此提示用户）；下一次启动不再重复告知。
  const dir = tempDir()
  try {
    // 第一次：损坏 → 留档（此时写标记；同一次 apply 已把它消费掉）
    writeFileSync(join(dir, 'plugin-state.json'), '{ bad json')
    apply(fakeCtx(), { memoryDir: dir })
    const marker = join(dir, 'plugin-state.json.quarantined.json')
    assert.equal(existsSync(marker), false, '标记应在同一次启动里被消费（读一次即删）')

    // 第二次：再损坏一次 → apply 必须把"设置被重置"告知模型
    writeFileSync(join(dir, 'plugin-state.json'), '{ bad again')
    const ctx2 = fakeCtx()
    apply(ctx2, { memoryDir: dir })
    const snapshot = renderSnap(ctx2, dir)
    assert.match(snapshot, /记忆设置曾被重置/, '快照必须一次性告知模型（用户可感知的状态变化）')
    assert.match(snapshot, /corrupt-/, '告知里要给备份文件名')
    // 快照每轮组装都会重渲染：同一次 apply 的第二次渲染不得再带这段，
    // 否则模型会每轮重复向用户播报（2026-09-16 审计 E3）。
    assert.doesNotMatch(renderSnap(ctx2, dir), /记忆设置曾被重置/, '同一进程内只告知一次')

    // 第三次：正常启动 → 不再出现该段（不反复用陈旧信息打扰）
    const ctx3 = fakeCtx()
    apply(ctx3, { memoryDir: dir })
    const snapshot3 = renderSnap(ctx3, dir)
    assert.doesNotMatch(snapshot3, /记忆设置曾被重置/, '第二次启动不得再提示')

    // 留档备份确实存在
    const backups = readdirSync(dir).filter(f => f.includes('.corrupt-') && f.endsWith('.bak'))
    assert.ok(backups.length >= 1, '必须留下可恢复的备份')
  } finally {
    clean(dir)
  }
})

/** 用 apply 注册的快照上下文渲染一次快照（走真实渲染路径，不是手拼字符串）。 */
function renderSnap(ctx, memoryDir) {
  const context = ctx.state.contexts.find(c => c.name === 'memory:snapshot')
  assert.ok(context, 'snapshot context registered')
  return String(context.text({
    agent: { id: 'a', session: { id: 's1', header: { cwd: memoryDir } } },
  }))
}

test('A1 反复损坏时留档文件最多保留 3 份（不让备份无限堆积）', () => {
  const dir = tempDir()
  try {
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(dir, 'plugin-state.json'), `{ bad ${i}`)
      apply(fakeCtx(), { memoryDir: dir })
      // 让时间戳不同（同毫秒会重名，实际不会，但测试里要保证可区分）
      const wait = Date.now() + 2
      while (Date.now() < wait) { /* spin */ }
    }
    const backups = readdirSync(dir).filter(f => f.includes('.corrupt-') && f.endsWith('.bak'))
    assert.ok(backups.length <= 3, `留档应 ≤3 份，实际 ${backups.length}：${backups.join(', ')}`)
  } finally {
    clean(dir)
  }
})

test('P1-A 健康状态文件仍照常生效（防修过头）', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'plugin-state.json'), JSON.stringify({ searchDocsEnabled: true }))
    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir })
    assert.ok(
      ctx.state.tools.some((t) => t.name === 'memory_evolve_search_local_files'),
      '合法状态文件里的运行时开关必须仍然生效',
    )
    assert.deepEqual(readdirSync(dir), ['plugin-state.json'], '健康文件不得被留档')
  } finally {
    clean(dir)
  }
})
