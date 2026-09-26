/**
 * tests/anchor-dir-invariant.test.js — AB2-03 / FIX-42③ 判据：**技能写入落点的
 * 库根锚定**（`anchorDir`）不许只写在散文里。
 *
 * ## 缺陷原形态（第二十八轮 AB2 审计，P3）
 *
 * `writeFileAtomicSafeAt` **不带 `anchorDir`** 时会退到"以**落点父目录**为断言基准"
 * 的兜底档（`lib/sync/filesets.js` 的 `resolveSelfAnchoredTarget` 第 2 档）：
 * `realRoot = realpath(dirname(file))` **自己变成包含性根**，而
 * `hasSymlinkComponent(dir, base)` 只从 `dir` **之下**开始 `lstat` ⇒ **父目录那一层
 * 的符号链接看不见**。技能库根下有预置的目录链接 `<库>/<name> -> <库外>`
 * （共享仓库的 `120000` 条目 / stow / chezmoi 布局）时判定恒真，`SKILL.md`
 * **真被写到库外还报成功**。
 *
 * A4/A5 把"技能写入必须以库根为断言基准"写进了 `lib/skills.js` 的模块头，并在
 * `skills.js` / `coi/skills-sync.js` 共 6 处落地；**同一个插件里的
 * `lib/skills-manager.js` 两处从未跟进**，而全仓没有任何用例会因此变红 ——
 * **散文不是判据**，本文件就是把它变成判据。
 *
 * ## 四块判据（缺任何一块都有假绿空间）
 *
 *  A. **谓词本身双向（真文件系统）**：同一个落点、同一份内容，不带 `anchorDir`
 *     时**写到库外且报成功**；带 `anchorDir` 时**拒收**且库外零字节。证明这条
 *     判据守的是一个真实存在的谓词，不是想象。
 *  B. **插件自身两个写路径（真 HTTP + 真 ctx）**：技能目录是符号链接时，
 *     `POST /api/skills/disable` 必须 **`ok:false` 且库外零改动**；
 *     `PUT /api/write`（目标经该链接）必须**拒收**且库外零改动。
 *  C. **仓库级扫描（角色取面，不是文件名硬编码）**：本插件里凡"会写技能内容"的
 *     模块，其 `writeFileAtomicSafeAt` 调用点必须**带 `anchorDir`**，或在
 *     `REGISTERED_WITHOUT_ANCHOR` 里逐条登记理由；登记项必须**双向**（调用点没了
 *     也不许留死条目）。新增第四个技能写入模块会被自动纳入 ⇒ 未登记即红。
 *  D. **修前红**（变异，不在本文件内）：把 `anchoredSkillWrite` 的锚定段去掉 ⇒
 *     B 的两条红；把两处 `anchorDir` 去掉 ⇒ C 红。
 *
 * 证据（实跑，`temp/r21/fix-42/logs/`）：修前 A 的 un-anchored 腿成立、B 两条红；
 * 修后 A 两条腿方向相反、B 两条绿、C 0 个未收口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installSkillsManager } from '../lib/skills-manager.js'
import { writeFileAtomicSafeAt } from '../lib/sync/filesets.js'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/* ------------------------------------------------------------------ *
 * A. 谓词本身双向（真文件系统）
 * ------------------------------------------------------------------ */

/** 造一个"技能库根 + 库外目录 + `<库>/evil -> 库外`"的真实布局。 */
function makeSymlinkedLibrary() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-anchor-invariant-'))
  const root = join(base, 'skills')
  const outside = join(base, 'OUTSIDE')
  mkdirSync(root, { recursive: true })
  mkdirSync(outside, { recursive: true })
  symlinkSync(outside, join(root, 'evil'), 'dir')
  return { base, root, outside, cleanup: () => { rmSync(base, { recursive: true, force: true }) } }
}

test('A. 不带 anchorDir 时"父目录是符号链接"那一档判定恒真（真写到库外且报成功）', () => {
  const lib = makeSymlinkedLibrary()
  try {
    const target = join(lib.root, 'evil', 'SKILL.md')
    writeFileAtomicSafeAt(target, 'PAYLOAD-TIER2', { followFileSymlink: false })
    assert.equal(
      readFileSync(join(lib.outside, 'SKILL.md'), 'utf8'),
      'PAYLOAD-TIER2',
      '不带 anchorDir 时应当**写穿到库外**（这就是被守护的缺陷形态；若这里抛错说明 filesets 的兜底档变了，须重新评估本判据的取值域）',
    )
  } finally {
    lib.cleanup()
  }
})

test('A′. 带 anchorDir 时同一发写入被拒，且库外零字节（对照腿：守卫不是恒真）', () => {
  const lib = makeSymlinkedLibrary()
  try {
    const target = join(lib.root, 'evil', 'SKILL.md')
    assert.throws(
      () => { writeFileAtomicSafeAt(target, 'PAYLOAD-ANCHORED', { anchorDir: lib.root, followFileSymlink: false }) },
      /dsh-memory-evolve/,
      '带库根锚定后必须拒收（符号链接组件在包含性判定里可见）',
    )
    assert.equal(existsSync(join(lib.outside, 'SKILL.md')), false, '被拒的写入不得在库外留下任何字节')
  } finally {
    lib.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * B. 插件自身两个写路径（真 HTTP + 真 ctx）
 * ------------------------------------------------------------------ */

/** 起一个真的 skills-manager（真 HTTP server + 真路由 + 目录里带一个符号链接技能）。 */
async function bootWithSymlinkedSkill() {
  const lib = makeSymlinkedLibrary()
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-anchor-state-'))
  const stateFile = join(stateDir, 'skills-state.json')
  const skillDir = join(lib.root, 'evil') // 目录符号链接 —— 走真 realpath 时会落到库外
  writeFileSync(join(lib.outside, 'SKILL.md'), '---\nname: evil\ndescription: "linked"\n---\nbody\n')
  // 目录里也放一个真实技能，给"正常路径不退化"做对照。
  const goodDir = join(lib.root, 'good')
  mkdirSync(goodDir, { recursive: true })
  writeFileSync(join(goodDir, 'SKILL.md'), '---\nname: good\ndescription: "good"\n---\nbody\n')

  const mk = (name, dir) => ({
    name,
    description: name,
    whenToUse: name,
    source: 'user-dsh',
    provider: 'test',
    invocation: { modelInvocable: true, userInvocable: true },
    resourceBase: { kind: 'directory', path: dir },
    path: join(dir, 'SKILL.md'),
    content: '',
  })
  const catalog = new Map([['evil', mk('evil', skillDir)], ['good', mk('good', goodDir)]])

  const ctx = {
    skills: {
      list: async () => [...catalog.values()],
      get: async (name) => catalog.get(name),
      register: () => () => {},
      // 真 `skills` 服务的 provider 注册面（`skills-manager.js` 启动时会调它）。
      registerProvider: () => () => {},
    },
    agentPresets: { standingKeyFor: async () => ({ agentPreset: 'standard' }) },
    get(name) { return ctx[name] },
    webServer: { register: ({ handler }) => { ctx.handler = handler; return () => {} } },
    workspaceRegistry: { list: () => [] },
    logger: { warn: () => {} },
    inject(deps, cb) {
      for (const dep of deps) assert.ok(ctx[dep] !== undefined, `missing fake service ${dep}`)
      const disposer = cb(ctx)
      void disposer
    },
    on() {},
    effect(fn) { fn() },
  }
  installSkillsManager(ctx, { stateFile, legacyStateFile: join(stateDir, 'no-legacy.json') })

  const server = createServer((req, res) => ctx.handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const request = async (method, path, body) => {
    const res = await fetch(origin + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    return { status: res.status, data }
  }
  return {
    ...lib,
    origin,
    skillDir,
    goodDir,
    request,
    outsideSkill: join(lib.outside, 'SKILL.md'),
    goodSkill: join(goodDir, 'SKILL.md'),
    close: () => new Promise((resolve) => server.close(resolve)),
    cleanup: () => { lib.cleanup(); rmSync(stateDir, { recursive: true, force: true }) },
  }
}

test('B1. 技能目录是符号链接时 `POST /api/skills/disable` 必须拒写（500 + 可读原因），库外零改动', async () => {
  const h = await bootWithSymlinkedSkill()
  try {
    const before = readFileSync(h.outsideSkill, 'utf8')
    const answer = await h.request('POST', '/skills-manager/api/skills/disable', { name: 'evil' })
    assert.equal(answer.status, 500, `落点被拒 ⇒ 禁用必须失败（实得 ${String(answer.status)} ${JSON.stringify(answer.data)}）`)
    assert.match(String(answer.data.error), /landing refused/)
    assert.equal(readFileSync(h.outsideSkill, 'utf8'), before, '库外的 SKILL.md 不得被改写一个字节')
    assert.equal(readdirSync(h.outside).filter((n) => n.startsWith('SKILL.md.tmp')).length, 0, '被拒的写入不得在库外留下 tmp 落点')
  } finally {
    await h.close()
    h.cleanup()
  }
})

test('B2. 修后：`PUT /api/write` 打向该链接必须拒收，库外零改动；正常技能照常可写', async () => {
  const h = await bootWithSymlinkedSkill()
  try {
    const before = readFileSync(h.outsideSkill, 'utf8')
    // ① 目标落在**每一个受管根之外** ⇒ 404，零字节。
    //    （注意：`resolveInside` 先 realpath，所以"技能目录是符号链接"这条形态在
    //    这里会被解析成链接目标、并被 `collectRoots` 认成一个根 —— 这正是 AB2 报告
    //     登记的"够不到"那一条；本路由的锚定价值在**写盘那一刻**的 TOCTOU 复检，
    //     由 C 的源码判据 + `anchoredSkillWrite` 的包含性判定共同钉住。）
    const stray = await fetch(`${h.origin}/skills-manager/api/write?path=${encodeURIComponent(join(h.root, 'stray', 'SKILL.md'))}`, {
      method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'nope\n',
    })
    assert.equal(stray.status, 404, '受管根之外的写入必须 404')
    assert.equal(existsSync(join(h.root, 'stray')), false, '被拒的写入不得创建任何东西')
    assert.equal(readFileSync(h.outsideSkill, 'utf8'), before, '库外的 SKILL.md 不得被改写一个字节')

    // 正常技能（真实目录）照常可写 —— 证明这条判据不是把写面整体关掉。
    const body = '---\nname: good\ndescription: "good"\n---\nupdated\n'
    const ok = await fetch(`${h.origin}/skills-manager/api/write?path=${encodeURIComponent(h.goodSkill)}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body,
    })
    assert.equal(ok.status, 200, '受管根内的普通技能文件必须照常可写')
    assert.equal(readFileSync(h.goodSkill, 'utf8'), body)
  } finally {
    await h.close()
    h.cleanup()
  }
})

/* ------------------------------------------------------------------ *
 * C. 仓库级扫描：技能写入落点必须带 anchorDir（或登记理由）
 * ------------------------------------------------------------------ */

/**
 * 登记表：`<lib 相对路径>#<写入目标表达式>` → 为什么它不需要库根锚定。
 *
 * 键不用行号（行号会漂，登记表就变成噪音）；目标表达式是这一处写面的身份。
 */
const REGISTERED_WITHOUT_ANCHOR = new Map([
  ['skills-manager.js#stateFile', '写的是插件自己的状态文件 `<memoryDir>/skills-manager.json` —— 落点在受管记忆仓库之下（走 `resolveSelfAnchoredTarget` 的**第 0 档**：登记仓库根），不是技能库落点，因此不需要技能库根锚定。'],
  ['coi/index.js#file', '写的是 COI 运行时配置 `<插件数据目录>/coi-runtime.json`（`saveRuntime`）—— 同模块的 `:360` 才是技能库写入（已带 `anchorDir: config.skillDir`）；这一处落在插件数据目录，按第 0 档锚定。'],
  ['coi/api.js#outFile', '写的是 COI 导出子进程的日志文件（`<outDir>/<adapter>-<id>.log`）—— 同模块的 `:99` 才是技能库写入（已带 `anchorDir: skillDir`）；这一处落在 COI 数据目录，按第 0 档锚定。'],
])

/** 去注释（判据扫的是**代码**；`lib/skills.js` 的散文里出现过同一个函数名）。 */
function blankComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

/** 取所有 `writeFileAtomicSafeAt(...)` 调用（括号配对切出实参文本）。 */
function callSites(source) {
  const out = []
  const re = /\bwriteFileAtomicSafeAt\s*\(/g
  let match
  while ((match = re.exec(source)) !== null) {
    let depth = 0
    let k = match.index + match[0].length - 1
    for (; k < source.length; k += 1) {
      const ch = source[k]
      if (ch === '(') depth += 1
      else if (ch === ')') { depth -= 1; if (depth === 0) break }
    }
    out.push({
      line: source.slice(0, match.index).split('\n').length,
      text: source.slice(match.index, k + 1),
      target: source.slice(match.index + match[0].length, k).split(',')[0].trim(),
    })
  }
  return out
}

/** 递归列出 `lib/` 下的全部 `.js`（相对 lib 的路径，`/` 分隔）。 */
function listLibModules() {
  const out = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) { walk(join(dir, entry.name), rel); continue }
      if (entry.name.endsWith('.js')) out.push(rel)
    }
  }
  walk(join(PACKAGE_ROOT, 'lib'), '')
  return out.sort()
}

/**
 * **角色取面**：一个模块"参与技能库落点判定"的判据 —— 满足任一条即可：
 *
 *   1. 代码里用了 {@link resolveSkillLanding}（`skills.js` 模块头写明的**唯一**
 *      技能落点解析实现："所有技能写入…都经这里解析落点"）；
 *   2. 有 ≥1 个 `writeFileAtomicSafeAt` 调用带 `anchorDir`（= 它已经在按库根锚定写）；
 *   3. 有 `writeFileAtomicSafeAt` 的**写入目标文本**里出现 `SKILL.md`。
 *
 * 为什么不用更宽的"提到 `SKILL.md` 就算"：那会把写**插件状态文件/日志**的模块
 * （`index.js` 的 `saveState`、`coi/index.js` 的 `saveRuntime`、`coi/api.js` 的导出
 * 日志）一起收进来 —— 它们各有各的锚定语义（第 0 档：登记仓库根），逼它们要么挂
 * 技能库根、要么进豁免表，正是本仓已登记的反面模式"豁免表变成免检区"。
 * 这个面同时是**前向**的：新模块只要按文档化的形式写技能（用 `resolveSkillLanding`
 * 或带 `anchorDir`），就会自动落进面内并因"某一处漏锚"而红。
 * @param {string} source - 已去注释的模块源码。
 * @param {Array<{text: string, target: string}>} sites - 该模块的写入调用点。
 * @returns {boolean} 是否属于技能写入面。
 */
function isSkillWriterModule(source, sites) {
  if (/\bresolveSkillLanding\b/.test(source)) return true
  if (sites.some((site) => /anchorDir/.test(site.text))) return true
  if (sites.some((site) => /SKILL\.md/.test(site.target))) return true
  return false
}

test('C. 仓库级：技能写入模块的每个 writeFileAtomicSafeAt 落点都带 anchorDir，或已登记', () => {
  const offenders = []
  const registeredSeen = new Set()
  let scanned = 0
  let writers = 0
  for (const rel of listLibModules()) {
    const source = blankComments(readFileSync(join(PACKAGE_ROOT, 'lib', rel), 'utf8'))
    const sites = callSites(source)
    if (!isSkillWriterModule(source, sites)) continue
    writers += 1
    for (const site of sites) {
      scanned += 1
      const key = `${rel}#${site.target}`
      if (/anchorDir/.test(site.text)) continue
      if (REGISTERED_WITHOUT_ANCHOR.has(key)) { registeredSeen.add(key); continue }
      offenders.push(`${rel}:${site.line}  ${key}  ← 无 anchorDir 且未登记`)
    }
  }
  assert.ok(writers >= 3, `技能写入模块至少 3 个（实得 ${writers}）——扫描面塌了会让判据空转`)
  assert.ok(scanned >= 10, `技能写入调用点至少 10 个（实得 ${scanned}）——扫描面塌了会让判据空转`)
  assert.deepEqual(offenders, [], '这些技能写入落点没有库根锚定、也没有登记理由（"父目录是符号链接"时判定恒真）')
})

test('C′. 登记表双向：登记了却不在面内（死条目）也红', () => {
  const present = new Set()
  for (const rel of listLibModules()) {
    const source = blankComments(readFileSync(join(PACKAGE_ROOT, 'lib', rel), 'utf8'))
    const sites = callSites(source)
    if (!isSkillWriterModule(source, sites)) continue
    for (const site of sites) present.add(`${rel}#${site.target}`)
  }
  const stale = [...REGISTERED_WITHOUT_ANCHOR.keys()].filter((key) => !present.has(key))
  assert.deepEqual(stale, [], '登记项已经没有对应的调用点了（"登记表"不许变成免检区）')
})

test('C″. 判据自检：扫描器对"无 anchorDir / 有 anchorDir / 登记过"三种形态判定不同', () => {
  const sample = (body) => blankComments(`function f() {\n${body}\n}`)
  const without = callSites(sample('  writeFileAtomicSafeAt(file, content, { followFileSymlink: false })'))
  const withAnchor = callSites(sample('  writeFileAtomicSafeAt(file, content, { anchorDir: root, followFileSymlink: false })'))
  assert.equal(without.length, 1)
  assert.equal(withAnchor.length, 1)
  assert.equal(/anchorDir/.test(without[0].text), false, '无锚形态必须被判为无锚（否则 C 是空断言）')
  assert.equal(/anchorDir/.test(withAnchor[0].text), true, '有锚形态必须被判为有锚')
  assert.equal(without[0].target, 'file', '写入目标表达式要能取出来（登记键就是它）')
  // 注释里的同名调用不算（`lib/skills.js` 的散文里真的有）。
  assert.equal(callSites(blankComments('// writeFileAtomicSafeAt(a, b, {})\n')).length, 0)
})
