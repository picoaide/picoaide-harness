#!/usr/bin/env node
/**
 * 补丁 resolution 键门禁:每个带 patch 的包必须在 `resolutions` 里同时拥有
 * **exact 键**与 **`^` 键**,且两者指向同一个 patch 文件。
 *
 * 为什么值得单独门禁(2026-09-12 二次审查 P1-4 的教训):
 *   yarn 的 `resolutions` 是**按描述符**匹配的。上游包把依赖写成 `^0.1.5-rc.2`,
 *   我们自己的 manifest 写死 `0.1.5-rc.2`;只登记 exact 键时,`^` 描述符会落到
 *   **未打补丁**的普通 resolution 上,于是 `node_modules/<pkg>/node_modules/...`
 *   里出现未打补丁的嵌套副本(`dsh-web-app`/`dsh-base`/`dsh-sdk-minimal` 下实测
 *   各有一份)。今天 Loader 恰好锚定顶层副本所以"看起来没事",但
 *   "补丁覆盖所有副本"的不变量已经破了,下一次升级/提层就会静默吃掉补丁。
 *   `scripts/upgrade-upstream.mjs` 本来就会同时改两种键,本次是历史遗漏 ——
 *   这条门禁把"遗漏"变成红灯。
 *
 * 同时校验:
 *   1. exact / `^` 两键的基础版本一致(`0.1.5-rc.2` ↔ `^0.1.5-rc.2`);
 *   2. 某个 patch 包的所有 resolution 键都指向同一个 patch 文件;
 *   3. `patches/*.patch` 与 resolutions 里的 patch 目标 **1:1**(没有孤儿补丁,
 *      也没有指向不存在文件的键);补丁文件名必须是 `<包名>@<版本>.patch`
 *      (升级脚本按这个形状改名)。
 *
 * 用法:node scripts/verify-patch-resolutions.mjs [--strict-lock]
 *   默认对 `yarn.lock` 里"`^` 描述符仍解析到非 patch 副本"只告警(离线无法重解析,
 *   需要 `yarn install` 才会重写锁文件);`--strict-lock` 让它直接失败。
 * 退出码:0 全部通过;1 有断言失败。
 *
 * 改动 resolutions 后必须由**主 agent 执行 `yarn install` 并提交 yarn.lock**
 * (本脚本刻意不跑 yarn,不会改写锁文件)。
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { listPatchFiles, readPatchTargets } from './patch-targets.mjs'

const root = resolve(import.meta.dirname, '..')
const strictLock = process.argv.includes('--strict-lock')
const failures = []
const warnings = []
const notes = []

const fail = message => failures.push(message)
const warn = message => warnings.push(message)
const note = message => notes.push(message)

/**
 * 允许"只有 exact 键"的补丁包。豁免不是免检:每一条都必须能证明**没有任何
 * 依赖者用 `^` 请求这个包**(见下面 `lockAsksForCaret()`),否则门禁照样红。
 *
 * 目前只有 app-builder-lib:electron-builder 以精确范围 `26.15.3` 依赖它,
 * yarn.lock 里只有 `app-builder-lib@npm:26.15.3` 一个描述符,装出来也只有一份
 * 顶层副本。哪天有依赖者改用 `^26.15.3`,这条豁免的证据失效 → 门禁要求补 `^` 键。
 */
const EXACT_ONLY_ALLOWED = new Map([
  ['app-builder-lib', 'electron-builder 用精确范围 26.15.3 依赖它(yarn.lock 无 ^ 描述符)'],
])

/** 正则元字符转义(yarn.lock 描述符里含 `.` `+` `^` 等)。 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * 找出 yarn.lock 里描述符表命中了 `descriptor` 的条目。
 * 描述符表形如 `"a@npm:1, a@npm:^1":` —— 只有第一个描述符带引号,
 * 所以按"token 边界"匹配而不是按引号匹配。
 * @param lockText - yarn.lock 内容(缺失时为 undefined)。
 * @param descriptor - 完整描述符(如 `pkg@npm:^1.0.0`)。
 * @returns 命中的 lock 条目文本列表。
 */
function lockBlocksForDescriptor(lockText, descriptor) {
  if (lockText === undefined) return []
  const pattern = new RegExp(`(?:^|[",\\s])${escapeRegExp(descriptor)}(?:["\\s,]|$)`, 'u')
  const blocks = []
  for (const block of lockText.split(/\n\n+/u)) {
    const header = block.split('\n', 1)[0] ?? ''
    if (!header.endsWith(':')) continue
    if (pattern.test(header)) blocks.push(block)
  }
  return blocks
}

/** 补丁包在 patches/ 下的期望文件名(`<去掉 scope 的包名>@<版本>.patch`)。 */
function expectedPatchFileName(name, version) {
  return `${name.replace(/^@[^/]+\//u, '')}@${version}.patch`
}

/**
 * yarn.lock 的描述符表里是否有人用 `^<version>` 请求这个包。
 * 这是"要不要 caret 键"的证据来源:`^` 描述符一旦出现,只登记 exact 键就会让
 * 它落到未打补丁的普通 resolution 上。
 * @param lockText - yarn.lock 内容(可能为 undefined)。
 * @param name - 包名。
 * @param version - 版本。
 * @returns 是否存在 `^` 描述符;锁文件缺失时返回 undefined(证据不可得)。
 */
function lockAsksForCaret(lockText, name, version) {
  if (lockText === undefined) return undefined
  return lockBlocksForDescriptor(lockText, `${name}@npm:^${version}`).length > 0
}

const { targets, resolutions, failures: parseFailures } = readPatchTargets(root)
failures.push(...parseFailures)

if (targets.length === 0) {
  fail('根 package.json 的 resolutions 里没有任何 patch 目标;既然仓库有 patches/,这里不该为空')
}

const allResolutionKeys = Object.keys(resolutions)

/** yarn.lock(缺失时 undefined;离线门禁只读不改)。 */
let lockText
try {
  lockText = readFileSync(join(root, 'yarn.lock'), 'utf8')
} catch {
  lockText = undefined
}

for (const target of targets) {
  const where = `package.json resolutions["${target.name}@${target.version}"]`
  const descriptors = target.keys.map(entry => entry.descriptor)

  // 1. exact 键必填;`^` 键:有 `^` 请求者(或不在豁免表里)时必填。
  const exactKey = `${target.name}@npm:${target.version}`
  const caretKey = `${target.name}@npm:^${target.version}`
  const hasCaretKey = allResolutionKeys.includes(caretKey)
  if (!allResolutionKeys.includes(exactKey)) {
    fail(`${where}: 缺少 exact 键 "${exactKey}"`)
  }
  const caretRequested = lockAsksForCaret(lockText, target.name, target.version)
  const exempt = EXACT_ONLY_ALLOWED.get(target.name)
  if (!hasCaretKey) {
    if (caretRequested === true) {
      fail(
        `${where}: 缺少 "^" 键 "${caretKey}" —— 依赖者用 "^${target.version}" 请求它,`
        + 'yarn 会把该描述符解析到**未打补丁**的副本(嵌套 node_modules 里实测存在未打补丁拷贝)。'
        + `照抄同文件里已有的 "…@npm:^0.1.5-rc.2" 写法补上,再由主 agent 跑 yarn install 提交 yarn.lock`,
      )
    } else if (caretRequested === undefined) {
      fail(
        `${where}: 缺少 "^" 键 "${caretKey}",而 yarn.lock 不可读 —— 无法证明没有 "^" 请求者。`
        + '请先安装依赖(corepack yarn install --immutable)后复跑',
      )
    } else if (exempt === undefined) {
      fail(
        `${where}: 缺少 "^" 键 "${caretKey}"。当前 yarn.lock 里没有 "^" 请求者,但本包不在`
        + ' EXACT_ONLY_ALLOWED 豁免表里;请补键,或把"无 ^ 请求者"的证据写进豁免表',
      )
    } else {
      note(`${where}: 只有 exact 键(已豁免:${exempt});yarn.lock 里没有 "^" 请求者`)
    }
  } else if (exempt !== undefined) {
    warn(`${target.name} 已同时有 exact/^ 键,可从 verify-patch-resolutions.mjs 的 EXACT_ONLY_ALLOWED 移除`)
  }

  // 2. 所有键的取值必须都是同一个 patch(不允许同包出现非 patch 键)。
  for (const entry of target.keys) {
    const value = resolutions[entry.key]
    if (value !== target.patchValue) {
      fail(`${where}: 键 "${entry.key}" 指向 ${String(value)},与其它键的 patch 目标不一致`)
    }
  }

  // 3. 描述符形状:只认 `<name>@npm:<version>` / `<name>@npm:^<version>`。
  for (const descriptor of descriptors) {
    if (!/^npm:\^?\d/u.test(descriptor)) {
      fail(
        `${where}: 不支持 resolution 键形状 "${target.name}@${descriptor}"`
        + '(本门禁只认识精确版本与 "^" 版本两种键;新增形状时请同步扩展 scripts/verify-patch-resolutions.mjs)',
      )
    }
  }

  // 4. 基础版本一致。
  for (const descriptor of descriptors) {
    const bare = descriptor.replace(/^npm:\^?/u, '')
    if (bare !== target.version) {
      fail(
        `${where}: 键 "${target.name}@${descriptor}" 的版本与补丁版本 ${target.version} 不一致`
        + '(exact 与 "^" 必须是同一个基础版本)',
      )
    }
  }

  // 5. 补丁文件名形状(升级脚本按 `<包名>@<版本>.patch` 改名)。
  const expected = `patches/${expectedPatchFileName(target.name, target.version)}`
  if (target.patchPath !== expected) {
    fail(`${where}: patch 文件名为 ${target.patchPath},期望 ${expected}(升级脚本按此形状改名)`)
  }
}

// 6. patches/*.patch 与 patch 目标 1:1。
const patchFiles = listPatchFiles(root)
const referenced = new Set(targets.map(target => target.patchPath))
for (const file of patchFiles) {
  if (!referenced.has(file)) {
    fail(`${file}: 补丁文件没有被任何 resolutions 键引用(孤儿补丁,永远不会生效)`)
  }
}
for (const target of targets) {
  if (!patchFiles.includes(target.patchPath)) {
    fail(`package.json resolutions 引用了不存在的补丁文件 ${target.patchPath}`)
  }
}

// 7. 非 patch 键不得命中 patch 包名(否则该描述符会拿到未打补丁副本)。
const patchNames = new Set(targets.map(target => target.name))
for (const [key, value] of Object.entries(resolutions)) {
  const name = key.includes('@npm:') ? key.slice(0, key.indexOf('@npm:')) : undefined
  if (name === undefined || !patchNames.has(name)) continue
  if (typeof value === 'string' && value.startsWith('patch:')) continue
  fail(
    `package.json resolutions["${key}"] = ${String(value)}:patch 包 ${name} 的这个描述符键没有指向补丁`
    + '(描述符键与 exact 键必须成对且都指向同一个 patch)',
  )
}

// 8. yarn.lock 诊断:`^` 描述符仍解析到非 patch 副本 = 需要 yarn install 重写锁文件。
for (const target of targets) {
  const caretDescriptor = `${target.name}@npm:^${target.version}`
  for (const block of lockBlocksForDescriptor(lockText, caretDescriptor)) {
    if (/^\s*resolution: "?[^"\n]*patch:/mu.test(block)) continue
    const message = `yarn.lock: 描述符 ${caretDescriptor} 仍解析到非 patch 副本 —— 需要主 agent 执行`
      + ' `corepack yarn install` 并提交 yarn.lock(离线门禁不会自己改写锁文件)'
    if (strictLock) fail(message)
    else warn(message)
  }
}

for (const message of notes) process.stdout.write(`verify-patch-resolutions: 提示: ${message}\n`)
for (const message of warnings) process.stderr.write(`verify-patch-resolutions: 警告: ${message}\n`)

if (failures.length > 0) {
  process.stderr.write(`\nverify-patch-resolutions: ${failures.length} 项断言失败\n`)
  for (const message of failures) process.stderr.write(`- ${message}\n`)
  process.exit(1)
}

const summary = targets
  .map(target => {
    const caret = target.keys.some(entry => entry.descriptor.startsWith('npm:^'))
    return `  ${`${target.name}@${target.version}`.padEnd(58)} ${caret ? 'exact + ^' : 'exact(已豁免 ^)'} → ${target.patchPath}`
  })
  .join('\n')
process.stdout.write(
  `verify-patch-resolutions: OK — ${targets.length} 个补丁包的 resolution 键与`
  + ` patches/ 下 ${patchFiles.length} 个补丁文件一一对应\n${summary}\n`,
)
