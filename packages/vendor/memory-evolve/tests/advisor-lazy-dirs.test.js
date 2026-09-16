/**
 * P1-B（2026-09-16）：advisor 的持久化目录必须**惰性创建**，且目录不可写时
 * 不得阻断插件装载。
 *
 * 症状（修复前，启动级）：`installAdvisor` 在装载期无条件
 * `mkdirSync(<memoryDir>/advisor/{instructions,conversations,session-scopes})`，
 * 而 `installAdvisor` 在 `apply()` 里是**无条件调用**的（`advisorEnabled`
 * 默认关只影响评审是否运行，不影响装配）。于是只读 home / 磁盘满 / 目录被
 * 文件占位 → mkdir 抛错 → cordis `plugin tree failed to load` → 宿主退出：
 * 面板功能一个都没用到，整个应用照样起不来。
 *
 * 修复后：目录在真正要写的那一刻才建；写入失败只影响 advisor 自己的持久化。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-advisor-dir-'))
}

function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}

function fakeCtx() {
  const state = { tools: [], contexts: [], commands: [], routes: [] }
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
    get: (key) => services[key] ?? (key === 'settings' ? settingsService : undefined),
    effect: (fn) => fn() ?? (() => {}),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  return ctx
}

test('P1-B 默认配置（advisor 关）：装载不创建 advisor 数据目录', () => {
  const dir = tempDir()
  try {
    apply(fakeCtx(), { memoryDir: dir })
    assert.equal(
      existsSync(join(dir, 'advisor')),
      false,
      'advisor 关着的时候不得急切 mkdir（这正是只读 home 下整个应用起不来的根因）',
    )
  } finally {
    clean(dir)
  }
})

test('P1-B 打开 advisor：装载期同样不建目录（写入时才建）', () => {
  const dir = tempDir()
  try {
    apply(fakeCtx(), { memoryDir: dir, advisorEnabled: true, advisorProvider: 'p', advisorModel: 'm' })
    assert.equal(existsSync(join(dir, 'advisor')), false, '目录应由首次写入创建')
  } finally {
    clean(dir)
  }
})

test('P1-B 记忆目录被普通文件占位（ENOTDIR）：apply 不抛、memory 工具照常注册', () => {
  const root = tempDir()
  try {
    const blocker = join(root, 'memories')
    writeFileSync(blocker, 'not a directory')
    const ctx = fakeCtx()
    assert.doesNotThrow(() => apply(ctx, { memoryDir: blocker }))
    assert.ok(ctx.state.tools.some((t) => t.name === 'memory'), 'memory 工具必须照常注册')
  } finally {
    clean(root)
  }
})

test('P1-B 写入路径会自建目录（懒建不丢功能）', () => {
  const dir = tempDir()
  try {
    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir, advisorEnabled: true, advisorProvider: 'p', advisorModel: 'm' })
    // apply 之后 advisor 数据目录仍不存在（懒建），但 advisor 的 HTTP 面已挂上
    // （功能面完整：命令注册受"评审员实例"claim 影响，这里钉住路由这一确定性信号）
    assert.equal(existsSync(join(dir, 'advisor')), false, '装载期不得建 advisor 目录')
    assert.ok(ctx.state.routes.length > 0, 'advisor HTTP 面应在装载期挂上（功能未因懒建退化）')
  } finally {
    clean(dir)
  }
})

test('P1-B 记忆目录被文件占位时写入如实报错，绝不静默成功', async () => {
  const root = tempDir()
  try {
    // 用文件占位制造 ENOTDIR：写入必然失败，但装载已完成
    const memoryDir = join(root, 'memories')
    writeFileSync(memoryDir, 'blocker')
    const ctx = fakeCtx()
    apply(ctx, { memoryDir, advisorEnabled: true, advisorProvider: 'p', advisorModel: 'm' })
    const tool = ctx.state.tools.find((t) => t.name === 'memory')
    assert.ok(tool, '装载必须完成（修复前这里根本到不了）')
    const exec = { agent: { session: { header: { cwd: root } } }, callId: 'c', signal: new AbortController().signal }
    let ok
    try {
      const result = await tool.execute({ action: 'add', target: 'memory', content: 'x' }, exec)
      ok = result.ok
    } catch (error) {
      assert.ok(error instanceof Error, '只允许抛 Error（不得静默吞掉）')
      ok = false
    }
    assert.equal(ok, false, '落盘失败必须如实回报，不能算成功')
  } finally {
    clean(root)
  }
})

test('P1-B 目录懒建后可正常落盘（功能未因懒建退化）', async () => {
  const dir = tempDir()
  try {
    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir })
    const tool = ctx.state.tools.find((t) => t.name === 'memory')
    const exec = { agent: { session: { header: { cwd: dir } } }, callId: 'c', signal: new AbortController().signal }
    const result = await tool.execute({ action: 'add', target: 'memory', content: '懒建回归' }, exec)
    assert.equal(result.ok, true, `写入应成功：${JSON.stringify(result)}`)
    assert.ok(readFileSync(join(dir, 'MEMORY.md'), 'utf8').includes('懒建回归'))
  } finally {
    clean(dir)
  }
})
