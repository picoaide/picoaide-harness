import { createRequire } from 'node:module'

const FIRST_PARTY_PREFIX = '@deepseek-ai/'

/**
 * 一方 peer 的"未挂载豁免"：该 peer 之所以没在部署根声明，是因为**唯一**够到它的组合行
 * 被我们显式关掉了（`packages/host/desktop/cordis.patch.yml` 的 `disabled: true`）。
 *
 * 为什么需要这个机制（2026-09-28，DSH 0.1.7 收尾）：closure 判据走的是**包图**
 * （`dependencies` → `peerDependencies`），而"这个包会不会被 import"由**组合**决定。
 * 0.1.7 新增的两行 `deepseek-account` / `account-controller` 就是这种形态：包
 * `@deepseek-ai/dsh-deepseek-account` 只被 peer 声明、**上游永不安装**，两行一旦启用就是
 * `failed to import`（所以 UPG-2 在桌面组合里关掉了它们）—— 此时在部署根声明这个 peer
 * 等于为了消红装一个永不加载的包，而**不声明**才是与"行被禁用"一致的事实。
 *
 * 但豁免必须是**可被打破的判据**，不是白名单：每条豁免都点名"是哪些行够到它"，调用方
 * （`verify-runtime-closure.mjs`）必须到 `cordis.patch.yml` 里核对那些行**真的**
 * `disabled: true` —— 有人重新启用行时，豁免立刻失效并报错（而不是安静地放行）。
 * 交叉核对见 {@link peerExemptionViolations}。
 */
export const UNMOUNTED_PEER_EXEMPTIONS = Object.freeze([
  {
    peer: '@deepseek-ai/dsh-deepseek-account',
    rows: ['deepseek-account', 'account-controller'],
    reason:
      '0.1.7 新增的两行（deepseek-account / account-controller）在桌面组合里被显式禁用：'
      + '它们 peer 依赖 @deepseek-ai/dsh-deepseek-account，而该包上游只有 peer 声明、'
      + '永不随包安装 ⇒ 行启用即 failed to import。包不在部署根声明是"行没挂载"的如实反映。',
  },
])

/**
 * 核对每条豁免点名的行**真的**在组合里被禁用。
 *
 * @param exemptions - {@link UNMOUNTED_PEER_EXEMPTIONS} 形状的豁免表。
 * @param disabledRowIds - `cordis.patch.yml` 里 `disabled: true` 的行 id 集合。
 * @returns 每条失效豁免的说明（空数组 = 全部成立）。
 */
export function peerExemptionViolations(exemptions, disabledRowIds) {
  const disabled = disabledRowIds instanceof Set ? disabledRowIds : new Set(disabledRowIds)
  const violations = []
  for (const exemption of exemptions) {
    const mounted = exemption.rows.filter(row => !disabled.has(row))
    if (mounted.length === 0) continue
    violations.push(
      `${exemption.peer}: 豁免点名的行 ${mounted.join(', ')} 已不再 disabled ⇒ `
      + '要么把该 peer 声明到部署根，要么重新禁用这些行（豁免不能陈旧）',
    )
  }
  return violations
}

/**
 * Verify that a published profile root directly supplies every required
 * first-party peer reached through its production dependency graph.
 * @param {object} manifest - deploy-root package manifest.
 * @param {(name: string, parentManifestPath: string) => Promise<{ manifest: object, path: string }>} loadPackage - package manifest loader.
 * @param {string} rootManifestPath - absolute deploy-root manifest path.
 * @param {{ exemptPeers?: ReadonlySet<string> }} [options] - peers that stay undeclared
 *   because their only composition rows are disabled; the caller is responsible for
 *   cross-checking the rows (`peerExemptionViolations`). Counted in `exempted`.
 * @returns {Promise<{ failures: string[], packageCount: number, exempted: string[] }>}
 */
export async function verifyRuntimeClosure(manifest, loadPackage, rootManifestPath, options = {}) {
  const direct = manifest.dependencies ?? {}
  const rootName = manifest.name ?? rootManifestPath
  const parents = new Map()
  const paths = new Map()
  const optional = new Map()
  const loaded = new Set()
  const skippedOptional = new Set()
  const queue = []

  for (const dependency of Object.keys(direct).filter(isFirstParty).sort()) {
    parents.set(dependency, undefined)
    paths.set(dependency, rootManifestPath)
    optional.set(dependency, false)
    queue.push(dependency)
  }

  const failures = []
  const exemptPeers = options.exemptPeers ?? new Set()
  const exempted = new Set()
  for (let index = 0; index < queue.length; index += 1) {
    const packageName = queue[index]
    const parentManifestPath = paths.get(packageName)
    if (packageName === undefined || parentManifestPath === undefined) continue
    if (loaded.has(packageName)) continue
    let current
    try {
      current = await loadPackage(packageName, parentManifestPath)
    } catch (cause) {
      if (optional.get(packageName) === true && isMissingPackage(cause)) {
        skippedOptional.add(packageName)
        continue
      }
      throw cause
    }
    loaded.add(packageName)
    const currentManifest = current.manifest
    const peers = currentManifest.peerDependencies ?? {}
    const peerMeta = currentManifest.peerDependenciesMeta ?? {}

    for (const peer of Object.keys(peers).sort()) {
      const requiredAtRoot = parents.get(packageName) === undefined || isFirstParty(peer)
      if (!requiredAtRoot || peerMeta[peer]?.optional === true || direct[peer] !== undefined) continue
      if (exemptPeers.has(peer)) {
        exempted.add(peer)
        continue
      }
      failures.push(`${formatChain(rootName, packageName, parents)} -> ${peer}`)
    }

    for (const dependency of Object.keys(currentManifest.dependencies ?? {}).filter(isFirstParty).sort()) {
      enqueue(dependency, packageName, current.path, false)
    }
    for (const dependency of Object.keys(currentManifest.optionalDependencies ?? {}).filter(isFirstParty).sort()) {
      enqueue(dependency, packageName, current.path, true)
    }
  }

  return { failures, packageCount: parents.size, exempted: [...exempted].sort() }

  function enqueue(dependency, parent, parentManifestPath, isOptional) {
    if (!parents.has(dependency)) {
      parents.set(dependency, parent)
      paths.set(dependency, parentManifestPath)
      optional.set(dependency, isOptional)
      queue.push(dependency)
      return
    }
    if (optional.get(dependency) !== true || isOptional) return
    optional.set(dependency, false)
    parents.set(dependency, parent)
    paths.set(dependency, parentManifestPath)
    if (skippedOptional.delete(dependency)) queue.push(dependency)
  }
}

/**
 * Resolve one installed package manifest from its owning package.
 * @param {string} name - package name.
 * @param {string} parentManifestPath - manifest whose dependency edge owns the package.
 * @returns {Promise<{ manifest: object, path: string }>}
 */
export async function loadInstalledPackage(name, parentManifestPath) {
  const require = createRequire(parentManifestPath)
  const path = require.resolve(`${name}/package.json`)
  return { manifest: require(path), path }
}

function isFirstParty(name) {
  return name.startsWith(FIRST_PARTY_PREFIX)
}

function isMissingPackage(cause) {
  return cause instanceof Error && 'code' in cause && cause.code === 'MODULE_NOT_FOUND'
}

function formatChain(rootName, packageName, parents) {
  const chain = [packageName]
  let parent = parents.get(packageName)
  while (parent !== undefined) {
    chain.unshift(parent)
    parent = parents.get(parent)
  }
  return [rootName, ...chain].join(' -> ')
}
