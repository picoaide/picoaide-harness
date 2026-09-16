/**
 * P3-A / P3-B（2026-09-16）：记忆工具的参数语义与提示词必须一致。
 *
 * - **P3-A**：快照提示写「用 memory action=expand+id 加载全文」，而 schema
 *   是 `required: ['action','target']`、expand 只认 `target==='key'`。模型照
 *   提示做（只传 id）会撞上"缺少 target（…每轮收尾批量写请用 add + entries
 *   数组）"——一条与当前动作毫无关系的文案。
 * - **P3-B**：key 轨的分支作用域在**快照注入**与 **expand** 上都生效，唯独
 *   `list` 只有显式传 `branch` 才过滤 ⇒ `list target=key` 会返回仅限其它分支
 *   的条目（既不会注入、也 expand 不出来）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, renderSnapshot, resolveConfig } from '../lib/index.js'
import { setLocale } from '../lib/i18n.js'

// 本套件钉中文文案契约（与 plugin.test.js 同款；i18n.test.js 覆盖英文）。
setLocale('zh')

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-params-'))
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

const execCwd = (cwd) => ({ agent: { session: { header: { cwd } } }, callId: 'c1', signal: new AbortController().signal })

test('P3-A expand 缺 target：报错点名 target=key，不再误导到 add+entries', async () => {
  const dir = tempDir()
  try {
    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir })
    const tool = ctx.state.tools.find((t) => t.name === 'memory')
    const result = await tool.execute({ action: 'expand', id: 'abcdef01' }, execCwd(dir))
    assert.equal(result.ok, false)
    assert.match(result.message, /expand/, '文案必须点名 expand')
    assert.match(result.message, /target=key/, '文案必须给出正确调用形态 target=key')
    assert.doesNotMatch(result.message, /entries 数组/, '不得再把 add 批量写的提示塞给 expand')
  } finally {
    clean(dir)
  }
})

test('P3-A 其它 action 缺 target：仍是原来的通用文案（未被改坏）', async () => {
  const dir = tempDir()
  try {
    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir })
    const tool = ctx.state.tools.find((t) => t.name === 'memory')
    const result = await tool.execute({ action: 'list' }, execCwd(dir))
    assert.equal(result.ok, false)
    assert.match(result.message, /缺少 target/)
  } finally {
    clean(dir)
  }
})

test('P3-A 概要：快照摘要模式提示必须写明 target=key', async () => {
  const dir = tempDir()
  try {
    const { MemoryStore } = await import('../lib/store.js')
    const config = resolveConfig({ memoryDir: dir, keyProgressiveDisclosure: 'on' })
    const store = new MemoryStore(config.memoryDir, config)
    const agent = { id: 'a', session: { header: { cwd: dir } } }
    // key 轨写入需用户确认 → 直接落盘一条带 [id:…] 的条目模拟已确认内容
    store.add('key', '[id:abcdef01] [summary:摘要内容] 正文内容\n', agent)
    const text = renderSnapshot(config, store, agent)
    assert.match(String(text), /target=key/, '摘要模式提示必须写明 target=key')
    assert.doesNotMatch(String(text), /action=expand\+id/, '旧的误导写法必须消失')
  } finally {
    clean(dir)
  }
})

test('P3-B list target=key 缺省按当前分支过滤（与注入/expand 同规则）', async (t) => {
  const { spawnSync } = await import('node:child_process')
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { projectHash } = await import('../lib/store.js')
  const dir = tempDir()
  try {
    const init = spawnSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' })
    if (init.status !== 0) return t.skip('git 不可用')
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir, stdio: 'ignore' })

    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir })
    const tool = ctx.state.tools.find((t) => t.name === 'memory')
    const keyDir = join(dir, 'projects', projectHash(dir))
    mkdirSync(keyDir, { recursive: true })
    writeFileSync(
      join(keyDir, 'KEY.md'),
      [
        '§',
        '[2026-09-16] 当前分支可见的条目',
        '§',
        '[2026-09-16] [branch:other-branch] 仅其它分支可见的条目',
        '',
      ].join('\n'),
    )

    const listed = await tool.execute({ action: 'list', target: 'key' }, execCwd(dir))
    assert.equal(listed.ok, true)
    const joined = listed.entries.join('\n')
    assert.match(joined, /当前分支可见的条目/, '无标记条目（=全部）必须保留')
    assert.doesNotMatch(joined, /仅其它分支可见的条目/, '缺省必须过滤掉其它分支的条目（P3-B 修复点）')

    // 显式传 branch 仍然是指定分支的语义（不被缺省逻辑吃掉）
    const explicit = await tool.execute({ action: 'list', target: 'key', branch: 'other-branch' }, execCwd(dir))
    assert.match(explicit.entries.join('\n'), /仅其它分支可见的条目/, '显式 branch 必须照旧生效')
  } finally {
    clean(dir)
  }
})

test('P3-B keyBranchFilter=false：list 也不过分支滤（保守开关仍然有效）', async (t) => {
  // NF-A4（2026-09-16 对抗复核）：这一条原先在**非 git 目录**上跑，只断言 ok=true
  // —— 非 git 下本来就不过滤，删掉被修逻辑照样绿（假绿）。改为**真 git 仓库**上
  // 构造"其它分支才可见的条目"，断言开关关掉时它**确实出现**。
  const { spawnSync } = await import('node:child_process')
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { projectHash } = await import('../lib/store.js')
  const dir = tempDir()
  try {
    const init = spawnSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore' })
    if (init.status !== 0) return t.skip('git 不可用')
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir, stdio: 'ignore' })

    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir, keyBranchFilter: false })
    const tool = ctx.state.tools.find((t) => t.name === 'memory')
    const keyDir = join(dir, 'projects', projectHash(dir))
    mkdirSync(keyDir, { recursive: true })
    writeFileSync(join(keyDir, 'KEY.md'), '§\n[2026-09-16] [branch:other-branch] 仅其它分支可见的条目\n')

    const listed = await tool.execute({ action: 'list', target: 'key' }, execCwd(dir))
    assert.equal(listed.ok, true)
    assert.match(
      listed.entries.join('\n'),
      /仅其它分支可见的条目/,
      'keyBranchFilter=false 时必须不过滤（否则这条用例在非 git 目录上是假绿）',
    )
  } finally {
    clean(dir)
  }
})
