#!/usr/bin/env node
/**
 * 渠道约束校验（WASM「客户端专属」改造 §10 / §16 W3 的 L4 部分）。
 *
 * **为什么是独立脚本**：`app_origin_scheme` 是应用 origin 的唯一来源（§8.3「scheme 的
 * 唯一来源 = 渠道包 desktop.app_origin_scheme」），它写错的后果在构建期之后**不可逆**：
 * 服务端镜像内含本渠道配置、客户端把 scheme 烧进协议注册与深链 —— 装到客户机器上
 * 再发现就只能重发版。所以本文件把「渠道包里这个字段必须存在、形状合法、跨渠道唯一」
 * 变成一条可复跑、可变异验证、离线（不联网、不需要渠道仓 token）的判据。
 *
 * 覆盖（逐条对应设计文档）：
 *   1. 冻结正则三方对拍：设计总纲 §8.3 的 `^[a-z][a-z0-9+.-]{1,31}$` ↔ ci-channels.sh
 *      里 deep_link_scheme 与 app_origin_scheme 两处**逐字相同**（R1-SRV-9 曾出现
 *      "正则/长度两端不一致"；只改一处就是漂移）。
 *   2. 仓库 pin 校验：`upstream.json`（commit 形状 + `sourceVersion == runtimePackageVersion`）、
 *      `.gitmodules` 的上游 URL、`git submodule status` 的实际检出 commit == `upstream.json.commit`
 *      （渠道 scheme 的取值与注入链都写在这个 pin 的行为上，pin 漂移则结论不可比）。
 *      具体版本号/commit**只在 `upstream.json` 里**（升级脚本同时改写它与 submodule）；
 *      历史版本的本注释曾写死具体 commit 与 tag，pin 一升级那两处立即失真
 *      （2026-09-23 二轮审计 D-4 同族：文档/注释里的 pin 必须指向真源，不写死值）。
 *   3. 渠道 CI dry-run（**正式 tag 名**，R2T-6/OPS-3：不能用预发 tag 只证明 beta）：
 *      对合成夹具跑 `scripts/ci-channels.sh`，断言正式 tag ⇒ 全部渠道（含 official）、
 *      预发 tag ⇒ 仅 beta、非 tag ⇒ 仅 official。
 *   4. app_origin_scheme 五条负例（缺字段 / 非法形状 / 与 deep_link_scheme 同值 /
 *      保留 scheme / 跨渠道重复）：每条都必须让 ci-channels.sh 非 0 退出且**点名字段**；
 *      重复用例额外断言输出里**不出现 scheme 取值**（渠道包的值就是客户品牌，输出会进
 *      公开 Actions 日志 —— 这是本仓硬纪律）。
 *   5. `--channels-repo <dir>`（可选）：对真实私有渠道仓检出跑一次正式 tag dry-run。
 *      不给则显式打印 SKIP（本脚本在公开仓里不持有渠道仓，也不联网）。
 *
 * 用法：
 *   node scripts/verify-wasm-channels.mjs
 *   node scripts/verify-wasm-channels.mjs --channels-repo /path/to/picoaide-channels
 * 退出码：0 = 全部判据通过；1 = 有失败项（逐条打印，含文件与行号）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHANNELS_SCRIPT = join(ROOT, 'scripts', 'ci-channels.sh')
const DESIGN_DOC = join(ROOT, 'docs', 'planning', '2026-09-19-wasm-client-only-design.md')
const UPSTREAM_JSON = join(ROOT, 'upstream.json')

/** §8.3 冻结的 scheme 正则（**不是**无上界版本）。 */
const FROZEN_SCHEME_REGEX = '^[a-z][a-z0-9+.-]{1,31}$'
/**
 * 上游 pin 的**唯一真源**是 `upstream.json`（升级脚本同时改写它与 submodule）。
 * 这里刻意**不再硬编码**版本号与 commit：历史版本写死了 `dsh-v0.1.5-rc.2` /
 * `fb2c4b9e…`，升级后会在 `yarn check` 里立刻报红，且失败信息指向"pin 校验"而不是
 * "守卫夹具过期"，极易被误判成升级本身坏了（2026-09-20 升级审计 P1-8）。
 */
const PIN_TAG_PATTERN = /^dsh-v\d+\.\d+\.\d+-(?:alpha|beta|rc)\.\d+$/
const APP_SCHEME_FIELD = 'desktop.app_origin_scheme'
/** §10 冻结的保留 scheme **契约**（真源是设计总纲原文，这里只作为解析失败时的对照提示）。 */
const RESERVED_SCHEMES = ['http', 'https', 'file', 'data', 'javascript', 'about']

/** 报告里的相对路径（失败信息要能直接点开）。 */
const REL = path => path.replace(`${ROOT}/`, '')

const failures = []
const scratch = []

function pass(message) {
  console.log(`  PASS ${message}`)
}

function fail(message) {
  failures.push(message)
  console.error(`  FAIL ${message}`)
}

function check(condition, message) {
  if (condition) pass(message)
  else fail(message)
}

function section(title) {
  console.log(`\n== ${title}`)
}

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/** 带行号的源码读取（失败信息必须能指到文件与行）。 */
function readLines(path) {
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\n')
  return { text, lines }
}

/** 在文本里找出某个字面量出现的所有行号（1 起）。 */
function lineNumbersOf(text, needle) {
  const found = []
  text.split('\n').forEach((line, index) => {
    if (line.includes(needle)) found.push(index + 1)
  })
  return found
}

/**
 * 造一个合成渠道仓：`<root>/channels/<id>/channel.json`。
 * @param specs - `{ id, appOriginScheme?, deepLinkScheme?, extraDesktop? }` 列表；
 *   `appOriginScheme === null` 表示**刻意不写**该字段（负例用）。
 * @returns 仓库根目录（含 channels/）。
 */
function fakeChannelRepo(specs) {
  const dir = tempDir('wasm-channels-repo-')
  for (const spec of specs) {
    const { id } = spec
    const publicChannel = id === 'official' || id === 'beta'
    const deepLinkScheme = spec.deepLinkScheme ?? `${id.replaceAll('-', '')}link`
    const desktop = {
      ...(publicChannel ? {} : {
        product_name: `${id} AI`,
        slug: `${id}-AI`,
        app_id: `com.example.${id.replaceAll('-', '')}`,
        home_dir: `.${id}-harness`,
      }),
      ...(id === 'beta' ? { home_dir: '.picoaide-harness' } : {}),
      deep_link_scheme: deepLinkScheme,
      ...(spec.appOriginScheme === undefined || spec.appOriginScheme === null
        ? {}
        : { app_origin_scheme: spec.appOriginScheme }),
      ...(spec.extraDesktop ?? {}),
    }
    mkdirSync(join(dir, 'channels', id), { recursive: true })
    writeFileSync(join(dir, 'channels', id, 'channel.json'), JSON.stringify({
      schema: 1,
      channel_id: id,
      identity: { display_name: `${id} AI`, short_name: id },
      assets: { _note: '注解:渠道素材说明,不是文件名/路径' },
      desktop,
    }, null, 2))
  }
  return dir
}

/**
 * 跑一次 ci-channels.sh（dry-run：只解析渠道集 + 校验字段，不打包）。
 * @param options - `{ source, refName, ref }`。
 */
function runChannels({ source, refName = '', ref }) {
  const cwd = tempDir('wasm-channels-run-')
  const dest = join(cwd, 'channels-dest')
  const list = join(cwd, 'channels.list')
  const result = spawnSync('bash', [CHANNELS_SCRIPT, '--dest', dest, '--list', list], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      CI_CHANNELS_SOURCE: source,
      GITHUB_REF_NAME: refName,
      GITHUB_REF: ref ?? (refName === '' ? '' : `refs/tags/${refName}`),
    },
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    selected: existsSync(list)
      ? readFileSync(list, 'utf8').split('\n').filter(line => line !== '').sort()
      : [],
  }
}

function sameSet(actual, expected) {
  const a = [...actual].sort().join(',')
  const b = [...expected].sort().join(',')
  return { equal: a === b, detail: `实际 [${a}] / 期望 [${b}]` }
}

/** 夹具基线：三渠道，official/beta 共用命名空间，品牌渠道各自唯一。 */
function baselineSpecs() {
  return [
    { id: 'official', appOriginScheme: 'picoaide-app' },
    { id: 'beta', appOriginScheme: 'picoaide-app' },
    { id: 'example-brand', appOriginScheme: 'examplebrand-app' },
  ]
}

// ---------------------------------------------------------------------------
section('1. 冻结 scheme 正则：设计总纲 §8.3 ↔ ci-channels.sh（逐字）')
{
  const doc = readLines(DESIGN_DOC)
  const docLines = lineNumbersOf(doc.text, FROZEN_SCHEME_REGEX)
  check(docLines.length > 0,
    `设计总纲 §8.3 冻结正则 ${FROZEN_SCHEME_REGEX}（${DESIGN_DOC.replace(`${ROOT}/`, '')}:${docLines.join(',') || '未命中'}）`)

  const script = readLines(CHANNELS_SCRIPT)
  const scriptLines = lineNumbersOf(script.text, FROZEN_SCHEME_REGEX)
  // 两处：deep_link_scheme 与 app_origin_scheme。只出现一次 ⇒ 必有一处用了别的正则。
  check(scriptLines.length >= 2,
    `ci-channels.sh 两处 scheme 校验都用冻结正则（scripts/ci-channels.sh:${scriptLines.join(',') || '未命中'}；期望 ≥2 处）`)

  const loose = lineNumbersOf(script.text, '^[a-z][a-z0-9+.-]*$')
  check(loose.length === 0,
    `ci-channels.sh 不得残留无上界正则 ^[a-z][a-z0-9+.-]*$（scripts/ci-channels.sh:${loose.join(',') || '—'}）`)
}

// ---------------------------------------------------------------------------
section('2. 仓库 pin 校验（upstream.json / .gitmodules / submodule 实际检出）')
{
  const upstream = JSON.parse(readFileSync(UPSTREAM_JSON, 'utf8'))
  const pinCommit = upstream.commit
  const pinVersion = upstream.runtimePackageVersion
  check(typeof pinCommit === 'string' && /^[0-9a-f]{40}$/.test(pinCommit),
    `upstream.json commit 必须是 40 位十六进制（实际 ${JSON.stringify(pinCommit)}）`)
  check(typeof pinVersion === 'string' && /^\d+\.\d+\.\d+-/.test(pinVersion),
    `upstream.json runtimePackageVersion 必须是 prerelease 版本（实际 ${JSON.stringify(pinVersion)}）`)
  check(upstream.sourceVersion === pinVersion,
    `upstream.json sourceVersion 必须等于 runtimePackageVersion（${JSON.stringify(upstream.sourceVersion)} vs ${JSON.stringify(pinVersion)}）`)

  const gitmodules = readFileSync(join(ROOT, '.gitmodules'), 'utf8')
  check(gitmodules.includes('deepseek-ai/deepseek-harness'),
    '.gitmodules 指向 deepseek-ai/deepseek-harness（上游 pin 的载体）')

  const status = spawnSync('git', ['submodule', 'status', 'deepseek-harness'], { cwd: ROOT, encoding: 'utf8' })
  const line = (status.stdout ?? '').trim()
  // 只断言**目标语义**：检出的 submodule commit == upstream.json 的 pin（`-` = 未初始化，必须失败）。
  //
  // 刻意**不**把「describe 段必须是 tag」写进断言 —— 那是"这个克隆有没有取到 tag"的
  // **环境性产物**：CI 的 actions/checkout 是浅检出、不带 tag，git 就打印缩写 hash
  // `(fb2c4b9e)`，于是同一条判据在 CI 恒红，而两端的 commit 其实完全相同（2026-09-20 实测：
  // PR #101 的 Gate 就红在这一条）。环境性产物一律只 WARN，不拦门禁。
  // 依据：`temp/wasm-client-only/AUDIT-CHARTER.md` §4.2「把新鲜度/环境守卫与目标断言分开」。
  const parsed = /^([-+U ])?\s*([0-9a-f]{40})\b/.exec(line)
  const state = parsed?.[1] ?? ''
  const commit = parsed?.[2] ?? ''
  check(status.status === 0 && state !== '-' && commit === pinCommit,
    `submodule 实际检出 commit = upstream.json 的 ${pinCommit}（实际 ${JSON.stringify(line)}）`)
  if (commit === pinCommit && !new RegExp(`\\(dsh-v[^)]*\\)`).test(line)) {
    console.log(`  WARN  submodule 的 describe 段不是 tag（${JSON.stringify(line)}）—— 浅检出/未取 tag 属正常，不拦门禁`)
  }

  // 设计总纲是**历史记录**（`docs/planning/`，记录面）：它冻结的是当时那个 pin，
  // 有意升级后与当前 pin 分歧属正常。因此这里只断言"它确实记录了一个 pin"，
  // 与当前 pin 不一致时给 WARN 而不是拦门禁。
  const doc = readLines(DESIGN_DOC)
  const recorded = /dsh-v\d+\.\d+\.\d+-(?:alpha|beta|rc)\.\d+/.exec(doc.text)?.[0]
  check(recorded !== undefined && PIN_TAG_PATTERN.test(recorded),
    `设计总纲必须记录它当时冻结的上游 pin（${DESIGN_DOC.replace(`${ROOT}/`, '')}）`)
  if (recorded !== undefined && !pinVersion.endsWith(recorded.replace(/^dsh-v/, ''))) {
    console.log(`  WARN  设计总纲记录的 pin 是 ${recorded}，当前 pin 是 ${pinVersion} —— 历史记录面，不拦门禁`)
  }
}

// ---------------------------------------------------------------------------
section('3. 渠道 CI dry-run：tag 名 → 渠道集（正式 tag 必须含 official）')
{
  const source = fakeChannelRepo(baselineSpecs())

  const formal = runChannels({ source, refName: 'v2.7.6' })
  const formalSet = sameSet(formal.selected, ['official', 'beta', 'example-brand'])
  check(formal.status === 0 && formalSet.equal,
    `正式 tag v2.7.6 ⇒ 全部渠道（含 official）；exit=${formal.status} ${formalSet.detail}`)
  if (formal.status !== 0) console.error(formal.stderr.trimEnd())

  const prerelease = runChannels({ source, refName: 'v2.7.6-beta.5' })
  const preSet = sameSet(prerelease.selected, ['beta'])
  check(prerelease.status === 0 && preSet.equal,
    `预发 tag v2.7.6-beta.5 ⇒ 仅 beta；exit=${prerelease.status} ${preSet.detail}`)

  const branch = runChannels({ source, refName: 'fix/server-p0-audit-2026-09-19', ref: 'refs/heads/fix/server-p0-audit-2026-09-19' })
  const branchSet = sameSet(branch.selected, ['official'])
  check(branch.status === 0 && branchSet.equal,
    `非 tag（分支）⇒ 仅 official；exit=${branch.status} ${branchSet.detail}`)
}

// ---------------------------------------------------------------------------
section(`4. ${APP_SCHEME_FIELD} 负例（每条都必须让渠道 CI 非 0 退出并点名字段）`)
{
  /**
   * 跑一条负例并断言「非 0 退出 + 点名字段」。
   * @param name - 用例名（打印用）。
   * @param specs - 夹具。
   * @param forbidden - 输出里**不得出现**的字符串（防品牌/取值泄漏）。
   */
  const expectAbort = (name, specs, forbidden = []) => {
    const result = runChannels({ source: fakeChannelRepo(specs), refName: 'v2.7.6' })
    const output = `${result.stdout}${result.stderr}`
    const named = output.includes(APP_SCHEME_FIELD)
    check(result.status !== 0 && named,
      `${name} ⇒ 非 0 且点名 ${APP_SCHEME_FIELD}（exit=${result.status}）`)
    for (const secret of forbidden) {
      check(!output.includes(secret),
        `${name} ⇒ 输出不得回显取值（检查 ${JSON.stringify(secret)}）`)
    }
    if (result.status === 0) console.error(output.trimEnd())
  }

  expectAbort('official 缺字段（公共渠道没有豁免）', [
    { id: 'official', appOriginScheme: null },
    { id: 'beta', appOriginScheme: 'picoaide-app' },
    { id: 'example-brand', appOriginScheme: 'examplebrand-app' },
  ], ['picoaide-app'])

  expectAbort('非法形状（大写 + 分隔符位置不合法）', [
    { id: 'official', appOriginScheme: 'Picoaide-App' },
    { id: 'beta', appOriginScheme: 'picoaide-app' },
    { id: 'example-brand', appOriginScheme: 'examplebrand-app' },
  ], ['Picoaide-App'])

  expectAbort('超长（>32 字符，验证上界 {1,31} 真的生效）', [
    { id: 'official', appOriginScheme: `a${'b'.repeat(40)}` },
    { id: 'beta', appOriginScheme: 'picoaide-app' },
    { id: 'example-brand', appOriginScheme: 'examplebrand-app' },
  ], [`a${'b'.repeat(40)}`])

  expectAbort('与 deep_link_scheme 同值（origin 与深链必须可分）', [
    { id: 'official', appOriginScheme: 'officiallink', deepLinkScheme: 'officiallink' },
    { id: 'beta', appOriginScheme: 'picoaide-app' },
    { id: 'example-brand', appOriginScheme: 'examplebrand-app' },
  ], ['officiallink'])

  expectAbort('保留 scheme（https）', [
    { id: 'official', appOriginScheme: 'https' },
    { id: 'beta', appOriginScheme: 'picoaide-app' },
    { id: 'example-brand', appOriginScheme: 'examplebrand-app' },
  ], [])

  expectAbort('跨渠道重复（品牌渠道与公共渠道撞名）', [
    { id: 'official', appOriginScheme: 'picoaide-app' },
    { id: 'beta', appOriginScheme: 'picoaide-app' },
    { id: 'example-brand', appOriginScheme: 'picoaide-app' },
  ], ['picoaide-app'])
}

// ---------------------------------------------------------------------------
section('5. 保留 scheme 契约对拍（设计总纲 §10 六项 = 真源；额外加固只 WARN）')
{
  // 口径（2026-09-19 主控订正，取代早期"三处逐字相等"的写法）：
  //   · **契约 = §10 冻结的六项**，真源是设计总纲原文（不是 CI 脚本，也不是运行期实现）；
  //   · CI 与客户端必须**包含**这六项（契约子集成立）；服务端 `ReservedAppOriginSchemes`
  //     声明为契约本身 ⇒ 必须**逐字**（含顺序）等于六项；
  //   · 客户端/服务端的**额外加固**（blob/ws/wss/ftp、chrome/chrome-extension/mailto/tel…）
  //     是各自的纵深防御、不是契约的一部分 ⇒ 只打 WARN 并列差集，不拦门禁；
  //   · **解析不到 = FAIL**：这条真的拦住过一次口径漂移（服务端重构把名单拆成两张表），
  //     所以失败必须点名"哪个文件的哪个符号找不到了"，让人一眼定位重构。
  const readQuotedList = (text, startMarker, endMarker) => {
    const start = text.indexOf(startMarker)
    if (start < 0) return null
    const end = text.indexOf(endMarker, start + startMarker.length)
    if (end < 0) return null
    return [...text.slice(start + startMarker.length, end).matchAll(/["']([a-z][a-z0-9+.-]*)["']/gu)].map(match => match[1])
  }
  const sameOrderedList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])

  // ---- 1) 契约六项：从设计总纲原文解析（出现多次时必须彼此一致） ----
  const docLines = readLines(DESIGN_DOC).lines
  const contractMatches = []
  docLines.forEach((line, index) => {
    const match = /不得是\s*`([a-z0-9+./]+)`/u.exec(line)
    if (match !== null && match[1].includes('/')) contractMatches.push({ list: match[1].split('/'), line: index + 1 })
  })
  const contract = contractMatches[0]?.list ?? null
  check(contract !== null && contract.length > 0,
    `设计总纲 §10 必须写明保留 scheme 契约名单（${REL(DESIGN_DOC)}:${contractMatches[0]?.line ?? '未命中'}）`)
  if (contract !== null) {
    check(contractMatches.every(match => sameOrderedList(match.list, contract)),
      `设计总纲里所有保留名单表述必须一致（命中行 ${contractMatches.map(match => match.line).join(', ')}）`)
    console.log(`  契约（§10，${contract.length} 项）：${contract.join(', ')}  ← ${REL(DESIGN_DOC)}:${contractMatches[0]?.line}`)
  }

  // ---- 2) 三处实现各自的符号（解析不到 ⇒ FAIL 并点名文件 + 符号） ----
  const ciText = readFileSync(CHANNELS_SCRIPT, 'utf8')
  const targets = [
    {
      label: 'CI',
      file: CHANNELS_SCRIPT,
      symbol: 'RESERVED_APP_ORIGIN_SCHEMES',
      start: 'RESERVED_APP_ORIGIN_SCHEMES = new Set(',
      end: '])',
      list: null,
      line: 0,
    },
    {
      label: '客户端',
      file: join(ROOT, 'packages/host/desktop/src/desktop-channel.ts'),
      symbol: 'RESERVED_APP_ORIGIN_SCHEMES',
      start: 'const RESERVED_APP_ORIGIN_SCHEMES = new Set(',
      end: '])',
      list: null,
      line: 0,
    },
    {
      label: '服务端（契约表）',
      file: join(ROOT, 'server/internal/channel/channel.go'),
      symbol: 'ReservedAppOriginSchemes',
      start: 'var ReservedAppOriginSchemes = []string{',
      end: '}',
      list: null,
      line: 0,
    },
  ]
  targets[0].line = lineNumbersOf(ciText, targets[0].start)[0] ?? 0
  targets[0].list = readQuotedList(ciText, targets[0].start, targets[0].end)
  for (const target of targets.slice(1)) {
    if (!existsSync(target.file)) continue
    const text = readFileSync(target.file, 'utf8')
    target.line = lineNumbersOf(text, target.start)[0] ?? 0
    target.list = readQuotedList(text, target.start, target.end)
  }
  for (const target of targets) {
    console.log(`  ${target.label}：${REL(target.file)}:${target.line} 符号 ${target.symbol}`)
    if (target.list === null) {
      // 解析不到 ⇒ 拆开写：失败信息必须点名"哪个文件的哪个符号找不到了"，
      // 否则重构换了个符号名时，门禁会静默失去意义（这条真的拦住过一次）。
      fail(`${REL(target.file)} 里找不到符号 ${target.symbol} —— 保留名单换了形态；本门禁会静默失去意义，必须同步改这里`)
    } else {
      pass(`${REL(target.file)} 的 ${target.symbol} 可解析（${target.list.length} 项）`)
    }
  }

  // ---- 3) 契约子集 / 服务端契约表逐字相等 ----
  if (contract !== null) {
    for (const label of ['CI', '客户端']) {
      const target = targets.find(candidate => candidate.label === label)
      if (target?.list === null || target?.list === undefined) continue
      const missing = contract.filter(scheme => !target.list.includes(scheme))
      check(missing.length === 0,
        `${label} 的保留名单必须覆盖 §10 契约六项（缺 ${missing.join(', ') || '—'}；${REL(target.file)}:${target.line}）`)
    }
    const server = targets.find(candidate => candidate.label === '服务端（契约表）')
    if (server?.list !== null && server?.list !== undefined) {
      check(sameOrderedList(server.list, contract),
        `服务端 ReservedAppOriginSchemes 必须逐字等于 §10 契约（实际 [${server.list.join(', ')}] / 期望 [${contract.join(', ')}]；${REL(server.file)}:${server.line}）`)
    }
  }

  // ---- 4) 额外加固：只 WARN（列差集，不拦门禁） ----
  const contractSet = new Set(contract ?? [])
  const client = targets.find(candidate => candidate.label === '客户端')
  const extras = [
    {
      label: '客户端额外加固',
      list: (client?.list ?? []).filter(scheme => !contractSet.has(scheme)),
      file: client?.file,
      line: client?.line,
    },
  ]
  const goPath = join(ROOT, 'server/internal/channel/channel.go')
  if (existsSync(goPath)) {
    const goText = readFileSync(goPath, 'utf8')
    const extraStart = 'var ExtraReservedAppOriginSchemes = []string{'
    extras.push({
      label: '服务端 ExtraReservedAppOriginSchemes（源码注释已声明不是契约）',
      list: readQuotedList(goText, extraStart, '}') ?? [],
      file: goPath,
      line: lineNumbersOf(goText, extraStart)[0] ?? 0,
    })
  }
  for (const extra of extras) {
    if (extra.list.length === 0) continue
    console.log(`  WARN  ${extra.label}（不拦门禁）：${extra.list.join(', ')}  ← ${extra.file === undefined ? '—' : REL(extra.file)}:${extra.line}`)
  }
  console.log('        口径：额外加固是各端纵深防御，不是契约；只有契约不一致才拦门禁（CI/客户端为契约子集 + 服务端契约表逐字）')
}

// ---------------------------------------------------------------------------
section('6. 真实渠道仓 dry-run（可选；未给目录时显式 SKIP，不静默通过）')
{
  const args = process.argv.slice(2)
  const flagIndex = args.indexOf('--channels-repo')
  const repo = flagIndex >= 0 ? args[flagIndex + 1] : process.env.WASM_CHANNELS_REPO
  if (repo === undefined || repo === '') {
    console.log('  SKIP 未提供 --channels-repo / WASM_CHANNELS_REPO：跳过真实渠道仓 dry-run（公开仓不持有渠道仓，也不联网）')
  } else {
    check(existsSync(join(repo, 'channels')), `${repo} 是渠道仓检出（含 channels/）`)
    const result = runChannels({ source: repo, refName: 'v2.7.6' })
    check(result.status === 0,
      `真实渠道仓正式 tag dry-run 通过（exit=${result.status}；渠道集 ${result.selected.length} 个）`)
    if (result.status !== 0) console.error(result.stderr.trimEnd())
  }
}

for (const dir of scratch) rmSync(dir, { recursive: true, force: true })

console.log(`\n===== ${failures.length === 0 ? '全部通过 ✅' : `存在失败项 ❌（${failures.length} 条）`} =====`)
for (const message of failures) console.error(`- ${message}`)
process.exit(failures.length === 0 ? 0 : 1)
