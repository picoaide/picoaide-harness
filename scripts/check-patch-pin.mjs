#!/usr/bin/env node
/**
 * 补丁 ↔ 上游 pin 的版本绑定门禁。
 *
 * 为什么需要它（2026-09-20 DSH 0.1.6 升级审计，模块 H 判为 **P0 门禁盲区**）：
 *
 *   我们要打补丁的 4 个包（`dsh-subprocess-local` / `dsh-tool-fs-search` /
 *   `dsh-win32-process` / `dsh-client-ui-brand-official`）**根本不在任何 manifest
 *   的 deps/devDeps 里** —— 它们只靠 `resolutions` 的 patch 描述符接进来。
 *   而既有的三道防线各有盲区：
 *     · `verify-layout.mjs:190-197` 只查 4 个 manifest 的 `dependencies` +
 *       `peerDependencies`（**不含 `devDependencies`，也不看 `resolutions`**）；
 *     · `verify-patch-resolutions.mjs` / `verify-patches.mjs` 只做
 *       `resolutions ↔ patches/ ↔ .yarn/cache` 的**自洽**对拍，从不读 pin；
 *     · yarn 4.18.0 对**没有描述符命中**的 resolution 是**静默忽略**的。
 *
 *   合起来的效果：升级时漏改一条 resolution 版本 ⇒ yarn 按未打补丁的 pristine
 *   包安装、补丁**静默消失**，而三个门禁全绿。受害面是沙箱托管、全局搜索 asar
 *   路径、Windows 隐藏控制台、品牌样式 —— 全是"不报错但功能退化"的形态。
 *
 * 本门禁把这条链补上，断言四件事：
 *   1. 每条 `patch:` resolution 的目标版本 == `upstream.json` 的
 *      `runtimePackageVersion`（pin 的唯一真源）；resolution **键**里的版本同源；
 *   2. 该 patch 文件确实存在，且 `patches/` 下没有孤儿补丁；
 *   3. 对于已安装的补丁目标包（`node_modules/<name>/package.json` 存在时），
 *      它的**实际版本**必须等于 pin —— 这是"resolution 静默失配"的直接判据：
 *      版本对不上说明描述符没命中，装进去的就是未打补丁的副本；
 *   4. 补丁文件名形如 `<包名>@<版本>.patch`（升级脚本按这个形状改名）。
 *
 * 第三方补丁（例如 `app-builder-lib`，非 `@deepseek-ai/dsh-*`）**豁免**版本绑定：
 * 它们跟随自己的版本线，与 DSH pin 无关。
 *
 * 用法：`node scripts/check-patch-pin.mjs`；退出码 0 通过、1 有断言失败。
 * 未安装依赖时第 3 条自动跳过（门禁可离线跑），并打印提示而不是假绿。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const failures = []
const notes = []

/** 只有上游 DSH 家族的包跟随 pin；其余（第三方）豁免。 */
const PIN_BOUND = /^@deepseek-ai\/dsh-/

const upstream = JSON.parse(readFileSync(join(root, 'upstream.json'), 'utf8'))
const pin = upstream.runtimePackageVersion
if (typeof pin !== 'string' || !/^\d+\.\d+\.\d+-/.test(pin)) {
  process.stderr.write(`check-patch-pin: upstream.json runtimePackageVersion 不合法: ${JSON.stringify(pin)}\n`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const resolutions = manifest.resolutions ?? {}

/**
 * 解析一条 patch resolution。
 * 形状：`patch:<name>@npm%3A<version>#./patches/<file>.patch`
 * @param value - resolution 取值。
 * @returns 拆出的名字 / 版本 / 补丁相对路径；形状不符返回 undefined。
 */
function parsePatchValue(value) {
  const match = /^patch:(@?[^@]+)@npm%3A([^#]+)#(.+)$/.exec(value)
  if (match === null) return undefined
  return { name: match[1], version: match[2], patchPath: match[3].replace(/^\.\//u, '') }
}

const patchDir = join(root, 'patches')
const patchFiles = existsSync(patchDir)
  ? readdirSync(patchDir).filter(name => name.endsWith('.patch')).sort()
  : []
const referenced = new Set()
let checked = 0
let skippedThirdParty = 0

for (const [key, value] of Object.entries(resolutions)) {
  if (typeof value !== 'string' || !value.startsWith('patch:')) continue
  const parsed = parsePatchValue(value)
  if (parsed === undefined) {
    failures.push(`resolution ${JSON.stringify(key)} 的 patch 取值形状无法解析: ${JSON.stringify(value)}`)
    continue
  }
  referenced.add(parsed.patchPath)
  if (!PIN_BOUND.test(parsed.name)) {
    skippedThirdParty += 1
    continue
  }
  checked += 1

  // 1. 取值里的版本 + 键里的版本都必须等于 pin。
  if (parsed.version !== pin) {
    failures.push(
      `resolution ${JSON.stringify(key)} 指向 ${parsed.name}@${parsed.version}，`
      + `但 upstream.json 的 pin 是 ${pin}（漏改这条 ⇒ yarn 静默忽略该 resolution、补丁消失）`,
    )
  }
  const keyVersion = /@npm:\^?(.+)$/u.exec(key)?.[1]
  if (keyVersion !== pin && keyVersion !== `^${pin}`) {
    failures.push(`resolution 键 ${JSON.stringify(key)} 的版本不是 ${pin} / ^${pin}（实际 ${JSON.stringify(keyVersion)}）`)
  }

  // 2. 补丁文件必须存在，且文件名里的版本段必须是 pin。
  //    命名约定 = 包名去掉 npm scope（`@deepseek-ai/`）后接 `@<pin>.patch`，
  //    与 `upgrade-upstream.mjs` 的 `migratePatchFiles()`（只替换版本段）一致。
  if (!existsSync(join(root, parsed.patchPath))) {
    failures.push(`resolution ${JSON.stringify(key)} 指向的补丁文件不存在: ${parsed.patchPath}`)
  } else {
    const actual = parsed.patchPath.replace(/^patches\//u, '')
    const base = parsed.name.replace(/^@[^/]+\//u, '')
    const expected = `${base}@${pin}.patch`
    if (actual !== expected) {
      failures.push(`补丁文件名 ${actual} 必须是 ${expected}（升级脚本按 <包名去 scope>@<pin>.patch 改名）`)
    }
  }

  // 3. 已安装的补丁目标必须是 pin 版本（静默失配的直接判据）。
  const installed = join(root, 'node_modules', parsed.name, 'package.json')
  if (existsSync(installed)) {
    const version = JSON.parse(readFileSync(installed, 'utf8')).version
    if (version !== pin) {
      failures.push(
        `已安装的 ${parsed.name} 版本是 ${version}，不是 pin ${pin} ——`
        + ' resolution 描述符没有命中，装进去的是**未打补丁**的副本',
      )
    }
  }
}

// 4. 孤儿补丁：patches/ 下有文件但没有任何 resolution 引用它。
for (const file of patchFiles) {
  if (!referenced.has(`patches/${file}`)) {
    failures.push(`patches/${file} 没有被任何 resolution 引用（孤儿补丁）`)
  }
}

// 未安装依赖时第 3 条整块跳过 —— 明确提示，不要让它看起来像"已校验"。
if (!existsSync(join(root, 'node_modules'))) {
  notes.push('未找到 node_modules：已跳过「已安装补丁目标版本 == pin」这条断言（跑 yarn install 后才是完整判据）')
}

for (const message of notes) process.stdout.write(`check-patch-pin: 提示: ${message}\n`)
if (failures.length > 0) {
  process.stderr.write(`\ncheck-patch-pin: ${failures.length} 项断言失败\n`)
  for (const message of failures) process.stderr.write(`- ${message}\n`)
  process.exit(1)
}
process.stdout.write(
  `check-patch-pin: OK — ${checked} 个 DSH 补丁目标绑定在 pin ${pin}`
  + `（第三方补丁豁免 ${skippedThirdParty} 条；patches/ 共 ${patchFiles.length} 个文件）\n`,
)
