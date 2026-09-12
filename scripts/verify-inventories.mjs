#!/usr/bin/env node
/**
 * 清单漂移门禁:把"手工同步的多份清单"变成互为对拍的红灯。
 *
 * 2026-09-12 二次审查 P2-9 的原话是"6 处手工同步清单无对拍门禁";其中最贵的两条
 * 在这里自动化(离线可跑、失败可操作):
 *
 *   1. `scripts/platform-modules.mjs` ↔ submodule
 *      `deepseek-harness/packages/client/web/src/platform.ts`
 *      漂移的后果是客户端 bundle 的 external 表与 shell 冻结模块表不一致 —— 运行时
 *      才炸,且只在特定插件被加载时炸。submodule 未 init 时**跳过并提示**(不静默通过)。
 *
 *   2. `.github/workflows/ci.yml` 的 `workspace-build` 归档清单 ↔
 *      `packages/host/desktop/scripts/prebuild-workspace-deps.ts` 的包表 ↔
 *      `scripts/check-workspaces.mjs` 的包表 ↔ 磁盘上的 workspace 包
 *      漂移的后果:新增/删除包后 CI 归档少带(三个平台 job 拿到旧产物)或多带
 *      (tar 直接报错),而 PR 上"gate 绿、打包炸"或"打包绿、运行期少 lib"。
 *
 * 其余清单(`mac-runtime.ts` 的 MACOS_*_NATIVE_ENTRIES、`verify-packaged-runtime.ts`
 * 的必需条目、`THIRD_PARTY_NOTICES.md`)需要逐条人眼核对语义,无法低成本自动化 ——
 * 由 `scripts/upgrade-upstream.mjs` 在每次升级时打印显式 TODO 提醒。
 *
 * 用法:node scripts/verify-inventories.mjs
 * 退出码:0 全部通过(或 submodule 未 init 而跳过);1 有漂移。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

const root = resolve(import.meta.dirname, '..')
const failures = []
const notices = []

const fail = message => failures.push(message)
const notice = message => notices.push(message)

/** 读取并解析一个 JSON 文件。 */
function readJson(relative) {
  return JSON.parse(readFileSync(join(root, relative), 'utf8'))
}

/** 抽出源码里 `NAME = [ ... ]` 数组体中的字符串字面量(单引号)。 */
function stringArrayFrom(source, name) {
  const match = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'u').exec(source)
  if (match === null) return undefined
  return [...match[1].matchAll(/'([^']*)'/gu)].map(entry => entry[1])
}

// ---- 1. platform-modules.mjs ↔ submodule platform.ts ----
{
  const localPath = 'scripts/platform-modules.mjs'
  const upstreamPath = 'deepseek-harness/packages/client/web/src/platform.ts'
  const local = readFileSync(join(root, localPath), 'utf8')
  if (!existsSync(join(root, upstreamPath))) {
    notice(
      `platform-modules 漂移未检查:${upstreamPath} 不存在(submodule 未 init)。`
      + '先 `git submodule update --init --recursive` 再跑本门禁',
    )
  } else {
    const upstream = readFileSync(join(root, upstreamPath), 'utf8')
    for (const name of ['PLATFORM_MODULES', 'PRELOADED_CLIENT_EXTERNALS']) {
      const localValues = stringArrayFrom(local, name)
      const upstreamValues = stringArrayFrom(upstream, name)
      if (localValues === undefined || upstreamValues === undefined) {
        fail(`${localPath}: 无法解析 ${name}(扫描器可能已失效,请同步扩展 verify-inventories.mjs)`)
        continue
      }
      if (JSON.stringify(localValues) !== JSON.stringify(upstreamValues)) {
        const missing = upstreamValues.filter(value => !localValues.includes(value))
        const extra = localValues.filter(value => !upstreamValues.includes(value))
        fail(
          `${localPath} 的 ${name} 与 ${upstreamPath} 漂移`
          + `${missing.length > 0 ? `;缺少 ${missing.join(', ')}` : ''}`
          + `${extra.length > 0 ? `;多出 ${extra.join(', ')}` : ''}`
          + '(跑 `node scripts/upgrade-upstream.mjs` 会从新 pin 重抽这张表)',
        )
      }
    }
  }
}

// ---- 2. workspace 包(磁盘真源) ----
/** workspace 目录 → { name, dir, build }。 */
const workspacePackages = new Map()

/**
 * 展开根 `workspaces` 里的 glob(只含单层星号段,与仓库用法一致)。
 * @param pattern - 形如 `packages/<star>/<star>` 或 `community/<star>`。
 * @returns 目录相对路径列表(存在 package.json 的目录由调用方过滤)。
 */
function expandWorkspacePattern(pattern) {
  let dirs = ['']
  for (const segment of pattern.split('/')) {
    const next = []
    for (const base of dirs) {
      if (segment !== '*') {
        next.push(base === '' ? segment : `${base}/${segment}`)
        continue
      }
      const baseDir = join(root, base === '' ? '.' : base)
      if (!existsSync(baseDir)) continue
      for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
        if (entry.isDirectory()) next.push(base === '' ? entry.name : `${base}/${entry.name}`)
      }
    }
    dirs = next
  }
  return dirs
}

{
  const workspace = readJson('package.json')
  for (const pattern of workspace.workspaces ?? []) {
    for (const dir of expandWorkspacePattern(pattern)) {
      const manifestPath = join(root, dir, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      workspacePackages.set(dir, {
        dir,
        name: manifest.name,
        build: typeof manifest.scripts?.build === 'string',
      })
    }
  }
  if (workspacePackages.size === 0) {
    fail('没有从根 package.json 的 workspaces 里解析出任何包 —— 扫描器已失效')
  }
}

/**
 * 有 build 脚本但**刻意**不参与 prebuild / CI 归档的包。
 * 每一条都必须写明理由;新增包若既没进 prebuild 也没写进这里,门禁会红。
 */
const PREBUILD_EXEMPTIONS = new Map([
  [
    'packages/vendor/memory-evolve',
    'lib/ 入库(版本库跟踪),构建依赖 ~/.dsh/source 的 esbuild,不走标准 prebuild —— 见 prebuild-workspace-deps.ts 末尾注释',
  ],
])

/** 不在 `check-workspaces.mjs` check 链里的包(与那份脚本的注释同源)。 */
const CHECK_CHAIN_EXEMPTIONS = new Map([
  ['packages/vendor/memory-evolve', '有 test 脚本但不在原 yarn check 链里,保持原样(测试缺口另行报告)'],
])

// ---- 3. scripts/check-workspaces.mjs 的包表 ----
const checkChainDirs = []
{
  const source = readFileSync(join(root, 'scripts/check-workspaces.mjs'), 'utf8')
  const entries = [...source.matchAll(/\{\s*name:\s*'([^']+)',\s*dir:\s*'([^']+)'/gu)]
    .map(match => ({ name: match[1], dir: match[2] }))
  if (entries.length === 0) {
    fail('scripts/check-workspaces.mjs: 没有解析出 PACKAGES 包表 —— 扫描器可能已失效')
  }
  for (const entry of entries) {
    const onDisk = workspacePackages.get(entry.dir)
    checkChainDirs.push(entry.dir)
    if (onDisk === undefined) {
      fail(`scripts/check-workspaces.mjs: 包表里的 ${entry.dir} 不是 workspace 包(包已删除或路径写错)`)
      continue
    }
    if (onDisk.name !== entry.name) {
      fail(`scripts/check-workspaces.mjs: ${entry.dir} 的包名写的是 ${entry.name},实际是 ${onDisk.name}`)
    }
  }
  for (const dir of workspacePackages.keys()) {
    if (checkChainDirs.includes(dir)) continue
    if (CHECK_CHAIN_EXEMPTIONS.has(dir)) continue
    fail(
      `workspace 包 ${dir} 不在 scripts/check-workspaces.mjs 的 PACKAGES 里,也没有豁免理由 —— `
      + '新包不进 check 链 = 它的 build/typecheck/test 永远不会在 CI 跑',
    )
  }
}

// ---- 4. prebuild-workspace-deps.ts 的包表 ----
const prebuildDirs = []
{
  const source = readFileSync(join(root, 'packages/host/desktop/scripts/prebuild-workspace-deps.ts'), 'utf8')
  const body = /const WORKSPACE_PACKAGES[^=]*=\s*\[([\s\S]*?)\n\]/u.exec(source)
  if (body === null) {
    fail('packages/host/desktop/scripts/prebuild-workspace-deps.ts: 没有解析出 WORKSPACE_PACKAGES —— 扫描器可能已失效')
  } else {
    for (const match of body[1].matchAll(/dir:\s*'([^']+)'/gu)) prebuildDirs.push(match[1])
    if (prebuildDirs.length === 0) {
      fail('packages/host/desktop/scripts/prebuild-workspace-deps.ts: WORKSPACE_PACKAGES 为空')
    }
  }
  for (const dir of prebuildDirs) {
    const onDisk = workspacePackages.get(dir)
    if (onDisk === undefined) {
      fail(`prebuild-workspace-deps.ts: ${dir} 不是 workspace 包(包已删除或路径写错)`)
      continue
    }
    if (!onDisk.build) {
      fail(`prebuild-workspace-deps.ts: ${dir} 没有 build 脚本,却在 prebuild 列表里`)
    }
  }
}

// ---- 5. 有 build 脚本的包必须进 prebuild(或写明豁免) ----
for (const [dir, pkg] of workspacePackages) {
  if (!pkg.build) continue
  if (prebuildDirs.includes(dir)) continue
  if (PREBUILD_EXEMPTIONS.has(dir)) continue
  fail(
    `workspace 包 ${dir}(${pkg.name}) 有 build 脚本,却既不在 prebuild-workspace-deps.ts 的包表里,`
    + '也没有豁免理由 —— 打包/冒烟会拿到缺失或过期的 lib/',
  )
}

// ---- 6. ci.yml 的 workspace-build 归档清单 ----
const archiveEntries = new Set()
{
  const workflowPath = '.github/workflows/ci.yml'
  const document = parseYaml(readFileSync(join(root, workflowPath), 'utf8'))
  const runs = []
  for (const job of Object.values(document?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (typeof step?.run === 'string' && step.run.includes('workspace-build.tgz')) runs.push(step.run)
    }
  }
  const tarRuns = runs.filter(run => /tar\s+-czf\s+workspace-build\.tgz/u.test(run))
  if (tarRuns.length !== 1) {
    fail(`${workflowPath}: 期望恰好 1 个 \`tar -czf workspace-build.tgz\` 步骤,实际 ${tarRuns.length} 个(扫描器可能已失效)`)
  }
  for (const run of tarRuns) {
    // 续行折叠成一行后再取 tar 的参数。
    const flattened = run.replace(/\\\r?\n\s*/gu, ' ')
    const tokens = flattened.split(/\s+/u).filter(Boolean)
    const index = tokens.findIndex(token => token === 'workspace-build.tgz')
    for (const token of tokens.slice(index + 1)) {
      if (token.includes('/')) archiveEntries.add(token)
    }
  }
  if (archiveEntries.size === 0 && tarRuns.length > 0) {
    fail(`${workflowPath}: workspace-build 归档清单解析为空 —— 扫描器可能已失效`)
  }

  // 归档清单必须与 prebuild 包表一一对应(desktop 另带 build/)。
  const expected = new Set(prebuildDirs.map(dir => `${dir}/lib`))
  expected.add('packages/host/desktop/build')
  for (const entry of expected) {
    if (!archiveEntries.has(entry)) {
      fail(
        `${workflowPath}: workspace-build 归档清单缺少 ${entry} —— CI 的三个平台 job 靠这份归档恢复产物,`
        + '漏带 = 它们拿旧包/缺 lib 打包(本地 prebuild 却一切正常)',
      )
    }
  }
  for (const entry of archiveEntries) {
    if (expected.has(entry)) continue
    const packageDir = entry.replace(/\/(?:lib|build)$/u, '')
    if (!workspacePackages.has(packageDir)) {
      fail(`${workflowPath}: workspace-build 归档清单里的 ${entry} 指向不存在的包(${packageDir})—— 包已删除或路径写错`)
    } else {
      fail(
        `${workflowPath}: workspace-build 归档清单里的 ${entry} 不在 prebuild 包表的产物里 —— `
        + '要么把它加进 prebuild-workspace-deps.ts,要么从归档清单删掉',
      )
    }
  }

  // 三个平台 job 解压后的 `[ -d <path> ]` 断言必须都是归档里真有的路径。
  for (const run of runs) {
    for (const match of run.matchAll(/\[\s*-d\s+([^\s\]]+)\s*\]/gu)) {
      const path = match[1]
      if (!path.startsWith('packages/') && !path.startsWith('community/')) continue
      if (!archiveEntries.has(path)) {
        fail(
          `${workflowPath}: 解压后的守卫断言 \`[ -d ${path} ]\` 指向归档清单里没有的路径 —— `
          + '门禁保证的东西根本不在 workspace-build 里',
        )
      }
    }
  }
}

// ---- 输出 ----
for (const message of notices) process.stderr.write(`verify-inventories: 提示: ${message}\n`)

if (failures.length > 0) {
  process.stderr.write(`\nverify-inventories: ${failures.length} 项断言失败\n`)
  for (const message of failures) process.stderr.write(`- ${message}\n`)
  process.exit(1)
}

process.stdout.write(
  'verify-inventories: OK — platform-modules 与 submodule 一致;'
  + `CI workspace-build 归档 ${archiveEntries.size} 条路径 ↔ prebuild 包表 ${prebuildDirs.length} 个包 ↔ `
  + `check 链 ${checkChainDirs.length} 个包 ↔ 磁盘 ${workspacePackages.size} 个 workspace 包互相对拍\n`,
)
