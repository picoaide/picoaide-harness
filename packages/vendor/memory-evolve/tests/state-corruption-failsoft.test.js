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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
