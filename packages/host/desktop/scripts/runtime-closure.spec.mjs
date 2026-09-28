import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { parse as parseYaml } from 'yaml'

import {
  peerExemptionViolations,
  UNMOUNTED_PEER_EXEMPTIONS,
  verifyRuntimeClosure,
} from './runtime-closure.mjs'

const manifests = {
  '@deepseek-ai/root': {
    dependencies: { '@deepseek-ai/leaf': '1.0.0' },
    peerDependencies: { '@deepseek-ai/service': '1.0.0' },
  },
  '@deepseek-ai/leaf': {},
  '@deepseek-ai/service': {},
}

async function loadPackage(name) {
  const manifest = manifests[name]
  assert.ok(manifest, `missing fixture manifest for ${name}`)
  return { manifest, path: `/virtual/${name}/package.json` }
}

test('rejects a required first-party peer that is not declared at the root', async () => {
  const result = await verifyRuntimeClosure({
    name: 'runtime',
    dependencies: { '@deepseek-ai/root': '1.0.0' },
  }, loadPackage, '/virtual/runtime/package.json')

  assert.deepEqual(result.failures, ['runtime -> @deepseek-ai/root -> @deepseek-ai/service'])
})

test('accepts required root peers and ignores optional peers', async () => {
  const result = await verifyRuntimeClosure({
    name: 'runtime',
    dependencies: {
      '@deepseek-ai/root': '1.0.0',
      '@deepseek-ai/service': '1.0.0',
    },
  }, async (name) => {
    if (name === '@deepseek-ai/root') {
      return {
        manifest: {
          ...manifests[name],
          peerDependencies: {
            ...manifests[name].peerDependencies,
            '@deepseek-ai/optional': '1.0.0',
          },
          peerDependenciesMeta: { '@deepseek-ai/optional': { optional: true } },
        },
        path: `/virtual/${name}/package.json`,
      }
    }
    return loadPackage(name)
  }, '/virtual/runtime/package.json')

  assert.deepEqual(result.failures, [])
  assert.equal(result.packageCount, 3)
})

test('requires external peers of direct deploy-root packages', async () => {
  const result = await verifyRuntimeClosure({
    name: 'runtime',
    dependencies: { '@deepseek-ai/root': '1.0.0' },
  }, async (name) => ({
    manifest: { ...manifests[name], peerDependencies: { react: '^18.2.0' } },
    path: `/virtual/${name}/package.json`,
  }), '/virtual/runtime/package.json')

  assert.deepEqual(result.failures, ['runtime -> @deepseek-ai/root -> react'])
})

test('upgrades an optional path when another package requires the same dependency', async () => {
  const result = await verifyRuntimeClosure({
    name: 'runtime',
    dependencies: {
      '@deepseek-ai/optional-owner': '1.0.0',
      '@deepseek-ai/required-owner': '1.0.0',
      '@deepseek-ai/service': '1.0.0',
    },
  }, async (name) => ({
    manifest: {
      ...(name === '@deepseek-ai/optional-owner'
        ? { optionalDependencies: { '@deepseek-ai/shared': '1.0.0' } }
        : name === '@deepseek-ai/required-owner'
          ? { dependencies: { '@deepseek-ai/shared': '1.0.0' } }
          : name === '@deepseek-ai/shared'
            ? { peerDependencies: { '@deepseek-ai/service': '1.0.0' } }
            : {}),
    },
    path: `/virtual/${name}/package.json`,
  }), '/virtual/runtime/package.json')

  assert.deepEqual(result.failures, [])
  assert.equal(result.packageCount, 4)
})

// ---- 未挂载 peer 的豁免（2026-09-28，0.1.7 收尾）--------------------------------
// 判据必须**双向**：豁免生效（不再报缺 peer）**且**豁免可被打坏（点名的行被重新启用时
// 必须报"豁免失效"）。只写前一半，等于给 closure 判据开了一个无法回收的白名单。

test('an exempted peer is not reported as a missing root declaration', async () => {
  const result = await verifyRuntimeClosure({
    name: 'runtime',
    dependencies: { '@deepseek-ai/root': '1.0.0' },
  }, loadPackage, '/virtual/runtime/package.json', {
    exemptPeers: new Set(['@deepseek-ai/service']),
  })

  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.exempted, ['@deepseek-ai/service'])
})

test('反向对照：同一份输入不加豁免时必须仍然报缺 peer', async () => {
  const result = await verifyRuntimeClosure({
    name: 'runtime',
    dependencies: { '@deepseek-ai/root': '1.0.0' },
  }, loadPackage, '/virtual/runtime/package.json')

  assert.deepEqual(result.failures, ['runtime -> @deepseek-ai/root -> @deepseek-ai/service'])
  assert.deepEqual(result.exempted, [])
})

test('每条豁免点名的组合行都必须真的 disabled（重新启用即失效）', () => {
  const exemptions = [{ peer: '@deepseek-ai/x', rows: ['row-a', 'row-b'], reason: 'fixture' }]
  assert.deepEqual(peerExemptionViolations(exemptions, ['row-a', 'row-b']), [])
  // 只重新启用其中一行也必须报（豁免是"这些行都没挂载"，不是"至少一行没挂载"）。
  assert.deepEqual(peerExemptionViolations(exemptions, ['row-a']), [
    '@deepseek-ai/x: 豁免点名的行 row-b 已不再 disabled ⇒ '
    + '要么把该 peer 声明到部署根，要么重新禁用这些行（豁免不能陈旧）',
  ])
  assert.deepEqual(peerExemptionViolations(exemptions, []), [
    '@deepseek-ai/x: 豁免点名的行 row-a, row-b 已不再 disabled ⇒ '
    + '要么把该 peer 声明到部署根，要么重新禁用这些行（豁免不能陈旧）',
  ])
})

test('仓库里的豁免表本身成立（对当前 cordis.patch.yml）', () => {
  const disabled = new Set(
    (parseYaml(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')) ?? [])
      .filter(row => row?.disabled === true)
      .map(row => row.id),
  )
  assert.deepEqual(peerExemptionViolations(UNMOUNTED_PEER_EXEMPTIONS, disabled), [])
})
