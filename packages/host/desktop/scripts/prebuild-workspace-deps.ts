/**
 * 打包/冒烟前预构建 workspace 依赖包(跨平台,被 package-win.ts / package-mac.ts /
 * release-mac.ts / verify-profile-boot.mjs 的真实 CLI 入口调用)。
 *
 * 背景:enterprise/account-card/branding 的 lib/ 未入库(fresh checkout 缺失),
 * 而 desktop 安装包运行时读取这些包的 lib/client.js(品牌 logo/版本标签等)。
 * 此前 dist:win/mac 未构建它们 → 安装包携带缺失/旧 bundle(品牌在但版本号不
 * 显示)。dist:linux 因前置 `yarn run build` 才碰巧完整。
 *
 * 顺序:desktop 自身 build 最先(产出 lib/types,enterprise 的 tsc 引用
 * dsh-plugin-desktop/desktop-home 的类型);随后 enterprise/account-card/
 * branding(它们 tsc 需 desktop 类型)。desktop build 不依赖 enterprise lib
 * (已验证),故无循环。
 *
 * 2026-09-20(构建环修复,路线 A + A 扩展)**修正这段顺序**:desktop 有三条真实的
 * 前置构建边——`src/host-locale.ts` / `src/desktop-home.ts` 各是一行 re-export
 * (两个零依赖叶子包 `@picoaide/dsh-host-locale` / `@picoaide/dsh-host-home` 的
 * lib/types),`src/main.ts`/`src/app-ai-runner.ts` 静态 import
 * `@picoaide/dsh-wasm-apps-host`(它自己又读 `@picoaide/dsh-browser/guard`)。
 * 而 browser 的 tsc 读 connectors 的 lib/types,connectors 只读两个叶子包 ⇒
 * 正确顺序是:**叶子包 → connectors → browser → wasm-apps-host → desktop → 其余**。
 * 旧顺序(desktop 最先、wasm-apps-host 垫底)在**干净检出**下会让 desktop 的
 * `tsc` 找不到那两个包的声明文件——`yarn check` 因为调度器已先把它们建好而看不
 * 出来,`yarn dist:*`(入口就是本函数)则直接失败。
 *
 * 2026-09-10 增量化:每个包构建前先判定「产物是否已是最新」——产物 mtime 不早于
 * 全部输入(src/ 递归 + package.json/tsconfig/tsdown 配置 + 依赖包产物)即跳过。
 * 动因:`yarn check` 里 desktop 的 verify:profile 会再跑一遍本函数,而此刻
 * 全部包刚刚在本轮 check 中构建完毕 → 纯重复劳动实测 40s(check 总时长的
 * 1/4)。判定只会在"源文件比产物新"或"产物缺失"时放行重建,方向始终偏保守;
 * CI/fresh checkout 下 lib/ 缺失 → 全量构建,行为与之前完全一致。
 * 需要强制全量重建时设 DSH_PREBUILD=force(或 CLI 传 --force)。
 *
 * 2026-09-23(mtime 竞态修复)**mtime 判定不足以代表"产物齐备"**:它只看
 * `outputFiles()` 里**残留**文件的最旧 mtime,而并发会话的 `yarn check` 会为别的包
 * 跑 tsdown(`clean: true` ⇒ `Cleaning N files`),可能正好在本函数与下游 tsc 之间把
 * 某个包的 `lib/` 清空。此时残留文件依旧"新" ⇒ 判定通过 ⇒ 跳过重建 ⇒ 下游报
 * `TS7016: Could not find a declaration file for module '@picoaide/dsh-wasm-apps-host'`
 * (实测 dsh-plugin-desktop 因此红 458s,并级联跳过 enterprise/cron/account-card)。
 * 现在 isUpToDate() 在 mtime 之外**还要求每个声明产物真的存在**:
 *   1. 该包 `package.json` 的 `exports` 每个子路径解析出的每个目标(`types` /
 *      `default` / `import` / `require`,含嵌套条件与数组)必须存在;
 *   2. 该包 `tsdown.config.ts` 的 `entry` 顶层键对应的产物必须存在(尽力而为地
 *      静态读配置;读不出只跳过这条来源,绝不因此判"需要重建")。
 * 漏一个就判"需要重建",绝不静默跳过。缺产物时的重建会沿依赖链向上传播
 * (依赖产物变新 ⇒ 依赖方也重建),这与既有的 mtime 语义一致。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDirectInvocation } from './direct-invocation.mjs'
import { channelVariantDirFor, readChannelVariantManifest } from './channel-variant.ts'

/** 构建产物目录(相对包根):lib/ 是各包 tsdown/tsc 的 outDir;desktop 另有 build/(brand-prepare)。 */
const OUTPUT_DIRS = ['lib', 'build']

/**
 * tsdown 产物可能的扩展名(由 `format` 与包 `type` 决定:esm → .js/.mjs,cjs → .cjs)。
 * 判定"入口产物是否存在"时逐个探测,避免把扩展名规则抄第二份(抄了必然漂移)。
 */
const ARTIFACT_EXTENSIONS = ['.js', '.mjs', '.cjs'] as const

/** 各包构建时读取、但不属于 src/ 的额外输入(相对仓库根)。 */
const EXTRA_INPUTS: Record<string, readonly string[]> = {
  // desktop build 先跑 brand-prepare.mjs 从 brands/official 派生图标与品牌资源
  'dsh-plugin-desktop': ['brands', 'assets'],
}

/** 构建输入判定时忽略的目录名(递归剪枝)。 */
const IGNORED_DIRS = new Set(['node_modules', '.git', 'lib', 'build', 'dist'])

/** 一个 workspace 包的构建描述。导出是为了让用例能用夹具表驱动同一个判定。 */
export interface WorkspacePackage {
  /** yarn workspace 名;null 表示"当前包"(用 `yarn run build` 而非 `yarn workspace`)。 */
  readonly workspace: string | null
  /** 包根相对仓库根。 */
  readonly dir: string
  /** 该包构建读取的其它 workspace 包(其产物更新则本包也需重建)。 */
  readonly deps?: readonly string[]
}

/**
 * 构建顺序表(叶子 → connectors → browser → wasm-apps-host → desktop → 其余)。
 * 导出是为了让 tests/prebuild-workspace-deps.spec.ts 对**同一份表**做声明面对拍
 * (另抄一份包表必然漂移,而漂移的清单正是本缺陷要消灭的形态)。
 */
export const WORKSPACE_PACKAGES: readonly WorkspacePackage[] = [
  // 0) 三个**零依赖叶子包**最先：browser / connectors / desktop 的 tsc 都读前两个的
  //    lib/types（desktop 的 `src/{host-locale,desktop-home}.ts` 各是一行 re-export）；
  //    panel-surface 是四个客户端面板（定时任务 / 能力中心 / 连接器 / 应用中心）
  //    共用的中列装载器与视觉语言，被它们的 client bundle 内联 ⇒ 同样必须先产出。
  { workspace: '@picoaide/dsh-host-locale', dir: 'packages/host/host-locale', deps: [] },
  { workspace: '@picoaide/dsh-host-home', dir: 'packages/host/host-home', deps: [] },
  { workspace: '@picoaide/dsh-panel-surface', dir: 'packages/client/panel-surface', deps: [] },
  // 0a) 宿主侧**网关客户端**的共享叶子包（2026-10-13 P0-b）：只读 host-locale 的
  //     lib/types ⇒ 排在它之后；enterprise / 能力中心 / 应用宿主三个消费方又都排在
  //     本包之后。它没有出边通往任何模块包，故不引入新的构建环。
  { workspace: '@picoaide/dsh-gateway-client', dir: 'packages/host/gateway-client', deps: ['packages/host/host-locale'] },
  // 0b) 底部「更多」行（2026-09-21 并道改造）：它把 panel-surface 的
  //     `activePanelId` / `PANEL_ACTIVE_ATTR` 内联进自己的 client bundle，因此
  //     **必须排在 panel-surface 之后**；五个面板插件（cron / enterprise /
  //     connectors / browser / wasm-apps）的类型面读它的 `./client` 声明
  //     （type-only import），所以它们又都排在它之后 —— 无环。
  { workspace: '@picoaide/dsh-foot-menu', dir: 'packages/client/foot-menu', deps: ['packages/client/panel-surface'] },
  // 0c) 能力中心（技能商店）的**客户端面**（2026-10-13 从 `@picoaide/dsh-enterprise`
  //     整块搬出）：`@picoaide/dsh-panel-surface` 被内联进它的 client bundle
  //     （读 panel-surface 的 lib/types + lib/client.js）⇒ 必须排在 panel-surface
  //     之后；`@picoaide/dsh-foot-menu` 的 `./client` 声明是它的 type-only 输入
  //     （`ctx.picoFootMenu`）⇒ 排在 foot-menu 之后。两条边都不成环（两个依赖都
  //     没有通往本包的出边）。
  //
  //     与 `scripts/check-workspaces.mjs` 的 `PACKAGES[*].needs` 有**一处刻意不同**：
  //     那边另有 enterprise / account-card → 本包两条边，那是两者的**测试**读本包
  //     源码（不产生产物输入）⇒ 只影响"何时重跑"，不进这张**构建**输入表。
  //     2026-10-13（P0-b）：**host 面也搬进来了**（四条本机路由 + 安装器/预检/归档/
  //     根表/frontmatter/内置技能事实），包随之从 `packages/client/` 移到
  //     `packages/host/`。构建输入因此多三条：host-locale（文案 + 宿主语言类型）、
  //     host-home（`dshHomeSafe` + 技能库根 `resolveSkillsDir`）、gateway-client
  //     （网关调用与错误分类）。三条都是无出边的叶子节点。
  {
    workspace: '@picoaide/dsh-capability-center',
    dir: 'packages/host/capability-center',
    deps: ['packages/client/panel-surface', 'packages/client/foot-menu', 'packages/host/host-locale', 'packages/host/host-home', 'packages/host/gateway-client'],
  },
  // 1) connectors：只读两个叶子包（`host-copy.ts` / `user-scope.ts`）—— 路线 A 扩展
  //    之后它**不再** import 桌面包，所以排在叶子包之后即可。
  {
    workspace: '@picoaide/dsh-connectors',
    dir: 'packages/host/connectors',
    deps: ['packages/host/host-home', 'packages/host/host-locale', 'packages/client/panel-surface', 'packages/client/foot-menu'],
  },
  // 2) browser：三个叶子包 + connectors 的 `lib/`。
  //    2026-10-13（去连接器耦合）：`src/index.ts` **不再**读 connectors 的 lib/types
  //    （契约改在 `src/connectors-contract.ts` 本地声明 ⇒ connectors/lib 不在时
  //    tsc 也过），改静态 import 数据根叶子包 `@picoaide/dsh-host-home`；
  //    `deps` 里仍留 connectors，因为 `tests/*.spec.ts` 值导入真实 `ConnectorStore`
  //    造夹具、运行期惰性 require 也解析到它的 `lib/`。
  {
    workspace: '@picoaide/dsh-browser',
    dir: 'packages/host/browser',
    deps: ['packages/host/host-home', 'packages/host/host-locale', 'packages/host/connectors', 'packages/client/foot-menu'],
  },
  // 3) 客户端专属 WASM 应用 origin：`electron-adapter.ts` 值导入
  //    `@picoaide/dsh-browser/guard` ⇒ 必须排在 browser 之后、desktop 之前
  //    （desktop 的 main.ts/app-ai-runner.ts 静态 import 它）。
  // 2026-09-24：`src/session.ts` 的订阅契约收口到叶子包（`session-events` 子路径）
  // ⇒ 它也是 wasm-apps-host 的构建输入。
  // 2026-10-13（P0-b）：应用中心（应用平台）的 host 面也搬进来了
  // （`src/wasm-apps.ts` / `wasm-app-tools.ts` / `wasm-apps-ai-rows-consent.ts` /
  // `app-routes.ts`）⇒ 构建输入多两条：host-home（`dshHomeSafe`）与 gateway-client
  // （网关调用 + 会话形状）。两条都无出边通往本包的前置节点。
  {
    workspace: '@picoaide/dsh-wasm-apps-host',
    dir: 'packages/host/wasm-apps-host',
    deps: ['packages/host/browser', 'packages/host/host-locale', 'packages/host/host-home', 'packages/host/gateway-client'],
  },
  // 4) desktop：读叶子包与 wasm-apps-host 的 lib/types，产出全仓共用的
  //    lib/types + build/。
  {
    workspace: null,
    dir: 'packages/host/desktop',
    deps: ['packages/host/host-home', 'packages/host/host-locale', 'packages/host/wasm-apps-host'],
  },
  // 2026-09-23：`loopback.ts` 四份合一后，enterprise 也直接读叶子包的
  // `./loopback` 子路径（原先实现住在自己包里）⇒ 这条边加上 host-locale。
  {
    workspace: '@picoaide/dsh-enterprise',
    dir: 'packages/host/enterprise',
    // 2026-10-13（P0-b）：`server-connector/{auth,config,electron}` 的实现收敛到
    // `packages/host/gateway-client`（本包保留同名 re-export）⇒ 多一条构建输入。
    deps: ['packages/host/host-locale', 'packages/host/gateway-client', 'packages/host/desktop', 'packages/client/panel-surface', 'packages/client/foot-menu'],
  },
  { workspace: '@picoaide/dsh-account-card', dir: 'packages/client/account-card', deps: ['packages/host/desktop'] },
  { workspace: '@picoaide/dsh-wasm-apps', dir: 'packages/client/wasm-apps', deps: ['packages/client/panel-surface', 'packages/client/foot-menu'] },
  { workspace: '@picoaide/dsh-branding', dir: 'packages/client/branding', deps: ['packages/host/desktop'] },
  // cron 的 tsc 仍读 desktop 的 lib/types（`dsh-plugin-desktop/host-locale` 与
  // `dsh-plugin-desktop/desktop-home` 两条 re-export 子路径）—— 它不在环上，
  // 两条子路径都保留，故这条边继续登记。2026-09-23 起它还直接读叶子包的
  // `./loopback` 子路径（`loopback.ts` 四份合一的落点），故加上 host-locale。
  {
    workspace: '@picoaide/dsh-cron',
    dir: 'packages/host/cron',
    deps: ['packages/host/host-locale', 'packages/host/desktop', 'packages/client/panel-surface', 'packages/client/foot-menu'],
  },
]

/** 执行一个 yarn 命令,失败即抛错。 */
function run(args: readonly string[], cwd: string, label: string): void {
  // corepack yarn:仓库约定(包管理器经 corepack);shell: true 让 Windows
  // 也能解析 corepack 的可执行 shim(否则 spawnSync 找不到未入 PATH 的包装)。
  const result = spawnSync('corepack', ['yarn', ...args], {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    throw new Error(`prebuildWorkspaceDeps: ${label} failed (status ${String(result.status)})`)
  }
}

/** 递归收集文件路径(不跟随符号链接,剪枝 node_modules/lib/build 等)。 */
function collectFiles(root: string, out: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      collectFiles(join(root, entry.name), out)
    } else if (entry.isFile()) {
      out.push(join(root, entry.name))
    }
  }
  return out
}

/** 一组文件的最新 mtime;空集合返回 0(调用方按"无输入"处理)。 */
function newestMtime(files: readonly string[]): number {
  let newest = 0
  for (const file of files) {
    const mtime = statSync(file).mtimeMs
    if (mtime > newest) newest = mtime
  }
  return newest
}

/** 一组文件的最旧 mtime;空集合返回 Infinity(调用方按"无产物"处理)。 */
function oldestMtime(files: readonly string[]): number {
  let oldest = Infinity
  for (const file of files) {
    const mtime = statSync(file).mtimeMs
    if (mtime < oldest) oldest = mtime
  }
  return oldest
}

/** 该包构建读取的全部输入文件。 */
function inputFiles(repoRoot: string, pkg: WorkspacePackage): string[] {
  const packageRoot = join(repoRoot, pkg.dir)
  const files = collectFiles(join(packageRoot, 'src'))
  for (const name of readdirSync(packageRoot)) {
    if (/^(?:package\.json|tsconfig[^/]*\.json|tsdown\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s)$/u.test(name)) {
      const path = join(packageRoot, name)
      if (statSync(path).isFile()) files.push(path)
    }
  }
  for (const extra of EXTRA_INPUTS[workspaceKey(pkg)] ?? []) {
    const path = join(repoRoot, extra)
    if (existsSync(path)) files.push(...collectFiles(path))
  }
  return files
}

/** 该包的构建产物文件。 */
function outputFiles(repoRoot: string, pkg: WorkspacePackage): string[] {
  const packageRoot = join(repoRoot, pkg.dir)
  const files: string[] = []
  for (const dir of OUTPUT_DIRS) {
    const path = join(packageRoot, dir)
    if (existsSync(path)) files.push(...collectFiles(path))
  }
  return files
}

function workspaceKey(pkg: WorkspacePackage): string {
  return pkg.workspace ?? 'dsh-plugin-desktop'
}

/** 包名 → 包描述(用于依赖产物 mtime 查询)。 */
const PACKAGE_BY_DIR = new Map(WORKSPACE_PACKAGES.map(pkg => [pkg.dir, pkg]))

/* ------------------------------------------------------------------ 声明产物 */
/*
 * 以下是"声明的产物是否真的存在"的唯一实现(2026-09-23)。它只回答一个问题:
 * **这个包声称自己会产出的文件,现在磁盘上有几个是缺的**。
 *
 * 判据方向是单向的:缺了 ⇒ 需要重建;读不出声明的形态 ⇒ 只跳过那条来源。
 * 反过来(读不出就重建)会让门禁永远红,是比本缺陷更糟的失败模式。
 */

/** `exports` 目标里哪些算"本包的构建产物":落在 OUTPUT_DIRS 内的相对路径。 */
function isDeclaredArtifactTarget(target: string): boolean {
  // 裸 specifier / 非相对目标不是本包文件(本仓没有这种形态,防御性排除)。
  if (!target.startsWith('./')) return false
  // 通配目标(如 cron 的 `"./src/*": "./src/*"`)不是"某一份产物",无法逐份判存在。
  if (target.includes('*')) return false
  const relative = target.slice(2)
  // `./package.json` 与 `./src/**` 都会被这条排除:它们不是构建产物。
  return OUTPUT_DIRS.some(dir => relative === dir || relative.startsWith(`${dir}/`))
}

/** 递归收集 `exports` 条件树里的字符串目标(string / 数组 / 嵌套条件对象)。 */
function collectExportTargets(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExportTargets(item, out)
    return out
  }
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) collectExportTargets(nested, out)
  }
  return out
}

/**
 * 该包 `package.json` 的 `exports` 声明的产物文件(相对包根、POSIX 形状、去重排序)。
 *
 * 这是本缺陷的主判据:`@picoaide/dsh-wasm-apps-host` 的
 * `exports["."].types = ./lib/types/index.d.ts` 在并发 clean 之后消失,而 mtime
 * 判定照样通过 —— 声明的 `types`/`default` 目标必须逐个存在,才算"构建完整"。
 */
export function declaredExportArtifacts(packageRoot: string): string[] {
  const manifestPath = join(packageRoot, 'package.json')
  if (!existsSync(manifestPath)) return []
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    // package.json 读不出/不是 JSON:输入文件判定会让这个包重建,这里不另判。
    return []
  }
  const exportsField =
    manifest !== null && typeof manifest === 'object' ? (manifest as Record<string, unknown>).exports : undefined
  if (exportsField === undefined) return []
  const targets = collectExportTargets(exportsField).filter(isDeclaredArtifactTarget)
  // 顶上两层目录不算产物(只有 tsdown 真产出才是);`./lib` 这种目录型目标不存在于本仓。
  return [...new Set(targets)].filter(target => !target.endsWith('/')).map(target => target.slice(2)).sort()
}

/** 去注释(字符串/模板串感知):注释里的花括号与逗号不能参与结构扫描。 */
function stripComments(text: string): string {
  let out = ''
  let quote: string | null = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string
    if (quote !== null) {
      out += char
      if (char === '\\') {
        out += text[index + 1] ?? ''
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      out += char
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      out += '\n'
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      index = text.indexOf('*/', index) + 1
      continue
    }
    out += char
  }
  return out
}

/** 配平扫描出文本里每个 `entry: { … }` 的块体(不含最外层花括号)。 */
function entryObjectBodies(text: string): string[] {
  const bodies: string[] = []
  const needle = 'entry:'
  let at = text.indexOf(needle)
  while (at !== -1) {
    let index = at + needle.length
    while (index < text.length && /\s/u.test(text[index] as string)) index += 1
    if (text[index] === '{') {
      let depth = 0
      let quote: string | null = null
      let cursor = index
      for (; cursor < text.length; cursor += 1) {
        const char = text[cursor] as string
        if (quote !== null) {
          if (char === '\\') {
            cursor += 1
            continue
          }
          if (char === quote) quote = null
          continue
        }
        if (char === '"' || char === "'" || char === '`') {
          quote = char
          continue
        }
        if (char === '{') depth += 1
        else if (char === '}') {
          depth -= 1
          if (depth === 0) break
        }
      }
      bodies.push(text.slice(index + 1, cursor))
    }
    at = text.indexOf(needle, at + needle.length)
  }
  return bodies
}

/** 在花括号/方括号/圆括号配平处按逗号切分(entry 块体用)。 */
function splitTopLevel(body: string): string[] {
  const segments: string[] = []
  let depth = 0
  let quote: string | null = null
  let segment = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string
    if (quote !== null) {
      segment += char
      if (char === '\\') {
        segment += body[index + 1] ?? ''
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      segment += char
      continue
    }
    if (char === '{' || char === '[' || char === '(') depth += 1
    else if (char === '}' || char === ']' || char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      segments.push(segment)
      segment = ''
      continue
    }
    segment += char
  }
  segments.push(segment)
  return segments
}

/**
 * `tsdown.config.ts` 里 `entry` 的顶层键(= 产物相对 outDir 的路径,不含扩展名)。
 *
 * 为什么要读配置:`exports` 只覆盖对外发布的入口,而 desktop 的 `main` / `bin` /
 * `preload/renderer-error`、cron 的 `host-scheduler` 这些**不经过 exports** 的产物
 * 同样会被 tsdown 的 `clean: true` 清掉,缺失时同样是硬故障(`lib/bin.js` 没了 =
 * 打包版没有 CLI)。手写扫描而不是引入 TS 解析器:失败模式是"读不出 ⇒ 不产生要求",
 * 覆盖仓库里真实使用的形态(对象字面量 entry、行/块注释、字符串/模板串)即可。
 */
export function tsdownEntryKeys(packageRoot: string): string[] {
  const configPath = join(packageRoot, 'tsdown.config.ts')
  if (!existsSync(configPath)) return []
  let text: string
  try {
    text = stripComments(readFileSync(configPath, 'utf8'))
  } catch {
    return []
  }
  const keys: string[] = []
  for (const body of entryObjectBodies(text)) {
    for (const segment of splitTopLevel(body)) {
      const match = /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_$][\w$]*))\s*:/u.exec(segment)
      const key = match?.[1] ?? match?.[2] ?? match?.[3]
      // 通配入口(entry: { x: 'src/*.ts' } 形态)不是单份产物,跳过。
      if (key !== undefined && !key.includes('*')) keys.push(key)
    }
  }
  return [...new Set(keys)].sort()
}

/**
 * 声明了却不存在的产物(相对包根、已排序去重);空数组 = 声明的产物齐备。
 *
 * 入口产物的落点按 **OUTPUT_DIRS** 探测(与 `outputFiles()` 同一个空间):产物目录
 * 之外的文件既不参与 mtime 判定,也不该参与存在性判定 —— 两处判据必须看同一批文件。
 * 标签按 tsdown 约定写成 `lib/<入口>{…}`(本仓所有包的 outDir 都是 `lib`)。
 *
 * 导出的原因:tests/prebuild-workspace-deps.spec.ts 用它把"缺了哪一个"钉死
 * (只看 isUpToDate() 的布尔值无法区分"因缺产物"与"因 mtime 旧")。
 */
export function missingDeclaredArtifacts(repoRoot: string, pkg: WorkspacePackage): string[] {
  const packageRoot = join(repoRoot, pkg.dir)
  const missing: string[] = []
  for (const artifact of declaredExportArtifacts(packageRoot)) {
    if (!existsSync(join(packageRoot, artifact))) missing.push(artifact)
  }
  for (const entry of tsdownEntryKeys(packageRoot)) {
    const emitted = OUTPUT_DIRS.some(dir =>
      ARTIFACT_EXTENSIONS.some(extension => existsSync(join(packageRoot, dir, `${entry}${extension}`))),
    )
    if (!emitted) missing.push(`${OUTPUT_DIRS[0]}/${entry}{${ARTIFACT_EXTENSIONS.join(',')}}`)
  }
  return [...new Set(missing)].sort()
}

/**
 * 判定单个包是否已是最新:产物存在,且最旧产物的 mtime 不早于
 * 自身输入与依赖产物的最新 mtime,且**声明的产物一份不缺**。
 *
 * 第三项是 2026-09-23 补的(mtime 竞态):mtime 只说明"残留的文件够新",
 * 说明不了"该产出的文件都在"。并发会话的 tsdown(`clean: true`)可以在本函数
 * 与下游 tsc 之间清掉 `lib/`,残留文件仍让 mtime 判定通过 ⇒ 静默跳过重建 ⇒
 * 下游 `TS7016: Could not find a declaration file`。
 *
 * `registry` 默认是本模块的生产包表;用例可传自己的夹具表驱动同一个判定。
 */
export function isUpToDate(
  repoRoot: string,
  pkg: WorkspacePackage,
  registry: ReadonlyMap<string, WorkspacePackage> = PACKAGE_BY_DIR,
): boolean {
  return stalenessReason(repoRoot, pkg, registry) === null
}

/**
 * `isUpToDate()` 的判定正文:返回 null 表示最新,否则返回**人类可读的原因**
 * (只用于日志与失败诊断;判定语义完全由它决定,不存在第二份判据)。
 */
export function stalenessReason(
  repoRoot: string,
  pkg: WorkspacePackage,
  registry: ReadonlyMap<string, WorkspacePackage> = PACKAGE_BY_DIR,
): string | null {
  const outputs = outputFiles(repoRoot, pkg)
  if (outputs.length === 0) return 'no build output'
  // 声明产物必须逐个真的存在:任一缺失 ⇒ 重建(不静默跳过)。
  const missing = missingDeclaredArtifacts(repoRoot, pkg)
  if (missing.length > 0) {
    const shown = missing.slice(0, 3).join(', ')
    const rest = missing.length > 3 ? `, +${missing.length - 3} more` : ''
    return `missing ${missing.length} declared artifact(s): ${shown}${rest}`
  }
  const inputs = inputFiles(repoRoot, pkg)
  let newestInput = newestMtime(inputs)
  for (const depDir of pkg.deps ?? []) {
    const dep = registry.get(depDir)
    if (dep === undefined) continue
    const depOutputs = outputFiles(repoRoot, dep)
    const depNewest = newestMtime(depOutputs)
    if (depNewest > newestInput) newestInput = depNewest
  }
  return oldestMtime(outputs) >= newestInput ? null : 'inputs newer than oldest output'
}

/**
 * 本次变体下**可以安全跳过**的包目录 → 该包属于哪个变体（空 Map = 全开构建）。
 *
 * "安全"是承重的限定词：只有当**没有任何保留包**把该目录列进 `deps` 时才可跳过。
 * 反例就在本表里 —— `browser` 的 `deps` 含 `packages/host/connectors`（它的 tsc 与
 * 运行期惰性 require 都读 connectors 的 `lib/`）⇒ 即便渠道关掉了连接器，
 * prebuild 也必须照常产出那份 `lib/`，否则保留包自己构建失败。反正它会随
 * staging `package.json` 的依赖裁剪而不进 asar。
 * @param desktopRoot - dsh-plugin-desktop 包根（清单落点由它派生）。
 * @returns 目录 → 变体标识。
 */
export function variantPrunedDirs(desktopRoot: string): ReadonlyMap<string, string> {
  const manifest = readChannelVariantManifest(channelVariantDirFor(desktopRoot))
  if (manifest === undefined) return new Map()
  const needed = new Set<string>()
  for (const pkg of WORKSPACE_PACKAGES) {
    if (manifest.directories.includes(pkg.dir)) continue
    for (const dep of pkg.deps ?? []) needed.add(dep)
  }
  const result = new Map<string, string>()
  for (const dir of manifest.directories) {
    if (needed.has(dir)) continue
    result.set(dir, manifest.variant)
  }
  return result
}

/** 预构建 desktop 自身 + enterprise/account-card/branding/其余自研插件包。
 *
 * `desktopRoot` 是 dsh-plugin-desktop 包根(调用方一直传这个);仓库根由它上溯三级
 * 得到(yarn workspace 命令在包内任意目录都能解析,故 cwd 统一用 desktopRoot)。
 */
export function prebuildWorkspaceDeps(desktopRoot: string): void {
  const repoRoot = resolve(desktopRoot, '..', '..', '..')
  const force = process.env.DSH_PREBUILD === 'force' || process.argv.includes('--force')
  const variantSkip = variantPrunedDirs(desktopRoot)
  const skipped: string[] = []
  const variantSkipped: string[] = []
  for (const pkg of WORKSPACE_PACKAGES) {
    const key = workspaceKey(pkg)
    // 功能模块变体（2026-10-13，P2）：被关闭的模块**不再随包**，三个 `dist:*` 默认
    // 先跑本函数 ⇒ 不跳过就会去构建一个不进产物的包（白付一次 tsdown）。
    // `variantPrunedDirs()` 只在**没有**保留包把它当构建输入时才把它列进来：
    // `browser` 的 tsc 与运行期惰性 require 都读 `connectors` 的 `lib/`
    // （见本表第 2 条的注释），跳过它会让保留包构建失败 —— 那种"省一次构建"换来
    // 一次红是本末倒置。真正让模块不进产物的是 staging `package.json` 的依赖裁剪
    // （`pack-app-root.mjs`），不是这里。
    if (variantSkip.has(pkg.dir)) {
      variantSkipped.push(`${key} (变体 ${variantSkip.get(pkg.dir)} 关闭了该模块)`)
      continue
    }
    const reason = stalenessReason(repoRoot, pkg)
    if (!force && reason === null) {
      skipped.push(key)
      continue
    }
    // 带上判定原因:本缺陷的现场症状是"跳过重建"看着一切正常,日志必须能直接
    // 区分"因为缺产物重建"与"因为源文件更新重建"。
    console.log(`[prebuild] ${key}: building${reason === null ? ' (forced)' : ` (${reason})`}`)
    const args = pkg.workspace === null ? ['run', 'build'] : ['workspace', pkg.workspace, 'build']
    run(args, desktopRoot, `${key} build`)
  }
  if (variantSkipped.length > 0) {
    console.log(
      `[prebuild] 变体裁剪，跳过: ${variantSkipped.join(', ')}`
      + '（这些模块不随包；保留包若把它当构建输入就不会列在这里 —— 见 variantPrunedDirs）',
    )
  }
  if (skipped.length > 0) {
    console.log(`[prebuild] up to date, skipped: ${skipped.join(', ')} (DSH_PREBUILD=force 可强制重建)`)
  }
  // dsh-memory-evolve 是 DSH 生态外部插件(构建依赖 ~/.dsh/source 的 esbuild,
  // 见其 scripts/build.mjs),其 lib/ 保留版本库跟踪,不走标准 prebuild。
}

if (isDirectInvocation(import.meta)) {
  const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  try {
    prebuildWorkspaceDeps(desktopRoot)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
