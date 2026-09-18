/**
 * 内置技能同步：**与 COI 开关解耦**、落点 = `<DSH_HOME>/skills`、且**平台技能不在其中**
 * （2026-09-18）。
 *
 * 事故形态（第一次修复的对象）：`syncBuiltinSkills` 只在 `installCoi()` 里被调用，
 * 而 `installCoi` 只在 `coiEnabled === true` 时安装（默认 false）。于是
 * 「随插件分发的内置技能同步到用户技能库」被一个毫不相干的 COI 调度开关挡住了。
 *
 * 第二次修正（本文件现在钉的契约，来源 = 用户口径 + 独立审计 P1-1）：同步的
 * **只有本插件自己的技能**。平台技能 `picoaide-app-builder` 随**服务端镜像**发布，
 * 由员工在客户端「能力中心 → 平台内置技能」**按需安装**；只要还有一条开机自动
 * 把它写进技能库的旁路，「按需」就名存实亡（实测：apply() 一次之后它已在库里，
 * 面板直接显示"已安装"，安装按钮永远走不到，且没有能力中心的溯源信息）。
 *
 * 本用例钉五条：
 *   1. `coiEnabled` 不传（= 默认 false）时，**本插件的技能**仍然同步；
 *   2. 落点是 `<DSH_HOME>/skills`（上游 skill-filesystem 的 user-dsh root / rank 400）；
 *   3. **平台技能不被同步**（两种开关状态下都不被同步）；
 *   4. `coiSyncSkills: false` 仍然能关掉同步；
 *   5. 平台技能的源目录与 frontmatter **必须完好** —— 它是服务端镜像的构建上下文
 *      （`server/Dockerfile` 的 `--build-context skillassets=<本包>`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'
import { BUILTIN_SKILLS, PLATFORM_SKILLS } from '../lib/coi/skills-sync.js'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-me-builtin-skills-'))
}

/** 递归列出目录下的普通文件（相对路径，'/'-分隔）。 */
function listFiles(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out.sort()
}

/**
 * 最小可用 ctx（与 plugin.test.js 的 fakeCtx 同口径，只保留 apply 需要的 seam）。
 * `inject` 按 cordis 语义：声明的服务不全就不执行回调。
 */
function fakeCtx() {
  const state = { tools: [], contexts: [], commands: [], listeners: [], routes: [] }
  const services = {
    tools: { register: (def) => { state.tools.push(def); return () => {} }, get: () => undefined },
    systemPrompt: { context: (def) => { state.contexts.push(def); return () => {} } },
    commands: { register: (def) => { state.commands.push(def); return () => {} } },
    webServer: { register: (route) => { state.routes.push(route); return () => {} } },
  }
  const settingsService = { get: (ns) => (ns === 'locale' ? { preference: 'zh' } : undefined) }
  const ctx = {
    state,
    ...services,
    on: (name, listener) => { (state.listeners[name] ??= []).push(listener); return () => {} },
    inject: (deps, callback) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return { dispose: () => {} }
      const disposer = callback(ctx)
      return { dispose: disposer ?? (() => {}) }
    },
    effect: (fn) => fn() ?? (() => {}),
    get: (key) => services[key] ?? (key === 'settings' ? settingsService : undefined),
    logger: { warn: () => {}, info: () => {}, error: () => {} },
  }
  return ctx
}

/** 在一次性 DSH_HOME 下跑一次 apply，返回 { home, dir, restore }。 */
function withDshHome(fn) {
  const root = tempDir()
  const home = join(root, 'harness-home')
  const dir = join(root, 'memory')
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    fn({ root, home, dir })
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(root, { recursive: true, force: true })
  }
}

test('本插件的技能在 coiEnabled 缺省(false) 时仍然同步，且落点是 <DSH_HOME>/skills', () => {
  withDshHome(({ home, dir }) => {
    // 刻意不传 coiEnabled —— 走默认 false，正是事故时的配置。
    apply(fakeCtx(), { memoryDir: dir })

    const landed = join(home, 'skills', 'memory-consolidate', 'SKILL.md')
    assert.ok(existsSync(landed), `本插件的技能必须同步到 ${landed}`)

    // 反向断言：旧落点（user-agents root）不得再被写入。
    const legacy = join(home, '.agents', 'skills', 'memory-consolidate')
    assert.equal(existsSync(legacy), false, `不得再落到旧根 ${legacy}`)

    // 整目录逐字节一致（正文 + 辅助文件一起走）。
    const sourceFiles = listFiles(join(PACKAGE_ROOT, 'skills', 'memory-consolidate'))
    const landedFiles = listFiles(join(home, 'skills', 'memory-consolidate'))
    assert.deepEqual(landedFiles, sourceFiles, '同步的必须是整目录，且文件名集合一致')
    for (const rel of sourceFiles) {
      assert.deepEqual(
        readFileSync(join(home, 'skills', 'memory-consolidate', rel)),
        readFileSync(join(PACKAGE_ROOT, 'skills', 'memory-consolidate', rel)),
        `${rel} 必须逐字节一致`,
      )
    }
  })
})

test('平台技能不被开机同步（默认配置）——「按需安装」必须是唯一入口', () => {
  withDshHome(({ home, dir }) => {
    apply(fakeCtx(), { memoryDir: dir })
    for (const name of PLATFORM_SKILLS) {
      assert.equal(
        existsSync(join(home, 'skills', name)),
        false,
        `平台技能 ${name} 不得被开机同步装上（那会让能力中心的安装按钮永远走不到）`,
      )
      assert.equal(
        existsSync(join(home, '.agents', 'skills', name)),
        false,
        `平台技能 ${name} 也不得落到 ~/.agents/skills`,
      )
    }
  })
})

test('coiEnabled=true 也不装平台技能（两条路径都不许）', () => {
  withDshHome(({ home, dir }) => {
    apply(fakeCtx(), { memoryDir: dir, coiEnabled: true, coiDataDir: join(dir, 'coi') })
    for (const name of PLATFORM_SKILLS) {
      assert.equal(existsSync(join(home, 'skills', name)), false, `coiEnabled=true 也不得装 ${name}`)
    }
    // 本插件的技能照旧（不回归）。
    assert.ok(existsSync(join(home, 'skills', 'memory-consolidate', 'SKILL.md')))
    // 幂等：再 apply 一次不抛错、内容不变。
    const landed = join(home, 'skills', 'memory-consolidate', 'SKILL.md')
    const before = readFileSync(landed)
    apply(fakeCtx(), { memoryDir: dir, coiEnabled: true, coiDataDir: join(dir, 'coi') })
    assert.deepEqual(readFileSync(landed), before)
  })
})

test('coiSyncSkills=false 仍然能关掉同步（技能管理 Tab 的既有语义）', () => {
  withDshHome(({ home, dir }) => {
    apply(fakeCtx(), { memoryDir: dir, coiSyncSkills: false })
    assert.equal(
      existsSync(join(home, 'skills', 'memory-consolidate')),
      false,
      'coiSyncSkills=false 必须关掉同步',
    )
  })
})

test('平台技能的源目录必须留在包里（服务端镜像的构建上下文，删了镜像构建就失败）', () => {
  for (const name of PLATFORM_SKILLS) {
    const dir = join(PACKAGE_ROOT, 'skills', name)
    const rels = listFiles(dir)
    for (const expected of [
      'SKILL.md',
      'references/abi.md',
      'references/app-config.md',
      'references/diagnostics.md',
      'references/limits.md',
      'references/publishing.md',
      'examples/go/go.mod',
      'examples/go/main.go',
      'examples/go/picoaide.app.json',
      'examples/go/preview.mjs',
      'examples/go/README.md',
    ]) {
      assert.ok(rels.includes(expected), `${name} 缺少 ${expected}`)
    }
  }
})

test('SKILL.md 的 frontmatter 同时带服务端必填字段与客户端同步用的 x-version', () => {
  for (const name of PLATFORM_SKILLS) {
    const raw = readFileSync(join(PACKAGE_ROOT, 'skills', name, 'SKILL.md'), 'utf8')
    const front = /^---\n([\s\S]*?)\n---/u.exec(raw)
    assert.ok(front !== null, `${name}/SKILL.md 必须有 frontmatter`)
    const text = front[1]
    const value = (key) => new RegExp(`^${key}:\\s*(.+)$`, 'mu').exec(text)?.[1]?.trim()
    // 服务端 skillmanifest.Parse 的必填字段（缺一个就走不了市场/内置下发通路）。
    assert.equal(value('name'), name)
    assert.match(value('version') ?? '', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u)
    assert.ok((value('title') ?? '').length > 0)
    assert.ok((value('author') ?? '').length > 0)
    assert.ok((value('category') ?? '').length > 0)
    // 客户端 COI 同步链用的 x-version 必须**保留**（两套版本语义，不合并）。
    assert.match(value('x-version') ?? '', /^\d+$/u)
    assert.equal(value('x-abi-version'), 'picoaide-app/1')
  }
})

test('同步不清扫技能库里的其它内容（只写自己的技能目录）', () => {
  withDshHome(({ home, dir }) => {
    const foreign = join(home, 'skills', 'user-authored')
    mkdirSync(foreign, { recursive: true })
    apply(fakeCtx(), { memoryDir: dir })
    assert.ok(existsSync(foreign), '用户自己的技能目录不得被同步流程删掉')
    assert.ok(existsSync(join(home, 'skills', 'memory-consolidate', 'SKILL.md')))
  })
})

test('纵深防御单独承重：清单被改坏（平台技能被加回）时，同步仍不得把它装上', () => {
  // 独立验证 2026-09-18 P3-4：`syncBuiltinSkills` 里那句
  // `if (PLATFORM_SKILLS.includes(name)) continue` 此前没有独立用例承重 ——
  // 只有"清单本身被冻结断言钉住"在挡。这里直接把清单改坏（运行时 push），
  // 断言防御层自己也能拦住，并在 finally 里复原（同文件其它用例共用这个模块实例）。
  withDshHome(({ home, dir }) => {
    try {
      for (const name of PLATFORM_SKILLS) BUILTIN_SKILLS.push(name)
      apply(fakeCtx(), { memoryDir: dir })
      for (const name of PLATFORM_SKILLS) {
        assert.equal(
          existsSync(join(home, 'skills', name)),
          false,
          `清单里有 ${name} 也不得被装上 —— PLATFORM_SKILLS 的纵深防御必须自己承重`,
        )
      }
      // 反向对照：这一轮同步**确实跑了**（不是"什么都没同步"造成的假绿）。
      assert.ok(existsSync(join(home, 'skills', 'memory-consolidate', 'SKILL.md')))
    } finally {
      for (const name of PLATFORM_SKILLS) {
        const i = BUILTIN_SKILLS.indexOf(name)
        if (i >= 0) BUILTIN_SKILLS.splice(i, 1)
      }
    }
  })
})
