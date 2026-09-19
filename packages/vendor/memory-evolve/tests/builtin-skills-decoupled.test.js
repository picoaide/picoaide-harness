/**
 * 内置技能同步：**与 COI 开关解耦**、落点 = `<DSH_HOME>/skills`、且**平台技能不在其中**
 * （2026-09-18）。
 *
 * 事故形态（第一次修复的对象）：`syncBuiltinSkills` 只在 `installCoi()` 里被调用，
 * 而 `installCoi` 只在 `coiEnabled === true` 时安装（默认 false）。于是
 * 「随插件分发的内置技能同步到用户技能库」被一个毫不相干的 COI 调度开关挡住了。
 *
 * 第二次修正（本文件现在钉的契约，来源 = 用户口径 + 独立审计 P1-1）：同步的
 * **只有本插件自己的技能**。平台技能 `app-builder`（原名 `picoaide-app-builder`）
 * 随**服务端镜像**发布，由员工在客户端「能力中心 → 平台内置技能」**按需安装**；
 * 只要还有一条开机自动把它写进技能库的旁路，「按需」就名存实亡（实测：apply()
 * 一次之后它已在库里，面板直接显示"已安装"，安装按钮永远走不到，且没有能力中心
 * 的溯源信息）。
 *
 * 第三次修正（2026-09-19，技能改名 + 源归位服务端）：它的**源目录已搬出本包**，
 * 真源在服务端仓库 `server/skills/app-builder/`（`server/Dockerfile` 直接 COPY，
 * 不再有 `--build-context skillassets`）。因此本文件的"源目录/"frontmatter"两条
 * 用例按新事实重写：断言它**不在包里**、且**在服务端目录里且契约完好**（目录名 =
 * frontmatter `name`，缺字段会被 `skillmanifest.Parse` 拒掉 ⇒ 技能被静默跳过）。
 *
 * 本用例钉五条：
 *   1. `coiEnabled` 不传（= 默认 false）时，**本插件的技能**仍然同步；
 *   2. 落点是 `<DSH_HOME>/skills`（上游 skill-filesystem 的 user-dsh root / rank 400）；
 *   3. **平台技能不被同步**（两种开关状态下都不被同步），且它已不在包内 `skills/`；
 *   4. `coiSyncSkills: false` 仍然能关掉同步；
 *   5. 平台技能的**新源目录**（`<repo>/server/skills/app-builder`）文件齐备且 frontmatter
 *      同时满足服务端 `skillmanifest.Parse` 的必填项与客户端同步链用的 `x-version`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'
import { BUILTIN_SKILLS, PLATFORM_SKILLS, syncBuiltinSkills } from '../lib/coi/skills-sync.js'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
/**
 * 服务端内置技能资产目录（`server/skills/`）——平台技能的真源。
 *
 * 本包是**本仓库内的 vendored 本地插件**（`packages/vendor/memory-evolve`），
 * 所以按仓库布局向上三级可达仓库根；找不到时**响亮失败**而不是跳过 —— 静默跳过
 * 只会让"源目录契约"这条断言在真正需要它的时候无声消失。
 */
const REPO_ROOT = dirname(dirname(dirname(PACKAGE_ROOT)))
const SERVER_SKILLS_DIR = join(REPO_ROOT, 'server', 'skills')

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
    // 反向对照（防"同步根本没跑"造成的假绿）：本插件的技能确实落到了技能库。
    assert.ok(existsSync(join(home, 'skills', 'memory-consolidate', 'SKILL.md')))
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

test('平台技能源目录已移出本包（2026-09-19 归位服务端；包内 skills/ 只剩本插件自己的技能）', () => {
  for (const name of PLATFORM_SKILLS) {
    assert.equal(
      existsSync(join(PACKAGE_ROOT, 'skills', name)),
      false,
      `平台技能 ${name} 的源目录必须已移出本包（旧位置会让"哪份是真源"再次含糊）`,
    )
  }
  // 反向对照：包内 skills/ 与本插件清单**一一对应** —— 既没有平台技能残留，
  // 也没有"搬错了目录"造成的缺口（本插件的技能一个都不能少）。
  const onDisk = readdirSync(join(PACKAGE_ROOT, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort()
  assert.deepEqual(onDisk, [...BUILTIN_SKILLS].sort(), '包内 skills/ 必须与本插件清单一一对应')
})

test('平台技能的新源目录在服务端仓库里，文件齐备（它就是镜像里下发的那份资产）', () => {
  assert.ok(existsSync(SERVER_SKILLS_DIR), `找不到服务端技能目录：${SERVER_SKILLS_DIR}（仓库布局变了？）`)
  for (const name of PLATFORM_SKILLS) {
    const dir = join(SERVER_SKILLS_DIR, name)
    assert.ok(existsSync(dir), `服务端技能目录缺失：server/skills/${name}`)
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
      assert.ok(rels.includes(expected), `server/skills/${name} 缺少 ${expected}`)
    }
  }
})

test('新源目录的 SKILL.md frontmatter：服务端必填字段齐全，且 name 必须等于目录名', () => {
  for (const name of PLATFORM_SKILLS) {
    const raw = readFileSync(join(SERVER_SKILLS_DIR, name, 'SKILL.md'), 'utf8')
    const front = /^---\n([\s\S]*?)\n---/u.exec(raw)
    assert.ok(front !== null, `${name}/SKILL.md 必须有 frontmatter`)
    const text = front[1]
    const value = (key) => new RegExp(`^${key}:\\s*(.+)$`, 'mu').exec(text)?.[1]?.trim()
    // 服务端 skillmanifest.Parse 的必填字段（缺一个就走不了内置下发通路）。
    assert.ok(value('name') !== undefined, `${name}/SKILL.md 缺 name`)
    // ⚠️ 目录名必须等于 frontmatter name：skillseed 用目录名当 declaredAppID 调
    // Parse()，不一致会让整条技能在启动扫描时被**静默丢弃**（接口 200 + 空数组）。
    assert.equal(value('name'), name, 'SKILL.md 的 name 必须等于目录名（否则技能被静默丢弃）')
    assert.match(value('version') ?? '', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u)
    assert.ok((value('title') ?? '').length > 0)
    assert.ok((value('description') ?? '').length > 0)
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

test('纵深防御真正承重（夹具源目录）：服务端会下发的每个技能名，插件都不得自动同步', () => {
  // 2026-09-19：平台技能的源目录搬出本包后，上面那条用例的"拦住"变成了
  // "源目录本来就不存在 ⇒ 记 missing"，即**就算删掉 PLATFORM_SKILLS 那句守卫也照样绿**。
  // 守卫要能自己承重，就必须喂一个**真的存在**的平台技能源目录 ——
  // `syncBuiltinSkills(pluginSkillsDir, userSkillsDir)` 的源目录是入参，正好可以造。
  //
  // 覆盖面刻意**不取自 PLATFORM_SKILLS**（否则"名单被清空"时用例跟着变空、假绿）：
  // 名字来自服务端资产目录 `server/skills/` —— 那才是"平台会下发什么"的真源。
  // 于是两侧漂移（服务端加了技能但忘了登记进 PLATFORM_SKILLS）也会被这条用例抓住。
  const delivered = readdirSync(SERVER_SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort()
  assert.ok(delivered.length > 0, `服务端资产目录 ${SERVER_SKILLS_DIR} 里一个技能都没有（前置失败）`)

  const dir = tempDir()
  const pluginSkills = join(dir, 'plugin-skills')
  const userSkills = join(dir, 'user-skills')
  mkdirSync(join(pluginSkills, 'memory-consolidate'), { recursive: true })
  writeFileSync(join(pluginSkills, 'memory-consolidate', 'SKILL.md'), '---\nx-version: 1\n---\n# 本插件自己的技能\n')
  for (const name of delivered) {
    mkdirSync(join(pluginSkills, name), { recursive: true })
    writeFileSync(join(pluginSkills, name, 'SKILL.md'), `---\nname: ${name}\nversion: 9.9.9\n---\n# 平台技能（不该被同步）\n`)
  }
  try {
    for (const name of delivered) BUILTIN_SKILLS.push(name)
    const results = syncBuiltinSkills(pluginSkills, userSkills)
    for (const name of delivered) {
      assert.equal(
        results.find((r) => r.name === name),
        undefined,
        `平台技能 ${name} 不该出现在同步结果里（连 missing 都不该有：它根本不参与这条链路）`,
      )
      assert.equal(existsSync(join(userSkills, name)), false, `平台技能 ${name} 不得被同步装上`)
    }
    // 反向对照：同一轮里，本插件自己的技能**确实被同步了**（防"函数没跑"的假绿）。
    assert.equal(results.find((r) => r.name === 'memory-consolidate')?.action, 'synced')
    assert.ok(existsSync(join(userSkills, 'memory-consolidate', 'SKILL.md')))
  } finally {
    for (const name of delivered) {
      const i = BUILTIN_SKILLS.indexOf(name)
      if (i >= 0) BUILTIN_SKILLS.splice(i, 1)
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
