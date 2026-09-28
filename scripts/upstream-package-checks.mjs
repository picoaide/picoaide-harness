#!/usr/bin/env node
/**
 * 升级前的两条 fail-loud 判据（`scripts/upgrade-upstream.mjs` 的第 3b 步调用）。
 *
 * 为什么必须存在（2026-09-28 事故的**直接根因**）：
 *   `bumpManifest()` / `migratePatchFiles()` 是**纯机械版本号替换** —— 它们既没有
 *   改名映射表、也不查 registry。于是 `dsh-v0.1.6-alpha.2 → dsh-v0.1.7-rc.2` 的两次
 *   上游改名**静默通过**，直到 `yarn install` 卡在 resolution 步才以
 *   `YN0082: @deepseek-ai/dsh-agent-presets@npm:0.1.7-rc.2: No candidates found` 的形式
 *   暴露（该包在新版被拆成 agent-preset / agent-preset-registry 两个包）。
 *
 * 本模块补上机械替换看不见的三件事：
 *   ① **改名映射表** —— 旧名 → 新名（或"已删除/能力并入"），命中我们声明过的包就中止；
 *   ② **上游包清单 diff** —— `0.1.6-alpha.2` vs 新版逐个 `package.json` 的 `name` 集合
 *      （抓"新旧名字都在、但语义搬走了"这一类，registry 判据抓不到）；
 *   ③ **registry 存在性检查** —— 对我们声明的每个 `@deepseek-ai/*` 名字查 registry，
 *      404 即中止并点名（不联网/查询失败同样中止：验证不了就不许 bump）。
 *
 * 自检：`node scripts/upstream-package-checks.mjs --self-test`（不需要网络）。
 *
 * 退出码：0 通过；1 有中止项或自检失败。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 默认 registry；`--registry` 或 `NPM_REGISTRY` 可覆盖（自检与离线镜像用）。 */
export const DEFAULT_REGISTRY = process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org'

/**
 * 上游改名/合并映射表：**旧名 → 去处**。
 *
 * `replacement` 是新名（字符串）或 `null`（包被删除、能力并入别处，用 `note` 说明）。
 * 判据是"我们是否还声明着这个旧名"——只要还声明就中止，因为新版 registry 上没有它。
 *
 * 每条都要有**上游证据**（submodule 里的路径或 commit），否则这张表会变成传言。
 */
export const RENAMED_UPSTREAM_PACKAGES = {
  '@deepseek-ai/dsh-agent-presets': {
    replacement: '@deepseek-ai/dsh-agent-preset + @deepseek-ai/dsh-agent-preset-registry',
    note: '0.1.7 拆分：agent-preset（插件，每个 preset 一行）+ agent-preset-registry（提供 '
      + '`agentPresets` 服务）。内置 preset 不再是 `presets/<id>/agent.cordis.yml` 目录式 roster，'
      + '而是 `@deepseek-ai/dsh-web-app` 的 `presets/<id>.patch.yml`（列在该 bundle 自己的 '
      + '`dsh.bundle.patch` 里）。',
    evidence: 'upstream packages/preset/{agent-preset,agent-preset-registry}, packages/bundle/web-app/presets/',
  },
  '@deepseek-ai/dsh-settings-file': {
    replacement: '@deepseek-ai/dsh-settings',
    note: '0.1.7 删除整包（`FileSettingsProvider`/`resolveSpec`/`Config` 在新版**不存在**）：'
      + 'settings 改为 profile patch 支撑的表单模型——命名空间 = profile 条目 id，'
      + '`SettingsForms.describe()/update()` 读写真源，`settings.yaml` 只被一次性导入后改名。',
    evidence: 'upstream commit 601d6761e4 (feat(settings): project volatile Config through profile-backed forms)',
  },
  '@deepseek-ai/dsh-client-ui-settings-unarchive-sessions': {
    replacement: null,
    note: '0.1.7 起该行/包在上游全仓零引用（能力并入 `ui-settings`）；它是**传递依赖**，'
      + '我们没直接声明，diff 判据会把它列出来供人工确认。',
    evidence: 'upstream grep: 0 hits at dsh-v0.1.7-rc.2',
  },
  '@deepseek-ai/dsh-experimental-agent-team-web-profile': {
    replacement: '@deepseek-ai/dsh-experimental-agent-team-profile',
    note: '0.1.7 起该包与 profile 行被删除（README 要求把 bundles 里的 web-profile 条目删掉）。',
    evidence: 'upstream packages/experimental/agent-team-profile/README.md',
  },
}

/** 收集一个包在 workspace 里被声明的全部位置。 */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

/**
 * 列出 workspace 声明的 `@deepseek-ai/*` 依赖与 resolutions 键。
 * @param root - 仓库根。
 * @param workspace - 根 `package.json`（含 `workspaces`）。
 * @returns `Map<包名, Array<{path, range, field}>>`。
 */
export function declaredUpstreamPackages(root, workspace) {
  const paths = ['package.json', ...expandWorkspacePattern(root, workspace)]
  const declared = new Map()
  for (const path of paths) {
    const absolute = resolve(root, path)
    if (!existsSync(absolute)) continue
    let json
    try {
      json = JSON.parse(readFileSync(absolute, 'utf8'))
    } catch {
      continue
    }
    const record = (name, range, field) => {
      if (typeof name !== 'string' || !name.startsWith('@deepseek-ai/')) return
      const list = declared.get(name) ?? []
      list.push({ path, range, field })
      declared.set(name, list)
    }
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, range] of Object.entries(json[field] ?? {})) record(name, range, field)
    }
    // resolution 键把版本写在键里（`@pkg@npm:^V`），取 `@npm:` 之前的部分当包名。
    for (const [key, value] of Object.entries(json.resolutions ?? {})) {
      record(key.split('@npm:')[0], value, 'resolutions')
    }
  }
  return declared
}

/** 把 `workspaces` glob 展开成 `<dir>/package.json` 相对路径。 */
export function expandWorkspacePattern(root, workspace) {
  const out = []
  for (const pattern of workspace.workspaces ?? []) {
    const segments = String(pattern).split('/')
    let seeds = ['']
    for (const segment of segments) {
      const next = []
      for (const seed of seeds) {
        if (segment === '*') {
          const base = resolve(root, seed || '.')
          if (!existsSync(base)) continue
          for (const entry of readdirSync(base, { withFileTypes: true })) {
            if (entry.isDirectory()) next.push(seed ? `${seed}/${entry.name}` : entry.name)
          }
        } else {
          next.push(seed ? `${seed}/${segment}` : segment)
        }
      }
      seeds = next
    }
    for (const seed of seeds) if (seed) out.push(join(seed, 'package.json'))
  }
  return out
}

/**
 * 对声明的包名跑改名映射表。
 * @param declared - {@link declaredUpstreamPackages} 的结果。
 * @param map - 改名映射表（默认 {@link RENAMED_UPSTREAM_PACKAGES}）。
 * @returns 中止项文案数组（空数组 = 通过）。
 */
export function renameMapFailures(declared, map = RENAMED_UPSTREAM_PACKAGES) {
  const failures = []
  for (const [name, entry] of Object.entries(map)) {
    const sites = declared.get(name)
    if (sites === undefined || sites.length === 0) continue
    const where = sites.map(site => `${site.path} (${site.field}: ${site.range})`).join(', ')
    failures.push(
      `${name} 在上游新版已${entry.replacement === null ? '删除' : `改名/拆分`}`
      + `${entry.replacement === null ? '' : ` → ${entry.replacement}`}，但仍被声明：${where}\n`
      + `    依据：${entry.evidence}\n    说明：${entry.note}`,
    )
  }
  return failures
}

/**
 * 逐个 `package.json` 的上游包名集合 diff（抓"新旧名都在、语义搬走"这一类）。
 * @param git - 在 submodule 里跑 git 的函数 `(args) => string`。
 * @param fromRev - 旧 revision（tag 或 commit）。
 * @param toRev - 新 revision。
 * @returns `{removed, added, pathMoved}`（均为排序后的数组）。
 */
export function diffUpstreamPackageSet(git, fromRev, toRev) {
  const namesOf = (rev) => {
    const files = git(['ls-tree', '-r', '--name-only', rev])
      .split('\n').filter(path => /(^|\/)package\.json$/u.test(path))
    const byName = new Map()
    for (const file of files) {
      let json
      try {
        json = JSON.parse(git(['show', `${rev}:${file}`]))
      } catch {
        continue
      }
      if (typeof json.name === 'string') byName.set(json.name, file)
    }
    return byName
  }
  const before = namesOf(fromRev)
  const after = namesOf(toRev)
  const removed = [...before.keys()].filter(name => !after.has(name)).sort()
  const added = [...after.keys()].filter(name => !before.has(name)).sort()
  const pathMoved = [...before.keys()]
    .filter(name => after.has(name) && before.get(name) !== after.get(name))
    .sort()
    .map(name => ({ name, from: before.get(name), to: after.get(name) }))
  return { removed, added, pathMoved }
}

/**
 * registry 存在性检查：声明的每个名字都要查得到，且要 bump 到的版本存在。
 * @param declared - {@link declaredUpstreamPackages} 的结果。
 * @param options - `{to, registry, fetchImpl, timeoutMs}`。
 * @returns `Promise<string[]>`（中止项文案；空数组 = 通过）。
 */
export async function registryFailures(declared, options) {
  const registry = options.registry ?? DEFAULT_REGISTRY
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 15_000
  const failures = []
  const names = [...declared.keys()].sort()
  const results = await Promise.all(names.map(async (name) => {
    const spec = `${registry}/${name.replaceAll('/', '%2F')}`
    try {
      const response = await fetchImpl(spec, { signal: AbortSignal.timeout(timeoutMs) })
      return { name, status: response.status }
    } catch (error) {
      return { name, status: 0, error: error instanceof Error ? error.message : String(error) }
    }
  }))
  for (const { name, status, error } of results) {
    if (status === 404) {
      const sites = declared.get(name).map(site => site.path).join(', ')
      failures.push(`${name} 在 registry 上不存在（HTTP 404）——声明位置：${sites}`)
    } else if (status === 0) {
      failures.push(`${name} 的 registry 查询失败（${error}）——无法验证存在性，按中止处理`)
    } else if (status >= 400) {
      failures.push(`${name} 的 registry 查询返回 HTTP ${status}`)
    }
  }
  // 版本面：凡是声明范围里写着 from 的（= 会被机械替换成 to），必须存在 to。
  if (typeof options.to === 'string' && options.to !== '') {
    const versioned = await Promise.all(names
      .filter(name => (declared.get(name) ?? []).some(site => String(site.range).includes(options.from ?? options.to)))
      .map(async (name) => {
        const spec = `${registry}/${name.replaceAll('/', '%2F')}/${options.to}`
        try {
          const response = await fetchImpl(spec, { signal: AbortSignal.timeout(timeoutMs) })
          return { name, status: response.status }
        } catch (error) {
          return { name, status: 0, error: error instanceof Error ? error.message : String(error) }
        }
      }))
    for (const { name, status, error } of versioned) {
      if (status === 404) failures.push(`${name}@${options.to} 在 registry 上不存在（HTTP 404）`)
      else if (status === 0) failures.push(`${name}@${options.to} 的 registry 查询失败（${error}）`)
      else if (status >= 400) failures.push(`${name}@${options.to} 的 registry 查询返回 HTTP ${status}`)
    }
  }
  return failures
}

/** 在 submodule 里跑 git 并返回 stdout 的便捷包装。 */
export function gitReader(dir) {
  return (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 })
}

/**
 * 自检：不需要网络，用桩 fetch 与内存 fixture 把两条判据都驱动一遍。
 * @returns 失败项数组（空数组 = 通过）。
 */
export async function selfTest() {
  const failures = []
  const expect = (condition, label) => { if (!condition) failures.push(label) }

  // ① 改名映射表：声明着旧名 ⇒ 必须中止并点名去处。
  const renamed = new Map([['@deepseek-ai/dsh-agent-presets', [{ path: 'packages/host/desktop/package.json', range: '0.1.7-rc.2', field: 'dependencies' }]]])
  const renameHits = renameMapFailures(renamed)
  expect(renameHits.length === 1, '改名映射表未对仍声明的旧名报警')
  expect(renameHits[0].includes('@deepseek-ai/dsh-agent-preset'), '改名映射表的告警没写出新名')
  expect(renameMapFailures(new Map([['@deepseek-ai/dsh-settings', [{ path: 'x', range: '1', field: 'dependencies' }]]])).length === 0,
    '改名映射表对无关包误报')

  // ② registry：404 ⇒ 中止；网络失败 ⇒ 中止；全 200 ⇒ 通过。
  const declared = new Map([
    ['@deepseek-ai/dsh-agent', [{ path: 'a/package.json', range: '0.1.7-rc.2', field: 'dependencies' }]],
    ['@deepseek-ai/dsh-does-not-exist', [{ path: 'b/package.json', range: '0.1.7-rc.2', field: 'dependencies' }]],
  ])
  const stub = (missing) => async (url) => ({ status: String(url).includes(missing) ? 404 : 200 })
  const missingFailures = await registryFailures(declared, {
    to: '0.1.7-rc.2', from: '0.1.6-alpha.2', fetchImpl: stub('dsh-does-not-exist'),
  })
  expect(missingFailures.length >= 1, 'registry 判据对 404 没有中止')
  expect(missingFailures.some(line => line.includes('dsh-does-not-exist')), 'registry 判据没点名 404 的包')
  const cleanFailures = await registryFailures(declared, {
    to: '0.1.7-rc.2', from: '0.1.6-alpha.2', fetchImpl: async () => ({ status: 200 }),
  })
  expect(cleanFailures.length === 0, `registry 判据对全 200 误报：${cleanFailures.join('; ')}`)
  const offlineFailures = await registryFailures(declared, {
    to: '0.1.7-rc.2', from: '0.1.6-alpha.2',
    fetchImpl: async () => { throw new Error('ENOTFOUND') },
  })
  expect(offlineFailures.length === declared.size, 'registry 判据在查询失败时没有按中止处理')

  // ③ 上游清单 diff：旧版有、新版没有的包必须出现在 removed 里。
  const fakeGit = (args) => {
    if (args[0] === 'ls-tree') {
      // gitReader 的调用形态是 `['ls-tree','-r','--name-only', rev]`：rev 在 args[3]。
      return args[3] === 'old'
        ? 'packages/a/package.json\npackages/gone/package.json\n'
        : 'packages/a/package.json\npackages/added/package.json\n'
    }
    // 每个路径一个独立包名（真实清单里 name 是唯一的，夹具也必须唯一，
    // 否则按 name 建索引会把两份合成一份）。
    const path = String(args[1]).split(':')[1]
    return JSON.stringify({ name: `@deepseek-ai/dsh-${path.split('/')[1]}` })
  }
  const diff = diffUpstreamPackageSet(fakeGit, 'old', 'new')
  expect(diff.removed.length === 1 && diff.added.length === 1, `上游清单 diff 形状不对：${JSON.stringify(diff)}`)
  expect(diff.removed[0] === '@deepseek-ai/dsh-gone', `removed 认错了包：${diff.removed.join(',')}`)
  expect(diff.added[0] === '@deepseek-ai/dsh-added', `added 认错了包：${diff.added.join(',')}`)
  return failures
}

async function main() {
  if (!process.argv.includes('--self-test')) {
    process.stderr.write('用法：node scripts/upstream-package-checks.mjs --self-test\n')
    process.exit(2)
  }
  const failures = await selfTest()
  if (failures.length > 0) {
    process.stderr.write(`upstream-package-checks 自检失败：\n  - ${failures.join('\n  - ')}\n`)
    process.exit(1)
  }
  process.stdout.write('upstream-package-checks 自检通过\n')
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`upstream-package-checks: ${error.message}\n`)
    process.exit(1)
  })
}
