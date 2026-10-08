/**
 * Verify every production dependency shipped inside the desktop installers
 * carries a permissive license that allows redistribution.
 *
 * Walks the production dependency graph (dependencies + optionalDependencies,
 * excluding dev/peer) starting from this package manifest. Fails when a
 * package has no license field and no LICENSE file, or when its license is
 * not on the redistribution allowlist.
 *
 * An **empty** production dependency graph is a failure too (2026-09-23 R3-C
 * 六处形态①): "0 packages checked" is indistinguishable from "all packages
 * compliant", and the desktop package is never dependency-free in practice —
 * an empty tree means the manifest lost its `dependencies` or the resolver
 * walked nothing. Pass `--allow-empty` to opt out explicitly (the opt-out is
 * printed, never silent).
 *
 * Usage: node scripts/verify-licenses.mjs [--allow-empty]
 *        node scripts/verify-licenses.mjs --notices <file>
 *        node scripts/verify-licenses.mjs --check-notices <file>
 * Exit codes: 0 = ok; 1 = violations (including an empty production tree
 * without `--allow-empty`) or bad CLI usage.
 *
 * @module scripts/verify-licenses
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const rootManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
// 显式豁免"空生产依赖树"（见文件头）。缺省不带 ⇒ 空树 fail-loud。
const allowEmpty = process.argv.includes('--allow-empty')

/** Licenses accepted for redistribution inside the desktop installers. */
const ALLOWED_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'Unlicense',
  'MPL-2.0',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Zlib',
  'Python-2.0',
])

/**
 * Licenses that permit redistribution only when their notice obligations are
 * honored. Sharp ships libvips as a separate @img/sharp-libvips-* package on
 * macOS and inside the @img/sharp-win32-* package on Windows. Their license
 * texts ship inside node_modules in the installer. Keep this list minimal and
 * review any addition.
 */
const NOTICE_LICENSES = new Set([
  'LGPL-3.0-or-later',
  'Apache-2.0 AND LGPL-3.0-or-later',
])

/**
 * Locate one installed package manifest by walking node_modules directories
 * upward from the parent manifest. Reads the real package.json regardless of
 * the package's `exports` map, which often hides the `./package.json` subpath.
 */
function resolvePackageManifest(name, fromManifestPath) {
  const segments = name.split('/')
  const folder = name.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  const entry = name.startsWith('@') ? segments.slice(2).join('/') : segments.slice(1).join('/')
  let dir = dirname(fromManifestPath)
  for (;;) {
    const candidate = join(dir, 'node_modules', folder, entry, 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** Normalize the license field of one package manifest. */
function licenseExpression(manifest) {
  const value = manifest.license
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && typeof value.type === 'string') return value.type
  if (Array.isArray(manifest.licenses)) {
    return manifest.licenses
      .map((item) => (typeof item === 'string' ? item : item.type))
      .filter(Boolean)
      .join(' OR ')
  }
  return undefined
}

const failures = []
const seen = new Set()
const manifests = []
const queue = [{ name: rootManifest.name ?? 'dsh-plugin-desktop', manifestPath: join(packageRoot, 'package.json') }]

for (let index = 0; index < queue.length; index += 1) {
  const current = queue[index]
  if (current === undefined || seen.has(current.name)) continue
  seen.add(current.name)
  const manifest = JSON.parse(readFileSync(current.manifestPath, 'utf8'))

  if (current.name !== rootManifest.name) {
    const license = licenseExpression(manifest)
    const hasLicenseFile = existsSync(join(dirname(current.manifestPath), 'LICENSE'))
      || existsSync(join(dirname(current.manifestPath), 'LICENSE.md'))
      || existsSync(join(dirname(current.manifestPath), 'LICENSE.txt'))
    // Compound SPDX expressions (OR/AND) are acceptable when every subterm
    // is on the allowlist (e.g. dompurify's "(MPL-2.0 OR Apache-2.0)").
    const subterms = license === undefined
      ? []
      : license.replaceAll('(', '').replaceAll(')', '').split(/\s+(?:OR|AND)\s+/u)
    const everySubtermAllowed = license !== undefined
      && subterms.length > 0
      && subterms.every(subterm => ALLOWED_LICENSES.has(subterm.trim()) || NOTICE_LICENSES.has(subterm.trim()))
    // A lowercase `license` file is the same notice as LICENSE on case-sensitive
    // filesystems (khroma ships `license`, MIT).
    const hasLicenseText = hasLicenseFile
      || existsSync(join(dirname(current.manifestPath), 'license'))
      || existsSync(join(dirname(current.manifestPath), 'license.md'))
      || existsSync(join(dirname(current.manifestPath), 'license.txt'))
    if (license === undefined && !hasLicenseText) {
      failures.push(`${current.name}: no license field and no LICENSE file`)
    } else if (everySubtermAllowed) {
      // all subterms allowed
    } else if (license !== undefined && license.startsWith('SEE LICENSE IN ')) {
      if (!hasLicenseFile) {
        failures.push(`${current.name}: license refers to ${JSON.stringify(license)} but no LICENSE file is shipped`)
      }
    } else if (license !== undefined && !ALLOWED_LICENSES.has(license) && !NOTICE_LICENSES.has(license)) {
      failures.push(`${current.name}: license ${JSON.stringify(license)} is not on the redistribution allowlist`)
    }
    // A lowercase `license`/`license.md` MIT-equivalent file without a license
    // field is accepted as redistribution-safe (khroma).
    if (license === undefined && hasLicenseText) {
      const noticePath = existsSync(join(dirname(current.manifestPath), 'license'))
        ? join(dirname(current.manifestPath), 'license')
        : existsSync(join(dirname(current.manifestPath), 'license.md'))
          ? join(dirname(current.manifestPath), 'license.md')
          : join(dirname(current.manifestPath), 'license.txt')
      const notice = readFileSync(noticePath, 'utf8').slice(0, 500)
      if (!/MIT|ISC|BSD|Apache|BlueOak|Unlicense|0BSD|CC0/i.test(notice)) {
        failures.push(`${current.name}: license file ${JSON.stringify(noticePath)} is not a recognized permissive license`)
      }
    }
    manifests.push({ name: current.name, version: manifest.version, license: license ?? 'SEE LICENSE FILE' })
  }

  const requireFrom = createRequire(current.manifestPath)
  void requireFrom
  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      const resolved = resolvePackageManifest(name, current.manifestPath)
      if (resolved === undefined) {
        // Optional dependencies may legitimately be absent on this platform.
        if (section === 'optionalDependencies') continue
        failures.push(`${current.name} -> ${name}: could not locate its manifest`)
        continue
      }
      queue.push({ name, manifestPath: resolved })
    }
  }
}

// 六处形态①（2026-09-23 三轮审计 R3-C）：空生产依赖树**不是**"全部合规"，而是
// "没有检查对象"。旧实现在这种情况下打印
// `verify-licenses: 0 production packages carry redistribution-safe licenses` 并 exit 0，
// 与"依赖树真的逐包查过且全合规"完全无法区分 —— 而桌面包在现实中永远不是零依赖
// （`dependencies` 被误删、或解析链断在 node_modules 上都会落到这里）。
// 显式豁免只有一个入口：`--allow-empty`（且它会被打印出来，不是静默放行）。
const totalProduction = seen.size - 1
if (totalProduction === 0 && !allowEmpty) {
  failures.push(
    'no production package was resolved from this manifest (dependencies + optionalDependencies) —— '
    + '"0 packages checked" is not "all packages compliant". If the desktop package is intentionally '
    + 'dependency-free, rerun with --allow-empty; otherwise check that `dependencies` survived and that '
    + 'node_modules is installed (`corepack yarn install --immutable`).',
  )
}

if (failures.length > 0) {
  process.stderr.write(`verify-licenses: ${failures.length} production package(s) need attention\n`)
  for (const failure of failures) process.stderr.write(`- ${failure}\n`)
  process.exit(1)
}
const noticeOnly = manifests.filter(entry => NOTICE_LICENSES.has(entry.license))

/**
 * 随包分发的**非 npm 第三方产物**（模型权重）。
 *
 * 这些文件不进依赖树，所以上面的包表覆盖不到它们，但它们是**客户交付物的一部分**
 * （随安装包分发，约 230 MB）。清单是静态的：升级模型时改这里并重跑
 * `verify:notices:write`，生成器与比对基准仍是同一份实现。
 *
 * 两条许可是**不同**的，不能合并成"开源"一句：
 *  · SenseVoiceSmall 权重走 FunASR 模型开源协议（不是代码仓的 MIT）：允许使用、
 *    复制、修改、分享，但 §2.2 要求**署名来源与作者并保留模型名** —— 所以下面
 *    逐字写出模型名与导出仓。
 *  · Silero VAD 是 MIT。
 * @see `deepseek-harness/packages/experimental/speech-to-text-sensevoice/runtime/assets.json`
 *   上游钉死的三个文件的 URL 与 sha256（本仓随包的是同一份字节）。
 */
const BUNDLED_MODEL_NOTICES = [
  {
    name: 'SenseVoiceSmall (int8 ONNX)，随 sherpa-onnx 导出分发',
    source: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    license: 'FunASR Model Open Source License Agreement v1.1 (Alibaba Group)',
    terms: '允许使用、复制、修改与分享；§2.2 要求署名来源与作者信息并保留模型名。',
  },
  {
    name: 'Silero VAD (silero_vad.onnx)',
    source: 'https://huggingface.co/csukuangfj/vad',
    license: 'MIT (Silero Team)',
    terms: '标准 MIT 条款。',
  },
]

/**
 * 随包 agent 运行时（node + pnpm + python，2026-10-08）—— 非 npm 产物，另有随包许可文本。
 *
 * 这三套是**第三方预编译制品**（不是从 npm 依赖树来的），所以上面那张表扫不到它们。
 * 再分发合规有两条：① 通告里点名来源与许可；② **许可正文随包**（各自运行时目录下的
 * `LICENSE` / `lib/python<X.Y>/LICENSE.txt`，由 `fetch-bundled-runtimes.mjs` 记录进载荷
 * 清单、afterPack 门禁逐条断言）。版本与来源的**唯一真源**是 `runtimes.json`。
 */
const BUNDLED_RUNTIME_NOTICES = (() => {
  // 版本/来源**不在这里写死**：真源是 `runtimes.json`（打包期就是按它下载与校验的）。
  // 写死一份的后果是"通告说 24.21.0、随包其实是别的版本"，而没有任何判据会发现。
  //
  // 文件缺席 ⇒ 这棵树**没有声明**随包运行时（`scripts/verify-check-workspaces.mjs` 的
  // 合成树就是这种形态：它们只放 scripts/ + package.json）。这条不像 npm 依赖树那样
  // "读不出就必须红"：真仓删掉 `runtimes.json` 会在 desktop 套件里当场红
  // （`tests/bundled-runtimes.spec.ts` 直接解析它、`channel-prepare` 的 TS 侧也 import
  // 同一个路径），所以这里不必再复制一条判据，而复制出来的那条只会把合成树夹具判死。
  const pinPath = new URL('../runtimes.json', import.meta.url)
  if (!existsSync(pinPath)) return []
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  return [
    {
      name: `Node.js (v${pin.node.version}，随包 node 运行时)`,
      source: pin.node.base,
      license: 'MIT（Node.js 及其内嵌组件的许可文本随包在 node/LICENSE）',
      terms: '标准 MIT 条款；随包的是官方预编译发行包，未做修改（按 runtimes.json 钉死的 sha256 校验）。',
    },
    {
      name: `pnpm (${pin.pnpm.version}，随包包管理器)`,
      source: `https://www.npmjs.com/package/pnpm/v/${pin.pnpm.version}`,
      license: 'MIT',
      terms: '标准 MIT 条款；以 npm 发行包形式随包（pnpm/LICENSE 随包），用随包 node 执行。',
    },
    {
      name: `CPython (${pin.python.version}，python-build-standalone ${pin.python.release}，随包 python 运行时)`,
      source: pin.python.source,
      license: 'PSF-2.0（其内嵌第三方组件的许可文本随包在 CPython 的 LICENSE.txt）',
      terms: 'Python 软件基金会许可协议第 2 版；随包的是官方 install_only_stripped 预编译包，未做修改。',
    },
  ]
})()

/**
 * Render the shipped third-party notice list.
 *
 * `--notices`(覆盖写)与 `--check-notices`(比对)共用这一份渲染:生成器与比对
 * 基准只允许有一处实现,否则"生成器改了但基准没改"就是假绿。
 * 注意保留历史语义:空行会被过滤掉、文件**不以换行结尾**(与仓库里现有的
 * THIRD_PARTY_NOTICES.md 逐字节一致,避免重生成时产生无意义 diff)。
 * @param entries - 依赖树里的包(`{ name, version, license }`)。
 * @returns Markdown 文本。
 */
function renderNotices(entries) {
  const noticeEntries = entries.filter(entry => NOTICE_LICENSES.has(entry.license))
  const lines = [
    '# Third-Party Notices',
    '',
    'PicoAide Harness distributes the following third-party packages inside its installers.',
    'Each package ships with its own license text in the application files; this list records',
    'the package names, versions, and licenses for transparency.',
    '',
    '| Package | Version | License |',
    '| --- | --- | --- |',
    ...entries
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => `| ${entry.name} | ${entry.version ?? ''} | ${entry.license} |`),
    '',
    noticeEntries.length === 0
      ? ''
      : `> Notice-required licenses in use: ${[...new Set(noticeEntries.map(entry => entry.license))].join(', ')}. Their license texts ship inside node_modules; see the package LICENSE files for the full terms.`,
    '',
    '## Bundled agent runtimes',
    '',
    'The installers also ship the node, pnpm and python runtimes the agent runs on. They are not',
    'npm packages, so the table above does not cover them; each runtime keeps its own license text',
    'inside `resources/runtimes/<runtime>/`, and the packaging gate refuses a build whose payload is',
    'missing any of those texts.',
    '',
    ...BUNDLED_RUNTIME_NOTICES.flatMap(notice => [
      `### ${notice.name}`,
      '',
      `- Source: ${notice.source}`,
      `- License: ${notice.license}`,
      `- Terms: ${notice.terms}`,
      '',
    ]),
    '## Bundled speech-recognition model weights',
    '',
    'The installers also ship speech-recognition model weights. They are not npm packages, so',
    'the table above does not cover them; these are their names, sources, and licenses.',
    '',
    ...BUNDLED_MODEL_NOTICES.flatMap(notice => [
      `### ${notice.name}`,
      '',
      `- Source: ${notice.source}`,
      `- License: ${notice.license}`,
      `- Terms: ${notice.terms}`,
      '',
    ]),
  ].filter(line => line !== '')
  return lines.join('\n')
}

/** Resolve a CLI path argument(绝对路径原样使用,相对路径按包根解析)。 */
function resolveNoticeTarget(target) {
  return isAbsolute(target) ? target : join(packageRoot, target)
}

/** 行级差异摘要(只看"多/少 哪些行",给人可操作的错误信息)。 */
function diffSummary(actualText, expectedText) {
  const count = (text) => {
    const map = new Map()
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1)
    return map
  }
  const actual = count(actualText)
  const expected = count(expectedText)
  const stale = []
  const missing = []
  for (const [line, times] of actual) {
    const delta = times - (expected.get(line) ?? 0)
    for (let index = 0; index < delta; index += 1) stale.push(line)
  }
  for (const [line, times] of expected) {
    const delta = times - (actual.get(line) ?? 0)
    for (let index = 0; index < delta; index += 1) missing.push(line)
  }
  return { stale, missing }
}

const noticesArg = process.argv.indexOf('--notices')
const checkArg = process.argv.indexOf('--check-notices')
if (noticesArg !== -1 && checkArg !== -1) {
  process.stderr.write('verify-licenses: --notices 与 --check-notices 互斥\n')
  process.exit(1)
}
if (noticesArg !== -1) {
  const target = process.argv[noticesArg + 1]
  if (target === undefined) {
    process.stderr.write('verify-licenses: --notices requires a file path\n')
    process.exit(1)
  }
  writeFileSync(resolveNoticeTarget(target), renderNotices(manifests))
  process.stdout.write(`verify-licenses: 已写入 ${target}\n`)
} else if (checkArg !== -1) {
  const target = process.argv[checkArg + 1]
  if (target === undefined) {
    process.stderr.write('verify-licenses: --check-notices requires a file path\n')
    process.exit(1)
  }
  const path = resolveNoticeTarget(target)
  const expected = renderNotices(manifests)
  let actual
  try {
    actual = readFileSync(path, 'utf8')
  } catch {
    process.stderr.write(
      `verify-licenses: ${target} 不存在 —— 随包第三方通告清单是交付物的一部分,必须入库。`
      + '生成:yarn workspace dsh-plugin-desktop verify:notices:write\n',
    )
    process.exit(1)
  }
  if (actual !== expected) {
    const { stale, missing } = diffSummary(actual, expected)
    const sample = (lines) => lines.slice(0, 5).map(line => `      ${line}`).join('\n')
    process.stderr.write(
      `verify-licenses: ${target} 与当前生产依赖树不一致(--check-notices)\n`
      + `  提交版本 ${actual.split('\n').length - 1} 行 / 重新生成 ${expected.split('\n').length - 1} 行\n`
      + `  已过期(提交里有、依赖树里没有)${stale.length} 行${stale.length > 0 ? `:\n${sample(stale)}` : ''}\n`
      + `  缺失(依赖树里有、提交里没有)${missing.length} 行${missing.length > 0 ? `:\n${sample(missing)}` : ''}\n`
      + '重新生成并提交:yarn workspace dsh-plugin-desktop verify:notices:write'
      + '(旧版本/已删除包会让法务面失真,升级后必须重生成)\n',
    )
    process.exit(1)
  }
  process.stdout.write(`verify-licenses: ${target} 与生产依赖树一致(${expected.split('\n').length - 1} 行)\n`)
}

const total = seen.size - 1
const summary = noticeOnly.length === 0
  ? `verify-licenses: ${total} production packages carry redistribution-safe licenses`
  : `verify-licenses: ${total} production packages checked; ${noticeOnly.length} use notice-required licenses (${[...new Set(noticeOnly.map(entry => entry.license))].join(', ')})`
process.stdout.write(`${summary}\n`)
