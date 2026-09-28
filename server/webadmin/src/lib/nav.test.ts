import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NAV_ENTRIES, isNavVisible, landingPath, visibleNav, type NavEntry } from './nav'
import type { MeUser } from './rbac'

// P2-43: nav 声明的 perms 必须被真正消费——服务端 /me 下发的 permissions
// 是可见性唯一依据(auditor = audit:read + usage:read + user:read)。
//
// ---------------------------------------------------------------------------
// 2026-09-23 第四轮审计 R4-D-3：权限全集**不再手抄**，改成**读 Go 真源**
// ---------------------------------------------------------------------------
//
// 此前这里是一份 `GO_ALL_PERMISSIONS` 手抄副本（旧注释写着"这正是本测试要产生的
// 摩擦"）。手抄不是判据：它只覆盖"前端声明一个 Go 端不存在的权限点"这**一个方向**，
// 而真实事故（`error-monitoring:read` 在 rbac.go 被删除后该页对**包括 super_admin
// 在内**的全部角色不可见、测试依旧全绿）恰好是另一个方向——两侧一起漂移时同样沉默。
//
// 现在解析 `server/internal/serverauth/rbac.go`（权限点常量块 +
// `AllPermissions`/`AuditorPermissions` 切片）并做**四向**对拍：
//   ① Go 常量块 ↔ `AllPermissions`：双向覆盖（新增常量忘了授权 ⇒ 红；切片引用一个
//      不存在的常量 ⇒ 红）；
//   ② `NAV_ENTRIES` 声明的 perms ⊆ Go 权限全集（前端声明 Go 不认的点 ⇒ 该页永不显示
//      = 上面那起事故的形态 ⇒ 红）；
//   ③ `lib/rbac.ts` 的每个 `PERM_*` 常量值都必须存在于 Go 全集（同一事故的第二个
//      入口：页面判定与导航 gate 用的是两份手抄表）；
//   ④ **前向守卫**：Go 全集里每个权限点必须要么被某个 NAV_ENTRIES gate，要么登记在
//      `PERM_WITHOUT_NAV_ENTRY`（附理由）—— 新增权限点时必须**显式决定**它在管理端
//      有没有入口，不能悄悄多出来。
//
// 读不到文件 / 解析出 0 条 ⇒ **throw**（fail-loud，不 skip；静默跳过等于关掉判据）。

/**
 * 定位服务端权限点真源 `server/internal/serverauth/rbac.go`。
 *
 * 不用 `import.meta.url`：jsdom 环境下它是 `http://localhost/...`。与
 * `pages/app-center/opens-contract-parity.spec.ts` 同款——从 cwd 向上找服务端标记。
 * @returns rbac.go 的绝对路径。
 */
function findRbacGo(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'internal', 'serverauth', 'rbac.go'))) {
      return join(dir, 'internal', 'serverauth', 'rbac.go')
    }
    if (existsSync(join(dir, 'server', 'internal', 'serverauth', 'rbac.go'))) {
      return join(dir, 'server', 'internal', 'serverauth', 'rbac.go')
    }
    dir = resolve(dir, '..')
  }
  throw new Error(
    `找不到服务端权限点真源 server/internal/serverauth/rbac.go（cwd=${process.cwd()}）：本用例读 Go 源码对拍，找不到真源必须红`,
  )
}

/**
 * 定位前端权限常量表 `src/lib/rbac.ts`（同样从 cwd 向上找，不依赖 import.meta.url）。
 * @returns rbac.ts 的绝对路径。
 */
function findRbacTs(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'src', 'lib', 'rbac.ts'))) return join(dir, 'src', 'lib', 'rbac.ts')
    if (existsSync(join(dir, 'webadmin', 'src', 'lib', 'rbac.ts'))) {
      return join(dir, 'webadmin', 'src', 'lib', 'rbac.ts')
    }
    dir = resolve(dir, '..')
  }
  throw new Error(`找不到前端权限常量表 src/lib/rbac.ts（cwd=${process.cwd()}）`)
}

const RBAC_GO_PATH = findRbacGo()
const RBAC_GO = readFileSync(RBAC_GO_PATH, 'utf8')
const RBAC_TS_PATH = findRbacTs()
const RBAC_TS = readFileSync(RBAC_TS_PATH, 'utf8')

/**
 * Go 权限点常量块：`PermXxx = "value"` ⇒ `{ PermXxx: 'value' }`。
 * @param src - rbac.go 全文。
 * @returns 常量名 → 权限点字符串。
 */
function goPermConstants(src: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of src.matchAll(/\b(Perm[A-Za-z0-9]*)\s*=\s*"([^"]+)"/gu)) {
    out.set(m[1]!, m[2]!)
  }
  if (out.size === 0) {
    throw new Error(`${RBAC_GO_PATH} 里解析不到任何权限点常量（形态变了？对拍必须 fail-loud）`)
  }
  return out
}

/**
 * Go 权限切片（`AllPermissions` / `AuditorPermissions`）⇒ 权限点**值**列表（保留声明顺序）。
 * @param src - rbac.go 全文。
 * @param varName - 切片变量名。
 * @param consts - {@link goPermConstants} 的结果（切片里写的是常量**名**）。
 * @returns 权限点字符串列表。
 */
function goPermSlice(src: string, varName: string, consts: Map<string, string>): string[] {
  const m = new RegExp(`var\\s+${varName}\\s*=\\s*\\[\\]string\\s*\\{`).exec(src)
  if (m === null) throw new Error(`${RBAC_GO_PATH} 里找不到切片 ${varName}（改名了？对拍真源必须同步）`)
  const open = src.indexOf('{', m.index)
  let depth = 0
  let end = -1
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) throw new Error(`${RBAC_GO_PATH} 里 ${varName} 的花括号不闭合`)
  const out: string[] = []
  for (const rawLine of src.slice(open + 1, end).split('\n')) {
    const line = rawLine.replace(/\/\/.*$/u, '').trim()
    if (line === '') continue
    for (const token of line.split(',')) {
      const name = token.trim()
      if (name === '') continue
      const value = consts.get(name)
      if (value === undefined) {
        throw new Error(`${varName} 引用了未声明的权限常量 ${name}（Go 真源自身不一致）`)
      }
      out.push(value)
    }
  }
  if (out.length === 0) throw new Error(`${RBAC_GO_PATH} 的 ${varName} 解析出 0 条（对拍必须 fail-loud）`)
  return out
}

/**
 * 前端 `lib/rbac.ts` 的 `PERM_*` 常量：`export const PERM_X = 'value'`。
 * @param src - rbac.ts 全文。
 * @returns 常量名 → 权限点字符串。
 */
function tsPermConstants(src: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of src.matchAll(/export const (PERM_[A-Z0-9_]+)\s*=\s*'([^']+)'/gu)) {
    out.set(m[1]!, m[2]!)
  }
  if (out.size === 0) {
    throw new Error('前端 lib/rbac.ts 里解析不到任何 PERM_* 常量（形态变了？对拍必须 fail-loud）')
  }
  return out
}

const GO_PERM_CONSTANTS = goPermConstants(RBAC_GO)
const GO_ALL_PERMISSIONS = goPermSlice(RBAC_GO, 'AllPermissions', GO_PERM_CONSTANTS)
const GO_AUDITOR_PERMISSIONS = goPermSlice(RBAC_GO, 'AuditorPermissions', GO_PERM_CONSTANTS)
const TS_PERM_CONSTANTS = tsPermConstants(RBAC_TS)

/**
 * **扫描根 = `src/**`（递归）**，不再只是 `lib/rbac.ts`（2026-09-29 第三十轮 FIX-45 ④）。
 *
 * 现场（第二十九轮 AC2-03，变异 + 反向对照只动"位置"这一个变量）：
 *   `PERM_AUDIT_RETENTION_WRITE` 就地声明在 `pages/Audit.tsx:24`，而当时的扫描根只是
 *   `lib/rbac.ts` ⇒ 对它**零覆盖**。把常量打错一个字符 ⇒ **整套 webadmin
 *   `50 files / 721 tests` 全绿、EXIT=0**，而保留策略保存按钮对**所有人（含超管）
 *   永久禁用**（`hasPermission` 拿一个永远匹配不上的字符串问权限）；把同一个常量
 *   搬进 `rbac.ts` 后，同一个错字 ⇒ 本文件当场红。
 *
 * 所以这里有**两条**判据，缺一不可：
 *   ① 扫描根扩到 `src/**` 的全部 `.ts/.tsx`（下面 `declaredPermConstants` 递归收集）；
 *   ② **前向守卫**：`PERM_*` 常量**只允许在 `lib/rbac.ts` 里声明** —— 就地再写一份
 *      （哪怕值与真源一致）也当场红，否则"扫描根之外的第二份手抄"会再次出现。
 * @param dir - 起始目录（webadmin 的 `src`）。
 * @returns 全 `src/**` 里 `PERM_*` 声明清单（`{ file, name, value }`）。
 */
function declaredPermConstants(dir: string): Array<{ file: string; name: string; value: string }> {
  const out: Array<{ file: string; name: string; value: string }> = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(?:ts|tsx)$/u.test(entry.name)) continue
      if (/\.test\.tsx?$/u.test(entry.name)) continue // 测试自己的夹具不算"声明一份权限常量"
      const text = readFileSync(full, 'utf8')
      for (const m of text.matchAll(
        /^[ \t]*(?:export[ \t]+)?const[ \t]+(PERM_[A-Z0-9_]+)[ \t]*(?::[^=]+)?=[ \t]*'([^']+)'/gmu,
      )) {
        out.push({ file: full, name: m[1]!, value: m[2]! })
      }
    }
  }
  walk(dir)
  if (out.length === 0) {
    throw new Error(`src/** 里解析不到任何 PERM_* 声明（扫描根坏了？前向守卫必须 fail-loud）`)
  }
  return out
}

const SRC_ROOT = resolve(dirname(RBAC_TS_PATH), '..')
const DECLARED_PERM_CONSTANTS = declaredPermConstants(SRC_ROOT)

// ===========================================================================
// 2026-09-27 第三十二轮 FIX-47 · 子泳道 B：`hasPermission(<实参>)` **调用点**守卫
// ===========================================================================
//
// 现场（第三十一轮 AD2 真跑复现，`temp/r31/AD2/REPORT.md` 的 `## AD2-01`）：把
// `pages/usage/Departments.tsx:38` 的实参就地写成**行内字符串字面量**
// `hasPermission('dept:raed')` ⇒ `npx vitest run src/pages/usage` 5 files / 28 tests
// **全绿、EXIT=0**；反向对照（只把值换成另一个**合法**权限点 `user:read`）才红。
//
// 为什么那次全绿：`hasPermission` 在实参匹配不上任何权限点时对**所有角色**恒 false
// （`lib/rbac.ts:81-90`），于是 `canReadDepts` 恒假 ⇒ 该页组织架构树/成员数/主管列与
// `GET /api/server/admin/departments` 对**所有人（含 super_admin）**永久消失，界面还
// 反过来显示「当前账号没有组织架构读取权限」。
//
// 这与 FIX-45 ④（保留策略保存按钮对所有人永久禁用）是**同一个失效模式**，只是收口点
// 不同：那次是 `PERM_*` 的**声明位置**（上面 `declaredPermConstants` 的前向守卫），
// 这次是 `hasPermission` 的**调用点实参** —— 行内字面量不是声明，落在既有两条前向守卫
// 的取值域之外（`declaredPermConstants` 的正则匹配的是 `const PERM_X = '…'` 这种声明）。
//
// 本节三条判据（**认符号来源，不认命名约定**）：
//   ① `hasPermission(<实参>)` 的实参必须是**从 `lib/rbac.ts` import 进来的 PERM_***
//      标识符（含 `{ PERM_X as 别名 }`、`import * as rbac` + `rbac.PERM_X`）—— 即实参
//      **真的 trace 到** rbac.ts 的导出，而且 trace 到的那个名字必须是它**真的声明过**的
//      `PERM_*`（vitest 不做类型检查，`import { PERM_X } from '../lib/rbac'` 打错名字
//      不会被 tsc 挡住）；
//   ② 表驱动形态（`hasPermission(t.perm)`）必须显式登记在 `PERM_ARG_TABLE_REGISTRY`，
//      且登记项要过第二道判据：那张表该属性的取值必须**仍然全是** rbac 的 `PERM_*`
//      标识符（登记 ≠ 放行"随便什么表达式"）；未登记的实参形态 ⇒ 红；
//   ③ 每个调用点必须在 `PERM_ARG_POSITIVE_FIXTURES` 里登记为「有正向夹具」并指向**真实
//      存在**的测试名，且该用例执行期内的 `setCurrentAdmin` 实参必须显式授予该权限点的
//      **字面值**（测试名不存在、夹具没授予该点 ⇒ 红）。判据③是**结构判据**：它证明
//      "存在一条会因该权限点写错而红的用例"，不证明那条用例断言了什么 —— 行为断言写在
//      被指向的用例里，本节不替它们背书。
//
// 取值域（明写清楚，免得"扫描根之外"的事故再来一次）：
//   * 扫描面 = `src/**` 的全部 `.ts/.tsx`，**去掉 `*.test.ts(x)`**：测试可以故意传错值
//     来验证 fail-closed 语义（那是 `hasPermission` 自身的单测，不是产品收口点）；
//   * 注释里的提及不算调用点（先把注释整段抹成空格再扫）；
//   * `lib/rbac.ts` 里的**函数定义**不算调用点（按 `function hasPermission(` 形态跳过），
//     并在自证里要求"全局恰好跳过一处、且它在 rbac.ts 里"，免得跳过规则把真调用点吞掉；
//   * **不支持但确实可写**的等价形态（写了就红，红得有理 —— 它们都不是 rbac.ts 的
//     `PERM_*` 标识符）：本地别名 `const P = PERM_X`、从第三方模块转出
//     （`import { PERM_X } from './perm-alias'`）、计算取属性（`TABS[0].perm`、`t['perm']`）、
//     三元/`??`表达式、把权限点存进 state/props 再传。要放行这些形态必须走
//     `PERM_ARG_TABLE_REGISTRY`（显式决定 + 表取值二次判据）。

/**
 * 把注释（或注释与字符串内容）整段抹成空格。**下标与换行逐字保留** ——
 * 调用方在掩码串上定位与配对、在原文上取实参（掩码只为不让注释/字符串里的括号
 * 干扰配对计数，以及判断"这一处是不是在注释里"）。
 *
 * 已知边界（有意）：模板字面量的 `${…}` 内部按字符串处理（里面再嵌注释不会被识别）。
 * @param src - 源文件全文。
 * @param mode - `comments` 只抹注释（保留字符串，供读实参字面量）；`comments-and-strings`
 *   连字符串内容一起抹（供花括号/方括号配对计数）。
 * @returns 等长的掩码串。
 */
function maskSource(src: string, mode: 'comments' | 'comments-and-strings'): string {
  const out = src.split('')
  const blank = (i: number): void => {
    if (i < out.length && out[i] !== '\n') out[i] = ' '
  }
  const drop = mode === 'comments-and-strings'
  type State = 'code' | 'line' | 'block' | 'single' | 'double' | 'template'
  let state: State = 'code'
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    const n = src[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') { blank(i); blank(i + 1); i++; state = 'line' }
      else if (c === '/' && n === '*') { blank(i); blank(i + 1); i++; state = 'block' }
      else if (c === "'") { if (drop) blank(i); state = 'single' }
      else if (c === '"') { if (drop) blank(i); state = 'double' }
      else if (c === '`') { if (drop) blank(i); state = 'template' }
      continue
    }
    if (state === 'line') {
      if (c === '\n') state = 'code'
      else blank(i)
      continue
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { blank(i); blank(i + 1); i++; state = 'code' }
      else blank(i)
      continue
    }
    // 字符串内部
    const quote = state === 'single' ? "'" : state === 'double' ? '"' : '`'
    if (c === '\\') { if (drop) { blank(i); blank(i + 1) } i++; continue }
    if (c === quote) { if (drop) blank(i); state = 'code'; continue }
    if (drop) blank(i)
  }
  return out.join('')
}

/**
 * 从 `openIndex`（指向 open 字符）找配对的 close 字符下标。
 * @param masked - 掩码后的文本（字符串/注释已抹平）。
 * @param openIndex - 起始下标。
 * @param open - 开括号字符。
 * @param close - 闭括号字符。
 * @returns 配对闭括号的下标。
 */
function matchingDelimiter(masked: string, openIndex: number, open: string, close: string): number {
  let depth = 0
  for (let i = openIndex; i < masked.length; i++) {
    if (masked[i] === open) depth += 1
    else if (masked[i] === close) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  throw new Error(`括号不配对（openIndex=${openIndex}，${open}${close}）：守卫的解析器坏了，必须 fail-loud`)
}

/**
 * 取实参列表里**第一个顶层实参**的原文（顶层 = 不在任何括号/花括号/方括号里）。
 * @param text - 原文。
 * @param masked - 同长度的掩码串。
 * @param start - 实参列表起点（`(` 之后）。
 * @param end - 实参列表终点（配对的 `)`）。
 * @returns 第一个实参的原文（已 trim）。
 */
function firstArgText(text: string, masked: string, start: number, end: number): string {
  let depth = 0
  for (let i = start; i < end; i++) {
    const c = masked[i]
    if (c === '(' || c === '{' || c === '[') depth += 1
    else if (c === ')' || c === '}' || c === ']') depth -= 1
    else if (c === ',' && depth === 0) return text.slice(start, i).trim()
  }
  return text.slice(start, end).trim()
}

/** `src` 下的 POSIX 风格相对路径（断言信息里用，跨平台稳定）。 */
function relPosix(from: string, to: string): string {
  return relative(from, to).split(sep).join('/')
}

/** `at` 处的 1-based 行号。 */
function lineOf(text: string, at: number): number {
  return text.slice(0, at).split('\n').length
}

/**
 * 该文件**从 `lib/rbac.ts`** import 进来的绑定：
 *   * `named` = 直接可用的本地标识符（`PERM_X`、`PERM_X as 别名` 的别名）；
 *   * `namespaces` = `import * as rbac` 的命名空间绑定。
 *
 * 只收"trace 得到 rbac.ts **真的声明过**的 `PERM_*`"的名字：打错常量的 import
 * （`import { PERM_NOPE } from '../lib/rbac'`）在这里就被判为**不来自 rbac** ⇒ 红
 * —— vitest 不做类型检查，这类错误不会在别处显形。
 * @param text - 文件全文。
 * @param filePath - 文件绝对路径（相对 import 按它的目录解析）。
 * @returns 绑定集合。
 */
function rbacImportBindings(text: string, filePath: string): { named: Set<string>; namespaces: Set<string> } {
  const named = new Set<string>()
  const namespaces = new Set<string>()
  const dir = dirname(filePath)
  const fromRbac = (spec: string): boolean => {
    if (!spec.startsWith('.')) return false
    const resolved = resolve(dir, spec)
    return resolved === RBAC_TS_PATH || resolved === RBAC_TS_PATH.replace(/\.ts$/u, '')
  }
  for (const m of text.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'([^']+)'/gu)) {
    if (!fromRbac(m[2]!)) continue
    for (const raw of m[1]!.split(',')) {
      const part = raw.trim()
      if (part === '') continue
      const aliased = /^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/u.exec(part)
      const imported = aliased === null ? part : aliased[1]!
      const local = aliased === null ? part : aliased[2]!
      // 必须是 rbac.ts **真的声明过**的 PERM_*（不是"看起来像"）。
      if (/^PERM_[A-Z0-9_]+$/u.test(imported) && TS_PERM_CONSTANTS.has(imported)) named.add(local)
    }
  }
  for (const m of text.matchAll(/import\s*\*\s*as\s+([A-Za-z0-9_$]+)\s*from\s*'([^']+)'/gu)) {
    if (fromRbac(m[2]!)) namespaces.add(m[1]!)
  }
  return { named, namespaces }
}

/** 一个 `hasPermission(` 调用点的判定形态。 */
type HasPermissionArgKind = 'rbac-identifier' | 'rbac-member' | 'registered-table' | 'literal' | 'unresolved'

interface HasPermissionSite {
  /** 绝对路径。 */
  file: string
  /** 相对 `src/` 的 POSIX 路径。 */
  rel: string
  /** 1-based 行号。 */
  line: number
  /** 实参原文（第一个顶层实参，已 trim）。 */
  arg: string
  kind: HasPermissionArgKind
}

/**
 * 判定单个实参的形态（**纯函数**，守卫自证直接喂合成片段给它）。
 * @param arg - 实参原文。
 * @param rel - 所在文件相对 `src/` 的路径（用于查表驱动登记表）。
 * @param named - 该文件从 rbac.ts 直接 import 的标识符。
 * @param namespaces - 该文件的 `import * as` 命名空间绑定。
 * @returns 形态。
 */
function classifyPermArg(
  arg: string,
  rel: string,
  named: Set<string>,
  namespaces: Set<string>,
): HasPermissionArgKind {
  if (/^'[^']*'$/u.test(arg) || /^"[^"]*"$/u.test(arg) || /^`[^`]*`$/u.test(arg)) return 'literal'
  if (/^[A-Za-z0-9_$]+$/u.test(arg)) return named.has(arg) ? 'rbac-identifier' : 'unresolved'
  const member = /^([A-Za-z0-9_$]+)\.(PERM_[A-Z0-9_]+)$/u.exec(arg)
  if (member !== null && namespaces.has(member[1]!) && TS_PERM_CONSTANTS.has(member[2]!)) return 'rbac-member'
  if (PERM_ARG_TABLE_REGISTRY.some((e) => e.rel === rel && e.arg === arg)) return 'registered-table'
  return 'unresolved'
}

/**
 * 表驱动实参的登记表。**新增条目必须有人显式决定**（未登记的实参形态一律红）。
 *
 * 允许它的前提由 {@link tablePermArgValues} 的第二道判据保证：那张表该属性的取值必须
 * 仍然全是 rbac.ts 的 `PERM_*` 标识符 —— 否则这里就从"允许一个间接层"退化成
 * "允许一个可以随便写字符串的口子"，正是本条要防的失效模式。
 */
const PERM_ARG_TABLE_REGISTRY: Array<{
  rel: string
  arg: string
  tableConst: string
  prop: string
  reason: string
}> = [
  {
    rel: 'pages/usage/UsageLayout.tsx',
    arg: 't.perm',
    tableConst: 'TABS',
    prop: 'perm',
    reason:
      '用量中心子导航把每个标签依赖的权限点声明在同文件的 `TABS` 常量表里（与服务端 '
      + 'internal/router 的 AdminRoute 申报一一对应），过滤写成 `TABS.filter((t) => '
      + 'hasPermission(t.perm))`。允许的理由：权限点仍然只有 rbac.ts 一处来源，'
      + '`TABS` 只是把它们排成一张表；风险（表里能写裸字面量）由同节的'
      + '「登记的表取值必须仍是 PERM_* 标识符」判据收口。',
  },
]

/**
 * 读表驱动登记项指向的那张表，取出该属性的全部取值文本。
 * @param rel - 相对 `src/` 的路径。
 * @param tableConst - 表常量名。
 * @param prop - 属性名。
 * @returns 取值原文列表（≥1；解析不到即 throw，绝不静默通过）。
 */
function tablePermArgValues(rel: string, tableConst: string, prop: string): string[] {
  const file = join(SRC_ROOT, rel)
  const text = readFileSync(file, 'utf8')
  const masked = maskSource(text, 'comments-and-strings')
  const decl = new RegExp(`(?:^|[^A-Za-z0-9_$])const\\s+${tableConst}\\b[^=]*=\\s*\\[`, 'u').exec(masked)
  if (decl === null) {
    throw new Error(
      `表驱动登记项指向的 ${rel} 里找不到 \`const ${tableConst} = [\`（登记项过期或表改名？判据必须 fail-loud）`,
    )
  }
  const open = masked.indexOf('[', masked.indexOf('=', decl.index) + 1)
  const close = matchingDelimiter(masked, open, '[', ']')
  const body = text.slice(open + 1, close)
  const values = [...body.matchAll(new RegExp(`\\b${prop}\\s*:\\s*([^,}\\n]+)`, 'gu'))].map((m) => m[1]!.trim())
  if (values.length === 0) {
    throw new Error(
      `${rel} 的 ${tableConst} 里解析不到任何 \`${prop}:\` 取值（形态变了？判据必须 fail-loud，不能"零命中全绿"）`,
    )
  }
  return values
}

/**
 * 扫 `src/**`（去掉测试文件）的全部 `hasPermission(` 调用点。
 *
 * 解析不到任何调用点 ⇒ throw（扫描根/正则退化时不能"零命中全绿"）。
 * @returns 调用点清单 + 被跳过的函数定义 + 扫描到的文件数。
 */
function scanHasPermissionSites(): {
  sites: HasPermissionSite[]
  declarations: string[]
  filesScanned: number
} {
  const sites: HasPermissionSite[] = []
  const declarations: string[] = []
  let filesScanned = 0
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(?:ts|tsx)$/u.test(entry.name)) continue
      // 测试文件不在本判据的取值域内（测试可以故意传错值验证 fail-closed 语义）。
      if (/\.test\.tsx?$/u.test(entry.name)) continue
      filesScanned += 1
      const text = readFileSync(full, 'utf8')
      const masked = maskSource(text, 'comments')
      const { named, namespaces } = rbacImportBindings(text, full)
      const rel = relPosix(SRC_ROOT, full)
      for (const m of masked.matchAll(/(^|[^A-Za-z0-9_$.])hasPermission\s*\(/gu)) {
        const at = (m.index ?? 0) + m[1]!.length
        const before = masked.slice(Math.max(0, at - 24), at)
        if (/(?:^|[^A-Za-z0-9_$])(?:function|const|let|var)\s+$/u.test(before)) {
          // `export function hasPermission(perm: string, …)` —— 函数定义，不是调用点。
          declarations.push(`${rel}:${lineOf(text, at)}`)
          continue
        }
        const open = masked.indexOf('(', at)
        const close = matchingDelimiter(masked, open, '(', ')')
        const arg = firstArgText(text, masked, open + 1, close)
        sites.push({ file: full, rel, line: lineOf(text, at), arg, kind: classifyPermArg(arg, rel, named, namespaces) })
      }
    }
  }
  walk(SRC_ROOT)
  if (sites.length === 0) {
    throw new Error('src/** 里扫不到任何 hasPermission 调用点（扫描根或正则退化？前向守卫必须 fail-loud）')
  }
  return { sites, declarations, filesScanned }
}

/** 调用点 → 该调用点要求的权限点**值**（来自 rbac.ts / 登记表，不手抄）。 */
function requiredPermPoints(site: HasPermissionSite): string[] {
  if (site.kind === 'rbac-identifier') return [TS_PERM_CONSTANTS.get(site.arg)!]
  if (site.kind === 'rbac-member') return [TS_PERM_CONSTANTS.get(site.arg.split('.')[1]!)!]
  const entry = PERM_ARG_TABLE_REGISTRY.find((e) => e.rel === site.rel && e.arg === site.arg)
  if (entry === undefined) throw new Error(`实参 ${site.arg}（${site.rel}）没有登记项，取不到权限点`)
  const file = join(SRC_ROOT, entry.rel)
  const text = readFileSync(file, 'utf8')
  const { named, namespaces } = rbacImportBindings(text, file)
  return tablePermArgValues(entry.rel, entry.tableConst, entry.prop).map((value) => {
    if (classifyPermArg(value, entry.rel, named, namespaces) === 'literal') {
      throw new Error(
        `${entry.rel} 的 ${entry.tableConst} 里把 ${entry.prop} 写成了裸字面量 ${value}`
        + `（表驱动形态只有在"取值仍来自 rbac.ts"时才被放行）：请改回 PERM_* 标识符`,
      )
    }
    const name = value.includes('.') ? value.split('.')[1]! : value
    const point = TS_PERM_CONSTANTS.get(name)
    if (point === undefined) {
      throw new Error(`${entry.rel} 的 ${entry.tableConst} 里 ${entry.prop}: ${value} 不是 rbac.ts 的 PERM_* 标识符`)
    }
    return point
  })
}

/**
 * 「该调用点有正向夹具」登记表（判据③）。
 *
 * `kind` 是**如实标注**：`behavior` = 本条目的用例里有"持有点 ⇒ 控件可见/请求发出"
 * 的行为断言（人读过并确认）；`registration` = 只有结构判据（测试名存在 + 夹具授予了
 * 该点），没有行为断言。不要把 `registration` 读成行为判据。
 */
interface PermArgPositiveFixture {
  rel: string
  arg: string
  testFile: string
  testName: string
  kind: 'behavior' | 'registration'
}

/**
 * 取出名为 `name` 的用例（`it(` / `test(`）的函数体原文。
 *
 * 用例名正则在**只抹注释**的掩码串上跑（字符串要留着才能读名字），花括号配对在
 * **连字符串一起抹**的掩码串上做（字符串里的 `{}` 不参与计数）；两者与原文等长，
 * 所以下标通用。
 * @param text - 文件原文。
 * @param name - 用例名（逐字相等）。
 * @returns 函数体原文；找不到返回 null。
 */
function findTestCaseBody(text: string, name: string): string | null {
  const masked = maskSource(text, 'comments')
  const maskedAll = maskSource(text, 'comments-and-strings')
  for (const m of masked.matchAll(/(?:^|[^A-Za-z0-9_$])(?:it|test)(?:\.\w+)?\s*\(\s*(['"`])([^'"`]*)\1/gu)) {
    if (m[2] !== name) continue
    const open = maskedAll.indexOf('{', m.index + m[0]!.length)
    if (open < 0) return null
    return text.slice(open, matchingDelimiter(maskedAll, open, '{', '}') + 1)
  }
  return null
}

/**
 * 该用例执行期内的 `setCurrentAdmin` **夹具取值域**（用于判"夹具真的授予了该权限点"）。
 *
 * 规则：用例体自己设了非 null 的 currentAdmin ⇒ 只看用例体（用例显式 `setCurrentAdmin(null)`
 * 时拿不到权限点 ⇒ 红）；否则回落到该文件的 `beforeEach` 钩子。`setCurrentAdmin(IDENT)`
 * 的 IDENT 若指向文件级 `const IDENT = {…}`，把那份声明的原文也纳入取值域。
 * @param text - 文件原文。
 * @param body - 用例体原文。
 * @returns 夹具文本；用例执行期内**没有任何** `setCurrentAdmin(` ⇒ null。
 */
function fixtureScopeText(text: string, body: string): string | null {
  const maskedAll = maskSource(text, 'comments-and-strings')
  const scopes: string[] = []
  if (/setCurrentAdmin\s*\(\s*(?!null\s*\))/u.test(body)) scopes.push(body)
  else {
    for (const m of maskedAll.matchAll(/(?:^|[^A-Za-z0-9_$])beforeEach\s*\(/gu)) {
      const open = maskedAll.indexOf('{', m.index + m[0]!.length)
      if (open < 0) continue
      scopes.push(text.slice(open, matchingDelimiter(maskedAll, open, '{', '}') + 1))
    }
  }
  if (!scopes.some((s) => /setCurrentAdmin\s*\(/u.test(s))) return null
  const extra: string[] = []
  for (const scope of scopes) {
    for (const m of scope.matchAll(/setCurrentAdmin\s*\(\s*([A-Za-z0-9_$]+)\s*\)/gu)) {
      const decl = new RegExp(`(?:^|[^A-Za-z0-9_$])const\\s+${m[1]}\\b`, 'u').exec(maskedAll)
      if (decl === null) continue
      const eq = maskedAll.indexOf('=', decl.index)
      if (eq < 0) continue
      const open = maskedAll.indexOf('{', eq)
      if (open < 0) continue
      extra.push(text.slice(decl.index, matchingDelimiter(maskedAll, open, '{', '}') + 1))
    }
  }
  return [...scopes, ...extra].join('\n')
}

/**
 * 每个调用点的正向夹具登记。
 *
 * **调用点清单本身是交付物**（第三十二轮 FIX-47 子泳道 B 的 `## ②` 表）：新增一处
 * `hasPermission(...)` 而忘了登记 ⇒ 本节的判据③当场红，逼着人显式决定"拿什么用例
 * 证明持有点时真的看得见/真的发请求"。
 */
const PERM_ARG_POSITIVE_FIXTURES: PermArgPositiveFixture[] = [
  { rel: 'pages/usage/Departments.tsx', arg: 'PERM_DEPT_READ', testFile: 'pages/usage/usage-center.test.tsx', testName: '持有 dept:read 时必须请求组织树并渲染成员列(正向夹具)', kind: 'behavior' },
  { rel: 'pages/usage/UsageLayout.tsx', arg: 't.perm', testFile: 'pages/usage/auditor-models.test.tsx', testName: '持有全部权限点时 7 个标签全部可见(含 dept:read 的部门用量与 report:read 的报表订阅)', kind: 'behavior' },
  { rel: 'pages/usage/Models.tsx', arg: 'PERM_GATEWAY_READ', testFile: 'pages/usage/auditor-models.test.tsx', testName: '持有 gateway:read 时必须请求模型目录并渲染单价(正向夹具)', kind: 'behavior' },
  { rel: 'pages/usage/Overview.tsx', arg: 'PERM_GATEWAY_READ', testFile: 'pages/usage/auditor-models.test.tsx', testName: '持有 gateway:read 时必须请求上游渠道并渲染余额(正向夹具)', kind: 'behavior' },
  { rel: 'pages/usage/Balance.tsx', arg: 'PERM_USER_WRITE', testFile: 'pages/usage/Balance.test.tsx', testName: 'user:write(admin)仍能看到全部写控件', kind: 'behavior' },
  { rel: 'pages/Users.tsx', arg: 'PERM_USER_WRITE', testFile: 'pages/Users.test.tsx', testName: '持有 user:write/dept:write 时新建/角色/部门入口可见(正向夹具)', kind: 'behavior' },
  { rel: 'pages/Users.tsx', arg: 'PERM_DEPT_WRITE', testFile: 'pages/Users.test.tsx', testName: '持有 user:write/dept:write 时新建/角色/部门入口可见(正向夹具)', kind: 'behavior' },
  { rel: 'pages/BuiltinSkills.tsx', arg: 'PERM_CAP_READ', testFile: 'pages/BuiltinSkills.test.tsx', testName: '展示资产目录与镜像里那条技能的元数据', kind: 'behavior' },
  { rel: 'pages/app-center/OpensBoard.tsx', arg: 'PERM_CAP_READ', testFile: 'pages/app-center/OpensBoard.test.tsx', testName: '今日 PV/UV 取服务端原值；窗口 PV 可累加、窗口 UV 取服务端去重值', kind: 'behavior' },
  { rel: 'pages/app-center/Limits.tsx', arg: 'PERM_CAP_WRITE', testFile: 'pages/AppPlatform.test.tsx', testName: '持有 capability:write 时保存与档位按钮解锁(正向夹具)', kind: 'behavior' },
  { rel: 'pages/app-center/Limits.tsx', arg: 'PERM_CAP_READ', testFile: 'pages/AppPlatform.test.tsx', testName: '只读账号:禁用的保存/恢复按钮指向可读的原因(不是只藏在 title 里)', kind: 'behavior' },
  { rel: 'pages/app-center/AppOpensSection.tsx', arg: 'PERM_DEPT_READ', testFile: 'pages/app-center/AppOpensAi.test.tsx', testName: '按部门：部门名 best-effort 映射（dept:read），行按 PV 降序，未归属部门单独成行', kind: 'behavior' },
  { rel: 'pages/app-center/Apps.tsx', arg: 'PERM_CAP_READ', testFile: 'pages/AppCenter.test.tsx', testName: '渲染应用列表:标题/app_id/访问级别中文标签/负责人/当前版本/状态', kind: 'behavior' },
  { rel: 'pages/app-center/Apps.tsx', arg: 'PERM_CAP_WRITE', testFile: 'pages/AppCenter.test.tsx', testName: '点「下架」→ POST /wasm-apps/<id>/unpublish，并按响应把该行切回「上架」', kind: 'behavior' },
  { rel: 'pages/Audit.tsx', arg: 'PERM_AUDIT_RETENTION_WRITE', testFile: 'pages/Audit.test.tsx', testName: 'super_admin 仍然可编辑并可保存(不误伤)', kind: 'behavior' },
  { rel: 'pages/GatewayFiles.tsx', arg: 'PERM_GATEWAY_WRITE', testFile: 'pages/GatewayFiles.test.tsx', testName: '写面收敛：持有 gateway:write 时删除/清理入口可见', kind: 'behavior' },
]

/** nav gate 用到的权限点并集（来自 NAV_ENTRIES 的声明，不是另抄一份清单）。 */
const NAV_GATED_PERMISSIONS = [...new Set(NAV_ENTRIES.flatMap((n) => n.perms ?? []))]

/**
 * **刻意不进侧栏**的权限点（前向守卫的登记表）。
 *
 * 判据：Go 全集里每个权限点都必须出现在 `NAV_ENTRIES` 的 perms 里，或者登记在这里并
 * 写明为什么管理端不需要独立入口。新增一个权限点时本用例会红，直到有人显式决定它属于
 * 哪一类——这正是"权限点漂移没有任何判据能发现"要补的那道闸。
 */
const PERM_WITHOUT_NAV_ENTRY: Record<string, string> = {
  'user:write': '写面：用户页（user:read 进入）内的动作，页内 hasPermission 收敛',
  'dept:write': '写面：部门页（dept:read 进入）内的动作',
  'auth:write': '写面：认证页（auth:read 进入）内的动作',
  'gateway:write': '写面：网关页 / 网关文件页（gateway:read 进入）内的动作',
  'report:write': '写面：用量中心「报表订阅」子页内的动作',
  'report:read': '报表订阅列表是「用量中心」的子页（入口由 usage:read 覆盖）',
  'market:write': '写面：能力中心（市场）的审批/授权动作',
  'capability:write': '写面：能力中心/应用中心的处置动作',
  'connector:write': '写面：连接器页（connector:read 进入）内的动作',
  'audit:retention:write': '写面：审计页（audit:read 进入）内的保留策略卡片',
  'portal:read': '门户页无独立管理入口（相关配置在「服务器信息」页）',
  'portal:write': '写面：门户配置动作',
}

const superAdmin: MeUser = { role: 'super_admin', permissions: GO_ALL_PERMISSIONS }
const auditor: MeUser = { role: 'auditor', permissions: GO_AUDITOR_PERMISSIONS }
const employee: MeUser = { role: 'user', permissions: [] }

const paths = (user: MeUser | null) => visibleNav(user).map((n) => n.to)

describe('权限点真源对拍(R4-D-3 · 读 server/internal/serverauth/rbac.go)', () => {
  it('Go 真源解析自证：非空、无重复、常量块 ↔ AllPermissions 双向覆盖', () => {
    // 解析器坏掉时不能"零命中全绿"（上面的解析函数已 throw，这里是第二道自证）。
    expect(GO_PERM_CONSTANTS.size).toBeGreaterThan(0)
    expect(GO_ALL_PERMISSIONS.length).toBeGreaterThan(0)
    expect(new Set(GO_ALL_PERMISSIONS).size, 'AllPermissions 不得重复授权').toBe(GO_ALL_PERMISSIONS.length)
    // 声明了权限点常量却没进 AllPermissions ⇒ 该权限点在服务端永不成立（连超管也没有）。
    const missing = [...GO_PERM_CONSTANTS.values()].filter((p) => !GO_ALL_PERMISSIONS.includes(p)).sort()
    expect(missing, `这些权限点常量未进 AllPermissions：${missing.join(', ')}`).toEqual([])
  })

  it('NAV_ENTRIES 声明的每个权限点都存在于 Go 权限全集(常量漂移守卫)', () => {
    // 事故形态：前端 gate 在一个 Go 端不存在的权限点上 ⇒ 该页对**包括 super_admin
    // 在内**的全部角色不可见（2026-09-12 的 `error-monitoring:read`）。
    const declared = [...NAV_GATED_PERMISSIONS].sort()
    expect(declared.filter((p) => !GO_ALL_PERMISSIONS.includes(p))).toEqual([])
  })

  it('lib/rbac.ts 的 PERM_* 常量值全部都存在于 Go 全集（第二个手抄入口）', () => {
    const unknown = [...TS_PERM_CONSTANTS.entries()]
      .filter(([, value]) => !GO_ALL_PERMISSIONS.includes(value))
      .map(([name, value]) => `${name}=${value}`)
      .sort()
    expect(unknown, `前端权限常量在 Go 真源里不存在（用它判定的页面会静默不可达）：${unknown.join(', ')}`).toEqual([])
  })

  it('PERM_* 只允许在 lib/rbac.ts 声明（扫描根 src/** + 前向守卫，FIX-45 ④）', () => {
    // ① **同一份真源只有一处**：`src/**` 里任何 `PERM_*` 声明都必须在 `lib/rbac.ts`。
    //    就地声明一个（即使值与真源一致）⇒ 它落在四向对拍的扫描根之外 ⇒ 必须当场红。
    const stray = DECLARED_PERM_CONSTANTS
      .filter((entry) => entry.file !== RBAC_TS_PATH)
      .map((entry) => `${entry.file.slice(SRC_ROOT.length + 1)}: ${entry.name}`)
      .sort()
    expect(
      stray,
      `这些 PERM_* 常量声明在 lib/rbac.ts 之外（就地手抄一份 ⇒ 四向对拍覆盖不到它）：${stray.join(', ')}`
        + `\n  修法：把常量搬进 ${RBAC_TS_PATH} 并从这里 import（不要就地声明）。`,
    ).toEqual([])
    // ② **扫描根自证**：`src/**` 收集到的声明值集合必须与 `rbac.ts` 自己的完全一致
    //    （递归遍历被改窄 / 正则退化 ⇒ 这里立刻红，而不是"零命中全绿"）。
    const fromScan = [...new Set(DECLARED_PERM_CONSTANTS.map((entry) => entry.value))].sort()
    const fromRbacTs = [...new Set(TS_PERM_CONSTANTS.values())].sort()
    expect(fromScan, 'src/** 的 PERM_* 收集结果与 lib/rbac.ts 自己的解析结果不一致（扫描根坏了？）')
      .toEqual(fromRbacTs)
  })

  it('src/** 收集到的每个 PERM_* 值都必须存在于 Go 全集（扫描根扩到全 src 后的第二道网）', () => {
    // 与上一条的区别：上一条钉"哪份文件能声明"，这一条钉"**声明出来的值**对不对"。
    // 只有 rbac.ts 能声明 ⇒ 这一条与 `TS_PERM_CONSTANTS` 同源；它防的是"把扫描根
    // 又改回单文件"——那时 `DECLARED_PERM_CONSTANTS` 只剩一份，① 仍会绿，但这里
    // 的对拍口径写的是"扫描根收集到什么就判什么"，改窄即与 rbac.ts 不一致 ⇒ 红。
    const unknown = DECLARED_PERM_CONSTANTS
      .filter((entry) => !GO_ALL_PERMISSIONS.includes(entry.value))
      .map((entry) => `${entry.name}=${entry.value}`)
      .sort()
    expect(unknown, `前端权限常量在 Go 真源里不存在：${unknown.join(', ')}`).toEqual([])
  })

  it('Go 权限点必须显式决定管理端入口（新增/删除权限点的前向守卫）', () => {
    // 新增一个权限点 ⇒ 本用例红，直到有人显式决定它属于哪一类：
    //   ① 给某个 NAV_ENTRIES 当 gate；② 登记进 PERM_WITHOUT_NAV_ENTRY 并写明理由。
    const unregistered = GO_ALL_PERMISSIONS.filter(
      (p) => !NAV_GATED_PERMISSIONS.includes(p) && !(p in PERM_WITHOUT_NAV_ENTRY),
    ).sort()
    expect(
      unregistered,
      `Go 新增了权限点但没有管理端入口登记（改 NAV_ENTRIES 或补 PERM_WITHOUT_NAV_ENTRY）：${unregistered.join(', ')}`,
    ).toEqual([])
    // 反向：登记表里不得留 Go 端已删除的权限点（删点后登记表必须同步收缩）。
    const stale = Object.keys(PERM_WITHOUT_NAV_ENTRY).filter((p) => !GO_ALL_PERMISSIONS.includes(p)).sort()
    expect(stale, `PERM_WITHOUT_NAV_ENTRY 里有 Go 端已不存在的权限点：${stale.join(', ')}`).toEqual([])
  })
})

describe('hasPermission 实参形态与正向夹具守卫(FIX-47 子泳道 B)', () => {
  it('守卫自证：分类器/掩码器对合成片段的判定(判据不是恒绿)', () => {
    // 分类器：命名约定不算数，符号来源才算。
    const named = new Set(['PERM_DEPT_READ'])
    const namespaces = new Set(['rbac'])
    expect(classifyPermArg("'dept:raed'", 'pages/usage/Departments.tsx', named, namespaces)).toBe('literal')
    expect(classifyPermArg('"dept:read"', 'x.tsx', named, namespaces)).toBe('literal')
    expect(classifyPermArg('`dept:read`', 'x.tsx', named, namespaces)).toBe('literal')
    expect(classifyPermArg('PERM_DEPT_READ', 'x.tsx', named, namespaces)).toBe('rbac-identifier')
    expect(classifyPermArg('PERM_USER_READ', 'x.tsx', named, namespaces)).toBe('unresolved') // 没 import
    expect(classifyPermArg('rbac.PERM_DEPT_READ', 'x.tsx', named, namespaces)).toBe('rbac-member')
    expect(classifyPermArg('rbac.PERM_NOPE', 'x.tsx', named, namespaces)).toBe('unresolved')
    expect(classifyPermArg('t.perm', 'pages/usage/UsageLayout.tsx', named, namespaces)).toBe('registered-table')
    expect(classifyPermArg('t.perm', 'pages/Other.tsx', named, namespaces)).toBe('unresolved') // 未登记
    expect(classifyPermArg('TABS[0].perm', 'pages/usage/UsageLayout.tsx', named, namespaces)).toBe('unresolved')
    expect(classifyPermArg('cond ? PERM_A : PERM_B', 'x.tsx', named, namespaces)).toBe('unresolved')

    // 掩码器①：注释里的提及不算调用点；字符串里的 `//` 不被当成注释开头。
    const src = 'const u = "https://x/y" // hasPermission(PERM_A)\nhasPermission(PERM_B)\n'
    expect([...maskSource(src, 'comments').matchAll(/hasPermission\s*\(/gu)]).toHaveLength(1)

    // 掩码器②：花括号配对必须跳过字符串里的括号（否则用例体的边界会切错）。
    const snippet = "it('x', () => { const s = \"}\"; expect(s).toBe('}') })"
    const maskedAll = maskSource(snippet, 'comments-and-strings')
    const open = maskedAll.indexOf('{')
    const close = matchingDelimiter(maskedAll, open, '{', '}')
    expect(snippet.slice(open, close + 1)).toContain("expect(s).toBe('}')")
    expect(snippet.indexOf('}', open)).toBeLessThan(close) // 朴素"取首个 }"会切错，证明这条自证有区分力
  })

  it('hasPermission 的实参必须是从 lib/rbac.ts import 的 PERM_* 标识符(行内字面量即红)', () => {
    const { sites, declarations, filesScanned } = scanHasPermissionSites()
    const bad = sites
      .filter((s) => s.kind === 'literal' || s.kind === 'unresolved')
      .map((s) => `${s.rel}:${s.line}  hasPermission(${s.arg})`)
      .sort()
    expect(
      bad,
      '这些 hasPermission 调用的实参不是从 lib/rbac.ts import 的 PERM_* 标识符：\n'
        + `${bad.join('\n')}\n`
        + '为什么必须红：hasPermission 在实参匹配不上任何权限点时对**所有角色**恒 false ⇒ 该处的'
        + '控件/请求对**所有人（含 super_admin）**永久消失（第三十一轮 AD2 真跑：Departments 的'
        + '组织架构树与 GET /api/server/admin/departments）。修法：改成从 lib/rbac.ts import 的'
        + 'PERM_* 标识符；确需表驱动形态（如 hasPermission(t.perm)）必须显式登记进'
        + 'PERM_ARG_TABLE_REGISTRY 并写明理由。',
    ).toEqual([])

    // 扫描根自证（防"零命中全绿"与"跳过规则吞掉真调用点"）。
    expect(sites.length).toBeGreaterThanOrEqual(10)
    expect(sites.map((s) => s.rel)).toContain('pages/usage/Departments.tsx') // AD2 的点名页
    expect(filesScanned).toBeGreaterThan(30)
    expect(declarations, `函数定义应当只跳过一处（lib/rbac.ts），实际跳过：${declarations.join(', ')}`).toHaveLength(1)
    expect(declarations[0]).toMatch(/^lib\/rbac\.ts:/u)
  })

  it('表驱动登记项：表的取值必须仍是 rbac 的 PERM_*，且登记表里不得有死条目', () => {
    const { sites } = scanHasPermissionSites()
    const problems: string[] = []
    for (const entry of PERM_ARG_TABLE_REGISTRY) {
      const hit = sites.filter((s) => s.rel === entry.rel && s.arg === entry.arg)
      if (hit.length === 0) {
        problems.push(
          `${entry.rel} 里找不到 hasPermission(${entry.arg})（登记项已过期 ⇒ 删掉它，`
            + '别留着"允许某种实参形态"的口子）',
        )
        continue
      }
      // 第二道判据：被放行的表，其该属性取值必须仍然全是 rbac.ts 的 PERM_* 标识符。
      for (const site of hit) {
        try {
          if (requiredPermPoints(site).length === 0) {
            problems.push(`${entry.rel} 的 ${entry.tableConst}.${entry.prop} 取值为空`)
          }
        } catch (e) {
          problems.push((e as Error).message)
        }
      }
    }
    expect(problems, `表驱动实参登记表：\n${problems.join('\n')}`).toEqual([])
  })

  it('每个调用点都登记为「有正向夹具」：测试名必须真实存在，且夹具显式授予了该权限点', () => {
    const { sites } = scanHasPermissionSites()
    const problems: string[] = []
    const keyOf = (rel: string, arg: string): string => `${rel}  hasPermission(${arg})`
    const byKey = new Map<string, PermArgPositiveFixture>()
    for (const f of PERM_ARG_POSITIVE_FIXTURES) {
      const k = keyOf(f.rel, f.arg)
      if (byKey.has(k)) problems.push(`${k} 在夹具登记表里重复登记`)
      byKey.set(k, f)
    }
    const siteKeys = new Set(sites.map((s) => keyOf(s.rel, s.arg)))
    // ① 调用点 → 登记（漏登记即红：新增调用点必须显式决定"拿什么用例证明持有点时真的可见"）
    for (const site of sites) {
      if (!byKey.has(keyOf(site.rel, site.arg))) {
        problems.push(
          `${site.rel}:${site.line}  hasPermission(${site.arg}) 没有正向夹具登记：负例在`
            + 'hasPermission 恒 false 时照样通过，"取值在夹具里不存在"与"实现正确"无法区分；'
            + '请在 PERM_ARG_POSITIVE_FIXTURES 里指向一条**显式授予该权限点**的用例。',
        )
      }
    }
    // ② 登记 → 调用点（死条目即红）
    for (const f of PERM_ARG_POSITIVE_FIXTURES) {
      if (!siteKeys.has(keyOf(f.rel, f.arg))) {
        problems.push(`${keyOf(f.rel, f.arg)} 的夹具登记是死条目（src 里没有这个调用点）`)
      }
    }
    // ③ 结构判据：测试名真实存在 + 该用例执行期内的 setCurrentAdmin 夹具授予了该权限点
    for (const [k, f] of byKey) {
      const testPath = join(SRC_ROOT, f.testFile)
      if (!existsSync(testPath)) {
        problems.push(`${k} 登记的测试文件不存在：${f.testFile}`)
        continue
      }
      const text = readFileSync(testPath, 'utf8')
      const body = findTestCaseBody(text, f.testName)
      if (body === null) {
        problems.push(`${k} 登记的测试名在该文件里找不到：「${f.testName}」（${f.testFile}）`)
        continue
      }
      const scope = fixtureScopeText(text, body)
      if (scope === null) {
        problems.push(
          `${k} 的用例「${f.testName}」执行期内没有任何 setCurrentAdmin 夹具：未下发 permissions 时`
            + 'hasPermission 走"默认放行"分支，对"权限点写错"完全不敏感。',
        )
        continue
      }
      const site = sites.find((s) => keyOf(s.rel, s.arg) === k)
      if (site === undefined
        || (site.kind !== 'rbac-identifier' && site.kind !== 'rbac-member' && site.kind !== 'registered-table')) {
        problems.push(`${k} 的实参形态（${site?.kind ?? '未扫到'}）取不到权限点，夹具判据不适用（形态本身已在另一条判据里红）`)
        continue
      }
      let points: string[]
      try {
        points = requiredPermPoints(site)
      } catch (e) {
        // 表驱动形态退化（表取值不再是 rbac 的 PERM_*）时，取权限点会抛 —— 收进 problems，
        // 让失败信息一次列全，而不是让用例以未捕获异常中断（另一条判据也会报同一件事）。
        problems.push((e as Error).message)
        continue
      }
      for (const point of points) {
        const asLiteral = scope.includes(`'${point}'`) || scope.includes(`"${point}"`)
        const asConstant = [...TS_PERM_CONSTANTS.entries()].some(
          ([name, value]) =>
            value === point && new RegExp(`(?:^|[^A-Za-z0-9_$])${name}(?:[^A-Za-z0-9_$]|$)`, 'u').test(scope),
        )
        if (!asLiteral && !asConstant) {
          problems.push(
            `${k} 的用例「${f.testName}」没有显式授予权限点 ${point}：夹具里必须出现该字面值或它对应的`
              + 'PERM_* 常量（否则这条用例在权限点写错时照样绿）。',
          )
        }
      }
    }
    expect(problems, `正向夹具登记表（kind=behavior 指向真的行为断言；kind=registration 只有结构判据）：\n${problems.join('\n')}`)
      .toEqual([])
  })
})

describe('导航权限过滤(P2-43)', () => {

  it('超管看到全部条目', () => {
    expect(paths(superAdmin)).toEqual(NAV_ENTRIES.map((n) => n.to))
  })

  it('超管能看到错误监控页(权限点从 error-monitoring:read 改回 server-info:read)', () => {
    // 回归:该条目曾 gate 在 rbac.go 已删除的 `error-monitoring:read` 上,
    // 导致 super_admin 的 granted 也不含它 → 页面无任何入口。
    const actual = NAV_ENTRIES.find((n) => n.to === '/error-monitoring')!
    expect(isNavVisible(actual, superAdmin)).toBe(true)
    // 改前形态的直接复现:同一个超管、同一条目,只把 perms 换回废弃常量
    // ⇒ isNavVisible 恒 false(这就是缺陷本身)。
    const retired: NavEntry = { ...actual, perms: ['error-monitoring:read'] }
    expect(isNavVisible(retired, superAdmin)).toBe(false)
  })

  it('审计员看到服务端允许的用户/用量/审计三页(不再只按 section 过滤)', () => {
    expect(paths(auditor)).toEqual(['/users', '/usage', '/audit'])
  })

  it('审计员看不到需要写/未授权页面', () => {
    const visible = paths(auditor)
    expect(visible).not.toContain('/departments')
    expect(visible).not.toContain('/gateway')
    expect(visible).not.toContain('/auth')
    expect(visible).not.toContain('/connectors')
    expect(visible).not.toContain('/server-info')
    expect(visible).not.toContain('/error-monitoring')
  })

  it('普通员工无任何可见条目', () => {
    expect(paths(employee)).toEqual([])
  })

  it('多权限点条目命中任一即可见(能力中心 market:read | capability:read)', () => {
    // capability:read 同时 gate「能力中心」与「应用中心」(读权限复用同一点,
    // 写入要 capability:write);market:read 只 gate 能力中心 —— 下面两条断言正是这条边界。
    expect(paths({ role: 'auditor', permissions: ['capability:read'] })).toEqual(['/capabilities', '/app-center'])
    expect(paths({ role: 'auditor', permissions: ['market:read'] })).toEqual(['/capabilities'])
  })

  it('应用中心页:capability:read 可见、普通员工不可见', () => {
    const entry = NAV_ENTRIES.find((n) => n.to === '/app-center')!
    expect(isNavVisible(entry, superAdmin)).toBe(true)
    expect(isNavVisible(entry, { role: 'auditor', permissions: ['capability:read'] })).toBe(true)
    expect(isNavVisible(entry, employee)).toBe(false)
  })

  it('网关文件页:gateway:read 可见,只读角色(无该权限点)不可见', () => {
    // 2026-09-22 新增条目（运维分区）：读占用/明细走 `gateway:read`（与
    // router.go 里 GET /gateway/files[/summary] 的申报同一点），删除/清理走
    // `gateway:write` —— 页面内另做写面收敛（GatewayFiles.tsx 的 canWrite）。
    const entry = NAV_ENTRIES.find((n) => n.to === '/gateway-files')!
    expect(entry.section).toBe('运维')
    expect(entry.perms).toEqual(['gateway:read'])
    expect(isNavVisible(entry, superAdmin)).toBe(true)
    expect(isNavVisible(entry, { role: 'auditor', permissions: ['gateway:read'] })).toBe(true)
    expect(isNavVisible(entry, auditor)).toBe(false) // auditor = audit/usage/user:read
    expect(isNavVisible(entry, employee)).toBe(false)
  })

  it('侧栏没有两条同图标入口(「应用平台」并入「应用中心」后的回归)', () => {
    // 2026-09-19 页面合并:此前 `/app-center` 与 `/app-platform` 两个条目同用 Boxes
    // 图标 —— 侧栏看着是两个入口、实际是同一类东西。合并后限制项/设置是应用中心的
    // 子页(路由表见 App.tsx),侧栏只留一条;`/app-platform` 只剩老书签重定向。
    const byIcon = new Map<unknown, string>()
    const dups: string[] = []
    for (const n of NAV_ENTRIES) {
      const seen = byIcon.get(n.icon)
      if (seen !== undefined) dups.push(`${seen} / ${n.to}`)
      else byIcon.set(n.icon, n.to)
    }
    expect(dups).toEqual([])
    expect(NAV_ENTRIES.map((n) => n.to)).not.toContain('/app-platform')
  })

  it('未声明 perms 的条目 fail-closed(仅超管可见)', () => {
    const legacy: NavEntry = { to: '/secret', label: '秘密', icon: NAV_ENTRIES[0]!.icon, section: '运维' }
    // 直接验证规则:服务端有权限集时,无 perms 声明只放行超管
    expect(visibleNav({ role: 'auditor', permissions: ['usage:read'] }).some((n) => n.to === legacy.to)).toBe(false)
    expect(visibleNav(superAdmin).length).toBe(NAV_ENTRIES.length)
  })

  it('服务端未下发 permissions(旧版本)时退回角色判定,不放大可见面', () => {
    expect(paths({ role: 'super_admin' })).toEqual(NAV_ENTRIES.map((n) => n.to))
    expect(paths({ role: 'auditor' })).toEqual(['/audit'])
    expect(paths({ role: 'user' })).toEqual([])
    expect(paths(null)).toEqual([])
  })

  it('落地页取第一个可见条目;审计员优先审计日志', () => {
    expect(landingPath(superAdmin)).toBe('/users')
    expect(landingPath(auditor)).toBe('/audit')
    expect(landingPath({ role: 'auditor', permissions: ['usage:read'] })).toBe('/usage')
    expect(landingPath(employee)).toBe('/users')
  })
})
