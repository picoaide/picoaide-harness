/**
 * tests/coi-skill-landing-unasserted-write.test.js — F6 收口遗漏（R7 复核 NF-1）。
 *
 * 缺陷族：`lib/coi/skills-sync.js` / `lib/coi/index.js` / `lib/coi/api.js` 用
 * **裸 `writeFileSync` 直接写最终落点** `<skillDir>/<name>/SKILL.md`——既不原子
 * 也不断言落点，跟随符号链接。预置一个真符号链接即可把仓外任意文件覆盖成
 * 内置技能正文，而函数仍报 `action:"synced"`（成功）；插件启动即执行
 * （`lib/coi/index.js` 的 `coiSyncSkills !== false` 分支），无需用户动作。
 *
 * 方法论反思（照抄自复核报告，值得留给下一轮）：F6 第一轮的收口判据是
 * 「名字长得像临时文件」（`.tmp.<pid>` / `.bak.<Date.now()>`），而不是
 * 「这个路径是否被断言」。按名字收敛必然漏掉「直接写最终落点」的整类，
 * 而同一轮新增的结构哨兵测试**恰好也只看名字**，于是给出「已经收口」的假保证。
 * 本文件因此把哨兵判据改成「落点是否经过断言」：`lib/**` 下除唯一实现
 * `lib/sync/filesets.js` 外，不允许出现任何**按路径**的裸 fs 写
 * （`writeFileSync(<非 fd>, …)` 一族）。
 *
 * 「改前失败」证据（改前跑本文件）：
 *   - syncBuiltinSkills：仓外 victim 被写成内置技能正文、action === "synced"；
 *   - 技能目录做成符号链接：4 个内置技能全部写穿到技能库之外；
 *   - coi writeSkill / POST /api/coi/adapters：同样写穿且报成功；
 *   - 结构哨兵：命中 lib/coi/{skills-sync,index,api}.js 等裸写。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const LIB_DIR = join(PKG, 'lib')
/** 唯一实现（落点断言 + O_EXCL 原子写的家）。 */
const PRIMITIVE = join(LIB_DIR, 'sync', 'filesets.js')
/** 构建产物（esbuild 打包的浏览器 bundle），非运行时源码。 */
const BUNDLE = join(LIB_DIR, 'client.js')
const OUTSIDE_TEXT = 'ORIGINAL-OUTSIDE-CONTENT\n'
const BUILTIN = 'kimi-cli-calling'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-coi-landing-'))
}

/** 仓外 victim 文件：内容必须逐字节不变。 */
function seedVictim(path, body = OUTSIDE_TEXT) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return path
}

/**
 * 给一个目标技能目录写本插件的溯源（`.picoaide/release.json`，channel: 'plugin'）。
 *
 * 2026-09-23 P1-1 来源闸门引入后，整树换入**只**对本插件自己写下的目录生效；
 * 下面的落点断言用例必须先过这道闸门，否则"refused"来自闸门而不是符号链接/
 * 越界断言 —— 断言照样绿，覆盖却没了（假绿）。
 * @param {string} dir - 目标技能目录（会被创建）。
 * @returns {void}
 */
function seedPluginProvenance(dir) {
  mkdirSync(join(dir, '.picoaide'), { recursive: true })
  writeFileSync(
    join(dir, '.picoaide', 'release.json'),
    `${JSON.stringify({ appId: BUILTIN, version: '1', channel: 'plugin', installedAt: '2026-09-01T00:00:00.000Z' }, null, 2)}\n`,
  )
}

/** 递归收集 lib/**\/*.js（跳过打包产物）。 */
function walkJs(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walkJs(full))
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

/**
 * 按路径的裸 fs 写（第一参数不是已打开的 fd）——落点未经任何断言。
 * 判据是**落点是否被断言**，不是「名字像不像临时文件」。
 *
 * 2026-09-13 第三轮（RECHECK3 NF1-1）：原先只认
 * `writeFileSync|appendFileSync|copyFileSync|writeFile` 这一族同步/流名，
 * 于是 `lib/advisor/index.js` 透传的 **`node:fs/promises` `appendFile`** 整类
 * 漏在哨兵之外（`records.jsonl` 是受管仓库内的落点，实测被追加写穿到仓外而
 * 哨兵全绿）。这里按**落点是否被断言**补齐整族：同步/异步写文件 +
 * 异步追加 + 流式写。
 */
// `(?<![.\w])`：只认 node:fs 的**自由函数**，不认 `this.writeFile(...)` 这类方法调用。
const BARE_PATH_WRITE_RE = /(?<![.\w])(?:writeFileSync|appendFileSync|copyFileSync|writeFile|appendFile|createWriteStream)\s*\(\s*([^,)]+)/
/**
 * 拷贝类原语：**写的是第二个参数**（第一个是源），且 cp(1) 语义会**跟随**
 * 落点上的符号链接（目录链接 → 内容写进链接目标）。
 *
 * 判据仍是"落点是否被断言"：同文件前 40 行内出现过落点断言调用即视为已断言
 * （例如 `const to = resolveSafeRepoTarget(skillDir, name)` 之后才
 * `cpSync(from, to)`）。这是结构性绊线而非证明 —— 断言必须真的约束到那个
 * 变量，但它保证"新加的拷贝落点至少要在断言旁边"。
 *
 * `renameSync` 刻意不在族内：rename(2) **不跟随**落点上的符号链接（它替换的
 * 是链接本身），与 cp 的写穿语义不同；现存 renameSync 落点（lib/update.js 的
 * 损坏备份与锁回收、lib/sync/repo.js 的同步内部搬移）也不是内容落点。
 * lib/coi/skills-sync.js 等真正的内容落点已改走断言版原语。
 */
const BARE_PATH_COPY_RE = /(?<![.\w])(?:cpSync|copyFileSync)\s*\(\s*[^,)]+,\s*([^,)]+)/
const LANDING_ASSERTION_RE = /resolveSafeRepoTarget|assertSafeRepoTarget|writeFileAtomicSafeAt|appendFileSafeAt|writeFileAtomicSafeAtAsync|openExclusiveSafe|writeFileAtomicSafe|isSymlinkFreeRepoTarget/
/** 拷贝落点断言的回看窗口（行）。 */
const ASSERTION_LOOKBACK_LINES = 40
/** 异步写族的模块来源：除唯一实现外，任何模块都不得直接 import 写 API。 */
const FS_PROMISES_WRITE_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*'node:fs\/promises'/
const FS_PROMISES_WRITE_API_RE = /(?<![.\w])(?:open|writeFile|appendFile|rename|unlink|copyFile|mkdir|rm)\b/
const FD_ARG_RE = /^(?:fd|[\w$]+\.fd|\d+)$/

/* ---------------------------------------------------------------- 结构哨兵 */

test('structural sentinel: no path-based bare fs write outside the single safe-write primitive', () => {
  const offenders = []
  for (const file of walkJs(LIB_DIR)) {
    if (file === PRIMITIVE || file === BUNDLE) continue
    const src = readFileSync(file, 'utf8')
    const rel = relative(LIB_DIR, file).split('\\').join('/')
    const lines = src.split('\n')
    for (const [index, line] of lines.entries()) {
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue // 注释里的历史引用不算
      const bare = BARE_PATH_WRITE_RE.exec(line)
      if (bare && !FD_ARG_RE.test(bare[1].trim())) {
        offenders.push(`${rel}: ${line.trim().slice(0, 100)}`)
        continue
      }
      const copy = BARE_PATH_COPY_RE.exec(line)
      if (!copy) continue
      if (FD_ARG_RE.test(copy[1].trim())) continue
      const lookback = lines.slice(Math.max(0, index - ASSERTION_LOOKBACK_LINES), index + 1).join('\n')
      if (!LANDING_ASSERTION_RE.test(lookback)) offenders.push(`${rel}: ${line.trim().slice(0, 100)}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'lib/** 下仍有按路径的裸 fs 写：落点未经断言（预置符号链接即写穿目录外/覆盖任意文件），'
      + '必须改用 lib/sync/filesets.js 的 writeFileAtomicSafeAt / appendFileSafeAt / writeFileAtomicSafe',
  )
})

test('structural sentinel: node:fs/promises write APIs are imported only by the single safe-write primitive', () => {
  const offenders = []
  for (const file of walkJs(LIB_DIR)) {
    if (file === PRIMITIVE || file === BUNDLE) continue
    const src = readFileSync(file, 'utf8')
    const rel = relative(LIB_DIR, file).split('\\').join('/')
    for (const line of src.split('\n')) {
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue
      const m = FS_PROMISES_WRITE_IMPORT_RE.exec(line)
      if (!m) continue
      // 只读 API（readFile/readdir/stat/realpath/lstat/access）不算写面。
      for (const name of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim())) {
        if (name !== '' && FS_PROMISES_WRITE_API_RE.test(name)) offenders.push(`${rel}: ${line.trim().slice(0, 100)}`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'lib/** 下仍有模块直接从 node:fs/promises 取写 API（open/writeFile/appendFile/rename/unlink/…）：'
      + '落点断言无处安放，必须改用 lib/sync/filesets.js 的断言版原语',
  )
})

/* ------------------------------------------- 内置技能同步（插件启动路径） */

test('syncBuiltinSkills refuses a pre-placed symlink at the final SKILL.md landing spot', async () => {
  const dir = tempDir()
  try {
    const userSkills = join(dir, 'skills')
    const victim = seedVictim(join(dir, 'victim.txt'), `---\nname: ${BUILTIN}\ndescription: x\nx-version: 0\n---\nSTALE-SEED\n`)
    mkdirSync(join(userSkills, BUILTIN), { recursive: true })
    // P1-1 来源闸门（2026-09-23 W4）：整树换入只对**本插件自己**的目录生效，所以
    // 这里必须先给目标目录一份 plugin 溯源，否则用例会先被闸门拒掉、**测不到**
    // 落点断言（假绿：看起来 refused，其实不是符号链接那条路径拒的）。
    seedPluginProvenance(join(userSkills, BUILTIN))
    symlinkSync(victim, join(userSkills, BUILTIN, 'SKILL.md'))

    const { syncBuiltinSkills, BUILTIN_SKILLS } = await import('../lib/coi/skills-sync.js')
    const results = syncBuiltinSkills(join(PKG, 'skills'), userSkills)

    assert.equal(readFileSync(victim, 'utf8').includes('STALE-SEED'), true, '仓外文件被内置技能正文覆盖（跟随了预置符号链接）')
    const entry = results.find((r) => r.name === BUILTIN)
    assert.notEqual(entry.action, 'synced', '落点被拒却仍报 synced 成功：调用方无法感知写穿')
    assert.equal(entry.action, 'refused')
    assert.equal(entry.code, undefined, '必须是落点断言（writeTargetRefusedError）拒的，不是来源闸门')
    // 其余内置技能不受影响（单个落点被拒不阻塞整轮同步）。数量按清单算，
    // 不再硬编码——上游 v26091501 新增 memory-consolidate，硬编码 3 会假红。
    assert.equal(results.filter((r) => r.action === 'synced').length, BUILTIN_SKILLS.length - 1)
    assert.equal(existsSync(join(userSkills, BUILTIN, 'SKILL.md')), true, '拒收不得删除/改写预置链接本身')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('syncBuiltinSkills refuses a symlinked skill directory escaping the skill library', async () => {
  const dir = tempDir()
  try {
    const userSkills = join(dir, 'skills')
    const outside = join(dir, 'elsewhere', BUILTIN)
    mkdirSync(userSkills, { recursive: true })
    mkdirSync(outside, { recursive: true })
    // 同前：给库外目标一份 plugin 溯源，让判定走到"目录本身是符号链接"那条断言。
    seedPluginProvenance(outside)
    symlinkSync(outside, join(userSkills, BUILTIN))

    const { syncBuiltinSkills } = await import('../lib/coi/skills-sync.js')
    const results = syncBuiltinSkills(join(PKG, 'skills'), userSkills)

    assert.equal(existsSync(join(outside, 'SKILL.md')), false, '内置技能经符号链接目录写到了技能库之外')
    assert.notEqual(results.find((r) => r.name === BUILTIN).action, 'synced')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('syncBuiltinSkills still syncs into a plain skill library (control)', async () => {
  const dir = tempDir()
  try {
    const userSkills = join(dir, 'skills')
    const { syncBuiltinSkills } = await import('../lib/coi/skills-sync.js')
    const results = syncBuiltinSkills(join(PKG, 'skills'), userSkills)
    assert.deepEqual([...new Set(results.map((r) => r.action))], ['synced'])
    assert.match(readFileSync(join(userSkills, BUILTIN, 'SKILL.md'), 'utf8'), /^---\n/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* -------------------------------------------- coi 服务/接口的技能写入落点 */

/** 最小 fake ctx（installCoi 只需要 tools/effect/inject/on/emit）。 */
function fakeCtx() {
  const ctx = {
    tools: { register: () => () => {} },
    effect: (fn) => { const d = fn(); return d ?? (() => {}) },
    inject: (_n, cb) => cb({
      commands: { register: () => () => {} },
      webServer: { register: () => () => {} },
      effect: (fn) => { const d = fn(); return d ?? (() => {}) },
    }),
    emit: () => {},
    on: () => () => {},
    off: () => {},
    get: () => undefined,
  }
  return ctx
}

async function bootCoi(dir, skillDir) {
  const { installCoi } = await import('../lib/coi/index.js')
  const { svc } = installCoi(fakeCtx(), {
    coiDataDir: join(dir, 'coi'),
    coiEnabled: true,
    coiSummaryEnabled: false,
    coiSyncSkills: false, // 本用例只测写入落点，不触发启动同步
    coiNotifyCommand: null,
    coiRetentionDays: 90,
    coiTaskTimeoutMs: 60000,
    coiMaxLogBytes: 65536,
    skillDir,
  }, { memoryStore: { add: () => ({ ok: true }) }, resolveCwd: () => undefined })
  return svc
}

test('coi writeSkill refuses a symlink at the final SKILL.md landing spot', async () => {
  const dir = tempDir()
  try {
    const skillDir = join(dir, 'skills')
    const victim = seedVictim(join(dir, 'victim.txt'))
    mkdirSync(join(skillDir, BUILTIN), { recursive: true })
    symlinkSync(victim, join(skillDir, BUILTIN, 'SKILL.md'))

    const svc = await bootCoi(dir, skillDir)
    const result = svc.writeSkill('kimi', '---\nname: kimi-cli-calling\ndescription: 测试\n---\n# 注入\n')

    assert.equal(result.ok, false, '落点被拒却报成功')
    assert.equal(readFileSync(victim, 'utf8'), OUTSIDE_TEXT, 'writeSkill 沿预置符号链接覆盖了仓外文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('coi writeSkill/readSkill reject a skill name that escapes the skill library', async () => {
  const dir = tempDir()
  try {
    const skillDir = join(dir, 'skills')
    // 预置一个可被穿越命中的仓外技能文件
    const escapee = join(dir, 'escapee', 'SKILL.md')
    seedVictim(escapee, 'SECRET-OUTSIDE-SKILL-LIBRARY\n')

    // 1) 新定义：白名单在 validateAdapter 就挡住（`../../escapee` 不是 kebab-case）
    const { validateAdapter } = await import('../lib/coi/adapters.js')
    assert.throws(
      () => validateAdapter({
        id: 'evil', name: 'Evil', type: 'plain-cli', binary: 'true', args: ['-p', '{task}'],
        skillName: '../../escapee',
      }),
      /skillName/,
      '未校验的 skillName 允许把技能读写落点带出技能库',
    )

    // 2) 存量定义（白名单上线前写入 adapters.json 的旧值）：读取时不受
    //    validateAdapter 回溯校验，落点前必须再验一次。
    mkdirSync(join(dir, 'coi'), { recursive: true })
    writeFileSync(join(dir, 'coi', 'adapters.json'), JSON.stringify({
      evil: { id: 'evil', name: 'Evil', type: 'plain-cli', binary: 'true', args: ['-p', '{task}'], skillName: '../../escapee' },
    }))
    const svc = await bootCoi(dir, skillDir)
    const write = svc.writeSkill('evil', '---\nname: x\ndescription: y\n---\n# pwned\n')
    assert.equal(write.ok, false, '存量定义里的非法 skillName 仍可把技能写到技能库之外')
    assert.equal(readFileSync(escapee, 'utf8'), 'SECRET-OUTSIDE-SKILL-LIBRARY\n')

    const read = svc.readSkill('evil')
    assert.equal(read.ok, false, '存量定义里的非法 skillName 仍可读到技能库之外的 SKILL.md')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('POST /api/coi/adapters refuses to auto-create a skill through a symlinked skill directory', async () => {
  const dir = tempDir()
  try {
    const skillDir = join(dir, 'skills')
    // 技能目录本身是指向库外的符号链接：`existsSync(<dir>/kimi-cli-calling/SKILL.md)`
    // 为 false（走自动创建分支），但落点整条链在技能库之外。
    const outside = join(dir, 'elsewhere', BUILTIN)
    mkdirSync(skillDir, { recursive: true })
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(skillDir, BUILTIN))

    const svc = await bootCoi(dir, skillDir)
    const { installCoiApi } = await import('../lib/coi/api.js')
    const ctx = { webServer: { register: ({ handler }) => { ctx.handler = handler; return () => {} } } }
    installCoiApi(ctx, svc)
    const server = createServer((req, res) => ctx.handler(req, res))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    try {
      const res = await fetch(`${base}/memory-evolve/api/coi/adapters`, {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({
          def: {
            id: 'kimi', name: 'Kimi', type: 'ai-cli', binary: 'true', args: ['-p', '{task}'],
            resume: { kind: 'flag', flag: '-S' }, skillName: BUILTIN,
          },
          skillContent: '---\nname: kimi-cli-calling\ndescription: x\n---\n# ATTACKER\n',
        }),
      })
      const body = await res.json().catch(() => ({}))
      assert.equal(res.status, 200)
      assert.equal(existsSync(join(outside, 'SKILL.md')), false, '自动建技能经符号链接目录写到了技能库之外')
      assert.match(String(body.skillMessage ?? ''), /失败|failed/i, '落点被拒时 skillMessage 必须如实报失败')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
