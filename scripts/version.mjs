#!/usr/bin/env node
/**
 * 产品版本单一权威源(git tag)的读写与校验脚本。
 *
 * 背景:产品版本号分布在两处——root package.json(产品展示/CI)与
 * packages/host/desktop/package.json(electron-builder 打包名 + 运行时
 * desktopProductVersion() 读取)。发布时漏改任一处,CI release job 会
 * fail-loud;Docker 镜像版本则直接取自 git tag(docker.yml 解析 ref/tag)。
 * 因此 git tag(vX.Y.Z)是唯一真值,package.json 是派生值:
 *
 *   node scripts/version.mjs set 2.3.0     # 同步写两处 package.json
 *   git commit ...; git tag v2.3.0; git push --tags   # 之后 CI 自动做剩余一切
 *
 * 预发布:版本带 prerelease 段(如 2.7.0-beta.1,可任意多次迭代)——CI 将其
 * 发布为 GitHub Pre-release(官方命名,不用 rc 等自定义叫法),正式客户端
 * 更新检查(releases/latest)天然排除,用户不会收到更新;验证通过后再 bump
 * 纯版本(2.7.0)发正式版(Latest)。
 * 详见 docs/decisions/2026-09-05-prerelease-test-channel.md。
 *
 * 子命令:
 *   set <version>  写入两处 package.json(接受 2.3.0 或 v2.3.0;无 v 前缀时打警告 ——
 *                  写进 manifest 的永远是去 v 的形式,但 **git tag 必须带 v**)
 *   check [tag]    校验 tag(或 git describe)与两处 package.json 一致;
 *                  无 tag(PR/日常分支)时校验两处彼此一致。不一致 exit 1。
 *                  **显式 tag 必须以 v 开头**:漏 v 的 tag 不是发布 tag,发布链
 *                  (`scripts/ci-release-policy.sh`)会据此 fail-loud(2026-09-23
 *                  第五轮审计 R5-C-1:漏 v 曾等于"构建照跑、交付为零、CI 全绿")。
 *   manifests      只校验**两处 manifest 彼此相等**(不关心 tag):"发布 PR 已 bump、
 *                  tag 还没打"的状态下它必须绿 ⇒ 这是能进 gate 的那半条判据
 *                  (check 在同样状态下必红,因为它拿 git describe 的最新 tag 当期望值)。
 *   get            打印当前产品版本(优先 git 最近 tag,否则两处 package.json;
 *                  两者不一致时 fail-loud)。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const readJson = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
const writeManifest = (path, value) => {
  const absolute = resolve(root, path)
  // 保持仓库现有排版:2 空格缩进;末尾换行随原文件状态
  // (仓库两个 package.json 均无末尾换行,强制加 \n 会产生无谓 diff 噪音)
  const original = readFileSync(absolute, 'utf8')
  const endsWithNewline = original.endsWith('\n')
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}${endsWithNewline ? '\n' : ''}`)
}
const fail = message => {
  console.error(`version: ${message}`)
  process.exit(1)
}
const run = (command, args, cwd = root) => {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

/** 与 .github/workflows/docker.yml 的 Resolve version 步骤同一套白名单。 */
function validateVersion(value) {
  if (value === '' || /[^0-9A-Za-z.-]/u.test(value) || !/^[0-9]/u.test(value)) return false
  return /^[0-9]+\.[0-9]+(\.[0-9]+)?(-[0-9A-Za-z.-]+)?$/u.test(value)
}

function normalizeVersion(input) {
  const value = input.startsWith('v') ? input.slice(1) : input
  if (!validateVersion(value)) return null
  return value
}

function productManifests() {
  return [
    ['root', 'package.json'],
    ['desktop', 'packages/host/desktop/package.json'],
  ]
}

/** git 最近 tag(去 v 前缀);无 tag 或无法读取时返回 null。 */
function latestTagVersion() {
  const tag = run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'])
  if (tag === '') return null
  return normalizeVersion(tag)
}

function readVersions() {
  const versions = productManifests().map(([owner, path]) => {
    const manifest = readJson(path)
    if (typeof manifest.version !== 'string' || manifest.version === '') {
      fail(`${owner} package.json 缺少字符串 version`)
    }
    return [owner, manifest.version]
  })
  return Object.fromEntries(versions)
}

function checkConsistency(versions, expected) {
  const [rootVersion, desktopVersion] = [versions.root, versions.desktop]
  const problems = []
  if (expected !== null && rootVersion !== expected) problems.push(`root=${rootVersion} (期望 ${expected})`)
  if (expected !== null && desktopVersion !== expected) problems.push(`desktop=${desktopVersion} (期望 ${expected})`)
  if (rootVersion !== desktopVersion) problems.push(`root(${rootVersion}) != desktop(${desktopVersion})`)
  if (problems.length > 0) {
    fail(`版本号不一致: ${problems.join('; ')} — 用 scripts/version.mjs set 同步`)
  }
}

function check() {
  const versions = readVersions()
  // 第一个位置参数:显式 tag(CI 场景,如 v2.3.0);缺省取 git describe
  const explicit = process.argv[3]
  let expected = null
  let sourceNote = ''
  if (explicit !== undefined) {
    // 显式 tag 必须以 v 开头(2026-09-23 第五轮审计 R5-C-1)。理由与 gate 侧的
    // ci-release-policy.sh 同源:本仓的发布 tag 一律 `vX.Y.Z[-预发]`,`git tag` 漏 v
    // 时 `refs/tags/v…` 的判据(release job 的 `if:`)与形态判据都不成立 ⇒
    // 三平台照常构建而交付面为零。这里在**打 tag 之前**就能拦住(先 check 再 tag)。
    if (!explicit.startsWith('v')) {
      fail(
        `显式 tag 必须以 v 开头(收到 ${explicit})—— 本仓发布 tag 一律 vX.Y.Z / vX.Y.Z-<beta|rc|alpha>[.N];` +
        '漏 v 会静默零发布(三平台照常构建,GitHub Release 与更新服务器全为零,CI 仍全绿)。' +
        `若只是想让 manifest 自检,用 node scripts/version.mjs manifests。`,
      )
    }
    expected = normalizeVersion(explicit)
    if (expected === null) fail(`显式 tag 非法: ${explicit}`)
    sourceNote = `显式 tag ${explicit}`
  } else {
    const tag = latestTagVersion()
    if (tag === null) {
      sourceNote = '无 git tag(分支/PR 场景),仅校验两处 package.json 一致'
    } else {
      expected = tag
      sourceNote = `git tag v${tag}`
    }
  }
  checkConsistency(versions, expected)
  process.stdout.write(`version: OK — ${sourceNote}; root=${versions.root} desktop=${versions.desktop}\n`)
}

/**
 * 只校验两处 manifest 彼此相等 —— 不看任何 tag。
 *
 * 为什么需要它:发布 PR 里两处 package.json 都 bump 到新版本、而 tag 还没打,
 * 此时 `check`(期望值取 git describe 的最新 tag)必红,不能进 gate;而"只改了一处"
 * 又必须在 gate 里 1 分钟内红(否则要等 release job 第 4 步,四平台构建 40 分钟之后)。
 * 判据边界:相等 ⇒ 绿;不等 ⇒ exit 1 并点名两处取值。
 */
function manifestsOnly() {
  const versions = readVersions()
  checkConsistency(versions, null)
  process.stdout.write(
    `version: OK — 两处 manifest 一致(未校验 tag); root=${versions.root} desktop=${versions.desktop}\n`,
  )
}

function setVersion() {
  const input = process.argv[3]
  if (input === undefined) fail('用法: node scripts/version.mjs set <version> (如 v2.3.0)')
  const version = normalizeVersion(input)
  if (version === null) fail(`版本号非法: ${input}(期望 semver 如 2.3.0 或 2.3.0-rc.1)`)
  // 无 v 前缀时**出声**:写进 manifest 的总是去 v 的形式,真正的坑在下一步的 git tag
  // (2026-09-23 第五轮审计 R5-C-1:漏 v 的 tag = 构建照跑、交付为零、CI 全绿)。
  // 不直接拒绝是为了不打断既有用法(文档/脚本里两种写法都在用),但不再静默。
  if (!input.startsWith('v')) {
    process.stderr.write(
      `::warning::version.mjs set 收到没有 v 前缀的输入 ${input} —— 已按 ${version} 写入 manifest。\n` +
      `::warning::git tag 必须带 v:git tag -a v${version} -m "v${version}";` +
      `漏 v 的 tag 会被发布判据拒绝(否则会静默零发布:构建照跑,Release 与更新服务器全为零)。\n`,
    )
  }
  for (const [, path] of productManifests()) {
    const absolute = resolve(root, path)
    const manifest = JSON.parse(readFileSync(absolute, 'utf8'))
    manifest.version = version
    writeManifest(path, manifest)
  }
  process.stdout.write(
    `version: ${version} 已写入 root package.json 与 packages/host/desktop/package.json\n` +
    `后续: 版本改动走 PR 合并到 master 后,在**合并提交**上 git tag -a v${version} -m "v${version}" && ` +
    `git push origin v${version}\n` +
    `(tag 必须带 v;push 后 CI 自动构建桌面三平台、服务端镜像与更新服务器发布面)\n`,
  )
}

function get() {
  const versions = readVersions()
  checkConsistency(versions, null)
  const tag = latestTagVersion()
  if (tag !== null && tag !== versions.root) {
    // 仅提示:开发分支上 tag 落后于 package.json 是常态(版本先改后打 tag)
    console.warn(`version: 注意 git 最近 tag v${tag} 与 package.json ${versions.root} 不同`)
    return versions.root
  }
  return versions.root
}

const [command] = process.argv.slice(2)
switch (command) {
  case 'set':
    setVersion()
    break
  case 'check':
    check()
    break
  case 'manifests':
    manifestsOnly()
    break
  case 'get':
    process.stdout.write(`${get()}\n`)
    break
  default:
    fail('用法: node scripts/version.mjs <set <version>|check [tag]|manifests|get>')
}
