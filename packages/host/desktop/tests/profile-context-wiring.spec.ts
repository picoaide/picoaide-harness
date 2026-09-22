/**
 * issue #130 的**接线**判据：`profileContext` 必须在生产路径上发布，且 `hmr` 行必须在
 * 桌面组合里显式关闭。
 *
 * 为什么除了 `scripts/verify-profile-boot.mjs` 还需要这一层：那份冒烟**自己** provide
 * `profileContext`（它复刻的就是 main.ts 的启动形态），所以只把 main.ts 里那一行删掉时，
 * 冒烟仍然全绿 —— 本仓吃过一次同形的亏（`provide(WASM_APPS_AI_RUNNER_SERVICE, …)` 当时
 * 没有任何判据，删掉后门禁全绿而生产静默 503，见 tests/app-ai-runner.spec.ts 第 2 条用例）。
 * 分工：冒烟证**行为**（真挂载整棵树 + 逐个 preset mount），这里证**接线**（两处调用点
 * 仍在、且 hmr 行仍是关的）。两处都必须能被打坏，否则判据是空转的。
 *
 * ## 为什么这里的匹配必须是**代码感知**（AST），不能是文本包含
 *
 * 本文件第一版用的是裸 `toContain`：
 *
 * ```ts
 * expect(main).toContain("hostCtx.provide('profileContext', desktopProfileContext(prepared))")
 * ```
 *
 * 2026-09-23 的对抗审计（lane F1 第二轮）实测它在**两个方向同时失效**：
 *
 * 1. **假绿（变异 M7b）**：把 `src/main.ts` 那一行**注释掉**（保留 import 让 tsc 通过）
 *    ⇒ 注释行里逐字含有这串文本 ⇒ 断言照样通过。后果不是"少一条测试"，而是：整个
 *    issue #130 的修复可以在生产被关掉、而冒烟 EXIT=0 + 本 spec 3/3 绿 —— P0 全绿回归。
 * 2. **误伤（变异 M8）**：把调用按 prettier 风格**换行**（
 *    `hostCtx.provide(\n  'profileContext',\n  desktopProfileContext(prepared),\n)`）
 *    ⇒ 语义完全等价，文本却不再连续出现 ⇒ spec 变红。判据惩罚了正确的代码。
 *
 * 文本判据的根因是它把"源码里存在这串字符"当成了"这个调用会发生"。注释、字符串字面量、
 * 改了格式的等价代码三者的"文本"与"语义"完全脱钩。这里改成在 **TypeScript AST** 上找
 * 调用点：
 *
 * * 注释**不是语法节点** ⇒ 注释掉即"调用不存在"（M7b 必红）；
 * * 空白 / 换行 / 参数折行**不改变 AST**（M8 仍绿）。
 *
 * 理想判据是**行为**判据（"main.ts 与冒烟调用同一个构造函数"）——那需要在 `src/main.ts`
 * 侧导出一个小工厂（`createProfileContextProvider(prepared, hostCtx)`）再让冒烟调用它；
 * 本轮 lane 的文件所有权不允许改 `src/`，所以退到 AST 判据，并用下面的"自检用例"把
 * 两个方向都钉死：任何人把判据改回文本包含，自检立刻红。
 *
 * @module dsh-plugin-desktop/tests/profile-context-wiring
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import ts from 'typescript'
import { parse as parseYaml } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { desktopProfileContext, prepareDesktopProfile } from '../src/profile.ts'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const homes: string[] = []

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-context-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** One `hostCtx.provide('profileContext', …)` call site found in the syntax tree. */
interface ProfileContextPublish {
  /** Identifier of the factory whose call produced the second argument (undefined for other shapes). */
  readonly factory: string | undefined
  /** True when the call sits inside an `if`/ternary, i.e. it may not run at all. */
  readonly conditional: boolean
  /** 1-based line of the call, for the failure message. */
  readonly line: number
}

/**
 * Find every `<bootContext>.provide('profileContext', <factory>(…))` call site in a source file.
 *
 * Operates on the syntax tree on purpose: comments never become nodes (so a commented-out
 * call is *absent*), while whitespace and line breaks are irrelevant (so a reformatted,
 * semantically identical call is *still found*). See the module header for the two
 * mutations that made a plain `toContain` unusable in both directions.
 *
 * The receiver is spelled `hostCtx` in `src/main.ts` and `host` in the smoke callback, so
 * both spellings are accepted; the *service name* (`'profileContext'`) and the factory are
 * what the judge is about.
 * @param source - TypeScript/JavaScript source text.
 * @param fileName - Name used for diagnostics and script-kind detection.
 * @returns Every matching call site, in source order.
 */
const BOOT_CONTEXT_RECEIVERS = new Set(['hostCtx', 'host', 'ctx'])

function findProfileContextPublishes(source: string, fileName = 'main.ts'): ProfileContextPublish[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith('.mjs') || fileName.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  )
  const found: ProfileContextPublish[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && BOOT_CONTEXT_RECEIVERS.has(node.expression.expression.text)
      && node.expression.name.text === 'provide'
    ) {
      const serviceArg = node.arguments[0]
      const valueArg = node.arguments[1]
      if (
        serviceArg !== undefined
        && valueArg !== undefined
        && ts.isStringLiteralLike(serviceArg)
        && serviceArg.text === 'profileContext'
      ) {
        const callee = ts.isCallExpression(valueArg) ? valueArg.expression : undefined
        found.push({
          factory: callee !== undefined && ts.isIdentifier(callee) ? callee.text : undefined,
          conditional: hasConditionalAncestor(node),
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/**
 * Whether a call may be skipped at runtime because it sits under an `if`/ternary.
 *
 * The provide must be unconditional: `if (someFlag) hostCtx.provide('profileContext', …)`
 * is the same P0 as not publishing at all whenever the flag is false. `try`/loops/plain
 * blocks stay allowed — they do not make the call optional in the same silent way.
 * @param node - the call expression to inspect.
 * @returns true when an `if` statement or conditional expression is an ancestor.
 */
function hasConditionalAncestor(node: ts.Node): boolean {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isIfStatement(current) || ts.isConditionalExpression(current)) return true
  }
  return false
}

/** `import { desktopProfileContext, … } from '<specifier>'` bindings for one identifier. */
function importedFrom(source: string, fileName: string, identifier: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    if (bindings.elements.some(element => element.name.text === identifier)) {
      specifiers.push(statement.moduleSpecifier.text)
    }
  }
  return specifiers
}

describe('desktop profileContext wiring (issue #130)', () => {
  it('判据本身是代码感知的：注释掉必红、换行格式化仍绿、条件化必被抓', () => {
    // 自检 —— 这条用例保护的是**判据**而不是产品代码。三个方向各自对应一次实测变异。
    const canonical = "hostCtx.provide('profileContext', desktopProfileContext(prepared))\n"
    expect(findProfileContextPublishes(canonical)).toHaveLength(1)

    // M7b：整行注释掉（保留 import 让 tsc 通过）—— 文本包含会通过，AST 必须找不到。
    const commented = `// ${canonical}void desktopProfileContext\n`
    expect(findProfileContextPublishes(commented)).toEqual([])
    // 块注释同理（成对出现的另一种"注释掉"）。
    expect(findProfileContextPublishes(`/* ${canonical} */\n`)).toEqual([])

    // M8：语义等价的换行改写（参数折到下一行）—— 必须仍然找得到。
    const reformatted = "hostCtx.provide(\n  'profileContext',\n  desktopProfileContext(prepared),\n)\n"
    const reformattedHits = findProfileContextPublishes(reformatted)
    expect(reformattedHits).toHaveLength(1)
    expect(reformattedHits[0]?.factory).toBe('desktopProfileContext')

    // 注释里的"调用"不得被当成调用，而真实调用必须被找到（同一份源码里两者共存）。
    const mixed = `${commented}${canonical}`
    expect(findProfileContextPublishes(mixed)).toHaveLength(1)

    // 条件化：`if (flag) provide(…)` 在 flag 为假时与不 provide 等价 —— 必须被标出来。
    const conditional = `if (process.env.SKIP_PROFILE_CONTEXT !== '1') {\n  ${canonical}}\n`
    const conditionalHits = findProfileContextPublishes(conditional)
    expect(conditionalHits).toHaveLength(1)
    expect(conditionalHits[0]?.conditional).toBe(true)

    // 换一个 service 名不算数（判据只认 'profileContext'）。
    expect(findProfileContextPublishes("hostCtx.provide('desktopRuntime', makeRuntime())\n")).toEqual([])
  })

  it('main.ts 经 desktopProfileContext 发布 profileContext（内联字面量会让冒烟测的不是生产路径）', () => {
    const main = readFileSync(join(packageRoot, 'src', 'main.ts'), 'utf8')
    const publishes = findProfileContextPublishes(main)
    expect(
      publishes,
      "src/main.ts 必须有一处**未注释、无条件**的 hostCtx.provide('profileContext', desktopProfileContext(prepared))；"
      + '注释掉它会让 issue #130（创造模式全部会话挂不起来）静默复活（对抗审计变异 M7b）',
    ).toHaveLength(1)
    expect(publishes[0]?.factory, 'profileContext 必须由 desktopProfileContext 构造，不得内联字面量').toBe('desktopProfileContext')
    expect(publishes[0]?.conditional, 'provide 不得被 if/三元包住 —— 关掉时与不 provide 完全等价').toBe(false)

    // 构造函数只允许一份实现：main.ts 必须从 profile.ts 引入，且同一函数被冒烟用于自己的
    // provide（两处调用**同一个**构造函数，否则冒烟测的就不是生产路径）。
    expect(importedFrom(main, 'main.ts', 'desktopProfileContext')).toEqual(['./profile.ts'])
    const smoke = readFileSync(join(packageRoot, 'scripts', 'verify-profile-boot.mjs'), 'utf8')
    expect(importedFrom(smoke, 'verify-profile-boot.mjs', 'desktopProfileContext')).toEqual(['../lib/profile.js'])
    expect(
      findProfileContextPublishes(smoke, 'verify-profile-boot.mjs'),
      '冒烟必须自己用同一个 desktopProfileContext 发布 profileContext（它 boot 的就是生产形态）',
    ).toHaveLength(1)
  })

  it('cordis.patch.yml 显式关闭 hmr 行（打开它需要 CLI 专属的 appReady 服务）', () => {
    const patch = join(packageRoot, 'cordis.patch.yml')
    const rows = parseYaml(readFileSync(patch, 'utf8')) as Array<{ id?: unknown; disabled?: unknown }>
    const hmr = rows.find(row => row?.id === 'hmr')
    expect(hmr, 'cordis.patch.yml 必须显式列出 hmr 行').toBeDefined()
    expect(hmr?.disabled, 'hmr 行必须是 disabled: true（提供 profileContext 会让它激活并炸掉整棵树）').toBe(true)
  })

  it('desktopProfileContext 的每个字段都来自本次真实装配', async () => {
    const home = temporaryHome()
    const prepared = await prepareDesktopProfile('1', home, 'linux')
    const context = desktopProfileContext(prepared)

    expect(context.name).toBe('desktop')
    expect(context.dir).toBe(prepared.profile.dir)
    expect(context.patchPath).toBe(prepared.profile.patchPath)
    expect(context.home).toBe(home)
    expect(context.cwd).toBe(process.cwd())
    expect(context.startedBundles).toEqual(prepared.profile.layers.map(layer => layer.packageName))
    // 装配入参的透传：必须用装配时那个值，而不是在这里重读 process.env
    // （冒烟/嵌入式调用会显式传值，重读会让"组合期 A、自述 B"分叉）。
    expect(context.telemetryDisabledEnv).toBe('1')

    // `plugin-manager` 的 `listBundles()` 会把 installAnchor 当 **JSON 文件**读
    // （`JSON.parse(readFileSync(this.profile.installAnchor))`）—— 给目录会在第一条
    // 管理动作上炸，所以这里按"它真能读"判据，而不是只比字符串。
    expect(context.installAnchor).toBe(prepared.installAnchor)
    expect(existsSync(context.installAnchor)).toBe(true)
    expect(JSON.parse(readFileSync(context.installAnchor, 'utf8'))).toMatchObject({ name: 'dsh-plugin-desktop' })

    expect(context.overlays).toEqual(prepared.overlays)
  })

  it('overlays 是 patches 的**真**尾段，且重算路径上不产生重复行（分界挪到 0 即红）', async () => {
    const home = temporaryHome()
    const prepared = await prepareDesktopProfile('1', home, 'linux')
    const patches = prepared.patches
    const overlays = prepared.overlays

    // ── 为什么这条不是 `patches.slice(len - overlays.length) == overlays` ──────────
    // 那一版是**恒真式**：`overlays` 本来就由 `patches.slice(overlayStart)` 构造，
    // 尾段关系按构造成立，换任何分界都过。对抗审计把它改成 `patches.slice(0)`
    // （分界挪到 0）后：冒烟 EXIT=0、接线 spec 3/3 绿 —— 而重算出的 191 个 id 里
    // **163 个重复**，上游 `plugin-manager` 的 `listPlugins()` 会因 `candidates.length > 1`
    // 把整片行判成 `unaddressable`，`set_plugin` 全线拒绝。恒真式测的是数组算法，
    // 不是分界语义。下面三条各有独立牙齿：
    //   ① overlays 非空且**严格短于** patches（分界挪到 0 ⇒ 两者等长 ⇒ 红）；
    //   ② 启动器 pin 层不得**重复 insert** 层区已经插入的条目（`insert:` 是追加语义，
    //      同一个 id 插两次 = Loader 里两个同名条目 ⇒ 重复候选）；
    //   ③ 用上游 `readProfilePatches` 走一遍 `plugin-manager` 的重算路径，
    //      **重复 id 必须为空**（分界挪到 0 ⇒ 163 条重复 ⇒ 红）。
    //
    // 注意 ② 只对 `insert:` 行成立：`id:` 行是**整键替换**语义，overlays 里出现
    // `settings`/`ui-layout`/`webserver` 这些与层区同名的 patch 行是**正常的**
    // （它们就是启动器的 pin），重复的是"条目"而不是"补丁键"。
    const insertIds = (rows: typeof patches): string[] => rows
      .flatMap(row => (row as { insert?: Array<{ id?: unknown }> }).insert ?? [])
      .map(entry => entry?.id)
      .filter((id): id is string => typeof id === 'string')

    expect(overlays.length, 'overlays 不能为空（空 = 启动器 pin 层整个丢失）').toBeGreaterThan(0)
    expect(
      overlays.length,
      'overlays 必须严格短于 patches：等长说明分界被挪到了 0，整份 patches 会被当成启动器覆盖层'
      + '（重算路径随即把每一行 insert 两次 —— 见本用例末尾的重复 id 判据）',
    ).toBeLessThan(patches.length)
    // 尾段逐项相等（结构相等，不是引用相等：overlays 是 structuredClone 出来的）。
    expect(patches.slice(patches.length - overlays.length)).toEqual(overlays)
    const prefixInsertIds = new Set(insertIds(patches.slice(0, patches.length - overlays.length)))
    expect(
      insertIds(overlays).filter(id => prefixInsertIds.has(id)),
      'overlays 不得重复 insert 层区已插入的条目 id：重复 insert 会让 Loader 里出现两个同名条目，'
      + 'plugin-manager 的 listPlugins() 随即把整片判 unaddressable',
    ).toEqual([])

    // ③ plugin-manager 的真实重算路径：readProfilePatches(profileContext) 必须无重复 id。
    const context = desktopProfileContext(prepared)
    const recomputed = readProfilePatches('dsh', context, prepared.profile)
    expect(recomputed.length).toBeLessThan(patches.length + 1)
    const counts = new Map<string, number>()
    for (const row of composeEntries([recomputed])) {
      if (typeof row.id !== 'string') continue
      counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
    }
    const duplicated = [...counts].filter(([, count]) => count > 1).map(([id, count]) => `${id}×${String(count)}`)
    expect(
      duplicated,
      'readProfilePatches(profileContext) 复算出的行 id 出现重复 ⇒ overlays 分界落在层区内'
      + '（上游 plugin-manager 会把重复候选整片判 unaddressable）',
    ).toEqual([])
  })
})
