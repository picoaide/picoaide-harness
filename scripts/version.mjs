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
 * 测试版:版本带 prerelease 段(如 2.7.0-rc.1,可任意多次迭代)——CI 将其
 * 发布为 GitHub Pre-release,正式客户端更新检查(releases/latest)天然
 * 排除,用户不会收到更新;验证通过后再 bump 纯版本(2.7.0)发正式版。
 * 详见 docs/decisions/2026-09-05-prerelease-test-channel.md。
 *
 * 子命令:
 *   set <version>  写入两处 package.json(接受 2.3.0 或 v2.3.0),输出待办指引
 *   check [tag]    校验 tag(或 git describe)与两处 package.json 一致;
 *                  无 tag(PR/日常分支)时校验两处彼此一致。不一致 exit 1。
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

function setVersion() {
  const input = process.argv[3]
  if (input === undefined) fail('用法: node scripts/version.mjs set <version> (如 2.3.0)')
  const version = normalizeVersion(input)
  if (version === null) fail(`版本号非法: ${input}(期望 semver 如 2.3.0 或 2.3.0-rc.1)`)
  for (const [, path] of productManifests()) {
    const absolute = resolve(root, path)
    const manifest = JSON.parse(readFileSync(absolute, 'utf8'))
    manifest.version = version
    writeManifest(path, manifest)
  }
  process.stdout.write(
    `version: ${version} 已写入 root package.json 与 packages/host/desktop/package.json\n` +
    `后续: git commit -m "chore: bump version to v${version}" && ` +
    `git tag v${version} && git push --tags\n` +
    `(push 后 CI 自动构建桌面三平台与 Docker 镜像 v${version}/latest)\n`,
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
  case 'get':
    process.stdout.write(`${get()}\n`)
    break
  default:
    fail('用法: node scripts/version.mjs <set <version>|check [tag]|get>')
}
