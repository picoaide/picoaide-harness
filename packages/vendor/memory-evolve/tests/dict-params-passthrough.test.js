/**
 * CoI / Prompt 视图 `dict()` 包装器的插值参数透传回归（2026-09-16 R9 审计 P1）。
 *
 * 缺陷形态：#77 的 i18n 迁移把两个视图的私有字典并进注册命名空间时，包了一层
 * `function dict(t) { return (key) => t(key) }` —— 返回函数的形参只有 `key`，
 * 第二参 `params` 被静默丢弃。调用点全部写成 `t('coi.…', { count })`，而上游
 * `translate` 在**无参**时原样返回模板，于是 COI Tab 有 9 处用户可见文案直接
 * 渲染成 `{count}` / `{value}` / `{minutes}`（任何语言都错，中文界面也错）。
 *
 * 三层都钉住，因为它们是同一份语义的三份载体（src / 入库产物 / 调用点）：
 *   1. src 的两个包装器必须把 `params` 透传给 `t`；
 *   2. **入库产物** `lib/client.js`（随安装包分发，构建依赖上游 esbuild，门禁里
 *      不会重建）必须与 src 同形 —— 只改 src 等于没修；
 *   3. 两个视图里带参数的 `t('key', { … })` 调用必须真的存在于字典键集合里
 *      （防的是"参数传了但键写错、静默回落模板"）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT_DIR = join(PACKAGE_ROOT, 'src', 'client')

const WRAPPERS = [
  { file: join(CLIENT_DIR, 'CoIView.tsx'), fn: 'dict' },
  { file: join(CLIENT_DIR, 'PromptView.tsx'), fn: 'dict' },
]

/**
 * Minimal stub for the bundle's platform requires: the bundle only evaluates
 * them, and only uses the values while rendering (this test never renders).
 */
function platformStub() {
  const stub = new Proxy(function () {}, {
    get: () => stub,
    apply: () => stub,
  })
  return stub
}

/**
 * Load the SHIPPED bundle's exports (the real dictionary the client registers).
 *
 * `src/client/index.ts` cannot be imported here: it transitively imports `.tsx`
 * files, which Node's type stripping does not handle — an earlier version of
 * this test used `await import(...).catch(() => null)` and therefore turned the
 * key check below into dead code that always passed (2026-09-16 R2 audit).
 * Reading the artifact is also the stronger statement: this is the dictionary
 * the plugin actually registers.
 * @returns the bundle's exported values.
 */
function loadBundleExports() {
  const code = readFileSync(join(PACKAGE_ROOT, 'lib', 'client.js'), 'utf8')
  let entry
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load: (value) => { entry = value } } }
  try {
    new Function('require', code)(() => platformStub())
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
  assert.ok(entry !== undefined, 'lib/client.js did not register a loader entry')
  return entry.factory(() => platformStub())
}

test('src：dict() 包装器透传 params（收窄成 (key) => t(key) 即红）', () => {
  for (const { file, fn } of WRAPPERS) {
    const source = readFileSync(file, 'utf8')
    const body = new RegExp(`function ${fn}\\(t: Translate\\)[^{]*\\{([\\s\\S]*?)\\n\\}`, 'u').exec(source)
    assert.ok(body, `${file}: 找不到 ${fn}() 包装器`)
    assert.match(body[1], /\(key, params\) => t\(key, params\)/u,
      `${file}: ${fn}() 必须把 params 透传给 t（丢参会让 {count} 之类模板原文上屏）`)
    assert.doesNotMatch(body[1], /\(key\) => t\(key\)/u, `${file}: ${fn}() 又收窄成单参了`)
  }
})

test('产物：lib/client.js 的两个包装器与 src 同形', () => {
  const bundle = readFileSync(join(PACKAGE_ROOT, 'lib', 'client.js'), 'utf8')
  assert.doesNotMatch(bundle, /return \(key\) => t\(key\);/u,
    'lib/client.js 仍有丢参的 dict 包装器（产物是用户实际拿到的那份）')
  assert.match(bundle, /function dict\(t\) \{\n {2}return \(key, params\) => t\(key, params\);\n\}/u)
  assert.match(bundle, /function dict2\(t\) \{\n {2}return \(key, params\) => t\(key, params\);\n\}/u)
})

test('调用点：带参数的 t(key, {…}) 都在字典里有对应键', () => {
  // 字典取自**入库产物**（见 loadBundleExports 的说明）。键写错时上游 translate
  // 会原样返回模板，所以这一层是"参数传了但键不存在"的唯一覆盖。
  const exported = loadBundleExports()
  assert.ok(exported.zh !== undefined && exported.en !== undefined, 'bundle 未导出 zh/en 字典')
  const zhKeys = new Set(Object.keys(exported.zh))
  const enKeys = new Set(Object.keys(exported.en))
  assert.deepEqual([...zhKeys].sort(), [...enKeys].sort(), 'zh/en 键集必须镜像')
  let checked = 0
  for (const { file } of WRAPPERS) {
    const source = readFileSync(file, 'utf8')
    // ASCII-only key class on purpose: a doc comment mentioning the pattern
    // (`t('coi.…', { … })`) must not be scanned as a call site.
    for (const match of source.matchAll(/\bt\('([A-Za-z0-9_.]+)',\s*\{/gu)) {
      checked += 1
      assert.ok(zhKeys.has(match[1]), `${file}: 字典缺少 ${match[1]}（会渲染成模板原文）`)
    }
  }
  // 探针自身不能空转：两个视图里确实存在带参数的调用（9 处以上）。
  assert.ok(checked >= 9, `只检查到 ${checked} 处带参调用，判据可能已失效`)
})
